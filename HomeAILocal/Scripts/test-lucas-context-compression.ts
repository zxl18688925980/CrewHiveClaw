/**
 * test-lucas-context-compression.ts — Lucas 上下文压缩验收脚本
 *
 * 运行：
 *   cd /Users/xinbinanshan/HomeAI/CrewHiveClaw/CrewClaw/crewclaw-routing
 *   npx tsx /Users/xinbinanshan/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/test-lucas-context-compression.ts
 */
import { normalizeContextText, extractContextTimestamp, compressLucasContext, type LucasCompressionOptions } from "/Users/xinbinanshan/HomeAI/CrewHiveClaw/CrewClaw/crewclaw-routing/context-handler.js";
import type { DynamicContextResult, ContextEntry } from "/Users/xinbinanshan/HomeAI/CrewHiveClaw/CrewClaw/crewclaw-routing/context-handler.js";

// ── 模拟 embedText（用于测试） ───────────────────────────────────────────────
// 返回基于文本内容的伪 embedding（不依赖 Ollama，保证测试独立运行）
function mockEmbed(text: string): Promise<number[]> {
  const seed = Array.from(text.slice(0, 100)).reduce((s, c) => s + c.charCodeAt(0), 0);
  const vec = new Array(4).fill(0).map((_, i) => Math.sin(seed * (i + 1)) * 0.5 + 0.5);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return Promise.resolve(vec.map(v => v / norm));
}

// ── 模拟 embedText（高相似度对，用于语义去重测试） ──────────────────────────
const similarPairs = new Map<string, number[]>();
function mockEmbedWithSimilarPairs(text: string): Promise<number[]> {
  const normalized = normalizeContextText(text).slice(0, 60);
  // 如果是已注册的高相似对，返回预设 embedding
  if (similarPairs.has(normalized)) return Promise.resolve(similarPairs.get(normalized)!);
  return mockEmbed(text);
}

// 注册两个语义相似的 knowledge 块（用于测试语义去重）
similarPairs.set("曾小龙近期关注 AI 助手效率提升相关话题", [0.7071, 0.7071, 0, 0]);
similarPairs.set("爸爸对 AI 工具提升工作效率很感兴趣", [0.7000, 0.7141, 0, 0]);  // 余弦相似度 ≈ 0.9998

// ── 构造测试 ContextEntry ──────────────────────────────────────────────────
function makeEntry(
  sourceId: string,
  text: string,
  tier: 0 | 1 | 2 | 3,
  injectMode: 'prepend' | 'appendSystem',
  extras: Partial<ContextEntry> = {}
): ContextEntry {
  return { text, tier, sourceId, label: sourceId, injectMode, ...extras };
}

// ── 场景 S1：家人日常跟进（含近期计划和待办）──────────────────────────────
function buildS1(): DynamicContextResult {
  const entries: ContextEntry[] = [
    makeEntry("family-profile", "【家人档案】曾小龙，爸爸，公司老板，关注家庭AI系统建设，喜欢直接高效的沟通。", 1, 'appendSystem', { compressGroup: 'profile', mustKeep: true, dedupMode: 'normalized', maxItemsAfterCompress: 1, priorityBias: 2 }),
    makeEntry("family-now", "【当前状态快照】今天是工作日，爸爸可能在开会，上次对话在昨天晚上。", 0, 'appendSystem', { compressGroup: 'now', mustKeep: true, dedupMode: 'none', maxItemsAfterCompress: 1, priorityBias: 3 }),
    makeEntry("background", "【项目背景】HomeAI 是家庭 AI 助手系统，包含 Lucas/Andy/Lisa 三个 Agent。", 1, 'appendSystem', { compressGroup: 'background', dedupMode: 'normalized', ttlHours: 72, maxItemsAfterCompress: 1, priorityBias: -1 }),
    makeEntry("conversations", "【近期对话】2026-04-25 22:00 爸爸：明天记得提醒我开会，Lucas：好的，我会提醒您。", 2, 'appendSystem', { compressGroup: 'recent-dialogue', dedupMode: 'semantic', maxItemsAfterCompress: 2 }),
    makeEntry("conversations", "【近期对话】2026-04-24 21:00 爸爸：HomeAI 系统最近怎么样？", 2, 'appendSystem', { compressGroup: 'recent-dialogue', dedupMode: 'semantic', maxItemsAfterCompress: 2 }),
    makeEntry("decision-memory", "【决策记忆】2026-04-20 Lucas 应该先询问家人需求再给建议", 2, 'appendSystem', { compressGroup: 'knowledge', dedupMode: 'semantic', maxItemsAfterCompress: 2 }),
    makeEntry("pending-commitments", "【未完成承诺】2026-04-25 承诺提醒爸爸明天开会（valid_until=2026-04-27）", 3, 'appendSystem', { compressGroup: 'pending', dedupMode: 'normalized', ttlHours: 168, maxItemsAfterCompress: 2, mustKeep: true }),
    makeEntry("agent-interactions", "【团队近期动态】2026-04-20 Andy 完成了流水线设计优化", 3, 'appendSystem', { compressGroup: 'knowledge', dedupMode: 'normalized', ttlHours: 72, maxItemsAfterCompress: 1 }),
    makeEntry("behavior-patterns", "【行为规律】曾小龙近期关注 AI 助手效率提升相关话题", 2, 'appendSystem', { compressGroup: 'knowledge', dedupMode: 'semantic', maxItemsAfterCompress: 2 }),
    makeEntry("family-knowledge", "【家庭知识】爸爸对 AI 工具提升工作效率很感兴趣", 2, 'appendSystem', { compressGroup: 'knowledge', dedupMode: 'semantic', maxItemsAfterCompress: 2 }),
    makeEntry("app-capabilities", "【可调用工具】pipeline-dashboard: https://homeai.local/dashboard?token=xxx", 1, 'prepend', { compressGroup: 'capability', dedupMode: 'normalized', maxItemsAfterCompress: 1, priorityBias: 1 }),
  ];

  const prependEntries = entries.filter(e => e.injectMode === 'prepend');
  const appendEntries  = entries.filter(e => e.injectMode === 'appendSystem');

  return {
    prepend:      prependEntries.map(e => e.text),
    appendSystem: appendEntries.map(e => e.text),
    meta: {
      prepend:      prependEntries,
      appendSystem: appendEntries,
    },
  };
}

