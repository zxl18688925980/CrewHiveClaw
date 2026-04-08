# Claude Code 协作手册

> **版本**: v432
> **最后更新**: 2026-03-22
> **维护者**: 系统工程师（Claude Code 主动追加，人做方向判断）
> **定位**: HomeAI 系统建设过程中积累的系统工程师最优实践。持续增长文档，随每次有价值的协作经验追加。
> **双重价值**: 我们自己的成长总结；第二个系统工程师（感性脑 + 理性脑）的入场手册。

---

## 为什么这份文档存在

HomeAI 系统的原始参与方只有三个：**业主 + Claude Code + 这份 README**。

没有专业工程团队，没有外包，没有前置技术培训。业主通过建这个系统的过程，自然成长为系统工程师（Main 角色）。Claude Code 是这个成长过程的核心工具。

这份手册记录的不是「怎么用 Claude Code 完成某个任务」，而是**「如何与 Claude Code 建立有效的协作关系」**——这是一种更根本的能力，可以迁移到任何系统建设场景。

### 核心命题：系统在进化，人也需要进化

AI 是持续进化的。每一代大模型都比上一代更强，能做的事越来越多，协作的方式也在变。

**系统的自进化有路径**：Lucas 积累语料 → MLX 微调 → 本地模型越来越懂这个家庭。这条路已经设计好了。

**人的进化路径同样需要设计**：不跟上最聪明的模型，就会逐渐失去对系统的方向掌控——只知道系统能做什么，不知道它为什么这样做，更不知道下一步该怎么演进。

跟上 AI 进化的方式，不是死记硬背技术细节，而是**持续与当下最强的模型协作，在真实任务中学习它的思维方式**。HomeAI 的建设过程本身就是这个训练场：每一次让 Claude Code 解释它为什么这样设计，每一次先对话确认再动手，每一次把决策原因记录下来——都是在训练「与 AI 共同思考」的能力。

这份手册是这个训练过程的经验沉淀。它的读者不只是「想用 Claude Code 的人」，而是**「想在 AI 时代持续保持方向掌控力的人」**。

### Claude Code 是持续成长的协作伙伴，不只是引导期工具

系统跑起来之后，Claude Code 的角色不消失，而是**从「主建设者」转变为「系统工程师的持续搭档」**：
- 业主（Main）遇到新问题、新需求，第一时间找 Claude Code 协同解决
- 系统演进的每次架构决策，Claude Code 提供分析、业主做最终判断
- 随着业主越来越懂系统，提问的质量提升，协作的深度也随之提升

这个成长是持续的，不存在「毕业了就不需要 Claude Code」的节点。

**更深的一层**：这份 08-handbook 本身，是 Claude Code 背后的大模型在探索「如何陪伴一个普通人持续成长为系统工程师」的经验积累。每一条最优实践，都是在这个具体家庭场景下验证过的教学方法。越多家庭走这条路，云端从这些经验里提炼出的协作范式就越好，反哺下一个家庭的起点越高——这是 HomeAI 双层架构里「云端积累」部分的真实意义之一。

### 重要边界：HomeAI 系统本身是日常自进化的主体

**Claude Code + README 解决的是「从 0 到 1」**：冷启动、系统搭建、业主成长为 Main。这个阶段以人为主，Claude Code 辅助，核心产出是一个能跑起来的系统和一个理解系统的业主。

**系统跑起来之后，自进化的主体是 HomeAI 自身**：
- Lucas 从家庭对话中持续提取需求和语料
- Andy/Lisa 持续交付新工具
- MLX 微调引擎定期把积累的交互内化进本地模型
- 路由比例（本地/云端）随时间自然下降——这是专精程度提升的量化指标

Claude Code 在系统运行阶段退为「维护辅助工具」，业主（Main）是主角。这是这套架构真正要验证的东西。

**Readme 同一份文档，三重身份**：
1. **第二个家庭的复建指南**：文档够了，不需要原作者介入
2. **业主自己的成长手册**：跟着 Claude Code 建系统的过程，自然读懂了系统
3. **Claude Code 的执行上下文**：新会话直接上手，不重复解释背景

「文档即培训」——业主在建系统的过程中不知不觉成长为系统工程师，这是 HomeAI 可复制性的核心设计。

---

## 条目格式说明

每条实践的格式：

- **场景**：什么时候用到这个技巧
- **做法**：具体怎么操作
- **案例**：在 HomeAI 建设过程中的真实例子
- **为什么有效**：背后的原理

---

## 一、系统工程师工具体系

> **工欲善其事，必先利其器。**
>
> 系统工程师 = 人（感性脑）+ Claude Code（理性脑）+ 工具体系。工具选对了，人的精力和 Claude Code 的 Token 才能花在真正值钱的地方。
>
> **核心原则：能用低层工具解决的，不升级到高层。**

### 1.1 四层工具体系

#### 第一层：认知同步（零 AI 成本，人可独立操作）

| 工具 | 职责 | 何时用 |
|------|------|--------|
| **Obsidian** | 三方共享工作台：人写家庭信息/业务上下文，Claude Code 写决策日志，跨会话共享状态 | 随时——用它来沉淀，不用它就靠口头交代（见 §1.3）|
| **CLAUDE.md** | Claude Code 的跨会话工作记忆（稳定区 + 动态区 + 【下次起点】）| 每次会话关闭时更新；每次会话启动时先读 |
| **Readme 系列（00-09）** | 系统设计的唯一真相来源 | 架构有疑问时查；修改前先读；不要每次会话全读 |
| **Git log** | 版本历史，变更追踪 | 想知道「某个文件怎么变成现在这样」时，比问 Claude Code 快 10 倍，成本为零（见 §1.4）|

#### 第二层：系统监控（秒级，不需要 AI）

| 工具 | 用途 | 典型命令 |
|------|------|---------|
| `curl` | Gateway / ChromaDB / wecom-entrance 健康检查 | `curl http://localhost:18789/health` |
| `pm2 status` | wecom-entrance + cloudflared 进程状态 | `pm2 status` |
| `launchctl list` | Gateway 进程状态 | `launchctl list \| grep openclaw` |
| `tail -f` | 实时日志追踪 | `tail -f ~/.openclaw/logs/gateway.log` |
| `cat *.jsonl` | 路由 KPI / 语料 / 决策记忆查看 | `tail -5 data/learning/route-events.jsonl` |

**原则**：这一层的所有操作，人自己能独立执行，不需要开 Claude Code 会话。系统日常巡检全靠这层。

#### 第三层：执行操作（需要判断，AI 参与）

| 工具 | 职责 | 典型会话类型 |
|------|------|------------|
| **Claude Code** | 代码修改、文档更新、架构分析、调试推理 | A 型（定向）/ B 型（设计）|
| **openclaw CLI** | 直连 Gateway，对所有 Agent 可见；调试、直接下发指令、查 Agent 状态 | A 型 |
| **Bash / Terminal** | 脚本执行、批量操作、进程管理 | A 型 |

#### 第四层：远程干预（不在本地时）

| 工具 | 职责 |
|------|------|
| **企业微信 Main 通道** | 自然语言远程诊断和操作系统，不需要打开电脑 |
| **Main agent（MiniMax-M2.7）** | 10 个工具：`get_system_status` / `get_logs` / `read_file` / `restart_service` / `restart_gateway` / `run_shell` / `test_lucas` / `exec_script` / `send_file` / `trigger_finetune` |

**原则**：能在企业微信里说一句话解决的，不开电脑。Main agent 覆盖了大部分日常运维操作。

---

