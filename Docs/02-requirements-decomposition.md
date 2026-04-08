# 需求分解

---

## 一、分解逻辑

### 设计到需求的转化

```
设计哲学（分布式智能演化，路由即学习）
    ↓
系统架构（多层架构，极端优化为双层 + 原生 OpenClaw + crewclaw-routing 插件 + 三层路由）
    ↓
各阶段开发需求（Setup → 基础版 → 高级版 → 进化版）
    ↓
操作指导书（05-09 告知如何实现这些需求）
```

### 阶段依赖关系

| 阶段 | 核心产出 | 作为下一阶段的基础 |
|------|---------|-----------------|
| **Setup** | 原生 OpenClaw + crewclaw-routing 插件 + 本地模型微调 + 家庭身份配置（SOUL.md + AGENTS.md）| 基础版所需执行层和模型 |
| **基础版** | Lucas embedded agent + Andy/Lisa daemon + 三层路由 + **路由学习闭环 + 增量微调** + 语料上传 + 多入口 | 本地系统完备，高级版可直接验证复杂能力 |
| **高级版** | 复杂功能自开发验证（物理接入）+ 云端接口验证（模拟器）+ 云端对接指南 | 架构完整性验证，云端接入随时可切换 |

---

## 二、Setup 阶段需求

**目的**：建立基础运行环境，安装原生 OpenClaw + crewclaw-routing 插件，完成三角色身份配置（SOUL.md + AGENTS.md），让 Lucas 第一次开口就认识这个家庭。

### 基础软件需求

| 需求 | 规格 | 优先级 | 验收标准 |
|------|------|--------|---------|
| Node.js | 22.x LTS | P0 | `node -v` 版本正确 |
| Python | 3.11.x | P0 | `python --version` 正确 |
| Ollama | 最新稳定版 | P0 | `ollama serve` 可启动 |
| ChromaDB | 本地 Python 包（端口 8001） | P0 | `curl localhost:8001/api/v2/heartbeat` 响应正常 |
| MLX | Apple Silicon 版本 | P1 | 可执行微调脚本 |
| PM2 | 最新稳定版 | P0 | `pm2 list` 可运行 |

### 执行层初始化需求

原生 OpenClaw + crewclaw-routing 插件是执行层的基础，后续所有阶段都依赖它。

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| 安装原生 OpenClaw | `npm install -g openclaw`，不需要 fork 或自行构建 | P0 | `openclaw --version` 可运行 |
| crewclaw-routing 插件 | 三层路由通过插件实现，零 core 修改 | P0 | 插件加载正常，`before_model_resolve` hook 生效 |
| OpenClaw Gateway | launchd 服务（ai.openclaw.gateway，端口 18789），wrapper script 确保 env 继承 | P0 | `curl localhost:18789/health` 响应正常 |
| Lucas embedded agent | Lucas 在 Gateway 内常驻，人格文件 SOUL.md + AGENTS.md | P0 | Lucas 用配置的名字和风格回应 |
| Skill/MCP 兼容 | 完整复用 OpenClaw Skill 和 MCP 生态，不重建 | P0 | 至少一个 Skill 可正常调用 |
| OpenAI 兼容接口 | 统一调用 Ollama 和云端模型 | P0 | 本地和云端模型均可通过同一接口调用 |

### 家庭身份配置需求

Lucas 的家庭成员身份是系统被真正使用的前提。

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| Lucas SOUL.md + AGENTS.md | `~/.openclaw/workspace-lucas/`，SOUL.md 填写家庭成员信息和 Lucas 名字，AGENTS.md 定义工具调用铁律 | P0 | Lucas 用配置的名字和风格回应 |
| Andy SOUL.md + AGENTS.md | `~/.openclaw/workspace-andy/`，架构师角色定位和工作规则 | P1 | Andy 回复风格与配置一致 |
| Lisa SOUL.md + AGENTS.md | `~/.openclaw/workspace-lisa/`，工程师角色定位和交付规范 | P1 | Lisa 回复风格与配置一致 |
| ChromaDB 初始化 | 首次对话时自动创建集合 | P0 | 集合可正常读写，跨 session 有效 |

### 本地模型微调需求

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| 基础模型下载 | homeai-assistant 基础模型（Ollama） | P0 | `ollama pull` 完成，模型可加载 |
| 三角色身份微调 | 用家庭信息 + 角色定义做初始 SFT | P0 | Lucas 自报家门正确，Andy/Lisa 角色认知正确 |
| 微调验证测试集 | Setup 完成时建立固定测试集 | P0 | 测试集问答全部正确 |
| MLX 微调脚本 | 可重复执行的增量微调脚本 | P1 | 脚本可执行，微调后模型可加载 |

