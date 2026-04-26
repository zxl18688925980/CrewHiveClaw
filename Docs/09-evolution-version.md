# 系统工程师干预记录

> **文档定位**：这里同时承担两个角色：
> 1. **干预日志**——每次系统工程师发现自进化机制不足、成功矫正后，由 Claude Code 主动追加一条记录。
> 2. **架构决策全记录**——每次重要架构变更、里程碑实现（L0~L3 推进）、设计方向对齐，也记录在此。是理解「系统现在是什么样子、每个机制为什么存在」的核心补充读物。
>
> **第二个工程师使用方式**：先读最新的 10~20 条（最新在文件末尾），快速建立「系统已做了什么」的全景图，再用 `CLAUDE.md 当前状态区` 定位当前任务起点。
>
> **维护方式**：Claude Code 主动追加，不删不改。查找特定版本用 `grep "^## v"` 或按日期关键字搜索。
> **版本**: v689
> **最后更新**: 2026-04-17

---

## v737 · ChromaDB cosine 迁移 + now.md 全家覆盖 + Kuzu has_pattern 修复（2026-04-26）

**干预类型**：架构修复（距离函数 + 数据迁移）+ 配置修复 + 基础设施修复

### 1. ChromaDB 距离函数迁移：L2 → cosine（架构级修复）

**根因**：`conversations` / `conversations_closets` / `decisions` / `behavior_patterns` 四个集合在 `getChromaCollectionId` cosine 默认值上线前已存在，使用默认 L2 距离（Euclidean）。

**核心 bug**：`scanCrossMemberContext`（index.ts line 2666-2675）对 `conversations` 集合应用 threshold=0.4，该阈值按 cosine 设计（range 0~2），而 L2 距离对 nomic-embed-text 768-dim 非归一化向量返回 100~300 量级。**结果：跨成员上下文感知功能自部署以来从未触发过。**

**迁移方案**：
- 使用 HTTP API 直接 fetch（绕过 Python client numpy boolean 比较 bug：`if embeddings:` 对 numpy array 抛"truth value ambiguous"）
- Python chromadb client 只用于 delete/create/write
- 二分法容错：batch fetch 失败时递归折半，直到 size=1 跳过单条损坏记录（不中断迁移）

**迁移结果**：
| 集合 | 记录数 | 跳过 | 备注 |
|------|--------|------|------|
| conversations | 4330 | 1（HNSW 内部损坏，offset=4217） | `scanCrossMemberContext` 阈值 0.4 现在正常工作 |
| conversations_closets | 4337 | 0 | 主语义检索路径，排序质量改善 |
| decisions | 1113 | 0 | Andy 决策注入排序质量改善 |
| behavior_patterns | 639 | 0 | Lucas 行为模式召回排序质量改善 |
| code_history | 保留 L2 | — | 8 条，只做 timeWeightedRerank 无阈值，迁移无收益 |

**迁移脚本**：`HomeAILocal/Scripts/migrate-chroma-to-cosine.py`

**陷阱记录**（同步写入 `docs/10-engineering-notes.md`）：
1. `getOrCreateCollection` 不更新已有集合的 `hnsw:space`，只有创建时才生效
2. Python client `col.get(include=["embeddings"])` 内部 `if embeddings:` 对 numpy array 触发 "truth value ambiguous"
3. HNSW 内部损坏（"Error finding id"）：元数据存在但向量索引缺失，用二分法定位后跳过单条记录

### 2. members.json now.md 全家覆盖修复

**根因**：`profileMap` 缺少妈妈（`xiamoqiufengliang`，带秋字）和黟黟（`zengyueyutong`）两条映射。`updateNowFile(userId)` 查不到 key 直接 return，now.md 永远不会创建。

**修复**：`config/members.json` 补入两条映射，Gateway 重启后自动生效。

### 3. Kuzu has_pattern 写入三连修

- 重试逻辑（6次×5s，覆盖 Gateway 短暂锁竞争）
- stdout flush（修复 cron 非 TTY 模式 Python 全缓冲日志全丢）
- model 格式兼容（v725 后 `{primary, fallbacks}` 对象格式，修复 `'dict' has no attribute 'split'` 崩溃）

**变更文件**：
- `HomeAILocal/Scripts/migrate-chroma-to-cosine.py`（新建）
- `CrewClaw/crewclaw-routing/config/members.json`（两条映射补入）
- `Docs/10-engineering-notes.md`（ChromaDB 迁移陷阱三条）
- `~/HomeAI/CLAUDE.md` v737（不进 git）
- `HomeAILocal/Scripts/distill-agent-memories.py`（Kuzu 三连修，进 git 的部分）

### 越界干预记录

ChromaDB 距离函数迁移属于架构级修复（功能级 bug，scanCrossMemberContext 完全失效），系统工程师直接执行。迁移不可逆（旧集合已删除），数据完整性通过记录数验证。

---

## v687 · Lisa 直接编码能力——Claude Code 级别（2026-04-16）

**干预类型**：架构变更（L2 Lisa 能力升级）

**背景**：Lisa 原来是"编排者"——所有编码任务必须委托 `run_opencode`（外部 CLI 进程）。她没有直接读写代码、搜索、执行命令的能力。AGENTS.md 铁律写着"你没有 edit 工具。你没有 write 工具。"这导致简单修改也要走完整的 opencode 流程，效率低、token 消耗大。

**改造内容**：
1. **工具层**：接入 `@mariozechner/pi-coding-agent` 的 7 个编码工具（read/edit/write/bash/grep/find/ls），直接注册给 Lisa
2. **桥接层**：`wrapCodingTool` 桥接函数，含 agent 门控（只有 Lisa 可用）+ 写操作路径沙箱（$HOME 内）
3. **幻觉防护移除**：Lisa 现在有真实的 edit/write 工具，原有的 `lisaBypassedOpencode` 幻觉检测块已删除
4. **认知层**：重写 Lisa AGENTS.md + TOOLS.md，教她"直接编码优先，run_opencode 备用"的工作流
5. **触发消息更新**：Andy→Lisa 的指令从"必须用 run_opencode"改为"简单任务直接编码，复杂任务用 run_opencode"

**工具数变化**：39 → 46（Lisa 4专属 → 4+7 专属）

**框架层判断**：这是框架层机制。任何 OpenClaw 部署都可以给 implementor agent 注册编码工具。工具名用原始名（read/edit/write/bash/grep/find/ls），不与现有工具冲突（现有：read_file/write_file/list_files/patch_file）。

---

## v685 · Vibe vs Harness 设计哲学写入正朔（2026-04-15）

**干预类型**：设计哲学（L2 本质认知升级）

**背景**：系统工程师与 Lucas 讨论中提炼出 L2 的本质设计哲学。用户带着模糊的"vibe"来，系统交出结构化的"harness"。这不是工程细节，而是决定协作链入口和出口设计方向的核心理念。

**变更内容**：

1. **00-project-overview.md**：在"为什么稳定输出是核心"之后新增"Vibe vs Harness"节——阐明 harness 是系统标准，vibe 是用户真实状态，好的系统入口接 vibe 出口交 harness，Frontend Agent 接住 vibe，Designer+Implementor 交出 harness
2. **HomeAI Readme.md**：新增"入口接得住 Vibe，出口交得出 Harness"独立小节，作为对外设计愿景

**修改文件**：
- `Docs/00-project-overview.md`（新增设计哲学段）
- `Docs/HomeAI Readme.md`（新增愿景小节）
- `Docs/09-evolution-version.md`（本条记录）

---

## v657 · 00-project-overview 四项机制文档补全（2026-04-13）

**干预类型**：文档维护（P0/P1 实现细节补入设计文档）

**背景**：v645-v651 实现了 P0 图增强检索、P1 Entity Tags、因果双置信度提取、代码知识自动蒸馏四项机制，代码已全部落地，但 `00-project-overview.md` 中缺少对应的设计描述。第二个系统工程师无法仅凭代码理解这些机制的设计意图和选择原因。

**变更清单**：

1. **因果关系双置信度**（§2.2 蒸馏节）：从「必须出现线索词，不推断」更新为高置信（0.85，明确线索词）/ 中置信（0.7，上下文合理推断）双档，匹配实际 `distill-memories.py` 实现
2. **代码知识自动蒸馏**（§2.2 蒸馏节，新增段落）：描述 codebase_patterns 写入时机（opencode 完成后 + Lisa 编辑路径）、Andy 上下文注入（context-sources.ts 注册）、主动查询（search_codebase scope=history），以及框架层机制如何适配不同实现工具
3. **Entity Tags 元数据 + 实体加权重排**（§2.3 上下文工程，新增条目）：描述写入层（extractEntityHits → entityTags metadata）和检索层（timeWeightedRerankWithEntityBoost 1.5x boost），说明 post-filtering reranking 的设计选择及三原因
4. **P0 图增强检索机制**（§2.1 记忆四维，扩展）：从一行括号扩展为完整的 extractEntityHits → graphExpandEntities → Kuzu Entity→Topic→Fact 遍历 → appendSystemContext 注入路径描述，含访客隔离守卫

**写作视角**：所有补充内容从「第二个系统工程师重建项目」角度撰写——不仅描述做了什么，还说明为什么这样设计、设计选择的原因、框架层机制在第二个部署中如何复用。

**未修改文件**：HomeAI Readme.md（愿景层，不含实现细节）、08-handbook（协作技巧，不含架构机制）

---

## v655 · Readme 系列文档全面刷新（2026-04-13）

**干预类型**：文档维护（v650-v654 变更同步到 Readme 系列）

**背景**：系统经历 v650-v654 大量架构变更（Andy 三维主动性 + 系统思考者转型、Lucas PM 能力增强、上下文注入优化、代码图谱化），但 Readme 系列文档存在多处过时描述。

**变更清单**：

1. **00-project-overview.md**（12 处修复）：
   - Andy 角色定位从「技术设计师」→「系统思考者 + 技术设计师」，补充三维主动性和代码图谱能力
   - Lucas 角色补充 PM 能力维度（工期感知/阻塞信号/紧急排序/交付闭环）
   - Andy 工具表补齐 trigger_lisa_integration / request_implementation_revision / evict_sub_agent
   - Andy/Lisa capability 注册从「2 个工具」更新为实际数量（15/10）
   - 蒸馏频率描述从「每周/每 7 天」统一为「每日」
   - Coordinator 模式 Lisa 模型标注错误修正（DeepSeek Reasoner → MiniMax M2.7）
   - notify_engineer 重新定位：从「请求干预的通道」→「三角色通用透明通报工具」
   - Lucas 任务协调管理信号 A 改为动态阈值（estimatedHours × 1.5）
   - 技术栈总览表 Andy/Lucas 描述更新

2. **HomeAI Readme.md**（3 处更新）：
   - Andy 角色列定位更新 + 补充代码图谱查询、预估工期
   - Lucas 角色列补充 PM 能力描述
   - Andy 人格描述段补充三维主动性人话描述

3. **08-claudecode-handbook.md**：
   - 版本号 v432→v654，日期更新
   - Main 工具补 evaluate_local_model

---

## v654 · Lucas 项目管理能力增强 + 任务生命周期信号完善（2026-04-13）

**干预类型**：L1 行为质量增强（任务管理基础设施 + 行为绑定）

**背景**：Lucas 的主动性和项目管理能力存在六个结构性缺口：①无法给家人时间预期 ②任务阻塞时家人无感知 ③无历史工期数据供 Andy 学习 ④HEARTBEAT 空闲调度不检查超时任务 ⑤家人情绪不影响调度优先级 ⑥PM 能力分散。系统工程师明确 PM 分工：Andy = 技术 PM（预估/里程碑/风险），Lucas = 客户 PM（沟通/预期/优先级）。

**变更1：TaskRegistryEntry 新增四字段**
- `estimatedHours`：Andy spec 时基于系统资源（Token 消耗/模型负载/并发槽位）填写，不参照人类 PM 经验
- `actualHours`：completed 时自动计算实际耗时，供 Andy 后续校准预估
- `blockedAt` / `blockedReason`：Lisa report_implementation_issue 或 Andy request_implementation_revision 时写入阻塞信号

**变更2：Andy spec 格式 + 历史工期注入**
- Andy AGENTS.md / TOOLS.md spec JSON 新增 `estimatedHours` 字段，预估规则基于系统资源
- `runAndyPipeline` prompt 末尾注入最近 5 条历史任务的 estimatedHours vs actualHours 对照数据
- `trigger_lisa_implementation` 从 Andy spec JSON 提取 `estimatedHours` 写入 task-registry

**变更3：任务阻塞信号流转**
- `report_implementation_issue`（Lisa）：写入 `blockedAt` + `blockedReason`
- `request_implementation_revision`（Andy）：写入 `blockedAt` + `blockedReason`（含修订轮次）
- `markTaskStatus("completed")`：自动清除阻塞信号

**变更4：Lucas 注入块增强**
- `【当前进行中任务】`新增显示：预估工期、阻塞状态、阻塞原因、紧急标记
- 紧急任务排序靠前（匹配 lucasContext / requirement 中的急/urgent/今天要等关键词）
- 已完成任务在 `list_active_tasks` 显示预估 vs 实际耗时

**变更5：HEARTBEAT 任务 6 扩展**
- 新增 6a 超时任务巡检：running 超 3h → ask_lisa 确认进展；阻塞任务 → 告知提交者；预估工期已过 → 主动通报
- 原调度逻辑保留为 6b，仅在无 running 任务时执行；巡检不受 22:00 限制

**变更6：触发 7A 动态阈值**
- Lucas AGENTS.md 触发 7 信号 A 从固定 6h 改为动态阈值：超过 estimatedHours × 1.5 时主动查进展
- 信号 B：有 estimatedHours 时给家人精确时间预期

**设计决策**：
- estimatedHours 基于系统资源而非人类经验——模型耗时 × Token 消耗 × 系统负载
- Andy/Lucas PM 分工通过 task-registry 共享状态：Andy 写预估（技术 PM），Lucas 管沟通（客户 PM）
- 框架层机制通用，实例层配置可按组织定制

**代码变更文件**：index.ts + Lucas/Andy AGENTS.md + HEARTBEAT.md + Andy TOOLS.md + 00-project-overview.md

---

## v653 · Andy 三维主动性体系（2026-04-13）

**干预类型**：L2 架构增强（Andy 角色从「任务执行者」进化为「系统思考者」）

**背景**：Andy 的所有行为此前都是「被叫到才动」——没有 Andy 自己发现问题、自己决定行动的路径。系统工程师设计三维主动性架构，让 Andy 能从运行信号中自主提炼判断。

**变更1：事件感知维度 · 事件驱动观察（`index.ts` + `gateway-watchdog.js`）**

| 事件 | 触发点 | Andy 行动 |
|------|--------|----------|
| opencode 完成 | `proc.on("close")` IIFE | spec vs diff 对照反思（6h 冷却） |
| Lisa 报实现阻塞 | `report_implementation_issue` | 能力缺口反思（≥3 次触发，4h 冷却） |
| 代码图谱重建完成 | `runCodeGraphRebuild()` child.on('exit') | 架构漂移检测（每日 5am） |

实现模式：fire-and-forget `callGatewayAgent`，冷却机制用模块级变量。

**变更2：知识获取维度 · 主动知识获取（HEARTBEAT 检查 10/11/12 + wecom/index.js 预计算）**

| 检查 | 频率 | 预计算来源 |
|------|------|----------|
| 检查 10：spec 回溯 | 每周 | opencode-results.jsonl 最近 7 天统计 |
| 检查 11：技术雷达 | 每两周 | andy-self-search-state.json 冷却检查 |
| 检查 12：代码变化感知 | 每日 | build-code-graph.log 统计解析 |

每个检查的预计算数据在 `wecom/index.js` 的 `runAndyHeartbeatLoop` 中完成，Andy 直接读取，无需 exec。

**变更3：自主判断维度 · 自主提案（HEARTBEAT 检查 13/14 + wecom/index.js 预计算）**

| 检查 | 频率 | 预计算来源 |
|------|------|----------|
| 检查 13：架构改进提案 | 每月 | ChromaDB decisions 反思类信号数量（≥3 条触发） |
| 检查 14：技术债标记 | 每两周 | opencode-results.jsonl 高频修改文件统计（≥3 次） |

信号流转：事件感知维度 事件沉淀 decisions → 自主判断维度 检查 13 聚合信号 → 达阈值后提案。

**变更4：人格文件更新**

- `SOUL.md`：新增信念「主动性是设计师的核心竞争力」
- `AGENTS.md`：新增「Andy 三维主动性体系」节，含三维设计哲学、跨维信号流转图
- `HEARTBEAT.md`：新增检查 10-14（spec 回溯 / 技术雷达 / 代码变化 / 架构提案 / 技术债）

**设计决策**：
- 事件驱动优先于轮询：事件感知维度 用已有事件点（proc.on("close")、child.on("exit")）注入 Andy 通知，不引入新调度器
- 预计算模式复用：新检查 10-14 全部走 wecom/index.js 预计算注入，Andy 不依赖 exec
- 冷却机制防过频：spec 反思 6h、阻塞反思 4h、架构提案 30 天、技术债 14 天
- 弱信号不提案：检查 13 需要 ≥3 条同方向信号才触发，避免噪声提案

**代码变更文件**：
- `CrewClaw/crewclaw-routing/index.ts`（spec 反思 IIFE + 能力缺口反思 + 冷却变量）
- `HomeAILocal/Scripts/gateway-watchdog.js`（代码图谱 Andy 架构漂移检测）
- `CrewClaw/daemons/entrances/wecom/index.js`（预计算 7-11：spec 回溯 + 技术雷达 + 代码变化 + 架构提案信号 + 技术债信号）
- `~/.openclaw/workspace-andy/HEARTBEAT.md`（新增检查 10-14）
- `~/.openclaw/workspace-andy/AGENTS.md`（新增主动性体系节）
- `~/.openclaw/workspace-andy/SOUL.md`（新增主动性信念）

---

## v645 · Main 增强：定时任务执行健康监控 + 基础设施清理（2026-04-12）

**干预类型**：架构变更

**背景**：Main 监控只覆盖「进程活着 + Lucas 说话正常」，25 项自动化任务中 22 项是监控盲区。凌晨蒸馏管道静默失败无人发现；crontab 有 9 条死任务（04-08 重构后路径失效）；index.ts 中 8 处脚本路径指向已删除的 `~/HomeAI/scripts/`。

**变更**：

1. **Main Step 1.5：定时任务执行健康（框架层机制）**
   - watchdog 每个定时任务执行后写入 `task-execution-log.jsonl`（taskId / lx / status / timestamp）
   - Main HEARTBEAT 每日检查一次：对比 `scheduled-tasks.json`（实例层配置），发现超时/失败/跳过则告警
   - 告警分级：3+ 任务异常 → Layer 3 立即推；1-2 个 → Layer 2 日报
   - **框架 vs 实例**：`logTaskExecution()` + Main 检查逻辑 = 框架层；`scheduled-tasks.json` 内容 = 实例层

2. **基础设施清理**
   - crontab：12 条 → 3 条，删除 9 条路径失效的死任务
   - index.ts 路径断链修复：新增 `SCRIPTS_DIR` 常量，8 处 `join(PROJECT_ROOT, "scripts/...")` → `join(SCRIPTS_DIR, "...")`，修复 kuzu-query / distill-memories / render-knowledge / finetune-scheduler 等引用

3. **自动化任务 Lx 分级全景**（25 项，新增配置）
   - L0 基础设施层 6 项（进程保活/群消息中断/任务卡死/目录清理/访客沉寂/PM2守护）
   - L1 行为质量层 5 项（DPO 6模式检测/工具调用幻觉/用户纠正/行为规则注入/Lisa幻觉）
   - L2 系统自进化层 9 项（4条蒸馏管道/Andy HEARTBEAT/Lucas HEARTBEAT/Lisa复盘/结晶信号/质量评分/代码图谱）
   - L3 组织协作进化层 2 项（team_observation 蒸馏/协作关系蒸馏）
   - L4 深度学习层 3 项（DPO周级扫描/DPO候选积累/微调队列）

**代码变更文件**：`gateway-watchdog.js`（logTaskExecution + 所有 run* 包装）、`index.ts`（SCRIPTS_DIR + 8 处路径修复）、`scheduled-tasks.json`（新建）、`Main AGENTS.md`（Step 1.5）、crontab（清理）

**设计决策**：选择「基础设施层写日志 + Main 读日志」而非「Main 自己查每条任务」，原因是框架层机制不依赖 Agent 能力，第二个部署只需写自己的 `scheduled-tasks.json`。

---

## v644 · Andy 新增 restart_service 工具 + watchdog 小修复（2026-04-12）

**干预类型**：架构变更

**背景**：Andy 作为架构师需要能重启关键进程以应对系统故障，当前只能 notify_engineer 等人来修，无法自主掌控架构演进。

**变更**：
1. **`restart_service` 工具（Andy 专属）**：可重启 gateway / chromadb / wecom-entrance / watchdog 四个关键服务
   - gateway 重启前自动执行插件编译检查（check-plugin.sh），编译失败拒绝重启
   - 每次重启自动通过企业应用通道 notify_engineer，系统工程师知情但无需操作
   - 工具注册在 `index.ts`，白名单校验 service 名称，非 Andy agentId 拒绝
2. **watchdog Ollama 重启修正**：移除不存在的 plist bootstrap（Ollama 由 App 注册到 launchd，无 plist 文件，用 kickstart 即可）
3. **watchdog 死代码清理**：删除未使用的 `ARCHIVE_KUZU_SCRIPT` 常量

**代码变更文件**：`index.ts`（restart_service 工具注册）、`TOOLS.md`（Andy 工具表追加）、`gateway-watchdog.js`（Ollama 重启 + 清理）

**设计判断**：Andy 有了执行能力，可以从「只能建议」升级为「能自行修复基础设施问题」，减少系统工程师干预频率。

---

## v643 · 蒸馏脚本路径修复 + _call_llm 异常安全 + Kuzu 锁冲突串行化（2026-04-12）

**干预类型**：Bug 修复 + 可靠性增强

**背景**：检查 2026-04-12 凌晨自动化任务执行情况，发现三个问题：distill-agent-memories 引用过时路径（04-08 重构后）、distill-impl-learnings SSL 连接失败直接崩溃、Andy HEARTBEAT 与 distill-memories 同时访问 Kuzu 导致锁冲突。

**变更**：
1. **distill-agent-memories 路径修复**：新增 `CREWCLAW_DIR` / `DOCS_DIR` 常量，修正 `render-knowledge.py`、`09-evolution-version.md`、`10-engineering-notes.md` 三处路径
2. **watchdog 全部脚本路径修正**：9 个蒸馏脚本 + 代码图谱脚本从 `CrewHiveClaw/scripts/` 改为 `HomeAILocal/Scripts/`（__dirname 同目录），日志路径同步修正
3. **7 个 distill-*.py `_call_llm` 异常安全**：裸 `requests.post()` 改为 `try/except RequestException` + 端点循环 fallback（SSL/连接异常时自动切换备用 API）
4. **Andy HEARTBEAT 串行化**：从 2am 与 distill-memories 并行改为 distill-memories 完成后触发，执行时序变为 distill-memories → Andy HEARTBEAT → 5min → distill-agent-memories

**代码变更文件**：`distill-agent-memories.py`、`distill-{impl,design,active-threads,learning-objectives,team-observations,memories,relationship-dynamics}.py`（7 个）、`gateway-watchdog.js`

**设计判断**：蒸馏是 L2 进化的输入管道，管道可靠性直接影响系统自进化质量。SSL 错误重试 + 路径修正 + 锁冲突串行化 = 蒸馏协作链从「偶发失败」升级为「稳定运行」。

## v638 · 合并 create_member_shadow → create_sub_agent + 三角色文档同步（2026-04-11）

**干预类型**：架构变更

**背景**：v636 实现了影子 Agent 全家覆盖，但设计上 `create_member_shadow` 和 `create_sub_agent` 是两个独立工具——本质相同操作却有两套参数和调用方式，增加认知负担。业主指出应合并为一个统一工具，由参数区分影子模式和任务模式。

**变更**：
1. **合并工具**：删除 `create_member_shadow` 和旧 `create_sub_agent`，统一为新的 `create_sub_agent`：
   - 影子模式（Lucas）：传入 `member_name` + `relationship` → 自动从模板渲染 SOUL.md + AGENTS.md
   - 任务模式（三角色）：传入 `role_description` → 生成 BOOTSTRAP.md
   - agentId 建议：家人影子用 `shadow-{昵称}`，任务型用英文描述
2. **删除手动创建物**：v636 由系统工程师手动创建的 4 个影子 workspace 目录和 registry 条目已全部删除，等待 Lucas 通过工具自主创建
3. **文档同步**：Lucas/Andy/Lisa TOOLS.md + AGENTS.md + CLAUDE.md + docs/00-project-overview.md 全部移除 `create_member_shadow` 引用，统一为合并后的 `create_sub_agent`
4. **工具计数调整**：Lucas 22→21（合并减少一个），总计 38→37

**代码变更文件**：`index.ts`（合并工具注册）、`TOOLS.md`×3、`AGENTS.md`（Lucas）、`CLAUDE.md`、`docs/00-project-overview.md`

**设计判断**：三角色共用一个工具函数，管理责任通过 parentAgentId 自然区分——Lucas 管家人影子，Andy/Lisa 管任务型子 Agent。Shadow 是 Lucas 专属概念，对 Andy/Lisa 只是「子 Agent」。

---

## v636 · L3 影子 Agent 全家覆盖 + 子 Agent 生命周期管理统一 + exec 权限放开（2026-04-11）

**干预类型**：架构变更 + L3 推进

**背景**：L3 于 2026-04-10 重新定义——从「组织扩张」转为「组织内个人增强」，家人默认拥有影子。原实现仅黟黟有影子（且 agentId 为 `workspace-yuyu`，导致目录双重前缀 `workspace-workspace-yuyu`）。

**变更**：
1. **影子命名规范修正**：agentId 前缀从 `workspace-` 改为 `shadow-`（OpenClaw 自动加 `workspace-` 前缀建目录，`workspace-` 前缀导致双重目录名）
2. **全家影子覆盖**：为全部 4 位家人创建影子 Agent——`shadow-yiyi`（黟黟）、`shadow-zhanglu`（妈妈张璐）、`shadow-xiaoshan`（小姨肖山）、`shadow-xiaolong`（爸爸曾小龙）；每个影子的 SOUL.md 从家庭档案个性化渲染
3. **清理残留**：`workspace-test-shadow` 从 registry 移除；`workspace-yuyu` 重命名为 `shadow-yiyi`
4. **`create_sub_agent` 开放给 Lucas**：从 Andy/Lisa 专属改为三角色共用（Lucas/Andy Tier 1/2，Lisa Tier 1）
5. **子 Agent 生命周期管理统一**：Lucas/Andy/Lisa 的 AGENTS.md + TOOLS.md 全部增加完整生命周期管理经验（创建→使用→监控→归档/驱逐）；Lucas AGENTS.md 重写「成员分身管理」为「子 Agent 生命周期管理」
6. **exec 权限放开**：openclaw.json 四个主 Agent 的 exec 从 `"ask": "on-miss"` 改为 `"ask": "off"`，不再需要人工批准 shell 命令

**关键设计决策**：
- 爸爸作为家庭成员一视同仁拥有影子（`shadow-xiaolong`），家庭角色和系统工程师角色分离
- 影子从「需要爸爸授权创建」变为「家人默认拥有，Lucas 负责生命周期管理」

**代码变更文件**：`index.ts`（create_member_shadow agentId 前缀 + create_sub_agent 描述）、`registry.json`（4 影子 + 清理 test-shadow）、`workspace-shadow-*/SOUL.md+AGENTS.md`（4 套人格文件）

---

## v635 · 访客语音修复 + Main 模型升级 + Lx 评估增强（2026-04-11）

**干预类型**：Bug 修复 + 模型升级 + 监控增强

**背景**：OpenClaw 升级到 2026.4.9 后，Gateway `/v1/chat/completions` 的 `model` 参数只接受 `openclaw` 或 `openclaw/<agentId>` 格式，不再接受原始模型名。

**变更**：
1. **访客语音修复**：`wecom/index.js` demo-proxy voice-chat 的 `model: 'deepseek-chat'` → `'openclaw'`；`demo-chat/index.html` 前端 `MODEL = 'lucas'` → `'openclaw'`
2. **watchdog 修复**：`gateway-watchdog.js` Lucas HEARTBEAT 的 `model: 'lucas'` → `'openclaw/lucas'`
3. **Main 模型升级**：`zai/glm-5` → `zai/GLM-5.1`（智谱 2026-04-07 发布的新旗舰，长程任务能力大幅提升）
4. **Main L1 评估增强**：新增 Main HEARTBEAT 检查、Lucas 子 Agent（访客影子）、evaluator 子 Agent（andy-evaluator/lisa-evaluator）活跃度检查
5. **Main 汇报格式强制 Lx 分层**：AGENTS.md 新增汇报格式要求，所有推送必须按 L0→L1→L2→L3 四层组织，L0 必须包含具体进程状态
6. **调试 API**：新增 `/api/internal/exec-main-tool` 内部工具执行接口
7. **文档修正**：`00-project-overview.md` 中 Andy/Lisa/Main 模型配置表、环境变量表、evaluator 模型表、架构总览表的模型互换错误全部修正；Andy/Lisa 工具表补齐 `notify_engineer`

**关键学习**：OpenClaw 大版本升级后需全面扫描所有 Gateway 调用点的 `model` 参数格式。

---

## v629 · PM2 重复进程修复 + 抖音 CDN 优化 + Main 429 重试（2026-04-11）

**干预类型**：Bug 修复 + 平台约束记录

**背景**：HomeAI 恢复时发现 PM2 有 10 个进程（5 服务 × 2），wecom-entrance 和 local-tts 端口冲突。同时排查抖音视频转录问题，确认 Lucas 通道正常但 Main 通道因 GLM-5 429 限流 + 企业微信 IP 白名单失效导致分析失败。

**变更1：`start-homeai.sh` PM2 全量启动修复**

- **根因**：`pm2 start "$ECOSYSTEM"` 无 `--only` 标志。当 wecom-entrance 不在线时，连带启动全部 5 个服务；而 PM2 resurrection 已有这些进程 → 10 个进程，端口冲突
- **修复**：`--only wecom-entrance`，只启动不在线的那个服务
- **平台约束**：`start-homeai.sh` 由 launchd（`com.homeai.startup`）开机触发 + 30s 健康巡检，必须幂等

**变更2：抖音 CDN 直连优化（跳过 yt-dlp）**

- **根因**：yt-dlp Douyin extractor 有已知 bug（#12669），JSON 解析失败后报 "Fresh cookies needed"，与 cookies 无关，是 extractor 本身问题。每次必败，白等 1-2 秒
- **修复**：反转策略——直接用 `_ROUTER_DATA` 的 CDN URL（`play` 无水印版），yt-dlp 仅在 `_ROUTER_DATA` 未拿到 URL 时作备选
- **附加优化**：`playwm` → `play`（无水印）；ffmpeg 加 `Referer: https://www.iesdouyin.com/` header
- **平台约束**：抖音 CDN URL 需移动端 UA + Referer 才能下载，桌面端 UA 返回 302 空响应

**变更3：`callMainModel` 429 限流重试**

- **根因**：Main 调 GLM-5 分析抖音转录时遇 429 限流，直接失败回退裸推（无重试）
- **修复**：429 自动重试最多 2 次，间隔 3s/6s
- **影响范围**：所有 `callMainModel` 调用（Main 对话 + 抖音分析 + 工具循环）

**验证点**：下次用户发抖音链接时确认 CDN URL 是 `play`（非 playwm）、无 yt-dlp 失败日志、转录时间 ~5s。

---

## v628 · Main 巡检去重 + L0~L3 评估方法全面刷新（2026-04-10）

**干预类型**：Bug 修复 + 架构对齐

**背景**：Main 巡检出现两个问题：① `log_improvement_task` 缺乏去重逻辑，同一类问题（如 chromadb 连接超时）被重复记录为多个 pending 任务，工程师每次要逐条判断是否重复；② `evaluate_l0/l1/l2` 评估实现与当前架构（L2 track A/C 落地、L3 协作蒸馏落地、Andy HEARTBEAT 写时间戳机制）已脱节，evaluate_system 硬编码「L3 未进入」与实际不符。另发现 `evaluate_l1` 和 `inspect_agent_context` 中 `PYTHON3` 变量 undefined，两个工具的 Kuzu 查询每次都静默失败。

**变更1：`log_improvement_task` pending 任务去重**

- 写入新任务前，扫描所有 `status: "pending"` 的现有任务
- 将新任务标题按空白/标点切词（≥3字符的词），统计与现有任务标题的词重叠数
- 重叠 ≥ 2 个关键词时视为重复，返回已有任务 ID 提示，跳过写入
- 防止「chromadb 连接超时」「chromadb 服务异常」等同义表述反复积压

**变更2：`PYTHON3` undefined bug 修复**

- **根因**：`PYTHON311` 定义在 `evaluate_l0` 局部块内，`evaluate_l1` 和 `inspect_agent_context` 引用的 `PYTHON3`（无 `11` 后缀）在模块作用域从未定义，Kuzu 查询路径被 `try/catch` 静默吞掉
- **修复**：`PYTHON311` 提升到 `executeMainTool` 函数顶部；两处 `PYTHON3` 统一改为 `PYTHON311`；临时 Python 脚本路径从 `scripts/` 改为 `temp/`（不污染脚本目录）

**变更3：`evaluate_l0` 新增两项检查**

- **检查5**：ChromaDB `decisions` 集合可达性 + 条数（蒸馏目标库，不可达说明 L1/L2 上下文注入会失效）
- **检查6**：Kuzu 协作边数量（`co_discusses` / `requests_from` / `supports` / `role_in_context` / `active_thread`），作为 L3 数据积累就绪信号，输出 `⚪`（数据积累中）或 `✅`（已有协作边）

**变更4：`evaluate_l2` 重写**

旧实现：Andy HEARTBEAT 靠模糊正则检测「是否有巡检记录」，不知道距上次多久；无 opencode 质量数据。

新实现：
- Andy HEARTBEAT：读取 `上次巡检:` 字段提取真实时间戳，计算距今小时数，超 30h 标黄（watchdog 写时间戳是基础设施层行为，字段格式固定）
- opencode-results.jsonl：读近 10 次运行记录，计算成功率 + 平均 spec 吻合率（`matchRate`），成功率 < 70% 标黄
- ChromaDB `codebase_patterns`：Lisa 每次 opencode 完成后写入的代码库洞察，0 条则 `⚪`（协作链未跑过或首次）
- `learningDir` 路径修正为 `Data/learning`（2026-04-08 目录重构后应为大写）

**变更5：新增 `evaluate_l3`**

全新评估工具，对应 L3「组织协作」层：
1. Kuzu 协作边完整分类计数（`distill-relationship-dynamics.py` 产出：4 类 collab + active_thread）
2. ChromaDB `shadow_interactions` 演进环记录数（`run_evolution_pass()` 产出）
3. `visitor-registry.json` 访客影子状态统计（active / dormant / archived）
4. `Logs/distill-relationship-dynamics.log` 上次运行时间（每周日 4am 触发）

**变更6：`evaluate_system` 更新**

- 调用链：`evaluate_l0 / l1 / l2` → `evaluate_l0 / l1 / l2 / l3`
- 评分卡 `L3 组织协作 ${动态评分}`，移除硬编码「L3 组织运作 ⬜（未进入）」
- 返回字符串末尾追加 L3 详细报告

**文档更新**：`00-project-overview.md` Main 工具表：evaluate_l0~l3 描述全部刷新，新增 evaluate_l3 行，evaluate_system + log_improvement_task 描述同步。

---

## v627 · 访客角色串台修复 + 访客 userId 过滤修复 + Lucas 事件驱动积压排干（2026-04-10）

**干预类型**：Bug 修复 + 架构增强

**背景**：系统工程师发现两类访客相关 Bug：① 访客会话中上下文措辞暗示「你在和某个家庭成员聊天」，导致访客（王炜琦）被 Lucas 识别为「爸爸」（角色串台）；② 访客查询历史时使用 `visitor:TOKEN` 格式 userId，而 ChromaDB 实际存储的是真实姓名，导致历史查询返回空。另外发现系统白天积压任务长期等待 22:00 off-peak 定时器，资源空闲但不利用。

**变更1：访客角色串台修复**

- **根因**：`index.ts` `buildVisitorSessionContext` 上下文措辞中包含「你正在和一位访客交谈」等暗示性描述，部分 prompt 结构与家人档案注入路径措辞相似，弱模型在家庭对话历史充沛时发生混淆
- **修复**：重写 `buildVisitorSessionContext` 上下文措辞，明确区分「访客对话」vs「家庭成员对话」，添加明确的身份边界说明

**变更2：访客 userId 历史查询修复**

- **根因**：`queryMemories` 访客路径使用 `visitor:TOKEN`（如 `visitor:b97e8e`）作为 ChromaDB 查询条件，但历史写入时存储的是真实姓名（如 `王炜琦`），导致历史检索永远返回空
- **修复**：`queryMemories` 访客分支改为用真实姓名（从 registry 解析）执行查询，与写入路径保持一致

**变更3：Lucas 事件驱动积压排干（`agent_end` 末尾新增调度块）**

**背景**：当前 off-peak 定时器（22:00–08:00，每 30 分钟）只在空闲时段处理积压任务；白天系统负载不高时，队列任务最长等待约 14 小时。

**实现**：`agent_end` 末尾新增主动积压排干块，触发条件（同时满足）：
1. Lucas 真实家庭对话（非访客、非测试）
2. `task-queue.jsonl` 有积压任务
3. `task-registry.json` 无 `status: "running"` 任务（Andy/Lisa 当前空闲）
4. 6h 全局冷却未超时（`PROACTIVE_DISPATCH_COOLDOWN_MS = 6h`，`lastProactiveDispatchAt` 模块级变量）

**行为**：条件满足时立即清空队列，逐任务延迟 2 分钟调 `runAndyPipeline`（避免并发雪崩），同时 `notifyEngineer` 通报工程师。

**文档更新**：
- `00-project-overview.md` hook 表 `agent_end` 行：补充「主动积压排干」触发描述
- `00-project-overview.md` 感知侧增量蒸馏节：新增第三条触发链（Lucas 家庭对话 + 6h 冷却 + 队列有积压 + 系统空闲），更新关键设计决策列表

**教训**：
- 访客与家人的上下文隔离不只是「哪些数据可见」，措辞和注入路径结构也会影响模型对身份的判断；弱模型在信息量大时更容易被最近上下文带偏，显式边界说明比隐式区分更可靠
- 写入和读取路径必须使用一致的 userId 格式；存储时用真实姓名，查询时也用真实姓名——不要在中间层做 token 到名字的映射然后忘记同步到查询侧
- 事件驱动与定时器是互补关系：定时器保底（最坏情况 22:00 必跑），事件驱动提速（有机会就提前）。冷却 Map 是防止事件驱动过度触发的标准模式，与蒸馏触发冷却机制完全对称

---

## v623 · ChromaDB watchdog IPv6 探测根因修复 + 访客上下文泄漏修复 + GLM Vision API Key 修复（2026-04-09）

**干预类型**：基础设施稳定性根因修复 + 安全边界修复 + 配置修复

**背景**：系统工程师发现 ChromaDB 在 PM2 中持续重启（从 v622 修后的 0 次又涨回 120+ 次），watchdog 日志显示每小时探测 ChromaDB 失败后执行 `pm2 delete + start` 重启。同时发现访客上下文注入了家庭群聊内容（含"爸爸"），GLM Vision API 报 401。

**变更1：ChromaDB watchdog IPv6 探测根因修复**

根因链条（三层叠加）：
1. **根因**：`gateway-watchdog.js` `probeChromaDB()` 写死 `hostname: '127.0.0.1'`（IPv4），但 ChromaDB（Python HTTP server）在 macOS 上只绑定 IPv6（`::`），Node.js `http.request` 用 IPv4 地址连接时 ECONNREFUSED
2. **为什么以前没事**：watchdog 在 2026-04-04 才补录到 PM2（之前 ecosystem.config.js 遗漏了 watchdog 条目），4月4日前 watchdog 从未运行，ChromaDB 没人杀它。**不是 ChromaDB 变了，是"杀手"上岗了。**
3. **v622 为什么没修住**：v622 只做了 PM2 entry 清理（删除旧 max_memory_restart），没触及探测逻辑。watchdog 下次运行照样用 IPv4 探测失败 → 又开始杀 ChromaDB

修复（`gateway-watchdog.js`）：
- **Fix 1（probeChromaDB）**：`127.0.0.1` → `localhost`（IPv4/IPv6 双栈兼容）
- **Fix 2（checkChromaDB）**：单次探测 → 三次重试（5s 间隔），确认真正挂了才重启
- **Fix 3（restartChromaDB）**：等待从 8s → 20s（ChromaDB 启动需 ~10s 加载 20 集合），重启后 `pm2 save` 持久化干净 entry

**变更2：访客上下文泄漏修复**

- **根因**：`index.ts` `queryMemories` 访客过滤器包含 `{ source: { $eq: "group" } }`，泄漏家庭群聊内容（含"爸爸"等家庭内部称呼）到访客上下文
- **修复**：移除 `source: "group"` 条件，访客严格只能看自己的对话

**变更3：GLM Vision 401 修复**

- **根因**：shell 环境变量 `ZHIPU_API_KEY` 是旧 key，dotenv 不覆盖已有环境变量，PM2 继承了旧 key
- **修复**：`export` 新 key + `pm2 delete + start` wecom-entrance 重建进程环境

**变更4：访客 demo-chat URL 自动可点击**

- `buildMsgEl()` 新增 URL 正则检测，自动替换为 `<a>` 标签

**变更5：邀请码延期**

- 6420C5（顾月峰）、B97E8E（王炜琦）有效期延至 30 天（2026-05-09）

**教训**：
- IPv4 vs IPv6 双栈问题是 macOS + Python HTTP server 的经典陷阱：Python 默认绑定 `::`（IPv6 any），Node.js 用 `127.0.0.1` 强制走 IPv4 栈。`localhost` 是正确选择——操作系统决定走哪条栈
- "为什么以前没问题"的答案经常是"触发条件不存在"，不是代码变了

---

## v622 · 非法 userId 推送过滤 + ChromaDB PM2 残留配置修复（2026-04-09）

**干预类型**：消息路由质量修复 + 基础设施稳定性修复

**背景**：系统工程师发现企业微信 AiBot 日志中存在大量 errcode=93006（invalid chatid）错误（38 次，自 3 月 22 日起）。根因是协作链工具（trigger_development_pipeline / report_bug / Coordinator 等）在记录或推送消息时，将系统会话的内部标识（`system`/`system-scheduler`/UUID/`group`/`owner`/`heartbeat-cron`/`test`）当作真实企业微信 userId 推送到 AiBotSDK `sendMessage()`，触发无效 chatId 错误。同时，ChromaDB 在 PM2 中累计重启 71 次（平均 uptime ~19s），根因是 PM2 残留了旧版 `max_memory_restart` 配置（ecosystem.config.js 已移除但 PM2 运行时未同步）。

**变更1：非法 userId 三层过滤（消息路由质量修复）**

三层过滤统一使用相同的非法 userId 判定规则（`isNonHumanUser()`）：

1. **index.ts `pushToChannel()`**（上游预防）：`pushToChannel` / `pushEventDriven` 调用前，非法 userId 直接 return，不发起 HTTP 请求
2. **wecom/index.js `/api/wecom/send-message`**（工具调用验证）：`send_message` 工具触发的消息发送端点，非法 userId 返回 `{ success: true, skipped: true, reason: 'non-human-user' }`
3. **wecom/index.js `/api/wecom/push-reply`**（回调验证）：`pushToChannel` → CHANNEL_PUSH_URL 的接收端点，非法 chatId/fromUser 静默跳过

非法 userId 判定规则：
- 空值 / `unknown` / `test` / `group` / `owner` / `heartbeat-cron`
- `system` 前缀（含 `system-scheduler`）
- UUID 格式（`/^[0-9a-f]{8}-...-[0-9a-f]{12}$/i`）

**影响**：Lucas 通过协作链工具（`send_message`）向家人推送消息不受影响；所有非法推送（系统会话状态通知、HEARTBEAT 反馈、协作链内部状态同步）不再触发企微 API 调用，消除 93006 和 81013 错误。

**变更2：ChromaDB PM2 残留配置修复**

- `pm2 delete chromadb && pm2 start ecosystem.config.js --only chromadb && pm2 save`
- 修复后：0 次重启，稳定运行
- **教训**：PM2 的 `ecosystem.config.js` 修改后，`pm2 restart` 不会重新读取配置，必须 `pm2 delete + start` 重新注册进程

---

## v618 · L2/L3 边界重新划定 + L3 设计方向对齐 + 生态 Skill 查找机制修复（2026-04-09）

**干预类型**：架构认知校正 + 设计方向对齐 + 数据质量修复

**背景**：系统工程师在 L2 基本完成后启动 L3 设计评审，发现两个问题：① 之前被标注为「L3 已完成」的内容（Andy↔Lisa 多轮协作、Coordinator 并行等）实际属于 L2（协作链效率提升），不改变组织拓扑，需要重新定性；② `context-sources.ts` 中 Andy/Lisa 各有一个 `capabilities` chromadb source 注入了 tool usage stats 而非能力描述，给角色带来误导性「已有能力参考」。

**变更1：L2/L3 边界重新划定（认知对齐）**

L2 = 协作链效率提升，组织拓扑不变：
- Andy↔Lisa 多轮协作（consult_lisa / request_evaluation / report_implementation_issue）
- Coordinator 并行任务模式（Andy 召唤 Lisa 小弟并行执行）
- Spec 结构化 + 双评估器
- 上述均已完成，属于 L2

L3 = 组织拓扑改变，影子 Agent 加入后触发源增加、信息流向改变、协调成本上升：
- **核心约束（已对齐）**：对外永远是 Lucas，影子是内部架构实现细节，访客/成员感知不到「专属助手」层
- 影子做的是让 Lucas 更懂这个人、更主动，不是对外增加一个身份

**变更2：访客影子作为 L3 最小验证切口（设计方向对齐）**

用访客系统验证 L3 的三件事（内部架构，对外无感）：
1. 影子层内部路由决策（能力视图内直接回，超出走完整 Lucas 上下文）
2. 能力视图维护（初始化方式、新能力入库后如何判断纳入、pipeline 结果 surface 机制）
3. 上行通道（影子无法处理时明确上报 Lucas；访客 pipeline 触发的责任链和优先级排序）

具体机制待下次会话设计落地。

**变更3：capabilities ChromaDB source 移除（data quality fix）**

- `context-sources.ts` Andy 处（~第 372 行）和 Lisa 处（~第 469 行）各有一个 `id: "capabilities"` chromadb source
- 问题：这个 source 注入的是 tool usage stats（格式如「andy 使用工具 exec 5 次」，共 3295 条），不是能力描述
- 影响：Andy/Lisa 每轮上下文中出现误导性「已有能力参考」，实际内容对「避免重复造轮子」毫无帮助
- 修复：两处 source 均已移除；正确的能力清单注入来源是 Kuzu `active-capabilities` source（已工作）
- 同时更新 Andy AGENTS.md spec JSON 模板：加入 `registers_capability` 字段（Fix 1），解决 capability-registry bigram 防重复检查永远为空的根因

---

## v581 · L0~L4 评估工具 + L2 进化循环激活 + 承诺幻觉基础设施加固（2026-04-04）

**干预类型**：监控能力扩展 + 进化循环激活 + DPO 检测加固

**背景**：系统工程师发起第一次系统性 L0~L4 运行评估，发现三个主要缺口：① Main 无法远程评估系统层级健康（只有运维监控，无进化层评估）；② Andy HEARTBEAT cron 从设计完成到现在从未触发（L2 进化循环在设计上存在但实际断路）；③ 承诺幻觉的 DPO 检测词库窄且缺乏 HEARTBEAT 即时通知。

**变更1：Main L0~L4 评估工具**
- `wecom/index.js` MAIN_TOOLS 新增 `evaluate_l0` / `evaluate_l1` / `evaluate_l2` / `evaluate_system` 四个工具
- `evaluate_l0`：gateway-watchdog PM2 状态、Kuzu Fact/Entity 总数（Python 临时脚本查询，sys.stdout.flush() 在 os._exit(0) 前，防止输出截断）、ChromaDB 对话量、家人档案新鲜度
- `evaluate_l1`：Lucas 最近 30 条对话质量（复用 scan_lucas_quality 逻辑）、Andy/Lisa agent_interactions 活跃度、家人档案注入完整性
- `evaluate_l2`：skill-candidates 候选数、dpo-candidates 负例数、Andy HEARTBEAT cron 状态、三角色 Skill 总数
- `evaluate_system`：总入口，递归调用三子工具，输出 `L0: ✅/⚠️/❌ [一句话]` 评分卡
- 业主触发词：「系统评估」或「评估 L0~L4」
- **坑**：Kuzu 实际 schema 是 `Entity`（有 type 字段），不是 `Person` 节点——文档描述与实际不符，需用 `WHERE e.type = 'person'` 查询

**变更2：Andy HEARTBEAT cron 激活（L2 进化循环）**
- `wecom/index.js` 新增 `runAndyHeartbeatLoop()` 函数，启动后延迟 15 分钟首次触发，之后每 24 小时
- 预计算两类数据注入 prompt：① Kuzu `has_pattern` 关系中 confidence ≥ 0.8 的结晶候选（Python 临时脚本查询）② `skill-candidates.jsonl` 中 status=pending 的显式候选
- 调用 `callGatewayAgent('andy', heartbeatPrompt, 'heartbeat-cron')`，Andy 按 HEARTBEAT.md 执行巡检并决策是否固化
- 触发后更新 Andy HEARTBEAT.md 时间戳（`- 上次巡检：${nowIso}`）
- `skill-candidates.jsonl` 原本不存在（文件从未被创建），同步创建空文件作为入口

**变更3：承诺幻觉 DPO 检测加固**
- `config/dpo-patterns.json` `false_commitment` 列表扩充：新增 Bug 类承诺词（"Bug 已提交"/"已提交给Lisa"/"已触发修复"等）；新增独立分组 `report_bug_commitment`
- `index.ts` `detectDpoCandidates` 新增模式5（Bug承诺幻觉）：声称提交 Bug 但未调 `report_bug` → 写入 `dpo-candidates.jsonl`
- 检测命中时即时追加到 `workspace-main/HEARTBEAT.md`「待汇总观察」节，Main 下次心跳汇总时感知
- `DpoPatternsJson` interface 新增可选字段 `report_bug_commitment?: string[]`，常量 `DPO_REPORT_BUG_PATTERNS` 加载
- `scan_lucas_quality` + `evaluate_l1` 的 COMMITMENT_RE 同步收紧：从 `/已(完成|处理|发送|安排|通知|触发|执行|更新)/` 改为 `/已(提交|修复|告知|报告|转告|安排)(?!了解|知道|确认)/`；MARKDOWN_TITLE_RE 去掉 `**加粗**\n` 误报，只保留 `^#{1,4}` 标题行匹配

**评估快照（2026-04-04 18:00）**：
- L0 ✅：gateway-watchdog online，Kuzu 259 Facts / 234 Entities，家人档案4个
- L1 ⚠️：Lucas 质量历史有旧问题，Andy/Lisa agent_interactions 正常，档案注入4个成员
- L2 ❌→⚠️：skill-candidates 从不存在→已创建，Andy cron 从未触发→已激活，dpo-candidates 35条
- L3/L4：未进入（设计在，未激活）

---

## v578 · 因果维度补齐（2026-04-04）

**干预类型**：记忆系统架构扩展

**背景**：外部参考 MAGMA（Multi-graph Agent Memory Architecture）提出四维图谱记忆模型（语义/时间/实体/因果）。对照我们的架构，语义（ChromaDB）、实体（Kuzu 节点）、时间（valid_until + 相对时间标签）三维已有，因果维度完全缺失。系统知道「爸爸在做抖音」，但不知道「为什么做」。MAGMA 还提出双流读写机制（交互流/推理流），与我们的「同步回复 + 异步蒸馏」模式在结构上同构，但粒度有差异：MAGMA 推理流是 per-message 实时更新图谱，我们是批处理（watchdog 定时，2-4 小时周期）。对当前家庭场景可接受，不做改造。

**变更清单**：
- `scripts/distill-memories.py`：`ALLOWED_RELATIONS` 新增 `causal_relation`（value=效果简述，context=因为X所以Y，仅有明确因果线索词时提取）；`DISTILL_PROMPT_JSON` 新增提取说明
- `scripts/render-knowledge.py`：`RELATION_LABELS` 新增 `"causal_relation": "因果关系"`
- `crewclaw-routing/index.ts`：新增 `queryCausalFacts(userId)` helper（Kuzu Cypher 查 causal_relation Fact 边）；`queryMemories` 自动注入 `【因果关系】` 块；`recall_memory` 工具结果包含因果事实
- `docs/00-project-overview.md` 2.2 节：新增因果关系蒸馏说明（来源参考不入 Readme）
- `Obsidian/07-设计与技术外部参考/2026-04-04-MAGMA-四维图谱记忆架构.md`：MAGMA 完整分析存档

**未来扩展**：数据积累后可沿 causal_relation 边做多跳遍历，支持「这件事的来龙去脉」类查询。

---

## 干预记录格式

每条记录包含：

```
## [日期] [干预标题]

**现象**：系统出现了什么问题 / 自进化在哪里失效了

**根因**：为什么会发生（prompt 设计？模板缺失？路由逻辑？协作链断点？）

**干预内容**：系统工程师做了什么

**改进结果**：干预后系统行为有何变化

**沉淀建议**：如何防止同类问题再发生（prompt 改进 / DPO 负例 / 协作链补丁）
```

---

## 干预记录

## 2026-04-03 蒸馏管道 L0/L1 缺口全面修复（P0-P3）

**现象**：系统进入低干预运行期后，对 L0/L1 知识蒸馏层做全面缺口审计，发现四类系统性问题：
1. **P0 滑动窗口截断**：蒸馏每次只看最近 60 条，历史对话积累被截断，长期项目的跨时段话题积累无法实现
2. **P1 当前轮盲区**：`recall_memory` 工具返回结果没有说明「本轮刚发生的对话尚未写入」，导致 Lucas 把「搜不到本轮内容」误判为「这件事不存在」
3. **P2 命名漂移碎片化**：LLM 对同一话题在不同批次使用不同名称（「运营抖音」vs「一起运营抖音」），形成 Kuzu 孤立节点，Topic-first 检索会命中不同节点
4. **P3 多人话题标注不完整**：`_sync_topic_to_chroma()` 虽已实现多人话题查询逻辑，但 `write_kuzu_facts()` 调用时漏传 `kuzu_conn`，导致多人标注始终为空

**根因**：
- P0：蒸馏设计只考虑了「效率」（窗口限制防 token 爆炸），没有考虑「全量重建」场景
- P1：recall_memory 工具已有「禁止调用」规则，但没有在返回结果里强化会话边界的提示
- P2：existing_facts 注入能防止 LLM 主动漂移，但对已有碎片化节点没有收敛机制
- P3：代码逻辑正确，但参数传递链有断层（函数签名支持但调用方没传）

**干预内容**：
1. **P0 全量历史模式**（`distill-memories.py`）：新增 `distill_user_full_history()`，分批处理全部历史，批次间通过 existing_facts 传递提炼结果；`write_kuzu_facts()` 新增 `skip_expire` 参数，首批前统一清空，后续批次跳过；新增 `--full-history` CLI 参数
2. **P1 会话边界提示**（`crewclaw-routing/index.ts`）：`recall_memory` execute 成功结果末尾追加提示；空结果也追加说明；Gateway 已重启生效
3. **P2 语义去重**（`distill-memories.py`）：新增 `find_canonical_topic()` 函数，ChromaDB 相似度查询（阈值 0.92），命中时复用已有 topic_id/name；写入 Kuzu 前调用，日志打印 `[P2] 语义去重`
4. **P3 参数修复**（`distill-memories.py`）：`write_kuzu_facts()` 调用 `_sync_topic_to_chroma()` 时传入 `kuzu_conn=conn`，多人话题标注生效
5. **00-project-overview.md 同步更新**：2.2 知识蒸馏节新增「蒸馏质量四项机制」和「shared_activity relation」说明；2.3 上下文工程节新增 `recall_memory` 两条使用边界；hook 表 `agent_end` 行补充活跃线索触发

**改进结果**：P3 立即生效（参数修复），P1 Gateway 重启后生效，P2 下次蒸馏触发时生效，P0 下次系统工程师手动执行 `--full-history` 时生效。

**沉淀建议**：
- `--full-history` 应在话题记忆出现明显断层时手动触发，不应纳入常规 watchdog（数据量大时 LLM 成本较高）
- P2 阈值 0.92 是保守值，若发现仍有碎片化可降至 0.90；若有误合并可升至 0.95，需观察几次蒸馏后校准
- Readme 系列文档已同步更新（00-project-overview.md），Readme.md 不需改动（概念层描述已准确）

---

## 2026-04-03 蒸馏增量更新 + recall_memory 上下文盲区修复

**现象**：
1. 爸爸询问抖音运营脚本策划（3-28），Lucas 完全不记得前一天（3-27）写好的脚本，只翻出更早的「小姨卖算力盒子」信息。同一话题跨 4 次会话（3-27/3-28/3-31/4-02），Kuzu 只记录了 3-27 一次，后续内容全部丢失。
2. 爸爸在当次对话里把原文发给 Lucas，Lucas 仍然说「查不到记忆」——因为调了 `recall_memory` 工具，工具查历史库返回空，Lucas 信工具结果、忽视了眼前的上下文。

**根因**：
1. `distill-memories.py` 全量覆盖策略：每次蒸馏先过期所有旧 Fact，再提取当批对话。LLM 只看当前批次，不知道同一话题之前已积累了什么，导致每次覆盖而非累积。
2. `recall_memory` 工具 description 没有限制：明明信息在当前对话上下文里，Lucas 仍习惯性调工具核实，工具返回空就认为「没记录」。

**干预内容**：
1. **蒸馏增量更新**（`scripts/distill-memories.py`）：新增 `load_existing_facts()` 读 Kuzu 现有活跃 Fact；`DISTILL_PROMPT_JSON` 注入「现有知识基础」；LLM 按三规则更新（追加/保留/新增）；三处 `call_llm_distill()` 调用传入 `existing_facts`
2. **recall_memory 禁止调用场景**（`crewclaw-routing/index.ts`）：tool description 新增：用户当前对话刚提供信息时，不得调工具核实
3. **手动修复 Kuzu Fact**：`topic_douyin_lucas_growth_story` context 补齐 4 轮完整脉络，同步 ChromaDB topics

**改进结果**：Gateway 已重启生效。下次蒸馏运行会输出「现有活跃 Fact：N 条」日志，说明增量注入正常工作。

**沉淀建议**：
- 蒸馏增量更新是防止「多轮话题只记第一次」的通用解法，所有长周期协作话题（项目/创作/计划）都受益
- recall_memory「禁止调用」规则的本质：工具只是记忆检索，不是事实判断的唯一来源；上下文里已有的信息比工具查询结果更可靠
- 蒸馏 LLM 长期应迁移到本地模型（高重复标准化任务，微调模型最适合，不消耗云端 Token）

---

## 2026-03-31 Main 角色强化：从被动响应器到主动监控代理

**现象**：Main 只在业主主动发消息时才响应，系统出现异常（进程崩溃、Gateway 无响应、Lucas 质量下降）时业主无法及时感知，依赖人工定期查看日志。SOUL.md / AGENTS.md 仍是 OpenClaw 泛化模板，包含 Discord/WhatsApp/群聊等与 HomeAI 运维无关的内容，Main 没有清晰的角色认知。

**根因**：Main 的定位从未被显式设计为「主动在场」。wecom-entrance 只实现了响应循环，没有监控循环。SOUL.md/AGENTS.md 沿用了 OpenClaw 默认模板，没有针对系统工程师运维场景做专属化。

**干预内容**：
1. **SOUL.md 重写**：HomeAI 专属版，明确「两种模式」（响应 + 监控）、干预边界、记忆机制
2. **AGENTS.md 重写**：去掉 Discord/WhatsApp/群聊等无关内容，加入 HEARTBEAT 行为规范和工具使用原则
3. **HEARTBEAT.md 激活**：定义检查清单（每次必查健康 + 每天质量扫描）、推送规则、运行记录
4. **新增 `scan_pipeline_health` 工具**：PM2 + Gateway(`/health`) + wecom + 最近 1h 日志错误，返回结构化健康报告
5. **新增 `scan_lucas_quality` 工具**：扫描 ChromaDB conversations 最近 50 条，检测 Markdown 违规 / 幻觉承诺 / 空回复
6. **Main 主动监控循环**：wecom-entrance 启动后 10min 首次触发，之后每 30min 循环；有异常推送给业主（`sendWeComMessage(WECOM_OWNER_ID, ...)`），全部正常静默；每次触发后更新 HEARTBEAT.md 时间戳
- 修改位置：`~/.openclaw/workspace-main/SOUL.md` / `AGENTS.md` / `HEARTBEAT.md`；`crewclaw/daemons/entrances/wecom/index.js`（MAIN_TOOLS 新增 2 工具、executeMainTool 新增实现、`runMainMonitorLoop` 函数、启动区注册循环）

**改进结果**：wecom-entrance 重启成功，Main 监控循环已注册（30min），首次触发已自动执行并更新 HEARTBEAT.md。

**沉淀建议**：监控循环的推送阈值需要观察校准——`scan_lucas_quality` 的幻觉承诺正则（`已完成|已处理|...`）可能有误报，需积累几次实际扫描结果后调整；Gateway 健康端点是 `/health` 不是 `/api/health`。

---

## 2026-03-31 conversations 记忆质量 Bug 修复（pipeline 污染 + userId 大小写）

**现象**：Lucas 记忆系统质量差——①搜索家人对话时混入 Andy/Lisa pipeline 对话（spec、HEARTBEAT 等）干扰语义结果；②查询 {OWNER_ID} 时只命中 514/578 条（64 条因大小写不一致漏查）。

**根因**：
- `writeMemory` 没有过滤 `fromType=agent` 的 pipeline 写入，Andy/Lisa 的工作对话混入 `conversations` 集合。
- `writeMemory` 写入 `userId: meta.fromId` 未 normalize，来源 ID `{OWNER_ID}`（企业微信原始格式）与 `zengxiaolong` 共存，`queryMemories` 精确匹配只能命中其中一套。

**干预内容**：
1. **查询侧过滤**（不删数据）：`queryMemories` 的 where 条件加 `fromType: { $eq: "human" }`，pipeline 记录对家人搜索不可见，但数据保留（Andy/Lisa 蒸馏燃料）。
2. **写入侧过滤**：conversations 写入块加 `if (convFromType === "agent") skip`，未来 pipeline 不再写入。
3. **userId 规范化**：`writeMemory` L1054 改 `meta.fromId.toLowerCase()`；`queryMemories` 入口加 `userId = userId.toLowerCase()`。
4. **存量 re-index**：64 条 `{OWNER_ID}` 记录 ChromaDB delete+add 重建为 `zengxiaolong`，现共 514 条全部命中。
- 修改位置：`crewclaw/crewclaw-routing/index.ts` L952（queryMemories）/ L982-990（where 条件）/ L1054（writeMemory）/ L3929-3949（conversations 写入过滤）

**改进结果**：家人对话搜索去除 pipeline 噪音；userId 查询覆盖率 100%。Gateway 已重启生效。

**沉淀建议**：新增 `fromType` 字段时记得同步在 queryMemories 加过滤；userId 来源（企业微信推送）不保证大小写，所有写入路径都应在入口 normalize。

---

## 2026-03-30 L1 感知侧升级：事件驱动增量蒸馏

**现象**：周期性全量蒸馏（每周一次）导致「本周期内知识缺口」——家人刚说过的事情 Lucas 不知道，直到下次蒸馏才能感知。人类家庭成员是流式感知，Lucas 是批量快照感知。

**根因**：蒸馏触发时机与知识生产时机脱钩。每条对话写入 ChromaDB 是实时的，但 Kuzu 知识图谱更新是周期性的，两者之间存在最多 7 天的感知延迟。

**干预内容**：在 `crewclaw-routing/index.ts` 的 `after_response` 路径（`writeMemory` 之后）追加事件驱动增量蒸馏触发：
- 条件：`ctx.agentId === "lucas"` + `isRealFamilyMember || isVisitorUser`
- 机制：fire-and-forget spawn `distill-memories.py --user userId`
- 冷却：`lastDistillTrigger` Map，30 分钟/用户，防止高频重复触发
- 安全：watchdog/heartbeat 的 userId 含 `:`，被 `isRealFamilyMember` 条件天然过滤
- `distill-memories.py` 内置 `delta_trig` 阈值，新记录不足时自动跳过

**改进结果**：Lucas 的知识从「最多延迟 7 天」变为「最多延迟 30 分钟」（冷却窗口）。L1 感知模式从批量快照升级为事件驱动流式感知。

**架构决策**：同期决定不做「发消息式主动行为」——主动发消息的触发场景需要真实数据归纳，不提前设计。感知侧解决后，L4 阶段若出现高频可归纳的主动场景，再接上 `proactive-signals.json` → watchdog 触发链路。

**沉淀建议**：`fire-and-forget spawn` + `Map 冷却` 是 L1 事件驱动感知的通用模式。后续遇到「实时采集 → 延迟处理」断点，优先用此模式，不引入异步队列或额外进程。

## 2026-03-30 L3 影子 Agent 架构设计定稿

**现象**：L3·成员影子 Agent 长期挂起，「系统自运转质量稳定」这个上线条件太模糊，实际是设计未完备导致无法推进。

**根因**：原设计停在「影子 Agent = 家人的 Lucas 分身」，没有解决权限模型、路由判断、访客统一纳管、治理闭环等核心问题。Demo Agent 是 ad-hoc 实现，没有和影子 Agent 机制对齐。

**干预内容**：系统工程师与业主完成完整设计讨论，定稿以下核心决策：
- **Shadow Agent 粒度**：一人一个，家人/访客/Demo 统一，无例外
- **权限模型**：标签制（非固定层级），知识节点打标签，人员节点有 `scope_tags` + `authorization_records`，支持周期性授权窗口
- **Shadow Agent 本质**：Lucas + 该人知识标签过滤视图；从外部看永远是 Lucas，Shadow Agent 是实现细节
- **邀请函机制**：生成邀请时携带结构化描述（关系/context/scope_tags/有效期）→ 预创建 Kuzu 人员节点 + Shadow Agent workspace
- **治理闭环**：Lucas `propose_knowledge_tag` → 爸爸审核确认 → 写入 Kuzu（与 `flag_for_skill` 机制对称）
- **Demo Agent 收编**：作为第一个 Shadow Agent 实例（`type=visitor`）实现，验证整套机制
- **组织哲学**：AI 成员有监护者（系统工程师），系统工程师也是组织成员；HomeAI 简化：爸爸=系统工程师=曾小龙（家庭专有简化）

**改进结果**：L3 从「挂起，等条件」变为「设计定稿，进入实现准备期」。实现顺序明确：Demo Agent 收编 → Kuzu schema 扩展 → Lucas 工具 → 家人影子上线。

**沉淀建议**：「上线条件：系统稳定」类描述是挂起的伪装，遇到这类条件要追问「设计完备了吗」——设计不完备才是真正的阻塞项，不是运行质量。

### 2026-03-29 三角色自我认知补全：BACKGROUND.md 注入（v539）

**现象**：Lucas / Andy / Lisa 的 IDENTITY.md 只有 27 行，描述「我是谁 / 如何思考」，完全不知道 HomeAI 是什么、彼此如何协作、走了哪些里程碑、遇到问题应该去哪里查文档。角色缺乏「前世今生」，无法对自己的来历做出任何说明。

**根因**：OpenClaw 8 文件体系中，IDENTITY.md 是角色人格定义，不是项目历史载体。项目背景、组织结构、文档地图从未被注入到任何角色的 system prompt。Andy 有 ARCH.md（技术架构），Lisa 有 CODEBASE.md（代码参考），但两者都没有「这个项目是什么 / 我是怎么来的」的叙述层。

**干预内容**：

1. **新建 `BACKGROUND.md`**（三个角色各一份）：
   - Lucas：HomeAI 是什么 / Andy & Lisa 幕后队友 + 触发方式 / L0-L2 里程碑 / 已交付成果 / 文档查阅地图（工具说明 / Readme / 演进记录 / 找系统工程师）
   - Andy：框架打样定位 / 四角色结构 / 双向V字协作链全图 / L0-L2 演进 / 文档查阅地图（出方案前必查9个文档，每条标注「为什么对我重要」，核心原则：**代码比文档更真实**）
   - Lisa：框架打样定位 / 协作链中的位置 / `report_implementation_issue` 机制 / 已交付系统 / 文档查阅地图（`10-engineering-notes.md` 标注最高优先级，**实现前必查**）

2. **注册到 context-sources.ts**：三个角色各加一条 `id: "background"` 的 `static-file → append-system` 源，注入顺序在工作规则之前（背景知识先于操作规则）

3. **Readme 系列刷新**：`00-project-overview.md` 三角色工作空间文件表各加 `BACKGROUND.md` 行；`03-configuration-management.md` 目录树同步更新

**设计原则确认**：文档地图的关键不是「这里有哪些文档」，而是「**遇到 X 问题时，去 Y 文档查，因为那里有 Z**」。路径 + 触发条件 + 意义三要素缺一不可，否则角色不会主动去查。

### 2026-03-29 L2 完整落地：双向V模型 + AGENTS.md精简 + Readme刷新（v538）

**现象**：
1. V字协作链是单向瀑布（Lucas→Andy→Lisa），任何一层遇到问题只能靠系统工程师介入；Andy 写完 spec 盲目触发 Lisa（未验证集成点）；Lisa 遇到实现阻塞无反馈路径；Lucas 无法叫停进行中的任务
2. Lucas AGENTS.md 有 11 个「情况」规则，认知负担高，模型在切换场景时容易漏读
3. Readme/project-overview 文档未反映 L2 的双向协作机制

**根因**：
1. V字右侧回路（Lisa→Andy、Andy→Lucas 澄清、Lucas 叫停）在系统设计里存在但工具层没有实现；协作链里没有 pre-Lisa 取消检查点
2. 情况分类是线性枚举，B/D/I 本质上都是 send_wecom_message，E/F 是输入描述而非触发条件，拆分标号反而增加了无效负担
3. 文档落后于实现

**干预内容**：

1. **双向V模型工具层**（index.ts）：新增 `query_requirement_owner`（Andy→Lucas 澄清）/ `report_implementation_issue`（Lisa→Andy 反馈）/ `list_active_tasks` / `cancel_task`（Lucas 任务控制）；任务注册表 `task-registry.json`；`trigger_lisa_implementation` 新增 `requirement_id` 参数 + pre-Lisa 取消检查点

2. **稳定性基础设施**：`stripMarkdownForWecom`（wecom-entrance 全路径格式强制）；`before_prompt_build` 承诺词铁律每轮注入（幻觉承诺防御）

3. **规则文件强化**：Andy AGENTS.md 加 spec 自验清单（5项 exec 核查）；Lisa AGENTS.md 加调试回路（最多2轮→report_implementation_issue）；Andy+Lisa HEARTBEAT 加行为规则自检（3次模式→alert_owner 提案）；Lucas AGENTS.md 情况J（Andy澄清）/ 情况K（任务管理）

4. **AGENTS.md 精简**（本次）：Lucas 11个「情况」→ 5个触发路径（开发需求/信息获取/主动联系与转发/任务管理/Andy澄清）；输入类型提示合并为一个简短块；E/F/B/D/I 全部折叠消失

5. **Readme 系列刷新**：HomeAI Readme 角色表 + 描述节反映双向V模型；00-project-overview 更新角色间通信图/协作链验证表/Andy能力/Lisa能力/HEARTBEAT自进化段落

**设计原则确认**：模型层约束（靠 prompt）不如基础设施层约束（靠代码强制）稳定。格式类→代码强制；行为约束→每轮注入；规则数量→最小化。这三条适用于所有后续 Agent 设计。

### 2026-03-29 TTS 引擎切换至 Spark-TTS + 视觉模型升级至 Qwen3-VL（v528）

**现象**：
1. Qwen3-TTS CustomVoice 9 个固定音色（aiden/ryan 等）全部音色偏向"抖音流行小帅"风格，不符合启灵形象；Base 模型（0.6B-8bit）的 `generate()` 不接受 `instruct` 参数（落入 `**kwargs` 被忽略）
2. Qwen2.5-VL-32B-4bit 视觉模型有更新版本 Qwen3-VL-32B-4bit

**根因**：
1. Qwen3-TTS CustomVoice 内置音色缺乏男性稳重感，且无声音克隆接口；Base 模型不支持 instruct 参数，情感控制无法实现
2. Qwen3-VL 是视觉模型代际更新，lmstudio-community 已发布 MLX 4bit 版本（18GB，4 个 safetensors 分片）

**干预内容**：

1. **TTS 引擎切换**：`Qwen3-TTS-0.6B-CustomVoice-8bit` → `Spark-TTS-0.5B-8bit`（ByteDance）；支持 `ref_audio=lucas.wav` 声音克隆，启灵音色；`config.json` 中 `model_type` 从 `qwen2` 修正为 `spark`（mlx_audio MODEL_REMAPPING 需要此字段匹配）；warmup 验证输出振幅从 101 升至 32085（正常）

2. **TTS 服务重命名**：`fish-speech-server.py` → `tts-server.py`；PM2 进程 `fish-speech-tts` → `local-tts`；wecom/index.js 常量 `FISH_TTS_URL` → `LOCAL_TTS_URL`；日志文件前缀同步更新

3. **CosyVoice2 备选**：同时尝试 CosyVoice2-0.5B-8bit（Alibaba，最优候选：中文+声音克隆+情感 instruct），但 mlx_audio 0.4.1 MODEL_REMAPPING 不含 `cosyvoice2`，暂无法运行；模型下载至 `~/HomeAI/Models/tts/CosyVoice2-8bit`（929MB），等 mlx_audio 支持后升级

4. **视觉模型升级**：Qwen2.5-VL-32B-4bit → Qwen3-VL-32B-4bit；mlx-vision PM2 进程用新模型路径重启；同步删除 Qwen2.5-VL 旧模型（20GB），并清理 HF cache 中无用旧模型（Qwen3-TTS-CustomVoice 3.7GB + DeepSeek-R1-14B 2.8GB + Qwen2.5-7B 1.0GB），共释放约 27.5GB

5. **文档更新**：`00-project-overview.md` TTS 管道描述 + `03-configuration-management.md` 端口速查 + `CLAUDE.md` 稳定区模型层

**改进结果**：启灵语音使用 lucas.wav 参考音频克隆，音色一致性和自然度显著优于固定音色；视觉模型升级至新一代；磁盘释放 27.5GB（344GB 可用）

**沉淀建议**：mlx_audio 加载模型依赖 `config.json` 的 `model_type` 字段与 MODEL_REMAPPING 的 key 精确匹配；引入新 TTS 模型前先验证此字段；情感/风格 instruct 是重要能力，选型时优先验证该能力是否真实可用（不被 `**kwargs` 静默吞掉）

---

### 2026-03-29 TTS 引擎切换至 Qwen3-TTS + 语音三项增强（v524）

**现象**：fish-audio-s2-pro（~4GB）因 HuggingFace xet 协议导致下载反复失败（xet CDN pre-signed URL 1 小时过期，断点续传不支持任意 range）；同时发现三个语音路径 bug：① 语音消息回复不走 [VOICE]/[RAP] 检测；② markdown 未 strip 直接传入 TTS；③ 无群组限流和 sendWithTimeout。

**根因**：
1. fish-audio-s2-pro 使用 xet 存储协议，`HF_HUB_DISABLE_XET=1` + aria2c 均无法绕过签名 URL 过期问题
2. wecom `message.voice` 处理分支是后加的，复用了文字分支的结构但遗漏了 [VOICE]/[RAP] 检测、markdown strip、限流和超时包装
3. generate_audio 默认 `lang_code='en'`，中文音质差（未传 `lang_code='zh'`）

**干预内容**：

1. **TTS 引擎切换**：`fish-audio-s2-pro` → `mlx-community/Qwen3-TTS-12Hz-0.6B-CustomVoice-8bit`（Qwen3-TTS，Alibaba）；`xetEnabled: False`，无下载障碍；~1.85GB（1.2GB + 651MB），warmup ~3s；内置声音 `aiden`；不依赖 ref_audio
2. **`HF_HUB_OFFLINE=1`**：模型已本地缓存，服务启动时注入此 env，防止 `snapshot_download` 发起网络请求挂死（已验证：无此 flag 时 fetch 卡死，加上后立即走本地缓存）
3. **voice handler 修复**（`wecom/index.js`）：补入 [VOICE]/[RAP] 标记检测；`stripMarkdownForVoice()` 清洁 TTS 文本；私聊语音消息自动追加语音回复（镜像模式，无需 [VOICE]）；群组消息添加限流；`replyStream` 包入 `sendWithTimeout`
4. **SOUL.md 补充**：声音模式节增加「收到语音消息时」指导——优先回 [VOICE]，写法符合声音模式规范
5. **lucas.wav 格式修复**：edge-tts 生成的 `.wav` 实为 MP3 → 用 ffmpeg 转为真正 PCM WAV（22050 Hz mono），miniaudio 才能解码
6. **`data/voice-samples/` 目录**：新建，含 `lucas.wav`（YunxiNeural 参考音频）+ `lucas.txt`（转录文本）+ `README.md`（录制说明）

**改进结果**：Qwen3-TTS 服务 3 秒 warmup 即就绪；语音消息输入→语音回复闭环完整；[RAP] 说唱风格通过 `instruct` 注入正常工作；edge-tts 降级路径保持不变。

**沉淀建议**：新增消息处理分支时，需对照其他分支 checklist（标记检测 / strip / 限流 / 超时）逐项核查；本地模型服务强制设 `HF_HUB_OFFLINE=1` 防止 snapshot_download 拦路。

---

### 2026-03-28 Fish-Speech 本地 TTS + [RAP] 说唱模式上线（v516-fish）

**现象**：Lucas 语音回复只有 edge-tts 一条路，音质单一；家人生日场景下希望能用更自然的本地语音，并支持说唱风格。

**干预内容**：

1. **Fish-Speech TTS 服务**（`services/fish-speech-server.py`，端口 8082）：基于 `mlx-audio 0.4.1` + `mlx-community/fish-audio-s2-pro`，HTTP 服务器，`POST /tts {text, style}` 返回 WAV bytes，懒加载 + 后台预热线程，加载完成前返回 503
2. **双引擎 TTS 路由**（`wecom/index.js`）：`sendOneTts()` 先请求 Fish-Speech（60s 超时），失败/503 时降级 edge-tts，对上层完全透明
3. **`[RAP]` 标记协议**：Lucas 回复末尾加 `[RAP][VOICE]` → TTS 以 `style='rap'` 调用，Fish-Speech 通过 `instruct` 参数注入「用活泼说唱的语气，节奏感强，带点嬉笑，有韵脚」
4. **`/api/wecom/send-message` 补齐检测**：此端点（Lucas `send_wecom_message` 工具调用路径）原只响应显式 `voiceText` 参数，现补入 `[VOICE]`/`[RAP]` inline 标记检测，与 bot reply 路径对齐
5. **`stripMarkdownForVoice()` 扩展**：新增 `[RAP]` 剥离
6. **PM2 配置**：新增 `fish-speech-tts` 进程，`min_uptime: 60s`，不设 `max_memory_restart`（模型约 4GB）
7. **Lucas SOUL.md**：新增「说唱模式（[RAP]）」节，定义适用场景和写作风格

**改进结果**：Fish-Speech 模型下载完成后（~4GB）自动成为主力 TTS；下载期间 edge-tts 无缝兜底，家人感知不到切换。[RAP] 标记在 bot reply 和 send_wecom_message 两条路径均生效。

**沉淀建议**：新增输出模态时，需同步检查所有发送路径（bot reply / send_wecom_message / send-to-group），避免路径遗漏导致标记只在部分路径生效。

---

### 2026-03-28 Kuzu 脚本 SIGBUS 全面加固 + Andy 认知更新闭环 + 弱模型兼容设计（v514）

**现象**：
1. render-knowledge.py `--agent lisa` 触发 SIGBUS——表面看是 Kuzu 析构 bug，实为 `re.sub(new_section, content)` 遇蒸馏内容含 `\d` 字符抛 `re.error`，异常冒泡导致 `os._exit(0)` 被跳过，Python 正常退出触发析构链
2. Andy 的自学习回路缺失：Andy 调研获得的新认知只能单向写入 ChromaDB，没有机制把「旧判断已过时」的信号写回知识库，MEMORY.md DISTILLED 只增不修正
3. Andy/Lisa 的 AGENTS.md 隐含「强模型假设」，`【约束验证】`/`【认知更新】` 等协议弱模型（MiniMax M2.7 / GLM-5）基本不会主动触发

**根因**：
1. re.sub 把替换字符串当 regex 模板处理，`\d` 触发 `bad escape`；五个 Kuzu 脚本中任何未捕获异常都会绕过 `os._exit(0)`
2. distill_focus 对 Andy 只有"哪些假设被推翻"的意图表述，无具体标记协议和 distill 识别逻辑
3. 关键行为（遵守约束、调工具）与增强行为（写标记、元认知）未分层，弱模型精力放错地方

**干预内容**：

① **re.sub bug 修复**：`render-knowledge.py` line 379 `pattern.sub(new_section, content)` → `pattern.sub(lambda m: new_section, content)`

② **五脚本全面加固**：`render-knowledge.py` / `distill-memories.py` / `distill-agent-memories.py` / `init-capabilities.py` / `init-family-relations.py` 的 `main()` 主体全部包进 `try/finally`，`os._exit(0)` 移入 `finally`——任何未捕获异常也保证通过 `os._exit(0)` 退出，析构路径彻底封死

③ **10-engineering-notes.md 补充**：新增「re.sub 替换字符串含反斜杠 → 绕过 os._exit(0) → 触发 SIGBUS」陷阱，含完整修复范围

④ **Andy 认知更新闭环**：
   - `~/.openclaw/workspace-andy/AGENTS.md` 加「认知更新协议」：发现调研结论与现有判断矛盾时写 `【认知更新】` 标记
   - `distill-agent-memories.py` Andy distill_focus 加：识别 `【认知更新】` → 淘汰旧 pattern / 写入修正判断；同时主动比对新 research 与现有 DISTILLED 是否矛盾

⑤ **弱模型兼容设计原则定稿**（执行中）：Andy/Lisa AGENTS.md 关键/增强分层；DISTILLED 输出格式改为指令式（禁止 X，用 Y 替代）

**改进结果**：
- render-knowledge.py 正常运行，CODEBASE.md DISTILLED 10 条 pattern 写入成功
- Andy 具备调研→发现矛盾→写标记→蒸馏识别→更新知识库的完整闭环
- 五个 Kuzu 脚本的 SIGBUS 防御从「依赖正常执行路径」升级为「任意路径保证」

**沉淀建议**：
- 所有 Kuzu 脚本新建时必须用 `try/finally` 包住 `main()` 主体，不能只在末尾放 `os._exit(0)`
- re.sub 替换字符串来自外部内容时必须用 lambda 形式
- Agent 的学习协议（写标记触发更新）要区分强/弱模型场景，弱模型不会主动触发时系统不能因此崩溃

---

### 2026-03-28 Lisa 工程知识管道 + 约束自学习闭环（v512）

**现象**：Lisa 在实现过程中无法可靠获取平台约束知识。已知陷阱（Kuzu SIGSEGV / SIGBUS / 静默写入虚报）散落在系统工程师知识域，无结构化传递路径。约束一旦写入没有失效机制，库版本升级后约束可能过时但 Lisa 无法感知。

**根因**：
1. 工程约束无专用积累文件，系统工程师发现陷阱后只存在 CLAUDE.md 和 MEMORY.md，不进 Lisa 的上下文
2. `decisions` ChromaDB 的语义召回把约束（type=constraint）和普通决策混在同一 topK 池，跨领域任务时约束不被召回
3. 约束无生命周期，无失效/复核机制；Lisa 没有向系统反馈「约束已过时」的通道

**干预内容**：

① 新建 `docs/10-engineering-notes.md`：系统工程师持续积累实现陷阱，格式规范含状态字段（活跃/已失效/待复核）

② 新增 `constraint-recall` queryMode（context-sources.ts / context-handler.ts / index.ts）：
   - `queryAgentConstraints()` 查 decisions 集合过滤 `{type: constraint}`，topK=5，独立于 decision-memory 通道
   - Lisa 每次收到任务时自动注入 `【已知平台约束】` 区块

③ `distill-agent-memories.py` Lisa 分支接入 `10-engineering-notes.md`，双重优先级（时间+影响面），识别 `【约束验证】` 标记更新约束状态

④ `render-knowledge.py --agent lisa` 渲染目标改为 `CODEBASE.md`（不再写 MEMORY.md），保底层只放 3-5 条活跃约束

⑤ `~/.openclaw/workspace-lisa/AGENTS.md` 改为知识视角（不是检查清单），加约束验证协议：遇到可能过时的约束用 exec 验证，结论写入 `【约束验证】` 标记，进入 code_history → 下次蒸馏识别

**改进结果**：
- 约束有独立召回通道，不与普通决策竞争上下文名额
- Lisa 有主动验证和反馈约束时效性的协议，形成完整闭环
- 约束生命周期可观测：活跃/已失效/待复核 由 Lisa 验证结论驱动更新

**沉淀建议**：新框架实例部署时，`10-engineering-notes.md` 应作为标准文件随框架模板携带，初始为空，随实例运行逐步积累；`constraint-recall` queryMode 是通用能力，所有工程型 agent 均可使用。

---

### 2026-03-27 OpenClaw browser 工具配置落地（v499）

**现象**：在 `openclaw.json` 加入 `"mcpServers": { "playwright": {...} }` 后 Gateway 启动失败，日志报 "Unknown config keys - mcpServers"。

**根因**：OpenClaw 不支持外部 `mcpServers` 配置（网络博客给出的配置格式是错误的）。OpenClaw 内置了自己的 browser 工具（底层用 Playwright），正确的配置是顶层 `browser` 字段。

**修复**：
```json
"browser": {
  "enabled": true,
  "headless": true
}
```

**文档修正**：`docs/05-environment-setup.md` Step 5.5 / `docs/00-project-overview.md` / `docs/01-openclaw-reference.md` 中所有 "Playwright MCP" 描述统一改为 "OpenClaw 原生 browser 工具"。

**经验**：OpenClaw 配置变更前务必先 `openclaw config validate` 验证 schema，再重启 Gateway。`mcpServers` 是 Claude Code / Claude Desktop 的 MCP 配置格式，OpenClaw 格式完全不同。

---

### 2026-03-26 L1 欠债补全：person→person 人际关系边（v494）

**现象**：Lucas inject.md 只有个人档案（个人特质、沟通风格、在意的事），缺少人与人之间的结构性关系信息。Lucas 不知道妈妈和小姨是姐妹、爸爸是姐姐的爸爸等基本家庭结构，无法在跨成员场景中有效理解家庭动态。

**根因**：L1 设计时只定义了 person→topic 的知识图边（个人档案），未定义 person→person 边（人际关系）。Kuzu 中仅有 1 条手动写入的 `married_to` 边，且 RELATION_LABELS 未覆盖，无法渲染到 inject.md。

**干预内容**：

1. **新建 `scripts/init-family-relations.py`**：12 条 family_structure person→person Fact 边（婚姻×2 / 亲子×4 / 姐妹×2 / 姻亲×4），幂等可重复运行，运行后自动触发 render-knowledge.py
2. **更新 `render-knowledge.py` RELATION_LABELS**：新增 `spouse_of`（配偶）/ `parent_of`（子女）/ `child_of`（家长）/ `sibling_of`（兄弟姐妹）/ `in_law_of`（姻亲）/ `relationship_with`（预留动态关系）
3. inject.md 已更新，Gateway 无需重启（before_prompt_build 按请求读文件）

**改进结果**：inject.md 现包含人际关系节（配偶、子女、姐妹等），Lucas 收到任意家人消息时，system prompt 中有该成员与其他家人的结构性关系信息。

**沉淀建议**：家庭结构变化（新成员/关系变化）直接修改 init-family-relations.py 重新运行即可；动态关系（如近期家人间有摩擦）需 distill-memories.py 加 `relationship_with` relation 来捕捉。

---

### 2026-03-26 L3 组织运作优化首批实现（v492）

**现象**：设计文档 Overview § 五 L3 已完整，但代码层零实现——无跨成员扫描、影子 workspace 只有 BOOTSTRAP.md（已知死文件）、能力视图为空、HEARTBEAT 无链路健康审计。

**根因**：L2 实现时专注协作链闭环，L3 部分（组织运作优化）作为下一阶段设计，未同步实现。

**干预内容**：

1. **L3-A：Lucas 跨成员扫描**（index.ts before_prompt_build）
   - 新增 `scanCrossMemberContext(userId, prompt)` 函数
   - Lucas 私聊消息后，对 ChromaDB conversations 做语义搜索（cosine distance < 0.4、7天内、其他成员私聊）
   - 发现关联 → 注入隐私安全的协调提示，Lucas 自主判断是否协调
   - 同步修复：openai.json Anthropic provider `api: "anthropic"` → `"anthropic-messages"`（OpenClaw 版本升级导致的枚举值变更）

2. **L3-B：Andy HEARTBEAT 链路健康审计**
   - gateway-watchdog.js `buildHeartbeatContext()` 新增 Check 3 预计算：积压热点（pending skill-candidates 数量 + 领域分布）+ 近 14 天工具调用热力统计
   - Andy HEARTBEAT.md 新增 Check 4：评估积压超阈值（>3）时建议创建角色影子 + 识别零使用能力候选废弃

3. **L3-C：成员影子 workspace 模板**
   - 新建 `workspace-templates/member-shadow/SOUL.md` + `AGENTS.md`（含 `{{MEMBER_NAME}}/{{RELATIONSHIP}}/{{DESCRIPTION}}` 占位符）
   - `create_member_shadow` execute 函数改为从模板渲染，替代硬编码 BOOTSTRAP.md
   - 验证：测试分身 workspace 正确生成 SOUL.md + AGENTS.md，内容符合预期

4. **L3-D：成员影子能力视图**
   - 新增 `buildShadowCapabilityView()` 函数：execSync Python 查 Kuzu has_capability Facts，10 分钟内存缓存
   - before_prompt_build 针对 `agentId.startsWith("workspace-")` 的 shadow agent 注入家庭可用能力清单
   - 基础版：注入全量能力（14条），不做角色匹配过滤（高阶动态视图留待后续）

**改进结果**：L3 感知层（跨成员扫描）+ 自优化层（链路健康审计）+ 影子基础设施（正式 workspace 文件 + 能力视图）全部落地。

**沉淀建议**：
- BOOTSTRAP.md 是 OpenClaw 一次性引导文件，onboarding 后不再注入；影子 Agent 的正式人格需用 SOUL.md + AGENTS.md
- 跨成员扫描注入隐私安全提示（不暴露原文），让 Lucas 自主决策是否协调——这是比自动连接更安全的设计
- 链路健康预计算在 watchdog 侧完成，Andy 只做判断推理，不做数据查询——MiniMax 非交互场景不稳定的教训延伸

---

### 2026-03-22 Lucas 行为收紧：通道拥堵根因诊断 + 陪伴优先重塑

**现象**：Gateway 通道经常被占满，家人发消息 Lucas 响应慢甚至无响应。排查后发现：并非接入层问题，而是 Lucas 触发开发任务的门槛太低，积累了大量 Andy/Lisa 会话占用共享槽位。

**根因链**：
1. Lucas 门槛低，随手触发 → capability-registry 积累 10 条 active 任务
2. 每条任务 = Andy 的 MiniMax 会话，超时 300s，长期占用 Gateway 共享槽位
3. 多任务并发时共享槽位耗尽，Lucas 对话也排队等待
4. 加上历史 proactive 循环 bug（已修复），曾形成雪崩式增长（115+ 条并发请求）

**干预内容**：
1. **SOUL.md 加「第一原则：陪伴优先」**：Lucas 首先是家人，其次才是研发协调者；先理解真实诉求，再判断是否需要开发
2. **需求确认门槛**：情况A触发前必须过 6 项确认清单（做什么/给谁/交付物/触发方式/数据来源/紧急程度）
3. **夜间调度**：`trigger_development_pipeline` 加 `urgent` 参数，非紧急+白天写入 `task-queue.jsonl`，22:00 后 drain scheduler 串行消化
4. **Andy 串行**：`MAX_ANDY_CONCURRENT` 从 2 降为 1，彻底断绝并发雪崩
5. **槽位扩容**：Lucas 保留 5 槽，共享 5 槽（原 2+3），先保证陪伴通道畅通
6. **清空历史包袱**：capability-registry 10 条全部标记 suspended

**改进结果**：白天通道完全留给陪伴；开发任务夜间调度串行消化；Gateway 槽位不再被开发任务打满。

**沉淀建议**：
- 通道拥堵不一定是接入层或 Gateway 问题，先排查是否有大量后台任务占用槽位
- Lucas 的核心竞争力是「懂这个家」，而不是触发开发任务的速度。触发门槛低 = 信任成本高
- 「陪伴优先」要写在 SOUL.md 最显眼的位置（身份和家庭成员之后、所有技术规则之前），让它真正定调，而不是埋在 bullet list 里

---

### 2026-03-21 接入层第二轮修复：sendMessage msgtype 坑 + Gateway 资源池

**现象**：私聊和群聊回复全部静默失败（40008 invalid message type），用户发消息无任何反馈。同时 Andy 慢请求可以把 Gateway 拖死，Lucas 对话也一起挂掉。

**根因**：
1. `sendMessage` 只支持 `msgtype: 'markdown'`，不支持 `text`（40008）。之前的"修复"只是从 markdown 换成 text，没有解决根本问题。
2. 私聊被动回复应该用 `replyStream(frame, text)`（有 frame 对象），不应该用 `sendMessage`。
3. Gateway 所有 Agent 共用一个进程，Andy 的 MiniMax 慢请求积累会把 Lucas 的响应通道一起打死。

**干预内容**：
- **消息类型修复**：`sendMessage` 统一改为 `msgtype: 'markdown'`（私聊 + 群聊主动推送均适用）
- **被动回复修复**：私聊 `message.text` handler 改用 `replyStream(frame, text)`；群聊保持 `sendMessage(chatId, markdown)`
- **Gateway 资源池**：在 `crewclaw-routing/index.ts` 插件层加 Semaphore——Lucas 专属保留 2 个槽位，Andy/Lisa/其他 agent 竞争 3 个槽位；`before_prompt_build` 获取，`agent_end` 释放，120s 安全阀强制归还
- **send-to-group 补 bot 通道**：send-to-group 端点和 push-reply 群聊路径统一走 bot markdown，有降级
- **push-reply 群聊补 chatHistory**：群聊主动发送漏了 chatHistory 记录，补上

**改进结果**：私聊和群聊消息全部恢复正常回复。Lucas 响应不再被 Andy 排队阻塞。

**沉淀建议**：
- 企业微信 aibot `sendMessage` 只支持 `markdown`，这是平台硬约束，踩过一次别再碰 `text`
- 私聊被动回复（有 frame）用 `replyStream`；主动推送（无 frame）用 `sendMessage(markdown)`
- 多 Agent 共用同一 Gateway 时，必须在插件层做资源隔离，否则慢 Agent 会打死快 Agent

---

### 2026-03-21 企业微信接入层完整修复：私聊通道 + Actor 真实性

**背景**：HomeAI 投入家庭使用后，陆续暴露出接入层（wecom/index.js）的多处 actor 归属错误——Lucas 的消息以「系统工程师」身份发出，且内部记录也归错了角色。

**三个问题与对应修复**：

**① Bot 私聊回复走企业应用通道（显示「系统工程师」而非「启灵」）**

`wsClient.on('message.text')` 处理私聊时，回复路径为 `sendWeComMessage(fromUser, replyText)`（企业自建应用，发送方显示「系统工程师」）。机器人收到私聊 → 却以企业应用身份回复，用户看到的不是「启灵」。

**修复**：私聊回复改为 `wsClient.sendMessage(fromUser, { msgtype: 'markdown', ... })`。SDK 文档明确：`sendMessage(chatid, body)` 中，群聊填 chatid，单聊填用户 userid，两者共用同一方法。错误回复 fallback 路径一并修复。

**② Lucas 主动发消息（push-reply / send-message / send-to-group）全部走企业应用通道**

Lucas 通过 `send_wecom_message` 工具发消息、pipeline 异步通知、群播都走 `sendWeComMessage` / `sendWeComGroupMessage`，接收方看到的是「系统工程师」，且家庭成员若想回复，去企业应用通道回复会被 `/wecom/callback` 以「非业主单聊」直接拒绝。

**修复**：三个出口均改为「优先 bot 通道，bot 未就绪时降级企业应用」：
```javascript
if (globalBotClient && globalBotReady) {
  await globalBotClient.sendMessage(userId, { msgtype: 'markdown', markdown: { content: text } });
} else {
  await sendWeComMessage(userId, text);
}
```

**③ 降级时 actor 记录错误：chatHistory 不记录 Lucas 主动发送的消息**

即使通道修复，chatHistory 里也没有 Lucas 主动发出的消息记录。下次家人找 Lucas，他不记得自己说过什么（主动通知、任务完成告知等）。

**修复**：所有出口在发送成功后，以 Lucas 身份写入 chatHistory：
```javascript
appendChatHistory(chatHistoryKey(false, null, userId), '[启灵主动发送]', text);
```
`send-to-group` 同理写入群 chatHistory。**无论走哪个通道，actor 归 Lucas，不归系统工程师。**

另：今天通过系统工程师接口（curl）直接发的3条群消息（自我介绍/通道说明/@规则），事后手动补录进群 chatHistory，确保 Lucas 的记忆完整。

**沉淀建议**：
- 企业微信 Bot SDK 的 `sendMessage(userid, ...)` 同时支持单聊（填 userid）和群聊（填 chatid），不需要两套方法
- 降级是通道问题，不是 actor 问题——chatHistory 等内部记录的 actor 必须始终反映真实发送者
- 系统工程师直接调 API 发出的内容，如果内容代表 Lucas，事后必须补录到 Lucas 的 chatHistory

---

### 2026-03-21 系统稳定性三层修复

**背景**：HomeAI 运行在家用设备上，多次出现 Gateway「健康检查正常、LLM 请求永久挂死」的静默故障，消息无回复，且 `replyStream` 超时后没有任何错误日志，排查困难。

**三个根因与对应修复**：

**① replyStream 依赖时效性 response_code 导致静默丢失回复**

`wsClient.replyStream(frame, ...)` 需要 `frame` 里的 `response_code` 来关联原始请求。当 LLM 响应超过 60 秒时，`response_code` 已过期，`replyStream` 调用静默失败——既不抛异常，也不写日志，消息就消失了。

**修复**：`wecom/index.js` 所有回复路径从 `replyStream` 改为 `sendMessage`（群聊）/ `sendWeComMessage`（单聊）。`sendMessage` 是独立主动推送，不依赖原始帧时效，无时间限制。

```javascript
// 之前（有时效限制）
await wsClient.replyStream(frame, streamId, replyText, true);

// 之后（无时限）
if (isGroup) {
  await wsClient.sendMessage(chatId, { msgtype: 'text', text: { content: replyText } });
} else {
  await sendWeComMessage(fromUser, replyText);
}
```

**② MiniMax 并发超时级联导致 Gateway session pool 腐化**

多个并发 Andy 协作链同时向 MiniMax 发请求，全部在 300s 后超时，Gateway session 状态损坏，后续所有请求挂死。

**修复**：`crewclaw-routing/index.ts` 在 `runAndyPipeline` 入口加信号量，`MAX_ANDY_CONCURRENT=2`，超出时排队（不丢弃）并立即通知用户「已排队」。`finally` 块保证槽位释放。

**③ proactive 循环触发 ChromaDB 条目指数膨胀**

`trigger_development_pipeline` 每次调用都以新 UUID 写一条 `outcome=""` 的 ChromaDB 条目。主动循环发现 `outcome=""` 条目 → 提示 Lucas → Lucas 再调用 `trigger_development_pipeline` → 写新条目 → 无限增长。曾积累 115+ 条重复，触发 MiniMax 雪崩，进而导致 Gateway 挂死。

**修复**：proactive 消息模板改为「告知状态，明确禁止重新触发协作链，除非用户明确确认从未提交」。`markCommitmentNotified` 在 Gateway 调用前执行，即使 Gateway 失败也不会重新触发。

**三层修复后稳定性状态**：静默丢消息问题消除；Gateway 挂死时 watchdog 5 分钟内自动恢复；Andy 并发受控；proactive 循环不再膨胀。

**沉淀建议**：
- 企业微信 WebSocket 回复，一律用 `sendMessage`（主动推送），不用 `replyStream`（依赖时效 response_code）；被动回复看起来更「正规」，但在 LLM 响应慢时必然失败
- 任何会写 `outcome=""` ChromaDB 条目的工具，设计时就要考虑重入安全：多次调用是否会产生重复条目？proactive 循环会把所有 `outcome=""` 都拉出来处理
- 信号量 + 排队 > 直接拒绝（降级策略），用户体验更好，且防止请求丢失

---

### 2026-03-21 企业微信双通道设计约束确立

**背景**：HomeAI 使用两条企业微信通道——企业自建应用（HTTP callback）+ 智能机器人 aibot（WebSocket 长连接）。在设计「群消息无需@、Lucas以启灵身份回复」时，多次尝试方案B（让企业应用通道收到的群消息回复走机器人通道发出，使显示名为「启灵」），耗费大量 Token，最终确认技术路线不可行。

**发现过程（重要：防止后来者走弯路）**：
- 最初误判：只看到 `replyStream(frame, ...)` 需要 `frame` 对象，以为 SDK 只支持被动回复
- **实际：SDK 有 `sendMessage(chatid, body)` 方法，无需 `frame`，可主动向任意群/单聊推送消息**
- `sendMediaMessage(chatid, ...)` 同理，支持主动推送媒体消息

**正确结论（设计约束更新）**：
1. 群消息**@启灵**：机器人通道处理，`replyStream` 被动回复，显示「启灵」✓
2. 群消息**不带@**：企业应用通道接收 → Lucas 处理 → **`wsClient.sendMessage(chatId, ...)` 主动发出，显示「启灵」** ✓
3. 企业应用通道：非业主单聊 → 直接返回无权限提示，不转 Lucas ✓

**已实施**：wecom/index.js 中群消息的 Lucas 回复，已从 `sendWeComGroupMessage`（企业应用API，显示「系统工程师」）改为 `wsClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: lucasReply } })`（机器人通道，显示「启灵」）；机器人未就绪时降级为企业应用发送。wecom-entrance 已重启生效。

**代码落点**：`crewclaw/daemons/entrances/wecom/index.js`，`/wecom/callback` POST 处理的身份路由段

**沉淀建议**：
- 遇到企业微信通道能力问题，先完整读 SDK 的 `.d.ts` 类型声明，不要只看代码里已用到的方法
- `@wecom/aibot-node-sdk` 的 `WSClient` 同时支持被动回复（`reply*` 系列，需要 `frame`）和主动推送（`sendMessage`/`sendMediaMessage`，只需 `chatid`）

---

### 2026-03-21 Readme 系列文档维护职责归属厘清

**现象**：Readme 系列文档（HomeAI Readme / 01-09）的维护职责经历了三次迭代，前两次都走错了方向。

**演进路径**：
1. **最初想让 Andy 维护**：Andy 是方案设计师，参与架构决策，似乎应该维护设计文档。问题：Andy 是 embedded agent，运行时才存在，无法在会话之间主动维护文档；且 Andy 的视角是「方案」，缺乏对全局系统边界的掌控力。
2. **后来想让 Lucas 维护**：Lucas 持续浸入家庭，了解全貌，似乎合适。问题：Lucas 的职责是家庭成员服务，文档维护会污染他的语料方向；更重要的是，Lucas 无权改变系统本身的边界——他是系统里的角色，不是系统的建设者。
3. **最终明确：系统工程师（人 + Claude Code）维护**：Readme 系列是系统边界的定义文档——谁能改系统边界，谁维护这些文档。系统工程师是唯一能改变系统本身边界的角色，职责自然在此。

**根因**：早期对「角色职责」的理解停留在「谁最了解内容」，而不是「谁有权力改变系统边界」。职责归属应跟权力边界对齐，而不是跟知识深度对齐。

**改进结果**：宪法 §五、Readme 文档维护分工表、CLAUDE.md 约束区均已明确：Readme 系列由系统工程师（人 + Claude Code）维护，Lucas 不参与，Andy/Lisa 发现文档需要更新时通过 `/tmp/lisa_doc_request.md` 告知系统工程师处理。

**沉淀建议**：
- 新实例搭建时，不要尝试让 Lucas/Andy/Lisa 维护 Readme 系列——他们是系统里的角色，不是系统的建设者
- 文档维护职责 = 系统边界修改权限，两者绑定
- 这条演进本身说明：HomeAI 的系统工程师协作体（人 + AI）本身也是自进化+沉淀的体系，与它所构建的系统在结构上同构

---

### 2026-03-17 Lucas 输出质量修复

**现象**：Lucas 回复出现 `<|im_start|>` 乱码；部分工具调用意图被误分类；模糊需求直接转 Andy 而不先澄清。

**根因**：
- 乱码：stop token 配置缺失，模型输出未在正确位置截断
- 误分类：Layer 1 意图路由 prompt 对工具意图的描述不够明确，边界案例未覆盖
- 不澄清：Lucas BOOTSTRAP.md 中缺少「需求模糊时先澄清再转 Andy」的明确指令

**干预内容**：
1. 修复 crewclaw-routing 插件的 stop token 配置
2. 重写 Layer 1 意图分类 prompt，补充工具意图示例和边界案例
3. Lucas BOOTSTRAP.md 补充澄清原则：「需求描述不足以让 Andy 出方案时，先问清楚再转」

**改进结果**：乱码消失；工具意图误分类率降低；Lucas 开始在模糊需求上主动提问。

**沉淀建议**：
- stop token 问题是 Ollama 模型常见坑，新模型接入时必须显式配置
- Layer 1 意图路由的边界案例应积累为 DPO 负例，防止未来微调后回退
- 澄清原则应写入所有角色的 BOOTSTRAP.md，不只是 Lucas

---

### 2026-03-26 蒸馏管道重定位 + V字协作链反馈回路补全

**背景**：以「Andy/Lisa/Lucas 是角色，所有交互节点都需要设计」为镜，发现两类系统缺口：① MEMORY.md 蒸馏仍在堆积具体细节，与 ChromaDB 实时语义召回重叠；② V字协作链中 Andy→Lucas 设计摘要、Lisa→Andy 结果通知两个节点为空。

**蒸馏管道重定位**（`scripts/distill-agent-memories.py`）：
- Andy/Lisa `distill_focus` 从「堆全量细节」改为「提炼高层判断倾向 + 反复出现的模式 + 高层反思」，明确排除细节
- Lucas 新加入蒸馏管道：decisions(agentFilter=lucas) + behavior_patterns → MEMORY.md 蒸馏节
- `scripts/seed-constraints.py` 新建：14 条已验证平台约束写入 ChromaDB decisions（type=constraint）

**V字协作链反馈回路**（`crewclaw-routing/index.ts`，触发点 `trigger_lisa_implementation`）：
- **① Andy→Lucas**：调用时立即 fire-and-forget 推 spec 前 3 行摘要给 Lucas，不等 Lisa 完成
- **② Lisa→Andy**：Lisa 成功/失败后写入 Andy 决策记忆（outcome: implemented/failed），反馈回路闭合
- **③** outcome 填充率 99%，无需干预

**核心认知**：蒸馏 = 行为层面自我认知摘要，不是经验全量堆积；ChromaDB 实时召回覆盖细节层，两层不重叠。

---

### 2026-03-26 Kuzu 知识层架构欠债审计

**现象**：确立「Kuzu 是唯一真相源，蒸馏必须先进 Kuzu 再到文件」原则后，审计发现系统现状与原则存在三项系统性违背。

**欠债一：蒸馏绕过 Kuzu 直写 MEMORY.md**
`distill-agent-memories.py` 调用 `update_memory_md()` 直接写入 MEMORY.md，完全绕过 Kuzu。正确路径应为：ChromaDB → 蒸馏 → Kuzu pattern/decision 节点 → render-knowledge.py → MEMORY.md。根因：蒸馏脚本在架构原则确立前已实现，未同步修改。

**欠债二：render-knowledge.py 无工程侧渲染能力**
当前脚本只支持家人 inject.md（家人侧），不支持从 Kuzu pattern/decision 节点渲染 MEMORY.md（工程侧）。两条路径不对称，欠债一的修复依赖欠债二先实现。

**欠债三：capability 迁移标注 ✅ 但节点=0**
CLAUDE.md v464 标注 `capability-registry.jsonl → Kuzu capability 节点` 已完成，实际 Kuzu 中 capability 节点为零。active-capabilities Kuzu source 因此维持 ready=false 是正确的保护，但迁移断点需要排查。

**尚无干预，仅完成诊断**：三项欠债已纳入 CLAUDE.md【下次起点 v485】待执行任务，按依赖顺序排列。

**沉淀建议**：架构原则变更后，必须立即对已有实现做一次合规扫描——原则变了，旧代码不会自动变。「原则确立」≠「系统合规」，合规需要主动审计。

---

_后续干预记录由 Claude Code 在每次成功干预后主动追加。系统三大能力（记忆系统 + 角色系统 + 自进化系统）基本成熟后，开始系统性回顾与补录。_

---

### 干预记录 v491（2026-03-26）：L2.2 Skill + L2.3 闭环验证

**背景**：L2 规划中，best-practice-evaluation Skill 需要双层部署（实例层 + 框架层），flag_for_skill → Andy HEARTBEAT 结晶闭环需要端到端验证。

**L2.2：best-practice-evaluation Skill 双层部署**

实例层（`~/.openclaw/workspace-andy/skills/best-practice-evaluation/SKILL.md`）已在 v490 创建，框架层（`~/HomeAI/CrewHiveClaw/CrewClaw/daemons/workspace-templates/andy/skills/best-practice-evaluation/SKILL.md`）在本次补全。

Skill 内容：三步生态优先检查（① openclaw skills list → ② clawhub search → ③ 自定义实现），确保 Andy 出 spec 前不重复造轮子。框架层是新部署的基线，`initAgentSkillsDir` 启动时自动同步。

**L2.3：flag_for_skill → HEARTBEAT 结晶闭环验证**

验证路径：Lucas 调用 `flag_for_skill` → `data/learning/skill-candidates.jsonl` 写入 pending 条目 → gateway-watchdog 预计算注入 HEARTBEAT 消息 → Andy 读取并评估。

**关键发现：MiniMax 在无交互 HEARTBEAT 场景下不可靠调用 exec**

初版 HEARTBEAT.md 要求 Andy 自己用 exec 跑 Python 查询 Kuzu/读文件。测试发现：
- MiniMax 在 HEARTBEAT 无交互场景（37 秒内）直接返回 HEARTBEAT_OK，没有任何 exec 调用
- exec-approvals.json 确认 Andy 已有 python3/bash 白名单，白名单不是问题
- 根本原因：MiniMax 模型在 cron/watchdog 触发的无交互场景下倾向跳过工具调用

**修复：watchdog 预计算注入**

gateway-watchdog.js 新增 `buildHeartbeatContext()` 函数：
- 写临时 Python 脚本查 Kuzu，获取 `has_pattern.confidence >= 0.8` 候选
- 读 `skill-candidates.jsonl` 获取 pending 条目
- 两路数据注入 HEARTBEAT 消息内容（`【预计算数据 - 检查 N：...】` 格式）
- Andy 只需读文字做判断，不依赖 exec

HEARTBEAT.md 检查 1/2 同步改为「读取消息中的预计算数据」。

**验证结果**：Andy 正确评估 Kuzu 候选（判断已在 MEMORY.md）；正确评估 skill-candidates（做出能力交叉检查，发现与现有 homework 工具是不同场景，并向 Lucas 提出 3 个确认问题）。

**沉淀建议**：
1. MiniMax 在 cron/无交互触发场景下不可靠调用 exec——需要数据的场景，在触发方（watchdog/入口）预计算注入消息，而不是期望 Agent 自己 exec
2. 此模式可复用：任何需要 Agent 在无交互场景读取结构化数据的场景，都应在触发方预计算并注入

---

### 干预记录 v490（2026-03-26）：L2 基础设施补全

**背景**：L1 完成后进行代码审计，发现 Overview 与代码存在两处不一致。

**不一致一：Andy HEARTBEAT.md 使用废弃查询**

Andy HEARTBEAT.md 检查 1 仍在查询 ChromaDB `behavior_patterns skill_candidate=true`，但此字段已于架构演进中废弃（结晶候选信号改由 Kuzu has_pattern.confidence 代理）。这是「原则确立 ≠ 系统合规」问题的又一个实例。

**修复**：HEARTBEAT.md 检查 1 改为 Kuzu Cypher 查询：
```cypher
MATCH (a:Entity {id: 'andy'})-[f:Fact {relation: 'has_pattern'}]->(p:Entity)
WHERE f.valid_until IS NULL AND f.confidence >= 0.8
RETURN p.name, f.context, f.confidence
```
验证：当前返回 2 条候选（「推回优先于补全」「Spec 范围控制」，confidence=0.8）。

**不一致二：flag_for_skill 工具被 Lucas AGENTS.md 引用但未注册**

Lucas AGENTS.md 第 176 行指示 Lucas 在同类情况 ≥3 次时调用 `flag_for_skill`，但 index.ts 中从未注册此工具。OpenClaw 不会把未注册工具暴露给 Agent，指令变成空指针。

**修复**：在 index.ts 注册 `flag_for_skill` 工具（Lucas 专属），写入 `data/learning/skill-candidates.jsonl`（status=pending），同步更新 Andy HEARTBEAT.md 检查 2 读取此文件。

**沉淀建议**：角色人格文件（AGENTS.md/SOUL.md）引用的工具名必须与 index.ts 注册的工具名一一对应。新增工具规范流程：① index.ts 注册 → ② 更新 TOOLS.md → ③ init-capabilities.py 同步 Kuzu。反向（先写 AGENTS.md 再补工具）容易产生空指针指令。

---

## 2026-03-27 Kuzu SIGBUS 根因修复 + gateway-watchdog python3 路径修正

### 背景

系统偶发莫名挂死，根因追查到 Kuzu 在 macOS ARM64 上的已知 bug。

### 问题一：`_heartbeat_kuzu_check.py` 缺少 `os._exit(0)`

**现象**：gateway-watchdog 每次触发 HEARTBEAT 预计算（凌晨 2 点 Andy 日检）时，`_heartbeat_kuzu_check.py` 跑完自然退出，Python GC 析构 `kuzu.Database` 对象，触发 SIGBUS crash，watchdog 进程随之挂死。

**根因**：Kuzu 0.11.3 在 macOS ARM64 的 `Database::~Database()` 执行 checkpoint 时触发 SIGBUS。升级无解（已是最新版）。其他五个脚本（`distill-memories.py` 等）此前已有 `os._exit(0)` 修复，`_heartbeat_kuzu_check.py` 漏网。

**修复**：`_heartbeat_kuzu_check.py` 末尾追加 `os._exit(0)`。

### 问题二：`gateway-watchdog.js` 动态覆写脚本内容，使修复失效

**现象**：问题一的修复会被 watchdog 每次运行时覆盖——`buildHeartbeatContext()` 内联了 `_heartbeat_kuzu_check.py` 的完整内容并用 `fs.writeFileSync` 覆写该文件。

**修复**：在 `gateway-watchdog.js` 的 `scriptContent` 数组末尾加入 `os._exit(0)` 这一行，使动态生成的脚本也包含该修复。

### 问题三：PM2 非交互 shell 的 `python3` 解析到错误版本

**现象**：error log 出现 `ModuleNotFoundError: No module named 'kuzu'`。kuzu 安装在 Homebrew Python 3.11 下，但 PM2 非交互 shell 中 `/opt/homebrew/bin/python3` 软链指向 Python 3.14（无 kuzu）。用户 shell 里的 `python3` 是 zshrc 定义的 function，PM2 环境不继承。

**修复**：`gateway-watchdog.js` 顶部新增常量 `PYTHON3 = '/opt/homebrew/opt/python@3.11/bin/python3.11'`，替换所有三处 `python3` 调用（`execSync` + 两处 `spawn`）。

### 其他

- `gateway-watchdog` 进程已从 PM2 列表消失（此前某次挂死后未自动恢复），重新启动并 `pm2 save`。
- 约束已同步记录至 `CLAUDE.md`「已知外部平台约束」和 `MEMORY.md`。

---

## 2026-03-27 抖音提取正则修复 + Main 频道重构 + 外部文档存档（v501）

### 问题一：抖音 desc 正则静默失败（v.douyin.com/dOvBY-rzeIg/）

**现象**：Main 收到 Claude Code 技巧视频链接，9:45 无响应，9:59 再次发送同链接仍无响应。

**根因**：`scrapeDouyinContent` 中两处静默 `return null`（无日志），加 desc 正则 `[^"]{5,300}` 双缺陷：
1. 最大 300 字符上限——长文案视频 desc 超出直接失配
2. 不支持转义字符——desc 含 `\"10 倍\"` 时 `[^"]` 在引号处截断

修复：改为 `(?:[^"\\]|\\.)*`（无长度限制 + 支持转义），新增 `unesc()` 还原转义序列，两处静默 null 补 `logger.warn`。

### 问题二：Main 频道 "无法访问抖音" 误回复

**根因**：抖音 URL 未从转发给 Main Claude 的 content 中剔除，Claude 看到链接自然回复"无法直接访问"。
另，提取完成后错误地调用 `callGatewayAgent('lucas', ...)` 做总结，Lucas 是 Gateway Agent，与 Main（直接 Anthropic API）无关，绕了不必要的一圈。

**修复**：
- content 里 `replace(douyinUrl, '')` 再追加无 URL 的提示文字
- 提取完成后直接 `sendWeComMessage` push 结果，移除 Lucas 中转

**沉淀**：Main 频道（`handleMainCommand`）直接调 Anthropic SDK，与 Gateway Agent（Lucas/Andy/Lisa）是两套独立体系。Main 内的 fire-and-forget 后续动作应直接 push 给用户，不经 callGatewayAgent。

### 新功能：外部文档 Obsidian 存档

分享链接并等待提取完成后，发「存 cc」或「存 技术」触发存档：
- ClaudeCode 类 → `00-ClaudeCode配置/ClaudeCode外部经验参考/`
- 技术架构类 → `07-设计与技术外部参考/`
- 格式：frontmatter（source/date/type）+ Haiku 摘要 + 完整内容
- 30 分钟有效缓存；覆盖抖音/微信文章/YouTube 三种类型

---

## v515 · 2026-03-28 · 长流程任务机制实现

**干预类型**：架构优化（接入层重构）

**背景**：家人发视频给启灵，转录结果从未推送；两个同时到达的视频互相 abort stream；失败路径不写 chatHistory 导致文件成死数据。

**实现内容**：

- **新建 `task-manager.js`**：TaskManager 类，per-user Promise 链 mutex，三类 Worker（视频/图片/文件），Notifier（3 次重试），dead-letter 持久化
- **重构 `handleMediaMessage`**：立即 ACK（< 1 秒）→ 写 chatHistory → 入队；删除原有内联长流程逻辑（~200 行）
- **`gateway-watchdog.js` 补充**：每 5 分钟扫描 processing 超时任务自动重置
- **死数据处理**：三个失败视频转录补存，推送给 Lucas

**根治的 bug**：
1. response_url TTL 与处理时间竞争 → 立即 ACK 彻底消除
2. 并发媒体消息互相 abort stream → per-user 串行 mutex
3. 失败路径不写 chatHistory → 任务创建即写 ACK 条目
4. Whisper 推送无保障 → Notifier 重试 + dead-letter

**影响范围**：wecom-entrance（接入层），不涉及 Gateway/OpenClaw/三角色

---

## v516 — Lucas 语音输出管道（2026-03-28）

**类型**：功能扩展（接入层）

**背景**：Lucas 回复是 markdown，发给家人可以渲染阅读，但 TTS 朗读时符号破坏语气，无法自然表达情感类内容。用户提出「发给对话的人语音信息，文字是 MD 信息，但语音里不是的」，触发本次进化。

**变更内容**：

1. **`[VOICE]` 标记协议**：Lucas 判断「这段话适合被说出来」时在回复末尾加 `[VOICE]` 标记
2. **`stripMarkdownForVoice()` 函数**（index.js）：剥离 markdown 符号 + `[VOICE]` 标记，生成适合朗读的纯文字
3. **`[VOICE]` 检测路径**（index.js 文字回复段）：检测到标记后先发清洁文字，再 fire-and-forget 追加语音
4. **Lucas SOUL.md「声音模式」节**：何时加 `[VOICE]`（情感/叙事/提醒）、声音体写作规范（短句/口语连接词/`……`停顿/无 markdown）、正反示例
5. **复用现有 TTS 管道**：edge-tts MP3 → `uploadMedia(type='voice')` → WeCom 真语音泡泡（v496 已建，本次接入文字回复路径）

**设计原则**：
- 生成模态与输出模态解耦——SOUL.md 定义生成规范，入口层负责格式转换
- TTS 失败降级到文字，不影响主流程
- 复用而不重建：现有 `sendVoiceReply` 已完整，只加 strip + 触发路径

**影响范围**：wecom-entrance（接入层）+ Lucas SOUL.md（人格层）

---

## v517 · 统一 context-assembly 架构完成（2026-03-28）

**干预类型**：地基基础设施补全（系统工程师亲自介入）

**背景**：Layer 2（近期对话连续性）在修改前完全缺失——私聊每条消息冷启动，群聊用 historyPrefix 文本块 workaround（只影响 prompt 格式，不是真实 messages array）。这是 Lucas/Andy/Lisa 运行的地基欠债。

**变更内容**：

`wecom/index.js`：
- 删除 `buildHistoryPrefix()`（文本块 workaround）
- 新增 `buildHistoryMessages()`：从 chatHistory 文件读取近期对话，转换为 OpenAI messages array 格式，assistant 回复清洗 `[VOICE]` 标记并截断 300 字
- `callGatewayAgent` 新增 `historyMessages = []` 参数，prepend 到 messages array
- `callClaudeFallback` 同步更新（后备通道也支持历史）
- 5 个消息入口全部更新：`message.text` / `message.mixed`（纯文字）/ `message.mixed`（含图片）/ `message.voice` / `/api/wecom/forward`

`crewclaw-routing/index.ts`：
- `LUCAS_MSG_WINDOW` 20 → 40（容纳 15 轮历史 30 条 + 当前消息 + prependContext 注入余量）
- 移除 3 处 historyPrefix strip regex（before_prompt_build 1 处 + agent_end 2 处，已成死代码）

**验证**：私聊连发 3 条，Lucas 第 3 条准确回忆「小花」和「喜欢吃鱼」。chatHistory 文件持久化正常，重启后历史有效。

**意外收获**：私聊原来也是冷启动（per-message session），此次同时补上了私聊的 Layer 2。

**设计决策沉淀**：
- 成员影子 Agent 上线时，Layer 2 实现方式已定稿（模式 A：入口直连，`shadowHistoryKey()` 命名空间 + 路由判断，基础设施复用）
- Andy↔Lisa 多轮协作的 Layer 2 缺口已识别，触发条件：出现真实多轮场景时再动

**影响范围**：wecom-entrance（接入层）+ crewclaw-routing 插件（滑动窗口 + strip regex）

---

## v518 · chat-history.js 共享模块提取（2026-03-28）

**干预类型**：基础设施完备性补强

**背景**：Layer 2 实现完成后发现 chatHistory 逻辑绑定在 wecom/index.js，每个新渠道需重复实现，chatHistoryKey 也没有渠道前缀（将来难以区分来源、难以迁移格式）。

**变更内容**：
- 新建 `crewclaw/daemons/entrances/chat-history.js`：渠道无关共享模块，包含 `chatHistoryKey(channel, ...)` / `shadowHistoryKey(agentId, channel, ...)` / `appendChatHistory` / `buildHistoryMessages` / `loadChatHistory`；启动时 IIFE 自动迁移旧格式文件
- `wecom/index.js`：删除本地 chatHistory 定义，改为 `require('../chat-history')`，本地包装 `chatHistoryKey` 固定 `channel='wecom'`
- 历史文件：`user:X` / `group:X` → `wecom:user:X` / `wecom:group:X`，零损失迁移

**设计意图**：
- 新渠道（feishu / email）直接 require，不重复实现逻辑
- 影子 Agent 使用 `shadowHistoryKey()` 获得独立命名空间，Layer 2 基础设施开箱即用
- channel 信息编码在 key 里，跨渠道聚合按前缀即可，记录 schema 不需要回填

**影响范围**：wecom-entrance（入口层），新增共享模块

---

## v519 · chat-history.js threadId 多线程支持（2026-03-28）

**干预类型**：基础设施前瞻性预留

**变更内容**：
- `chatHistoryKey(channel, isGroup, chatId, fromUser, threadId='default')`：`threadId='default'` 时返回不带后缀的 base key（现有文件名不变），非 default 时追加 `:thread:{threadId}`
- `shadowHistoryKey` 同步增加 `threadId` 参数

**向前兼容**：现有所有调用不传 threadId，行为与修改前完全一致，历史文件无需迁移。

**预留用途**：
- Andy↔Lisa 多轮协作任务：`chatHistoryKey('agent', false, null, 'andy-lisa', taskId)`
- 影子 Agent 项目线：`shadowHistoryKey(agentId, 'wecom', false, null, userId, projectId)`
- 同一用户多话题分支（未来）

**影响范围**：`chat-history.js`（共享模块），无其他文件改动

---

## v520 — 图上下文组装 P1/P2 上线（2026-03-28）

### 变更内容

**context-sources.ts**：
- `pending-events`（Lucas）：`ready: false` → `ready: true`（P1-A/P2-B）
- 新增 `relationship-network`（Lucas）：KuzuSource，遍历 family_structure / relationship_with 边，返回相关家人的 current_status / recent_concern / cares_most_about / key_event，topK=12，inject=append-system（P2-A path B）

**index.ts**：
- Kuzu resolver 新增 `date()` 无参自动替换：执行前把 Cypher 中的 `date()` 替换为 `date('YYYY-MM-DD')` 字面量（Kuzu 0.11.3 不支持无参调用）

**数据层**：
- `distill-memories.py --force`：P1-C 迁移，新格式 topic 节点（`topic_{relation}_{slug}`）写入 Kuzu；旧格式节点保留，待 full refresh 清理

### 效果

Lucas 现在在 before_prompt_build 阶段会额外注入两类图遍历结果：
1. **pending-events**：inject.md 里渲染的「近期待跟进」，以 prepend 方式置顶
2. **relationship-network**：从 Lucas 出发，遍历家庭关系边，汇报每位相关家人的近况关注

### 影响范围

`crewclaw-routing/context-sources.ts`、`crewclaw-routing/index.ts`（resolver 层）、Kuzu 数据层

### 系统工程师干预记录

属于计划内架构推进（P1/P2 图上下文组装计划），非应急干预。

---

## v522 · HEARTBEAT 任务 3 双通道并行（2026-03-29）

**变更内容**：`~/.openclaw/workspace-lucas/HEARTBEAT.md` 任务 3「待处理语境跟进」执行步骤重构

**背景**：v520 启用 pending-events context-source（Kuzu 注入）后，任务 3 被改为「Kuzu 为空则跳过」。经评估发现信息茧房风险：Kuzu 蒸馏有最长一周延迟，家人本周内刚提到的事项无法被感知和跟进。

**决策**：恢复 recall_memory 作为并行通道，与 Kuzu 互补而非互相替代：
- 路径 A：Kuzu `【待跟进事项】` 块（结构化、有延迟）
- 路径 B：`recall_memory` 搜近 7 天对话（新鲜、无结构）
- 合并去重后执行跟进

**设计原则沉淀**：结构化数据源（Kuzu）有蒸馏延迟，不能替代实时语义搜索（ChromaDB recall_memory）。两者定位不同，在自主任务场景下应并行使用。

**影响范围**：`HEARTBEAT.md` 任务 3 步骤定义

---

## v524 · L3 Shadow Agent 架构定稿（2026-03-30）

### 设计决策

**核心定义**：Shadow Agent = Lucas + 该人关系上下文（per-person relationship context）。从外部看永远是 Lucas，Shadow Agent 是内部实现细节。不是独立 workspace，不是标签过滤，而是：
1. 专属 ChromaDB namespace（visitor:TOKEN），关系积累独立
2. 初始关系种子注入（邀请时携带 name/relation/scopeTags/behaviorContext）
3. 主动能力钩子（proactive capability hooks）
4. 持续演化的行为画像（evolving behavioral profile）

**废弃 workspace-demo**：Demo Agent（`agentId=demo`, `workspace-demo`）整体废弃，改为动态子 Agent。访客统一路由到 `agentId=lucas`，通过 visitor-registry 注入动态上下文。

**userId 命名变更**：`demo-visitor:TOKEN` → `visitor:TOKEN`

**visitor-registry.json**：新数据结构 `data/visitor-registry.json`，每个 token 对应 `{name, invitedBy, scopeTags, behaviorContext, status, expiresAt, shadowMemoryPath}`

**生命周期**：invite → active（积累中）→ dormant（N 天无互动）→ archived（蒸馏为 memory file）→ 再入（两条路径：A. 正式新邀请；B. 有机再入——在家人生活话题中再次出现，蒸馏管道检测 archived person 的新 Fact 边写入）

**Person 节点不删除**：状态变更而非删除，Fact 边 / Topic 关联永久保留。

**Kuzu 扩展字段**：Entity 节点新增 scope_tags / shadow_status / invited_by / shadow_memory_path

**家庭专有简化（标注）**：核心家人（爸妈/小姨）不需要 Shadow Agent，因为 Lucas 通过 Kuzu 注入 + ChromaDB 召回已足够深。Shadow Agent 主要服务外围关系（访客/朋友）。

### 实现任务

15 个任务建立于 Task 系统（#1-#15），分 A/B/C/D/E/F 组，从路由层到蒸馏管道全链路覆盖。

### 影响范围

`wecom/index.js`（路由）、`crewclaw-routing/index.ts`（插件层）、Kuzu schema、`distill-memories.py`、`gateway-watchdog.js`、docs/00-project-overview.md

---

## v548 — L3 Shadow Agent 访客分支实现完成（2026-03-30）

**15 任务全部完成**：

- **A1/A2（路由基础设施）**：visitor-registry.json 建立；gen-invite 升级支持结构化元数据
- **B1/B2/B3（插件层）**：isVisitorSession 路由；动态 registry 注入；ChromaDB 访客写入
- **C1（Kuzu schema 重建）**：DB 因 shutdown corruption 重建；新 schema 含 scope_tags/shadow_status/invited_by/shadow_memory_path；创建 init-kuzu-schema.py（含种子节点）
- **C2（init-visitor.py）**：邀请时自动写 Kuzu Person 节点，gen-invite endpoint fire-and-forget 调用
- **D1（distill-memories.py 访客分支）**：单 pass privacy_level=visitor；访客门槛降为 5 条；文件路径冒号处理
- **D2（watchdog 归档）**：每日凌晨 3AM 扫描 expiresAt 过期 → archived → 触发 distill
- **D3（revival 信号检测）**：蒸馏完成后检测 shadow_status=archived → revived + 写 pending-revival-signals.json
- **D4（revival 路径注入）**：B2 块读取 member-profiles/visitor_TOKEN.md 摘要并注入
- **E1（gen_visitor_invite）**：替代 gen_demo_invite，携带 name/invitedBy/scopeTags/behaviorContext 参数
- **E2（propose_knowledge_tag）**：标签治理闭环工具，与 flag_for_skill 对称
- **F1/F2（文档）**：docs/00-project-overview.md 新增两个 HomeAI L3 实现小节（访客 Shadow Agent + Andy↔Lisa 协作链质量升级）；CLAUDE.md v548 更新

**同期补录（Andy↔Lisa 多轮协作，原属本次 L3 范围）**：
- `consult_lisa`（Andy 专属）：spec 前可行性预判，避免设计无法实现的方案
- `request_evaluation` + `lisa-evaluator` 子 Agent：Lisa 完成后调独立 Agent 做客观验收，3 轮保护机制
- `report_implementation_issue` 3 轮保护：2 轮自修复失败强制上报 Andy

**Bug 修复**：`buildShadowCapabilityView()` 中 `while res.has_next()` → `for row in res` + `os._exit(0)`

**Kuzu DB 恢复路径**：停 watchdog → unload launchd → 删旧文件 → `init-kuzu-schema.py` → `init-family-relations.py` → `init-capabilities.py` → `render-knowledge.py` → 重启 Gateway + watchdog

---

## v553 · L3 设计文档补全 + L4 任务挂起（2026-03-30）

**干预类型**：文档补全 + 任务管理

**背景**：L3 实现代码已完成，但 00-project-overview.md 缺少最近三批实现的记录。

**新增内容（00-project-overview.md L3 章节）**：
- `HomeAI L3 实现：Spec 结构化与双评估器架构`——integration_points exists 卡点、andy-evaluator 设计质量门、双评估器串联
- `HomeAI L3 实现：感知侧升级——事件驱动增量蒸馏`——30 分钟冷却、fire-and-forget、delta_trig 内置阈值
- `HomeAI L3 实现：Skills 预检门与 Co-Pilot 自增强`——基础设施级 bigram 软拦截、行为模式主动沉淀规则

**缺口识别**：capability-registry.jsonl 新能力写入缺失（只有初始化 + 休眠检测，无交付后自动写入），已发单给 Lucas（req_cap_registry_001）走协作链。

**L4 设计任务挂起**：两条主线——本地模型化（云端 → 微调本地专精）+ Skill 固化（DPO → 内化 → Tool 下线）。触发条件：L2+L3 成熟模式积累到阈值后设计。

---

## v555 · ChromaDB 二次污染修复（2026-03-30）

**干预类型**：Bug 修复（插件代码 + 数据清洗）

**背景**：v539 的 ChromaDB 写入质量修复将取值来源从 `event.prompt` 改为 `event.messages[-1].user.content`，但未能真正解决问题——OpenClaw Gateway 在传递消息时，已将 `[Chat messages since your last reply - for context]\nUser: xxx\nAssistant: xxx` 多轮历史格式注入进 user message content 本身。因此提取出来的仍是污染内容，behavior_patterns / family_knowledge 持续以每天 50-115 条的速度积累脏数据，最终导致 behavior_patterns 49% 为污染记录，Lucas recall_memory 信噪比严重下降。

**根因定位**：`before_prompt_build` 的 `sessionPrompt` 存储逻辑（index.ts ~L3477）。`_lastUser = event.messages.find(user).content` 拿到的是 `[Chat messages...]\nUser: 实际消息` 格式，`typeof === "string"` 判断通过但内容已含前缀。

**代码修复**（index.ts `before_prompt_build`，~L3475-3492）：
- 在 sessionPrompt 存储前，检测是否含 `[Chat messages since your last reply` 前缀
- 含则解析：按行倒序找最后一个 `User: ` 行，取其后内容作为真正原始消息
- 不含则直接使用（单轮对话无注入）

**数据清洗**（3 个集合共删除 1127 条）：
- `behavior_patterns`：260 条污染删除，剩 263 条
- `conversations`：58 条污染 + 466 条双写重复删除，剩 662 条
- `family_knowledge`：343 条污染删除，剩 539 条

**蒸馏传播评估**：insights / decisions / agents / inject.md 全部干净。distill-memories.py 用 LLM 提炼摘要，即使源数据含前缀格式，生成的档案是整理后的自然语言，污染未扩散到蒸馏层。

**Gateway 重启**：已重启，代码修复生效。

## v569 · 幻觉污染防护 + DPO 用户纠正信号采集（2026-04-02）

**干预类型**：架构加固（蒸馏管道 + agent_end 信号采集）

**背景**：爸爸（启灵）在 2026-04-02 08:35 对话中指出幻觉记录会持续污染记忆蒸馏——已被识别的幻觉如果也进入蒸馏，错误会在 Lucas 认知里固化下来，形成正反馈闭环。Lucas 在 08:36 已自发将幻觉类型写入 `~/.openclaw/workspace-lucas/MEMORY.md` 的 `【幻觉污染识别】` 节，但这些标签与蒸馏管道之间没有任何连接。

**问题本质**：
1. ChromaDB 里已有 `dpoFlagged=true` 的幻觉记录，但 `distill-memories.py` 从未读取这个字段，照单全收
2. Lucas 的幻觉自省（MEMORY.md 标签）是孤立存在的，蒸馏 LLM 看不到，仍可能把幻觉行为提炼为「正确的 interaction_style」

**修复 1：蒸馏管道幻觉防护**（`scripts/distill-memories.py`）
- 新增 `load_hallucination_patterns()`：读 Lucas `MEMORY.md` 的 `【幻觉污染识别】` 节，提取幻觉类型标签及描述，注入蒸馏 prompt 的 `⚠️ 已知幻觉类型` 警告前缀
- 新增 `collect_dpo_flagged_records()`：蒸馏前扫 ChromaDB records，将 `dpoFlagged=true` 的记录剥离到 `data/learning/hallucination-filtered.jsonl`，LLM 蒸馏阶段不读这些记录
- `distill_user()` 在蒸馏循环前调用两个新函数
- 机制设计：Lucas 每次自省写入 MEMORY.md → 下次蒸馏自动生效，无需系统工程师介入

**修复 2：用户纠正信号 DPO 采集**（`crewclaw-routing/index.ts`）
- `config/dpo-patterns.json` 新增 `user_correction_signals`（18 条纠正信号：你骗我/这是幻觉/你没做等）
- 新增 `detectUserCorrection()`：检测用户消息命中纠正词组时，取前一条 Lucas 回复为 `bad_response`，写入 `data/learning/dpo-candidates.jsonl`（type=user_correction，confirmed=false）
- `agent_end` 新增调用点：FRONTEND_AGENT_ID + 非 test session 时触发

**文档同步**：`docs/00-project-overview.md` 四处更新（hook 表 / 2.2 蒸馏节 / 信号文件表 / DPO 名词速查）

## v570 · Main 监控三层协议（2026-04-02）

**干预类型**：监控架构设计（Main 角色重新定义 + 三层信号分层）

**背景**：Main 的 AGENTS.md/SOUL.md 是通用 OpenClaw 模板（讲 Discord/邮件/日历），与 HomeAI 无关。监控循环是"有异常就推"的简单报警器，没有信号分层，轻微质量问题和严重故障同等对待。系统工程师缺乏清晰的介入信号判断框架。

**核心设计**：三层监控协议

| 层级 | 触发条件 | Main 动作 |
|------|---------|---------|
| Layer 3 | PM2 进程不在线 / Gateway 不可达 / 质量问题 ≥5 条 | 立即推送工程师 |
| Layer 2 | 质量问题 1-4 条 / 轻微日志异常 | 追加到 HEARTBEAT.md 待汇总观察，每日日报 |
| Layer 1 | 一切正常 | HEARTBEAT_OK，不推送 |

**变更清单**：
- `~/.openclaw/workspace-main/SOUL.md`：重写为 HomeAI 监控代理身份（宁可少推原则）
- `~/.openclaw/workspace-main/AGENTS.md`：重写为 Step 1-4 监控协议（基础设施→质量扫描→日报→回复）
- `~/.openclaw/workspace-main/HEARTBEAT.md`：新增「待汇总观察」节 + 「上次日报发送」字段
- `wecom/index.js`：新增 `update_heartbeat` 工具（`append_observation` / `mark_daily_sent`）；heartbeat prompt 改写为三层决策协议

**未解决设计缺口**：介入信号→介入类型→介入动作的映射框架（工程师收到 Main 信号后，如何判断是改 AGENTS.md / 改代码 / 只观察）——待下次会话讨论。

---

## v579 — 系统恢复 + 访客身份识别修复（2026-04-04）

**触发**：系统工程师发现 Main 和 Lucas 均无响应（隔夜 WebSocket 中断后未完全自恢复）；访客系统出现身份混淆（赵昱被认成丁跃明）。

### Bug 修复 1：gateway-watchdog 进程缺失

`ecosystem.config.js` 遗漏 `gateway-watchdog` 进程定义，导致 Gateway 存活探测、访客归档、记忆蒸馏定时触发等功能全部缺失。已补录，`pm2 save` 持久化。

### Bug 修复 2：Bot→userId errcode=40008

私聊主动推送和 Main 监控推送两处代码尝试走 Bot 协议发 userId，始终 40008。根因：`botSent=true` 在 ack 失败前设置，fallback 永不执行。修复：两处均移除 Bot 尝试，直接走 HTTP API。

### Bug 修复 3：访客身份识别 case-sensitivity

`normalizeUserId()` 将 visitor token 小写化（`"db334c"`），但 `visitor-registry.json` key 为大写（`"DB334C"`），导致查找失败 → Lucas 无访客姓名上下文 → 幻觉。修复：`buildVisitorSessionContext` 改为 case-insensitive 查找。清除 DB334C 污染对话历史（7 条，Lucas 在其中幻觉称赵昱为"丁跃明先生"）。

### v605：时间戳统一（2026-04-08）

**背景**：`new Date().toISOString()` 返回 UTC（`Z` 后缀），Gateway 自身日志用 `+08:00` CST，导致日志/ChromaDB 时区混乱，同一时刻显示两种日期。

**变更**：`crewclaw-routing/index.ts` + `wecom/index.js` 新增三个 helper：
- `nowCST()` → `2026-04-08T02:15:44+08:00`
- `todayCST()` → `2026-04-08`（date-only）
- `agoCST(ms)` → N 毫秒前的 CST 时间（用于字符串 cutoff 比较，保持格式一致）

全量替换：index.ts 91 处、index.js 12 处；Winston logger timestamp 也改为 CST。

字符串 cutoff 比较（routing threshold 过滤）同步改为 `agoCST()`，保证 ISO 字符串排序正确性。

### v607：watchdog 三重保活 + cloudflared 重启策略（2026-04-08）

**变更背景**：cloudflared-tunnel 因网络抖动于 10:11 退出，PM2 `autorestart` 未能恢复（旧注册状态导致 pid=N/A，`pm2 restart` 无效）。静默断联近 2 小时后由系统工程师手动发现。

**变更内容**：`gateway-watchdog.js` 新增 cloudflared 保活逻辑：
- 探测 metrics 端口（`127.0.0.1:20241/metrics`）；进程存在且端口响应 = 正常
- 异常时执行 `pm2 delete cloudflared-tunnel + pm2 start ecosystem.config.js --only cloudflared-tunnel`（重新注册，而非 restart），规避旧注册状态问题
- 等待 8s 后复查，日志记录恢复状态

**设计决策**：cloudflared 用 `pm2 delete + start` 而非 `pm2 restart`，因为旧注册状态下 `pm2 restart` 不重读 ecosystem.config.js，pid 仍为 N/A。重新注册是唯一可靠的恢复路径。

---

## v610 — 自运转回路 + 全角色监控透明化（2026-04-09）

**触发**：系统工程师主动设计，目标是让组织能在无人值守下自洽运行，并在运行过程中对外完全透明。

**干预类型**：信息流转回路 + 目标闭环 + 监控架构补全

### Loop 1：外部知识感知提醒

`before_prompt_build` 新增 KNOWLEDGE_SHARE_RE 正则检测块：当 Lucas 私聊中检测到外部知识分享信号（文章、研究、行业洞察等关键词），向 Lucas 注入一条 `【知识感知提示】`，提醒他回复后可调用 `share_with_andy` 将内容路由给 Andy 消化。

设计原则：不强制触发，保留 Lucas 判断权；只在私聊 + 非访客 + 非群聊时生效。

### Loop 2：Andy 目标闭环

两层分离设计：

- **基础设施层**（`wecom/index.js`）：`runAndyHeartbeatLoop` 新增预计算，在 HEARTBEAT prompt 里注入当前 `in_progress` 目标列表（从 `andy-goals.jsonl` 读取）
- **行为层**（`HEARTBEAT.md`）：Check 0 拆成强制两步——第一步必须更新上轮 in_progress 目标状态（done/blocked/continued），第二步才生成新目标。保证目标池不因积压而失真。

### 全角色身份标记

系统工程师通道无法区分发言者（企业微信应用通道统一显示「系统工程师」）。各角色推送的消息头部增加身份前缀：
- Main：`📋 [Main → 系统工程师]`（监控告警）；对话回复加 `[Main]\n` 前缀
- Andy/Lisa：`notifyEngineer` 调用时 `fromAgent` 参数传入角色名，工程师通道日志可追溯

### Andy HEARTBEAT 透明化

`runAndyHeartbeatLoop` 的 `.then()` 改为 fire-and-forget 异步：HEARTBEAT 完成后，若结果不含 `HEARTBEAT_OK`（即有主动行动），自动通过 `sendLongWeComMessage` 推送到工程师通道，工程师可随时感知 Andy 在做什么而不阻塞 HEARTBEAT 主流程。

### notify_engineer 开放给 Andy / Lisa

工具注释从「Lucas 专属」改为「三角色通用」，Andy 和 Lisa 均可直接调用。触发场景：
- Lisa `report_implementation_issue`：遇阻上报时 + Andy 决策返回后各一次
- Lisa `request_evaluation`：发出请求时 + evaluator 结论返回后各一次
- Lucas 主动循环：循环执行后通知工程师

### Main 改进任务队列

新增 `log_improvement_task` 工具（`wecom/index.js`）：Main 监控发现系统改进点时写入 `data/main-pending-tasks.json`（格式：`id / priority / title / description / status / source`）。ClaudeCode 会话启动时自动读取 pending 任务列表，确保改进点不丢失。

**变更文件**：
- `crewclaw-routing/index.ts`：Loop 1 检测块、notify_engineer 注释更新、Lisa 两工具各 2 处 `void notifyEngineer()`
- `wecom/index.js`：全角色身份前缀、`log_improvement_task` 工具、Andy HEARTBEAT fire-and-forget、Lucas 主动循环通知
- `~/.openclaw/workspace-andy/HEARTBEAT.md`：Check 0 强制两步、巡检摘要末尾格式

**设计原则**：所有监控通知必须异步（`void notifyEngineer()` / `.catch(() => {})`），不阻塞主业务流程。

---

## v615 — Coordinator 并行任务模式正式激活（2026-04-09）

**触发**：系统工程师将 Coordinator 模式列为 L2 优先级特性，主动推进落地。

**干预类型**：L2 能力扩张（大特性并行实现架构）

**背景**：Coordinator 并行调度机制（`spawnParallelLisa` + `trigger_lisa_integration`）及 Andy AGENTS.md 的 C1-C4 完整指引早已实现，但以「等 L2/L3 更稳定」为由挂起。本次确认代码完整可用，补全 4 个生产级缺口后正式激活。

**核心设计**：Andy 写 spec 时，若满足任意一条触发条件（独立模块 ≥ 3 / AC 合计 ≥ 6 / 预估改动文件 ≥ 5），spec JSON 里加入 `use_coordinator: true` + `sub_specs[]`，`trigger_lisa_implementation` 自动走并行路径：

1. `spawnParallelLisa()`：`Promise.all` 并行调度 N 个 Lisa，各自处理独立子模块，结果写 `data/pipeline/{reqId}/`
2. 所有子任务完成后异步唤醒 Andy（新独立 session），Andy 综合验收
3. 需要胶水代码时调用 `trigger_lisa_integration`，触发集成 Lisa 处理跨模块接口连接

**本次补全的生产级缺口**：

| 缺口 | 修复内容 | 位置 |
|------|---------|------|
| 子任务无实时通知 | 每个子任务完成/失败后立即 `notifyEngineer` | `spawnParallelLisa` |
| Andy 聚合超时偏低 | 300s → 600s（与子任务超时对齐） | 聚合 `callGatewayAgent` |
| Coordinator 整体异常漏报 | catch 块补充 `notifyEngineer` | 异步 IIFE catch |
| pipeline 目录永久积累 | 凌晨 4 点，15 天 TTL 清理 | `gateway-watchdog.js` |

**设计决策**：并行子任务不重试——retry 在并发上下文中会叠出更多 Lisa 会话，失败直接记录，由 Andy 综合阶段决策修复还是降级。Andy 聚合 prompt 截断每个子任务结果至 600 字（足够判断），Andy 可用 `exec` 读完整的 `data/pipeline/{reqId}/{taskId}.json`。

**变更文件**：
- `crewclaw-routing/index.ts`：`spawnParallelLisa` 增加实时通知 + 超时调整 + 整体异常通知
- `HomeAILocal/Scripts/gateway-watchdog.js`：`cleanPipelineDirs()` + `schedulePipelineCleanup()`

**文档同步**：`00-project-overview.md` watchdog 检测表新增 cloudflared 行；`06-basic-version.md` watchdog 描述更新为"三重保活"。

---

## v619 — 访客影子生命周期 dormant 状态落地（2026-04-09）

**触发**：L3 访客影子机制补全最后一块——dormant 中间态。

**干预类型**：L3 基础设施完善（访客生命周期四态完整闭环）

**背景**：原有系统只有两种访客状态：`active`（对话中）和 `archived`（到期归档）。缺少中间态导致两个问题：① 30 天未回来的访客和「永久失联」的访客在系统眼里没有区别；② 「暂时沉默」≠「关系结束」——前者的邀请仍然有效，revival 应该无缝，不应触发蒸馏。

**dormant vs archived 的本质区别**：
- `dormant`：关系暂停，邀请仍有效，revival 无断层（对访客无感）
- `archived`：关系结束，触发蒸馏留档，再入需要历史摘要补偿

**实现三件事**：

**① gateway-watchdog.js `checkVisitorSilence()` 三条路径分离**：

| 路径 | 触发条件 | 行动 |
|------|---------|------|
| 路径 1（原有）| expiresAt 到期 | → archived + 蒸馏留档 |
| 路径 2（新增）| status=dormant + dormantAt 超 90 天 | → archived + 蒸馏留档 |
| 路径 3（新增）| status=active + lastInteractionAt 超 30 天 | → dormant，不蒸馏 |

新增 `markVisitorDormantInKuzu()`（与 `archiveVisitorInKuzu` 对称），fire-and-forget Python 脚本更新 Kuzu `shadow_status=dormant`。

**② index.ts agent_end**：

访客每轮对话结束后写 `lastInteractionAt = Date.now()` 到 visitor-registry.json，dormant 检测的数据来源。对话未发生时（首次邀请但未开口）不写，watchdog 跳过 dormant 检测。

**③ index.ts buildVisitorSessionContext**（revival 路径）：

访客打开 demo-chat 时：
- 检测到 `status=dormant` → 即时切回 `status=active`（写 registry + 记 `revivedAt` + 清 `dormantAt`）
- 异步 Python 脚本更新 Kuzu `shadow_status=active`
- 对访客完全无感，Lucas 接收完整上下文，无任何断层提示

**registry 新字段**：`lastInteractionAt`（毫秒时间戳）/ `dormantAt`（进入 dormant 时间）/ `revivedAt`（revival 时间）

**变更文件**：
- `HomeAILocal/Scripts/gateway-watchdog.js`：`markVisitorDormantInKuzu()` + `checkVisitorSilence()` 三路径 + 启动日志
- `crewclaw-routing/index.ts`：`unlinkSync` import + agent_end lastInteractionAt 更新 + buildVisitorSessionContext dormant revival

**文档同步**：`00-project-overview.md` 生命周期描述从「expiresAt 到期 → archived」升级为四态完整描述；实现路径表新增 D5 行；数据流从 3 段扩展为 5 段（新增「状态流转」和「dormant revival」独立说明）。

---

## v620 — Lucas 开发状态管控三项增强（2026-04-09）

**触发**：Lucas 对开发完成状态的感知全靠记忆传递，缺乏基础设施约束——协作链完成了但家人不知道是系统性缺口，不是偶发问题。

**干预类型**：L1 基础设施补齐（Lucas 开发管控闭环）

**背景**：原有系统只有【当前进行中任务】注入，覆盖了「任务在跑」这一半；但「任务完成了，Lucas 是否告知了家人」完全没有约束。Andy 会向 Lucas 发交付简报，但发出去之后有没有转达给家人、什么时候转达——全靠 Lucas 自己记，依赖模型记忆，不稳定。

**实现三件事**：

**① task-registry 新字段 + markTaskStatus 自动标记**：

`TaskRegistryEntry` 新增：
- `deliveryBrief`：Andy 验收完成时的家人语言简报（从 `Lucas交付：` 段提取，写入 task-registry）
- `lucasAcked`：Lucas 是否已主动告知家人（`false` = 待告知，`true` = 已告知）

`markTaskStatus("completed")` 时自动设 `lucasAcked = false`；brief 提取后同步回写 `deliveryBrief`。

**② 【待告知家人任务】注入块**：

`before_prompt_build` Lucas 私聊非访客时，除原有【当前进行中任务】外，新增【待告知家人任务】块：扫描 completed + lucasAcked=false 的任务，注入任务 ID + deliveryBrief，提示 Lucas「本次对话中择机告知，告知后调 ack_task_delivered 标记」。

**③ 新工具 `ack_task_delivered`** + 家人任务负载提示：

- `ack_task_delivered`：Lucas 告知家人后调用，将 `lucasAcked` 置为 true，注入块随即消失。支持精确 task_id 或关键词模糊匹配。
- 家人任务负载提示：原来访客繁忙检查的 `else` 分支为空（家人任务直接漏过）。现在非紧急家人任务 + 系统繁忙时，返回负载感知提示（非拦截，Lucas 自行决定是否立即提交）。
- `list_active_tasks` 更新：completed 任务显示 `[待告知]` / `[已告知]` 标签。

**根本意义**：把「是否告知家人」从模型记忆约束（不稳定）下沉到基础设施约束（每轮对话自动提醒，告知后才消失）——和承诺词铁律每轮注入的逻辑完全一致。

**变更文件**：
- `crewclaw-routing/index.ts`：`TaskRegistryEntry` 新字段 + `markTaskStatus` + brief 回写 + 注入块扩展 + 负载提示 else 分支 + `ack_task_delivered` 工具 + `list_active_tasks` 显示更新

**文档同步**：`00-project-overview.md` 协作链阶段可见性行 / 工具表 / Lucas 核心能力 / 数据流图 / 任务注册表描述；`HomeAI Readme.md` Lucas 角色列 + 协作段描述。

---

## v621 — 访客信息边界基础设施防护（2026-04-09）

**触发**：审计今日访客对话发现 Lucas 被社工攻击——访客用「介绍一下你的家庭成员」套出完整家庭档案（真名/单位/地点/个人规划），是 P0 安全问题。

**干预类型**：L1 安全补齐（访客信息边界从模型层下沉到基础设施层）

**根因**：只有工具层约束（哪些工具不能用），没有信息层约束（哪些内容不能说）。家庭档案完整注入 context，模型如实回答——架构性缺口，不是 AGENTS.md 规则没写够。

**实现两件事**：

**① `before_prompt_build` 访客 session 每轮注入【访客对话隐私边界】**（主，基础设施层）：

与承诺词禁令 / 静默原则同级——`appendSystem` 每轮重注，始终在最近上下文，不随 context 压缩漂移。访客都是爸爸邀请的朋友，基本信息（姓名/工作单位）可正常聊；保护的是个人规划、内部评价、系统架构信息、家庭通讯渠道等深层隐私。被追问敏感内容时，注入提供自然转移话术。

**② Lucas `AGENTS.md` 新增「访客对话分寸感」节**（辅，模型层）：

给 Lucas 一个可操作的判断标准：「这个信息发出去，爸爸看到会不会皱眉？会的话就别说。」明确可说内容（姓名/工作单位/日常生活）和需谨慎的内容（个人规划/内部评价/系统架构），配合基础设施层双重保障。

**根本意义**：把「哪些内容不对访客说」从依赖模型记忆 AGENTS.md 规则（不稳定，会随 context 压缩失效）下沉到基础设施层每轮注入——访客每次打开对话，铁律自动刷新。

**变更文件**：
- `crewclaw-routing/index.ts`：`before_prompt_build` 访客 session 分支新增隐私边界 appendSystem 块
- `~/.openclaw/workspace-lucas/AGENTS.md`：末尾新增「访客对话分寸感」节

**文档同步**：`00-project-overview.md` hook 表 `before_prompt_build` 行补访客隐私边界注入描述。

---

## v625 · L3 三元飞轮完整落地（2026-04-10）

**干预类型**：架构里程碑实现（L3 Phase 1-3 全部落地）

**背景**：L3 定义已于上次会话重构为「组织能力扩张飞轮」（理解→增强→演进三元循环），本次会话完成完整实现。同时修复 2026-04-08 目录重构遗留的 HOMEAI_ROOT 路径 bug（16 个脚本批量修复）。

**Phase 1 · 理解层（协作关系蒸馏）**：

新建 `distill-relationship-dynamics.py`：
- 从 ChromaDB `conversations` 集合拉取每个家庭成员的最近 60 条对话
- DeepSeek 提取四类协作边：`co_discusses`（共同关注）/ `requests_from`（依赖协作）/ `supports`（主动支持）/ `role_in_context`（协作角色）
- Upsert 到 Kuzu person→person Fact（`source_type=collab_distill`，`valid_until=today+90d`，初始 `confidence=0.75`）
- 关键设计：LLM 被明确告知 FROM 用户不能出现在 to_person 中（早期踩坑：LLM 把 FROM 用户自身当作协作对象返回 23 条错误边）

更新 `render-knowledge.py`：新增协作边查询（`r4`，过滤 `source_type=collab_distill` + `valid_until >= today`）+ 渲染「组织协作关系」节，插入到 inject.md `### Andy 的视角` 之后。

更新 `gateway-watchdog.js`：每周日凌晨 4am 调度（错开 2am 蒸馏 + 3am team_observation，避免 Kuzu 锁竞争）。

**Phase 2 · 增强层（最小可用）**：

inject.md 已渲染协作边 → Lucas 自然读取并在对话中引用。深化（`create_member_shadow` 主动读协作边）留待真实数据积累后验证设计再实现。

**Phase 3 · 演进环**：

`run_evolution_pass()` 接在 `distill_user()` 写新边之后自动运行：
1. 查询该用户所有活跃 `collab_distill` 边
2. 逐条调 LLM 推断状态（`resolved`/`ongoing`/`failed`/`unknown`）
3. Kuzu confidence 调整：resolved +0.1，failed -0.15，clamp [0.1, 1.0]
4. 写入 ChromaDB `shadow_interactions` 集合（含 Ollama nomic-embed-text 嵌入向量），doc_id 按日期 upsert

**HOMEAI_ROOT 路径批量修复**（16 个脚本）：

根因：目录重构后脚本从 `~/HomeAI/scripts/`（2层）移到 `~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/`（需3层），所有 `parent.parent` 计算指向空 DB。修复模式引入 `_SCRIPTS_DIR.parent.parent.parent` + `HOMEAI_DATA_ROOT` env var 支持。详见 `10-engineering-notes.md § 2026-04-10`。

**变更文件**：
- `HomeAILocal/Scripts/distill-relationship-dynamics.py`（新建，~500行）
- `HomeAILocal/Scripts/render-knowledge.py`（协作边渲染 + 路径修复）
- `HomeAILocal/Scripts/gateway-watchdog.js`（调度 + 路径修复）
- 其余 14 个 Python 脚本（仅 HOMEAI_ROOT 路径修复）
- `CrewClaw/crewclaw-routing/index.ts`（`read_file` / `list_files` 工具 + Fact 新鲜度标记）
- `Docs/00-project-overview.md`（L3 三元飞轮定义更新）

---

## v630 · Andy 工具链对齐 ClaudeCode（2026-04-11）

**背景**：系统工程师从星原AI学院抖音视频（ClaudeCode底层技术原理解析）中提炼 ClaudeCode 工具设计哲学——原子写入、精确读取、ripgrep 高性能搜索——并对照 Andy 当前能力差距，逐项补齐。

**新增 `write_file` 工具（Andy 专属）**：
- 原子写入：先写 `.tmp.{timestamp}` 临时文件，再 `renameSync` 到目标路径，写入失败不留脏文件（对标 ClaudeCode Write/Ride 工具）
- 路径安全：目标路径必须在 `~/.openclaw/workspace-andy/` 内，越权写代码库直接拒绝
- 相对路径支持：传 `specs/xxx.md` 自动补全为绝对路径
- 追加模式：`append=true` 走 `appendFileSync`，`false`（默认）走原子覆盖

**`search_codebase` 升级 ripgrep**：
- content 模式从 `grep -rni` 改为 `/opt/homebrew/bin/rg --no-heading -n -i`（ripgrep 15.1.0）
- 超时从 15s 收紧到 8s（rg 多线程 + SIMD，实际耗时 <1s）
- 对标 ClaudeCode Grep 工具（ripgrep 原生二进制，比 node grep 快 10-100x）

**补录 `read_file` / `list_files` 文档**：两个工具在 2026-04-10 随 L0 大文件能力新增，但未写入 Andy TOOLS.md，本次补录并确认 Andy 可用。

**工具数更新**：Andy 8→11，总计 32→35。

**变更文件**：
- `CrewClaw/crewclaw-routing/index.ts`（write_file 新增 + search_codebase rg 升级 + renameSync import）
- `CrewClaw/crewclaw-routing/context-handler.ts`（codebase-patterns switch case 补录，上次会话遗漏未 commit）
- `CrewClaw/crewclaw-routing/context-sources.ts`（ChromaQueryMode 联合类型补 "codebase-patterns"）
- `CrewClaw/crewclaw-routing/config/dpo-patterns.json`（上次会话遗漏未 commit）
- `Docs/00-project-overview.md`（Andy 工具表更新：write_file + search_codebase 描述更新）

---

## v631 · CrewClaw 框架化重构完成（2026-04-11）

**背景**：CrewClaw 框架核心主张是「框架层提供机制，实例层提供内容」。本次变更完成框架层代码的最后一批去硬编码——所有 Agent ID 全部替换为环境变量常量，使 crewclaw-routing 插件真正做到零硬编码 Agent 名，新部署只需配环境变量，不改框架代码。

**29 处硬编码 Agent ID 全部框架化**：
- `"andy"` 全部替换为 `DESIGNER_AGENT_ID`（环境变量 `DESIGNER_AGENT_ID`，默认 `"andy"`）
- `"lisa"` 全部替换为 `IMPLEMENTOR_AGENT_ID`
- `"lucas"` 全部替换为 `FRONTEND_AGENT_ID`
- 覆盖范围：agent guard 比较、corpus role 字段、decision memory agent 字段、notifyEngineer 第三参数、sub-agent 注册/驱逐、HEARTBEAT gate、research_task fallback、create_sub_agent tier 逻辑、query_member_profile fromAgent

**DPO 检测框架化**：
- 原有 `config/dpo-patterns.json` → 拆分为 `lucas-dpo-patterns.json` / `andy-dpo-patterns.json` / `lisa-dpo-patterns.json`（原文件保留为 tombstone）
- 新增 `getDpoPatterns(agentId)` 函数：Map 缓存 + 按 Agent ID 动态加载对应 JSON，全角色独立 DPO 模式，不混用

**变更文件**：
- `CrewClaw/crewclaw-routing/index.ts`（29 处硬编码替换 + getDpoPatterns 重构）
- `CrewClaw/crewclaw-routing/config/lucas-dpo-patterns.json`（新建）
- `CrewClaw/crewclaw-routing/config/andy-dpo-patterns.json`（新建）
- `CrewClaw/crewclaw-routing/config/lisa-dpo-patterns.json`（新建）

---

## v632 · Lucas↔Andy↔Lisa 双向协作通道（2026-04-11）

**背景**：三角色间原有通信是单向或半双工的——Andy 可通过 `query_requirement_owner` 主动找 Lucas 澄清需求，但 Lucas 无法主动联系 Andy 或 Lisa（只能被动等待，或走完整协作链）。观察到 Lucas 对双向通道不了解（他认为只能「单向提交需求」），决定补齐工具层并更新人格文件。

**新增 `ask_andy` 工具（Lucas 专属）**：
- 直接向 Andy 发出技术/设计/可行性问题，Andy 同步回答，不触发开发协作链
- 适用：了解系统现状、确认可行性、询问需求设计思路；不适用：正式开发需求（用 `trigger_development_pipeline`）
- 实现：agentId guard（非 FRONTEND_AGENT_ID 拦截）→ `callGatewayAgent(DESIGNER_AGENT_ID, prompt, 120_000)` → `notifyEngineer` fire-and-forget 通报工程师

**新增 `ask_lisa` 工具（Lucas 专属）**：
- 直接向 Lisa 咨询实现进展/代码细节，Lisa 同步回答，不触发协作链
- 适用：确认某功能是否已完成、了解代码层支持情况；不适用：Bug 修复（用 `report_bug`）、设计问题（用 `ask_andy`）
- 结构与 `ask_andy` 完全对称，调用 `IMPLEMENTOR_AGENT_ID`

**Lucas AGENTS.md 更新**：
- 触发 5 重命名为「Andy 需求澄清（Andy 主动找你）」（原触发 5 描述不清晰）
- 新增触发 6「主动咨询 Andy 或 Lisa（你主动发起）」：明确 ask_andy / ask_lisa 各自适用场景
- 新增「双向协作意识」段：Lucas 明确知道他不是单向接口，三通道的方向和触发条件

**三通道全通**：
| 方向 | 工具 | 触发方 |
|------|------|--------|
| Andy → Lucas | `query_requirement_owner` | Andy 遇需求歧义主动发起 |
| Lucas → Andy | `ask_andy` | Lucas 主动咨询技术/设计 |
| Lucas → Lisa | `ask_lisa` | Lucas 主动咨询实现/进展 |

**工具数更新**：Lucas 18→20，总计 35→37。

**变更文件**：
- `CrewClaw/crewclaw-routing/index.ts`（ask_andy + ask_lisa 工具新增）
- `~/.openclaw/workspace-lucas/AGENTS.md`（触发5重命名 + 触发6新增 + 双向协作意识）
- `Docs/00-project-overview.md`（Lucas 工具表新增两行 + 三角色直接协作通道小节）
- `Docs/HomeAI Readme.md`（角色描述段更新，补双向协作说明）

---

## v633 · 代码图谱化增强 Andy 代码理解 + 蒸馏全部改每日触发（2026-04-11）

**干预类型**：架构增强 + 调度策略变更

**背景**：Andy 在写 spec 时面临「只能搜文件、不能理解调用链」的结构性盲区。ripgrep 内容搜索能定位代码行，但无法回答「这个函数被谁调用」「它依赖哪些内部函数」。同时，所有蒸馏任务此前限制为每周日触发，实际上 DeepSeek/GLM 等云端 LLM API 费用压力小，每日触发的新鲜度收益更大。

**变更1：代码结构图谱（build-code-graph.py + Kuzu CodeNode/CODE_CALLS）**

- **新增** `HomeAILocal/Scripts/build-code-graph.py`：tree-sitter 解析 TypeScript、Python `ast` 解析 Python，提取函数/类/方法定义及调用关系，写入 Kuzu `CodeNode` 节点表和 `CODE_CALLS` 有向边表
- **全量构建**：9684 节点，39403 调用边，覆盖 1712 文件，耗时约 8 分钟
- **快速模式**：`--incremental --paths CrewClaw/crewclaw-routing HomeAILocal/Scripts`，89 文件，约 39 秒

**变更2：index.ts 三处修改（search_codebase + queryCodeStructure + proc.on("close")）**

- **新增** `queryCodeStructure(symbol)` 函数：内联 Python 脚本查 Kuzu，返回符号定义位置 + 调用者列表（最多 8 条）+ 被调用者列表（最多 8 条），遵循 `buildShadowCapabilityView` 模式，`os._exit(0)` 防 SIGBUS
- **更新** `search_codebase` 工具：新增 `scope=structure` 第四种搜索模式；从 query 用正则提取符号名，调 `queryCodeStructure`，返回 `【结构查询：symbol】` 块
- **更新** `proc.on("close")`：opencode 完成后，在 `codebase_observation` IIFE 之后追加图谱增量重建 IIFE，detached spawn `build-code-graph.py --incremental`，fire-and-forget，不阻塞主流程

**变更3：gateway-watchdog 每日凌晨 5 点触发代码图谱重建**

- 新增常量 `CODE_GRAPH_SCRIPT` / `CODE_GRAPH_LOG`
- 新增 `lastCodeGraphDay` 变量 + `shouldRunCodeGraph()` 检测函数（凌晨 5 点）
- 新增 `runCodeGraphRebuild()` 函数：spawn `build-code-graph.py --incremental --paths`，日志写入 `Logs/build-code-graph.log`
- `check()` 新增调用块：每日凌晨 5 点触发，与 1~4 点蒸馏任务错开

**变更4：蒸馏调度全部改每日**

去掉 gateway-watchdog 三处 `getDay() === 0` 限制（原为仅周日触发），改为每日凌晨触发：
- 凌晨 1 点：Andy/Lisa 每日自我进化链（`distill-design-learnings.py` + `distill-impl-learnings.py` + `distill-learning-objectives.py`）
- 凌晨 2 点：记忆蒸馏（`distill-memories.py`）+ Andy HEARTBEAT
- 凌晨 4 点：协作关系蒸馏（`distill-relationship-dynamics.py`）
- 背景判断：DeepSeek 等 LLM API 费用对业主可忽略，Sonnet 才是主要支出；每日触发保持图谱新鲜，L4 本地化后零成本

**变更5：watchdog 注释可读化**

将所有 Track A/C/D 等内部架构术语改为直接描述脚本功能的人话注释（如"Andy/Lisa 每日自我进化"），同时更新启动日志格式，去掉内部架构术语。

**凌晨时序总览（更新后）**：

| 时间 | 任务 |
|------|------|
| 凌晨 1 点 | Andy/Lisa 每日自我进化（三脚本依次 fire-and-forget）|
| 凌晨 2 点 | 家人记忆蒸馏 + Andy 自评（串行，Kuzu 锁协调）|
| 凌晨 3 点 | 团队洞察蒸馏（Andy 视角 → Lucas 上下文）|
| 凌晨 4 点 | 协作关系蒸馏 + 演进环 |
| 凌晨 5 点 | 代码图谱增量重建（~39s）|

**已验证**：check-plugin.sh 编译通过，Gateway 已重启生效；全量图谱构建完成（9684/39403）

**变更文件**：
- `CrewClaw/crewclaw-routing/index.ts`（queryCodeStructure 新增、search_codebase 更新、proc.on("close") 图谱重建 IIFE 新增）
- `HomeAILocal/Scripts/build-code-graph.py`（新建）
- `HomeAILocal/Scripts/gateway-watchdog.js`（每日 5am 代码图谱触发、蒸馏改每日、注释可读化）
- `Docs/00-project-overview.md`（search_codebase 四种模式、代码图谱基础设施节新增、蒸馏调度表全部改每日、proc.on("close") 补充⑤）
- `Docs/09-evolution-version.md`（本条目）

---

## v634 · Lucas 任务协调管理行为绑定（AGENTS.md 触发7）（2026-04-11）

**干预类型**：行为约束补全（AGENTS.md 漏洞修复）

**背景**：Lucas 任务管理的基础设施（注入块 + HEARTBEAT 任务3/6 + event-driven followup dispatch）在 v628 已全部就绪，但 AGENTS.md 从未明确规定"收到注入块之后，Lucas 该做什么"。结果是数据推进来了，但行为层没绑定——Lucas 不会主动提及进行中任务状态，pipeline 触发后不给家人时间预期，【待告知家人任务】不主动带出。这是典型的读取侧漏洞：写入侧（infra）完整，读取侧（AGENTS.md 行为规则）缺失。

**根因**：v628 的 Track D 反馈回路工作专注于写入侧（pipeline 完成后自动写 followup-queue），未做读取侧的 AGENTS.md 行为绑定。触发1~6 无任何"任务协调管理"触发。

**变更：AGENTS.md 新增触发7：任务协调管理**

四个信号绑定：

| 信号 | 触发条件 | 绑定行为 |
|------|---------|---------|
| A | 上下文含 `【当前进行中任务】` 且话题相关 + 距上次提交 >6h | 先调 `ask_lisa` 确认进展，再回复家人 |
| B | 刚调用 `trigger_development_pipeline` 成功 | 下一句必须给家人时间预期（「通常今晚完成，完成我通知你」） |
| C | 上下文含 `【待告知家人任务】` | 本次对话里自然带出，禁止留到下次 |
| D | 告知家人任务完成后，家人还未确认 | 下次对话自然问一句「好用吗？」，确认后才调 `record_outcome_feedback(completed)` |

**设计注意**：禁止在家人未确认前自行标 completed，也禁止忘记跟进让任务永远挂着。

**00-project-overview.md 更新**：Lucas 核心能力列表新增「任务协调管理」条目，描述四类行为绑定逻辑。

**变更文件**：
- `~/.openclaw/workspace-lucas/AGENTS.md`（触发7新增，行为绑定四信号）
- `Docs/00-project-overview.md`（Lucas 核心能力新增「任务协调管理」条目）
- `Docs/09-evolution-version.md`（本条目）

---

## v637 · Readme 系列文档全面刷新 + notify-engineer 全调用审计（2026-04-11）

**干预类型**：文档维护 + 代码审计

**背景**：系统经历多次模型变更（Main GLM-5→GLM-5.1、Andy/Lisa 模型互换修正）和架构演进（watchdog 5min、本地模型 Gemma 4、工具新增），但 Readme 系列文档中存在大量过时描述。同时 notify-engineer 调用链存在一处 fromAgent 缺失。

**文档修正**：

| 文件 | 修正项 |
|------|--------|
| `HomeAI Readme.md` | Main 模型 MiniMax-M2.7 → GLM-5.1 |
| `06-basic-version.md` | Andy/Lisa 模型互换修正、Main MiniMax → GLM-5.1、watchdog 每小时 → 每 5 分钟、Ollama embedding → ChromaDB |
| `00-project-overview.md` | Andy 模型路由 MiniMax → DeepSeek R1、Lisa 模型路由 GLM-5.1 → MiniMax M2.7、watchdog 间隔修正、本地模型表更新（+Gemma 4 / Spark-TTS）|
| `05-environment-setup.md` | 方案 B GLM-4 → GLM-5.1 |
| `08-claudecode-handbook.md` | Main MiniMax-M2.7 → GLM-5.1、工具数 10 → 21 |
| `CLAUDE.md` | 工具列表补齐（+ack_task_delivered / share_with_andy / forward_message / request_implementation_revision / trigger_lisa_integration）|

**代码修正**：
- `index.ts` L6096：主动调度排干通知补充 `fromAgent: FRONTEND_AGENT_ID`（原来缺省，默认为 "pipeline"）

**审计结论**：notify-engineer 全链路 28 个调用点均正确标识发送者身份，无遗漏。

---

## v641（2026-04-11）：Main 监控三层协议修正 + CrewClaw 骨架里程碑

**干预类型**：行为约束修正 + 里程碑记录

### Main 监控协议修正

**问题**：Main 监控循环每 30 分钟触发，旧的五步 prompt 要求 Step 6"已记录改进任务 → 按分层格式简述操作"，导致模型每次都生成描述性文字（"这步跳过、那步跳过"），永远不回 HEARTBEAT_OK，每半小时推一条冗余消息给工程师。

**根因**：prompt 设计给模型留了"解释自己做了什么"的空间，使得 Layer 1（正常静默）无法触发。

**修正**：
- 频率：30min → 4h（Layer 3 故障探测，4 小时内发现足够）
- heartbeatPrompt 重写为严格三层：Layer 3 紧急推送 / Layer 2 每日日报 / Layer 1 完全静默
- 铁律：除 notify_engineer 推送外，禁止生成任何面向工程师的文字内容

**设计原则确认**：监控 prompt 的静默路径必须是模型的「默认选项」，而不是需要模型主动判断"无问题"才执行的路径——把解释空间留给模型，模型就一定会用。

### CrewClaw 本地骨架里程碑（2026-04-11 闭环）

L0~L4 全部落地：
- L0：三机制管道（记忆/蒸馏/上下文注入）
- L1：四角色人格化（Lucas/Andy/Lisa/Main）
- L2：行为结晶（Skill/Tool 自动结晶 + 跨角色知识流动）
- L3：组织能力扩张飞轮（影子 Agent + 三元循环）
- L4：行为内化（SFT+DPO 双路径 + watchdog 周级自动扫描）

**下一阶段**：HiveClaw 多组织分布式层。触发条件：HomeAI 积累真实 DPO 数据。

---

## v642 · 工具调用幻觉检测机制（L1 级三道防线）（2026-04-11）

**干预类型**：L1 机制性增强

**背景**：Lucas 在读取 Obsidian 文件时出现严重幻觉——在文字里描述了完整的"读取过程"（编造路径 `/home/ubuntu/obsidian/`、声称"我找到了文件"），但实际上根本没有发出 `read_file` tool_call。用户发现后指出这是 L1 的关键能力问题，需要机制性解法而非头痛医头。

**核心认知**：幻觉从原理上无法消灭（token 预测机制，模型无法感知自己是否真正调用了工具），但**传播链可以切断**。幻觉若进入对话历史未被纠正，后续每一轮都在强化错误，ChromaDB 记忆写入后会被后续召回时再次激活——形成持久化幻觉循环。没有外部干预机制，幻觉会表现为 Lucas「固执地坚信自己读了文件」。

**变更（三道防线）**：

**防线 1 · 检测层（`agent_end`）**
- 新增 `detectToolCallHallucination()` 函数：机械对比 response 含「声称文件操作」短语（"我读了/我查看了/我找到了/我调用了..."）AND `toolUseCounts` 无 `read_file`/`list_files`/`search_codebase` 实际调用
- Lucas 专属，只在 `FRONTEND_AGENT_ID` 触发
- 命中后：① 写入 `dpo-candidates.jsonl`（`type: tool_call_hallucination`）② 追加 HEARTBEAT.md 待汇总观察 ③ 存入 `sessionPendingCorrections` Map

**防线 2 · 纠正层（`before_prompt_build` 下一轮注入）**
- 新增 `sessionPendingCorrections: Map<string, string>` 跨轮缓存
- 下一轮 `appendSystemContext` 注入纠正：「上一轮你说了 X，但没有实际调用工具。声称调用 ≠ 真实调用。」
- 注入后立即清除，不污染后续轮次
- 用外部基础设施替代模型自我纠察（不依赖模型元认知）

**防线 3 · 记忆保护层（`writeMemory` 写入前过滤）**
- 检测到幻觉的轮次，跳过 ChromaDB `conversations` 集合写入
- 防止幻觉内容进入记忆库，被后续召回时强化错误
- 消灭「持久化幻觉循环」的根本途径

**DPO 积累层（方向二）**：`tool_call_hallucination` 作为新 pattern 类型自动积累，走 L4 行为内化训练协作链。

**`lucas-dpo-patterns.json` 更新**：新增 `tool_call_hallucination` 字段，22 个声称操作短语覆盖"我读了/我查看了/我找到了/读取了文件/工具已调用"等变体。

**代码变更文件**：
- `CrewClaw/crewclaw-routing/index.ts`：`DpoPatternsJson` 接口新增字段、`detectToolCallHallucination()` 函数、`sessionPendingCorrections` Map、`before_prompt_build` 纠正注入、`agent_end` 检测调用 + 记忆保护
- `CrewClaw/crewclaw-routing/config/lucas-dpo-patterns.json`：新增 `tool_call_hallucination` 字段

### v649 · 2026-04-12 · Lx 评估框架对齐 + 数据驱动模型评测 + 告警等级

**系统工程师越界干预**：L0~L4 评估维度重新定义（从旧定义到新口语化定义），evaluate_local_model 从硬编码改为数据驱动机制，Main/Andy 推送加告警等级。

**Lx 评估框架对齐（v646）**：
- L0 基础设施（稳不稳）：新增软硬件性能评估（磁盘/内存/Gateway 延迟/ChromaDB 延迟）
- L1 行为质量（好不好）：输出分【记忆质量】+【输出质量】两维度
- L2 系统自进化（自身能力越来越强）：输出分【开发协作链成效】+【自进化机制运转】+【喂养成效】
- L3 组织协作进化（组织运作越来越优化）：新增成员增强效果检查
- L4 深度学习（内化能力越来越强）：新增 evaluate_local_model 模型能力评估

**数据驱动模型评测（v648）**：
- evaluate_local_model 从硬编码 9 条家庭任务题 → 从实例数据自动生成
- Kuzu 家人事实 → Main 生成自然语言知识题（0.4 权重）
- ChromaDB 真实对话 → 直接用 user message 测对话能力（0.6 权重）
- 零硬编码题目，第二个部署有数据就能跑

**告警等级（v649）**：
- Main 推送格式：`[Main 监控报告] 告警等级：🔴/🟡/🟢`
- Andy 推送格式：`[Andy HEARTBEAT 报告] 告警等级：🔴/🟡`
- 告警等级从回复内容自动判定

**Andy ARCH.md 同步更新**：Lx 新定义 + Kuzu relation 枚举（8→14+种）+ 模型配置（GLM-5→GLM-5.1）

### v651 · 2026-04-12 · Andy HEARTBEAT 预计算补全 + 系统思考者转型 + skill-candidates 积压清理

**Andy HEARTBEAT 预计算补全**：
- wecom/index.js 新增预计算：behavior_patterns（ChromaDB, agent=andy, limit=20）、knowledge_injection（decisions, type=knowledge_injection, limit=10）、学习状态（andy-learning-state.json）
- HEARTBEAT.md 检查 5（行为规则自检）和检查 7（知识注入消化）改为读取预计算数据，不再依赖 exec 查 ChromaDB
- 绕过 OpenClaw exec allowlist 限制，Andy HEARTBEAT 不再因 exec 权限失败

**Andy 系统思考者转型**：
- 新增 HEARTBEAT 检查 8「主动学习——设计来时路消化」：每 7 天读一篇 Obsidian `04-系统工程师关键决策记录/`，提炼设计洞察写入 decisions（source=proactive_learning）
- SOUL.md 新增信念「理解设计来时路，才能写出有判断力的 spec」
- AGENTS.md 增强行为新增「理解设计来时路」原则
- 学习状态预计算注入 HEARTBEAT prompt（已读文件列表 + 距上次天数）

**skill-candidates 积压清理**：
- 87 条 auto_detect 噪声全部标记 rejected（75 种不重复组合，最高频仅 4 次，均为正常工作流）
- auto_detect 门槛提高：≥2 工具 → ≥3 工具，去重窗口 24h → 7 天，新增排除 list_active_tasks
- 预期积压速率从每天 ~15 条降到接近零

### v650 · 2026-04-12 · 上下文注入优化 + 访客隐私机制重设计

**上下文注入优化**：
- 删除 `queryRelevantTopics` 重复调用（hook 和 queryMemories 各调一次 → 只保留 queryMemories 内）
- 新增 `queryPersonDistilledFacts()`：主动从 Kuzu 查询提到的家人的 `current_status`/`recent_concern`/`key_event`/`cares_most_about` 事实
- 因果关系从 queryMemories 内部移至 context-sources 独立注入（Kuzu causal_relation 独立 Cypher 查询）
- Lisa 新增 codebase-patterns 知识源（与 Andy 对齐）

**访客上下文一致性**：
- 设计转变：从输入侧限制（`!isVisitorSession` 守卫）改为输出侧过滤
- 访客与家人享有同等上下文注入（记忆检索、受众感知、行为规则等全部开放）
- 新增输出级隐私过滤：agent_end 检测回复中的隐私泄漏 → 下一轮注入纠正指令 → 泄漏轮次跳过 ChromaDB 写入
- 隐私模式配置化：`config/visitor-restrictions.json` 的 `privacyPatterns` 数组，实例层管理

**代码图谱扩展**：
- `build-code-graph.py` 新增 C++ 解析（tree-sitter-cpp），支持 `.cpp/.h/.c/.hpp` 文件
- 新增 JavaScript 解析（复用 TypeScript parser）
- 扫描范围从 `PROJECT_ROOT` 扩展到 `HOMEAI_ROOT`（覆盖 hermes 等 C++ 代码库）
- watchdog 凌晨 5 点增量重建路径更新

**Lucas 上下文优先级重排**：
- 注入顺序：自我认知 > 受众认知 > 最近对话 > 回忆/背景知识
- 大量 prepend 源迁移到 appendSystem（conversations、decisions、behavior_patterns 等）
- 仅保留 user-profile（受众）和 app-capabilities（工具）为 prepend

---

## v658 · 项目三问认知校正 + Lucas 可靠性差距分析（2026-04-13）

**干预类型**：认知校正 + 探索分析（非代码变更）

**背景**：v657 会话中，系统工程师发现近期架构决策（v629-v657）偏离了项目初衷——大量决策被放在「让 HomeAI 更好用」的框架下评估，而非回答三个核心问题。

**认知校正**：

1. **项目三问**（架构决策校准标准）：
   - ① 开发即交付，交付即开发是什么样的？
   - ② Agentic Team / Organization 应该怎么运作？
   - ③ AI 时代，研发团队何去何从？
   - HomeAI / 小姨公司 / 自己管理的部门 = 三个验证项目，不是目的本身
   - 本质：AI 变革带来的社会实验的一部分

2. **Main 定位校正**：Main 不是为了抢系统的工作多做，而是保留系统演化的「明白人」把控，不是限制自我发展。脚手架是过程态，逐步下沉能力给三角色。

3. **Lucas 受众自适应**：不是「隐藏技术细节」这么简单——Lucas 要看人说话，根据每个人的认知背景用她能理解的方式沟通。对爸爸可以讲逻辑，对妈妈直接说结果，对小姨要说跟她的关系。

4. **运行即测试**：不需要额外加回归测试机制。Main evaluate_l0~l3 = 系统级测试，三角色的日常运作 = 功能级测试，家人反馈 = 验收测试。

**Lucas 可靠性差距分析（探索完成）**：

差距不在模型（模型还是那些模型），在于工程可靠性。Claude Code 可靠是因为有原子化工具、精确读写、ripgrep 搜索等工程模式。

- 工具层：21 个 Lucas 工具中 agentId 守卫不一致（一半硬检查一半 description 文本）、fire-and-forget 异步链缺乏确认、返回格式不统一
- 上下文层：40 个注入块 / 50-70K tokens 系统提示，MEMORY.md 双注浪费 16-24K tokens，人物信息 6 块重复，承诺规则三重注入
- 行为层：AGENTS.md 暴露内部术语（Andy/Lisa/pipeline），未实现受众自适应

**下次任务**：Lucas 可靠性增强——工具层加固 + 上下文精简 + AGENTS.md 封装性。

**文档变更**：
- `Obsidian/04-系统工程师关键决策记录/2026-04-13-项目三问与认知校正.md`（新建）
- `CLAUDE.md` v658（下次起点更新 + 项目三问 + Main 定位校正 + 运行即测试 + 受众自适应）
- `Docs/09-evolution-version.md` 本条目

**未修改文件**：无代码变更，本次纯认知校正 + 探索分析

---

### v659：Main 评估体系升级——数值化评分 + Web 仪表盘（设计提案）

**日期**：2026-04-13

**类型**：架构升级（Main 工具 + 前端仪表盘）

**背景**：Main 的 evaluate_l0~l4 全部使用 emoji 三档评分（✅/⚠️/❌），无数值化分数，无历史记录，无法追踪趋势。业主要求 Main 评估时自动提供图形化分析，且以 Web 应用形式在企业微信访问。

**变更**：

1. **新建 `config/evaluation-rubric.json`（框架层配置）**
   - L0~L4 共 31 个子维度，每个含 name / weight / direction（enum / higher_better / lower_better）/ threshold→score 映射
   - 评分规则：0=缺失, 1=较差, 2=偏低, 3=合格, 4=良好, 5=完美
   - pass_threshold：L0=3.0, L1=3.0, L2=2.5, L3=2.0, L4=2.0

2. **重构 evaluate_l0~l4（`wecom/index.js`）**
   - 保持所有检查逻辑和文本输出不变
   - 每层末尾新增文本解析评分块：从 results 数组提取原始指标值 → 对照 rubric 阈值 → 输出 0-5 分数
   - 每层加权均分，文本末尾追加 `· X.X/5.0`
   - 内部返回结构化评分对象供 evaluate_system 消费

3. **新增 evaluate_trend 工具（Main 专属）**
   - 读取 `evaluation-history.jsonl`，输出趋势方向 + 关键卡点分析
   - 自动附 Web 仪表盘链接

4. **evaluate_system 增强**
   - 收集 L0~L4 结构化分数，生成含数值的评分卡
   - 写入 `evaluation-history.jsonl`（历史可追溯）
   - 自动附 Web 仪表盘链接

5. **Web 仪表盘（`/eval-dashboard`）**
   - 公网 URL：`https://wecom.your-domain.com/eval-dashboard`
   - Chart.js 交互式图表，暗色主题，手机友好
   - 四模块：总体评分（L0-L4 均值）→ 趋势折线图 → 子维度柱状图 → 关键卡点列表
   - 数据 API：`/api/eval/history`（JSONL → JSON 数组）
   - 通过 Cloudflare Tunnel 企业微信直接访问

6. **Co-Pilot 化交付**
   - evaluate_system / evaluate_trend 返回自动附带 `[交互式仪表盘](URL)` markdown 链接
   - Main 在企业微信回复时，业主点链接即可跳转浏览器查看图形化分析

**设计原则**：
- 评分逻辑在代码（确定性），rubric 阈值在配置（可调整），历史在文件（可追溯）
- Main 跑 GLM-5.1，不依赖 LLM 判断来评分——纯代码逻辑
- 仪表盘是前端渲染（Chart.js CDN），后端只提供数据 API

**修改文件**：
- `CrewClaw/crewclaw-routing/config/evaluation-rubric.json`（新建）
- `CrewClaw/daemons/entrances/wecom/index.js`（评分框架 + evaluate_l0~l4 重构 + evaluate_system 增强 + evaluate_trend 新增 + 仪表盘路由）
- `~/.openclaw/workspace-main/AGENTS.md`（工具列表 + 触发词更新）

---

### v660：L2 内涵刷新——Vibe Anything + 自进化飞轮

**日期**：2026-04-13

**类型**：架构设计升级（Lx 评估体系）

**背景**：L2 原定义「系统自进化」过于偏重工程侧（pipeline 成功率、蒸馏机制运转），忽略了价值本质——Coding 只是手段，家人需要的 Any Thing 才是目的。业主要求 L2 内涵刷新为两个正交维度：Vibe Anything + 自进化飞轮。

**设计**：

L2 = Vibe Anything × 自进化飞轮（乘法关系）

- **维度 A：Vibe Anything**（家人要什么，系统造什么）
  - `task_type_coverage`：任务类型覆盖度（成功交付过的任务类型数，越高系统越万能）
  - `delivery_success_rate`：端到端交付成功率（从需求识别到家人满意的完整链路）
  - `deliverable_diversity`：交付物多样性（app/文件/报告/提醒/研究/洞察…，不限于代码）

- **维度 B：自进化飞轮**（越用越强）
  - `evolution_signals`：进化信号积累（skill-candidates + dpo-candidates 合并指标）
  - `knowledge_internalization`：知识内化率（蒸馏产出 + 代码库洞察）
  - `skill_count`：Skill 积累总量（三角色合计）
  - `andy_heartbeat_check`：Andy HEARTBEAT 巡检时效

**与旧版变化**：
- 新增 3 个维度A子维度（任务类型覆盖度、交付成功率、交付物多样性）
- 合并 skill-candidates + dpo-candidates → 进化信号（一个指标，消除重复）
- 合并 codebase_patterns + opencode_success_rate → 端到端交付成功率（从"能不能跑"升维到"家人满意不满意"）
- 输出分组从「协作链成效 / 机制运转 / 喂养成效」改为「Vibe Anything / 自进化飞轮」

**修改文件**：
- `CrewClaw/crewclaw-routing/config/evaluation-rubric.json`（L2 7 个子维度重新定义）
- `CrewClaw/daemons/entrances/wecom/index.js`（evaluate_l2 全面重写）
- `Docs/HomeAI Readme.md`（Lx 里程碑描述更新）
- `Docs/09-evolution-version.md`（本条目）
- `CLAUDE.md`（动态区 v660 + L2 新定义引用）

---

## v664 · L2 双维度缺口补全 + Main 评估回流 + 调度时序重排（2026-04-14）

**变更类型**：架构增强 + 设计补全

### 背景
L2 定义为双维度（Vibe Anything × 自进化飞轮）后，对照实际系统发现五个缺口。

### 改动
1. **Lisa L2 角色定义**：三角色体系中 Lisa 是双维度桥梁——Vibe Anything 交付手 + 自进化飞轮信号源。`00-project-overview.md` + `HomeAI Readme.md` 补入。
2. **回流机制文档化**：五条已实现回流路径 + 新增第六条 Main 评估回流。`00-project-overview.md` 新增「双维度回流机制」段。
3. **skill-candidates 消费端修复**：Lucas 写入 skill-candidates.jsonl，Andy HEARTBEAT 注入中新增读取逻辑（`index.ts`）。
4. **Main 评估回流 Andy**：Andy HEARTBEAT 注入读取 `evaluation-history.jsonl` 最后两条记录，退步维度高亮（`index.ts`）。
5. **evaluate_l2 对齐**：工具描述 + AGENTS.md 汇报格式从旧三问更新为双维度。
6. **调度时序重排**：Andy HEARTBEAT 从凌晨 2 点移至 6 点（例行动作最后），Main evaluate_system 凌晨 1 点 fire-and-forget，给足 5 小时完成。L4 DPO 从周一 6 点挪至 7 点。
7. **L2 基线首次测量**：覆盖度 0（task-registry 无 completed）、opencode 100%、交付物 ≥4 种、Andy HEARTBEAT 定时执行正常、andy-learning-state 不存在（主动学习未产出）。

### 文件
- `CrewClaw/crewclaw-routing/index.ts`：Andy HEARTBEAT 注入（skill-candidates + Main 评估回流）
- `CrewClaw/daemons/entrances/wecom/index.js`：evaluate_l2 工具描述更新
- `HomeAILocal/Scripts/gateway-watchdog.js`：调度时序重排 + Main 预评估独立任务
- `HomeAILocal/Config/scheduled-tasks.json`：新增 main-pre-eval + andy-heartbeat 移至 6 点
- `Docs/00-project-overview.md`：Lisa 桥梁角色 + 回流机制 + 调度表 + 基线数据
- `Docs/HomeAI Readme.md`：Lisa 桥梁角色一句话

---

## v662 · L2 内部分工明确——Andy 自进化主力意志感（2026-04-13）

**干预类型**：L2 设计补全——Andy 作为自进化飞轮主力的定位、意志感与自主行动路径

**背景**：L2 的 Vibe Anything × 自进化飞轮框架已建立，但两个子层的主力归属一直隐含未说清。Lucas 是 Vibe Anything 的主力（感知外部需求触发协作链），Andy 是自进化飞轮的主力（主动巡检系统信号推动能力进化）——这个分工在设计文档里没有对称表达，Andy AGENTS.md 里的三维主动性体系也缺少「使命声明」，Check 13 停在「提案」层面而非「直接行动」。用户定位：Andy 在系统能力自进化上要有意志感，不是等人触发，是主动推动。

**变更内容**：

1. **00-project-overview.md L2 描述更新**：
   - L2 表格行：「Vibe Anything（Lucas 主力）× 自进化飞轮（Andy 主力）」，两个子层各有负责人
   - 简洁文字块同步加入主力归属标注
   - 新增「L2 内部分工」独立段落：解释两个子层互不替代、都在运转 L2 才活着的设计逻辑
   - Andy 特殊原则更新：「L2 自进化飞轮的主力」作为核心定位，区分「Lucas 触发任务」vs「Andy 自主发起任务」的行为规则

2. **Andy AGENTS.md 三维主动性体系重构**：
   - 在「设计哲学」前加「核心使命：L2 自进化飞轮的主力」声明
   - 明确自主发起改进的完整路径：观察→积累→判断→直接行动→事后汇报
   - 明确两类任务的行为差异：Lucas 触发的任务（Andy 是执行方，阻塞必须通知 Lucas）vs Andy 自主发起的自进化任务（Andy 是需求方，直接推进，架构级改动才提前告知系统工程师）
   - Check 13「架构改进提案」→「架构改进/能力补全」，从「提案」改为「行动」：Skill 结晶/工具补全直接推进，架构级调整才先知会系统工程师

3. **HomeAI Readme.md L2 描述同步**：加入 Lucas/Andy 主力归属标注

**设计来源**：用户原话「在系统能力自进化这个事情上，Andy 是主力，要有对应的意志感。L2 是包含这两部分的。」

**修改文件**：
- `~/.openclaw/workspace-andy/AGENTS.md`（核心使命声明 + Check 13 行动路径 + 两类任务行为差异）
- `Docs/00-project-overview.md`（L2 表格/文字块/内部分工段落/Andy 特殊原则）
- `Docs/HomeAI Readme.md`（L2 里程碑描述）
- `Docs/09-evolution-version.md`（本条目）

---

## v661 · Lucas 思考框架落地（2026-04-13）

**干预类型**：L1 行为质量增强——Lucas 工作流设计（等价于 Claude Code Vibe Coding 的家庭版落地）

**背景**：v660 设计会话完成了 Lucas 思考框架的完整设计讨论，但未落地。核心判断：Lucas 与 CLI（Claude Code）的可靠性差距，根因不是模型，而是工程可靠性——CLI 有 5 个工作流强制减速带，Lucas 一个都没有，是「信息灌进来 → 抓关键词 → 条件反射」。

**设计来源**：Claude Code Vibe Coding 六大机制对标分析（Read-before-Edit / Plan Mode / Think Tool / Lint-Typecheck / Doom Loop），映射到 Lucas 家庭场景等价物。

**变更清单**：

1. **AGENTS.md 思考框架节**（新增）：
   - 三维判断标准——歧义度（需求清楚吗）/ 错误代价（做错了回得来吗）/ 信息充分性（信息够做决策吗）
   - 三层分级——不思考（简单明确直接行动）/ 轻度推演（有歧义说出来）/ 深度推演（复杂高代价和家人一起想）
   - 可见思考原则——推演过程对家人可见，用对话方式展示思考，让家人随时纠偏，不是内部独白
   - 禁止内部术语规则——「Andy」「Lisa」「协作链」「spec」「trigger」「pipeline」不出现在对家人的回复里

2. **SOUL.md 受众自适应**（更新）：
   - 「看人说话」原则落地——不是统一隐藏技术细节，是 per-person 适应（爸爸讲逻辑/妈妈说结果/小姨说影响）
   - 可见思考人格定义——遇复杂问题自然地把思考过程说出来，让家人参与纠偏
   - 对话原则明确：内部的事（找谁做/怎么做/走什么流程）永远不对家人说

3. **trigger_development_pipeline 强制理解检查**（基础设施层，index.ts）：
   - 新增 `understanding_summary` 必填参数（不可省略）——Lucas 对需求的理解摘要，强制在触发前想清楚「做什么/给谁/成功标准」
   - 空或少于 10 字直接拒绝并要求重填——等价于 Claude Code 的 Read-before-Edit 基础设施强制
   - understanding_summary 注入 Andy 收到的消息头部（`【Lucas 理解摘要】`），减少 spec 方向猜错的概率

4. **上下文注入精简**（context-sources.ts）：
   - 去除 MEMORY.md 双注入——OpenClaw 原生已加载，context-sources.ts 的 `self-memory` 重复注入删除，节省约 16-24K tokens
   - active-capabilities topK 30→21——三角色均调整，覆盖实际工具数量即可，不过量注入

**Readme 系列文档同步**：
- `Docs/00-project-overview.md`：Lucas 角色表补充思考框架能力维度；新增「Lucas 特殊原则」段落
- `Docs/HomeAI Readme.md`：Lucas 表格和角色描述段落补充可见思考 / Vibe Thinking
- `Docs/09-evolution-version.md`：本条目

**修改文件**：
- `~/.openclaw/workspace-lucas/AGENTS.md`（思考框架节 + 禁止内部术语）
- `~/.openclaw/workspace-lucas/SOUL.md`（受众自适应 + 可见思考）
- `CrewClaw/crewclaw-routing/index.ts`（understanding_summary 强制参数）
- `CrewClaw/crewclaw-routing/context-sources.ts`（MEMORY.md 去重 + topK 调整）
- `Docs/00-project-overview.md`（Lucas 特殊原则 + 角色表）
- `Docs/HomeAI Readme.md`（Lucas 描述）
- `Docs/09-evolution-version.md`（本条目）

---

## v662 · Andy L2 自进化主力意志感（2026-04-13）

**干预类型**：L2 自进化飞轮——Andy 角色设计增强

**背景**：L2 有两个正交子层（Vibe Anything × 自进化飞轮），但 Andy 作为自进化飞轮主力的意志感不够——Andy 的行为规则没有区分「Lucas 触发的任务」和「Andy 自主发起的自进化任务」。

**设计来源**：用户原话「在系统能力自进化这个事情上，Andy 是主力，要有对应的意志感。」

**变更清单**：

1. **Andy AGENTS.md 核心使命声明**（新增）：
   - 在「设计哲学」前加「核心使命：L2 自进化飞轮的主力」声明
   - 明确自主发起改进的完整路径：观察→积累→判断→直接行动→事后汇报
   - 明确两类任务的行为差异：Lucas 触发的任务（Andy 是执行方，阻塞必须通知 Lucas）vs Andy 自主发起的自进化任务（Andy 是需求方，直接推进，架构级改动才提前告知系统工程师）
   - Check 13「架构改进提案」→「架构改进/能力补全」，从「提案」改为「行动」：Skill 结晶/工具补全直接推进，架构级调整才先知会系统工程师

2. **00-project-overview.md L2 内部分工补充**：
   - L2 表格/文字块明确标注 Lucas/Andy 主力归属
   - Andy 特殊原则更新：「L2 自进化飞轮的主力」作为核心定位

3. **HomeAI Readme.md L2 里程碑描述同步**

**修改文件**：
- `~/.openclaw/workspace-andy/AGENTS.md`（核心使命声明 + Check 13 行动路径 + 两类任务行为差异）
- `Docs/00-project-overview.md`（L2 表格/文字块/内部分工段落/Andy 特殊原则）
- `Docs/HomeAI Readme.md`（L2 里程碑描述）
- `Docs/09-evolution-version.md`（本条目）

---

## v663 · Lucas 工具层加固 + Andy HEARTBEAT 基础设施修复（2026-04-13）

**干预类型**：L0 基础设施修复 + L1 行为质量加固

**背景**：全量审计发现两个系统性问题：(1) Lucas 工具调用缺少 agentId 守卫——21 个工具中部分调用时未校验来源角色，存在越权调用风险；(2) Andy HEARTBEAT 依赖 exec 调 ChromaDB/Kuzu，但 exec 不在 L2 允许列表中导致执行被拒；同时缺少预计算机制，Andy 每次 HEARTBEAT 都要重新查询，造成不必要的 token 消耗。

**变更清单**：

1. **Lucas 工具层 21/21 agentId 守卫**（index.ts）：
   - 所有 Lucas 专属工具的 tool handler 增加调用者身份校验
   - 非授权角色调用返回明确错误而非静默失败

2. **Andy HEARTBEAT exec L2 允许列表**（index.ts）：
   - `exec` 工具的 L2 安全校验增加 Andy HEARTBEAT 必需的命令白名单
   - 允许 Andy 在 HEARTBEAT 上下文中执行预定义的数据查询命令

3. **Andy HEARTBEAT 预计算管道**（index.ts）：
   - 12 个数据块在 HEARTBEAT 触发前预计算并注入 prompt
   - 包括：活跃任务数、skill-candidates 统计、capability 数、最近 DPO 信号、代码图谱变化、评估趋势等
   - Andy 不再需要在 HEARTBEAT 中调 exec 查询，直接消费预计算结果

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`（agentId 守卫 + exec 允许列表 + 12 个预计算块）
- `Docs/09-evolution-version.md`（本条目）

---

## v664 · L2 双维度缺口补全（2026-04-14）

**干预类型**：L2 自进化飞轮——架构完整性修复

**背景**：v662 确立了 L2 双维度（Vibe Anything × 自进化飞轮）框架，v663 修复了基础设施。但全量审计发现五个结构性缺口：(1) Lisa 在 L2 中的桥梁角色没有文档化；(2) 回流机制只有 codebase_patterns 实现了，其他四条停留在设计；(3) skill-candidates 消费端（Andy HEARTBEAT）路径断裂；(4) Main 评估结果没有回流给 Andy；(5) Andy HEARTBEAT 6am 和蒸馏 2am 调度时序冲突。同时发现 Lucas false_commitment 检测缺少下一轮纠正闭环。

**变更清单**：

1. **Lisa 桥梁角色定义**（00-project-overview.md）：
   - 明确 Lisa 是两个维度的桥梁：Vibe Anything 的交付手 + 自进化飞轮的信号源
   - 三角色在 L2 中的闭环关系：Lucas 提需求 → Andy 设计 + 自进化 → Lisa 交付 + 反馈信号 → 回到 Lucas

2. **五条回流机制文档化**（00-project-overview.md + index.ts）：
   - codebase_patterns（Lisa→Andy）：已实现
   - capability-registry（Lisa→Lucas）：已实现
   - skill-candidates（Lucas→Andy）：框架层实现
   - capability_gap_proposal（Lisa→Andy）：框架层实现
   - knowledge_injection（Lucas→Andy）：框架层实现
   - Main 评估回流（Main→Andy）：新增，evaluation-history.jsonl → Andy HEARTBEAT 消费

3. **skill-candidates 消费端修复**（index.ts）：
   - Andy HEARTBEAT 检查 4 消费 skill-candidates 路径修正
   - 阈值从 2 个工具调整为 3 个工具 + 7 天去重

4. **Main 评估回流 Andy**（index.ts）：
   - Main evaluate_system 结果写入 evaluation-history.jsonl
   - Andy HEARTBEAT 检查 8 消费最近评估趋势，退步维度高亮

5. **调度时序重排**（gateway-watchdog.js）：
   - Andy HEARTBEAT 从 2am 移到 6am，与蒸馏 2am 错开
   - 避免同一时段大量后台任务竞争 Gateway 资源

6. **L2 基线首次测量**：
   - Vibe Anything 覆盖度：0 completed / 4 总计
   - 自进化飞轮：skill-candidates 89 条，andy-goals 1 条

7. **false_commitment 纠正闭环**（index.ts）：
   - 新增 `sessionFalseCommitCorrections` Map
   - agent_end 检测 false_commitment → 下一轮 before_prompt_build 注入针对性纠正
   - 补全了之前只有 tool_call_hallucination 有纠正而 false_commitment 没有的缺口

**Readme 系列文档同步**：
- `Docs/00-project-overview.md`：L2 双维度表格 + Lisa 桥梁角色 + 五条回流机制 + L2 基线数据 + Main 评估回流
- `Docs/HomeAI Readme.md`：L2 里程碑描述更新（Lisa 桥梁 + 回流机制）
- `Docs/09-evolution-version.md`：本条目

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`（sessionFalseCommitCorrections + skill-candidates 消费端 + Main 评估回流）
- `CrewHiveClaw/HomeAILocal/Scripts/gateway-watchdog.js`（调度时序）
- `Docs/00-project-overview.md`（L2 双维度 + 回流机制 + 基线数据）
- `Docs/HomeAI Readme.md`（L2 描述）
- `Docs/09-evolution-version.md`（本条目）

---

## v665 · Main 任务处理 + 全量评估 + 基础设施修复（2026-04-14）

**干预类型**：L0 基础设施修复 + L1 行为质量 + 系统诊断

**背景**：Main 监控积累 5 条 Lucas 承诺幻觉 pending 任务（mt-2026-04-11-002~005），DPO 信号持续高频。同时 gateway-watchdog 和 cloudflared-tunnel 进程不在 PM2 中运行，蒸馏管道因缺少 watchdog 调度而停滞。

**变更清单**：

1. **Main 5 条 pending 任务处理**：
   - 全部标记 done，根因统一：false_commitment 缺少下一轮纠正闭环
   - v664 已补全 sessionFalseCommitCorrections，本轮验证机制生效

2. **DPO 模式扩充**（lucas-dpo-patterns.json）：
   - 从实际 96 条 DPO 数据中发现并新增 6 个 false_commitment 模式
   - 「已完成设计」「已经设计好」「已共享给」「Lisa 马上开始」「Lisa马上开始」「已提交给Lisa修复」
   - 纠正提示包含具体行动指引（先调工具再说话、返回⚠️时说「已加入队列」不说「已提交」）

3. **全量评估完成**：
   - **L0 基础设施**：Gateway 正常，ChromaDB 正常（2104 conversations / 504 decisions / 1604 family_knowledge），Ollama 正常，PM2 进程除 watchdog+cloudflared 外正常
   - **L1 记忆数据**：三个核心集合每日正常写入，conversations 最新到 4/14
   - **L2 Kuzu 图谱**：Entity 397 / Fact 376 / CodeNode 170,854 / CODE_CALLS 7,279,685，蒸馏管道脚本路径已修正
   - **关键发现**：conversations 检索质量差（「抖音带货」top-10 全不相关），疑因文档过长导致嵌入向量稀释 + nomic-embed-text 中文语义能力有限

4. **基础设施修复**：
   - gateway-watchdog + cloudflared-tunnel 恢复 PM2 运行
   - 蒸馏管道诊断：log 路径已从旧路径迁移到新路径，4/12 有成功运行记录，watchdog 恢复后今晚 2am 将自动触发

5. **Pipeline 0/4 completed 根因待查**：
   - task-registry 显示 3 failed + 1 suspended，0 completed
   - 待下次排查失败原因

**Readme 系列文档同步**：
- `Docs/09-evolution-version.md`：本条目

**修改文件**：
- `CrewClaw/crewclaw-routing/config/lucas-dpo-patterns.json`（+6 个 false_commitment 模式）
- `~/HomeAI/Data/main-pending-tasks.json`（5 条 → done）
- `~/HomeAI/CLAUDE.md`（版本号 v665 + 动态区更新）
- `Docs/09-evolution-version.md`（本条目）

---

## v667 · L1 记忆优化——文件即真相 + 检索质量提升（2026-04-14）

**干预类型**：L1 行为质量优化（记忆系统）

**背景**：全量评估发现 conversations 检索质量差（「抖音带货」top-10 全不相关），根因是写入侧（整段对话一个向量，语义稀释）。同时 Lucas 核心认知（承诺、接话点）依赖 ChromaDB 检索而非结构性注入。从 Claude Code 的上下文管理中提炼「文件即真相」原则——关键信息是注入的，不是检索的。

**变更清单**：

1. **Phase 1a · 动态家人摘要（.now.md）**
   - 新增 `~/.openclaw/workspace-lucas/family/{userId}.now.md`（每家人一份）
   - `readNowFile()` 读取 + `updateNowFile()` 机械提取（话题/承诺/接话点/待跟进）
   - agent_end 后 fire-and-forget 写入，有界 50 行，7 天过期
   - context-sources.ts 新增 `family-now` FileSource（queryMode: "user-now"）
   - context-handler.ts 新增 `"user-now"` resolve case

2. **Phase 1b · 纠正持久化**
   - `trackDpoFrequency()` 写 `dpo-pattern-frequency.jsonl`，session 去重
   - `checkAndPersistCorrection()` 计数 ≥3 个不同 session → 写 Lucas AGENTS.md `<!-- AUTO-PERSISTED CORRECTIONS -->` 区间
   - 最多 10 条自动规则，超出替换最旧的

3. **Phase 2a · 对话分块写入**
   - `writeMemory()` 重写：<600 字整条写入；>600 字按 prompt 独立块 + response 按句切分 ≤500 字
   - 每块独立 embedding，metadata 含 `parentConvId` + `chunkIndex`
   - `timeWeightedRerank()` 和 `timeWeightedRerankWithEntityBoost()` 新增 parentConvId 去重

4. **Phase 2b · Kuzu 预筛**
   - queryMemories Step 3a：entityHits 非空时，先 `$contains` 匹配 entityTags 做窄范围查询
   - 不足时 fallback 全量补充，去重合并
   - 日志标记 `[P2]`

5. **Phase 3 · 上下文预算分层**
   - context-sources.ts 三种 Source 接口新增 `tier?: 0|1|2|3`（默认 2）
   - Lucas 17 个 source 逐个标注 tier（0=不可裁剪 1=高优 2=正常 3=低优）
   - Andy/Lisa 同步标注
   - context-handler.ts 新增 `applyContextBudget()`：从 Tier 3 开始裁剪，dryRun=true 只记日志
   - `config/context-budget.json`：maxContextChars=40000, dryRun=true

**设计决策**：
- 分块对蒸馏是正面的：`distill-memories.py` 截断到 300 字，分块后信息密度更高
- 预算分层初期 dryRun：先积累 1-2 周各 tier 实际占用数据，再决定裁剪阈值
- 纠正持久化是框架层机制，AGENTS.md 内容是实例层

**涉及文件**：
- `CrewClaw/crewclaw-routing/index.ts`（writeMemory 重写、queryMemories 预筛、readNowFile/updateNowFile、DPO 追踪、预算加载）
- `CrewClaw/crewclaw-routing/context-sources.ts`（+user-now、+tier 标注）
- `CrewClaw/crewclaw-routing/context-handler.ts`（+user-now resolve、+applyContextBudget）
- `CrewClaw/crewclaw-routing/config/context-budget.json`（新增）
- `~/.openclaw/workspace-lucas/AGENTS.md`（+AUTO-PERSISTED 标记）
- `CLAUDE.md`（v667 动态区更新）

---

## v666 · Andy spec 落地自动重触发机制 + jiti 兼容性修复（2026-04-14）

**干预类型**：L1 协作链可靠性修复 + 基础设施 bug 修复

**背景**：task-registry 显示 3/3 任务 failed（0/4 completed），根因是 DeepSeek R1（Andy 模型）完成方案分析并输出完整 Implementation Spec 后，不调用 `trigger_lisa_implementation` 工具。Andy 的思考（CoT）里分析了需求、写了结构化 spec JSON，但最后一步「启动 Lisa」被跳过——推测是 R1 的长程推理衰减或工具调用注意力不足。

**变更1：Andy spec 落地自动重触发**（index.ts `runAndyPipeline`）

协作链结束检测逻辑：Andy 响应完成后，检查协作线程文件 `andy-to-lisa:{reqId}_collab.json` 是否存在。

| 情况 | 检测方式 | 处理 |
|------|---------|------|
| Andy 正常完成 | collab 文件存在 | `markTaskStatus("completed")` |
| Andy 有 spec 但没调 trigger | regex 匹配 ` ```json ``` ` 含 `integration_points` | 自动重触发：提取 spec → 构造精简 prompt → 二次调 Andy |
| 自动重触发成功 | collab 文件出现 | `markTaskStatus("completed")` + notify engineer |
| 自动重触发失败 | collab 文件仍不存在 | `markTaskStatus("failed")` + 转 Lucas 决策 |
| Andy 无 spec 且没调 trigger | regex 无匹配 | `markTaskStatus("failed")` + 转 Lucas 决策 |

重触发 prompt 设计原则：Andy 在新 session 中无历史记忆，所以把完整 spec JSON 嵌入 retry prompt，告诉 Andy「只需要做一件事：调用 trigger_lisa_implementation」。

**变更2：`runLucasPipelineFallback` 提取复用**

从原 inline Lucas 决策逻辑提取为独立 async 函数，供自动重触发失败路径和无 spec 路径共同调用。Lucas 收到 3 个选项：①补充背景重提需求 ②问家人一个关键问题 ③上报系统工程师。

**变更3：jiti Babel parse error 修复**

**根因**：`before_prompt_build` 中 Andy HEARTBEAT 的 Lucas 知识投喂代码块（~L5932-5955）没有被 `try {` 包裹。前一个 `catch` 在 L5930 关闭了对应的 `try`，但后续代码直接裸露执行，直到 L5956 遇到 `} catch (_e) {`，此时没有匹配的 `try`，jiti Babel parser 报 `Unexpected token`。

**影响**：此 bug 导致 Gateway 启动时插件无法加载——jiti 懒加载在首次真实请求时才暴露 parse error，让所有工具消失。

**修复**：在 L5932 前添加 `try {`。

**变更4：全局 `} catch {` → `} catch (_e) {`**

158 处 optional catch binding 替换为显式参数。虽然 jiti 2.6.1 Babel parser 支持 optional catch binding（实际根因是缺 `try`），但显式参数是防御性措施，避免未来 jiti 版本差异。

**变更5：task-registry 清理**

3 条 failed 任务（`req_1775858994072`、`req_1776003363639`、`req_1776003551689`）标记 cancelled，注明根因和修复版本。1 条 queued 任务保留。

**验证**：`check-plugin.sh` 编译通过，Gateway 成功启动（`ready (2 plugins, 5.0s)`），PID 25721 端口 18789 正常监听。

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`（自动重触发 + `runLucasPipelineFallback` + missing try fix + catch syntax）
- `~/HomeAI/Data/learning/task-registry.json`（3 failed → cancelled）
- `Docs/09-evolution-version.md`（本条目）

---

## v668 · Lx 能力分级体系重构 + watchdog 修复 + 架构拓扑厘清（2026-04-14）

### 1. Lx 能力分级体系重构

**问题**：原有 L2 定义同时包含「Vibe Anything（帮人做事）」和「系统自进化（自己变强）」两个正交维度，本质上是爸爸的双重身份（家庭成员+系统工程师）导致的设计边界模糊。L4 只定义为「深度学习（DPO+微调）」，遗漏了系统层面的自我改进能力。

**决策**：重新定义 Lx 体系：
- L2 = **Vibe Anything**·开发即交付（帮人做事的能力）：Lucas 感知家人需求 → Andy 设计 → Lisa 实现 → 家人用上
- L4 = **系统自我演化**·让 L0~L3 越来越好的元能力，含两层：
  - 系统层自我改进（结晶/蒸馏/spec 质量提升/DPO 信号收集/路由阈值进化/Andy 主动巡检）
  - 模型层内化（本地模型微调/DPO 训练/行为模式写入权重）

**L2 与 L4 核心差别**：L2 是「帮人做事的能力」，L4 是「自己变强的能力」。L2 与 L3 核心差别：L3 带着人。

**控制回路**：「正朔→认知」工作流——系统工程师修改 Readme（正朔）→ 刷新 Agent 认知文件（AGENTS.md/SOUL.md/MEMORY.md/TOOLS.md），这是系统工程师影响系统自演化方向的最关键工作流，也是 L4 的控制回路。

**刷新范围**（进行中）：
- ✅ `docs/HomeAI Readme.md` line 150：Lx 里程碑引用段落
- ✅ `docs/00-project-overview.md` §七 核心定义表 + 说明文字（lines 290-335）
- ✅ `docs/00-project-overview.md` 散落引用：结晶路径/学习闭环/Andy 原则/记忆系统图（~6 处）
- ✅ `docs/00-project-overview.md` §八「L4 系统层自我演化」整节改 L4 + L4 模型层内化节对齐 + watchdog 描述 + HEARTBEAT 标签 + 其他散落引用（~30 处）
- ✅ Agent 认知文件刷新（四角色全刷：Main/Andy/Lisa/Lucas AGENTS.md + Andy/Lisa HEARTBEAT.md + Andy DESIGN-PRINCIPLES.md）
- ✅ evaluate_l2/l4 代码重构：L2 只留 Vibe Anything 指标，L4 拆系统层（S1-S5）+ 模型层（M1-M3）
- ✅ MAIN_SYSTEM_PROMPT + HEARTBEAT 提示 Lx 分层标签对齐

### 2. Watchdog probe 自毁循环修复

**问题**：gateway-watchdog 通过 `/v1/chat/completions` 发 `model: 'openclaw/lucas'` + `content: 'watchdog probe'` 验证 LLM 链路。Lucas 把 probe 当用户消息处理，调用 `restart_service` 重启 Gateway。watchdog 下一轮发现 Gateway 无响应又触发重启，形成自毁循环。

**根因**：watchdog 探测 Gateway，不应通过 Gateway 内部验证 Gateway（逻辑倒挂）。LLM 链路健康是 Gateway 自己的内部事务。

**修复**：
1. `gateway-watchdog.js`：probe 从 LLM 请求改为纯 `/health` HTTP GET
2. `crewclaw-routing/index.ts`：`before_prompt_build` 开头增加 watchdog probe 短路拦截

### 3. 架构拓扑厘清

确认系统架构的四个独立组件及其关系：
- **watchdog**（PM2）= Main 的基础设施，独立于 Gateway
- **Gateway**（launchd）= Lucas/Andy/Lisa 的主进程
- **wecom-entrance**（PM2）= 统一外部接口，内含 bot 通道 + 企业应用通道两条独立通道
- **Main** = 直连 LLM API（`callMainModel` → `fetch(completionsUrl)`），不经 Gateway

**设计原则**：watchdog 探测 Gateway 只做外部 HTTP 检查，不做 LLM 请求验证。

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`（watchdog probe 短路拦截）
- `HomeAILocal/Scripts/gateway-watchdog.js`（probe 改为 /health-only）
- `docs/HomeAI Readme.md`（Lx 里程碑引用）
- `docs/00-project-overview.md`（核心定义表 + 散落引用，部分完成）
- `docs/09-evolution-version.md`（本条目）
- `docs/10-engineering-notes.md`（watchdog 自毁循环约束追加）

---

## v670 · L1 Skill 固化三阶段机制落地 + Lx 定义刷新（2026-04-14）

**干预类型**：L1 行为质量 + 自进化能力增强（Skill 自动结晶完整闭环）

**背景**：当前 Skill 结晶管道断裂——`flag_for_skill` 从未被 Lucas 调用过，auto-detect 门槛过高（≥3 工具），87 条 auto_detect 候选全是噪声（全部 rejected）。参考 Hermes Agent 设计（2 次触发自动写 Skill 草稿、使用频率追踪、自动迭代/废弃），实现三阶段 Skill 固化机制。

**变更清单**：

1. **Phase 1：低阈值 + 自动写 Skill 草稿**
   - auto-detect 阈值从 ≥3 → ≥2，覆盖三角色（Lucas/Andy/Lisa）
   - 新增 `writeSkillDraft()` 函数：检测到 2+ 工具组合后自动写 `SKILL.md` 草稿到对应 agent workspace skills 目录
   - 幂等设计：已存在 draft 则更新 trigger_count/last_seen；已 active 不覆盖
   - frontmatter 含 status/created_from/trigger_count/first_seen/last_seen/usage_count/success_count/last_used
   - Lucas AGENTS.md flag_for_skill 门槛同步降为 2 次

2. **Phase 2：使用频率追踪 + frontmatter 扩展**
   - 新增 `skill-usage.jsonl`：每轮 agent_end 追踪 Skill 加载/使用/完成/跳过状态
   - 推断方式：对比 Skill 步骤工具与本轮 toolUseCounts，不依赖 Agent 自报
   - frontmatter 自动更新 usage_count/success_count/last_used
   - Andy HEARTBEAT 新增 Skill 使用统计预计算注入，含健康审计指导

3. **Phase 3：自动迭代 + 废弃 + Andy/Lisa 积累**
   - 偏差检测：Skill 步骤工具覆盖度 < 50% 记录为 deviated
   - 自动迭代：偏差 ≥ 3 次后用最常见的实际工具组合重写步骤
   - 废弃：usage_count=0 且 age>30 天自动标 deprecated
   - Andy 自动积累：search_codebase + write_file 成功后自动创建 spec-{topic} Skill
   - Lisa 自动积累：run_opencode + get_opencode_result 成功后自动创建 impl-{topic} Skill

**同期完成**：Lx 五层定义刷新（v669-v670）
- L1: 行为质量+自进化·好不好+自成长（记忆质量+输出质量+Skill固化）
- L2: Engineering Anything·开发即交付——多Agent智能体协作框架Ready
- L3: 组织级AI·带着人一起进化
- L4: 系统自进化·架构自优化+模型本地内化

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`（writeSkillDraft + auto-detect ≥2 + Skill 使用追踪 + 偏差检测 + 自动迭代 + 废弃 + Andy/Lisa 积累）
- `~/.openclaw/workspace-lucas/AGENTS.md`（flag_for_skill 门槛 3→2）
- `~/HomeAI/Data/learning/skill-usage.jsonl`（新建）
- `Docs/09-evolution-version.md`（本条目）

---

## v671（2026-04-14）Andy compaction 修复 + L2 Planning Mode + Lucas 行为改进

**背景**：Andy（DeepSeek R1）在处理复杂 spec 时持续超时/"No reply from agent"，根因是 `compaction.mode: "safeguard"` 在长上下文（31K token）时 compaction 本身超时导致 agent 被杀。修复后 Andy 能稳定运行 12+ 分钟。

**1. Andy compaction 修复**
- `openclaw.json` 中 `agents.defaults.compaction.mode` 从 `"safeguard"` 改为 `"default"`
- 根因：safeguard 模式在上下文较长时触发 compaction，compaction 本身超时（约 2 分钟），导致 agent 被杀返回空结果
- 修复后 Andy R1 能稳定运行 12+ 分钟完成推理

**2. L2 Planning Mode**
- `trigger_lisa_implementation` 新增 `planning_mode: true` 检测
- 新增 `decomposeToSubSpecs()` 函数：按 `integration_points` 文件目录自动分组，结构化分解（无 LLM 调用）
- 复用 `spawnParallelLisa()` 基础设施并行调度各子模块
- 完成后 Andy 验收，退化处理（≤1 组自动降级为单 Lisa）
- Andy AGENTS.md 新增「Planning Mode（自动并行）」节

**3. Lucas 行为改进**
- SOUL.md 加「能办事」「先做再说」性格描述 + 认知风格「解决问题导向」「深层理解」
- AGENTS.md 禁止汇报体/反复求确认/车轱辘话规则
- `lucas-behavioral-rules.json` 新增 `styleRule`：每轮强制注入「像家人聊天，不像做汇报」

**4. Pipeline drain 修复**
- `task-queue.jsonl` 为空时从 `task-registry.json` 补救 `status=queued` 的孤儿任务
- 避免因 queue file 写入失败导致任务永远积压

**5. Andy re-trigger 改进**
- 不依赖 spec 格式检测，只看协作线程文件是否存在（无 collab 文件 = 需要重触发）
- 减少对 Andy spec 格式的依赖

**6. write_file 三角色共享**
- 从 Andy 专属 + `workspace-andy/` 路径限制 → Lucas/Andy/Lisa 共享 + `$HOME/` 路径限制
- CLAUDE.md 工具表：Andy（8专属）/ 共享（7）
- before_tool_call 写入守卫：`workspace-andy/` → `$HOME/`

**修改文件**：
- `~/.openclaw/openclaw.json`（compaction mode）
- `CrewClaw/crewclaw-routing/index.ts`（decomposeToSubSpecs + planning_mode 检测 + drain 改进 + re-trigger 改进 + write_file 共享）
- `~/.openclaw/workspace-lucas/SOUL.md`（性格描述）
- `~/.openclaw/workspace-lucas/AGENTS.md`（行为规则）
- `~/.openclaw/workspace-lisa/behavioral-rules/lucas-behavioral-rules.json`（styleRule）
- `~/.openclaw/workspace-andy/AGENTS.md`（Planning Mode 节）
- `Docs/00-project-overview.md`（三种执行路径表 + Planning Mode 节 + write_file 共享 + drain 改进）
- `Docs/09-evolution-version.md`（本条目）

---

## v672（2026-04-14）L2 交付可靠性三机制 + L3 设计 CrewClaw 框架化

**背景**：向 Claude Code 学习——可靠性不靠模型强，靠工程结构保证。当前 L2 协作链 Lisa 说"做完了"但 `changedFiles: []`，基础设施层不独立验证。失败后线性重试同一方案。Lucas 进度反馈不够主动。

**设计原则**：机制保证，不靠模型自觉。基础设施层验证，不依赖 Andy/Lisa 模型能力。所有组织成员（家人+访客）体验一致。

**1. 交付验证门**
- 新增 `verifyLisaDelivery()` 函数：组合 `runProjectCompileCheck()` + spec 新增文件存在性检查
- `trigger_lisa_implementation` 单 Lisa 路径：Lisa 交付后独立验证 → 不通过自动重试一次 → 仍不通过带证据通知 Andy
- `spawnParallelLisa` 并行子任务同步加验证：验证结果写入子任务 JSON

**2. 失败分层升级**
- Lisa 失败通知 Andy 的 prompt 改为分层建议：简化 spec → 换方案 → 了解阻塞 → 上报
- `request_implementation_revision` 第 2 轮起追加系统提示：同一问题反复可能是 spec 设计问题

**3. Lucas 进度反馈**
- `lucas-behavioral-rules.json` 新增 `progressRule`：家人和访客一致的进度反馈指导
- 中间通知 prompt 从被动改为有条件主动（用户问过就主动告知）
- 访客交付提示词对齐：不叫家人称呼，用专业友好语气

**4. L3 设计 CrewClaw 框架化**
- 00-project-overview L2 定义：交付可靠性三机制写入框架层定义表
- 00-project-overview L3 定义：从 HomeAI 视角改为 CrewClaw 框架视角（Frontend/Designer/Implementor）
- 新增「交付可靠性三机制」节：框架/实例分离表
- 实现记录节标题：从「HomeAI L3 实现记录」改为「CrewClaw L2/L3 框架机制 + HomeAI 实现记录」

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`（verifyLisaDelivery + 验证门 + spawnParallelLisa 验证 + Andy 分层通知 + revision 提示 + progressRule 注入 + 通知 prompt + 访客语气）
- `CrewClaw/crewclaw-routing/config/lucas-behavioral-rules.json`（progressRule）
- `Docs/00-project-overview.md`（L2/L3 定义框架化 + 交付可靠性节 + 实现记录标题）
- `Docs/09-evolution-version.md`（本条目）


---

## v673 · L3 成员理解机制框架化（2026-04-14）

**干预类型**：文档刷新（L3 设计从 HomeAI 视角升级为 CrewClaw 框架视角）

**背景**：L3 的成员理解能力（成员画像、关系图谱、影子 Agent、跨成员感知）此前描述绑在「家庭」上——家人档案、家庭关系、看家人情绪。业主指出这是通用组织机制，不是家庭专属：家庭理解家人的情绪与关系，企业理解员工的职责与协作偏好，学校理解学生的学情与社交动态。机制相同，内容由实例注入。

**变更清单**：

1. **00-project-overview.md L3 核心定义表**（line 297）：
   - 从「组织理解力 + 协作优化」改为「组织成员理解 + 协作优化」，明确四层框架机制：成员画像/关系图谱/影子 Agent/跨成员感知
   - 新增「框架 vs 实例」标注：机制=框架层，内容=实例层
2. **00-project-overview.md L3 口诀版**（line 304）：
   - 更新为四层机制的简洁表达
3. **00-project-overview.md L2/L3 差别段**（line 335）：
   - 新增「成员理解不是家庭专属——任何组织都需要理解成员」说明
   - 三种实例场景对比：家庭/企业/学校
4. **00-project-overview.md L3 详细节**（line 2791）：
   - 新增「组织成员理解机制（四层框架）」完整节，含框架/实例对比表
   - 「Lucas：跨成员协作中介」→「前端 Agent：跨成员协作中介」，示例同时给 HomeAI 和企业场景
   - 与影子的分工描述去 Lucas 名
5. **HomeAI Readme.md L3 里程碑**（line 150）：
   - L3 描述更新为四层成员理解机制 + 「不是家庭专属」标注
6. **09-evolution-version.md 版本号**：v670→v673

**设计决策**：成员理解机制的框架/实例分离表明确——框架提供蒸馏管道、图谱遍历、影子创建、跨成员扫描；实例定义关系类型（spouse_of vs reports_to）、画像维度（情绪 vs 职级）、隐私规则（家庭隐私 vs 商业机密）。

**修改文件**：
- `Docs/00-project-overview.md`（L3 定义表 + 口诀 + 差别段 + 详细节）
- `Docs/HomeAI Readme.md`（L3 里程碑）
- `Docs/09-evolution-version.md`（本条目）


---

## v674 · Main 评估算法刷新——对齐最新 L0~L4 定义（2026-04-14）

**干预类型**：评估算法重构 + rubric 配置更新

**背景**：v668 完成 Lx 能力分级体系重构（L2=Engineering Anything / L3=组织级AI / L4=系统自进化）后，Main 的 evaluate_l2/l3/l4 实现和 evaluation-rubric.json 仍停留在旧定义，存在多处错位：L2 混入了 L4 自进化指标（evolution_signals/skill_count），L3 缺少成员画像维度，L4 用"幻觉禁令条数"衡量成熟度（二元指标）而不是趋势性指标。

**变更清单**：

1. **evaluation-rubric.json**：
   - L2：删除 evolution_signals/skill_count/andy_heartbeat_check（属于 L4），新增 pipeline_health（三角色协作链健康，completed/failed 比例）
   - L3：label 从"组织协作进化"改为"组织级AI"，新增 member_profile（成员画像蒸馏比例）
   - L4：label 从"深度学习"改为"系统自进化"，删除 l2_intervention（幻觉禁令二元指标），新增 agents_md_maturity（三角色 AGENTS.md 规则总条数，lower_better，越少越成熟）+ routing_evolution（本地路由占比，higher_better）

2. **evaluate_l2**：标题改为"Engineering Anything · 三角色闭环交付力"，新增 B 维度（三角色协作链健康：读 task-registry.json，计算 completed/failed 比例）

3. **evaluate_l3**：重构为四维度分段输出——①成员画像（inject.md 含蒸馏信息关键词比例）②关系图谱（Kuzu 协作边）③影子 Agent（演进环记录+访客Registry）④跨成员感知（关系蒸馏日志+成员协作信息比例）

4. **evaluate_l4 S5**：从"Lucas AGENTS.md 幻觉禁令条数"改为"三角色 AGENTS.md 规则总条数"（当前基线 ~178 条，阈值 ≤100 为 5 分，基线阶段 3 分）

5. **evaluate_l4 S6**：新增路由阈值进化（读 route-events.jsonl 近 200 条，统计 local/total 比例）

6. **LAYER_NAMES/layerLabels/HEARTBEAT 提示**：全部统一为 L2→"Engineering Anything"、L3→"组织级AI"、L4→"系统自进化"

7. **Andy HEARTBEAT 时间戳解析修复**：原代码 `.slice(0, 20)` 截断 ISO 时间戳尾部（`2026-04-14T16:47:56.064+08:00` → 截成 `2026-04-14T16:47:56.` 含尾部点），再拼 `+08:00` 产生 NaN，fallback 到 9999h；改为直接解析完整原始字符串

**修改文件**：
- `CrewClaw/crewclaw-routing/config/evaluation-rubric.json`
- `CrewClaw/daemons/entrances/wecom/index.js`（evaluate_l2/l3/l4 实现 + LAYER_NAMES + layerLabels + HEARTBEAT 提示）
- `Docs/09-evolution-version.md`（本条目）


---

## v675 · DPO 生成修复 + Readme 刷新（2026-04-14）

**干预类型**：bug 修复 + 文档对齐

**背景**：触发 `generate_dpo_good_responses` 生成 false_commitment 的 good_response 时，工具报告"20 条生成完成"但 `approve_dpo_batch` 实际只确认 1 条。经排查，根因是 GLM-5.1（推理模型）的 reasoning_content 耗尽 max_tokens=300 的 token 预算，content 字段返回空字符串，同时 `generated.push(pt)` 未加空值守卫导致虚报计数。

**变更清单**：

1. **generate_dpo_good_responses** (`wecom/index.js` line ~4487)：
   - 模型从 `callAgentModel('main', ...)` 改为 `callAgentModel('lucas', ...)`（deepseek-chat，非推理模型，适合简单改写任务）
   - max_tokens 从 300 提升到 600
   - `generated.push(pt)` 加空值守卫：`if (entry.good_response) generated.push(pt)`

2. **Readme 刷新**（`Docs/00-project-overview.md`）：
   - `evaluate_l2` 工具描述：补充三角色协作链健康维度
   - `evaluate_l3` 工具描述：更新为 ①成员画像 ②关系图谱 ③影子 Agent ④跨成员感知 格式
   - `evaluate_l4` 工具描述：AGENTS.md 指标更新 + 新增 routing_evolution 描述
   - L2 成熟信号列：补充"三角色协作链健康（completed 比例 ≥80%）"
   - DPO 处理方式：从"批量送云端自动生成"改为"调用 lucas 模型（deepseek-chat）批量改写"

**实际执行结果**：false_commitment 45 条中 26 条已 confirmed（6 历史存量 + 20 本次新生成），剩余 19 条待下次处理。

**修改文件**：
- `CrewClaw/daemons/entrances/wecom/index.js`（generate_dpo_good_responses 修复）
- `Docs/00-project-overview.md`（evaluate 工具描述对齐）
- `Docs/HomeAI Readme.md`（Lx 里程碑注释位置调整 + 表格格式）
- `Docs/09-evolution-version.md`（本条目）

---

## v676 · L2 ClaudeCode 协作链体验对齐（2026-04-15）

**干预类型**：L2 交付体验升级（第四机制）

**背景**：L2 的三条可靠性机制（验证门/分层升级/进度反馈）已稳定运行，但用户视角的体验与 ClaudeCode CLI 7 阶段工作流存在系统性差距：Andy 探索阶段黑盒、需求澄清无强制检查、设计方案用户不可见、代码审查无结构、交付摘要无格式。本次以 ClaudeCode 7 阶段模型为基准，全面对齐。

**变更清单**：

1. **`runAndyPipeline`（index.ts）**：
   - Exploration 阶段：Andy 启动前立即通知 Frontend Agent + 工程师「Andy 开始探索」（Discovery 可见性）
   - 需求澄清4条件强制注入 Andy 消息（目标用户/成功标准/技术约束/范围），满足任意一条必须先调 `query_requirement_owner`

2. **`trigger_lisa_implementation`（index.ts）**：
   - 多方案通知：alternatives≥2 时保存 approaches.json + 通知 Frontend Agent（已有）
   - 单方案设计摘要：alternatives<2 时也通知 Frontend Agent 方案/文件/AC（Architecture Design 可见性，补齐缺口）
   - 软审批 gate：通过验证后向 Frontend Agent 发「即将修改N个文件」清单（Pre-implementation gate）

3. **代码审查指引（index.ts）**：Andy 验收时附已修改文件前60行，并注入三维度审查指引（正确性/简洁性/规范），WARN/FAIL 强制调 `request_implementation_revision`

4. **交付摘要格式（index.ts）**：TUI路径 / Coordinator路径 / Planning Mode路径三套 Lucas prompt 统一升级为4段结构（做了什么/修改位置/注意事项/建议下一步）

5. **新工具 `select_spec_approach`（index.ts，Frontend Agent 专属）**：读取 approaches.json，叫停当前进行中实现，用用户选定方案重触发 Designer 协作链

6. **`list_active_tasks` 升级（index.ts）**：每条任务新增当前阶段标签（andy_designing / lisa_implementing / andy_verifying）+ 已运行分钟数

7. **修订早期预警（index.ts）**：`request_implementation_revision` 第 2 轮起自动通知工程师

8. **Andy AGENTS.md**：明确 4 种必须先澄清的情形 + 多方案设计（alternatives 字段）格式规范

**设计决策**：
- 用户审批采用「告知 + 默认继续 + 事后可切换」而非「等待批准」，避免阻塞协作链
- alternatives 保存为独立文件（approaches.json），供 select_spec_approach 读取，与 spec 解耦
- 3维度代码审查通过在 responseText 注入指引实现，零延迟（不另起审查调用）

**文档更新**：
- `Docs/00-project-overview.md`：L2 表格 + 口诀 + 交付可靠性「三机制」改为「四机制」+ 新增「机制四：ClaudeCode 协作链体验对齐」详细节
- `Docs/HomeAI Readme.md`：Andy 行补充多方案设计 + 需求澄清 + 三维度代码审查描述

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`
- `~/.openclaw/workspace-andy/AGENTS.md`
- `Docs/00-project-overview.md`
- `Docs/HomeAI Readme.md`
- `Docs/09-evolution-version.md`（本条目）

---

## v677 · MemPalace/MAGMA/Hermes/ClaudeCode 四项目 gap 补全（2026-04-15）

**干预类型**：L0/L1/L4 多层机制补全（参考四个外部项目深度 gap 分析后实施）

**背景**：系统工程师对 MemPalace（L0 记忆架构）、MAGMA（L0 图谱检索）、Hermes（L1 行为质量）、ClaudeCode（L2 协作链体验）四个参考项目做了深度评估，识别出 P0/P1 缺口，本次全部实现，同时激活已积累数据的上下文预算裁剪。

**变更清单**：

1. **hall_type 对话分类元数据（index.ts `writeMemory`）**：
   - MemPalace 四厅架构对齐（hall_events / hall_discoveries / hall_preferences / hall_facts）
   - 写入时机：`agent_end` 触发的 `writeMemory` 同步写 metadata `hall_type` 字段
   - 分类规则：dev_or_complex intent → hall_events；「发现/原来/学到」关键词 → hall_discoveries；「喜欢/习惯/偏好」关键词 → hall_preferences；其余默认 hall_facts
   - 价值：为未来按记忆类型过滤检索（只查「发现类」或「事件类」）打基础

2. **MAGMA Phase 2 因果多跳检索（index.ts）**：
   - `detectCausalQuery(query: string): boolean`：正则检测「为什么/为何/原因/怎么会/导致/因为」
   - `queryCausalFactsMultiHop(userId: string)`：2-hop Kuzu MATCH `(p)-[f1:causal]->(m)-[f2:causal]->(t) LIMIT 6`，返回 `{chain, context}[]`
   - recall_memory 中：检测到因果查询时并发执行 multi-hop + 1-hop，合并为 `【因果推理链】` 块注入；普通查询走原有路径

3. **session_todo 工具（index.ts，Andy/Lisa 共享）**：
   - Hermes todo_tool 对齐，action: `write/update/read/clear`
   - `sessionTodoMap: Map<string, TodoItem[]>`，TodoItem: `{id, content, status: pending|in_progress|done|cancelled}`
   - `before_prompt_build`：检测到未完成 todo 时注入 `【当前任务进度】` 块（⬜/🔄/✅/🚫），全部完成时追加 clear 提示
   - 仅 DESIGNER_AGENT_ID / IMPLEMENTOR_AGENT_ID 可调用

4. **recall_memory session 聚合摘要（index.ts）**：
   - Hermes session_search_tool 对齐，解决原始碎片化检索结果可读性差的问题
   - 按 sessionId 聚合检索结果 → top-3 session（每 session ≤4 条）→ 跨 ≥2 session 且 ≥4 条时调 lucas 模型摘要（max_tokens=300，4s 超时）→ 注入 `【语义相关对话摘要】`
   - 超时或摘要 <20 字时 fallback 到原始结果，不影响可靠性

5. **findRelevantMemories 关键词动态注入过滤（context-sources.ts + context-handler.ts）**：
   - ClaudeCode `findRelevantMemories` 机制对齐（轻量无 LLM 版本）
   - `FileSource` 新增 `optional?: boolean` + `keywords?: string[]` 字段
   - `context-handler.ts resolveFile()`：optional=true + queryMode=static-file + keywords 非空时，keyword miss → 静默返回空字符串，跳过注入
   - Andy 背景文件（optional: true, keywords: 项目背景/里程碑/HomeAI/HiveClaw/L0-L4...）
   - Andy MEMORY.md（optional: true, keywords: 设计/架构/原则/踩坑/spec...）
   - Lisa 背景文件和 MEMORY.md 同样配置各自场景 keywords

6. **上下文预算正式激活（config/context-budget.json）**：
   - `dryRun: true` → `dryRun: false`，v667 积累的数据已验证（典型 total=13436 < 40000，正常不裁剪）
   - T0~T3 四层裁剪逻辑正式生效，溢出时从 T3（低优）开始裁剪，T0 永不裁剪

7. **Andy Spec SFT 积累管道（index.ts + 两个 Python 脚本）**：
   - `ANDY_SPEC_FINETUNE_QUEUE = data/learning/andy-spec-finetune-queue.jsonl`
   - `trigger_lisa_implementation` 中：spec 通过验证后写入队列（requirement + context + spec + specQuality 元数据）
   - `launchOpenCodeBackground` 中：`opencodeReqIdMap` 记录 sessionId → requirementId 映射
   - opencode `proc.on("close")` 中：回填 outcome（exitCode + specMatchRate），设置 `eligibleForTraining`
   - `seed-andy-spec-queue.py`：扫描 workspace-andy/ 12 个历史 spec 种子导入，mtime 去重
   - `prepare-andy-sft-data.py`：过滤 eligible → MLX messages 格式 train.jsonl + valid.jsonl，50 条触发 LoRA SFT 提示
   - 运行结果：12 条种子，9 条 eligible，8 train + 1 valid 分割

**设计决策**：
- hall_type 写入阶段用关键词分类而非 LLM，避免每次对话多一次 LLM 调用；精确度够用（主要用途是批量统计/过滤，不是精准分类）
- session_todo 用 sessionKey 而非 agentId 作 Map key，保证 tool 调用和 before_prompt_build 读同一个 session 状态
- recall_memory 摘要设 4s 超时是有意的 safeguard——summrization 是锦上添花，不能阻塞主流程
- SFT 积累管道设计为异步非阻塞（写队列 fire-and-forget），不影响主协作链延迟

**文档更新**：
- `Docs/HomeAI Readme.md`：L0~L4 里程碑段落补充 hall_type/因果多跳/session_todo/recall摘要/findRelevantMemories/预算激活/SFT管道
- `Docs/00-project-overview.md`：因果多跳 Phase 2 实现/hall_type写入层/session聚合摘要/findRelevantMemories节/dryRun激活/Andy SFT管道/L4定义
- `~/HomeAI/CLAUDE.md`：版本 v675→v677，工具 36→37，session_todo 加入共享工具表

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`
- `CrewClaw/crewclaw-routing/context-sources.ts`
- `CrewClaw/crewclaw-routing/context-handler.ts`
- `CrewClaw/crewclaw-routing/config/context-budget.json`
- `HomeAILocal/Scripts/seed-andy-spec-queue.py`（新增）
- `HomeAILocal/Scripts/prepare-andy-sft-data.py`（新增）
- `Docs/HomeAI Readme.md`
- `Docs/00-project-overview.md`
- `Docs/09-evolution-version.md`（本条目）

---

## v678（2026-04-15）

**主题**：L1 自进化链路补全——flag_for_skill 三角色共用 + Skill 固化三层机制

**背景与动机**：
- 原设计 `flag_for_skill` 是 Lucas 专属工具，Andy/Lisa 在协作链执行中遇到弱信号没有出口
- Andy HEARTBEAT 的检查 2（skill-candidates 评估）依赖候选池，但输入源只有 Lucas——协作链里最密集产生缺口感知的两个角色反而无法标记
- 核心原则确立：**L1 自进化要靠各角色自己的主动性，不依赖定时任务**；Andy HEARTBEAT 是批处理端，三角色主动 flag 是感知生产端

**变更内容**：

1. **`crewclaw-routing/index.ts`**：
   - `flag_for_skill` 从 Lucas 专属 → 三角色共用
   - guard 从 `!== FRONTEND_AGENT_ID` 改为 `allowedAgents.has(agentId)`（阻止 main，开放 lucas/andy/lisa）
   - jsonl 记录新增 `source: toolCtx.agentId` 字段，标记哪个角色发出信号
   - description 更新为三角色各自的弱信号示例（Lucas/Andy/Lisa 各一套）

2. **`~/.openclaw/workspace-andy/AGENTS.md`**：
   - Skill 自主管理从「直接 skill_manage」升级为两级机制
   - 弱信号（首次出现、尚不确定）→ `flag_for_skill`；稳定信号（2+ 次、pattern 清晰）→ `skill_manage create`

3. **`~/.openclaw/workspace-lisa/AGENTS.md`**：同上，弱信号示例换成 Lisa 实现场景

4. **Readme 系列文档全量对齐**：
   - `Docs/HomeAI Readme.md`：L1 段"两层"→"三层"（新增弱信号预标记层）
   - `Docs/00-project-overview.md`：6 处更新——V字协作链热路径、skill-candidates 写入描述、工具表 flag_for_skill 行、L1 Skill 自主管理三层表、flag_for_skill 工具签名（修正参数名 situation_type→pattern_name）、三轴进化"Lucas 感知"→"三角色感知"
   - `~/HomeAI/CLAUDE.md`：Lucas 21专属→20专属，共享 9→10，flag_for_skill 迁移到共享工具

**设计决策**：
- `flag_for_skill` 工具签名中实际参数（`pattern_name`/`description`/`suggested_form`）与 00-project-overview 文档记录（`situation_type`/`examples`/`context`）存在历史漂移，本次一并修正
- 两级机制门槛：弱信号首次即可 flag（低门槛，不遗漏）；稳定信号 2+ 次才直接结晶（高确信，不产生劣质 Skill）
- L1 与 L4 职责边界：agent 任务中感知 = L1；HEARTBEAT 批处理候选池 = L4；两者配合才能让结晶链路真正转起来

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`
- `~/.openclaw/workspace-andy/AGENTS.md`
- `~/.openclaw/workspace-lisa/AGENTS.md`
- `Docs/HomeAI Readme.md`
- `Docs/00-project-overview.md`
- `Docs/09-evolution-version.md`（本条目）
- `~/HomeAI/CLAUDE.md`

---

## v678 · Closet 两层记忆检索架构 + Loop 1 意志感修复（2026-04-15）

### 背景

两个独立问题：
1. **检索质量**：直接对全文 `conversations` 做向量搜索，因文档长且噪音高，语义精度差（实测 top-10 全不相关）。MemPalace 借鉴机会明确。
2. **意志感减弱**：Lucas 在 04:18 `share_with_andy` 失败，且对"HyperAgents：跨领域自主进化系统"视频没有主动触发知识分享循环（Loop 1），根因：① Gateway flapping；② Loop 1 正则未覆盖 AI/视频类内容。

### 变更内容

#### 1. Closet 两层检索架构（参考 MemPalace）

新增 `conversations_closets` ChromaDB 集合作为紧凑索引层：
- **格式**：`[hall_type] entityTags: prompt摘要(120字) | response摘要(80字) →drawerId`
- **写入**：`writeMemory` 每次写 drawer 同时写对应 closet，失败不影响主链路
- **检索**（`closetFirstSearch`）：
  1. query `conversations_closets`（小文档，语义精度高）取 nClosets=20
  2. 语义命中集合内按 **timestamp 降序**重排（新结论优先，解决旧结论压过新结论的问题）
  3. 提取去重 `drawer_id` → `chromaGetByIds("conversations", drawerIds)` 批量拉完整原文
  4. 返回空时 fallback 到原 `chromaQuery("conversations", ...)`
- **接入点**：`queryMemories` Step 3a + `recall_memory` Step 5，均为 closet-first → fallback
- **历史回填**：`HomeAILocal/Scripts/backfill-conversations-closets.py`，首次部署后执行，幂等

#### 2. Loop 1 知识感知正则扩展

`KNOWLEDGE_SHARE_RE` 新增覆盖：AI/大模型/Agent/架构/系统设计类内容、抖音/B站/视频类内容、「值得了解/学习/借鉴」等表达，解决 HyperAgents 类视频场景未命中问题。

#### 3. Gateway flapping 根因确认

Gateway flapping 根因：旧进程 pid 占端口 + watchdog 反复触发 EADDRINUSE，`share_with_andy` 失败是副作用非工具 bug。修复：`pkill -f openclaw-gateway && start-gateway.sh` 重启干净进程。

### 设计决策

- **为什么不用 AAAK 压缩**：MemPalace 的 AAAK 是 30x 有损压缩，为英文设计，中文语义保留率不确定。closet 用可读摘要（prompt[:120] | response[:80]）更安全，中文效果可验证。
- **为什么在语义集合内按时间排而非全局时间排**：全局时间排会完全失去语义过滤，语义集合内排是"相关但最新"的最优平衡——先过语义门槛，门槛内最新的排前面。
- **backward compatibility 设计**：`conversations_closets` 为空时 fallback，存量 conversations 记录不影响可用性，回填脚本是增量提升而非必要条件。

### 修改文件

- `CrewClaw/crewclaw-routing/index.ts`（新增 `chromaGetByIds` / `buildClosetDoc` / `closetFirstSearch`；`writeMemory` 新增 closet 写入；`queryMemories` / `recall_memory` 接入 closet-first；Loop 1 正则扩展；timestamp 重排）
- `HomeAILocal/Scripts/backfill-conversations-closets.py`（新增）
- `Docs/HomeAI Readme.md`（L0 里程碑加 Closet 架构描述）
- `Docs/00-project-overview.md`（Entity Tags 段后新增 Closet 两层检索架构设计说明）

---

## v679 · Lucas 对话质量优化 + 模型切换（2026-04-15）

**背景**：Lucas 近期对话暴露 5 个系统性问题——批量消息回复灾难（9 个视频 = 9 条一模一样的长回复）、记忆编造、场景误判、回复过长、虚假承诺。爸爸反复纠正「想不起来就想不起来，不能编」「你整个记忆都有点混乱」。

### 改动 1：行为规则强化（P1+P3+P4）

`crewclaw-routing/config/lucas-behavioral-rules.json` 新增 3 条铁律：
- **certaintyRule**：不确定必须说不确定，禁止编造具体日期/数字/人名/地点
- **lengthRule**：日常回复不超过 150 字硬限制，简单问答 50 字内
- **statusRule**：后台处理中的任务只能说「收到了，后台在处理」，不能说已完成

注入方式：`index.ts` 在 `progressRule` 注入后追加三条规则到 `appendSystem`，每轮必注入。

`workspace-lucas/AGENTS.md` 强化对应表述：第 11 行长度规则、第 13 行不确定性规则措辞更硬。

### 改动 2：消息聚合器（P0）

`wecom/index.js` 新增 `MessageAggregator` 类：
- 2 秒 debounce，同用户同类型消息合并为一次 Lucas 调用
- ≥3 条消息时注入场景提示「家人短时间内连续发送 N 条同类型消息，简洁回复」
- 单条消息直接走原流程，延迟增加 < 2 秒

新增 `transcriptionBuffer`：抖音视频转录完成后按用户聚合，3 秒 debounce，最后一条完成时合并推送，避免 N 个视频 = N 条独立推送。

`task-manager.js` 新增 `getPendingCount(userId, taskType)` 方法供聚合器查询。

### 改动 3：L2 改进

- **任务状态自动注入**：`index.ts` `before_prompt_build` 中读取 taskRegistry，向 Lucas appendSystem 注入真实活跃任务状态（含运行时间），家人问进度时 Lucas 基于真实数据回答，不编造。
- **术语后处理**：`stripInternalTerms()` 清洗技术术语（pm2/Gateway/spec/pipeline 等），Andy/Lisa 名称保留（家人熟知）。

### 改动 4：Lucas 模型切换

Lucas 从 `deepseek/deepseek-chat` 切换为 `dashscope/qwen3.6-plus`（阿里云 DashScope API）。
- `openclaw.json` 新增 `dashscope` provider + Lucas agent model 更新
- `start-gateway.sh` 环境变量 `LUCAS_CLOUD_PROVIDER/MODEL` + `DASHSCOPE_API_KEY`
- `index.ts` provider 注释补充 `dashscope`

### 改动 5：Bug 修复

- **recall_memory `entityHits` 作用域 bug**：`entityHits` 在 `if (kuzuEntityMapLoaded)` 块内 `const` 声明，块外引用 → `ReferenceError`。修复：提升到块外，`kuzuEntityMapLoaded` 为 false 时默认空数组。
- 此 bug 导致 `recall_memory` 工具完全不可用（不是 ChromaDB 服务问题）。

### 修改文件

- `CrewClaw/crewclaw-routing/config/lucas-behavioral-rules.json`（新增 3 条规则）
- `CrewClaw/crewclaw-routing/index.ts`（规则注入 + 任务状态注入 + entityHits 修复 + provider 注释）
- `~/.openclaw/workspace-lucas/AGENTS.md`（强化表述）
- `CrewClaw/daemons/entrances/wecom/index.js`（MessageAggregator + transcriptionBuffer + stripInternalTerms）
- `CrewClaw/daemons/entrances/wecom/task-manager.js`（getPendingCount）
- `~/.openclaw/openclaw.json`（dashscope provider + Lucas model）
- `~/.openclaw/start-gateway.sh`（环境变量）
- `Docs/04-project-constitution.md`（模型表更新）
- `Docs/09-evolution-version.md`（本条记录）
- `~/HomeAI/CLAUDE.md`（动态区更新）

---

## v679b · 基础设施修复 + L4 微调闭环接通 + 本地模型路由激活（2026-04-15）

**干预类型**：基础设施修复 + L4 里程碑推进

**背景**：watchdog 多处配置错误导致巡检数据路径不一致；L4 微调管道各环节已就绪但未桥接；本地模型仍路由到已停止的 mlx_lm.server（gemma-4-lucas）而非 Ollama homeai-assistant；wecom 入口存在未捕获 Promise rejection 导致进程崩溃；Lucas 系统提示定位不准确。

**变更清单**：

### 1. watchdog 修复

- **HOMEAI_ROOT 路径修正**：`gateway-watchdog.js` 中 `HOMEAI_ROOT` 硬编码路径与实际不一致，改为从环境变量读取并回退到 `~/HomeAI`
- **检查间隔 1h→5min**：watchdog 检查间隔从 1 小时缩短为 5 分钟，匹配 PM2 配置描述
- **数据路径统一**：日志、Kuzu 临时查询脚本、状态文件路径统一到 `~/HomeAI/` 根目录下的标准位置

### 2. L4 微调闭环接通

- **finetune-queue→pending-samples 桥接**：`bridge-finetune-queue.py` 脚本将 `andy-spec-finetune-queue.jsonl`（eligible 条目）和 DPO confirmed 条目桥接到 MLX LoRA 训练的 `pending-samples.jsonl` 统一格式
- **3416 条样本就绪**：桥接后共 3416 条训练样本（含 Andy spec SFT + Lucas DPO），满足 LoRA 微调数量要求
- **run-finetune.sh 闭环**：新增 `run-finetune.sh` 脚本，一键执行 LoRA 训练→权重 fuse→GGUF 量化→ollama create，从数据到可用模型全链路打通

### 3. 本地模型路由激活

- **localProvider 切换**：`openclaw.json` 中 `localProvider` 从 `mlx/gemma-4-lucas`（已停止的 mlx_lm.server）切换到 `ollama/homeai-assistant`（基于 Qwen2.5-Coder-32B-4bit LoRA 微调）
- **Ollama 注册 homeai-assistant**：微调产物（GGUF 格式）通过 `ollama create homeai-assistant` 注册到本地 Ollama 服务，端口 11434
- **效果**：低复杂度路由从不可用变为实际走本地 Ollama，Axis 3 本地专精进化正式启动

### 4. wecom 崩溃修复

- **unhandledRejection 兜底**：`wecom/index.js` 添加 `process.on('unhandledRejection')` 全局捕获，记录日志后不崩溃，防止未预期的 Promise rejection 导致进程退出
- **40008 错误路由修正**：企业微信 API 返回 40008（消息格式错误）时，原路由逻辑将错误消息再次发送给用户形成死循环；修正为记录日志并跳过，不重发

### 5. Lucas 身份

- **系统提示更新**：Lucas 的 IDENTITY.md / SOUL.md 中系统提示从"家庭助手"改为"曾家的小儿子"，强化家人身份定位而非工具属性

### 修改文件

- `HomeAILocal/Scripts/gateway-watchdog.js`（HOMEAI_ROOT + 间隔 + 路径统一）
- `HomeAILocal/Scripts/bridge-finetune-queue.py`（新增）
- `HomeAILocal/Scripts/run-finetune.sh`（新增）
- `~/.openclaw/openclaw.json`（localProvider 切换）
- `CrewClaw/daemons/entrances/wecom/index.js`（unhandledRejection + 40008 修正）
- `~/.openclaw/workspace-lucas/IDENTITY.md` / `SOUL.md`（身份定位更新）
- `Docs/09-evolution-version.md`（本条记录）
- `~/HomeAI/CLAUDE.md`（动态区更新）

---

## v684 · 访客=外围组织成员，Lx 权限模型重构（2026-04-15）

**干预类型**：架构决策（Lx 机制定义）

**背景**：访客不应是"外部用户"，而是"外围组织成员"。任何组织都有核心成员和外围成员——企业有正式员工和合作伙伴/客户，学校有教师和家长/校友。外围成员与核心成员在 L2 上体验完全一致，但在 L3/L4 引导权上受限。

**变更内容**：

1. **L3 表格行**（00-project-overview.md）：从"外部用户管理与核心成员隔离但体验对齐"改为"外围成员是组织成员——L2 体验与核心成员完全对齐，但不可引导组织演化"
2. **新增 Lx 权限模型节**：核心成员 vs 外围成员在各层的权限对比表，明确"引导类工具封锁、L2 开发类开放"的设计原则
3. **Shadow Agent 节**：从"访客 Shadow Agent"重命名为"外围成员 Shadow Agent"
4. **进度反馈原则**：从"对内部成员和外部用户体验一致"改为"核心成员与外围成员体验一致——L2 不分内外"

**待跟进**：当前 `visitor-restrictions.json` 封锁了 `list_active_tasks`/`cancel_task`/`report_bug`/`follow_up_requirement`/`record_outcome_feedback` 等 L2 工具，与新原则不一致。需要调整为：L2 工具解封，仅保留引导类工具封锁（`flag_for_skill`/`create_member_shadow`/`gen_visitor_invite`）和隐私类封锁（`recall_memory`/`query_member_profile`/`send_*`）。

**修改文件**：
- `Docs/00-project-overview.md`（L3 表格行 + 新增权限模型节 + Shadow Agent 重命名）
- `Docs/09-evolution-version.md`（本条记录）

---

## v683 · L2 三方向实现：patch_file/状态同步/审批gate（2026-04-15）

**干预类型**：L2 功能实现（稳定输出 + 过程可见 + 可选干预）

**背景**：Readme 系列文档刷新了 L2 本质对标设计（稳定输出+过程可见+可选干预），四个实现方向中三个需要代码实现（小弟并行 v682 已完成）。

**方向 1：patch_file 工具**（P1，对稳定输出贡献最大）
- 新工具 `patch_file`：Andy/Lisa 共享，exact string replacement（old_string→new_string）
- 原子写入（tmp→rename），路径限定 $HOME/，唯一性检查，支持 replace_all
- 幻觉防护更新：patch_file 合法（Lisa 在 spec 含 edit_patches 时可用），其余 edit/write 仍拦截
- Lisa AGENTS.md 铁律更新：patch_file 在 edit_patches 场景下的例外说明
- Andy TOOLS.md 新增 patch_file 文档

**方向 2：流式状态同步**（P2，对过程可见贡献最大）
- 三个阶段转换点通过 Lucas 推送进度（收到→设计完成→验收中），不直接推用户
- `pushStageToLucas` → `callGatewayAgent(FRONTEND_AGENT_ID, ...)`，由 Lucas 根据用户身份决定怎么告知（千人千面）
- 多方案审批通知也走 Lucas，单方案删除 `pushEventDriven` 直接推送
- 去重守卫 `stagePushTracker`：每任务每阶段最多推送一次，48h 自动清理
- 最终交付报告（成功/失败）保留 `pushEventDriven` 直接推送——这是结果通知，不是过程同步

**方向 3：方案审批 gate**（P3，对可选干预贡献最大）
- 多方案时通过 Lucas 推送方案选项 + 5 分钟超时默认推荐方案
- `pendingApprovals` Map + Promise 等待机制（不阻塞工具返回）
- `select_spec_approach` 增加审批拦截：有 pending approval 时直接 resolve，不走 cancel+retrigger
- 单方案也通过 Lucas 通知（千人千面），不直接推用户

**未修改 index.ts 以外的框架代码**：三个方向全部在插件层实现。

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`（工具注册/幻觉防护/状态同步/审批 gate）
- `~/.openclaw/workspace-lisa/AGENTS.md`（铁律更新）
- `~/.openclaw/workspace-andy/TOOLS.md`（patch_file 文档）
- `Docs/09-evolution-version.md`（本条记录）

---

## v680 · 开发协作链去重误判修复（2026-04-15）

**干预类型**：L2 协作链 bug 修复

**问题**：`trigger_development_pipeline` 的在途任务去重几乎每次都触发误判，阻止新需求提交。根因是 `bigramScore` 用**绝对数** `>= 3` 做阈值，但中文常见前缀（"做一个"→2个 bigram，"开发一个"→3个，"爸爸想要"→3个）极易撞线，两个完全不同的需求被误判为"相似"。

**修复**：`bigramScore` 去重判断从绝对数改为**重叠比率**（重叠 bigram 数 / 较短串长度-1），三处阈值调整：
- 在途任务去重：`score >= 3` → `ratio >= 0.7`（70% bigram 重叠才拦截）
- 能力注册表检查：`score >= 3` → `ratio >= 0.7`
- Skill 匹配推荐：`score >= 2` → `ratio >= 0.5`（稍宽松，推荐比硬拦截风险低）

**验证**：修复后"做一个抖音数据看板" vs "做一个微信公众号看板"（ratio 0.38）正确通过；"做一个抖音数据看板分析播放量趋势" vs "做一个抖音播放量数据看板分析趋势"（ratio 0.80）正确拦截。

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`（三处 bigramScore 去重改为 ratio 判断）

---

## v682 · Andy/Lisa 按需小弟使用策略（2026-04-15）

**干预类型**：L4 行为层配置（不改基础设施）

**背景**：Andy 和 Lisa 都是单线程工作——Andy 串行调研→读代码→写 spec，Lisa 串行实现→验证。效率瓶颈不在模型能力，在于串行。`create_sub_agent` / `evict_sub_agent` / `callGatewayAgent` 基础设施已就绪，但 Andy/Lisa 不知道何时该 spawn 小弟并行。

**方案**：纯行为层规则（AGENTS.md），不加新基础设施。

**新增内容**：

1. **Andy AGENTS.md** `## 小弟使用策略（v682）`：
   - 场景 1：调研+读代码并行（触发条件：spec 涉及技术选型/API 不确定）
   - 场景 2：验收代码审查并行（触发条件：integration_points ≥ 3 文件）
   - 约束：同时最多 1 个小弟，tier="1"，任务完成必须 evict

2. **Lisa AGENTS.md** `## 小弟使用策略（v682）`：
   - 场景 3：实现+验证并行（触发条件：acceptance_criteria ≥ 3 条）
   - 同样约束：最多 1 小弟，tier="1"，必须 evict

**未修改 index.ts**：现有工具足够，瓶颈在行为层而非基础设施层。

**待观察**：小弟实际使用频率、Gateway 重启成本（~15s）是否抵消并行收益、轻量任务是否值得走本地模型。

**修改文件**：
- `~/.openclaw/workspace-andy/AGENTS.md`（新增小弟使用策略节）
- `~/.openclaw/workspace-lisa/AGENTS.md`（新增小弟使用策略节）
- `Docs/09-evolution-version.md`（本条记录）

---

## v689 · L3 影子节点协作框架 + manage_nodes 内存注册表重构（2026-04-17）

**干预类型**：架构变更（L3 节点协作 + bug修复）

**背景**：之前 manage_nodes 依赖 localhost:3004 的独立 node-monitor 服务，但该服务从未部署。同时 manage_nodes 限制为 Andy/Lisa 专用，但 Lucas 作为家庭成员节点的配置者也应该有权限。

**改造内容**：

1. **manage_nodes 权限修复**：Lucas 已加入 ALLOWED 集合（`FRONTEND_AGENT_ID`），现在 Lucas/Andy/Lisa 均可使用
2. **管理架构重构**：manage_nodes 改用 Gateway 内存中的 nodeRegistryStore（注册数据已在其中）和 nodeActivityStore（心跳），移除对独立 node-monitor 服务的 HTTP 依赖
3. **统一 nodeId 格式**：所有端点（register/heartbeat/results）的 nodeActivityStore key 统一为 `node_${nodeName.replace(/[^a-zA-Z0-9]/g, "_")}`
4. **L3 影子节点设计固化**：节点 = 家庭成员私人 AI 助理物理载体，Lucas 配置，Kuzu HAS_SHADOW_NODE 协作边沉淀
5. **Kuzu AI_Node 实体**：节点注册时自动在 Kuzu 创建 AI_Node 实体和 HAS_SHADOW_NODE 边
6. **jiti 缓存陷阱发现**：Gateway 重启后 node_modules/.cache/jiti/ 缓存旧代码，导致 index.ts 修改不生效。必须删除该缓存才能让新代码生效

**框架层判断**：
- 节点属于影子（家庭成员），不属于 Andy/Lisa（框架小弟）
- 框架层提供节点协作机制（HTTP 注册端点 + 内存注册表 + Kuzu 协作边），不感知 Channel 实现
- 节点协作协议 = 框架层机制，内容（节点归属、配置）= 实例层

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`（权限修复 + 重构 + L3 节点协作 + Kuzu 边）
- `CrewClaw/daemons/entrances/wecom/index.js`（代理端点透传 owner_userId + hostname）
- `Docs/00-project-overview.md`（L3 表格和摘要更新）
- `Docs/10-engineering-notes.md`（jiti 缓存陷阱记录）
- `CLAUDE.md`（动态区更新 + 版本递增）

**待观察**：
- 节点注册后 Kuzu 协作边是否正确建立
- Gateway 重启后节点列表清空——需要持久化方案
- 节点上 Claude Code 插件的实际协作效果

---

## 附录：组织级AI必要性反思（2026-04-17）

**讨论背景**：发现 OpenClaw 生态有 `openclaw-claude-code` 插件，节点集成后触发对 CrewHiveClaw 架构的反思——折腾 L2/L3/L4 是否真的有必要。

**核心讨论**：
- CrewHiveClaw 的真正价值：Lucas 需求理解层 + 跨成员记忆 + 影子 Agent + 多节点协调
- 过度设计的部分：Andy/Lisa 协作链（对家庭规模太重）、L3/L4 进化体系（需要真实数据驱动）、蒸馏管道（空转风险）
- 简单方案（节点 + Claude Code 插件）可能解决 80% 问题

**结论**：架构跟着需求走，不是需求跟着架构走。先用最小化方案跑通，真实需求出现再加复杂。

**状态**：待后续验证

---

## v701 · OpenClaw 生态评估 + 三层架构修复 + Clawhub 接入（2026-04-20）

**干预类型**：架构修复（框架层漂移纠正）+ 生态机制接入

**背景**：发现 HomeAI 系统存在三处架构漂移，偏离"OpenClaw 生态二次开发"的设计原则：
1. 框架层代码中硬编码了实例专属字面量（`"main"`, `"lucas"`, `"andy"`, 家人 ID 列表）
2. `agentWorkspaceMap` 错误地将 agentId 映射到 workspace 目录名——但 workspace 目录名本来就等于 agentId，是无意义且有害的中间层
3. "生态优先"原则（先查 OpenClaw Skills → Clawhub → 再自建）只停留在 Andy AGENTS.md 软记忆，从未被机械执行（`best-practice-evaluation` Skill 显示 `used=0`）

同时发现 Skill 追踪机制对所有手写 Skill 完全失效（`used=0 completed=0`），根因是缺少 `## 操作步骤` 节。

**改造内容**：

1. **硬编码字面量清除**：
   - `MONITOR_AGENT_ID` 常量（env-var-backed，默认 `"main"`）
   - `FAMILY_USER_IDS_SET`（Set，来自 `FAMILY_USER_IDS` 环境变量）
   - 所有 `"main"` 字面量改为 `MONITOR_AGENT_ID`，`"andy"` 改为 `DESIGNER_AGENT_ID`，`callAgentModel("lucas")` 改为 `FRONTEND_AGENT_ID`
   - `FAMILY_USER_IDS` 数组改 Set，性能和语义更正确

2. **agentWorkspaceMap 移除**：
   - 原代码：`agentWorkspaceMap[agentId] ?? agentId` 映射三个 agentId 到 workspace 目录名
   - 修复：`const agentLabel = agentId;`（workspace 目录名 = agentId，框架层无需映射）
   - 3 处出现全部移除

3. **Clawhub 生态扫描机制**（trigger_development_pipeline）：
   - `clawhub search <query>` 调用，5s 超时，解析 `slug Name (score)` 格式
   - 高相关（score ≥ 2.5）：软拦截，返回 Clawhub 安装建议，不进入 Andy pipeline
   - 低相关（score 1.8~2.5）：注入 Andy brief 作为参考，不阻断
   - 提供 `忽略Clawhub检查` 逃逸机制（用户主动跳过时）

4. **App 使用追踪**（send_message）：
   - 检测 text 中的 `/app/` URL 模式，写入 `Data/learning/app-usage.jsonl`
   - fire-and-forget，失败不影响发送

5. **lifecycle-manager.py 增强**：
   - `--gc`：对 stale/never-used 的 top-3 Skill 调 Clawhub 搜索，给出"淘汰建议+生态替代"
   - `--report`：统计 app-usage.jsonl 的 App 使用频率

6. **Skill 追踪修复**：
   - 14 个手写 Skill 全部补充 `## 操作步骤` 节（`- toolName: 描述` 格式）
   - 纯认知类 Skill 用 `- think:` 占位，保证 parser 能解析
   - 自动 Skill 不受影响（生成时天然有操作步骤节）

7. **openclaw.json 一致性修复**：
   - Lucas agent `model` 字段：`minimax/MiniMax-M2.7` → `dashscope/qwen3.6-plus`
   - 原来实际路由已经走 dashscope（`start-gateway.sh` 环境变量），json 里的错误值只在 OpenClaw TUI 展示时误导

**框架层判断**：
- 常量化是框架层正确做法，实例层通过 env var 配置
- agentWorkspaceMap 是反框架模式——workspace 目录名 = agentId 是 OpenClaw 设计约定，不应有额外映射
- Clawhub 扫描是框架层机制（生态集成点），不含 HomeAI 专属内容
- App 追踪是框架层（通用学习数据收集），路径配置可通过 env var 覆盖

**修改文件**：
- `CrewClaw/crewclaw-routing/index.ts`（常量化 + agentWorkspaceMap 移除 + Clawhub 扫描 + App 追踪）
- `HomeAILocal/Scripts/lifecycle-manager.py`（Clawhub gc 建议 + App 报告统计）
- `CrewClaw/daemons/entrances/wecom/index.js`（bigram Jaccard 修复中文误杀，同次提交）
- `HomeAILocal/Scripts/distill-memories.py`（Kuzu has_pending_event 边去重，同次提交）
- `~/.openclaw/openclaw.json`（Lucas 模型字段一致性，git repo 外）
- 14 个手写 SKILL.md 文件（补 `## 操作步骤`）
- `Docs/10-engineering-notes.md`（Skill 追踪陷阱记录）
- `CLAUDE.md`（动态区更新 + 版本递增）

**待观察**：
- Clawhub 生态扫描首次触发效果
- Skill 追踪计数开始累积
- memory-core 能力边界（Problem 3，用户标记"稍后讨论"）

## v702 · Lx 自闭环原则设计（2026-04-21）

### 背景

爸爸在 2026-04-20 的对话中指出：系统当前的 Lx 质量评估完全依赖 Main 的外部 evaluate_l* 工具，这是补救而非主路径。每个 Lx 层内部本就应该有自我反思的闭环机制。

经过多轮讨论，澄清了两个关键区分：
1. **Lx 自闭环 ≠ Main 外部监控**：自闭环是动作级质量控制（即时、执行者自带），Main 是系统级长期指标跟踪（记忆召回率/协作成功率/劣化根因）
2. **自我反思 = 两阶段**：前置质控（做之前查历史约束）+ 后置效果验证（做之后设检查点回查）

### 变更内容

**`Docs/00-project-overview.md`**：
- 重写「Lx 自闭环原则」章节
- 五层 × 两阶段反思机制完整表格
- 明确与 Main 外部监控的分工

**`~/.openclaw/workspace-andy/AGENTS.md`**：
- 关键行为新增步骤 1.8：L1 前置质控（写 spec 前查同域历史失败记录）
- 检查 13 执行路径新增步骤 5：L4 后置效果验证（每次 L4 动作写 l4_improvement_action + 30 天检查点）
- 将错误的「L1 质量趋势自评」改正为「L1 失败模式结晶」（聚合失败 → 追加 DESIGN-PRINCIPLES.md）

### 设计要点

每次自进化动作的自我反思是质量控制手段；Main 的长期度量是外部积累监控。前者保证每次动作质量，后者保证系统整体方向正确。两者独立运作。

## v703 · L0/L1 记忆四维度评估 + probe 集方案（2026-04-21）

### 背景

爸爸在 2026-04-21 的对话中提出：Main 的 L0/L1 自动化评估缺少记忆质量维度。当前评估看进程存活、延迟、ChromaDB 可达性，但没有检测「记忆存储是否有效、检索是否准确」。

经过设计讨论，确立了分层原则：
- **L0 = 写入侧**：记忆是否正确写入（embedding 有效、字段完整）
- **L1 = 检索侧**：记忆是否能被正确检索（命中率、相关性）

记忆四维度：**语义**（embedding 向量有效率）、**时间**（timestamp 完整率）、**实体**（entityField 填充率）、**因果**（causal 类型记录，Lucas 专属）

probe 集方案参考业界 LongMemEval + RAGAS，选择 ground truth 评测集（Hit Rate@K + MRR）作为可量化指标。

### 变更内容

**`CrewClaw/crewclaw-routing/config/evaluation-rubric.json`**：
- L0 新增 `memory_write_health`（weight=1.0，higher_better，thresholds [[90,5],[80,4],[60,3],[40,2],[0,1]]）
- L1 新增 `memory_recall_quality`（weight=1.0，lower_better，thresholds [[0.35,5],[0.5,4],[0.65,3],[0.8,2],[2.0,1]]）

**`CrewClaw/daemons/entrances/wecom/index.js`**（L0 check 8 + L1 召回质量）：
- L0 Check 8：三角色（Lucas/Andy/Lisa）× 四维度（语义/时间/实体/因果）写入健康检查，fetch 最近 100 条记录统计各维度有效率，取三角色最低 embedding 有效率计入 rubric
- L1 canary 查询：三角色各用一条 canary query embed → ChromaDB top-3 → avg cosine distance + 时间/实体/因果维度检查，追加【召回质量】区块到 L1 报告
- L1 return 结构重组：【记忆质量】+【召回质量】+【输出质量】三块

**`HomeAILocal/Scripts/gen-memory-probes.py`**（新建）：
- 从 ChromaDB 三集合采样记录，用本地 LLM 生成自然语言探测问题，构建 ground truth 评测集
- 存入 `~/HomeAI/Data/learning/memory-probes.jsonl`
- 支持 `--all/--collection/--n/--review/--prune` 参数
- **待修复**：LLM 调用改用 DeepSeek API（本地 qwen3.6/homeai-assistant 均为推理模型，content 始终为空）

**`HomeAILocal/Scripts/eval-memory-probes.py`**（新建）：
- 读 memory-probes.jsonl，embed query → ChromaDB 检索 top-K → 计算 Hit Rate@1/3/5 + MRR
- 结果追加到 `~/HomeAI/Data/learning/memory-probe-results.jsonl`
- 支持 `--collection/--k/--json/--no-save` 参数，`--json` 模式供 evaluate_l1 调用

### 遗留问题

**ChromaDB L2 vs cosine 距离**：conversations / code_history 集合在创建时使用 L2 距离（非 cosine），导致 canary avg_dist 返回 200+，而 decisions 集合（cosine）返回 0.591。两套不可比的距离值使得统一 threshold 失效。后续决策：①重建为 cosine（数据损失风险）或 ②仅用 Hit Rate@K 评估，完全不依赖 distance 阈值。

**本地推理模型陷阱（新增工程约束）**：
- qwen3.6（Ollama）和 homeai-assistant（Ollama，底模 qwen3.6）均为推理模型
- 即使加 `/no_think` 前缀，thinking 内容也会泄漏进 content（英文推理步骤），生成的不是所需中文问题
- `num_predict` 小值（如 60/80）时 token 全被 thinking 耗尽，content 为空
- 解决方案：probe 生成改走 DeepSeek API（deepseek-chat，非推理模型）

---

## v704 — L0/L1 架构重定义：正朔文档 + 评估实现全面对齐

**日期**：2026-04-21
**触发**：系统工程师主动架构校准——L0/L1 定义精化，正朔文档与评估实现同步

### 核心变更

**架构认知刷新（最重要）**：
- **L0 = Agent 记忆与认知质量（写入侧）**：四维度（语义/时间/实体/因果）× 三角色记忆写入健康 + 蒸馏管道持续产出。基础设施（Gateway/磁盘/内存）是前提条件，不是 L0 核心定义。
- **L1 = Agent 人格完整度（召回侧）**：记忆语义召回质量 + 上下文工程形成人格连续性 + Skill 自动沉淀积累 + 行为模式结晶（Kuzu has_pattern）。

**指标归属调整**：
- `distillation_output`（design_learning/impl_learning）：L1 → L0（写入侧蒸馏产物）
- `family_inject`（Kuzu→inject.md 产物）：L1 → L0（写入侧档案文件）
- `collab_edges_readiness`：L0 移除，L3 已有 `collab_edges`（正确归属）
- `skill_accumulation`：L1 新增（native skills 总数，人格完整度的技能维度）
- 基础设施 items（disk/gateway_latency/chromadb_latency/memory_usage）：降权为 prerequisite（weight 从 0.5~1.0 降至 0.2~0.3）
- `memory_write_health`：L0 核心指标，weight 从 1.0 升至 1.5

### 文件变更清单

| 文件 | 变更内容 |
|------|---------|
| `Docs/00-project-overview.md` | Lx 表格 L0/L1 名称与描述完整刷新 |
| `crewclaw-routing/config/evaluation-rubric.json` | L0 label 改名，移入 family_inject/distillation_output，移除 collab_edges_readiness；L1 label 改名，移除旧项，新增 skill_accumulation；infra 项降权标注 prerequisite |
| `daemons/entrances/wecom/index.js` | evaluate_l0：新增 check 9（家人档案注入文件）、check 10（Andy/Lisa 蒸馏产出），更新评分提取；evaluate_l1：删除旧 check 3/4，新增 check 6（Skill 自动沉淀），更新评分提取，输出格式改为【模式沉淀】/【召回质量】/【表达质量】|

### 越界干预记录

无系统工程师手动越界。纯架构重对齐操作：正朔文档先行，代码跟进。

---

## v705 — L1→L0 反馈回路实装

**日期**：2026-04-21
**触发**：系统工程师主动完善——L0 写入质量盲点无法传导给 Andy 的设计缺口

### 核心变更

**反馈回路机制**：L1 召回侧评估识别到 L0 写入盲点 → 写入 `l0-recall-feedback.jsonl` → Andy `before_prompt_build` 注入 → Andy HEARTBEAT 推动 L0 改进。完整闭合 L0→L1→L0 进化环路。

**文件变更清单**：

| 文件 | 变更内容 |
|------|---------|
| `CrewClaw/crewclaw-routing/index.ts` | 新增 `checkAndWriteRecallFeedback()` 函数：采样 conversations/decisions/code_history 各 20 条，评估四维度（语义/时间/实体/因果）写入健康；填充率 < 70% 才写入 l0-recall-feedback.jsonl（保留最近 30 条）；agent_end 节流触发（50次请求或6h，fire-and-forget）；Andy before_prompt_build 读取 24h 内最新盲点注入「L0 记忆写入质量反馈」 |

### 越界干预记录

无系统工程师手动越界。新增机制不改变已有行为，纯新增路径。

---

## v706 — 内外循环框架设计正朔化 + 外循环教师工具实装

**日期**：2026-04-21
**触发**：系统工程师主动架构完善——进化质量保障缺少宏观外循环评估能力，且外循环设计未正朔化

### 核心变更

**设计正朔化（最重要）**：原「Lx 自闭环原则」章节重构为「进化质量保障：内循环 + 外循环」。明确两层定义：
- **内循环** = 每次进化动作的两阶段自我反思（前置质控 + 后置效果验证），不是进化本身而是质量保障
- **外循环** = Main 教师节点，周期性宏观评估，上帝视角，从真实数据主动构造测试
- **测试集构造原则**：必须从真实数据直接提取（90天前消息/真实决策/承诺记录），不用模型合成

**外循环教师工具实装**：

| 工具检测项 | 数据来源 | 产出 |
|-----------|---------|------|
| L0 时间分层退化检测 | conversations 400条，按 <30天 vs >90天分层 | 差值 pp，写入 temporal_degradation rubric |
| L1 教师召回测试（Hit Rate@3）| conversations 90天前真实人类消息，随机取3条 | origId 命中率，写入 teacher_hit_rate rubric |
| L1 承诺追踪测试 | requirements outcome="" 且 >30天 | 未落地需求数，写入 unresolved_requirements rubric |

**文件变更清单**：

| 文件 | 变更内容 |
|------|---------|
| `Docs/00-project-overview.md` | 「Lx 自闭环原则」章节重构为「进化质量保障：内循环 + 外循环」，内循环子章节保留，外循环新增；L0~L4 各层外循环评估表格；外循环两层执行结构图 |
| `CrewClaw/daemons/entrances/wecom/index.js` | evaluate_l0：新增时间分层退化检测（T节）；evaluate_l1：新增外循环教师测试 T1（Hit Rate@3）和 T2（承诺追踪）；rubric 评分追加三项 |
| `CrewClaw/crewclaw-routing/config/evaluation-rubric.json` | L0 新增 `temporal_degradation`（weight=1.0）；L1 新增 `teacher_hit_rate`（weight=1.2）和 `unresolved_requirements`（weight=0.8） |

### 越界干预记录

无系统工程师手动越界。正朔文档先行，代码跟进，外循环教师工具与已有 evaluate_l0/l1 体系对称实装。

---

## v707 — 2026-04-22

### 变更摘要

chatHistory 时间感修复 + 私聊跨渠道在场感 + Kuzu userId 大小写 bug 修复（6 个 context source 全部恢复）

### 核心变更

**chatHistory 时间感修复**：`buildHistoryMessages` 给每条消息加 `[今天 22:38]` / `[昨天 10:15]` / `[3天前]` 相对时间前缀（北京时间），Lucas 可感知对话时间距离，区分"刚才说的"和"上周的"。

**私聊跨渠道在场感**：新增 `getMostRecentGroupKey()` 和 `buildGroupContextMessages()`，私聊时自动前置 48h 内最近群聊消息（`[群聊 - 今天 22:38]` 前缀），替代原来机械触发 recall_memory 的 AGENTS.md 规则。

**Kuzu userId 大小写 bug 修复**（关键修复，影响 L0 全量 person 数据）：
- 根因：normalizeUserId() 小写化后 Kuzu 精确匹配失败，6 个 person 级 context source 长期静默返回空
- 修复：KUZU_USER_ID_MAP + toKuzuEntityId() 函数，SessionParams 新增 kuzuUserId 字段
- 影响范围：person-realtime / pending-events / active-threads / relationship-network / topic-resonance / causal-facts + queryCausalFacts / queryCausalFactsMultiHop

**文件变更清单**：

| 文件 | 变更内容 |
|------|---------|
| `CrewClaw/daemons/entrances/chat-history.js` | 新增 `_relativeTimeLabel`、`getMostRecentGroupKey`、`buildGroupContextMessages`；`buildHistoryMessages` 加时间前缀 |
| `CrewClaw/daemons/entrances/wecom/index.js` | 新增 `buildHistoryWithCrossChannel`；4 个 call site 替换；更新 require 导入 |
| `CrewClaw/crewclaw-routing/index.ts` | 新增 `KUZU_USER_ID_MAP` + `toKuzuEntityId()`；sessionParams 新增 `kuzuUserId`；queryCausalFacts/MultiHop 改用 kuzuId |
| `CrewClaw/crewclaw-routing/context-sources.ts` | SessionParams 新增 `kuzuUserId: string`；6 个 Kuzu person 源 params/Cypher 改用 kuzuUserId |
| `~/.openclaw/workspace-lucas/AGENTS.md` | 删除「私聊中引用群聊事件必须先 recall_memory」机械规则 |
| `Docs/10-engineering-notes.md` | 追加「Kuzu person 查询 userId 大小写不匹配」条目 |

### 越界干预记录

无系统工程师手动越界。修复均通过正常代码变更完成，编译验证通过后重启 Gateway。

---

## v708 — 2026-04-22

### 变更摘要

L0 四维度写入质量三连修：entityTags 缺失 + timestamp 72% + 因果评估逻辑误判

### 核心变更

**entityTags 缺失修复**：`addDecisionMemory` 和 `writeCodeHistory` 在 `embedText` 之后各加一行 `extractEntityHits(document).join(",")` 并写入 metadata。新写入的 decisions/code_history 条目开始携带实体标签，实体权重加成（×1.5 boost）对这两个集合生效。

**timestamp 72% 修复**：`seed-constraints.py` 根因是写入时未包含 `timestamp` 字段，导致 14 条 constraint 类型条目缺失时间维度。修复：`import datetime` + 生成 `seeded_at`（ISO 8601 + 08:00），metadata 加 `timestamp: c.get("confirmed_at", seeded_at)`。重新运行脚本 upsert 回填全部 14 条，decisions timestamp 填充率从 72% 升至接近 100%。

**因果评估逻辑修正（核心修复）**：`checkAndWriteRecallFeedback` 原来对 conversations/decisions/code_history 三集合各自检查 `causal_relation` metadata 字段，但因果关系设计在 Kuzu，ChromaDB 从不写此字段 → 永远 0% → 误报因果缺失 → Andy 收到虚假预警。修复：集合内 `causalOk = total`（N/A），循环结束后单独 `spawnSync` 查 Kuzu `MATCH ()-[r:causal_relation]->() RETURN count(r)`，≥10 条视为健康（rate=1.0）。Kuzu 有 166 条 causal_relation → causal rate = 1.0，不再误报。

**文件变更清单**：

| 文件 | 变更内容 |
|------|---------|
| `CrewClaw/crewclaw-routing/index.ts` | `addDecisionMemory` + `writeCodeHistory` 加 entityTags；`checkAndWriteRecallFeedback` 因果维度改为 Kuzu 计数 |
| `HomeAILocal/Scripts/seed-constraints.py` | `import datetime` + `seeded_at` + metadata 加 `timestamp` |

### 越界干预记录

无系统工程师手动越界。三项修复均为代码变更，编译验证通过后重启 Gateway。seed-constraints.py 重新运行完成存量回填。


---

## v710 — 2026-04-22

### 变更摘要

L4 SE 远程干预机制 + SE 可观测性增强 + 各 Agent 自主 Skill 结晶 + L0/L1 边界正朔化

### 核心变更

**L4 远程干预**：
- `register_l4_task` / `complete_l4_task` / `check_l4_control` 三工具（Andy 专属），任务看板 l4-tasks.json + 控制文件 l4-control.json
- SE 可发「叫停 l4-xxx / 暂停 L4 / 恢复 L4 / 查 L4」零 Token 命令，wecom/index.js 拦截前处理
- Andy HEARTBEAT 前置 L4 控制信号检查，global_pause=true 跳过所有主动改进

**SE 可观测性**：
- `write_file` 写入认知文件（AGENTS.md/SOUL.md/MEMORY.md/TOOLS.md/HEARTBEAT.md/DESIGN-PRINCIPLES.md）时自动 notifyEngineer（非阻塞）

**各 Agent 自主 Skill 结晶**：
- Andy HEARTBEAT 检查 1/2：只结晶 agent=andy 模式；Lucas/Lisa 候选路由给本人处理
- Lisa HEARTBEAT 新增检查 4（每周）：扫 code_history + behavior_patterns，直接 skill_manage
- Lucas HEARTBEAT 新增任务 7（每周）：扫 recall_memory + skill-candidates，直接 skill_manage

**skill_manage layer 参数**：
- 新增 `layer: "native" | "archive"`，archive 写归档层（status=draft，frontmatter 含完整生命周期字段）
- 三个 HEARTBEAT 文件统一改用 `skill_manage(action=create, layer="archive")`

**L0/L1 正朔**：
- Skill 结晶 = L0（写入侧）；L1 = 人格激活/召回侧；上下文预算管理为未来 L1 方向
- 00-project-overview.md Lx 表格 + "L0 Skill 能力沉淀"章节（原"L1 Skill 自主管理"）全部更新

---

## v709 — 2026-04-22

### 变更摘要

SE 超然观测者原则落地：移除所有 Bot 降级逻辑 + 移除 Andy 审批机制 + 三角色研发小队设计

### 架构决策

**系统工程师只是观测者，不参与任何业务循环。** 这条原则本次在两个维度彻底落地：

1. **Bot 通道纯化**：Lucas→家人的消息路径只走 Bot（`globalBotClient.sendMessage`），没有任何降级到企业应用通道的逻辑。Bot 失败 = 失败，通知 SE 记录异常，不把 Lucas 内容通过"系统工程师"名义发出——这是信息污染。企业应用通道（`sendWeComMessage`）现在只有一个合法用途：SE 自身的通信（`notify-engineer` endpoint）。

2. **Andy 审批机制移除**：Andy 不再向 SE 提交审批请求。认知文件修改、路由配置变更、新工具注册等，Andy 全权自决，事后 `notify_engineer` 告知。SE 是信息接收者，不是决策者。不确定方向时，Andy 与 Lucas 协商（`【来自Andy·方向协商】`），技术假设不确定时让 Lisa 做 Spike 验证。

### 核心变更

**`botSend(target, text)` 替代 `botPushOrFallback`**：新函数不含任何 fallback 逻辑，Bot 未就绪或发送失败直接抛错，调用方捕获后走 `notify-engineer` endpoint。

**所有 Bot 失败路径统一走 `notify-engineer`**：push-reply 私聊/群聊失败、send-message 私聊失败、send-file 群聊失败，均通过内部 HTTP fetch 调用 `http://localhost:{PORT}/api/wecom/notify-engineer`，保证每次 SE 通知同时写入 ChromaDB `agent_interactions`（fire-and-forget，Ollama nomic-embed-text 嵌入）。

**`notify-engineer` ChromaDB 持久化**：每次 SE 通知在成功发出企业微信消息后，异步写入 ChromaDB `agent_interactions` 集合，供 Main `recall_memory` 做问题分析。

**`request_approval` 工具移除**：从 `crewclaw-routing/index.ts` 完整移除，编译验证通过。Main 的 `查待审批`/`批准 [ID]`/`拒绝 [ID]` 命令处理器同步移除，Andy HEARTBEAT 检查 0 的审批执行逻辑同步移除。

**三角色研发小队设计**：Andy 方向不确定 → Lucas 协商（业务判断）；技术假设不确定 → Lisa Spike（方法 C：`/tmp/homeai-spike/` 隔离目录，bash 执行，真实输出）。

**认知文件同步**：
- Andy AGENTS.md：移除审批边界表，新增全权自决范围 + Lucas 协商触发条件 + Lisa Spike 协作模式 + 调研能力（GitHub clone + Kuzu 代码图谱）
- Andy TOOLS.md：移除 `request_approval` 行，更新 `notify_engineer`/`query_requirement_owner`/`research_task` 描述
- Lisa AGENTS.md：新增方法 C（Technical Spike）章节
- Lucas AGENTS.md：新增 `【来自Andy·方向协商】` 处理规则
- 00-project-overview.md：「Andy 自决 vs 需 SE 审批」改为「Andy 全权自决（三角色研发小队）」表格

### 文件变更清单

| 文件 | 变更内容 |
|------|---------|
| `CrewClaw/daemons/entrances/wecom/index.js` | 新增 `botSend`；移除 `botPushOrFallback`；所有 Bot 失败路径改走 `notify-engineer` endpoint；`notify-engineer` 新增 ChromaDB 持久化 |
| `CrewClaw/crewclaw-routing/index.ts` | 移除 `request_approval` 工具；移除 Main 审批命令处理器；移除 Andy HEARTBEAT 检查 0 审批执行逻辑 |
| `~/.openclaw/workspace-andy/AGENTS.md` | 全权自决设计 + Lucas 协商触发 + Lisa Spike 协作 + 调研能力 |
| `~/.openclaw/workspace-andy/TOOLS.md` | 移除 `request_approval`；更新三个工具描述 |
| `~/.openclaw/workspace-lisa/AGENTS.md` | 新增方法 C（Technical Spike）|
| `~/.openclaw/workspace-lucas/AGENTS.md` | 新增 `【来自Andy·方向协商】` 处理规则 |
| `Docs/00-project-overview.md` | Andy 特殊原则章节重写 |

### 越界干预记录

本次变更由系统工程师发起并主导（正确越界）：发现 Bot 降级逻辑和 SE 审批机制违反「SE 超然观测者」原则，属于架构级错误，通过代码变更和认知文件更新完成矫正。记录于此作为后续设计参考。

---

## v711 · SE 可观测性修复 + Readme 正朔刷新

**日期**：2026-04-22
**类型**：越界干预（SE 主导可观测性修复）+ 正朔刷新

### 背景

延续上一会话的 SE 可观测性审计工作，并完成本会话的 Readme 系列文档刷新（将代码变更同步至正朔）。

### 关键变更

**SE 可观测性补全（`crewclaw-routing/index.ts`）**：

审计发现两处 SE 观测盲点并修复：

1. **`request_andy_evaluation`**（Andy 工具）：Lisa-evaluator 审 Andy spec，但 SE 之前完全看不到审查结果。补充两个 `notifyEngineer`：
   - 调 evaluator 前：`【Andy 请求 Spec 审查】[req_id] spec_summary...`
   - 结果返回后：`【Spec 审查结论】[req_id] PASS ✅ / FAIL ❌ + 结论摘要`
   与 `request_evaluation`（Lisa 工具）的对称可观测性对齐。

2. **`cancel_task`**（Lucas 工具）：Lucas 叫停任务时 SE 完全不知情。补充 `notifyEngineer`：
   - `markTaskStatus(target.id, 'cancelled')` 之后：`【任务叫停】Lucas 取消了任务\nID: xxx\n需求：...`

编译验证通过（`check-plugin.sh` exit 0），Gateway 重启成功（`/health` ok）。

**`00-project-overview.md` 正朔刷新（6 处更新）**：

将前几个版本（pipeline 任务统一、Andy HEARTBEAT 计划模式）的代码变更同步至文档：

1. **外循环流程图（Line 464）**：`main-pending-tasks.json` → `task-registry.json`（requires_approval 标记说明）
2. **`evaluate_system` 描述（Line 1524）**：写入目标改为 `task-registry.json`，补充 requires_approval=false/true 说明
3. **`log_improvement_task` 描述（Line 1526）**：路径改为 `data/learning/task-registry.json`
4. **定时任务表（Line 2086）**：Andy HEARTBEAT 改为 `23:00-23:30 CST 固定窗口`，描述改为计划模式
5. **Andy HEARTBEAT 全描述（Line 2844）**：整段替换为计划模式描述（三步骤 + JSON 计划 + requires_approval 批准规则 + Skill 结晶规则）
6. **SE 观测信号表（Line 1557 后）**：新增 `data/learning/task-registry.json` 行（包含 API 端点说明）

**正朔协议**：Andy 认知文件已正确使用 `task-registry` 引用，无需更新。

### 文件变更清单

| 文件 | 变更内容 |
|------|---------|
| `CrewClaw/crewclaw-routing/index.ts` | `request_andy_evaluation` 补充 2 个 notifyEngineer；`cancel_task` 补充 1 个 notifyEngineer |
| `Docs/00-project-overview.md` | 6 处更新（详见上方）|
| `HomeAI/CLAUDE.md` | 版本 v710→v711，Readme 刷新记录 |

### 越界干预记录

`request_andy_evaluation` 和 `cancel_task` 可观测性修复属于基础设施层面的架构修正（SE 超然观测者原则），由系统工程师主导介入，记录于此。

---

## v715 · Andy AGENTS.md 瘦身 + Skill 分层 + L1 运行时管控（2026-04-23）

**干预类型**：架构变更（L1 写入侧质量管控 + Andy 认知文件优化）

**背景**：Andy AGENTS.md 膨胀至 43277 chars（689行），远超 OpenClaw 12000 char 截断上限，后半内容实际上从未被读到。大量「正确/错误对照示例」、Coordinator 完整 JSON、调研代码片段等场景触发型内容占据大量篇幅，属于「不适合压缩、应按需加载」的 Skill 内容。

**改造内容**：

### 1. Andy AGENTS.md 瘦身

- 43277 chars → 9814 chars（-77%）
- 删除内容：所有正确/错误做法示例段落、Coordinator 完整 sub-spec JSON 示例（2个）、三维主动性哲学叙事、小弟使用策略详细场景步骤、外部调研代码片段
- 保留内容：全部 18 个 section 标题、行为规则步骤 1~8、spec JSON 字段规范、工具调用铁律、检查13执行路径

**关键陷阱（AGENTS.md 字符 vs 字节）**：
OpenClaw 截断上限是 **字符数**（12000 chars），不是字节数。中文每字 3 字节，`wc -c` 给字节数，必须用 `python3 -c "len(open(...).read())"` 获取字符数。9814 chars = 16554 bytes，如果看字节数会误认为仍然超限。

### 2. 4 个 archive Skill 创建

存放路径：`~/HomeAI/Data/learning/auto-skills/andy/{skill-name}/SKILL.md`

| Skill | 内容 |
|-------|------|
| coordinator-spec | 大特性 Coordinator 模式：C1 接口契约前置 / C2 拆分自验清单 / C3 完整 JSON 格式 / C4 触发方式 |
| spec-examples | consult_lisa vs trigger_lisa 区分 / Lucas交付简报格式 / bug_fix original_symptom / 验收阶段判断 |
| research-workflow | git clone --depth=1 / Kuzu 临时图谱 source='research' / 生命周期清理 / 蒸馏边界 |
| sub-agent-strategy | 场景1（调研并行）/ 场景2（验收并行）/ 工作分配格式 / create/evict 命令 |

**层级分工**：native（≤15，OpenClaw 全量注入）vs archive（无上限，`recallAutoSkills` 按关键词召回 top-3）。场景触发型内容一律放 archive。

### 3. index.ts 三机制实装

**机制1：AGENTS.md 溢出检测**（`agent_end` hook）
- 检测 `AGENTS.md > 10000 chars`（soft limit，低于 OpenClaw 12000 上限保留余量）
- 7 天去重：防止每次 `agent_end` 重复写同一信号
- 写入 `skill-candidates.jsonl`：`source: "agents_overflow", suggested_form: "agents_to_skill_migration"`

**机制2：archive Skill 自动晋升 native**（Phase 2 末尾）
- 条件：`success_count ≥ 3` + `fail_rate < 30%` + `native Skill < 15`
- 动作：复制 archive Skill 到 native，`status: active`；archive 保留，`status: promoted`
- 效果：经过验证的 Skill 自动上升，无需手动操作

**机制3：skill_manage create 层级分类校验**（`atomicWrite` 前）
- 触发词检测：`["当.*时", "需要.*时", "场景.*：", "遇到.*时", "触发条件", "适用.*场景", "使用.*时机"]`
- 检测到触发型 Skill → 强制重定向到 archive 层，返回提示
- L1 运行时管控：将「什么内容适合放 Skill」从文字规则提升为代码级强制

编译验证：`bash ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/check-plugin.sh` → exit 0

### 文件变更清单

| 文件 | 变更内容 |
|------|---------|
| `~/.openclaw/workspace-andy/AGENTS.md` | 43277 chars → 9814 chars（-77%，全 18 节保留）|
| `~/HomeAI/Data/learning/auto-skills/andy/coordinator-spec/SKILL.md` | 新建 archive Skill |
| `~/HomeAI/Data/learning/auto-skills/andy/spec-examples/SKILL.md` | 新建 archive Skill |
| `~/HomeAI/Data/learning/auto-skills/andy/research-workflow/SKILL.md` | 新建 archive Skill |
| `~/HomeAI/Data/learning/auto-skills/andy/sub-agent-strategy/SKILL.md` | 新建 archive Skill |
| `CrewClaw/crewclaw-routing/index.ts` | +109行：三机制实装（溢出检测/自动晋升/层级校验）|

### 越界干预记录

index.ts 三机制将 L1 写入侧质量管控从 AGENTS.md 文字规则提升为运行时代码强制，属于框架层架构演进，由系统工程师主导介入，记录于此。

---

## v720（2026-04-24）：基础设施 launchd 化完成 + Andy Gemini 400 修复

### 版本目标

完成 cloudflared → launchd 迁移收尾，修复 wrong_agent 工具错误标记，根治 Andy（Gemini 3.1 Pro）多轮工具调用 400 崩溃。

### 变更内容

#### 1. cloudflared → launchd 迁移完成

`CrewClaw/daemons/ecosystem.config.js` 中 `cloudflared-tunnel` 条目注释，`~/Library/LaunchAgents/com.homeai.cloudflared.plist` 接管。至此三大关键进程全部 launchd 化：

| 进程 | 管理方式 | launchd label |
|------|----------|---------------|
| OpenClaw Gateway | launchd | `ai.homeclaw.gateway` |
| wecom-entrance | launchd | `com.homeai.wecom-entrance` |
| cloudflared-tunnel | launchd | `com.homeai.cloudflared` |

PM2 现在只管理 chromadb / local-tts / gateway-watchdog（基础支撑服务），不再管理任何关键通道进程。

#### 2. wrong_agent `isError: true` 修复（index.ts）

所有 wrong_agent 拒绝返回缺少 `isError: true`（OpenClaw 默认 false）。后果：Gemini 把工具错误当成功结果继续推理，导致后续行为混乱。修复：补全 43 处 wrong_agent 返回的 `isError: true`。

受影响工具：wrapCodingTool / search_web / ask_andy / ask_lisa / trigger_development_pipeline / trigger_lisa_implementation / report_bug / query_requirement_owner / report_implementation_issue / request_implementation_revision / trigger_lisa_integration / search_codebase 等。

#### 3. Google API 配置修复（`~/.openclaw/openclaw.json`）

**根因**：`"api": "openai-completions"` 使 OpenClaw 走 OpenAI 兼容路径，跳过 `sanitizeGoogleThinkingPayload`（thought_signature 透传），Gemini 3.1 Pro 多轮工具调用必然 400。

**修复**：
- `api`: `"openai-completions"` → `"google-generative-ai"`
- `baseUrl`: `…/v1beta/openai` → `…/v1beta`
- 移除 `compat.maxTokensField`

详见 `10-engineering-notes.md` §OpenClaw Google Provider thought_signature 陷阱。

### 越界干预记录

openclaw.json 配置修复属于基础设施层运维操作，由系统工程师直接介入。wrong_agent isError 修复属于框架层 bug 修复，记录于此。

---

## v721（2026-04-24）

### 变更内容

**群定位机制（config-driven）**：
- `~/HomeAI/data/groups.json`：新增 `name`/`positioning` 字段，已配置两个群（启灵的家/黟黟的阳光城）
- `group-registry.js`：新增 `getGroupInfo(chatId)` 方法，暴露在 return 对象
- `bot-connection.js`：memberTag 使用群名替换"群聊"，messageToLucas 前注入群定位上下文

**send_message wecom- 前缀 93006 修复**：
- `crewclaw-routing/index.ts`：send_message execute 中剥离 CHANNEL_USER_PREFIX，保留原始大小写（注：不用 normalizeUserId，后者会转小写）
- `daemons/entrances/wecom/index.js`：send-message handler 入口处 `let` 重赋值剥离前缀，fallback='wecom-'

### 越界干预记录

wecom- 前缀导致 93006 属于框架层 bug（插件在 send_message 工具中未规范化 userId），系统工程师直接修复。群定位机制属于 HomeAI 实例层运维配置，由系统工程师直接配置。

---

## v722（2026-04-24）：session Map TTL 周期清理

### 干预类型

基础设施 bug 修复（L0 Gateway 内存泄漏根治）

### 背景

Gateway 内存持续增长（RSS 最高达 3.1GB）导致 OOM 崩溃、pipeline 卡壳。前次会话已将 `--max-old-space-size` 扩容至 12GB（治标）。本次修复根因：`agent_end` 未触发时（API 超时、OOM 中途崩溃），`sessionIntent` / `sessionModel` / `sessionPrompt` / `sessionSem` 等 9 个 session Map 的条目永久堆积，无任何 TTL 保护。

### 变更内容

`crewclaw-routing/index.ts`：
- 新增 `sessionLastAccess = new Map<string, number>()`，记录每个 sessionKey 的最后活跃时间
- `setInterval` 每 20 分钟扫描一次，对超过 2 小时未活跃的 key 调 `cleanupSessionNow()`，打 `[session-ttl]` 日志
- `llm_input` 的 `sessionModel.set(...)` 旁边同步写 `sessionLastAccess.set(..., Date.now())`
- `cleanupSessionMaps` 末尾同步 `sessionLastAccess.delete(sessionKey)` 防重复清理
- `setInterval().unref()` 确保不阻止进程退出

### 越界干预记录

Gateway 内存管理属于框架基础设施，由系统工程师直接修复。

---

## v723（2026-04-24）：TTS SO_REUSEADDR + Gateway 堆内存稳定确认

### 干预类型

基础设施 bug 修复（L0 进程稳定性）

### 背景

系统工程师观察到两类基础设施不稳：① local-tts (8082) 每次 PM2 重启后因端口占用崩溃循环；② Gateway 在 v722 内存泄漏修复后内存状态需要确认是否真正稳定。

### 变更内容

**TTS SO_REUSEADDR 修复**（`daemons/services/tts-server.py`）：
- 新增 `import socket`
- HTTPServer 创建后立即调用 `server.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)`
- 作用：允许进程重启后立即重新绑定端口，防止 PM2 重启时 "Address already in use" 崩溃循环

**Gateway 堆内存状态确认**：
- 已验证 Lisa 的 `cleanupSessionMaps` / `scheduleSessionCleanup` / `cleanupSessionNow` 三函数代码存在（index.ts lines 6101-6148）
- 内存时序：Gateway 重启 805MB → 初始化完成 2867MB → GC 后 2394MB → 稳定 2395MB（10min 后基本持平）
- 确认 GC 正常工作，12GB heap limit 留有约 9.5GB 余量
- 发现两处次级泄漏（`opencodeSessions` line ~3910、`revisionRoundsMap` line ~11432 无 .delete()），但生命周期为 per-task 而非 per-message，全年影响 <500KB，列为低优先级

### 越界干预记录

TTS 是基础设施组件，SO_REUSEADDR 属于 Python socket 标准做法，系统工程师直接修复。Gateway 内存验证为观察性操作，无代码变更。

---

## v724 (2026-04-24) Scene 实体建模 + Lucas 能力扩展 + send_message 三角色化

**干预类型**：框架层实体概念建模 + 协作通道扩展

**背景**：
1. `group:chatId` 把 wecom-specific chatId 嵌入 sessionKey，群的概念与 channel 耦合，无法支持未来其他 channel 的群（如邮件群发）
2. Lucas 在协作工具上有盲区：只能触发完整流水线（重型）或即时问答（同步），缺少「异步委托有交付物任务」的通道
3. `send_message` Lucas-only 导致 task_andy/task_lisa 的回调承诺（"完成后用 send_message 通知你"）实际不可执行——Andy/Lisa 调用该工具会被 wrong_agent 拒绝

**变更内容**：

1. **Scene 实体抽象**：三层分离设计
   - 框架层：`scenes.json`（sceneId/name/positioning/channel/channelRef）
   - Channel 层：`group-registry.js` channelRef→sceneId 翻译 + 运行时 groups.json merge
   - 实例层：`HomeAILocal/Config/scenes.json`（SE 维护）
   - sessionKey 格式：`group:chatId:fromUser:msgId` → `scene:sceneId:fromUser:msgId`；旧前缀向后兼容
   - ChromaDB 元数据：`chatId/groupName` → `sceneId/sceneName`；展示层兼容旧记录

2. **Lucas 能力扩展**：
   - `search_codebase` 门控：Andy-only → Andy+Lucas 可用
   - `task_andy`（新工具）：Lucas 委托 Andy 异步调研/分析，Andy 完成后 send_message 回报；fire-and-forget，不走流水线
   - `task_lisa`（新工具）：Lucas 委托 Lisa 直接执行任务，Lisa 完成后 send_message 回报；遇架构判断自动升级 Andy

3. **send_message 三角色化**：
   - 移除 Lucas-only 硬性门控，改为定向门控
   - Lucas：无限制，可发给任何家庭成员/群/访客
   - Andy/Lisa：只能发给任务委托人（WECOM_OWNER_ID），不可直接向组织成员或群发消息
   - 修复 task_andy/task_lisa 回调不可达的 bug（之前 Andy/Lisa 调用 send_message 会被 wrong_agent 拒绝）

4. **六条协作通道（新增 Lisa→Lucas）**：
   - Lisa 执行 task_lisa 中遇到用户侧决策问题时，用 send_message + `【来自Lisa·执行澄清】` 前缀直接问 Lucas
   - 技术/架构问题仍走 report_implementation_issue

**变更文件**：
- `CrewClaw/crewclaw-routing/index.ts`（Scene cache 函数 + sessionKey 升级 + search_codebase 门控扩展 + task_andy/task_lisa 工具 + send_message 门控重构）
- `CrewClaw/daemons/entrances/wecom/lib/bot-connection.js`（getSceneIdByChannelRef）
- `CrewClaw/daemons/entrances/wecom/lib/group-registry.js`（loadScenes + getSceneByChannelRef）
- `HomeAILocal/Config/scenes.json`（新文件，家庭群 Scene 配置）
- `~/.openclaw/workspace-andy/AGENTS.md`（三类任务行为差异：新增 task_andy 直接委托）
- `~/.openclaw/workspace-lisa/AGENTS.md`（直接执行模式：新增第 4 条执行澄清规则）
- `Docs/HomeAI Readme.md`（Andy/Lisa 交互通道列更新）
- `Docs/00-project-overview.md`（三角色直接协作通道扩展为六条 + 工具表更新）

### 越界干预记录

框架层实体建模（Scene）属于架构演化，系统工程师直接实施。send_message 门控重构属于修复 task 回调 bug，同时明确设计约束。

---

## v725 (2026-04-25) 流水线稳定性修复：超时/限流/schema 三项

**干预类型**：基础设施配置修复（L0）

**背景**：
昨日流水线磕绊，日志分析发现三个独立故障点：
1. Lucas `callGatewayAgent` 超时 180s，与 Andy Gemini 3.1 Pro 处理时长重合，触发 `⚠️ 系统应急模式`（昨日共 20 次）
2. Lucas/Andy/Lisa 三个角色均无显式 fallback 配置，云端模型失败时继承 `defaults.primary = zai/GLM-5.1`（云端），不符合「本地模型兜底」设计意图；GLM-5.1 也超时后 `next=none`，请求完全失败
3. Andy (Gemini 3.1 Pro) 每日 100+ 次 429 限流；另有 12 次 400 schema 拒绝，原因是 compat 配置缺 `maxTokensField: "max_tokens"`

**变更内容**：

1. **Lucas 超时 180s→300s**（`bot-connection.js`）：
   - 5 处 `callGatewayAgent('lucas', ..., 180000, ...)` 全部改为 `300000`
   - 对齐 `ask_andy` 的 MEDIUM 超时（300s），防止 Gateway 忙时误触应急模式

2. **三角色 fallback 本地化**（`openclaw.json`）：
   - Lucas / Andy / Lisa 的 `model` 字段从字符串改为 `{primary, fallbacks}` 对象
   - fallback 统一设为 `ollama/homeai-assistant`（本地 Qwen3 36B MoE）
   - openclaw 自动注册了 `ollama` provider 插件

3. **Gemini 400 schema 修复**（`openclaw.json`）：
   - `google/models/gemini-3.1-pro-preview` compat 新增 `"maxTokensField": "max_tokens"`
   - Google Native API 用 `max_tokens` 而非 `max_completion_tokens`，缺此配置导致请求 schema 被拒

**变更文件**：
- `CrewClaw/daemons/entrances/wecom/lib/bot-connection.js`（超时 180s→300s，5 处）
- `~/.openclaw/openclaw.json`（三角色 fallback + Gemini compat，不进 git）

### 越界干预记录

基础设施参数修复（超时、fallback、compat），属于 L0 稳定性范畴，系统工程师直接修复。

---

## v728 (2026-04-25) Andy↔Lisa 模型互换 + Readme 内容清洁

**干预类型**：模型配置变更（业主指令）+ 文档清洁

**背景**：
Andy（Gemini 3.1 Pro Preview）遭遇 250 次/天免费配额限制（Preview 状态），每天上午即耗尽，导致 Andy spec 设计频繁失败。Lisa 使用频率远低于 Andy，Gemini 配额对 Lisa 够用。

**变更内容**：

1. **Andy → GPT-5.4**（openai）：Andy spec 设计频率最高，切高频稳定模型；fallback → Sonnet 4.6 → Ollama
2. **Lisa → Gemini 3.1 Pro Preview**（google）：Lisa 使用频率低，Gemini 配额可覆盖；fallback → Sonnet 4.6 → Ollama
3. **andy-evaluator / skill-candidate-processor / skill-crystallization-evaluator / research-assistant** → gpt-5.4（跟随 Andy）
4. **lisa-evaluator** → gemini-3.1-pro-preview（跟随 Lisa）

**变更文件**：
- `~/.openclaw/openclaw.json`（Andy/Lisa 及所有子 Agent 模型更新，不进 git）
- `~/.openclaw/start-gateway.sh`（ANDY_PROVIDER/ANDY_MODEL/LISA_PROVIDER/LISA_MODEL 更新，不进 git）
- `CLAUDE.md`（稳定区技术现实 + 宪法表更新）
- `memory/MEMORY.md`（当前模型分工更新）
- `Docs/00-project-overview.md`（6 处过时模型名称去特化：evaluator 表格/Coordinator 状态标注/设计哲学/路由图/云端 Agent L5 段落/env var 表格）

### 越界干预记录

模型切换为业主明确指令（2026-04-25）。配置文件修改属于系统工程师职责范围（不经 Andy 流水线）。文档清洁（去特化过时模型名）属于维护性工作，不影响架构设计。
