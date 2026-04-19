/**
 * 算力适配层
 *
 * 屏蔽不同算力提供商的 API 差异，对上层暴露统一的训练任务接口。
 * 路由策略：优先选满足 deadline 且当前报价最低的提供商。
 */

import type { TrainingJob, JobResult, JobProgress } from "./types.js";

// ─── 统一接口 ────────────────────────────────────────────────────────────────

export interface ComputeAdapter {
  readonly name: string;
  /** 是否支持国内数据（敏感语料只走国内提供商）*/
  readonly domesticOnly: boolean;

  /** 提交训练任务，返回提供商侧的 job_id */
  submit(job: TrainingJob): Promise<string>;

  /** 查询任务进度 */
  getStatus(providerJobId: string): Promise<JobProgress>;

  /** 取消任务 */
  cancel(providerJobId: string): Promise<void>;

  /** 预估费用（USD），用于路由决策 */
  estimateCost(job: TrainingJob): Promise<number>;

  /** 当前是否有可用算力（可用于接受新任务）*/
  isAvailable(): Promise<boolean>;
}

// ─── 硅基流动适配器 ──────────────────────────────────────────────────────────

export class SiliconFlowAdapter implements ComputeAdapter {
  readonly name = "siliconflow";
  readonly domesticOnly = true;

  private readonly apiKey: string;
  private readonly baseUrl = "https://api.siliconflow.cn/v1/training";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async submit(job: TrainingJob): Promise<string> {
    // TODO: 实现硅基流动训练任务提交
    // POST ${this.baseUrl}/jobs
    // 参数映射：job.training_config → 硅基流动 API 格式
    throw new Error("SiliconFlowAdapter.submit: not yet implemented (Dry Run)");
  }

  async getStatus(providerJobId: string): Promise<JobProgress> {
    // TODO: GET ${this.baseUrl}/jobs/${providerJobId}
    throw new Error("SiliconFlowAdapter.getStatus: not yet implemented (Dry Run)");
  }

  async cancel(providerJobId: string): Promise<void> {
    // TODO: DELETE ${this.baseUrl}/jobs/${providerJobId}
    throw new Error("SiliconFlowAdapter.cancel: not yet implemented (Dry Run)");
  }

  async estimateCost(job: TrainingJob): Promise<number> {
    // TODO: POST ${this.baseUrl}/estimate
    // 临时估算：基于 epoch × dataset_size × GPU-hour 单价
    throw new Error("SiliconFlowAdapter.estimateCost: not yet implemented (Dry Run)");
  }

  async isAvailable(): Promise<boolean> {
    // TODO: GET ${this.baseUrl}/availability
    return false;
  }
}

// ─── 火山方舟适配器 ──────────────────────────────────────────────────────────

export class VolcengineAdapter implements ComputeAdapter {
  readonly name = "volcengine";
  readonly domesticOnly = true;

  private readonly apiKey: string;
  private readonly baseUrl = "https://api.volcengine.com/ark/v3/fine_tunes";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async submit(job: TrainingJob): Promise<string> {
    throw new Error("VolcengineAdapter.submit: not yet implemented (Dry Run)");
  }

  async getStatus(providerJobId: string): Promise<JobProgress> {
    throw new Error("VolcengineAdapter.getStatus: not yet implemented (Dry Run)");
  }

  async cancel(providerJobId: string): Promise<void> {
    throw new Error("VolcengineAdapter.cancel: not yet implemented (Dry Run)");
  }

  async estimateCost(job: TrainingJob): Promise<number> {
    throw new Error("VolcengineAdapter.estimateCost: not yet implemented (Dry Run)");
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}

// ─── Together.ai 适配器 ──────────────────────────────────────────────────────

export class TogetherAdapter implements ComputeAdapter {
  readonly name = "together";
  readonly domesticOnly = false;

  private readonly apiKey: string;
  private readonly baseUrl = "https://api.together.xyz/v1/fine-tunes";

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async submit(job: TrainingJob): Promise<string> {
    throw new Error("TogetherAdapter.submit: not yet implemented (Dry Run)");
  }

  async getStatus(providerJobId: string): Promise<JobProgress> {
    throw new Error("TogetherAdapter.getStatus: not yet implemented (Dry Run)");
  }

  async cancel(providerJobId: string): Promise<void> {
    throw new Error("TogetherAdapter.cancel: not yet implemented (Dry Run)");
  }

  async estimateCost(job: TrainingJob): Promise<number> {
    throw new Error("TogetherAdapter.estimateCost: not yet implemented (Dry Run)");
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}

// ─── 调度器 ──────────────────────────────────────────────────────────────────

export interface SchedulerOptions {
  /** 是否包含敏感数据（true = 只走国内提供商）*/
  sensitiveData?: boolean;
}

export class ComputeScheduler {
  private adapters: ComputeAdapter[];

  constructor(adapters: ComputeAdapter[]) {
    this.adapters = adapters;
  }

  /**
   * 选择最优提供商并提交训练任务。
   *
   * 路由策略：
   * 1. 过滤：sensitiveData=true 时只考虑 domesticOnly 的提供商
   * 2. 过滤：isAvailable() = false 的提供商排除
   * 3. 按 estimateCost 升序排列，选最低价且能满足 deadline 的
   * 4. 单次任务不跨提供商（避免数据传输成本）
   */
  async submit(job: TrainingJob, opts: SchedulerOptions = {}): Promise<string> {
    const candidates = await this.rankCandidates(job, opts);
    if (candidates.length === 0) {
      throw new Error("No available compute providers for this job");
    }

    // 按失败重试逻辑：最多 3 次，指数退避，然后切下一个提供商
    for (const adapter of candidates) {
      try {
        return await this.submitWithRetry(adapter, job, 3);
      } catch (err) {
        console.error(`[compute-scheduler] ${adapter.name} failed:`, err);
        // 继续尝试下一个提供商
      }
    }

    throw new Error("All compute providers failed. Job written to failure queue.");
  }

  private async rankCandidates(
    job: TrainingJob,
    opts: SchedulerOptions,
  ): Promise<ComputeAdapter[]> {
    const filtered = this.adapters.filter(
      (a) => !opts.sensitiveData || a.domesticOnly,
    );

    const available: Array<{ adapter: ComputeAdapter; cost: number }> = [];
    for (const adapter of filtered) {
      if (!(await adapter.isAvailable())) continue;
      try {
        const cost = await adapter.estimateCost(job);
        available.push({ adapter, cost });
      } catch {
        // estimateCost 失败视为不可用
      }
    }

    return available
      .sort((a, b) => a.cost - b.cost)
      .map((x) => x.adapter);
  }

  private async submitWithRetry(
    adapter: ComputeAdapter,
    job: TrainingJob,
    maxRetries: number,
  ): Promise<string> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      try {
        return await adapter.submit(job);
      } catch (err) {
        lastErr = err;
        // 指数退避：1s, 2s, 4s
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
      }
    }
    throw lastErr;
  }
}
