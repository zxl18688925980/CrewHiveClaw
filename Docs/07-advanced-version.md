# HomeAI 云端实例实现与验证

> 本地验证优先，云端层架构预留。本文是 HiveClaw 云端侧在 HomeAI 实例中的实现设计——架构与本地 CrewClaw 同源，核心是三模型持续增训与 Readme 进化引擎。
>
> 框架层设计见 `00-project-overview.md`（Part 1~3 本地，Part 4 云端）。HomeAI 本地实例见 `06-basic-version.md`。

---

## 一、云端架构

```
┌──────────────────────────────────────────────────────────────────┐
│                   【云端】HiveClaw 进化系统                       │
│                                                                   │
│  语料接收层（各实例持续上传）                                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  实例1 / 实例2 / ... → 去标识化验证 → 按角色分类入库      │   │
│  │  业务语料库（Lucas）  架构语料库（Andy）  实现语料库（Lisa）│   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                    │
│  三模型增训层（各自独立，互不稀释）                                │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │   业务大师      │  │   架构大师      │  │   实现大师      │  │
│  │  业务语料增训   │  │  架构语料增训   │  │  实现语料增训   │  │
│  │  越来越懂业务   │  │  越来越懂设计   │  │  越来越懂代码   │  │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘  │
│           └───────────────────┬┘───────────────────┘             │
│                               ↓  触发：新实例部署                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  三合一蒸馏引擎                                           │   │
│  │  取三位大师当前版本 → 蒸馏 → 可在本地硬件运行的小模型     │   │
│  │  → 新实例 Setup 起点（越晚加入，起点越高）                │   │
│  └──────────────────────────────────────────────────────────┘   │
│                              ↓                                    │
│  Readme 进化引擎                                                   │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  跨实例最佳实践提炼 → 按组织类型定制 → 可复制部署文档     │   │
│  │  家庭版 / 企业版 / 医院版 / 学校版 ...                    │   │
│  └──────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

**核心设计原则**：

- **三模型独立增训，互不稀释**：业务语料只训业务大师，架构语料只训架构大师，实现语料只训实现大师。角色专精是 CrewClaw 架构的核心竞争力，云端增训必须保持这一特性。
- **蒸馏是部署动作，不是训练动作**：三位大师持续增训是常态；只有新实例部署时才触发蒸馏，将三位大师的当前能力压缩为可在本地硬件运行的小模型。
- **越晚加入，起点越高**：每个实例的语料都在喂养三位大师，新实例拿到的蒸馏模型天然包含所有前序实例的经验积累。这是 HiveClaw 分布式语料审核网络的飞轮效应。
- **本地代码零改动**：云端接入只需修改环境变量（URL + API Key），本地系统架构、插件代码、Agent 行为完全不变。

---

## 二、语料上传协议

### 2.1 接口定义

| 项目 | 说明 |
|------|------|
| 端点 | `POST /corpus/{role}`，其中 `{role}` 为 `lucas` / `andy` / `lisa` |
| 请求格式 | `Content-Type: application/jsonl`，body 为 JSONL 格式（每行一条 JSON 记录） |
| 认证方式 | `Authorization: Bearer {CLOUD_API_KEY}`，Token 由云端分配，存储在本地 `.env` |
| 响应格式 | `{ "received": N, "status": "ok", "timestamp": "..." }` |
| 错误码 | `401` 认证失败 / `413` 单次上传超限 / `422` JSONL 格式错误 / `500` 服务端异常 |

### 2.2 JSONL 记录格式

每行一条 JSON，字段定义：

```jsonl
{"role":"lucas","type":"conversation","content":"...","timestamp":"2026-04-17T10:00:00Z","instance_id":"homeai-001","anonymized":true}
{"role":"andy","type":"decision","content":"...","timestamp":"2026-04-17T10:05:00Z","instance_id":"homeai-001","anonymized":true}
{"role":"lisa","type":"code_history","content":"...","timestamp":"2026-04-17T10:10:00Z","instance_id":"homeai-001","anonymized":true}
```

关键字段说明：
- `role`：语料归属角色，与 URL 路径中的 `{role}` 一致
- `type`：语料类型（conversation / decision / code_history / agent_interaction / behavior_pattern）
- `anonymized`：去标识化标记，上传前本地必须完成脱敏处理（姓名→代号，地址→区域，电话→掩码）
- `instance_id`：实例标识，用于云端区分语料来源

### 2.3 本地语料文件

本地侧语料文件位于：

```
~/HomeAI/Data/corpus/lucas-corpus.jsonl   ← Lucas 业务对话语料
~/HomeAI/Data/corpus/andy-corpus.jsonl    ← Andy 架构决策语料
~/HomeAI/Data/corpus/lisa-corpus.jsonl    ← Lisa 实现代码语料
```

这些文件由本地 L4 蒸馏管道持续写入，是云端上传的数据源。上传脚本读取这些文件、执行去标识化处理后，按角色分别推送到对应的云端端点。

### 2.4 上传触发

```bash
# 手动触发上传（含去标识化 + 增量上传）
node ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/corpus-uploader.js

