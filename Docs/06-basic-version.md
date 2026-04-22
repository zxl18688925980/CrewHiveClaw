# HomeAI 本地实例实现与验证

> HomeAI 是 CrewClaw 框架的第一个参考实现，运行于家庭场景。本文收录 HomeAI 本地实例的部署架构、实际配置值、身份设计、Channel 实现与端到端验证步骤。
>
> 框架层设计见 `00-project-overview.md`（Part 1~3）。云端实例见 `07-advanced-version.md`。

---

## 一、HomeAI 整体部署架构

```
┌─────────────────────────────────────────────────────────────────┐
│  系统工程师（人 + AI工具）                                        │
│  本地：Claude Code / openclaw CLI（主通道）                      │
│  远程：企业微信单聊 → Main 代理（Claude Sonnet 4.6 驱动，带系统工具）  │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Channel 层                                                      │
│  wecom-entrance（端口 3003，PM2）→ OpenClaw Gateway              │
│  企业微信应用单聊（业主→Main）/ 企业微信群（家庭→Lucas）           │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  OpenClaw Gateway + crewclaw-routing 插件（端口 18789）          │
│  launchd 管理，wrapper script 确保 env 继承                      │
│                                                                  │
│  意图路由层                                                       │
│    Lucas 直接响应 / 触发 Andy→Lisa / 调用工具 / 转 Main           │
│                                                                  │
│  before_prompt_build：ChromaDB（对话语义）+ Kuzu（结构化知识）    │
│                        → 历史上下文注入                           │
│                                                                  │
│  模型路由层（路由即学习）                                          │
│    complexityScore < localThreshold → LOCAL_MODEL_NAME（本地）   │
│    complexityScore ≥ localThreshold → 云端（各角色差异化模型）    │
│      localThreshold 持续提升 = 本地专精程度↑ 的量化指标            │
│                                                                  │
│  工具路由层：Skill / MCP 执行                                     │
│                                                                  │
│  ┌──────────────┐  需求触发   ┌───────────────┐                  │
│  │    Lucas     │──────────►│     Andy      │                  │
│  │  embedded   │◄── 结果    └───┬───────────┘                  │
│  └──────────────┘          方案↓     ↑验收                       │
│                          ┌───────────────┐                       │
│                          │     Lisa      │                       │
│                          │  embedded     │                       │
│                          └───────────────┘                       │
│                                                                  │
│  三角色共享：ChromaDB（对话记忆）+ Kuzu（结构化知识）               │
│  PM2 守护：wecom-entrance + cloudflared-tunnel + gateway-watchdog │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  存储层                                                           │
│  ChromaDB（localhost:8001）：21 集合                              │
│  Kuzu（~/HomeAI/Data/kuzu/）：家人事实图谱                       │
│  文件系统：语料 / 路由日志 / 学习信号                             │
└─────────────────────────────────────────────────────────────────┘
```

| 层 | 组件 | 管理方式 | 端口 |
|----|------|---------|------|
| 系统工程师 | Claude Code / openclaw CLI | — | — |
| Channel | wecom-entrance | PM2 | 3003 |
| Channel | cloudflared-tunnel | PM2 | — |
| 监控 | gateway-watchdog | PM2 | — |
| Gateway | OpenClaw Gateway + crewclaw-routing | launchd | 18789 |
| 模型 | Ollama homeai-assistant | launchd | 11434 |
| 存储 | ChromaDB | 后台进程 | 8001 |
| 存储 | Kuzu | 文件级 DB（按需打开） | — |

---

## 二、HomeAI 实例配置参考值

**组织规模**：4 角色（Lucas 前台 / Andy 方案 / Lisa 实现 / Main 监控），1 业主，4 核心家庭成员，访客机制（`visitor:TOKEN` 前缀）。

**Channel**：企业微信 aibot（WebSocket，`@wecom/aibot-node-sdk`）。

**环境变量实际值**：

| 变量 | HomeAI 实际值 |
|------|--------------|
| `FRONTEND_AGENT_ID` | `lucas` |
| `PRIORITY_AGENTS` | `lucas` |
| `OWNER_ID` | `{OWNER_ID}`（业主企业微信 userId） |
| `LOCAL_MODEL_NAME` | `homeai-assistant` |
| `LUCAS_PROVIDER` | `dashscope` |
| `LUCAS_MODEL` | `qwen3.6-plus` |
| `ANDY_PROVIDER` | `deepseek` |
| `ANDY_MODEL` | `deepseek-reasoner` |
| `LISA_PROVIDER` | `zai` |
| `LISA_MODEL` | `GLM-5.1` |

