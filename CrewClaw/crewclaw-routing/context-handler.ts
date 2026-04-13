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
    "user-profile":     (userId: string) => string;
    "user-now":         (userId: string) => string;
    "app-capabilities": (prompt: string) => string;
    "static-file":      (filePath: string) => string;
  };
}

// ── 查询结果 ──────────────────────────────────────────────────────────────

export interface DynamicContextResult {
  prepend:      string[];  // 按序拼接后 prependContext
  appendSystem: string[];  // 按序拼接后 appendSystemContext
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
  switch (src.queryMode) {
    case "user-profile":
      return resolvers["user-profile"](params.userId);
    case "user-now":
      return resolvers["user-now"](params.userId);
    case "app-capabilities":
      return resolvers["app-capabilities"](params.prompt);
    case "static-file":
      return resolvers["static-file"](src.filePath ?? "");
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

  sources.forEach((src, i) => {
    const result = results[i];
    const text = result.status === "fulfilled" ? result.value : "";
    if (!text) return;

    if (src.inject === "prepend") {
      prepend.push(text);
    } else {
      appendSystem.push(text);
    }
  });

  return { prepend, appendSystem };
}
