# 10 - Engineering Notes

> **维护方：系统工程师**
> **定位**：在系统维护、调试、架构演进过程中发现的实现陷阱、平台 bug、编程约束。
> 每次会话发现新陷阱时追加，不要删改已有条目。
>
> **流向**：`distill-agent-memories.py` → Kuzu `has_pattern`（agent=lisa）→ `render-knowledge.py` → CODEBASE.md DISTILLED 区块
>
> **格式规范**：
> - 每条以 `### 标题` 开头（三级标题，蒸馏脚本识别此格式）
> - 标题应是可被语义召回的短语，如「Kuzu 无过滤边扫描 SIGSEGV」
> - 正文说明：场景 + 现象 + 根因 + 规避/修复方式
> - 结尾标注确认日期
> - **状态行（必填）**：`**状态**：活跃 | 已失效（原因：XXX，日期）| 待复核（环境变更：XXX）`
>   - 活跃 = 当前版本已验证，仍需规避
>   - 已失效 = 库升级或 bug 修复，规避措施不再需要
>   - 待复核 = 相关库有版本变更，需 Lisa 实验验证后更新
> - **失效或复核更新由 Lisa 通过 `【约束验证】` 标记触发，系统工程师在此文件确认**

---

## 2026-04-10

### 访客 userId 写读路径格式不一致导致历史检索永远为空

**场景**：ChromaDB `conversations` 集合中，访客对话写入时使用真实姓名（如 `王炜琦`）作为 `userId` 字段；查询时 `queryMemories` 访客分支使用 `visitor:TOKEN`（如 `visitor:b97e8e`）查询。

**现象**：访客的历史对话无法被 `recall_memory` 或 `queryMemories` 检索到，每次对话都像第一次见面。

**根因**：写入路径在 `agent_end` 中调 `writeMemory` 时，`userId` 已被解析为真实姓名；查询路径在 `before_prompt_build` 中用了原始的 `visitor:TOKEN` 字符串，两者格式不统一。

**规避/修复**：`queryMemories` 访客分支改为先从 `visitor-registry.json` 解析真实姓名，再用真实姓名执行 ChromaDB 查询。**原则**：数据存储的 key 格式与查询使用的 key 格式必须完全一致，不能在中间层做映射后忘记同步查询侧。

**确认日期**：2026-04-10
**状态**：活跃

---

### 访客上下文措辞结构相似导致弱模型身份混淆

**场景**：Lucas 与访客对话时，`buildVisitorSessionContext` 注入的上下文措辞与家人档案注入路径结构相似（都有「你正在和 XXX 交谈」类句式）。

**现象**：当系统中家庭对话历史充沛、且访客（如王炜琦）与某家庭成员同为男性时，弱模型（DeepSeek Chat）偶发身份混淆，将访客识别为「爸爸」等家庭成员。

**根因**：弱模型对上下文中的隐式结构敏感——如果访客注入块和家庭成员注入块的句式相似，模型在大量家庭上下文背景下可能被「最强信号」带偏。显式边界说明优先于隐式区分。

**规避/修复**：重写访客上下文措辞，明确标注「当前是访客对话，对方不是家庭成员」，避免与家人档案注入路径的句式混淆。**原则**：面向弱模型的上下文设计中，任何身份边界都应显式声明，不依赖模型通过结构推断。

**确认日期**：2026-04-10
**状态**：活跃

---

## 2026-03-28

### Kuzu 无过滤边扫描触发 SIGSEGV

**场景**：在 Python 脚本中执行 Kuzu Cypher 查询，使用无节点约束的边扫描。

**现象**：`MATCH ()-[f:Fact]->()` 触发 Kuzu worker thread SIGSEGV（`_platform_memmove` null 地址写，exit code 139），进程直接崩溃。

**根因**：Kuzu 0.11.3 macOS ARM64 内部 bug，不同于已知的 `Database::~Database()` SIGBUS，是另一处内存访问越界。

**规避规则**：查边时必须指定 src 或 dst 节点的属性过滤，禁止写无约束边扫描：
```cypher
-- 禁止
MATCH ()-[f:Fact]->() RETURN f LIMIT 1

-- 正确
MATCH (p:Entity {id: $uid})-[f:Fact]->(o:Entity) RETURN f.relation
```

**状态**：活跃（Kuzu 0.11.3，macOS ARM64 已验证）

**确认日期**：2026-03-28

---

### Kuzu 表缺列时写入虚报（written 计数不可信）

**场景**：给 Kuzu 的 CREATE 语句新增字段（如 `privacy_level`），但未提前执行 `ALTER TABLE` 添加该列。

**现象**：`conn.execute(...)` 抛 `Binder exception: Cannot find property xxx`，被 `try/except` 捕获后，外层 `written += 1` 仍然执行——脚本打印"写入 N 条"，实际 0 条入库，且不报错退出。

**根因**：Python 的 `try/except` 捕获了 Kuzu Binder 异常，但计数器在 try 块外部递增，导致虚报。

**修复方式**：执行 `ALTER TABLE TableName ADD column_name TYPE DEFAULT value` 补列。任何 Kuzu schema 变更后必须用独立查询验证实际落盘，不能信任脚本的 `written` 计数。

**状态**：活跃（schema 变更时必须验证）

**确认日期**：2026-03-28

---

### ChromaDB userId 与 Kuzu Entity ID 大小写不匹配

**场景**：从 ChromaDB 读取 `userId` 后，直接用于 Kuzu 的 MATCH/CREATE 操作。

**现象**：ChromaDB 存储的 userId 为小写（如 `zifeiyu`），Kuzu 中 person Entity 节点 ID 为大驼峰（如 `ZiFeiYu`，来自 `init-family-relations.py` 初始化）。`MATCH (p:Entity {id:'zifeiyu'})` 匹配不到任何节点，后续 CREATE 静默跳过——无报错，但 0 条数据写入。

**规避规则**：所有涉及 ChromaDB userId → Kuzu entity ID 的脚本，必须使用 `CHROMA_TO_KUZU_ID` 映射做规范化（定义在 `scripts/distill-memories.py`）：
```python
kuzu_user_id = CHROMA_TO_KUZU_ID.get(user_id, user_id)
```

**状态**：活跃（依赖 CHROMA_TO_KUZU_ID 映射维护）

**确认日期**：2026-03-28

---

### WeCom aibot SDK：response_url TTL 与长流程处理时间竞争

**场景**：`handleMediaMessage` 收到视频/大文件，内联执行下载 + Claude API 调用 + `wsClient.replyStream(frame, ...)`。