### 1.2 工具选择决策树

```
这件事需要做什么？
    │
    ├─ 看状态 / 看日志 / 查版本历史
    │       → 第一/二层工具，不开 Claude Code
    │
    ├─ 改一个明确的东西（知道改哪里、改什么）
    │       → Claude Code A 型（< 50K Token）
    │
    ├─ 需要设计决策（不确定怎么做）
    │       → Claude Code B 型（50–200K），结束后执行关闭协议
    │
    ├─ 需要全局审视（多模块联动）
    │       → 先尝试拆成多个 A/B 型；拆不了再做 C 型，但要有明确产出目标
    │
    └─ 不在本地 / 不方便开电脑
            → 企业微信 Main 通道，能解决就不开 Claude Code
```

---

### 1.3 Obsidian：认知同步的核心工具

**当前状态（2026-03-27 已建立）**：Obsidian Vault 已正式启用，路径 `~/Documents/Obsidian Vault/HomeAI/`，认知同步双轨运行（CLAUDE.md + Obsidian）。

#### 为什么 Obsidian 是杠杆最高的工具

**缺失 Obsidian 的代价**：
- 人在两次会话之间积累的上下文（想法、决策草稿、外部条件变化），没有地方沉淀，下次会话需要口头重新交代
- Claude Code 写入的决策日志，没有人可以随时翻看的界面，只能开新会话问
- 多窗口并行时，各窗口之间的状态同步靠人脑记，容易断档

**Obsidian 建立后的效率提升**：

| 场景 | 当前 | 建立后 |
|------|------|--------|
| 新会话启动 | 读 CLAUDE.md + 口头补充背景 | 读【下次起点】+ 读 Obsidian 当日记录，人无需开口 |
| 多窗口协作 | 靠人脑同步各窗口进展 | 各窗口写 Obsidian，互相读，人脑只做决策 |
| 人单独巡检 | 只能看 PM2 / curl 等系统指标 | 还能看 Claude Code 写入的决策日志和待办 |
| 家庭信息维护 | 散落在 BOOTSTRAP.md 等配置文件 | 统一在 Obsidian，Lucas 通过 MCP 读取 |

#### 如何接入（MCP 配置）

Obsidian 的知识库本质上是本地 Markdown 文件夹。把 vault 路径加入 filesystem MCP 的允许列表即可：

全局 `~/.claude.json` 或项目级 `.mcp.json`：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y", "@modelcontextprotocol/server-filesystem",
        "/Users/yourname/HomeAI",
        "/Users/yourname/Documents/Obsidian Vault"
      ]
    }
  }
}
```

**注意**：全局 `~/.mcp.json` 和项目级 `.mcp.json` 中同名 server，项目级优先（覆盖，不合并）。需要在项目级同时列出所有需要的路径。修改后重启 Claude Code 生效。

#### Vault 目录结构（已建立，2026-03-27）

```
Obsidian Vault/HomeAI/
├── HomeAI 工作台/             ← 总导航，系统当前状态
├── 01-HomeAI Readme文档/      ← docs/ 软链，直接在 Obsidian 中读文档
├── 02-四角色人格文件/          ← SOUL/AGENTS/MEMORY 等人格文件软链
├── 03-系统工程师工作日志/      ← Claude Code 写，人读（YYYY-MM/YYYY-MM-DD.md）
├── 04-系统工程师关键决策记录/  ← 按主题建文档（架构/模型/协作模式）
├── 05-系统工程师思想录/        ← 人写，私域想法与反思
├── 06-HomeAI系统需求管理/      ← 需求追踪
└── 07-设计与技术外部参考/      ← 外部内容存档，带出处，待验证后升入 docs/08
```

#### 三方分工

- **人**：在 `05-系统工程师思想录/` 写私域想法；在 `04-系统工程师关键决策记录/` 拍板架构决策
- **Claude Code**：在 `03-系统工程师工作日志/` 记录每次会话决策（背景/选项/决定/原因）；必要时追加 `04-` 关键决策条目
- **Lucas**：将完成的需求和跟进状态写入 `06-HomeAI系统需求管理/`

**何时建立**：一次性低成本 Setup（配置 MCP + 建目录，约 30 分钟 A 型会话）。建议在下一次感到「背景交代太费劲」时触发。

---

### 1.4 Git：最被低估的工具

**当前实际用法**：提交代码变更，版本号写 commit message。

**还可以做但没用的**：

```bash
# 某个文件是怎么变成现在这样的？（比问 Claude Code 快 10 倍）
git log --follow -p docs/04-project-constitution.md

# 上次改了哪些文件？
git show --stat HEAD

# 某个字符串是什么时候加进来的？
git log -S "trigger_development_pipeline" --oneline

# 两个版本之间的文档差异
git diff v408b HEAD -- "docs/HomeAI Readme.md"
```

**原则**：有版本问题先查 Git，不要开 Claude Code 会话问历史。Git 的答案比 Claude Code 更准确（Claude Code 有上下文压缩，Git 没有），成本为零。

---

### 1.5 工具体系的自进化

工具体系本身也随项目演进：

- **当前缺口**：Obsidian 未建立（第一层认知同步单点依赖 CLAUDE.md）
- **下一个扩展点**：Obsidian 建立后，§1.3 补充实操验证结果
- **长期方向**：Main agent 的工具覆盖越来越多，系统工程师在企业微信里能处理的比例越来越高，开电脑的频率越来越低

---

## 二、项目上下文管理

### 2.1 用 CLAUDE.md 给 Claude Code 一个持久大脑

**场景**：任何需要多次会话才能完成的项目。

**做法**：在项目根目录放 `CLAUDE.md`，分两个区：
- **稳定区**：架构设计、角色定义、关键约束——不频繁变动
- **动态区**：当前阶段、完成状态、下一步任务——每次有进展更新

```markdown
## 【稳定区】项目上下文
（架构、角色、约束——建完基本不变）

## 【动态区】当前状态
（【下次起点】+ 当前阶段 + 各模块状态 + 下一步任务——每次会话后更新）
```

**案例**：HomeAI 的 CLAUDE.md 让每次新会话开始时，Claude Code 直接知道系统全貌、当前运行状态、待处理任务，不需要业主重新解释背景。

**为什么有效**：Claude Code 每次会话开始会自动读取 CLAUDE.md。稳定区保证认知一致，动态区保证状态最新。这是与 Claude Code 长期协作最重要的机制。

---

### 2.2 Memory 文件：Claude Code 的工作笔记本

**场景**：需要跨会话保留的技术经验、踩坑记录、已验证的结论。

**做法**：Claude Code 在 `~/.claude/projects/<项目路径>/memory/` 目录下维护 memory 文件。业主可以要求 Claude Code 「把这个记下来」，也可以直接查看 memory 文件了解 Claude Code 记了什么。

```bash
# 查看 Claude Code 的项目记忆
ls ~/.claude/projects/-Users-xinbinanshan-HomeAI/memory/
```

**案例**：HomeAI 的 memory 文件记录了已知修复、守护进程路径迁移历史、已验证的关键结论。这些信息不适合放在 CLAUDE.md（太细节），但 Claude Code 在处理相关问题时需要参考。

**为什么有效**：CLAUDE.md 管「项目级认知」，memory 管「经验级积累」。前者业主维护，后者 Claude Code 自主维护。

---

### 2.3 Machine Profile：把 Setup 经验传递给自运作过程

**场景**：系统有机器相关的约束（内存、GPU、网络），这些约束在 Setup 阶段试错发现，需要传递给后续自动化脚本。

**做法**：创建 `config/machine-profile.json`，记录每个参数的值和发现原因：

```json
{
  "mlx_training": {
    "safe_params": { "val_batches": 0 },
    "learnings": [
      {
        "date": "2026-03-14",
        "param": "val_batches=0",
        "discovery": "验证阶段触发 Metal GPU OOM → kernel panic",
        "fix": "跳过验证集评估"
      }
    ]
  }
}
```

自动化脚本读取 machine-profile，而不是硬编码参数：

```bash
BATCH_SIZE=$(python3 -c "import json; p=json.load(open('config/machine-profile.json')); print(p['mlx_training']['safe_params']['batch_size'])")
```

**案例**：HomeAI 的 MLX 微调在 Setup 阶段发现 3 个 OOM 触发点，全部记录在 machine-profile 中。`run-finetune.sh` 从 machine-profile 读取参数，换机器时只需更新 machine-profile，脚本不用改。

**为什么有效**：Setup 产生了机器特定的操作知识。Machine profile 让这些知识成为可传递的结构化资产，同时保留了「为什么」，让第二个人能做有依据的调整。

---

### 2.4 从历史记录恢复项目的标准流程

**场景**：新会话开始，或从其他窗口切换回，需要快速恢复项目上下文。

**做法**：

```
恢复流程（3步）：
1. 读 CLAUDE.md 动态区的【下次起点】字段：了解系统最新状态和第一件事
2. 读 Obsidian 当日对话记录（如已建立）：了解今天其他窗口已做了什么
3. 读 Obsidian 前一日对话记录的「遗留任务」章节：整合跨日未完成项
       ↓
   综合三者，确认优先级后开始执行
