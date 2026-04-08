# 系统工程师干预记录

> **文档定位**：持续增长的干预日志。每次系统工程师发现自进化机制不足、成功矫正后，由 Claude Code 主动追加一条记录。
> **目标读者**：后来者——接手这个系统或搭建新实例的人，用这些记录少踩坑、优化自进化机制。
> **维护方式**：Claude Code 主动追加，不删不改，时间倒序（最新在前）。
> **版本**: v581
> **最后更新**: 2026-04-04

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

**根因**：为什么会发生（prompt 设计？模板缺失？路由逻辑？流水线断点？）

**干预内容**：系统工程师做了什么

**改进结果**：干预后系统行为有何变化

**沉淀建议**：如何防止同类问题再发生（prompt 改进 / DPO 负例 / 流水线补丁）
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

**现象**：Lucas 记忆系统质量差——①搜索家人对话时混入 Andy/Lisa pipeline 对话（spec、HEARTBEAT 等）干扰语义结果；②查询 ZengXiaoLong 时只命中 514/578 条（64 条因大小写不一致漏查）。

**根因**：
- `writeMemory` 没有过滤 `fromType=agent` 的 pipeline 写入，Andy/Lisa 的工作对话混入 `conversations` 集合。
- `writeMemory` 写入 `userId: meta.fromId` 未 normalize，来源 ID `ZengXiaoLong`（企业微信原始格式）与 `zengxiaolong` 共存，`queryMemories` 精确匹配只能命中其中一套。

**干预内容**：
1. **查询侧过滤**（不删数据）：`queryMemories` 的 where 条件加 `fromType: { $eq: "human" }`，pipeline 记录对家人搜索不可见，但数据保留（Andy/Lisa 蒸馏燃料）。
2. **写入侧过滤**：conversations 写入块加 `if (convFromType === "agent") skip`，未来 pipeline 不再写入。
3. **userId 规范化**：`writeMemory` L1054 改 `meta.fromId.toLowerCase()`；`queryMemories` 入口加 `userId = userId.toLowerCase()`。
4. **存量 re-index**：64 条 `ZengXiaoLong` 记录 ChromaDB delete+add 重建为 `zengxiaolong`，现共 514 条全部命中。
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
   - Andy：框架打样定位 / 四角色结构 / 双向V字流水线全图 / L0-L2 演进 / 文档查阅地图（出方案前必查9个文档，每条标注「为什么对我重要」，核心原则：**代码比文档更真实**）
   - Lisa：框架打样定位 / 流水线中的位置 / `report_implementation_issue` 机制 / 已交付系统 / 文档查阅地图（`10-engineering-notes.md` 标注最高优先级，**实现前必查**）

2. **注册到 context-sources.ts**：三个角色各加一条 `id: "background"` 的 `static-file → append-system` 源，注入顺序在工作规则之前（背景知识先于操作规则）

3. **Readme 系列刷新**：`00-project-overview.md` 三角色工作空间文件表各加 `BACKGROUND.md` 行；`03-configuration-management.md` 目录树同步更新

**设计原则确认**：文档地图的关键不是「这里有哪些文档」，而是「**遇到 X 问题时，去 Y 文档查，因为那里有 Z**」。路径 + 触发条件 + 意义三要素缺一不可，否则角色不会主动去查。

### 2026-03-29 L2 完整落地：双向V模型 + AGENTS.md精简 + Readme刷新（v538）

**现象**：
1. V字流水线是单向瀑布（Lucas→Andy→Lisa），任何一层遇到问题只能靠系统工程师介入；Andy 写完 spec 盲目触发 Lisa（未验证集成点）；Lisa 遇到实现阻塞无反馈路径；Lucas 无法叫停进行中的任务
2. Lucas AGENTS.md 有 11 个「情况」规则，认知负担高，模型在切换场景时容易漏读
3. Readme/project-overview 文档未反映 L2 的双向协作机制

**根因**：
1. V字右侧回路（Lisa→Andy、Andy→Lucas 澄清、Lucas 叫停）在系统设计里存在但工具层没有实现；流水线里没有 pre-Lisa 取消检查点
2. 情况分类是线性枚举，B/D/I 本质上都是 send_wecom_message，E/F 是输入描述而非触发条件，拆分标号反而增加了无效负担
3. 文档落后于实现

**干预内容**：