**现象**：视频下载（数十 MB）+ Claude API 调用合计超过 WeCom response_url 有效期（约 5 分钟，由签名参数 `q-sign-time` 决定），`replyStream` 抛 `stream has been aborted`，用户收不到回复，任务结果丢失。

**根因**：WeCom Bot SDK 的被动回复依赖 `frame` 对象携带的 `response_url`，该 URL 有 TTL。任何长流程任务都不能在 `response_url` 有效期内完成时才回复。

**规避规则**：收到媒体/长流程触发消息后，必须在 1 秒内发出 ACK（立即 `replyStream` 告知「已收到，处理中」），实际处理逻辑全部异步走 TaskManager；结果通过 `globalBotClient.sendMessage`（主动推送，不依赖 response_url）发回。

**确认日期**：2026-03-28

---

### WeCom aibot SDK：并发媒体消息互相 abort stream

**场景**：同一用户在 3 秒内连发两个视频，两个 `handleMediaMessage` 并发执行，各自持有不同的 `frame` 对象（不同 `response_url`）。

**现象**：两个任务都调用 `callGatewayAgent`（同 userId，同 session key），Gateway session 层产生上下文混淆；先完成的任务 `replyStream` 成功，后完成的抛 `stream has been aborted`；第二个视频的 chatHistory 不写入，转录结果不推送，成为死数据。

**规避规则**：同一 userId 的长流程任务必须串行执行（per-user Promise 链 mutex），不允许并发；每个任务使用独立 session ID（`lucas:followup:{taskId}`），不共享 session 上下文。

**确认日期**：2026-03-28

---

### re.sub 替换字符串含反斜杠 → 绕过 os._exit(0) → 触发 Kuzu SIGBUS

**场景**：在使用 Kuzu 的 Python 脚本中，用 `re.sub(pattern, replacement_str, content)` 替换文件内容，`replacement_str` 来自 LLM 蒸馏输出（可能含 `\d`、`\n`、`\g` 等字符）。

**现象**：`re.sub` 抛 `re.error: bad escape \d at position NNN`，异常未被捕获，向上冒泡至 `main()`，`os._exit(0)` 未能执行。Python 正常退出流程触发 `Database::~Database()` → SIGBUS（exit code 138）。表面看是 Kuzu SIGBUS，实为 re.sub 异常绕过了 SIGBUS 修复。

**根因**：`re.sub` 把替换字符串当作 regex 替换模板处理，`\d`/`\n`/`\g<name>` 等均为特殊转义序列。蒸馏内容含此类字符时即触发 `re.error`。

**规避规则**：凡替换字符串来自外部内容（LLM 输出、用户输入、文件读取）时，必须用 lambda 形式：

```python
# 禁止（替换字符串含特殊序列时 re.error）
pattern.sub(new_section, content)

# 正确（lambda 绕过替换字符串解析）
pattern.sub(lambda m: new_section, content)
```

**附：任何 Kuzu 脚本中未被捕获的异常都会绕过 os._exit(0)，触发 SIGBUS**。修复方式：在 `main()` 主体包 `try/finally`，`os._exit(0)` 放进 `finally`，保证所有退出路径都经过它。

**已修复范围（2026-03-28）**：
- `render-knowledge.py`：line 379 `re.sub` 改 lambda；main() 加 try/finally
- `distill-memories.py`：main() 加 try/finally
- `distill-agent-memories.py`：main() 加 try/finally
- `init-capabilities.py`：main() 加 try/finally
- `init-family-relations.py`：main() 加 try/finally

**状态**：活跃（新增 Kuzu 脚本时必须遵守，已有五脚本已修复）

**确认日期**：2026-03-28

---

### WeCom aibot SDK：失败路径不写 chatHistory → 媒体文件成死数据

**场景**：`handleMediaMessage` 在 catch 块中捕获异常，发送错误提示后 return，`appendChatHistory` 从未被调用。

**现象**：文件已落盘，但 chatHistory 无记录，Lucas 的记忆里不存在这个文件，无法主动检索，文件成为死数据。

**规避规则**：TaskManager 在 Task 创建时立即写入 chatHistory（ACK 条目），Task 完成/失败时写入结果条目；失败的 Task 写入 ChromaDB dead letter，确保 Lucas 可检索到「有个任务失败了」。

**确认日期**：2026-03-28

---

### WeCom aibot 群消息推送中断（WebSocket 心跳正常但 message.text 不触发）

**场景**：企业微信智能机器人 WebSocket 长连接。

**现象**：心跳 ACK 正常（平台侧认为连接存活），但群里 @启灵 的消息不触发 `message.text` 事件，日志无任何「Bot 收到」记录。私聊消息同期仍正常到达。重启 wecom-entrance（重建 WSClient 连接）后群消息可能恢复；若无效则需将启灵踢出群再重新拉入。

**根因**：平台侧偶发性中断对该 bot-group subscription 的消息推送，原因不明（可能与 `846607: frequency limit exceeded` 触发群级冷却有关）。WebSocket 本身未断线，SDK 无法感知推送静默，也无主动订阅刷新机制。

**恢复方式**：
1. `pm2 restart wecom-entrance`（重建 WSClient，适用于连接层问题）
2. 若重启无效：将启灵踢出群 → 重新拉入（刷新平台侧 bot-group subscription）

**监控**：gateway-watchdog 已加入群消息沉默检测（每 30 分钟扫 chatHistory，私聊有更新但群消息沉默超 2 小时 → 通过 notify-engineer 端点告警业主）。

**状态**：活跃（平台行为，无法从代码侧根本解决，监控已到位）

**确认日期**：2026-03-28

---

### Lucas 语音输出：生成模态 vs 输出模态分离

**场景**：Lucas 生成 markdown 格式回复，TTS 朗读时 `**粗体**` 变成"星号星号"，或列表符号破坏语气节奏。

**根因**：语言模型的默认输出格式为视觉渲染设计，朗读时语义完全不同。核心矛盾是**生成模态（文字）和输出模态（声音）不匹配**。

**解决方案**：两层分离

1. **`[VOICE]` 标记**：Lucas 判断「这段话适合被说出来」时在回复末尾加 `[VOICE]`，入口层检测后激活语音管道
2. **`stripMarkdownForVoice()`**：剥离 `**` / `*` / `#` / 列表符 / 代码块 / 链接，同时去除 `[VOICE]` 标记；文字展示和 TTS 均用这份清洁文本
3. **TTS 管道**：`sendVoiceReply(toUserId, text)` → edge-tts MP3 → `uploadMedia(type='voice')` → WeCom 真语音泡泡（非文件附件）

