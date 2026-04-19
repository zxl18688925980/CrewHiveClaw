/**
 * hiveclaw-routing 云端大师插件
 *
 * 职责：为 HiveClaw 云端四个大师（Lucas/Andy/Lisa/Readme）注册工具集。
 *
 * 与 crewclaw-routing 的核心差异：
 * - 无 before_model_resolve（大师本身就是模型服务，不需要路由）
 * - 无 before_prompt_build ChromaDB 注入（大师有独立的知识库机制）
 * - 工具按大师角色门控：语料/训练/版本工具 → lucas/andy/lisa 大师
 *                        Readme 工具 → readme 大师
 *
 * 所有工具在 Dry Run 阶段编译通过，但实际执行会抛出 "not yet implemented" 错误。
 * 等云端基础设施就绪后逐步替换 stub 实现。
 */

import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import {
  corpusIntake,
  corpusDedup,
  corpusClassify,
  corpusQualityFilter,
  corpusBalanceCheck,
} from "./src/tools/corpus-tools.js";

import {
  checkTrainingQueue,
  submitTrainingJob,
  getJobStatus,
} from "./src/tools/training-tools.js";

import {
  listModelVersions,
  startCanary,
  promoteVersion,
  rollbackVersion,
  runEval,
  compareVersions,
} from "./src/tools/version-tools.js";

import {
  searchReadmeExamples,
  getDesignPrinciple,
  searchAntipatterns,
  generateReadmeDraft,
  refineSection,
  addReadmeSample,
  addAntiPattern,
} from "./src/tools/readme-tools.js";

import {
  SiliconFlowAdapter,
  VolcengineAdapter,
  TogetherAdapter,
  ComputeScheduler,
} from "./src/compute-adapter.js";

import type { MasterRole, OrgType } from "./src/types.js";

// ─── 配置 ────────────────────────────────────────────────────────────────────

const STORAGE_ROOT      = process.env.HIVECLAW_STORAGE_ROOT    || "/data/hiveclaw";
const KB_ROOT           = process.env.HIVECLAW_KB_ROOT         || "/data/hiveclaw/readme-kb";
const EVAL_SET_PATH     = process.env.HIVECLAW_EVAL_SET_PATH   || "/data/hiveclaw/eval-sets";
const COMPUTE_PROVIDER  = process.env.HIVECLAW_COMPUTE_PROVIDER || "siliconflow";

// 大师角色 ID（OpenClaw workspace 目录名对应）
const LUCAS_MASTER_ID  = "lucas-master";
const ANDY_MASTER_ID   = "andy-master";
const LISA_MASTER_ID   = "lisa-master";
const README_MASTER_ID = "readme-master";

const MASTER_ROLES = new Set([LUCAS_MASTER_ID, ANDY_MASTER_ID, LISA_MASTER_ID]);
const ALL_MASTERS  = new Set([...MASTER_ROLES, README_MASTER_ID]);

// ─── 算力调度器初始化 ────────────────────────────────────────────────────────

const scheduler = new ComputeScheduler([
  new SiliconFlowAdapter(process.env.SILICONFLOW_API_KEY || ""),
  new VolcengineAdapter(process.env.VOLCENGINE_API_KEY   || ""),
  new TogetherAdapter(process.env.TOGETHER_API_KEY       || ""),
]);

// ─── 工具门控辅助 ────────────────────────────────────────────────────────────

function isMasterAgent(agentId: string | undefined): boolean {
  return !!agentId && MASTER_ROLES.has(agentId);
}

function isReadmeMaster(agentId: string | undefined): boolean {
  return agentId === README_MASTER_ID;
}

function masterRoleFromAgentId(agentId: string): MasterRole {
  if (agentId === LUCAS_MASTER_ID) return "lucas";
  if (agentId === ANDY_MASTER_ID)  return "andy";
  if (agentId === LISA_MASTER_ID)  return "lisa";
  throw new Error(`Unknown master agent: ${agentId}`);
}

function dryRunError(toolName: string, detail?: string): AgentToolResult<Record<string, unknown>> {
  return {
    result: {
      error: `${toolName}: ${detail ?? "not yet implemented (Dry Run)"}`,
    },
  };
}

// ─── 插件定义 ────────────────────────────────────────────────────────────────