```

关键判断：哪些任务**可以立即动手**（不依赖外部条件），哪些**依赖外部条件**（等待中），哪些是**持续运行中**（不需要主动操作）。只做第一类，不等第二类，不干扰第三类。

**案例**：HomeAI 多次多窗口协作经验——开发窗口每完成一项就写入 Obsidian，另一窗口激活时可以直接读 Obsidian 了解系统当前状态，不需要业主重新说明背景。

**为什么有效**：「记忆断层」是协作效率最大的敌人。标准恢复流程把「重新定向」从 10-15 分钟压缩到 3-5 分钟。

---

## 三、会话效能

### 3.1 会话类型定标：开口前先归类

**场景**：每次找 Claude Code 协作，结果要么花了不必要的时间泛读文档，要么对话不够充分导致下次还要重做。

**做法**：在心里（或对 Claude Code 直接说）把当次会话归为三类：

| 类型 | 特征 | Token 预期 | 启动话术 |
|------|------|-----------|---------|
| **A 型（定向执行）** | 目标清晰、改动范围确定 | < 50K | 「帮我修复 XX」「把 YY 文档的 ZZ 部分更新为 WW」|
| **B 型（设计推理）** | 需要权衡选项、评估影响 | 50–200K | 「我们要解决 XX，有 YY 和 ZZ 两个方向，帮我分析」|
| **C 型（全局审视）** | 系统级 review、多模块联动 | > 200K | 应优先拆成多个 A/B 型 |

A 型不要升级成 B 型。B 型对话结束后，执行阶段按 A 型处理。C 型能拆就拆。

**案例**：HomeAI 某次「审视一下文档，再审视一下代码」的请求，触发了全量读取 4 个大型文档 + 完整代码，变成 C 型会话。更高效的方式是：先说「我想确认 Skills 架构描述是否和代码一致」（B 型，聚焦一个问题）。

**为什么有效**：Claude Code 在宽泛提示下会默认走「最全面」的路径。会话类型定标给了 Claude Code 一个「精度指令」，让它在合适的粒度上工作。

---

### 3.2 会话关闭协议：让每次进展都有沉淀

**场景**：一次有实质进展的会话结束，但没有更新 CLAUDE.md，下次会话时人需要重新解释背景。

**做法**：每次有实质进展时（不必等所有任务完成），Claude Code 主动执行：

```
会话关闭协议（Claude Code 主动执行）：
1. 更新 CLAUDE.md 动态区
      ├─ 当前阶段描述（完成了什么）
      ├─ 模块状态表更新
      └─ 已知问题更新

2. 写入【下次起点】字段（动态区顶部）：
      ├─ 下次第一件事（具体到可直接执行的粒度）
      ├─ 未关闭上下文（等待条件、待验证结论）
      └─ 本次会话类型（A/B/C）

3. 写入 Obsidian 工作日志：
      路径：~/Documents/Obsidian Vault/HomeAI/03-系统工程师工作日志/YYYY-MM/YYYY-MM-DD.md
      内容：本次会话做了哪些决策 + 为什么这样决定（推理过程、争论点、转折点）
      注意：Git 记录「变更了什么」，Obsidian 记录「为什么这样决定」，两者互补不重复

