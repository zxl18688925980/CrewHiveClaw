/**
 * HiveClaw 核心类型定义
 *
 * 所有跨模块共享的接口在此统一声明，避免循环依赖。
 */

// ─── 角色 ──────────────────────────────────────────────────────────────────

export type MasterRole = "lucas" | "andy" | "lisa";
export type AllRole = MasterRole | "readme";

// ─── 语料 ──────────────────────────────────────────────────────────────────

export type CorpusType = "dpo" | "sft" | "pattern";

export type CorpusStatus = "active" | "archive";

export type ArchiveReason =
  | "time_decay"        // 时间衰减超过阈值
  | "behavior_drift"    // 行为漂移：近期 pattern 不一致
  | "explicit_deprecation" // SE 显式弃用该 pattern 类别
  | "quality_threshold" // 新版本质量阈值提升后降级（不溯及既往，仅新上传时触发）
  | "pattern_cap";      // 同一 pattern 变体超过 20 条，末位 archive

export interface CorpusEntry {
  id: string;                   // UUID，上传时生成
  role: MasterRole;
  type: CorpusType;
  instance_id: string;          // 来源实例，"seed" 表示 HomeAI 种子语料
  content: {
    prompt: string;
    chosen?: string;            // type=dpo 时必填
    rejected?: string;          // type=dpo 时必填
    output?: string;            // type=sft 时必填
  };
  tags: string[];               // 行为类型标签，如 ["需求澄清", "任务触发"]
  quality_score: number;        // 0-1，本地 SE 评分
  uploaded_at: string;          // ISO 8601
  // 生命周期字段
  status: CorpusStatus;
  created_at: string;
  archived_at?: string;
  archive_reason?: ArchiveReason;
  // 衰减跟踪
  effective_quality: number;    // 经时间衰减后的实际质量分，初始等于 quality_score
  last_decay_at?: string;
}

/** 语料上传请求（单条，来自本地实例）*/
export interface CorpusUploadItem {
  role: MasterRole;
  type: CorpusType;
  instance_id: string;
  content: CorpusEntry["content"];
  tags: string[];
  quality_score: number;
  uploaded_at: string;
}

/** 上传批次响应 */
export interface UploadBatchResult {
  received: number;
  accepted: number;
  rejected: number;
  reject_reasons: string[];
}

// ─── 训练任务 ───────────────────────────────────────────────────────────────

export interface TrainingConfig {
  method: "dpo" | "sft";
  epochs: number;
  learning_rate: number;
  batch_size: number;
  lora_rank: number;
  max_seq_len: number;
  /** 历史语料重放比例，推荐 0.15，防止灾难性遗忘 */
  replay_ratio: number;
}

export interface TrainingJob {
  job_id: string;
  role: MasterRole;
  dataset_path: string;         // 云端存储路径（训练数据集打包后）
  base_model_id: string;        // 如 "qwen3-72b-chat"
  training_config: TrainingConfig;
  compute_budget_usd: number;
  deadline_hours: number;
  priority: "normal" | "high";
  created_at: string;
}

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface JobResult {
  job_id: string;
  status: "completed" | "failed" | "cancelled";
  model_path: string;           // 训练产物存储路径
  actual_cost_usd: number;
  duration_hours: number;
  failure_reason?: string;
}

export interface JobProgress {
  job_id: string;
  status: JobStatus;
  progress_pct?: number;        // 0-100
  estimated_remaining_hours?: number;
}

// ─── 模型版本 ───────────────────────────────────────────────────────────────

export type VersionStatus = "active" | "shadow" | "retired" | "rollback_target";

export interface EvalScores {
  rouge_l: number;
  task_completion: number;
  dpo_preference: number;
}

export interface ModelVersion {
  /** 格式：{year}Q{quarter}.{batch_seq}，例：2026Q2.003 */
  version: string;
  role: MasterRole;
  base_model: string;
  training_completed_at: string;
  training_data: {
    dpo_count: number;
    sft_count: number;
    instance_count: number;
    date_range: [string, string];
  };
  eval_scores: EvalScores;
  vs_previous: {
    rouge_l_delta: string;
    task_completion_delta: string;
    dpo_preference_delta: string;
  };
  status: VersionStatus;
  /** 热切换：当前 shadow 版本的流量百分比（0-100）*/
  canary_pct?: number;
  /** active 版本被替代后保留 48h 作为紧急回滚备份 */
  retire_after?: string;
}

// ─── 语料平衡 ───────────────────────────────────────────────────────────────

/** 每个角色的行为类型分类标签 */
export const BEHAVIOR_TYPES: Record<MasterRole, string[]> = {
  lucas: ["需求澄清", "陪伴支持", "任务触发", "反馈收集"],
  andy:  ["spec设计", "技术选型", "质量判断", "踩坑记录"],
  lisa:  ["代码实现", "错误修复", "工具选用", "交付报告"],
};

export interface TypeDistribution {
  type: string;
  count: number;
  pct: number;
}

export interface BalanceReport {
  role: MasterRole;
  total: number;
  distribution: TypeDistribution[];
  /** 超过 50% 的类型，下轮训练需限速 */
  over_represented: string[];
  /** 低于 5% 的类型，触发稀缺告警 */
  scarce: string[];
}

// ─── 实例注册 ───────────────────────────────────────────────────────────────

export type OrgType = "family" | "company" | "team";

export interface InstanceRegistration {
  instance_id: string;
  org_type: OrgType;
  contact_se: string;
  agents_enabled: MasterRole[];
  corpus_consent: boolean;
}

export interface InstanceRecord extends InstanceRegistration {
  api_key: string;               // JWT，含 instance_id 字段
  registered_at: string;
  corpus_quota_used_pct: number; // 单实例已占总池的百分比
}

// ─── Readme 大师 ────────────────────────────────────────────────────────────

export interface ReadmeIntakeForm {
  org_type: OrgType;
  member_count: number;
  member_roles: string[];        // 如 ["爸爸/决策者", "妈妈/日常使用"]
  core_scenarios: string[];      // 最想解决的前 3 个问题
  channel: string;               // 如 "企业微信", "Slack"
  ai_maturity: "beginner" | "experienced" | "deployed";
  special_constraints: string[]; // 隐私要求/行业规范等
}

export interface ReadmeSample {
  id: string;
  org_type: OrgType;
  scenarios: string[];
  /** 去标识化 Readme 摘要（用于检索，不是全文）*/
  summary: string;
  /** 结构摘要：哪些章节存在，各章节的核心内容 */
  structure_summary: string[];
  verified_at: string;           // SE 验收时间
}

export interface AntiPattern {
  id: string;
  scenario: string;
  mistake: string;
  fix: string;
  source_instance_type: OrgType;
  added_at: string;
}