**时序设计**：先发文字，再 fire-and-forget 追加语音。TTS 生成（约 3-5s）不阻塞文字响应，失败也不影响主流程。

**SOUL.md 指引**：Lucas SOUL.md「声音模式」节定义了语音适用场景（情感/叙事/提醒）和写作规范，让模型在**生成阶段**就写说话体，而不只靠后处理剥离符号。这是根本解法：输入侧写好说话体 > 输出侧后处理补救。

**状态**：活跃（edge-tts 7.2.8，zh-CN-XiaoxiaoNeural，已验证）

**确认日期**：2026-03-28

---

### 调试接口与主流程同步的「漏更新」陷阱

**场景**：主流程改了接口签名或行为，调试/测试接口没有同步更新，导致测试结果误导。

**本次案例**：
- 主流程（`message.text` / `message.mixed` / `message.voice`）已正确使用 `buildHistoryMessages` + `historyMessages` 参数
- `/api/wecom/forward` 调试接口仍用旧方式 `callGatewayAgent('lucas', message, userId)`——无历史传入，无 `appendChatHistory` 写回
- 测试 3 条消息后 Lucas 无法引用上文 → 误判为 Layer 2 实现失败
- 实际上主流程早已正确，只是调试接口漏更新

**规则**：
- 改主流程的接口签名时，同步检查所有测试/调试入口（`/api/wecom/forward`、watchdog 探测调用等）
- 调试接口应与主流程保持功能对等，不能是简化版本（否则测试的不是真实行为）
- 验证时优先用真实 WeCom 消息，或确认调试接口与主流程完全等价后再用调试接口

**状态**：活跃

**确认日期**：2026-03-28

---

### 入口共享模块 + 启动时自动迁移模式

**场景**：多个 entrance（wecom / feishu / email）需要共用同一套逻辑（如 chatHistory），同时已有历史数据需要格式升级。

**模式**：
1. 提取共享模块到 `daemons/entrances/{module}.js`，各入口 `require('../{module}')`
2. 模块内用 IIFE 在 require 时执行一次性迁移（重命名文件、补字段等）
3. 迁移幂等：先检查新格式是否已存在，存在则跳过

```javascript
// 启动时自动迁移（IIFE，require 时执行一次）
(function migrateOldFiles() {
  const files = fs.readdirSync(DIR);
  for (const f of files) {
    if (f.startsWith('user:') || f.startsWith('group:')) {
      const newPath = path.join(DIR, 'wecom:' + f);
      if (!fs.existsSync(newPath)) fs.renameSync(path.join(DIR, f), newPath);
    }
  }
})();
```

**好处**：
- 迁移与模块共存，不需要单独运行迁移脚本
- 进程重启时自动完成，零人工操作
- 新代码和旧数据之间的兼容性由模块自己负责

**本次案例**：`chat-history.js` 将 `user:X` / `group:X` 迁移为 `wecom:user:X` / `wecom:group:X`，wecom-entrance 重启后历史文件自动升级，Lucas 历史数据零损失。

**状态**：活跃

**确认日期**：2026-03-28

---

### Kuzu 0.11.3 `date()` 无参数不可调用

**场景**：在 Cypher 查询中使用 `WHERE f.valid_until >= date()` 想获取当前日期做比较。

**现象**：Kuzu 抛出 `Binder exception: Function DATE did not receive correct arguments: Actual: () Expected: (STRING) -> DATE`，查询失败返回空结果。

**根因**：Kuzu 0.11.3 的 `date()` 函数只接受一个 STRING 参数（如 `date('2026-03-28')`），不支持无参形式获取当前日期。Kuzu 也没有 `today()`、`current_date`、`now()` 等无参当前日期函数。

**规避/修复方式**：在调用 Kuzu 之前，由宿主语言（TypeScript/Python）计算今日日期字符串，替换 Cypher 中的 `date()` 占位符，再传入 Kuzu 执行。

index.ts resolver 已实现自动替换（类似 `$topK` 的处理）：
```typescript
const todayStr = new Date().toISOString().slice(0, 10);
const cypher = _cypher.replace(/\bdate\(\)/g, `date('${todayStr}')`);
```

所有在 context-sources.ts 定义的 Cypher 中，`date()` 无参形式会被 resolver 自动替换为当日日期字面量，无需在每个查询里手动填日期。

**状态**：活跃（Kuzu 版本 0.11.3，待升级时复核）

**确认日期**：2026-03-28

---

### render-knowledge.py 更新后 inject.md 不自动重渲染

**现象**：修改 `render-knowledge.py` 代码逻辑后（如新增 `（待确认）` 标注），已生成的 inject.md 文件不会自动更新，仍保留旧内容。

**原因**：render-knowledge.py 只在被显式调用时才运行（distill 后触发，或手动执行）。代码变更本身不触发重渲染。

**规避规则**：修改 render-knowledge.py 后，如需立即验证效果，必须手动执行：
```bash
cd ~/HomeAI && /opt/homebrew/opt/python@3.11/bin/python3.11 scripts/render-knowledge.py --user {userId}
```
后续 distill-memories.py 定时任务（周日凌晨 2 点）会带 render，之后恢复自动更新。

**状态**：活跃

**确认日期**：2026-03-29

---

### Lucas 私聊中转群聊内容时忽略渠道指令

**场景**：用户在私聊里把群聊内容转发给 Lucas，并明确说"你直接在群里回"。

**现象**：Lucas 在私聊直接输出了回复内容，没有调 `send_wecom_message` 发到群里。群里没有任何消息，用户的指令被静默忽略。

**根因**：AGENTS.md 没有覆盖「私聊中转发群聊内容 + 指定渠道」这个模式。Lucas 面对「指令嵌在内容里」的结构时，倾向于提取内容并在当前对话回复，渠道指令（"在群里回"）被当作背景信息处理而不是行动触发器。

**修复**：AGENTS.md 新增情况 I，明确：识别到"在群里回"/"发到群里"等指令 → 调 `send_wecom_message(群chatId, 内容)` → 私聊仅告知"已在群里回"。

**规避规则**：Lucas 处理私聊消息时，先判断「回复目标渠道」再组织内容——默认渠道是当前私聊，但出现渠道指令时必须切换，不能把渠道指令当作普通上下文忽略。

**状态**：活跃（AGENTS.md 情况 I 已覆盖）

**确认日期**：2026-03-29

---

### 企业微信 WebSocket 重推同一消息导致 Lucas 重复回复

**场景**：企业微信 aibot WebSocket 在网络抖动时，会将同一条消息（相同 msgid）重新推送多次。