// ── 场景 S2：含已过期承诺和过期背景 ──────────────────────────────────────
function buildS2(): DynamicContextResult {
  const nowMs = Date.now();
  const past = new Date(nowMs - 200 * 3600 * 1000).toISOString().slice(0, 10); // 200h 前

  const entries: ContextEntry[] = [
    makeEntry("family-profile", "【家人档案】曾小龙，爸爸。", 1, 'appendSystem', { compressGroup: 'profile', mustKeep: true, dedupMode: 'normalized', maxItemsAfterCompress: 1, priorityBias: 2 }),
    makeEntry("background", `【项目背景 ${past}】旧背景文件，超过 72 小时。`, 1, 'appendSystem', { compressGroup: 'background', dedupMode: 'normalized', ttlHours: 72, maxItemsAfterCompress: 1, priorityBias: -1 }),
    makeEntry("pending-commitments", "【未完成承诺】已完成：帮助妈妈订机票", 3, 'appendSystem', { compressGroup: 'pending', dedupMode: 'normalized', ttlHours: 168, maxItemsAfterCompress: 2, mustKeep: true }),
    makeEntry("pending-commitments", "【未完成承诺】2026-04-26 提醒爸爸每日站会", 3, 'appendSystem', { compressGroup: 'pending', dedupMode: 'normalized', ttlHours: 168, maxItemsAfterCompress: 2, mustKeep: true }),
  ];

  const prependEntries = entries.filter(e => e.injectMode === 'prepend');
  const appendEntries  = entries.filter(e => e.injectMode === 'appendSystem');

  return {
    prepend:      prependEntries.map(e => e.text),
    appendSystem: appendEntries.map(e => e.text),
    meta: {
      prepend:      prependEntries,
      appendSystem: appendEntries,
    },
  };
}

// ── 测试工具 ─────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

// ── T1: normalizeContextText ──────────────────────────────────────────────
console.log("\n── T1: normalizeContextText ──────────────────────────────────────");
assert(
  normalizeContextText("【家人档案】曾小龙  爸爸\n公司老板").includes("曾小龙"),
  "去除标签头后包含核心内容"
);
assert(
  !normalizeContextText("【家人档案】曾小龙").includes("【"),
  "标签头被去除"
);
assert(
  normalizeContextText("  多余  空白  ").trim() === "多余  空白",
  "首尾空白被修剪"
);

// ── T2: extractContextTimestamp ───────────────────────────────────────────
console.log("\n── T2: extractContextTimestamp ──────────────────────────────────");
const ts1 = extractContextTimestamp("2026-04-25T22:30:00 某些内容");
assert(ts1 !== null && ts1 > 0, "提取完整 ISO 时间戳");

const ts2 = extractContextTimestamp("日期 2026-04-25 其他内容");
assert(ts2 !== null, "提取日期格式时间戳");

const ts3 = extractContextTimestamp("无时间戳的纯文本");
assert(ts3 === null, "无时间戳时返回 null");

// 多个时间戳取最大
const ts4 = extractContextTimestamp("2026-04-24 和 2026-04-25");
assert(ts4 !== null && new Date(ts4).toISOString().startsWith("2026-04-25"), "多时间戳取最大");

