/**
 * AgentRegistry — 自动生成 Agent 的 Tier 体系与容量策略
 *
 * 基础 Agent（Lucas / Andy / Lisa / Main）在 Tier 体系之外，始终全轴运行。
 * 自动生成的 Agent 创建前必须经过 registry.canCreate(tier) 检查。
 *
 * Tier 定义（Axis 编号与文档三轴一致）：
 *   Axis 1 = 能力进化，Axis 2 = 协作进化，Axis 3 = 本地专精进化
 *
 *   Tier 0 (Ephemeral)  — 无进化，无上限，自动清理
 *   Tier 1 (Lightweight) — 最多 10 个，仅 Axis 1（能力），5 能力，100 条 corpus FIFO，30 天休眠
 *   Tier 2 (Standard)   — 最多  5 个，Axis 1+3（能力+本地专精），15 能力，500 条 corpus，60 天休眠
 *   Tier 3 (Full)       — 最多  2 个，全轴（含 Axis 2 协作），无限制，90 天休眠
 *
 * 数据：data/agents/registry.json
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ── 类型定义 ───────────────────────────────────────────────────────────────

export type AgentTier = 0 | 1 | 2 | 3;

export interface TierPolicy {
  /** 同时存活的最大数量（0 = 无限制） */
  maxCount: number;
  /** 启用的进化轴（1=能力进化, 2=协作进化, 3=本地专精进化） */
  axes: number[];
  /** 最多可安装的能力数（0 = 无限制） */
  maxCapabilities: number;
  /** corpus 保留条数，超出按 FIFO 滚动（0 = 无限制） */
  corpusLimit: number;
  /** 不活跃超过此天数进入休眠（0 = 永不休眠） */
  dormancyDays: number;
}

export const TIER_POLICIES: Record<AgentTier, TierPolicy> = {
  0: { maxCount: 0,  axes: [],        maxCapabilities: 0,  corpusLimit: 0,   dormancyDays: 0  },
  1: { maxCount: 10, axes: [3],       maxCapabilities: 5,  corpusLimit: 100, dormancyDays: 30 },
  2: { maxCount: 5,  axes: [1, 3],    maxCapabilities: 15, corpusLimit: 500, dormancyDays: 60 },
  3: { maxCount: 2,  axes: [1, 2, 3], maxCapabilities: 0,  corpusLimit: 0,   dormancyDays: 90 },
};

export interface AgentRecord {
  agentId: string;
  tier: AgentTier;
  /** 创建此 Agent 的基础 Agent ID（lucas / andy / lisa） */
  parentAgentId?: string;
  createdAt: string;
  lastActiveAt: string;
  /** 累计对话轮次 */
  activityCount: number;
  status: "active" | "dormant" | "evicted";
  /** 已安装的能力名称列表 */
  capabilities: string[];
}

interface RegistryData {
  version: number;
  /** key = agentId */
  agents: Record<string, AgentRecord>;
}

// 基础 Agent 不受 Tier 约束
export const BASE_AGENTS = new Set(["lucas", "andy", "lisa", "main"]);

export function isBaseAgent(agentId: string): boolean {
  return BASE_AGENTS.has(agentId);
}

// ── AgentRegistry ─────────────────────────────────────────────────────────

export class AgentRegistry {
  private data: RegistryData;

  constructor(private registryFile: string) {
    this.data = this.load();
  }

