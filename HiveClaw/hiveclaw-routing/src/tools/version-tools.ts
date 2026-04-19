/**
 * 版本管理工具（大师用）
 *
 * list_model_versions / start_canary / promote_version / rollback_version / run_eval / compare_versions
 */

import type { ModelVersion, MasterRole, EvalScores, VersionStatus } from "../types.js";

// ─── 版本命名 ────────────────────────────────────────────────────────────────

/**
 * 生成下一个版本号。格式：{year}Q{quarter}.{batch_seq:03d}
 * 例：2026Q2.003
 */
export function nextVersionId(role: MasterRole, existingVersions: ModelVersion[]): string {
  const now = new Date();
  const year = now.getFullYear();
  const quarter = Math.ceil((now.getMonth() + 1) / 3);
  const prefix = `${year}Q${quarter}`;

  const sameQuarter = existingVersions.filter((v) => v.version.startsWith(prefix));
  const seq = sameQuarter.length + 1;
  return `${prefix}.${String(seq).padStart(3, "0")}`;
}

// ─── 工具实现 ────────────────────────────────────────────────────────────────

/**
 * list_model_versions：列出给定角色的所有版本及状态。
 */
export async function listModelVersions(params: {
  role: MasterRole;
  storage_root: string;
}): Promise<ModelVersion[]> {
  // TODO: 从 storage_root/versions/{role}/ 读取所有版本元数据
  throw new Error("list_model_versions: not yet implemented (Dry Run)");
}

/**
 * start_canary：将 shadow 版本开始承接一定比例的真实流量。
 *
 * Canary 阶段评估标准：
 * - 评估集：500 条固定保留样本（不用于训练）
 * - 最少持续 2h，样本量 ≥ 100 条真实请求
 * - 任意维度下降 > 5% → 触发自动回滚
 */
export async function startCanary(params: {
  role: MasterRole;
  version: string;
  pct: number;       // 0-100，建议从 10 开始
  storage_root: string;
}): Promise<{ started: true; shadow_version: string; canary_pct: number }> {
  if (params.pct < 1 || params.pct > 50) {
    throw new Error("canary_pct must be between 1 and 50 (start low, e.g. 10)");
  }
  // TODO: 更新 storage_root/versions/{role}/{version}.json → canary_pct = params.pct
  // TODO: 通知流量路由层切分流量
  throw new Error("start_canary: traffic routing not yet implemented (Dry Run)");
}

/**
 * promote_version：Canary 评估通过后，将 shadow 版本晋升为 active。
 *
 * 晋升流程：
 * 1. 当前 active → status=rollback_target，设置 retire_after = 48h 后
 * 2. shadow → status=active，canary_pct 清除
 * 3. 流量路由层切换至新 active
 */
export async function promoteVersion(params: {
  role: MasterRole;
  version: string;
  storage_root: string;
}): Promise<{ promoted: true; previous_active: string | null }> {
  // TODO: 读取当前 active 版本
  // TODO: 执行状态转换
  // TODO: 通知流量路由层全量切换
  throw new Error("promote_version: not yet implemented (Dry Run)");
}

/**
 * rollback_version：将 active 版本回滚到指定版本。
 * 适用场景：Canary 检测未覆盖的业务特定问题，需要手动回滚。
 */
export async function rollbackVersion(params: {
  role: MasterRole;
  version: string;   // 目标版本，必须是 rollback_target 或近 3 个历史版本之一
  storage_root: string;
}): Promise<{ rolled_back: true; from: string; to: string }> {
  // TODO: 验证目标版本在允许的回滚范围内
  // TODO: 执行状态转换（当前 active → retired，目标版本 → active）
  // TODO: 通知流量路由层
  throw new Error("rollback_version: not yet implemented (Dry Run)");
}

/**
 * run_eval：在固定评估集上运行指标评估。
 *
 * 评估集：500 条固定保留样本（每角色，永不用于训练）
 * 评估维度：ROUGE-L / 任务完成率 / DPO 偏好分
 */
export async function runEval(params: {
  role: MasterRole;
  version: string;
  eval_set_path: string;
  storage_root: string;
}): Promise<EvalScores> {
  // TODO: 加载评估集
  // TODO: 对指定版本的模型逐条推理
  // TODO: 计算三个维度的指标
  throw new Error("run_eval: model inference not yet available (Dry Run)");
}

/**
 * compare_versions：对比两个版本的评估分数，判断是否存在质量回退（>5%）。
 */
export async function compareVersions(params: {
  role: MasterRole;
  v1: string;
  v2: string;
  storage_root: string;
}): Promise<{
  v1: EvalScores;
  v2: EvalScores;
  regression_detected: boolean;
  regression_details: string[];
}> {
  // TODO: 分别读取两个版本的 eval_scores
  throw new Error("compare_versions: not yet implemented (Dry Run)");
}

// ─── 自动回滚检查 ────────────────────────────────────────────────────────────

const REGRESSION_THRESHOLD = 0.05; // 5% 相对下降触发回滚

/**
 * 判断 candidate 版本相对 baseline 是否存在质量回退。
 * 纯函数，可在任意位置调用。
 */
export function detectRegression(
  baseline: EvalScores,
  candidate: EvalScores,
): { regression: boolean; details: string[] } {
  const details: string[] = [];

  const dims: Array<keyof EvalScores> = ["rouge_l", "task_completion", "dpo_preference"];
  for (const dim of dims) {
    const base = baseline[dim];
    const cand = candidate[dim];
    if (base > 0) {
      const relativeDrop = (base - cand) / base;
      if (relativeDrop > REGRESSION_THRESHOLD) {
        details.push(
          `${dim}: ${(relativeDrop * 100).toFixed(1)}% 下降 (${base.toFixed(3)} → ${cand.toFixed(3)})`,
        );
      }
    }
  }

  return { regression: details.length > 0, details };
}
