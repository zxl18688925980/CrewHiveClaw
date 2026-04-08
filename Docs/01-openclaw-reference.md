# OpenClaw 系统理解：架构、机制与实践

> 由系统工程师（Claude Code）维护。从 HomeAI 建设实践中提炼，结合源码分析和官方文档。
> **阅读对象**：接手 HomeAI 的第二个系统工程师，或从零在新场景部署 OpenClaw 的工程师。
> **使用方式**：做 OpenClaw 相关工作前先读此文件；有新发现及时更新。
> 最后更新：2026-03-27

---

## 一、设计哲学：给 AI 一个真实的自我

OpenClaw 的核心设计不是「让 AI 完成任务」，而是「给 AI 一个能持续生长的自我认知体系」。

这个体系的物质形式，是 workspace 目录下一组 Markdown 文件。这些文件不是配置项，是 Agent 的**人格基础设施**——它是谁、怎么说话、记得什么、会做什么，全部在这里。

**从「能跑」到「好用」的分水岭，就是这套文件写得认不认真。**

没有认真配置 workspace 的 Agent，每次对话都像第一次见面。精心配置的 Agent，用户会形成「这个 AI 是有个性的」的感觉，一致性建立信任，信任让用户愿意给它更复杂的任务。

### 1.1 OpenClaw 为进化准备的基础设施（系统工程师视角）

越深入 OpenClaw 的设计，越能看到作者已经为「Agent 自我进化」把地基打好了：

```
个体基础设施（OpenClaw 已提供）：
  8文件体系      → 个体对象的完整自我定义
  Gateway + hooks → 神经系统，所有信息流经过这里
  Agent 自写 workspace → 进化的执行路径
  MEMORY.md 常青设计 → 沉淀不衰减
  Skills 分层覆盖 → 能力可迭代
  Heartbeat + cron → 主动行为的时钟

组织基础设施（CrewHiveClaw 在此基础上加的）：
  多 Agent 路由（subagents.allowAgents）
  Nodes（IoT 设备接入）
  跨 Agent 协作工具（trigger_*/record_outcome_feedback）
```

**核心洞察**：OpenClaw 作者把「运行即采集、采集即进化」的所有插入点都预留好了——Gateway 是信息锚点（所有流都经过），hooks 是介入点（每个关键时机都有钩子），workspace 文件是进化的载体（Agent 自己就能更新）。HomeAI 的工作是在这套地基上，把系统能力进化（L1→L2）和组织进化（L3）的逻辑填充进去，而不是重新发明基础设施。

---

## 二、消息全链路：一条消息的完整旅程

**这是理解整个系统最重要的视角**——看懂一条消息从家人发出到收到回复的完整路径，整个系统就清楚了。

