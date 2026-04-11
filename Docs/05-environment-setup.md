# 环境准备

---

## 概述

环境准备分三个阶段，逐步引入 AI 协作：

| 阶段 | 内容 | 谁主导 |
|------|------|-------|
| **第一阶段** | 最小手工操作（装好 Claude Code） | 人类独立完成 |
| **第二阶段** | Claude Code 协助：账号/API Key/基础软件 | 人 + Claude Code |
| **第三阶段** | Claude Code 主导：部署核心组件、验收 | Claude Code 主导，人验收 |

完成全部三阶段后，系统进入基础版验证。

---

## 第一阶段：手工操作（约 30 分钟）

### 1.1 申请 Claude Code 大模型 API

Claude Code 需要一个大模型 API。推荐方案：

- **方案 A（推荐）**：申请 Anthropic API Key（直接用 Claude）
  - 访问 console.anthropic.com，注册并创建 API Key
- **方案 B**：使用 GLM-5.1（国内替代，同一个 API 后续 Main 也用）
  - 访问 open.bigmodel.cn，注册 → 创建 API Key

### 1.2 安装 Homebrew

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
# 安装完成后按提示加入 PATH
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zshrc
source ~/.zshrc
```

### 1.3 安装 Node.js

```bash
brew install node
node --version   # 应输出 v22.x 或更高
```

### 1.4 安装 Claude Code

```bash
npm install -g @anthropic-ai/claude-code
```

配置大模型：

```bash
# 方案 A：Anthropic API
export ANTHROPIC_AUTH_TOKEN="你的Anthropic_API_Key"

# 方案 B：GLM-5.1
export ANTHROPIC_BASE_URL="https://open.bigmodel.cn/api/paas/v4"
export ANTHROPIC_AUTH_TOKEN="你的GLM-5.1_API_Key"

# 写入 shell 配置，避免每次重新设置
echo 'export ANTHROPIC_AUTH_TOKEN="..."' >> ~/.zshrc
source ~/.zshrc
```

### 1.5 获取 HomeAI 代码并启动 Claude Code

HomeAI 是系统的代码仓库，CrewClaw 执行层和所有运行代码都在这里。代码采用管控式开源，需要先联系项目所有者申请访问权限。

```bash
# 1. 联系项目所有者申请协作者权限
# 2. 权限获取后，克隆仓库
git clone https://github.com/zxl18688925980/HomeAI.git ~/HomeAI
cd ~/HomeAI
claude   # 启动 Claude Code，开始第二阶段
```

**第一阶段验收**：Claude Code 能正常启动并响应即完成。

---

## 第二阶段：Claude Code 协助完成账号与基础软件

在 Claude Code 中粘贴以下提示词执行：

```
请协助我完成 HomeAI 项目的基础环境配置。

【目标】
1. 指导我注册以下云端账号并获取 API Key：
   - DeepSeek（Lucas 云端模型 deepseek-chat + Andy 云端模型 deepseek-reasoner/R1）：DEEPSEEK_API_KEY
   - MiniMax（Lisa 云端模型 MiniMax-M2.7）：MINIMAX_API_KEY
   - ZAI/智谱（Main 云端模型 GLM-5.1）：ZAI_API_KEY / ZHIPU_API_KEY
   - Anthropic（Main 代理 Claude 驱动）：ANTHROPIC_API_KEY
   - 企业微信自建应用（消息入口）：
     WECOM_CORP_ID / WECOM_AGENT_ID / WECOM_SECRET / WECOM_TOKEN / WECOM_ENCODING_AES_KEY

2. 帮我填写 ~/HomeAI/.env 文件（参考项目根目录格式）
   额外需要申请的 Key：
   - 企业微信智能机器人（通道 B，群里 @启灵 用）：WECOM_BOT_ID / WECOM_BOT_SECRET
     → 企业微信管理后台 → 应用管理 → 智能机器人 → 新建机器人
   - Brave Search API（可选，Lucas 联网搜索）：BRAVE_API_KEY
     → search.brave.com/search/api 申请

3. 安装以下基础软件：
   - Python 3.11（运行蒸馏/知识图谱脚本）
   - Ollama（本地模型服务）
   注：ChromaDB 走本地 Python 包，不需要 Docker Desktop