4. 如有新的协作模式出现，追加到本手册持续追加区
```

**主动写入触发**（会话中途，不等会话关闭）：
- 做完一个重要决策
- 话题出现重大转折
- 用户说了重要的背景或想法
- 感觉上下文积累已多、压缩风险变高

```
新会话启动协议（Claude Code 主动执行，按序）：
1. 读 CLAUDE.md【下次起点】字段 → 定位任务，不泛读文档
2. 读 memory/MEMORY.md → 恢复稳定架构认知
3. 读 Obsidian 03-系统工程师工作日志 最近 2-3 条 → 恢复决策推理上下文
→ 完成后，人不需要重新解释背景，直接进入任务
```

**案例**：HomeAI 某次会话压缩后重建，Claude Code 读到 Obsidian 记录「MiniMax 400 根因是 inputSchema 格式不兼容，已升 M2.7 修复」，直接知道不需要再调试这个问题，节省了 30 分钟重复排查。

**为什么有效**：上下文压缩 / 新会话重建是不可避免的。关键是把「会话间记忆」外化到文件系统。CLAUDE.md 存导航，Obsidian 存推理，memory.md 存稳定架构事实——三层互补，重建成本趋近于零。

---

### 3.3 Claude Code 的自我监控：识别低效协作模式

**场景**：会话中出现低效模式，Claude Code 没有意识到，继续消耗 Token 和人的注意力。

**做法**：Claude Code 在每次会话中主动监控三种模式：

**模式 1：泛读文档**
- 症状：会话前 10 步内读了 3 个以上文档，但任务还没开始
- 自我检测：「我在读文档，是因为任务需要，还是因为提示模糊在找方向？」
- 纠正：停下来，直接问：「这次会话要完成的核心任务是什么？」

**模式 2：重复解释已决定的事**
- 症状：人说的内容，CLAUDE.md 稳定区已有记录
- 自我检测：「这件事之前是否已经决定过？CLAUDE.md 里有没有？」
- 纠正：引用 CLAUDE.md 对应记录，确认是否有新情况需要重新讨论

**模式 3：系统工程师介入运行时决策（有条件允许）**
- 不是「永远不能做」，而是「做了要记录」
- 判断流程：
  ```
  Lucas/Andy/Lisa 某环节需要决策
      ↓
  评估：他们现在能自主完成吗？
      ├─ 能 → 退出，让流水线跑，不干预
      └─ 不能（能力缺口 or 进度压力）
              ↓
          执行干预
              ↓
          记录到 docs/09-evolution-version.md
          （干预了什么 / 能力缺口 / 改进条件）
              ↓
          改进条件写入 CLAUDE.md 动态区待办
  ```
- 目标：09-evolution-version.md 越来越薄，说明系统三大能力（记忆系统 + 角色系统 + 自进化系统）越来越成熟

**为什么有效**：感性脑的强项是方向判断，弱点是精力有限。理性脑的强项是信息处理，弱点是在宽泛提示下倾向穷举。双方各自意识到自己的弱点并主动弥补，协作效率才能持续提升。

---

### 3.4 TL;DR 先读原则：大文档的快速定位策略

**场景**：文档超过 200 行，全读消耗大量 Token，跳过又怕漏掉关键信息。

**做法**：大文档的阅读顺序：

```
1. 先读【下次起点】字段（如在 CLAUDE.md）或文档开头的概述
2. 如果已经够了 → 直接开始任务，不继续读
3. 只在任务执行中遇到不确定时，才去读对应的具体章节
```

对于 00-project-overview.md（900+ 行）这类大文档，不应在每次会话开始时全量读取。只在以下情况读：
- 有新成员要了解系统全貌（B/C 型会话）
- 正在修改该文档本身
- 遇到架构疑问，需要核对某个章节

**案例**：HomeAI 03-configuration-management.md 修复时，只需读「andy-daemon / lisa-daemon」相关的章节，不是全文。实际操作：先 grep 关键词定位行号，只读相关段落，编辑后验证，全程不需要读完整文档。

**为什么有效**：文档的价值在于「需要时能找到」，不在于「每次都读完」。Claude Code 的注意力是稀缺资源，集中在当前任务相关的信息上，比均匀分布在整份文档上效率高得多。

---

## 四、高效协作工作流

### 4.1 先架构决策，再动手实现

**场景**：涉及多个文件、影响系统结构的改动。

**做法**：在让 Claude Code 动手之前，先用对话确认方案。描述目标，让 Claude Code 列出改动范围和设计思路，业主确认后再执行。也可以使用 `/plan` 模式，Claude Code 先输出完整计划，等待确认后再执行。

**案例**：HomeAI 的企业微信通道路由重设计（业主单聊→Main，群消息→Lucas）。如果直接动手，可能遗漏「业主在群里也是家庭成员」这个边界条件。先对话确认，发现了这个场景，避免了两次返工。

**为什么有效**：Claude Code 执行力强，但架构决策需要业主的业务判断。先对话确认边界，比实现后再修改效率高 3-5 倍。大改动一定先对齐，小修复可以直接让 Claude Code 做。

---

### 4.2 让 Claude Code 解释它在做什么

**场景**：业主想理解系统，不只是让 Claude Code 完成任务。

**做法**：在提问时加上「解释一下」「为什么这样设计」「这里有什么坑」。Claude Code 会在执行的同时给出解释。也可以要求 Claude Code 在写代码时加注释，注释重点放在「为什么这样做」而不是「做了什么」：

```javascript
// val_batches=0：验证阶段触发 Metal GPU OOM，见 machine-profile.mlx_training.learnings
```

**案例**：HomeAI 的 `run-finetune.sh` 最初只有参数，没有解释。修复后每个参数都指向 machine-profile 里的原因。业主看到脚本时，不只知道参数是什么，还知道为什么。

**为什么有效**：Claude Code 是工具，但业主的成长才是目标。「知其然」能用系统，「知其所以然」能演进系统。

---

### 4.3 先刷文档，再演进系统

**场景**：任何架构变更，无论大小。

**做法**：
1. 对话确认架构决策
2. 更新 CLAUDE.md 动态区（记录决策）
3. 更新对应设计文档
4. 再改代码实现
5. 验收后更新 CLAUDE.md 当前状态

**案例**：HomeAI 每次有较大变更都先在 CLAUDE.md 记录决策，再更新 00-project-overview.md，最后动代码。有几次因为赶进度跳过了文档步骤，下次会话时 Claude Code 就会基于过时的认知行动。

**为什么有效**：Claude Code 读 CLAUDE.md 来定位当前状态。文档不更新，Claude Code 的行动就会基于过时的认知。「先刷文档」不是形式，是保证 Claude Code 下次会话仍能准确行动的前提。

---

### 4.4 系统工程师不替代，只教导——流水线失败的正确响应

**场景**：Andy→Lisa 流水线输出了不完整或错误的结果，业主想尽快解决，Claude Code 倾向直接补全。

**做法**：Claude Code 的职责是「诊断 + 修复流水线」，而不是「替 Lisa 写代码」。正确步骤：

1. **读实际产物**：去 `app/generated/` 看 Lisa 真正输出了什么，而不是猜
2. **追代码路径**：从 spec 进入 → generateCode prompt → model 调用 → extractCode → saveCode，逐层找断点
3. **定位根因**：是 prompt 设计问题？模板缺失？spec 格式不对？还是写文件逻辑错误？
4. **修流水线**：改 prompt 模板、改 saveCode 逻辑，让 Lisa 自己重跑出正确结果
5. **验证**：用真实 spec 再跑一次，确认流水线输出正确，不是手工打补丁

**案例**：Lisa 的 `generateCode()` 把整个 spec JSON 丢进 prompt 说「请生成代码」，模型只生成了第一个文件的骨架。修复时读了实际生成的文件，追代码发现 prompt 无逐文件指令、`saveCode` 只写单文件。修复方案：改 `generateCode` 为按 `spec.implementationOrder` 逐文件循环生成；改 `saveCode` 支持写入 Array。

**为什么有效**：每次直接替 Lisa 写代码，就是在绕过积累过程。每次修流水线，才是在真正让系统变强。

---

### 4.5 多窗口任务分割 + Obsidian 实时同步

**场景**：同一天有多类任务并行推进（开发 + 文档 + 等待外部条件），需要在不同窗口分别处理。

**做法**：

1. **按任务性质分窗口**：开发主窗口（代码改动）、文档窗口（文档刷新）、等待窗口（条件激活后操作）。每个窗口有明确职责，不混用。

2. **Obsidian 作为跨窗口共享状态**：每个窗口的关键进展，**及时写入 Obsidian 当日对话记录**，不是等到会话结束再统一写。其他窗口启动时先读 Obsidian 当日记录。

3. **写入时机**：完成一个子任务后立即写，不攒到最后。关键信息：做了什么、为什么这样做、验证结果、遗留问题。

**案例**：2026-03-16 设置三个并行窗口：开发主窗口（Lisa 修复 + Gateway TUI）、文档窗口（各文档刷新）、DNS 窗口（域名激活后端到端验证）。开发窗口每完成一项就写入 Obsidian，DNS 窗口激活时可以直接读 Obsidian 了解系统当前状态。

**为什么有效**：多窗口的最大风险是「左手不知道右手在做什么」。Obsidian 是唯一真实的共享状态，比 CLAUDE.md 更实时（CLAUDE.md 每次会话结束才更新，Obsidian 实时写入）。

---

## 五、能力扩展

### 5.1 MCP：给 Claude Code 装插件

**场景**：Claude Code 默认能力不够用，需要接入外部服务或工具。

**做法**：MCP（Model Context Protocol）是 Claude Code 的插件标准。通过配置 `~/.claude.json` 或项目级 MCP 配置，可以给 Claude Code 添加新能力：

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/allow"]
    }
  }
}
```

常用 MCP：
- `filesystem`：读写本地文件（已在 HomeAI 配置）
- `git`：GitHub 操作（已在 HomeAI 配置）
- `brave-search`：网络搜索
- `obsidian`：读写 Obsidian 知识库

**案例**：HomeAI 配置了 filesystem MCP，让 Claude Code 可以直接读写项目文件，不需要把文件内容复制粘贴给它。这是整个协作的基础。

