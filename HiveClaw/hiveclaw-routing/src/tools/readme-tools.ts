/**
 * Readme 大师工具集
 *
 * search_readme_examples / get_design_principle / search_antipatterns
 * generate_readme_draft / refine_section / add_readme_sample / add_antipattern
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { ReadmeIntakeForm, ReadmeSample, AntiPattern, OrgType } from "../types.js";

// ─── 知识库路径约定 ───────────────────────────────────────────────────────────

function kbPaths(kbRoot: string) {
  return {
    samples:      join(kbRoot, "samples.jsonl"),
    antipatterns: join(kbRoot, "antipatterns.jsonl"),
    principles:   join(kbRoot, "principles.md"),
    qa_history:   join(kbRoot, "qa-history.jsonl"),
  };
}

// ─── 知识库读取 ──────────────────────────────────────────────────────────────

function loadSamples(kbRoot: string): ReadmeSample[] {
  const path = kbPaths(kbRoot).samples;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ReadmeSample);
}

function loadAntiPatterns(kbRoot: string): AntiPattern[] {
  const path = kbPaths(kbRoot).antipatterns;
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as AntiPattern);
}

// ─── 工具实现 ────────────────────────────────────────────────────────────────

/**
 * search_readme_examples：检索知识库中相似实例的 Readme 摘要。
 *
 * 检索逻辑（Dry Run 阶段用简单关键词匹配，上线后换语义检索）：
 * 1. 优先 org_type 匹配
 * 2. 其次 scenarios 关键词重叠
 */
export function searchReadmeExamples(params: {
  org_type: OrgType;
  scenarios: string[];
  kb_root: string;
  top_k?: number;
}): ReadmeSample[] {
  const { org_type, scenarios, kb_root, top_k = 3 } = params;
  const samples = loadSamples(kb_root);

  const scored = samples.map((s) => {
    let score = 0;
    if (s.org_type === org_type) score += 10;
    for (const sc of scenarios) {
      for (const ss of s.scenarios) {
        if (ss.includes(sc) || sc.includes(ss)) score += 1;
      }
    }
    return { sample: s, score };
  });

  return scored
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, top_k)
    .map((x) => x.sample);
}

/**
 * get_design_principle：从 principles.md 检索设计原则。
 * 关键词匹配相关段落，返回原文片段。
 */