```
家人发消息（企业微信）
        │
        ▼
wecom-entrance（Node.js，port 3003，PM2 守护）
        │
        ├─ URL 预检测：微信公众号链接？
        │     ├─ 是 → Playwright 抓取全文，注入 content 字段
        │     └─ 否 → 原样传递
        │
        ├─ 生成 session key（per-message 独立）
        │     ├─ 群聊：group:{fromUser}:{msgId}
        │     └─ 私聊：{userId}:{timestamp}
        │
        └─ POST /agent/{agentId} → Gateway:18789
                │
                ▼
        OpenClaw Gateway（launchd 守护，port 18789）
                │
                ├─ [hook: before_prompt_build]        ← 插件介入点①
                │       └─ context-sources 多源并发注入
                │               ├─ ChromaDB 语义检索（对话历史 / 决策记忆 / 代码历史）→ prependContext
                │               ├─ Kuzu 实时查图（家人档案 .inject.md）→ appendSystemContext
                │               └─ 静态文件（ARCH.md / CODEBASE.md / DESIGN-PRINCIPLES.md）→ appendSystemContext
                │               ⚠️ event.messages 是对话历史，不含 system prompt
                │
                ├─ OpenClaw 原生：Skills 注入          ← 在 hook 之前完成
                │       └─ 扫描 workspace/skills/ → 构建 <available_skills>
                │               ↓ 注入 system prompt
                │
                ├─ Workspace 文件注入（按顺序）
                │       └─ AGENTS → SOUL → TOOLS → IDENTITY → USER → HEARTBEAT → MEMORY
                │
                ├─ [hook: before_model_resolve]        ← 插件介入点②
                │       └─ 三层模型路由覆盖
                │               lucas → deepseek-chat
                │               andy  → MiniMax-M2.7
                │               lisa  → deepseek-reasoner
                │
                ├─ [hook: llm_input]                   ← 插件介入点③
                │       └─ 记录路由事件到 route-events.jsonl
                │
                ├─ LLM 调用（含工具调用循环）
                │       └─ function calling → execute → 返回结果 → 再调 LLM
                │
                └─ [hook: agent_end]                   ← 插件介入点④
                        ├─ 剥离历史前缀（cleanPrompt）
                        ├─ ChromaDB 写入（对话记忆 + 行为规律 + 家庭知识）
                        ├─ 语料写入（corpus.jsonl）
                        └─ DPO 候选检测
                                │
                                ▼
                        返回回复文本
                                │
                                ▼
        wecom-entrance 回调
                ├─ 群聊被动回复 → reply(frame, content)   → 显示「启灵」
                └─ 私聊/主动发送 → sendMessage(userId, body) → 显示「启灵」
                        │
                        ▼
              家人收到回复（企业微信）
```

---

## 三、整体架构：四层组成

```
┌─────────────────────────────────────────────────┐
│  Channel 层                                      │
│  企业微信 / Telegram / Discord / Web             │
│  ↓ 消息接入，转发给 Gateway                       │
├─────────────────────────────────────────────────┤
│  Gateway 层                                      │
│  OpenClaw Gateway（默认 port 18789）              │
│  统一路由 · 维护 session · 调 LLM · 管理 hooks    │
│  ↓                                              │
├─────────────────────────────────────────────────┤
│  Plugin 层                                       │
│  crewclaw-routing 等插件                          │
│  hooks 介入生命周期：记忆注入 · 模型路由 · 工具注册 │
│  ↓                                              │
├─────────────────────────────────────────────────┤
│  Workspace 层                                    │
│  ~/.openclaw/workspace-{agent}/                  │
│  Agent 的人格 · 记忆 · 工具 · 技能               │
└─────────────────────────────────────────────────┘
```

两个关键原则：

**Gateway 是系统总线**：所有 Agent 请求必须经过 Gateway，路由日志、记忆写入、DPO 数据积累全靠它。绕过 Gateway 直调 LLM 会导致这些机制全部失效。

**Plugin 是叠加层，不是替代层**：先读懂 OpenClaw 默认机制，再决定在哪里叠加。重建平行机制是最常见的错误（例如：自己写一套 skills 注入逻辑，实际上 OpenClaw 原生就有）。

---

## 四、Workspace 文件体系：Agent 的自我认知系统

每个 Agent 的 workspace 位于 `~/.openclaw/workspace-{agent}/`。

### 4.1 文件全览与注入时机

```
System Prompt 构建顺序（源码确认）
─────────────────────────────────────────────────────
① AGENTS.md     工作规则：做什么、怎么做、不做什么    每轮注入
② SOUL.md       性格叙事：我是谁、说话风格、价值观    每轮注入
③ TOOLS.md      工具清单与使用规范                   每轮注入
④ IDENTITY.md   结构化身份元数据（名字/emoji/头像）   每轮注入
⑤ USER.md       对话对象的背景与偏好                 每轮注入
⑥ HEARTBEAT.md  会话节奏与状态提示                   每轮注入
⑦ BOOTSTRAP.md  首次启动引导（⚠️ 应于 onboarding 后删除）
⑧ MEMORY.md     Agent 自维护的长期稳定知识            仅 main session

          ↓ 以上构成 system prompt

[Plugin: before_prompt_build]
  ChromaDB 语义检索 → prependContext
  注入到「对话历史」的最前面（不是 system prompt）

          ↓ 最终送给 LLM 的完整上下文：
            system prompt（①～⑧）+ 记忆片段 + 对话历史
```

