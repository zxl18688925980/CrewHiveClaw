# 高级版开发指导书

---

## 概述

高级版目标：**在本地系统完备的基础上，验证两件事——系统能否自主交付复杂功能；云端接入时本地是否零改动。**

与基础版的本质区别：

| 维度 | 基础版 | 高级版 |
|------|-------|-------|
| 验证重点 | 本地系统完备（三角色协作、学习闭环、增量微调）| 复杂功能自开发能力 + 云端接口协议 |
| 云端关系 | 无（语料本地保留）| 模拟器验证接口，真实云端可随时切换 |
| 系统工程师角色 | 执行搭建，逐步验收 | 只做验收，Andy→Lisa 自主交付 |

**前置条件**：基础版验收通过——本地学习闭环运转，语料上传管道可用（含模拟器接收）。

---

## 一、物理接入（复杂功能自开发验证）

### 1.1 验证意图

物理接入不是「我们想要无人机功能」，而是**用无人机控制这个复杂需求，测试 Andy→Lisa 流水线的自开发能力边界**：

```
系统工程师说出需求（自然语言）
    ↓
Lucas 提取结构化需求
    ↓
Andy 出设计方案（空间模型 + 控制模块 + 安全机制 + 意图路由集成）
    ↓
Lisa 实现代码（通过 OpenCode SDK）
    ↓
系统工程师验收
```

全程 Andy/Lisa 自主完成，系统工程师只做验收。这是「家庭 AI 研发团队」核心价值的压力测试。

### 1.2 触发方式

将以下需求通过企业微信发给 Lucas：

```
家里买了一台 DJI Tello EDU 无人机，希望能用企业微信控制它。
基本需求：起飞、降落、前后左右移动、紧急停止。
进阶：定义家里各个房间的位置，说「去客厅」就能导航过去。
安全：电量低时不能起飞，不能飞出房间边界。
```

Lucas 确认需求 → 触发 Andy→Lisa 流水线。

### 1.3 期望产出（Andy 设计，Lisa 实现）

#### 家庭空间管理（`crewclaw/daemons/shared/space-manager.js`）

- 房间管理：创建房间（名称/坐标/尺寸），存储至 `data/rooms/`
- 航点管理：每个房间可添加命名航点（坐标 + 描述）
- HTTP API 集成到 Gateway：
  ```
  POST /api/space/room          → 创建房间
  GET  /api/space/rooms         → 查询所有房间
  POST /api/space/room/:id/waypoint → 添加航点
  GET  /api/space/room/:id/waypoints → 查询航点
  ```

#### 无人机控制（`crewclaw/daemons/shared/drone-controller.js`）

硬件：DJI Tello EDU（WiFi UDP，控制端口 8889，状态端口 8890）

- 基础控制：`connect / takeoff / land / move(direction, distance) / rotate / emergency / getStatus`
- 航点导航：`navigateTo(waypointName) / patrol(waypointList)`
- 安全机制（必须实现，优先级最高）：
  - 起飞前检查：电量 ≥ 20%
  - 高度上限：2.5 米
  - 水平范围：不超过房间边界
  - 紧急停止：企业微信收到「紧急停止」立即执行
- HTTP API：
  ```
  POST /api/drone/takeoff
  POST /api/drone/land
  POST /api/drone/move      Body: { direction, distance }
  GET  /api/drone/status
  POST /api/drone/navigate  Body: { waypoint }
  POST /api/drone/emergency
  ```

#### 自然语言指令解析（Lucas 意图路由新增 `physical_control` 类型）

```
「起飞」          → takeoff
「降落」          → land
「去客厅」        → navigate to 客厅中央航点
「向前飞 50 厘米」 → move("forward", 50)
「紧急停止」       → emergency（最高优先级）
```

### 1.4 验收标准

```bash
# 1. 空间管理
curl -X POST localhost:18789/api/space/room \
  -H "Content-Type: application/json" \
  -d '{"name":"客厅","position":{"x":0,"y":0,"z":0},"size":{"w":5,"h":3,"d":4}}'
curl localhost:18789/api/space/rooms

# 2. 无人机状态（无人机需开机并连接 WiFi）
curl localhost:18789/api/drone/status
# 期望：返回电量、温度等状态

# 3. 企业微信自然语言控制
# 发送「无人机起飞」→ 期望：无人机起飞，企业微信收到确认消息
# 发送「紧急停止」  → 期望：立即停止，无论当前状态

# 4. 安全机制
# 模拟电量 < 20%（修改 mock 返回）→ 发送「起飞」→ 期望：拒绝并告知原因
```

验收重点：**流水线全程自主**——查看 Andy 产出的方案文档、Lisa 产出的代码，确认没有系统工程师直接干预。

---

## 二、云端接口验证（模拟器）

### 2.1 设计原则

本地系统架构上已完备。云端（三位大师 + 蒸馏）是**接入点**，不是本地的前置依赖。

模拟器（`scripts/cloud-simulator.js`，端口 4000）替代真实云端，验证接口协议正确性。验证通过后，真实云端接入只需修改 `.env` 中的两个 URL，本地代码零改动。