const hiveclawRoutingPlugin = {
  id: "hiveclaw-routing",
  name: "HiveClaw 云端大师插件",
  description: "语料管理 · 训练调度 · 版本管理 · Readme 生成协议",

  register(api: OpenClawPluginApi) {

    // ━━ 语料管理工具（lucas/andy/lisa 大师可用）━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    api.registerTool((toolCtx) => ({
      label: "接收语料批次",
      name: "corpus_intake",
      description: [
        "接收来自本地 CrewClaw 实例上传的语料批次，运行格式校验和实例配额检查。",
        "通过校验的条目写入暂存区，等待去重和分类。",
        "质量分低于当前版本阈值、格式不完整的条目将被拒绝并返回原因。",
      ].join("\n"),
      parameters: Type.Object({
        batch: Type.Array(Type.Object({
          role:          Type.String(),
          type:          Type.String(),
          instance_id:   Type.String(),
          content:       Type.Object({
            prompt:   Type.String(),
            chosen:   Type.Optional(Type.String()),
            rejected: Type.Optional(Type.String()),
            output:   Type.Optional(Type.String()),
          }),
          tags:          Type.Array(Type.String()),
          quality_score: Type.Number(),
          uploaded_at:   Type.String(),
        })),
        master_version_seq: Type.Number({ description: "当前大师版本序号，用于计算质量阈值" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        if (!isMasterAgent(toolCtx.agentId)) {
          return dryRunError("corpus_intake", "仅 lucas/andy/lisa 大师可调用");
        }
        try {
          const role = masterRoleFromAgentId(toolCtx.agentId!);
          const result = await corpusIntake({
            batch: params.batch as Parameters<typeof corpusIntake>[0]["batch"],
            instance_id: params.batch[0]?.instance_id ?? "unknown",
            master_version_seq: params.master_version_seq,
            storage_root: STORAGE_ROOT,
          });
          return { result: { ...result } };
        } catch (err) {
          return dryRunError("corpus_intake", String(err));
        }
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "语料语义去重",
      name: "corpus_dedup",
      description: "对暂存区语料进行语义去重。同实例内相似度>0.92合并；跨实例保留（多样性）。",
      parameters: Type.Object({
        role: Type.String({ description: "lucas | andy | lisa" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await corpusDedup({ role: params.role as MasterRole, storage_root: STORAGE_ROOT });
          return { result: { ...result } };
        } catch (err) {
          return dryRunError("corpus_dedup", String(err));
        }
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "语料行为分类",
      name: "corpus_classify",
      description: "对暂存区语料按行为类型分类打标，验证 tags 合法性，无标签条目自动分类。",
      parameters: Type.Object({
        role: Type.String(),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await corpusClassify({ role: params.role as MasterRole, storage_root: STORAGE_ROOT });
          return { result: { ...result } };
        } catch (err) {
          return dryRunError("corpus_classify", String(err));
        }
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "语料质量过滤",
      name: "corpus_quality_filter",
      description: "按当前版本质量阈值过滤语料，低于阈值的降级为 pattern 或 archive。",
      parameters: Type.Object({
        role:      Type.String(),
        min_score: Type.Number({ description: "质量阈值，通常由 computeQualityThreshold(version) 提供" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await corpusQualityFilter({
            role: params.role as MasterRole,
            min_score: params.min_score,
            storage_root: STORAGE_ROOT,
          });
          return { result: { ...result } };
        } catch (err) {
          return dryRunError("corpus_quality_filter", String(err));
        }
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "检查语料平衡",
      name: "corpus_balance_check",
      description: "检查行为类型分布是否平衡，输出过度集中和稀缺告警。",
      parameters: Type.Object({
        role: Type.String(),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await corpusBalanceCheck({ role: params.role as MasterRole, storage_root: STORAGE_ROOT });
          return { result: result as unknown as Record<string, unknown> };
        } catch (err) {
          return dryRunError("corpus_balance_check", String(err));
        }
      },
    }));

    // ━━ 训练管理工具（lucas/andy/lisa 大师可用）━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    api.registerTool((_toolCtx) => ({
      label: "查看训练队列",
      name: "check_training_queue",
      description: "查看当前训练等待队列状态，以及是否满足自动触发条件（≥200 DPO + ≥14天）。",
      parameters: Type.Object({
        role: Type.String(),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await checkTrainingQueue({ role: params.role as MasterRole, storage_root: STORAGE_ROOT });
          return { result: result as unknown as Record<string, unknown> };
        } catch (err) {
          return dryRunError("check_training_queue", String(err));
        }
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "提交训练任务",
      name: "submit_training_job",
      description: [
        "满足触发条件时，打包训练数据集（新增语料85% + 历史重放15%）并提交算力调度。",
        "训练集基于当前 active 版本权重继续训练，不从基础模型重头开始。",
        "基础模型切换是例外事件（需 SE 授权），不在此工具范围内。",
      ].join("\n"),
      parameters: Type.Object({
        role:                Type.String(),
        base_model_id:       Type.String({ description: "如 qwen3-72b-chat，通常从当前 active 版本元数据读取" }),
        compute_budget_usd:  Type.Number(),
        deadline_hours:      Type.Number({ description: "最晚完成时间（小时），影响算力路由选择" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await submitTrainingJob(
            {
              role: params.role as MasterRole,
              base_model_id: params.base_model_id,
              storage_root: STORAGE_ROOT,
              compute_budget_usd: params.compute_budget_usd,
              deadline_hours: params.deadline_hours,
            },
            scheduler,
          );
          return { result: result as unknown as Record<string, unknown> };
        } catch (err) {
          return dryRunError("submit_training_job", String(err));
        }
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "查询训练进度",
      name: "get_job_status",
      description: "查询指定训练任务的当前进度（queued/running/completed/failed）。",
      parameters: Type.Object({
        job_id: Type.String(),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await getJobStatus({ job_id: params.job_id, storage_root: STORAGE_ROOT });
          return { result: result as unknown as Record<string, unknown> };
        } catch (err) {
          return dryRunError("get_job_status", String(err));
        }
      },
    }));

    // ━━ 版本管理工具（lucas/andy/lisa 大师可用）━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    api.registerTool((_toolCtx) => ({
      label: "列出模型版本",
      name: "list_model_versions",
      description: "列出指定角色的所有模型版本及其状态（active/shadow/retired/rollback_target）。",
      parameters: Type.Object({ role: Type.String() }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await listModelVersions({ role: params.role as MasterRole, storage_root: STORAGE_ROOT });
          return { result: { versions: result } };
        } catch (err) {
          return dryRunError("list_model_versions", String(err));
        }
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "启动金丝雀测试",
      name: "start_canary",
      description: [
        "训练完成后，将 shadow 版本开始承接真实流量（建议从 10% 开始）。",
        "Canary 阶段最少持续 2h，样本量 ≥ 100 条，任意维度下降 > 5% 触发自动回滚。",
      ].join("\n"),
      parameters: Type.Object({
        role:    Type.String(),
        version: Type.String({ description: "shadow 版本号，如 2026Q2.003" }),
        pct:     Type.Number({ description: "流量百分比，建议 10，最大 50" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await startCanary({
            role: params.role as MasterRole,
            version: params.version,
            pct: params.pct,
            storage_root: STORAGE_ROOT,
          });
          return { result: result as unknown as Record<string, unknown> };
        } catch (err) {
          return dryRunError("start_canary", String(err));
        }
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "晋升版本为 active",
      name: "promote_version",
      description: "Canary 评估通过后，将 shadow 版本晋升为 active，原 active 保留 48h 作为回滚备份。",
      parameters: Type.Object({
        role:    Type.String(),
        version: Type.String(),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await promoteVersion({ role: params.role as MasterRole, version: params.version, storage_root: STORAGE_ROOT });
          return { result: result as unknown as Record<string, unknown> };
        } catch (err) {
          return dryRunError("promote_version", String(err));
        }
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "回滚版本",
      name: "rollback_version",
      description: "将 active 版本回滚到指定历史版本（仅限 rollback_target 或近 3 个历史版本）。",
      parameters: Type.Object({
        role:    Type.String(),
        version: Type.String({ description: "目标回滚版本号" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await rollbackVersion({ role: params.role as MasterRole, version: params.version, storage_root: STORAGE_ROOT });
          return { result: result as unknown as Record<string, unknown> };
        } catch (err) {
          return dryRunError("rollback_version", String(err));
        }
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "运行版本评估",
      name: "run_eval",
      description: "在固定 Canary 评估集（500条/角色，永不用于训练）上运行指标评估。",
      parameters: Type.Object({
        role:    Type.String(),
        version: Type.String(),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await runEval({
            role: params.role as MasterRole,
            version: params.version,
            eval_set_path: EVAL_SET_PATH,
            storage_root: STORAGE_ROOT,
          });
          return { result: result as unknown as Record<string, unknown> };
        } catch (err) {
          return dryRunError("run_eval", String(err));
        }
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "对比两个版本",
      name: "compare_versions",
      description: "对比两个版本的评估分数，检测是否存在超过 5% 的质量回退。",
      parameters: Type.Object({
        role: Type.String(),
        v1:   Type.String(),
        v2:   Type.String(),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        try {
          const result = await compareVersions({ role: params.role as MasterRole, v1: params.v1, v2: params.v2, storage_root: STORAGE_ROOT });
          return { result: result as unknown as Record<string, unknown> };
        } catch (err) {
          return dryRunError("compare_versions", String(err));
        }
      },
    }));

    // ━━ Readme 大师工具（readme-master 专用）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    api.registerTool((toolCtx) => ({
      label: "检索 Readme 样例",
      name: "search_readme_examples",
      description: "从知识库检索同类型组织的 Readme 结构摘要，作为生成初稿的参考。",
      parameters: Type.Object({
        org_type:  Type.String({ description: "family | company | team" }),
        scenarios: Type.Array(Type.String(), { description: "核心使用场景关键词" }),
        top_k:     Type.Optional(Type.Number()),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const results = searchReadmeExamples({
          org_type: params.org_type as OrgType,
          scenarios: params.scenarios,
          kb_root: KB_ROOT,
          top_k: params.top_k,
        });
        return { result: { samples: results } };
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "查询框架设计原则",
      name: "get_design_principle",
      description: "查询 CrewHiveClaw 框架的设计原则，如 L2/L3 边界、SOUL.md vs AGENTS.md 的区别等。",
      parameters: Type.Object({
        topic: Type.String({ description: "如 \"L3 L4 边界\"、\"SOUL.md\"、\"行为规则\"" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const result = getDesignPrinciple({ topic: params.topic, kb_root: KB_ROOT });
        return { result: { content: result } };
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "检索反模式",
      name: "search_antipatterns",
      description: "检索已知的 Readme 设计错误（反模式库），避免重蹈覆辙。",
      parameters: Type.Object({
        scenario: Type.String({ description: "场景关键词，如 \"Lucas 角色设计\"" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const results = searchAntipatterns({ scenario: params.scenario, kb_root: KB_ROOT });
        return { result: { antipatterns: results } };
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "生成 Readme 初稿",
      name: "generate_readme_draft",
      description: [
        "根据 SE 填写的 Intake 问卷生成定制化 Readme 初稿。",
        "Dry Run 阶段返回结构骨架，上线后调用 LLM 生成完整内容。",
      ].join("\n"),
      parameters: Type.Object({
        intake_form: Type.Object({
          org_type:           Type.String(),
          member_count:       Type.Number(),
          member_roles:       Type.Array(Type.String()),
          core_scenarios:     Type.Array(Type.String()),
          channel:            Type.String(),
          ai_maturity:        Type.String(),
          special_constraints: Type.Array(Type.String()),
        }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const result = generateReadmeDraft({
          intake_form: params.intake_form as Parameters<typeof generateReadmeDraft>[0]["intake_form"],
          kb_root: KB_ROOT,
        });
        return { result: { draft: result } };
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "精化 Readme 章节",
      name: "refine_section",
      description: "根据 SE 反馈精化 Readme 中的指定章节，不全量重生成。",
      parameters: Type.Object({
        section:         Type.String({ description: "章节名称，如 \"Lucas 角色设计\"" }),
        feedback:        Type.String({ description: "SE 的修改要求" }),
        current_content: Type.String({ description: "章节当前内容" }),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const result = refineSection({
          section: params.section,
          feedback: params.feedback,
          current_content: params.current_content,
          kb_root: KB_ROOT,
        });
        return { result: { refined: result } };
      },
    }));

    // ━━ 知识库维护工具（HiveClaw SE 管理接口）━━━━━━━━━━━━━━━━━━━━━━━━━━━━

    api.registerTool((_toolCtx) => ({
      label: "新增 Readme 样本",
      name: "add_readme_sample",
      description: "（HiveClaw SE 专用）将新实例验收后的去标识化 Readme 入库。",
      parameters: Type.Object({
        org_type:         Type.String(),
        scenarios:        Type.Array(Type.String()),
        summary:          Type.String(),
        structure_summary: Type.Array(Type.String()),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const result = addReadmeSample({
          sample: {
            org_type: params.org_type as OrgType,
            scenarios: params.scenarios,
            summary: params.summary,
            structure_summary: params.structure_summary,
          },
          kb_root: KB_ROOT,
        });
        return { result: result as unknown as Record<string, unknown> };
      },
    }));

    api.registerTool((_toolCtx) => ({
      label: "追加反模式",
      name: "add_antipattern",
      description: "（HiveClaw SE 专用）记录一个新发现的 Readme 设计错误到反模式库。",
      parameters: Type.Object({
        scenario:             Type.String(),
        mistake:              Type.String(),
        fix:                  Type.String(),
        source_instance_type: Type.String(),
      }),
      execute: async (_id, params): Promise<AgentToolResult<Record<string, unknown>>> => {
        const result = addAntiPattern({
          scenario: params.scenario,
          mistake: params.mistake,
          fix: params.fix,
          source_instance_type: params.source_instance_type as OrgType,
          kb_root: KB_ROOT,
        });
        return { result: result as unknown as Record<string, unknown> };
      },
    }));

  }, // end register
};

export default hiveclawRoutingPlugin;