| 文件 | 职责类比 | 要写什么 |
|------|---------|---------|
| `SOUL.md` | 人物小传 | 性格、沟通风格、价值观与边界。第一人称叙事，不写规则 |
| `AGENTS.md` | 岗位说明书 | 工作规则、工具铁律、多 Agent 协调。写「不做什么」比「做什么」更重要 |
| `USER.md` | 关于你客户的预备知识 | 业主的偏好、背景、期望 |
| `TOOLS.md` | 工具使用手册 | 工具清单、使用场景、重要约束 |
| `IDENTITY.md` | 名片/工牌 | 名字、头像、Emoji |
| `HEARTBEAT.md` | 值班提醒卡 | 定时任务、状态检查 |
| `MEMORY.md` | 整理后的长期笔记 | Agent 自行提炼的稳定知识，仅 main session 加载 |
| `BOOTSTRAP.md` | 新员工报到手册 | 一次性 onboarding，用完即删 |

> **⚠️ BOOTSTRAP.md 陷阱（最常见误解）**：这是一次性引导文件，官方模板末行明确写：「Delete this file. You don't need a bootstrap script anymore — you're you now.」`MINIMAL_BOOTSTRAP_ALLOWLIST`（最小必要文件集）不含它，设计意图就是用完删除。**改 Agent 行为要改 SOUL.md 和 AGENTS.md，不要动 BOOTSTRAP.md。** HomeAI 已于 v442 删除三个 workspace 的 BOOTSTRAP.md。

### 4.2 SOUL.md vs AGENTS.md：最容易混淆的分工

```
SOUL.md（人是谁）               AGENTS.md（人怎么干活）
─────────────────────          ──────────────────────────────
性格叙事，第一人称               工作规则，条目式
"我是启灵，家庭的智能伙伴..."    "收到消息，先做X，再做Y..."
价值观、沟通风格                 工具调用铁律、场景判断
情感模式、关系感知               不做什么的边界约束
200字以内效果最好                300-500字比2000字更有效
```

**AGENTS.md 写法原则**：
1. **越长越差**：LLM 注意力有上限，300-500 字比 2000 字更有效，重要规则必须前置
2. **写「不做什么」比「做什么」更重要**：LLM 默认会「发挥创意」，边界约束比能力描述更能产生可预期行为
3. **场景触发优于通用指令**：「当用户发来文章链接时……」比「始终帮用户分析文章」更有效
4. **定期剪枝**：删掉「理论有用但实际无差异」的指令

### 4.3 MEMORY.md：使用边界与自维护机制

- 仅在 main session 加载，不在群聊/公共频道加载（含私人上下文，多人场景不能泄露）
- **Agent 可以直接写自己的 MEMORY.md**（用内置 write/edit 工具），修改后下次 session 立即生效——这是 OpenClaw 的设计意图，不是旁门左道
- **不是系统自动汇总**：原生机制是 heartbeat 驱动下 Agent 自行提炼（memory/ → MEMORY.md）；HomeAI 的 distill-agent-memories.py 是辅助路线，不替代 Agent 自主写入
- HomeAI 用 ChromaDB 替代 memory/ 日记目录，是同一层的不同实现（向量检索 vs 文件检索）

> **⚠️ MEMORY.md 不注入给子 Agent**：子 Agent 和 cron 任务只拿到 AGENTS.md / SOUL.md / TOOLS.md / IDENTITY.md / USER.md，MEMORY.md 不在内。设计子 Agent 时不要假设它知道父 Agent 的长期记忆。

### 4.4 Embedded Agent 的工具路径边界

OpenClaw Agent 是「沙箱内嵌 Agent」。工具（如 read_file）的**路径根目录是 workspace**，不是宿主机任意目录。

```
Lucas 能看到的文件系统：
  ~/.openclaw/workspace-lucas/   ← read_file 的根
    SOUL.md
    AGENTS.md
    TOOLS.md
    skills/
    ...

Lucas 看不到的（路径在沙箱外）：
  ~/HomeAI/data/                 ← ENOENT，不是权限问题，路径根本不在工作区
  ~/HomeAI/crewclaw/
  ...
```