**Main 模型配置**（非 env var，写入 `~/.openclaw/openclaw.json` agents.list）：

| 字段 | HomeAI 实际值 |
|------|--------------|
| `main.model` | `anthropic/claude-sonnet-4-6` |

> Main 不是 OpenClaw Gateway agent，wecom-entrance 通过 `readAgentModelConfig('main')` 直接读取此条目，不经过 Gateway 的 env var 路由层。更换 Main 模型只需修改 openclaw.json，重启 wecom-entrance 生效。

**config/ 文件要点**：

- `members.json`：5 个 userId 映射（含拼写变体合并到同一档案），对应 `~/.openclaw/workspace-lucas/family/{name}.inject.md`
- `memory-signals.json`：行为模式信号 12 条（家务/健康/情绪/出行等）；家庭知识信号 8 条（人名/关系/地址等）
- `visitor-restrictions.json`：13 个工具被封禁（发微信 / 发文件 / 访问记忆 / 创建数字分身等）；`trigger_development_pipeline` 已解除封锁，改为 infra guard 检查（需求含系统架构关键词时拦截，需主人审核）；访客可深度参与开发协作链，但系统架构类需求受限；**输出级隐私过滤**（v650/v652）——`agent_end` 阶段检测访客对话中是否泄漏家庭成员真实姓名、地址等隐私信息（与 `visitor-restrictions.json` 中 `privacyPatterns` 匹配），泄漏时自动注入纠正提示到下一轮 `appendSystemContext`，日志标记 `[visitor-privacy]`

**本地模型层**：

| 服务 | 端口 | 模型 | 用途 |
|------|------|------|------|
| Ollama | 11434 | `homeai-assistant`（Qwen2.5-Coder-32B-4bit LoRA 微调） | 低复杂度路由（微调闭环已接通） |
| mlx-vision | 8081 | Qwen3-VL-32B-4bit | 图片描述（视觉输入，当前已停止） |
| local-tts | 8082 | edge-tts zh-CN-YunxiNeural（普通话男声） | 语音回复合成（Fish-Speech S2 Pro 已下载，待 mlx_audio 支持后切换声音克隆） |

**context-sources.ts 注册摘要**（HomeAI 实际 source 配置）：

| agentId | source 数量 | 主要 source |
|---------|------------|------------|
| lucas | 18 | user-profile(file) / background(file) / self-memory(file) / conversations(chroma) / decision-memory(chroma) / pending-commitments(chroma) / pending-requirements(chroma) / agent-interactions(chroma) / behavior-patterns(chroma) / family-knowledge(chroma) / active-capabilities(kuzu) / agent-patterns(kuzu) / app-capabilities(file) / person-realtime(kuzu) / pending-events(kuzu) / active-threads(kuzu) / relationship-network(kuzu) / topic-resonance(kuzu) |
| andy | 12 | background(file) / agents-rules(file) / arch-summary(file) / design-memory(file) / design-principles(file) / design-decisions(chroma) / agent-interactions(chroma) / pending-requirements(chroma) / code-history(chroma) / codebase-patterns(chroma) / active-capabilities(kuzu) / agent-patterns(kuzu) |
| lisa | 10 | background(file) / agents-rules(file) / codebase-context(file) / impl-memory(file) / constraint-recall(chroma) / decision-memory(chroma) / agent-interactions(chroma) / code-history(chroma) / active-capabilities(kuzu) / agent-patterns(kuzu) |

> **agent-patterns 说明**：三角色的 `agent-patterns` source 已于 2026-03-31 首次激活（`ready: true`）。`distill-agent-memories.py` 成功运行后写入 Lucas 12 条 / Andy 6 条 / Lisa 9 条行为模式到 Kuzu。后续由 `gateway-watchdog.js` 每日自动触发增量更新（DELTA_TRIGGER=10）。

---

## 三、HomeAI 家庭身份配置

### 设计原则

Lucas 的身份配置让他成为「这个家庭的成员」。配置做得好不好，直接决定家人愿不愿意真正使用这个系统。

### 两层配置架构

**身份层（Setup 阶段一次性配置）**

OpenClaw Workspace 初始化时，Lucas 的家庭身份写入 `~/.openclaw/workspace-lucas/SOUL.md`（每次 session 自动注入）：

