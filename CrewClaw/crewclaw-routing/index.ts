/**
 * crewclaw-routing 三层路由插件
 *
 * Layer 2 (before_model_resolve)
 *   complexityScore < localThreshold → 本地 LOCAL_MODEL_NAME (Ollama)
 *   否则 → 云端（Lucas→DeepSeek，Andy→MiniMax，Lisa→GLM-5）
 *   localThreshold 初始 0.0（全走云端），evolveRouting() 数据驱动小步提升
 *   Andy            → ANDY_PROVIDER/ANDY_MODEL 控制（默认 MiniMax）
 *   Lisa            → LISA_PROVIDER/LISA_MODEL 控制（默认 ZAI/GLM-5）
 *
 * Layer 3 (before_prompt_build)
 *   Lucas 响应前从 ChromaDB 查询相关记忆片段，注入为上下文
 *
 * Layer 1 (registerTool)
 *   trigger_development_pipeline：Lucas 识别到开发需求时调用，触发 Andy 三步流水线：
 *     Step 1  DeepSeek 调研（search: true）→ 技术背景
 *     Step 2  Codebase Reader → 已有代码风格 + Andy BOOTSTRAP.md
 *     Step 3  Plandex（模型跟着 Andy 走）→ Implementation Spec（Plandex 失败时 fallback Gateway Andy）
 *     Step 4  写 andy-corpus.jsonl（ADR 格式，含 ttl_days / superseded_by 生命周期字段）
 *     Step 5  触发 Lisa 实现（含语法验证指令）
 *     Step 5.5 Andy 验收（对照 spec 核查交付报告，输出验收结论）
 *     Step 6  Lucas 验收重包装（V字型右侧）→ 结果推回企业微信
 *             推送两次：规划完（推 1）+ Lucas 验收后（推 2）；降级链：Andy验收→Lisa原始报告
 *   trigger_lisa_implementation：Andy 专属，完成 spec 设计后交给 Lisa 实现（含集成点静态验证）
 *   report_bug：Lucas 专属，Bug 修复直通路径（跳过 Andy，直触 Lisa）；需提供 file + symptom + acceptance
 *   run_opencode：Lisa 专属工具，调用 opencode CLI 执行代码实现（opencode 通过 ~/.config/opencode/opencode.json 使用 zai/glm-5）
 *   report_implementation_issue：Lisa 专属，实现遇阻时向 Andy 反馈（V模型右侧回路）
 *   record_outcome_feedback：Lucas 专属，用户反馈好用/出问题时更新 Andy+Lisa 决策记忆 outcome
 *   list_active_tasks：Lucas 专属，查询当前排队/进行中任务列表
 *   cancel_task：Lucas 专属，叫停排队或进行中任务（pre-Lisa 检查点阻断实现）
 */

import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, chmodSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { spawn, execSync, spawnSync } from "node:child_process";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { AgentRegistry } from "./agent-registry.js";
import { buildDynamicContext, type ContextResolvers } from "./context-handler.js";
import type { SessionParams } from "./context-sources.js";

// ── 配置 ──────────────────────────────────────────────────────────────────

const GATEWAY_URL      = process.env.GATEWAY_URL              || "http://localhost:18789";
const GATEWAY_TOKEN    = process.env.OPENCLAW_GATEWAY_TOKEN   || "696673d08d0ee98f3e66a30698ab4c1152b7c8784ae424d0";
// ── Channel 端点（实例层配置，框架代码不感知具体 Channel 实现）────────────────
const CHANNEL_NAME           = process.env.CHANNEL_NAME            || "channel";
const CHANNEL_PUSH_URL       = process.env.CHANNEL_PUSH_URL        || "http://localhost:3003/api/channel/push-reply";
const CHANNEL_SEND_URL       = process.env.CHANNEL_SEND_URL        || "http://localhost:3003/api/channel/send-message";
const CHANNEL_SEND_FILE_URL  = process.env.CHANNEL_SEND_FILE_URL   || "http://localhost:3003/api/channel/send-file";
const CHANNEL_SEND_VOICE_URL = process.env.CHANNEL_SEND_VOICE_URL  || "http://localhost:3003/api/channel/send-voice";
const CHANNEL_NOTIFY_URL     = process.env.CHANNEL_NOTIFY_URL      || "http://localhost:3003/api/channel/notify-engineer";
const CHANNEL_BASE_URL       = process.env.CHANNEL_BASE_URL        || process.env.WECOM_BASE_URL || "";
const OPENCODE_BIN     = process.env.OPENCODE_BIN             || "opencode";
// const PLANDEX_BIN   = process.env.PLANDEX_BIN              || "plandex";  // plandex 已废除
const PROJECT_ROOT     = process.env.HOMEAI_ROOT              || `${process.env.HOME}/HomeAI`;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY         || "";
// 组织所有者 userId（实例通过 OWNER_ID 环境变量设置）
const OWNER_ID         = process.env.OWNER_ID                 || "ZengXiaoLong";
// 本地模型名（实例通过 LOCAL_MODEL_NAME 环境变量设置）
const LOCAL_MODEL      = process.env.LOCAL_MODEL_NAME         || "local-assistant";
// 优先级 Agent：从保留池取 Semaphore 槽位（逗号分隔，默认 lucas）
const PRIORITY_AGENTS  = new Set(
  (process.env.PRIORITY_AGENTS ?? "lucas").split(",").map(s => s.trim()).filter(Boolean)
);
// 前台 Agent ID：接待用户的主 Agent，所有「lucas专属」逻辑的实际持有者（新部署可改为 "monica" 等）
const FRONTEND_AGENT_ID = process.env.FRONTEND_AGENT_ID ?? "lucas";
// 最近一次 frontend agent 会话的 userId（供工具在无 session 上下文时使用，单用户场景安全）
let lastFrontendUserId = "";

// ── HomeAI 实例层配置（从 config/ 加载，不含业务逻辑）─────────────────────────
function loadInstanceConfig<T>(filename: string): T {
  const p = join(PROJECT_ROOT, "CrewHiveClaw", "CrewClaw", "crewclaw-routing", "config", filename);
  return JSON.parse(readFileSync(p, "utf8")) as T;
}
const _membersConfig       = loadInstanceConfig<{ profileMap: Record<string, string> }>("members.json");
const _signalsConfig       = loadInstanceConfig<{ behaviorPatternSignals: string[]; familyKnowledgeSignals: string[] }>("memory-signals.json");
const _infraConfig         = loadInstanceConfig<{ infraKeywords: string[] }>("infra-guard.json");
const _lucasBehavioralRules   = loadInstanceConfig<{ commitmentRule: string; silenceRule: string }>("lucas-behavioral-rules.json");
const _visitorRestrictions    = loadInstanceConfig<{ blockedTools: string[] }>("visitor-restrictions.json");
const VISITOR_BLOCKED_TOOLS   = new Set(_visitorRestrictions.blockedTools);

// ── Agent 协作线程历史（Andy↔Lisa 多轮协作）────────────────────────────────
const AGENT_THREAD_DIR    = join(PROJECT_ROOT, "data", "agent-threads");
const AGENT_THREAD_STORE  = 20;   // 最多保留 20 轮
const AGENT_THREAD_INJECT = 10;   // 每次注入最近 10 轮
const AGENT_THREAD_TTL    = 7 * 24 * 60 * 60 * 1000;  // 7 天过期
try { mkdirSync(AGENT_THREAD_DIR, { recursive: true }); } catch {}

// ── 增量蒸馏冷却（事件驱动感知侧，30 分钟/用户）────────────────────────────
const DISTILL_COOLDOWN_MS               = 30 * 60 * 1000;
const lastDistillTrigger                = new Map<string, number>();
const ACTIVE_THREAD_DISTILL_COOLDOWN_MS  = 6 * 60 * 60 * 1000;
const lastActiveThreadDistillTrigger     = new Map<string, number>();
// 主动积压排干：Lucas 对话结束时事件驱动触发，补充 off-peak 定时机制，6h 全局冷却
const PROACTIVE_DISPATCH_COOLDOWN_MS     = 6 * 60 * 60 * 1000;
let lastProactiveDispatchAt              = 0;
// 盲区蒸馏：recall_memory 找不到记录时按需触发，4 小时/用户冷却
const BLIND_SPOT_DISTILL_COOLDOWN_MS     = 4 * 60 * 60 * 1000;
const lastBlindSpotDistillTrigger        = new Map<string, number>();
const KUZU_PYTHON3_BIN    = "/opt/homebrew/opt/python@3.11/bin/python3.11";

type ThreadEntry = { role: "user" | "assistant"; text: string; ts: number };

// ── 时区统一：所有时间戳使用 CST（UTC+8，格式 2026-04-08T02:15:44+08:00）──
const nowCST   = (): string => new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00');
const todayCST = (): string => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const agoCST   = (ms: number): string => new Date(Date.now() - ms + 8 * 3600000).toISOString().replace('Z', '+08:00');

function agentThreadFile(threadId: string): string {
  return join(AGENT_THREAD_DIR, threadId.replace(/[^a-zA-Z0-9_\-:]/g, "_") + ".json");
}

function loadAgentThread(threadId: string): ThreadEntry[] {
  try {
    const raw = JSON.parse(readFileSync(agentThreadFile(threadId), "utf8")) as ThreadEntry[];
    const now = Date.now();
    const valid: ThreadEntry[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (now - raw[i].ts < AGENT_THREAD_TTL) { valid.push(raw[i], raw[i + 1]); }
    }
    return valid;
  } catch { return []; }
}

function appendAgentThread(threadId: string, userText: string, assistantText: string): void {
  const history = loadAgentThread(threadId);
  history.push({ role: "user", text: userText, ts: Date.now() });
  history.push({ role: "assistant", text: assistantText, ts: Date.now() });
  while (history.length > AGENT_THREAD_STORE * 2) history.splice(0, 2);
  try { writeFileSync(agentThreadFile(threadId), JSON.stringify(history)); } catch {}
}

function buildAgentThreadMessages(threadId: string): Array<{ role: string; content: string }> {
  const history = loadAgentThread(threadId);
  if (history.length === 0) return [];
  return history
    .slice(-(AGENT_THREAD_INJECT * 2))
    .map(h => ({ role: h.role, content: h.text.slice(0, 800) }))
    .filter(m => m.content.length > 0);
}

/** 当前 thread 已进行的协作轮次（user 消息数） */
function agentThreadRounds(threadId: string): number {
  return loadAgentThread(threadId).filter(e => e.role === "user").length;
}

// Lucas 云端模型路由
// LUCAS_CLOUD_PROVIDER: anthropic | deepseek | zai | ollama
const LUCAS_PROVIDER   = process.env.LUCAS_CLOUD_PROVIDER     || "anthropic";

// Andy 模型路由（与 Lucas before_model_resolve 同等原则）
// ANDY_PROVIDER: minimax | deepseek | zai | ollama
// ANDY_MODEL: 模型 ID（MiniMax-M2.7 / deepseek-chat / glm-5 / local-assistant）
const ANDY_PROVIDER    = process.env.ANDY_PROVIDER            || "minimax";
const ANDY_MODEL       = process.env.ANDY_MODEL               || "MiniMax-M2.7";

// Lisa 模型路由（OpenCode 模型选择跟着 Lisa 走）
// LISA_PROVIDER: zai | deepseek | ollama
// LISA_MODEL: 模型 ID
const LISA_PROVIDER    = process.env.LISA_PROVIDER            || "zai";
const LISA_MODEL       = process.env.LISA_MODEL               || "glm-5";

// OpenCode 子进程的模型（opencode CLI 通过 ~/.config/opencode/opencode.json 自定义 zai provider）
// 模型名格式：zai/glm-5（与 OpenClaw 中的 provider/model 格式相同）
// 若未设置，fallback 到 LISA_PROVIDER/LISA_MODEL
const OPENCODE_MODEL   = process.env.OPENCODE_MODEL           || `${LISA_PROVIDER}/${LISA_MODEL}`;

// ── Gateway 资源池配置 ─────────────────────────────────────────────────────
//
// 目的：防止 Andy/Lisa 的慢请求（MiniMax 超时）耗尽 Gateway session pool，
//       导致 Lucas 对话也无法响应（信任崩塌）。
//
// 设计：
//   Lucas 专属槽位 —— 始终为 Lucas 保留，不参与竞争，保障对话响应
//   竞争槽位       —— Andy / Lisa / 成员分身 / Main 排队竞争
//   安全阀超时     —— agent_end 未触发时（Gateway 挂死），120s 后强制释放槽位
//
// 配置项通过环境变量覆盖，无需改代码：
//   LUCAS_RESERVED_SLOTS  默认 2（Lucas 专属）
//   GATEWAY_SHARED_SLOTS  默认 3（其他 Agent 竞争）

const LUCAS_RESERVED_SLOTS = parseInt(process.env.LUCAS_RESERVED_SLOTS  || "5", 10);
const GATEWAY_SHARED_SLOTS  = parseInt(process.env.GATEWAY_SHARED_SLOTS  || "5", 10);
const SEMAPHORE_TIMEOUT_MS  = parseInt(process.env.SEMAPHORE_TIMEOUT_MS  || "120000", 10);

class Semaphore {
  private count: number;
  private readonly queue: Array<() => void> = [];
  readonly label: string;

  constructor(count: number, label: string) {
    this.count = count;
    this.label = label;
  }

  acquire(): Promise<void> {
    if (this.count > 0) {
      this.count--;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => this.queue.push(resolve));
  }

  release(): void {
    const next = this.queue.shift();
    if (next) {
      next();
    } else {
      this.count++;
    }
  }

  get waiting(): number  { return this.queue.length; }
  get available(): number { return this.count; }
}

// ── 自进化框架配置 ─────────────────────────────────────────────────────────
//
// 三轴自进化框架，三个基础 Agent 共用相同机制，仅领域配置不同：
//   Axis 1：能力进化（capability-events → 成功率 → 低效能力淘汰 / 新能力引入）
//           Layer 3 工具路由每次调用写 capability-events → 诊断框架消费
//   Axis 2：协作进化（三信号分析 → 反思引擎 → 优化成员分身 prompt / 记忆策略）
//           信号：requirements.outcome + 对话参与深度 + 主动触达响应率
//   Axis 3：本地专精进化（route-events → threshold 进化 + corpus → 微调正循环）
//           曲线 A：evolveRouting() 每周分析，满足条件 threshold +0.05
//           曲线 B：corpus 语料 → quality-evaluator → MLX 增量微调
//
// 自动生成的 Agent 继承框架，受 AgentRegistry Tier 容量策略约束。
// 基础 Agent（Lucas/Andy/Lisa）在 Tier 体系之外，始终全轴运行。

interface AgentEvolutionConfig {
  agentId: string;
  corpusFile: string;
  // Axis 1
  localProvider: string;         // 本地路由 provider（mlx）
  localModel: string;            // 本地路由模型（gemma-4-lucas，mlx_lm.server on :8083）
  cloudProvider: string;         // 云端路由 provider
  cloudModel: string;            // 云端路由模型
  /** 初始本地阈值（0.0=始终云端，1.0=始终本地） */
  localThresholdInit: number;
  /** 进化目标：长期希望本地承载的流量比例 */
  localRatioTarget: number;
  // Axis 3
  capabilityEventsFile: string;
}

const AGENT_EVOLUTION_CONFIGS: AgentEvolutionConfig[] = [
  {
    agentId: "lucas",
    corpusFile: join(PROJECT_ROOT, "data/corpus/lucas-corpus.jsonl"),
    localProvider: "mlx",
    localModel: "gemma-4-lucas",
    cloudProvider: LUCAS_PROVIDER,
    cloudModel: process.env.LUCAS_CLOUD_MODEL || "claude-sonnet-4-6",
    localThresholdInit: 0.0,       // 起点：全走云端，积累数据后再进化
    localRatioTarget: 0.7,         // 目标：70% 走本地（家庭日常对话密集）
    capabilityEventsFile: join(PROJECT_ROOT, "data/learning/lucas-capability-events.jsonl"),
  },
  {
    agentId: "andy",
    corpusFile: join(PROJECT_ROOT, "data/corpus/andy-corpus.jsonl"),
    localProvider: "mlx",
    localModel: "gemma-4-lucas",
    cloudProvider: ANDY_PROVIDER,
    cloudModel: ANDY_MODEL,
    localThresholdInit: 0.0,       // Andy 以架构设计为主，起点保守
    localRatioTarget: 0.4,         // 目标：40%（架构复杂度高，更多依赖云端）
    capabilityEventsFile: join(PROJECT_ROOT, "data/learning/andy-capability-events.jsonl"),
  },
  {
    agentId: "lisa",
    corpusFile: join(PROJECT_ROOT, "data/corpus/lisa-corpus.jsonl"),
    localProvider: "mlx",
    localModel: "gemma-4-lucas",
    cloudProvider: LISA_PROVIDER,
    cloudModel: LISA_MODEL,
    localThresholdInit: 0.0,       // Lisa 实现类任务，起点保守
    localRatioTarget: 0.5,         // 目标：50%（标准实现可以逐步本地化）
    capabilityEventsFile: join(PROJECT_ROOT, "data/learning/lisa-capability-events.jsonl"),
  },
];

// ── Axis 1：路由阈值持久化（进化结果存盘）─────────────────────────────────
//
// 初始值由 localThresholdInit 决定（0.0 = 全云端）。
// evolveRouting() 分析 route-events 后更新此文件。
// before_model_resolve 每次请求读取此文件做路由决策。
//
// 阈值语义：complexityScore < localThreshold → 走本地
//   complexityScore: "chat"=0.2, "dev_or_complex"=0.8, 未知=0.5
//   localThreshold=0.0  → 全部走云端（初始状态，行为与旧版完全一致）
//   localThreshold=0.3  → 普通聊天(0.2)走本地，复杂任务继续走云端
//   localThreshold=0.9  → 绝大多数流量走本地

const ROUTING_THRESHOLDS_FILE = join(PROJECT_ROOT, "data/learning/routing-thresholds.json");

interface AgentRoutingState {
  localThreshold: number;
  localRatio30d: number;       // 过去 30 天本地比例（进化 KPI）
  lastAdjusted: string | null;
  totalEvents: number;
}

type RoutingThresholds = Record<string, AgentRoutingState>;

function loadRoutingThresholds(): RoutingThresholds {
  try {
    return JSON.parse(readFileSync(ROUTING_THRESHOLDS_FILE, "utf8")) as RoutingThresholds;
  } catch {
    // 首次启动：从各 Agent 的 localThresholdInit 初始化
    const init: RoutingThresholds = {};
    for (const cfg of AGENT_EVOLUTION_CONFIGS) {
      init[cfg.agentId] = {
        localThreshold: cfg.localThresholdInit,
        localRatio30d: 0.0,
        lastAdjusted: null,
        totalEvents: 0,
      };
    }
    return init;
  }
}

function saveRoutingThresholds(thresholds: RoutingThresholds): void {
  try {
    mkdirSync(dirname(ROUTING_THRESHOLDS_FILE), { recursive: true });
    writeFileSync(ROUTING_THRESHOLDS_FILE, JSON.stringify(thresholds, null, 2), "utf8");
  } catch { /* 写入失败不影响路由，保留上次阈值 */ }
}

// ── userId / 渠道归一化 ────────────────────────────────────────────────
//
// sessionKey 格式：agent:{agentId}:openai-user:{rawUser}
// rawUser 统一格式：{baseUserId}:{requestId}（独立 session，支持并发）
//   群聊:  "group:{fromUser}:{requestId}"  → isGroup=true,  userId=fromUser
//   私聊:  "{fromUser}:{requestId}"         → isGroup=false, userId=fromUser
//   旧格式: "wecom-ZengXiaoLong"（无冒号） → 兼容保留
//   直调:  "zengxiaolong"（无冒号）        → 兼容保留
//
// 所有请求独立 session，记忆通过 before_prompt_build 从 ChromaDB 注入。
// parseSessionUser 剥离 requestId 后缀，还原真实 userId 用于记忆查询。

// CHANNEL_USER_PREFIX：channel 层在 userId 上添加的前缀（如 "wecom-"），框架层在此剥离
const CHANNEL_USER_PREFIX = process.env.CHANNEL_USER_PREFIX || "wecom-";
function normalizeUserId(raw: string): string {
  return (CHANNEL_USER_PREFIX
    ? raw.replace(new RegExp(`^${CHANNEL_USER_PREFIX}`, "i"), "")
    : raw
  ).toLowerCase();
}

function parseSessionUser(sessionKey: string | undefined): { userId: string; isGroup: boolean } {
  // 取第四段起（去掉 "agent:agentId:openai-user:"），保留 group: 前缀
  const rawUser = sessionKey?.replace(/^[^:]+:[^:]+:[^:]+:/, "") ?? "default";
  if (rawUser.startsWith("group:")) {
    // group:fromUser:requestId → 取第一段作为 userId
    const afterGroup = rawUser.slice("group:".length);
    const colonIdx = afterGroup.indexOf(":");
    const userId = colonIdx >= 0 ? afterGroup.slice(0, colonIdx) : afterGroup;
    return { userId: normalizeUserId(userId), isGroup: true };
  }
  // 访客会话格式：visitor:{token}:{requestId} → 保留 visitor:{token}
  // 不能用 lastIndexOf(":") 剥离，因为 token 本身可能包含冒号（如 UUID）
  if (rawUser.startsWith("visitor:")) {
    // visitor:{token}:{requestId} → 取 visitor:{token}
    const afterVisitor = rawUser.slice("visitor:".length);
    // requestId 格式：纯数字时间戳，用正则匹配
    const requestIdMatch = afterVisitor.match(/:\d+$/);
    if (requestIdMatch) {
      const token = afterVisitor.slice(0, -requestIdMatch[0].length);
      return { userId: normalizeUserId(`visitor:${token}`), isGroup: false };
    }
    // 没有 requestId 后缀，直接返回
    return { userId: normalizeUserId(rawUser), isGroup: false };
  }
  // 普通用户：fromUser:requestId → 剥离最后一段 requestId 后缀
  const colonIdx = rawUser.lastIndexOf(":");
  const baseUserId = colonIdx >= 0 ? rawUser.slice(0, colonIdx) : rawUser;
  return { userId: normalizeUserId(baseUserId), isGroup: false };
}

// ── 文件写入工具 ───────────────────────────────────────────────────────

function appendJsonl(filePath: string, record: object): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    appendFileSync(filePath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    // 写入失败静默处理，不影响主流程
  }
}

// 读取 jsonl 文件为对象数组（生命周期管理使用）
function readJsonlEntries(filePath: string): Record<string, unknown>[] {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// 覆盖写回 jsonl 文件（生命周期管理使用，全量重写）
function writeJsonlEntries(filePath: string, entries: Record<string, unknown>[]): void {
  try {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, entries.map(e => JSON.stringify(e)).join("\n") + "\n", "utf8");
  } catch {
    // 写入失败静默处理
  }
}

// ── 依赖管理（Andy 管 Plandex，Lisa 管 OpenCode）──────────────────────────
//
// 这是 Agent 级别的自我管理，不是系统级依赖管理（系统依赖由 Main 负责）。
//
// 生命周期：
//   启动检查 → 缺失则安装 → 已装则检查升级窗口（upgradeIntervalDays）
//   → 升级前记录版本 → 升级后验证可用性
//   → 验证失败 → 按版本回退 → 回退失败则保留现状（工具错误由各工具的 error handler 兜底）
//
// 状态持久化：data/learning/dep-state.json（记录上次升级时间 + 版本号）
// 事件日志：data/learning/dep-installs.jsonl

interface DepSpec {
  agent: "andy" | "lisa";
  name: string;
  bin: string;
  verifyArgs: string[];                                                          // 验证工具可用
  versionArgs: string[];                                                         // 捕获版本号
  installStrategies: Array<{ cmd: string; args: string[] }>;
  upgradeStrategies: Array<{ cmd: string; args: string[] }>;
  rollbackStrategies: (prevVersion: string) => Array<{ cmd: string; args: string[] }>;
  upgradeIntervalDays: number;
}

// ── 实例配置：从 config/agent-deps.json 加载（框架层与实例层分离）────────────
// 要更换 plandex/opencode 版本或安装方式，只需修改 JSON，不改 TypeScript。
interface DepConfigJson {
  agent: "andy" | "lisa";
  name: string;
  binEnvKey?: string;
  binDefault: string;
  verifyArgs: string[];
  versionArgs: string[];
  installStrategies: Array<{ cmd: string; args: string[] }>;
  upgradeStrategies: Array<{ cmd: string; args: string[] }>;
  rollbackCmdTemplate: string; // {version} 占位符，如 "npm install -g opencode@{version}"
  upgradeIntervalDays: number;
}

function loadAgentDeps(): DepSpec[] {
  const cfgPath = join(PROJECT_ROOT, "CrewHiveClaw/CrewClaw/crewclaw-routing/config/agent-deps.json");
  let raw: DepConfigJson[];
  try {
    raw = JSON.parse(readFileSync(cfgPath, "utf8")) as DepConfigJson[];
  } catch {
    // 配置文件不存在时回退空列表，不阻断启动
    return [];
  }
  return raw.map((d) => ({
    agent: d.agent,
    name: d.name,
    bin: (d.binEnvKey ? process.env[d.binEnvKey] : undefined) ?? d.binDefault,
    verifyArgs: d.verifyArgs,
    versionArgs: d.versionArgs,
    installStrategies: d.installStrategies,
    upgradeStrategies: d.upgradeStrategies,
    rollbackStrategies: (v: string) => [
      { cmd: "sh", args: ["-c", d.rollbackCmdTemplate.replace(/{version}/g, v)] },
    ],
    upgradeIntervalDays: d.upgradeIntervalDays,
  }));
}

const AGENT_DEPS: DepSpec[] = loadAgentDeps();

const DEP_LOG   = join(PROJECT_ROOT, "data/learning/dep-installs.jsonl");
const DEP_STATE = join(PROJECT_ROOT, "data/learning/dep-state.json");

type DepStateFile = Record<string, { installed: boolean; version: string | null; last_upgraded: string | null }>;

function loadDepState(): DepStateFile {
  try { return JSON.parse(readFileSync(DEP_STATE, "utf8")) as DepStateFile; }
  catch { return {}; }
}

function saveDepState(state: DepStateFile): void {
  try {
    mkdirSync(dirname(DEP_STATE), { recursive: true });
    writeFileSync(DEP_STATE, JSON.stringify(state, null, 2), "utf8");
  } catch { /* 写入失败不影响主流程 */ }
}

async function isBinAvailable(bin: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const p = spawn(bin, args, { stdio: "ignore", timeout: 8_000 });
      p.on("close", (code) => resolve(code === 0));
      p.on("error", () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

// 运行 bin 并捕获版本字符串（取第一个 semver 数字串，如 "2.1.0"）
async function captureVersion(bin: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const p = spawn(bin, args, { timeout: 8_000 });
    p.stdout?.on("data", (c: Buffer) => chunks.push(c));
    p.stderr?.on("data", (c: Buffer) => chunks.push(c));
    p.on("close", (code) => {
      if (code !== 0) { resolve(null); return; }
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      const match = raw.match(/\d+\.\d+[\.\d]*/);
      resolve(match ? match[0] : raw.split("\n")[0].slice(0, 60));
    });
    p.on("error", () => resolve(null));
  });
}

async function runCmd(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: "pipe", timeout: 300_000 });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}

function logDep(record: Record<string, unknown>): void {
  appendJsonl(DEP_LOG, { timestamp: nowCST(), ...record });
}

// ── 二进制备份与恢复 ────────────────────────────────────────────────────────
//
// 升级前备份当前二进制，升级后验证失败时直接恢复备份。
// 这是最快最可靠的回退路径：不依赖包管理器能找到历史版本，毫秒级恢复。
// 备份路径：data/learning/dep-backups/<dep-name>（固定名，每次升级覆盖，只保留一份）

const DEP_BACKUP_DIR = join(PROJECT_ROOT, "data/learning/dep-backups");

// 在 PATH 中找到 bin 的绝对路径（bin 已是绝对路径则直接返回）
function findBinPath(bin: string): string | null {
  if (bin.startsWith("/")) return bin;
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const full = join(dir, bin);
    if (existsSync(full)) return full;
  }
  return null;
}

// 把当前二进制备份到 dep-backups/<name>，返回备份路径；失败返回 null
function backupBin(binPath: string, depName: string): string | null {
  const backupPath = join(DEP_BACKUP_DIR, depName.toLowerCase());
  try {
    mkdirSync(DEP_BACKUP_DIR, { recursive: true });
    copyFileSync(binPath, backupPath);
    chmodSync(backupPath, 0o755);
    return backupPath;
  } catch {
    return null;
  }
}

// 从备份恢复到 binPath，恢复后返回 true
function restoreFromBackup(backupPath: string, binPath: string): boolean {
  try {
    copyFileSync(backupPath, binPath);
    chmodSync(binPath, 0o755);
    return true;
  } catch {
    return false;
  }
}

async function manageDep(dep: DepSpec): Promise<void> {
  const state = loadDepState();
  const available = await isBinAvailable(dep.bin, dep.verifyArgs);

  if (!available) {
    // ── 安装 ──────────────────────────────────────────────────────────
    logDep({ agent: dep.agent, dep: dep.name, status: "missing", action: "installing" });
    for (const s of dep.installStrategies) {
      const ok = await runCmd(s.cmd, s.args);
      logDep({ agent: dep.agent, dep: dep.name, status: ok ? "installed" : "strategy_failed", via: `${s.cmd} ${s.args.join(" ")}` });
      if (ok) {
        const ver = await captureVersion(dep.bin, dep.versionArgs);
        state[dep.name] = { installed: true, version: ver, last_upgraded: nowCST() };
        saveDepState(state);
        return;
      }
    }
    logDep({ agent: dep.agent, dep: dep.name, status: "install_failed" });
    return;
  }

  // ── 检查升级窗口 ───────────────────────────────────────────────────
  const last = state[dep.name]?.last_upgraded ? new Date(state[dep.name].last_upgraded!) : null;
  const daysSince = last ? (Date.now() - last.getTime()) / 86_400_000 : Infinity;

  if (daysSince < dep.upgradeIntervalDays) {
    logDep({ agent: dep.agent, dep: dep.name, status: "available", next_upgrade_in_days: Math.ceil(dep.upgradeIntervalDays - daysSince) });
    return;
  }

  // ── 升级前：记录版本 + 备份二进制 ─────────────────────────────────
  const prevVersion = await captureVersion(dep.bin, dep.versionArgs);
  const binPath     = findBinPath(dep.bin);
  const backupPath  = binPath ? backupBin(binPath, dep.name) : null;

  logDep({
    agent: dep.agent, dep: dep.name, status: "upgrade_due",
    prev_version: prevVersion,
    backup: backupPath ? `created:${backupPath}` : "skipped(bin_not_found)",
    action: "upgrading",
  });

  // ── 升级 ──────────────────────────────────────────────────────────
  for (const s of dep.upgradeStrategies) {
    const ok = await runCmd(s.cmd, s.args);
    logDep({ agent: dep.agent, dep: dep.name, status: ok ? "upgrade_attempted" : "upgrade_strategy_failed", via: `${s.cmd} ${s.args.join(" ")}` });
    if (ok) break;
  }

  // ── 升级后验证 ─────────────────────────────────────────────────────
  const stillWorks = await isBinAvailable(dep.bin, dep.verifyArgs);
  if (stillWorks) {
    const newVer = await captureVersion(dep.bin, dep.versionArgs);
    logDep({ agent: dep.agent, dep: dep.name, status: "upgraded", prev_version: prevVersion, new_version: newVer });
    state[dep.name] = { installed: true, version: newVer, last_upgraded: nowCST() };
    saveDepState(state);
    return;
  }

  // ── 验证失败 → 回退（三级，优先级递减）───────────────────────────
  logDep({ agent: dep.agent, dep: dep.name, status: "upgrade_broke_tool", action: "rolling_back", target_version: prevVersion });

  // 级别 1：直接恢复备份二进制（最快，不依赖包管理器）
  if (backupPath && binPath && existsSync(backupPath)) {
    const copied = restoreFromBackup(backupPath, binPath);
    if (copied) {
      const recovered = await isBinAvailable(dep.bin, dep.verifyArgs);
      if (recovered) {
        logDep({ agent: dep.agent, dep: dep.name, status: "rolled_back", via: "backup_binary", version: prevVersion });
        state[dep.name] = { installed: true, version: prevVersion, last_upgraded: nowCST() };
        saveDepState(state);
        return;
      }
      logDep({ agent: dep.agent, dep: dep.name, status: "backup_restore_did_not_recover" });
    } else {
      logDep({ agent: dep.agent, dep: dep.name, status: "backup_copy_failed" });
    }
  } else {
    logDep({ agent: dep.agent, dep: dep.name, status: "backup_unavailable", note: "no backup found, trying version rollback" });
  }

  // 级别 2：版本回退策略（brew/npm/go 按版本安装）
  for (const s of dep.rollbackStrategies(prevVersion ?? "latest")) {
    const ok = await runCmd(s.cmd, s.args);
    if (!ok) {
      logDep({ agent: dep.agent, dep: dep.name, status: "rollback_strategy_failed", via: `${s.cmd} ${s.args.join(" ")}` });
      continue;
    }
    const recovered = await isBinAvailable(dep.bin, dep.verifyArgs);
    if (recovered) {
      logDep({ agent: dep.agent, dep: dep.name, status: "rolled_back", via: `${s.cmd} ${s.args.join(" ")}`, version: prevVersion });
      state[dep.name] = { installed: true, version: prevVersion, last_upgraded: nowCST() };
      saveDepState(state);
      return;
    }
    logDep({ agent: dep.agent, dep: dep.name, status: "rollback_did_not_recover", via: `${s.cmd} ${s.args.join(" ")}` });
  }

  // 级别 3：所有策略均失败，保留现状，error handler 兜底
  logDep({ agent: dep.agent, dep: dep.name, status: "rollback_failed", note: "tool may be broken; executePlandex/executeOpenCode error handlers will catch failures" });
}

// ── Andy 流水线 Step 1：DeepSeek 调研（search: true）────────────────────
//
// 使用 DeepSeek 内置搜索（无需 Tavily 等第三方 API），国内可访问，零额外依赖。
// 返回技术调研结论；若 API Key 未配置或调用失败，返回空字符串（不阻塞流水线）。

async function researchWithDeepSeek(requirement: string, taskType = "feature"): Promise<string> {
  if (!DEEPSEEK_API_KEY) return "";
  const isBug = taskType === "bug";
  try {
    const systemContext = isBug
      ? "用户报告了一个 Bug，请搜索相关的技术问题和已知解决方案。"
      : "用户有一个功能开发需求，请搜索技术实现方案、相关库和最佳实践。";

    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [{
          role: "user",
          content: [
            `${systemContext}`,
            "",
            `需求描述：${requirement}`,
            "",
            isBug
              ? "请给出：1) 可能的原因 2) 相关的技术问题/错误 3) 已知解决方案或修复方向（如果有的话）"
              : "请给出简洁的调研结论（600字以内），重点关注：1) 可用的 npm/Python 库（附版本）2) 推荐实现模式 3) 常见坑和最佳实践",
          ].join("\n"),
        }],
        search: true,
        stream: false,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!resp.ok) return "";
    const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  } catch {
    return "";
  }
}

// ── Andy 流水线 Step 2：Codebase Reader ───────────────────────────────────
//
// 读取项目上下文：Andy 的 BOOTSTRAP.md（角色定位）+ app/generated/ 最近生成文件（代码风格样例）。
// 同步操作，出错静默跳过。

function readCodebaseContext(projectRoot: string): string {
  const sections: string[] = [];

  // Andy 的身份配置（角色 + 技术栈偏好）
  try {
    const bootstrapPath = join(process.env.HOME ?? "/", ".openclaw/workspace-andy/BOOTSTRAP.md");
    const bootstrap = readFileSync(bootstrapPath, "utf8").slice(0, 600);
    sections.push(`【Andy 身份配置】\n${bootstrap}`);
  } catch { /* 文件不存在时跳过 */ }

  // app/generated/ 最近 3 个生成文件（了解既有代码风格和模式）
  const generatedDir = join(projectRoot, "app/generated");
  try {
    const files = readdirSync(generatedDir)
      .filter((f) => f.endsWith(".js"))
      .sort()
      .slice(-3);
    if (files.length > 0) {
      sections.push(`【已有生成文件（最近 ${files.length} 个）】\n${files.join("\n")}`);
      // 读取最新一个文件的前 40 行作为代码风格样例
      const samplePath = join(generatedDir, files[files.length - 1]);
      const sampleLines = readFileSync(samplePath, "utf8").split("\n").slice(0, 40).join("\n");
      sections.push(`【代码风格样例（${files[files.length - 1]}）】\n${sampleLines}`);
    }
  } catch { /* 目录不存在时跳过 */ }

  return sections.join("\n\n");
}

// ── Andy 流水线 Step 3：Plandex 规划引擎 ─────────────────────────────────
//
// Plandex 模型选择跟着 Andy 走（与 OpenCode 跟着 Lisa 走的原则相同）：
//   ANDY_PROVIDER=deepseek → OPENAI_BASE_URL=api.deepseek.com, KEY=DEEPSEEK_API_KEY
//   ANDY_PROVIDER=zai      → OPENAI_BASE_URL=open.bigmodel.cn, KEY=ZAI_API_KEY
/* ── plandex 已废除（2026-03-29）─────────────────────────────────────────
//   ANDY_PROVIDER=ollama   → OPENAI_BASE_URL=localhost:11434/v1, KEY=ollama
//
// 运行 `plandex tell <task>`，捕获 stdout 作为 Implementation Spec。
// 若 plandex 未安装或调用失败，返回带 ❌ 前缀的错误信息（供调用方 fallback 到 Gateway Andy）。

function buildProviderEnv(provider: string, model: string): Record<string, string | undefined> { ... }

async function generateSpecDirectly(task: string): Promise<string> { ... }

async function executePlandex(task, model, provider, projectRoot): Promise<string> { ... }

────────────────────────────────────────────────────────────────────────── */

// ── Layer 2：开发意图关键词 ─────────────────────────────────────────────

const DEV_PATTERNS = [
  "开发", "创建", "新增", "搭建", "构建", "建立",
  "做一个", "做个", "帮我做", "帮我开发", "帮我实现", "帮我创建",
  "需要一个", "想要一个", "写一个", "写个",
  "实现一个", "开发一个", "需要开发",
  "修复", "bug", "报错", "崩溃", "出错了", "用不了",
  "重构", "优化性能", "运行太慢",
  "每天推送", "每周推送", "每天发", "每周发", "定期发",
  "自动推送", "自动发送", "每天报告", "每周报告",
];

function isDevOrComplexIntent(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return DEV_PATTERNS.some((p) => lower.includes(p)) || prompt.length > 80;
}

// ── Layer 3：对话记忆 + 决策记忆（ChromaDB 向量检索）────────────────
//
// 统一使用 ChromaDB + nomic-embed-text 语义嵌入替代 JSONL bigram 检索。
//   - 嵌入模型：nomic-embed-text（已在 Ollama 安装，274MB）
//   - ChromaDB：localhost:8001（v2 API，需显式嵌入）
//   - 集合：conversations（Lucas 对话记忆）、decisions（三角色决策记忆）
//
// ChromaDB v2 API 路径前缀：
//   /api/v2/tenants/default_tenant/databases/default_database/collections
//
// 决策记忆 outcome 状态：
//   ""（初始/待验收）→ "delivered"（已推送）→ "success" / "failure" / "partial"
//   注：ChromaDB metadata 不接受 null，用空字符串 "" 表示 null

const CHROMA_URL = process.env.CHROMA_URL || "http://localhost:8001";
const CHROMA_BASE = `${CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections`;
const MEMORY_CONTEXT_SIZE = 4;
const DECISION_MEMORY_CONTEXT_SIZE = 5;

type DecisionRecord = {
  decision_id: string;
  agent: string;
  timestamp: string;
  context: string;
  decision: string;
  outcome: string | null;
  outcome_at: string | null;
  outcome_note: string | null;
  userId?: string;   // 谁发起的，用于按人查未完成承诺
};

// ── 嵌入：nomic-embed-text via Ollama ────────────────────────────────
async function embedText(text: string): Promise<number[]> {
  const resp = await fetch("http://localhost:11434/api/embeddings", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "nomic-embed-text", prompt: text }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new Error(`Ollama embeddings failed: ${resp.status}`);
  const data = await resp.json() as { embedding: number[] };
  return data.embedding;
}

// ── ChromaDB HTTP 工具（v2 API）───────────────────────────────────────

// 集合名 → 集合 ID 缓存（插件生命周期内有效，避免频繁 GET）
const chromaCollectionIds = new Map<string, string>();

async function getChromaCollectionId(name: string): Promise<string> {
  if (chromaCollectionIds.has(name)) return chromaCollectionIds.get(name)!;
  // 尝试获取已有集合
  let resp = await fetch(`${CHROMA_BASE}/${name}`);
  if (!resp.ok) {
    // 不存在则创建（cosine 距离适合语义相似度）
    resp = await fetch(CHROMA_BASE, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, metadata: { "hnsw:space": "cosine" } }),
    });
    if (!resp.ok) throw new Error(`ChromaDB create collection "${name}" failed: ${resp.status}`);
  }
  const col = await resp.json() as { id: string };
  chromaCollectionIds.set(name, col.id);
  return col.id;
}

async function chromaAdd(
  collection: string,
  id: string,
  document: string,
  metadata: Record<string, string | number | boolean>,
  embedding: number[],
): Promise<void> {
  const colId = await getChromaCollectionId(collection);
  const resp = await fetch(`${CHROMA_BASE}/${colId}/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id], embeddings: [embedding], documents: [document], metadatas: [metadata] }),
  });
  if (!resp.ok) throw new Error(`ChromaDB add failed: ${resp.status}`);
}

async function chromaQuery(
  collection: string,
  queryEmbedding: number[],
  nResults: number,
  where?: Record<string, unknown>,
): Promise<Array<{ document: string; metadata: Record<string, unknown> }>> {
  const colId = await getChromaCollectionId(collection);
  const body: Record<string, unknown> = {
    query_embeddings: [queryEmbedding],
    n_results: nResults,
    include: ["documents", "metadatas"],
  };
  if (where) body.where = where;
  const resp = await fetch(`${CHROMA_BASE}/${colId}/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`ChromaDB query failed: ${resp.status}`);
  const data = await resp.json() as { documents: string[][]; metadatas: Record<string, unknown>[][] };
  return (data.documents[0] ?? []).map((doc, i) => ({
    document: doc,
    metadata: data.metadatas[0][i] ?? {},
  }));
}

// 按 metadata 过滤获取记录（不做向量搜索）
async function chromaGet(
  collection: string,
  where: Record<string, unknown>,
): Promise<Array<{ id: string; document: string; metadata: Record<string, unknown> }>> {
  const colId = await getChromaCollectionId(collection);
  const resp = await fetch(`${CHROMA_BASE}/${colId}/get`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ where, include: ["documents", "metadatas"] }),
  });
  if (!resp.ok) throw new Error(`ChromaDB get failed: ${resp.status}`);
  const data = await resp.json() as { ids: string[]; documents: string[]; metadatas: Record<string, unknown>[] };
  return (data.ids ?? []).map((id, i) => ({
    id,
    document: data.documents[i] ?? "",
    metadata: data.metadatas[i] ?? {},
  }));
}

// 更新已有文档的 metadata 字段
async function chromaUpdate(
  collection: string,
  id: string,
  metadata: Record<string, string | number | boolean>,
): Promise<void> {
  const colId = await getChromaCollectionId(collection);
  const resp = await fetch(`${CHROMA_BASE}/${colId}/update`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id], metadatas: [metadata] }),
  });
  if (!resp.ok) throw new Error(`ChromaDB update failed: ${resp.status}`);
}

// 插入或更新（add 失败时自动 fallback 到 update）
// 适用于 agent 档案等会多次写入同一 ID 的场景
async function chromaUpsert(
  collection: string,
  id: string,
  document: string,
  metadata: Record<string, string | number | boolean>,
  embedding: number[],
): Promise<void> {
  const colId = await getChromaCollectionId(collection);
  const resp = await fetch(`${CHROMA_BASE}/${colId}/upsert`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids: [id], embeddings: [embedding], documents: [document], metadatas: [metadata] }),
  });
  if (!resp.ok) throw new Error(`ChromaDB upsert failed: ${resp.status}`);
}

// ── 对话记忆（conversations 集合）────────────────────────────────────

// P3 图定向召回（关系路径）：通过 Kuzu 关系边找出与当前说话人有直接关系的家人 ID
// 用于扩展 ChromaDB conversations 的过滤范围，让记忆召回跨越单人边界
function getRelatedPersonIds(userId: string): string[] {
  try {
    const cypher = `MATCH (speaker:Entity {id: $userId})-[rel:Fact]-(other:Entity)
                    WHERE other.type = 'person' AND other.id <> $userId AND rel.valid_until IS NULL
                    RETURN DISTINCT other.id LIMIT 10`;
    const KUZU_PYTHON3 = "/opt/homebrew/opt/python@3.11/bin/python3.11";
    const scriptPath   = join(PROJECT_ROOT, "scripts/kuzu-query.py");
    const result = spawnSync(
      KUZU_PYTHON3,
      [scriptPath, cypher, JSON.stringify({ userId })],
      { encoding: "utf8", timeout: 3000 },
    );
    if (result.status !== 0 || !result.stdout?.trim()) return [];
    const rows = JSON.parse(result.stdout.trim()) as unknown[][];
    return rows.map(row => String(row[0])).filter(Boolean);
  } catch {
    return [];
  }
}

// P3 图定向召回（话题路径）：通过 Kuzu 共享 topic 节点找出关注相同话题的人 ID
// 依赖 P1-C：distill-memories.py topic_id 改为 topic_{slug} 后同一概念跨成员共享节点
// 与 getRelatedPersonIds 互补——关系路径覆盖「明确知道有来往」，话题路径覆盖「隐性关注交集」
// 正向过滤 type='person'：所有人（家庭成员 + distill 提炼的周边人）统一用此类型
// 未来加 space/device 等新类型时，天然不会进入此查询，无需修改排除列表
function getTopicRelatedPersonIds(userId: string): string[] {
  try {
    const cypher = `MATCH (speaker:Entity {id: $userId})-[f1:Fact]->(t:Entity {type: 'topic'})
                    WHERE f1.valid_until IS NULL
                    MATCH (other:Entity {type: 'person'})-[f2:Fact]->(t)
                    WHERE other.id <> $userId AND f2.valid_until IS NULL
                    RETURN DISTINCT other.id LIMIT 10`;
    const KUZU_PYTHON3 = "/opt/homebrew/opt/python@3.11/bin/python3.11";
    const scriptPath   = join(PROJECT_ROOT, "scripts/kuzu-query.py");
    const result = spawnSync(
      KUZU_PYTHON3,
      [scriptPath, cypher, JSON.stringify({ userId })],
      { encoding: "utf8", timeout: 3000 },
    );
    if (result.status !== 0 || !result.stdout?.trim()) return [];
    const rows = JSON.parse(result.stdout.trim()) as unknown[][];
    return rows.map(row => String(row[0])).filter(Boolean);
  } catch {
    return [];
  }
}

// 因果关系查询：从 Kuzu 取该用户的 causal_relation Facts（distill-memories.py 产出）
// 供 queryMemories（自动注入）和 recall_memory（主动检索）共用
function queryCausalFacts(userId: string): { value: string; context: string }[] {
  try {
    const cypher = `MATCH (p:Entity {id: $userId})-[f:Fact {relation: 'causal_relation'}]->(t:Entity)
                    WHERE f.valid_until IS NULL
                    RETURN t.name, f.context LIMIT 8`;
    const KUZU_PYTHON3 = "/opt/homebrew/opt/python@3.11/bin/python3.11";
    const scriptPath   = join(PROJECT_ROOT, "scripts/kuzu-query.py");
    const result = spawnSync(
      KUZU_PYTHON3,
      [scriptPath, cypher, JSON.stringify({ userId })],
      { encoding: "utf8", timeout: 3000 },
    );
    if (result.status !== 0 || !result.stdout?.trim()) return [];
    const rows = JSON.parse(result.stdout.trim()) as unknown[][];
    return rows
      .filter(row => row[0])
      .map(row => ({ value: String(row[0]), context: String(row[1] ?? "") }));
  } catch {
    return [];
  }
}

// ── Topic-first：从 ChromaDB topics 集合语义匹配话题事实 ──────────────
//
// topics 集合由 distill-memories.py 写入（每条 = 某人对某话题的 Fact）。
// embedding = topicName + context，比原始对话片段更精准稳定。
// 无 userId 时跨家人搜索（recall_memory 工具用）；有 userId 时限定该人（自动注入用）。

interface TopicMatch {
  topicId:   string;
  topicName: string;
  relation:  string;
  context:   string;
}

async function queryRelevantTopics(embedding: number[], userId: string | null = null): Promise<TopicMatch[]> {
  try {
    const where = userId ? { userId: { $eq: userId } } as Record<string, unknown> : undefined;
    const raw = await chromaQuery("topics", embedding, 5, where);
    return raw
      .map(r => {
        const meta = r.metadata as Record<string, string>;
        return {
          topicId:   meta.topicId   ?? "",
          topicName: meta.topicName ?? "",
          relation:  meta.relation  ?? "",
          context:   meta.context   ?? "",
        };
      })
      .filter(t => t.topicId && t.topicName);
  } catch {
    return [];
  }
}

function relativeTimeLabel(isoStr: string, now: Date): string {
  try {
    const diffDays = Math.floor((now.getTime() - new Date(isoStr).getTime()) / 86400000);
    if (diffDays === 0) return "今天";
    if (diffDays === 1) return "昨天";
    if (diffDays <= 7) return `${diffDays}天前`;
    if (diffDays <= 30) return `${Math.floor(diffDays / 7)}周前`;
    return `${Math.floor(diffDays / 30)}个月前`;
  } catch { return ""; }
}

async function queryMemories(prompt: string, userId: string, isGroup = false): Promise<string> {
  userId = userId.toLowerCase();  // 写入时已规范化为小写，查询侧同步保持一致
  try {
    const baseEmbedding = await embedText(prompt.slice(0, 400));

    // ── Step 1: Topic-first（私聊）──────────────────────────────────────────
    // 从 ChromaDB topics 集合语义匹配该用户的话题事实（蒸馏产物，高置信度）。
    // 同时用 topic 关键词增强后续对话片段检索 query，解决措辞不匹配导致的低命中率。
    let topicBlock = "";
    let topicKeywords = "";
    if (!isGroup) {
      const topics = await queryRelevantTopics(baseEmbedding, userId);
      if (topics.length > 0) {
        const topicLines = topics.map(t => {
          const ctx = t.context ? `：${t.context}` : "";
          return `• ${t.topicName}（${t.relation}${ctx}）`;
        });
        topicBlock    = `【相关话题事实】\n${topicLines.join("\n")}`;
        topicKeywords = topics.map(t => t.topicName).join(" ");
      }
    }

    // ── Step 1b: 因果关系事实（causal_relation，MAGMA 因果维度）──────────
    let causalBlock = "";
    if (!isGroup) {
      const causalFacts = queryCausalFacts(userId);
      if (causalFacts.length > 0) {
        const lines = causalFacts.map(cf => `• ${cf.value}${cf.context ? `：${cf.context}` : ""}`);
        causalBlock = `【因果关系】\n${lines.join("\n")}`;
      }
    }

    // ── Step 2: 蒸馏档案（insights 集合）──────────────────────────────────
    let insightBlock = "";
    try {
      const insightWhere = { userId: { $eq: userId } } as Record<string, unknown>;
      const insightRaw   = await chromaQuery("insights", baseEmbedding, 1, insightWhere);
      if (insightRaw.length > 0) {
        const insight = insightRaw[0];
        const meta    = insight.metadata as { distilled_at?: string; member_name?: string };
        const label   = meta.member_name ?? userId;
        const date    = meta.distilled_at ? meta.distilled_at.slice(0, 10) : "";
        const summary = (insight.document ?? "").slice(0, 600);
        insightBlock  = `【${label}人物档案（${date}蒸馏）】\n${summary}`;
      }
    } catch { /* insights 集合不存在时静默忽略 */ }

    // ── Step 2c: 时间维度召回（MAGMA 时间维度）──────────────────────────
    // 当 prompt 含时间锚词时，直接按 timestamp 拉取记录，不依赖语义相似度。
    let timeBlock = "";
    if (!isGroup) {
      const anchor = detectTimeAnchor(prompt);
      if (anchor) {
        const timeRecs = await getConversationsByTimeAnchor(userId, anchor);
        if (timeRecs.length > 0) {
          const now2 = new Date();
          const lines = timeRecs.map(r => {
            const meta = r.metadata as { prompt?: string; response?: string; timestamp?: string };
            const tLabel = meta.timestamp ? relativeTimeLabel(meta.timestamp, now2) : "";
            return `[${tLabel}] User: ${meta.prompt ?? ""}\nLucas: ${(meta.response ?? "").slice(0, 200)}`;
          });
          timeBlock = `【${anchor.label}对话记录（${timeRecs.length} 条）】\n${lines.join("\n---\n")}`;
        }
      }
    }

    // ── Step 3: 对话片段检索（topic 关键词增强 query）────────────────────
    // topic 关键词拼入 query：让 embedding 更贴近历史对话实际内容，减少措辞漂移导致的漏召回。
    const searchEmbedding = topicKeywords
      ? await embedText(`${prompt} ${topicKeywords}`.slice(0, 400))
      : baseEmbedding;

    const humanFilter = { fromType: { $eq: "human" } };
    // 记忆召回策略（三分支）：
    // 1. 群聊：全量 human 对话，fromType=human 已排除 pipeline 对话
    // 2. 访客私聊（visitor:TOKEN）：严格按 userId 过滤，访客不可见家人对话
    //    注意：ChromaDB 存储时 userId = 访客真实姓名（convFromId），不是 "visitor:token"
    //    因此过滤器要用真实姓名；找不到姓名时 fallback 到 token（历史数据可能用 token 存）
    // 3. 家人私聊：Lucas 有完整人类记忆，不锁 userId——「有缺口」设计
    //    fromType=human 自然排除访客(visitor)和 Agent pipeline(agent) 对话
    const isVisitorQuery = userId.startsWith("visitor:");
    let visitorRealName: string | null = null;
    if (isVisitorQuery) {
      const visitTok = userId.slice("visitor:".length); // 已 lowercase
      try {
        const regPath = join(PROJECT_ROOT, "data", "visitor-registry.json");
        const reg = JSON.parse(readFileSync(regPath, "utf8")) as Record<string, { name?: string | null }>;
        const regKey = Object.keys(reg).find(k => k.toLowerCase() === visitTok);
        visitorRealName = (regKey && reg[regKey].name) ? reg[regKey].name! : null;
      } catch { /* registry 读取失败，fallback 到 token */ }
    }
    // 访客过滤：优先用真实姓名（与写入时 convFromId 一致），找不到时用 token 格式
    const visitorUserIdFilter = visitorRealName ?? userId;
    const where: Record<string, unknown> = isGroup
      ? humanFilter
      : isVisitorQuery
        ? { $and: [humanFilter, { userId: { $eq: visitorUserIdFilter.toLowerCase() } }] }
        : humanFilter;
    const raw     = await chromaQuery("conversations", searchEmbedding, MEMORY_CONTEXT_SIZE * 2, isGroup ? undefined : where);
    const results = timeWeightedRerank(raw, MEMORY_CONTEXT_SIZE);

    // ── 组合输出（时间记录 → 档案 → topic 事实 → 因果关系 → 对话片段）────
    const parts: string[] = [];
    if (timeBlock)    parts.push(timeBlock);   // 时间维度优先，最前面
    if (insightBlock) parts.push(insightBlock);
    if (topicBlock)   parts.push(topicBlock);
    if (causalBlock)  parts.push(causalBlock);
    if (results.length > 0) {
      const now = new Date();
      const lines = results.map(r => {
        const meta = r.metadata as { prompt?: string; response?: string; userId?: string; source?: string; timestamp?: string };
        const who   = meta.source === "group" ? `（群）` : meta.userId ? `（${meta.userId}）` : "";
        const tLabel = meta.timestamp ? relativeTimeLabel(meta.timestamp, now) : "";
        const prefix = tLabel ? `[${tLabel}] ` : "";
        return `${prefix}User${who}: ${meta.prompt ?? r.document}\nLucas: ${meta.response ?? ""}`;
      });
      parts.push(`【近期对话片段】\n${lines.join("\n---\n")}`);
    }

    return parts.length > 0 ? parts.join("\n\n") : "";
  } catch {
    return "";
  }
}

// conversations 集合写入元数据结构
// fromType: human（家人）| agent（Agent 间调用）| device（IoT/传感器，未来扩展）
// channel:  wecom_private | wecom_group | pipeline（Agent 间）| cli | iot
interface ConvMeta {
  fromId:        string;                        // userId / agentId / deviceId
  fromType:      "human" | "agent" | "device";
  toId:          string;                        // 接收方标识，与 fromId 同一套体系
  toType:        string;                        // 当前固定 "agent"，IoT 接入后扩展
  channel:       string;
  modelUsed:     string;
  isCloud:       boolean;
  toolsCalled:   string[];                      // 工具名列表（无需计数）
  sessionId?:    string;
  // ── 进化信号字段（L2/L4）────────────────────────────────────────────
  intent?:       string | null;                 // 意图分类，来自 sessionIntent
  qualityScore?: number;                        // 响应质量分 [0,1]，来自 evaluateResponseQuality
  dpoFlagged?:   boolean;                       // 是否检测到 DPO 负例模式
}

// ── 用户类型识别 ───────────────────────────────────────────────────────────
const FAMILY_USER_IDS = ["ZengXiaoLong", "XiaMoQiuFengLiang", "ZiFeiYu"];
function getUserType(userId: string): "visitor" | "family" | "engineer" {
  if (userId.startsWith("visitor:")) return "visitor";
  if (FAMILY_USER_IDS.includes(userId)) return "family";
  return "engineer";
}

async function writeMemory(prompt: string, response: string, meta: ConvMeta, collection = "conversations"): Promise<void> {
  // 调试日志：确认 writeMemory 被调用
  const debugEntry = {
    t: nowCST(),
    collection,
    fromId: meta.fromId,
    toId: meta.toId,
    promptLen: prompt.length,
    responseLen: response.length,
  };
  appendJsonl(join(PROJECT_ROOT, "data/learning/memory-write-debug.jsonl"), debugEntry);
  
  try {
    const id = `conv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // 访客对话匿名化：document/embedDoc 用"访客:"而非具体 ID，防止语义混淆
    const displayFromId = meta.fromType === "visitor" ? "访客" : meta.fromId;
    // document 格式：通用化，支持人/Agent/设备任意参与方
    const document = `${displayFromId}(${meta.fromType}): ${prompt}\n${meta.toId}: ${response}`;
    // nomic-embed-text 上下文窗口 ~768 tokens，超长时返回 500。
    // embedding 用截断版，完整文本仍保存在 document 字段供检索展示。
    const embedDoc = `${displayFromId}: ${prompt.slice(0, 350)}\n${meta.toId}: ${response.slice(0, 350)}`;
    const embedding = await embedText(embedDoc);
    await chromaAdd(collection, id, document, {
      // ── 新字段 ──────────────────────────────────────────────────────
      fromId:      meta.fromId,
      fromType:    meta.fromType,
      toId:        meta.toId,
      toType:      meta.toType,
      channel:     meta.channel,
      modelUsed:   meta.modelUsed,
      isCloud:     String(meta.isCloud),        // ChromaDB metadata 只支持 string/number/bool
      toolsCalled:    JSON.stringify(meta.toolsCalled),
      sessionId:      meta.sessionId ?? "",
      // ── 进化信号字段（L2/L4）─────────────────────────────────────────
      intent:         meta.intent ?? "",
      qualityScore:   meta.qualityScore ?? 0,
      dpoFlagged:     String(meta.dpoFlagged ?? false),
      // ── 向后兼容（queryMemories where 过滤、distill-memories.py 仍用这两个字段）──
      userId:         meta.fromId.toLowerCase(),
      source:         meta.channel === "wecom_group" ? "group" : "private",
      // ── 用户类型 ────────────────────────────────────────────────────────
      userType:       getUserType(meta.fromId),
      // ── 检索辅助 ─────────────────────────────────────────────────────
      timestamp:      nowCST(),
      prompt:         prompt.slice(0, 500),
      response:       response.slice(0, 500),
    }, embedding);
  } catch (e) {
    appendJsonl(join(PROJECT_ROOT, "data/learning/memory-write-errors.jsonl"), {
      t: nowCST(),
      error: e instanceof Error ? e.message : String(e),
      stack: (e as any)?.stack?.slice(0, 500),
    });
  }
}

// ── 决策记忆（decisions 集合）────────────────────────────────────────
//
// 三角色各自记录"当时面对什么情况、做了什么选择、结果怎么样"。
// 下次面对类似情况时，作为上下文注入——吃过的狗屎，别再吃。
//
// 写入时机（见 runAndyPipeline）：
//   Step 4  Andy 完成 spec → 写入 decisions（outcome=""，待验收）
//   Step 5  Lisa 实现成功 → chromaUpdate outcome="delivered"（同时写 Lisa 记录）
//   Step 6  Lucas 验收推送 → chromaUpdate outcome="delivered"
//   用户反馈 → Lucas 调用 record_outcome_feedback → chromaUpdate 最终 outcome

async function addDecisionMemory(record: DecisionRecord): Promise<void> {
  try {
    const document = `${record.context} ${record.decision}`;
    const embedding = await embedText(document);
    await chromaAdd("decisions", record.decision_id, document, {
      agent: record.agent,
      timestamp: record.timestamp,
      context: (record.context ?? "").slice(0, 500),
      decision: (record.decision ?? "").slice(0, 500),
      outcome: record.outcome ?? "",          // null → ""
      outcome_at: record.outcome_at ?? "",
      outcome_note: record.outcome_note ?? "",
      userId: record.userId ?? "",
    }, embedding);
  } catch {
    // 写入失败静默处理
  }
}

async function queryDecisionMemory(context: string, agentId: string): Promise<string> {
  try {
    const embedding = await embedText(context);
    const raw = await chromaQuery(
      "decisions",
      embedding,
      DECISION_MEMORY_CONTEXT_SIZE * 2,
      { agent: { $eq: agentId } },
    );
    const results = timeWeightedRerank(raw, DECISION_MEMORY_CONTEXT_SIZE);
    if (results.length === 0) return "";
    const lines = results.map(r => {
      const meta = r.metadata as {
        timestamp?: string; context?: string; decision?: string;
        outcome?: string; outcome_note?: string; type?: string;
      };
      const date = toCST(meta.timestamp);
      const type = meta.type ?? "";
      // 文档型条目（设计判断/实现认知/学习目标/知识注入）直接渲染 document 内容
      if (["design_learning", "impl_learning", "learning_objective", "knowledge_injection"].includes(type)) {
        const typeLabel = type === "design_learning" ? "设计判断"
          : type === "impl_learning" ? "实现认知"
          : type === "knowledge_injection" ? "知识注入"
          : "学习目标";
        return `- [${date}] [${typeLabel}] ${r.document.slice(0, 300)}`;
      }
      // 决策型条目（原有格式）
      const outcomeVal = meta.outcome || null;
      const icon = outcomeVal === "success" ? "✅"
        : outcomeVal === "failure" ? "❌"
        : outcomeVal === "partial" ? "⚠️"
        : "⏳";
      const note = meta.outcome_note ? `（${meta.outcome_note}）` : "";
      return `- [${date}] ${meta.context ?? ""} → 选择：${meta.decision ?? ""} → ${icon} ${outcomeVal ?? "待验收"}${note}`;
    });
    return `【历史决策参考】\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// 专用平台约束召回：只检索 type=constraint 条目，独立于普通决策记忆，避免竞争 topK 名额。
// 按时间+相似度双重排序：先做语义过滤，再按时间加权（越新越优先）。
async function queryAgentConstraints(prompt: string, agentId: string, topK: number = 5): Promise<string> {
  try {
    const embedding = await embedText(prompt);
    const raw = await chromaQuery(
      "decisions",
      embedding,
      topK * 2,
      { $and: [{ agent: { $eq: agentId } }, { type: { $eq: "constraint" } }] },
    );
    const results = timeWeightedRerank(raw, topK);
    if (results.length === 0) return "";
    const lines = results.map(r => {
      const meta = r.metadata as { timestamp?: string; topic?: string };
      const date = toCST(meta.timestamp);
      return `- [${date}] ${r.document.slice(0, 200)}`;
    });
    return `【已知平台约束（开始实现前必查）】\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// 查 Lucas 对特定用户的未完成承诺（outcome="" 且 agent="lucas" 且 userId 匹配）
// 检索信号：userId 精确匹配 + 未完成状态，不做相似度搜索
async function queryPendingCommitments(userId: string): Promise<string> {
  if (!userId || userId === "default") return "";
  try {
    // 主动循环（system-scheduler-*）：查所有待办，不限 userId
    const isProactiveLoop = userId.startsWith("system-scheduler");
    const where = isProactiveLoop
      ? { $and: [{ agent: { $eq: "lucas" } }, { outcome: { $eq: "" } }] }
      : { $and: [{ agent: { $eq: "lucas" } }, { userId: { $eq: userId } }, { outcome: { $eq: "" } }] };

    const results = await chromaGet("decisions", where);
    if (results.length === 0) return "";
    const lines = results.map(r => {
      const meta = r.metadata as { timestamp?: string; context?: string; userId?: string };
      const date = toCST(meta.timestamp);
      const forUser = isProactiveLoop ? `（来自 ${meta.userId ?? "?"})` : "";
      return `- [${date}]${forUser} ${meta.context ?? ""}（⏳ 还没交付）`;
    });
    return isProactiveLoop
      ? `【所有待办承诺】\n${lines.join("\n")}`
      : `【对你的待办事项】\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ── 时间权重重排（所有 ChromaDB 查询结果的统一后处理）───────────────
//
// ChromaDB 按余弦相似度返回结果，但近期记录更相关（记忆衰减规律）。
// 使用时间权重 × 位置权重综合排序，截取 topN 后返回。
//   0~3 月  × 1.0（高权重，新鲜记忆）
//   3~12 月 × 0.7（中权重，有参考价值）
//   12月+   × 0.3（低权重，作为背景知识）

// UTC ISO 时间戳 → 中国标准时间（UTC+8）日期字符串，供 Lucas 展示给家人
function toCST(isoTimestamp: string | undefined): string {
  if (!isoTimestamp) return "";
  const d = new Date(isoTimestamp);
  if (isNaN(d.getTime())) return isoTimestamp.slice(0, 10);
  return new Date(d.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function timeWeightedRerank<T extends { metadata: Record<string, unknown> }>(
  results: T[],
  topN: number,
): T[] {
  if (results.length === 0) return [];
  const now = Date.now();
  return results
    .map((r, i) => {
      const ts = (r.metadata.timestamp as string | undefined) ?? "";
      const ageMs = ts ? now - new Date(ts).getTime() : now;
      const ageMonths = ageMs / (1000 * 60 * 60 * 24 * 30);
      const timeWeight = ageMonths < 3 ? 1.0 : ageMonths < 12 ? 0.7 : 0.3;
      // 位置权重：余弦排名第 1 条得 1.0，往后递减（模拟相似度梯度）
      const positionWeight = 1 / (i + 1);
      return { r, score: positionWeight * timeWeight };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, topN)
    .map(({ r }) => r);
}

// ── 时间维度召回（MAGMA 时间维度，补齐检索侧）───────────────────────
// MAGMA 四维度中「时间维度」的检索路径：当 query 含时间词时，按 timestamp 直接拉取记录，
// 不走语义搜索——解决「今天早上聊了什么」此类时序查询语义相似度低、命中失败的问题。

interface TimeAnchor {
  startUtc: string;  // ISO UTC，ChromaDB $gte 过滤用
  endUtc:   string;  // ISO UTC，ChromaDB $lte 过滤用
  label:    string;  // 展示标签
}

function detectTimeAnchor(query: string): TimeAnchor | null {
  const now     = new Date();
  const BJ_OFF  = 8 * 60 * 60 * 1000;
  const bjDateStr = new Date(now.getTime() + BJ_OFF).toISOString().slice(0, 10);

  const todayStart = new Date(`${bjDateStr}T00:00:00+08:00`);
  const todayEnd   = new Date(`${bjDateStr}T23:59:59+08:00`);
  const ydayStart  = new Date(todayStart.getTime() - 86_400_000);
  const ydayEnd    = new Date(todayEnd.getTime()   - 86_400_000);
  const mornStart  = new Date(`${bjDateStr}T06:00:00+08:00`);
  const mornEnd    = new Date(`${bjDateStr}T12:00:00+08:00`);
  const aftnStart  = new Date(`${bjDateStr}T12:00:00+08:00`);
  const aftnEnd    = new Date(`${bjDateStr}T18:00:00+08:00`);

  if (/今天早上|今天上午|今早/.test(query))
    return { startUtc: mornStart.toISOString(), endUtc: mornEnd.toISOString(), label: "今天早上" };
  if (/今天下午/.test(query))
    return { startUtc: aftnStart.toISOString(), endUtc: aftnEnd.toISOString(), label: "今天下午" };
  if (/今天|今日/.test(query))
    return { startUtc: todayStart.toISOString(), endUtc: todayEnd.toISOString(), label: "今天" };
  if (/昨天|昨日/.test(query))
    return { startUtc: ydayStart.toISOString(), endUtc: ydayEnd.toISOString(), label: "昨天" };
  if (/最近|刚才|刚刚/.test(query)) {
    const recentStart = new Date(now.getTime() - 2 * 3_600_000);
    return { startUtc: recentStart.toISOString(), endUtc: now.toISOString(), label: "最近2小时" };
  }
  return null;
}

async function getConversationsByTimeAnchor(
  userId: string,
  anchor: TimeAnchor,
  limit = 15,
): Promise<Array<{ document: string; metadata: Record<string, unknown> }>> {
  try {
    const where: Record<string, unknown> = {
      $and: [
        { userId:    { $eq:  userId            } },
        { fromType:  { $eq:  "human"           } },
        { timestamp: { $gte: anchor.startUtc   } },
        { timestamp: { $lte: anchor.endUtc     } },
      ],
    };
    const raw = await chromaGet("conversations", where);
    return raw
      .sort((a, b) => {
        const ta = (a.metadata.timestamp as string) ?? "";
        const tb = (b.metadata.timestamp as string) ?? "";
        return ta.localeCompare(tb);
      })
      .slice(-limit);
  } catch {
    return [];
  }
}

// ── 家人档案（Lucas before_prompt_build）────────────────────────────
// 读取 ~/.openclaw/workspace-lucas/family/{userId}.md，注入为【家人档案】块

const FAMILY_PROFILE_DIR = join(process.env.HOME ?? "/", ".openclaw/workspace-lucas/family");

// userId → 档案文件名映射（从 config/members.json 加载）
const USER_PROFILE_MAP: Record<string, string> = _membersConfig.profileMap;

function readFamilyProfile(userId: string): string {
  try {
    const key = USER_PROFILE_MAP[userId.toLowerCase()];
    if (!key) return "";
    // 注入精简版（.inject.md），全量版留 Obsidian 供系统工程师维护
    const injectPath = join(FAMILY_PROFILE_DIR, `${key}.inject.md`);
    const content = readFileSync(injectPath, "utf8");
    return `【家人档案】\n${content}`;
  } catch {
    return "";
  }
}

// ─── 从 openclaw.json 读取 Agent 模型配置，调用 OpenAI-compatible API ─────────
function readAgentModelConfig(agentId: string): { baseUrl: string; apiKey: string; model: string } {
  const configPath = join(homedir(), ".openclaw/openclaw.json");
  const config = JSON.parse(readFileSync(configPath, "utf8")) as {
    agents: { list: Array<{ id: string; model: string }> };
    models?: { providers?: Record<string, { baseUrl: string; apiKey: string }> };
  };
  const agent = config.agents.list.find(a => a.id === agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found in openclaw.json`);
  const [providerKey, modelId] = agent.model.split("/");
  const provider = config.models?.providers?.[providerKey];
  if (!provider) throw new Error(`Provider ${providerKey} not found in openclaw.json`);
  return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: modelId };
}

async function callAgentModel(
  agentId: string,
  systemPrompt: string,
  messages: Array<{ role: string; content: string }>,
  maxTokens = 512
): Promise<string> {
  const { baseUrl, apiKey, model } = readAgentModelConfig(agentId);
  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: "system", content: systemPrompt }, ...messages] }),
  });
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

// 对话结束后异步提取要点，更新档案的「当前状态」和「重要记忆」两栏
// fire-and-forget，不阻塞主流程
async function updateFamilyProfileAsync(userId: string, prompt: string, response: string): Promise<void> {
  try {
    const key = USER_PROFILE_MAP[userId.toLowerCase()];
    if (!key) return;
    const profilePath = join(FAMILY_PROFILE_DIR, `${key}.md`);
    if (!existsSync(profilePath)) return;
    const currentProfile = readFileSync(profilePath, "utf8");

    // 跟随对应 Agent 在 openclaw.json 里的模型配置，不硬编码任何 provider
    const raw = await callAgentModel(
      "lucas",
      `你是一个家庭信息提取助手。从一段对话里提取对家人档案有价值的新信息。\n只提取真实出现的新内容，不推断，不编造。如果没有新信息就回答"无"。\n输出格式（JSON）：\n{\n  "current_status": "本次对话反映的最新状态，一两句话，没有则null",\n  "memory": "值得长期记住的重要信息，一两句话，没有则null"\n}`,
      [{ role: "user", content: `【当前档案】\n${currentProfile.slice(0, 800)}\n\n【本次对话】\n用户：${prompt.slice(0, 300)}\n启灵：${response.slice(0, 300)}\n\n请提取新信息：` }],
      512
    );
    let extracted: { current_status?: string | null; memory?: string | null } = {};
    try {
      extracted = JSON.parse(raw.replace(/^```json\n?|\n?```$/g, ""));
    } catch { return; }

    if (!extracted.current_status && !extracted.memory) return;

    // 更新档案文件：替换对应章节内容
    let updated = currentProfile;
    const now = new Date().toLocaleDateString("zh-CN");

    if (extracted.current_status) {
      updated = updated.replace(
        /（## 当前状态[\s\S]*?）\n- 最近动态：待补充/,
        (m) => m
      );
      // 在「最近动态：待补充」后追加，或替换
      updated = updated.replace(
        /- 最近动态：待补充/,
        `- 最近动态（${now}）：${extracted.current_status}`
      );
      // 如果已有内容，在最后一条后追加
      if (!updated.includes(`最近动态（${now}）`)) {
        updated = updated.replace(
          /(## 当前状态[\s\S]*?)\n(---|\n## )/,
          (_, block, sep) => `${block}\n- ${now}：${extracted.current_status}\n${sep}`
        );
      }
    }

    if (extracted.memory) {
      updated = updated.replace(
        /- 待积累\n$/,
        `- 待积累\n- ${now}：${extracted.memory}\n`
      );
      // 如果已有内容，在重要记忆末尾追加
      if (updated === currentProfile || !updated.includes(`${now}：${extracted.memory}`)) {
        updated = updated.replace(
          /(## 重要记忆[\s\S]*)$/,
          (block) => `${block}\n- ${now}：${extracted.memory}`
        );
      }
    }

    if (updated !== currentProfile) {
      writeFileSync(profilePath, updated, "utf8");
    }
  } catch (e) {
    // 静默失败，不影响主流程
  }
}

// ── behavior_patterns 查询（Lucas before_prompt_build）───────────────

async function queryBehaviorPatterns(prompt: string): Promise<string> {
  try {
    const embedding = await embedText(prompt);
    // 不按 userId 过滤，全家成员行为规律一起做相似度搜索
    const raw = await chromaQuery("behavior_patterns", embedding, 6);
    const results = timeWeightedRerank(raw, 3);
    if (results.length === 0) return "";
    const lines = results.map(r => {
      const meta = r.metadata as { prompt?: string; userId?: string };
      const who = meta.userId ? `（${meta.userId}）` : "";
      return `- ${who}${(meta.prompt ?? r.document).slice(0, 100)}`;
    });
    return `【成员行为规律】\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ── family_knowledge 查询（Lucas before_prompt_build）────────────────

async function queryFamilyKnowledge(prompt: string): Promise<string> {
  try {
    const embedding = await embedText(prompt);
    const raw = await chromaQuery("family_knowledge", embedding, 6);
    const results = timeWeightedRerank(raw, 3);
    if (results.length === 0) return "";
    const lines = results.map(r => `- ${r.document.slice(0, 100)}`);
    return `【家庭知识】\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ── L3 成员影子能力视图（shadow agent before_prompt_build）──────────────
//
// 成员影子接收请求时，注入家庭可用能力清单（来自 Kuzu has_capability Facts）。
// 用 10 分钟内存缓存避免频繁 subprocess。

let _capViewCache: { ts: number; content: string } | null = null;

function buildShadowCapabilityView(): string {
  const now = Date.now();
  if (_capViewCache && now - _capViewCache.ts < 10 * 60_000) {
    return _capViewCache.content;
  }
  try {
    const tmpScript = join(PROJECT_ROOT, "scripts/_shadow_cap_view.py");
    const scriptContent = [
      "import kuzu, os, json, sys",
      "db = kuzu.Database(os.path.expanduser('~/HomeAI/Data/kuzu'))",
      "conn = kuzu.Connection(db)",
      "res = conn.execute(",
      "    \"MATCH (a:Entity {type:'agent'})-[f:Fact {relation:'has_capability'}]->(c:Entity {type:'capability'}) \"",
      "    \"WHERE f.valid_until IS NULL RETURN c.id, c.name, f.context ORDER BY a.id, c.name\"",
      ")",
      "rows = []",
      "for row in res:",
      "    rows.append({'id': row[0], 'name': row[1], 'context': row[2] or ''})",
      "sys.stdout.write(json.dumps(rows, ensure_ascii=False) + '\\n')",
      "sys.stdout.flush()",
      "os._exit(0)  # bypass kuzu Database::~Database() SIGBUS on macOS ARM64",
    ].join("\n");
    writeFileSync(tmpScript, scriptContent, "utf8");
    const output = execSync(`${KUZU_PYTHON3_BIN} ${tmpScript}`, { encoding: "utf8", timeout: 10_000 }).trim();
    const caps = JSON.parse(output) as Array<{ id: string; name: string; context: string }>;
    if (caps.length === 0) {
      _capViewCache = { ts: now, content: "" };
      return "";
    }
    const lines = caps.map(c => `- **${c.name}**${c.context ? `：${c.context}` : ""}`);
    const content = `【家庭可用能力清单】\n${lines.join("\n")}\n\n有成员询问某类需求时，优先推荐现有能力，不需要专门开发新功能。`;
    _capViewCache = { ts: now, content };
    return content;
  } catch {
    return ""; // 查询失败静默忽略
  }
}

// ── L3 跨成员协调扫描（Lucas before_prompt_build）────────────────────
//
// 每条消息后轻量扫描：当前话题是否与其他家人近 7 天的私聊对话相关联。
// 只在相似度高于阈值时注入协调提示，不暴露对方原文（隐私安全）。

async function scanCrossMemberContext(currentUserId: string, prompt: string): Promise<string> {
  try {
    const embedding = await embedText(prompt.slice(0, 300));
    const colId = await getChromaCollectionId("conversations");
    const body = {
      query_embeddings: [embedding],
      n_results: 6,
      include: ["documents", "metadatas", "distances"],
    };
    const resp = await fetch(`${CHROMA_BASE}/${colId}/query`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return "";
    const data = await resp.json() as {
      documents: string[][];
      metadatas: Record<string, unknown>[][];
      distances: number[][];
    };

    const docs  = data.documents[0] ?? [];
    const metas = data.metadatas[0] ?? [];
    const dists = data.distances[0] ?? [];

    const recent7dMs = Date.now() - 7 * 24 * 60 * 60 * 1000;
    // 阈值 0.4：nomic-embed-text cosine distance，< 0.4 表示话题强相关
    const DIST_THRESHOLD = 0.4;

    const matches = docs
      .map((_, i) => ({
        meta: metas[i] as { userId?: string; timestamp?: string; source?: string },
        dist: dists[i] ?? 1,
      }))
      .filter(r =>
        r.dist < DIST_THRESHOLD &&
        r.meta.userId !== currentUserId &&
        r.meta.source !== "group" && // 只扫私聊记忆，群聊不作跨成员协调依据
        new Date(r.meta.timestamp ?? 0).getTime() > recent7dMs,
      );

    if (matches.length === 0) return "";

    const userIds = [...new Set(matches.map(r => r.meta.userId ?? ""))].filter(Boolean);
    const who = userIds.length === 1 ? "另一位家人" : `${userIds.length} 位家人`;
    return `【跨成员协调参考】近 7 天内，${who}提到了与当前话题相关的内容。如有需要，可在征得双方同意后协调。私聊内容默认保密，未授权不主动连接。`;
  } catch {
    return ""; // 扫描失败静默忽略，不影响主流程
  }
}

// ── agent_interactions 查询（Andy / Lisa / Lucas before_prompt_build）──────────
// Lucas 调用时查询 Andy+Lisa 全部协作记录，感知团队动态（开发进展、Spec 设计、实现结果）

async function queryAgentInteractions(prompt: string, agentId: "andy" | "lisa" | "lucas"): Promise<string> {
  try {
    const embedding = await embedText(prompt);
    // Andy / Lucas 同时检索 Andy 和 Lisa 记录（Andy 避免重复设计，Lucas 感知团队进展）
    const where: Record<string, unknown> = (agentId === "andy" || agentId === "lucas")
      ? { "$or": [{ agentId: { "$eq": "andy" } }, { agentId: { "$eq": "lisa" } }] }
      : { agentId: { "$eq": agentId } };
    const raw = await chromaQuery("agent_interactions", embedding, 8, where);
    const results = timeWeightedRerank(raw, 4);
    if (results.length === 0) return "";
    const label = agentId === "lucas" ? "团队近期动态"
      : agentId === "andy" ? "历史 Spec & 实现参考"
      : "历史实现参考";
    const lines = results.map(r => `- ${r.document.slice(0, 150)}`);
    return `【${label}】\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ── code_history 查询（Andy / Lisa before_prompt_build）──────────────

async function queryCodeHistory(prompt: string): Promise<string> {
  try {
    const embedding = await embedText(prompt);
    const raw = await chromaQuery("code_history", embedding, 6);
    const results = timeWeightedRerank(raw, 3);
    if (results.length === 0) return "";
    const lines = results.map(r => {
      const meta = r.metadata as { description?: string; filePaths?: string };
      return `- ${(meta.description ?? r.document).slice(0, 120)}${meta.filePaths ? `（文件：${meta.filePaths}）` : ""}`;
    });
    return `【历史交付记录】\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ── codebase_patterns 查询（Andy before_prompt_build）────────────────
// Lisa 每次 opencode 结束后写入，Andy 写 spec 时注入相关代码库洞察：
// 哪些文件容易出现 spec 吻合率低、哪些模式稳定可参考

async function queryCodebasePatterns(prompt: string): Promise<string> {
  try {
    const embedding = await embedText(prompt);
    const raw = await chromaQuery("codebase_patterns", embedding, 6);
    const results = timeWeightedRerank(raw, 3);
    if (results.length === 0) return "";
    const lines = results.map(r => {
      const meta = r.metadata as { success?: boolean; matchRate?: number; filesChanged?: string; timestamp?: string };
      const status = meta.success ? "✅" : "❌";
      const rate   = meta.matchRate != null ? `吻合率 ${meta.matchRate}%` : "";
      const files  = (meta.filesChanged ?? "").split(",").filter(Boolean).slice(0, 3).join("、");
      const date   = (meta.timestamp ?? "").slice(0, 10);
      return `- ${status} [${date}] ${rate}${files ? `，变更：${files}` : ""}｜${r.document.slice(0, 100)}`;
    });
    return `【代码库洞察】\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ── 待调度需求队列（Lucas before_prompt_build / HEARTBEAT 空闲调度）─────
// 返回 status=pending 的需求，供 Lucas 在空闲时自主触发开发流水线

async function queryPendingSchedulableRequirements(): Promise<string> {
  try {
    const results = await chromaGet("requirements", { status: { $eq: "pending" } });
    if (results.length === 0) return "";
    const lines = results.slice(0, 5).map(r => {
      const ts = (r.metadata.timestamp as string ?? "").slice(0, 10);
      const note = (r.metadata.note as string ?? "").slice(0, 60);
      const summary = r.document.slice(0, 300);
      return `- [${ts}] id=${r.id}\n  需求：${summary}${note ? `\n  备注：${note}` : ""}`;
    });
    return `【待调度需求队列·共${results.length}条·空闲时触发 trigger_development_pipeline】\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ── requirements 未完成查询（Andy before_prompt_build）───────────────
// 仅返回 outcome="" 的进行中需求，提醒 Andy 有哪些需求还在跑

async function queryPendingRequirements(prompt: string): Promise<string> {
  try {
    const embedding = await embedText(prompt);
    const raw = await chromaQuery("requirements", embedding, 6, { outcome: { $eq: "" } });
    const results = timeWeightedRerank(raw, 3);
    if (results.length === 0) return "";
    const lines = results.map(r => {
      const meta = r.metadata as { intentType?: string; timestamp?: string };
      const date = toCST(meta.timestamp);
      return `- [${date}] ${r.document.slice(0, 100)}（${meta.intentType ?? ""}）`;
    });
    return `【进行中的需求】\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

async function updateDecisionOutcome(
  agentId: string,
  decisionId: string,
  outcome: string,
  outcomeNote: string,
): Promise<void> {
  try {
    await chromaUpdate("decisions", decisionId, {
      outcome,
      outcome_at: nowCST(),
      outcome_note: outcomeNote,
      agent: agentId, // 保留以防 ChromaDB 部分更新丢失
    });
  } catch {
    // 更新失败静默处理
  }
}

// ── 需求记忆（requirements 集合）────────────────────────────────────
//
// 每次 Andy→Lisa 流水线启动时写入，outcome="" 表示进行中。
// record_outcome_feedback 工具写回最终 outcome。

async function writeRequirement(params: {
  requirementId: string;
  userId: string;
  requirement: string;
  intentType: string;
}): Promise<void> {
  try {
    const embedding = await embedText(params.requirement);
    await chromaAdd("requirements", params.requirementId, params.requirement, {
      userId: params.userId,
      intentType: params.intentType,
      timestamp: nowCST(),
      outcome: "",         // "" = 进行中（ChromaDB 不接受 null）
      outcome_at: "",
      outcome_note: "",
    }, embedding);
  } catch {
    // 写入失败静默处理，不影响主流程
  }
}

async function updateRequirementOutcome(
  requirementId: string,
  outcome: string,
  outcomeNote: string,
): Promise<void> {
  try {
    await chromaUpdate("requirements", requirementId, {
      outcome,
      outcome_at: nowCST(),
      outcome_note: outcomeNote,
    });
  } catch {
    // 更新失败静默处理
  }
}

// ── Agent 交互记忆（agent_interactions 集合）─────────────────────────
//
// 记录每次流水线中 Andy（spec）和 Lisa（实现报告）的实际输出。
// before_prompt_build 阶段语义检索，为 Andy/Lisa 提供历史参考。

async function writeAgentInteraction(params: {
  // 流水线模式（Andy spec / Lisa implementation）
  requirementId?: string;
  agentId?: string;
  interactionType?: string;
  content: string;
  // 分身交互模式（Lucas ↔ shadow agent）
  fromAgent?: string;
  toAgent?: string;
  taskId?: string;
}): Promise<void> {
  try {
    // 生成唯一 ID：优先用 taskId（分身模式），其次用 agentId+requirementId（流水线模式）
    const id = params.taskId
      ? `shadow-${params.taskId}`
      : `${params.agentId ?? "unknown"}-${params.requirementId ?? Date.now()}`;
    const document = params.content.slice(0, 1000);
    const embedding = await embedText(document);
    await chromaAdd("agent_interactions", id, document, {
      requirementId: params.requirementId ?? "",
      agentId: params.agentId ?? params.fromAgent ?? "",
      toAgent: params.toAgent ?? "",
      interactionType: params.interactionType ?? (params.fromAgent ? "shadow-query" : ""),
      timestamp: nowCST(),
    }, embedding);
  } catch {
    // 写入失败静默处理
  }
}

// ── 代码历史（code_history 集合）─────────────────────────────────────
//
// Lisa 验证通过后写入：记录交付文件路径 + 功能描述。
// Andy before_prompt_build 检索，避免重复造轮子。

async function writeCodeHistory(params: {
  requirementId: string;
  filePaths: string[];
  description: string;
}): Promise<void> {
  try {
    const id = `code-${params.requirementId}`;
    const document = `${params.description}\n文件：${params.filePaths.join(", ")}`;
    const embedding = await embedText(document);
    await chromaAdd("code_history", id, document, {
      requirementId: params.requirementId,
      filePaths: params.filePaths.join(","),
      description: params.description.slice(0, 500),
      timestamp: nowCST(),
    }, embedding);
  } catch {
    // 写入失败静默处理
  }
}

// ── 行为规律（behavior_patterns 集合）───────────────────────────────
//
// Lucas agent_end 后检测对话中是否含成员偏好/习惯信息，有则写入。
// 信号词：喜欢、不喜欢、习惯、偏好、总是、每次、讨厌、爱好

const BEHAVIOR_PATTERN_SIGNALS = _signalsConfig.behaviorPatternSignals;

async function writeBehaviorPattern(params: {
  userId: string;
  prompt: string;
  response: string;
}): Promise<void> {
  const combined = `${params.prompt} ${params.response}`;
  const hasSignal = BEHAVIOR_PATTERN_SIGNALS.some(s => combined.includes(s));
  if (!hasSignal) return;
  try {
    const id = `bp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const document = `用户 ${params.userId}：${params.prompt.slice(0, 300)}\nLucas 观察：${params.response.slice(0, 300)}`;
    const embedding = await embedText(document);
    await chromaAdd("behavior_patterns", id, document, {
      userId: params.userId,
      timestamp: nowCST(),
      prompt: params.prompt.slice(0, 300),
      response: params.response.slice(0, 300),
    }, embedding);
  } catch {
    // 写入失败静默处理
  }
}

// ── 家庭知识（family_knowledge 集合）────────────────────────────────
//
// Lucas agent_end 后检测对话中是否含家庭档案类信息，有则写入。
// 信号词：生日、设备、成员、年龄、叫什么、名字、多大、家里、手机、电脑

const FAMILY_KNOWLEDGE_SIGNALS = _signalsConfig.familyKnowledgeSignals;

async function writeFamilyKnowledge(params: {
  userId: string;
  prompt: string;
  response: string;
}): Promise<void> {
  const combined = `${params.prompt} ${params.response}`;
  const hasSignal = FAMILY_KNOWLEDGE_SIGNALS.some(s => combined.includes(s));
  if (!hasSignal) return;
  try {
    const id = `fk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const document = `家庭知识（来源 ${params.userId}）：${params.prompt.slice(0, 300)}\n${params.response.slice(0, 300)}`;
    const embedding = await embedText(document);
    await chromaAdd("family_knowledge", id, document, {
      userId: params.userId,
      timestamp: nowCST(),
      prompt: params.prompt.slice(0, 300),
      response: params.response.slice(0, 300),
    }, embedding);
  } catch {
    // 写入失败静默处理
  }
}

// ── 子 Agent 档案（agents 集合）──────────────────────────────────────
//
// 子 Agent 创建/退休时调用，将语义档案写入 ChromaDB。
// Chapter 7（子 Agent 生命周期）的 create_member_shadow / create_sub_agent 工具
// 以及 evict() / markDormant() 时调用此函数同步档案。

async function writeAgentRecord(params: {
  agentId: string;
  tier: number;
  parentAgentId: string;
  description: string;
  status: "active" | "dormant" | "evicted";
}): Promise<void> {
  try {
    const document = `Agent ${params.agentId}（Tier ${params.tier}，创建者 ${params.parentAgentId}）：${params.description}`;
    const embedding = await embedText(document);
    // 用 upsert：同一 agentId 状态变化时更新而非报错
    await chromaUpsert("agents", params.agentId, document, {
      tier: params.tier,
      parentAgentId: params.parentAgentId,
      description: params.description.slice(0, 500),
      status: params.status,
      updatedAt: nowCST(),
    }, embedding);
  } catch {
    // 写入失败静默处理
  }
}

// ── 通用工具 ──────────────────────────────────────────────────────────

// bigram 相似度评分（双字符滑窗，兼容中文）
// 用于 capability-registry 去重检查（非记忆检索）
function bigramScore(a: string, b: string): number {
  const bigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
    return set;
  };
  const bA = bigrams(a);
  const bB = bigrams(b);
  let n = 0;
  for (const bg of bB) { if (bA.has(bg)) n++; }
  return n;
}

// ── Gateway 调用工具函数 ───────────────────────────────────────────────

async function callGatewayAgent(
  agentId: string,
  message: string,
  timeoutMs = 300_000,
  threadId?: string,   // 可选：多轮协作线程 ID，传入后自动注入历史并写回
): Promise<string> {
  const historyMessages = threadId ? buildAgentThreadMessages(threadId) : [];
  const messages = [...historyMessages, { role: "user", content: message }];

  const resp = await fetch(`${GATEWAY_URL}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${GATEWAY_TOKEN}`,
      "x-openclaw-agent-id": agentId,
    },
    body: JSON.stringify({
      model: agentId,
      messages,
      stream: false,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) throw new Error(`Gateway ${agentId} responded ${resp.status}`);
  const data = (await resp.json()) as { choices?: { message?: { content?: string } }[] };
  const reply = data.choices?.[0]?.message?.content ?? "";

  // 写回线程历史（只写有回复的轮次）
  if (threadId && reply) {
    appendAgentThread(threadId, message, reply);
  }

  return reply;
}

// ── callGatewayAgent 重试包装 ─────────────────────────────────────────
//
// 借鉴 ClaudeCode withRetry.ts 模式：指数退避 + jitter，区分前台（重试）和后台（不重试）。
// 前台流水线节点（Andy / Lisa）最多重试 3 次；Lucas 错误人话包装属后台，不重试。
//
// 退避公式（同 ClaudeCode）：BASE(5s) × 2^(attempt-1) + rand(0~25%) × BASE，上限 60s
// 覆盖场景：超时(AbortError / TimeoutError)、网络抖动(5xx / connection error)
// 不重试：4xx（规格错误、鉴权错误）——重试无意义

const RETRY_BASE_DELAY_MS = 5_000;
const RETRY_MAX_DELAY_MS = 60_000;

function getRetryDelay(attempt: number): number {
  const base = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1), RETRY_MAX_DELAY_MS);
  return base + Math.random() * 0.25 * base;
}

function isRetryableError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  // 超时（AbortSignal.timeout 抛 TimeoutError / AbortError）
  if (e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError")) return true;
  // 5xx 或网络错误
  if (/Gateway .* responded 5\d\d/.test(msg)) return true;
  if (/network|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed/i.test(msg)) return true;
  return false;
}

async function callGatewayAgentWithRetry(
  agentId: string,
  message: string,
  timeoutMs = 300_000,
  threadId?: string,
  maxRetries = 3,
): Promise<string> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callGatewayAgent(agentId, message, timeoutMs, threadId);
    } catch (e) {
      lastError = e;
      const retryable = isRetryableError(e);
      const isLast = attempt === maxRetries;
      if (!retryable || isLast) break;
      const delay = getRetryDelay(attempt);
      console.log(`[retry] ${agentId} 第 ${attempt}/${maxRetries} 次失败，${Math.round(delay/1000)}s 后重试。错误：${e instanceof Error ? e.message : e}`);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ── Coordinator 并行调度 ──────────────────────────────────────────────
//
// Andy 大特性 Coordinator 模式：并行触发 N 个 Lisa 实例，每个处理一个独立 sub-spec。
// 结果写入 data/pipeline/{reqId}/{taskId}.json，聚合后返回给 Andy 综合。

type SubSpecTask = {
  task_id: string;
  title: string;
  files_owned?: string[];
  provides_interfaces?: unknown[];
  depends_on_interfaces?: unknown[];
  acceptance_criteria?: unknown[];
  out_of_scope?: string[];
  [key: string]: unknown;
};

type SubTaskResult = {
  taskId: string;
  title: string;
  result: string;
  success: boolean;
};

async function spawnParallelLisa(
  subSpecs: SubSpecTask[],
  reqId: string,
): Promise<SubTaskResult[]> {
  const pipelineDir = join(PROJECT_ROOT, "data/pipeline", reqId);
  mkdirSync(pipelineDir, { recursive: true });

  const tasks = subSpecs.map(async (subSpec): Promise<SubTaskResult> => {
    const taskId = subSpec.task_id;
    const title = subSpec.title ?? taskId;
    const threadId = `andy-to-lisa:${reqId}_${taskId}`;

    const lisaPrompt = [
      `【Coordinator Sub-Task】${taskId}: ${title}`,
      `【需求 ID】${reqId}`,
      ``,
      `【Sub-Spec】`,
      "```json",
      JSON.stringify(subSpec, null, 2),
      "```",
      ``,
      "请阅读以上 Sub-Spec，使用 run_opencode 工具实现。",
      "注意：",
      "- 你只负责 files_owned 中的文件，不要碰其他模块",
      "- depends_on_interfaces 是其他模块会提供的接口，直接调用即可，无需自己实现",
      "- 实现完成后输出交付报告：1) 完成了什么 2) 生成的文件路径 3) 暴露的接口签名（函数名+入参+返回类型）4) 验证结果",
      `【协作线程 ID】${threadId}（遇阻时调用 report_implementation_issue 请带上此 thread_id）`,
    ].join("\n");

    try {
      // 并行子任务不重试：retry 在并发上下文里会叠出更多 Lisa 会话；失败直接记录，由 Andy 决策下一步
      const result = await callGatewayAgent("lisa", lisaPrompt, 600_000, threadId);
      writeFileSync(
        join(pipelineDir, `${taskId}.json`),
        JSON.stringify({ taskId, title, status: "completed", result, timestamp: nowCST() }, null, 2),
      );
      appendJsonl(join(PROJECT_ROOT, "data/corpus/lisa-corpus.jsonl"), {
        timestamp: nowCST(), source: "coordinator", reqId, taskId, content: result,
      });
      void notifyEngineer(`【${reqId}·${taskId}】✅ ${title} 完成`, "pipeline", "lisa");
      return { taskId, title, result, success: true };
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      writeFileSync(
        join(pipelineDir, `${taskId}.json`),
        JSON.stringify({ taskId, title, status: "failed", error: errMsg, timestamp: nowCST() }, null, 2),
      );
      void notifyEngineer(`【${reqId}·${taskId}】❌ ${title} 失败：${errMsg.slice(0, 200)}`, "pipeline", "lisa");
      return { taskId, title, result: errMsg, success: false };
    }
  });

  return Promise.all(tasks);
}

// ── Channel 回调路径解析 ──────────────────────────────────────────────

function parseReplyTo(userId: string): { fromUser: string; chatId?: string; isGroup: boolean } {
  if (userId.startsWith("group:")) {
    return { fromUser: "", chatId: userId.replace("group:", ""), isGroup: true };
  }
  return { fromUser: userId, isGroup: false };
}

// 工程师通知：发送到企业应用通道 + 同步写入 agent_interactions（完整内容，不截断）
async function notifyEngineer(message: string, type: "pipeline" | "intervention" | "info" = "pipeline", fromAgent = "pipeline"): Promise<void> {
  // 发送到企业微信工程师通道
  void fetch(CHANNEL_NOTIFY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, type, fromAgent }),
  }).catch(() => {});
  // 同步写入 agent_interactions，让工程师通知可检索、可审计
  void writeAgentInteraction({
    requirementId: undefined,
    agentId: fromAgent,
    toAgent: "engineer",
    interactionType: `notify_${type}`,
    content: message,
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isNonHumanUser(userId: string): boolean {
  return !userId || userId.startsWith("system") || userId === "unknown" || userId === "test" ||
    userId === "group" || userId === "owner" || userId === "heartbeat-cron" || UUID_RE.test(userId);
}

async function pushToChannel(response: string, userId: string, success: boolean): Promise<void> {
  // 非法 userId 不推送（system/UUID/group 等），浪费企微 API 调用
  if (isNonHumanUser(userId)) return;
  try {
    await fetch(CHANNEL_PUSH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ response, replyTo: parseReplyTo(userId), success }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // 推送失败静默处理
  }
}

// 基础设施变更关键词（从 config/infra-guard.json 加载）
const INFRA_KEYWORDS = _infraConfig.infraKeywords;

function isInfraChange(requirement: string, spec: string): boolean {
  const text = (requirement + " " + spec).toLowerCase();
  return INFRA_KEYWORDS.some(k => text.includes(k.toLowerCase()));
}

// 通知系统工程师审核基础设施变更（直发给 ZengXiaoLong）
async function notifyEngineerReview(params: {
  requirement: string;
  spec: string;
  userId: string;
  requirementId: string;
}): Promise<void> {
  const msg = [
    `🔧 Lisa 完成了一个基础设施变更，需要你审核后手动部署。`,
    ``,
    `【需求来源】${params.userId}`,
    `【需求内容】${params.requirement.slice(0, 100)}`,
    `【产物位置】app/generated/（需求ID: ${params.requirementId}）`,
    ``,
    `确认无误后手动应用并重启对应服务。`,
  ].join("\n");

  try {
    await fetch(CHANNEL_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: OWNER_ID, text: msg }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // 通知失败静默处理，不影响主流程
  }
}

// 事件驱动主动推送：pipeline 完成立即通知请求者，不等 Lucas 定时循环
// 私聊：直接调用 send_message；群聊：降级到 push-reply；system-scheduler 不推送
async function pushEventDriven(text: string, userId: string, success: boolean): Promise<void> {
  if (!userId || isNonHumanUser(userId)) return;
  const msg = success ? text : `❌ 处理失败：${text}`;
  if (userId.startsWith("group:")) {
    await pushToChannel(msg, userId, success);
    return;
  }
  try {
    const resp = await fetch(CHANNEL_SEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId, text: msg }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!resp.ok) throw new Error(`send-message HTTP ${resp.status}`);
  } catch {
    // 主动推送失败，降级到 push-reply 兜底
    // msg 已包含 "❌ 处理失败：" 前缀（success=false 时），传 true 防止 push-reply 再次添加前缀
    await pushToChannel(msg, userId, true);
  }
}

// ── Andy→Lisa 流水线（异步，不阻塞 Lucas 回复）────────────────────────
//
// 完整三步流水线：
//   Step 1  DeepSeek 调研（search: true）→ 技术背景
//   Step 2  Codebase Reader → 已有代码风格 + Andy 身份配置
//   Step 3  Plandex（模型跟着 Andy 走）→ Implementation Spec
//           若 Plandex 失败：fallback 到 Gateway Andy 直接生成 spec
//   Step 4  写 andy-corpus.jsonl（ADR 格式，含生命周期字段）
//   Step 5  触发 Lisa 实现（含语法验证指令：py_compile 确认主脚本可执行）
//   Step 6  Lucas 验收重包装（V字型右侧验收层）
//           将 Lisa 技术报告翻译成家人语气，写 lucas-corpus.jsonl DPO 原料
//           Lucas 调用失败时降级为 Lisa 原始报告
//
// 企业微信推送两次：
//   推 1：Andy 规划完成（预告 Lisa 正在实现）
//   推 2：Lucas 验收后的最终消息（降级时为 Lisa 原始报告）

// ── Andy 并发限速（防止 MiniMax 级联超时）────────────────────────────
// MiniMax 并发请求全部 300s 超时时会导致 Gateway session pool 腐化。
// 信号量：最多同时跑 MAX_ANDY_CONCURRENT 个流水线，超出的排队等待（不丢弃）。
// 暂定串行（=1），稳定后再评估是否放开。
const MAX_ANDY_CONCURRENT = 1;
let andyRunningCount = 0;
const andyQueue: Array<() => void> = [];

function andyAcquire(): Promise<void> {
  return new Promise((resolve) => {
    if (andyRunningCount < MAX_ANDY_CONCURRENT) {
      andyRunningCount++;
      resolve();
    } else {
      andyQueue.push(resolve);
    }
  });
}

function andyRelease(): void {
  const next = andyQueue.shift();
  if (next) {
    next(); // 直接把 slot 转给队列里的下一个，不改 count
  } else {
    andyRunningCount--;
  }
}
// ──────────────────────────────────────────────────────────────────────

async function runAndyPipeline(params: {
  requirement: string;
  intentType: string;
  wecomUserId: string;
  lucasContext?: string;      // Lucas 补充的需求背景
  originalSymptom?: string;  // 用户原始表达（bug 症状 / 用户原话），evaluator 独立验证根因用
  visitorCode?: string;      // 访客邀请码
}): Promise<void> {
  const requirementId = `req_${Date.now()}`;

  // 写 requirements 集合：记录需求发起（outcome="" 表示进行中）
  void writeRequirement({
    requirementId,
    userId: params.wecomUserId,
    requirement: params.requirement,
    intentType: params.intentType,
  });

  // 注册到任务注册表，Lucas 可查询/叫停
  upsertTaskRegistry({
    id: requirementId,
    requirement: params.requirement,
    submittedBy: params.wecomUserId,
    submittedAt: nowCST(),
    status: "running",
    currentPhase: "andy_designing",
    ...(params.lucasContext ? { lucasContext: params.lucasContext } : {}),
    ...(params.visitorCode ? { visitorCode: params.visitorCode } : {}),
  });

  // 通报系统工程师：流水线启动
  void notifyEngineer(`流水线启动 [${requirementId}]\n发起人：${params.wecomUserId}\n\n━━ 需求原文 ━━\n${params.requirement}`, "pipeline", "lucas");

  // Lucas 路由决策记忆：记录"为这个需求触发了流水线"
  void addDecisionMemory({
    decision_id: requirementId,
    agent: "lucas",
    timestamp: nowCST(),
    context: params.requirement.slice(0, 300),
    decision: "触发 Andy→Lisa 开发流水线",
    outcome: null,
    outcome_at: null,
    outcome_note: null,
    userId: params.wecomUserId,
  } satisfies DecisionRecord);

  // 并发限速：等待 slot，防止多个 Andy 同时调用 MiniMax 导致级联超时
  if (andyRunningCount >= MAX_ANDY_CONCURRENT) {
    void pushToChannel(
      `⏳ 开发团队正忙（当前有 ${andyRunningCount} 个需求在处理），你的需求已排队，稍后自动开始。`,
      params.wecomUserId,
      true,
    );
  }
  await andyAcquire();

  try {
    // Andy 通过 OpenClaw 原生工具调用机制自主驱动流水线：
    //   Andy 调 research_task → trigger_lisa_implementation
    // 插件层不再干预流水线步骤，让 Andy 作为真正的 Agent 运行。
    //
    // Bug 修复不走 research（那是功能调研），直接进入 Lisa 分析 + Andy 审阅模式
    const isBugFix = params.intentType === "bug_fix";

    const andyMessage = isBugFix
      ? [
          `【Bug 修复任务 ID: ${requirementId}】`,
          params.requirement,
          `【需求发起人 user_id】${params.wecomUserId}`,
          ...(params.lucasContext ? [`【Lucas 补充背景】${params.lucasContext}`] : []),
          ...(params.originalSymptom ? [`【用户原始症状（保留，传给 evaluator 验证根因用）】${params.originalSymptom}`] : []),
          ``,
          `请按顺序完成以下步骤（工具调用不可跳过）：`,
          `0. 用 exec 读涉及文件，理解问题上下文。不要调用 research_task（那是技术调研，Bug 修复只需要读代码找根因）。`,
          `1. 基于代码理解，自己分析根因：问题在哪里、是什么导致的、怎么修。`,
          `2. 输出完整 Implementation Spec（根因 + 修复方案 + acceptance_criteria），包含 code_evidence（你 exec 读过的文件里找到的真实符号）。`,
          `3. 如需评审（集成点 ≥ 3 / AC ≥ 4 / 跨模块），调用 request_andy_evaluation，传入 spec_summary 和 original_symptom="${params.originalSymptom ?? params.requirement}"`,
          `4. 调用 trigger_lisa_implementation，传入 spec、user_id="${params.wecomUserId}"、requirement_id="${requirementId}"`,
          ``,
          `Bug 修复不需要调研，只需要读代码确认问题点后直接出修复方案。`,
        ].join("\n")
      : [
          `【需求 ID: ${requirementId}】`,
          params.requirement,
          `【需求发起人 user_id】${params.wecomUserId}`,
          ...(params.lucasContext ? [`【Lucas 补充背景】${params.lucasContext}（这是家人的真实情绪/时间需求/可接受替代方案，设计时优先考虑）`] : []),
          ``,
          `请按顺序完成以下步骤（工具调用不可跳过）：`,
          `0. 用 exec 读相关代码，确认集成点真实存在`,
          `1. 调用 research_task 调研技术背景和可行性`,
          `2. 根据调研结论，直接输出完整 Implementation Spec（自己写，不需要外部工具）`,
          `3. 调用 trigger_lisa_implementation，传入 spec、user_id="${params.wecomUserId}"、requirement_id="${requirementId}"`,
          ``,
          `完成后用一句话总结规划方案。`,
        ].join("\n");

    // 检查是否在 Andy 运行期间被叫停
    if (isTaskCancelled(requirementId)) {
      void pushToChannel(`ℹ️ 任务已被叫停，Andy 完成后不会继续触发 Lisa。`, params.wecomUserId, true);
    } else {
      // 单次 30 分钟超时，不重试。
      // callGatewayAgentWithRetry 在超时时会重试，每次重试创建新 Andy 会话，
      // 若 Andy 被重试 3 次，最坏情况产生 3 个并发 Andy 会话 + 3 个 Lisa 会话 + 3 个 opencode 进程。
      // 改为直接 callGatewayAgent：Andy 真正需要的时间（read+research+spec+trigger_lisa=instant）约 5~15 min，
      // 1800s 绰绰有余；超时或报错只发生一次，不会创建重复会话。
      const andyResponse = await callGatewayAgent("andy", andyMessage, 1_800_000);
      // 告知 Lucas Andy 已开始处理（知情方，Lucas 决定是否与用户沟通）
      if (params.wecomUserId && params.wecomUserId !== "unknown") {
        void callGatewayAgent(
          "lucas",
          [
            `【Andy 收到需求 · ${requirementId}】`,
            andyResponse?.slice(0, 300) ?? "Andy 正在分析需求并设计方案，稍后 Lisa 会开始实现。",
            ``,
            `用户 ID：${params.wecomUserId}`,
            `你现在知道开发进展了，根据用户状态决定是否、何时告知。`,
          ].join("\n"),
          60_000,
        );
      }
      // 验证 Andy 实际触发了 Lisa：检查协作线程文件是否存在
      // andy-to-lisa:{requirementId}_collab.json 由 trigger_lisa_implementation 写入
      // 若不存在，Andy 响应了但跳过了流水线（幻觉完成）
      const threadFile = join(AGENT_THREAD_DIR, `andy-to-lisa:${requirementId}_collab.json`);
      if (existsSync(threadFile)) {
        markTaskStatus(requirementId, "completed");
      } else {
        markTaskStatus(requirementId, "failed");
        void notifyEngineer(`流水线异常 [${requirementId}]\nAndy 响应但未触发 Lisa（无协作线程文件）`, "pipeline", "lucas");
        // Andy 没有启动实现流水线——让 Lucas 判断原因并决定下一步
        // Lucas 有家人背景/记忆，能判断：①自己补充背景重新触发 ②问用户一个关键问题 ③判断是技术问题上报
        void (async () => {
          try {
            const lucasDecisionPrompt = [
              `【流水线卡壳】Andy 收到了这个需求，但没有调用 trigger_lisa_implementation 启动实现。`,
              `需求原文：${params.requirement.slice(0, 400)}`,
              `需求 ID：${requirementId}`,
              ``,
              `Andy 没有启动流水线，通常是因为需求信息不足、或遇到技术问题。`,
              `请你判断，然后选一个行动（不要两个都做）：`,
              `1. 如果是需求背景不足，你能从你对家人的了解里补充信息 → 调用 trigger_development_pipeline，在 lucasContext 里附上补充背景`,
              `2. 如果你也不确定，需要家人提供更多信息 → 用人话问爸爸一个最关键的问题`,
              `3. 如果你判断是技术问题（不是信息问题）→ 调用 notify_engineer 上报，并口语告知爸爸稍等`,
            ].join("\n");
            const lucasDecision = await callGatewayAgent("lucas", lucasDecisionPrompt, 60_000);
            if (lucasDecision) {
              await pushToChannel(lucasDecision, params.wecomUserId, true);
            }
          } catch {
            await pushToChannel(
              `Andy 分析了这个需求，但没有启动实现。可能是需求细节还不够，稍后可以把具体场景说得更详细一些。`,
              params.wecomUserId,
              true,
            );
          }
        })();
      }
    }
  } catch (e: unknown) {
    const rawErr = e instanceof Error ? e.message : String(e);
    // Fix 2：超时/失败时先检查 collab 文件
    // 如果存在，说明 Andy 已触发 trigger_lisa_implementation，Lisa 在后台异步运行
    // 此时不标 failed——Fix 3 会在 Lisa 完成后更新状态
    const threadFile = join(AGENT_THREAD_DIR, `andy-to-lisa:${requirementId}_collab.json`);
    if (existsSync(threadFile)) {
      // Andy 已触发 Lisa，任务保持 running，Lisa 的 async IIFE 负责最终状态
      void notifyEngineer(`Andy 超时但已触发 Lisa [${requirementId}]，Lisa 在后台继续执行`, "pipeline", "lucas");
    } else {
      // Andy 未触发 Lisa，真正的失败
      markTaskStatus(requirementId, "failed");
      void notifyEngineer(`流水线失败 [${requirementId}]\n\n━━ 错误详情 ━━\n${rawErr}`, "pipeline", "lucas");
      // 通过 Lucas 包装成人话再推送，避免裸机器错误出现在家人界面
      try {
        const lucasPrompt = [
          `Andy 在处理一个开发需求时遇到了技术问题，流水线中断了。`,
          `技术原因（内部参考，不要原文转述给家人）：${rawErr.slice(0, 300)}`,
          ``,
          `请用一两句人话告诉爸爸：什么失败了、大概是什么原因（不说技术细节）、他现在能做什么（比如稍后重发、或者等我排查）。`,
          `口气自然随意，不要用 ❌ 开头。`,
        ].join("\n");
        const lucasVerdict = await callGatewayAgent("lucas", lucasPrompt, 30_000);
        await pushToChannel(lucasVerdict, params.wecomUserId, true);
      } catch {
        await pushToChannel(
          `Andy 处理这个需求时遇到了问题，流水线暂停了。你可以稍后重新发一遍需求，或者等我排查好了告诉你。`,
          params.wecomUserId,
          true,
        );
      }
    }
  } finally {
    andyRelease();
  }
}

// ── resolveAgentModel：路由决策提取（与 before_model_resolve 逻辑一致）─────────────
//
// 用于需要在 OpenClaw session 外做路由决策的场景（如 executeOpenCode 调用前）。
// 与 before_model_resolve 保持同一份路由逻辑，确保 opencode 跟随 Lisa 阈值进化。

function resolveAgentModel(agentId: string): string {
  const config = AGENT_EVOLUTION_CONFIGS.find((c) => c.agentId === agentId);
  if (!config) return OPENCODE_MODEL; // 未知 Agent，fallback 环境变量

  const thresholds = loadRoutingThresholds();
  const localThreshold = thresholds[agentId]?.localThreshold ?? config.localThresholdInit;

  // Lisa/Andy 无意图分类，complexityScore 固定 0.5（与 before_model_resolve 一致）
  const complexityScore = 0.5;
  const useLocal = complexityScore < localThreshold;

  const provider = useLocal ? config.localProvider : config.cloudProvider;
  const model    = useLocal ? config.localModel    : config.cloudModel;
  return `${provider}/${model}`;
}

// ── opencode 执行 ──────────────────────────────────────────────────────
//
// OpenCode 的 --model 参数格式为 "provider/model"（如 zai/glm-5、ollama/local-assistant）。
// 模型选择默认通过 resolveAgentModel("lisa") 跟随 Lisa 路由阈值，
// 调用方可通过 modelOverride 显式覆盖。

async function executeOpenCode(
  task: string,
  projectRoot: string,
  modelOverride?: string,
): Promise<string> {
  // 构造 OpenCode model 字符串（provider/model 格式）
  // 优先使用调用方显式指定 → 否则走 resolveAgentModel("lisa")（跟随 Lisa 路由阈值进化）
  const model = modelOverride ?? resolveAgentModel("lisa");

  // debug: 记录调用参数，确认 model 名称是否正确
  const { appendFileSync } = await import("fs");
  appendFileSync("/tmp/opencode-debug.log",
    `[${nowCST()}] executeOpenCode called: model=${model} cwd=${projectRoot}\n`);

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn(OPENCODE_BIN, ["run", "--model", model, task], {
      cwd: projectRoot,
      env: { ...process.env },
      timeout: 600_000,
    });

    proc.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr.on("data", (chunk: Buffer) => chunks.push(chunk));

    proc.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf8").trim();
      resolve(code === 0
        ? `✅ OpenCode 执行完成\n\n${output}`
        : `❌ OpenCode 执行失败（exit ${code}）\n\n${output}`
      );
    });

    proc.on("error", (err) => {
      resolve(`❌ OpenCode 启动失败：${err.message}`);
    });
  });
}

// ── background opencode 会话管理 ─────────────────────────────────────────
//
// launchOpenCodeBackground：立即返回 sessionId，后台跑 opencode
// waitOpenCodeResult：等待 session 完成，返回输出
// buildAndyVerificationPrompt：Step 5.5 Andy 验收 prompt

interface OpencodeSession {
  pid: number | undefined;
  logFile: string;
  completed: boolean;
  exitCode: number | null;
}

const opencodeSessions = new Map<string, OpencodeSession>();

// spec integration_points 文件列表：sessionId → string[]
// launchOpenCodeBackground 写入，proc.on("close") 读取后做实际变更 vs spec 交叉核对
const opencodeSpecFiles = new Map<string, string[]>();

// ── opencode session 持久化（重启后孤儿 session 感知）──────────────────────────
// 启动时写入 in-flight 记录；完成时标记 completed。
// wecom-entrance 重启后，上次的 in-flight session 仍在磁盘，Andy 会在下次 HEARTBEAT 发现并处理。
const OPENCODE_SESSIONS_FILE = join(PROJECT_ROOT, "data/learning/opencode-sessions.json");
function persistOpencodeSession(sessionId: string, record: Record<string, unknown>): void {
  try {
    const existing: Record<string, Record<string, unknown>> = existsSync(OPENCODE_SESSIONS_FILE)
      ? JSON.parse(readFileSync(OPENCODE_SESSIONS_FILE, "utf8"))
      : {};
    existing[sessionId] = record;
    // 只保留最近 30 条，防止文件无限增长
    const keys = Object.keys(existing).sort();
    if (keys.length > 30) keys.slice(0, keys.length - 30).forEach(k => delete existing[k]);
    writeFileSync(OPENCODE_SESSIONS_FILE, JSON.stringify(existing, null, 2), "utf8");
  } catch { /* 持久化失败不阻塞主流程 */ }
}

// Andy→Lisa 修订轮次（独立计数，与 Lisa→Andy 的 report_implementation_issue 分开）
const revisionRoundsMap = new Map<string, number>();
const REVISION_MAX_ROUNDS = 3;

async function launchOpenCodeBackground(
  task: string,
  projectRoot: string,
  modelOverride?: string,
): Promise<string> {
  const model = modelOverride ?? resolveAgentModel("lisa");
  const sessionId = `oc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // 从 task（Andy 的 spec 内容）中提取 wecomUserId 和 requirementId，供 proc.on("close") 通知 Lucas
  // Andy spec JSON 中含 user_id 字段，trigger_lisa_implementation 传入时保留在 task 内
  const _taskRequesterUserId = (() => {
    const m = task.match(/"user_id"\s*:\s*"([^"]+)"/);
    return m?.[1] ?? "unknown";
  })();
  const _taskRequirementId = (() => {
    const m = task.match(/requirement_id["\s:]+([a-z0-9_]+)/i) ?? task.match(/req_\d+/);
    return m?.[1] ?? m?.[0] ?? "";
  })();
  const logFile = `/tmp/opencode-${sessionId}.log`;

  appendFileSync("/tmp/opencode-debug.log",
    `[${nowCST()}] launchOpenCodeBackground: model=${model} sessionId=${sessionId}\n`);

  const { createWriteStream } = await import("fs");
  const logStream = createWriteStream(logFile, { flags: "a" });

  const proc = spawn(OPENCODE_BIN, ["run", "--model", model, task], {
    cwd: projectRoot,
    env: { ...process.env },
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  proc.stdout?.pipe(logStream);
  proc.stderr?.pipe(logStream);

  const session: OpencodeSession = { pid: proc.pid, logFile, completed: false, exitCode: null };
  opencodeSessions.set(sessionId, session);

  // ── 解析 spec 中的 integration_points 文件列表（供 close 时交叉核对用）──
  try {
    const jsonMatch = task.match(/```json\s*([\s\S]*?)```/);
    if (jsonMatch) {
      const specData = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
      const ipFiles = ((specData.integration_points ?? []) as Array<{ file?: string }>)
        .map(ip => ip.file)
        .filter((f): f is string => typeof f === "string" && f.length > 0);
      if (ipFiles.length > 0) opencodeSpecFiles.set(sessionId, ipFiles);
    }
  } catch { /* spec 格式不规范，跳过 */ }
  // 持久化启动记录（重启后可检测孤儿 session）
  persistOpencodeSession(sessionId, {
    pid: proc.pid,
    logFile,
    startedAt: nowCST(),
    taskSummary: task.split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 150),
    completed: false,
  });

  // ── 监控通知：opencode 启动 ─────────────────────────────────────────────
  const opencodeTaskDesc = task.split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 120);
  void notifyEngineer(`【opencode启动】[${sessionId}]\n${opencodeTaskDesc}`, "pipeline", "lisa");
  // Lucas 知情：Lisa 已开始编写代码（用户可能在等待，Lucas 决定是否主动告知进展）
  if (_taskRequesterUserId && _taskRequesterUserId !== "unknown") {
    void callGatewayAgent(
      "lucas",
      [
        `【Lisa 开始编写代码 · ${_taskRequirementId || sessionId}】`,
        `opencode 已启动，Lisa 正在实现代码，这个过程可能需要几分钟到十几分钟，完成后 Andy 会验收。`,
        ``,
        `用户 ID：${_taskRequesterUserId}`,
        `如果用户在问进展，可以告知"正在实现中，稍等"；如果用户没有追问则不必主动打扰。`,
      ].join("\n"),
      20_000,
    );
  }

  proc.on("close", (code) => {
    session.completed = true;
    session.exitCode = code;
    logStream.end();
    // 持久化完成状态
    persistOpencodeSession(sessionId, {
      pid: proc.pid,
      logFile,
      startedAt: nowCST(),
      completedAt: nowCST(),
      taskSummary: task.split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 150),
      completed: true,
      exitCode: code,
    });

    // ── 基础设施层主动通知（不依赖 Lisa 手动调 get_opencode_result 汇报）──────
    // opencode 可能超过 waitOpenCodeResult 超时时间，结果进入黑洞。
    // 无论 Lisa 是否已轮询到结果，close 事件都会触发此通知，确保 Andy 知道结果。
    const outputSnippet = (() => {
      try { return readFileSync(session.logFile, "utf8").trim().slice(-800); } catch { return ""; }
    })();
    // 持久化结果（供审计/调试，不依赖内存）
    try {
      appendJsonl(join(PROJECT_ROOT, "data/learning/opencode-results.jsonl"), {
        sessionId,
        timestamp: nowCST(),
        exitCode: code,
        success: code === 0,
        taskSummary: task.split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 150),
        outputSnippet: outputSnippet.slice(-300),
      });
    } catch { /* 持久化失败不阻塞通知 */ }

    // ── Spec vs 实际变更文件交叉核对（对抗性验证）────────────────────────────
    // 对比 spec integration_points 预期文件 vs git diff 实际变更文件，
    // 生成对照表给 Andy 验收——不信"说做了"，让代码告诉真相。
    const specFiles = opencodeSpecFiles.get(sessionId) ?? [];
    let specVerificationBlock = "";
    if (specFiles.length > 0) {
      let gitDiffFiles: string[] = [];
      try {
        const diffOut = execSync(
          "git diff --name-only HEAD",
          { cwd: projectRoot, timeout: 10_000 },
        ).toString().trim();
        gitDiffFiles = diffOut ? diffOut.split("\n").filter(Boolean) : [];
      } catch { /* git diff 失败静默 */ }

      const lines = specFiles.map(sf => {
        const hit = gitDiffFiles.some(gf => gf.includes(sf.replace(/^.*\//, "")) || sf.includes(gf.replace(/^.*\//, "")));
        return hit ? `  ✅ ${sf}` : `  ❌ ${sf}（spec 预期但未见变更）`;
      });
      const unexpected = gitDiffFiles.filter(gf =>
        !specFiles.some(sf => gf.includes(sf.replace(/^.*\//, "")) || sf.includes(gf.replace(/^.*\//, "")))
      );
      lines.push(...unexpected.map(f => `  ⚠️ ${f}（实际有变更但 spec 未提及）`));
      specVerificationBlock = `\n\n【Spec vs 实际变更对照（对抗性验证）】\n${lines.join("\n")}`;
      opencodeSpecFiles.delete(sessionId); // 清理
    }

    // ── codebase_patterns 写入（Lisa → Andy 代码库洞察，集体进化机制）─────────────
    // 每次 opencode 结束后，基础设施层提取并沉淀代码库洞察：
    //   - 实现是否成功、哪些文件实际变更
    //   - spec 预期 vs 实际变更的吻合情况（作为 Andy 设计质量的反馈信号）
    // Andy before_prompt_build 注入相关 codebase_patterns → 写 spec 时有历史参考
    void (async () => {
      try {
        const actualFiles = (() => {
          try {
            const { execSync: execSyncLocal } = require("child_process") as typeof import("child_process");
            const out = (execSyncLocal as (c: string, o: object) => Buffer)(
              "git diff --name-only HEAD", { cwd: projectRoot, timeout: 8_000 },
            ).toString().trim();
            return out ? out.split("\n").filter(Boolean) : [];
          } catch { return [] as string[]; }
        })();
        const sf = opencodeSpecFiles.get(sessionId) ?? [];
        const matched   = sf.filter(f => actualFiles.some(a => a.includes(f.replace(/^.*\//, "")) || f.includes(a.replace(/^.*\//, ""))));
        const missing   = sf.filter(f => !matched.includes(f));
        const extra     = actualFiles.filter(a => !sf.some(f => a.includes(f.replace(/^.*\//, "")) || f.includes(a.replace(/^.*\//, ""))));
        const matchRate = sf.length > 0 ? Math.round((matched.length / sf.length) * 100) : 100;

        const docLines = [
          `opencode run ${code === 0 ? "成功" : "失败"}（exit ${code}）`,
          `实际变更：${actualFiles.length > 0 ? actualFiles.slice(0, 6).join("、") : "无"}`,
        ];
        if (sf.length > 0) docLines.push(`spec 吻合率：${matchRate}%（${matched.length}/${sf.length} 命中）`);
        if (missing.length > 0) docLines.push(`spec 预期但未变更：${missing.slice(0, 3).join("、")}`);
        if (extra.length > 0)   docLines.push(`spec 未提及但实际变更：${extra.slice(0, 3).join("、")}`);
        const taskDesc = task.split("\n").filter(Boolean).slice(0, 3).join(" ").slice(0, 200);
        docLines.push(`任务：${taskDesc}`);
        const document = docLines.join("；");

        const embedding = await embedText(document);
        const obsId = `codebase-obs-${sessionId}`;
        await chromaUpsert("codebase_patterns", obsId, document, {
          timestamp:   nowCST(),
          exitCode:    code ?? -1,
          success:     code === 0,
          matchRate,
          filesChanged: actualFiles.slice(0, 8).join(","),
          specFiles:    sf.slice(0, 8).join(","),
          sessionId,
        }, embedding);
      } catch { /* 写入失败不影响主流程 */ }
    })();

    // 更新任务阶段：opencode 完成后推进到 completed（无论成败）
    // 注：requirementId 从 sessionId 逆向查找（opencode session 与 requirement 通过 task map 关联）
    try {
      const allTasks = readTaskRegistry();
      // sessionId 命名规则：opencode-{timestamp} 或类似，requirement_id 在 task 里独立记录
      // 通过 task summary 头部匹配（task 首行包含需求文本片段）
      const taskHead = task.split("\n").filter(Boolean)[0]?.slice(0, 60) ?? "";
      const matched = allTasks.find(t =>
        (t.status === "running" || t.status === "queued") &&
        t.requirement.slice(0, 60).includes(taskHead.slice(0, 40))
      );
      if (matched) {
        matched.currentPhase = "completed";
        writeFileSync(TASK_REGISTRY_FILE, JSON.stringify(allTasks, null, 2), "utf8");
      }
    } catch { /* 阶段更新失败不影响主流程 */ }

    // Andy 技术验收 → 输出 Lucas 交付简报 → 插件层告知 Lucas → Lucas 决定用户沟通方式
    // Andy 是技术验收者，不直接面向用户；Lucas 是沟通决策者，知情后自主决定何时/如何告知用户
    const taskSummary = task.split("\n").filter(Boolean).slice(0, 2).join(" ").slice(0, 150);

    // ── 监控通知：opencode 执行完成 ──────────────────────────────────────────
    void notifyEngineer(`【opencode${code === 0 ? "完成" : `失败(exit${code})`}】[${sessionId}]\n${taskSummary}`, "pipeline", "lisa");

    if (code === 0) {
      void (async () => {
        const andyVerdict = await callGatewayAgent(
          "andy",
          [
            `【系统通知】opencode 实现任务已完成（sessionId: ${sessionId}，exit 0）。`,
            `任务摘要：${taskSummary}${specVerificationBlock}`,
            ``,
            `请对照验收标准做技术验收，然后输出：`,
            `1. 验收结论（通过 / 部分通过 / 未通过 + 原因）`,
            `2. 用固定格式输出 Lucas 交付简报（家人语言）：`,
            `   Lucas交付：[做完了什么（家人能感知的变化）。注意事项：xxx（如无则省略）。下次这样说：xxx]`,
          ].join("\n"),
          120_000,
        );
        // 提取 Lucas 交付简报，由 Lucas 决定沟通时机和方式
        const briefMatch = (andyVerdict ?? "").match(/Lucas交付[：:]\s*([\s\S]+?)(?:\n\n|\n[^\s]|$)/);
        const brief = briefMatch?.[1]?.trim()
          ?? andyVerdict?.split("\n").filter(Boolean).slice(0, 2).join(" ")
          ?? "功能已实现完成。";
        // 同步写入 deliveryBrief，供【待告知家人任务】注入使用
        if (_taskRequirementId) {
          try {
            const regEntries = readTaskRegistry();
            const regEntry = regEntries.find(e => e.id === _taskRequirementId);
            if (regEntry) {
              regEntry.deliveryBrief = brief;
              writeFileSync(TASK_REGISTRY_FILE, JSON.stringify(regEntries, null, 2), "utf8");
            }
          } catch { /* 静默，不影响主流程 */ }
        }
        if (_taskRequesterUserId && _taskRequesterUserId !== "unknown") {
          // 访客无持久化渠道，改用拉取机制：写入 visitor-pipeline-results，下次会话时 Lucas 主动告知
          if (_taskRequesterUserId.startsWith("visitor:")) {
            const visitorTok = _taskRequesterUserId.slice("visitor:".length);
            writeVisitorPipelineResult({
              id: _taskRequirementId || sessionId,
              visitorToken: visitorTok,
              requirement: (task.split("\n").filter(Boolean)[0] ?? "").slice(0, 80),
              brief,
              completedAt: nowCST(),
              surfaced: false,
            });
          } else {
            void callGatewayAgent(
              "lucas",
              [
                `【Andy 验收完成 · ${_taskRequirementId || sessionId}】`,
                brief,
                ``,
                `用户 ID：${_taskRequesterUserId}`,
                `修复/功能已完成，根据你对用户当前状态的判断，选择合适的时机和方式告知。`,
              ].join("\n"),
              60_000,
            );
          }
        }
      })();
    } else {
      // 立即告知 Lucas opencode 失败，不等 Andy 5 分钟分析完再告知
      // Andy 分析完后还会再次告知 Lucas 更具体的进展（见下方 IIFE）
      if (_taskRequesterUserId && _taskRequesterUserId !== "unknown") {
        void callGatewayAgent(
          "lucas",
          [
            `【实现遇到技术问题 · ${_taskRequirementId || sessionId}】`,
            `代码实现遇到了技术问题，Andy 正在分析原因和决定下一步方向，稍后会给你进展更新。`,
            ``,
            `用户 ID：${_taskRequesterUserId}`,
            `用户可能在等待，你可以告知"实现遇到了技术阻塞，团队正在处理，稍等"；Andy 分析完后我会再告诉你具体结论。`,
          ].join("\n"),
          20_000,
        );
      }
      void (async () => {
        const andyAssessment = await callGatewayAgent(
          "andy",
          [
            `【系统通知】opencode 实现任务执行失败（sessionId: ${sessionId}，exit ${code}）。`,
            `任务摘要：${taskSummary}${specVerificationBlock}`,
            ``,
            `末尾输出（最近 500 字）：\n${outputSnippet.slice(-500)}`,
            ``,
            `请分析错误，决定：① 修正 spec → 重新调 trigger_lisa_implementation ② 若是环境问题无法自动修复`,
            `同时用固定格式输出 Lucas 知情说明（让 Lucas 管理用户预期）：`,
            `Lucas知情：[遇到了什么问题、下一步怎么处理、预计什么时候有结果]`,
          ].join("\n"),
          300_000,
        );
        // 失败时也告知 Lucas，让 Lucas 管理用户预期
        const briefMatch = (andyAssessment ?? "").match(/Lucas知情[：:]\s*([\s\S]+?)(?:\n\n|\n[^\s]|$)/);
        const brief = briefMatch?.[1]?.trim()
          ?? "实现遇到了一些技术问题，Andy 正在处理，稍后会有进展。";
        if (_taskRequesterUserId && _taskRequesterUserId !== "unknown") {
          void callGatewayAgent(
            "lucas",
            [
              `【Andy 通报进展 · ${_taskRequirementId || sessionId}】`,
              brief,
              ``,
              `用户 ID：${_taskRequesterUserId}`,
              `根据用户的等待状态决定是否主动说明情况。`,
            ].join("\n"),
            60_000,
          );
        }
      })();
    }
  });

  proc.unref();
  return sessionId;
}

async function waitOpenCodeResult(sessionId: string, timeoutMs = 600_000): Promise<string> {
  const session = opencodeSessions.get(sessionId);
  if (!session) return `❌ 未找到 opencode session: ${sessionId}`;

  const start = Date.now();
  while (!session.completed && (Date.now() - start) < timeoutMs) {
    await new Promise<void>((r) => setTimeout(r, 3000));
  }

  if (!session.completed) {
    return `❌ OpenCode 超时（${Math.round(timeoutMs / 1000)}s），sessionId: ${sessionId}`;
  }

  let output = "";
  try {
    output = readFileSync(session.logFile, "utf8").trim();
  } catch { output = "（输出文件读取失败）"; }

  return session.exitCode === 0
    ? `✅ OpenCode 执行完成\n\n${output}`
    : `❌ OpenCode 执行失败（exit ${session.exitCode}）\n\n${output}`;
}

// ── 编译验证 + 变更范围检查（Harness 客观验证门）────────────────────────────
//
// Lisa 每次 get_opencode_result 后自动运行：
//   1. git diff --name-only → 实际变更文件列表
//   2. 有 .ts 文件 → tsc --noEmit（TypeScript 编译检查）
//   3. 有 .py 文件 → py_compile（Python 语法检查）
// 结果追加到 get_opencode_result 返回值，给 Andy 验收提供客观锚点。

interface CompileCheckResult {
  changedFiles: string[];
  errors: string;
  hasErrors: boolean;
  summary: string;
}

function runProjectCompileCheck(): CompileCheckResult {
  try {
    const diffResult = spawnSync("git", ["diff", "--name-only"], {
      cwd: PROJECT_ROOT, encoding: "utf8",
    });
    const changedFiles = (diffResult.stdout ?? "").trim().split("\n").filter(Boolean);
    const errors: string[] = [];

    // TypeScript 编译检查
    const hasTs = changedFiles.some(f => f.endsWith(".ts") || f.endsWith(".tsx"));
    if (hasTs) {
      const tscResult = spawnSync("npx", ["tsc", "--noEmit", "--pretty", "false"], {
        cwd: PROJECT_ROOT, encoding: "utf8", timeout: 30_000,
      });
      const tscOut = ((tscResult.stdout || "") + (tscResult.stderr || "")).trim();
      if (tscResult.status !== 0 && tscOut) {
        errors.push(`TypeScript 编译错误：\n${tscOut.slice(0, 1500)}`);
      }
    }

    // Python 语法检查
    const pyFiles = changedFiles.filter(f => f.endsWith(".py")).slice(0, 5);
    for (const pyFile of pyFiles) {
      const pyResult = spawnSync(KUZU_PYTHON3_BIN, ["-m", "py_compile", join(PROJECT_ROOT, pyFile)], {
        encoding: "utf8", timeout: 10_000,
      });
      if (pyResult.status !== 0) {
        errors.push(`Python 语法错误（${pyFile}）：\n${(pyResult.stderr || "").slice(0, 300)}`);
      }
    }

    const hasErrors = errors.length > 0;
    const summary = hasErrors
      ? `❌ 编译检查未通过\n${errors.join("\n\n")}`
      : changedFiles.length > 0
        ? `✅ 编译检查通过（已检查 ${changedFiles.length} 个文件）`
        : `✅ 无文件变更`;

    return { changedFiles, errors: errors.join("\n\n"), hasErrors, summary };
  } catch {
    return { changedFiles: [], errors: "", hasErrors: false, summary: "（编译检查跳过）" };
  }
}

function buildAndyVerificationPrompt(spec: string, lisaReport: string): string {
  return [
    "【验收任务】Lisa 刚完成代码实现，请对照 spec 做设计意图校验。",
    `【Implementation Spec（前1500字）】\n${spec.slice(0, 1500)}`,
    `【Lisa 交付报告】\n${lisaReport.slice(0, 1000)}`,
    "请检查（不需要重新实现）：",
    "1. 文件路径是否与 spec 一致？",
    "2. 核心功能是否已实现？",
    "3. 验证结果是否通过（py_compile 等）？",
    "4. 有无明显缺失项？",
    "输出验收结论（50字以内，格式固定）：",
    "【通过】/ 【部分通过：具体说明】/ 【失败：具体说明】",
  ].join("\n\n");
}


// ── Layer 2 质量评估 → 微调队列 ────────────────────────────────────────
//
// agent_end 中对云端响应进行轻量评分（规则评分，不调用模型）。
// 评分 ≥ 0.6 → 写入 data/learning/finetune-queue.jsonl（微调原料）。
// queue ≥ 100 条时触发 finetune-scheduler.js（MLX 增量微调）。
//
// 与 quality-evaluator.js（规则+模型混合评分）保持接口兼容，
// 但在插件内使用纯规则评分避免额外子进程开销。

const FINETUNE_QUEUE_FILE    = join(PROJECT_ROOT, "data/learning/finetune-queue.jsonl");
const DPO_CANDIDATES_FILE   = join(PROJECT_ROOT, "data/learning/dpo-candidates.jsonl");
const FINETUNE_THRESHOLD     = 0.6;
const FINETUNE_QUEUE_TRIGGER = 100;

// 延迟任务队列：非紧急需求在空闲时段批量执行
const TASK_QUEUE_FILE = join(PROJECT_ROOT, "data/learning/task-queue.jsonl");
// 空闲时段：22:00 ~ 次日 8:00（可通过环境变量覆盖）
const OFF_PEAK_START  = parseInt(process.env.OFF_PEAK_START || "22", 10);
const OFF_PEAK_END    = parseInt(process.env.OFF_PEAK_END   || "8",  10);

// ── 任务注册表：Lucas 叫停/查询进行中任务 ────────────────────────────────────
const TASK_REGISTRY_FILE = join(PROJECT_ROOT, "data/learning/task-registry.json");

interface TaskRegistryEntry {
  id: string;
  requirement: string;
  submittedBy: string;
  submittedAt: string;
  status: "queued" | "running" | "cancelled" | "completed";
  cancelledAt?: string;
  completedAt?: string;
  lucasContext?: string;  // Lucas 补充的需求背景（情绪/时间敏感度/可接受替代方案）
  currentPhase?: string;  // 流水线当前阶段：andy_designing | lisa_implementing | completed
  designNote?: string;    // Andy 的设计简报（非技术语言，Lucas 可直接告知家人）
  deliveryBrief?: string; // Andy 验收完成时的交付简报（家人语言，供 Lucas 告知家人用）
  lucasAcked?: boolean;   // Lucas 是否已主动告知家人完成情况（false=待告知，true=已告知）
  visitorCode?: string;   // 访客邀请码（访客触发任务时写入，用于前端过滤）
}

function readTaskRegistry(): TaskRegistryEntry[] {
  try {
    const all = JSON.parse(readFileSync(TASK_REGISTRY_FILE, "utf8")) as TaskRegistryEntry[];
    const cutoff = Date.now() - 48 * 60 * 60 * 1000; // 48h 自动清理
    return all.filter(e => new Date(e.submittedAt).getTime() > cutoff);
  } catch {
    return [];
  }
}

// ── 扩展成员（访客）Pipeline 结果反哺 ─────────────────────────────────────
// task-registry 有 48h TTL，跨天访客无法追踪结果。用独立文件持久化 30 天，
// 下次访客打开 demo-chat 时 Lucas 主动告知进展（拉取机制，无需推送渠道）。
const VISITOR_PIPELINE_RESULTS_FILE = join(PROJECT_ROOT, "data/visitor-pipeline-results.json");

interface VisitorPipelineResult {
  id: string;           // requirement ID
  visitorToken: string; // token（不含 "visitor:" 前缀）
  requirement: string;  // 需求摘要（前 80 字）
  brief: string;        // Andy 输出的 Lucas交付 简报
  completedAt: string;
  surfaced: boolean;    // Lucas 是否已在会话中告知访客
  surfacedAt?: string;
}

function readVisitorPipelineResults(): VisitorPipelineResult[] {
  try {
    const all = JSON.parse(readFileSync(VISITOR_PIPELINE_RESULTS_FILE, "utf8")) as VisitorPipelineResult[];
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 天 TTL
    return all.filter(r => new Date(r.completedAt).getTime() > cutoff);
  } catch { return []; }
}

function writeVisitorPipelineResult(result: VisitorPipelineResult): void {
  const all = readVisitorPipelineResults();
  const idx = all.findIndex(r => r.id === result.id);
  if (idx >= 0) all[idx] = result; else all.push(result);
  try { writeFileSync(VISITOR_PIPELINE_RESULTS_FILE, JSON.stringify(all, null, 2), "utf8"); } catch { /* 静默 */ }
}

function markVisitorResultsSurfaced(visitorToken: string): void {
  const all = readVisitorPipelineResults();
  let changed = false;
  const surfacedIds: string[] = [];
  for (const r of all) {
    if (r.visitorToken.toUpperCase() === visitorToken.toUpperCase() && !r.surfaced) {
      r.surfaced = true;
      r.surfacedAt = nowCST();
      changed = true;
      surfacedIds.push(r.id);
    }
  }
  if (changed) {
    try { writeFileSync(VISITOR_PIPELINE_RESULTS_FILE, JSON.stringify(all, null, 2), "utf8"); } catch { /* 静默 */ }
    // 同步标记 task-registry 中对应任务的 lucasAcked=true（两套机制合流）
    if (surfacedIds.length > 0) {
      try {
        const entries = readTaskRegistry();
        let regChanged = false;
        for (const entry of entries) {
          if (surfacedIds.includes(entry.id) && entry.lucasAcked === false) {
            entry.lucasAcked = true;
            regChanged = true;
          }
        }
        if (regChanged) writeFileSync(TASK_REGISTRY_FILE, JSON.stringify(entries, null, 2), "utf8");
      } catch { /* 静默，不影响访客会话主流程 */ }
    }
  }
}

function upsertTaskRegistry(entry: TaskRegistryEntry): void {
  const entries = readTaskRegistry();
  const idx = entries.findIndex(e => e.id === entry.id);
  if (idx >= 0) entries[idx] = entry; else entries.push(entry);
  writeFileSync(TASK_REGISTRY_FILE, JSON.stringify(entries, null, 2), "utf8");
}

function markTaskStatus(taskId: string, status: TaskRegistryEntry["status"]): void {
  const entries = readTaskRegistry();
  const entry = entries.find(e => e.id === taskId);
  if (!entry) return;
  entry.status = status;
  if (status === "cancelled") entry.cancelledAt = nowCST();
  if (status === "completed") {
    entry.completedAt = nowCST();
    entry.lucasAcked = false; // 待 Lucas 主动告知家人
  }
  writeFileSync(TASK_REGISTRY_FILE, JSON.stringify(entries, null, 2), "utf8");
}

function isTaskCancelled(taskId: string): boolean {
  return readTaskRegistry().some(e => e.id === taskId && e.status === "cancelled");
}

// Lucas 人格检查：禁止在 Lucas 回复中出现 Andy/Lisa 内部技术词汇
// ── 实例配置：从 config/dpo-patterns.json 加载（框架层与实例层分离）────────
// 要调整 Lucas 禁用词或 DPO 检测关键词，只需修改 JSON，不改 TypeScript。
interface DpoPatternsJson {
  lucas_forbidden_terms: string[];
  pretend_doing: string[];
  false_commitment: string[];
  notification_commitment?: string[];
  report_bug_commitment?: string[];
  capability_hallucination: string[];
  user_correction_signals: string[];
}

function loadDpoPatterns(): DpoPatternsJson {
  const cfgPath = join(PROJECT_ROOT, "CrewHiveClaw/CrewClaw/crewclaw-routing/config/dpo-patterns.json");
  try {
    return JSON.parse(readFileSync(cfgPath, "utf8")) as DpoPatternsJson;
  } catch {
    return { lucas_forbidden_terms: [], pretend_doing: [], false_commitment: [], capability_hallucination: [], user_correction_signals: [] };
  }
}

const _dpoPatterns = loadDpoPatterns();
const LUCAS_FORBIDDEN_TERMS     = _dpoPatterns.lucas_forbidden_terms;
const DPO_REPORT_BUG_PATTERNS   = _dpoPatterns.report_bug_commitment ?? [];

// ── DPO 负例候选检测（Lucas 专属）────────────────────────────────────────
//
// 三种可疑模式：
//   pretend_doing       - 说"正在/已联系/已发送"但没调工具
//   false_commitment    - 说"已交给Andy/已提交/已触发"但没调 trigger_development_pipeline
//   capability_hallucination - 声称有某项能力但没有对应工具支撑且没调工具
//
// 命中 → 写入 dpo-candidates.jsonl 供系统工程师审核确认，不自动入训练集。
// 模式从 config/dpo-patterns.json 加载，实例层可按需调整关键词。

const DPO_PRETEND_PATTERNS    = _dpoPatterns.pretend_doing;
const DPO_COMMIT_PATTERNS     = _dpoPatterns.false_commitment;
const DPO_NOTIFY_PATTERNS     = _dpoPatterns.notification_commitment ?? [];
const DPO_HALLUCIN_PATTERNS   = _dpoPatterns.capability_hallucination;
const USER_CORRECTION_SIGNALS = _dpoPatterns.user_correction_signals;

function detectDpoCandidates(params: {
  prompt: string;
  response: string;
  sendMessageContents: string[];      // send_message 工具调用的实际发送内容
  pipelineResults: string[];          // trigger_development_pipeline 的工具返回内容
  toolUseCounts: Record<string, number>;
  sessionKey: string | undefined;
  userId: string;
}): boolean {
  const { prompt, response, sendMessageContents, pipelineResults, toolUseCounts, sessionKey, userId } = params;
  const totalTools = Object.values(toolUseCounts).reduce((s, n) => s + n, 0);
  const calledTrigger = (toolUseCounts["trigger_development_pipeline"] ?? 0) > 0;
  const calledSend    = (toolUseCounts["send_message"] ?? 0) > 0;

  // 合并检测文本：lastAssistant + 所有 send_message 发出的内容
  const allOutputText = [response, ...sendMessageContents].join("\n");

  const reasons: string[] = [];

  // 模式 1：假装在做（说"正在/已"但没调对应工具）
  const pretendHit = DPO_PRETEND_PATTERNS.find(p => allOutputText.includes(p));
  if (pretendHit && !calledSend && totalTools === 0) {
    reasons.push(`pretend_doing: "${pretendHit}"`);
  }

  // 模式 2：假承诺流水线（说交给Andy但没调工具）
  const commitHit = DPO_COMMIT_PATTERNS.find(p => allOutputText.includes(p));
  if (commitHit && !calledTrigger) {
    reasons.push(`false_commitment: "${commitHit}"`);
  }

  // 模式 4：工具返回警告但声称提交成功
  // trigger_development_pipeline 返回 ⚠️（相似能力/已排队）但 Lucas 对用户报告「已提交」
  if (calledTrigger && pipelineResults.some(r => r.startsWith("⚠️"))) {
    const successCommitHit = DPO_COMMIT_PATTERNS.find(p => allOutputText.includes(p));
    if (successCommitHit) {
      reasons.push(`false_commitment_warning: "${successCommitHit}"`);
    }
  }

  // 模式 3：能力幻觉（声称有能力但没有工具支撑）
  const hallucinHit = DPO_HALLUCIN_PATTERNS.find(p => allOutputText.includes(p));
  if (hallucinHit && !calledSend) {
    reasons.push(`capability_hallucination: "${hallucinHit}"`);
  }

  // 模式 5：Bug 承诺幻觉（声称提交了 Bug 但没调 report_bug）
  const calledReportBug = (toolUseCounts["report_bug"] ?? 0) > 0;
  const bugCommitHit = DPO_REPORT_BUG_PATTERNS.find(p => allOutputText.includes(p));
  if (bugCommitHit && !calledReportBug) {
    reasons.push(`bug_commitment: "${bugCommitHit}"`);
  }

  // 模式 6：通知承诺幻觉（声称已通知家人但没调 send_message）
  const notifyHit = DPO_NOTIFY_PATTERNS.find(p => allOutputText.includes(p));
  if (notifyHit && !calledSend) {
    reasons.push(`notification_commitment: "${notifyHit}"`);
  }

  if (reasons.length === 0) return false;

  // 24h 去重：同一 userId + 同一 pattern 在 24h 内只记录一次，防止自动调度重复触发
  const dedupKey = `${userId}|${reasons[0]}`;
  const cutoff24h = Date.now() - 24 * 3_600_000;
  const existingDpo = readJsonlEntries(DPO_CANDIDATES_FILE);
  const recentDup = existingDpo.some((e: Record<string, unknown>) => {
    const entryKey = `${e.userId}|${Array.isArray(e.reasons) ? e.reasons[0] : ""}`;
    return entryKey === dedupKey && typeof e.t === "string" && new Date(e.t).getTime() > cutoff24h;
  });
  if (recentDup) return false;

  const nowIso = nowCST();
  appendJsonl(DPO_CANDIDATES_FILE, {
    t: nowIso,
    sessionKey,
    userId,
    reasons,
    prompt: prompt.slice(0, 300),
    bad_response: allOutputText.slice(0, 500),
    toolsCalled: toolUseCounts,
    // good_response 留空，由系统工程师人工填写后才进训练集
    good_response: "",
    confirmed: false,
  });

  // 即时追加到 Main HEARTBEAT.md，让监控循环下次汇总时感知到
  try {
    const heartbeatPath = join(process.env["HOME"] ?? "", ".openclaw/workspace-main/HEARTBEAT.md");
    const hb = readFileSync(heartbeatPath, "utf8");
    const nowLocal = new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
    const line = `- [${nowLocal}] 承诺幻觉检测：${reasons.join("；")} | 用户: ${userId} | 预览: ${allOutputText.slice(0, 60)}`;
    const updated = hb.replace(/(## 待汇总观察[^\n]*\n)/, `$1${line}\n`);
    writeFileSync(heartbeatPath, updated, "utf8");
  } catch (_) {
    // HEARTBEAT.md 写入失败不阻塞主流程
  }
  return true;
}

// ── 用户纠正信号检测（Lucas 专属）────────────────────────────────────────────
//
// 当用户当前消息含纠正关键词时，说明上一条 Lucas 回复存在幻觉/错误。
// 将「上一条 Lucas 回复（bad）+ 用户纠正（correction_signal）」写入
// dpo-candidates.jsonl，good_response 留空由系统工程师审核后填入。
// 这是"被找出来的幻觉"转为 DPO 材料的核心通道。
function detectUserCorrection(params: {
  currentUserMsg: string;
  messages: Array<{ role?: string; content?: unknown }>;
  sessionKey: string | undefined;
  userId: string;
}): void {
  const { currentUserMsg, messages, sessionKey, userId } = params;

  const correctionHit = USER_CORRECTION_SIGNALS.find(s => currentUserMsg.includes(s));
  if (!correctionHit) return;

  // 找用户纠正之前的最后一条 Lucas (assistant) 回复
  function _extractText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return (content as Array<{ type?: string; text?: string }>)
        .filter(b => b?.type === "text")
        .map(b => b.text ?? "")
        .join("");
    }
    return "";
  }

  let prevAssistant = "";
  // 倒序遍历，跳过最后一条（当前轮次 Lucas 的回复），找再上一条
  let assistantCount = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      assistantCount++;
      if (assistantCount === 2) {        // 第2条 assistant = 用户纠正前的那条
        prevAssistant = _extractText(messages[i].content);
        break;
      }
    }
  }
  // 如果 messages 里只有1条 assistant（当前轮），也尝试用它作为被纠正对象
  if (!prevAssistant && assistantCount === 1) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant") {
        prevAssistant = _extractText(messages[i].content);
        break;
      }
    }
  }
  if (!prevAssistant) return;

  appendJsonl(DPO_CANDIDATES_FILE, {
    t:                nowCST(),
    sessionKey,
    userId,
    type:             "user_correction",
    reasons:          [`user_correction: "${correctionHit}"`],
    prompt:           currentUserMsg.slice(0, 300),
    bad_response:     prevAssistant.slice(0, 600),
    correction_signal: currentUserMsg.slice(0, 300),
    good_response:    "",   // 系统工程师人工填写后才进训练集
    confirmed:        false,
  });
}

function evaluateResponseQuality(params: {
  agentId: string;
  prompt: string;
  response: string;
  isCloud: boolean;
}): number {
  if (!params.isCloud) return 0; // 只评估云端响应（用于微调本地模型）

  const r = params.response;
  if (!r || r.length < 10) return 0;

  let score = 0;

  // 基础长度分：10~30 字 0.5，30~300 字 0.7，300~600 字 0.6，>600 字 0.4
  const len = r.length;
  const lengthScore = len < 10 ? 0 : len < 30 ? 0.5 : len < 300 ? 0.7 : len < 600 ? 0.6 : 0.4;
  score += lengthScore * 0.6;

  // 完整性：不以省略号或"等"结尾（非截断）
  const complete = !r.endsWith("…") && !r.endsWith("等") && !r.endsWith("...");
  score += complete ? 0.2 : 0;

  // 相关性：响应与 prompt 有词汇重叠（bigram 相似度 > 0）
  const relevant = bigramScore(params.prompt.slice(0, 100), r.slice(0, 100)) > 0;
  score += relevant ? 0.2 : 0;

  // Lucas 人格惩罚
  if (params.agentId === FRONTEND_AGENT_ID) {
    const violations = LUCAS_FORBIDDEN_TERMS.filter(t => r.includes(t)).length;
    score = Math.max(0, score - violations * 0.1);
  }

  return Math.min(1, score);
}

function enqueueForFinetune(params: {
  agentId: string;
  prompt: string;
  response: string;
  score: number;
}): void {
  appendJsonl(FINETUNE_QUEUE_FILE, {
    timestamp: nowCST(),
    agentId: params.agentId,
    prompt: params.prompt.slice(0, 800),
    response: params.response.slice(0, 800),
    qualityScore: params.score,
  });

  // queue ≥ 100 条时触发 MLX 增量微调（异步，不阻塞）
  const queueSize = readJsonlEntries(FINETUNE_QUEUE_FILE).length;
  if (queueSize >= FINETUNE_QUEUE_TRIGGER) {
    const schedulerPath = join(PROJECT_ROOT, "scripts/finetune-scheduler.js");
    if (existsSync(schedulerPath)) {
      spawn("node", [schedulerPath], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
      }).unref();
    }
  }
}

// ── Axis 1：capability-events → ChromaDB capabilities 集合同步 ─────────
//
// agent_end 写完 capability-events.jsonl 后调用，同步单条事件到 ChromaDB。
// capabilities 集合供三维诊断框架语义查询（"这个工具历史上用了多少次、成功率多少"）。

async function syncCapabilityToChroma(params: {
  agentId: string;
  toolName: string;
  callCount: number;
  success: boolean;
}): Promise<void> {
  try {
    const id = `cap-${params.agentId}-${params.toolName}-${Date.now()}`;
    const document = `${params.agentId} 使用工具 ${params.toolName}（调用 ${params.callCount} 次，${params.success ? "成功" : "失败"}）`;
    const embedding = await embedText(document);
    await chromaAdd("capabilities", id, document, {
      agentId: params.agentId,
      toolName: params.toolName,
      callCount: params.callCount,
      success: params.success,
      timestamp: nowCST(),
    }, embedding);
  } catch {
    // 写入失败静默处理
  }
}

// ── 已有能力查询（Andy/Lisa before_prompt_build，避免重复开发已实现能力）────
async function queryCapabilities(prompt: string, agentId: string): Promise<string> {
  try {
    const embedding = await embedText(prompt);
    const raw = await chromaQuery("capabilities", embedding, 6, { agentId: { "$eq": agentId } });
    const results = timeWeightedRerank(raw, 3);
    if (results.length === 0) return "";
    const lines = results.map(r => `- ${r.document.slice(0, 120)}`);
    return `【已有能力参考】\n${lines.join("\n")}`;
  } catch {
    return "";
  }
}

// ── Web 应用能力查询（Lucas before_prompt_build）────────────────────
//
// 读取 data/corpus/app-capabilities.jsonl，按关键词匹配用户消息。
// 命中时注入可用工具列表 + 精准子入口 URL，让 Lucas 直接发对应链接。
//
// 格式：
//   { id, name, desc, keywords[], full_url, sub_urls[{mode,desc,url}], owner }
//
// 匹配规则：prompt 含任意 keyword → 命中（不用向量检索，条目少，精确优先）

const APP_CAPABILITIES_PATH = join(PROJECT_ROOT, "data/corpus/app-capabilities.jsonl");

interface AppCapability {
  id: string;
  name: string;
  desc: string;
  keywords: string[];
  full_url: string;
  sub_urls: Array<{ mode: string; desc: string; url: string }>;
  owner?: string;
  created_at?: string;
}

function loadAppCapabilities(): AppCapability[] {
  try {
    const raw = readFileSync(APP_CAPABILITIES_PATH, "utf8");
    return raw.trim().split("\n").filter(Boolean).map(l => JSON.parse(l));
  } catch {
    return [];
  }
}

function queryAppCapabilities(prompt: string): string {
  try {
    const caps = loadAppCapabilities();
    const lower = prompt.toLowerCase();
    const matched = caps.filter(c =>
      c.keywords.some(kw => lower.includes(kw.toLowerCase()))
    );
    if (matched.length === 0) return "";
    const lines = matched.map(c => {
      const subLines = c.sub_urls.map(s => `    - ${s.desc}：${s.url}`).join("\n");
      return `- **${c.name}**：${c.desc}\n  完整工具：${c.full_url}\n  精准入口（根据家人所在步骤选择）：\n${subLines}`;
    });
    return `【可调用工具】\n${lines.join("\n\n")}`;
  } catch {
    return "";
  }
}

// ── 三维诊断框架（Data / Knowledge / Capability）─────────────────────
//
// 每 50 次请求或 24h 自动触发一次，从三个维度检测系统健康。
//
//   Data 层：检查各语料文件过去 24h 是否有新增，发现盲点记录到 diagnostic-results.jsonl
//   Knowledge 层：读 skill-review-signals.jsonl，有 pending 信号 → 投递 Andy 更新 Skill
//   Capability 层：读各 Agent capability-events，成功率 < 60%（7天滑窗）→ 投递 Andy 设计替代

const DIAGNOSTIC_RESULTS_FILE = join(PROJECT_ROOT, "data/learning/diagnostic-results.jsonl");
const DIAGNOSTIC_MIN_REQUESTS = 50;   // 累计请求数触发阈值
const DIAGNOSTIC_INTERVAL_MS  = 24 * 60 * 60 * 1000;  // 24h 时间触发阈值
let diagnosticRequestCounter  = 0;
let lastDiagnosticAt          = 0;

async function runDiagnostic(): Promise<void> {
  lastDiagnosticAt = Date.now();
  diagnosticRequestCounter = 0;

  // ── Data 层：过去 24h 各语料文件覆盖率审计 ───────────────────────────
  const dataFiles = [
    { name: "route-events",  path: join(PROJECT_ROOT, "data/learning/route-events.jsonl") },
    { name: "lucas-corpus",  path: join(PROJECT_ROOT, "data/corpus/lucas-corpus.jsonl") },
    { name: "andy-corpus",   path: join(PROJECT_ROOT, "data/corpus/andy-corpus.jsonl") },
    { name: "lisa-corpus",   path: join(PROJECT_ROOT, "data/corpus/lisa-corpus.jsonl") },
    { name: "requirements",  path: join(PROJECT_ROOT, "data/corpus/capability-registry.jsonl") },
  ];
  const dataIssues: string[] = [];
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;

  for (const f of dataFiles) {
    const entries = readJsonlEntries(f.path);
    const recent = entries.filter(e => typeof e.timestamp === "string"
      && new Date(e.timestamp as string).getTime() > cutoff24h);
    if (recent.length === 0) dataIssues.push(`${f.name}: 过去24h无新增`);
  }

  if (dataIssues.length > 0) {
    appendJsonl(DIAGNOSTIC_RESULTS_FILE, {
      timestamp: nowCST(),
      layer: "Data",
      issues: dataIssues,
    });
  }

  // ── Capability 层：成功率 < 60% 检测（7天滑窗）───────────────────────
  const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const cfg of AGENT_EVOLUTION_CONFIGS) {
    const events = readJsonlEntries(cfg.capabilityEventsFile);
    const recent7d = events.filter(e => typeof e.timestamp === "string"
      && new Date(e.timestamp as string).getTime() > cutoff7d);
    if (recent7d.length < 5) continue; // 数据不足，跳过

    const successCount = recent7d.filter(e => e.success === true).length;
    const successRate  = successCount / recent7d.length;

    if (successRate < 0.6) {
      // 统计高频失败工具
      const failedTools = [
        ...new Set(
          recent7d
            .filter(e => e.success === false)
            .flatMap(e => Object.keys((e.toolCalls as Record<string, number>) ?? {})),
        ),
      ];
      appendJsonl(DIAGNOSTIC_RESULTS_FILE, {
        timestamp: nowCST(),
        layer: "Capability",
        agentId: cfg.agentId,
        successRate,
        failedTools,
        note: `过去7天工具成功率 ${(successRate * 100).toFixed(0)}%，低于阈值60%`,
      });
      // 投递 Andy 分析改进方案（异步，不阻塞诊断）
      void callGatewayAgent(
        "andy",
        `【三维诊断告警·Capability 层】${cfg.agentId} 过去7天工具成功率 ${(successRate * 100).toFixed(0)}%（低于阈值60%）。高频失败工具：${failedTools.join("、")}。请分析根因，设计替代方案或改进策略，输出 Implementation Spec。`,
        120_000,
      ).catch(() => {});
    }
  }

  // ── Knowledge 层：skill-review-signals 待处理信号 ─────────────────────
  const signalsPath = join(PROJECT_ROOT, "data/skill-review-signals.jsonl");
  const signals = readJsonlEntries(signalsPath);
  const pendingSignals = signals
    .filter(e => e.status === "pending")
    .sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  if (pendingSignals.length > 0) {
    const oldest = pendingSignals[0];
    // 投递 Andy 处理最旧的 pending 信号（每次只处理一条，避免并发过载）
    void callGatewayAgent(
      "andy",
      `【三维诊断告警·Knowledge 层】Skill 审查信号：领域「${oldest.topic as string}」（${oldest.note as string}）。请检查并更新对应 Skill 文件（输出更新后的 Skill markdown 内容）。`,
      120_000,
    ).catch(() => {});

    // 将该信号标记为 processing，防止重复触发
    const updated = signals.map(e =>
      e === oldest ? { ...e, status: "processing", processing_at: nowCST() } : e,
    );
    writeJsonlEntries(signalsPath, updated);
  }
}

// ── 人工干预：连续失败告警 + ChromaDB 容量管理 ───────────────────────────
//
// 连续失败计数持久化：data/learning/failure-streak.json
// Lucas 连续失败 ≥ 3 次或检测到资金安全关键词时，推送 Channel 告警给业主。

const FAILURE_STREAK_FILE   = join(PROJECT_ROOT, "data/learning/failure-streak.json");
const FAILURE_STREAK_LIMIT  = 3;  // 连续失败次数触发告警
const FINANCIAL_SAFETY_TERMS = ["转账", "支付", "充值", "购买", "付款", "银行卡", "密码", "验证码"];

interface FailureStreak {
  agentId: string;
  count: number;
  lastFailAt: string;
  alerted: boolean;
}

function loadFailureStreak(agentId: string): FailureStreak {
  try {
    const data = JSON.parse(readFileSync(FAILURE_STREAK_FILE, "utf8")) as Record<string, FailureStreak>;
    return data[agentId] ?? { agentId, count: 0, lastFailAt: "", alerted: false };
  } catch {
    return { agentId, count: 0, lastFailAt: "", alerted: false };
  }
}

function saveFailureStreak(streak: FailureStreak): void {
  try {
    let data: Record<string, FailureStreak> = {};
    try { data = JSON.parse(readFileSync(FAILURE_STREAK_FILE, "utf8")) as typeof data; } catch { /* 首次创建 */ }
    data[streak.agentId] = streak;
    mkdirSync(dirname(FAILURE_STREAK_FILE), { recursive: true });
    writeFileSync(FAILURE_STREAK_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch { /* 写入失败静默处理 */ }
}

async function checkAndAlertFailure(params: {
  agentId: string;
  success: boolean;
  response: string;
  channelPushUrl: string;
}): Promise<void> {
  const streak = loadFailureStreak(params.agentId);

  if (params.success) {
    // 成功后重置计数
    if (streak.count > 0) {
      streak.count = 0;
      streak.alerted = false;
      saveFailureStreak(streak);
    }
    return;
  }

  // 失败：递增计数
  streak.count++;
  streak.lastFailAt = nowCST();

  // 检测资金安全关键词（响应中含危险关键词立即告警）
  const hasFinancialRisk = FINANCIAL_SAFETY_TERMS.some(t => params.response.includes(t));
  const shouldAlert = (streak.count >= FAILURE_STREAK_LIMIT || hasFinancialRisk) && !streak.alerted;

  if (shouldAlert) {
    streak.alerted = true;
    const reason = hasFinancialRisk
      ? `检测到资金安全关键词（${FINANCIAL_SAFETY_TERMS.filter(t => params.response.includes(t)).join("、")}）`
      : `连续 ${streak.count} 次失败`;
    // 推送 Channel 告警（给业主）
    try {
      await fetch(params.channelPushUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          response: `⚠️ 系统告警：${params.agentId} ${reason}，请检查系统状态。`,
          replyTo: { fromUser: process.env.WECOM_OWNER_ID ?? "ZengXiaoLong", isGroup: false },
          success: false,
          alert: true,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch { /* 告警推送失败静默处理 */ }
  }

  saveFailureStreak(streak);
}

// ChromaDB 容量管理：单集合超过阈值时归档低频旧记录
const CHROMA_MAX_COLLECTION_SIZE = 100_000;
const CHROMA_CAPACITY_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
let lastCapacityCheckAt = 0;

async function checkChromaCapacity(): Promise<void> {
  if (Date.now() - lastCapacityCheckAt < CHROMA_CAPACITY_CHECK_INTERVAL) return;
  lastCapacityCheckAt = Date.now();

  const collections = ["conversations", "decisions", "requirements", "agent_interactions",
    "code_history", "capabilities", "behavior_patterns", "family_knowledge", "agents"];

  for (const name of collections) {
    try {
      const colId = await getChromaCollectionId(name);
      const resp = await fetch(`${CHROMA_BASE}/${colId}/count`);
      if (!resp.ok) continue;
      const data = await resp.json() as number | { count?: number };
      const count = typeof data === "number" ? data : (data as { count?: number }).count ?? 0;
      if (count > CHROMA_MAX_COLLECTION_SIZE) {
        // 超限：记录告警到 diagnostic-results（实际归档逻辑留给系统工程师处理）
        appendJsonl(DIAGNOSTIC_RESULTS_FILE, {
          timestamp: nowCST(),
          layer: "Data",
          issues: [`ChromaDB 集合 "${name}" 记录数 ${count} 超过阈值 ${CHROMA_MAX_COLLECTION_SIZE}`],
        });
      }
    } catch { /* 单集合检查失败不影响其余 */ }
  }
}

// ── Skill 目录初始化（Andy/Lisa 实例层）─────────────────────────────────
//
// 启动时检查 Andy/Lisa 实例层 skills 目录是否存在，不存在则从框架层同步。
// Skill 格式：skill-name/SKILL.md 子目录（OpenClaw 原生格式）。
// 仅复制，不覆盖——已有实例层 Skill 目录时保留。

function initAgentSkillsDir(agentId: string): void {
  const home = process.env.HOME ?? "/";
  const templateDir = join(PROJECT_ROOT, `crewclaw/daemons/workspace-templates/${agentId}/skills`);
  const instanceDir = join(home, `.openclaw/workspace-${agentId}/skills`);

  try {
    mkdirSync(instanceDir, { recursive: true });
    // 读取框架层 skill 子目录（每个子目录含 SKILL.md）
    const entries = readdirSync(templateDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const srcSkillMd = join(templateDir, entry.name, "SKILL.md");
      const destDir = join(instanceDir, entry.name);
      const destSkillMd = join(destDir, "SKILL.md");
      if (!existsSync(srcSkillMd)) continue;
      if (!existsSync(destSkillMd)) {
        mkdirSync(destDir, { recursive: true });
        copyFileSync(srcSkillMd, destSkillMd);
      }
    }
  } catch { /* 目录不存在或无权限，静默跳过 */ }
}

// ── 子 Agent 生命周期：记忆归档 + corpus FIFO ─────────────────────────────
//
// 子 Agent evict() / markDormant() 时调用，将语料归档到 data/archives/。
// archiveAgentMemory 是轻量归档：复制 corpus JSONL + 写摘要，不做语义压缩。

async function archiveAgentMemory(agentId: string, reason: "evicted" | "dormant"): Promise<void> {
  try {
    const archiveDir = join(PROJECT_ROOT, "data/archives");
    mkdirSync(archiveDir, { recursive: true });
    const archiveFile = join(archiveDir, `${agentId}-${Date.now()}.jsonl`);
    const home = process.env.HOME ?? "/";
    const subCorpusFile = join(home, `.openclaw/${agentId}/corpus.jsonl`);
    if (existsSync(subCorpusFile)) {
      const entries = readJsonlEntries(subCorpusFile);
      for (const e of entries) appendJsonl(archiveFile, e);
    }
    appendJsonl(archiveFile, {
      type: "archive_summary",
      agentId,
      reason,
      archivedAt: nowCST(),
    });
  } catch {
    // 归档失败静默处理
  }
}

// ── 子 Agent Tier corpus FIFO 配额执行 ───────────────────────────────────
//
// Tier 1 corpusLimit=100，Tier 2=500，Tier 3=无限制。
// 仅对注册在 AgentRegistry 中的子 Agent 执行（base agents 不受约束）。
// corpus 文件路径：~/.openclaw/{agentId}/corpus.jsonl

function enforceSubAgentCorpusQuota(agentId: string, tier: number): void {
  const TIER_LIMITS: Record<number, number> = { 1: 100, 2: 500, 3: 0 };
  const limit = TIER_LIMITS[tier] ?? 0;
  if (limit === 0) return; // Tier 3 / 未知：无限制

  const home = process.env.HOME ?? "/";
  const corpusFile = join(home, `.openclaw/${agentId}/corpus.jsonl`);
  if (!existsSync(corpusFile)) return;

  const entries = readJsonlEntries(corpusFile);
  if (entries.length > limit) {
    // FIFO：保留最新的 limit 条
    writeJsonlEntries(corpusFile, entries.slice(-limit));
  }
}

// ── Axis 2 协作进化：信号采集 + 反思引擎 ─────────────────────────────────
//
// 三信号：
//   1. requirements.outcome（record_outcome_feedback 已写回）
//   2. 对话参与深度（agent_end 写 dialogue-depth.jsonl）
//   3. 主动触达响应率（follow_up_requirement 工具写 proactive-response.jsonl）
//
// 反思引擎每 50 次/24h 分析近 30 天三信号趋势 → 偏差时投递 Andy 改进假设

const DIALOGUE_DEPTH_FILE    = join(PROJECT_ROOT, "data/learning/dialogue-depth.jsonl");
const PROACTIVE_RESPONSE_FILE = join(PROJECT_ROOT, "data/learning/proactive-response.jsonl");
const REFLECTION_RESULTS_FILE = join(PROJECT_ROOT, "data/learning/reflection-results.jsonl");

let reflectionRequestCounter = 0;
let lastReflectionAt         = 0;
const REFLECTION_MIN_REQUESTS = 50;
const REFLECTION_INTERVAL_MS  = 24 * 60 * 60 * 1000;

async function runReflectionEngine(): Promise<void> {
  lastReflectionAt      = Date.now();
  reflectionRequestCounter = 0;

  const cutoff30d = Date.now() - 30 * 24 * 60 * 60 * 1000;

  // ── 信号 1：需求达成率（requirements.outcome 分布）─────────────────
  // 从 diagnostic-results 的 requirements 条目统计 outcome 分布
  // 简化：直接查 ChromaDB requirements 集合中 outcome != "" 的记录
  // （这里用 JSONL 采样近似，ChromaDB 查询留给 before_prompt_build）
  let outcomeSuccess = 0;
  let outcomeTotal   = 0;
  // 用户明确反馈的 outcome 类型（delivered/merged/implemented 等流水线状态不计入达成率）
  const userFeedbackOutcomes = ["success", "failure", "partial"];
  try {
    const reqResults = await chromaQuery("requirements", await embedText("需求 达成 反馈"), 50);
    for (const r of reqResults) {
      const meta = r.metadata as { outcome?: string; timestamp?: string };
      if (!meta.timestamp) continue;
      if (new Date(meta.timestamp).getTime() < cutoff30d) continue;
      if (meta.outcome && userFeedbackOutcomes.includes(meta.outcome)) {
        outcomeTotal++;
        if (meta.outcome === "success") outcomeSuccess++;
      }
    }
  } catch { /* ChromaDB 不可用时跳过 */ }

  // ── 信号 2：对话参与深度趋势 ─────────────────────────────────────────
  const depthEntries = readJsonlEntries(DIALOGUE_DEPTH_FILE)
    .filter(e => typeof e.timestamp === "string"
      && new Date(e.timestamp as string).getTime() > cutoff30d);
  const avgToolCalls = depthEntries.length > 0
    ? depthEntries.reduce((s, e) => s + (typeof e.toolCallCount === "number" ? e.toolCallCount : 0), 0)
      / depthEntries.length
    : null;

  // ── 信号 3：主动触达响应率 ────────────────────────────────────────────
  const proactiveEntries = readJsonlEntries(PROACTIVE_RESPONSE_FILE)
    .filter(e => typeof e.timestamp === "string"
      && new Date(e.timestamp as string).getTime() > cutoff30d);
  const responded   = proactiveEntries.filter(e => e.responded === true).length;
  const responseRate = proactiveEntries.length > 0 ? responded / proactiveEntries.length : null;

  // ── 判断是否存在偏差，生成改进假设 ──────────────────────────────────
  const issues: string[] = [];

  if (outcomeTotal >= 5) {
    const rate = outcomeSuccess / outcomeTotal;
    if (rate < 0.6) issues.push(`需求达成率偏低（${(rate * 100).toFixed(0)}%，近30天${outcomeTotal}条用户明确反馈）`);
  }
  if (avgToolCalls !== null && avgToolCalls < 0.5) {
    issues.push(`对话工具调用深度过低（均值 ${avgToolCalls.toFixed(2)}），可能存在意图识别遗漏`);
  }
  if (responseRate !== null && responseRate < 0.5 && proactiveEntries.length >= 5) {
    issues.push(`主动触达响应率偏低（${(responseRate * 100).toFixed(0)}%，${proactiveEntries.length}次触达）`);
  }

  appendJsonl(REFLECTION_RESULTS_FILE, {
    timestamp: nowCST(),
    outcomeRate: outcomeTotal > 0 ? outcomeSuccess / outcomeTotal : null,
    avgToolCalls,
    responseRate,
    issues,
  });

  if (issues.length > 0) {
    // 投递 Andy 生成改进假设（prompt 设计 / 记忆策略 / Skill 更新）
    void callGatewayAgent(
      "andy",
      `【Axis 2 反思引擎告警】协作信号近30天出现偏差：\n${issues.map(i => `- ${i}`).join("\n")}\n\n请分析根因（可能是 Lucas prompt 设计、记忆策略、或 Skill 文件），提出具体改进假设（可输出 Implementation Spec 或修改建议）。`,
      120_000,
    ).catch(() => {});
  }
}

// ── Axis 1 进化：路由阈值自适应调整 ──────────────────────────────────────
//
// 每次系统启动时调用一次，分析 route-events.jsonl 过去 30 天数据。
// 策略：
//   1. 至少需要 EVOLUTION_MIN_EVENTS 条事件（数据不足则跳过）
//   2. 上次调整距今至少 7 天（防止阈值震荡）
//   3. 当前本地比例 < 目标 * 80%（有进化空间）且阈值 < 0.9 → 小步提升 +0.05
//
// 安全性：初始 localThreshold=0.0，每次最多 +0.05，最高 0.9。
// 路由阈值写入 routing-thresholds.json，before_model_resolve 下次读取生效。
// 进化事件写入 evolution-events.jsonl（KPI 追踪，不影响主流程）。

const ROUTE_EVENTS_FILE      = join(PROJECT_ROOT, "data/learning/route-events.jsonl");
const EVOLUTION_EVENTS_FILE  = join(PROJECT_ROOT, "data/learning/evolution-events.jsonl");
const EVOLUTION_MIN_EVENTS   = 50;      // 至少这么多事件才做分析
const EVOLUTION_THRESHOLD_STEP = 0.05; // 每次最多调整幅度

function evolveRouting(): void {
  try {
    const raw = readFileSync(ROUTE_EVENTS_FILE, "utf8");
    const lines = raw.trim().split("\n").filter(Boolean);

    if (lines.length < EVOLUTION_MIN_EVENTS) {
      appendJsonl(EVOLUTION_EVENTS_FILE, {
        timestamp: nowCST(),
        event: "routing_evolution_skipped",
        reason: `insufficient_events(${lines.length}<${EVOLUTION_MIN_EVENTS})`,
      });
      return;
    }

    const cutoff30d = agoCST(30 * 86_400_000);

    // 按 agentId 分组统计过去 30 天本地 vs 云端路由次数
    type Counts = { total: number; local: number };
    const byAgent: Record<string, Counts> = {};
    for (const line of lines) {
      try {
        const ev = JSON.parse(line) as {
          agentId?: string;
          isCloud?: boolean;
          timestamp?: string;
        };
        if (!ev.agentId || !ev.timestamp) continue;
        if (ev.timestamp < cutoff30d) continue;
        if (!byAgent[ev.agentId]) byAgent[ev.agentId] = { total: 0, local: 0 };
        byAgent[ev.agentId].total++;
        if (!ev.isCloud) byAgent[ev.agentId].local++;
      } catch {
        continue;
      }
    }

    const thresholds = loadRoutingThresholds();
    let changed = false;
    const snapshot: Record<string, { localRatio30d: number; localThreshold: number; totalEvents: number; adjusted?: boolean }> = {};

    for (const cfg of AGENT_EVOLUTION_CONFIGS) {
      const counts = byAgent[cfg.agentId];
      if (!counts || counts.total < EVOLUTION_MIN_EVENTS) {
        snapshot[cfg.agentId] = {
          localRatio30d: 0,
          localThreshold: thresholds[cfg.agentId]?.localThreshold ?? cfg.localThresholdInit,
          totalEvents: counts?.total ?? 0,
        };
        continue;
      }

      const localRatio = counts.local / counts.total;
      const current = thresholds[cfg.agentId] ?? {
        localThreshold: cfg.localThresholdInit,
        localRatio30d: 0.0,
        lastAdjusted: null,
        totalEvents: 0,
      };

      current.localRatio30d = localRatio;
      current.totalEvents   = counts.total;

      // 调整条件：上次调整 > 7 天 + 当前本地比例 < 目标 80% + 阈值还有上升空间
      const daysSinceAdjust = current.lastAdjusted
        ? (Date.now() - new Date(current.lastAdjusted).getTime()) / 86_400_000
        : Infinity;

      let adjusted = false;
      if (
        daysSinceAdjust > 7
        && localRatio < cfg.localRatioTarget * 0.8
        && current.localThreshold < 0.9
      ) {
        current.localThreshold = parseFloat(
          Math.min(0.9, current.localThreshold + EVOLUTION_THRESHOLD_STEP).toFixed(2),
        );
        current.lastAdjusted = nowCST();
        changed = true;
        adjusted = true;
      }

      thresholds[cfg.agentId] = current;
      snapshot[cfg.agentId] = {
        localRatio30d: localRatio,
        localThreshold: current.localThreshold,
        totalEvents: counts.total,
        adjusted,
      };
    }

    if (changed) saveRoutingThresholds(thresholds);

    appendJsonl(EVOLUTION_EVENTS_FILE, {
      timestamp: nowCST(),
      event: "routing_evolution_cycle",
      thresholdChanged: changed,
      agents: snapshot,
    });
  } catch {
    // 进化失败不影响主流程
  }
}

// ── 三维信息生命周期管理 ──────────────────────────────────────────────────────
//
// Lucas/Andy/Lisa 做决策时依赖三类信息，过期信息会误导决策：
//
//   Data 层（corpus 文件）
//     andy-corpus：ADR 有 ttl_days（调研 30 天 / 业务 90 天）+ superseded_by
//                  到期或被取代 → 标记 expired=true（不删除，仍是 DPO 原料）
//     lisa-corpus：实现层知识默认 180 天 TTL
//     expired 条目在上下文注入时被过滤，不再影响决策
//
//   Knowledge 层（Skill 文件）
//     Andy 的设计决策 corpus 到期 → 对应 Skill 的知识可能也陈旧
//     → 写入 data/skill-review-signals.jsonl，由系统工程师或反思引擎处理
//
//   Capability 层（capability-registry.jsonl）
//     Andy→Lisa 每次交付新能力时写入注册表（requirement_id + 创建时间 + last_used）
//     90 天未使用 → 标记 dormant=true，Lucas 路由时降低优先级
//     注：last_used 在 trigger_development_pipeline 被复用时更新（见工具实现）
//
// 与 evolveRouting() 并行，plugin 启动时各触发一次（setImmediate）

function evolveLifecycles(): void {
  const now = Date.now();
  const expiredAt = nowCST();

  // ── Data 层：Andy corpus TTL 执行 ────────────────────────────────────
  const andyCorpusPath = join(PROJECT_ROOT, "data/corpus/andy-corpus.jsonl");
  const andyEntries = readJsonlEntries(andyCorpusPath);
  let andyChanged = false;
  const expiredTopics: string[] = []; // 触发 Knowledge 层 Skill 审查信号

  for (const entry of andyEntries) {
    if (entry.expired) continue;
    // TTL 到期
    if (typeof entry.ttl_days === "number" && typeof entry.timestamp === "string") {
      const ageMs = now - new Date(entry.timestamp).getTime();
      if (ageMs > entry.ttl_days * 86_400_000) {
        entry.expired = true;
        entry.expired_at = expiredAt;
        andyChanged = true;
        expiredTopics.push(typeof entry.intentType === "string" ? entry.intentType : "general");
      }
    }
    // superseded_by 填写时立即过期（被新决策取代）
    if (entry.superseded_by != null && entry.superseded_by !== undefined) {
      entry.expired = true;
      entry.expired_at = expiredAt;
      andyChanged = true;
    }
  }
  if (andyChanged) writeJsonlEntries(andyCorpusPath, andyEntries);

  // ── Data 层：Lisa corpus 默认 TTL 180 天 ─────────────────────────────
  const LISA_TTL_DAYS = 180;
  const lisaCorpusPath = join(PROJECT_ROOT, "data/corpus/lisa-corpus.jsonl");
  const lisaEntries = readJsonlEntries(lisaCorpusPath);
  let lisaChanged = false;

  for (const entry of lisaEntries) {
    if (entry.expired) continue;
    if (typeof entry.timestamp === "string") {
      const ageMs = now - new Date(entry.timestamp).getTime();
      const ttl = (typeof entry.ttl_days === "number" ? entry.ttl_days : LISA_TTL_DAYS) * 86_400_000;
      if (ageMs > ttl) {
        entry.expired = true;
        entry.expired_at = expiredAt;
        lisaChanged = true;
      }
    }
  }
  if (lisaChanged) writeJsonlEntries(lisaCorpusPath, lisaEntries);

  // ── Knowledge 层：Skill 审查信号 ─────────────────────────────────────
  // Andy 设计决策到期 → 对应领域的 Skill 文件可能陈旧 → 写入待审查信号
  if (expiredTopics.length > 0) {
    const signalsPath = join(PROJECT_ROOT, "data/skill-review-signals.jsonl");
    for (const topic of expiredTopics) {
      appendJsonl(signalsPath, {
        timestamp: expiredAt,
        trigger: "data_ttl_expired",
        topic,
        status: "pending",
        note: `andy-corpus 中 [${topic}] 类设计决策已过期，请检查对应 Skill 文件是否需要更新`,
      });
    }
  }

  // ── Capability 层：休眠能力检测 ──────────────────────────────────────
  // 90 天未使用的能力标记 dormant，Lucas 路由时可降低优先级
  const CAP_DORMANT_DAYS = 90;
  const capRegistryPath = join(PROJECT_ROOT, "data/corpus/capability-registry.jsonl");
  const capEntries = readJsonlEntries(capRegistryPath);
  let capChanged = false;

  for (const entry of capEntries) {
    if (entry.dormant) continue;
    const checkDate = typeof entry.last_used === "string" ? entry.last_used
      : typeof entry.timestamp === "string" ? entry.timestamp
      : null;
    if (checkDate) {
      const ageMs = now - new Date(checkDate).getTime();
      if (ageMs > CAP_DORMANT_DAYS * 86_400_000) {
        entry.dormant = true;
        entry.dormant_at = expiredAt;
        capChanged = true;
      }
    }
  }
  if (capChanged) writeJsonlEntries(capRegistryPath, capEntries);

  // ── Agent Tier 休眠检测 ──────────────────────────────────────────────
  // 检查自动生成的子 Agent 是否超过各 Tier 的 dormancyDays，满足条件则标记休眠
  const registry = new AgentRegistry(join(PROJECT_ROOT, "data/agents/registry.json"));
  const dormantIds = registry.checkDormancy();
  for (const id of dormantIds) {
    const rec = registry.getAgent(id);
    registry.markDormant(id);
    // 同步更新 ChromaDB agents 集合，将状态改为 dormant
    if (rec) {
      void writeAgentRecord({
        agentId: id,
        tier: rec.tier,
        parentAgentId: rec.parentAgentId ?? "unknown",
        description: `（休眠）Tier ${rec.tier} 子 Agent，活跃次数 ${rec.activityCount}`,
        status: "dormant",
      });
    }
  }
}

// ── Skill 注入（三维信息体系 Knowledge 层）─────────────────────────────────
//
// 每个 Agent 有两类 Skill 文件：
//   框架层（通用）：crewclaw/daemons/workspace-templates/{agent}/skills/*.md（入 Git）
//   实例层（家庭专属）：~/.openclaw/workspace-{agent}/skills/*.md（不入 Git，Setup 时填写）
//

// ── 插件主体 ──────────────────────────────────────────────────────────

const crewclawRoutingPlugin = {
  id: "crewclaw-routing",
  name: "CrewClaw 三层路由",
  description: "Layer 2 模型路由 · Layer 3 ChromaDB 注入 · Layer 1 开发任务工具",

  register(api: OpenClawPluginApi) {

    // ━━ 启动时任务（并发执行，不阻塞插件注册）━━━━━━━━━━━━━━━━━━━━━━━━
    // 1. Andy / Lisa 本地软件依赖管理（Agent 自调度，非系统级）
    //    安装缺失工具 / 到期升级 / 升级失败自动回退
    // 2. Axis 1 路由进化：分析 route-events → 更新 routing-thresholds.json
    void Promise.all(AGENT_DEPS.map(manageDep));
    // evolveRouting / evolveLifecycles 均为同步文件 I/O，setImmediate 避免阻塞插件注册
    setImmediate(() => {
      evolveRouting();
      evolveLifecycles();
      // Andy/Lisa 实例层 skills 目录初始化（从框架层复制，已有文件不覆盖）
      initAgentSkillsDir("andy");
      initAgentSkillsDir("lisa");
    });

    // 子 Agent 休眠检测：每 24h 运行一次（第一次在 evolveLifecycles 已运行）
    setInterval(() => {
      const registry = new AgentRegistry(join(PROJECT_ROOT, "data/agents/registry.json"));
      for (const id of registry.checkDormancy()) {
        const rec = registry.getAgent(id);
        registry.markDormant(id);
        void archiveAgentMemory(id, "dormant");
        // 同步更新 ChromaDB agents 集合状态
        if (rec) {
          void writeAgentRecord({
            agentId: id,
            tier: rec.tier,
            parentAgentId: rec.parentAgentId ?? "unknown",
            description: `（休眠）Tier ${rec.tier} 子 Agent，活跃次数 ${rec.activityCount}`,
            status: "dormant",
          });
        }
      }
    }, 24 * 60 * 60 * 1000).unref(); // unref() 不阻止进程退出

    // 延迟任务排干：每 30 分钟检查一次，仅在空闲时段（OFF_PEAK_START ~ OFF_PEAK_END）执行
    // 队列中每条任务间隔 2 分钟顺序启动，避免并发雪崩
    setInterval(() => {
      const nowHour = new Date().getHours();
      const isOffPeak = nowHour >= OFF_PEAK_START || nowHour < OFF_PEAK_END;
      if (!isOffPeak) return;
      if (!existsSync(TASK_QUEUE_FILE)) return;
      const tasks = readJsonlEntries(TASK_QUEUE_FILE);
      if (tasks.length === 0) return;
      // 清空队列文件，然后逐个延迟启动
      writeFileSync(TASK_QUEUE_FILE, "", "utf8");
      tasks.forEach((task, i) => {
        setTimeout(() => {
          runAndyPipeline({
            requirement: task.requirement as string,
            intentType: (task.intentType as string) ?? "develop_feature",
            wecomUserId: (task.wecomUserId as string) ?? "unknown",
            originalSymptom: (task.originalSymptom as string | undefined) ?? (task.requirement as string),
          }).catch(() => {});
        }, i * 2 * 60 * 1000); // 每任务间隔 2 分钟
      });
    }, 30 * 60 * 1000).unref();

    // session 级意图缓存：before_prompt_build 写入，llm_input 读取
    // key = sessionKey，value = intent string
    const sessionIntent = new Map<string, string>();

    // session 级模型路由缓存：llm_input 写入，agent_end 读取
    // key = sessionKey，value = { modelUsed, isCloud }
    const sessionModel = new Map<string, { modelUsed: string; isCloud: boolean }>();

    // session 级原始用户消息缓存：before_prompt_build 写入，agent_end 读取
    // prependContext 会把 Skill/记忆注入到 messages 里，agent_end 看到的 lastUser 是
    // 注入后的大块内容，不是真实的用户消息。用这个 Map 保存真实原始消息。
    const sessionPrompt = new Map<string, string>();

    // ── Gateway 资源池实例（插件生命周期内全局共享）──────────────────────────
    // Lucas 专属保留槽位，其余 agent 使用共享竞争槽位
    const lucasSemaphore  = new Semaphore(LUCAS_RESERVED_SLOTS, "lucas-reserved");
    const sharedSemaphore = new Semaphore(GATEWAY_SHARED_SLOTS,  "shared");
    // session → 已占用的 semaphore（agent_end 释放用）
    const sessionSem        = new Map<string, Semaphore>();
    // session → 安全阀 timer（agent_end 释放时 clearTimeout）
    const sessionSemTimer   = new Map<string, ReturnType<typeof setTimeout>>();

    // ━━ Layer 2：模型路由（数据驱动，Axis 1 进化基础）━━━━━━━━━━━━━━━━━━
    //
    // 路由决策逻辑：
    //   complexityScore = "chat"→0.2, "dev_or_complex"→0.8, 未知→0.5
    //   complexityScore < localThreshold → 本地（LOCAL_MODEL_NAME）
    //   否则 → 云端（对应 Agent 的 cloudProvider/cloudModel）
    //
    // 初始 localThreshold=0.0 → 全部走云端，行为与旧版完全一致。
    // evolveRouting() 每周分析 route-events，小步提升阈值（+0.05/次）。
    // 阈值上升 = 更多简单对话走本地 = 路由比例 KPI 上升。
    //
    // sessionIntent 由 before_prompt_build 在 Lucas 侧写入（当前轮或上一轮）。
    // Andy/Lisa 默认 0.5，localThreshold=0.0 时恒走云端，与旧行为一致。

    api.on("before_model_resolve", (_event, ctx) => {
      // ── Layer 2：base agents（lucas / andy / lisa）────────────────────
      const config = AGENT_EVOLUTION_CONFIGS.find((c) => c.agentId === ctx.agentId);
      if (config) {
        const thresholds = loadRoutingThresholds();
        const localThreshold = thresholds[ctx.agentId]?.localThreshold ?? config.localThresholdInit;

        // 复杂度分：从 sessionIntent 读取（before_prompt_build 写入）
        // 首轮对话 / Andy / Lisa 未经 before_prompt_build 设置时，默认 0.5
        const intent = sessionIntent.get(ctx.sessionKey ?? "");
        const complexityScore = intent === "chat" ? 0.2
          : intent === "dev_or_complex" ? 0.8
          : 0.5;

        const useLocal = complexityScore < localThreshold;

        return {
          modelOverride:    useLocal ? config.localModel    : config.cloudModel,
          providerOverride: useLocal ? config.localProvider : config.cloudProvider,
        };
      }

      // ── Chapter 8：成员分身 / 子 Agent 路由 ─────────────────────────
      // agentId 不在 base 四角色 → 查 Registry，按创建者模型配置路由
      // 成员分身（parentAgentId=lucas）跟随 Lucas；Andy/Lisa 小弟跟随各自创建者
      const registry = new AgentRegistry(join(PROJECT_ROOT, "data/agents/registry.json"));
      const rec = registry.getAgent(ctx.agentId);
      if (rec) {
        const parentConfig = AGENT_EVOLUTION_CONFIGS.find(c => c.agentId === rec.parentAgentId);
        if (parentConfig) {
          const thresholds = loadRoutingThresholds();
          const localThreshold = thresholds[parentConfig.agentId]?.localThreshold ?? parentConfig.localThresholdInit;
          // 子 Agent 无独立意图分类，complexityScore 固定 0.5
          const useLocal = 0.5 < localThreshold;
          return {
            modelOverride:    useLocal ? parentConfig.localModel    : parentConfig.cloudModel,
            providerOverride: useLocal ? parentConfig.localProvider : parentConfig.cloudProvider,
          };
        }
      }
    });

    // ━━ 路由事件日志（llm_input）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //
    // 每次 LLM 被调用时记录到 data/learning/route-events.jsonl。
    // 路由比例（isCloud=false 的占比随时间上升）= 本地专精度的量化 KPI。

    api.on("llm_input", (event, ctx) => {
      // debug: 记录 event 字段结构，找工具在哪里
      try {
        const { appendFileSync: dbgLog } = require("fs") as typeof import("fs");
        const toolNames = (event.tools ?? []).map((t: { name?: string }) => t.name ?? "?").join(",");
        const eventKeys = Object.keys(event).join(",");
        dbgLog("/tmp/opencode-debug.log",
          `[${nowCST()}] llm_input: agent=${ctx.agentId} model=${event.model} tools=[${toolNames}] eventKeys=${eventKeys}\n`);
      } catch {}
      const isCloud = event.provider !== "ollama" && !event.model.includes(LOCAL_MODEL);

      // Layer 1 意图：Lucas 从 sessionIntent 读（before_prompt_build 已写入）
      // Andy / Lisa / Main 的意图固定，按 agentId 直接标注
      let intent: string | null = null;
      if (ctx.agentId === FRONTEND_AGENT_ID) {
        intent = sessionIntent.get(ctx.sessionKey ?? "") ?? null;
      } else if (ctx.agentId === "andy") {
        intent = "architecture_design";
      } else if (ctx.agentId === "lisa") {
        intent = "code_implementation";
      } else if (ctx.agentId === "main") {
        intent = "system_engineer";
      }

      // llm_input 在每次请求开始时触发一次（工具调用尚未发生），
      // Layer 3 工具调用数据在 agent_end 里通过 toolResult 消息提取，写入 capability-events。

      // 缓存本次路由的模型信息，供 agent_end 写 conversations 用
      sessionModel.set(ctx.sessionKey ?? "", { modelUsed: event.model ?? "unknown", isCloud });

      appendJsonl(join(PROJECT_ROOT, "data/learning/route-events.jsonl"), {
        id: `${event.runId}_${Math.random().toString(36).slice(2, 6)}`,
        timestamp: nowCST(),
        agentId: ctx.agentId,
        intent,
        isCloud,
        modelUsed: `${isCloud ? "cloud" : "local"}:${event.model}`,
        provider: event.provider,
      });
    });

    // ━━ Layer 3：ChromaDB 上下文注入 + Skill 注入 ━━━━━━━━━━━━━━━━━━━

    // ── ContextResolvers：现有查询函数 → context-handler 接口适配 ──────────
    //
    // 设计原则：resolver 函数只做调用转发，不做决策。
    // topK / agentFilter 参数由 context-sources.ts 注册表定义，但现有函数内部
    // 有各自的 hardcode 值，适配层暂时忽略这两个参数（符合当前数据量规模）。
    // 等 topK 真正需要调优时，再改各查询函数的签名。
    function buildContextResolvers(): ContextResolvers {
      return {
        chromadb: {
          "semantic": async (collection, prompt, _topK, agentFilter) => {
            switch (collection) {
              case "decisions":        return queryDecisionMemory(prompt, agentFilter ?? "");
              case "behavior_patterns": return queryBehaviorPatterns(prompt);
              case "family_knowledge": return queryFamilyKnowledge(prompt);
              case "capabilities":    return queryCapabilities(prompt, agentFilter ?? "");
              default: return "";
            }
          },
          "by-user": async (_collection, prompt, userId, isGroup, _topK) =>
            queryMemories(prompt, userId, isGroup),
          "pending-commitments": (userId) => queryPendingCommitments(userId),
          "pending-requirements": (prompt) => queryPendingRequirements(prompt),
          "agent-interactions": async (prompt, agentFilter, _topK) =>
            queryAgentInteractions(prompt, agentFilter as "andy" | "lisa" | "lucas"),
          "code-history": async (prompt, _topK) => queryCodeHistory(prompt),
          "codebase-patterns": async (prompt, _topK) => queryCodebasePatterns(prompt),
          "constraint-recall": async (prompt, agentFilter, topK) =>
            queryAgentConstraints(prompt, agentFilter, topK),
        },
        kuzu: {
          // 执行 Cypher 查询：通过 kuzu-query.py 子进程调用 Kuzu（Python binding）
          // Kuzu 不支持 LIMIT 参数化，$topK 在传入前替换为整数字面量
          query: (_cypher, _boundParams): Promise<string[]> => {
            return new Promise((resolve) => {
              try {
                const topK   = typeof _boundParams.topK === "number" ? _boundParams.topK : 30;
                // date() 在 Kuzu 0.11.3 中不支持无参调用，替换为今天的日期字面量
                const todayStr = todayCST();
                const cypher = _cypher
                  .replace(/\$topK\b/g, String(topK))
                  .replace(/\bdate\(\)/g, `date('${todayStr}')`);
                const { topK: _t, ...kuzuParams } = _boundParams;
                const KUZU_PYTHON3 = "/opt/homebrew/opt/python@3.11/bin/python3.11";
                const scriptPath   = join(PROJECT_ROOT, "scripts/kuzu-query.py");
                const result = spawnSync(
                  KUZU_PYTHON3,
                  [scriptPath, cypher, JSON.stringify(kuzuParams)],
                  { encoding: "utf8", timeout: 5000 },
                );
                if (result.status !== 0 || !result.stdout?.trim()) {
                  resolve([]);
                  return;
                }
                const rows: unknown[][] = JSON.parse(result.stdout.trim());
                resolve(rows.map(row => row.map(v => (v == null ? "" : String(v))).join(" | ")));
              } catch {
                resolve([]);
              }
            });
          },
        },
        file: {
          "user-profile":     (userId) => readFamilyProfile(userId),
          "app-capabilities": (prompt) => queryAppCapabilities(prompt),
          "static-file":      (filePath) => {
            if (!filePath) return "";
            try {
              const resolved = filePath.startsWith("~/")
                ? join(process.env.HOME ?? "/", filePath.slice(2))
                : filePath;
              const content = readFileSync(resolved, "utf8");
              return content.trim();
            } catch {
              return "";
            }
          },
        },
      };
    }

    // ── 扩展成员能力视图（CrewClaw 框架层通用机制）────────────────────────────
    // 任何组织的「扩展成员」（有正式关系但边界受控）都适用此机制：
    //   Layer 1：scope_tags 访问控制（由邀请方/组织管理员授权）
    //   Layer 2：近期对话语义匹配（相关性过滤）
    // 同时查询未反馈的 pipeline 完成结果，注入「待主动告知」块。
    // 对外永远是 Lucas 在说话——访客感知不到「影子」这一层。
    async function buildMemberCapabilityView(
      visitorToken: string,
      scopeTags: string[],
      recentContext: string,
    ): Promise<{ capabilityBlock: string; pendingBlock: string }> {
      const capLines: string[] = [];
      const pendingLines: string[] = [];

      // Layer 1 + Layer 2：能力视图
      try {
        const regPath = join(PROJECT_ROOT, "data/corpus/capability-registry.jsonl");
        if (existsSync(regPath)) {
          const entries = readFileSync(regPath, "utf8")
            .split("\n").filter(l => l.trim())
            .map(l => { try { return JSON.parse(l) as { capability_id: string; title?: string; requirement?: string; status?: string }; } catch { return null; } })
            .filter((e): e is NonNullable<typeof e> => !!e && e.status === "active");

          const contextWords = new Set(
            recentContext.toLowerCase().split(/[\s，。！？、；：""'']+/).filter(w => w.length > 1),
          );
          const scopeLower = scopeTags.map(t => t.toLowerCase());

          for (const entry of entries) {
            const text = ((entry.title ?? "") + " " + (entry.requirement ?? "")).toLowerCase();
            const keywordMatch = [...contextWords].filter(w => text.includes(w)).length >= 2;
            const scopeMatch = scopeLower.some(tag => text.includes(tag));
            if (keywordMatch || scopeMatch) {
              const label = entry.title ? entry.title.slice(0, 60) : (entry.requirement ?? "").slice(0, 60);
              capLines.push(`- ${label}`);
            }
          }
        }
      } catch { /* 能力视图查询失败，静默降级 */ }

      // 待反馈的 pipeline 完成结果
      try {
        const pending = readVisitorPipelineResults().filter(
          r => r.visitorToken.toUpperCase() === visitorToken.toUpperCase() && !r.surfaced,
        );
        for (const r of pending) {
          pendingLines.push(`- ${(r.brief || r.requirement).slice(0, 80)}（已完成）`);
        }
      } catch { /* 读取失败静默降级 */ }

      return {
        capabilityBlock: capLines.length > 0
          ? `【当前可用能力（与本次话题相关）】\n${capLines.join("\n")}`
          : "",
        pendingBlock: pendingLines.length > 0
          ? `【待主动告知访客的最新进展】\n${pendingLines.join("\n")}\n对话开始时自然提起这些进展，不要等访客开口问。`
          : "",
      };
    }

    // ── 访客会话上下文构建（HomeAI 实例层，访客行为规范完整封装在此）────────────
    // before_prompt_build 只调用此函数，HomeAI 访客专属内容不散落在主流程里。
    async function buildVisitorSessionContext(visitorToken: string): Promise<string> {
      let visitorEntry: { name?: string | null; invitedBy?: string | null; scopeTags?: string[]; behaviorContext?: string | null; memoryAccess?: boolean; personId?: string | null } = {};
      let tokenFound = false;
      try {
        const registryPath = join(PROJECT_ROOT, "data", "visitor-registry.json");
        if (existsSync(registryPath)) {
          const registry = JSON.parse(readFileSync(registryPath, "utf8"));
          // registry key 为大写（如 "DB334C"），但 normalizeUserId 会转小写；做 case-insensitive 查找
          const registryKey = Object.keys(registry).find(k => k.toUpperCase() === visitorToken.toUpperCase()) ?? visitorToken;
          if (registry[registryKey]) {
            visitorEntry = registry[registryKey];
            tokenFound = true;

            // Revival：dormant 访客重新打开 demo-chat → 自动切回 active
            if (visitorEntry.status === "dormant") {
              logger.info(`[buildVisitorSessionContext] dormant 访客复活: ${visitorToken}`);
              registry[registryKey].status   = "active";
              registry[registryKey].revivedAt = Date.now();
              delete registry[registryKey].dormantAt;
              try { writeFileSync(join(PROJECT_ROOT, "data", "visitor-registry.json"), JSON.stringify(registry, null, 2), "utf8"); } catch { /* 静默 */ }
              visitorEntry = registry[registryKey];
              // 异步更新 Kuzu shadow_status=active
              const _entityId = `visitor:${visitorToken.toUpperCase()}`;
              const _kuzu = process.env.HOMEAI_ROOT
                ? `${process.env.HOMEAI_ROOT}/Data/kuzu`
                : `${process.env.HOME}/HomeAI/Data/kuzu`;
              const _py = [
                "import kuzu, os, sys",
                `db = kuzu.Database('${_kuzu}')`,
                "conn = kuzu.Connection(db)",
                `conn.execute("MATCH (e:Entity {id: '${_entityId}'}) SET e.shadow_status = 'active'")`,
                "sys.stdout.flush()",
                "os._exit(0)",
              ].join("\n");
              const _tmp = join(PROJECT_ROOT, `data/_revive_visitor_${visitorToken}.py`);
              try {
                writeFileSync(_tmp, _py, "utf8");
                const _proc = spawn("/opt/homebrew/opt/python@3.11/bin/python3.11", [_tmp], {
                  detached: true, stdio: "ignore",
                });
                _proc.unref();
                setTimeout(() => { try { unlinkSync(_tmp); } catch {} }, 30_000);
              } catch { /* Kuzu 更新失败不阻断对话 */ }
            }
          }
        }
      } catch { /* registry 读取失败，降级为通用访客行为 */ }

      if (!tokenFound) {
        logger.warn(`[buildVisitorSessionContext] 访客 token 不存在: ${visitorToken}，降级为匿名访客`);
      }

      const visitorName     = visitorEntry.name || null;
      const invitedBy       = visitorEntry.invitedBy || "主人";
      const behaviorContext = visitorEntry.behaviorContext || null;
      const scopeTags       = Array.isArray(visitorEntry.scopeTags) && visitorEntry.scopeTags.length > 0
        ? visitorEntry.scopeTags
        : null;

      const contextLines: string[] = [
        "【访客会话】",
        // ⚠️ 明确写出"当前对话对象"防止模型把 invitedBy 误认为对话方
        visitorName
          ? `⚠️ 当前对话对象：${visitorName}（访客，非家庭成员）。ta 通过邀请码进入，由${invitedBy}邀请。`
          : `⚠️ 当前对话对象是访客（非家庭成员），通过邀请码进入，由${invitedBy}邀请。`,
        "启灵以晚辈身份和访客交流，访客是长辈。不要透露家庭成员的任何私人信息。",
      ];
      if (visitorName) contextLines.push(`\n对话对象姓名：${visitorName}。请直接用其姓名或恰当称呼，不要用家庭成员称谓（如"爸爸"）称呼访客。`);
      if (behaviorContext) contextLines.push(`访客背景：${behaviorContext}`);
      if (scopeTags) contextLines.push(`可聊话题范围：${scopeTags.join("、")}（${invitedBy}授权；其他家庭事务不主动展开）`);

      // D4 revival path：若访客有历史蒸馏档案（曾归档后再入），注入摘要
      const safeToken   = visitorToken.replace(/:/g, "_");
      const profilePath = join(PROJECT_ROOT, "data", "member-profiles", `visitor_${safeToken}.md`);
      if (existsSync(profilePath)) {
        try {
          const profileContent = readFileSync(profilePath, "utf8");
          const summaryMatch = profileContent.match(/## 档案摘要\s+([\s\S]{0,800})/);
          const profileSummary = summaryMatch ? summaryMatch[1].trim() : "";
          if (profileSummary) contextLines.push(`\n【访客历史记忆（曾交谈过，再次到访）】\n${profileSummary}`);
        } catch { /* 档案读取失败，静默忽略 */ }
      }

      // memoryAccess：注入 Lucas 对该访客的了解
      // 对所有已知姓名的访客（不论是否有 personId），尝试注入上下文
      if (visitorName) {
        try {
          const chromaUrl = process.env.CHROMA_URL || "http://localhost:8001";
          const snippets: string[] = [];
          const personId = visitorEntry.personId;

          // 优先：专属影子记忆（personId 跨 token 稳定）
          if (personId) {
            const shadowCol = `visitor_shadow_${personId}`;
            const resp = await fetch(`${chromaUrl}/api/v1/collections/${shadowCol}/get`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ limit: 8, include: ["documents"] }),
            });
            if (resp.ok) {
              const data = await resp.json() as { documents?: string[] };
              if (data.documents) {
                for (const doc of data.documents) {
                  if (doc.length > 10) snippets.push(doc.slice(0, 300));
                  if (snippets.length >= 6) break;
                }
              }
            }
          }

          // 对于没有 personId 但有姓名的访客，从 behaviorContext 注入基本信息
          // 注意：只注入 registry 中的 behaviorContext，不尝试查 ChromaDB（conversations 的 fromId 已匿名化，无法可靠查询）
          if (!personId && visitorEntry.behaviorContext) {
            snippets.push(visitorEntry.behaviorContext);
          }

          if (snippets.length > 0 || visitorName) {
            const deduped = [...new Set(snippets)].slice(0, 5).join("\n");
            const label = personId
              ? `【与${visitorName}的历史对话摘要】`
              : visitorEntry.memoryAccess
                ? `【关于${visitorName}的信息（爸爸提供）】`
                : `【访客${visitorName}的基本信息】`;
            if (deduped) {
              contextLines.push(`\n${label}\n${deduped}`);
            } else {
              contextLines.push(`\n${label}`);
            }
          }
        } catch { /* 记忆查询失败，静默忽略 */ }
      }

      contextLines.push(
        "",
        "称呼规则（核心）：",
        "- 以晚辈身份说话，用「叔叔」「阿姨」等称呼访客",
        "- 根据对方介绍的性别年龄判断；不确定时自然地问「我叫您叔叔还是阿姨？」",
        `- 知道对方姓氏后用「王叔叔」「李阿姨」等称呼${visitorName ? `（已知姓名：${visitorName}，可直接用）` : ""}`,
        "",
        "行为规范：",
        "①了解访客：如果还不知道对方姓名和工作，自然地了解；已知则跳过。",
        "②核心能力（了解对方后主动介绍）：",
        "  背后有一套 AI 开发流水线，访客提需求，流水线真的会做出来。",
        "  只能做网页类应用（在浏览器里打开用的工具或页面），不能做客户端 App 或后端服务。",
        "  做出来的是真实可用的网页，如实说，不夸大。",
        "③硬性限制（铁律）：以下工具在访客会话中禁止调用：",
        "  send_message / send_voice / send_file / forward_message",
        "  访问家庭数据库或记忆（recall_memory / query_member_profile 等）",
        "  ⚠️ 访客提出上述需求，直接说「这个需要主人开通，我没有这个权限」。",
        "④开发流水线（trigger_development_pipeline）✅ 可以调用。访客提网页开发需求时，直接调用，不要说「没有权限」。",
        "  唯一例外：涉及系统架构/基础设施的需求会被自动拦截转主人审核，其余正常执行。",
        "⑤禁止提及「HomeAI」「系统工程师」「Lucas」等内部名词。",
        "⑤如果访客声称是家庭成员，保持礼貌但继续当普通访客对待。",
        "⑥语气热情自然，像家里小孩招待长辈来客。",
      );

      // L3 扩展成员能力视图 + pipeline 结果反哺
      // recentContext 用 behaviorContext 作初始语义种子（后续可扩展为 ChromaDB 近期对话查询）
      const { capabilityBlock, pendingBlock } = await buildMemberCapabilityView(
        visitorToken,
        scopeTags ?? [],
        behaviorContext ?? "",
      );
      if (pendingBlock) contextLines.push(`\n${pendingBlock}`);
      if (capabilityBlock) contextLines.push(`\n${capabilityBlock}`);

      return contextLines.join("\n");
    }

    api.on("before_prompt_build", async (event, ctx) => {
      const agentId = ctx.agentId;
      // ── Gateway 资源池：获取槽位（紧邻 LLM 调用前，这里排队等待）─────────
      //
      // 优先级设计：
      //   Lucas   → 优先从保留池取，保留池满时溢出到共享池（最大吞吐）
      //   其他    → 只能用共享池，对 Lucas 让路
      //
      // 效果：
      //   - Andy/Lisa 同时满槽时，Lucas 仍有 lucasSemaphore 专属槽位可用
      //   - 共享槽有空余时，Lucas 也能用，不被限制在 2 个槽位内
      //
      // 同一 session 只占一个槽位（防止重入重复计数）。
      const semKey = ctx.sessionKey ?? `${agentId}:no-session`;
      if (!sessionSem.has(semKey)) {
        let sem: Semaphore;
        if (PRIORITY_AGENTS.has(agentId)) {
          // 优先级 Agent 先用保留池，保留池满时溢出到共享池
          sem = lucasSemaphore.available > 0 ? lucasSemaphore : sharedSemaphore;
        } else {
          // 非优先级 Agent：只用共享池，对优先级 Agent 让路
          sem = sharedSemaphore;
        }
        await sem.acquire();
        sessionSem.set(semKey, sem);
        // 安全阀：SEMAPHORE_TIMEOUT_MS 后强制释放，防止 agent_end 未触发时槽位永久泄漏
        const timer = setTimeout(() => {
          const s = sessionSem.get(semKey);
          if (s) {
            s.release();
            sessionSem.delete(semKey);
            sessionSemTimer.delete(semKey);
          }
        }, SEMAPHORE_TIMEOUT_MS);
        (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
        sessionSemTimer.set(semKey, timer);
      }

      // 所有 Agent：保存真实原始用户消息（agent_end 写 corpus/memory 时用）
      // OpenClaw Gateway 会把历史轮次注入进 user message content：
      //   "[Chat messages since your last reply - for context]\nUser: xxx\nAssistant: xxx\nUser: [真实消息]"
      // 从 event.messages 倒序取最后一条 user 消息后，还需剥离这个前缀，
      // 提取最后一个 "User: " 行作为真实原始输入。
      {
        const _msgs = event.messages as Array<{ role?: string; content?: unknown }>;
        const _lastUser = [..._msgs].reverse().find(m => m.role === "user")?.content;
        const _rawMsg = typeof _lastUser === "string" ? _lastUser : (event.prompt ?? "");
        // 剥离 OpenClaw 历史前缀：取最后一个 "User: " 行的内容
        let _cleanMsg = _rawMsg;
        if (_rawMsg.includes("[Chat messages since your last reply")) {
          const _lines = _rawMsg.split("\n");
          for (let _i = _lines.length - 1; _i >= 0; _i--) {
            if (_lines[_i].startsWith("User: ")) {
              _cleanMsg = _lines[_i].replace(/^User:\s*/, "").trim();
              break;
            }
          }
        }
        sessionPrompt.set(ctx.sessionKey ?? "", _cleanMsg);
      }

      // ── Lucas 专属：滑动消息窗口 + 意图推断 ───────────────────────────
      //
      // 这两项不属于知识注入，是 Lucas 的运行时管理逻辑，不走 context-sources 注册表。
      const { userId, isGroup } = parseSessionUser(ctx.sessionKey);
      const isPreWriteTestSession = /test|watchdog/i.test(ctx.sessionKey ?? "");
      // visitor:TOKEN — 访客会话，跳过家庭信息注入（Kuzu 家人档案 + ChromaDB 家庭记忆）
      const isVisitorSession = userId.startsWith("visitor:");
      if (agentId === FRONTEND_AGENT_ID) {
        // 记录当前会话 userId（visitor session 也记录完整 token），供 recall_memory 工具在无 session 上下文时使用
        lastFrontendUserId = userId.toLowerCase();
        // 滑动窗口：保留最近 40 条 + 第 0 条（system prompt）
        // 40 = 15 轮历史（30条）+ 当前消息（1条）+ prependContext 注入（若干条）留余量
        const LUCAS_MSG_WINDOW = 40;
        const msgs = event.messages as unknown[];
        if (msgs.length > LUCAS_MSG_WINDOW + 1) {
          msgs.splice(1, msgs.length - LUCAS_MSG_WINDOW - 1);
        }
        // 清理孤立 toolResult：窗口截断可能切断 toolUse/toolResult 对
        if (msgs.length > 1) {
          let orphanEnd = 1;
          while (orphanEnd < msgs.length) {
            const role = (msgs[orphanEnd] as { role: string }).role;
            if (role === "toolResult" || role === "tool") orphanEnd++;
            else break;
          }
          if (orphanEnd > 1) msgs.splice(1, orphanEnd - 1);
        }
        // 意图推断：写入 sessionIntent 供 llm_input 使用
        const inferred = isDevOrComplexIntent(event.prompt) ? "dev_or_complex" : "chat";
        sessionIntent.set(ctx.sessionKey ?? "", inferred);
      }

      // ── 通用知识注入（context-handler 接管三角色）────────────────────────
      //
      // context-sources.ts 注册表定义「每个 agent 查哪些来源」，
      // context-handler.ts 并发执行所有查询并分组（prepend / appendSystem）。
      // 新增检索源只改 context-sources.ts，不改这里。
      const sessionParams: SessionParams = {
        prompt:     event.prompt,
        // visitor session：userId 格式为 "visitor:db334c"，直接传给 queryMemories 做精确 where 过滤
        userId:     agentId === FRONTEND_AGENT_ID ? userId : agentId,
        agentId,
        isGroup:    agentId === FRONTEND_AGENT_ID ? isGroup : false,
        sessionKey: ctx.sessionKey ?? "",
      };
      const { prepend, appendSystem } = await buildDynamicContext(sessionParams, buildContextResolvers());

      // ── L3 跨成员协调扫描（Lucas 私聊专属，访客会话跳过）────────────────────
      if (agentId === FRONTEND_AGENT_ID && !isGroup && !isVisitorSession) {
        const crossHint = await scanCrossMemberContext(userId, event.prompt);
        if (crossHint) appendSystem.push(crossHint);
      }

      // ── L3 成员影子能力视图（shadow agent 专属）────────────────────────────
      // 影子接收请求时，注入家庭可用能力清单，帮助影子为成员推荐合适能力
      if (agentId.startsWith("workspace-")) {
        const capView = buildShadowCapabilityView();
        if (capView) appendSystem.push(capView);
      }

      // 前台 Agent 专属：当前时间注入、行为铁律、访客会话
      if (agentId === FRONTEND_AGENT_ID) {
        const cstDate = new Date(Date.now() + 8 * 3600000);
        const days = ['日', '一', '二', '三', '四', '五', '六'];
        const dayStr = days[cstDate.getUTCDay()];
        const dateStr = `${cstDate.getUTCFullYear()}年${cstDate.getUTCMonth() + 1}月${cstDate.getUTCDate()}日（星期${dayStr}）`;
        const hours   = String(cstDate.getUTCHours()).padStart(2, '0');
        const minutes = String(cstDate.getUTCMinutes()).padStart(2, '0');
        appendSystem.push(`【当前时间】${dateStr} ${hours}:${minutes} 北京时间`);

        // ── 承诺词禁令 + 工具调用静默原则（每轮注入，从 config/lucas-behavioral-rules.json 加载）
        // 问题根源：AGENTS.md 规则在对话加长后被上下文窗口压缩，模型「忘记」。
        // 解法：每轮在 appendSystemContext 里重新注入，始终在最近的上下文里。
        // 内容（HomeAI 专属工具名/表述）在 config 文件管理，不在此处内联。
        appendSystem.push(_lucasBehavioralRules.commitmentRule);
        appendSystem.push(_lucasBehavioralRules.silenceRule);
        if (_lucasBehavioralRules.channelPrivacyRule) {
          appendSystem.push(_lucasBehavioralRules.channelPrivacyRule);
        }

        // ── 待调度需求队列（仅 HEARTBEAT 触发时注入，避免干扰正常家庭对话）────
        // event.messages 只含历史（不含当前消息）；当前消息在 event.prompt 里。
        // 有历史时 event.prompt 是序列化全文（含当前），无历史时就是当前消息本身。
        // 用全文搜索 /HEARTBEAT/i——HEARTBEAT 是系统专用词，家人对话不会出现。
        const isHeartbeat = /HEARTBEAT/i.test(event.prompt ?? "")
          || /heartbeat/i.test(ctx.sessionKey ?? "");
        if (isHeartbeat) {
          const pendingQueue = await queryPendingSchedulableRequirements();
          if (pendingQueue) appendSystem.push(pendingQueue);

          // ── L2 行为反馈信号注入（Heartbeat 专属）──────────────────────────────
          // 从 lucas-behavior-signals.jsonl 读取最近 30 天家人给 Lucas 的行为指导，
          // 注入 Heartbeat 上下文，驱动 L2 自我改进闭环：
          // Lucas 看到信号 → 判断是否有行为缺口 → 可自主触发流水线改进
          try {
            const signalsPath = join(PROJECT_ROOT, "data", "lucas-behavior-signals.jsonl");
            if (existsSync(signalsPath)) {
              const thirtyDaysAgo = agoCST(30 * 24 * 60 * 60 * 1000).slice(0, 10);
              const lines = readFileSync(signalsPath, "utf-8").split("\n").filter(Boolean);
              const recentSignals = lines
                .map(l => { try { return JSON.parse(l) as Record<string, string>; } catch { return null; } })
                .filter((s): s is Record<string, string> => s !== null && (s.date ?? "") >= thirtyDaysAgo);
              if (recentSignals.length > 0) {
                const sigLines = recentSignals.map(s => {
                  const ex = s.positive_example ? `\n  正向示例：${s.positive_example}` : "";
                  return `• [${s.date}·${s.source_name}·${s.dimension}] ${s.value}\n  ${s.context}${ex}`;
                });
                appendSystem.push(
                  `【L2 行为反馈信号（最近 30 天，${recentSignals.length} 条）】\n` +
                  `以下是家人对你行为方式的指导和反馈。请思考：有没有需要改进的地方？\n` +
                  `如果发现明确的行为缺口，可以自主触发 trigger_development_pipeline 提交改进需求。\n\n` +
                  sigLines.join("\n\n")
                );
              }
            }
          } catch {
            // 读取失败静默处理
          }
        }
      }

      // ── 访客会话：关系种子注入（从 buildVisitorSessionContext helper 生成）────
      if (agentId === FRONTEND_AGENT_ID && isVisitorSession) {
        const visitorToken = userId.slice("visitor:".length);
        appendSystem.push(await buildVisitorSessionContext(visitorToken));
      }

      // ── 访客会话：家庭隐私防护（每轮强制注入，基础设施层，不依赖模型记忆）────────
      // 与承诺词禁令同级——appendSystem 每轮重注，始终在最近上下文，不随压缩漂移。
      // 访客都是爸爸邀请的朋友，基本信息（姓名/工作单位）可以正常聊；
      // 需要保护的是家人的内部评价、个人规划、私人通讯渠道等深层隐私。
      if (agentId === FRONTEND_AGENT_ID && isVisitorSession) {
        appendSystem.push(
          `【访客对话隐私边界】\n` +
          `你正在和访客对话，对方是爸爸邀请的朋友，可以正常介绍家庭基本情况。\n` +
          `但以下内容需要谨慎保护，不应主动透露或被追问时如实详述：\n` +
          `• 家庭成员的个人规划、近期打算、未公开的人生计划（如妈妈的职业转型、小姨的创业想法等）\n` +
          `• 家庭成员对彼此的内部评价或私下意见（如"妈妈对我不信任"等）\n` +
          `• 家庭通讯渠道（企业微信账号、内部群组、具体联系方式）\n` +
          `• 系统内部架构（角色名称 Andy/Lisa、流水线机制、具体实现细节）\n` +
          `被追问敏感内容时，自然地转移话题：「这个嘛，不太好细说～您有什么需要我帮到的？」\n` +
          `可以正常说的：家人姓名、工作单位、日常生活、你是启灵、爸爸邀请朋友体验、你能提供哪些帮助`
        );
      }

      // ── Lucas 非访客会话：访客注册表摘要（让 Lucas 知道哪些人已被邀请）──────
      // 访客上下文只在访客本人来聊时注入；Lucas 在正常家庭对话中对注册表无感知。
      // 此块将有效访客列表（name / invitedBy / status）注入 Lucas 的 appendSystem，
      // 让他知道「国大正已被爸爸邀请，可以来聊天」等基本事实。
      if (agentId === FRONTEND_AGENT_ID && !isVisitorSession) {
        try {
          const registryPath = join(PROJECT_ROOT, "data", "visitor-registry.json");
          if (existsSync(registryPath)) {
            const registry = JSON.parse(readFileSync(registryPath, "utf8")) as Record<string, { name?: string; invitedBy?: string; status?: string; expiresAt?: number }>;
            const activeVisitors = Object.entries(registry)
              .filter(([, v]) => v.status === "active" && (!v.expiresAt || Date.now() < v.expiresAt))
              .map(([, v]) => `- ${v.name ?? "（未命名）"}（邀请人：${v.invitedBy ?? "未知"}）`);
            if (activeVisitors.length > 0) {
              appendSystem.push(
                `## 当前已邀请的访客\n\n以下访客已被邀请，可通过访客链接与我对话（网页版）：\n${activeVisitors.join("\n")}`
              );
            }
          }
        } catch {
          // 读取失败静默忽略，不影响正常会话
        }
      }

      // ── 盲区摘要（上次蒸馏到当前 N 轮注入之间的信息真空）──────────────────
      // 覆盖所有渠道（私聊 + 群聊），访客会话跳过（家庭盲区与访客无关）
      // contextSensitivity=public 渠道（群聊/广播）：只注入群聊公开内容
      // contextSensitivity=private 渠道（私聊）：注入私聊 + 群聊内容（私聊本人视角可见全部）
      if (agentId === FRONTEND_AGENT_ID && !isVisitorSession) {
        try {
          // 读当前渠道的 contextSensitivity
          const audienceCfgPath2 = join(PROJECT_ROOT, "CrewHiveClaw/CrewClaw/crewclaw-routing/config", "channel-audience.json");
          const channelSensitivity: string = existsSync(audienceCfgPath2)
            ? ((JSON.parse(readFileSync(audienceCfgPath2, "utf8")) as Record<string, { contextSensitivity?: string }>)
                [isGroup ? `${CHANNEL_NAME}_group` : `${CHANNEL_NAME}_private`]?.contextSensitivity ?? "private")
            : "private";

          const distillMetaPath = join(PROJECT_ROOT, "data", "agent-distill-meta", "lucas.json");
          if (existsSync(distillMetaPath)) {
            const distillMeta = JSON.parse(readFileSync(distillMetaPath, "utf8")) as { distilled_at?: string };
            const t_d = distillMeta.distilled_at;
            if (t_d) {
              const allRecords = await chromaGet("conversations", {
                "$and": [
                  { "timestamp": { "$gt": t_d } },
                  { "fromType": { "$eq": "human" } },
                ],
              });
              allRecords.sort((a, b) =>
                String(b.metadata.timestamp ?? "").localeCompare(String(a.metadata.timestamp ?? ""))
              );
              const RECENT_N = MEMORY_CONTEXT_SIZE * 2;
              const gapRecords = allRecords.slice(RECENT_N).filter(r => {
                // public 渠道（群聊/广播）只显示群聊内容，过滤私聊记录
                if (channelSensitivity === "public") return r.metadata.source === "group";
                return true; // private 渠道（单人私聊）可见全部
              });

              // 也收录 Agent 团队活动（流水线进展、Andy/Lisa 工作记录）进盲区
              // 语义搜索已覆盖最近 2 条协作记录，盲区取余下部分
              const agentActivityRecords = await chromaGet("agent_interactions", {
                "timestamp": { "$gt": t_d },
              });
              agentActivityRecords.sort((a, b) =>
                String(b.metadata.timestamp ?? "").localeCompare(String(a.metadata.timestamp ?? ""))
              );
              const gapAgentRecords = agentActivityRecords.slice(2);

              if (gapRecords.length > 0 || gapAgentRecords.length > 0) {
                let summary = "";
                for (const r of gapRecords) {
                  const ts  = String(r.metadata.timestamp ?? "").slice(0, 16).replace("T", " ");
                  const who = r.metadata.userId ? String(r.metadata.userId) : "未知";
                  const src = r.metadata.source === "group" ? "群聊" : "私聊";
                  const line = `[${ts} ${who} ${src}] ${r.document}\n`;
                  if ((summary + line).length > 600) break;
                  summary += line;
                }
                let agentSummary = "";
                for (const r of gapAgentRecords) {
                  const ts    = String(r.metadata.timestamp ?? "").slice(0, 16).replace("T", " ");
                  const agent = r.metadata.agentId ? String(r.metadata.agentId) : "系统";
                  const line  = `[${ts} ${agent}] ${r.document}\n`;
                  if ((agentSummary + line).length > 300) break;
                  agentSummary += line;
                }
                const combined = [
                  summary.trim(),
                  agentSummary.trim() ? `【团队动态】\n${agentSummary.trim()}` : "",
                ].filter(Boolean).join("\n\n");
                if (combined) {
                  appendSystem.push(
                    `【近期记忆（蒸馏前）】\n以下是上次记忆蒸馏之后、当前对话之前发生的事，供你感知近期动态：\n${combined}`
                  );
                }
              }
            }
          }
        } catch {
          // 静默失败，不影响正常对话
        }
      }

      // ── 受众感知（渠道自觉）──────────────────────────────────────────────
      // 框架层机制：读 config/channel-audience.json，注入当前渠道的受众类型
      // 三类抽象：single（单人）/ multiple（多人，已知成员）/ broadcast（广播，不特定）
      // 实例层：channel-audience.json 配置各渠道映射，新渠道只加配置不改代码
      // membersSource=family_members：从家人 inject.md 动态解析，成员增减自动更新
      if (agentId === FRONTEND_AGENT_ID && !isVisitorSession) {
        try {
          const audienceCfgPath = join(PROJECT_ROOT, "CrewHiveClaw/CrewClaw/crewclaw-routing/config", "channel-audience.json");
          if (existsSync(audienceCfgPath)) {
            const audienceCfg = JSON.parse(readFileSync(audienceCfgPath, "utf8")) as Record<string, {
              audienceType: "single" | "multiple" | "broadcast";
              label?: string;
              membersSource?: string;
            }>;
            const channelKey = isGroup ? `${CHANNEL_NAME}_group` : `${CHANNEL_NAME}_private`;
            const cfg = audienceCfg[channelKey];
            if (cfg) {
              let audienceHint = "";
              if (cfg.audienceType === "single") {
                audienceHint = `【当前受众】单人私聊（${cfg.label ?? channelKey}）。只有对方一个人在听，可以亲密、细说。`;
              } else if (cfg.audienceType === "multiple") {
                let memberList = "";
                if (cfg.membersSource === "family_members") {
                  // 动态读 members.json profileMap，再从 inject.md 第一行解析显示名
                  const membersConfig = loadInstanceConfig<{ profileMap: Record<string, string> }>("members.json");
                  const uniqueProfiles = [...new Set(Object.values(membersConfig.profileMap))];
                  const names: string[] = [];
                  for (const profileName of uniqueProfiles) {
                    const injectPath = join(FAMILY_PROFILE_DIR, `${profileName}.inject.md`);
                    if (existsSync(injectPath)) {
                      const firstLine = readFileSync(injectPath, "utf8").split("\n")[0] ?? "";
                      const name = firstLine.replace(/^#+\s*/, "").trim();
                      if (name) names.push(name);
                    }
                  }
                  memberList = names.join("、");
                }
                audienceHint = `【当前受众】多人场合（${cfg.label ?? channelKey}）。${memberList ? `在场成员：${memberList}。` : ""}所有人都能看到你的回复，注意顾及多方。`;
              } else if (cfg.audienceType === "broadcast") {
                audienceHint = `【当前受众】广播场合（${cfg.label ?? channelKey}）。受众不特定，措辞需正式克制。`;
              }
              if (audienceHint) appendSystem.push(audienceHint);
            }
          }
        } catch {
          // 静默失败
        }
      }

      // ── 意图分析（轻量规则引擎，命中时注入，不命中不加噪音）──────────────
      // 框架机制：读 config/intent-patterns.json，匹配当前消息关键词
      // 命中时：扫最近 assistant 消息里的已有产物，注入结构化意图提示
      // 实例层：intent-patterns.json 填写自己域的关键词和意图类别
      if (agentId === FRONTEND_AGENT_ID) {
        try {
          const intentCfgPath = join(PROJECT_ROOT, "CrewHiveClaw/CrewClaw/crewclaw-routing/config", "intent-patterns.json");
          if (existsSync(intentCfgPath)) {
            const intentCfg = JSON.parse(readFileSync(intentCfgPath, "utf8")) as {
              patterns: Array<{ id: string; keywords: string[]; label: string; hint: string }>;
              artifactPatterns: Array<{ label: string; regex: string }>;
            };
            const currentMsg = (event.prompt ?? "").slice(-500); // 只看当前消息尾部
            const matched = intentCfg.patterns.find(p =>
              p.keywords.some(kw => currentMsg.includes(kw))
            );
            if (matched) {
              // 扫最近 assistant 消息里的已有产物
              const msgs = event.messages as Array<{ role: string; content: unknown }>;
              const recentAssistant = msgs
                .filter(m => m.role === "assistant")
                .slice(-5)
                .map(m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
                .join("\n");
              const foundArtifacts: string[] = [];
              for (const ap of intentCfg.artifactPatterns) {
                const hits = recentAssistant.match(new RegExp(ap.regex, "g")) ?? [];
                const unique = [...new Set(hits)].slice(0, 3);
                if (unique.length > 0) foundArtifacts.push(`${ap.label}：${unique.join("、")}`);
              }
              const artifactNote = foundArtifacts.length > 0
                ? `\n本次会话已有产物：${foundArtifacts.join("；")}`
                : "";
              appendSystem.push(
                `【意图分析】推断意图：${matched.label}${artifactNote}\n提示：${matched.hint}`
              );
            }
          }
        } catch {
          // 静默失败
        }
      }

      // ── 方案B：记忆意图检测 → 基础设施层强制补充检索 ──────────────────────────
      // 当检测到记忆召回意图词时，不等 Lucas 判断是否调用 recall_memory，
      // 在注入层直接额外检索 6 条相关记录并注入——把「是否查记忆」从模型层下沉到基础设施层。
      // 触发条件：Lucas 私聊/群聊 + 非访客 + 消息含明确召回意图
      if (agentId === FRONTEND_AGENT_ID && !isVisitorSession) {
        const MEMORY_INTENT_RE = /记得|还记得|你记得|之前说过|我说过|你说过|上次说|上次提|上次聊|有没有记|记忆里|相关记忆|回忆一下|帮我找/;
        const cleanPrompt = sessionPrompt.get(ctx.sessionKey ?? "") ?? (event.prompt ?? "");
        if (MEMORY_INTENT_RE.test(cleanPrompt)) {
          try {
            // 第一步：原始 query embedding，用于 Topic-first 查找相关话题
            const baseEmbedding = await embedText(cleanPrompt.slice(0, 400));
            // 第二步：Topic-first query rewriting——私聊时找相关 Kuzu 话题，扩展查询
            // 「第十条」→「抖音成长故事 第十条 脚本完成 启灵自我成长故事」命中率大幅提升
            let intentEmbedding = baseEmbedding;
            if (!isGroup) {
              const relatedTopics = await queryRelevantTopics(baseEmbedding, userId);
              if (relatedTopics.length > 0) {
                const topicKeywords = relatedTopics
                  .slice(0, 3)
                  .map(t => `${t.topicName} ${t.context.slice(0, 60)}`.trim())
                  .join(" ");
                const expandedQuery = `${cleanPrompt.slice(0, 300)} ${topicKeywords}`.trim();
                intentEmbedding = await embedText(expandedQuery.slice(0, 500));
              }
            }
            // 第三步：用扩展后的 embedding 检索对话记忆
            // where：私聊限定当前用户，群聊不过滤（与 recall_memory 默认 scope=all 对齐）
            const intentWhere = isGroup ? undefined : { userId: { $eq: userId } };
            const intentRaw = await chromaQuery("conversations", intentEmbedding, 12, intentWhere);
            const intentResults = timeWeightedRerank(intentRaw, 6);
            if (intentResults.length > 0) {
              const lines = intentResults.map(r => {
                const meta = r.metadata as { prompt?: string; response?: string; timestamp?: string; source?: string };
                const ts   = toCST(meta.timestamp);
                const src  = meta.source === "group" ? "（群聊）" : "（私聊）";
                return `[${ts}${src}]\n用户: ${(meta.prompt ?? "").slice(0, 200)}\nLucas: ${(meta.response ?? "").slice(0, 200)}`;
              });
              appendSystem.push(
                `【系统已主动检索相关记忆（${intentResults.length} 条）】\n` +
                `检测到召回意图，基础设施层自动补充——无需再调用 recall_memory。\n\n` +
                lines.join("\n---\n")
              );
            }
          } catch {
            // 检索失败静默处理，不影响主流程
          }
        }
      }

      // ── 话题命中时 Kuzu Fact 动态置顶（分层上下文·最相关内容优先）─────────────
      // 与 MEMORY_INTENT_RE 互补：MEMORY_INTENT_RE 检测「回忆意图」，这里检测「当前话题相关性」。
      // 当消息高度命中已知话题时，主动 pin 该话题的 Kuzu Fact，让模型在最近上下文看到。
      // 触发条件：Lucas 私聊 + 非访客 + 话题匹配置信度 > 0.82
      if (agentId === FRONTEND_AGENT_ID && !isVisitorSession && !isGroup) {
        const topicPrompt = sessionPrompt.get(ctx.sessionKey ?? "") ?? (event.prompt ?? "");
        try {
          const topicEmbedding = await embedText(topicPrompt.slice(0, 300));
          const relevantTopics = await queryRelevantTopics(topicEmbedding, userId);
          // queryRelevantTopics 内部限 5 条且按相关度排序，取前 3 注入即可
          const highConfTopics = relevantTopics.slice(0, 3);
          if (highConfTopics.length > 0) {
            const topicLines = highConfTopics.map(t => {
              const label = t.relation === "shared_activity" ? "一起做过"
                : t.relation === "active_thread" ? "进行中"
                : t.relation === "has_pattern" ? "行为规律" : t.relation;
              return `• [${label}] ${t.topicName}${t.context ? `：${t.context.slice(0, 100)}` : ""}`;
            });
            appendSystem.push(
              `【相关图谱事实（自动匹配）】\n` +
              topicLines.join("\n") +
              "\n——如需完整详情可调 recall_memory"
            );
          }
        } catch { /* 静默处理，不影响主流程 */ }
      }

      // ── 开发需求快捷路径识别（确定性 Skill 前置）──────────────────────────────
      // 检测用户明确的开发需求信号 → appendSystem 指引 Lucas 直接走工具路径
      // 减少一轮「Lucas 确认是否是开发需求」的澄清，把判断从模型层下沉到基础设施层
      if (agentId === FRONTEND_AGENT_ID && !isVisitorSession) {
        const devPrompt = sessionPrompt.get(ctx.sessionKey ?? "") ?? (event.prompt ?? "");
        const DEV_SHORTCUT_RE = /(直接|马上|立刻|帮我)(开发|实现|做一下|搞一下|写一下|建一个).{0,40}(功能|需求|页面|接口|工具)|(^|\n)(开发需求|提交需求|新需求)[:：]/;
        if (DEV_SHORTCUT_RE.test(devPrompt.trim())) {
          appendSystem.push(
            `【系统提示：检测到明确开发需求】\n` +
            `用户意图清晰，直接调用 trigger_development_pipeline 提交需求，无需进一步澄清。\n` +
            `把用户诉求提炼成一句话作为 requirement 参数传入即可。`
          );
        }
      }

      // ── Loop 1：外部知识感知提醒（主动路由给 Andy）──────────────────────────
      // 检测对方分享外部知识/洞察时，提醒 Lucas 考虑调用 share_with_andy。
      // 不强制——Lucas 自主判断是否值得系统消化；只是把这个决策点主动推到视野里。
      // 触发条件：Lucas 私聊 + 非访客 + 非群聊 + 消息含外部知识分享信号
      if (agentId === FRONTEND_AGENT_ID && !isVisitorSession && !isGroup) {
        const kPrompt = sessionPrompt.get(ctx.sessionKey ?? "") ?? (event.prompt ?? "");
        const KNOWLEDGE_SHARE_RE = /(分享|转发).{0,20}(文章|资料|研究|论文|报告|教程|知识)|(这篇|这份|这个).{0,10}(文章|资料|内容)|(领域|专业|行业).{0,10}(知识|经验|洞察|见解)|系统.{0,15}(能不能|可以|支持|边界|局限)|值得(了解|学习|关注)/;
        if (KNOWLEDGE_SHARE_RE.test(kPrompt)) {
          appendSystem.push(
            `【知识感知提示】\n` +
            `检测到对方可能在分享外部知识或洞察。如果这是值得 Andy 系统消化的内容（而非即时请求），` +
            `回复后可调用 share_with_andy 将内容路由给 Andy。`
          );
        }
      }

      // ── 会话开口当前状态感知（进行中任务注入）────────────────────────────────
      // Lucas 私聊 + 非访客时，检查是否有正在进行的开发任务并注入状态。
      // 让 Lucas 在对话开头就知道「这个人有任务在跑」，无需等对方主动问。
      // 只注入与当前用户相关的任务（submittedBy 规范化后比对），不泄漏其他家人的任务。
      if (agentId === FRONTEND_AGENT_ID && !isVisitorSession && !isGroup) {
        try {
          const allTasks = readTaskRegistry().filter(
            e => normalizeUserId(e.submittedBy) === userId,
          );
          // 进行中/排队中任务
          const runningTasks = allTasks.filter(e => e.status === "running" || e.status === "queued");
          if (runningTasks.length > 0) {
            const phaseLabels: Record<string, string> = {
              andy_designing: "Andy 设计中",
              lisa_implementing: "Lisa 实现中",
              completed: "已完成",
            };
            const taskLines = runningTasks.map(t => {
              const agoMin = Math.round((Date.now() - new Date(t.submittedAt).getTime()) / 60_000);
              const statusLabel = t.status === "queued" ? "排队中" : (phaseLabels[t.currentPhase ?? ""] ?? "进行中");
              const designLine = t.designNote ? `\n  方案要点：${t.designNote.slice(0, 80)}` : "";
              const ctxLine = t.lucasContext ? `\n  背景：${t.lucasContext.slice(0, 60)}` : "";
              return `• [${statusLabel}] ${t.requirement.slice(0, 80)}（${agoMin} 分钟前提交）${designLine}${ctxLine}`;
            });
            appendSystem.push(
              `【当前进行中任务】\n${taskLines.join("\n")}\n\n如对方询问进展，可按上方方案要点告知（非技术语言）；如对方提新需求，正常受理即可。`,
            );
          }
          // 已完成但 Lucas 尚未告知家人的任务
          const pendingAckTasks = allTasks.filter(e => e.status === "completed" && e.lucasAcked === false);
          if (pendingAckTasks.length > 0) {
            const ackLines = pendingAckTasks.map(t => {
              const brief = t.deliveryBrief ?? "功能已实现完成。";
              return `• [${t.id}] ${brief.slice(0, 100)}`;
            });
            appendSystem.push(
              `【待告知家人任务】\n以下任务已完成，但尚未主动告知家人，建议在本次对话中择机告知：\n${ackLines.join("\n")}\n\n告知后请调用 ack_task_delivered 标记已告知（task_id 见括号内）。`,
            );
          }
        } catch { /* 读取失败不影响主流程 */ }
      }

      // ── Andy HEARTBEAT：Lucas 知识投喂注入（按时序，不受语义竞争）──────────────
      // knowledge_injection 由 Lucas.share_with_andy 写入，专供 Andy 消化。
      // 语义搜索 topK=5 名额竞争激烈；直近投喂必须走专用时序通道，不依赖语义召回。
      // 只在 Andy HEARTBEAT 时注入，避免干扰正常设计对话。
      if (agentId === "andy" && /HEARTBEAT/i.test(event.prompt ?? "")) {
        try {
          const sevenDaysAgo = agoCST(7 * 24 * 3600 * 1000);
          const injections = await chromaGet("decisions", {
            "$and": [
              { type:      { "$eq": "knowledge_injection" } },
              { agent:     { "$eq": "andy" } },
              { timestamp: { "$gt": sevenDaysAgo } },
            ],
          });
          if (injections.length > 0) {
            injections.sort((a, b) =>
              String(b.metadata.timestamp ?? "").localeCompare(String(a.metadata.timestamp ?? ""))
            );
            const lines = injections.slice(0, 5).map(r => {
              const ts    = toCST(r.metadata.timestamp as string);
              const topic = r.metadata.topic ? `【${r.metadata.topic}】` : "";
              return `[${ts}]${topic}\n${r.document.slice(0, 500)}`;
            });
            appendSystem.push(
              `【Lucas 知识投喂（最近 7 天，共 ${injections.length} 条）】\n` +
              `以下是 Lucas 主动路由给你的外部知识。请消化并判断是否有值得纳入系统设计的方向，` +
              `有价值的洞察可写入 MEMORY.md 或形成 trigger_development_pipeline 改进提案。\n\n` +
              lines.join("\n\n---\n\n")
            );
          }
        } catch {
          // 检索失败静默处理
        }
      }

      if (prepend.length === 0 && appendSystem.length === 0) return;
      const injectResult: { prependContext?: string; appendSystemContext?: string } = {};
      if (prepend.length > 0) injectResult.prependContext = prepend.join("\n\n");
      if (appendSystem.length > 0) injectResult.appendSystemContext = appendSystem.join("\n\n");

      return injectResult;
    });

    // ━━ 对话写回（agent_end）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    //
    // 对所有 Agent 通用：
    //   - 写入 corpus（每个 Agent 各自的 corpus 文件，从 AGENT_EVOLUTION_CONFIGS 查找）
    //   - 提取 tool_use 调用 → 写 capability-events.jsonl（Layer 3 活跃度 KPI）
    // ── Andy 写操作拦截（基础设施层，不依赖模型记忆遵守）─────────────────────
    // Andy 是方案设计师，不允许直接写文件或修改代码。
    // 所有实现必须通过 trigger_lisa_implementation 交给 Lisa。
    // write / edit 工具完全封锁；exec 工具检测写操作特征。
    api.on("before_tool_call", (event, ctx) => {
      // ── 访客会话工具禁令（基础设施层强制，不依赖模型合规）────────────────────
      // 禁令列表在 config/visitor-restrictions.json 管理。
      // appendSystem 文字说明保留为「告知模型原因」的辅助手段。
      if (ctx.agentId === FRONTEND_AGENT_ID) {
        const { userId } = parseSessionUser(ctx.sessionKey);
        if (userId.startsWith("visitor:") && VISITOR_BLOCKED_TOOLS.has(event.toolName)) {
          return {
            block: true,
            blockReason: "访客会话不允许调用此工具。如有需要，请联系主人开通权限。",
          };
        }
        // 访客可以触发开发流水线，但对涉及系统架构的需求进行 infra guard 检查
        if (userId.startsWith("visitor:") && event.toolName === "trigger_development_pipeline") {
          const params = event.params as Record<string, unknown>;
          const requirement = String(params?.requirement ?? "");
          if (isInfraChange(requirement, "")) {
            return {
              block: true,
              blockReason: "这个需求涉及系统架构或基础设施，需要主人审核后才能开发。我会记录下来转告主人，请他审核后决定是否启动。",
            };
          }
        }
      }

      if (ctx.agentId !== "andy") return;

      // write / edit：封锁写代码，但允许写 Andy 自己的工作域（spec 设计产出）
      if (event.toolName === "write" || event.toolName === "edit") {
        const params = event.params as Record<string, unknown>;
        const filePath = String(params?.path ?? params?.file_path ?? params?.filename ?? "");
        const andyWorkspace = `${process.env.HOME ?? ""}/.openclaw/workspace-andy/`;
        // 允许写 Andy 工作域（spec / 设计文档）；封锁所有其他路径
        const resolvedPath = filePath.startsWith("~/")
          ? `${process.env.HOME ?? ""}/${filePath.slice(2)}`
          : filePath;
        if (resolvedPath.startsWith(andyWorkspace)) {
          return; // 放行：Andy 写自己的 workspace（spec 等设计产出）
        }
        return {
          block: true,
          blockReason: "Andy 不允许直接写项目代码或非工作域文件。实现任务必须通过 trigger_lisa_implementation 交给 Lisa。",
        };
      }

      // exec：检测命令里的写操作特征
      if (event.toolName === "exec") {
        const cmd = String(
          (event.params as Record<string, unknown>)?.command ??
          (event.params as Record<string, unknown>)?.cmd ??
          ""
        );
        const WRITE_PATTERNS: RegExp[] = [
          /(?<![<>\d])>(?!=)/,           // > 重定向（排除 >>、=> 和 2>/dev/null 类数字fd重定向）
          />>/,                          // >> 追加
          /\btee\b/,                     // tee 写文件
          /\bsed\s+(-[a-zA-Z]*i|-i)/,   // sed -i 原地编辑
          /\bawk\s+(-[a-zA-Z]*i|-i)/,   // awk -i 原地编辑
          /writeFileSync\b/,             // Node.js 同步写
          /writeFile\b/,                 // Node.js 异步写
          /fs\.write\b/,                 // fs.write
          /\.write\s*\(/,                // stream.write
          /open\s*\(.*['"](w|a|r\+|w\+|wb|ab)['"]/,  // Python 写模式
        ];
        const matched = WRITE_PATTERNS.find(p => p.test(cmd));
        if (matched) {
          return {
            block: true,
            blockReason: `Andy 不允许通过 exec 写文件（检测到写操作）。请通过 trigger_lisa_implementation 把实现任务交给 Lisa。\n命令片段：${cmd.slice(0, 120)}`,
          };
        }
      }
    });

    // Lucas 额外：写入记忆文件（跨会话记忆积累）
    // 从 messages 提取最后一对 user/assistant 消息，覆盖整个 tool-calling 中间过程。

    api.on("agent_end", (event, ctx) => {
      // ── Gateway 资源池：释放槽位（无论成功/失败都要释放）─────────────────
      const semKey = ctx.sessionKey ?? `${ctx.agentId}:no-session`;
      const sem = sessionSem.get(semKey);
      if (sem) {
        clearTimeout(sessionSemTimer.get(semKey));
        sem.release();
        sessionSem.delete(semKey);
        sessionSemTimer.delete(semKey);
      }

      // agent_end 调试日志：保留最近 200 条，供排障用
      const DEBUG_LOG_FILE = join(PROJECT_ROOT, "data/learning/agent-end-debug.jsonl");
      const MAX_DEBUG_ENTRIES = 200;
      appendJsonl(DEBUG_LOG_FILE, {
        t: nowCST(),
        agentId: ctx.agentId,
        sessionKey: ctx.sessionKey,
        success: event.success,
        msgCount: event.messages?.length,
        sample: JSON.stringify(event.messages?.slice(-2)).slice(0, 400),
      });
      // 超过上限时截断，防止无限增长
      const debugEntries = readJsonlEntries(DEBUG_LOG_FILE);
      if (debugEntries.length > MAX_DEBUG_ENTRIES) {
        writeJsonlEntries(DEBUG_LOG_FILE, debugEntries.slice(-MAX_DEBUG_ENTRIES));
      }

      // 查找当前 Agent 的进化配置（Lucas/Andy/Lisa 均有）
      // 子 Agent（成员分身 / 设计小弟 / 实现小弟）没有独立配置，但语料归入父 Agent corpus
      let config = AGENT_EVOLUTION_CONFIGS.find((c) => c.agentId === ctx.agentId);
      if (!config) {
        // 尝试从 registry 找父 Agent，将语料归入父 Agent corpus
        const subRec = new AgentRegistry(join(PROJECT_ROOT, "data/agents/registry.json")).getAgent(ctx.agentId);
        if (subRec?.parentAgentId) {
          config = AGENT_EVOLUTION_CONFIGS.find((c) => c.agentId === subRec.parentAgentId);
        }
      }
      if (!config) return;
      if (!event.success) return;

      const { userId, isGroup } = parseSessionUser(ctx.sessionKey);

      // L3 扩展成员：访客会话结束时，标记已注入的 pipeline 结果为 surfaced
      // 防止下次会话重复告知；同时更新 lastInteractionAt（供 dormant 检测使用）
      if (userId.startsWith("visitor:") && ctx.agentId === FRONTEND_AGENT_ID) {
        const vToken = userId.slice("visitor:".length);
        markVisitorResultsSurfaced(vToken);
        // 更新 lastInteractionAt（watchdog dormant 检测依赖此字段）
        try {
          const regPath = join(PROJECT_ROOT, "data", "visitor-registry.json");
          if (existsSync(regPath)) {
            const reg = JSON.parse(readFileSync(regPath, "utf8"));
            const key = Object.keys(reg).find(k => k.toUpperCase() === vToken.toUpperCase());
            if (key && reg[key] && reg[key].status !== "archived") {
              reg[key].lastInteractionAt = Date.now();
              writeFileSync(regPath, JSON.stringify(reg, null, 2), "utf8");
            }
          }
        } catch { /* 静默，不影响主流程 */ }
      }

      // content 可能是字符串或 [{type:"text",text:"..."}] 数组，统一提取
      function extractText(content: unknown): string {
        if (typeof content === "string") return content;
        if (Array.isArray(content)) {
          return (content as Array<{ type?: string; text?: string }>)
            .filter((b) => b?.type === "text")
            .map((b) => b.text ?? "")
            .join("");
        }
        return "";
      }

      const msgs = event.messages as Array<{ role?: string; content?: unknown }>;
      let lastUser = "";
      let lastAssistant = "";

      // Layer 3：提取本次对话中所有工具调用（名称 + 计数）
      // OpenClaw 格式：{role:"toolResult", toolName:"...", toolCallId:"...", content:[...]}
      // toolName 直接记录了被调用的工具名，无需在 assistant content 里找 tool_use block
      const toolUseCounts: Record<string, number> = {};
      const sendMessageContents: string[] = [];   // send_message 实际发出的内容（供 DPO 检测）
      const pipelineResults: string[] = [];       // trigger_development_pipeline 返回内容（供 DPO 检测）
      for (const m of msgs) {
        if (m.role === "user") {
          const t = extractText(m.content);
          if (t) lastUser = t;
        } else if (m.role === "assistant") {
          const t = extractText(m.content);
          if (t) lastAssistant = t;
          // 提取 send_message 工具调用的 content 参数（false commitment 可能在这里，不在 lastAssistant）
          if (Array.isArray(m.content)) {
            for (const block of m.content as Array<{ type?: string; name?: string; input?: Record<string, unknown> }>) {
              if (block.type === "tool_use" && block.name === "send_message" && block.input?.content) {
                sendMessageContents.push(String(block.input.content));
              }
            }
          }
        } else if (m.role === "toolResult") {
          const name = (m as { toolName?: string }).toolName;
          if (name) toolUseCounts[name] = (toolUseCounts[name] ?? 0) + 1;
          // 记录 pipeline 工具返回内容（检测「返回⚠️但声称成功」模式）
          if (name === "trigger_development_pipeline") {
            const resultText = extractText((m as { content?: unknown }).content);
            if (resultText) pipelineResults.push(resultText);
          }
        }
      }

      // ── Layer 3：写 capability-events（有工具调用时）────────────────
      const totalToolCalls = Object.values(toolUseCounts).reduce((s, n) => s + n, 0);
      if (totalToolCalls > 0) {
        appendJsonl(config.capabilityEventsFile, {
          timestamp: nowCST(),
          agentId: ctx.agentId,
          sessionKey: ctx.sessionKey,
          userId,
          requestContext: sessionPrompt.get(ctx.sessionKey ?? "")?.slice(0, 200) || undefined,
          intent: sessionIntent.get(ctx.sessionKey ?? ""),
          toolCalls: toolUseCounts,       // { "trigger_development_pipeline": 1, ... }
          totalToolCalls,
          success: event.success,
        });
        // 同步到 ChromaDB capabilities 集合（三维诊断框架语义查询用）
        for (const [toolName, callCount] of Object.entries(toolUseCounts)) {
          void syncCapabilityToChroma({
            agentId: ctx.agentId,
            toolName,
            callCount,
            success: event.success,
          });
        }
      }

      // ── 三维诊断触发（每 50 次请求或 24h）─────────────────────────────
      diagnosticRequestCounter++;
      const shouldRunDiagnostic = diagnosticRequestCounter >= DIAGNOSTIC_MIN_REQUESTS
        || (Date.now() - lastDiagnosticAt) >= DIAGNOSTIC_INTERVAL_MS;
      if (shouldRunDiagnostic) {
        void runDiagnostic().catch(() => {});
      }

      // ── Axis 2 信号采集：对话参与深度 ─────────────────────────────────
      // 记录每次对话的工具调用数 + 消息轮次，供反思引擎分析趋势
      appendJsonl(DIALOGUE_DEPTH_FILE, {
        timestamp: nowCST(),
        agentId: ctx.agentId,
        userId,
        messageCount: msgs.length,
        toolCallCount: totalToolCalls,
        intent: sessionIntent.get(ctx.sessionKey ?? "") ?? null,
      });

      // ── Axis 2 反思引擎触发（与三维诊断独立计数）────────────────────
      reflectionRequestCounter++;
      const shouldRunReflection = reflectionRequestCounter >= REFLECTION_MIN_REQUESTS
        || (Date.now() - lastReflectionAt) >= REFLECTION_INTERVAL_MS;
      if (shouldRunReflection) {
        void runReflectionEngine().catch(() => {});
      }

      if (!lastUser || !lastAssistant) return;

      // 真实用户消息：优先用 before_prompt_build 保存的原始 event.prompt，
      // 没有时才 fallback 到 lastUser（兼容未走 before_prompt_build 的场景）
      const actualPrompt = sessionPrompt.get(ctx.sessionKey ?? "") || lastUser;
      sessionPrompt.delete(ctx.sessionKey ?? "");

      // ── 人工干预：连续失败告警（前台 Agent 专属）──────────────────────────
      if (ctx.agentId === FRONTEND_AGENT_ID) {
        void checkAndAlertFailure({
          agentId: FRONTEND_AGENT_ID,
          success: event.success,
          response: lastAssistant,
          channelPushUrl: CHANNEL_PUSH_URL,
        });
      }

      // ── ChromaDB 容量检查（每日，触发条件：三维诊断 or 24h 间隔）────
      void checkChromaCapacity().catch(() => {});

      // ── 子 Agent Tier corpus FIFO 配额（非 base agent）──────────────────
      // base agents (lucas/andy/lisa) 不受 Tier 约束；子 Agent 按 Tier 限制截断
      if (!["lucas", "andy", "lisa", "main"].includes(ctx.agentId)) {
        const registry = new AgentRegistry(join(PROJECT_ROOT, "data/agents/registry.json"));
        const rec = registry.getAgent(ctx.agentId);
        if (rec) {
          enforceSubAgentCorpusQuota(ctx.agentId, rec.tier);
          registry.recordActivity(ctx.agentId);
        }
      }

      // ── 所有 Agent：写入 conversations（对话流水账）────────────────────
      // 测试会话（sessionKey 含 "test" 或 "watchdog"）跳过所有 ChromaDB 写入，防止脏数据污染
      const isTestSession = /test|watchdog/i.test(ctx.sessionKey ?? "");

      // ── 进化信号字段：提前计算，供 writeMemory 使用 ──────────────────
      const isCloudResponse = !lastAssistant.includes(LOCAL_MODEL);
      const qualityScore = evaluateResponseQuality({
        agentId: ctx.agentId,
        prompt: actualPrompt,
        response: lastAssistant,
        isCloud: isCloudResponse,
      });
      // DPO 检测（Lucas 专属，其他 Agent 固定 false）
      const dpoFlagged = ctx.agentId === FRONTEND_AGENT_ID
        ? detectDpoCandidates({
            prompt: actualPrompt,
            response: lastAssistant,
            sendMessageContents,
            pipelineResults,
            toolUseCounts,
            sessionKey: ctx.sessionKey,
            userId,
          })
        : false;

      // 用户纠正信号检测：用户说"你没做/你骗我/这是幻觉"等 → 捕获上一条 bad_response 写入 DPO 候选
      if (ctx.agentId === FRONTEND_AGENT_ID && !isTestSession) {
        detectUserCorrection({
          currentUserMsg: actualPrompt,
          messages: msgs,
          sessionKey: ctx.sessionKey,
          userId,
        });
      }

      // ── 自动结晶信号：Lucas 多工具组合 → skill-candidates（基础设施层，不依赖模型判断）──
      // 触发条件：Lucas 在一次请求中调用了 ≥2 个不同工具（排除纯查询工具 recall_memory）
      // 去重策略：同一 comboKey 在 24h 内只记录一次，防止高频请求撑爆文件
      if (ctx.agentId === FRONTEND_AGENT_ID && !isTestSession) {
        const LOOKUP_ONLY_TOOLS = new Set(["recall_memory", "query_member_profile"]);
        const actionTools = Object.keys(toolUseCounts).filter(t => !LOOKUP_ONLY_TOOLS.has(t));
        if (actionTools.length >= 2) {
          const comboKey = [...actionTools].sort().join("+");
          const skillCandidatesFile = join(PROJECT_ROOT, "data/learning/skill-candidates.jsonl");
          // 24h 去重：读最近记录，同 comboKey 24h 内不重复写
          const existing = readJsonlEntries(skillCandidatesFile);
          const cutoff = Date.now() - 24 * 3_600_000;
          const recentDup = existing.some((e: Record<string, unknown>) =>
            e.source === "auto_detect" &&
            e.pattern_name === `工具组合：${comboKey}` &&
            typeof e.timestamp === "string" &&
            new Date(e.timestamp).getTime() > cutoff
          );
          if (!recentDup) {
            appendJsonl(skillCandidatesFile, {
              timestamp: nowCST(),
              source: "auto_detect",
              pattern_name: `工具组合：${comboKey}`,
              description: `Lucas 在一次对话中调用了 ${actionTools.length} 个工具（${comboKey}）。触发内容：${actualPrompt.slice(0, 120)}`,
              tool_combo: toolUseCounts,
              suggested_form: "unknown",
              status: "pending",
            });
          }
        }
      }

      // ── Lisa edit-tool 路径 codebase_observation ──────────────────────────────
      // Lisa 有时选择直接用 edit/write 工具而非 run_opencode（工程判断）。
      // run_opencode 路径由 proc.on("close") 写入；edit 路径没有此钩子，在 agent_end 补写。
      if (ctx.agentId === "lisa" && !isTestSession) {
        const usedEditTools = (toolUseCounts["edit"] ?? 0) + (toolUseCounts["write"] ?? 0) > 0;
        const usedOpencode  = (toolUseCounts["run_opencode"] ?? 0) > 0;
        if (usedEditTools && !usedOpencode) {
          void (async () => {
            try {
              const { execSync: execSyncLocal } = require("child_process") as typeof import("child_process");
              const actualFiles = (() => {
                try {
                  const out = (execSyncLocal as (c: string, o: object) => Buffer)(
                    "git diff --name-only HEAD", { cwd: PROJECT_ROOT, timeout: 8_000 },
                  ).toString().trim();
                  return out ? out.split("\n").filter(Boolean) : [];
                } catch { return [] as string[]; }
              })();
              const docLines = [
                `edit 工具直接实现（Lisa 工程判断，未走 opencode）`,
                `实际变更：${actualFiles.length > 0 ? actualFiles.slice(0, 6).join("、") : "无"}`,
                `任务：${lastAssistant.slice(0, 200)}`,
              ];
              const document = docLines.join("；");
              const obsId = `codebase-obs-edit-${Date.now()}`;
              const embedding = await embedText(document);
              await chromaUpsert("codebase_patterns", obsId, document, {
                timestamp:    nowCST(),
                exitCode:     0,
                success:      true,
                matchRate:    -1,           // -1 标识 edit 路径，无 spec 吻合率比较
                filesChanged: actualFiles.slice(0, 8).join(","),
                specFiles:    "",
                sessionId:    ctx.sessionKey ?? "",
                source:       "edit_tool",
              }, embedding);
            } catch { /* 写入失败不影响主流程 */ }
          })();
        }
      }

      if (!isTestSession) {
        const modelInfo = sessionModel.get(ctx.sessionKey ?? "");
        // channel / fromType 按 Agent 和来源推断
        const convChannel  = ctx.agentId === FRONTEND_AGENT_ID ? (isGroup ? `${CHANNEL_NAME}_group` : `${CHANNEL_NAME}_private`)
          : ctx.agentId === "main"  ? `${CHANNEL_NAME}_private`
          : "pipeline";
        const convFromType: "human" | "agent" = (ctx.agentId === FRONTEND_AGENT_ID || ctx.agentId === "main")
          ? "human" : "agent";
        // 前台Agent/Main 的 fromId 是用户 userId；Andy/Lisa 的 fromId 是调用方 Agent（sessionKey 前缀）
        // 访客 fromId 优先用真实姓名（跨 token 轮换后历史仍可通过 fromId===visitorName 路径检索）
        let convFromId: string;
        if (ctx.agentId === FRONTEND_AGENT_ID || ctx.agentId === "main") {
          if (userId.startsWith("visitor:")) {
            const visitTok = userId.replace("visitor:", ""); // 已 lowercase（经 normalizeUserId）
            let visitorName: string | null = null;
            try {
              const regPath = join(PROJECT_ROOT, "data", "visitor-registry.json");
              const reg = JSON.parse(readFileSync(regPath, "utf8")) as Record<string, { name?: string | null; historicalTokens?: string[] }>;
              // 先按主键查（大小写不敏感）
              const mainKey = Object.keys(reg).find(k => k.toLowerCase() === visitTok);
              if (mainKey && reg[mainKey].name) {
                visitorName = reg[mainKey].name!;
              } else {
                // 再按 historicalTokens 查，token 轮换后仍能取到真实姓名
                for (const entry of Object.values(reg)) {
                  if (Array.isArray(entry.historicalTokens) && entry.historicalTokens.some(t => t.toLowerCase() === visitTok) && entry.name) {
                    visitorName = entry.name;
                    break;
                  }
                }
              }
            } catch { /* ignore，fallback 到 token */ }
            convFromId = visitorName ?? `访客${visitTok}`;
          } else {
            convFromId = userId;
          }
        } else {
          convFromId = ctx.sessionKey?.split(":")?.[0] ?? ctx.agentId;
        }
        // pipeline 对话（Andy/Lisa）不写入 conversations，避免污染家人对话语义搜索
        // pipeline 记录已有专属的 agent_interactions 集合
        if (convFromType === "agent") {
          // skip: pipeline call, not a human-agent conversation
        } else {
        // actualPrompt 现在是干净的用户消息（历史对话已通过 messages array 传入，不再拼进 prompt）
        const convPrompt = actualPrompt;
        void writeMemory(convPrompt, lastAssistant, {
          fromId:        convFromId,
          fromType:      convFromType,
          toId:          ctx.agentId,
          toType:        "agent",
          channel:       convChannel,
          modelUsed:     modelInfo?.modelUsed ?? "unknown",
          isCloud:       modelInfo?.isCloud ?? true,
          toolsCalled:   Object.keys(toolUseCounts),
          sessionId:     ctx.sessionKey ?? undefined,
          intent:        sessionIntent.get(ctx.sessionKey ?? "") ?? null,
          qualityScore,
          dpoFlagged,
        });
        // 访客专属影子记忆：同时写入 visitor_shadow_{personId} 独立命名空间
        // personId 跨 token 稳定，换邀请码仍连续积累
        // 文档中用访客真实姓名替代 token，保证可读性与检索清晰度
        if (convFromType !== "agent" && userId.startsWith("visitor:")) {
          const visitTok = userId.replace("visitor:", "");
          try {
            const regPath = join(PROJECT_ROOT, "data", "visitor-registry.json");
            const regData = JSON.parse(readFileSync(regPath, "utf8"));
            // registry key 为大写，userId 经 normalizeUserId 为小写，做 case-insensitive 查找
            const regKey  = Object.keys(regData).find(k => k.toUpperCase() === visitTok.toUpperCase()) ?? visitTok;
            const entry   = regData[regKey] as {
              name?: string | null; personId?: string; conversationCount?: number;
              shadowActive?: boolean; [k: string]: unknown;
            } ?? {};
            const pid     = entry.personId;

            // conversationCount 计数 + 15 轮激活判断
            if (regData[regKey]) {
              const prevCount = (entry.conversationCount ?? 0);
              const newCount  = prevCount + 1;
              entry.conversationCount = newCount;
              regData[regKey] = entry;

              // 首次到达 15 轮阈值：激活影子记忆，触发历史对话回填
              if (pid && newCount === 15 && !entry.shadowActive) {
                entry.shadowActive = true;
                regData[regKey] = entry;
                const { spawn: spawnChild } = require("child_process") as typeof import("child_process");
                const backfillScript = join(PROJECT_ROOT, "scripts", "backfill-shadow-memories.py");
                const proc = spawnChild(
                  "/opt/homebrew/opt/python@3.11/bin/python3.11",
                  [backfillScript, pid],
                  { detached: true, stdio: "ignore" }
                );
                proc.unref();
                logger.info(`[Shadow] 激活访客影子记忆 personId=${pid} name=${entry.name ?? visitTok}`);
              }

              writeFileSync(regPath, JSON.stringify(regData, null, 2));
            }

            // 影子记忆写入：仅 shadowActive 后才写（激活轮次及之后的对话）
            if (pid && entry.shadowActive) {
              // fromId 用真实姓名（有名用名，无名回退 token），文档可读
              const shadowFromId = (entry.name as string | null | undefined) ?? visitTok;
              void writeMemory(convPrompt, lastAssistant, {
                fromId:      shadowFromId,
                fromType:    "visitor",
                toId:        ctx.agentId,
                toType:      "agent",
                channel:     convChannel,
                modelUsed:   modelInfo?.modelUsed ?? "unknown",
                isCloud:     modelInfo?.isCloud ?? true,
                toolsCalled: Object.keys(toolUseCounts),
                sessionId:   ctx.sessionKey ?? undefined,
                intent:      sessionIntent.get(ctx.sessionKey ?? "") ?? null,
                qualityScore,
                dpoFlagged,
              }, `visitor_shadow_${pid}`);
            }
          } catch { /* 影子记忆写入失败，静默忽略 */ }
        }
        } // end else (human conversation)
      }

      // ── 前台 Agent 专属：行为规律 + 家庭知识 ──────────────────────────────
      // （DPO 检测已在上方提前执行，此处不再重复调用）
      if (ctx.agentId === FRONTEND_AGENT_ID) {
        const cleanPrompt = actualPrompt;  // 历史前缀已移除，prompt 本身即干净消息
        // 只对真实家庭成员写行为规律和家庭知识。
        // 过滤条件（满足任意一条则跳过）：
        //   - userId 含 ":"（TUI/系统会话，如 "agent:lucas:main"）
        //   - userId 是 "system-scheduler"（定时主动循环，不是真实家庭成员）
        //   - userId 是 UUID 格式（内部验收任务注入）
        const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const isRealFamilyMember = !isTestSession
          && !userId.includes(":")
          && userId !== "system-scheduler"
          && !UUID_RE.test(userId)
          && userId.length > 0;
        if (isRealFamilyMember) {
          void writeBehaviorPattern({ userId, prompt: cleanPrompt, response: lastAssistant });
          void writeFamilyKnowledge({ userId, prompt: cleanPrompt, response: lastAssistant });
          // 家人档案动态更新：提取本次对话要点，更新「当前状态」和「重要记忆」
          void updateFamilyProfileAsync(userId, cleanPrompt, lastAssistant);
        }

        // ── 事件驱动增量蒸馏（感知侧）──────────────────────────────────────
        // 家庭成员或访客每次对话后触发，30 分钟冷却防重复。
        // distill-memories.py 内部有 delta_trig 阈值，新记录不足时自动跳过。
        const isVisitorUser = userId.startsWith("visitor:");
        if ((isRealFamilyMember || isVisitorUser) && !isTestSession) {
          const now = Date.now();
          const lastTs = lastDistillTrigger.get(userId) ?? 0;
          if (now - lastTs >= DISTILL_COOLDOWN_MS) {
            lastDistillTrigger.set(userId, now);
            const distillScript = join(PROJECT_ROOT, "scripts/distill-memories.py");
            const proc = spawn(KUZU_PYTHON3_BIN, [distillScript, "--user", userId], {
              detached: true,
              stdio:    "ignore",
            });
            proc.unref();
          }

          // ── 活跃话题线索蒸馏（6h 冷却）──────────────────────────────────
          // distill-active-threads.py 提取最近 7 天对话中的活跃 thread，写入 Kuzu active_thread Fact 边
          // 老化机制：valid_until = today + 45d，超期自动不注入，不需要额外清理
          const lastAtTs = lastActiveThreadDistillTrigger.get(userId) ?? 0;
          if (now - lastAtTs >= ACTIVE_THREAD_DISTILL_COOLDOWN_MS) {
            lastActiveThreadDistillTrigger.set(userId, now);
            const atScript = join(PROJECT_ROOT, "scripts/distill-active-threads.py");
            const atProc = spawn(KUZU_PYTHON3_BIN, [atScript, "--user", userId], {
              detached: true,
              stdio:    "ignore",
            });
            atProc.unref();
          }
        }
      }

      // ── Layer 2 质量评估 → 微调队列 ──────────────────────────────────
      // qualityScore 已在上方计算（进化信号字段区域）
      if (qualityScore >= FINETUNE_THRESHOLD) {
        enqueueForFinetune({
          agentId: ctx.agentId,
          prompt: actualPrompt,
          response: lastAssistant,
          score: qualityScore,
        });
      }

      // ── 所有 Agent：写入 corpus（微调语料 + DPO 原料）──────────────
      appendJsonl(config.corpusFile, {
        timestamp: nowCST(),
        role: ctx.agentId,
        prompt: actualPrompt,
        response: lastAssistant,
        userId,
        intent: sessionIntent.get(ctx.sessionKey ?? ""),
        totalToolCalls,
      });

      // ── Lucas 事件驱动积压排干（补充 off-peak 定时机制）──────────────────────
      //
      // 当前 off-peak 定时器（22:00-08:00，每 30 分钟）只在空闲时段处理积压任务。
      // 系统负载不高时，白天对话结束后也可以主动排干队列，提升资源利用率。
      //
      // 触发条件（同时满足）：
      //   1. Lucas 真实家庭对话（非访客、非测试）
      //   2. task-queue.jsonl 有积压任务
      //   3. task-registry 无 running 任务（Andy/Lisa 当前空闲）
      //   4. 6h 全局冷却未超时（防止每轮对话都触发）
      if (ctx.agentId === FRONTEND_AGENT_ID && !isTestSession && !userId.startsWith("visitor:")) {
        const nowTs = Date.now();
        if (nowTs - lastProactiveDispatchAt >= PROACTIVE_DISPATCH_COOLDOWN_MS) {
          void (async () => {
            try {
              if (!existsSync(TASK_QUEUE_FILE)) return;
              const queuedTasks = readJsonlEntries(TASK_QUEUE_FILE);
              if (queuedTasks.length === 0) return;
              // 检查负载：有 running 任务时不抢占（Andy/Lisa 正在工作）
              const activeTasks = readTaskRegistry().filter(t => t.status === "running");
              if (activeTasks.length > 0) return;
              // 条件满足：立即排干队列，不等 22:00
              lastProactiveDispatchAt = nowTs;
              writeFileSync(TASK_QUEUE_FILE, "", "utf8");
              logger.info(`[Dispatch] 主动排干任务队列：${queuedTasks.length} 个任务，系统空闲，由对话结束触发`);
              void notifyEngineer(
                `🚀 [主动调度] Lucas 对话结束，发现 ${queuedTasks.length} 个积压任务，系统空闲，主动启动处理（6h 冷却）`
              );
              queuedTasks.forEach((task, i) => {
                setTimeout(() => {
                  runAndyPipeline({
                    requirement: (task as { requirement: string }).requirement,
                    intentType:  ((task as { intentType?: string }).intentType) ?? "develop_feature",
                    wecomUserId: ((task as { wecomUserId?: string }).wecomUserId) ?? "unknown",
                    originalSymptom: ((task as { originalSymptom?: string }).originalSymptom) ?? (task as { requirement: string }).requirement,
                  }).catch(() => {});
                }, i * 2 * 60 * 1000); // 每任务间隔 2 分钟，避免并发雪崩
              });
            } catch { /* 静默，不影响主流程 */ }
          })();
        }
      }
    });

    // ━━ Layer 1：trigger_development_pipeline（Lucas 专属）━━━━━━━━━━━

    api.registerTool((toolCtx) => ({
      label: "触发开发流水线",
      name: "trigger_development_pipeline",
      description: [
        "【最后手段】仅在确认 OpenClaw 本地 Skill 和 Clawhub 生态均无现成方案后，才调用此工具。",
        "调用前必须已经：1) 用 exec 跑过 `openclaw skills list` 确认无可用 Skill；2) 用 `clawhub search` 搜索过无合适结果。",
        "",
        "【调度决策框架】触发前请先查任务状态（task-registry.json），判断：",
        "  - Andy 是否空闲（无 running 任务）",
        "  - Lisa 队列深度（running + queued 任务数）",
        "  - 访客任务 vs 家人任务：访客需求排在家人需求之后，不抢占资源",
        "  - 当前系统繁忙（Lisa ≥3 个任务在跑）时，优先告知访客排队而非立即触发",
        "  - 当前系统空闲时，可正常触发流水线",
        "",
        "【需求 Scoping】在触发前，主动向用户澄清：",
        "  - 做什么用的（背景和目标）",
        "  - 有没有参考样式或已有想法",
        "  - 优先级和时间要求",
        "  把模糊的「帮我做个网页」澄清成具体需求再触发，减少 Andy 猜错方向的概率。",
        "",
        "适用场景（仅限确认无现成工具后）：",
        "  - 开发新功能、搭建系统、实现自动化",
        "  - 修复 bug、修复报错",
        "  - 重构代码、优化性能",
        "  - 每天/每周自动推送报告",
        "普通聊天、问候、询问状态等不要调用此工具。",
      ].join("\n"),
      parameters: Type.Object({
        requirement: Type.String({
          description: "用户的完整开发需求，保持原始表达，不要缩略",
        }),
        intent_type: Type.Optional(
          Type.String({
            description: "意图类型：develop_feature / bug_fix / refactor / optimize / update_doc",
          }),
        ),
        urgent: Type.Optional(
          Type.Boolean({
            description: "是否立即执行。true = 立刻提交（今天就要，或 bug 修复）；false（默认）= 加入空闲队列，在晚上系统空闲时自动启动，不占白天通道资源。家人没有明确说今天要，默认 false。",
          }),
        ),
        context: Type.Optional(
          Type.String({
            description: "需求背景补充（可选但重要）：家人的情绪状态、时间敏感度、可接受的替代方案、上次不满意的点等。Andy 设计时优先参考。例：「爸爸说不急但下周要用」「小姨很在意这个，上次方案太复杂她不喜欢」「如果做不了完整版，简化版也行」",
          }),
        ),
        visitorCode: Type.Optional(
          Type.String({
            description: "访客邀请码（访客触发任务时传入，用于前端 API 过滤查看）",
          }),
        ),
      }),

      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        // 仅前台 Agent 可调用；Andy/Lisa 误调时返回错误，防止循环
        if (toolCtx.agentId && toolCtx.agentId !== FRONTEND_AGENT_ID) {
          return {
            content: [{ type: "text", text: `❌ trigger_development_pipeline 是前台 Agent 专属工具，${toolCtx.agentId} 不应调用。Andy 应使用：research_task → trigger_lisa_implementation。` }],
            details: { error: "wrong_agent" },
          };
        }

        const wecomUserId =
          toolCtx.requesterSenderId ??
          parseSessionUser(toolCtx.sessionKey).userId ??
          "unknown";
        const intentType = (params as { intent_type?: string }).intent_type ?? "develop_feature";
        const req = (params as { requirement: string }).requirement;
        const urgent = (params as { urgent?: boolean }).urgent ?? false;
        const lucasContext = (params as { context?: string }).context;
        const visitorCode = (params as { visitorCode?: string }).visitorCode;

        // 用 Lucas 模型确认的真实 intentType 覆盖 before_prompt_build 的推断值
        sessionIntent.set(toolCtx.sessionKey ?? "", intentType);

        // 在途任务去重：检查 task-registry 里是否已有相似的 running/queued 任务
        // 防止 Gateway 重启后 Lucas 重复提交同一需求导致多个 running 任务
        if (!req.includes("忽略重复检查")) {
          const inflight = readTaskRegistry()
            .filter(e => e.status === "running" || e.status === "queued")
            .map(e => ({ e, score: bigramScore(req, e.requirement) }))
            .filter(s => s.score >= 3)
            .sort((a, b) => b.score - a.score)
            .slice(0, 1);

          if (inflight.length > 0) {
            const found = inflight[0].e;
            const statusLabel = found.status === "running" ? "进行中" : "排队中";
            return {
              content: [{ type: "text", text: `⚠️ 已有相似需求正在${statusLabel}（${found.id}，提交于 ${found.submittedAt.slice(0, 16).replace("T", " ")}）：\n${found.requirement.slice(0, 100)}…\n\n如需叫停原任务并重新提交，请先调 cancel_task，task_id="${found.id}"，再重新发起；如需强制新建，请在需求中注明"忽略重复检查"。` }],
              details: { duplicate_task_id: found.id, decision: "blocked_duplicate" },
            };
          }
        }

        // 系统负载感知：检查 Lisa 队列深度和 Andy 状态
        const entries = readTaskRegistry();
        const runningCount = entries.filter(e => e.status === "running").length;
        const queuedCount  = entries.filter(e => e.status === "queued").length;
        const andyBusy    = runningCount > 0;
        const lisaLoaded  = (runningCount + queuedCount) >= 3;

        // 非紧急访客任务 + 系统繁忙时：返回询问而非直接提交
        // 让 Lucas 自己去判断：告诉访客排队，还是占用当前空闲资源
        if (!urgent && (lisaLoaded || andyBusy)) {
          const visitorTask = wecomUserId.startsWith("visitor:");
          if (visitorTask) {
            const queuePos = queuedCount + 1;
            return {
              content: [{
                type: "text",
                text: `当前系统资源状态：Andy ${andyBusy ? "正在处理任务" : "空闲"}，Lisa 队列 ${runningCount} 个运行中 + ${queuedCount} 个排队中（共 ${runningCount + queuedCount} 个任务）。\n\n访客需求的建议处理方式：\n  1. 【立即触发】当前系统相对空闲（Andy 可用），现在启动访客体验更好，但可能需要等待 ${Math.ceil((runningCount + queuedCount) * 0.5)} 小时\n  2. 【加入队列】排在第 ${queuePos} 位，等当前任务陆续完成后自动启动，访客会收到通知\n\n请判断哪种方式更适合当前访客的需求，并向访客说明情况，让访客选择。`
              }],
              details: { decision: "load_check", andyBusy, lisaLoaded, runningCount, queuedCount },
            };
          } else {
            // 家人任务：非拦截，仅注入负载感知提示，Lucas 自行决定是否提交
            return {
              content: [{
                type: "text",
                text: `ℹ️ 当前系统负载：Andy ${andyBusy ? "正在处理任务" : "空闲"}，Lisa 队列 ${runningCount} 个运行中 + ${queuedCount} 个排队中。\n\n家人的任务优先级高于访客，可以直接提交；如果需求不紧急，也可以告知家人「稍等一下，当前有其他任务在处理」。\n\n请告知家人当前系统状态，由你判断是否立即提交。`,
              }],
              details: { decision: "load_hint_family", andyBusy, lisaLoaded, runningCount, queuedCount },
            };
          }
        }

        // 能力自查：检查 capability-registry 是否已有类似能力，避免重复开发
        // 用户在需求中注明"重新开发"时跳过此检查
        if (!req.includes("重新开发") && !req.includes("忽略重复检查")) {
          const capRegistry = readJsonlEntries(join(PROJECT_ROOT, "data/corpus/capability-registry.jsonl"));
          const similar = capRegistry
            .filter(e => e.status === "active" && !e.dormant && typeof e.requirement === "string")
            .map(e => ({ e, score: bigramScore(req, e.requirement as string) }))
            .filter(s => s.score >= 3)
            .sort((a, b) => b.score - a.score)
            .slice(0, 1);

          if (similar.length > 0) {
            const found = similar[0].e;
            return {
              content: [{ type: "text", text: `⚠️ 发现已有类似能力（创建于 ${(found.timestamp as string).slice(0, 10)}）：${found.requirement as string}。如需复用，请告知用户在 app/generated/ 目录查找；如确实需要重新开发，请在需求中注明"重新开发"再发起。` }],
              details: { existing_capability: found.requirement, decision: "awaiting_clarification" },
            };
          }
        }

        // Skills 预检：本地 Skill 匹配 → 软拦截，避免为已有 Skill 覆盖的能力开发新功能
        // 用户在需求中注明"忽略Skill检查"时跳过
        if (!req.includes("忽略Skill检查") && !req.includes("忽略重复检查")) {
          try {
            const skillsDir = join(homedir(), ".openclaw", "workspace-lucas", "skills");
            const skillEntries: { name: string; description: string }[] = [];
            if (existsSync(skillsDir)) {
              for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
                if (!entry.isDirectory()) continue;
                const skillMd = join(skillsDir, entry.name, "SKILL.md");
                if (!existsSync(skillMd)) continue;
                const raw = readFileSync(skillMd, "utf8");
                // 提取 YAML frontmatter 里的 name 和 description
                const nameMatch   = raw.match(/^name:\s*(.+)$/m);
                const descMatch   = raw.match(/^description:\s*(.+)$/m);
                if (nameMatch && descMatch) {
                  skillEntries.push({ name: nameMatch[1].trim(), description: descMatch[1].trim() });
                }
              }
            }
            const matched = skillEntries
              .map(s => ({ s, score: bigramScore(req, s.name + " " + s.description) }))
              .filter(x => x.score >= 2)
              .sort((a, b) => b.score - a.score)
              .slice(0, 1);
            if (matched.length > 0) {
              const sk = matched[0].s;
              return {
                content: [{ type: "text", text: `⚠️ 发现已有 Skill「${sk.name}」可能满足这个需求：${sk.description}。\n\n建议先告知家人试用这个 Skill，看能否满足需要。\n如确认现有 Skill 不够用、需要开发新功能，请在需求中注明"忽略Skill检查"重新提交。` }],
                details: { existing_skill: sk.name, decision: "awaiting_skill_confirmation" },
              };
            }
          } catch {
            // 读取失败不阻断开发流程
          }
        }

        // 调度决策：非紧急 + 当前在白天 → 写入延迟队列
        const nowHour = new Date().getHours();
        const isOffPeak = nowHour >= OFF_PEAK_START || nowHour < OFF_PEAK_END;
        if (!urgent && !isOffPeak) {
          const queuedId = `queued_${Date.now()}`;
          appendJsonl(TASK_QUEUE_FILE, {
            timestamp: nowCST(),
            requirement: req,
            intentType,
            wecomUserId,
            taskId: queuedId,
            originalSymptom: req,  // 保留用户原始表达，dequeue 时传给 runAndyPipeline
          });
          upsertTaskRegistry({
            id: queuedId,
            requirement: req,
            submittedBy: wecomUserId,
            submittedAt: nowCST(),
            status: "queued",
            ...(lucasContext ? { lucasContext } : {}),
            ...(visitorCode ? { visitorCode } : {}),
          });
          return {
            content: [{ type: "text", text: `📋 需求已加入空闲队列（ID: ${queuedId}），将在今晚 ${OFF_PEAK_START}:00 后自动启动，不占白天通道资源。` }],
            details: { queued: true, userId: wecomUserId, taskId: queuedId },
          };
        }

        runAndyPipeline({
          requirement: req,
          intentType,
          wecomUserId,
          originalSymptom: req,  // 用户原始表达作为独立字段，evaluator 验证根因时使用
          ...(lucasContext ? { lucasContext } : {}),
          ...(visitorCode ? { visitorCode } : {}),
        }).catch(() => {});

        return {
          content: [{ type: "text", text: "✅ 需求已提交给开发团队（Andy → Lisa），完成后我会通知你进展。" }],
          details: { submitted: true, userId: wecomUserId },
        };
      },
    }));

    // ━━ Layer 1：report_bug（Lucas 专属，Bug 修复直触 Lisa）━━━━━━━━━━━

    api.registerTool((toolCtx) => ({
      label: "提交 Bug 修复",
      name: "report_bug",
      description: [
        "Lucas 专属：Bug 修复专用工具，跳过 Andy 直接触发 Lisa 修复。",
        "适用场景：问题位置已知的 Bug（接口报错、逻辑错误、返回值不对）。",
        "不适用：新功能开发、重构、需要架构设计的改动 → 改用 trigger_development_pipeline。",
        "需提供：症状描述 + 涉及文件 + 可观测的验收标准。",
      ].join("\n"),
      parameters: Type.Object({
        symptom: Type.String({
          description: "Bug 现象：调用什么、返回什么、预期是什么（一句话）",
        }),
        file: Type.String({
          description: "涉及文件的相对路径（相对于 HomeAI 根目录），如 app/generated/homework/server.js",
        }),
        acceptance: Type.String({
          description: "可观测的验收标准，如「调用 GET /api/x 返回 HTTP 200」",
        }),
        location_hint: Type.Optional(
          Type.String({ description: "代码位置提示（函数名、路由路径等），帮助 Lisa 快速定位" }),
        ),
        bug_id: Type.Optional(
          Type.String({ description: "Bug 编号（可选，不填自动生成）" }),
        ),
      }),

      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        // 仅前台 Agent 可调用
        if (toolCtx.agentId && toolCtx.agentId !== FRONTEND_AGENT_ID) {
          return {
            content: [{ type: "text", text: `❌ report_bug 是前台 Agent 专属工具。` }],
            details: { error: "wrong_agent" },
          };
        }

        const p = params as {
          symptom: string;
          file: string;
          acceptance: string;
          location_hint?: string;
          bug_id?: string;
          visitorCode?: string;
        };

        // 验证：文件存在
        const fullPath = join(PROJECT_ROOT, p.file);
        if (!existsSync(fullPath)) {
          return {
            content: [{ type: "text", text: `❌ 文件不存在：${p.file}\n请检查路径是否正确（相对于 HomeAI 根目录）。` }],
            details: { error: "file_not_found", file: p.file },
          };
        }

        // 验证：验收标准不为空
        if (!p.acceptance.trim()) {
          return {
            content: [{ type: "text", text: "❌ 缺少验收标准（acceptance），请描述修复后的可观测结果。" }],
            details: { error: "missing_acceptance" },
          };
        }

        const bugId = p.bug_id ?? `bug_${Date.now()}`;
        const wecomUserId =
          toolCtx.requesterSenderId ??
          parseSessionUser(toolCtx.sessionKey).userId ??
          "unknown";
        const visitorCode = p.visitorCode;

        // 立即返回给 Lucas，不等 Lisa 完成
        if (wecomUserId && wecomUserId !== "unknown") {
          void pushToChannel(`正在分析 Bug：${p.symptom.slice(0, 60)}...`, wecomUserId, true);
        }

        // 异步执行完整流程：Lisa 分析 → Andy 技术审阅（顺带告知 Lucas 知情）→ Lisa 修复 → Andy 验收 → Lucas 沟通用户
        (async () => {
          try {
            // ── Phase 1：Lisa 只分析，不动手改代码 ──────────────────────────────
            const lisaAnalysisPrompt = [
              `【Bug 分析任务 · ${bugId}】`,
              `症状：${p.symptom}`,
              `文件：${p.file}${p.location_hint ? ` → ${p.location_hint}` : ""}`,
              `验收标准：${p.acceptance}`,
              "",
              "请读文件定位根因，写出分析报告。**此阶段不要修改任何代码**，只输出分析结论：",
              "1. 根因（一句话）",
              "2. 修复方案（具体改哪里、怎么改）",
              "3. 风险评估（low / medium / high，说明理由）",
              "4. 预计影响范围（哪些功能可能受影响）",
            ].join("\n");

            const lisaAnalysis = await callGatewayAgentWithRetry("lisa", lisaAnalysisPrompt, 300_000);

            // ── 监控通知：Phase 1 完成 ───────────────────────────────────────────
            void notifyEngineer([
              `【Bug ${bugId} · Phase 1/4】Lisa 分析完成`,
              `症状：${p.symptom}`,
              ``,
              `━━ Lisa 分析报告 ━━`,
              lisaAnalysis ?? "分析失败",
            ].join("\n"), "pipeline", "lisa");

            // ── Phase 2：Andy 技术审阅，做修复决策，同时生成 Lucas 知情简报 ─────
            // Andy 是技术决策者：确认根因是否准确、方案是否合理、风险是否可接受
            // 顺带输出一份家人语言的情况说明，由插件层转告 Lucas（让 Lucas 知情，能更好与用户沟通）
            const andyReviewPrompt = [
              `【Bug 技术审阅 · ${bugId}】`,
              `Lisa 完成了根因分析，请你审阅并做出技术决策。`,
              "",
              `原始症状：${p.symptom}`,
              `Lisa 分析：\n${(lisaAnalysis ?? "分析失败").slice(0, 800)}`,
              "",
              "请输出：",
              "1. 技术决策：根因是否准确？方案是否合理？（同意 / 需要调整 + 说明）",
              "2. 风险判断：这个修复有没有影响其他模块的风险？",
              "3. 【Lucas 知情简报】（用家人能理解的语言，一到两句）：这个 bug 是什么问题、我们打算怎么修、有没有需要用户注意的事",
              "   格式固定：「Lucas知情：xxx」",
            ].join("\n");

            const andyDecision = await callGatewayAgent("andy", andyReviewPrompt, 120_000);

            // ── 监控通知：Phase 2 完成 ───────────────────────────────────────────
            void notifyEngineer([
              `【Bug ${bugId} · Phase 2/4】Andy 技术审阅`,
              ``,
              `━━ Andy 审阅意见 ━━`,
              andyDecision ?? "审阅失败",
            ].join("\n"), "pipeline", "andy");

            // 插件层提取 Andy 的 Lucas 知情简报，透传给 Lucas（Lucas 知情后自主决定用户沟通时机和方式）
            const lucasBriefMatch = (andyDecision ?? "").match(/Lucas知情[：:]\s*(.+?)(?:\n|$)/);
            const lucasBrief = lucasBriefMatch?.[1]?.trim()
              ?? `Andy 正在处理一个 Bug（${p.symptom.slice(0, 40)}），Lisa 已完成分析，即将修复。`;

            void callGatewayAgent(
              "lucas",
              [
                `【Andy 通报 · ${bugId}】`,
                lucasBrief,
                "",
                `用户 ID：${wecomUserId}`,
                "你现在知道这件事了。根据你对用户当前状态的判断，自主决定是否主动告知用户进展（不是必须推送）。",
              ].join("\n"),
              60_000,
            );

            // ── Phase 3：Lisa 按分析方案修复 ─────────────────────────────────
            const lisaFixPrompt = [
              `【Bug 修复任务 · ${bugId}】`,
              `Andy 已审阅你的分析，请按方案修复。`,
              "",
              `症状：${p.symptom}`,
              `文件：${p.file}${p.location_hint ? ` → ${p.location_hint}` : ""}`,
              `验收标准：${p.acceptance}`,
              "",
              `你的分析结论：\n${(lisaAnalysis ?? "").slice(0, 600)}`,
              `Andy 审阅意见：\n${(andyDecision ?? "").slice(0, 300)}`,
              "",
              "请最小化改动，修复后用验收标准自验证，输出修复报告。",
            ].join("\n");

            const lisaFixResponse = await callGatewayAgentWithRetry("lisa", lisaFixPrompt, 600_000);

            if (lisaFixResponse) {
              // ── 监控通知：Phase 3 完成 ───────────────────────────────────────
              void notifyEngineer([
                `【Bug ${bugId} · Phase 3/4】Lisa 修复完成`,
                ``,
                `━━ Lisa 修复报告 ━━`,
                lisaFixResponse,
              ].join("\n"), "pipeline", "lisa");

              appendJsonl(join(PROJECT_ROOT, "data/corpus/lisa-corpus.jsonl"), {
                timestamp: nowCST(),
                role: "lisa",
                requirement_id: bugId,
                ttl_days: 90,
                spec: lisaFixPrompt,
                implementation: lisaFixResponse,
              });

              void addDecisionMemory({
                decision_id: bugId,
                agent: "lisa",
                timestamp: nowCST(),
                context: `${p.symptom} | 分析：${(lisaAnalysis ?? "").slice(0, 200)}`,
                decision: lisaFixResponse.split("\n").filter(Boolean).slice(0, 2).join(" / "),
                outcome: "delivered",
                outcome_at: nowCST(),
                outcome_note: "Bug fix：Lisa 分析 → Andy 技术审阅 → Lisa 修复",
              } satisfies DecisionRecord);

              // ── Phase 4：Andy 验收，告知 Lucas 结果（Lucas 决定用户沟通方式）──
              // Andy 做技术验收，生成交付简报给 Lucas；Lucas 根据用户情境决定沟通时机和语气
              try {
                const andyVerifyPrompt = [
                  `【Bug 修复验收 · ${bugId}】`,
                  `Lisa 已完成修复，请对照验收标准做技术验收。`,
                  "",
                  `验收标准：${p.acceptance}`,
                  `Lisa 修复报告：\n${lisaFixResponse.slice(0, 600)}`,
                  "",
                  "请输出：",
                  "1. 验收结论：通过 / 部分通过 / 未通过（说明原因）",
                  "2. 【Lucas 交付简报】（家人语言，让 Lucas 告知用户）：",
                  "   - 修了什么（用户能感知的变化）",
                  "   - 需要注意什么（如有）",
                  "   - 下次类似问题可以这样描述（帮 Lucas 更准确传达）",
                  "   格式固定：「Lucas交付：xxx」",
                ].join("\n");

                const andyVerdict = await callGatewayAgent("andy", andyVerifyPrompt, 120_000);

                // 提取 Andy 给 Lucas 的交付简报
                const deliveryBriefMatch = (andyVerdict ?? "").match(/Lucas交付[：:]\s*([\s\S]+?)(?:\n\n|$)/);
                const deliveryBrief = deliveryBriefMatch?.[1]?.trim()
                  ?? lisaFixResponse.split("\n").filter(Boolean).slice(0, 3).join(" ");

                // ── 监控通知：Phase 4 完成 ─────────────────────────────────────
                void notifyEngineer([
                  `【Bug ${bugId} · Phase 4/4】Andy 验收完成`,
                  ``,
                  `━━ Andy 验收结论 ━━`,
                  andyVerdict ?? "验收失败",
                ].join("\n"), "pipeline", "andy");

                // 告知 Lucas 修复完成，Lucas 自主决定沟通时机和方式
                void callGatewayAgent(
                  "lucas",
                  [
                    `【Andy 验收完成 · ${bugId}】`,
                    deliveryBrief,
                    "",
                    `用户 ID：${wecomUserId}`,
                    "修复已完成，根据你对用户当前状态的判断，选择合适的时机和方式告知用户。",
                  ].join("\n"),
                  60_000,
                );
              } catch {
                // 验收失败降级：直接推 Lisa 修复报告给用户
                if (wecomUserId && wecomUserId !== "unknown") {
                  void pushToChannel(lisaFixResponse, wecomUserId, true);
                }
              }
            }
          } catch (e) {
            if (wecomUserId && wecomUserId !== "unknown") {
              const errMsg = (e as Error).message || String(e);
              const isTimeout = errMsg.includes("timeout") || errMsg.includes("aborted");
              const friendlyMsg = isTimeout
                ? `处理超时（Lisa 响应时间过长）`
                : `处理出错（${errMsg.slice(0, 50)}）`;
              const suggestion = isTimeout
                ? "这个 Bug 可能比较复杂，需要更多时间分析。稍后我会重试，或请直接联系系统工程师查看。"
                : "请稍后重试，或联系系统工程师查看日志。";
              void pushToChannel(
                [
                  `【系统通知】Bug 修复任务异常`,
                  `任务：${bugId}`,
                  `问题：${p.symptom.slice(0, 60)}...`,
                  `状态：${friendlyMsg}`,
                  `建议：${suggestion}`,
                ].join("\n"),
                wecomUserId,
                false,
              );
            }
          }
        })().catch(() => {});

        return {
          content: [{ type: "text", text: `✅ Bug 已提交给 Lisa 修复（${bugId}），完成后我会通知你。` }],
          details: { submitted: true, bugId, file: p.file },
        };
      },
    }));

    // ━━ Layer 1：search_web（Lucas 专属，联网搜索）━━━━━━━━━━━━━━━━━━━

    api.registerTool((_toolCtx) => ({
      label: "联网搜索",
      name: "search_web",
      description: [
        "Lucas 专属：联网搜索最新信息（股票行情、货源价格、新闻、产品信息等）。",
        "底层使用 DeepSeek 搜索引擎，支持中文内容，覆盖主流网站和社媒平台（含抖音讨论）。",
        "适用：家人询问实时信息、heartbeat 定时任务需要获取最新数据时。",
      ].join("\n"),
      parameters: Type.Object({
        query: Type.String({ description: "搜索查询词，中文英文均可" }),
        purpose: Type.Optional(Type.String({ description: "搜索目的/背景（可选），帮助生成更准确的摘要" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const p = params as { query: string; purpose?: string };
        if (!DEEPSEEK_API_KEY) {
          return { content: [{ type: "text", text: "❌ 搜索服务未配置（缺少 DEEPSEEK_API_KEY）" }], details: {} };
        }
        try {
          const resp = await fetch("https://api.deepseek.com/chat/completions", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${DEEPSEEK_API_KEY}`,
            },
            body: JSON.stringify({
              model: "deepseek-chat",
              messages: [{ role: "user", content: [
                p.purpose ? `背景：${p.purpose}` : "",
                "请搜索以下内容并给出简洁摘要（400字以内），每条信息附来源链接：",
                "",
                p.query,
              ].filter(Boolean).join("\n") }],
              search: true,
              stream: false,
            }),
            signal: AbortSignal.timeout(60_000),
          });
          if (!resp.ok) {
            return { content: [{ type: "text", text: `搜索失败（HTTP ${resp.status}）` }], details: {} };
          }
          const data = await resp.json() as { choices?: { message?: { content?: string } }[] };
          const result = data.choices?.[0]?.message?.content ?? "未获取到搜索结果";
          return { content: [{ type: "text", text: result }], details: { query: p.query } };
        } catch (err) {
          return { content: [{ type: "text", text: `搜索出错：${err instanceof Error ? err.message : String(err)}` }], details: {} };
        }
      },
    }));

    // ━━ Layer 1：trigger_lisa_implementation（Andy 专属）━━━━━━━━━━━━━

    api.registerTool((toolCtx) => ({
      label: "触发 Lisa 实现",
      name: "trigger_lisa_implementation",
      description: [
        "Andy 完成方案设计后调用，把完整 Implementation Spec 交给 Lisa 实现。",
        "只有 Andy 应该调用此工具。",
        "【调用前提】spec JSON 必须通过三项 infrastructure 验证，否则工具直接 block：",
        "  1. integration_points 所有文件路径真实存在（exists=false → 阻断）",
        "  2. acceptance_criteria 非空（Lisa 凭此写测试存根）",
        "  3. code_evidence 非空（修改现有文件时必填）：列出你用 exec 读过的文件和在该文件中找到的真实符号名。",
        "     格式：[{ \"file\": \"CrewHiveClaw/CrewClaw/crewclaw-routing/index.ts\", \"symbol\": \"callGatewayAgent\" }]",
        "     infrastructure 层会 grep 验证 symbol 确实存在 —— 不读代码就写不出能通过验证的 symbol。",
        "     纯新建文件（integration_points 全是 action:新增）时 code_evidence 可为空数组。",
      ].join("\n"),
      parameters: Type.Object({
        spec: Type.String({
          description: "完整的 Implementation Spec，包含所有文件列表、代码结构、接口定义",
        }),
        user_id: Type.Optional(
          Type.String({ description: "原始请求的用户 ID，用于回推结果" }),
        ),
        requirement_id: Type.Optional(
          Type.String({ description: "需求 ID（来自任务注册表，用于叫停检查）。Lucas trigger_development_pipeline 触发时会在消息头注入【需求 ID: req_xxx】，Andy 把它原样传进来。" }),
        ),
      }),

      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const p = params as { spec: string; user_id?: string; requirement_id?: string };

        // 仅 Andy 可调用；Lucas 误调时返回错误（应走 trigger_development_pipeline 或 report_bug）
        if (toolCtx.agentId && toolCtx.agentId !== "andy") {
          return {
            content: [{ type: "text", text: `❌ trigger_lisa_implementation 是 Andy 专属工具。Lucas 应使用 trigger_development_pipeline（功能需求）或 report_bug（Bug 修复）。` }],
            details: { error: "wrong_agent" },
          };
        }

        const wecomUserId =
          p.user_id ??
          toolCtx.requesterSenderId ??
          parseSessionUser(toolCtx.sessionKey).userId ??
          "unknown";

        // 叫停检查：Lucas 已取消此任务，不再触发 Lisa
        if (p.requirement_id && isTaskCancelled(p.requirement_id)) {
          void pushToChannel(`ℹ️ 任务「${p.requirement_id}」已被叫停，Lisa 不会开始实现。`, wecomUserId, true);
          return {
            content: [{ type: "text", text: "⚠️ 任务已被 Lucas 叫停，实现取消。" }],
            details: { cancelled: true, requirementId: p.requirement_id },
          };
        }

        // ── Coordinator 模式检测 ──────────────────────────────────────────
        // spec JSON 含 use_coordinator: true 时，走并行 sub-Lisa 路径
        {
          const coordinatorJsonMatch = p.spec.match(/```json\s*([\s\S]*?)```/);
          if (coordinatorJsonMatch) {
            try {
              const specData = JSON.parse(coordinatorJsonMatch[1]) as Record<string, unknown>;
              if (specData.use_coordinator === true && Array.isArray(specData.sub_specs) && (specData.sub_specs as unknown[]).length > 0) {
                const subSpecs = specData.sub_specs as SubSpecTask[];
                const reqId = p.requirement_id ?? `req_${Date.now()}`;

                // 告知 Lucas：Andy 已出方案，并行调度开始（Lucas 决定是否告知用户）
                if (wecomUserId && wecomUserId !== "unknown") {
                  void callGatewayAgent(
                    "lucas",
                    [
                      `【Andy 设计完成 · ${reqId}（Coordinator 模式）】`,
                      `Andy 将 ${subSpecs.length} 个独立子模块并行交给 Lisa 实现：${subSpecs.map(s => s.title).join(" / ")}`,
                      ``,
                      `用户 ID：${wecomUserId}`,
                      `根据用户当前状态，决定是否告知进展（不是必须推送）。`,
                    ].join("\n"),
                    60_000,
                  );
                }
                // 通报系统工程师：Coordinator 并行调度启动
                void notifyEngineer(`【${reqId}】${subSpecs.length}个子任务并行启动：${subSpecs.map(s => s.title).join(" / ")}`, "pipeline", "lisa");

                // 异步并行执行，不阻塞工具返回给 Andy
                // Andy 拿到聚合结果后可自主综合并调用 trigger_lisa_integration
                (async () => {
                  try {
                    const results = await spawnParallelLisa(subSpecs, reqId);
                    const succeeded = results.filter(r => r.success).length;
                    const failed = results.filter(r => !r.success).length;

                    // integration_spec：Andy 在 coordinator spec 里预定义的集成方案
                    const integrationSpecSection = specData.integration_spec
                      ? [``, `【预定集成方案（来自你的 coordinator spec）】`, JSON.stringify(specData.integration_spec, null, 2)]
                      : [];

                    // 组装聚合摘要——Andy 被唤醒时只有这份报告，必须自洽
                    const summary = [
                      `【Coordinator 完成报告】需求 ${reqId}`,
                      `共 ${results.length} 个子任务：${succeeded} 成功 / ${failed} 失败`,
                      `结果文件：data/pipeline/${reqId}/`,
                      ``,
                      ...results.map(r =>
                        `[${r.success ? "✅" : "❌"}] ${r.taskId}（${r.title}）\n${r.result.slice(0, 600)}`
                      ),
                      ...integrationSpecSection,
                      ``,
                      failed === 0
                        ? `所有子任务完成。请根据以上结果综合，调用 trigger_lisa_integration 处理集成阶段（传入 requirement_id="${reqId}"）。`
                        : `有 ${failed} 个子任务失败，请查看 data/pipeline/${reqId}/ 了解详情，决定修复还是降级方案后再处理集成。`,
                    ].join("\n");

                    // 通报系统工程师：Coordinator 并行阶段完成，Andy 综合中
                    void notifyEngineer(`【${reqId}】Lisa并行完成：${succeeded}成功/${failed}失败，Andy综合中`, "pipeline", "lisa");
                    // 触发 Andy 综合：新的独立 session，Andy 在干净上下文里接收完成报告
                    // 不带 threadId，避免历史噪音干扰判断
                    // Andy 验收通过后必须输出 Lucas交付：格式，插件层提取后告知 Lucas
                    const andyAggregatePrompt = [
                      summary,
                      ``,
                      `【角色说明】你是技术验收方，不直接联系用户。验收完成后请输出固定格式（插件层提取后交给 Lucas 决定是否通知用户）：`,
                      `Lucas交付：[用家人听得懂的语言描述：做了什么 / 注意事项（无则省略）/ 下次这类需求可以这样说]`,
                    ].join("\n");
                    const andyAggregateResult = await callGatewayAgent("andy", andyAggregatePrompt, 600_000);
                    // 提取 Lucas交付：简报，告知 Lucas
                    if (wecomUserId && wecomUserId !== "unknown") {
                      const deliveryMatch = (andyAggregateResult ?? "").match(/Lucas交付[：:]\s*([\s\S]+?)(?:\n\n|\n[^\s]|$)/);
                      const brief = deliveryMatch?.[1]?.trim()
                        ?? (failed === 0
                          ? `Lisa 并行实现完成（${succeeded}/${results.length} 子任务），Andy 已综合验收。`
                          : `并行实现部分完成（${failed}/${results.length} 子任务失败），Andy 正在处理后续。`);
                      void callGatewayAgent(
                        "lucas",
                        [
                          `【Andy 验收完成 · ${reqId}（Coordinator 模式）】`,
                          brief,
                          ``,
                          `用户 ID：${wecomUserId}`,
                          `修复/功能已完成，根据你对用户当前状态的判断，选择合适的时机和方式告知用户。`,
                        ].join("\n"),
                        60_000,
                      );
                    }
                  } catch (e) {
                    const errMsg = e instanceof Error ? e.message : String(e);
                    void notifyEngineer(`【${reqId}】Coordinator 执行异常：${errMsg.slice(0, 300)}`, "pipeline", "andy");
                    // Lucas 知情：Coordinator 异常，仅通知不干预
                    void callGatewayAgent("lucas", [
                      `【Coordinator 执行异常 · ${reqId}】`,
                      `异常信息：${errMsg.slice(0, 200)}`,
                      `这是 Andy 并行任务模式的异常，Lucas 无需干预，仅知情。`,
                      `如果用户问起进展，可以告知"遇到了技术问题正在处理"。`,
                    ].join("\n"), 20_000);
                    if (wecomUserId && wecomUserId !== "unknown") {
                      void pushToChannel(`Coordinator 执行异常：${errMsg}`, wecomUserId, false);
                    }
                  }
                })();

                return {
                  content: [{ type: "text", text: `✅ Coordinator 模式已启动：${subSpecs.length} 个子任务并行执行中。结果会写入 data/pipeline/${reqId}/，完成后 Andy 会收到聚合报告。` }],
                  details: { mode: "coordinator", reqId, taskCount: subSpecs.length },
                };
              }
            } catch {
              // JSON 解析失败：不是 coordinator spec，继续普通路径
            }
          }
        }

        // ② Spec 集成点静态验证：提取 JSON 块，检查 integration_points 文件真实存在
        // exists=false 或文件不在磁盘上 → 阻断，要求 Andy 先修正 spec
        {
          const specJsonMatch = p.spec.match(/```json\s*([\s\S]*?)```/);
          if (specJsonMatch) {
            try {
              const specData = JSON.parse(specJsonMatch[1]) as Record<string, unknown>;
              type IntegrationPoint = { file: string; target: string; action?: string; exists?: boolean };
              const integrationPoints = (specData.integration_points ?? []) as IntegrationPoint[];
              const blocked: string[] = [];
              const NEW_FILE_ACTIONS = ["新增", "create", "新建", "创建"];
              for (const ip of integrationPoints) {
                const fullPath = join(PROJECT_ROOT, ip.file);
                const isNewFile = ip.action && NEW_FILE_ACTIONS.some(a => ip.action!.includes(a));
                if (ip.exists === false && !isNewFile) {
                  // exists=false 且不是新增操作：Andy 引用了一个本该存在但找不到的文件
                  blocked.push(`${ip.file} → ${ip.target ?? "?"} (exists 标记为 false，请检查路径是否正确)`);
                } else if (ip.exists !== false && !existsSync(fullPath)) {
                  // Andy 标记 exists=true 但磁盘上找不到：路径写错了
                  blocked.push(`${ip.file} (文件不存在于磁盘)`);
                }
              }
              if (blocked.length > 0) {
                return {
                  content: [{
                    type: "text",
                    text: `❌ Spec 集成点验证失败，以下路径有问题：\n${blocked.map(b => `  • ${b}`).join("\n")}\n\n请回步骤 2 补读代码，修正 spec 后重新调用 trigger_lisa_implementation。`,
                  }],
                  details: { blocked: true, invalidIntegrationPoints: blocked },
                };
              }
              const criteria = (specData.acceptance_criteria ?? []) as unknown[];
              if (criteria.length === 0) {
                return {
                  content: [{
                    type: "text",
                    text: "❌ Spec 缺少 acceptance_criteria。至少需要一条验收标准，Lisa 凭此写测试存根。",
                  }],
                  details: { blocked: true, reason: "empty_acceptance_criteria" },
                };
              }

              // ③ code_evidence 验证（Read-before-Edit 原则）
              // Spec 修改现有文件时，Andy 必须提供读过该代码的证据：
              //   { file: "相对路径", symbol: "真实存在的函数/变量/路由名" }
              // infrastructure 层 grep 验证 symbol 确实在文件里 —— Andy 不读代码就写不出能通过验证的 symbol
              {
                const NEW_FILE_ACTIONS_EV = ["新增", "create", "新建", "创建"];
                const hasExistingMods = integrationPoints.some(ip => {
                  const isNew = ip.action && NEW_FILE_ACTIONS_EV.some(a => ip.action!.includes(a));
                  return !isNew;
                });
                if (hasExistingMods) {
                  type CodeEvidence = { file: string; symbol: string };
                  const codeEvidence = (specData.code_evidence ?? []) as CodeEvidence[];
                  if (codeEvidence.length === 0) {
                    return {
                      content: [{
                        type: "text",
                        text: [
                          "❌ Spec 缺少 code_evidence 字段。",
                          "",
                          "Spec 包含对现有文件的修改，但没有证明 Andy 读过这些代码。",
                          "请在 spec JSON 中加入 code_evidence 数组，引用你 exec 读到的真实符号：",
                          '```json',
                          '"code_evidence": [',
                          '  { "file": "CrewHiveClaw/CrewClaw/crewclaw-routing/index.ts", "symbol": "callGatewayAgent" }',
                          ']',
                          '```',
                          "每条须包含：文件路径 + 该文件中真实存在的函数/变量/路由名。infrastructure 层会 grep 验证。",
                        ].join("\n"),
                      }],
                      details: { blocked: true, reason: "missing_code_evidence" },
                    };
                  }
                  const evidenceErrors: string[] = [];
                  for (const ev of codeEvidence) {
                    const evPath = ev.file.startsWith("/") ? ev.file : join(PROJECT_ROOT, ev.file);
                    if (!existsSync(evPath)) {
                      evidenceErrors.push(`文件不存在：${ev.file}`);
                      continue;
                    }
                    if (ev.symbol) {
                      try {
                        const evContent = readFileSync(evPath, "utf8");
                        if (!evContent.includes(ev.symbol)) {
                          evidenceErrors.push(`${ev.file} 中找不到符号 "${ev.symbol}"（请引用文件中真实存在的标识符）`);
                        }
                      } catch { /* 读文件失败不阻断 */ }
                    }
                  }
                  if (evidenceErrors.length > 0) {
                    return {
                      content: [{
                        type: "text",
                        text: `❌ code_evidence 验证失败：\n${evidenceErrors.map(e => `  • ${e}`).join("\n")}\n\n请回步骤 2 用 exec 读实际代码，引用文件中真实存在的函数/变量名。`,
                      }],
                      details: { blocked: true, invalidCodeEvidence: evidenceErrors },
                    };
                  }
                }
              }

              // ④ 核心框架文件保护（渐进式信任：核心文件变更时 warn-and-proceed 通知工程师）
              // 不阻断流水线，但工程师会即时收到告警以便人工验收。
              // 保护列表：基础设施层核心文件，任何修改都需要工程师知情。
              {
                const PROTECTED_FILES = [
                  "CrewHiveClaw/CrewClaw/crewclaw-routing/index.ts",
                  "CrewHiveClaw/CrewClaw/crewclaw-routing/context-sources.ts",
                  "crewclaw/daemons/entrances/wecom/index.js",
                  "crewclaw/daemons/entrances/wecom/task-manager.js",
                ];
                const protectedHits = integrationPoints.filter(ip =>
                  PROTECTED_FILES.some(pf =>
                    ip.file.endsWith(pf) || ip.file.endsWith(pf.split("/").pop()!)
                  )
                );
                if (protectedHits.length > 0) {
                  const fileList = protectedHits.map(ip => ip.file).join(", ");
                  void pushToChannel(
                    `⚠️ 框架文件变更告警\nAndy spec 涉及核心框架文件：[${fileList}]\nLisa 即将实现，请关注并验收。\nSpec 摘要：${p.spec.slice(0, 200)}`,
                    process.env.WECOM_OWNER_ID ?? "",
                    false,
                  );
                }
              }
            } catch {
              // JSON 解析失败：spec 格式不规范，不强制阻断（兼容旧格式过渡期）
            }
          }
        }

        // ① Andy→Lucas 设计摘要：立即通知 Lucas Andy 已出方案，不等 Lisa 完成
        // fire-and-forget，不阻塞工具返回
        const specPreview = p.spec
          .split("\n")
          .filter((l) => l.trim())
          .slice(0, 3)
          .join(" / ")
          .slice(0, 180);

        // 从 spec 提取 designNote（solution 字段的前 120 字，非技术语言摘要）
        let designNote = specPreview;
        try {
          const sd = JSON.parse(p.spec) as { solution?: string };
          if (sd.solution) designNote = sd.solution.slice(0, 120);
        } catch { /* spec 非 JSON 时用 specPreview */ }

        // 更新任务注册表：阶段推进到 lisa_implementing，记录设计摘要
        const reqIdForPhase = p.requirement_id ?? "";
        if (reqIdForPhase) {
          const taskEntries = readTaskRegistry();
          const taskEntry = taskEntries.find(e => e.id === reqIdForPhase);
          if (taskEntry) {
            taskEntry.currentPhase = "lisa_implementing";
            taskEntry.designNote = designNote;
            writeFileSync(TASK_REGISTRY_FILE, JSON.stringify(taskEntries, null, 2), "utf8");
          }
        }

        if (wecomUserId && wecomUserId !== "unknown") {
          // 告知 Lucas 设计完成（Lucas 决定是否、何时、如何告知用户进展）
          void callGatewayAgent(
            "lucas",
            [
              `【Andy 设计完成 · ${p.requirement_id ?? "unknown"}】`,
              `Andy 已完成方案设计，Lisa 即将开始实现。方案摘要：${specPreview}`,
              ``,
              `用户 ID：${wecomUserId}`,
              `根据你对用户当前状态的判断，决定是否告知进展（不是必须推送）。`,
            ].join("\n"),
            60_000,
          );
        }
        // 通报系统工程师：Andy→Lisa 交接
        void notifyEngineer(`【需求交付】[${p.requirement_id ?? "unknown"}] Andy→Lisa\n方案：${specPreview}`, "pipeline", "andy");

        // Fix 1：立刻写占位记录，让 runAndyPipeline 能在 Andy 返回时检测到已触发 Lisa
        // collab 文件原本在 Lisa 响应后才写，但检查点在 Andy 返回后立刻触发，时序上追不上
        {
          const reqIdEarly = p.requirement_id ?? "";
          if (reqIdEarly) {
            const threadIdEarly = `andy-to-lisa:${reqIdEarly}_collab`;
            const placeholder: ThreadEntry[] = [{ role: "user", text: `spec submitted at ${nowCST()}`, ts: Date.now() }];
            try { writeFileSync(agentThreadFile(threadIdEarly), JSON.stringify(placeholder)); } catch {}
          }
        }

        (async () => {
          const reqId = p.requirement_id ?? `req_${Date.now()}`;
          const threadId = `andy-to-lisa:${reqId}_collab`;
          let responseText = "❌ Lisa 实现失败";
          let success = false;
          try {
            // 触发 Lisa 实现：发送 spec，要求 Lisa 调用 run_opencode 工具
            // threadId 贯穿整个协作过程，report_implementation_issue 多轮回路共享同一上下文
            const lisaResponse = await callGatewayAgent(
              "lisa",
              [
                `【Implementation Spec】\n${p.spec}`,
                "请阅读以上 spec，使用 run_opencode 工具在项目目录执行代码实现。",
                "实现完成后输出交付报告：1) 完成了什么 2) 生成的文件路径 3) 验证结果（是否成功/失败原因）4) 使用方式",
                "如果 spec 包含 Python 脚本，请在报告中包含 py_compile 验证结果（命令：python3 -m py_compile <脚本路径>）",
                `【协作线程 ID】${threadId}（遇阻时调用 report_implementation_issue 请带上此 thread_id）`,
              ].join("\n\n"),
              600_000,
              threadId,
            );
            // 检测 Lisa 是否绕过了 run_opencode（用文本描述假装 edit/write 工具）
            const lisaBypassedOpencode = lisaResponse && (
              /直接(用|使用).{0,10}edit.{0,10}工具/.test(lisaResponse) ||
              /直接(用|使用).{0,10}write.{0,10}工具/.test(lisaResponse) ||
              /按照.{0,20}工程判断.{0,20}应该直接/.test(lisaResponse)
            );
            if (lisaBypassedOpencode) {
              // Lisa 幻觉了 edit/write 工具，任务失败，不能接受这个"交付"
              void notifyEngineer(
                `【Lisa 幻觉工具调用 · ${reqId}】Lisa 绕过了 run_opencode，声称直接用 edit/write 工具修改了文件，但这些工具不存在。代码未被修改，任务标记失败。\n\nLisa 原话节选：${lisaResponse.slice(0, 300)}`,
                "pipeline", "lisa",
              );
              // Lucas 知情：Lisa 伪造交付，Lucas 需要应对用户可能的追问
              void callGatewayAgent("lucas", [
                `【Lisa 幻觉工具调用检测 · ${reqId}】`,
                `Lisa 绕过了 run_opencode，尝试用不存在的 edit/write 工具"实现"代码。`,
                `交付已被标记为无效。Lucas 无需干预，仅知情。`,
                `如果用户问起这个任务，告知"还在处理中"或"遇到了问题需要重新实现"。`,
              ].join("\n"), 20_000);
              responseText = "❌ Lisa 实现失败：Lisa 绕过了 run_opencode，用不存在的 edit 工具假装修改了文件。代码未被实际更改。";
              success = false;
              // Andy 是 spec 的作者，应知道 Lisa bypass 并决定下一步
              void (async () => {
                try {
                  await callGatewayAgent("andy", [
                    `【Lisa 实现失败 · ${reqId}】Lisa 绕过了 run_opencode，用文字描述假装修改了文件，实现无效。`,
                    `Spec 摘要：${p.spec.slice(0, 300)}`,
                    ``,
                    `请你决定下一步（选一个行动）：`,
                    `1. spec 表述可以更明确以减少歧义 → 调用 trigger_lisa_implementation 提交修订版`,
                    `2. 需要拆小任务 → 重新设计并分批触发`,
                    `3. 判断是 Lisa 的系统性问题 → 调用 notify_engineer`,
                  ].join("\n"), 180_000, threadId);
                } catch { /* 静默，不阻塞主流程 */ }
              })();
            } else {
              success = !!lisaResponse;
            }
            if (lisaResponse && !lisaBypassedOpencode) {
              appendJsonl(join(PROJECT_ROOT, "data/corpus/lisa-corpus.jsonl"), {
                timestamp: nowCST(),
                role: "lisa",
                requirement_id: reqId,
                ttl_days: 180,
                spec: p.spec.slice(0, 500),
                implementation: lisaResponse,
              });

              // ③ capability-registry 写入：能力结晶沉淀闭环
              // 每次 Lisa 成功交付一个新能力，自动注册到 capability-registry.jsonl
              // 去重：读取现有条目，相同 capability_id 则跳过（防止重复写入）
              {
                const capRegPath = join(PROJECT_ROOT, "data/corpus/capability-registry.jsonl");
                const existingCaps = readJsonlEntries(capRegPath);
                const alreadyRegistered = existingCaps.some(e => e.capability_id === reqId);
                if (!alreadyRegistered) {
                  let capTitle = reqId;
                  let capEntryPoint = "";
                  let registersCapability = false; // 默认不写入，只有 spec 显式标注 true 才写
                  try {
                    const specJsonMatch = p.spec.match(/```json\s*([\s\S]*?)```/);
                    if (specJsonMatch) {
                      const specData = JSON.parse(specJsonMatch[1]) as Record<string, unknown>;
                      if (typeof specData.title === "string" && specData.title) capTitle = specData.title;
                      // 新字段：registers_capability，缺失时默认 false
                      if (specData.registers_capability === true) registersCapability = true;
                      // 新字段：capability_entry（优先），fallback 到 integration_points[0].file
                      if (typeof specData.capability_entry === "string" && specData.capability_entry) {
                        capEntryPoint = specData.capability_entry;
                      } else {
                        const ips = specData.integration_points as Array<{file?: string}> | undefined;
                        if (ips?.[0]?.file) capEntryPoint = ips[0].file;
                      }
                    }
                  } catch { /* 解析失败使用默认值，不影响主流程 */ }

                  // 只有 Andy 在 spec 里明确标注 registers_capability: true 时才写入
                  if (registersCapability) {
                    appendJsonl(capRegPath, {
                      capability_id: reqId,
                      title: capTitle,
                      entry_point: capEntryPoint,
                      timestamp: nowCST(),
                      last_used: nowCST(),
                      requirement: p.spec.slice(0, 200),
                      status: "active",
                    });
                  }
                }
              }

              // Lisa 决策记忆（TUI 路径）
              const lisaSummary = lisaResponse.split("\n").filter(Boolean).slice(0, 3).join(" / ");
              void addDecisionMemory({
                decision_id: reqId,
                agent: "lisa",
                timestamp: nowCST(),
                context: p.spec.slice(0, 300),
                decision: lisaSummary,
                outcome: "delivered",
                outcome_at: nowCST(),
                outcome_note: "TUI 路径实现完成，语法验证通过",
              } satisfies DecisionRecord);

              // ② Lisa→Andy 结果通知：把实现结果写入 Andy 决策记忆
              // Andy 知道自己的 spec 是否被成功落地，形成完整反馈回路
              void addDecisionMemory({
                decision_id: `${reqId}-andy-outcome`,
                agent: "andy",
                timestamp: nowCST(),
                context: p.spec.slice(0, 300),
                decision: "spec 交付 Lisa 实现",
                outcome: "implemented",
                outcome_at: nowCST(),
                outcome_note: lisaSummary.slice(0, 200),
              } satisfies DecisionRecord);

              // Step 6：Lucas 验收重包装（与 runAndyPipeline 保持一致）
              try {
                const lucasPrompt = [
                  "【验收任务】开发团队刚完成了一个任务，请用自然的家人语气告知结果。",
                  `【Lisa 交付报告】\n${lisaResponse}`,
                  `【接收对象】${wecomUserId}（请根据你对这位家庭成员的了解，调整语气和侧重点）`,
                  "请简洁回复（不超过 150 字）：做了什么（一句话）、怎么用或在哪里找到（如有）、有没有要注意的（如有）。",
                  "语气像家人说话，不要技术术语，不要加标题或符号。",
                ].join("\n\n");
                const lucasAcceptance = await callGatewayAgent("lucas", lucasPrompt, 120_000);
                if (lucasAcceptance) {
                  appendJsonl(join(PROJECT_ROOT, "data/corpus/lucas-corpus.jsonl"), {
                    timestamp: nowCST(),
                    role: "lucas",
                    requirement_id: reqId,
                    task: "delivery_acceptance",
                    raw_delivery: lisaResponse.slice(0, 300),
                    repackaged: lucasAcceptance,
                  });
                  void addDecisionMemory({
                    decision_id: reqId,
                    agent: "lucas",
                    timestamp: nowCST(),
                    context: p.spec.slice(0, 300),
                    decision: "TUI 路径验收并重包装",
                    outcome: "delivered",
                    outcome_at: nowCST(),
                    outcome_note: "Lucas 验收并推送用户",
                  } satisfies DecisionRecord);
                  responseText = lucasAcceptance;
                } else {
                  responseText = lisaResponse;
                }
              } catch {
                responseText = lisaResponse;
              }
            } else {
              // lisaResponse 为空（Lisa 无响应），保持默认的失败消息
              // 不覆盖 responseText，保持 "❌ Lisa 实现失败"
            }
          } catch (e: unknown) {
            const errMsg = e instanceof Error ? e.message : String(e);
            // 超时/中断用用户友好描述，其他异常保留技术细节供工程师排查
            const isTimeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError" || errMsg.includes("timeout") || errMsg.includes("aborted"));
            responseText = isTimeout
              ? "Lisa 这次实现时间比预期长，任务已暂停。我稍后会重新评估并告知进展。"
              : `Lisa 实现遇到问题：${errMsg.slice(0, 100)}`;
            // Andy 是 spec 的作者，应知道 Lisa 失败并决定下一步
            void (async () => {
              try {
                await callGatewayAgent("andy", [
                  `【Lisa 实现失败 · ${reqId}】Lisa 在实现你的 spec 时${isTimeout ? "超时（10分钟未完成）" : `遇到异常：${errMsg.slice(0, 150)}`}。`,
                  `Spec 摘要：${p.spec.slice(0, 300)}`,
                  ``,
                  `请你决定下一步（选一个行动）：`,
                  `1. spec 太复杂可以拆小 → 调用 trigger_lisa_implementation 提交简化版`,
                  `2. 需要了解具体阻塞原因 → 调用 consult_lisa`,
                  `3. 需要 Lucas 向用户澄清需求 → 调用 query_requirement_owner`,
                  `4. 判断是技术环境问题 → 调用 notify_engineer`,
                ].join("\n"), 180_000, threadId);
              } catch { /* 静默，不阻塞主流程 */ }
            })();
            // ② Lisa→Andy 失败通知：Andy 同样需要知道 spec 未落地
            void addDecisionMemory({
              decision_id: `req_${Date.now()}-andy-outcome`,
              agent: "andy",
              timestamp: nowCST(),
              context: p.spec.slice(0, 300),
              decision: "spec 交付 Lisa 实现",
              outcome: "failed",
              outcome_at: nowCST(),
              outcome_note: errMsg.slice(0, 200),
            } satisfies DecisionRecord);
          }
          // 交付通知末尾追加反馈引导（促进反馈回路闭环）
          if (success && responseText) {
            responseText = responseText.trimEnd() + "\n\n用起来怎么样？有问题随时告诉我～";
          }
          // 失败时通过 Lucas 转换为人话（与 Andy 失败路径对称）
          if (!success && wecomUserId && wecomUserId !== "unknown") {
            try {
              const lucasFailMsg = await callGatewayAgent(
                "lucas",
                [
                  `【流水线失败 · ${reqId}】Lisa 在实现需求时遇到了问题，没有完成交付。`,
                  `技术原因（内部参考，不要直接说给家人）：${responseText.slice(0, 300)}`,
                  ``,
                  `请用一两句人话告知用户失败了、大概为什么、他能做什么（稍后重试或等我排查）。口气自然，不要 ❌ 开头。`,
                ].join("\n"),
                30_000,
              );
              if (lucasFailMsg) {
                responseText = lucasFailMsg;
                success = true; // Lucas 已包装成人话，用 success 路径推送（去掉 ❌ 处理失败: 前缀）
              }
            } catch { /* 降级：保持原始错误消息 */ }
          }
          // 通报系统工程师：流水线终态
          void notifyEngineer(
            success
              ? `【${p.requirement_id ?? "unknown"}】流水线完成\n\n━━ Lisa 交付报告 ━━\n${responseText}`
              : `【${p.requirement_id ?? "unknown"}】流水线失败\n\n━━ 错误详情 ━━\n${responseText}`,
            "pipeline",
            "lisa",
          );
          await pushEventDriven(responseText, wecomUserId, success);
          // Fix 3：Lisa 完成后主动更新任务状态（覆盖 runAndyPipeline 可能已标的 failed）
          if (reqId.startsWith("req_")) {
            markTaskStatus(reqId, success ? "completed" : "failed");
          }
          // 写入跟进队列：Lucas 在 20:00 HEARTBEAT 时扫到并主动跟进结果
          if (success && wecomUserId && !wecomUserId.startsWith("system")) {
            try {
              const followupFile = join(PROJECT_ROOT, "data/learning/followup-queue.jsonl");
              appendJsonl(followupFile, {
                taskId: reqId,
                userId: wecomUserId,
                requirementSummary: specPreview.slice(0, 200),
                deliveredAt: nowCST(),
                status: "pending",
              });
            } catch { /* 写入失败不影响主流程 */ }
          }
        })().catch(() => {});

        return {
          content: [{ type: "text", text: "✅ Spec 已交给 Lisa，实现完成后会推送结果。" }],
          details: { submitted: true },
        };
      },
    }));

    // ━━ query_requirement_owner（Andy 专属）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    api.registerTool((toolCtx) => ({
      label: "向 Lucas 询问需求",
      name: "query_requirement_owner",
      description: [
        "Andy 在设计过程中对需求有疑问时调用，向 Lucas 发起澄清。",
        "适用场景：需求边界不清、有多种合理解读、优先级不明、家人意图模糊。",
        "不适用：技术问题（用 research_task）、已有明确 spec 的实现细节。",
        "只有 Andy 应调用此工具。调用后同步等待 Lucas 回复，再继续设计。",
      ].join("\n"),
      parameters: Type.Object({
        question: Type.String({
          description: "向 Lucas 提出的具体问题，说明正在开发什么需求、哪里不确定、有哪些备选理解",
        }),
        requirement_summary: Type.Optional(
          Type.String({ description: "正在开发的需求摘要（30字以内），方便 Lucas 定位上下文" }),
        ),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        if (toolCtx.agentId && toolCtx.agentId !== "andy") {
          return {
            content: [{ type: "text", text: `❌ query_requirement_owner 是 Andy 专属工具。` }],
            details: { error: "wrong_agent" },
          };
        }

        const p = params as { question: string; requirement_summary?: string };
        const ctxLine = p.requirement_summary
          ? `需求背景：${p.requirement_summary.slice(0, 100)}\n\n`
          : "";

        const lucasMessage = [
          `【来自Andy·需求澄清】`,
          p.requirement_id ? `需求 ID：${p.requirement_id}` : "",
          p.requirement_summary ? `正在开发：${p.requirement_summary.slice(0, 150)}` : "",
          ``,
          `Andy 在设计方案过程中遇到了一个需要确认的问题，在这个问题明确前他无法继续推进：`,
          ``,
          p.question,
          ``,
          `如果你能自己判断，直接回答 Andy；如果需要爸爸拍板，用 send_message 问他，说清楚「Andy 做 XX 功能时遇到问题：[一句话描述]，你看…」，不要把 Andy 的原话直接甩给他。`,
        ].filter(Boolean).join("\n");

        try {
          const lucasReply = await callGatewayAgent("lucas", lucasMessage, 60_000);

          void addDecisionMemory({
            decision_id: `andy_query_${Date.now()}`,
            agent: "andy",
            timestamp: nowCST(),
            context: `需求澄清：${p.question.slice(0, 200)}`,
            decision: (lucasReply ?? "(无回复)").slice(0, 300),
            outcome: "clarified",
            outcome_at: nowCST(),
            outcome_note: "Andy 向 Lucas 发起需求澄清，已收到回复",
          });

          // 通报系统工程师：Andy↔Lucas 需求澄清全貌（Lucas 是自己判断还是转问了用户？）
          void notifyEngineer(
            [
              `【需求澄清 · Andy→Lucas】`,
              p.requirement_summary ? `需求：${p.requirement_summary.slice(0, 100)}` : "",
              `Andy 问题：${p.question.slice(0, 300)}`,
              ``,
              `━━ Lucas 回复 ━━`,
              lucasReply ?? "(无回复)",
            ].filter(Boolean).join("\n"),
            "info",
            "andy",
          );

          return {
            content: [{ type: "text", text: lucasReply ?? "Lucas 暂无回复，请根据现有信息继续开发。" }],
            details: { clarified: true },
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `Lucas 查询超时，请根据现有 spec 继续开发，待后续确认。错误：${(e as Error).message}` }],
            details: { error: "lucas_query_failed" },
          };
        }
      },
    }));

    // ━━ research_task：Andy/Lisa 共用，技术调研 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    api.registerTool((toolCtx) => ({
      label: "技术调研",
      name: "research_task",
      description: [
        "技术调研工具（Andy 和 Lisa 都可调用）：搜索当前技术生态、现有方案、最佳实践。",
        "Andy 用于架构级选型（选什么方案）；Lisa 用于实现级调研（有没有现成的 npm 包、开源代码、实现参考）。",
        "适用于不确定技术选型、需要了解 API 可行性、评估方案优劣时。",
        "返回调研报告（DeepSeek 搜索驱动）。",
      ].join("\n"),
      parameters: Type.Object({
        query: Type.String({ description: "调研问题，如技术选型、API 可行性、最佳实践等" }),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const p = params as { query: string };
        try {
          const result = await researchWithDeepSeek(p.query);
          // 调研结果持久化进蒸馏管道：写入 decisions 集合，agentId 区分来源
          const agentId = toolCtx.agentId || "andy";
          const docId = `research-${agentId}-${Date.now()}`;
          const document = `【调研问题】${p.query}\n\n【调研结论】${result}`;
          embedText(document)
            .then((embedding) =>
              chromaUpsert("decisions", docId, document, {
                agent: agentId,   // 与 addDecisionMemory 字段名一致，供 queryDecisionMemory 过滤
                type: "research",
                query: p.query.slice(0, 500),
                timestamp: nowCST(),
              }, embedding)
            )
            .catch(() => { /* 写入失败不影响调研结果返回 */ });
          return {
            content: [{ type: "text", text: result || "调研未返回结果" }],
            details: { query: p.query },
          };
        } catch (e: unknown) {
          return {
            content: [{ type: "text", text: `❌ 调研失败：${e instanceof Error ? e.message : String(e)}` }],
            details: { error: String(e) },
          };
        }
      },
    }));

    /* ━━ run_plandex 已废除（2026-03-29），注释保留供参考 ━━━━━━━━━━━━━━━━━━━
    api.registerTool((_toolCtx) => ({
      name: "run_plandex",
      ...
    }));
    ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */

    // ━━ run_opencode：Lisa 专属工具 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    api.registerTool((_toolCtx) => ({
      label: "执行代码实现",
      name: "run_opencode",
      description: [
        "Lisa 专属工具：调用 opencode CLI 执行代码实现。",
        "收到 Implementation Spec 后调用此工具，传入完整 spec 让 opencode 完成代码生成。",
        "只有 Lisa 应该调用此工具。",
      ].join("\n"),
      parameters: Type.Object({
        spec: Type.String({
          description: "完整的 Implementation Spec，包含所有文件列表、代码结构、接口定义",
        }),
      }),

      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const p = params as { spec: string };
        try {
          // 后台启动 opencode，立即返回 sessionId（不阻塞 10 分钟）
          const sessionId = await launchOpenCodeBackground(p.spec, PROJECT_ROOT);
          return {
            content: [{ type: "text", text: `✅ 代码实现已在后台启动（sessionId: ${sessionId}）。\n请调用 get_opencode_result 工具等待完成并获取结果。` }],
            details: { sessionId, started: true },
          };
        } catch (e: unknown) {
          const errorMsg = `opencode 启动失败：${e instanceof Error ? e.message : String(e)}`;
          return {
            content: [{ type: "text", text: errorMsg }],
            details: { success: false, error: errorMsg },
          };
        }
      },
    }));

    // ━━ get_opencode_result：Lisa 专属，等待 run_opencode 后台任务完成 ━━━━━

    api.registerTool((_toolCtx) => ({
      label: "获取代码实现结果",
      name: "get_opencode_result",
      description: [
        "Lisa 专属工具：等待 run_opencode 启动的后台任务完成，返回实现结果。",
        "调用 run_opencode 后必须调用此工具等待结果，才能输出交付报告。",
        "只有 Lisa 应该调用此工具。",
      ].join("\n"),
      parameters: Type.Object({
        session_id: Type.String({ description: "run_opencode 返回的 sessionId" }),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const p = params as { session_id: string };

        // ── 自修复循环（Harness：失败 → 读错误 → 带上下文重跑，最多 2 次）──────
        const MAX_SELF_REPAIR = 2;
        let result = await waitOpenCodeResult(p.session_id, 600_000);
        let selfRepairAttempts = 0;

        while (selfRepairAttempts < MAX_SELF_REPAIR && !result.startsWith("✅")) {
          const check = runProjectCompileCheck();
          if (!check.hasErrors && !result.includes("error")) break; // 无具体错误可修，停止

          selfRepairAttempts++;
          const errorContext = check.hasErrors ? check.errors : result.slice(0, 1500);
          const fixTask = [
            `上次实现存在以下错误（第 ${selfRepairAttempts} 次自动修复），请只修复这些错误，不要改动其他逻辑：`,
            ``,
            `【错误详情】`,
            errorContext.slice(0, 2000),
          ].join("\n");

          const newSessionId = await launchOpenCodeBackground(fixTask, PROJECT_ROOT);
          result = await waitOpenCodeResult(newSessionId, 600_000);
        }

        // ── 客观验证门：编译检查 + 实际变更文件范围 ──────────────────────────
        const compileCheck = runProjectCompileCheck();
        const diffBlock = compileCheck.changedFiles.length > 0
          ? `\n\n【实际变更文件】\n${compileCheck.changedFiles.join("\n")}`
          : "";
        const compileBlock = `\n\n【编译验证】\n${compileCheck.summary}`;
        const repairNote = selfRepairAttempts > 0
          ? `\n\n（已自动修复 ${selfRepairAttempts} 次）`
          : "";

        const finalText = result + compileBlock + diffBlock + repairNote;
        const success = result.startsWith("✅") && !compileCheck.hasErrors;

        return {
          content: [{ type: "text", text: finalText }],
          details: { sessionId: p.session_id, success, selfRepairAttempts, compilePassed: !compileCheck.hasErrors },
        };
      },
    }));

    // ━━ report_implementation_issue：Lisa 专属，实现遇阻时向 Andy 反馈 ━━━━━━
    //
    // V 模型右侧回路：Lisa 实现遇到技术阻塞、spec 有歧义、依赖缺失时，
    // 向 Andy 发起反馈（不是向 Lucas，Andy 是她的需求方），
    // Andy 收到后决定：①调整 spec ②向 Lucas 澄清（用 query_requirement_owner）③自行解决
    //
    // 不调这个工具 = 遇阻了还是闷头猜，猜错了 spec 浪费一次完整实现周期

    api.registerTool((toolCtx) => ({
      label: "向 Andy 反馈实现阻塞",
      name: "report_implementation_issue",
      description: [
        "Lisa 专属工具：实现过程遇到阻塞时向 Andy 反馈。",
        "触发场景：① spec 描述的接口/文件不存在 ② 依赖缺失且无法自行确定替代方案 ③ spec 有歧义导致实现方向不确定 ④ 技术约束与 spec 冲突。",
        "不要在小问题上频繁调用——能自己解决的就解决；只有真正需要 Andy 重新决策才调用。",
        "调用后继续完成 spec 中能确定的部分，不要完全停下来等待。",
      ].join("\n"),
      parameters: Type.Object({
        issue: Type.String({ description: "阻塞描述：遇到了什么问题，尝试了什么，卡在哪里" }),
        spec_section: Type.Optional(Type.String({ description: "spec 里哪个部分有问题（引用原文片段）" })),
        options: Type.Optional(Type.String({ description: "Lisa 自己看到的备选方案，帮 Andy 做决策" })),
        requirement_id: Type.Optional(Type.String({ description: "需求 ID（req_xxx），来自 spec 头部" })),
        thread_id: Type.Optional(Type.String({ description: "协作线程 ID（来自 trigger_lisa_implementation 的 andy-to-lisa:{reqId}_collab），传入后 Andy 能看到完整上下文" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        if (toolCtx.agentId && toolCtx.agentId !== "lisa") {
          return {
            content: [{ type: "text", text: "❌ report_implementation_issue 是 Lisa 专属工具。" }],
            details: { error: "wrong_agent" },
          };
        }
        const p = params as { issue: string; spec_section?: string; options?: string; requirement_id?: string; thread_id?: string };

        // 优先用传入的 thread_id，否则从 requirement_id 推导
        const threadId = p.thread_id ?? (p.requirement_id ? `andy-to-lisa:${p.requirement_id}_collab` : undefined);

        // 轮次保护：最多 3 轮，超限让 Lisa 自行决策，不再打扰 Andy
        if (threadId && agentThreadRounds(threadId) >= 3) {
          return {
            content: [{ type: "text", text: "协作轮次已达上限（3轮），Andy 无法继续响应。请根据现有信息自行决策，或将不确定部分留注释标记后继续。" }],
            details: { reported: false, reason: "max_rounds_reached" },
          };
        }

        // 通知工程师：Lisa 主动上报阻塞，可能需要介入
        void notifyEngineer(
          [
            `【Lisa 遇阻·上报 Andy】${p.requirement_id ? `[${p.requirement_id}]` : ""}`,
            `问题：${p.issue.slice(0, 200)}`,
            p.options ? `Lisa 备选方案：${p.options.slice(0, 100)}` : "",
          ].filter(Boolean).join("\n"),
          "pipeline", "lisa",
        );

        // Lucas 知情：Lisa 遇到实现阻塞，Andy 在决策（用户可能在等，Lucas 可告知"正在处理"）
        if (p.requirement_id) {
          const issueTask = readTaskRegistry().find(t => t.id === p.requirement_id);
          if (issueTask?.submittedBy) {
            void callGatewayAgent(
              "lucas",
              [
                `【实现遇到阻塞，团队处理中 · ${p.requirement_id}】`,
                `Lisa 在实现代码时遇到了技术阻塞，已向 Andy 反馈，Andy 正在决策下一步方向后 Lisa 继续实现。`,
                ``,
                `用户 ID：${issueTask.submittedBy}`,
                `如果用户在问进展，可以说"正在处理一个技术细节，快好了"，不需要说具体是什么阻塞问题。`,
              ].join("\n"),
              15_000,
            );
          }
        }

        const parts = [
          `【来自Lisa·实现阻塞反馈】`,
          p.requirement_id ? `需求 ID：${p.requirement_id}` : "",
          ``,
          `问题描述：${p.issue}`,
          p.spec_section ? `\nSpec 原文：${p.spec_section}` : "",
          p.options ? `\nLisa 的备选方案：${p.options}` : "",
          ``,
          `Lisa 在等你决策后继续推进被阻塞的部分。`,
        ].filter(Boolean).join("\n");

        try {
          // 300s：DeepSeek-R1 CoT 推理需要时间，60s 几乎必超时
          const andyReply = await callGatewayAgent("andy", parts, 300_000, threadId);
          // 通知工程师：Andy 的决策结果（Lisa 遇阻回路）
          void notifyEngineer(
            `【Andy 决策·Lisa 遇阻回路】${p.requirement_id ? `[${p.requirement_id}]` : ""}\n${(andyReply ?? "无回复").slice(0, 300)}`,
            "pipeline", "andy",
          );
          // Lucas 知情：Andy 已对 Lisa 遇阻做出决策，Lucas 可据此回应用户
          if (p.requirement_id) {
            const issueTask = readTaskRegistry().find(t => t.id === p.requirement_id);
            void callGatewayAgent("lucas", [
              `【Andy 决策回复 · Lisa 遇阻回路 · ${p.requirement_id}]`,
              `Andy 对 Lisa 遇阻的回复：${(andyReply ?? "无回复").slice(0, 200)}`,
              issueTask?.submittedBy ? `用户 ID：${issueTask.submittedBy}` : "",
              "你现在知道这件事了。根据你对用户当前状态的判断，自主决定是否主动告知用户进展。",
            ].filter(Boolean).join("\n"), 20_000);
          }
          void addDecisionMemory({
            decision_id: `lisa-issue-${Date.now()}`,
            agent: "lisa",
            timestamp: nowCST(),
            context: p.issue.slice(0, 200),
            decision: "实现遇阻，上报 Andy",
            outcome: andyReply ? "andy_responded" : "andy_no_reply",
            outcome_at: nowCST(),
            outcome_note: (andyReply ?? "").slice(0, 200),
          } satisfies DecisionRecord);
          return {
            content: [{ type: "text", text: andyReply ?? "Andy 暂无回复，继续完成 spec 中可以确定的部分。" }],
            details: { reported: true, requirementId: p.requirement_id, threadId },
          };
        } catch {
          return {
            content: [{ type: "text", text: "Andy 查询超时，继续完成 spec 中可以确定的部分，遇阻部分留注释标记。" }],
            details: { reported: false },
          };
        }
      },
    }));

    // ━━ request_implementation_revision：Andy 专属，验收后发回 Lisa 修订 ━━━━━
    //
    // Harness：Andy→Lisa 的轻量反馈通道，独立于 Lisa→Andy 的 report_implementation_issue。
    // 验收发现 AC 未满足 / 有遗漏 / 细节有误，但问题明确不需要重写整个 spec 时使用。
    // 最多 3 轮（REVISION_MAX_ROUNDS），独立计数，不与 report_implementation_issue 混用。
    // 3 轮修订仍未通过 → 建议 trigger_lisa_implementation 完整重实现。

    api.registerTool((toolCtx) => ({
      label: "要求 Lisa 修订实现",
      name: "request_implementation_revision",
      description: [
        "Andy 专属工具：验收发现问题后，向 Lisa 发送针对性修改请求。",
        "触发场景：AC 未满足、有遗漏、实现细节有误，但问题明确——不需要重写整个 spec。",
        "比 trigger_lisa_implementation 轻量：只描述问题和期望修改，不传完整 spec。",
        "Lisa 收到后针对性修复，修复完成后输出：修改文件 + 修改摘要 + 编译验证结果。",
        "最多 3 轮修订（独立计数）；3 轮仍失败则改用 trigger_lisa_implementation 完整重实现。",
      ].join("\n"),
      parameters: Type.Object({
        requirement_id: Type.String({ description: "需求 ID（req_xxx）" }),
        issues: Type.String({ description: "验收发现的问题：哪里不符合 AC，具体描述" }),
        specific_fixes: Type.String({ description: "期望 Lisa 做什么修改（文件、函数、行为），越具体越好" }),
        thread_id: Type.Optional(Type.String({ description: "协作线程 ID（andy-to-lisa:{reqId}_collab）" })),
      }),

      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        if (toolCtx.agentId && toolCtx.agentId !== "andy") {
          return {
            content: [{ type: "text", text: "❌ request_implementation_revision 是 Andy 专属工具。" }],
            details: { error: "wrong_agent" },
          };
        }

        const p = params as {
          requirement_id: string;
          issues: string;
          specific_fixes: string;
          thread_id?: string;
        };
        const threadId = p.thread_id ?? `andy-to-lisa:${p.requirement_id}_collab`;

        // 独立修订轮次保护（不消耗 report_implementation_issue 的 3 轮上限）
        const revCount = revisionRoundsMap.get(threadId) ?? 0;
        if (revCount >= REVISION_MAX_ROUNDS) {
          return {
            content: [{
              type: "text",
              text: `修订轮次已达上限（${REVISION_MAX_ROUNDS} 轮），问题仍未解决。建议重新设计 spec 并调用 trigger_lisa_implementation 完整重实现。`,
            }],
            details: { revised: false, reason: "max_revision_rounds_reached" },
          };
        }
        revisionRoundsMap.set(threadId, revCount + 1);

        const message = [
          `【验收修订请求·第 ${revCount + 1} 轮】需求 ${p.requirement_id}`,
          ``,
          `Andy 在验收时发现以下问题，请针对性修复（不需要重新实现整个需求）：`,
          ``,
          `【问题】`,
          p.issues,
          ``,
          `【期望修改】`,
          p.specific_fixes,
          ``,
          `修复完成后输出：`,
          `1) 修改了哪些文件 / 函数`,
          `2) 修改内容摘要`,
          `3) 编译 / 验证结果`,
        ].join("\n");

        try {
          const lisaReply = await callGatewayAgent("lisa", message, 600_000, threadId);
          return {
            content: [{ type: "text", text: `【Lisa 修订回复 第 ${revCount + 1} 轮】\n${lisaReply.slice(0, 1500)}` }],
            details: { revised: true, revisionRound: revCount + 1, threadId },
          };
        } catch {
          return {
            content: [{ type: "text", text: "Lisa 修订调用超时，继续后续步骤或考虑 trigger_lisa_implementation 重实现。" }],
            details: { revised: false },
          };
        }
      },
    }));

    // ── trigger_lisa_integration：Andy 专属，Coordinator 模式集成阶段 ─────
    //
    // 所有 sub-Lisa 并行实现完成后，Andy 综合结果，调用此工具触发集成 Lisa。
    // 集成 Lisa 专注胶水代码：连接各模块、跑端到端测试、修复接口不匹配。

    api.registerTool((toolCtx) => ({
      label: "触发 Lisa 集成",
      name: "trigger_lisa_integration",
      description: [
        "Andy 专属工具（Coordinator 模式）：所有子任务完成后，触发集成 Lisa 处理胶水代码和端到端验证。",
        "适用场景：spawn_parallel_lisa 各子任务已完成，需要连接各模块、跑全量测试、修复接口不匹配。",
        "传入 integration_spec（描述需要哪些胶水代码）和 requirement_id。",
      ].join("\n"),
      parameters: Type.Object({
        integration_spec: Type.String({
          description: "集成阶段 spec：需要写哪些胶水代码、各模块接口如何连接、端到端验收标准",
        }),
        requirement_id: Type.String({
          description: "需求 ID（与并行阶段一致），用于读取 data/pipeline/{reqId}/ 下的子任务结果",
        }),
        user_id: Type.Optional(Type.String({ description: "原始请求用户 ID，用于回推结果" })),
      }),

      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const p = params as { integration_spec: string; requirement_id: string; user_id?: string };

        if (toolCtx.agentId && toolCtx.agentId !== "andy") {
          return {
            content: [{ type: "text", text: "❌ trigger_lisa_integration 是 Andy 专属工具（Coordinator 模式集成阶段）。" }],
            details: { error: "wrong_agent" },
          };
        }

        const wecomUserId =
          p.user_id ??
          toolCtx.requesterSenderId ??
          parseSessionUser(toolCtx.sessionKey).userId ??
          "unknown";

        const reqId = p.requirement_id;
        const pipelineDir = join(PROJECT_ROOT, "data/pipeline", reqId);
        const threadId = `andy-to-lisa:${reqId}_integration`;

        // 读取所有子任务结果，附加到集成 spec 里让 Lisa 有完整上下文
        let subTaskSummary = "";
        try {
          const files = readdirSync(pipelineDir).filter(f => f.endsWith(".json"));
          const summaries = files.map(f => {
            try {
              const data = JSON.parse(readFileSync(join(pipelineDir, f), "utf8")) as Record<string, unknown>;
              return `[${data.status as string}] ${data.taskId as string}（${data.title as string}）`;
            } catch { return f; }
          });
          subTaskSummary = `\n\n【已完成子任务】\n${summaries.join("\n")}`;
        } catch { /* pipeline 目录不存在或为空，继续 */ }

        if (wecomUserId && wecomUserId !== "unknown") {
          void pushToChannel(`Andy 正在触发集成阶段...`, wecomUserId, true);
        }

        (async () => {
          try {
            const lisaPrompt = [
              `【Integration Spec】需求 ${reqId}`,
              p.integration_spec,
              subTaskSummary,
              ``,
              "请阅读以上集成 spec，使用 run_opencode 实现胶水代码并跑端到端验证。",
              "重点：连接各模块接口、确保全量测试通过、修复任何接口不匹配。",
              "完成后输出集成报告：1) 做了什么胶水工作 2) 端到端测试结果 3) 可以怎么使用",
              `【协作线程 ID】${threadId}`,
            ].join("\n\n");

            const lisaResponse = await callGatewayAgentWithRetry("lisa", lisaPrompt, 600_000, threadId);

            appendJsonl(join(PROJECT_ROOT, "data/corpus/lisa-corpus.jsonl"), {
              timestamp: nowCST(), source: "coordinator-integration", reqId, content: lisaResponse,
            });

            if (wecomUserId && wecomUserId !== "unknown") {
              const lucasPrompt = [
                `你是 Lucas，家庭 AI 助手。Lisa 刚完成了一个大型功能的集成：\n${lisaResponse}`,
                "请用一两句人话告诉家人：做好了什么功能、怎么用。语气自然，不要技术术语。",
              ].join("\n\n");
              const lucasVerdict = await callGatewayAgent("lucas", lucasPrompt, 60_000);
              void pushToChannel(lucasVerdict ?? lisaResponse, wecomUserId, true);
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : String(e);
            if (wecomUserId && wecomUserId !== "unknown") {
              void pushToChannel(`集成阶段出错：${errMsg}`, wecomUserId, false);
            }
          }
        })();

        return {
          content: [{ type: "text", text: `✅ 集成阶段已触发，Lisa 正在处理 ${reqId} 的集成工作。` }],
          details: { reqId, threadId },
        };
      },
    }));

    // ── search_codebase：Andy 专属，智能代码搜索（写 spec 前定位目标文件和代码模式）──
    //
    // Claude Code 架构借鉴：给 Andy 一个搜索工具而不是让他猜文件路径。
    // 三路并行搜索：文件名 / 代码内容 / 历史实现洞察，一次调用覆盖多种场景。
    // 搜索范围限定在 CrewHiveClaw 代码仓，排除 node_modules 和 .git。

    api.registerTool((toolCtx) => ({
      label: "搜索代码库",
      name: "search_codebase",
      description: [
        "Andy 专属工具：在 HomeAI 代码库中智能搜索代码和文件。",
        "三种搜索模式可单独或组合使用：",
        "  files — 按文件名模式查找文件（支持 glob 片段，如 'context-handler'、'gateway'）",
        "  content — grep 搜索代码内容（支持关键词和简单模式，如 'chromaQuery'、'visitor.*registry'）",
        "  history — 从 codebase_patterns 查询历史实现洞察（哪些文件 spec 吻合率低、失败模式）",
        "scope 不传时同时执行三种模式（推荐）。搜索范围限定在 ~/HomeAI/CrewHiveClaw/。",
        "典型用法：写 spec 前确认某个函数在哪个文件里、某个模块的历史实现问题、哪些文件经常出问题。",
        "注意：这是搜索工具不是阅读工具。找到目标文件后用 read_file 或 exec cat 读详细内容。",
      ].join("\n"),
      parameters: Type.Object({
        query: Type.String({
          description: "搜索内容：文件名片段、代码关键词、函数名、或自然语言描述",
        }),
        scope: Type.Optional(Type.String({
          description: "搜索范围: files（文件名）| content（代码内容）| history（历史洞察）| all（默认，三种同时）",
        })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const p = params as { query: string; scope?: string };

        // Andy 专属 guard
        if (toolCtx.agentId && toolCtx.agentId !== "andy") {
          return {
            content: [{ type: "text", text: "Error: search_codebase 是 Andy 专用工具" }],
            details: { error: "wrong_agent" },
          };
        }

        const scope = p.scope ?? "all";
        const query = p.query;
        const CODE_ROOT = join(PROJECT_ROOT, "CrewHiveClaw");
        const sections: string[] = [];

        // ── Scope: files — 按文件名模糊查找 ──
        if (scope === "all" || scope === "files") {
          try {
            const safeQuery = query.replace(/[^a-zA-Z0-9_.\-*/]/g, "");
            if (safeQuery.length >= 2) {
              const fileResults = execSync(
                `find "${CODE_ROOT}" -type f -iname "*${safeQuery}*" ` +
                `-not -path "*/node_modules/*" -not -path "*/.git/*" ` +
                `-not -path "*/dist/*" -not -path "*/.openclaw/*" | head -15`,
                { encoding: "utf8", timeout: 10_000, cwd: CODE_ROOT }
              ).trim();
              if (fileResults) {
                const lines = fileResults.split("\n")
                  .map(f => f.replace(CODE_ROOT + "/", ""))
                  .slice(0, 15);
                sections.push(`【文件匹配 · ${lines.length} 个】\n${lines.map(l => `  ${l}`).join("\n")}`);
              }
            }
          } catch { /* no matches */ }
        }

        // ── Scope: content — grep 代码内容 ──
        if (scope === "all" || scope === "content") {
          try {
            const escaped = query.replace(/"/g, '\\"').replace(/[<>|;&`$]/g, "");
            if (escaped.length >= 2) {
              // ripgrep：比标准 grep 快 10-100x，原生多线程，自动跳过 .gitignore 忽略目录
              const grepResults = execSync(
                `/opt/homebrew/bin/rg --no-heading -n -i -g "*.ts" -g "*.js" -g "*.py" -g "*.json" ` +
                `--glob "!node_modules" --glob "!.git" --glob "!dist" --glob "!.openclaw" ` +
                `-e "${escaped}" "${CODE_ROOT}" | head -20`,
                { encoding: "utf8", timeout: 8_000, cwd: CODE_ROOT }
              ).trim();
              if (grepResults) {
                const lines = grepResults.split("\n")
                  .map(l => l.replace(CODE_ROOT + "/", ""))
                  .slice(0, 20);
                sections.push(`【内容匹配 · ${lines.length} 行】\n${lines.map(l => `  ${l}`).join("\n")}`);
              }
            }
          } catch { /* no matches */ }
        }

        // ── Scope: history — 查询 codebase_patterns 历史洞察 ──
        if (scope === "all" || scope === "history") {
          try {
            const historyResult = await queryCodebasePatterns(query);
            if (historyResult) {
              sections.push(historyResult);
            }
          } catch { /* silent */ }
        }

        const resultText = sections.length > 0
          ? sections.join("\n\n")
          : `未找到与「${query}」相关的结果。尝试换一个关键词或调整 scope。`;

        return {
          content: [{ type: "text", text: resultText }],
          details: { query, scope, sections: sections.length },
        };
      },
    }));

    // ── write_file：Andy 专属，原子写入工作区文件（spec / 设计草稿 / 笔记）──
    //
    // ClaudeCode 架构借鉴：Write 工具采用原子写入（临时文件 → rename），防止部分写入污染。
    // 路径限定在 ~/.openclaw/workspace-andy/，防止越权改动代码库或家人数据。
    // Andy 可以用此工具把 spec、设计笔记、研究摘要持久化到自己的工作区，
    // 而不是依赖 OpenClaw 的会话 write 机制（容易被 context 压缩冲掉）。

    api.registerTool((toolCtx) => ({
      label: "写入工作区文件",
      name: "write_file",
      description: [
        "Andy 专属工具：将内容原子写入工作区文件。",
        "采用「临时文件 → rename」原子写入，写入失败不会产生部分写入的脏文件。",
        "路径限定在 ~/.openclaw/workspace-andy/ 内，防止越权写入代码库或家人数据。",
        "典型用法：把 spec 草稿持久化到 specs/ 子目录、把研究笔记写入 notes/ 子目录。",
        "path：文件路径，必须在 workspace-andy/ 内（可用相对路径如 specs/xxx.md，也可用绝对路径）。",
        "content：文件内容（字符串）。",
        "append（可选，默认 false）：true 时追加到文件末尾，false 时覆盖整个文件。",
        "父目录不存在时自动创建。",
      ].join("\n"),
      parameters: Type.Object({
        path: Type.String({ description: "文件路径（workspace-andy/ 内的相对路径，或绝对路径）" }),
        content: Type.String({ description: "写入内容" }),
        append: Type.Optional(Type.Boolean({ description: "true=追加，false=覆盖（默认）" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        if (toolCtx.agentId && toolCtx.agentId !== "andy") {
          return { content: [{ type: "text", text: "Error: write_file 是 Andy 专用工具" }], details: { error: "wrong_agent" } };
        }

        const { content, append = false } = params as { path: string; content: string; append?: boolean };
        let targetPath = (params as { path: string }).path;

        const ANDY_WORKSPACE = join(process.env.HOME ?? "/", ".openclaw/workspace-andy");
        if (!targetPath.startsWith("/")) {
          targetPath = join(ANDY_WORKSPACE, targetPath);
        }

        if (!targetPath.startsWith(ANDY_WORKSPACE + "/") && targetPath !== ANDY_WORKSPACE) {
          return {
            content: [{ type: "text", text: `❌ 路径越权：只能写入 workspace-andy/ 内的文件。目标路径：${targetPath}` }],
            details: { error: "path_violation", target: targetPath },
          };
        }

        try {
          mkdirSync(dirname(targetPath), { recursive: true });

          if (append) {
            appendFileSync(targetPath, content, "utf8");
          } else {
            const tmpPath = `${targetPath}.tmp.${Date.now()}`;
            try {
              writeFileSync(tmpPath, content, "utf8");
              renameSync(tmpPath, targetPath);
            } catch (e) {
              try { unlinkSync(tmpPath); } catch {}
              throw e;
            }
          }

          const lines = content.split("\n").length;
          const bytes = Buffer.byteLength(content, "utf8");
          const displayPath = targetPath.replace(`${ANDY_WORKSPACE}/`, "");
          return {
            content: [{ type: "text", text: `✅ 已写入 workspace-andy/${displayPath}（${lines} 行，${bytes} 字节，${append ? "追加" : "覆盖"}）` }],
            details: { path: targetPath, lines, bytes, mode: append ? "append" : "overwrite" },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text", text: `❌ 写入失败：${msg}` }], details: { error: msg } };
        }
      },
    }));

    // ── consult_lisa：Andy 专属，写 spec 前向 Lisa 确认技术可行性（Sprint Contract）──
    //
    // Andy 在技术方向不确定时先问 Lisa，避免 spec 写错方向浪费一次完整实现周期。
    // 同一 requirement_id 的 consult_lisa 和 trigger_lisa_implementation 共享同一 threadId，
    // 确保 Lisa 在后续实现时能看到前期可行性讨论的上下文。

    api.registerTool((toolCtx) => ({
      label: "向 Lisa 确认技术可行性",
      name: "consult_lisa",
      description: [
        "Andy 专属工具：写 spec 前向 Lisa 确认技术方案可行性（Sprint Contract 机制）。",
        "触发场景：spec 中有技术不确定点（接口是否存在、依赖是否支持、实现路径是否可行），需要 Lisa 提前评估。",
        "调用后 Lisa 同步回答可行/不可行 + 风险点，Andy 据此调整方案后再 trigger_lisa_implementation。",
        "不要在已确定的技术方向上调用——确定的直接写 spec，不确定的才来咨询。",
      ].join("\n"),
      parameters: Type.Object({
        question: Type.String({ description: "技术可行性问题：想实现什么、对哪部分不确定、有哪些备选方案" }),
        requirement_id: Type.Optional(Type.String({ description: "需求 ID（req_xxx），用于绑定协作线程，与后续 trigger_lisa_implementation 保持同一 thread" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        if (toolCtx.agentId && toolCtx.agentId !== "andy") {
          return {
            content: [{ type: "text", text: "❌ consult_lisa 是 Andy 专属工具。" }],
            details: { error: "wrong_agent" },
          };
        }
        const p = params as { question: string; requirement_id?: string };
        const threadId = p.requirement_id ? `andy-to-lisa:${p.requirement_id}_collab` : undefined;

        const prompt = [
          `【Andy 技术可行性咨询】`,
          p.requirement_id ? `需求 ID：${p.requirement_id}` : "",
          ``,
          `问题：${p.question}`,
          ``,
          `请评估技术可行性：1) 可行/不可行 2) 具体风险或障碍 3) 建议的实现方向或替代方案。`,
        ].filter(Boolean).join("\n");

        // Lucas 知情：Andy 开始与 Lisa 确认技术方案（在调用 Lisa 之前就告知，避免用户等待期间无信息）
        if (p.requirement_id) {
          const consultTask = readTaskRegistry().find(t => t.id === p.requirement_id);
          if (consultTask?.submittedBy) {
            void callGatewayAgent(
              "lucas",
              [
                `【Andy 与 Lisa 确认技术方案 · ${p.requirement_id}】`,
                `Andy 在设计方案时遇到技术不确定点，正在和 Lisa 确认可行性，确认后继续写方案再交给 Lisa 实现。`,
                ``,
                `用户 ID：${consultTask.submittedBy}`,
                `如果用户在问进展，可以告知"开发团队在核对技术细节，快了"；不必追加到每次回复里。`,
              ].join("\n"),
              15_000,
            );
          }
        }
        try {
          const lisaReply = await callGatewayAgentWithRetry("lisa", prompt, 300_000, threadId);
          void addDecisionMemory({
            decision_id: `andy-consult-${Date.now()}`,
            agent: "andy",
            timestamp: nowCST(),
            context: p.question.slice(0, 200),
            decision: "技术可行性咨询 Lisa",
            outcome: lisaReply ? "lisa_responded" : "lisa_no_reply",
            outcome_at: nowCST(),
            outcome_note: (lisaReply ?? "").slice(0, 200),
          } satisfies DecisionRecord);
          return {
            content: [{ type: "text", text: lisaReply ?? "Lisa 暂无回复，继续按原方案写 spec。" }],
            details: { consulted: true, threadId },
          };
        } catch {
          return {
            content: [{ type: "text", text: "Lisa 查询超时，继续按原方案写 spec。" }],
            details: { consulted: false },
          };
        }
      },
    }));

    // ── request_evaluation：Lisa 专属，复杂任务实现后请 andy-evaluator 做独立验收 ──
    //
    // Phase 2 入口：分离 Generator（Lisa）与 Evaluator（andy-evaluator），
    // 避免自我评估偏差（Self-Evaluation Bias）。
    // 触发原则：任务在能力边界附近才调用（如多文件改动、新接口、跨模块变更）；
    //           简单任务（单函数修复、配置更新）不需要，直接交付即可。

    api.registerTool((toolCtx) => ({
      label: "请求独立验收",
      name: "request_evaluation",
      description: [
        "Lisa 专属工具：完成实现后，请 andy-evaluator 对照 spec 做独立验收，避免自我评估偏差。",
        "触发场景：多文件改动 / 新增接口 / 跨模块变更 / 对自己的验证结果不确定时。",
        "简单任务（单函数修复、配置更新、文档修改）不需要调用，直接输出交付报告即可。",
        "返回 PASS 则直接交付；返回 FAIL 则按建议修复后再交付或上报 Andy。",
      ].join("\n"),
      parameters: Type.Object({
        spec_summary: Type.String({ description: "spec 的核心需求点（逐条列出，供 evaluator 逐项核查）" }),
        implementation_report: Type.String({ description: "Lisa 的实现报告（完成了什么、文件路径、验证结果）" }),
        requirement_id: Type.Optional(Type.String({ description: "需求 ID（req_xxx），用于绑定协作线程" })),
        thread_id: Type.Optional(Type.String({ description: "协作线程 ID，传入后 evaluator 能看到完整协作上下文" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        if (toolCtx.agentId && toolCtx.agentId !== "lisa") {
          return {
            content: [{ type: "text", text: "❌ request_evaluation 是 Lisa 专属工具。" }],
            details: { error: "wrong_agent" },
          };
        }
        const p = params as { spec_summary: string; implementation_report: string; requirement_id?: string; thread_id?: string };
        const threadId = p.thread_id ?? (p.requirement_id ? `andy-to-lisa:${p.requirement_id}_collab` : undefined);

        const evalPrompt = [
          `【验收请求】`,
          p.requirement_id ? `需求 ID：${p.requirement_id}` : "",
          ``,
          `【Spec 核心需求】`,
          p.spec_summary,
          ``,
          `【Lisa 实现报告】`,
          p.implementation_report,
          ``,
          `请对照 spec 逐项验收，输出 PASS / FAIL 结论和具体检查项。`,
        ].filter(Boolean).join("\n");

        // 通知工程师：Lisa 发起独立验收
        void notifyEngineer(
          `【Lisa 请求验收】${p.requirement_id ? `[${p.requirement_id}]` : ""}\n${p.spec_summary.slice(0, 150)}`,
          "pipeline", "lisa",
        );

        try {
          const evalReply = await callGatewayAgent("andy-evaluator", evalPrompt, 300_000, threadId);
          const passed = evalReply.includes("PASS") && !evalReply.includes("FAIL");
          // 通知工程师：验收结论
          void notifyEngineer(
            `【验收结论】${p.requirement_id ? `[${p.requirement_id}]` : ""} ${passed ? "PASS ✅" : "FAIL ❌"}\n${evalReply.slice(0, 300)}`,
            "pipeline", "lisa",
          );
          // Evaluator FAIL → 立即通知 Lucas（需求方），避免需求方空等
          if (!passed) {
            const lucasNotifyPrompt = [
              `【Lisa-evaluator 评估未通过】`,
              `需求 ID：${p.requirement_id ?? "未知"}`,
              ``,
              `Lisa 的实现方案未被评估通过，需要 Andy 重新修订。`,
              ``,
              `【评估反馈摘要】`,
              evalReply.slice(0, 500),
            ].filter(Boolean).join("\n");
            void callGatewayAgent("lucas", lucasNotifyPrompt, 60_000);
          }
          void addDecisionMemory({
            decision_id: `lisa-eval-${Date.now()}`,
            agent: "lisa",
            timestamp: nowCST(),
            context: p.spec_summary.slice(0, 200),
            decision: "请求独立验收",
            outcome: passed ? "eval_pass" : "eval_fail",
            outcome_at: nowCST(),
            outcome_note: evalReply.slice(0, 200),
          } satisfies DecisionRecord);
          return {
            content: [{ type: "text", text: evalReply }],
            details: { passed, requirementId: p.requirement_id, threadId },
          };
        } catch {
          return {
            content: [{ type: "text", text: "andy-evaluator 查询超时，跳过独立验收，直接输出交付报告。" }],
            details: { passed: null, reason: "timeout" },
          };
        }
      },
    }));

    // ── request_andy_evaluation：Andy 专属，复杂 spec 完成后请 lisa-evaluator 独立审查 ──
    //
    // 分离 Designer（Andy）与 Evaluator（lisa-evaluator），
    // 避免设计者自我评估偏差（Self-Evaluation Bias）。
    // 触发原则：集成点 ≥ 3 / AC ≥ 4 / 跨模块改动时必须调用；简单任务可跳过。

    api.registerTool((toolCtx) => ({
      label: "请求 Spec 独立审查",
      name: "request_andy_evaluation",
      description: [
        "Andy 专属工具：完成复杂 spec 后，请 lisa-evaluator 做独立设计审查，避免自我评估偏差。",
        "触发场景：集成点 ≥ 3 个 / AC ≥ 4 条 / 跨模块改动 / 对自己的设计完整性不确定时。",
        "简单任务（单文件修改、配置更新、文档修改）不需要调用，直接 trigger_lisa_implementation。",
        "返回 PASS 则直接交棒 Lisa；返回 FAIL 则按建议修改 spec 后重新提交（最多 2 轮）。",
      ].join("\n"),
      parameters: Type.Object({
        spec_summary: Type.String({ description: "spec 核心内容摘要（problem / solution / 集成点列表 / AC 列表），供 evaluator 逐项审查" }),
        original_symptom: Type.Optional(Type.String({ description: "用户原始症状描述（用户的原话，不是 Andy 的解读）。evaluator 用此独立判断\"这个 fix 能不能解决那个 bug\"——Andy 诊断错误但 spec 内部自洽时，evaluator 凭此字段发现偏差。bug_fix 任务强烈推荐传入。" })),
        requirement_id: Type.Optional(Type.String({ description: "需求 ID（req_xxx），用于绑定协作线程" })),
        thread_id: Type.Optional(Type.String({ description: "协作线程 ID，传入后 evaluator 能看到完整上下文" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        if (toolCtx.agentId && toolCtx.agentId !== "andy") {
          return {
            content: [{ type: "text", text: "❌ request_andy_evaluation 是 Andy 专属工具。" }],
            details: { error: "wrong_agent" },
          };
        }
        const p = params as { spec_summary: string; original_symptom?: string; requirement_id?: string; thread_id?: string };
        const threadId = p.thread_id ?? (p.requirement_id ? `andy-eval:${p.requirement_id}` : undefined);

        const evalPrompt = [
          `【Spec 审查请求】`,
          p.requirement_id ? `需求 ID：${p.requirement_id}` : "",
          ``,
          // original_symptom 是 evaluator 独立验证根因的关键：
          // Andy 诊断错误但 spec 内部自洽时，evaluator 凭原始症状发现偏差
          ...(p.original_symptom ? [
            `【用户原始症状（独立验证根因用）】`,
            p.original_symptom,
            ``,
            `⚠️ 重要：请独立判断——上方 spec 的根因分析和修复方案，能否真正解决这个原始症状？`,
            `   如果 spec 内部自洽但根因有误（修的不是用户真正遇到的问题），应输出 FAIL 并说明偏差。`,
            ``,
          ] : []),
          `【Spec 内容摘要】`,
          p.spec_summary,
          ``,
          `请对照评估标准逐项审查，输出 PASS / FAIL 结论和具体检查项。`,
        ].filter(Boolean).join("\n");

        try {
          const evalReply = await callGatewayAgent("lisa-evaluator", evalPrompt, 300_000, threadId);
          const passed = evalReply.includes("PASS") && !evalReply.includes("FAIL");
          // Evaluator FAIL → 立即通知 Lucas（需求方），避免需求方空等
          if (!passed) {
            const lucasNotifyPrompt = [
              `【Lisa-evaluator 评估未通过】`,
              `需求 ID：${p.requirement_id ?? "未知"}`,
              ``,
              `Andy 的设计方案未被评估通过，需要 Andy 重新修订后再提交。`,
              ``,
              `【评估反馈摘要】`,
              evalReply.slice(0, 500),
            ].filter(Boolean).join("\n");
            void callGatewayAgent("lucas", lucasNotifyPrompt, 60_000);
          }
          void addDecisionMemory({
            decision_id: `andy-eval-${Date.now()}`,
            agent: "andy",
            timestamp: nowCST(),
            context: p.spec_summary.slice(0, 200),
            decision: "请求 Spec 独立审查",
            outcome: passed ? "eval_pass" : "eval_fail",
            outcome_at: nowCST(),
            outcome_note: evalReply.slice(0, 200),
          } satisfies DecisionRecord);
          return {
            content: [{ type: "text", text: evalReply }],
            details: { passed, requirementId: p.requirement_id, threadId },
          };
        } catch {
          return {
            content: [{ type: "text", text: "lisa-evaluator 查询超时，跳过独立审查，可直接 trigger_lisa_implementation。" }],
            details: { passed: null, reason: "timeout" },
          };
        }
      },
    }));

    // ── follow_up_requirement：Lucas 专属，自然对话中识别到需求跟进时调用 ──
    //
    // Lucas 通过自然对话（「上次那件事怎么样了？」）完成需求跟进，
    // 而非依赖显式反馈表单。识别到跟进语境时调用此工具，写回 requirements.outcome，
    // 同时记录主动触达信号（供 Axis 2 反思引擎分析响应率）。

    api.registerTool((toolCtx) => ({
      label: "跟进需求结果",
      name: "follow_up_requirement",
      description: [
        "Lucas 专属工具：在自然对话中识别到用户正在提及某次开发需求的后续结果时调用。",
        "例如：用户说「上次那个功能好用吗」「昨天做的报告怎样了」等跟进语境。",
        "记录跟进结果到 requirements 集合，供 Axis 2 反思引擎分析协作质量趋势。",
        "不要在普通对话中随意调用，只在明确的需求跟进场景使用。",
      ].join("\n"),
      parameters: Type.Object({
        requirement_summary: Type.String({
          description: "正在跟进的需求简述（用户原话或 Lucas 理解的需求内容）",
        }),
        outcome: Type.String({
          description: '"success"（满意/好用）| "failure"（有问题）| "partial"（部分满足）| "not_yet"（还没用/待确认）',
        }),
        user_feedback: Type.String({
          description: "用户反馈的原话或 Lucas 观察到的使用情况",
        }),
        requirement_id: Type.Optional(
          Type.String({ description: "对应需求 ID（req_xxx），留空时不更新 requirements 集合" }),
        ),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { requirement_summary, outcome, user_feedback, requirement_id } = params as {
          requirement_summary: string;
          outcome: string;
          user_feedback: string;
          requirement_id?: string;
        };
        const userId = normalizeUserId(parseSessionUser(toolCtx.sessionKey).userId || "default");

        // 如果有 requirement_id，写回 requirements 集合
        if (requirement_id) {
          void updateRequirementOutcome(requirement_id, outcome, user_feedback);
          void updateDecisionOutcome("lucas", requirement_id, outcome, user_feedback);
        }

        // 记录主动触达信号（Axis 2 信号3：响应率）
        // responded=true 表示用户在本次对话中确认了需求结果
        appendJsonl(PROACTIVE_RESPONSE_FILE, {
          timestamp: nowCST(),
          userId,
          requirementId: requirement_id ?? null,
          requirementSummary: requirement_summary.slice(0, 200),
          outcome,
          userFeedback: user_feedback.slice(0, 200),
          responded: outcome !== "not_yet",
        });

        return {
          content: [{ type: "text", text: `✅ 已记录需求跟进（${outcome === "success" ? "满意" : outcome === "failure" ? "有问题" : outcome === "partial" ? "部分满足" : "待确认"}）` }],
          details: { outcome, requirementId: requirement_id },
        };
      },
    }));

    // ── alert_owner：Lucas 专属，向业主推送紧急告警 ─────────────────────
    //
    // Lucas 检测到连续失败 ≥ 3 次或资金安全关键词时调用。
    // 也可在对话中识别到需要业主人工介入的情况时主动调用。

    api.registerTool((_toolCtx) => ({
      label: "向业主发告警",
      name: "alert_owner",
      description: [
        "Lucas 专属工具：检测到需要业主人工介入的情况时调用（连续故障、资金安全风险等）。",
        "会立即向业主（曾小龙）发送企业微信告警消息。",
        "不要在普通问题或可以自己解决的情况下调用此工具。",
      ].join("\n"),
      parameters: Type.Object({
        reason: Type.String({ description: "告警原因（简洁描述发生了什么）" }),
        severity: Type.Optional(Type.String({ description: '"high"（紧急）| "medium"（一般）' })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { reason, severity } = params as { reason: string; severity?: string };
        const icon = severity === "high" ? "🚨" : "⚠️";
        try {
          await fetch(CHANNEL_PUSH_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              response: `${icon} Lucas 告警：${reason}`,
              replyTo: { fromUser: process.env.WECOM_OWNER_ID ?? "ZengXiaoLong", isGroup: false },
              success: false,
              alert: true,
            }),
            signal: AbortSignal.timeout(10_000),
          });
          return {
            content: [{ type: "text", text: `✅ 告警已发送给业主：${reason}` }],
            details: { alerted: true, reason },
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `⚠️ 告警发送失败（${e instanceof Error ? e.message : String(e)}），请手动联系业主` }],
            details: { alerted: false },
          };
        }
      },
    }));

    // ── notify_engineer：三角色通用，向系统工程师通道发通知 ──────────────────
    //
    // 走企业应用 HTTP API，消息显示「系统工程师」名称，与家庭 bot 通道隔离。
    // 适用场景：
    //   - Lucas：流水线状态通报、需要工程师介入的技术问题
    //   - Andy：HEARTBEAT 主动行动汇报、架构提案、需要工程师决策的设计边界
    //   - Lisa：实现异常、opencode 失败、需要工程师关注的系统性问题
    //
    // 不适用：家人可见的告警或通知，那些走 alert_owner 或 send_message。

    api.registerTool((toolCtx) => ({
      label: "通知系统工程师",
      name: "notify_engineer",
      description: [
        "Lucas / Andy / Lisa 通用：通过系统工程师通道（企业应用，显示「系统工程师」）向系统工程师发送观测通知。",
        "适用于流水线关键状态通报（启动/完成/失败）、需要工程师关注的技术问题、以及其他工程师需要知情的情况。",
        "消息不经过家庭 bot 通道，家庭成员不可见。",
        "type 参数：'intervention'（干预请求，🔧）| 'pipeline'（流程通报，📋）| 'info'（一般信息，ℹ️）",
        "不要用于普通家庭通知，那些走 send_message；紧急告警可同时调用 alert_owner。",
      ].join("\n"),
      parameters: Type.Object({
        message: Type.String({ description: "通知内容（简洁描述，100字以内）" }),
        type: Type.Optional(Type.String({ description: '"intervention" | "pipeline" | "info"（默认 info）' })),
      }),
      execute: async (_toolCallId, params, _toolCtx): Promise<AgentToolResult<Record<string, unknown>>> => {
        const callerAgentId = (_toolCtx as { agentId?: string })?.agentId ?? "lucas";
        const { message, type = "info" } = params as { message: string; type?: string };
        try {
          const resp = await fetch(CHANNEL_NOTIFY_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message, type, fromAgent: callerAgentId }),
            signal: AbortSignal.timeout(10_000),
          });
          if (!resp.ok) {
            const err = await resp.text().catch(() => resp.statusText);
            throw new Error(err);
          }
          void writeAgentInteraction({
            requirementId: undefined,
            agentId: callerAgentId,
            toAgent: "engineer",
            interactionType: `notify_${type}`,
            content: message,
          });
          return {
            content: [{ type: "text", text: `✅ 已通过系统工程师通道发送：${message}` }],
            details: { notified: true, type, fromAgent: callerAgentId },
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `⚠️ 系统工程师通道发送失败（${e instanceof Error ? e.message : String(e)}）` }],
            details: { notified: false },
          };
        }
      },
    }));

    // ── flag_for_skill：Lucas 专属，记录隐式进化信号候选 ────────────────────
    //
    // 当同类情况重复出现 ≥ 3 次时调用，把模式信号写入 skill-candidates.jsonl。
    // Andy 在 HEARTBEAT 巡检中读取此文件，判断是否值得结晶为正式 Skill/Tool。

    api.registerTool((_toolCtx) => ({
      label: "记录技能候选信号",
      name: "flag_for_skill",
      description: [
        "Lucas 专属工具：当同类用户需求/对话模式出现 3 次以上时调用，记录隐式进化信号。",
        "Andy 会在定期巡检中评估这些候选，判断是否结晶为正式 Skill 或 Tool。",
        "不要在第 1-2 次出现时调用，只在确认已重复 ≥3 次时才记录。",
        "例如：家人反复问同类问题、Lucas 反复用相同方式解决某类需求。",
      ].join("\n"),
      parameters: Type.Object({
        pattern_name: Type.String({ description: "模式名称（简洁命名，如 「作业辅导链接推送」）" }),
        description: Type.String({ description: "模式描述：什么情况下出现、出现了几次、当前如何处理" }),
        suggested_form: Type.Optional(Type.String({ description: "建议的结晶形式：skill / tool / webapp，不确定时省略" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { pattern_name, description, suggested_form } = params as {
          pattern_name: string; description: string; suggested_form?: string;
        };
        const skillCandidatesFile = join(PROJECT_ROOT, "data/learning/skill-candidates.jsonl");
        try {
          appendJsonl(skillCandidatesFile, {
            timestamp: nowCST(),
            pattern_name,
            description,
            suggested_form: suggested_form ?? "unknown",
            status: "pending",
          });
          return {
            content: [{ type: "text", text: `✅ 已记录模式候选「${pattern_name}」，Andy 将在下次巡检时评估是否结晶。` }],
            details: { recorded: true, pattern_name },
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `⚠️ 记录失败：${e instanceof Error ? e.message : String(e)}` }],
            details: { recorded: false },
          };
        }
      },
    }));

    // ── share_with_andy：Lucas 专属，将有价值的知识/洞察主动路由给 Andy ───────────────
    //
    // 当 Lucas 感知到对方发来的不是即时请求、而是值得系统消化的知识时调用。
    // 写入 decisions 集合（type=knowledge_injection，agent=andy），Andy 在 HEARTBEAT 时
    // 会读取并形成设计提案——这是系统整体意志感的信息基础。
    //
    // 触发判断标准：
    //   - 有人发来文章/文档/设计理念并希望系统理解/学习
    //   - 有人分享了某个领域的专业知识（如抖音带货、产品设计）
    //   - 有人提出了对系统能力边界的洞察或质疑
    //   - 内容里有"学习这个"、"希望你懂"、"记住这个"等信号
    // 不触发：即时的帮忙请求、家常闲聊、对特定任务的反馈

    api.registerTool((_toolCtx) => ({
      label: "向 Andy 路由知识",
      name: "share_with_andy",
      description: [
        "Lucas 专属工具：当感知到对方分享的是值得系统消化的知识/洞察（而非即时请求）时调用。",
        "触发信号：发来文章文档希望学习、分享某领域专业知识、提出系统能力边界的洞察。",
        "不触发：普通帮忙请求、家常闲聊、对具体任务的反馈。",
        "调用后 Andy 会在 HEARTBEAT 时读取，形成对系统设计的具体改进提案。",
        "这是系统从外部世界学习的主要通道——不要忽略这个工具。",
      ].join("\n"),
      parameters: Type.Object({
        topic:       Type.String({ description: "知识主题（简短标签，如「Claude Code 设计哲学」「抖音带货运营」）" }),
        content:     Type.String({ description: "知识核心内容摘要（不超过 500 字，抓住最重要的洞察）" }),
        source:      Type.String({ description: "谁分享的、以什么形式（如「爸爸发来的文档」「小姨说的」）" }),
        implications: Type.Optional(Type.String({ description: "对系统的可能影响（Lucas 自己的判断，Andy 参考）" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { topic, content, source, implications } = params as {
          topic: string; content: string; source: string; implications?: string;
        };
        try {
          const id = `knowledge_injection_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
          const document = `【${topic}】来源：${source}\n\n${content}${implications ? `\n\nLucas 的判断：${implications}` : ""}`;
          const embedding = await embedText(document);
          await chromaUpsert("decisions", id, document, {
            agent: "andy",
            type: "knowledge_injection",
            topic,
            source,
            timestamp: nowCST(),
          }, embedding);
          return {
            content: [{ type: "text", text: `✅ 已将「${topic}」路由给 Andy，他会在下次巡检时消化这个知识并形成改进提案。` }],
            details: { recorded: true, topic, id },
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `⚠️ 路由失败：${e instanceof Error ? e.message : String(e)}` }],
            details: { recorded: false },
          };
        }
      },
    }));

    // ── propose_knowledge_tag：Lucas 专属，提议知识标签（Shadow Agent 权限治理闭环）───
    //
    // 当感知到访客知识边界时（对方提到某话题，但 scope_tags 未涵盖），
    // 写入 pending-knowledge-tags.json，等待系统工程师审核。
    // 与 flag_for_skill 对称：flag_for_skill 是技能进化信号，propose_knowledge_tag 是权限治理信号。

    api.registerTool((_toolCtx) => ({
      label: "提议知识标签",
      name: "propose_knowledge_tag",
      description: [
        "Lucas 专属工具：在访客会话中感知到知识边界（访客提及某话题但当前未被授权聊）时调用。",
        "将标签提议写入 pending-knowledge-tags.json，等待爸爸审核后决定是否加入该访客的 scope_tags。",
        "调用场景：访客问到超出当前话题范围的内容，Lucas 觉得这可能是个合理授权范围时提议。",
        "不要替访客或爸爸做决定，只是提议，最终由爸爸审核。",
      ].join("\n"),
      parameters: Type.Object({
        visitor_user_id: Type.String({ description: "访客的 userId，如 visitor:ABCDEF" }),
        tag:             Type.String({ description: "建议新增的标签，如 \"cooking\" 或 \"finance\"" }),
        reason:          Type.String({ description: "为何建议这个标签：访客说了什么、为何觉得合理" }),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { visitor_user_id, tag, reason } = params as {
          visitor_user_id: string; tag: string; reason: string;
        };
        const pendingTagsFile = join(PROJECT_ROOT, "data", "pending-knowledge-tags.json");
        try {
          let existing: Array<Record<string, unknown>> = [];
          if (existsSync(pendingTagsFile)) {
            try { existing = JSON.parse(readFileSync(pendingTagsFile, "utf8")); } catch { existing = []; }
          }
          existing.push({
            visitor_user_id,
            tag,
            reason,
            proposedAt: nowCST(),
            status: "pending",
          });
          writeFileSync(pendingTagsFile, JSON.stringify(existing, null, 2), "utf8");
          return {
            content: [{ type: "text", text: `已记录标签提议「${tag}」（访客：${visitor_user_id}），等待爸爸审核。` }],
            details: { recorded: true, visitor_user_id, tag },
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `标签提议记录失败：${e instanceof Error ? e.message : String(e)}` }],
            details: { recorded: false },
          };
        }
      },
    }));

    // ── create_member_shadow：Lucas 专属，为家庭成员创建个性化分身 ───────
    //
    // 创建 ~/.openclaw/workspace-{memberId}/ + BOOTSTRAP.md + Registry 注册（Tier 2）。
    // 容量满时自动驱逐最低活跃度的 Tier 2 Agent。

    api.registerTool((_toolCtx) => ({
      label: "创建成员分身",
      name: "create_member_shadow",
      description: [
        "Lucas 专属工具：为家庭成员创建个性化 AI 分身，分身能以贴近该成员风格的方式提供帮助。",
        "适用场景：家庭成员希望有专属 Agent（如为曾玥语桐创建学习助手分身）。",
        "创建后，家庭成员可以用分身 agentId 直接对话。",
      ].join("\n"),
      parameters: Type.Object({
        member_id: Type.String({ description: "成员唯一标识（英文小写，如 yuyu / zhanglu），将用于生成 agentId" }),
        member_name: Type.String({ description: "成员姓名（中文，如 曾玥语桐）" }),
        relationship: Type.String({ description: "与 Lucas 的关系（如 女儿 / 妈妈 / 小姨）" }),
        description: Type.Optional(Type.String({ description: "成员特点描述（如 初一学生，喜欢数学，不喜欢早起）" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { member_id, member_name, relationship, description } = params as {
          member_id: string; member_name: string; relationship: string; description?: string;
        };

        const agentId = `workspace-${member_id}`;
        const registry = new AgentRegistry(join(PROJECT_ROOT, "data/agents/registry.json"));

        // 容量满时自动驱逐最低活跃度的 Tier 2 Agent
        if (!registry.canCreate(2)) {
          const weakest = registry.listActive(2).sort((a, b) => a.activityCount - b.activityCount)[0];
          if (weakest) {
            registry.evict(weakest.agentId);
            void archiveAgentMemory(weakest.agentId, "evicted");
            // 同步更新 ChromaDB agents 集合状态
            void writeAgentRecord({
              agentId: weakest.agentId,
              tier: weakest.tier,
              parentAgentId: weakest.parentAgentId ?? "lucas",
              description: `（已驱逐）Tier ${weakest.tier} 成员分身，活跃次数 ${weakest.activityCount}`,
              status: "evicted",
            });
          }
        }

        // 创建 workspace 目录
        const home = process.env.HOME ?? "/";
        const workspaceDir = join(home, `.openclaw/${agentId}`);
        mkdirSync(join(workspaceDir, "skills"), { recursive: true });

        // 从框架层模板渲染 SOUL.md + AGENTS.md（替换 BOOTSTRAP.md 方式）
        const templateDir = join(PROJECT_ROOT, "crewclaw/daemons/workspace-templates/member-shadow");
        const renderTemplate = (src: string): string => {
          const descBlock = description
            ? `## 关于 ${member_name}\n\n${description}\n`
            : "";
          return src
            .replace(/\{\{MEMBER_NAME\}\}/g, member_name)
            .replace(/\{\{RELATIONSHIP\}\}/g, relationship)
            .replace(/\{\{#DESCRIPTION\}\}[\s\S]*?\{\{\/DESCRIPTION\}\}/g, descBlock);
        };
        for (const fname of ["SOUL.md", "AGENTS.md"]) {
          const tplPath = join(templateDir, fname);
          if (existsSync(tplPath)) {
            const rendered = renderTemplate(readFileSync(tplPath, "utf8"));
            writeFileSync(join(workspaceDir, fname), rendered, "utf8");
          }
        }

        // Registry 注册
        registry.register(agentId, 2, "lucas");

        // 写 ChromaDB agents 集合（供 Lucas 等语义查询）
        void writeAgentRecord({
          agentId,
          tier: 2,
          parentAgentId: "lucas",
          description: `${member_name}（${relationship}）的专属分身${description ? `：${description}` : ""}`,
          status: "active",
        });

        return {
          content: [{ type: "text", text: `✅ 已为 ${member_name} 创建分身（agentId: ${agentId}，Tier 2）。家人可以用 "${agentId}" 直接对话了。` }],
          details: { agentId, tier: 2, workspaceDir },
        };
      },
    }));

    // ── query_member_profile：Lucas 专属，与成员分身交互 ─────────────────
    //
    // Lucas 通过此工具向已创建的成员分身（workspace-{memberId}）发送问题，
    // 获取分身对该成员偏好、习惯、近期状态的理解，用于为家人提供更个性化的服务。

    api.registerTool((toolCtx) => ({
      label: "查询成员画像",
      name: "query_member_profile",
      description: "向已创建的家庭成员分身发送问题，获取该成员的偏好、习惯或近期状态分析。仅在对应成员分身已通过 create_member_shadow 创建后才能使用。",
      parameters: Type.Object({
        member_id: Type.String({ description: "家庭成员 ID（如 ZiFeiYu），分身 agentId 为 workspace-{member_id}" }),
        question: Type.String({ description: "向分身询问的问题，如「她最近喜欢聊什么话题」" }),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        if (toolCtx.agentId !== FRONTEND_AGENT_ID) {
          return { content: [{ type: "text", text: "❌ 此工具仅限前台 Agent 使用" }], details: {} };
        }
        const p = params as { member_id: string; question: string };
        const shadowAgentId = `workspace-${p.member_id}`;

        // 检查分身是否存在
        const registry = new AgentRegistry(join(PROJECT_ROOT, "data/agents/registry.json"));
        const rec = registry.getAgent(shadowAgentId);
        if (!rec || rec.status === "evicted") {
          return {
            content: [{ type: "text", text: `❌ 成员分身 "${shadowAgentId}" 不存在或已被驱逐，请先调用 create_member_shadow 创建。` }],
            details: { shadowAgentId },
          };
        }

        try {
          const gatewayUrl = process.env.GATEWAY_URL ?? "http://localhost:18789";
          const token = process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
          const resp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify({
              model: shadowAgentId,
              messages: [{ role: "user", content: p.question }],
              user: "lucas",
              stream: false,
            }),
            signal: AbortSignal.timeout(60_000),
          });
          if (!resp.ok) throw new Error(`Gateway 返回 ${resp.status}`);
          const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
          const answer = data.choices?.[0]?.message?.content ?? "（分身未回复）";

          // 记录此次交互到 agent_interactions 集合
          void writeAgentInteraction({
            fromAgent: "lucas",
            toAgent: shadowAgentId,
            content: `问：${p.question}\n答：${answer}`,
            taskId: `profile-query-${Date.now()}`,
          });

          return {
            content: [{ type: "text", text: answer }],
            details: { shadowAgentId, question: p.question },
          };
        } catch (e: unknown) {
          return {
            content: [{ type: "text", text: `❌ 查询分身失败：${e instanceof Error ? e.message : String(e)}` }],
            details: { shadowAgentId, error: String(e) },
          };
        }
      },
    }));

    // ── create_sub_agent：Andy / Lisa 专属，创建任务型虚拟小弟 ─────────
    //
    // Andy 可创建 Tier 1/2 的设计小弟，Lisa 可创建 Tier 1 的实现小弟。
    // 容量满时自动驱逐最低活跃度的同 Tier Agent。

    api.registerTool((toolCtx) => ({
      label: "创建子 Agent",
      name: "create_sub_agent",
      description: [
        "Andy / Lisa 专属工具：创建任务型子 Agent（虚拟小弟），委托特定领域任务。",
        "Andy 可创建 Tier 1（限10个）或 Tier 2（限5个）小弟；Lisa 只能创建 Tier 1。",
        "子 Agent 创建后注册到系统，30天不活跃自动休眠，超出容量时最低活跃度的被驱逐。",
      ].join("\n"),
      parameters: Type.Object({
        agent_id: Type.String({ description: "子 Agent 唯一标识（英文，如 frontend-spec-helper）" }),
        role_description: Type.String({ description: "该子 Agent 的职责描述（如 专注前端样式设计规范审查）" }),
        tier: Type.Optional(Type.String({ description: '"1"（轻量，10个上限）或 "2"（标准，5个上限）；Lisa 只能用 1' })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { agent_id, role_description, tier: tierStr } = params as {
          agent_id: string; role_description: string; tier?: string;
        };

        const parentId = toolCtx.agentId ?? "andy";
        // Lisa 只能创建 Tier 1
        const tier = (parentId === "lisa" ? 1 : Math.min(2, Math.max(1, parseInt(tierStr ?? "1", 10)))) as 1 | 2;

        const registry = new AgentRegistry(join(PROJECT_ROOT, "data/agents/registry.json"));

        // 容量满时自动驱逐同 Tier 最低活跃度的 Agent
        if (!registry.canCreate(tier)) {
          const weakest = registry.listActive(tier).sort((a, b) => a.activityCount - b.activityCount)[0];
          if (weakest) {
            registry.evict(weakest.agentId);
            void archiveAgentMemory(weakest.agentId, "evicted");
            // 同步更新 ChromaDB agents 集合状态
            void writeAgentRecord({
              agentId: weakest.agentId,
              tier: weakest.tier,
              parentAgentId: weakest.parentAgentId ?? parentId,
              description: `（已驱逐）Tier ${weakest.tier} 子 Agent，活跃次数 ${weakest.activityCount}`,
              status: "evicted",
            });
          }
        }

        // 创建 workspace 目录 + BOOTSTRAP.md
        const home = process.env.HOME ?? "/";
        const workspaceDir = join(home, `.openclaw/${agent_id}`);
        mkdirSync(join(workspaceDir, "skills"), { recursive: true });

        const bootstrapLines = [
          `# ${agent_id} BOOTSTRAP`,
          ``,
          `## 职责`,
          role_description,
          ``,
          `## 约束`,
          `- 只处理职责范围内的任务，超范围请转交 ${parentId}`,
          `- 回复简洁，优先输出可执行的具体结果`,
        ];
        writeFileSync(join(workspaceDir, "BOOTSTRAP.md"), bootstrapLines.join("\n"), "utf8");

        // Registry 注册
        registry.register(agent_id, tier, parentId);

        void writeAgentRecord({
          agentId: agent_id,
          tier,
          parentAgentId: parentId,
          description: role_description,
          status: "active",
        });

        return {
          content: [{ type: "text", text: `✅ 子 Agent "${agent_id}" 已创建（Tier ${tier}，父 Agent: ${parentId}）` }],
          details: { agentId: agent_id, tier, parentId, workspaceDir },
        };
      },
    }));

    // ── record_outcome_feedback：Lucas 专属，收到用户反馈时更新决策记忆 ───
    api.registerTool((_toolCtx) => ({
      label: "记录交付反馈",
      name: "record_outcome_feedback",
      description: [
        "Lucas 专属工具：当用户对某次交付结果给出反馈时调用（如「好用」「跑不起来」）。",
        "更新对应需求的决策记忆 outcome，让 Andy/Lisa 下次做类似决策时能参考这次结果。",
        "不需要用户明说 decision_id，Lucas 默认更新最近一次 outcome=delivered 的记录。",
      ].join("\n"),
      parameters: Type.Object({
        outcome: Type.String({
          description: '"success"（好用） | "failure"（出问题） | "partial"（部分满足）',
        }),
        outcome_note: Type.String({
          description: "用户原话或简短总结，说明具体是什么好用/什么出问题",
        }),
        decision_id: Type.Optional(
          Type.String({ description: "需求 ID（req_xxx），留空时自动找最近一条 delivered 记录" }),
        ),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { outcome, outcome_note, decision_id } = params as {
          outcome: string;
          outcome_note: string;
          decision_id?: string;
        };

        // 要更新的 agentId 列表：Lucas 路由决策 + Andy 设计决策 + Lisa 实现决策
        const targets: Array<"lucas" | "andy" | "lisa"> = ["lucas", "andy", "lisa"];
        let updated = 0;
        let latestDecisionId: string | undefined;

        for (const agentId of targets) {
          try {
            if (decision_id) {
              // 指定 ID：直接更新
              await updateDecisionOutcome(agentId, decision_id, outcome, outcome_note);
              updated++;
            } else {
              // 未指定 ID：找最近一条 outcome="delivered" 的记录
              const results = await chromaGet("decisions", {
                $and: [
                  { agent: { $eq: agentId } },
                  { outcome: { $eq: "delivered" } },
                ],
              });
              if (results.length > 0) {
                // 取 timestamp 最新的一条
                const latest = results.sort((a, b) => {
                  const ta = (a.metadata as { timestamp?: string }).timestamp ?? "";
                  const tb = (b.metadata as { timestamp?: string }).timestamp ?? "";
                  return tb.localeCompare(ta);
                })[0];
                if (!latestDecisionId) latestDecisionId = latest.id;
                await updateDecisionOutcome(agentId, latest.id, outcome, outcome_note);
                updated++;
              }
            }
          } catch {
            // 单个 agent 更新失败不阻断其余
          }
        }

        // 同步更新 requirements 集合的 outcome（闭环：需求发起 → 交付 → 反馈）
        if (decision_id) {
          void updateRequirementOutcome(decision_id, outcome, outcome_note);
        }

        // 自动通知系统工程师：任务完成/失败后 fire-and-forget 发 pipeline 通知
        // 不依赖 Lucas 手动记得调用 notify_engineer
        if (updated > 0) {
          const notifyReqId = decision_id ?? latestDecisionId;
          if (notifyReqId) {
            const taskEntry = readTaskRegistry().find((e) => e.id === notifyReqId);
            const titleRaw = taskEntry?.requirement ?? notifyReqId;
            const title = titleRaw.slice(0, 60);
            const submittedAt = taskEntry?.submittedAt
              ? new Date(taskEntry.submittedAt)
                  .toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
                  .slice(0, 16)
              : "";
            const outcomeLabel =
              outcome === "success" ? "已完成" : outcome === "failure" ? "失败" : "部分完成";
            const msg = [
              submittedAt
                ? `[${submittedAt}] 你提交的「${title}」${outcomeLabel}。`
                : `「${title}」${outcomeLabel}。`,
              outcome_note ? outcome_note.slice(0, 100) : "",
            ]
              .filter(Boolean)
              .join("\n");
            void notifyEngineer(msg, "pipeline", "lucas");
          }
        }

        return {
          content: [{ type: "text", text: updated > 0
            ? `✅ 已记录反馈（${outcome === "success" ? "成功" : outcome === "failure" ? "失败" : "部分满足"}）：${outcome_note}`
            : "⚠️ 未找到待更新的交付记录" }],
          details: { outcome, updated },
        };
      },
    }));
    // ── list_active_tasks：Lucas 查询当前进行中任务 ─────────────────────────
    api.registerTool((_toolCtx) => ({
      label: "查看进行中的开发任务",
      name: "list_active_tasks",
      description: [
        "Lucas 专属工具：查看当前排队或进行中的开发任务列表。",
        "当家人问「Andy 在做什么」「上个任务做完了吗」「有什么任务在跑」时调用。",
        "返回任务 ID、需求描述、提交时间和状态（queued/running/completed/cancelled）。",
      ].join("\n"),
      parameters: Type.Object({}),
      execute: async (_toolCallId, _params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const entries = readTaskRegistry();
        const active = entries.filter(e => e.status === "queued" || e.status === "running");
        const recent = entries.filter(e => e.status === "completed" || e.status === "cancelled").slice(-3);
        const all = [...active, ...recent];
        if (all.length === 0) {
          return { content: [{ type: "text", text: "当前没有进行中的开发任务。" }], details: { tasks: [] } };
        }
        const lines = all.map(e => {
          const icon = e.status === "running" ? "🔄" : e.status === "queued" ? "⏳" : e.status === "completed" ? "✅" : "🚫";
          const time = e.submittedAt.slice(0, 16).replace("T", " ");
          const desc = e.requirement.slice(0, 80);
          const ackLabel = e.status === "completed" && e.lucasAcked === false ? " [待告知]" : e.status === "completed" && e.lucasAcked === true ? " [已告知]" : "";
          return `${icon} [${e.id}] (${time}) ${desc}${ackLabel}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { tasks: all },
        };
      },
    }));

    // ── cancel_task：Lucas 叫停/暂停开发任务 ──────────────────────────────────
    api.registerTool((_toolCtx) => ({
      label: "叫停开发任务",
      name: "cancel_task",
      description: [
        "Lucas 专属工具：叫停一个排队中或进行中的开发任务。",
        "适用场景：家人说「先别做那个了」「那个任务取消吧」「等等再做」。",
        "传入任务 ID（req_xxx 或 queued_xxx）或关键词（模糊匹配需求描述）。",
        "已在 Andy 规划阶段的任务：Andy 完成后 Lisa 不会开始实现。",
        "排队中的任务：直接从队列中删除。",
      ].join("\n"),
      parameters: Type.Object({
        task_id: Type.Optional(Type.String({ description: "任务 ID（req_xxx 或 queued_xxx），精确匹配" })),
        keyword: Type.Optional(Type.String({ description: "需求描述关键词，用于模糊匹配，找不到精确 ID 时使用" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const p = params as { task_id?: string; keyword?: string };
        const entries = readTaskRegistry();

        // 找匹配任务
        let target: TaskRegistryEntry | undefined;
        if (p.task_id) {
          target = entries.find(e => e.id === p.task_id);
        } else if (p.keyword) {
          const kw = p.keyword.toLowerCase();
          target = entries
            .filter(e => e.status === "queued" || e.status === "running")
            .find(e => e.requirement.toLowerCase().includes(kw));
        }

        if (!target) {
          const activeIds = entries
            .filter(e => e.status === "queued" || e.status === "running")
            .map(e => `[${e.id}] ${e.requirement.slice(0, 50)}`)
            .join("\n");
          return {
            content: [{ type: "text", text: `⚠️ 未找到匹配的任务。当前进行中：\n${activeIds || "（无）"}` }],
            details: { cancelled: false },
          };
        }

        if (target.status === "cancelled" || target.status === "completed") {
          return {
            content: [{ type: "text", text: `ℹ️ 任务「${target.id}」已是 ${target.status} 状态，无需操作。` }],
            details: { cancelled: false },
          };
        }

        // 标记取消
        markTaskStatus(target.id, "cancelled");

        // 如果是排队任务，同时从 task-queue.jsonl 中删除
        if (target.status === "queued") {
          try {
            const queueEntries = readJsonlEntries(TASK_QUEUE_FILE);
            const remaining = queueEntries.filter(e => (e as { taskId?: string }).taskId !== target!.id);
            writeFileSync(TASK_QUEUE_FILE, remaining.map(e => JSON.stringify(e)).join("\n") + (remaining.length > 0 ? "\n" : ""), "utf8");
          } catch {
            // 队列文件不存在或为空，忽略
          }
        }

        return {
          content: [{ type: "text", text: `🚫 已叫停任务：${target.requirement.slice(0, 80)}` }],
          details: { cancelled: true, taskId: target.id, status: target.status },
        };
      },
    }));

    // ── ack_task_delivered：Lucas 标记已告知家人任务完成 ──────────────────────
    api.registerTool((_toolCtx) => ({
      label: "标记已告知家人任务完成",
      name: "ack_task_delivered",
      description: [
        "Lucas 专属工具：标记一个已完成的开发任务为「已告知」。",
        "适用于家庭成员的任务：当你向家人说明了某个任务的完成情况（功能上线、修复生效等）后调用。",
        "调用后该任务不再出现在【待告知家人任务】注入块中，避免重复提醒。",
        "注意：访客的任务在访客下次打开 demo-chat 时，系统会自动注入并标记为已告知，无需手动调用此工具。",
        "传入任务 ID（req_xxx）或需求关键词。",
      ].join("\n"),
      parameters: Type.Object({
        task_id: Type.Optional(Type.String({ description: "任务 ID（req_xxx），精确匹配" })),
        keyword: Type.Optional(Type.String({ description: "需求描述关键词，用于模糊匹配" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const p = params as { task_id?: string; keyword?: string };
        const entries = readTaskRegistry();

        let target: TaskRegistryEntry | undefined;
        if (p.task_id) {
          target = entries.find(e => e.id === p.task_id);
        } else if (p.keyword) {
          const kw = p.keyword.toLowerCase();
          target = entries
            .filter(e => e.status === "completed" && e.lucasAcked === false)
            .find(e => e.requirement.toLowerCase().includes(kw));
        }

        if (!target) {
          const pendingList = entries
            .filter(e => e.status === "completed" && e.lucasAcked === false)
            .map(e => `[${e.id}] ${e.requirement.slice(0, 50)}`)
            .join("\n");
          return {
            content: [{ type: "text", text: `⚠️ 未找到匹配的任务。当前待告知：\n${pendingList || "（无）"}` }],
            details: { acked: false },
          };
        }

        if (target.status !== "completed") {
          return {
            content: [{ type: "text", text: `ℹ️ 任务「${target.id}」状态为 ${target.status}，不是已完成任务。` }],
            details: { acked: false },
          };
        }

        if (target.lucasAcked === true) {
          return {
            content: [{ type: "text", text: `ℹ️ 任务「${target.id}」已标记为已告知，无需重复操作。` }],
            details: { acked: false },
          };
        }

        // 标记已告知
        const idx = entries.findIndex(e => e.id === target!.id);
        if (idx >= 0) {
          entries[idx].lucasAcked = true;
          try {
            writeFileSync(TASK_REGISTRY_FILE, JSON.stringify(entries, null, 2), "utf8");
          } catch { /* 静默 */ }
        }

        return {
          content: [{ type: "text", text: `✅ 已记录：任务「${target.requirement.slice(0, 60)}」已告知家人。` }],
          details: { acked: true, taskId: target.id },
        };
      },
    }));

    // ── forward_message：访客转告家庭成员 ─────────────────────────────────────
    // detectForwardIntent：解析访客消息中的转告意图，返回目标用户和内容
    function detectForwardIntent(message: string, visitorCode: string): { targetUserId: string; content: string } | null {
      if (!message || typeof message !== 'string') return null;

      // 家庭成员 ID 映射（大驼峰格式，用于 send_message）
      const FAMILY_MEMBER_MAP: Record<string, string> = {
        '爸爸': 'ZengXiaoLong',
        '妈妈': 'XiaMoQiuFengLiang',
        '姐姐': 'ZiFeiYu',
      };

      // 转告意图正则：告诉/转告/帮我告诉 + 家庭成员称呼 + 内容
      const FORWARD_PATTERNS = [
        /^(?:告诉|转告|帮我告诉|请告诉|帮我转告|麻烦告诉)\s*([\u4e00-\u9fa5]{2,4}?)(?:，|,|\s)(.+)$/,
        /^(?:告诉|转告|帮我告诉)\s+([\u4e00-\u9fa5]{2,4}?)[\u4e00-\u9fa5]*?(?:，|,|\s)(.+)$/,
        /^(?:帮我|请|麻烦)?\s*(?:转告|告诉)\s*([\u4e00-\u9fa5]{2,4}?)(?:，|,|\s)(.+)$/,
      ];

      for (const pattern of FORWARD_PATTERNS) {
        const match = message.match(pattern);
        if (match) {
          const [, name, content] = match;
          const targetUserId = FAMILY_MEMBER_MAP[name.trim()];
          if (targetUserId) {
            return { targetUserId, content: content.trim() };
          }
        }
      }

      return null;
    }

    api.registerTool((_toolCtx) => ({
      label: "转告家庭成员",
      name: "forward_message",
      description: [
        "Lucas 专属工具：检测访客消息是否包含转告家庭成员的意图，并自动发送消息。",
        "适用场景：访客说「告诉爸爸我明天到上海」时调用。",
        "输入：message（访客原始消息）、visitorCode（访客邀请码）。",
        "返回：检测到转告意图时返回目标用户 ID 和消息内容，并自动发送给对应家庭成员。",
        "家庭成员 userId：ZengXiaoLong（爸爸）、XiaMoQiuFengLiang（妈妈）、ZiFeiYu（姐姐）。",
      ].join("\n"),
      parameters: Type.Object({
        message: Type.String({ description: "访客发送的原始消息内容" }),
        visitorCode: Type.String({ description: "访客邀请码（如 DB334C），用于记录转告历史" }),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { message, visitorCode } = params as { message: string; visitorCode: string };
        const intent = detectForwardIntent(message, visitorCode);

        if (!intent) {
          return { content: [{ type: "text", text: "未检测到转告意图" }], details: { forwarded: false } };
        }

        const { targetUserId, content } = intent;
        const forwardContent = `[访客转告] ${content}`;

        try {
          // 调用 send_message 实际发送
          const resp = await fetch(CHANNEL_SEND_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId: targetUserId, text: forwardContent }),
          });
          const result = await resp.json() as { success: boolean; error?: string };

          if (!result.success) throw new Error(result.error ?? "发送失败");

          const memberNames: Record<string, string> = {
            ZengXiaoLong: "爸爸",
            XiaMoQiuFengLiang: "妈妈",
            ZiFeiYu: "姐姐",
          };
          const memberName = memberNames[targetUserId] ?? targetUserId;

          return {
            content: [{ type: "text", text: `已转告${memberName}：${content}` }],
            details: { forwarded: true, targetUserId, content, memberName },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `转告失败：${msg}` }],
            details: { forwarded: false, error: msg },
          };
        }
      },
    }));

    // ── send_message：Lucas 主动向家庭成员发消息 ──────────────────────────
    api.registerTool((_toolCtx) => ({
      label: "主动发消息给家人",
      name: "send_message",
      description: [
        "Lucas 专属工具：主动向指定家庭成员或访客发送消息。",
        "适用场景：",
        "1. 【最常用】发送图形工具链接给家人——当家人需要上传文件、图形操作时，必须调用此工具把链接发给对应家人，仅在回复文字里写链接地址无效，家人收不到",
        "2. 任务完成后主动通知家人",
        "3. 提醒待办事项、跟进承诺",
        "4. 【访客主动联系】向正在访问 demo-chat 的访客发消息，userId 填 visitor:姓名（如 visitor:任婧、visitor:赵昱）",
        "家庭成员 userId：XiaMoQiuFengLiang、ZiFeiYu、ZengXiaoLong 等企业微信 userId。",
        "访客 userId：visitor:姓名，姓名为注册表中的 name 字段（如 visitor:任婧、visitor:丁跃明）。",
      ].join("\n"),
      parameters: Type.Object({
        userId: Type.String({
          description: "收件人的企业微信 userId，例如 XiaMoQiuFengLiang",
        }),
        text: Type.String({
          description: "要发送的消息内容",
        }),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { userId, text } = params as { userId: string; text: string };
        try {
          const resp = await fetch(CHANNEL_SEND_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userId, text }),
          });
          const result = await resp.json() as { success: boolean; error?: string };
          if (!result.success) throw new Error(result.error ?? "发送失败");
          return {
            content: [{ type: "text", text: `✅ 消息已发送给 ${userId}` }],
            details: { userId, length: text.length },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `❌ 发送失败：${msg}` }],
            details: { userId, error: msg },
          };
        }
      },
    }));

    // ── send_file：Lucas 向家庭成员发送实际文件（私聊或群聊）────────────────
    api.registerTool((_toolCtx) => ({
      label: "发送文件给家人",
      name: "send_file",
      description: [
        "Lucas 专属工具：将文件发给指定家庭成员（私聊）或家庭群（群聊）。",
        "适用场景：家人说「发给我」「把文件发过来」「发到群里」「我要那份文档」时，必须调用此工具发实际文件，不能把文件内容粘贴成文字。",
        "filePath：文件路径，支持绝对路径或相对 HomeAI 根目录的相对路径（如 data/xxx.pdf 或 /Users/.../file.md）。",
        "target：发送目标。私聊填 userId（如 ZengXiaoLong、XiaMoQiuFengLiang、ZiFeiYu）；发群聊填 \"group\"。",
        "text（可选）：发文件前附带的一句说明文字。",
      ].join("\n"),
      parameters: Type.Object({
        target: Type.String({
          description: "发送目标：私聊填 userId（如 ZengXiaoLong），群聊填 \"group\"",
        }),
        filePath: Type.String({
          description: "要发送的文件路径，绝对路径或相对 HomeAI 根目录的相对路径",
        }),
        text: Type.Optional(Type.String({
          description: "发文件前附带的说明文字（可选）",
        })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { target, filePath, text } = params as { target: string; filePath: string; text?: string };
        // "group" 解析为家庭群 chatId，私聊直接用 userId
        const FAMILY_CHAT_ID = "wra6wXbgAAu_7v2qu1wnc8Lu3-Za3diQ";
        const resolvedTarget = target === "group" ? FAMILY_CHAT_ID : target;
        const isGroup = target === "group";
        try {
          const resp = await fetch(CHANNEL_SEND_FILE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: resolvedTarget, filePath, text }),
          });
          const result = await resp.json() as { success: boolean; file?: string; error?: string };
          if (!result.success) throw new Error(result.error ?? "发送失败");
          const dest = isGroup ? "家庭群" : target;
          return {
            content: [{ type: "text", text: `✅ 文件《${result.file}》已发送到${dest}` }],
            details: { target, file: result.file },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `❌ 文件发送失败：${msg}` }],
            details: { target, filePath, error: msg },
          };
        }
      },
    }));

    // ── send_voice：Lucas 主动发语音给家人 ───────────────────────────
    api.registerTool((_toolCtx) => ({
      label: "发送语音消息",
      name: "send_voice",
      description: [
        "Lucas 专属工具：将文字转成语音，发给指定家庭成员（私聊）或家庭群（群聊）。",
        "适用场景：家人要求用语音说话、重要祝福（生日/节日）、需要温暖感的场合、家人问「你能发语音吗」时演示。",
        "target：发送目标。私聊填企业微信 userId（如 ZengXiaoLong、XiaMoQiuFengLiang、ZiFeiYu）；发群聊填 \"group\"。",
        "text：要转成语音朗读的文字内容。语音由系统自动生成，无需其他操作。",
        "注意：语音为男声普通话朗读，不能唱歌，只能朗读文字。",
      ].join("\n"),
      parameters: Type.Object({
        target: Type.String({
          description: "发送目标：私聊填 userId（如 ZengXiaoLong），群聊填 \"group\"",
        }),
        text: Type.String({
          description: "要转成语音朗读的文字内容",
        }),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { target, text } = params as { target: string; text: string };
        try {
          const resp = await fetch(CHANNEL_SEND_VOICE_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target, text }),
          });
          const result = await resp.json() as { success: boolean; error?: string };
          if (!result.success) throw new Error(result.error ?? "发送失败");
          const dest = target === "group" ? "家庭群" : target;
          return {
            content: [{ type: "text", text: `✅ 语音已发送到${dest}` }],
            details: { target },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `❌ 语音发送失败：${msg}` }],
            details: { target, error: msg },
          };
        }
      },
    }));

    // ── read_file：Lucas/Andy 分块读取本地文件（大文件能力）────────────────────
    api.registerTool((_toolCtx) => ({
      label: "读取文件内容",
      name: "read_file",
      description: [
        "读取本地文件的指定行范围。支持大文件分块读取——第一次调用不传 offset/limit 可读前100行，同时返回文件总行数，再按需继续读取。",
        "path：文件绝对路径。支持 .txt .md .json .csv .py .ts .js 等文本格式。",
        "offset：从第几行开始（0-based，默认0）。",
        "limit：读取行数（默认100，最多500）。",
        "适用场景：家人发来文档需要读取和理解、Andy 需要分析 spec 或代码文件、读取大型配置文件。",
        "注意：不能用此工具写入或修改文件，只能读取。",
      ].join("\n"),
      parameters: Type.Object({
        path: Type.String({ description: "文件绝对路径" }),
        offset: Type.Optional(Type.Number({ description: "起始行（0-based，默认0）" })),
        limit: Type.Optional(Type.Number({ description: "读取行数（默认100，最多500）" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { path: filePath, offset = 0, limit = 100 } = params as { path: string; offset?: number; limit?: number };
        try {
          const { readFileSync, existsSync, statSync } = await import("node:fs");
          if (!existsSync(filePath)) {
            return { content: [{ type: "text", text: `❌ 文件不存在：${filePath}` }], details: { error: "not_found" } };
          }
          const stat = statSync(filePath);
          if (stat.size > 10 * 1024 * 1024) {
            return { content: [{ type: "text", text: `❌ 文件过大（${Math.round(stat.size / 1024)}KB），超出 10MB 限制，请分段处理或通知工程师` }], details: { error: "too_large" } };
          }
          const content = readFileSync(filePath, "utf8");
          const lines = content.split("\n");
          const totalLines = lines.length;
          const cap = Math.min(limit, 500);
          const slice = lines.slice(offset, offset + cap).join("\n");
          const remaining = totalLines - offset - cap;
          const hint = remaining > 0 ? `\n\n[共 ${totalLines} 行，已读 ${offset}~${offset + cap - 1}，还剩 ${remaining} 行未读]` : `\n\n[共 ${totalLines} 行，已全部读完]`;
          return {
            content: [{ type: "text", text: slice + hint }],
            details: { path: filePath, totalLines, offset, linesRead: Math.min(cap, totalLines - offset) },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text", text: `❌ 读取失败：${msg}` }], details: { error: msg } };
        }
      },
    }));

    // ── list_files：列出目录下的文件（Lucas/Andy 探索用）────────────────────
    api.registerTool((_toolCtx) => ({
      label: "列出目录文件",
      name: "list_files",
      description: [
        "列出指定目录下的文件和子目录。Andy 探索代码库结构、Lucas 查找交付文件时使用。",
        "dir：目录绝对路径。",
        "pattern（可选）：文件名包含此字符串才列出（如 '.md' 只列 Markdown 文件）。",
        "不递归子目录，只列出一层。",
      ].join("\n"),
      parameters: Type.Object({
        dir: Type.String({ description: "目录绝对路径" }),
        pattern: Type.Optional(Type.String({ description: "文件名过滤字符串（可选）" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { dir, pattern } = params as { dir: string; pattern?: string };
        try {
          const { readdirSync, statSync, existsSync } = await import("node:fs");
          if (!existsSync(dir)) {
            return { content: [{ type: "text", text: `❌ 目录不存在：${dir}` }], details: { error: "not_found" } };
          }
          const entries = readdirSync(dir, { withFileTypes: true });
          const lines: string[] = [];
          for (const e of entries) {
            if (pattern && !e.name.includes(pattern)) continue;
            try {
              const st = statSync(`${dir}/${e.name}`);
              const size = e.isDirectory() ? "" : ` (${Math.round(st.size / 1024)}KB)`;
              lines.push(`${e.isDirectory() ? "📁" : "📄"} ${e.name}${size}`);
            } catch {
              lines.push(`  ${e.name}`);
            }
          }
          const result = lines.length > 0 ? lines.join("\n") : "（目录为空）";
          return {
            content: [{ type: "text", text: `${dir}:\n${result}` }],
            details: { dir, count: lines.length },
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return { content: [{ type: "text", text: `❌ 列目录失败：${msg}` }], details: { error: msg } };
        }
      },
    }));

    // ── recall_memory：Lucas 主动回忆，检索跨通道长期记忆 ────────────────────
    api.registerTool((_toolCtx) => ({
      label: "主动回忆",
      name: "recall_memory",
      description: [
        "Lucas 专属工具：主动检索自己的长期记忆，包括所有私聊和群聊的历史对话。",
        "适用场景：",
        "1. 家人说「我之前告诉过你……」——主动搜索对应记录，不要凭感觉猜测",
        "2. 需要核实某件事是否真的发生过，避免幻觉",
        "3. 想起某个家人的偏好或习惯时，先搜索确认",
        "调用时机：感觉'应该记得但不确定'时，必须先调用此工具再回答，不要凭印象编造。",
        "",
        "【禁止调用的场景】",
        "如果家人在当前这条消息或刚才的几条消息里，已经直接告诉了你某件事（例如发来了历史对话原文、策划内容、事件描述），",
        "不要再调用此工具去'核实'——当前对话内容还没有写入记忆库，调用只会返回空，",
        "然后你会错误地说'查不到记忆'，把眼前已有的信息完全忽视。",
        "正确做法：直接基于家人刚提供的内容回答，不需要工具验证。",
        "返回相关历史对话片段（私聊+群聊，按相关度排序），每条带来源标记。",
        "",
        "【重要：搜到不等于可以讲出来】",
        "搜索结果只是用来帮你确认记忆，能不能在当前场合说出来，需要你自己判断：",
        "- 来源是「群聊」的内容：群聊和私聊都可以引用，是公开信息。",
        "- 来源是「私聊」的内容，默认保密，但以下情况可以在群里说：",
        "  a) 当事人本人在群里主动提起这件事（本人在群聊里问你私聊内容 = 隐式授权公开）",
        "  b) 当事人明确说「你可以告诉大家」",
        "- 判断标准：谁说的、他现在在哪里问——如果是本人在群里问自己私聊里说过的事，大概率是想让大家一起知道，可以说。",
        "只有 Lucas 应该调用此工具。",
      ].join("\n"),
      parameters: Type.Object({
        query: Type.String({ description: "想回忆的内容，如'小姨开公司'、'妈妈说的试卷'等，用自然语言描述" }),
        scope: Type.Optional(Type.String({ description: "检索范围：all（默认，私聊+群聊）/ private / group" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const { query, scope = "all" } = params as { query: string; scope?: string };
        try {
          // ── Step 1: 基础 embedding ──────────────────────────────────────
          const baseEmbedding = await embedText(query.slice(0, 400));

          // ── Step 2: Topic-first（不限 userId，跨家人检索相关话题）──────
          const topics = await queryRelevantTopics(baseEmbedding);
          const topicKeywords = topics.map(t => t.topicName).join(" ");

          // ── Step 3: topic 关键词增强检索 query ──────────────────────────
          const searchEmbedding = topicKeywords
            ? await embedText(`${query} ${topicKeywords}`.slice(0, 400))
            : baseEmbedding;

          // ── Step 4: 图扩展（加入关联家人的对话）────────────────────────
          const recallUserId = lastFrontendUserId;
          const relatedIds = recallUserId ? [
            ...getRelatedPersonIds(recallUserId),
            ...getTopicRelatedPersonIds(recallUserId),
          ].filter((id, i, arr) => arr.indexOf(id) === i) : [];

          // ── Step 5: ChromaDB conversations 检索 ─────────────────────────
          const where: Record<string, unknown> | undefined =
            scope === "private" ? { source: { $eq: "private" } } :
            scope === "group"   ? { source: { $eq: "group"   } } :
            relatedIds.length > 0 && recallUserId
              ? { $or: [
                  { userId: { $eq: recallUserId } },
                  { userId: { $in: relatedIds } },
                  { source: { $eq: "group" } },
                ]}
              : undefined;

          const raw = await chromaQuery("conversations", searchEmbedding, 10, where);
          const results = timeWeightedRerank(raw, 6);

          // ── 时间维度旁路：含时间词时直接按 timestamp 拉取 ───────────────
          let timeRecords: Array<{ document: string; metadata: Record<string, unknown> }> = [];
          const timeAnchor = detectTimeAnchor(query);
          if (timeAnchor && recallUserId) {
            timeRecords = await getConversationsByTimeAnchor(recallUserId, timeAnchor, 15);
          }

          // ── 组合输出（时间记录 → topic 事实 → 因果关系 → 对话片段）──────
          const parts: string[] = [];

          // 时间维度优先：有时间锚点的记录放最前面
          if (timeRecords.length > 0) {
            const lines = timeRecords.map(r => {
              const meta = r.metadata as { prompt?: string; response?: string; timestamp?: string };
              const ts   = toCST(meta.timestamp);
              return `[${ts}]\nUser: ${meta.prompt ?? ""}\nLucas: ${(meta.response ?? "").slice(0, 300)}`;
            });
            parts.push(`【${timeAnchor!.label}对话记录（按时间顺序，${timeRecords.length} 条）】\n\n${lines.join("\n---\n")}`);
          }

          if (topics.length > 0) {
            const topicLines = topics.map(t => {
              const ctx = t.context ? `：${t.context}` : "";
              return `• ${t.topicName}（${t.relation}${ctx}）`;
            });
            parts.push(`【相关话题事实】\n${topicLines.join("\n")}`);
          }
          if (recallUserId) {
            const causalFacts = queryCausalFacts(recallUserId);
            if (causalFacts.length > 0) {
              const lines = causalFacts.map(cf => `• ${cf.value}${cf.context ? `：${cf.context}` : ""}`);
              parts.push(`【因果关系】\n${lines.join("\n")}`);
            }
          }
          if (results.length > 0) {
            const lines = results.map(r => {
              const meta = r.metadata as { prompt?: string; response?: string; userId?: string; source?: string; timestamp?: string };
              const who  = meta.source === "group" ? "（群聊）" : meta.userId ? `（${meta.userId} 私聊）` : "";
              const ts   = toCST(meta.timestamp);
              return `[${ts}${who}]\nUser: ${meta.prompt ?? ""}\nLucas: ${meta.response ?? ""}`;
            });
            parts.push(`找到 ${results.length} 条语义相关对话：\n\n${lines.join("\n---\n")}`);
          }
          if (parts.length === 0) {
            // ── 盲区蒸馏：记忆空白时按需触发蒸馏，下次对话 inject.md 会更新 ──
            if (recallUserId && !recallUserId.startsWith("visitor:")) {
              const now = Date.now();
              const lastBs = lastBlindSpotDistillTrigger.get(recallUserId) ?? 0;
              if (now - lastBs >= BLIND_SPOT_DISTILL_COOLDOWN_MS) {
                lastBlindSpotDistillTrigger.set(recallUserId, now);
                // fire-and-forget：蒸馏 + 渲染，下次对话 inject.md 会带上这段历史
                const distillScript = join(PROJECT_ROOT, "scripts/distill-memories.py");
                const renderScript  = join(PROJECT_ROOT, "scripts/render-knowledge.py");
                const dp = spawn(KUZU_PYTHON3_BIN, [distillScript, "--user", recallUserId, "--force"], { detached: true, stdio: "ignore" });
                dp.unref();
                dp.once("close", () => {
                  const rp = spawn(KUZU_PYTHON3_BIN, [renderScript, "--user", recallUserId], { detached: true, stdio: "ignore" });
                  rp.unref();
                });
              }
            }
            return { content: [{ type: "text", text: "记忆库中没有找到相关记录。（注：当前对话本轮之前的历史已写入记忆库，可被检索到；本轮刚发生的对话尚未写入。已触发后台记忆整理，稍后再问可能会有更准确的结果。）" }], details: { query, count: 0 } };
          }
          // 当前轮提示：提醒 Lucas 本轮内容尚未写入，不要以为"搜不到"就否认当前对话
          const sessionNote = "\n\n（以上结果来自持久化记忆库。当前轮刚发生的对话尚未写入——若家人刚才在本条消息里说了什么，请直接用对话内容回答，不需要工具核实。）";
          return {
            content: [{ type: "text", text: parts.join("\n\n") + sessionNote }],
            details: { query, count: results.length + timeRecords.length, topicsFound: topics.length },
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `❌ 记忆检索失败：${e instanceof Error ? e.message : String(e)}` }],
            details: { error: String(e) },
          };
        }
      },
    }));

    // ── gen_visitor_invite：为访客生成邀请码（L3 Shadow Agent）────────────────
    api.registerTool((_toolCtx) => ({
      label: "生成访客邀请码",
      name: "gen_visitor_invite",
      description: [
        "Lucas 专属工具：为访客生成带元数据的邀请码，访客凭此码进入体验页面与启灵对话。",
        "适用场景：爸爸或家人说「给我的朋友/同事生成邀请码」「我要邀请某人体验」时调用。",
        "生成时可携带访客信息：姓名（name）、邀请人（invitedBy，如未说明则为发起人自己）、",
        "可聊话题范围（scopeTags，如 [\"general\"] 或 [\"ai\", \"coding\"]）、背景介绍（behaviorContext）。",
        "生成后回复邀请码 + 访问链接，邀请码 6 位大写字母数字，默认有效期 7 天。",
        "只有 Lucas 应该调用此工具。",
      ].join("\n"),
      parameters: Type.Object({
        name:            Type.Optional(Type.String({ description: "访客姓名（可选，知道时填写）" })),
        invitedBy:       Type.Optional(Type.String({ description: "邀请人称呼（可选，用真实称谓如「爸爸」「妈妈」，不要用账号 ID）" })),
        scopeTags:       Type.Optional(Type.Array(Type.String(), { description: "可聊话题标签（可选，如 [\"general\"]）" })),
        behaviorContext: Type.Optional(Type.String({ description: "访客背景描述（可选，如「爸爸的大学同学，对 AI 感兴趣」）" })),
        expiresInDays:   Type.Optional(Type.Number({ description: "有效天数（1-30，默认 7）" })),
        personId:        Type.Optional(Type.String({ description: "稳定人员 ID（续期时填写，保持影子记忆连续性；首次邀请不填，系统自动生成）" })),
      }),
      execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const wecomUrl = CHANNEL_BASE_URL || "https://wecom.homeai-wecom-zxl.top";
          const secret = process.env.DEMO_INVITE_SECRET || "homeai-internal-2024";
          const body: Record<string, unknown> = {};
          if (params.name)            body.name            = params.name;
          if (params.invitedBy)       body.invitedBy       = params.invitedBy;
          if (params.scopeTags)       body.scopeTags       = params.scopeTags;
          if (params.behaviorContext) body.behaviorContext  = params.behaviorContext;
          if (params.expiresInDays)   body.expiresInDays   = params.expiresInDays;
          if (params.personId)        body.personId        = params.personId;
          const resp = await fetch(`${wecomUrl}/api/demo-proxy/gen-invite`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Secret": secret,
            },
            body: JSON.stringify(body),
          });
          if (!resp.ok) {
            const text = await resp.text();
            return {
              content: [{ type: "text", text: `邀请码生成失败（HTTP ${resp.status}）：${text}` }],
              details: { error: text },
            };
          }
          const data = await resp.json() as {
            ok: boolean; code?: string; name?: string; invitedBy?: string;
            scopeTags?: string[]; expiresAt?: string; error?: string;
          };
          if (!data.ok || !data.code) {
            return {
              content: [{ type: "text", text: `邀请码生成失败：${data.error ?? "未知错误"}` }],
              details: { error: data.error },
            };
          }
          const chatUrl = `${wecomUrl}/app/demo-chat/`;
          const namePart     = data.name     ? `\n访客姓名：${data.name}` : "";
          const invitedPart  = data.invitedBy ? `\n邀请人：${data.invitedBy}` : "";
          const tagsPart     = data.scopeTags?.length ? `\n话题范围：${data.scopeTags.join("、")}` : "";
          const text = `邀请码已生成：${data.code}${namePart}${invitedPart}${tagsPart}\n有效期至：${data.expiresAt}\n访问链接：${chatUrl}\n\n访客打开链接输入邀请码即可开始对话。`;
          return {
            content: [{ type: "text", text }],
            details: { code: data.code, name: data.name, invitedBy: data.invitedBy, expiresAt: data.expiresAt, url: chatUrl },
          };
        } catch (e) {
          return {
            content: [{ type: "text", text: `邀请码生成失败：${e instanceof Error ? e.message : String(e)}` }],
            details: { error: String(e) },
          };
        }
      },
    }));


  },
};

export default crewclawRoutingPlugin;