**把 HomeAI 数据传递给 Lucas 的正确方式**：
- `before_prompt_build` hook 里用 `prependContext` 注入
- Main 通道读文件后通过 API 或对话中转

> **⚠️ 典型误解**：在 AGENTS.md 里告诉 Lucas「你可以 read ~/HomeAI/data/xxx」——他调用工具后会收到文件不存在的错误。要让 Agent 访问外部数据，必须通过插件或 Main 中转，不是告诉他路径。

### 4.5 多 Agent 场景的 workspace 原则

```
错误做法：                        正确做法：
  workspace-lucas/                  workspace-lucas/   ← Lucas 专属
    SOUL.md（复制自 andy）            SOUL.md（启灵人格）
                                  workspace-andy/    ← Andy 专属
                                    SOUL.md（方案设计师人格）
                                  ~/.openclaw/skills/ ← 多 Agent 共用
                                    shared-skill/     （做成 skill 共享）
```

---

## 五、Plugin 体系：Hook 生命周期

Plugin 通过 hooks 介入 Agent 的处理流程。理解 hooks 的**时序**和**能力边界**至关重要。

```
Gateway 收到请求
      │
      ▼
[hook: before_prompt_build]                    ← 介入点①
  能做：
    prependContext(content)      注入到对话历史前
    appendSystemContext(content) 追加到 system prompt
    读取 session user（event.session）
  不能做：
    ⚠️ 读取或修改 <available_skills> 块
       → OpenClaw 在此 hook「之前」已完成 skills 注入
       → event.messages 是对话历史，不含 system prompt
  HomeAI 用途：context-sources 多源注入
    Lucas：ChromaDB conversations（语义召回）+ Kuzu person（家人档案）→ appendSystemContext
    Andy： ChromaDB decisions（历史决策）+ Kuzu capabilities + ARCH.md + DESIGN-PRINCIPLES.md
    Lisa： ChromaDB code_history + Kuzu capabilities + CODEBASE.md
      │
      ▼
[OpenClaw 原生：Workspace 文件注入]             ← 插件无法介入
  AGENTS → SOUL → TOOLS → IDENTITY → USER → HEARTBEAT → MEMORY
      │
      ▼
[hook: before_model_resolve]                   ← 介入点②
  能做：
    覆盖模型 ID（event.modelId = "xxx"）
  HomeAI 用途：三层模型路由
    lucas → deepseek-chat
    andy  → MiniMax-M2.7
    lisa  → deepseek-reasoner
      │
      ▼
[hook: llm_input]                              ← 介入点③
  能做：记录请求元数据
  ⚠️ event.tools 不存在（读到 undefined，不是空数组）
     工具列表在 Plugin 注册时确定，不在这里修改
  HomeAI 用途：路由事件写入 route-events.jsonl
      │
      ▼
  LLM 调用（含工具调用循环）
  Agent 可能多次调用工具，每次工具执行后继续推理，直到输出最终回复
      │
      ▼
[hook: agent_end]                              ← 介入点④
  能做：读取 event.prompt（本轮提问）和 event.response（本轮回复）
  ⚠️ event.prompt 含历史前缀脏数据
     wecom-entrance 把「【近期对话（最近 N 轮）】...---\n\n」前缀注入了 event.prompt
     存入 ChromaDB 前必须剥离：
       cleanPrompt = actualPrompt.replace(/^【近期对话（最近 \d+ 轮）】[\s\S]*?---\n\n/, "")
  HomeAI 用途：ChromaDB 记忆写入、语料写入、DPO 候选检测
```

---

## 六、Skills 机制：可扩展能力包

Skills 是 Agent 的「模块化工作手册」——不是工具（tools），是「这件事怎么做」的步骤说明。

### 6.1 Skills 注入流程

```
六层 Skills 来源（优先级从低到高）
─────────────────────────────────────────────────────────
extra          config.skills.load.extraDirs（自定义目录）
bundled        OpenClaw 内置 Skills
managed        ~/.openclaw/skills/（全局管理 Skills）
personal       ~/.agents/skills/（个人 agents 目录）
project        /.agents/skills/（项目 agents 目录）
workspace      ~/.openclaw/workspace-{agent}/skills/（最高优先级）
```