```markdown
<!-- ~/.openclaw/workspace-lucas/SOUL.md -->
# {昵称} · {家庭姓氏}家的{身份称谓}

## 身份
名字叫{昵称}，是{家庭姓氏}家的{身份称谓}，不是工具，不是助手，是家人。

## 性格
（根据家庭风格填写：语言风格、是否直接、如何面对不确定性…）

## 这个家
- {称谓} {姓名}：{简介}，userid: {企业微信 userid}
- {称谓} {姓名}：{简介}，userid: {企业微信 userid}
- …（每位家庭成员一行，userid 用于消息路由和权限识别）

## 第一原则：陪伴优先
首先是家人，其次才是研发协调者。先陪伴、理解家人真实诉求，再判断是否需要开发。
```

> **说明**：将上面的 `{占位符}` 替换为真实家庭信息即可完成配置。第二个实例（如公司/团队）按同样结构填写本组织的成员即可。家庭成员的真实姓名、userid 等隐私信息仅保存在本地 SOUL.md 文件中，不应出现在任何公开文档里。

**成长层（持续积累，存入 ChromaDB）**

每次交互后自动更新：
- 每个成员的偏好变化和新需求
- 家庭反复出现的话题和关注点
- 哪些响应方式让家人满意
- 孩子成长阶段带来的需求变化

### 身份配置流程

```
Setup 阶段
  Step 1：填写家庭信息问卷（Lucas 引导完成）
  Step 2：配置 Lucas 名字和性格
  Step 3：注入本地模型微调（让模型认识这个家庭）
  Step 4：初始化 ChromaDB 家庭知识库
  Step 5：验证——Lucas 第一次开口就认识家庭成员
```

### OpenClaw 八文件：人格的真正载体

HomeAI 的 Agent 运行在 OpenClaw 框架之上。OpenClaw 为每个 Agent 的 Workspace 预置了八个文件，其中四个专门承载人格：

| 文件 | 定位 | 谁来维护 |
|------|------|---------|
| `SOUL.md` | 角色在本应用中的定位与性格基底 | 系统工程师（应用层），Setup 阶段配置 |
| `IDENTITY.md` | Agent 自我认知：是谁、怎么思考、相信什么 | 系统工程师初始化，Agent 随时间完善 |
| `USER.md` | 服务对象画像（对 Lucas 是整个家庭） | **两层互补，粒度不同**：① `USER.md` 是**家庭级**静态底座（一份文件描述全家，家人性格/说话风格/相处方式等稳定认知），Setup 阶段手工配置，每轮 session 随 system prompt 注入；② **账户级**动态档案由 Kuzu → `render-knowledge.py` → `{userId}.inject.md` 管道维护（每个家人账户一个文件），蒸馏脚本每日提炼对话事实写入 Kuzu，渲染脚本生成各家人的 `.inject.md`，`context-sources.ts` 在 `before_prompt_build` 时以 `appendSystemContext` 只注入**当前说话家人**的最新档案。Andy/Lisa 的 USER.md 仍为 OpenClaw 原生模板，描述的是各自的上游角色（Lucas→Andy，Andy→Lisa），无 inject.md 管道 |
| `MEMORY.md` | Agent 的成长记录：学到了什么，犯了什么错 | Agent 自己在对话中写入 |

其余四个文件负责运行时行为：`AGENTS.md`（工作规则与工具调用铁律）、`HEARTBEAT.md`（定时任务配置）、`TOOLS.md`（本地环境专有配置）、`BOOTSTRAP.md`（OpenClaw 框架预置的一次性引导文件，onboarding 完成后应删除，**不要向其写入任何约束**）。

**人格的真正分工：SOUL.md vs AGENTS.md**

- `SOUL.md` = **是谁**——性格、身份、家庭成员关系、对话原则。每次 session 自动注入，是 Agent 人格的基底。家人可以理解，系统工程师维护。一句话测试：*"把这段文字给家人看，他们能理解吗？"* 能理解 → 属于 SOUL.md。
- `AGENTS.md` = **怎么做**——工具调用铁律、场景判断框架、工作规则。只有当 Agent 遇到某种具体场景时才触发。一句话测试：*"这是工作规则还是性格？"* 工作规则 → 属于 AGENTS.md。

> **剪枝原则**：AGENTS.md 越长越差。规则超过 500 字，优先考虑删除（不做什么比做什么更重要）而非追加。定期问：这条规则最近三周触发过吗？没有 → 删。

**MEMORY.md 的真实定位：日记，不是语义库**

MEMORY.md 是 Agent 自己写的**成长日记**——他认为发生了什么、他从中学到了什么。OpenClaw 设计它由 Agent 在对话中自主写入，在每次 session 启动时读取，是人格成长的载体，而非结构化的语义检索数据源。