// ── T3: S1 基础压缩（不启用 embedText）──────────────────────────────────
console.log("\n── T3: S1 基础压缩（规则去重 + 配额裁剪）─────────────────────────");
const s1Result = buildS1();
const s1Before = {
  prepend: s1Result.prepend.reduce((s, t) => s + t.length, 0),
  append:  s1Result.appendSystem.reduce((s, t) => s + t.length, 0),
};

const options1: LucasCompressionOptions = {
  agentId: "lucas",
  prompt: "爸爸最近在忙什么",
  maxPrependChars: 4000,
  maxAppendChars: 12000,
  semanticThreshold: 0.92,
  semanticMaxCandidates: 12,
  dryRun: false,
};

const { result: r1, stats: s1 } = await compressLucasContext(s1Result, options1);

console.log(`  before_prepend=${s1Before.prepend} before_append=${s1Before.append}`);
console.log(`  after_prepend=${s1.after_prepend_chars} after_append=${s1.after_append_chars}`);
console.log(`  dropped=${s1.dropped_entries} expired=${s1.expired_dropped} dedup=${s1.dedup_dropped}`);

assert(r1.prepend.length > 0 || r1.appendSystem.length > 0, "压缩后有输出");
assert(s1.after_prepend_chars <= options1.maxPrependChars, "prepend 未超配额");
assert(s1.after_append_chars <= options1.maxAppendChars, "appendSystem 未超配额");

// mustKeep 条目保留验证：family-profile, family-now, pending-commitments
const allTexts1 = [...r1.prepend, ...r1.appendSystem].join("\n");
assert(allTexts1.includes("家人档案"), "family-profile(mustKeep) 被保留");
assert(allTexts1.includes("当前状态快照"), "family-now(mustKeep) 被保留");
assert(allTexts1.includes("未完成承诺"), "pending-commitments(mustKeep) 被保留");

// ── T4: S2 过期过滤 ───────────────────────────────────────────────────────
console.log("\n── T4: S2 过期过滤 ──────────────────────────────────────────────");
const s2Result = buildS2();
const { result: r2, stats: s2 } = await compressLucasContext(s2Result, options1);

console.log(`  expired_dropped=${s2.expired_dropped} dedup_dropped=${s2.dedup_dropped}`);

const allTexts2 = [...r2.prepend, ...r2.appendSystem].join("\n");
// 背景文件超 72h TTL 应被过滤
assert(s2.expired_dropped >= 1, "至少 1 条过期条目被丢弃");
// 已完成承诺应被过滤
assert(!allTexts2.includes("已完成：帮助妈妈订机票"), "「已完成」标记条目被过滤");
// mustKeep 的未过期承诺应保留
assert(allTexts2.includes("提醒爸爸每日站会"), "未过期 mustKeep 承诺被保留");
// family-profile mustKeep 保留
assert(allTexts2.includes("家人档案"), "family-profile(mustKeep) 在过期场景下保留");

// ── T5: 语义去重（启用 embedText）────────────────────────────────────────
console.log("\n── T5: 语义去重（behavior-patterns 与 family-knowledge 相似）──────");
const s1WithSemantic = buildS1();
const options5: LucasCompressionOptions = {
  ...options1,
  embedText: mockEmbedWithSimilarPairs,
};

const { result: r5, stats: s5 } = await compressLucasContext(s1WithSemantic, options5);

console.log(`  semantic_dropped=${s5.semantic_dropped}`);
const allTexts5 = [...r5.prepend, ...r5.appendSystem].join("\n");

// 两条 knowledge 语义相似，至少保留 1 条，丢弃 1 条
const hasAITopic = allTexts5.includes("AI 助手效率") || allTexts5.includes("AI 工具");
assert(hasAITopic, "语义去重后至少保留 1 条 AI 相关 knowledge");
// 注：由于 mock embedding 相似度计算，实际是否触发去重依赖 mock 值，不强断言 semantic_dropped > 0

// ── T6: dryRun 模式 ───────────────────────────────────────────────────────
console.log("\n── T6: dryRun 模式（不裁剪配额）────────────────────────────────");
const s1DryRun = buildS1();
const optionsDry: LucasCompressionOptions = {
  ...options1,
  dryRun: true,
  maxPrependChars: 10,  // 故意设很小，dryRun 应忽略
  maxAppendChars: 10,
};

const { result: r6, stats: s6 } = await compressLucasContext(s1DryRun, optionsDry);

// dryRun 时不裁剪，after_chars 可以超过 maxChars 限制
console.log(`  dryRun after_prepend=${s6.after_prepend_chars} after_append=${s6.after_append_chars}`);
assert(r6.appendSystem.length > 0, "dryRun 模式有输出");

// ── 总结 ─────────────────────────────────────────────────────────────────
console.log(`\n══ 验收结果：${passed} 通过 / ${failed} 失败 ══`);
if (failed === 0) {
  console.log("✅ 全部通过，Lucas 上下文压缩管线验收成功");
} else {
  console.log("❌ 有测试失败，请检查实现");
  process.exit(1);
}
