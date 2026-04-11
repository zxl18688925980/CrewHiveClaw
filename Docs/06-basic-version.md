# 基础版验证指导书

---

## 概述

基础版目标：**三角色协同运行，能从家庭对话中提取需求，并交付第一个家庭工具。**

> **重要**：所有代码已存在（OpenClaw CLI + crewclaw-routing 插件 + wecom-entrance）。
> 本阶段任务是：**验证系统端到端跑通，完成第一次真实需求交付。**

核心验证：
1. Lucas 浸入 → Andy 设计 → Lisa 实现 → 交付 —— 全流程跑通
2. 家庭成员发出一个真实需求，系统自动交付可用工具
3. ChromaDB 对话记忆跨 session 有效
4. 路由事件日志有内容写入，语料采集运转

**前置条件**：Setup 阶段验收通过（Gateway 运行、wecom-entrance online、ChromaDB 运行中）

---

## 一、系统架构（当前实现）

```
家庭成员（企业微信）
        ↓
wecom-entrance（端口 3003，PM2 管理）
  ├─ 企业微信 Callback 解密验签
  ├─ isOwner 判断：业主 → Main 代理；其他成员 → Lucas
  └─ callGatewayAgent() → POST /v1/chat/completions + x-openclaw-agent-id header
        ↓
OpenClaw Gateway（端口 18789，launchd 管理）
  └─ crewclaw-routing 插件（~/HomeAI/CrewHiveClaw/CrewClaw/crewclaw-routing/）
       ├─ before_model_resolve：
       │   Layer 1 意图路由 → 对话 / 成员专属 Agent / 开发需求 / 工具 / 人工干预
       │   Layer 2 模型路由 → 本地置信度足够→ollama/homeai-assistant，不足→云端
       │     Lucas 云端：deepseek/deepseek-chat
       │     Andy 云端：deepseek/deepseek-reasoner（R1）
       │     Lisa 云端：minimax/MiniMax-M2.7
       ├─ after_model_resolve：写路由事件 data/learning/route-events.jsonl
       ├─ before_prompt_build：context-sources 多源注入
       │     Lucas：ChromaDB conversations（语义召回）+ Kuzu person（家人档案）→ appendSystemContext
       │     Andy： ChromaDB decisions（历史决策）+ Kuzu capabilities + ARCH.md + DESIGN-PRINCIPLES.md
       │     Lisa： ChromaDB code_history + Kuzu capabilities + CODEBASE.md
       └─ agent_end：ChromaDB 写回 + 语料采集
              ↓ 发现开发需求
        trigger_development_pipeline()
              ↓
        Andy /api/chat（通过 Gateway proxy）
              ↓
        Lisa /api/chat（通过 Gateway proxy）
              ↓
        代码输出到 ~/HomeAI/App/generated/
              ↓
        Lucas 回复用户：交付完成

系统工程师（Main）
  ├─ 本地：Claude Code / openclaw CLI（直连 Gateway，对所有 Agent 可见）
  └─ 远程：企业微信单聊 → Main（同一 Gateway，GLM-5.1 驱动）
```

### 关键路径说明

- **Lucas = OpenClaw embedded agent**：不是独立进程，由 Gateway 统一管理
- **Andy / Lisa = Gateway proxy 代理**：通过 crewclaw-routing 插件的 `triggerDevelopmentPipeline` 调用，走 Gateway `/api/chat` 代理路由
- **wecom-entrance 是唯一外部入口**：所有企业微信消息都经 wecom-entrance → Gateway → Lucas
- **PM2 管三个进程**：wecom-entrance（3003）+ cloudflared-tunnel（Cloudflare 隧道）+ gateway-watchdog（三重保活：Gateway LLM / ChromaDB / cloudflared tunnel，每 5 分钟一轮）

---

## 二、验证步骤

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

## 三、端到端验收测试

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

## 四、常见问题

遇到具体执行问题，优先查阅 **docs/08-claudecode-handbook.md**。

| 问题 | 快速排查 |
|------|---------|
| Lucas 无响应 | `tail -50 ~/.openclaw/logs/gateway.log` 查看错误 |
| 响应超时（>3min） | 检查 `~/.openclaw/start-gateway.sh` API Key；本地模型关掉节省资源 |
| Andy→Lisa 未触发 | 检查 crewclaw-routing 插件的意图识别日志；需求描述要更明确 |
| 代码未生成 | 检查 `app/generated/` 目录权限；查 Gateway 日志 Lisa 部分 |
| ChromaDB 连接失败 | `ps aux \| grep chromadb`；手动启动：`nohup chromadb run --host 127.0.0.1 --port 8001 --path ~/HomeAI/chroma > ~/HomeAI/Logs/chromadb.log 2>&1 &` |
| 路由事件为空 | 检查 `data/learning/` 目录是否存在并有写权限 |
| 企业微信无回复 | `pm2 logs wecom-entrance --lines 30`；检查 Cloudflare Tunnel 状态 |

---

## 五、完成标志

基础版完成后：

1. Gateway 稳定运行（launchd 管理，开机自启）
2. wecom-entrance 稳定运行（PM2 管理，`pm2 save` 已保存）
3. 第一个家庭工具已通过完整 Lucas→Andy→Lisa 流程交付
4. ChromaDB 跨 session 记忆有效
5. Lucas 的回复体现家庭身份感
6. 路由事件日志和语料文件有内容写入

**下一步**：开始高级版（交互学习引擎 + 增量微调 + 语料上传）

```bash
cat docs/07-advanced-version.md
```