**现象**：2026-03-21 爸爸发了一条「帮我写脚本」的消息，ChromaDB 中记录了 13 条相同内容的对话，Lucas 每次均正常响应——家人侧感知是「Lucas 一直在重复说同样的话」。

**根因**：wecom-entrance 入口层对 msgid 没有任何去重机制。每次 `message.text`/`message.voice`/`handleMediaMessage` 收到推送，都直接透传给 Lucas 处理，不检查是否已处理过相同 msgid。

**修复**：在 wecom-entrance 全局加 `processedMsgIds` Set：
```javascript
const processedMsgIds = new Set();
function isDuplicateMsg(msgId) {
  if (!msgId || processedMsgIds.has(msgId)) return true;
  processedMsgIds.add(msgId);
  setTimeout(() => processedMsgIds.delete(msgId), 60_000);
  return false;
}
```
在三类消息入口（`message.text` / `message.voice` / `handleMediaMessage`）开头调用，重复则直接 return 并记录日志。

**规避规则**：企业微信 WebSocket 消息入口必须做 msgid 去重。TTL 设 60 秒：足够覆盖重推窗口，不会长期占用内存。

**状态**：活跃（wecom-entrance 已修复，v529）

**确认日期**：2026-03-29

---

### 教师模型干预：Lucas 反复违反 Markdown 禁令和幻觉承诺

**场景**：系统工程师定期读 ChromaDB 真实对话，执行「教师模型干预」——识别系统自进化无法修复的行为缺口。

**现象（2026-03-22 对话）**：
1. Lucas 多次使用 `## 标题` 格式回复。AGENTS.md 已有禁令，但描述不够具体，模型当「原则」而非「铁律」。
2. 爸爸指出「你把想做的和已经做的搞混了」——Lucas 承诺执行某动作（如创建 skill），实际没有调用任何工具，但语气像已完成。

**根因**：两类缺口属于「正确行为从未发生过」——自进化（ChromaDB→蒸馏→MEMORY.md）只能强化已出现的模式，对从未被纠正到位的行为无效。必须靠教师模型（系统工程师）直接写入约束。

**修复**：AGENTS.md「回复格式铁律」节新增：
- Markdown 禁令加负例示范（`❌ 错：## 标题` / `✅ 对：**加粗**`）
- 「**禁止把「打算做」说成「已经做」。** 承诺了什么必须调工具确认才算完成。没有调工具 = 没有发生。」

**规避规则**：教师模型干预的触发信号是「家人纠正了 Lucas 的行为，但后续对话中还是犯同样的错」——说明自进化无法收敛，需外部写入规则。干预后观察 1-2 周确认缺口是否消除。

**状态**：活跃（AGENTS.md 已更新，待观察）

**确认日期**：2026-03-29

---

### wecom-entrance 事件处理器闭包作用域隔离陷阱

**场景**：`wecom/index.js` 中多个 `wsClient.on('message.*', ...)` 事件处理器，某处理器定义了局部辅助函数，另一处理器直接复用该函数调用。

**现象**：私聊语音消息（`message.voice`）完全静默无回复。日志报 `"error":"sendWithTimeout is not defined","message":"语音消息处理失败"`。消息被 catch 块捕获后直接丢弃。

**根因**：`sendWithTimeout` 定义在 `message.text` 处理器的闭包内（局部 `const`），是该闭包的私有变量。后续给 `message.voice` 处理器增加私聊 `replyStream` 支持时，直接抄了函数调用，但漏掉将函数定义一起带入 voice 处理器作用域。JS 事件回调是独立闭包，互相不可见对方的局部变量。

**隐蔽性**：只有「私聊语音」路径触发此 bug——群聊语音用 `wsClient.sendMessage`（不调 `sendWithTimeout`），私聊文字在 text 处理器内部（定义可见），两者均正常。该路径长期未被触发，直到第一次发私聊语音消息才暴露。

**修复**：在 `message.voice` 处理器内添加同样的局部定义。

**规避规则**：`wsClient.on(...)` 各事件处理器是独立闭包。工具函数若需跨处理器复用，必须定义在模块级别（handler 外层），不能只定义在某一个 handler 内部后在其他 handler 里调用。

**状态**：活跃

**确认日期**：2026-03-29

---

### 同模型不同稳定性：模型层约束 vs 基础设施层约束

**背景**：Lucas（Claude Sonnet 4.6）与 Claude Code（同模型）在稳定性上存在明显差距——Markdown 格式违规、幻觉承诺等问题反复出现，即使 AGENTS.md 写了明确的禁令。

**根因**：Claude Code 在基础设施层约束模型行为（工具是唯一动作通道，不调工具=什么都没发生），Lucas 在模型层约束（AGENTS.md 规则靠模型记忆遵守）。基础设施约束是确定性的，模型约束是概率性的。同一个模型放在不同架构里，表现就不同。

**修复模式**：

1. **格式类约束 → 基础设施执行**：不要指望模型"记住"不能用 `## `。在输出路径（wecom-entrance `stripMarkdownForWecom`）拦截，无论模型输出什么，到达用户前都被修正。已实现：wecom-entrance 所有三个输出路径（主回复/push-reply/send-message）统一调用 `stripMarkdownForWecom`，`## title` → `**title**`，`---` → 空行。

2. **行为约束 → 每轮注入**：AGENTS.md 里的禁令在对话加长后被上下文压缩，模型"忘记"规则。解法：在 `before_prompt_build` 的 `appendSystemContext` 里每轮重新注入承诺词禁令，让它始终在最近的上下文窗口里，不依赖系统提示的记忆持久性。

3. **规则数量 → 最小化**：情况越多，失败点越多（11个情况=11个潜在失败分支）。目标：能下沉到工具 description 的逻辑就下沉，AGENTS.md 只保留不能下沉的核心判断。

**状态**：格式基础设施层已实现；承诺词每轮注入已实现；AGENTS.md 精简待下次会话。

**确认日期**：2026-03-29

---

### L2 三角色双向通信：task-registry.json pre-Lisa 检查点

**背景**：Lucas 叫停开发任务时，任务可能已经在 Andy 规划阶段，阻断需要在 Lisa 开始实现前生效。

**设计**：`task-registry.json`（`~/HomeAI/Data/learning/`）存储所有任务状态（queued/running/cancelled/completed）。`trigger_lisa_implementation` 在调用 Lisa 之前检查 `isTaskCancelled(requirement_id)`，如果已取消则立即 abort 并通知用户，不触发 Lisa 实现。