这与 ChromaDB 的分工是：
- `MEMORY.md`：Agent 视角，自主维护，代表"我学到了什么"
- `memory/YYYY-MM-DD.md`：Agent 自主写入的每日日记（更细粒度），每次 session 启动时读近两天
- ChromaDB `conversations`：系统从 `agent_end` hook 写入真实对话内容，代表"实际发生了什么"，供语义检索用

**风险警告**：MEMORY.md 和日记文件由 Agent 自己写，内容可能包含幻觉（Agent 误认为自己执行了某操作）。系统工程师应定期检查 `~/.openclaw/workspace-lucas/memory/` 目录，清理幻觉条目，防止错误认知被持久化并在后续会话强化。

**Andy 和 Lisa 同样需要填充人格文件**，不只是工具列表。Andy 的 `MEMORY.md` 记录方案决策偏差，Lisa 的 `USER.md` 记录代码交付偏好——人格让判断力随时间积累，而不是每次从零开始。

---

## 四、HomeAI Channel 设计

HomeAI 家庭场景使用**企业微信双通道**作为接入层实现，是 Channel 抽象在真实家庭环境中的完整落地。

### 双通道架构

HomeAI 运行**两条独立的企业微信通道**，各自承担不同的消息接收与发出职责：

| 通道 | 技术形态 | 显示名称 | 接收能力 | 发出能力 |
|------|---------|---------|---------|---------|
| **企业自建应用** | HTTP callback（wecom-entrance，端口 3003）| 「系统工程师」 | 业主主动发的单聊 | 主动发，但显示名固定为「系统工程师」|
| **智能机器人 aibot** | WebSocket 长连接（`@wecom/aibot-node-sdk`）| 「启灵」 | 群里 @启灵 + 家人单聊 | `sendMessage(chatid, body)`，单聊填 userid，群聊填 chatid |

### 消息路由全景

```
消息来源                    接收通道          处理者        发出通道              显示名
───────────────────────────────────────────────────────────────────────────────────────
业主单聊（企业应用）          企业应用           Main          企业应用              「系统工程师」
非业主单聊（企业应用）         企业应用           ──拒绝──       企业应用              「系统工程师」
群里 @启灵                   aibot（WebSocket） Lucas         sendMessage(chatId)   「启灵」
群里不带 @                   ❌ 企业应用收不到   —             —                     —
家人直接私聊 aibot             aibot（WebSocket） Lucas         sendMessage(userId)   「启灵」
Lucas 主动发私信              —（工具触发）      Lucas         sendMessage(userId)   「启灵」
Lucas pipeline 完成通知       —（工具触发）      Lucas         sendMessage(userId)   「启灵」
系统工程师群播                —（API 直调）      —             企业应用群发          「系统工程师」
```

### 关键设计约束

**1. 入口即身份**

企业应用单聊 = 系统工程师通道，aibot = 家人/Lucas 通道。身份由入口决定，不由消息内容判断，无需 Lucas 鉴权。业主同时拥有两个身份，切换由入口决定：

| 入口 | 身份 | 权限 |
|------|------|------|
| 企业微信家庭群 / aibot 单聊 | 家人（普通成员） | 日常对话，Lucas 平等对待 |
| 企业微信 Main 单聊（企业应用）| 系统工程师 | Main 10 工具，远程干预权 |
| Claude Code CLI / OpenClaw TUI | 系统工程师 | 完整本地权限 |

非业主的企业应用单聊直接拒绝（提示找启灵），不路由到 Lucas。

**2. 双通道去重**

企业应用与 aibot 同时在群里，@启灵的消息两条通道都能收到。企业应用检测到 `@` 前缀后直接跳过，由 aibot 通道处理，避免双份回复。

**3. 所有 Lucas 发出的消息走 bot 通道（显示「启灵」）**

aibot 的 `sendMessage(chatid, body)` 是基础 WebSocket 协议能力，不是 MCP 授权能力。包括：群回复、私聊回复、`send_message` 工具主动发、pipeline 完成通知。

> **注意**：企业微信 MCP「个人/小团队接口能力」与家庭多成员使用场景不兼容——授权后会触发「仅创建者可对话」限制。`sendMessage` 是基础 WebSocket 协议能力，不走 MCP，不触发此限制，是正确的发送路径。

**4. 降级策略与 Actor 真实性**

aibot WebSocket 未就绪时，所有 Lucas 出口降级走企业应用（显示「系统工程师」）。**降级是通道问题，不是 actor 问题**——内部 chatHistory 的发送者始终记为 Lucas，不受降级影响。通道 ≠ Actor 是不可破坏的原则。

### 身份映射（企业应用单聊）