**为什么有效**：MCP 让 Claude Code 从「对话工具」变成「操作工具」。filesystem MCP 是最基础的，相当于给 Claude Code 一双手。

---

### 5.2 Hooks：在 Claude Code 操作前后自动执行检查

**场景**：希望 Claude Code 在某类操作前后自动运行检查脚本，比如每次修改代码后自动验证语法。

**做法**：在 CLAUDE.md 或项目配置里定义 hooks：

```json
{
  "hooks": {
    "postEdit": "node scripts/validate.js"
  }
}
```

**对 HomeAI 的潜在价值**：每次 Claude Code 修改守护进程代码后，自动运行健康检查，确认服务没有挂掉。

**为什么有效**：把验证步骤自动化，防止 Claude Code 改了代码但忘记验证的情况。让 Claude Code 的操作有内置的安全网。

---

## 六、系统构建模式

### 6.1 给 Claude Code 明确的「不能做」清单

**场景**：系统有关键约束，不能因为 Claude Code 的「过度热情」被破坏。

**做法**：在 CLAUDE.md 的「不可破坏规则」章节明确列出：

```markdown
**不可破坏规则**
- 不删除用户数据
- 危险操作前必须确认
- 禁止删除：企业微信交互、长记忆系统
```

**案例**：HomeAI 的项目宪法（04-project-constitution.md）和 CLAUDE.md 都有明确的约束列表。Claude Code 在执行时会主动检查操作是否违反这些约束。

**为什么有效**：明确的禁止清单让 Claude Code 的主动性在安全边界内发挥。

---

### 6.2 用对话积累决策历史

**场景**：系统建设过程中有大量架构决策，这些决策背后的原因容易被遗忘。

**做法**：重要决策对话后，让 Claude Code 把决策和原因摘要写入 CLAUDE.md 的「架构决策记录」区：

```markdown
### 架构决策记录
**Main 不建独立守护进程（2026-03-15）**
- 原因：Main 职责聚焦（系统维护命令），不需要 LLM 推理
- 实现：内置于 wecom-entrance，isOwner 分流
```

**案例**：HomeAI 的多个决策（如「bore 端口不稳定，选择推送通知而不是固定 URL」）都记录在 CLAUDE.md 动态区。下次会话时 Claude Code 不会重新质疑这些已经做过的决定。

**为什么有效**：决策历史防止「走回头路」。Claude Code 在新会话里看到决策记录，会在此基础上推进，而不是重新讨论已解决的问题。

---

### 6.3 扩展意图路由时的全路径检查

**场景**：在 Lucas 意图路由里新增一个意图类型，但这个新意图与已有的路由判断逻辑有隐性的交互。

**做法**：每次新增意图类型，必须检查**所有以「意图类型」为条件的判断点**，不只是新增分支本身。常见的隐性交互点：

```javascript
// 1. isDevIntent 这类聚合判断——新意图是否应该被包含？
const isDevIntent = intent.type !== 'chat' && intent.type !== 'tool';

// 2. 异步回调逻辑——新意图是否应该走异步路径？
if (isDevIntent && callbackUrl) { ... }

// 3. evolutionTracker.track 里的路由统计是否反映真实路径？
```

**案例**：`member_deep` 意图新增时，`isDevIntent` 把它当成开发任务，导致 wecom-entrance 带着 `callbackUrl` 调用时走了 Andy 的 SE 流水线，而不是同步走成员 Agent 路径。修复：在 `isDevIntent` 里明确排除 `member_deep`。

**为什么有效**：意图路由是系统的核心分流逻辑，每个聚合判断都是隐式的约束。新增意图时只关注新分支，容易忽视已有的聚合判断。正确做法：新增意图后，手动追踪一遍从入口到出口的完整链路。

---

### 6.4 让真实测试暴露架构假设

**场景**：设计了一个新路由分支，用关键词匹配触发，但实际使用时用户的表达方式并不精确命中关键词。

**做法**：尽早用真实场景测试，而不是用「正好触发关键词」的测试用例。真实测试经常能暴露架构假设的问题。

**案例**：`member_deep` 意图设计完成后，用真实的妈妈问题测试：「姐姐这周的数学错题有什么规律吗」。结果 intent 分类为 `chat`，因为 "数学错题" 不在 `member_deep` 关键词列表里。这个测试暴露了更根本的问题：**有专属 Agent 的用户，所有 chat 消息都应该走 Agent**，而不只是触发了关键词的消息。

**为什么有效**：专属 Agent 不是「特殊情况下的工具」，而是这个成员的首选对话界面。一旦确定了用户有专属 Agent，路由判断应该基于身份而不是关键词。

---

### 6.5 叠加而非替代：在已有基础设施上构建

**场景**：实现新功能时，Claude Code 绕开了上游已有的机制，自建了一套平行的机制。

**用户的纠正**：「你要先吃透这个八个文件，系统默认的角色，也应该有他们自己的 OpenClaw 的设置，我们是叠加在上面的，不是完全自己独立干。」

**根因诊断**：Claude Code 没有先读懂上游（OpenClaw）的设计，就开始动手实现，造出了平行机制：

```
OpenClaw 已有                     重建（错误）
---------------------------------------------------
SOUL.md  (人格)         →         agent.md  (混合了人格+成员信息)
USER.md  (关于这个人)   →         members/  (新建目录)
```

**正确做法**：先完整阅读上游设计，再决定叠加在哪里，叠加什么。

- 接手新系统之前，先找「这个系统认为配置应该放在哪里」
- 新目录是最后手段，先穷举现有机制能不能承载新需求
- 多真相来源不是设计问题，是没有先读懂上游的症状

**为什么有效**：每多一个守护进程就多一个需要维护的进程、端口、日志、健康监控。叠加在已有机制上是零基础设施成本的方案。

---

### 6.6 成员专属 Agent：复用基础设施，切换系统提示

**场景**：需要为不同用户提供差异化的 AI 服务——同一个 Lucas 接待全家人，但每个人的偏好、背景、沟通风格完全不同。

**做法**：不要给每个成员单独起一个守护进程，而是在**同一个模型路由基础设施上，通过切换 system prompt 实现人格隔离**。每个成员一个目录，存两个文件：

```
~/.homeclaw/agents/<member-id>/
  config.json     # 机器可读：状态、人格参数、记忆 scope、wecom_user_id 映射
  agent.md        # 模型直读：成员专属 system prompt
```

关键设计：`wecom_user_id` 字段实现了「企业微信 ID ↔ 专属 Agent」的解耦映射。新成员加入时，填这一个字段，路由逻辑零修改。

**案例**：HomeAI 小姨专属 Agent（xiao-shan）。`config.json` 里定义了人格参数（朋友式、禁客服套话），测试时发 `userId: "xiao-shan"` 的副业咨询消息，回复用朋友语气，没有「您好感谢您的提问」。

**为什么有效**：当某个成员的需求需要真正独立的工具时，再升级为独立守护进程；在此之前，system prompt 隔离是足够的，零基础设施成本。

---

## 七、系统边界与干预

### 7.1 系统工程师边界：分清「我应该做」vs「系统应该做」

**场景**：需要为家庭成员创建专属 Agent。Claude Code 在执行中，主动为成员创建了 Agent 目录和配置文件。

**用户发现越权**：「这些 Agent 是 Lucas 创建的吗？」

**根因**：系统设计是「Lucas 根据触发条件自主决定什么时候创建成员 Agent」，但 Claude Code 直接替 Lucas 做了这个决策，跳过了流水线。这是**系统工程师越权**。

