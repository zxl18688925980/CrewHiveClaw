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
  // 压缩元数据（从 source 拷贝）
  compressGroup?: string;
  mustKeep?: boolean;
  dedupMode?: 'exact' | 'normalized' | 'semantic' | 'none';
  ttlHours?: number;
  maxItemsAfterCompress?: number;
  priorityBias?: number;
  injectMode?: 'prepend' | 'appendSystem';
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

    const src_any = src as Record<string, unknown>;
    const entry: ContextEntry = {
      text,
      tier: (src as { tier?: 0 | 1 | 2 | 3 }).tier ?? 2,
      sourceId: (src as { id: string }).id,
      label: (src as { label: string }).label,
      compressGroup:         src_any.compressGroup as string | undefined,
      mustKeep:              src_any.mustKeep as boolean | undefined,
      dedupMode:             src_any.dedupMode as 'exact'|'normalized'|'semantic'|'none' | undefined,
      ttlHours:              src_any.ttlHours as number | undefined,
      maxItemsAfterCompress: src_any.maxItemsAfterCompress as number | undefined,
      priorityBias:          src_any.priorityBias as number | undefined,
      injectMode:            src.inject === 'prepend' ? 'prepend' : 'appendSystem',
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

// ── Lucas 专属压缩管线 ─────────────────────────────────────────────────────

export interface LucasCompressionOptions {
  agentId: string;
  prompt: string;
  maxPrependChars: number;
  maxAppendChars: number;
  semanticThreshold: number;
  semanticMaxCandidates: number;
  dryRun?: boolean;
  embedText?: (text: string) => Promise<number[]>;
  nowMs?: number;
}

export interface LucasCompressionStats {
  before_prepend_chars: number;
  after_prepend_chars: number;
  before_append_chars: number;
  after_append_chars: number;
  dropped_entries: number;
  expired_dropped: number;
  dedup_dropped: number;
  semantic_dropped: number;
}

/** 文本标准化：去标签头、多余空白、换行 */
export function normalizeContextText(text: string): string {
  return text
    .replace(/^【[^】]*】\s*/gm, "")
    .replace(/[\n\r]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[-•·]\s*/gm, "")
    .trim();
}

/** 从文本提取最近一个 ISO 时间戳，返回 ms；未找到返回 null */
export function extractContextTimestamp(text: string): number | null {
  const ISO_RE = /\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?)?/g;
  const matches = text.match(ISO_RE);
  if (!matches || matches.length === 0) return null;
  const timestamps = matches.map(m => new Date(m).getTime()).filter(t => !isNaN(t));
  if (timestamps.length === 0) return null;
  return Math.max(...timestamps);
}

/** 计算余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/** 对单条 ContextEntry 计算综合优先级分数 */
export function scoreContextEntry(
  entry: ContextEntry,
  _promptEmbedding?: number[],
  nowMs: number = Date.now(),
): number {
  let score = 0;
  // mustKeep 附加分
  if (entry.mustKeep) score += 100;
  // tier 权重
  const tierWeight: Record<number, number> = { 0: 40, 1: 25, 2: 10, 3: 0 };
  score += tierWeight[entry.tier] ?? 10;
  // priorityBias
  score += (entry.priorityBias ?? 0) * 5;
  // recency
  const ts = extractContextTimestamp(entry.text);
  if (ts !== null) {
    const ageH = (nowMs - ts) / 3600000;
    score += Math.max(0, 10 - ageH / 24); // 越新越高，24h 内满分 10
  }
  return score;
}

/** 检查 entry 是否已过期 */
function isEntryExpired(entry: ContextEntry, nowMs: number): boolean {
  const text = entry.text;
  // 显式过期标签
  if (/已过期|已完成|已取消/.test(text)) return true;
  // valid_until 字段
  const validUntilMatch = text.match(/valid_until[：:=]\s*(\d{4}-\d{2}-\d{2})/);
  if (validUntilMatch) {
    const deadline = new Date(validUntilMatch[1]).getTime();
    if (!isNaN(deadline) && deadline < nowMs) return true;
  }
  // ttlHours：从文本中提取时间戳，若超过 ttl 则过期
  if (entry.ttlHours != null) {
    const ts = extractContextTimestamp(text);
    if (ts !== null) {
      const ageH = (nowMs - ts) / 3600000;
      if (ageH > entry.ttlHours) return true;
    }
  }
  return false;
}