【说明】
- 我是 Mac Mini，macOS
- 请逐步引导，每步完成后我会告诉你结果
- 遇到问题优先查 docs/08-claudecode-handbook.md

开始吧，先帮我检查当前环境状态。
```

**第二阶段验收**：

- [ ] 所有 API Key 已填入 `~/HomeAI/.env`
- [ ] 企业微信自建应用已创建（5项）+ 智能机器人已创建（BOT_ID/SECRET）
- [ ] Python 3.11 可用：`python3 --version`
- [ ] Ollama 安装完成：`ollama --version`

---

## 第三阶段：Claude Code 主导部署核心组件

> **重要**：代码已存在，第三阶段是**部署已有系统**，不是从零构建。

在 Claude Code 中粘贴以下提示词，Claude Code 将主导完成所有配置：

```
第二阶段已完成，请按顺序部署 HomeAI 核心组件。
代码已存在，不需要重新编写。每步完成告知我验收结果。

【步骤 1】安装 OpenClaw CLI（执行层）
npm install -g openclaw
验证：openclaw --version（应输出版本号）

【步骤 2】安装 crewclaw-routing 插件依赖
cd ~/HomeAI/CrewHiveClaw/CrewClaw/crewclaw-routing && npm install
验证：ls node_modules 应看到依赖包

【步骤 3】安装 wecom-entrance 依赖
cd ~/HomeAI/CrewHiveClaw/CrewClaw/daemons && npm install
验证：node -e "require('./entrances/wecom/index.js')" 不报模块缺失

【步骤 4】安装并启动 ChromaDB（本地，不用 Docker）
pip3 install chromadb
# 创建数据目录
mkdir -p ~/HomeAI/chroma

# 启动 ChromaDB（端口 8001，避免与其他服务冲突）
nohup chromadb run --host 127.0.0.1 --port 8001 --path ~/HomeAI/chroma > ~/HomeAI/Logs/chromadb.log 2>&1 &

# 或加入 PM2 管理（推荐）
# ecosystem.config.js 中已包含 chromadb 进程配置
验证：curl http://localhost:8001/api/v2/heartbeat（应返回 heartbeat JSON）

注：ChromaDB 端口统一用 8001（8000 留给其他可能的服务）

【步骤 5】安装 Python 依赖包
pip3 install kuzu chromadb openai

# TTS 语音功能（Lucas 语音回复）
pip3 install edge-tts

验证：
python3 -c "import kuzu; print('kuzu ok')"
python3 -c "import chromadb; print('chromadb ok')"
edge-tts --version

【步骤 5.5】安装 Playwright（Lisa E2E 测试）
# Playwright 用于 Lisa 的 T5 前端 E2E 测试
npm install -g @playwright/mcp@latest   # 含 Playwright 核心库
npx playwright install chromium         # OpenClaw browser 工具内部依赖 chromium

# 验证
npx playwright --version

# openclaw.json 中开启 browser 工具（步骤 6 配置时加入）：
# "browser": {
#   "enabled": true,
#   "headless": true       ← Mac Mini 无桌面显示时必须开启
# }
#
# T5 两条路径：
# 路径 A（主路）：OpenClaw 原生 browser 工具（navigate/click/fill/screenshot 内置工具）
#   Lisa 直接调用 browser 工具与 Web App 交互，无需额外配置
# 路径 B（降级）：Lisa 用 exec 运行 e2e-test.js（node e2e-test.js）
#   适合 browser 工具不可用或需要批量断言的场景

【步骤 5.6】启动 Ollama + 拉取本地基础模型
ollama serve &
ollama pull qwen2.5:7b
验证：curl http://localhost:11434/api/tags（应看到 qwen2.5:7b）

注：qwen2.5:7b 是初始基础模型，Setup 微调后会替换为 homeai-assistant。