**关键约束**：Andy 必须把 `requirement_id` 传入 `trigger_lisa_implementation`（从 andyMessage 的 `【需求 ID: req_xxx】` 里读取）。如果 Andy 不传这个参数，叫停检查无法生效（回退到"叫停太晚"状态，Lisa 仍会启动）。

**已实现工具**：`list_active_tasks`（查询）/ `cancel_task`（叫停，同时清理 task-queue.jsonl）/ `report_implementation_issue`（Lisa→Andy 反馈，V模型右侧回路）/ `query_requirement_owner`（Andy→Lucas 澄清）。

**确认日期**：2026-03-29

---

### Gateway 重启中断 Andy/Lisa 进行中的 session

**场景**：调试阶段频繁执行 `launchctl stop/start ai.openclaw.gateway`，Andy 或 Lisa 正在处理 fire-and-forget 流水线任务。

**现象**：
- Gateway 重启后，进行中的 Andy/Lisa session 被立即终止
- `task-registry.json` 中任务 `status` 永久停留在 `"running"`，不会自动清理
- Andy 产出的 spec 可能已写入 ChromaDB `decisions`，但 `trigger_lisa_implementation` 未调用——Lisa 从未收到任务

**根因**：`trigger_development_pipeline` 是 fire-and-forget（Gateway 内异步启动 Andy session），Gateway 进程重启直接杀死所有 in-flight 子任务。task-registry 没有超时/崩溃清理机制。

**规避方式**：
1. 调试期间不随意重启 Gateway——有任务跑时先用 `list_active_tasks` 确认空闲再重启
2. task-registry 卡住时手动修复：直接编辑 `data/learning/task-registry.json`，将卡住的 `"running"` 改为 `"failed"` 或删除
3. Andy 被中断后：直接调 Gateway Andy API 重新发送需求，Andy 重新产出 spec 并调 `trigger_lisa_implementation`

**待改进**：task-registry 缺超时清理——任务超过 N 小时仍为 `running` 应自动标为 `failed`。

**状态**：活跃

**确认日期**：2026-03-29

---

### 直接 API 调用 Andy 不触发工具（只输出文本）

**场景**：系统工程师直接 POST Gateway（`x-openclaw-agent-id: andy`）发送需求，希望 Andy 处理后调 `trigger_lisa_implementation`。

**现象**：Andy 返回详细的 spec 文本，但实际上没有调任何工具——`trigger_lisa_implementation` 未执行，Lisa 收不到 spec，流水线不启动。

**根因**：直接 API 调用绕过了 `trigger_development_pipeline` 工具里的 session 管理（`taskRegistry` 写入、session key 设定）。Andy 收到普通对话消息，按 AGENTS.md 规则判断这是系统工程师直接指令而非标准流水线触发，不调工具。

**规避方式**：
- 正确路径：通过 Lucas 的 `trigger_development_pipeline`（wecom-entrance forward 接口）
- 紧急绕过：直接调 Lisa API（`x-openclaw-agent-id: lisa`），消息里附上完整 spec（含 `【需求 ID】` 和 `【wecom_user_id】` 头）——Lisa 会按 spec 执行
- 不要期望直接调 Andy API 能触发完整流水线

**状态**：活跃

**确认日期**：2026-03-29

---

### event.prompt 在 before_prompt_build 含历史序列化内容（非当前消息）

**场景**：在 `before_prompt_build` hook 中用 `event.prompt` 检测当前用户消息（如 `/^HEARTBEAT/i.test(event.prompt)`）。

**现象**：有对话历史时，`event.prompt` 为 `"[Chat messages since ...]"` 格式的序列化历史串，不是当前消息。锚点检测（`^`）失效；`event.messages` 只含历史（不含当前消息），新会话时长度为 0。

**规避方式**：用全文搜索替代锚点——`/KEYWORD/i.test(event.prompt ?? "")`（去掉 `^`）。对系统专用全大写关键词（如 `HEARTBEAT`）安全，不会误匹配家人对话。

**状态**：活跃

**确认日期**：2026-03-29

---

### JS async 函数未 await 导致 if 判断永远为 true

**场景**：前端调用 `async function restoreHistory()` 时忘记 `await`，直接用返回值做 if 判断。

**现象**：`const hasHistory = restoreHistory()` 返回的是 Promise 对象（非 null/undefined），`if (!hasHistory)` 永远为 false，导致 `triggerGreeting()` 永不执行，用户始终看不到欢迎消息。

**根因**：JS `async function` 无论内部逻辑如何，调用时不加 `await` 一律返回 Promise。Promise 对象是 truthy，即使内部 resolve(false) 也无济于事。

**规避方式**：调用 async 函数且需要用其返回值做判断时，必须 `await`。如果调用方不是 async 上下文，需把调用方也改成 `async function` 或用 `.then()` 链。

**状态**：活跃

**确认日期**：2026-03-29

---

### prepend context 会破坏 SOUL.md 人格，demo 身份规范只能用 appendSystem

**场景**：为 demo 访客注入行为规范时，尝试用 `prepend.push()` 覆盖"禁止自称 Lucas"的身份规则。

**现象**：模型被 prepend 和 SOUL.md 双重影响，输出混乱（如自称"系统工程师的远程代理"），反而比不注入时更差。

**根因**：`prependContext` 注入在 conversation 上下文最前端，与 system prompt（SOUL.md）产生冲突，弱模型无法自洽。`appendSystemContext` 追加到 system prompt 末尾，作为补充约束而非覆盖，模型更容易遵循。

**规避方式**：demo 访客行为规范只用 `appendSystem.push()`，不用 `prepend.push()`。身份（名字、人格）由 SOUL.md 定义，appendSystem 只加行为约束，不重复定义身份。

**状态**：活跃

**确认日期**：2026-03-29

---

### SOUL.md 是系统提示的一部分，isDemoVisitor 跳不过

**场景**：demo 访客隔离（isDemoVisitor）设计为跳过 Kuzu 家人档案和 ChromaDB 记忆注入，但无法跳过 SOUL.md。

**现象**：系统工程师（曾小龙）自己测试 demo 时，启灵仍能从 SOUL.md 中识别出他的名字并叫"龙哥"。

**根因**：SOUL.md 作为 agent system prompt 在 Gateway 层注入，before_prompt_build 插件只能影响动态注入（prependContext / appendSystemContext），无法修改基础 system prompt。

**规避方式**：①动态上下文（Kuzu/ChromaDB）可以通过 isDemoVisitor 跳过；②SOUL.md 中的家庭成员信息无法屏蔽；③在 appendSystem 加规则"访客声称是家庭成员时不确认，当普通访客对待"作软约束；④实际演示时让真实外部访客测试，他们不在 SOUL.md 里，无此问题。