**正确行为**：
- 系统工程师负责**设计和实现能力**（`createMemberAgent()` 方法、触发机制、路由逻辑）
- **什么时候用这个能力**，是 Lucas 在运行时的决策，基于真实交互数据触发
- 系统工程师直接创建的唯一例外：经过设计确认的手动创建（用于测试通路）

**更深层的原则**：
> 系统工程师建设系统，不参与系统的日常运转决策。

当 Claude Code 发现自己在「替系统内部角色做决定」时，应该停下来问：这件事是应该出现在代码逻辑里，还是应该由我直接执行？

---

## 持续追加区

> **定位**：新发现的协作技巧和模式的原始落点。Claude Code 主动追加，格式：场景/做法/案例/为什么有效。
>
> **增长规则（Claude Code 主动执行）**：
> 1. 会话中出现有价值的新协作模式 → 直接追加到本区
> 2. 触发整理条件：同类条目 2+ 条，或内容明显属于某章节 → 移入对应章节，本区删除该条
> 3. 整理时同步更新版本号和时间戳

### 通道 ≠ Actor：出口降级时内部记录的 actor 必须保持真实

**场景**：系统有主通道（Bot WebSocket，显示「启灵」）和降级通道（企业应用，显示「系统工程师」）。Bot 未就绪时所有 Lucas 的消息都走降级通道。

**做法**：通道选择和 actor 记录完全解耦——`appendChatHistory` 等内部记录调用，放在 `try` 块里无论走哪个通道都执行，且始终传 Lucas 的标识，不传通道名称。

**案例**：`send-message` 接口：
```javascript
if (globalBotClient && globalBotReady) {
  await globalBotClient.sendMessage(userId, { ... });  // 显示「启灵」
} else {
  await sendWeComMessage(userId, text);  // 显示「系统工程师」
}
// 无论走哪个通道，记录的 actor 都是 Lucas
appendChatHistory(chatHistoryKey(false, null, userId), '[启灵主动发送]', text);
logger.info('发送', { channel, actor: 'lucas' });
```

**为什么有效**：降级是通道/显示名问题，是平台限制，不是角色问题。如果降级时同时把内部记录的 actor 也改成系统工程师，Lucas 的 chatHistory 就会出现空洞——他不记得自己说过的话。两个关切必须分开处理：对外（家人看到谁发的）受平台约束；对内（Lucas 的记忆里谁做的）必须真实。

---

### 系统工程师直接调 API 发出的内容，事后补录到对应 Agent 的 chatHistory

**场景**：通过 `curl` 或脚本直接调接口发出的消息，代表的是 Lucas 的内容（如通过 `/api/wecom/send-to-group` 发出的自我介绍），但因为是系统工程师发起的，不会自动写入 Lucas 的 chatHistory。

**做法**：发出后立即补录：
```python
history.insert(0, {"role": "user",      "text": "[启灵主动发送]", "ts": ts})
history.insert(1, {"role": "assistant", "text": "...Lucas的消息内容...", "ts": ts})
```

**为什么有效**：chatHistory 是 Lucas 的上下文窗口前缀，是他「记得自己说过什么」的依据。内容代表谁，记录就属于谁——发出渠道是系统工程师操作，不影响内容归属。

---

### 企业微信 aibot sendMessage：只支持 markdown，text 会 40008

**场景**：通过 aibot WebSocket 主动推送消息（无 frame 的 proactive 发送）。

**结论**：`sendMessage(chatid, body)` 只支持 `msgtype: 'markdown'`，不支持 `text`，群聊和私聊均如此。

```javascript
// 正确
await wsClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: text } });
// 错误 → 40008
await wsClient.sendMessage(chatId, { msgtype: 'text', text: { content: text } });
```

**被动回复（有 frame）用 replyStream**：私聊 message.text handler 收到消息后，有 frame 对象，应用 `replyStream(frame, text)` 回复，不用 sendMessage。

**为什么有效**：两类发送场景完全不同——被动回复走 frame 的 response 机制，主动推送走 aibot_send_msg 协议命令，两者支持的消息类型不同，混用必然报错。

---

### Gateway 资源隔离：用 Semaphore 给 Lucas 保留专属槽位

**场景**：多 Agent 共用同一 OpenClaw Gateway 进程，Andy 的 MiniMax 慢请求（300s 超时）积累后把 Gateway session pool 打满，Lucas 对话也一起挂死。

**做法**：在插件的 `before_prompt_build` hook 里加 Semaphore——Lucas 优先走专属保留池，保留池满时溢出到共享池；其他 Agent 只走竞争池。插件层拦截所有来源（不管是 wecom、TUI 还是任何 Channel）。

```typescript
// Lucas 专属 5 槽位（可溢出到共享池），其他竞争 5 槽位
const sem = agentId === 'lucas'
  ? (lucasSemaphore.available > 0 ? lucasSemaphore : sharedSemaphore)
  : sharedSemaphore;
await sem.acquire();  // 排队等待
// agent_end 释放，120s 安全阀兜底
```

**为什么有效**：慢 Agent 只能在竞争池排队，永远抢不到 Lucas 的专属槽位。Lucas 的对话响应能力和 Andy/Lisa 的流水线彻底解耦。这是「信任崩塌防线」——系统跑不出新特性可以接受，但 Lucas 不响应是致命的。

---

### Lucas 人格文件：SOUL.md 是有效文件，不要动 BOOTSTRAP.md

**场景**：需要修改 Lucas 的身份、性格、铁律、触发条件。

**结论**：`~/.openclaw/workspace-lucas/SOUL.md` 是每次 session 自动注入的唯一有效人格文件。`BOOTSTRAP.md` 是 OpenClaw 框架预置的占位文件，HomeAI 当前阶段不依赖它，改了也没有效果。

**错误做法**：把约束写进 BOOTSTRAP.md，然后疑惑为什么 Lucas 的行为没有改变。

**为什么有效**：SOUL.md 的注入由 OpenClaw 框架在 session 启动时执行，是可靠路径；BOOTSTRAP.md 是否生效取决于框架内部机制，不可控。所有约束统一放 SOUL.md，维护成本最低，行为最可预期。

---

### Lucas 触发开发任务的门槛：陪伴优先，确认后再触发

**场景**：家人说了一句模糊的话（"要是有个 XX 就好了"），系统工程师需要判断 Lucas 是否该触发开发流水线。

**做法**：SOUL.md 里用「第一原则：陪伴优先」定调，在工具调用铁律里要求触发前过 6 项确认清单（做什么 / 给谁用 / 交付物 / 触发方式 / 数据来源 / 紧急程度）。任意一项不清楚，先聊清楚再触发。

**为什么有效**：Lucas 随手触发的根本问题是「响应字面需求，而不是理解真实诉求」。陪伴原则让他先消化再行动；确认清单是结构化的判断工具，防止"感觉需求清楚了"的幻觉。

---

### 开发任务夜间调度：非紧急任务不占白天通道

**场景**：白天家人聊天时，Andy 的 MiniMax 慢请求（300s 超时）和 Lucas 的正常对话竞争 Gateway 槽位。

**做法**：`trigger_development_pipeline` 加 `urgent` 参数（默认 `false`）。execute 里判断：非紧急 + 当前是白天（8:00~22:00）→ 写入 `data/learning/task-queue.jsonl` 排队；空闲时段（22:00~8:00）drain scheduler 每 30 分钟检查一次，逐任务间隔 2 分钟顺序启动。

```typescript
if (!urgent && !isOffPeak) {
  appendJsonl(TASK_QUEUE_FILE, { requirement, intentType, wecomUserId });
  return { content: [{ type: 'text', text: '📋 已加入空闲队列，今晚自动启动' }] };
}
runAndyPipeline(...).catch(() => {});
```