【步骤 6】配置 ~/.openclaw/openclaw.json
请读取 ~/HomeAI/docs/03-configuration-management.md 第四节和
~/.openclaw/openclaw.json（当前配置作为参考模板），
为新实例配置：
- 三角色 agent 定义（lucas / andy / lisa），workspace 路径指向新机器的 ~
- 云端 model providers（deepseek / minimax / zai），apiKey 从 .env 读取
- 本地 ollama provider（baseUrl: http://localhost:11434）
- crewclaw-routing 插件路径（~/HomeAI/CrewHiveClaw/CrewClaw/crewclaw-routing）
- Gateway auth token（自行生成一个随机字符串）

【步骤 7】创建三角色 Workspace（身份配置）
mkdir -p ~/.openclaw/workspace-lucas/family
mkdir -p ~/.openclaw/workspace-andy
mkdir -p ~/.openclaw/workspace-lisa
mkdir -p ~/.openclaw/workspace

# 每个角色从模板复制完整 8 文件体系
for agent in lucas andy lisa; do
  cp ~/HomeAI/CrewHiveClaw/CrewClaw/daemons/workspace-templates/$agent/SOUL.md ~/.openclaw/workspace-$agent/
  cp ~/HomeAI/CrewHiveClaw/CrewClaw/daemons/workspace-templates/$agent/AGENTS.md ~/.openclaw/workspace-$agent/
  cp ~/HomeAI/CrewHiveClaw/CrewClaw/daemons/workspace-templates/$agent/IDENTITY.md ~/.openclaw/workspace-$agent/
  cp ~/HomeAI/CrewHiveClaw/CrewClaw/daemons/workspace-templates/$agent/MEMORY.md ~/.openclaw/workspace-$agent/
  cp ~/HomeAI/CrewHiveClaw/CrewClaw/daemons/workspace-templates/$agent/TOOLS.md ~/.openclaw/workspace-$agent/
  cp ~/HomeAI/CrewHiveClaw/CrewClaw/daemons/workspace-templates/$agent/USER.md ~/.openclaw/workspace-$agent/
  cp ~/HomeAI/CrewHiveClaw/CrewClaw/daemons/workspace-templates/$agent/HEARTBEAT.md ~/.openclaw/workspace-$agent/
done

# Andy 专属：DESIGN-PRINCIPLES.md + ARCH.md；Lisa 专属：CODEBASE.md
cp ~/HomeAI/CrewHiveClaw/CrewClaw/daemons/workspace-templates/andy/DESIGN-PRINCIPLES.md ~/.openclaw/workspace-andy/
# ARCH.md / CODEBASE.md 由系统工程师手工维护，首次部署需要创建：
touch ~/.openclaw/workspace-andy/ARCH.md ~/.openclaw/workspace-lisa/CODEBASE.md

# Lucas 关键文件需要定制（填入本家庭信息）
# SOUL.md：Lucas 的家庭身份、家庭成员信息、对话风格偏好、第一原则（陪伴优先）
# TOOLS.md：家庭成员 userId 清单、群 chatId

注：OpenClaw 的 BOOTSTRAP.md 是一次性引导文件，onboarding 完成后应删除。
人格配置写在 SOUL.md + AGENTS.md 中，不要写入 BOOTSTRAP.md。

【步骤 7.5】初始化 Skill 文件（Knowledge 层）

# Skills 格式要求：子目录格式，不是扁平 .md
# 正确格式：~/.openclaw/workspace-{agent}/skills/{skill-name}/SKILL.md
# SKILL.md 必须有 YAML frontmatter（name + description 字段）

mkdir -p ~/.openclaw/workspace-lucas/skills \
         ~/.openclaw/workspace-andy/skills \
         ~/.openclaw/workspace-lisa/skills

# 通用 Skill 已在框架层，crewclaw-routing 插件启动时自动复制到实例层
# 框架层位置：crewclaw/daemons/workspace-templates/{agent}/skills/{skill-name}/SKILL.md

# 创建家庭专属 Skill（每个 skill 一个子目录）
# 示例：
mkdir -p ~/.openclaw/workspace-lucas/skills/family-members
cat > ~/.openclaw/workspace-lucas/skills/family-members/SKILL.md << 'EOF'
---
name: family-members
description: 家庭成员信息：userId、称呼、说话风格、关注点。Lucas 回复时参考。
---
# 家庭成员

（填写每位成员的信息）
EOF