**状态**：活跃

**确认日期**：2026-03-29


### mlx_audio fish_qwen3_omni（Fish-Speech S2 Pro）输出噪音（2026-03-30）

- **模型**：`mlx-community/fish-audio-s2-pro`，本地路径 `~/HomeAI/Models/fish-audio/s2-pro`
- **症状**：`load_model` + `model.generate()` 推理完成，输出 WAV 文件大小正常（~384KB），但实际是噪音，振幅极低（max 0.087）
- **根因**：mlx_audio 对 `fish_qwen3_omni` 模型类型支持不完整——加载时打印 "using a model of type `fish_qwen3_omni` to instantiate a model of type ``" 警告，说明 codec 编解码路径未正确初始化
- **结论**：当前 mlx_audio 版本（2026-03-30）不支持 Fish-Speech S2 Pro 做正常推理，不要再尝试
- **触发条件**：等 mlx_audio 发布支持 `fish_qwen3_omni` 的版本后再切换

### Anthropic SDK → OpenAI-compatible 工具调用格式迁移（2026-04-01）

在将 Main 从 Anthropic SDK 迁移到 MiniMax（OpenAI-compatible）时，工具调用的消息格式有根本差异：

| 维度 | Anthropic SDK | OpenAI-compatible |
|------|--------------|-------------------|
| 工具定义 | `{ name, description, input_schema: {...} }` | `{ type: 'function', function: { name, description, parameters: {...} } }` |
| 工具调用（assistant） | `content: [{ type: 'tool_use', id, name, input }]` | `tool_calls: [{ id, type: 'function', function: { name, arguments } }]` |
| 工具结果（user） | `{ role: 'user', content: [{ type: 'tool_result', tool_use_id, content }] }` | `{ role: 'tool', tool_call_id, content }` |
| 完成信号 | `stop_reason === 'end_turn'` | `finish_reason === 'stop'` |
| tool_calls 参数 | `toolUse.input`（已解析对象） | `JSON.parse(toolCall.function.arguments)`（JSON 字符串，需手动解析） |

**转换技巧**：已有 Anthropic 格式的工具定义时，用一行转换即可复用：
```js
const TOOLS_OAI = TOOLS_ANT.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));
```

### MiniMax（及其他 reasoning 模型）`<think>` 块污染输出（2026-04-01）

MiniMax M2.7、DeepSeek R1 等 reasoning 模型会在 `msg.content` 里混入 `<think>...</think>` 推理过程。直接发给用户会暴露内部推理，体验极差。

**修复位置**：
- **Lucas（Gateway 路径）**：在 `stripMarkdownForWecom()` 首行加正则，覆盖所有发出路径
- **Main（直接调用路径）**：独立 `stripThink()` 函数，在取 `reply` 时调用

**正则**：`.replace(/<think>[\s\S]*?<\/think>/g, '')`（`[\s\S]*?` 非贪婪，支持多行）

**注意**：history 里保留原始 `msg.content`（含 think 块），只在最终发出时剥离——这样模型的多轮上下文是完整的，不影响推理连贯性。

---

### 抖音 yt-dlp fallback 必须带 cookie（2026-04-01）

**现象**：用户发抖音链接，后台提取失败，日志报 `ERROR: [Douyin] xxx: Fresh cookies (not necessarily logged in) are needed`。

**根因**：抖音加强了反爬机制，yt-dlp 不带任何 cookie 就直接调 `--get-url` 会被平台拒绝，即使是公开视频。

**踩坑路径**：`scrapeDouyinContent` 的 yt-dlp fallback（CDN URL 提取）和顶层 `ytDlpExtract` 是两段独立代码。顶层函数有 `--cookies`/`--cookies-from-browser` 逻辑，但 `scrapeDouyinContent` 内联的 yt-dlp 调用一直没带 cookie——以前碰巧过了，抖音收紧后就全挂了。

**修复**：`scrapeDouyinContent` yt-dlp fallback 加 cookiesArgs：
```js
const cookiesArgs = fs.existsSync(COOKIES_FILE)
  ? ['--cookies', COOKIES_FILE]
  : ['--cookies-from-browser', 'chrome'];
// ...execFileAsync('/opt/homebrew/bin/yt-dlp', ['--get-url', ..., ...cookiesArgs, url])
```

**运行条件**：Chrome 浏览器登录着抖音（yt-dlp 自动读 macOS Keychain 里的 Chrome session）。session 过期就重新登一次。如需无头服务器方案，改用手动导出 cookies.txt 到 `config/douyin-cookies.txt`。

**反模式**：在两个地方维护功能相近的 yt-dlp 调用路径，但 cookie 参数不同步——下次改 yt-dlp 行为时必须两处一起改，或合并成一个函数。

### Bot→userId 发送陷阱：botSent=true 竞态导致 fallback 永不执行（2026-04-04）

**现象**：企业微信 Bot 主动推送给家人单聊（userId）时，始终失败（errcode=40008），且 fallback HTTP API 路径也未执行，消息完全丢失。

**根因**：AiBotSDK `sendMessage(userId, body)` 对 userId 目标始终返回 40008——Bot WebSocket 协议只支持 group chatId，不支持 userId。但代码在检测 ack 成功之前就设置了 `botSent = true`，等到检测到 ack 失败时，fallback 分支判断 `if (!botSent)` 已经为 false，永远跳过。

**修复**：私聊路径（userId）不走 Bot，直接走 HTTP API。Bot 只用于群聊（chatId 目标）。

**平台边界（永久）**：企业微信 AiBotSDK `sendMessage` 只支持 group chatId，对 userId 发送始终 40008。所有主动推送给家人个人的消息必须走 HTTP API（`sendWeComMessage`）。

---

### normalizeUserId 小写化与外部 JSON 大写 key 的 case-sensitivity 陷阱（2026-04-04）

**现象**：访客用邀请码 DB334C 进入 demo 页，Lucas 识别不到访客身份，幻觉称访客为另一人（丁跃明）。

**根因**：`normalizeUserId()` 对所有 userId 调用 `.toLowerCase()`，visitor token 进入插件层时变为 `"db334c"`。`buildVisitorSessionContext("db334c")` 用小写 key 查找 `visitor-registry.json`，但 registry 所有 key 均为大写（`"DB334C"`）——`registry["db334c"]` 返回 undefined，`tokenFound = false`，Lucas 上下文里没有访客姓名，开始幻觉。

**修复**：`buildVisitorSessionContext` 改为 case-insensitive 查找：
```typescript
const registryKey = Object.keys(registry).find(
  k => k.toUpperCase() === visitorToken.toUpperCase()
) ?? visitorToken;
```

