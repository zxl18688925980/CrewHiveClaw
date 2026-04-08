---
name: best-practice-evaluation
description: 提出方案前的生态优先检查：先查 OpenClaw Skills 和 Clawhub 生态，确认无现成方案再设计新实现，避免重复造轮子。
---

# Skill：方案前生态优先检查

**适用场景**：每次 Andy 准备给出 Implementation Spec 之前，先过一遍此清单。

---

## 为什么要先查生态

HomeAI 运行在 OpenClaw 平台上，OpenClaw 生态（Clawhub）有大量已有 Skill 和工具。
跳过生态直接让 Lisa 实现，等于用 2 小时做本来 5 分钟能装好的事。
**生态检查不是可选步骤，是出方案前的强制前置。**

---

## 检查步骤（按顺序）

### 第 ① 步：查本地已有 Skill

```bash
openclaw skills list
```

逐条过需求关键词，判断是否有 `ready` 状态的 Skill 直接覆盖。

- 有覆盖 → 在 spec 中注明直接调用该 Skill，不需要 Lisa 重新实现
- 无覆盖 → 继续第 ② 步

### 第 ② 步：搜索 Clawhub 生态

```bash
clawhub search <需求关键词>
```

判断标准：**评分 > 1.5 且功能吻合** → 优先使用，spec 中注明 `clawhub install <slug>`。

- 有合适插件 → 在 spec 中注明安装路径，Lisa 执行 install 即可
- 无合适插件 → 继续第 ③ 步

### 第 ③ 步：确认自定义实现必要性

只有前两步都没有覆盖，才进入完整 spec 设计流程。

在 spec 开头加一行说明为什么不用现有生态：
> 「已查 OpenClaw skills list（无覆盖）和 clawhub search（无合适结果），需要自定义实现。」

---

## 快速判断原则

| 情况 | 结论 |
|------|------|
| 现有 Skill 功能完全匹配 | 直接调用，不新建 |
| 现有 Skill 部分匹配 | 评估是否 fork/扩展，而非从头写 |
| Clawhub 有类似工具但功能不完全匹配 | 优先评估能否适配，再考虑自研 |
| 需求完全独特（HomeAI 家庭专属逻辑） | 自定义实现，正常出 spec |

---

## 注意

- **不要跳过这两步直接出 spec**：即使 Andy 觉得「这个需求很独特」，也要过一遍，哪怕只花 1 分钟
- **生态检查结果写进 spec**：让 Lucas 和系统工程师知道做了这步，增加透明度
- **Co-Pilot 体验进化**：若用户反映界面摩擦（找不到功能、链接发错、操作步骤繁琐），这类隐式信号也属于「已有生态未被正确使用」的范畴，flag_for_skill 记录后由 Andy 在 HEARTBEAT 中评估