验证：
- ls ~/.openclaw/workspace-lucas/skills/（应看到子目录，不是 .md 文件）
- openclaw 日志中应出现 skills loaded 且数量 > 0

注：Skill 文件不入 Git（.gitignore 已配置 AGENTS.md 等，但 skills/ 目录建议也排除家庭专属内容）。

【步骤 7.6】初始化知识图谱数据库（Kuzu）

# 创建数据目录
mkdir -p ~/HomeAI/Data/kuzu ~/HomeAI/Data/family

cd ~/HomeAI

# 初始化家庭成员节点（person Entity + 基础事实）
# 需要先编辑 scripts/init-family-relations.py，填入本家庭成员信息
python3 scripts/init-family-relations.py     # 写入 person 节点 + family_structure 关系边

# 初始化能力节点（capability Entity + has_capability Fact）
python3 scripts/init-capabilities.py         # 从 TOOLS.md 提炼，写入 Kuzu capability 节点

# 首次渲染家人档案（inject.md）
python3 scripts/render-knowledge.py          # Kuzu person → family/{userId}.inject.md

验证：
python3 -c "
import kuzu
conn = kuzu.Connection('data/kuzu')
result = conn.execute('MATCH (e:Entity) RETURN count(e)')
print('Kuzu nodes:', result.get_next())
"
# 期望：节点数 > 0（家庭成员 person 节点 + capability 节点）
ls ~/.openclaw/workspace-lucas/family/  # 应看到 {userId}.inject.md 文件

【步骤 8】配置并启动 OpenClaw Gateway（launchd 服务）
# 复制 plist 到用户 LaunchAgents
cp ~/HomeAI/CrewHiveClaw/CrewClaw/config/ai.openclaw.gateway.plist \
   ~/Library/LaunchAgents/ai.openclaw.gateway.plist

# 创建并编辑 wrapper script
cp ~/.openclaw/start-gateway.sh.example ~/.openclaw/start-gateway.sh  # 如有模板
# 或参考当前机器的 start-gateway.sh 格式手动创建
# 填入本机所有 API Key 和 OPENCLAW_GATEWAY_TOKEN
chmod +x ~/.openclaw/start-gateway.sh

# 加载并启动
launchctl load ~/Library/LaunchAgents/ai.openclaw.gateway.plist
launchctl start ai.openclaw.gateway

验证：
- launchctl list | grep openclaw（应看到 ai.openclaw.gateway）
- cat ~/.openclaw/logs/gateway.log（应无错误，显示监听 18789）

【步骤 9】启动 PM2 进程（wecom-entrance + cloudflared）
cd ~/HomeAI/CrewHiveClaw/CrewClaw/daemons
pm2 start ecosystem.config.js
pm2 save
pm2 startup   # 配置开机自启
验证：pm2 status（应看到 wecom-entrance / cloudflared-tunnel / gateway-watchdog 均 online）

【步骤 10】配置 Cloudflare Tunnel（企业微信回调公网可达）
# 如果没有 Cloudflare 账号，先注册 cloudflare.com
brew install cloudflare/cloudflare/cloudflared
cloudflared tunnel login
cloudflared tunnel create homeai-wecom
cloudflared tunnel route dns homeai-wecom <你的子域名>
# ecosystem.config.js 已配置 "tunnel run homeai-wecom"，无需额外操作

在企业微信管理后台配置 Callback URL：
应用管理 → 自建应用 → 接收消息 → URL
填入：https://<你的子域名>/wecom/callback
Token / EncodingAESKey 与 .env 中一致

【步骤 11】首次对话验证
curl -X POST http://localhost:3003/api/wecom/forward \
  -H "Content-Type: application/json" \
  -d '{"message":"你好，你是谁？","userId":"setup-test"}'
验证：收到 Lucas 的回复，体现 SOUL.md 中配置的名字和风格

【步骤 12】生成验收报告
执行本文第四节完整验收检查，输出通过/失败状态。

【参考文档】
- docs/03-configuration-management.md（配置规范）
- docs/04-project-constitution.md（约束规则）
- docs/08-claudecode-handbook.md（常见问题）