**workspace 层优先级最高**——实例层的 Skill 会覆盖框架层的同名 Skill，这是有意设计。

Skills 加载有运行时资格评估：`requires.bins`（二进制依赖）/ `requires.env`（环境变量）/ `os`（操作系统）——缺少依赖时静默不加载，无报错，注意排查「为什么 Skill 没出现」的场景。

```
三层（HomeAI 实际使用）
─────────────────────────────────────────────────────────
bundled 层：OpenClaw 内置 Skills（所有 Agent 默认可见）
共享层：  ~/.openclaw/skills/{skill-name}/SKILL.md
私有层：  ~/.openclaw/workspace-{agent}/skills/{skill-name}/SKILL.md
                    │
                    ▼
        [before_prompt_build hook 「之前」，OpenClaw 原生完成]
                    │
                    ▼
        扫描三层目录，读取每个 SKILL.md 的 frontmatter
                    │
                    ▼
        构建 <available_skills> 块：
          <available_skills>
            name: family-understanding
            description: 系统性理解家庭成员的方法论...
            ---
            name: web-apps
            description: 何时发图形工具链接...
          </available_skills>
                    │
                    ▼
        注入到 system prompt（插件无法介入这个过程）
                    │
                    ▼
        Agent 读到 description → 决定是否读取 SKILL.md 全文
```

### 6.2 格式要求（必须严格遵守）

```
正确格式：                          错误格式（静默丢弃）：
workspace-lucas/                    workspace-lucas/
  skills/                             skills/
    family-understanding/               family-understanding.md  ← 扁平文件，不识别
      SKILL.md    ← 子目录格式
```

`SKILL.md` 头部必须有 YAML frontmatter：
```yaml
---
name: family-understanding
description: 一句话说明触发场景，Agent 看这句话决定是否读全文
---
```

缺少 frontmatter 或格式错误 → 静默丢弃，无错误提示。

### 6.3 HomeAI Skills 层级

```
框架层（源文件，不直接使用）：
  ~/HomeAI/crewclaw/daemons/workspace-templates/{agent}/skills/

实例层（运行时，Gateway 实际读取）：
  ~/.openclaw/workspace-{agent}/skills/

启动时：initAgentSkillsDir 从框架层复制到实例层（已有文件不覆盖）
```

> **⚠️ skill description 要写具体**：触发条件写太宽会导致几乎每次对话都带上这个 skill，上下文膨胀。description 描述具体场景和关键词，而不是模糊覆盖一大类任务。

---

## 七、记忆系统：ChromaDB 读写循环

### OpenClaw 原生记忆哲学：文件即真相

OpenClaw 的记忆系统采用「文件即真相」设计：

```
真相层（持久）：Markdown 文件（MEMORY.md + memory/YYYY-MM-DD.md）
加速层（索引）：SQLite + 向量嵌入（机器检索用，不是存储本体）
```

**混合搜索机制**：向量（0.7权重，语义相似）+ BM25（0.3权重，精确关键词）→ MMR 去重（防返回相似片段）→ 时间衰减（30天半衰期）

**常青文件不衰减**：MEMORY.md 和非日期命名文件（如 `memory/projects.md`）永不衰减，排名稳定。

**预压缩提示**：context 快满时，OpenClaw 自动提示 Agent 写入记忆——这就是为什么 Agent 必须会自主维护 MEMORY.md，而不是等外部脚本来帮它。

**HomeAI 的 ChromaDB 是同一层的实现替代**：我们用 ChromaDB + nomic-embed-text 替代了 SQLite + 向量索引的加速层，「对话记忆→向量检索→注入上下文」的逻辑完全一致。

