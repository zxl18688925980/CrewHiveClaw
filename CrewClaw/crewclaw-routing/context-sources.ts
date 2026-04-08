/**
 * context-sources.ts — HomeAI 实例层配置：声明式知识检索注册表
 *
 * ━━ 框架 / 实例分工说明 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 * 框架层（context-handler.ts）：提供机制 —— 并发执行多来源查询、分组注入
 * 实例层（本文件）：提供内容 —— 为每个 Agent 连接哪些 ChromaDB / Kuzu / 文件来源
 *
 * 新部署只需提供自己的 contextSources 注册表，不改框架代码。
 * ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
 *
 * before_prompt_build 通用 handler 读取此文件，决定为每个 agent 注入哪些知识片段。
 * 新增检索源只改本文件，不改 before_prompt_build 主逻辑。
 *
 * 三类来源：
 *   chromadb  原始数据语义检索（对话历史 + 过渡态工程记录，待 Kuzu 就绪后逐步替换）
 *   kuzu      图数据库实时查询（ready=false 时跳过；ready=true = 数据已就绪）
 *   file      本地文件读取（静态注入：家人档案、架构摘要、MEMORY.md 等）
 *
 * Kuzu 工程侧 Entity+Fact schema（2026-03-26 定稿）：
 *   Entity {id, type, name}
 *     type='agent'      — Andy/Lisa/Lucas 锚点，id='andy'/'lisa'/'lucas'
 *     type='pattern'    — 蒸馏提炼的行为模式，id='pattern_{agent}_{slug}'
 *     type='capability' — 能力注册表，id='capability_{slug}'
 *     type='person'     — 家庭成员（已有）
 *     type='topic'      — 家人事实载体（已有）
 *   Fact {relation, context, valid_from, valid_until, confidence, source_type, source_id}
 *     relation='has_pattern'    — agent → pattern（蒸馏写入，full refresh）
 *     relation='has_capability' — agent → capability（registry 迁移写入）
 *
 * ChromaDB 过渡态说明：
 *   标注「过渡态」的 chromadb source = 未来应由 Kuzu 接管；
 *   当对应 Kuzu source ready=true 后，删除此 chromadb 条目。
 *   conversations 集合是例外：最近对话永远从 ChromaDB 取，不进 Kuzu。
 *
 * 迁移路线：
 *   家人档案（file user-profile）   → person-realtime Kuzu source ready=true 后，此条删除
 *   能力清单（chromadb capabilities）→ active-capabilities Kuzu source ready=true 后，chromadb 条目删除
 *   agent-patterns（Kuzu）          → distill-agent-memories.py write_kuzu_patterns() 完成后 ready=true
 */

// ── Session 参数（before_prompt_build 时可用的上下文）─────────────────────

export interface SessionParams {
  prompt:     string;   // 当前用户消息（语义检索用）
  userId:     string;   // 发消息的用户 ID
  agentId:    string;   // 当前 agent（lucas / andy / lisa）
  isGroup:    boolean;  // 是否群聊
  sessionKey: string;
}

export type InjectMode = "prepend" | "append-system";

// ── ChromaDB 来源 ─────────────────────────────────────────────────────────

export type ChromaQueryMode =
  | "semantic"             // 用 prompt 向量检索
  | "by-user"              // 按 userId 过滤（对话历史）
  | "pending-commitments"  // 按 userId 查 outcome=null 的承诺
  | "pending-requirements" // 查 status=pending 的需求
  | "agent-interactions"   // 按 agentId 查协作记录
  | "code-history"         // 语义检索代码历史
  | "constraint-recall";   // 只召回 type=constraint 的平台约束（独立通道，不与决策竞争 topK）

export interface ChromaSource {
  source:       "chromadb";
  id:           string;
  collection:   string;
  queryMode:    ChromaQueryMode;
  agentFilter?: string;   // queryMode=semantic 时额外按 agent 字段过滤
  topK:         number;
  label:        string;   // 注入时的前缀标签，例如「近期对话」
  inject:       InjectMode;
}