遇到问题先查 docs/08-claudecode-handbook.md，无法解决再问我。
```

---

## 四、验收标准

Setup 阶段完成标志：以下所有检查项均通过。

### 基础软件

| 检查项 | 验证命令 | 期望结果 |
|--------|---------|---------|
| Node.js 版本 | `node --version` | v22.x+ |
| OpenClaw CLI | `openclaw --version` | 版本号输出 |
| Python 版本 | `python3 --version` | 3.11.x |
| ChromaDB | `curl http://localhost:8001/api/v2/heartbeat` | `{"nanosecond heartbeat":...}` |
| Kuzu | `python3 -c "import kuzu; print('ok')"` | `ok` |
| edge-tts | `python3 -c "import edge_tts; print('ok')"` | `ok` |
| Playwright | `npx playwright --version` | 版本号输出 |
| Playwright Chromium | `npx playwright install chromium --dry-run` | 已安装，无需重装 |
| Ollama 运行 | `curl http://localhost:11434/api/tags` | JSON 响应含 qwen2.5:7b |

### OpenClaw Gateway + 三角色

| 检查项 | 验证命令 | 期望结果 |
|--------|---------|---------|
| Gateway launchd | `launchctl list \| grep openclaw` | ai.openclaw.gateway 显示 |
| Gateway 日志 | `tail -20 ~/.openclaw/logs/gateway.log` | 无错误，监听 18789 |
| Lucas 身份配置 | `cat ~/.openclaw/workspace-lucas/SOUL.md` | 包含家庭成员信息和 Lucas 人格 |
| Lucas 可对话 | `curl -X POST http://localhost:3003/api/wecom/forward -H "Content-Type: application/json" -d '{"message":"你好","userId":"test"}'` | 有 Lucas 回复，体现身份感 |

### PM2 进程

| 检查项 | 验证命令 | 期望结果 |
|--------|---------|---------|
| PM2 状态 | `pm2 status` | wecom-entrance / cloudflared-tunnel / gateway-watchdog 均 online |
| wecom-entrance | `curl http://localhost:3003/api/health` | `{"status":"ok"}` |

### 企业微信入口

| 检查项 | 验证命令 | 期望结果 |
|--------|---------|---------|
| Callback 可达 | 企业微信后台验证 URL | 返回验证成功 |
| 消息转发 | 手机企业微信发消息 | Lucas 有回复 |

---

## 五、常见问题

遇到具体执行问题，优先查阅 **docs/08-claudecode-handbook.md**。

### 快速排查指引

| 问题现象 | 可能原因 | 排查方向 |
|---------|---------|---------|
| Gateway 无响应 | launchd 未加载 / env 未继承 | `launchctl list \| grep openclaw`；查 `~/.openclaw/logs/gateway.log` |
| Lucas 回复超时（>30s） | 云端 API Key 无效或本地模型太慢 | 检查 `~/.openclaw/start-gateway.sh` 中的 API Key |
| Lucas 回复乱码（`<\|im_start\|>`） | 本地模型 stop token 未配置 | 检查 crewclaw-routing 插件 stop token 设置 |
| wecom-entrance offline | .env 变量缺失或路径错误 | `pm2 logs wecom-entrance --lines 50` |
| 企业微信收不到消息 | Cloudflare Tunnel 未运行 | `pm2 logs cloudflared-tunnel --lines 20` |
| ChromaDB 连接失败 | 本地进程未启动 | `ps aux \| grep chromadb`；手动启动：`nohup chromadb run --host 127.0.0.1 --port 8001 --path ~/HomeAI/chroma > ~/HomeAI/Logs/chromadb.log 2>&1 &` |
| openclaw.json 报错 | JSON 格式错误 | `node -e "JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.openclaw/openclaw.json','utf8'))"` |
| 云端模型超时 | API Key 未配置或网络问题 | 直接 curl 测试对应 API |

---

## 六、Setup 完成后的操作方式

Setup 验收通过后，进入基础版验证阶段。

**验证系统就绪**：

```bash
pm2 status                                     # wecom-entrance online
launchctl list | grep openclaw                 # Gateway 运行中
curl http://localhost:8001/api/v2/heartbeat    # ChromaDB 响应
curl http://localhost:3003/api/health          # wecom-entrance 响应
```

**下一步**：

```bash
cat docs/06-basic-version.md
```