```
每轮对话的记忆流动
─────────────────────────────────────────────────────────

【读取阶段】before_prompt_build hook
  ┌─────────────────────┐
  │ event.session.user  │  → 解析出真实 userId
  │ event.messages      │  → 取最近一条消息作为查询向量
  └─────────────────────┘
            │
            ▼
  ChromaDB.query(userId, promptText, topK=5)
  nomic-embed-text 向量化 → 余弦相似度检索
            │
            ▼
  返回最相关的记忆片段
            │
            ▼
  prependContext("【记忆片段】\n" + memories)
  注入到对话历史最前面 ← Agent 能感知到历史上下文

【写入阶段】agent_end hook
  ┌──────────────────────────────────────┐
  │ event.prompt（需剥离历史前缀！）       │
  │ event.response                       │
  └──────────────────────────────────────┘
            │
            ▼
  两类写入（并行）：
    conversations 集合：原始对话记录
    behavior_patterns 集合：Lucas 行为模式提炼

  防重复写入：chromaUpsert 用内容 hash 作 ID，同内容不重复写

【跨 session 记忆连续性】
  session 是请求隔离单元（每条消息独立），不是记忆载体
  记忆连续性完全靠 ChromaDB 注入，不靠 session 历史
```

### Session Key 设计（v425）

```
群聊消息：group:{fromUser}:{msgId}    ← 每条消息唯一 session
私聊消息：{userId}:{timestamp}        ← 每次独立 session

原因：稳定 session key（如 group:{chatId}）会导致：
  超时请求 A 占用 session → 后续消息 B、C 共用同一 session
  → A 未完成时 B、C 阻塞 → 并发崩溃

parseSessionUser 解析逻辑：
  "group:ZengXiaoLong:msg123" → userId = "ZengXiaoLong"（取中间段）
  "ZengXiaoLong:1742000000"   → userId = "ZengXiaoLong"（取前段）
```

> **⚠️ 测试 session 写保护**：session key 含 `test|watchdog` 的请求，跳过所有 ChromaDB 写入。否则 watchdog 探测请求会污染记忆数据。

---

## 八、Agent 自进化机制

这是 OpenClaw 最容易被低估的能力：**Agent 可以用内置工具直接修改自己的 workspace 文件**。

```
Agent 可自主修改的文件：
  AGENTS.md    → 调整工作规则和边界
  SOUL.md      → 调整性格和风格
  MEMORY.md    → 写入长期稳定知识
  memory/YYYY-MM-DD.md → 写入当日笔记
```

**修改后下次 session 立即生效**，无需重启 Gateway，无需外部脚本介入。

这是「越用越聪明」的物质基础：Agent 在对话中发现规律 → 写入 MEMORY.md → 下次对话自动携带。

**HomeAI 当前状态（L1 已激活）**：Lucas/Andy/Lisa 三角色的 MEMORY.md 已在 L1 阶段完成人工播种初始内容，Agent 可在对话中自主写入。distill-agent-memories.py 是系统工程师辅助蒸馏管道，两条路径互补——Agent 自主写是实时积累，外部蒸馏是定期提炼，不是替代关系。

> **关联**：这与 HomeAI 的进化方向一致——distill-agent-memories.py 是系统工程师辅助蒸馏，但 Agent 自主写入是更本质的进化路径，两者应该互补，不是替代关系。

---

## 九、Plugin 工具注册

```
工具注册时机：Gateway 启动时，Plugin 的 register() 函数执行

注册格式（OpenAI function calling）：
  api.registerTool({
    name: "send_message",
    description: "...",
    parameters: Type.Object({        ← ⚠️ MiniMax 必须用此格式
      userId: Type.String(),         ← 不能用 inputSchema（MiniMax 会返回 400）
      text: Type.String(),
    }),
    execute: async (params, toolCtx) => {
      if (toolCtx.agentId !== 'lucas') {   ← 检查 agentId，限制工具作用域
        return { error: "仅 Lucas 可调用" };
      }
      // ... 实际执行逻辑
    }
  })

工具对 Agent 的可见性：
  所有注册工具对所有 Agent 可见（都出现在 function calling 列表）
  通过 execute 里检查 agentId 实现运行时限制，而非声明时过滤
```

---

## 十、多 Agent 流水线：V字型协作

