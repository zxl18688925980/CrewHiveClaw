/**
 * 语料管理工具（大师用）
 *
 * corpus_intake / corpus_dedup / corpus_classify / corpus_quality_filter / corpus_balance_check
 */

import type { CorpusEntry, CorpusUploadItem, UploadBatchResult, MasterRole } from "../types.js";
import {
  computeQualityThreshold,
  checkBehaviorBalance,
  checkInstanceQuota,
} from "../corpus-lifecycle.js";

// ─── 工具实现 ────────────────────────────────────────────────────────────────

/**
 * corpus_intake：接收上传批次，运行格式校验 + 实例配额检查。
 * 校验通过的条目写入临时暂存区，等待后续去重和分类。
 */
export async function corpusIntake(params: {
  batch: CorpusUploadItem[];
  instance_id: string;
  master_version_seq: number;
  storage_root: string;
}): Promise<UploadBatchResult> {
  const { batch, instance_id, master_version_seq, storage_root } = params;

  // TODO: 从 storage_root 加载当前语料池
  const allEntries: CorpusEntry[] = [];

  const threshold = computeQualityThreshold(master_version_seq);
  const accepted: CorpusEntry[] = [];
  const rejectReasons: string[] = [];

  // 配额预检
  if (!checkInstanceQuota(instance_id, allEntries, batch.length)) {
    return {
      received: batch.length,
      accepted: 0,
      rejected: batch.length,
      reject_reasons: [`实例 ${instance_id} 超出语料配额上限（30%），本次批次全量拒绝`],
    };
  }

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i]!;
    const idx = i + 1;

    // 格式校验
    if (!item.content.prompt) {
      rejectReasons.push(`第${idx}条：prompt 为空`);
      continue;
    }
    if (item.type === "dpo" && (!item.content.chosen || !item.content.rejected)) {
      rejectReasons.push(`第${idx}条：type=dpo 时 chosen/rejected 不可为空`);
      continue;
    }
    if (item.type === "sft" && !item.content.output) {
      rejectReasons.push(`第${idx}条：type=sft 时 output 不可为空`);
      continue;
    }

    // 质量阈值
    if (item.quality_score < threshold) {
      rejectReasons.push(
        `第${idx}条：quality_score ${item.quality_score} 低于当前阈值 ${threshold}`,
      );
      continue;
    }

    const entry: CorpusEntry = {
      id: crypto.randomUUID(),
      role: item.role,
      type: item.type,
      instance_id: item.instance_id,
      content: item.content,
      tags: item.tags,
      quality_score: item.quality_score,
      uploaded_at: item.uploaded_at,
      status: "active",
      created_at: new Date().toISOString(),
      effective_quality: item.quality_score,
    };
    accepted.push(entry);
  }

  // TODO: 将 accepted 写入 storage_root 暂存区（pending-dedup/）

  return {
    received: batch.length,
    accepted: accepted.length,
    rejected: batch.length - accepted.length,
    reject_reasons: rejectReasons,
  };
}

/**
 * corpus_dedup：对给定角色的待处理语料进行语义去重。
 * 同实例内相似度 > 0.92 的合并；跨实例的保留（多样性）。
 *
 * 实际语义相似度计算需要嵌入模型，Dry Run 阶段返回 stub 结果。
 */
export async function corpusDedup(params: {
  role: MasterRole;
  storage_root: string;
}): Promise<{ before: number; after: number; merged: number }> {
  // TODO: 加载 pending-dedup/ 下的待处理条目
  // TODO: 调用嵌入模型计算 cosine similarity
  // TODO: 同实例内相似度 > 0.92 → 合并，保留 quality_score 最高的
  // TODO: 将结果写入 pending-classify/
  throw new Error("corpus_dedup: embedding model not yet connected (Dry Run)");
}

/**
 * corpus_classify：按行为模式对语料分类打标。
 * tags 字段由本地 SE 上传时填写，此处做二次验证和补充。
 */
export async function corpusClassify(params: {
  role: MasterRole;
  storage_root: string;
}): Promise<{ classified: number; untagged: number }> {
  // TODO: 加载 pending-classify/ 下的条目
  // TODO: 验证 tags 是否在 BEHAVIOR_TYPES[role] 范围内
  // TODO: 无 tags 的条目通过小模型自动分类（Dry Run 阶段跳过，标记为 untagged）
  // TODO: 写入 pending-balance-check/
  throw new Error("corpus_classify: auto-classification model not yet connected (Dry Run)");
}

/**
 * corpus_quality_filter：检查并应用质量过滤。
 * 低于当前版本阈值的语料降级为 pattern 或 archive。
 */
export async function corpusQualityFilter(params: {
  role: MasterRole;
  min_score: number;
  storage_root: string;
}): Promise<{ passed: number; demoted: number; archived: number }> {
  // TODO: 遍历 active 语料，对 effective_quality < min_score 的执行降级
  throw new Error("corpus_quality_filter: not yet implemented (Dry Run)");
}

/**
 * corpus_balance_check：检查单实例配额和行为类型分布。
 */
export async function corpusBalanceCheck(params: {
  role: MasterRole;
  storage_root: string;
}): Promise<ReturnType<typeof checkBehaviorBalance>> {
  // TODO: 从 storage_root 加载 active 语料
  const entries: CorpusEntry[] = [];
  return checkBehaviorBalance(entries, params.role);
}