# 预览模式（不实际上传，只输出将要发送的数据量）
node ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/corpus-uploader.js --dry-run

# 检查上传历史
tail -3 ~/HomeAI/Data/corpus/upload-history.jsonl
```

上传脚本维护增量游标，每次只上传自上次以来的新增条目，避免重复传输。

---

## 三、蒸馏模型拉取

### 3.1 接口定义

| 项目 | 说明 |
|------|------|
| 端点 | `GET /model/distilled` |
| 查询参数 | `?since={last_pull_timestamp}`（ISO 8601 格式，返回该时间点之后的新版本） |
| 认证方式 | `Authorization: Bearer {CLOUD_API_KEY}`，与语料上传共用同一 Token |
| 响应格式 | `application/gzip`，tar.gz 压缩包 |
| 错误码 | `304` 无新版本 / `401` 认证失败 / `404` 尚无可用蒸馏模型 / `500` 服务端异常 |

### 3.2 压缩包结构

```
distilled-{version}.tar.gz
├── modelfile          ← Ollama Modelfile（FROM + PARAMETER + SYSTEM 定义）
├── adapter/           ← LoRA adapter 权重
│   └── adapters.safetensors
├── metadata.json      ← 版本号、源大师版本、蒸馏时间、兼容基础模型
└── checksum.sha256    ← 完整性校验
```

`metadata.json` 示例：

```json
{
  "version": "v3",
  "base_model": "Qwen2.5-Coder-32B-4bit",
  "master_versions": {
    "lucas": "v12",
    "andy": "v8",
    "lisa": "v15"
  },
  "distilled_at": "2026-04-17T00:00:00Z",
  "min_ram_gb": 24
}
```

### 3.3 本地应用流程

拉取蒸馏模型后，本地通过 `run-finetune.sh` 完成完整的模型更新管道：

```
拉取 tar.gz → 解压 adapter → LoRA merge → fuse → GGUF 量化 → ollama create
```

具体步骤：

```bash
# 1. 拉取蒸馏模型包
curl -H "Authorization: Bearer $CLOUD_API_KEY" \
  "$CLOUD_MODEL_URL?since=$LAST_PULL" \
  -o /tmp/distilled-latest.tar.gz

# 2. 校验完整性
tar -xzf /tmp/distilled-latest.tar.gz -C /tmp/distilled/
cd /tmp/distilled && sha256sum -c checksum.sha256

# 3. 将 adapter 放到标准位置
cp /tmp/distilled/adapter/adapters.safetensors \
   ~/HomeAI/Models/adapters/setup/adapters.safetensors

# 4. 执行完整管道（LoRA→fuse→GGUF→ollama create）
bash ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/run-finetune.sh

# 5. 验证新模型已加载
ollama list | grep homeai-assistant
```

本地微调调度器（`run-finetune.sh`）已支持完整的 LoRA merge → fuse → GGUF 量化 → ollama create 管道，云端蒸馏模型与本地微调产物共用同一条路径，无需额外适配。

---

## 四、云端对接切换

### 4.1 切换原则

**本地代码零改动**。从纯本地模式切换到云端连接模式，只需修改环境变量。本地的插件代码、Agent 行为、蒸馏管道、微调管道完全不变。

### 4.2 环境变量配置

在 `.env` 中添加或修改以下变量：

```bash
# 语料上传地址（按角色分别配置）
CLOUD_UPLOAD_URL_LUCAS=https://cloud.hiveclaw.com/corpus/lucas
CLOUD_UPLOAD_URL_ANDY=https://cloud.hiveclaw.com/corpus/andy
CLOUD_UPLOAD_URL_LISA=https://cloud.hiveclaw.com/corpus/lisa

# 蒸馏模型拉取地址
CLOUD_MODEL_URL=https://cloud.hiveclaw.com/model/distilled

# 认证密钥（云端分配）
CLOUD_API_KEY=your-cloud-api-key
```

未配置这些变量时，系统运行在纯本地模式，语料只写入本地文件，微调只用本地积累的样本。配置后，系统自动开启云端同步。

### 4.3 切换步骤

```bash
# 步骤 1：配置环境变量
# 编辑 .env，填入上述变量

# 步骤 2：触发一次上传验证
node ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/corpus-uploader.js --dry-run
# 确认：输出显示正确的云端地址和待上传条数

# 步骤 3：正式上传
node ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/corpus-uploader.js
# 确认：upload-history.jsonl 记录 status: "success"

# 步骤 4：验证行为与本地基线一致
# 上传完成后，本地 Agent 行为不应有任何变化
# 触发一次正常的家庭对话，确认 Lucas 响应质量、Andy 设计质量、Lisa 实现质量无退化