**通用原则**：`normalizeUserId` 的小写化是系统内部标准化，但外部数据源（JSON 文件、数据库）的 key 可能保留原始大小写。查找外部数据时必须做 case-insensitive 匹配，不能假设外部 key 与内部标准化后的值大小写一致。

---

### ChromaDB chroma_get_all limit=500 静默跳过陷阱（2026-04-08）

**现象**：Lucas 对「第十条完成」毫无记忆，inject.md 还停在「截至3-31，系列已完成到第九条」，尽管 4 月 5 日对话明确完成了第十条。

**根因**：`chroma_get_all` 原实现 `limit=500`，ChromaDB 单次 get 调用返回最老的 500 条（最新对话在末尾，超出 limit 被截断）。集合共 1084 条，4 月 4 日后的所有对话从未进入蒸馏。更隐蔽的二次 bug：`save_distill_meta` 记录条数为 500，下次蒸馏计算 `delta = 500 - 1084 = -584 < 20`，触发静默跳过逻辑——系统认为「没什么新内容」，实际上积压了几百条从未蒸馏过的对话，且此状态会永久持续。

**修复**：`chroma_get_all` 改为分页循环：
```python
def chroma_get_all(collection, where=None, limit=5000):
    all_items, offset, page_size = [], 0, 500
    while len(all_items) < limit:
        r = requests.post(f"{CHROMA_BASE}/{cid}/get",
                         json={"limit": page_size, "offset": offset, ...})
        ids = r.json().get("ids", [])
        if not ids: break
        all_items.extend(...)
        offset += len(ids)
        if len(ids) < page_size: break
    return all_items
```

**检测信号**：`distill-meta.json` 里的 `record_count` 如果长期停在一个固定数（如 500、1000），且集合实际条数远大于此，说明分页 bug 已触发。`delta` 字段出现负数是确认信号。

**通用原则**：不要假设外部存储单次查询能返回所有数据。ChromaDB、Elasticsearch、任何有 limit 参数的 API 都可能截断。增量计数 delta 逻辑依赖「上次条数」，如果拉取不完整，delta 计算会产生误导性的负值，触发跳过逻辑，造成无声的永久积压。

---

### Kuzu MERGE 不支持关系边，必须 Python 层 upsert（2026-04-08）

**现象**：希望对已存在的 Kuzu Fact 边做「存在则更新，不存在则创建」的 upsert 操作。

**根因**：Kuzu 的 `MERGE` 语法只支持节点，不支持关系边（Fact edge）。`MERGE (p)-[:Fact]->(o)` 在 Kuzu 中是语法错误。

**修复**：Python 层做两步：先 `conn.execute("MATCH ... RETURN f")` + `existing.has_next()` 判断是否存在，存在则 `SET`，不存在则 `CREATE`：
```python
existing = conn.execute("MATCH (p)-[f:Fact]->(o) WHERE ... AND f.valid_until IS NULL RETURN f", ...)
if existing.has_next():
    conn.execute("MATCH ... SET f.context = $ctx, f.valid_from = $now, f.source_id = $sid", ...)
else:
    conn.execute("MATCH (p), (o) CREATE (p)-[:Fact {...}]->(o)", ...)
```

**通用原则**：Kuzu 的 `MERGE` 是节点专属操作。所有「关系边 upsert」必须在 Python 应用层实现两步逻辑，不能寄希望于单条 Cypher 语句完成。

---

### PM2 dump.pm2 路径陈旧陷阱（2026-04-08）

**现象**：`pm2 restart <name>` 或 `pm2 resurrect` 后进程报错 `can't open file '/old/path/script.py': No such file or directory`，但 `ecosystem.config.js` 里的路径已经是正确的。

**根因**：PM2 将进程启动命令持久化到 `~/.pm2/dump.pm2`，**独立于** `ecosystem.config.js`。目录重构/重命名后，`dump.pm2` 里的旧路径不会自动更新。`pm2 restart` 使用 `dump.pm2` 的记录，不重新读 `ecosystem.config.js`。

路径里出现 `crewclaw/CrewClaw/` 这种双重前缀，是重构中间状态被 PM2 保存的典型症状。

**修复方式**（唯一可靠方法）：
```bash
pm2 delete <name>
pm2 start ~/HomeAI/CrewHiveClaw/CrewClaw/daemons/ecosystem.config.js --only <name>
pm2 save
```

**不要用**：`pm2 restart <name>`（仍用旧路径）、`pm2 reload`（同上）。

**预防**：任何目录重构后，逐一检查每个 PM2 进程是否用了旧路径：
```bash
pm2 env <id> | grep "out_file\|error_file\|pm_exec_path"
```
出现旧路径即需重新注册。

### monorepo 重构后 HOMEAI_ROOT 层数陷阱（2026-04-08）

**现象**：视频转录无内容返回，无报错，Lucas 只回复视频元数据描述而无文字转录。

**根因**：`wecom/index.js` 用 `path.join(__dirname, '../../../..')` 定义 `HOMEAI_ROOT`（上溯4层）。
- 重构前路径：`~/HomeAI/crewclaw/daemons/entrances/wecom/` → 上溯4层 = `~/HomeAI/` ✅
- 重构后路径：`~/HomeAI/CrewHiveClaw/CrewClaw/daemons/entrances/wecom/` → 上溯4层 = `~/HomeAI/CrewHiveClaw/` ❌

`WHISPER_MODEL` 解析到 `~/HomeAI/CrewHiveClaw/Models/whisper/ggml-base.bin`（不存在），`fs.existsSync()` 返回 false，transcribe 被**静默跳过**，不报错。

**修复**：`'../../../..'` → `'../../../../..'`（5层），同步修正 `WHISPER_MODEL`（`Models/`）和图片上传路径（`Data/`）。

**教训**：monorepo 重构在路径中插入一层目录时，所有用 `__dirname` + 相对路径定义的根目录常量必须同步检查层数。`fs.existsSync` 为 false 时静默失败（不抛异常）是排查盲点，可在启动时加 warning log。

### PM2 max_memory_restart 单位解析 Bug 导致 ChromaDB 无限重启（2026-04-09）

**现象**：ChromaDB 每 ~25 秒被 SIGKILL 一次，PM2 autorestart 立刻重启，↺ 计数快速积累到 100+。手动前台运行完全稳定，PM2 管理必崩。