### 企业微信配置需求

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| wecom-entrance 部署 | 独立 PM2 进程，端口 3003，AES 解密 + 签名验证 | P0 | `curl localhost:3003/api/health` 响应正常 |
| 消息路由到 Lucas | 企业微信消息转发到 Lucas /api/chat | P0 | 发消息 Lucas 能回复 |
| Cloudflare Tunnel（cloudflared） | 将 3003 端口暴露到公网供企业微信回调 | P0 | 企业微信 Callback URL 验证通过 |

### Setup 验收标准

- [ ] `openclaw --version` 可运行
- [ ] OpenClaw Gateway 启动，`curl localhost:18789/health` 正常
- [ ] Lucas 用配置的名字和风格回应（测试一次对话）
- [ ] ChromaDB 首次对话后集合正常
- [ ] wecom-entrance PM2 online（Andy/Lisa 是 OpenClaw embedded agent，无独立 PM2 进程）
- [ ] 企业微信收发消息正常（可选）

---

## 三、基础版需求

**目的**：建立 Lucas（embedded agent）+ Andy/Lisa（/api/chat daemon）完整协作体系，实现完整的三层路由，完成第一个端到端家庭需求交付，验证「家庭 AI 研发团队」核心价值。

### 三角色需求

#### Lucas（OpenClaw embedded agent）

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| 持续在场 | 在 Gateway 内常驻，所有企业微信消息经 Gateway 路由到 Lucas | P0 | 消息到达 Gateway → Lucas 有回复 |
| Layer 1 意图路由 | 日常对话 / 开发需求 / 工具调用 / 成员深度（member_deep）四路分发 | P0 | 四类意图识别准确率 ≥ 85% |
| 需求提取器 | 从对话中识别隐性需求，结构化存入 ChromaDB | P0 | 「要是有个错题本就好了」能被识别为需求 |
| Andy 流水触发 | 需求确认后通过 Gateway daemon proxy 转发给 Andy | P0 | Andy 能收到并处理 Lucas 发来的需求 |
| ChromaDB 读写 | 对话历史、家庭记忆、需求记录持久化 | P0 | 跨 Session 记忆有效 |
| 对话语料采集 | 每次对话自动记录至 `data/corpus/lucas-corpus.jsonl` | P0 | 文件持续增长，格式正确 |
| 成员分身管理 | 为重要组织成员按需创建/退役专属 Agent（有创建判断原则）| P1 | 分身 Agent 语料归入 Lucas 语料管道 |
| 人工干预提醒 | 连续失败 / 超范围请求时提醒业主 | P1 | 触发条件准确，提醒及时 |

#### Andy（OpenClaw embedded agent）

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| embedded agent 运行 | 在 Gateway 内常驻，由 Lucas 通过 `trigger_development_pipeline` 触发 | P0 | Gateway 收到对 andy 的请求正常响应 |
| 自主两步驱动 | 收到需求后自主调用：`research_task`（调研）→ 自主写 spec → `trigger_lisa_implementation`（触发 Lisa）| P0 | Andy 完成调研和 spec，Lisa 收到 spec |
| 决策记录器 | 每次设计决策自动记录至 ChromaDB | P0 | 决策可追溯，有原因说明 |
| Andy 验收 | Lisa 交付后，Andy 对照 spec 做验收（通过/失败/部分通过）| P0 | 验收结论有记录，失败时 Lucas 知晓 |
| 架构语料采集 | 记录设计过程至 `data/corpus/andy-corpus.jsonl` | P0 | 文件持续增长，格式正确 |

#### Lisa（OpenClaw embedded agent）

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| embedded agent 运行 | 在 Gateway 内常驻，由 Andy 通过 `trigger_lisa_implementation` 触发 | P0 | Gateway 收到对 lisa 的请求正常响应 |
| OpenCode 集成 | 调用 `run_opencode` 工具驱动代码实现，输出落地至 `app/generated/` | P0 | `app/generated/{应用名}/` 有可运行文件 |
| 交付验证 | 实现完成后通过 `pushEventDriven` 通知 Lucas，再由 Andy 验收 | P0 | Lucas 收到完成通知 |
| 代码语料采集 | 记录实现过程至 `data/corpus/lisa-corpus.jsonl` | P0 | 文件持续增长，格式正确 |