export function getDesignPrinciple(params: {
  topic: string;
  kb_root: string;
}): string {
  const path = kbPaths(params.kb_root).principles;
  if (!existsSync(path)) return "设计原则文档尚未初始化";

  const content = readFileSync(path, "utf8");
  const topic = params.topic.toLowerCase();

  // 按段落（## 标题）切分，返回包含关键词的段落
  const sections = content.split(/^## /m).filter(Boolean);
  const matched = sections.filter((s) => s.toLowerCase().includes(topic));

  if (matched.length === 0) return `未找到与「${params.topic}」相关的设计原则`;
  return matched.map((s) => `## ${s.trim()}`).join("\n\n---\n\n");
}

/**
 * search_antipatterns：检索已知的反模式。
 */
export function searchAntipatterns(params: {
  scenario: string;
  kb_root: string;
}): AntiPattern[] {
  const antipatterns = loadAntiPatterns(params.kb_root);
  const kw = params.scenario.toLowerCase();
  return antipatterns.filter(
    (a) => a.scenario.toLowerCase().includes(kw) || a.mistake.toLowerCase().includes(kw),
  );
}

/**
 * generate_readme_draft：根据 Intake 问卷生成 Readme 初稿。
 *
 * 流程：
 * 1. 从知识库检索最相似的已有实例作为结构参考
 * 2. 按 intake_form 信息填充骨架
 * 3. 返回 Markdown 初稿
 *
 * Dry Run：返回结构骨架 + 填充说明，不调用 LLM。
 * 上线后：调用 Readme大师 Agent 的 Gateway endpoint 生成完整文稿。
 */
export function generateReadmeDraft(params: {
  intake_form: ReadmeIntakeForm;
  kb_root: string;
}): string {
  const { intake_form, kb_root } = params;
  const examples = searchReadmeExamples({
    org_type: intake_form.org_type,
    scenarios: intake_form.core_scenarios,
    kb_root,
    top_k: 1,
  });

  const referenceNote = examples.length > 0
    ? `> 参考实例：与本组织 org_type=${intake_form.org_type} 类似的已有部署\n\n`
    : `> 注：暂无同类实例参考，基于框架标准结构生成\n\n`;

  // Dry Run：生成结构占位骨架
  return [
    `# [组织名] HomeAI Readme`,
    ``,
    referenceNote,
    `## 这是什么`,
    ``,
    `[基于以下信息填充：org_type=${intake_form.org_type}，${intake_form.member_count}人团队，`,
    `核心场景：${intake_form.core_scenarios.join("、")}]`,
    ``,
    `## 角色设计`,
    ``,
    `### Lucas（前台联络官）`,
    `[根据 channel=${intake_form.channel} 和成员角色 ${intake_form.member_roles.join("、")} 定制]`,
    ``,
    `### Andy（方案设计师）`,
    `[标准框架设计，根据组织核心场景调整 spec 侧重]`,
    ``,
    `### Lisa（开发工程师）`,
    `[标准框架设计]`,
    ``,
    `### 系统工程师`,
    `[根据 ai_maturity=${intake_form.ai_maturity} 调整启动引导内容]`,
    ``,
    `## 能力边界`,
    ``,
    `[根据 ai_maturity 建议 L2 优先覆盖范围，L3/L4 推迟时机]`,
    ``,
    `## 特殊约束`,
    ``,
    intake_form.special_constraints.length > 0
      ? intake_form.special_constraints.map((c) => `- ${c}`).join("\n")
      : `（无特殊约束）`,
    ``,
    `---`,
    ``,
    `> [!NOTE] 这是 Dry Run 生成的结构骨架。上线后由 Readme大师 Agent 调用 LLM 填充完整内容。`,
  ].join("\n");
}

/**
 * refine_section：按 SE 反馈精化指定章节，不全量重生成。
 * Dry Run：返回修改建议而非直接重写。
 */
export function refineSection(params: {
  section: string;
  feedback: string;
  current_content: string;
  kb_root: string;
}): string {
  // TODO: 调用 Readme大师 Agent Gateway endpoint，传入 section + feedback + current_content
  // Dry Run：返回修改建议
  return [
    `## 精化建议（Dry Run）`,
    ``,
    `**章节**：${params.section}`,
    `**反馈**：${params.feedback}`,
    ``,
    `上线后，Readme大师将基于以上反馈直接修改章节内容。`,
    `当前 Dry Run 阶段，请系统工程师参考框架设计原则手动修改。`,
    ``,
    `相关反模式检查：`,
    ...searchAntipatterns({ scenario: params.section, kb_root: params.kb_root })
      .map((a) => `- ⚠️ ${a.mistake} → ${a.fix}`),
  ].join("\n");
}

// ─── 知识库维护（HiveClaw SE 专用）────────────────────────────────────────────

/**
 * add_readme_sample：新增去标识化实例样本。
 */
export function addReadmeSample(params: {
  sample: Omit<ReadmeSample, "id" | "verified_at">;
  kb_root: string;
}): ReadmeSample {
  const record: ReadmeSample = {
    ...params.sample,
    id: crypto.randomUUID(),
    verified_at: new Date().toISOString(),
  };
  const path = kbPaths(params.kb_root).samples;
  writeFileSync(path, (existsSync(path) ? readFileSync(path, "utf8") : "") + JSON.stringify(record) + "\n");
  return record;
}

/**
 * add_antipattern：追加反模式条目。
 */
export function addAntiPattern(params: {
  scenario: string;
  mistake: string;
  fix: string;
  source_instance_type: OrgType;
  kb_root: string;
}): AntiPattern {
  const record: AntiPattern = {
    id: crypto.randomUUID(),
    scenario: params.scenario,
    mistake: params.mistake,
    fix: params.fix,
    source_instance_type: params.source_instance_type,
    added_at: new Date().toISOString(),
  };
  const path = kbPaths(params.kb_root).antipatterns;
  writeFileSync(path, (existsSync(path) ? readFileSync(path, "utf8") : "") + JSON.stringify(record) + "\n");
  return record;
}