**为什么有效**：把「要不要做」（Lucas 判断）和「什么时候做」（系统调度）解耦。白天通道完全留给陪伴，开发任务在夜间批量消化，互不干扰。

---

### OpenClaw BOOTSTRAP.md 的正确理解与清理

**场景**：之前把 BOOTSTRAP.md 当作永久人格文件在维护（和 SOUL.md 同等地位），导致两文件内容重叠且 BOOTSTRAP.md 逐渐过时（旧规则仍被注入）。

**源码结论**（`/opt/homebrew/lib/node_modules/openclaw/dist/agent-scope-DvYJ0Ktc.js`）：
- BOOTSTRAP.md 是一次性引导文件，OpenClaw 模板末行："Delete this file. You don't need a bootstrap script anymore — you're you now."
- `MINIMAL_BOOTSTRAP_ALLOWLIST`（最小必要文件集）= AGENTS / SOUL / TOOLS / IDENTITY / USER，**BOOTSTRAP.md 不在其中**
- 注入顺序：AGENTS / SOUL / TOOLS / IDENTITY / USER / HEARTBEAT / BOOTSTRAP（若存在）/ MEMORY
- BOOTSTRAP.md 在文件存在时会被注入，但设计意图是 onboarding 完成后删除

**做法**：
1. 对比 BOOTSTRAP.md 和 SOUL.md，找出 BOOTSTRAP.md 里 SOUL.md 没有的内容
2. 把差异内容合并进 SOUL.md（Lucas：受众感知；Andy：技术选型铁律 + Spec JSON 格式；Lisa：无）
3. 删除三个 workspace 的 BOOTSTRAP.md
4. 确认 workspace-templates 框架层本就无 BOOTSTRAP.md（正确状态）

**为什么有效**：消除了「BOOTSTRAP.md 里的旧规则仍在注入但没人维护」的静默问题。SOUL.md 成为唯一人格文件，维护路径清晰。

---

### MEMORY.md 与 CLAUDE.md 的分工：写作视角不同

**场景**：MEMORY.md 超出 200 行截断限制，且内容混乱——模型配置、工具清单、操作命令和认知提炼混在一起。

**正确分工**（2026-03-23 确立）：

| 文件 | 谁来写 | 写什么 |
|------|-------|-------|
| MEMORY.md | Claude Code 写给自己 | 从经历中提炼的判断：验证过的原则、踩过的坑的教训、架构洞察 |
| CLAUDE.md | 系统工程师写给 Claude Code | 项目操作上下文：当前状态、配置、约束、下一步 |

类比 OpenClaw：CLAUDE.md ≈ SOUL.md（人类维护，项目身份），MEMORY.md ≈ OpenClaw 的 MEMORY.md（agent 自己积累）。

**判断标准**：一个内容「换了项目还成立」→ 放 MEMORY.md；「离开 HomeAI 就没意义」→ 放 CLAUDE.md。

**做法**：整理时把 MEMORY.md 中所有操作性内容（配置表、命令、任务历史）确认已在 CLAUDE.md 覆盖后删除，只保留认知提炼。目标 100 行以内。

**为什么有效**：MEMORY.md 200 行截断是硬限制；内容越精炼，新会话恢复上下文越快；操作细节放 CLAUDE.md 不会丢失，只是换了地方。

---

### 关键决策记录体系：Obsidian 04 目录

**场景**：历史会话里有大量架构决策、踩坑教训，散落在 CLAUDE.md 动态区和工作日志里，没有结构化索引，回溯困难。

**做法**：在 `Obsidian/04-系统工程师关键决策记录/` 下按主题建文档：

```
架构与设计/
  01-整体架构演进.md     ← OpenClaw集成、V字流水线、per-message session 等
  02-模型选型决策.md     ← 模型切换历史与原因
  03-Skills架构演进.md   ← 扁平→子目录的迁移过程
协作模式与协议/
  01-双窗口运作模式.md
  02-信息域与文档协议.md
经验与教训/
  01-Gateway稳定性问题.md
  02-ChromaDB脏数据.md
  03-平台约束踩坑.md
```

**触发写入**：会话关闭协议第④步判断——本次有架构变更/版本决策/越界干预 → 追加到对应文档。从历史会话批量提取时，以 CLAUDE.md 和 MEMORY.md 已有内容为主要素材，不需要重读所有 JSONL。

**为什么有效**：`03-工作日志` 是时间线索引，`04-关键决策记录` 是主题索引。两者互补，新会话定位任务用工作日志，理解某个决策的来龙去脉用关键决策记录。

---

### macOS 熄屏后消息断连：禁止系统睡眠

**场景**：Mac 熄屏一段时间后，企业微信 WebSocket 断连，家人消息收不到。

**根因**：`pmset` 默认 `sleep=1`（闲置1分钟睡眠）+ `networkoversleep=0`（睡眠时断网）。watchdog 的 `caffeinate` 只是临时5分钟防睡，超时后失效。

**修复**（插电状态下永不睡眠）：
```bash
sudo pmset -c sleep 0        # 插电时禁止系统睡眠
sudo pmset -c displaysleep 15  # 屏幕仍可正常熄屏
```

**验证**：
```bash
pmset -g custom | grep sleep
# 期望：sleep 0，displaysleep 15
```

**注意**：`-c` 只影响插电（AC Power）配置，`pmset -g` 显示当前激活配置，需用 `pmset -g custom` 才能看到 AC Power 专属设置是否已变更。

### 用 AI 读源码：系统知道细节，人知道结论

**场景**：系统行为和预期不符，但不确定是自己的代码问题还是上游框架（OpenClaw、企业微信 SDK、任何第三方库）的行为本来如此。原来的选择是：查文档（往往不全）、试错（成本高）、靠猜（不可靠）。

**协作分工**：
- **AI 做**：定位源码 → 阅读关键函数 → 提炼行为逻辑 → 给出可直接使用的结论
- **人做**：说清楚疑问（「BOOTSTRAP.md 到底有没有被注入」），确认结论（「对，就是这个意思」），决定方向（「那就删掉它」）

整个过程，人不需要看一行源码。框架的细节留在 AI 的理解里；人获得的是行动判断依据。

**今日案例**（2026-03-23，OpenClaw BOOTSTRAP.md 真相）：

之前认为 SOUL.md 和 BOOTSTRAP.md 是两个同等地位的人格文件，会被同时注入。实际上：

```
问题：「BOOTSTRAP.md 到底有没有被注入？它和 SOUL.md 是什么关系？」

AI 读了：
  /opt/homebrew/.../openclaw/dist/agent-scope-*.js
  /opt/homebrew/.../openclaw/dist/reply-*.js
  /opt/homebrew/.../openclaw/docs/reference/templates/BOOTSTRAP.md

提炼出：
  - MINIMAL_BOOTSTRAP_ALLOWLIST 不含 BOOTSTRAP.md
  - 注入顺序：AGENTS/SOUL/TOOLS/IDENTITY/USER/HEARTBEAT/BOOTSTRAP（若存在）/MEMORY
  - 模板末行："Delete this file. You don't need a bootstrap script anymore — you're you now."
  - 设计意图：onboarding 引导文件，用完即删

人得到结论：「原来是一次性文件，删掉它，把独有内容合并进 SOUL.md」
```

这次读了三个混淆编译后的 .js 文件，如果靠人来读，需要 1-2 小时。AI 定位 + 提炼用了 10 分钟。