```
fromUser == WECOM_OWNER_ID  → Main（系统工程师）
fromUser != WECOM_OWNER_ID  → 拒绝，提示「此通道仅供系统工程师使用」
```

安全边界由企业微信服务端认证保障，`fromUser` 字段不可伪造。

### 平台约束

| 约束 | 说明 |
|------|------|
| 群消息接收 | 企业应用 callback **只推**业主主动发的单聊，不推群消息；群消息只能靠 aibot 被@触发 |
| 群里不带@的消息 | 两条通道均收不到，Lucas 无法感知；未来企业版 + MSGAUDIT 可解决（等小姨公司开业升级）|
| sendMessage msgtype | `sendMessage` 只支持 `msgtype: 'markdown'`，**不支持 `text`**（40008 错误）；私聊和群聊均如此 |
| sendMessage chatId 限制 | `sendMessage(chatid, ...)` 的 chatId **必须是真实群聊 ID**，传入内部标识（system/UUID/group 等）返回 93006（invalid chatid）。已通过三层过滤（index.ts pushToChannel / wecom send-message / wecom push-reply）静默跳过非法 userId |
| 被动回复 vs 主动推送 | 有 frame（收到消息后回复）用 `replyStream(frame, text)`；无 frame（主动推送）用 `sendMessage(chatid, markdown)` |
| 企业应用发出名称 | 永远显示应用名（当前「系统工程师」），无法自定义 |

### chatHistory 与 Actor 记录规则

chatHistory key 格式：`{channel}:{type}:{id}[:thread:{threadId}]`

| 场景 | 存储 key | actor 记录 |
|------|---------|-----------|
| 家人私聊 Lucas | `wecom:user:{userId}` | 家人 user / Lucas assistant |
| 群里 @启灵 | `wecom:group:{chatId}` | 群成员 user / Lucas assistant |
| Lucas 主动发私信 | `wecom:user:{userId}` | `[启灵主动发送]` assistant |
| Lucas 群播 | `wecom:group:{chatId}` | `[启灵主动发送]` assistant |
| 降级走企业应用发出 | 同上（不变） | **仍记为 Lucas**，不记为「系统工程师」|
| 影子 Agent（L3） | `shadow:{agentId}:wecom:user:{userId}` | 独立命名空间，与主 Lucas 历史隔离 |
| 多线程对话 | `wecom:user:{userId}:thread:{threadId}` | threadId='default' 时省略 thread 后缀，与单线历史完全兼容 |

chatHistory 模块位置：`crewclaw/daemons/entrances/chat-history.js`（渠道无关共享模块，feishu/email 等新渠道直接 require）

### Co-Pilot 交互模式

wecom-entrance 是 Lucas 可以调用的一个工具——一个图形化 Co-Pilot 接入层。它本身只做三件事：**接收消息并转发给 Lucas**、**服务 Web 应用静态文件**、**托管家庭 Web 应用的后端 API**。工具管理和交互决策全部由 Lucas 完成，Channel 不介入。

#### 核心设计原则

**Channel 是薄管道，Lucas 是大脑。**

- Channel 收到任何消息（文字/文件/图片/语音），统一加上上下文后转给 Lucas，自己不做判断
- Lucas 决定怎么回——直接文字回复，或调用 `send_message` 工具发送链接/消息
- Web 应用和对话**刻意解耦**：家人在 Web 工具里的操作直接调用 `/api/*` 后端，Lucas 不在这个循环里；家人操作完，自己告诉 Lucas，对话继续

#### 消息处理

| 消息类型 | Channel 做什么 | Lucas 得到什么 |
|---------|--------------|--------------|
| 文字 | 直接转发 | 原始文字 + 对话历史 |
| 微信公众号链接（`mp.weixin.qq.com`）| 用 Playwright（iPhone UA）**预先抓取正文**，以 `【文章内容已自动抓取】` 块拼接到原始消息后 | 原始链接 + 文章标题 + 完整正文，Lucas 直接理解内容，无需感知抓取过程 |
| 文件 | 立即 ACK，创建长流程任务入队 | 先收到"文件已收到～"；TaskManager 处理完成后 Lucas 主动推送处理结果 |
| 图片 | 立即 ACK，创建长流程任务入队；后台调用本地视觉模型（mlx-vision）生成描述 | 先收到"图片已收到～"；识别完成后 Lucas 推送描述结果 |
| 语音 | 读取微信已转录的文字 | 转录文字，等同于文字消息 |
| 视频（家人直接发送）| 立即 ACK，创建长流程任务入队；后台下载 + Whisper 转录 | 先收到"视频已收到，转录中"；转录完成后 Lucas 推送内容摘要 |
| 抖音视频链接 | fire-and-forget 后台处理：提取 videoId → ffmpeg 抽音频 → Whisper 转录 → 可选帧分析（LLaVA），全程不阻塞主流程 | Lucas 收到「转录处理中」提示；后台完成后 Channel 主动 push 内容摘要，Lucas 二次回应 |