/**
 * Lucas 专属上下文压缩管线
 *
 * 四步：过期过滤 → 规则去重 → 轻量语义去重 → 排序与配额裁剪
 */
export async function compressLucasContext(
  result: DynamicContextResult,
  options: LucasCompressionOptions,
): Promise<{ result: DynamicContextResult; stats: LucasCompressionStats }> {
  const nowMs = options.nowMs ?? Date.now();
  const allEntries: ContextEntry[] = [
    ...result.meta.prepend.map(e => ({ ...e, injectMode: 'prepend' as const })),
    ...result.meta.appendSystem.map(e => ({ ...e, injectMode: 'appendSystem' as const })),
  ];

  const before_prepend_chars = result.prepend.reduce((s, t) => s + t.length, 0);
  const before_append_chars  = result.appendSystem.reduce((s, t) => s + t.length, 0);

  // ── Step A: 过期过滤 ─────────────────────────────────────────────────────
  let expiredDropped = 0;
  const afterExpiry = allEntries.filter(e => {
    if (isEntryExpired(e, nowMs)) { expiredDropped++; return false; }
    return true;
  });

  // ── Step B: 规则去重 ─────────────────────────────────────────────────────
  let dedupDropped = 0;
  const afterDedup: ContextEntry[] = [];
  const seenKeys = new Set<string>();

  // 排序优先级：mustKeep > tier asc > priorityBias desc > timestamp desc > text.length asc
  const sortForDedup = (entries: ContextEntry[]) => [...entries].sort((a, b) => {
    if ((b.mustKeep ? 1 : 0) !== (a.mustKeep ? 1 : 0)) return (b.mustKeep ? 1 : 0) - (a.mustKeep ? 1 : 0);
    if (a.tier !== b.tier) return a.tier - b.tier;
    const bBias = b.priorityBias ?? 0, aBias = a.priorityBias ?? 0;
    if (aBias !== bBias) return bBias - aBias;
    const aTs = extractContextTimestamp(a.text) ?? 0;
    const bTs = extractContextTimestamp(b.text) ?? 0;
    if (bTs !== aTs) return bTs - aTs;
    return a.text.length - b.text.length;
  });

  for (const entry of sortForDedup(afterExpiry)) {
    const mode = entry.dedupMode ?? 'normalized';
    if (mode === 'none') { afterDedup.push(entry); continue; }
    // 'semantic' 先按 normalized 方式判断，之后在 Step C 再做 embedding 去重
    const key = mode === 'exact'
      ? `${entry.sourceId}::${entry.text}`
      : `${entry.sourceId}::${normalizeContextText(entry.text).slice(0, 200)}`;
    if (seenKeys.has(key)) { dedupDropped++; continue; }
    seenKeys.add(key);
    afterDedup.push(entry);
  }

  // ── Step C: 轻量语义去重 ────────────────────────────────────────────────
  let semanticDropped = 0;
  const afterSemantic = [...afterDedup];

  if (options.embedText) {
    try {
      const semanticCandidates = afterDedup
        .filter(e => e.dedupMode === 'semantic')
        .slice(0, options.semanticMaxCandidates);

      if (semanticCandidates.length > 1) {
        // 按 compressGroup 分组，只在同组内比较
        const groups = new Map<string, ContextEntry[]>();
        for (const e of semanticCandidates) {
          const g = e.compressGroup ?? 'default';
          if (!groups.has(g)) groups.set(g, []);
          groups.get(g)!.push(e);
        }

        const toRemove = new Set<string>();
        for (const [, groupEntries] of groups) {
          if (groupEntries.length < 2) continue;
          // 生成 embeddings
          const embeddings = await Promise.all(
            groupEntries.map(e => options.embedText!(normalizeContextText(e.text).slice(0, 400)))
          );
          // 两两比较，淘汰低分重复
          for (let i = 0; i < groupEntries.length; i++) {
            for (let j = i + 1; j < groupEntries.length; j++) {
              const sim = cosineSimilarity(embeddings[i], embeddings[j]);
              if (sim >= options.semanticThreshold) {
                // 淘汰总分较低的
                const scoreI = scoreContextEntry(groupEntries[i], undefined, nowMs);
                const scoreJ = scoreContextEntry(groupEntries[j], undefined, nowMs);
                const loser = scoreI >= scoreJ ? j : i;
                const loserKey = groupEntries[loser].sourceId + groupEntries[loser].text.slice(0, 50);
                if (!toRemove.has(loserKey)) {
                  toRemove.add(loserKey);
                  semanticDropped++;
                }
              }
            }
          }
        }

        // 从 afterSemantic 中去除语义重复项
        afterSemantic.splice(0);
        for (const e of afterDedup) {
          const key = e.sourceId + e.text.slice(0, 50);
          if (!toRemove.has(key)) afterSemantic.push(e);
        }
      }
    } catch {
      // 语义去重失败静默回退，保留规则去重结果
    }
  }

  // ── Step D: 排序与配额裁剪 ───────────────────────────────────────────────
  // 先按总分降序排列
  const scored = afterSemantic.map(e => ({
    entry: e,
    score: scoreContextEntry(e, undefined, nowMs),
  })).sort((a, b) => b.score - a.score);

  // 每个 source 的 maxItemsAfterCompress 控制
  const sourceCount = new Map<string, number>();
  const finalEntries: ContextEntry[] = [];

  // 先保证 mustKeep
  const mustKeepIds = new Set<string>();
  const mustKeepGroups = new Map<string, boolean>();
  for (const { entry } of scored) {
    if (entry.mustKeep && !mustKeepGroups.has(entry.compressGroup ?? entry.sourceId)) {
      if (!isEntryExpired(entry, nowMs)) {
        mustKeepIds.add(entry.sourceId + entry.text.slice(0, 50));
        mustKeepGroups.set(entry.compressGroup ?? entry.sourceId, true);
      }
    }
  }

  for (const { entry } of scored) {
    const key = entry.sourceId + entry.text.slice(0, 50);
    const cnt = sourceCount.get(entry.sourceId) ?? 0;
    const max = entry.maxItemsAfterCompress ?? Infinity;
    if (cnt < max || mustKeepIds.has(key)) {
      finalEntries.push(entry);
      sourceCount.set(entry.sourceId, cnt + 1);
    }
  }

  // 按预算裁剪 prepend / appendSystem
  const prependEntries = finalEntries.filter(e => e.injectMode === 'prepend');
  const appendEntries  = finalEntries.filter(e => e.injectMode === 'appendSystem');

  // 超配额时从低分末尾裁
  function fitToBudget(entries: ContextEntry[], budget: number): ContextEntry[] {
    let total = entries.reduce((s, e) => s + e.text.length, 0);
    const res = [...entries];
    while (total > budget && res.length > 0) {
      // 从末尾（最低分）裁，但 mustKeep 不裁
      let removed = false;
      for (let i = res.length - 1; i >= 0; i--) {
        if (!res[i].mustKeep) {
          total -= res[i].text.length;
          res.splice(i, 1);
          removed = true;
          break;
        }
      }
      if (!removed) break; // 全是 mustKeep，不再裁
    }
    return res;
  }

  const finalPrepend = options.dryRun ? prependEntries : fitToBudget(prependEntries, options.maxPrependChars);
  const finalAppend  = options.dryRun ? appendEntries  : fitToBudget(appendEntries, options.maxAppendChars);

  const totalDropped = allEntries.length - (finalPrepend.length + finalAppend.length);

  const stats: LucasCompressionStats = {
    before_prepend_chars,
    after_prepend_chars: finalPrepend.reduce((s, e) => s + e.text.length, 0),
    before_append_chars,
    after_append_chars:  finalAppend.reduce((s, e) => s + e.text.length, 0),
    dropped_entries:     totalDropped,
    expired_dropped:     expiredDropped,
    dedup_dropped:       dedupDropped,
    semantic_dropped:    semanticDropped,
  };

  const compressedResult: DynamicContextResult = {
    prepend:      finalPrepend.map(e => e.text),
    appendSystem: finalAppend.map(e => e.text),
    meta: {
      prepend:      finalPrepend,
      appendSystem: finalAppend,
    },
  };

  return { result: compressedResult, stats };
}