### 三角色通信协议（V 字型流水线，fire-and-forget）

```
企业微信 → wecom-entrance(3003) → Gateway(18789) → Lucas(embedded)

Lucas 识别到开发需求
  → 调用 trigger_development_pipeline（工具）
  → crewclaw-routing 插件写入 requirements，fire-and-forget 发给 Andy

Andy 收到需求（不等 Lucas）
  → 自主调用 research_task（调研）→ 自主写 spec → trigger_lisa_implementation（fire-and-forget）

Lisa 收到 spec（不等 Andy）
  → 自主调用 run_opencode → 完成后调用 pushEventDriven 通知 Lucas

Lucas 收到通知（事件驱动，不轮询）
  → 翻译结果推送给家庭成员
```

### 三层路由需求（基础版）

| Layer | 需求 | 优先级 | 验收标准 |
|-------|------|--------|---------|
| Layer 1 | 意图分类（crewclaw-routing 插件）：对话 / 开发 / 工具 / 成员深度 | P0 | 准确率 ≥ 85% |
| Layer 2 | 本地/云端模型路由（crewclaw-routing `before_model_resolve` hook）：路由即学习，每次云端路由记录为学习机会 | P0 | 简单任务走本地 ≤ 3s，云端路由事件有日志 |
| Layer 3 | Skill 调用 + MCP SDK 直连（原生 OpenClaw，不重建）| P0 | 至少 3 个 Skill 可正常调用 |

### 多入口交互需求

| 入口 | 需求 | 优先级 | 验收标准 |
|------|------|--------|---------|
| 企业微信 | 私聊 + 群组消息收发 | P0 | 消息延迟 ≤ 5s |
| 本地语音 | 语音识别 + TTS 回复 | P0 | 识别准确率 ≥ 85% |
| HTTP API | wecom-entrance HTTP API | P0 | `curl localhost:3003/api/health` 响应正常 |

### 端到端验证需求

基础版必须完成至少一个完整的家庭需求交付：

```
家庭成员说出需求（任意形式）
  → Lucas 提取需求
  → Andy 出方案
  → Lisa 实现
  → 交付可用产品
  → 四类语料生成
```

### 路由学习闭环需求

「路由即学习」的数据基础——没有这一层，本地专精程度无法量化，增量微调无从触发。

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| 路由事件日志 | `after_model_resolve` 钩子：每次路由记录任务类型/置信度/目标模型 | P0 | `data/learning/route-events.jsonl` 持续增长 |
| 质量评估器 | 云端响应自动评分（响应完整性/上下文相关性/家庭风格符合度）| P0 | 质量分 > 0.75 → 纳入微调候选队列 |
| 微调样本筛选 | 候选队列格式化为 MLX 训练对，去重（相似度 > 0.9 只保留一条）| P0 | 样本格式符合 MLX 训练要求 |
| 路由比例追踪 | 每日聚合 cloud_route_ratio / avg_confidence，写入指标文件 | P1 | 指标可查，趋势可见 |

### 增量微调需求

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| MLX 增量微调调度 | 样本数 ≥ 50 且距上次微调 ≥ 7 天时触发 | P0 | 微调后模型可加载，测试集通过率提升 |
| 微调前备份 | 执行前备份当前 adapter，确保可回滚 | P0 | 回滚机制可用 |
| 微调后验证 | 固定测试集验证，平均质量分下降 > 5% 自动回滚 | P0 | 测试集通过率不低于微调前 |
| 微调完成通知 | 企业微信推送：新增样本数、云端路由比例变化 | P1 | 通知内容准确 |

### 语料上传流水线需求

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| 去标识化处理 | 上传前自动替换家庭成员姓名等隐私信息 | P0 | 上传语料中无可识别个人信息 |
| 每日定时上传 | 定时任务打包三条语料管道上传云端 | P0 | 上传成功（或模拟器接收成功）|
| 上传状态记录 | 记录每次上传数量、时间、状态 | P1 | 状态可查，失败可重试 |

### 基础版验收标准

