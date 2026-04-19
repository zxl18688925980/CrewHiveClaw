/**
 * 语料生命周期管理
 *
 * 负责：时间衰减 / 质量阈值进化 / 行为类型平衡 / 去重策略 / 训练重放缓冲
 */

import type {
  CorpusEntry,
  MasterRole,
  BalanceReport,
  TypeDistribution,
} from "./types.js";
import { BEHAVIOR_TYPES } from "./types.js";

// ─── 质量阈值进化 ────────────────────────────────────────────────────────────

const QUALITY_BASE = 0.60;
const QUALITY_STEP = 0.02;
const QUALITY_CAP  = 0.80;

/**
 * 根据大师当前版本号计算质量入场阈值。
 * v1 → 0.60，v2 → 0.62，...，v11+ → 0.80（封顶）
 * 不溯及既往：只影响新上传语料的审核，不踢出已有语料。
 */
export function computeQualityThreshold(masterVersionSeq: number): number {
  const threshold = QUALITY_BASE + QUALITY_STEP * (masterVersionSeq - 1);
  return Math.min(threshold, QUALITY_CAP);
}

// ─── 时间衰减 ────────────────────────────────────────────────────────────────

const DECAY_PER_MONTH = 0.02;
const DECAY_START_MONTHS = 12; // 12 个月后开始衰减
const ARCHIVE_THRESHOLD  = 0.30; // 有效质量低于此值时自动 archive

/**
 * 对单条语料应用时间衰减。
 * 超过 12 个月未被标注为「常青」的语料，每月 effective_quality -= 0.02。
 */
export function applyTimeDecay(entry: CorpusEntry, now: Date = new Date()): CorpusEntry {
  if (entry.status === "archive") return entry;

  const createdAt = new Date(entry.created_at);
  const monthsElapsed = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24 * 30);

  if (monthsElapsed <= DECAY_START_MONTHS) return entry;

  const decayMonths = Math.floor(monthsElapsed - DECAY_START_MONTHS);
  const effectiveQuality = Math.max(
    0,
    entry.quality_score - DECAY_PER_MONTH * decayMonths,
  );

  const updated: CorpusEntry = {
    ...entry,
    effective_quality: effectiveQuality,
    last_decay_at: now.toISOString(),
  };

  if (effectiveQuality < ARCHIVE_THRESHOLD) {
    updated.status = "archive";
    updated.archive_reason = "time_decay";
    updated.archived_at = now.toISOString();
  }

  return updated;
}

// ─── 行为类型平衡 ────────────────────────────────────────────────────────────

const OVER_REPRESENTED_THRESHOLD = 0.50; // 超过 50% 触发限速
const SCARCE_THRESHOLD           = 0.05; // 低于 5% 触发稀缺告警

/**
 * 检查给定角色的语料在各行为类型上的分布是否平衡。
 * 仅统计 status=active 的语料。
 */
export function checkBehaviorBalance(
  entries: CorpusEntry[],
  role: MasterRole,
): BalanceReport {
  const active = entries.filter((e) => e.role === role && e.status === "active");
  const total = active.length;

  const knownTypes = BEHAVIOR_TYPES[role];
  const counts: Record<string, number> = {};
  for (const t of knownTypes) counts[t] = 0;

  for (const entry of active) {
    for (const tag of entry.tags) {
      if (tag in counts) counts[tag] = (counts[tag] ?? 0) + 1;
    }
  }

  const distribution: TypeDistribution[] = knownTypes.map((type) => ({
    type,
    count: counts[type] ?? 0,
    pct: total > 0 ? ((counts[type] ?? 0) / total) : 0,
  }));

  return {
    role,
    total,
    distribution,
    over_represented: distribution
      .filter((d) => d.pct > OVER_REPRESENTED_THRESHOLD)
      .map((d) => d.type),
    scarce: distribution
      .filter((d) => total > 0 && d.pct < SCARCE_THRESHOLD)
      .map((d) => d.type),
  };
}

// ─── 去重策略 ────────────────────────────────────────────────────────────────

/**
 * 同实例内高相似度（>0.92）→ 合并；
 * 跨实例同样高相似度 → 保留（多样性）。
 * 本函数只判断「是否应合并」，实际语义相似度计算由调用方提供 similarityScore。
 */
export function shouldMerge(
  a: CorpusEntry,
  b: CorpusEntry,
  similarityScore: number,
): boolean {
  if (a.instance_id !== b.instance_id) return false; // 跨实例保留多样性
  return similarityScore > 0.92;
}

// 同一 pattern 变体上限
const PATTERN_VARIANT_CAP = 20;
const PATTERN_VARIANT_KEEP = 10;

/**
 * 在给定的同 pattern 变体组内，超过 PATTERN_VARIANT_CAP 时
 * 返回应该 archive 的条目 ID 列表（保留质量分最高的 PATTERN_VARIANT_KEEP 条）。
 */
export function getPatternCapArchives(entries: CorpusEntry[]): string[] {
  if (entries.length <= PATTERN_VARIANT_CAP) return [];

  const sorted = [...entries].sort(
    (a, b) => b.effective_quality - a.effective_quality,
  );
  return sorted.slice(PATTERN_VARIANT_KEEP).map((e) => e.id);
}

// ─── 训练重放缓冲 ────────────────────────────────────────────────────────────

/**
 * 从历史语料中随机抽取重放缓冲，防止增量训练导致的灾难性遗忘。
 *
 * @param allHistorical - 所有历史 active 语料（不含本轮新增）
 * @param newCount      - 本轮新增语料数量
 * @param ratio         - 重放比例，推荐 0.15（即新增 100 条 → 重放 ~18 条历史语料）
 */
export function selectReplayBuffer(
  allHistorical: CorpusEntry[],
  newCount: number,
  ratio: number = 0.15,
): CorpusEntry[] {
  const replayCount = Math.round(newCount * ratio / (1 - ratio));
  if (replayCount <= 0 || allHistorical.length === 0) return [];

  // Fisher-Yates shuffle，取前 replayCount 条
  const pool = [...allHistorical];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }
  return pool.slice(0, Math.min(replayCount, pool.length));
}

// ─── 实例配额 ────────────────────────────────────────────────────────────────

const INSTANCE_QUOTA_MAX = 0.30; // 单实例不超过总池的 30%

/**
 * 检查新增语料后某实例是否超出配额。
 * @returns true = 未超出（可接收），false = 超出配额（拒绝）
 */
export function checkInstanceQuota(
  instanceId: string,
  allEntries: CorpusEntry[],
  newCount: number,
): boolean {
  const active = allEntries.filter((e) => e.status === "active");
  const totalAfter = active.length + newCount;
  if (totalAfter === 0) return true;

  const instanceCurrent = active.filter((e) => e.instance_id === instanceId).length;
  const instanceAfter = instanceCurrent + newCount;
  return instanceAfter / totalAfter <= INSTANCE_QUOTA_MAX;
}