1. **双向V模型工具层**（index.ts）：新增 `query_requirement_owner`（Andy→Lucas 澄清）/ `report_implementation_issue`（Lisa→Andy 反馈）/ `list_active_tasks` / `cancel_task`（Lucas 任务控制）；任务注册表 `task-registry.json`；`trigger_lisa_implementation` 新增 `requirement_id` 参数 + pre-Lisa 取消检查点

2. **稳定性基础设施**：`stripMarkdownForWecom`（wecom-entrance 全路径格式强制）；`before_prompt_build` 承诺词铁律每轮注入（幻觉承诺防御）

3. **规则文件强化**：Andy AGENTS.md 加 spec 自验清单（5项 exec 核查）；Lisa AGENTS.md 加调试回路（最多2轮→report_implementation_issue）；Andy+Lisa HEARTBEAT 加行为规则自检（3次模式→alert_owner 提案）；Lucas AGENTS.md 情况J（Andy澄清）/ 情况K（任务管理）

4. **AGENTS.md 精简**（本次）：Lucas 11个「情况」→ 5个触发路径（开发需求/信息获取/主动联系与转发/任务管理/Andy澄清）；输入类型提示合并为一个简短块；E/F/B/D/I 全部折叠消失

5. **Readme 系列刷新**：HomeAI Readme 角色表 + 描述节反映双向V模型；00-project-overview 更新角色间通信图/流水线验证表/Andy能力/Lisa能力/HEARTBEAT自进化段落

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

**根因**：L2 实现时专注流水线闭环，L3 部分（组织运作优化）作为下一阶段设计，未同步实现。

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

多个并发 Andy 流水线同时向 MiniMax 发请求，全部在 300s 后超时，Gateway session 状态损坏，后续所有请求挂死。

**修复**：`crewclaw-routing/index.ts` 在 `runAndyPipeline` 入口加信号量，`MAX_ANDY_CONCURRENT=2`，超出时排队（不丢弃）并立即通知用户「已排队」。`finally` 块保证槽位释放。

**③ proactive 循环触发 ChromaDB 条目指数膨胀**

`trigger_development_pipeline` 每次调用都以新 UUID 写一条 `outcome=""` 的 ChromaDB 条目。主动循环发现 `outcome=""` 条目 → 提示 Lucas → Lucas 再调用 `trigger_development_pipeline` → 写新条目 → 无限增长。曾积累 115+ 条重复，触发 MiniMax 雪崩，进而导致 Gateway 挂死。

**修复**：proactive 消息模板改为「告知状态，明确禁止重新触发流水线，除非用户明确确认从未提交」。`markCommitmentNotified` 在 Gateway 调用前执行，即使 Gateway 失败也不会重新触发。

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

### 2026-03-26 蒸馏管道重定位 + V字流水线反馈回路补全

**背景**：以「Andy/Lisa/Lucas 是角色，所有交互节点都需要设计」为镜，发现两类系统缺口：① MEMORY.md 蒸馏仍在堆积具体细节，与 ChromaDB 实时语义召回重叠；② V字流水线中 Andy→Lucas 设计摘要、Lisa→Andy 结果通知两个节点为空。

**蒸馏管道重定位**（`scripts/distill-agent-memories.py`）：
- Andy/Lisa `distill_focus` 从「堆全量细节」改为「提炼高层判断倾向 + 反复出现的模式 + 高层反思」，明确排除细节
- Lucas 新加入蒸馏管道：decisions(agentFilter=lucas) + behavior_patterns → MEMORY.md 蒸馏节
- `scripts/seed-constraints.py` 新建：14 条已验证平台约束写入 ChromaDB decisions（type=constraint）

**V字流水线反馈回路**（`crewclaw-routing/index.ts`，触发点 `trigger_lisa_implementation`）：
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
- **F1/F2（文档）**：docs/00-project-overview.md 新增两个 HomeAI L3 实现小节（访客 Shadow Agent + Andy↔Lisa 流水线质量升级）；CLAUDE.md v548 更新

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

**缺口识别**：capability-registry.jsonl 新能力写入缺失（只有初始化 + 休眠检测，无交付后自动写入），已发单给 Lucas（req_cap_registry_001）走流水线。

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

**文档同步**：`00-project-overview.md` watchdog 检测表新增 cloudflared 行；`06-basic-version.md` watchdog 描述更新为"三重保活"。