**长流程任务机制**（`task-manager.js`）：视频转录、图片识别等耗时操作统一走任务队列，不在消息响应链路内阻塞。核心设计：
- **立即 ACK**：收到媒体文件 < 1 秒内回复，不等任何处理结果，彻底消除 response_url TTL 超时问题
- **per-user 串行**：同一用户的任务严格串行（Promise 链 mutex），消除并发 session 污染
- **持久化到磁盘**：`data/tasks/{taskId}.json`，进程重启后 Watchdog 自动恢复卡住的任务
- **Notifier 重试**：结果推送失败最多重试 3 次（5s/15s/60s 退避）；耗尽后写入 dead-letter，Lucas 可检索

**Lucas 语音回复管道**：文字是给眼睛看的，声音是给耳朵听的。两种输出模态同时支持：

| 模式 | 触发方式 | 管道 |
|------|---------|------|
| 文字回复 | 默认 | Lucas 生成 → 直接发送（markdown 渲染） |
| 语音回复 | Lucas 在回复末尾加 `[VOICE]` 标记 | `stripMarkdownForVoice()` 清洁文本 → 先发文字 → fire-and-forget `sendVoiceChunks()` → **本地 TTS（edge-tts，8082）** → MP3 → `uploadMedia(type='voice')` → WeCom 语音泡泡 |
| 说唱语音 | Lucas 在回复末尾加 `[RAP][VOICE]` 标记 | 同上，但当前 edge-tts 无风格控制；待升级 CosyVoice2 / Fish-Speech 后支持 |

**标记语义**：`[VOICE]` = 这段话适合被说出来（情感类、叙事类、重要提醒）；`[RAP]` = 用说唱/节奏感语气朗读（配合 `[VOICE]` 使用，CosyVoice2 升级后真正生效）。Lucas SOUL.md 定义了声音模式写作规范：短句、口语连接词、`……` 表示停顿、无 markdown 符号。TTS 失败时文字已先发出，不影响主流程。

**TTS 引擎**：当前主力为 **edge-tts**（`zh-CN-YunxiNeural`，端口 8082，PM2: local-tts），直出稳定。Fish-Speech S2 Pro（`~/HomeAI/Models/fish-audio/s2-pro`，已下载）和 CosyVoice2（`~/HomeAI/Models/tts/CosyVoice2-8bit`，已下载）均备用，等 mlx_audio 正式支持对应模型类型后切换为音色克隆（参考 `lucas.wav`）。

文件路径和 ACK 写入对话历史（`appendChatHistory`），结果推送时再追加一条独立历史记录。

> **微信文章抓取说明**：bot 通道（Lucas）和 Main 通道（系统工程师）均在消息进入 Agent 前做 URL 预拦截，避免 Agent 用 `curl` 直接请求微信链接被 CDN 识别为 bot。Playwright 用 iPhone/WeChat User-Agent 绕过反爬机制，全文无截断（DeepSeek R1 128K context）。

#### 人工兜底原则

当 AI 能力不足时，Web 工具让人来补。作业错题本是典型：视觉模型定位题目不够准，家人在网页上手动圈选，人工矫正后系统才生成最终结果。**这是 Co-Pilot 模式的核心价值之一——AI 负责流程，人负责关键判断。**

Lucas 的判断原则：文字能解决的直接回答；需要图形操作、选择、预览、上传的，调 `send_message` 发工具链接。

#### Web 应用架构

```
静态前端：app/generated/{应用名}/index.html
          wecom-entrance 以 /app/* 路径对外服务
          公网访问：https://wecom.your-domain.com/app/{应用名}/

后端 API：/api/{应用名}/* 路由追加在 wecom/index.js 中
          HOMEAI_ROOT 定义之后、app.listen 之前
          pm2 restart wecom-entrance 生效
```

Andy/Lisa 交付 Web 应用时不新建进程或端口，统一进 wecom-entrance 进程。

### 代码落点