HomeAI 的需求流水线是「V字型」——Lucas 发起，沿 V 字左边下行到 Andy/Lisa 执行，完成后沿右边上行通知。

```
Lucas（家庭需求官）
  │
  │ trigger_development_pipeline（fire-and-forget，不等结果）
  │
  ▼
Andy（方案设计师）                      ← Gateway 独立 session 处理
  │
  ├─ research_task（信息调研）
  ├─ 自主写 spec（自包含 Implementation Spec，Andy 直接输出，不依赖外部工具）
  │
  │ trigger_lisa_implementation（fire-and-forget，不等结果）
  │
  ▼
Lisa（工具实现师）                       ← Gateway 独立 session 处理
  │
  ├─ run_opencode（代码实现）
  ├─ T1静态分析 → T2启动 → T3健康检查
  ├─ T4 后端 API 测试（curl，校验接口逻辑）
  ├─ T5 前端 E2E 测试（OpenClaw 原生 browser 工具，模拟真实用户操作）
  │     Web App 交付时必须；纯脚本交付时跳过
  │     └─ 自我修复循环（T2~T5 总计最多 2 轮）→ 生成 test-report.json + screenshots
  │
  │ pushEventDriven（完成后主动通知，不是轮询）
  │   回传内容：交付报告 + test-report.json + 失败截图
  │
  ▼
Andy（验收）← 基于 test-report.json 做设计意图校验
  │
  ▼
Lucas ← 收到完成通知 → 告知家人
```

**关键设计原则**：

```
错误做法（堵塞实时响应）：         正确做法（异步，fire-and-forget）：
  const reply = await               callGatewayAgent('andy', msg)
    callGatewayAgent('andy', msg);    .then(r => logger.info(r))
                                      .catch(e => logger.error(e));
                                    // 立即返回，不等 Andy
```

**为什么必须异步**：Gateway 并发处理所有请求，一个 `await` 会占用事件循环，阻塞其他家人的实时消息响应。Andy/Lisa 的处理可能需要数分钟，实时消息等不起。

---

## 十一、已知模型特性

| 模型 | 角色 | 工具调用 | 注意事项 |
|------|------|---------|---------|
| DeepSeek Chat（deepseek-chat）| Lucas | 稳定 | 工具调用可靠；曾用过 R1（deepseek-reasoner），因响应格式问题回退 |
| DeepSeek V3 / R1 | —（已弃用）| 不稳定 | V3 function calling 不稳定；R1 推理 token 格式影响工具调用 |
| MiniMax M2.7 | Andy | 稳定，但并发风险高 | 并发超时级联 → Gateway session pool 腐化（见§十二）|
| DeepSeek Reasoner | Lisa | 稳定 | opencode 调用 deepseek/deepseek-reasoner，推理能力强，适合实现任务 |

**MiniMax 工具注册特殊要求**：参数必须用 `parameters: Type.Object(...)` TypeBox 格式，`inputSchema` 格式会触发 400 错误。

---

## 十二、Gateway 稳定性

```
问题根因链（必须理解）：

MiniMax 并发超时
    │
    ▼
Gateway session pool 腐化
（session 对象卡在 pending 状态，无法清除）
    │
    ▼
/health 端点仍返回 200          ← ⚠️ 不能用 /health 判断 Gateway 健康
    │
    ▼
后续 LLM 请求永久 pending
（不超时，不返回，彻底卡死）
    │
    ▼
家人消息无响应，系统假死
```

**解决方案**：

```
缓解（已落地，v425）：
  gateway-watchdog（PM2 守护）
    每 5 分钟发一次「真实 LLM 请求」
    （不是 /health，是 POST /agent/lucas，用独立 session key watchdog:xxx）
    超时阈值：3 分钟
    超时则：kill -9 旧进程 → launchctl bootstrap 重启 Gateway

根治方向（未落地）：
  Andy session 加并发信号量（MAX_ANDY_CONCURRENT=1）
  超限排队通知用户，finally 确保信号量释放
```