# 步骤 5：拉取蒸馏模型（云端有可用版本时）
curl -H "Authorization: Bearer $CLOUD_API_KEY" \
  "$CLOUD_MODEL_URL" -o /tmp/distilled-latest.tar.gz
# 按第三节流程完成本地应用
```

### 4.4 回退

如需回退到纯本地模式，只需注释或删除 `.env` 中的 `CLOUD_*` 变量，重启相关服务即可。本地语料文件不受影响，已上传的数据在云端保留。

---

## 五、Readme 进化引擎

### 5.1 设计定位

Readme 进化引擎是 HiveClaw 云端系统的第二核心产物（第一是蒸馏模型）。它从跨实例语料中提炼最佳实践，生成按组织类型定制的部署文档，使新实例的部署成本持续下降。

### 5.2 运作机制

```
各实例持续上传语料
        ↓
云端语料分析层
  - 提取跨实例共性模式（多个实例独立发现的相同解决方案）
  - 识别组织类型特征（家庭 vs 企业 vs 医院 vs 学校）
  - 标记已验证的最佳实践（多实例验证通过的配置/流程/规则）
        ↓
模式聚合与分类
  - 通用模式：所有组织类型共享（如 Agent 协作回路、记忆机制、蒸馏管道）
  - 领域模式：特定组织类型专有（如家庭版的家人档案注入、企业版的审批流程）
        ↓
Readme 生成器
  - 通用骨架 + 领域定制模块 = 完整部署文档
  - 输出按组织类型分版本：
    - 家庭版：HomeAI 模式，四角色（业务/架构/实现/系统工程师），家庭场景优化
    - 企业版：CrewHiveClaw 模式，四角色同构，企业场景适配（审批/合规/多部门）
    - 医院版：患者沟通/医嘱管理/排班协调
    - 学校版：教学辅助/学生管理/家校沟通
```

### 5.3 进化闭环

Readme 进化引擎与三模型增训形成双轮驱动：

- **模型增训**解决「Agent 能力」问题——每个角色越来越懂自己的领域
- **Readme 进化**解决「部署成本」问题——新实例的系统工程师拿到的文档越来越精准

两者共同支撑 HiveClaw 的规模化：实例越多 → 语料越丰富 → 模型越强 + 文档越准 → 新实例部署越快 → 实例更多。这是分布式语料审核网络的核心飞轮。

### 5.4 HomeAI 的角色

HomeAI 作为第一个实例，承担「模式发现者」的角色：

- HomeAI 踩过的坑（如 Kuzu SIGBUS、GLM-5.1 max_tokens 陷阱）→ 云端自动标记为已知约束，新实例部署文档直接包含规避方案
- HomeAI 验证通过的设计模式（如 per-message session、Co-Pilot 绕过不可靠工具调用）→ 云端提炼为通用最佳实践
- HomeAI 的家庭专有简化（如群聊全库召回、家人档案注入）→ 云端标记为「家庭版专有」，不会污染企业版文档

第二个实例（小姨肖山的 CrewHiveClaw 公司）将验证企业场景的差异化需求，两个实例的语料交叉验证将产生第一批跨组织类型的通用模式。

---

## 六、验收标准

### 6.1 语料上传就绪

- [ ] 三条语料管道（lucas / andy / lisa）上传全部成功
- [ ] `upload-history.jsonl` 有完整记录（时间戳、条数、状态）
- [ ] 去标识化处理生效（上传数据中无真实姓名、地址、电话）
- [ ] 增量上传正确（重复执行不产生重复数据）

### 6.2 蒸馏模型拉取就绪

- [ ] 模型包格式正确（tar.gz 包含 modelfile + adapter + metadata.json + checksum）
- [ ] 完整性校验通过（sha256sum 匹配）
- [ ] `run-finetune.sh` 管道跑通（LoRA → fuse → GGUF → ollama create）
- [ ] 新模型加载后 `ollama list` 可见，基础对话质量不低于更新前

### 6.3 云端对接就绪

- [ ] 修改 `.env` 后上传/拉取正常工作，本地代码无任何改动
- [ ] 回退到纯本地模式后系统正常运行
- [ ] 上传失败时本地系统不受影响（容错隔离）

### 6.4 Readme 进化引擎就绪

- [ ] 云端能按组织类型生成差异化部署文档
- [ ] HomeAI 的已知约束和最佳实践正确出现在家庭版文档中
- [ ] 通用模式与领域模式正确分离（家庭专有内容不出现在企业版）

### 6.5 整体就绪

- [ ] 接口协议文档完整（URL / 请求格式 / 响应格式 / 认证方式 / 错误码）
- [ ] 健康检查端点（`GET /health`）返回正常
- [ ] 端到端流程验证：本地语料写入 → 上传云端 → 云端增训 → 蒸馏 → 本地拉取 → 模型更新