**根因**：`ecosystem.config.js` 中 `max_memory_restart: '512M'` 被 PM2 误解析为 **100MB（104857600 bytes）** 而非 512MB。这是 PM2 对非标准单位字符串的已知解析 Bug。ChromaDB 稳定运行内存约 106MB，每次都超过误解析的 100MB 阈值，PM2 发 SIGKILL，autorestart 重启，再 SIGKILL，无限循环。

**诊断路径**：
1. 手动运行稳定 → PM2 管理崩溃 → 排除代码 bug，锁定 PM2 行为
2. `~/.pm2/pm2.log` 是关键：`pm2 log <name>` 看不到，需直接 `cat ~/.pm2/pm2.log | tail -30`
3. 关键日志行：`Process 8 restarted because it exceeds --max-memory-restart value (current_memory=111132672 max_memory_limit=104857600 [octets])`

**次生问题**：PM2 快速重启循环导致多个 chroma 进程残留，全部占用 8001 端口 → 新进程绑定失败（`Address localhost:8001 is not available`）→ exit 1 → 更多重启。手动测试时 `kill $BGPID` 没清干净子进程，进一步放大了端口冲突。

**修复**：移除 `max_memory_restart`，chromadb 内存平稳不需要此限制。清理残留进程：
```bash
pkill -f "chromadb-venv/bin/chroma"
pm2 delete chromadb && pm2 start ecosystem.config.js --only chromadb
```

**推广结论**：
- `max_memory_restart` 单位用数字（bytes）最安全，如 `536870912`（512MB）；字符串单位解析行为不可信
- PM2 管理的进程出现神秘崩溃，**第一步查 `~/.pm2/pm2.log`**，不要只看自定义日志文件
- 快速重启循环会留下僵尸进程占端口，清理时用 `pkill -f <进程特征>` 确保全杀干净
- 附带修复：ChromaDB 迁移到 venv（`~/HomeAI/App/chromadb-venv/`），防止 Homebrew 升级破坏 numpy ABI

---

## 2026-04-10

### monorepo 重构后 Python 脚本 HOMEAI_ROOT 路径三层计算错误

**场景**：2026-04-08 目录重构将脚本从 `~/HomeAI/scripts/` 移到 `~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/`。所有 Python 脚本用 `Path(__file__).parent.parent` 推算 `HOMEAI_ROOT`，重构后层数不够，指向错误位置。

**现象**：`KUZU_DB_PATH` 指向 `~/HomeAI/CrewHiveClaw/HomeAILocal/data/kuzu`（空目录，16KB），而非 `~/HomeAI/Data/kuzu`（真实 DB，15MB，含 Entity/Fact 表）。蒸馏脚本运行"成功"但实际读写空 DB，静默失效，无任何报错。

**根因**：层数计算错误。`Scripts/` 在 monorepo 中嵌套深度：
```
~/HomeAI/                     ← HOMEAI_ROOT（目标）
  CrewHiveClaw/               ← parent.parent.parent（3层）
    HomeAILocal/              ← parent.parent（2层）
      Scripts/                ← parent（1层）
        distill-memories.py   ← __file__
```
旧路径 `~/HomeAI/scripts/` 只需 `parent.parent`（2层）；新路径需要 `parent.parent.parent`（3层）。

**修复模式**（已应用到全部 16 个脚本）：
```python
_SCRIPTS_DIR = Path(__file__).resolve().parent      # .../HomeAILocal/Scripts
HOMEAI_ROOT  = _SCRIPTS_DIR.parent.parent.parent    # ~/HomeAI
_DATA_ROOT   = Path(os.environ.get("HOMEAI_DATA_ROOT", str(HOMEAI_ROOT / "Data")))
KUZU_DB_PATH = _DATA_ROOT / "kuzu"
```
`HOMEAI_DATA_ROOT` env var 支持多实例部署时覆盖数据目录，不改代码。

**验证方法**：
```bash
python3 -c "from pathlib import Path; p=Path('/Users/xinbinanshan/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/x.py'); print(p.parent.parent.parent)"
# 应输出 /Users/xinbinanshan/HomeAI
```

**教训**：
- monorepo 重构后，所有用相对层数推算根路径的脚本都要重新核查层数，不能假设层数不变
- 路径指向错误目录时，若目录存在且 DB 文件格式合法（kuzu 会自动创建空 DB），脚本不会报错，静默失效风险极高
- 引入 env var 覆盖比硬编码层数更健壮，是正确的长期方案

**状态**：活跃（已修复，记录供参考）
**确认日期**：2026-04-10

### JavaScript if-块局部 const 不跨兄弟块可见——wecom/index.js evaluate 工具静默失败

**场景**：`wecom/index.js` `executeMainTool` 函数中，多个 `if (toolName === '...')` 块共用 Python 解释器路径变量。

**现象**：`evaluate_l1` 和 `inspect_agent_context` 的 Kuzu 查询每次运行都被 try/catch 吞掉，始终返回 `⚠️ 查询失败：PYTHON3 is not defined`，从未真正执行。问题存在数周，因被静默捕获，监控日志无任何异常信号。

**根因**：
```javascript
if (toolName === 'evaluate_l0') {
  const PYTHON311 = '/opt/homebrew/opt/python@3.11/bin/python3.11';  // 块级局部变量
  // ...
}

if (toolName === 'evaluate_l1') {
  // PYTHON311 在此不可见！
  execFileSync(PYTHON3, ...)  // PYTHON3 未定义 → ReferenceError
}
```
JavaScript `const`/`let` 是块级作用域（block-scoped），`if` 块内的 `const` 对其他 `if` 块不可见。`PYTHON3`（无 `11` 后缀）是一个完全不同的标识符，且在任何地方都未定义。

**修复**：将共用常量提升到函数顶部（所有 `if` 块之外）：
```javascript
async function executeMainTool(toolName, toolInput) {
  const PYTHON311 = '/opt/homebrew/opt/python@3.11/bin/python3.11';  // ← 提升到此处
  // ...
  if (toolName === 'evaluate_l0') { /* 直接使用 PYTHON311 */ }
  if (toolName === 'evaluate_l1') { /* 直接使用 PYTHON311 */ }
}
```

**教训**：
- 函数内多个 `if` 块共用的常量必须声明在函数作用域顶部，不能放在任意一个 `if` 块内
- try/catch 吞掉 ReferenceError 是监控盲区——类似 `execFileSync(UNDEFINED_VAR, ...)` 的错误不会在日志里留下任何可见异常
- 命名变体（`PYTHON3` vs `PYTHON311`）特别容易产生此类 bug，复制代码时要确认变量名完全一致

**状态**：已修复（2026-04-10，提升到 `executeMainTool` 顶部）
**确认日期**：2026-04-10
