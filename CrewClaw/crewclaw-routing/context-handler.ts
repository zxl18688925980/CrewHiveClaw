/**
 * context-handler.ts — 框架层：通用 before_prompt_build 知识注入 handler
 *
 * 读取 context-sources.ts 注册表，为每个 agent 并发查询所有 source，
 * 按 inject 模式分组后返回注入内容。
 *
 * 设计原则：
 *   - 本文件只做调度，不包含任何 ChromaDB / Kuzu / 文件读取实现
 *   - 所有实现通过 ContextResolvers 注入（在 index.ts 里绑定）
 *   - Kuzu source ready=false 时静默跳过，不报错
 *   - 任何单个 source 查询失败都静默忽略，不影响其他 source
 *   - agentId 不在注册表中时，自动 fallback 到 "default" 键（新部署免改代码）
 */

import {
  contextSources,
  type ContextSource,
  type ChromaSource,
  type KuzuSource,
  type FileSource,
  type SessionParams,
} from "./context-sources.js";

// ── Resolver 接口（实现在 index.ts 里绑定）────────────────────────────────

export interface ContextResolvers {
  chromadb: {
    "semantic":             (collection: string, prompt: string, topK: number, agentFilter?: string) => Promise<string>;
    "by-user":              (collection: string, prompt: string, userId: string, isGroup: boolean, topK: number) => Promise<string>;
    "pending-commitments":  (userId: string) => Promise<string>;
    "pending-requirements": (prompt: string) => Promise<string>;
    "agent-interactions":   (prompt: string, agentFilter: string, topK: number) => Promise<string>;
    "code-history":         (prompt: string, topK: number) => Promise<string>;
    "constraint-recall":    (prompt: string, agentFilter: string, topK: number) => Promise<string>;
    "codebase-patterns":    (prompt: string, topK: number) => Promise<string>;
  };
  kuzu: {
    query: (cypher: string, boundParams: Record<string, unknown>) => Promise<string[]>;
  };
  file: {
    "user-profile":      (userId: string) => string;
    "user-now":          (userId: string) => string;
    "app-capabilities":  (prompt: string) => string;
    "static-file":       (filePath: string) => string;
    "auto-skill-recall": (prompt: string, agentId: string) => string;
  };
}

// ── 查询结果 ──────────────────────────────────────────────────────────────

export interface ContextEntry {
  text: string;
  tier: 0 | 1 | 2 | 3;
  sourceId: string;
  label: string;
}

export interface DynamicContextResult {
  prepend:      string[];        // 按序拼接后 prependContext
  appendSystem: string[];        // 按序拼接后 appendSystemContext
  meta: {                        // 上下文预算用元数据
    prepend:      ContextEntry[];
    appendSystem: ContextEntry[];
  };
}

// ── 单个 Source 执行 ──────────────────────────────────────────────────────

async function resolveSource(
  source:    ContextSource,
  params:    SessionParams,
  resolvers: ContextResolvers,
): Promise<string> {
  try {
    if (source.source === "chromadb") {
      return await resolveChroma(source, params, resolvers.chromadb);
    }
    if (source.source === "kuzu") {
      return await resolveKuzu(source, params, resolvers.kuzu);
    }
    if (source.source === "file") {
      return resolveFile(source, params, resolvers.file);
    }
  } catch {
    // 单个 source 失败静默忽略，不中断其他 source
  }
  return "";
}

async function resolveChroma(
  src:       ChromaSource,
  params:    SessionParams,
  resolvers: ContextResolvers["chromadb"],
): Promise<string> {
  switch (src.queryMode) {
    case "semantic":
      return resolvers["semantic"](src.collection, params.prompt, src.topK, src.agentFilter);

    case "by-user":
      return resolvers["by-user"](src.collection, params.prompt, params.userId, params.isGroup, src.topK);

    case "pending-commitments":
      return resolvers["pending-commitments"](params.userId);

    case "pending-requirements":
      return resolvers["pending-requirements"](params.prompt);

    case "agent-interactions":
      return resolvers["agent-interactions"](params.prompt, src.agentFilter ?? params.agentId, src.topK);

    case "code-history":
      return resolvers["code-history"](params.prompt, src.topK);

    case "constraint-recall":
      return resolvers["constraint-recall"](params.prompt, src.agentFilter ?? params.agentId, src.topK);

    case "codebase-patterns":
      return resolvers["codebase-patterns"](params.prompt, src.topK);
  }
}

async function resolveKuzu(
  src:       KuzuSource,
  params:    SessionParams,
  resolvers: ContextResolvers["kuzu"],
): Promise<string> {
  // ready=false：Kuzu 数据尚未就绪，静默跳过
  if (!src.ready) return "";

  // 从 session params 绑定 Cypher 变量
  const boundParams: Record<string, unknown> = { topK: src.topK };
  for (const key of src.params) {
    boundParams[key] = params[key];
  }

  const rows = await resolvers.query(src.cypher, boundParams);
  if (rows.length === 0) return "";
  return `【${src.label}】\n${rows.join("\n")}`;
}