  private load(): RegistryData {
    try {
      return JSON.parse(readFileSync(this.registryFile, "utf8")) as RegistryData;
    } catch {
      return { version: 1, agents: {} };
    }
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.registryFile), { recursive: true });
      writeFileSync(this.registryFile, JSON.stringify(this.data, null, 2), "utf8");
    } catch { /* best effort */ }
  }

  /**
   * 检查指定 Tier 是否还有容量可以创建新 Agent。
   * 基础 Agent 不需要调用此方法。
   */
  canCreate(tier: AgentTier): boolean {
    if (tier === 0) return true; // Ephemeral 无上限
    const policy = TIER_POLICIES[tier];
    const activeCount = Object.values(this.data.agents)
      .filter((a) => a.tier === tier && a.status === "active").length;
    return activeCount < policy.maxCount;
  }

  /**
   * 注册一个新的自动生成 Agent，或更新已存在记录的活跃时间。
   */
  register(agentId: string, tier: AgentTier, parentAgentId?: string): AgentRecord {
    const existing = this.data.agents[agentId];
    if (existing) {
      existing.lastActiveAt = new Date().toISOString();
      existing.activityCount++;
      if (existing.status === "dormant") existing.status = "active";
      this.save();
      return existing;
    }
    const record: AgentRecord = {
      agentId,
      tier,
      parentAgentId,
      createdAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      activityCount: 1,
      status: "active",
      capabilities: [],
    };
    this.data.agents[agentId] = record;
    this.save();
    return record;
  }

  /** 记录 Agent 活跃（对话完成时调用） */
  recordActivity(agentId: string): void {
    const rec = this.data.agents[agentId];
    if (!rec) return;
    rec.lastActiveAt = new Date().toISOString();
    rec.activityCount++;
    if (rec.status === "dormant") rec.status = "active";
    this.save();
  }

  /**
   * 为 Agent 安装一个能力。
   * 返回 false 表示已达到该 Tier 的能力上限。
   */
  addCapability(agentId: string, capabilityName: string): boolean {
    const rec = this.data.agents[agentId];
    if (!rec) return false;
    const policy = TIER_POLICIES[rec.tier];
    if (policy.maxCapabilities > 0 && rec.capabilities.length >= policy.maxCapabilities) {
      return false; // 容量已满
    }
    if (!rec.capabilities.includes(capabilityName)) {
      rec.capabilities.push(capabilityName);
      this.save();
    }
    return true;
  }

  /**
   * 尝试将 Agent 提升到上一 Tier。
   * 返回 false 表示已是 Tier 3 或目标 Tier 已满。
   */
  promote(agentId: string): boolean {
    const rec = this.data.agents[agentId];
    if (!rec || rec.tier >= 3) return false;
    const nextTier = (rec.tier + 1) as AgentTier;
    if (!this.canCreate(nextTier)) return false;
    rec.tier = nextTier;
    this.save();
    return true;
  }

  /** 将 Agent 降级到下一 Tier */
  demote(agentId: string): void {
    const rec = this.data.agents[agentId];
    if (!rec || rec.tier <= 0) return;
    rec.tier = (rec.tier - 1) as AgentTier;
    this.save();
  }

  /** 标记为休眠（超过 dormancyDays 不活跃时触发） */
  markDormant(agentId: string): void {
    const rec = this.data.agents[agentId];
    if (!rec) return;
    rec.status = "dormant";
    this.save();
  }

  /** 驱逐（容量超限时清理最低活跃度的 Agent） */
  evict(agentId: string): void {
    const rec = this.data.agents[agentId];
    if (!rec) return;
    rec.status = "evicted";
    this.save();
  }

  /**
   * 检查所有 active Agent，返回需要进入休眠的 agentId 列表。
   * 调用方负责对每个返回的 ID 调用 markDormant()。
   */
  checkDormancy(): string[] {
    const dormant: string[] = [];
    const now = Date.now();
    for (const [id, rec] of Object.entries(this.data.agents)) {
      if (rec.status !== "active") continue;
      const policy = TIER_POLICIES[rec.tier];
      if (policy.dormancyDays === 0) continue;
      const daysSince = (now - new Date(rec.lastActiveAt).getTime()) / 86_400_000;
      if (daysSince > policy.dormancyDays) dormant.push(id);
    }
    return dormant;
  }

  /**
   * 获取各 Tier 当前容量状态。
   * base agents 不计入。
   */
  getCapacityStatus(): Record<AgentTier, { count: number; max: number }> {
    const result = {} as Record<AgentTier, { count: number; max: number }>;
    for (const tier of [0, 1, 2, 3] as AgentTier[]) {
      const count = Object.values(this.data.agents)
        .filter((a) => a.tier === tier && a.status === "active").length;
      result[tier] = { count, max: TIER_POLICIES[tier].maxCount };
    }
    return result;
  }

  getAgent(agentId: string): AgentRecord | undefined {
    return this.data.agents[agentId];
  }

  listActive(tier?: AgentTier): AgentRecord[] {
    return Object.values(this.data.agents).filter(
      (a) => a.status === "active" && (tier === undefined || a.tier === tier),
    );
  }

  /** 检查 registryFile 是否存在（供首次启动判断） */
  static exists(registryFile: string): boolean {
    return existsSync(registryFile);
  }
}
