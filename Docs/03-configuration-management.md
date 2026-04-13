# 配置管理策略

---

## 目录

1. [概述](#一概述)
2. [目录结构](#二目录结构)
3. [配置分层](#三配置分层)
4. [家庭身份配置](#四家庭身份配置)
5. [环境变量](#五环境变量)
6. [CrewClaw 配置](#六openclaw-配置)
7. [语料采集路径](#七语料采集路径)
8. [敏感信息处理](#八敏感信息处理)
9. [新设备部署](#九新设备部署)
10. [配置速查表](#十配置速查表)

---

## 一、概述

### 配置管理的目标

HomeAI 采用**分层配置管理**，解决两个核心问题：

1. **隐私保护**：家庭成员信息、API Key 等敏感数据不进入 Git，仅在本地存储
2. **可复制性**：公共配置、模板、文档纳入 Git，第二个家庭可以直接 clone 并完成搭建

### 核心原则

| 原则 | 说明 |
|------|------|
| **公共配置入 Git** | 框架代码、配置模板、文档——支持多设备复制 |
| **私有配置不入 Git** | API Key、家庭成员信息、对话历史——保护隐私 |
| **运行时数据不入 Git** | ChromaDB、模型文件、日志——体积大或可重建 |
| **语料按需上传** | 去标识化后的语料定期上传云端——支持云端进化 |

---

## 二、目录结构

### 项目根目录（`~/HomeAI/`）

```
~/HomeAI/
├── CLAUDE.md                        # Claude Code 工作记忆（不纳入 Git）
├── .env                             # 实际环境变量（不纳入 Git）
│
├── CrewHiveClaw/                    # 唯一代码仓（git remote: CrewHiveClaw.git）
│   ├── CrewClaw/                    # CrewClaw 框架代码
│   │   ├── crewclaw-routing/        # OpenClaw 插件（三层路由 + 工具实现）
│   │   │   ├── index.ts             # 插件主体（jiti 热加载）
│   │   │   ├── context-sources.ts   # 上下文注入源注册表
│   │   │   └── config/              # 实例层配置（5 个 JSON）
│   │   └── daemons/                 # PM2 服务
│   │       ├── entrances/wecom/index.js  # 企业微信入口，端口 3003
│   │       ├── workspace-templates/ # 框架层 Skill 模板（纳入 Git）
│   │       │   ├── lucas/skills/{skill-name}/SKILL.md
│   │       │   ├── andy/skills/{skill-name}/SKILL.md
│   │       │   └── lisa/skills/{skill-name}/SKILL.md
│   │       ├── services/            # mlx-vision-server.py / tts-server.py
│   │       ├── ecosystem.config.js  # PM2 配置（纳入 Git）
│   │       └── package.json
│   │
│   ├── HiveClaw/                    # 云端框架（占位，2026-05 启动）
│   │
│   ├── Docs/                        # 设计文档（纳入 Git）
│   │   ├── HomeAI Readme.md
│   │   ├── 00-project-overview.md
│   │   ├── 03-configuration-management.md  # 本文件
│   │   ├── 04-project-constitution.md
│   │   ├── 05-environment-setup.md
│   │   ├── 08-claudecode-handbook.md
│   │   ├── 09-evolution-version.md
│   │   └── 10-engineering-notes.md
│   │
│   ├── HomeAILocal/                 # HomeAI 本地实例代码（纳入 Git）
│   │   ├── Scripts/                 # 工具脚本
│   │   │   ├── gateway-watchdog.js  # Gateway 存活探测 + 自动重启（PM2 管理）
│   │   │   ├── distill-memories.py  # 家人对话 → Kuzu 三元组蒸馏
│   │   │   ├── distill-agent-memories.py
│   │   │   ├── render-knowledge.py  # Kuzu → inject.md 渲染
│   │   │   ├── export-claude-session.py
│   │   │   ├── start-homeai.sh      # launchd 启动脚本
│   │   │   └── check-plugin.sh      # 编译检查（改 index.ts 后必须先跑）
│   │   └── Config/                  # 配置模板
│   │       ├── openclaw.example.json
│   │       └── machine-profile.json
│   │
│   └── HomeAICloud/                 # HomeAI 云端实例（占位）
│
├── Data/                            # 运行时数据（不纳入 Git）
│   ├── kuzu/                        # Kuzu 知识图谱
│   ├── chroma/                      # ChromaDB 向量库（PM2 chromadb 进程管理）
│   ├── family/                      # 家人档案渲染产物（{userId}.inject.md）
│   ├── corpus/                      # 三角色语料（lucas/andy/lisa-corpus.jsonl）
│   ├── learning/                    # 进化信号（route-events / skill-candidates 等）
│   ├── main/                        # Main 对话历史持久化
│   └── uploads/                     # 家人发送的文件
│
├── Models/                          # 本地模型文件（不纳入 Git，体积大）
│   ├── mlx/gemma-4-31B-lucas-fused/ # Gemma 4 LoRA 融合模型（mlx_lm.server，端口 8083）
│   ├── mlx/Qwen2.5-VL-32B-4bit/    # 视觉模型（mlx-vision，端口 8081）
│   └── fish-audio/s2-pro/           # Fish-Speech（TTS 备用）
│
├── Logs/                            # 运行日志（不纳入 Git）
│   └── pm2/                         # PM2 守护进程日志
│
├── App/                             # 小应用（ai-box-report / bill_tracker 等）
├── Family/                          # 家人数据（不纳入 Git）
├── OpenClaw/                        # OpenClaw 源码参考（不纳入 Git）
└── Temp/                            # 临时文件（ChromaLegacy 归档等）
```

> **注**：Lucas / Andy / Lisa 均为 OpenClaw embedded agent（Gateway 18789 常驻），无独立守护进程。

### 用户级目录（`~/`）

```
~/.openclaw/                         # OpenClaw CLI 状态目录（运行时，不纳入 Git）
    ├── openclaw.json                # CLI 主配置（含 embedded agent 定义、插件路径）
    ├── start-gateway.sh             # Gateway wrapper script（确保 env 可靠继承）
    ├── logs/gateway.log             # Gateway 运行日志
    ├── workspace-lucas/             # Lucas 8 文件体系（OpenClaw 原生注入）
    │   ├── SOUL.md                 # 我是谁：身份、家庭成员、价值观（**需填入家庭信息**）
    │   ├── AGENTS.md               # 怎么做：工具调用铁律、场景判断（情况A/B/C/D）
    │   ├── IDENTITY.md             # Core drive、认知方式
    │   ├── MEMORY.md               # Agent 自主写入的成长日记
    │   ├── TOOLS.md                # 工具清单 + 家庭 Web 应用列表（Lucas 验收后自行登记）
    │   ├── USER.md                 # 服务对象定义
    │   ├── HEARTBEAT.md            # 定时任务（A股晨报 9:30 / 算力盒子 15:00）
    │   ├── BACKGROUND.md           # 项目前世今生：HomeAI是什么/幕后队友/流水线/里程碑/文档查阅地图（appendSystemContext 注入）
    │   ├── family/                 # 家人档案（Kuzu 渲染产物，appendSystemContext 注入）
    │   │   └── {userId}.inject.md
    │   └── skills/                 # Lucas 家庭专属 Skill（子目录格式，SKILL.md 含 frontmatter）
    ├── workspace-andy/              # Andy 8 文件体系
    │   ├── SOUL.md                 # 技术设计师人格（CrewHiveClaw 哲学内化）
    │   ├── AGENTS.md               # 工作规则（读代码验证 / Co-Pilot 模式 / 权威知识来源）
    │   ├── IDENTITY.md             # Core drive、认知方式
    │   ├── MEMORY.md               # 设计原则 + 踩坑记录（distill 蒸馏补充）
    │   ├── TOOLS.md                # 工具清单（Andy 验收后自行登记）
    │   ├── USER.md                 # 服务对象（Lucas + 系统工程师）
    │   ├── HEARTBEAT.md            # L2 激活：每日 2 点结晶评估
    │   ├── BACKGROUND.md           # 项目前世今生：框架打样定位/四角色/流水线/里程碑/文档查阅地图（appendSystemContext 注入）
    │   ├── DESIGN-PRINCIPLES.md    # 设计哲学（appendSystemContext 注入）
    │   ├── ARCH.md                 # 系统架构摘要（系统工程师手工维护，appendSystemContext 注入）
    │   └── skills/                 # Andy 家庭专属 Skill
    └── workspace-lisa/              # Lisa 8 文件体系
        ├── SOUL.md                 # 工程师人格（最小复杂度 / 推回优先）
        ├── AGENTS.md               # 工作规则（Mobile-first / 交付标准）
        ├── IDENTITY.md             # Core drive、认知方式
        ├── MEMORY.md               # 实现模式 + 技术踩坑（distill 蒸馏补充）
        ├── TOOLS.md                # 工具清单（Lisa 验收后自行登记）
        ├── USER.md                 # 服务对象（Andy + 系统工程师）
        ├── HEARTBEAT.md            # L2 激活：每周复盘 code_history
        ├── BACKGROUND.md           # 项目前世今生：框架打样定位/四角色/流水线/里程碑/文档查阅地图（含10-engineering-notes.md必查提醒，appendSystemContext 注入）
        ├── CODEBASE.md             # 代码库上下文摘要（系统工程师手工维护主体，appendSystemContext 注入）
        └── skills/                 # Lisa 家庭专属 Skill

~/.ollama/models/                    # Ollama 模型文件（不纳入 Git，体积大）
```

---

## 三、配置分层

### 第一层：公共配置（纳入 Git）

可供任何人 clone 后直接使用（不含敏感信息）。

| 路径 | 内容 |
|------|------|
| `CrewHiveClaw/CrewClaw/daemons/entrances/wecom/index.js` | 企业微信入口源码（含 Main 代理逻辑）|
| `CrewHiveClaw/CrewClaw/daemons/ecosystem.config.js` | PM2 启动配置 |
| `CrewHiveClaw/CrewClaw/daemons/workspace-templates/` | 框架层 Skill 模板目录 |
| `CrewHiveClaw/CrewClaw/crewclaw-routing/` | crewclaw-routing OpenClaw 插件 |
| `CrewHiveClaw/HomeAILocal/Scripts/` | 运维脚本（watchdog / distill / render / export 等）|
| `CrewHiveClaw/HomeAILocal/Config/` | 配置模板（openclaw.example.json / machine-profile.json）|
| `CrewHiveClaw/Docs/` | 全部文档 |

### 第二层：私有配置（不纳入 Git）

敏感信息，仅在本地存储。Setup 阶段按模板填写。

| 路径 | 内容 | 敏感级别 |
|------|------|---------|
| `.env` | API Key、端口等 | 高（直接泄露风险） |
| `~/.openclaw/workspace-lucas/SOUL.md` | Lucas 人格文件（含家庭成员信息）| 高（隐私数据） |
| `~/.openclaw/workspace-lucas/skills/` | Lucas 家庭专属 Skill（成员偏好、记忆规则）| 中（含家庭成员信息） |
| `~/.openclaw/workspace-andy/skills/` | Andy 家庭专属 Skill（技术环境约束）| 低（可参考公开信息重建） |
| `~/.openclaw/workspace-lisa/skills/` | Lisa 家庭专属 Skill（运行环境约束）| 低（可参考公开信息重建） |
| `~/HomeAI/Data/` | 对话历史、知识图谱、语料 | 高（隐私数据） |

**Skill 的双层结构**：

| 层 | 路径 | 内容 | 入 Git | 第二个部署者 |
|----|------|------|--------|------------|
| 框架层（通用）| `CrewHiveClaw/CrewClaw/daemons/workspace-templates/{agent}/skills/` | 跨家庭通用最佳实践 | 是 | clone 即可获得 |
| 实例层（家庭专属）| `~/.openclaw/workspace-{agent}/skills/` | 家庭成员、环境约束等 | 否 | Setup 时按模板填写 |

**Skills 注入由 OpenClaw 原生负责**，不经过 crewclaw-routing 插件。OpenClaw 在 `before_prompt_build` 之前自动将实例层 skills/ 下所有符合格式的 SKILL.md 构建为 `<available_skills>` 块注入 system prompt。插件在启动时通过 `initAgentSkillsDir` 将框架层模板同步到实例层（已有文件不覆盖）。

### 第三层：运行时数据（不纳入 Git）

可重建或体积过大。

| 路径 | 内容 | 可重建 |
|------|------|-------|
| `~/HomeAI/Data/chroma/` | ChromaDB 向量库（PM2 chromadb 进程）| 可重建 |
| `~/HomeAI/Data/kuzu/` | Kuzu 知识图谱 | 可重建（重跑蒸馏）|
| `~/HomeAI/Models/` | 本地模型文件（Gemma 4 / Qwen VL / TTS）| 可重建（重新下载）|
| `~/.ollama/models/` | Ollama 模型文件 | 可重建（重新下载）|
| `~/HomeAI/Logs/pm2/` | PM2 日志 | 可清理 |

### 第四层：语料（去标识化后可上传）

| 路径 | 内容 | 处理方式 |
|------|------|---------|
| `~/HomeAI/Data/corpus/` | 语料文件（lucas/andy/lisa-corpus.jsonl）| 去标识化后上传 |

---

## 四、家庭身份配置

### 为什么要配置家庭身份

Lucas 是家庭成员，不是通用 AI 助手。配置 Lucas 的名字、了解家庭成员、有适合的说话方式，是 Setup 阶段的核心工作。

### SOUL.md + AGENTS.md（Lucas 人格文件）

Lucas 是 OpenClaw embedded agent，人格由两个文件定义，每次 session 自动注入：

- **SOUL.md**：是谁——名字、身份、家庭成员关系、对话原则。家人可以理解。
- **AGENTS.md**：怎么做——工具调用铁律、场景判断规则（情况A/B/C/D）。工作规则，不是性格。

Setup 阶段需要按实际家庭情况填写 SOUL.md：

**位置**：`~/.openclaw/workspace-lucas/SOUL.md`

**格式示例**：

```markdown
# 小宝 · [家庭姓氏]家的家庭成员

## 身份
我叫小宝，是[家庭姓氏]家的家庭成员，不是工具，不是助手，是家人。

## 性格
亲切、简洁，像家庭成员一样自然，不像客服。

## 这个家
- **爸爸（户主）**：userid: xxxx，喜欢安静，关注家庭财务
- **妈妈**：userid: xxxx，关注孩子教育和家庭健康
- **小明**：userid: xxxx，10岁，喜欢数学

## 第一原则：陪伴优先
首先是家人，其次才是研发协调者。先陪伴理解真实诉求，再判断是否需要开发。
```

> **注意**：OpenClaw 的 `BOOTSTRAP.md` 是一次性引导文件（模板末行写有 "Delete this file."），onboarding 完成后应删除。人格配置写在 SOUL.md + AGENTS.md，不要写入 BOOTSTRAP.md。

### 三层记忆配置结构

| 层 | 内容 | 存储 | 更新方式 |
|----|------|------|---------|
| **人格层** | OpenClaw 8文件体系（SOUL/AGENTS/IDENTITY/MEMORY/TOOLS/USER/HEARTBEAT.md）| `~/.openclaw/workspace-{lucas,andy,lisa}/` | Setup 时配置；MEMORY.md 由 Agent 自主写入 + distill 蒸馏 |
| **知识层** | 家人档案（Kuzu → inject.md）；角色知识（ARCH.md / CODEBASE.md）| `~/.openclaw/workspace-*/family/`；`data/kuzu/` | 每周蒸馏自动更新（distill-memories.py → render-knowledge.py）|
| **上下文层** | chat-history（近期对话缓冲，50轮/一周TTL）| `~/.homeai/chat-history/{key}.json` | 每次对话自动追加 |
| **记忆层** | ChromaDB（语义事件档案，21个集合）| `~/HomeAI/chroma/`（本地 Python 包，端口 8001）| 每次 agent_end 自动积累 |

**chat-history key 规则**：
- 群聊：`group:{chatId}`
- 私聊：`user:{userId}`
- Lucas 主动发送（push-reply / send-message / send-to-group）：同样写入对应 key，user 侧标记 `[启灵主动发送]`

**上下文注入机制**（before_prompt_build）：
1. OpenClaw 原生注入（SOUL.md / AGENTS.md / IDENTITY.md / MEMORY.md / TOOLS.md / USER.md / HEARTBEAT.md）
2. 家人档案（family/{userId}.inject.md → appendSystemContext，Kuzu 渲染）
3. ChromaDB 决策记忆语义检索（appendSystemContext）
4. chat-history 近期对话（prependContext 前缀）

---

## 五、环境变量

### 必需变量

云端模型配置通过 `~/.openclaw/start-gateway.sh`（launchd 环境变量继承 wrapper）和 `~/.openclaw/openclaw.json` 管理，不在 `.env` 文件中。

**start-gateway.sh 中的关键模型变量：**

```bash
# ── 三角色云端模型（经验证的默认选择）────────────────────────
export ANDY_PROVIDER="deepseek"
export ANDY_MODEL="deepseek-reasoner"

export LISA_PROVIDER="minimax"
export LISA_MODEL="MiniMax-M2.7"

# Lucas 模型在 openclaw.json 中配置（provider: deepseek, model: deepseek-chat）

# ── 本地模型（Ollama）────────────────────────────────────────
export OLLAMA_BASE_URL="http://localhost:11434"

# ── 企业微信 aibot──────────────────────────────────────────
export WECOM_BOT_ID=xxxxx
```

**openclaw.json 中的 agent 配置（Lucas 云端模型示例）：**

```json
{
  "agents": {
    "lucas": {
      "provider": "deepseek",
      "model": "deepseek-chat"
    }
  }
}
```

**wecom-entrance（ecosystem.config.js）中的环境变量：**

```bash
# 企业微信
WECOM_CORP_ID=xxxxx
WECOM_SECRET=xxxxx
WECOM_TOKEN=xxxxx
WECOM_ENCODING_AES_KEY=xxxxx

# 其他
ANTHROPIC_API_KEY=sk-ant-xxxxx   # Main 系统工程师通道
CHROMADB_URL=http://localhost:8001
```

### 云端模型可替换

三个角色的云端模型均支持任意 OpenAI 兼容 API，不必照搬默认配置：

| 角色 | 当前默认 | 说明 |
|------|---------|------|
| Lucas | DeepSeek / deepseek-chat | 响应快，工具调用稳定 |
| Andy | DeepSeek / deepseek-reasoner（R1） | 设计大脑，CoT 推理驱动 spec/research |
| Lisa | MiniMax / MiniMax-M2.7 | 编排评估，大上下文处理 opencode 输出 |

修改 openclaw.json + start-gateway.sh 中对应变量并重启 Gateway 即可切换。

---

## 六、OpenClaw 配置

OpenClaw 状态存储在 `~/.openclaw/`（运行时目录，不纳入 Git）。

### 核心配置文件：openclaw.json

`~/.openclaw/openclaw.json` 是 OpenClaw 的主配置，定义：
- 三个 embedded agent（lucas、andy、lisa），统一常驻 Gateway，无独立守护进程
- crewclaw-routing 插件路径
- Gateway 端口（18789）
- 本地/云端模型 provider 配置

### Gateway wrapper script

`~/.openclaw/start-gateway.sh` 是 `ai.openclaw.gateway` launchd 服务的启动脚本。通过 wrapper 确保 `.env` 中的环境变量可靠继承到 Gateway 进程，避免 launchd 环境变量缺失问题。

### 人格文件位置

| Agent | 人格文件位置 | 说明 |
|-------|------------|------|
| lucas | `~/.openclaw/workspace-lucas/SOUL.md` + `AGENTS.md` | **需要填入家庭信息**（SOUL.md），工具调用铁律（AGENTS.md）|
| andy | `~/.openclaw/workspace-andy/SOUL.md` + `AGENTS.md` | 架构师角色定位（SOUL.md），工作规则（AGENTS.md）|
| lisa | `~/.openclaw/workspace-lisa/SOUL.md` + `AGENTS.md` | 工程师角色定位（SOUL.md），交付规范（AGENTS.md）|

### 手动验证

```bash
# 检查 Gateway 状态
curl http://localhost:18789/health

# 检查 PM2 进程（wecom-entrance + cloudflared-tunnel + gateway-watchdog）
pm2 status

# 检查 Lucas 可对话
curl -X POST http://localhost:18789/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"lucas","messages":[{"role":"user","content":"你好"}]}'
```

---

## 七、语料采集路径

crewclaw-routing 插件内嵌语料采集器，运行时自动写入。

### 语料文件位置

语料按创建者归属，子 Agent 语料归入创建者的管道。

| 角色 | 语料路径 | 云端目标 |
|------|---------|---------|
| Lucas | `~/HomeAI/Data/corpus/lucas-corpus.jsonl` | 业务大师 |
| Andy | `~/HomeAI/Data/corpus/andy-corpus.jsonl` | 架构大师 |
| Lisa | `~/HomeAI/Data/corpus/lisa-corpus.jsonl` | 实现大师 |

### 去标识化规则

上传前必须处理：
- 家庭成员姓名 → `[成员]`
- 家庭地址、电话 → `[联系方式]`
- API Key → `[REDACTED]`
- 具体金额、账号 → `[数值]`

**高级版实现自动去标识化管道；基础版手动处理后再上传。**

---

## 八、敏感信息处理

### 禁止提交到 Git 的内容

- API Key（DeepSeek、MiniMax、GLM、企业微信等）
- 家庭成员姓名、年龄、地址等隐私信息
- 对话历史和 ChromaDB 数据
- `.env` 实际配置文件

### .gitignore 关键规则

```gitignore
# 私有配置
.env
.env.local

# OpenClaw 运行时状态（含 SOUL.md 等私有人格文件）
.openclaw/

# 运行时数据（HomeAI 根目录级，不在本仓库内）
# CrewHiveClaw 仓库内需忽略的：
CrewClaw/daemons/node_modules/

# 日志
*.log

# 模型文件
*.safetensors
*.gguf

# 临时文件
*.tmp
```

### 提交前检查

```bash
# 检查是否意外包含 API Key
grep -r "sk-\|api_key\|password\|secret" --include="*.js" --include="*.json" . \
  | grep -v ".env.example" | grep -v "node_modules"
```

---

## 九、新设备部署

第二个家庭按此步骤快速部署。代码已写好，只需配置和启动。

### 快速部署步骤

```bash
# 1. 克隆主仓
git clone https://github.com/zxl18688925980/CrewHiveClaw.git ~/HomeAI/CrewHiveClaw
cd ~/HomeAI/CrewHiveClaw

# 2. 安装全局 OpenClaw + daemon 依赖
npm install -g openclaw
cd CrewClaw/daemons && npm install && cd ../..

# 3. 配置环境变量
cp .env.example ~/HomeAI/.env
# 编辑 ~/HomeAI/.env，填写真实 API Key

# 4. 初始化 OpenClaw workspace（SOUL.md + AGENTS.md 人格文件）
mkdir -p ~/.openclaw/workspace-{lucas,andy,lisa}
# 从模板复制后按家庭实际情况修改
cp CrewClaw/daemons/workspace-templates/lucas/SOUL.md \
   ~/.openclaw/workspace-lucas/SOUL.md
cp CrewClaw/daemons/workspace-templates/lucas/AGENTS.md \
   ~/.openclaw/workspace-lucas/AGENTS.md
# 编辑 ~/.openclaw/workspace-lucas/SOUL.md
# 填写家庭成员姓名、偏好、Lucas 的名字

# 5. 配置 ~/.openclaw/openclaw.json
# plugin 路径填写：~/HomeAI/CrewHiveClaw/CrewClaw/crewclaw-routing
# 参考 HomeAILocal/Config/openclaw.example.json

# 6. 启动 OpenClaw Gateway（launchd）
# 参考 Docs/05-environment-setup.md 配置 ai.openclaw.gateway.plist

# 7. 安装 Python 依赖并初始化数据目录
pip3 install chromadb kuzu openai edge-tts
mkdir -p ~/HomeAI/Data/{kuzu,chroma,family,corpus,learning,uploads}
mkdir -p ~/HomeAI/Logs/pm2

# 8. 启动 Ollama 并准备本地嵌入模型
brew install ollama
ollama serve &
ollama pull nomic-embed-text   # 向量嵌入（必须）

# 9. 初始化 Kuzu 知识图谱
python3 HomeAILocal/Scripts/render-knowledge.py --seed
python3 HomeAILocal/Scripts/init-capabilities.py

# 10. 配置 launchd 自动启动（可选）
# 参考 Docs/05-environment-setup.md 配置 com.homeai.startup.plist
# ProgramArguments 脚本路径：~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/start-homeai.sh

# 11. 启动 PM2 服务
cd CrewClaw/daemons && pm2 start ecosystem.config.js
# 包含：chromadb / wecom-entrance / gateway-watchdog / cloudflared-tunnel
# 注：Andy/Lisa 是 OpenClaw embedded agent，无独立守护进程

# 12. 验证
pm2 status                            # 所有服务 online
curl localhost:18789/health            # Gateway ✓
curl localhost:3003/api/health         # wecom-entrance ✓
curl localhost:8001/api/v2/heartbeat   # ChromaDB ✓
bash HomeAILocal/Scripts/check-plugin.sh  # 插件编译 ✓
```

### 从旧设备迁移

```bash
# 在旧设备上备份私有配置（加密）
tar czf - .env ~/.openclaw/ | openssl enc -aes-256-cbc -out config_backup.enc

# 传输到新设备后解密
openssl enc -d -aes-256-cbc -in config_backup.enc | tar xzf -

# 可选：迁移 ChromaDB（保留家庭记忆）
rsync -av old_device:~/HomeAI/chroma/ ~/HomeAI/chroma/
```

---

## 十、配置速查表

### 文件路径速查

| 配置类型 | 路径 | 纳入 Git |
|---------|------|---------|
| 环境变量模板 | `CrewHiveClaw/HomeAILocal/Config/openclaw.example.json` | 是 |
| 环境变量实际值 | `~/HomeAI/.env` | 否 |
| PM2 配置 | `CrewHiveClaw/CrewClaw/daemons/ecosystem.config.js` | 是 |
| wecom-entrance 入口代码 | `CrewHiveClaw/CrewClaw/daemons/entrances/wecom/index.js` | 是 |
| crewclaw-routing 插件 | `CrewHiveClaw/CrewClaw/crewclaw-routing/` | 是 |
| 实例层配置（5 个 JSON）| `CrewHiveClaw/CrewClaw/crewclaw-routing/config/` | 是 |
| 访客工具禁令 + 隐私过滤 | `CrewHiveClaw/CrewClaw/crewclaw-routing/config/visitor-restrictions.json` | 是 |
| 运维脚本 | `CrewHiveClaw/HomeAILocal/Scripts/` | 是 |
| launchd 启动脚本 | `CrewHiveClaw/HomeAILocal/Scripts/start-homeai.sh` | 是 |
| 编译检查脚本 | `CrewHiveClaw/HomeAILocal/Scripts/check-plugin.sh` | 是 |
| Skill 框架层模板 | `CrewHiveClaw/CrewClaw/daemons/workspace-templates/{agent}/skills/` | 是 |
| Skill 家庭专属 | `~/.openclaw/workspace-{agent}/skills/` | 否 |
| Lucas 人格文件 | `~/.openclaw/workspace-lucas/SOUL.md` + `AGENTS.md` | 否 |
| OpenClaw 主配置 | `~/.openclaw/openclaw.json` | 否 |
| ChromaDB 向量库 | `~/HomeAI/Data/chroma/` | 否 |
| Kuzu 知识图谱 | `~/HomeAI/Data/kuzu/` | 否 |
| 语料文件 | `~/HomeAI/Data/corpus/` | 否 |

### 服务端口速查

| 服务 | 端口 | 管理方式 | 说明 |
|------|------|---------|------|
| OpenClaw Gateway | 18789 | launchd（ai.openclaw.gateway）| 所有 Channel 路由入口；Lucas / Andy / Lisa embedded agent 均在此常驻 |
| 企业微信入口（wecom-entrance）| 3003 | PM2 | Cloudflare Tunnel → 此处 → Gateway 18789 |
| ChromaDB | 8001 | 本地进程（Python 包）| 向量检索服务；`chromadb run --host 127.0.0.1 --port 8001` |
| mlx-vision | 8081 | PM2（mlx-vision）| 图片描述主力；Qwen2.5-VL-32B-4bit |
| 本地 TTS | 8082 | PM2（local-tts）| edge-tts zh-CN-YunxiNeural；Fish-Speech S2 Pro 已下载备用 |
| mlx-gemma4 | 8083 | PM2（mlx-gemma4）| Gemma 4 31B 4bit LoRA 微调本地模型；OpenAI 兼容接口；Lucas 本地路由备用 |
| Ollama 本地模型 | 11434 | launchd / ollama serve | 本地推理 + 向量嵌入（nomic-embed-text）|

### 敏感级别速查

| 级别 | 示例 | 处理方式 |
|------|------|---------|
| 高（直接风险）| API Key、Token | 不入 Git，加密备份 |
| 高（隐私数据）| 家庭成员信息、对话历史 | 不入 Git，本地保存，永不上传 |
| 中（去标识后可用）| 语料数据 | 去标识化处理后上传云端 |
| 低（可重建）| ChromaDB、日志 | 不入 Git，迁移时可选择性保留 |