**适用范围**：任何「不知道某个框架/工具真正怎么工作」的时候：
- 上游平台的 SDK 行为（企业微信 aibot、OpenClaw、任何 npm 包）
- 某个配置项到底有没有生效（找源码里读它的地方）
- 某个错误的根因在上游还是自己（追调用链）

**触发时机**：
1. 系统行为和预期不符，且排除了自己的代码问题
2. 文档说法不明确，或文档和实际行为不一致
3. 准备动一个东西之前，想知道「改这里会影响什么」

**为什么有效**：AI 在「阅读大量代码 + 提炼核心逻辑」这件事上是真正高效的。人的时间用在「提出正确的问题」和「确认结论后做决策」——这两件事 AI 做不了。人机协作的杠杆在这里：系统知道细节，人知道方向。

---

## 遇到「平台特殊性」问题，先查行业最佳实践，不要闷头自己搞

**教训来源**：2026-03-24，抖音视频内容提取。

花了整整半天走了以下弯路：yt-dlp → cookies.txt → headless Playwright + stealth → non-headless Chrome → CDP → cookies 注入 Playwright……全部失败。最后查了一下行业资料，15 分钟找到真正的解法。

**根本原因**：抖音的 API 需要 X-Bogus 动态签名，yt-dlp 的 Douyin extractor 有已知 bug，所有通用浏览器自动化工具都被抖音的 JS bot 检测挡住。这是行业共知的问题，有专门的解决方案，不是「稍微复杂一点的技术问题」。

**正确的工作方式**：
1. 遇到「主流平台的数据提取」需求，**第一步先搜索**，关键词：`[平台名] + scraper/API/extract + 2026`
2. 专注于**验证已知方案**是否适用，而不是自己从头推导
3. 闷头实现 30 分钟无进展 → 立刻停下来查资料

**这次的行业答案**：
- **抖音**：移动端分享页 `iesdouyin.com/share/video/{id}/` 直接返回含视频标题/描述的 HTML（无需登录，无需签名），正则提取 `"desc"` 字段即可。复杂场景用 [Evil0ctal/Douyin_TikTok_Download_API](https://github.com/Evil0ctal/Douyin_TikTok_Download_API)（Python，实现了 X-Bogus + A-Bogus 签名算法）。
- **YouTube/Bilibili**：yt-dlp 完全可用，字幕 + 元数据一键提取。
- **视频转文字**：[AsrTools](https://github.com/WEIFENG2333/AsrTools) 利用剪映/JianYing 的免费 ASR 接口，无需 API Key。
- **通用原则**：抖音 ≠ 普通网站，其 Web API 有动态签名保护，任何「自己写请求」的方案都会撞墙。

**可迁移的规则**：任何涉及「头部平台（微信/抖音/微博/小红书/B站）的数据提取」，都要先假设有成熟的专用工具，搜 GitHub Topics 和 PyPI 后再动手。

<!-- 新发现的技巧从这里追加 -->


## Gateway /v1/chat/completions 调试方法

OpenClaw Gateway 走 HTTP POST，`/health` 是 GET，`/v1/chat/completions` 是 POST。直接 curl 时必须带两个关键 header：

```bash
TOKEN=$(python3 -c "import json,os; d=json.load(open(os.path.expanduser('~/.openclaw/openclaw.json'))); print(d['gateway']['auth']['token'])")
curl -s -X POST http://localhost:18789/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-openclaw-agent-id: andy" \
  -d '{"model":"andy","messages":[{"role":"user","content":"你好"}],"stream":false,"user":"test:sys:001"}' \
  --max-time 45
```

**关键点**：
- `x-openclaw-agent-id` header 必须与 `model` 字段一致，缺少时返回 `{"error":{"message":"Unauthorized"}}`
- 响应格式：`choices[0].message.content`；有时含控制字符导致 JSON 解析失败，可存文件后用 `strings` 查看
- Gateway 日志在 `/tmp/openclaw/openclaw-YYYY-MM-DD.log`，含工具调用链的完整流水线记录

---

## MiniMax 无交互场景 exec 不可靠：预计算注入模式

**问题**：在 HEARTBEAT / cron / watchdog 触发的无交互场景下，MiniMax 倾向于跳过 exec 工具调用，直接生成回复。即使：
- exec-approvals.json 白名单已包含 python3/bash
- HEARTBEAT.md 明确写了 Python 代码块要求执行
- 请求完全正常（HTTP 200，响应时间 <60s）

MiniMax 仍可能直接返回「无待处理」或空洞答复，根本没有触发 exec。

**根本原因**：无交互场景 = 没有用户审批/反馈的上下文，MiniMax 在此场景倾向于跳过不确定的工具调用。

**解法：触发方预计算注入**

在触发 HEARTBEAT 的一侧（gateway-watchdog.js）预先计算好数据，将结果注入消息内容，Agent 只需读文字做判断，不依赖 exec：

```javascript
// gateway-watchdog.js：buildHeartbeatContext() 模式
function buildHeartbeatContext() {
  const sections = [];
  // 1. 写临时 Python 脚本查 Kuzu
  fs.writeFileSync(tmpScript, kuzuScriptContent);
  const output = execSync(`python3 ${tmpScript}`, { timeout: 15_000 });
  sections.push(`【预计算数据 - 检查 1：Kuzu 候选】\n${output}`);
  // 2. 读 skill-candidates.jsonl
  const pending = readPendingCandidates();
  sections.push(`【预计算数据 - 检查 2：pending 条目】\n${JSON.stringify(pending)}`);
  return sections.join('\n\n');
}

// 注入消息
const body = JSON.stringify({
  messages: [{ role: 'user', content: `HEARTBEAT\n\n${buildHeartbeatContext()}` }]
});
```

**HEARTBEAT.md 对应写法**：
```markdown
触发此巡检的消息内容已包含预计算数据（格式：【预计算数据 - 检查 N：...】），直接读取即可，无需自行查询数据库。
```

**可复用性**：任何需要 Agent 在无交互场景读取结构化数据的场景（定时任务、watchdog 触发、自动化流水线），都应在触发方预计算注入，不期望 Agent 自己 exec。

---

## 会话关闭：讨论内容分类落地

关闭协议第一步：扫描本次会话所有讨论，按以下规则分类写入 CLAUDE.md【下次起点】：

- **已达成基本共识、方向明确** → `⬜ 待执行任务`（附具体实现方向）
- **讨论未完、还没有定论** → `💬 待续讨论`（简述讨论到哪里、分歧或开放问题是什么）

MEMORY.md 只存跨会话稳定认知，不存讨论过程。「保存认知」≠「进计划」，二者不能混淆。

### wecom WebSocket 静默卡死排查 SOP（2026-04-08）

**现象**：用户发消息无响应，`pm2 list` 显示 wecom-entrance `online`，但日志停止更新（无 pong、无新消息）。

**根因**：企业微信 SDK 重连时 attempt 2 之后静默失败——无 "connected" 日志，无后续 retry，进程存活但 WebSocket 已死。

**快速确认**：
```bash
tail -20 ~/HomeAI/Logs/pm2/wecom-out.log
# 正常：有 "Received heartbeat ack" 每 30s 一条
# 卡死：最后条目停在 "Reconnecting in Xms (attempt 2)" 之后
```

**治标**：`pm2 restart wecom-entrance`（5s 后 WebSocket 重连成功）

**注意**：断连恢复后，Gateway 可能补发断连期间的旧 push-reply（含失败结果），用户会收到历史"处理失败"消息——这是正常的延迟送达，不是新故障。