// ── Kuzu 来源 ─────────────────────────────────────────────────────────────

export interface KuzuSource {
  source:  "kuzu";
  id:      string;
  cypher:  string;                     // Cypher 模板，支持 $userId $agentId $topK 占位符
  params:  Array<keyof SessionParams>; // 从 session 绑定到 Cypher 变量的字段名
  topK:    number;
  label:   string;
  inject:  InjectMode;
  ready:   boolean;                    // false = Kuzu 数据尚未就绪，跳过（不报错）
}

// ── 文件来源（过渡态）────────────────────────────────────────────────────

export type FileQueryMode =
  | "user-profile"     // 读 ~/.openclaw/workspace-lucas/family/{userId}.inject.md
  | "app-capabilities" // 读 data/corpus/app-capabilities.jsonl，关键词匹配
  | "static-file";     // 读固定路径文件，整体注入（filePath 必须指定）

export interface FileSource {
  source:    "file";
  id:        string;
  queryMode: FileQueryMode;
  filePath?: string;   // queryMode=static-file 时必填，支持 ~ 展开
  label:     string;
  inject:    InjectMode;
}

export type ContextSource = ChromaSource | KuzuSource | FileSource;

// ── 注册表 ────────────────────────────────────────────────────────────────

export const contextSources: Record<string, ContextSource[]> = {

  // ── Lucas ──────────────────────────────────────────────────────────────
  lucas: [
    // 家人档案：当前说话家人的背景档案，注入 system prompt（背景知识，非对话内容）
    // 过渡态：render-knowledge.py 完成后由 Kuzu 渲染的档案接管，届时此条改为 kuzu source
    {
      source: "file", id: "family-profile",
      queryMode: "user-profile",
      label: "家人档案", inject: "append-system",
    },

    // 项目背景：HomeAI 是什么、Andy/Lisa 幕后团队、流水线、里程碑（前世今生）
    {
      source: "file", id: "background",
      queryMode: "static-file",
      filePath: "~/.openclaw/workspace-lucas/BACKGROUND.md",
      label: "项目背景", inject: "append-system",
    },

    // Lucas 自我认知摘要：蒸馏产出的判断倾向 + 有效策略 + 反复犯的错
    // 双重注入：OpenClaw 原生在 prompt 开头注入，这里在末尾再压一遍（末尾权重更高）
    {
      source: "file", id: "self-memory",
      queryMode: "static-file",
      filePath: "~/.openclaw/workspace-lucas/MEMORY.md",
      label: "自我认知", inject: "append-system",
    },

    // 近期对话历史（按 userId 过滤）
    {
      source: "chromadb", id: "conversations",
      collection: "conversations", queryMode: "by-user",
      topK: 5, label: "近期对话", inject: "prepend",
    },

    // Lucas 自己的决策记忆（过渡态：Lucas pattern 节点写入 Kuzu 后，由 agent-patterns 接管）
    {
      source: "chromadb", id: "decision-memory",
      collection: "decisions", queryMode: "semantic", agentFilter: "lucas",
      topK: 3, label: "决策记忆", inject: "prepend",
    },

    // 对家人的未完成承诺
    {
      source: "chromadb", id: "pending-commitments",
      collection: "decisions", queryMode: "pending-commitments",
      topK: 5, label: "未完成承诺", inject: "prepend",
    },

    // 进行中需求
    {
      source: "chromadb", id: "pending-requirements",
      collection: "requirements", queryMode: "pending-requirements",
      topK: 5, label: "进行中需求", inject: "prepend",
    },

    // 团队近期动态：Lucas 感知 Andy/Lisa 最近在做什么（开发进展、Spec 设计、实现结果）
    // 让 Lucas 和 Andy 之间信息对称——Lucas 知道幕后团队的工作状态，协作时不会重复提需求
    {
      source: "chromadb", id: "agent-interactions",
      collection: "agent_interactions", queryMode: "agent-interactions", agentFilter: "lucas",
      topK: 3, label: "团队近期动态", inject: "prepend",
    },

    // 家庭行为规律（过渡态：Lucas behavior pattern 节点写入 Kuzu 后，由 agent-patterns 接管）
    {
      source: "chromadb", id: "behavior-patterns",
      collection: "behavior_patterns", queryMode: "semantic",
      topK: 3, label: "行为规律", inject: "prepend",
    },

    // 家庭知识（过渡态：家庭知识侧 Kuzu schema 设计后接管）
    {
      source: "chromadb", id: "family-knowledge",
      collection: "family_knowledge", queryMode: "semantic",
      topK: 3, label: "家庭知识", inject: "prepend",
    },

    // Kuzu：当前能力清单（init-capabilities.py 已写入，数据就绪）
    // 含 Lucas 所有 11 个插件工具 + Web 应用，每条附带「何时用」描述
    // 新增/修改能力：修改 scripts/init-capabilities.py 的 CAPABILITY_REGISTRY，重新运行
    {
      source: "kuzu", id: "active-capabilities",
      cypher: `MATCH (a:Entity {id: $agentId, type: 'agent'})-[f:Fact {relation: 'has_capability'}]->(c:Entity {type: 'capability'})
               WHERE f.valid_until IS NULL
               RETURN c.name, f.context
               ORDER BY f.valid_from DESC LIMIT $topK`,
      params: ["agentId"],
      topK: 30, label: "当前能力清单", inject: "append-system",
      ready: true,
    },

    // Kuzu：角色行为模式（ready=true；distill-agent-memories.py 首次成功运行于 2026-03-31）
    // 来源：decisions(agentFilter=lucas) + behavior_patterns 蒸馏后写入
    {
      source: "kuzu", id: "agent-patterns",
      cypher: `MATCH (a:Entity {id: $agentId, type: 'agent'})-[f:Fact {relation: 'has_pattern'}]->(p:Entity {type: 'pattern'})
               WHERE f.valid_until IS NULL
               RETURN p.name, f.context, f.confidence
               ORDER BY f.confidence DESC LIMIT $topK`,
      params: ["agentId"],
      topK: 10, label: "行为模式积累", inject: "append-system",
      ready: true,
    },

    // Web 应用工具（关键词命中时注入精准 URL）
    {
      source: "file", id: "app-capabilities",
      queryMode: "app-capabilities",
      label: "可调用工具", inject: "prepend",
    },

    // Kuzu：家人实时状态（路径已完整：distill-memories.py → Kuzu → render-knowledge.py → inject.md）
    {
      source: "kuzu", id: "person-realtime",
      cypher: `MATCH (p:Entity {id: $userId})-[f:Fact]->(o:Entity)
               WHERE f.valid_until IS NULL
               RETURN f.relation, o.name, f.context
               ORDER BY f.confidence DESC LIMIT $topK`,
      params: ["userId"],
      topK: 10, label: "家人当前状态", inject: "append-system",
      ready: true,
    },

    // Kuzu：近期待跟进事项（has_pending_event，按 valid_until 升序，最近到期的排前面）
    {
      source: "kuzu", id: "pending-events",
      cypher: `MATCH (p:Entity {id: $userId})-[f:Fact {relation: 'has_pending_event'}]->(e:Entity)
               WHERE f.valid_until >= date()
               RETURN e.name, f.context, f.valid_until
               ORDER BY f.valid_until ASC LIMIT $topK`,
      params: ["userId"],
      topK: 5, label: "待跟进事项", inject: "prepend",
      ready: true,
    },

    // Kuzu：当前活跃话题线索（distill-active-threads.py 写入，每次对话后触发 6h 冷却）
    // 老化机制：valid_until = 写入时 today + 45d，超期自动不注入，不需要额外清理
    // 连续性作用：让 Lucas 知道「我们上次在推进什么事」，理解「那件事」等隐式指代
    {
      source: "kuzu", id: "active-threads",
      cypher: `MATCH (p:Entity {id: $userId})-[f:Fact {relation: 'active_thread'}]->(t:Entity)
               WHERE f.valid_until >= date()
               RETURN t.name, f.context
               ORDER BY f.valid_from DESC LIMIT $topK`,
      params: ["userId"],
      topK: 5, label: "当前活跃话题", inject: "prepend",
      ready: true,
    },

    // Kuzu：关系网络近况（P2-A path B）— 遍历家庭关系边，找相关家人的当前状态/近期关注/重要事件
    {
      source: "kuzu", id: "relationship-network",
      cypher: `MATCH (speaker:Entity {id: $userId})-[rel:Fact]->(other:Entity)
               WHERE other.type = 'person' AND rel.valid_until IS NULL
               MATCH (other)-[f:Fact]->(info:Entity)
               WHERE f.valid_until IS NULL
                 AND f.relation IN ['current_status', 'recent_concern', 'cares_most_about', 'key_event']
               RETURN other.name, f.relation, info.name, f.context
               LIMIT $topK`,
      params: ["userId"],
      topK: 12, label: "家人近况", inject: "append-system",
      ready: true,
    },

    // Kuzu：话题共鸣（P2-A path A）— 找到与当前说话人关注相同话题的其他人（家庭成员 + 周边人）
    // 依赖 P1-C topic 节点归一化（distill-memories.py topic_id 已改为 topic_{slug}）
    // 同一 topic 节点被多个人的 Fact 边指向 → 发现话题交集
    // 正向过滤 type='person'：所有人（家庭成员 + distill 提炼的周边人）统一用此类型
    // 未来加 space/device 等新类型时，天然不会进入此查询，无需修改
    {
      source: "kuzu", id: "topic-resonance",
      cypher: `MATCH (speaker:Entity {id: $userId})-[f1:Fact]->(t:Entity {type: 'topic'})
               WHERE f1.valid_until IS NULL
               MATCH (other:Entity {type: 'person'})-[f2:Fact]->(t)
               WHERE other.id <> $userId AND f2.valid_until IS NULL
               RETURN DISTINCT other.name, t.name, f2.relation, f2.context
               LIMIT $topK`,
      params: ["userId"],
      topK: 8, label: "话题共鸣", inject: "append-system",
      ready: true,
    },
  ],

  // ── Andy ───────────────────────────────────────────────────────────────
  andy: [
    // 项目背景：HomeAI 是什么、组织四角色、V字流水线、里程碑（前世今生）
    {
      source: "file", id: "background",
      queryMode: "static-file",
      filePath: "~/.openclaw/workspace-andy/BACKGROUND.md",
      label: "项目背景", inject: "append-system",
    },

    // 工作规则：工具调用铁律 + 输出标准 + 家庭 Web 约束（OpenClaw 原生只注入全局模板，这里补注 Andy 专属规则）
    {
      source: "file", id: "agents-rules",
      queryMode: "static-file",
      filePath: "~/.openclaw/workspace-andy/AGENTS.md",
      label: "工作规则", inject: "append-system",
    },

    // 系统架构知识：三层架构 + 关键路径 + 数据层 + 约束（常驻 system prompt）
    {
      source: "file", id: "arch-summary",
      queryMode: "static-file",
      filePath: "~/.openclaw/workspace-andy/ARCH.md",
      label: "系统架构", inject: "append-system",
    },

    // 设计积累：已验证的设计原则 + 踩过的坑 + 判断规则（蒸馏自 decisions 集合）
    {
      source: "file", id: "design-memory",
      queryMode: "static-file",
      filePath: "~/.openclaw/workspace-andy/MEMORY.md",
      label: "设计积累", inject: "append-system",
    },

    // 设计决策规则：「遇到 X 做 Y 不做 Z」判断规则（架构/Spec/降级设计，来自真实踩坑）
    {
      source: "file", id: "design-principles",
      queryMode: "static-file",
      filePath: "~/.openclaw/workspace-andy/DESIGN-PRINCIPLES.md",
      label: "设计决策规则", inject: "append-system",
    },

    // 历史设计决策（过渡态：Andy 的 decision 节点写入 Kuzu 后，由 agent-patterns 接管）
    {
      source: "chromadb", id: "design-decisions",
      collection: "decisions", queryMode: "semantic", agentFilter: "andy",
      topK: 5, label: "历史决策", inject: "prepend",
    },

    // 与 Lucas/Lisa 的协作记录（过渡态：agent 协作侧 Kuzu schema 设计后接管）
    {
      source: "chromadb", id: "agent-interactions",
      collection: "agent_interactions", queryMode: "agent-interactions", agentFilter: "andy",
      topK: 3, label: "协作历史", inject: "prepend",
    },

    // 进行中需求（Andy 判断是否已有能力覆盖用）
    {
      source: "chromadb", id: "pending-requirements",
      collection: "requirements", queryMode: "pending-requirements",
      topK: 5, label: "进行中需求", inject: "prepend",
    },

    // 历史实现记录（过渡态：写入 Kuzu code_history 节点后接管）
    {
      source: "chromadb", id: "code-history",
      collection: "code_history", queryMode: "code-history",
      topK: 3, label: "实现历史", inject: "prepend",
    },

    // 代码库洞察（集体进化：Lisa opencode 结束后写入，Andy 写 spec 时参考）
    // 内容：哪些文件 spec 吻合率低、哪些实现成功/失败模式、变更范围异常信号
    {
      source: "chromadb", id: "codebase-patterns",
      collection: "codebase_patterns", queryMode: "codebase-patterns",
      topK: 3, label: "代码库洞察", inject: "prepend",
      ready: true,
    },

    // 已有能力（过渡态：active-capabilities Kuzu source ready=true 后删除此条）
    {
      source: "chromadb", id: "capabilities",
      collection: "capabilities", queryMode: "semantic", agentFilter: "andy",
      topK: 5, label: "已有能力参考", inject: "prepend",
    },

    // Kuzu：当前能力清单（init-capabilities.py 已写入，数据就绪）
    // 新增能力：修改 scripts/init-capabilities.py 的 CAPABILITY_REGISTRY，重新运行
    {
      source: "kuzu", id: "active-capabilities",
      cypher: `MATCH (a:Entity {id: $agentId, type: 'agent'})-[f:Fact {relation: 'has_capability'}]->(c:Entity {type: 'capability'})
               WHERE f.valid_until IS NULL
               RETURN c.name, f.context
               ORDER BY f.valid_from DESC LIMIT $topK`,
      params: ["agentId"],
      topK: 30, label: "当前能力清单", inject: "append-system",
      ready: true,
    },

    // Kuzu：角色行为模式（ready=true；distill-agent-memories.py 首次成功运行于 2026-03-31）
    // 蒸馏路径：ChromaDB decisions → LLM 提炼 → Kuzu has_pattern → render-knowledge.py → MEMORY.md
    {
      source: "kuzu", id: "agent-patterns",
      cypher: `MATCH (a:Entity {id: $agentId, type: 'agent'})-[f:Fact {relation: 'has_pattern'}]->(p:Entity {type: 'pattern'})
               WHERE f.valid_until IS NULL
               RETURN p.name, f.context, f.confidence
               ORDER BY f.confidence DESC LIMIT $topK`,
      params: ["agentId"],
      topK: 10, label: "设计模式积累", inject: "append-system",
      ready: true,
    },
  ],

  // ── Lisa ───────────────────────────────────────────────────────────────
  lisa: [
    // 项目背景：HomeAI 是什么、组织四角色、流水线、里程碑（前世今生）
    {
      source: "file", id: "background",
      queryMode: "static-file",
      filePath: "~/.openclaw/workspace-lisa/BACKGROUND.md",
      label: "项目背景", inject: "append-system",
    },

    // 工作规则：交付标准 + 自验证策略 + 家庭 Web 规范（OpenClaw 原生只注入全局模板，这里补注 Lisa 专属规则）
    {
      source: "file", id: "agents-rules",
      queryMode: "static-file",
      filePath: "~/.openclaw/workspace-lisa/AGENTS.md",
      label: "工作规则", inject: "append-system",
    },

    // 代码库上下文：关键文件路径 + 编码模式 + 交付约定（常驻 system prompt）
    {
      source: "file", id: "codebase-context",
      queryMode: "static-file",
      filePath: "~/.openclaw/workspace-lisa/CODEBASE.md",
      label: "代码库上下文", inject: "append-system",
    },

    // 实现积累：已验证的实现模式 + 技术踩坑 + 工程品味判断（蒸馏自 decisions/code_history 集合）
    {
      source: "file", id: "impl-memory",
      queryMode: "static-file",
      filePath: "~/.openclaw/workspace-lisa/MEMORY.md",
      label: "实现积累", inject: "append-system",
    },

    // 平台约束专用通道：只召回 type=constraint 条目，独立于决策记忆，不竞争 topK 名额
    // 来源：write_lisa_constraints.py 写入 + distill-agent-memories.py 从 10-engineering-notes.md 蒸馏
    {
      source: "chromadb", id: "constraint-recall",
      collection: "decisions", queryMode: "constraint-recall", agentFilter: "lisa",
      topK: 5, label: "平台约束", inject: "prepend",
    },

    // Lisa 自己的决策记忆（过渡态：Lisa pattern 节点写入 Kuzu 后，由 agent-patterns 接管）
    {
      source: "chromadb", id: "decision-memory",
      collection: "decisions", queryMode: "semantic", agentFilter: "lisa",
      topK: 3, label: "决策记忆", inject: "prepend",
    },

    // 与 Andy/Lucas 的协作记录（过渡态：agent 协作侧 Kuzu schema 设计后接管）
    {
      source: "chromadb", id: "agent-interactions",
      collection: "agent_interactions", queryMode: "agent-interactions", agentFilter: "lisa",
      topK: 3, label: "协作历史", inject: "prepend",
    },

    // 历史实现记录（过渡态：写入 Kuzu code_history 节点后接管）
    {
      source: "chromadb", id: "code-history",
      collection: "code_history", queryMode: "code-history",
      topK: 5, label: "实现历史", inject: "prepend",
    },

    // 已有能力（过渡态：active-capabilities Kuzu source ready=true 后删除此条）
    {
      source: "chromadb", id: "capabilities",
      collection: "capabilities", queryMode: "semantic", agentFilter: "lisa",
      topK: 5, label: "已有能力参考", inject: "prepend",
    },

    // Kuzu：当前能力清单（init-capabilities.py 已写入，数据就绪）
    {
      source: "kuzu", id: "active-capabilities",
      cypher: `MATCH (a:Entity {id: $agentId, type: 'agent'})-[f:Fact {relation: 'has_capability'}]->(c:Entity {type: 'capability'})
               WHERE f.valid_until IS NULL
               RETURN c.name, f.context
               ORDER BY f.valid_from DESC LIMIT $topK`,
      params: ["agentId"],
      topK: 30, label: "已有能力清单", inject: "append-system",
      ready: true,
    },

    // Kuzu：角色行为模式（ready=true；distill-agent-memories.py 首次成功运行于 2026-03-31）
    {
      source: "kuzu", id: "agent-patterns",
      cypher: `MATCH (a:Entity {id: $agentId, type: 'agent'})-[f:Fact {relation: 'has_pattern'}]->(p:Entity {type: 'pattern'})
               WHERE f.valid_until IS NULL
               RETURN p.name, f.context, f.confidence
               ORDER BY f.confidence DESC LIMIT $topK`,
      params: ["agentId"],
      topK: 10, label: "实现模式积累", inject: "append-system",
      ready: true,
    },
  ],
};
