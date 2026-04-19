/**
 * 训练管理工具（大师用）
 *
 * check_training_queue / submit_training_job / get_job_status
 */

import type { TrainingJob, JobProgress, MasterRole } from "../types.js";
import { ComputeScheduler } from "../compute-adapter.js";

// 触发条件常量
const MIN_NEW_DPO_SAMPLES = 200;   // 跨实例累计新增 DPO ≥ 200 条
const MIN_DAYS_BETWEEN    = 14;    // 距上次训练 ≥ 14 天

export interface QueueStatus {
  role: MasterRole;
  pending_dpo: number;
  pending_sft: number;
  last_training_at: string | null;
  days_since_last: number | null;
  trigger_ready: boolean;
  trigger_reason: string;
  active_job_id: string | null;
}

/**
 * check_training_queue：查看训练队列当前状态及是否满足触发条件。
 */
export async function checkTrainingQueue(params: {
  role: MasterRole;
  storage_root: string;
}): Promise<QueueStatus> {
  // TODO: 从 storage_root/queue/{role}.json 加载队列状态
  // TODO: 统计 pending 语料数量（整理完毕、未进入训练的）
  // TODO: 读取 last_training_at

  // Dry Run 返回 stub 状态
  const now = new Date();
  return {
    role: params.role,
    pending_dpo: 0,
    pending_sft: 0,
    last_training_at: null,
    days_since_last: null,
    trigger_ready: false,
    trigger_reason: "Dry Run: queue state not yet connected to storage",
    active_job_id: null,
  };
}

/**
 * submit_training_job：满足触发条件时提交训练任务。
 *
 * 触发条件（全部满足）：
 * 1. 新增 DPO 样本 ≥ 200 条（跨实例累计）
 * 2. 距上次训练 ≥ 14 天
 * 3. 当前无进行中的训练任务
 *
 * 训练集 = 本次新增语料（85%）+ 历史语料随机重放（15%）
 */
export async function submitTrainingJob(
  params: {
    role: MasterRole;
    base_model_id: string;
    storage_root: string;
    compute_budget_usd: number;
    deadline_hours: number;
  },
  scheduler: ComputeScheduler,
): Promise<{ job_id: string; provider: string } | { skipped: true; reason: string }> {
  const queue = await checkTrainingQueue({
    role: params.role,
    storage_root: params.storage_root,
  });

  if (!queue.trigger_ready) {
    return { skipped: true, reason: queue.trigger_reason };
  }
  if (queue.active_job_id) {
    return { skipped: true, reason: `Already has active job: ${queue.active_job_id}` };
  }

  // TODO: 打包训练数据集（新增 + 重放缓冲）到 storage_root/datasets/{role}/
  // TODO: 调用 scheduler.submit(job)

  const job: TrainingJob = {
    job_id: crypto.randomUUID(),
    role: params.role,
    dataset_path: `${params.storage_root}/datasets/${params.role}/latest.jsonl`,
    base_model_id: params.base_model_id,
    training_config: {
      method: "dpo",
      epochs: 3,
      learning_rate: 5e-5,
      batch_size: 16,
      lora_rank: 16,
      max_seq_len: 4096,
      replay_ratio: 0.15,
    },
    compute_budget_usd: params.compute_budget_usd,
    deadline_hours: params.deadline_hours,
    priority: "normal",
    created_at: new Date().toISOString(),
  };

  throw new Error(
    `submit_training_job: compute scheduler not yet connected (Dry Run). ` +
    `Would submit job_id=${job.job_id} for role=${params.role}`,
  );
}

/**
 * get_job_status：查询训练任务当前进度。
 */
export async function getJobStatus(params: {
  job_id: string;
  storage_root: string;
}): Promise<JobProgress> {
  // TODO: 从 storage_root/jobs/{job_id}.json 读取本地记录的任务状态
  // TODO: 如果 status=running，向算力提供商查询最新进度
  throw new Error("get_job_status: not yet implemented (Dry Run)");
}