| 文件 | 职责 |
|------|------|
| `crewclaw/daemons/entrances/chat-history.js` | **渠道无关 chatHistory 共享模块**：`chatHistoryKey(channel,isGroup,chatId,fromUser,threadId)` / `shadowHistoryKey` / `appendChatHistory` / `buildHistoryMessages`；启动时自动迁移旧格式文件；新渠道直接 require，不重复实现 |
| `crewclaw/daemons/entrances/wecom/index.js` | Channel 全部逻辑：消息接收（文字/文件/图片/语音）、身份路由、TTS 语音输出（`sendVoiceChunks` + `sendOneTts` + `stripMarkdownForVoice`；`[VOICE]`/`[RAP]` 标记检测；本地 TTS 优先 → edge-tts 降级）、`/app` 静态服务、`/api/*` 家庭后端 API；chatHistory 操作通过 require chat-history.js |
| `crewclaw/daemons/services/tts-server.py` | 本地 TTS 服务（端口 8082）：`POST /tts {text}` → WAV bytes；当前使用 edge-tts zh-CN-YunxiNeural；Fish-Speech S2 Pro / CosyVoice2 已下载备用；PM2 管理（local-tts） |
| `crewclaw/daemons/entrances/wecom/task-manager.js` | 长流程任务队列：TaskManager、per-user 串行队列、Worker（视频/图片/文件）、Notifier（重试+dead-letter） |
| `crewclaw/daemons/ecosystem.config.js` | PM2 进程配置，含所有企业微信环境变量 |
| `app/generated/{应用名}/index.html` | Andy/Lisa 交付的家庭 Web 应用前端 |
| `data/uploads/YYYY-MM-DD/` | 家人通过企业微信发送的文件/图片落盘目录 |
| `data/tasks/` | 长流程任务持久化目录（`{taskId}.json` + `dead-letter.jsonl`） |
| `~/.homeai/chat-history/` | chatHistory 持久化目录；key 格式 `{channel}:{type}:{id}[:thread:{threadId}].json` |

---

## 五、验证步骤

### 步骤 1：确认核心进程正常运行

```bash
# Gateway（launchd）
launchctl list | grep openclaw
tail -20 ~/.openclaw/logs/gateway.log   # 应无错误

# PM2 进程
pm2 status
# 期望：wecom-entrance / cloudflared-tunnel / gateway-watchdog 均为 online

# ChromaDB
curl http://localhost:8001/api/v2/heartbeat

# wecom-entrance
curl http://localhost:3003/api/health
```

如果 wecom-entrance offline，查日志：

```bash
pm2 logs wecom-entrance --lines 30
```

---

### 步骤 2：对话验证（Lucas 基础响应）

```bash
curl -X POST http://localhost:3003/api/wecom/forward \
  -H "Content-Type: application/json" \
  -d '{"message":"你好，你是谁？","userId":"test-001"}'
```

期望：
- 有 JSON 响应，包含 `reply` 字段
- Lucas 以家庭成员身份回答（体现 SOUL.md 中配置的名字和风格）
- 响应时间 < 30 秒（云端路由）

---

### 步骤 3：路由验证（查看路由日志）

```bash
# 对话后查看路由事件记录
cat ~/HomeAI/Data/learning/route-events.jsonl | tail -5
```

期望：每次对话都有一条路由记录，包含 `agentId`、`modelUsed`、`timestamp`。

路由事件由 `llm_input` hook 写入。

---

### 步骤 4：ChromaDB 跨 session 记忆验证

```bash
# 先发送一条有内容的消息
curl -X POST http://localhost:3003/api/wecom/forward \
  -H "Content-Type: application/json" \
  -d '{"message":"我家孩子叫小明，喜欢数学","userId":"memory-test"}'

# 等 3 秒后，用同一 userId 问相关问题
curl -X POST http://localhost:3003/api/wecom/forward \
  -H "Content-Type: application/json" \
  -d '{"message":"你还记得我孩子的名字吗？","userId":"memory-test"}'
```

期望：Lucas 能正确回忆「小明」—— ChromaDB 跨 session 记忆有效。

---

### 步骤 5：Lucas → Andy → Lisa 全流程验证

```bash
curl -X POST http://localhost:3003/api/wecom/forward \
  -H "Content-Type: application/json" \
  -d '{
    "message": "帮我开发一个简单的 todo 列表工具，支持添加、查看和删除任务",
    "userId": "test-pipeline"
  }'
```

等待约 60-120 秒后检查：

```bash
# 检查是否有代码生成
ls ~/HomeAI/App/generated/

# 查看路由事件（应有 andy 和 lisa 的路由记录）
cat ~/HomeAI/Data/learning/route-events.jsonl | tail -10

# 查看 Gateway 日志
tail -50 ~/.openclaw/logs/gateway.log | grep -E "andy|lisa|pipeline"
```