- [ ] Lucas embedded agent 通过 Gateway 正常响应
- [ ] Andy/Lisa embedded agent 在 Gateway 内正常响应（Gateway 日志无报错，`/v1/chat/completions` 调用 andy/lisa 可得回复）
- [ ] Lucas → Andy → Lisa 流水线通信正常
- [ ] 语料文件持续生成（lucas/andy/lisa 三条管道各自归属）
- [ ] 路由事件日志 `route-events.jsonl` 持续写入
- [ ] MLX 增量微调至少执行一次，测试集验证通过
- [ ] 语料上传（或模拟器接收）验证通过
- [ ] 企业微信入口正常
- [ ] 至少一个家庭需求完整交付，ChromaDB 跨 Session 记忆有效

---

## 四、高级版需求

**目的**：用复杂场景验证 Andy→Lisa 自开发能力的边界；用模拟器验证云端接口协议；确保云端真实接入时本地零改动。

> 前置条件：基础版验收通过——本地系统完备，学习闭环运转，语料上传管道可用。

### 物理接入需求（复杂功能自开发验证）

物理接入是**系统自开发能力的压力测试**：把「无人机控制」这个复杂需求投入 Lucas→Andy→Lisa 流水线，验证系统能否自主交付非平凡功能。

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| 家庭空间管理 | 房间定义 + 航点管理，HTTP API，存储至本地 JSON | P0 | 可创建房间、添加航点、查询 |
| 无人机基础控制（Tello EDU）| 起飞/降落/移动/旋转/紧急停止，安全限制（电量/高度/范围）| P0 | 企业微信「起飞」→ 无人机起飞 |
| 自然语言指令解析 | 「去客厅」→ 导航到航点；「紧急停止」→ 立即执行 | P0 | Lucas 意图路由正确识别无人机指令 |
| 传感器数据读取 | 至少 1 种传感器（Tello 状态：电量/高度/温度）实时可读 | P0 | 状态 API 正常返回 |

**验收重点**：不是无人机飞起来本身，而是整个流水线——Lucas 提取「想要无人机控制」需求 → Andy 出设计方案 → Lisa 实现代码 → 交付可用功能，全程 Andy/Lisa 自主完成，系统工程师只做验收。

### 云端接口验证需求

本地系统架构上已完备，云端（三位大师 + 蒸馏）是接入点。**模拟器**（`scripts/cloud-simulator.js`，端口 4000）替代真实云端，验证接口协议正确性，确保真实接入时本地无需任何修改。

| 需求 | 说明 | 优先级 | 验收标准 |
|------|------|--------|---------|
| 模拟器部署 | `cloud-simulator.js` 监听端口 4000，模拟云端接收语料、返回蒸馏模型 | P0 | 模拟器启动，接口可访问 |
| 语料上传验证 | 本地按协议上传三条语料管道 → 模拟器正确接收并响应 | P0 | 上传成功，格式无误 |
| 模型拉取验证 | 本地向模拟器请求蒸馏模型 → 模拟器返回 mock 模型包 → 本地正常加载 | P0 | 完整拉取流程跑通 |
| 接口协议文档 | 上传/拉取接口的请求格式、认证方式、错误码记录在案 | P0 | 第三方按文档即可对接 |

### 云端对接指南

真实云端就绪时，按此步骤替换模拟器，本地系统零改动：

| 步骤 | 内容 | 验收 |
|------|------|------|
| 1. 替换上传目标 | `.env` 中 `CLOUD_UPLOAD_URL` 从模拟器地址改为真实云端地址 | 语料正常上传到真实云端 |
| 2. 替换模型拉取地址 | `CLOUD_MODEL_URL` 改为真实蒸馏服务地址 | 本地可拉取真实蒸馏模型 |
| 3. 验证 | 运行一次完整的上传 + 拉取，对比模拟器阶段的日志 | 行为一致，无 diff |

### 高级版验收标准

- [ ] 物理接入：企业微信自然语言控制无人机，全流程经 Andy→Lisa 自主交付
- [ ] 云端接口：模拟器上传 + 拉取全流程跑通，接口协议文档完整
- [ ] 云端对接：替换为真实云端后系统行为无变化（如已有真实云端）

---

## 五、性能基准

| 指标 | 基础版目标 | 高级版目标 |
|------|----------|----------|
| Lucas 响应时间（本地） | ≤ 3s | ≤ 2s |
| Lucas 响应时间（云端） | ≤ 8s | ≤ 6s |
| 意图识别准确率 | ≥ 85% | ≥ 90% |
| Gateway 响应时间 | ≤ 500ms | ≤ 300ms |
| ChromaDB 检索时间 | ≤ 500ms | ≤ 300ms |
| 云端路由比例（目标趋势）| — | 持续下降（路由即学习 KPI）|


---