function resolveFile(
  src:       FileSource,
  params:    SessionParams,
  resolvers: ContextResolvers["file"],
): string {
  // findRelevantMemories（ClaudeCode memdir 对齐，轻量版）：
  // optional=true 的 static-file，若 query 未命中任一 keyword，跳过注入（节省 token）
  if (src.optional && src.queryMode === "static-file" && src.keywords && src.keywords.length > 0) {
    const prompt = params.prompt.toLowerCase();
    const matched = src.keywords.some(kw => prompt.includes(kw.toLowerCase()));
    if (!matched) {
      return ""; // keyword miss → 跳过此文件
    }
  }

  switch (src.queryMode) {
    case "user-profile":
      return resolvers["user-profile"](params.userId);
    case "user-now":
      return resolvers["user-now"](params.userId);
    case "app-capabilities":
      return resolvers["app-capabilities"](params.prompt);
    case "static-file":
      return resolvers["static-file"](src.filePath ?? "");
    case "auto-skill-recall":
      return resolvers["auto-skill-recall"](params.prompt, params.agentId);
  }
}

// ── 主函数：为指定 agent 并发查询所有 source ──────────────────────────────

export async function buildDynamicContext(
  params:    SessionParams,
  resolvers: ContextResolvers,
): Promise<DynamicContextResult> {
  // agentId 不在注册表时 fallback 到 "default"（新部署只需在 context-sources.ts 加 default 键）
  const sources = contextSources[params.agentId] ?? contextSources["default"] ?? [];

  // 并发查询所有 source
  const results = await Promise.allSettled(
    sources.map(src => resolveSource(src, params, resolvers))
  );

  const prepend:      string[] = [];
  const appendSystem: string[] = [];
  const prependMeta:      ContextEntry[] = [];
  const appendSystemMeta: ContextEntry[] = [];

  sources.forEach((src, i) => {
    const result = results[i];
    const text = result.status === "fulfilled" ? result.value : "";
    if (!text) return;

    const entry: ContextEntry = {
      text,
      tier: (src as { tier?: 0 | 1 | 2 | 3 }).tier ?? 2,
      sourceId: (src as { id: string }).id,
      label: (src as { label: string }).label,
    };

    if (src.inject === "prepend") {
      prepend.push(text);
      prependMeta.push(entry);
    } else {
      appendSystem.push(text);
      appendSystemMeta.push(entry);
    }
  });

  return {
    prepend, appendSystem,
    meta: { prepend: prependMeta, appendSystem: appendSystemMeta },
  };
}

// ── 上下文预算管理 ────────────────────────────────────────────────────────

export interface BudgetConfig {
  maxContextChars: number;
  dryRun:          boolean;  // true = 只记日志不裁剪
  tiers: Record<string, {
    sources?: string[];  // 可选：指定哪些 source 属于此 tier（留空则靠 source 自身 tier 字段）
    maxChars:  number | null;  // null = 不限制
  }>;
}

/**
 * 按预算裁剪注入内容：从 Tier 3 开始裁剪，保持 Tier 0 不动
 * dryRun=true 时只写日志不实际裁剪，用于积累数据
 */
export function applyContextBudget(
  result: DynamicContextResult,
  config: BudgetConfig,
  agentId: string,
): DynamicContextResult {
  const allEntries = [
    ...result.meta.prepend.map((e, i) => ({ ...e, mode: "prepend" as const, idx: i })),
    ...result.meta.appendSystem.map((e, i) => ({ ...e, mode: "appendSystem" as const, idx: i })),
  ];

  const totalChars = allEntries.reduce((sum, e) => sum + e.text.length, 0);

  // 按 tier 统计
  const tierStats = [0, 1, 2, 3].map(t => {
    const entries = allEntries.filter(e => e.tier === t);
    return { tier: t, count: entries.length, chars: entries.reduce((s, e) => s + e.text.length, 0) };
  });

  // 日志输出（无论 dryRun 与否）
  console.log(
    `[budget] agent=${agentId} total=${totalChars} | ` +
    tierStats.map(ts => `T${ts.tier}=${ts.chars}(${ts.count})`).join(" ")
  );

  // 未超预算 或 dryRun → 不裁剪
  if (config.dryRun || totalChars <= config.maxContextChars) {
    return result;
  }

  // 实际裁剪：从 Tier 3 开始，到 Tier 2
  let remaining = totalChars;
  const trimmedPrepend = [...result.prepend];
  const trimmedAppend = [...result.appendSystem];

  for (const trimTier of [3, 2]) {
    if (remaining <= config.maxContextChars) break;
    const tierConfig = config.tiers[String(trimTier)];
    if (!tierConfig) continue;

    // 从 appendSystem 末尾开始裁（保持 prepend 不动，prepend 通常是高优）
    for (let i = result.meta.appendSystem.length - 1; i >= 0; i--) {
      if (remaining <= config.maxContextChars) break;
      const entry = result.meta.appendSystem[i];
      if (entry.tier !== trimTier) continue;
      const removed = trimmedAppend[i];
      if (removed) {
        remaining -= removed.length;
        trimmedAppend[i] = "";
        console.log(`[budget] trimmed T${trimTier} "${entry.sourceId}" (${removed.length} chars)`);
      }
    }
  }

  return {
    prepend: trimmedPrepend.filter(Boolean),
    appendSystem: trimmedAppend.filter(Boolean),
    meta: result.meta,
  };
}