### 2.2 模拟器启动

```bash
# 启动模拟器
node ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/cloud-simulator.js

# 期望输出
# [cloud-simulator] Listening on :4000
# [cloud-simulator] Routes:
#   POST /corpus/lucas    → 接收 Lucas 语料
#   POST /corpus/andy     → 接收 Andy 语料
#   POST /corpus/lisa     → 接收 Lisa 语料
#   GET  /model/distilled → 返回 mock 蒸馏模型包
#   GET  /health          → 状态检查
```

### 2.3 语料上传验证

在 `.env` 中配置模拟器地址：

```bash
CLOUD_UPLOAD_URL_LUCAS=http://localhost:4000/corpus/lucas
CLOUD_UPLOAD_URL_ANDY=http://localhost:4000/corpus/andy
CLOUD_UPLOAD_URL_LISA=http://localhost:4000/corpus/lisa
```

触发一次上传并验证：

```bash
# 手动触发上传
node ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/corpus-uploader.js --dry-run   # 先预览
node ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/corpus-uploader.js             # 正式上传

# 检查模拟器是否收到
curl http://localhost:4000/corpus/lucas/summary
# 期望：{ received: N, last_upload: "..." }

# 检查上传日志
tail -3 ~/HomeAI/Data/corpus/upload-history.jsonl
# 期望：status: "success"，lines_uploaded > 0
```

### 2.4 模型拉取验证

```bash
# 向模拟器请求蒸馏模型
curl http://localhost:4000/model/distilled -o /tmp/distilled-mock.tar.gz

# 验证格式
tar -tzf /tmp/distilled-mock.tar.gz
# 期望：包含 modelfile + adapter（mock 内容，格式正确即可）
```

### 2.5 接口协议记录

验证通过后，将协议固化到文档（供真实云端实现时参考）：

| 接口 | 方法 | 请求格式 | 响应格式 | 认证 |
|------|------|---------|---------|------|
| 上传语料 | POST `/corpus/{role}` | `Content-Type: application/jsonl`，body 为 jsonl 行 | `{ received: N, status: "ok" }` | Bearer Token（`.env` 中 `CLOUD_API_KEY`）|
| 拉取蒸馏模型 | GET `/model/distilled` | Query: `?since={last_pull_timestamp}` | `tar.gz` 包（modelfile + adapter）| 同上 |
| 健康检查 | GET `/health` | 无 | `{ status: "ok", version: "..." }` | 无 |

### 2.6 验收标准

- [ ] 模拟器正常启动，`/health` 返回正常
- [ ] 三条语料管道上传全部成功，`upload-history.jsonl` 有记录
- [ ] 模型拉取流程跑通，格式验证通过
- [ ] 接口协议文档完整（URL/格式/认证/错误码）

---

## 三、云端对接指南

真实云端就绪时，按此步骤替换模拟器，**本地代码零改动**。

### 3.1 切换步骤

```bash
# 1. 修改 .env，将模拟器地址替换为真实云端地址
CLOUD_UPLOAD_URL_LUCAS=https://cloud.homeai.example.com/corpus/lucas
CLOUD_UPLOAD_URL_ANDY=https://cloud.homeai.example.com/corpus/andy
CLOUD_UPLOAD_URL_LISA=https://cloud.homeai.example.com/corpus/lisa
CLOUD_MODEL_URL=https://cloud.homeai.example.com/model/distilled
CLOUD_API_KEY=your-real-api-key

# 2. 触发一次上传验证
node ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/corpus-uploader.js

# 3. 验证行为与模拟器阶段一致
diff <(cat data/corpus/upload-history.jsonl | tail -1) \
     <(cat data/corpus/upload-history-simulator-baseline.jsonl | tail -1)
# 期望：除 url 字段外，其余字段一致
```

### 3.2 蒸馏模型接入

真实云端提供蒸馏模型后，本地微调调度器自动拉取：

```bash
# 手动触发一次完整的拉取 + 验证
node scripts/finetune-scheduler.js --pull-only

# 检查新模型是否加载正常
ollama list | grep homeai-assistant
```

### 3.3 验收标准

- [ ] 真实云端上传成功，云端侧确认收到数据
- [ ] 蒸馏模型拉取成功，本地 homeai-assistant 更新为新版本
- [ ] 运行固定测试集，新模型质量不低于模拟器阶段基线
- [ ] 云端路由比例趋势继续下降（本地专精持续提升）

---

## 四、验收总结

| 模块 | 关键验收点 | 状态 |
|------|-----------|------|
| 物理接入 | 企业微信自然语言控制无人机；全流程经 Andy→Lisa 自主交付 | — |
| 云端接口 | 模拟器三条管道上传 + 模型拉取全通；协议文档完整 | — |
| 云端对接 | 替换真实云端后行为无变化（如已有真实云端）| — |

**高级版完成标志**：本地系统完备（基础版），复杂功能自开发能力验证（物理接入），云端接口协议冻结（模拟器验证）。云端真实接入是随时可执行的运维操作，不是开发任务。