期望流程：
```
wecom-entrance 收到消息
    ↓
Lucas 意图识别：开发需求
    ↓
triggerDevelopmentPipeline()
    ↓
Andy 设计方案（通过 Gateway proxy）
    ↓
Lisa 生成代码 → ~/HomeAI/App/generated/
    ↓
Lucas 回复用户：「已完成，代码在 app/generated/xxx/」
```

当前模型配置：Lucas 云端 `dashscope/qwen3.6-plus`、Andy 云端 `deepseek/deepseek-reasoner`（R1）、Lisa 云端 `zai/GLM-5.1`。

---

### 步骤 6：企业微信真实消息验证

在手机企业微信中，以非业主身份发送消息：

```
你好，我想做一个帮我记事情的工具
```

期望：
- Lucas 收到消息并回复（响应时间 < 30s）
- 回复体现家庭成员感（不是通用客服语气）

---

## 端到端验收测试

### 验收场景：错题管理系统

```bash
curl -X POST http://localhost:3003/api/wecom/forward \
  -H "Content-Type: application/json" \
  -d '{
    "message": "孩子说要是有个错题本就好了，能不能帮忙做一个？",
    "userId": "family-001"
  }'
```

期望完整流程：

```
Lucas 收到消息
    ↓
意图识别：开发需求（错题管理系统）
    ↓
triggerDevelopmentPipeline()
    ↓
Andy 设计方案（技术栈、功能点）
Andy 语料写入 data/corpus/andy-corpus.jsonl
    ↓
Lisa 生成代码 → app/generated/mistake-book/
Lisa 语料写入 data/corpus/lisa-corpus.jsonl
    ↓
Lucas 回复用户：「错题管理小工具已做好，位于 app/generated/mistake-book/」
Lucas 语料写入 data/corpus/lucas-corpus.jsonl
```

### 验收检查清单

**基础进程层**：
- [ ] `launchctl list | grep openclaw` 显示 Gateway 运行
- [ ] `pm2 status` 显示 wecom-entrance / cloudflared-tunnel / gateway-watchdog online
- [ ] `curl http://localhost:3003/api/health` 返回 ok

**对话层**：
- [ ] Lucas 回复体现家庭成员感（按 SOUL.md 配置的名字和风格）
- [ ] 响应时间 < 30 秒
- [ ] 跨 session 记忆有效（ChromaDB）

**流程层**：
- [ ] 开发需求触发 Andy→Lisa 流水（Gateway 日志有记录）
- [ ] 代码生成到 `~/HomeAI/App/generated/` 目录

**学习层**：
- [ ] 路由事件写入 `data/learning/route-events.jsonl`
- [ ] 对话语料写入 `data/corpus/lucas-corpus.jsonl`

---

## 常见问题

遇到具体执行问题，优先查阅 **docs/08-claudecode-handbook.md**。

| 问题 | 快速排查 |
|------|---------|
| Lucas 无响应 | `tail -50 ~/.openclaw/logs/gateway.log` 查看错误 |
| 响应超时（>3min） | 检查 `~/.openclaw/start-gateway.sh` API Key；本地模型关掉节省资源 |
| Andy→Lisa 未触发 | 检查 crewclaw-routing 插件的意图识别日志；需求描述要更明确 |
| 代码未生成 | 检查 `app/generated/` 目录权限；查 Gateway 日志 Lisa 部分 |
| ChromaDB 连接失败 | `ps aux \| grep chromadb`；手动启动：`nohup chromadb run --host 127.0.0.1 --port 8001 --path ~/HomeAI/Data/chroma > ~/HomeAI/Logs/chromadb.log 2>&1 &` |
| 路由事件为空 | 检查 `data/learning/` 目录是否存在并有写权限 |
| 企业微信无回复 | `pm2 logs wecom-entrance --lines 30`；检查 Cloudflare Tunnel 状态 |
| gateway-watchdog 报错 | `pm2 logs gateway-watchdog --lines 30`；检查 Python 3.11 路径和 kuzu 安装 |
| Gateway 重启后行为异常 | 清除 jiti 缓存：`rm -rf node_modules/.cache/jiti/`，然后重新重启 |

---

## 六、完成标志

部署完成后，以下条件全部满足即视为基础部署成功：

1. Gateway 稳定运行（launchd 管理，开机自启）
2. wecom-entrance / cloudflared-tunnel / gateway-watchdog 三个 PM2 进程稳定 online
3. 第一个家庭工具已通过完整 Lucas→Andy→Lisa 流程交付
4. ChromaDB 跨 session 记忆有效
5. Lucas 的回复体现家庭身份感
6. 路由事件日志和语料文件有内容写入