**手动操作**：
```bash
# 重启 Gateway
launchctl bootout gui/$UID/ai.openclaw.gateway
launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# 查看 watchdog 探测历史
pm2 logs gateway-watchdog --lines 20
cat ~/HomeAI/logs/pm2/gateway-watchdog.log

# 语法验证（修改插件后）
cd ~/HomeAI/crewclaw/crewclaw-routing
node_modules/.bin/jiti ./index.ts
```

---

## 十三、安全模型：单用户信任，不是多租户

OpenClaw 采用「个人助手」信任模型，不是多租户共享总线：

```
一个可信操作者
  └── 一个 Gateway
        └── 多个 Agent
              └── 多个 session（session key = 路由控制，不是授权边界）
```

**关键结论**：
- 通过 Gateway 认证的调用者 = 可信操作者，有完全权限
- 同一 Gateway 上的 Agent 可以互相看到数据——这是**预期行为**，不是漏洞
- 沙箱默认关闭（`sandbox.mode: off`）——可信操作者不需要隔离
- Lucas 的 `read_file` 路径限制来自 workspace 边界（`openBoundaryFile` 2MB 限制 + 路径检查），不是 Docker 沙箱

**多用户场景**：每个信任边界使用独立的 OS 用户 / 主机 / Gateway——小姨公司实例应该是独立的 Gateway 实例，不是共用。

---

## 十四、openclaw.json：系统总控

```json
{
  "agents": {
    "list": [
      {
        "id": "lucas",
        "workspace": "~/.openclaw/workspace-lucas",   ← 人格文件目录（SOUL/AGENTS/TOOLS...）
        "agentDir": "~/.openclaw/agents/lucas"        ← 运行状态目录（sessions/auth-profiles）
      }
    ]
  },
  "subagents": {
    "allowAgents": ["andy", "lisa"]   ← 权限白名单，不在列表里的 Agent 无法被 spawn
  }
}
```

**workspace vs agentDir**：
- `workspace`：人格文件（怎么干活）→ SOUL.md / AGENTS.md / TOOLS.md...
- `agentDir`：运行状态（运行时产物）→ sessions / auth-profiles / models

> **⚠️ `${VAR}` 环境变量引用**：openclaw.json 语法上支持 `${DEEPSEEK_API_KEY}` 引用，但 `openclaw update` 命令会把它覆写成明文（已知 bug，Issue #9627）。轮换 API 密钥时需手动更新三处：openclaw.json + start-gateway.sh + .env。

---

## 十五、HomeAI 的叠加方式

```
OpenClaw 平台层（基础设施）
  │ 提供：Workspace 文件体系 · Skills 注入 · Session 管理 · hooks
  │
  ▼ 叠加
crewclaw-routing 插件层（HomeAI 专属扩展）
  │ 提供：ChromaDB 记忆 · 三层模型路由 · 家庭专属工具 · V字型流水线
  │
  ▼ 叠加
家庭场景应用层（业务实现）
  │ 提供：企业微信 Channel · 家人档案 · 错题工具等 app
```

**三条叠加原则**：
1. **不重建平行机制**：OpenClaw 有的（workspace 文件体系、skills 注入、session 管理）直接用，不另起炉灶
2. **插件层薄路由**：crewclaw-routing 只做记忆注入、模型路由、工具注册；Agent 自主决策，插件不替 Agent 编排步骤
3. **场景映射**：OpenClaw 的 USER.md 在 HomeAI 里映射为家庭成员档案；SOUL.md 映射为启灵的家庭成员身份

**关键路径速查**：
```
人格文件：  ~/.openclaw/workspace-{lucas,andy,lisa}/SOUL.md（同目录其他文件）
实例配置：  ~/.openclaw/openclaw.json
插件代码：  ~/HomeAI/crewclaw/crewclaw-routing/index.ts
wecom 入口：~/HomeAI/crewclaw/daemons/entrances/wecom/index.js
Gateway 启动：~/.openclaw/start-gateway.sh
Gateway 日志：~/.openclaw/logs/gateway.log
框架层 Skills：~/HomeAI/crewclaw/daemons/workspace-templates/{agent}/skills/
watchdog：  ~/HomeAI/scripts/gateway-watchdog.js
```
