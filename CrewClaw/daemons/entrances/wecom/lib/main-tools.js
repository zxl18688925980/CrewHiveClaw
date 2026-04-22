'use strict';
/**
 * main-tools.js — Main 系统工程师工具层
 *
 * 包含：MAIN_SYSTEM_PROMPT / MAIN_TOOLS / executeMainTool / handleMainCommand
 *       以及 callMainModel、评估基础设施、文档归档辅助
 *
 * 工厂函数：module.exports = (logger, deps) => ({ ... })
 * 调用方：
 *   const _mainToolsFactory = require('./lib/main-tools');
 *   const mt = _mainToolsFactory(logger, { readAgentModelConfig, callAgentModel,
 *                                           nowCST, sendWeComFile, INSTANCE_ROOT });
 */

const fs            = require('fs');
const path          = require('path');
const { execSync, execFileSync } = require('child_process');
const axios         = require('axios');

module.exports = function createMainTools(logger, deps) {
  const { readAgentModelConfig, callAgentModel, nowCST, sendWeComFile, INSTANCE_ROOT,
          VIDEO_URL_RE, DOUYIN_URL_RE, FRAME_ANALYSIS_RE } = deps;

  // 剥离推理模型 <think>...</think> 块（MiniMax/GLM/DeepSeek-R1 等推理模型返回）
  function stripThink(text) {
    return (text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  }

// Main 调用模型（OpenAI-compatible，带工具）
// 模型配置来自 ~/.openclaw/openclaw.json agents.list main 条目，独立于三角色 env var 层
async function callMainModel(systemPrompt, messages, retries = 2) {
  const { baseUrl, apiKey, model } = readAgentModelConfig('main');
  // Anthropic 的 OpenAI 兼容端点需要 /v1/ 前缀 + anthropic-version header
  const isAnthropic = baseUrl.includes('anthropic.com');
  const base = baseUrl.replace(/\/$/, '');
  const completionsUrl = isAnthropic ? `${base}/v1/chat/completions` : `${base}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
  if (isAnthropic) headers['anthropic-version'] = '2023-06-01';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(completionsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools: MAIN_TOOLS_OAI,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
      // 429 限流：等待后重试
      if (resp.status === 429 && attempt < retries) {
        const delay = 3000 * (attempt + 1);
        logger.info('callMainModel 429 限流，等待重试', { attempt, delay, error: errText.slice(0, 100) });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`Main model API error ${resp.status}: ${errText.slice(0, 200)}`);
    }
    return resp.json();
  }
}

// 每个业主会话的对话历史（进程内保留，重启清空）
const mainHistory = {};

// Main 历史持久化目录（重启后恢复上下文）
const MAIN_HISTORY_DIR = path.join(INSTANCE_ROOT, 'data', 'main');

function loadMainHistory(userId) {
  try {
    const file = path.join(MAIN_HISTORY_DIR, `history-${userId}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return [];
}

function persistMainHistory(userId) {
  try {
    fs.mkdirSync(MAIN_HISTORY_DIR, { recursive: true });
    // 图片 base64 不持久化，避免文件过大
    const toSave = (mainHistory[userId] || []).map(msg => {
      if (!Array.isArray(msg.content)) return msg;
      return { ...msg, content: msg.content.map(b =>
        b.type === 'image' ? { type: 'text', text: '[图片已省略]' } : b
      )};
    });
    fs.writeFileSync(path.join(MAIN_HISTORY_DIR, `history-${userId}.json`), JSON.stringify(toSave), 'utf8');
  } catch (e) {
    logger.warn('Main 历史持久化失败', { error: e.message });
  }
}

// Obsidian vault 路径（系统工程师信息域）
const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH ||
  path.join(process.env.HOME || '', 'Documents', 'Obsidian Vault', process.env.OBSIDIAN_VAULT_NAME || 'HomeAI');

// Main 对话日志目录（本地）
const MAIN_LOG_DIR = path.join(INSTANCE_ROOT, 'logs', 'main');

/**
 * 记录 Main 对话到本地 jsonl + Obsidian Markdown
 * 双写：本地是可靠存储，Obsidian 是系统工程师可读视图
 */
function logMainConversation(userId, userMessage, toolsCalled, finalReply) {
  const now     = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0];

  // 1. 本地 JSONL（主存储，不依赖 Obsidian）
  try {
    fs.mkdirSync(MAIN_LOG_DIR, { recursive: true });
    const entry = JSON.stringify({
      ts:      now.toISOString(),
      userId,
      message: userMessage,
      tools:   toolsCalled,
      reply:   finalReply,
    }) + '\n';
    fs.appendFileSync(path.join(MAIN_LOG_DIR, `${dateStr}.jsonl`), entry);
  } catch (e) {
    logger.warn('Main 日志写入失败（本地）', { error: e.message });
  }

  // 2. Obsidian Markdown（统一存入 01-系统决策日志/YYYY-MM/，与 ClaudeCode 会话并列）
  try {
    const monthStr = dateStr.slice(0, 7); // YYYY-MM
    const obsDir = path.join(OBSIDIAN_VAULT_PATH, '03-系统工程师工作日志', monthStr);
    fs.mkdirSync(obsDir, { recursive: true });
    const toolsStr = toolsCalled.length > 0 ? toolsCalled.join(', ') : '无';
    const mdEntry  = [
      `### ${timeStr}`,
      `**工具**: ${toolsStr}`,
      '',
      `**我**：`,
      userMessage,
      '',
      `**Main**：`,
      finalReply,
      '',
      '---',
      '',
    ].join('\n');
    // 第一次写入时追加文件头
    const filePath = path.join(obsDir, `${dateStr}-Main.md`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, `# Main 通道 · ${dateStr}\n\n## 对话原文\n\n`);
    }
    fs.appendFileSync(filePath, mdEntry);
  } catch (e) {
    logger.warn('Main 日志写入失败（Obsidian）', { error: e.message });
  }
}

const MAIN_SYSTEM_PROMPT = `你是 HomeAI 系统的系统工程师助理 Main，负责远程协助业主管理和调试 HomeAI 系统。

HomeAI 当前架构：
- OpenClaw Gateway（端口 18789，launchd 管理）：Lucas/Andy/Lisa 三个 Embedded Agent 运行于此，crewclaw-routing 插件处理三层路由。日志：~/.openclaw/logs/gateway.log
- wecom-entrance（PM2 管理，端口 3003）：企业微信入口，即你自己所在的进程
- cloudflared-tunnel（PM2 管理）：Cloudflare Tunnel，把公网请求转发到本地

重要：Lucas/Andy/Lisa 是 OpenClaw 内置 Embedded Agent，不是独立进程，PM2 里看不到它们，也不能用 PM2 重启。要重启 Gateway 只能用 launchctl（不在工具范围内，需要告知业主手动执行：launchctl stop ai.openclaw.gateway && launchctl start ai.openclaw.gateway）。

记忆说明：你在同一次 PM2 运行周期内有会话历史，每个业主的最近 20 条对话会保留在内存中。wecom-entrance 重启后历史清空，这是正常现象。

长期记忆：所有 Main 对话均记录在 Obsidian 工作日志（~/Documents/Obsidian Vault/HomeAI/03-系统工程师工作日志/）。

如果业主问历史决策或上次做了什么，直接告知「我的 session 记忆有限，请到 CLI 用 Claude Code 查 Obsidian 工作日志」，不要尝试自己搜索。

---
系统工程师工作方式（你的行为标准）：

遇到问题，先建立上下文，再动手。顺序：
1. 看日志（get_logs / run_shell tail）→ 定位症状
2. 读相关代码（read_file）→ 理解根因，不猜
3. 做修改（exec_script / write_file）→ 改最小必要的地方
4. 重启验证（restart_service / restart_gateway）→ test_lucas 确认
5. 报告：说清楚改了什么、为什么、验证结果

判断根因前不改代码。改完必须验证。不确定就告诉业主，不自作主张。

文档地图（遇到对应问题时主动去读）：
- 整体架构 / 当前状态：read_file crewclaw/../CLAUDE.md（即 ${INSTANCE_ROOT}/../CLAUDE.md 或用 run_shell cat ~/HomeAI/CLAUDE.md）
- 插件逻辑（记忆注入 / 路由）：${INSTANCE_ROOT}/crewclaw/crewclaw-routing/index.ts
- wecom 入口逻辑：${INSTANCE_ROOT}/crewclaw/daemons/entrances/wecom/index.js
- Gateway 启动 / 环境变量：~/.openclaw/start-gateway.sh
- Lucas/Andy/Lisa 人格规则：~/.openclaw/workspace-{lucas,andy,lisa}/AGENTS.md
- Lucas 工具清单：~/.openclaw/workspace-lucas/TOOLS.md
- 历史决策 / 会话记录：~/Documents/Obsidian Vault/HomeAI/03-系统工程师工作日志/（只读，无搜索工具，告知业主去 CLI 查）

项目根目录：${INSTANCE_ROOT}
PM2 日志目录：${INSTANCE_ROOT}/logs/pm2/

你可以使用以下工具帮助业主诊断问题、查看状态、管理服务：
- get_system_status：PM2 + 服务健康检查
- get_logs：查 gateway/wecom/cloudflared 日志
- read_file：读 HomeAI 目录下的文件
- restart_service：重启 PM2 管理的服务（wecom/cloudflared）
- restart_gateway：重启 OpenClaw Gateway（launchctl），改完插件代码后用
- run_shell：执行诊断命令（curl/cat/tail/grep/launchctl/pm2 等白名单命令）
- test_lucas：向 Lucas 发测试消息，验证 wecom→Gateway 全链路是否正常
- exec_script：在 HomeAI 根目录执行 bash/python3 脚本，对本机所有目录有完整读写权限（含 ~/Documents/Obsidian Vault/、系统配置等），无路径限制
- send_file：将 HomeAI 目录下的文件通过企业微信发给业主
- trigger_finetune：触发增量微调
- scan_pipeline_health：全面扫描系统健康（PM2 + Gateway + 最近 1h 日志错误），返回结构化报告
- scan_lucas_quality：扫描 ChromaDB 最近 50 条 Lucas 对话，检测 Markdown 违规、幻觉承诺、空回复等质量问题
- recall_se_history：召回最近 N 天的 SE 通知历史（ChromaDB agent_interactions），了解上次发现了什么问题/现在是否改善——建立跨对话记忆连续性（limit / days 可选）

流水线任务看板（SE 专属，直接操作 task-registry.json，无需手动读文件）：
- query_pipeline_tasks：查全量流水线任务（含用户提交 + 系统自动生成）。status_filter 可选 all / pending-review / queued / running / active（默认）
- approve_pipeline_task：批准 pending-review 任务进队列执行（仅 requires_approval=true 的任务会进 pending-review，如认知文件修改）
- cancel_pipeline_task：叫停任意任务（不受 submittedBy 限制），可叫停 pending-review / queued / running 状态的任何任务
- log_improvement_task：记录改进建议到 task-registry.json（非紧急，供下次工作周期处理）

任务数据来源说明：
- 开发流水线任务：~/HomeAI/Data/learning/task-registry.json（用 query_pipeline_tasks 查，不要手动 exec_script 读文件）
- 旧格式任务目录（~/HomeAI/Data/tasks/、pipeline/）：已废弃，不要读这里


收到文章/视频链接的默认行为：只做简要分析并回复，不自动存文件。
仅当业主明确说「存外部参考」「纳入参考」「记录下来」等指令时，根据内容类型选择目录：
- ClaudeCode 相关（使用技巧、插件、Skills、协作经验等）→ write_file 写入 /Users/xinbinanshan/Documents/Obsidian Vault/HomeAI/00-ClaudeCode配置/ClaudeCode外部经验参考/
- 其他设计/技术内容 → write_file 写入 /Users/xinbinanshan/Documents/Obsidian Vault/HomeAI/07-设计与技术外部参考/
文件名格式 YYYY-MM-DD-标题摘要.md，内容包含出处链接、摘要和要点。

典型调试流程：业主改完插件代码 → restart_gateway → test_lucas → 确认修复。
回答用中文，简洁直接，不要啰嗦。如果需要先看日志或文件再下结论，主动去看。

---

**汇报格式（强制）**：所有推送给工程师的状态报告必须按 Lx 分层组织：
## L0 Agents基础设施
[各 PM2 进程名称+状态、Gateway、端口、数据量]
## L1 Agent 人格化
[Lucas 质量、Andy/Lisa 活跃度、蒸馏产出、evaluator 状态]
## L2 Engineering Anything
[任务类型覆盖度、端到端交付成功率、交付物多样性、三角色流水线健康]
## L3 组织协作进化
[①成员画像/②协作关系图谱/③影子Agent演进/④跨成员感知蒸馏]
## L4 系统自进化
[系统层：AGENTS.md规则收敛+路由阈值进化+Andy巡检时效 | 模型层：DPO积累/本地路由比例/本地模型就绪]
规则：某层无问题写 ✅ 无异常，不要省略。L0 必须包含具体进程状态。

系统评估工具（业主发「系统评估」时使用）：
- evaluate_system：依次调用 evaluate_l0~l4，输出 L0~L4 评分卡
- evaluate_l0 / evaluate_l1 / evaluate_l2 / evaluate_l3 / evaluate_l4：单层评估
- inspect_agent_context：查看 Andy 或 Lisa 上下文快照

L4 微调流水线工具（业主主导，按需调用）：
- evaluate_local_model：数据驱动评测本地模型智力（Kuzu 知识题 0.4 + ChromaDB 对话题 0.6，综合 ≥3.5 通过）
- generate_dpo_good_responses：为积累达阈值的 DPO 负例批量生成 good_response（云端改写）
- approve_dpo_batch：批准指定 pattern 的 good_response，标记 confirmed=true 进入微调队列`;

const MAIN_TOOLS = [
  {
    name: 'get_system_status',
    description: '获取 PM2 进程状态（wecom/cloudflared）及 Gateway/wecom 服务健康检查',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_logs',
    description: '获取指定服务的最近日志',
    input_schema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          enum: ['gateway', 'wecom', 'cloudflared'],
          description: '服务名称：gateway（OpenClaw Gateway，含 Lucas/Andy/Lisa）、wecom（企业微信入口）、cloudflared（隧道）',
        },
        lines: {
          type: 'number',
          description: '获取最近几行，默认 30',
        },
      },
      required: ['service'],
    },
  },
  {
    name: 'read_file',
    description: '读取 HomeAI 项目目录下的文件内容，用于诊断配置、代码或数据问题',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '相对于 crewclaw 目录的文件路径，例如 crewclaw-routing/index.ts 或 daemons/entrances/wecom/index.js',
        },
        tail_lines: {
          type: 'number',
          description: '只读最后 N 行（适合大文件），不填则读全部（限 200 行）',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'restart_service',
    description: '重启 PM2 管理的服务（仅限 wecom/cloudflared，Gateway 不在此管理）',
    input_schema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          enum: ['wecom', 'cloudflared'],
          description: '要重启的服务名称',
        },
      },
      required: ['service'],
    },
  },
  {
    name: 'trigger_finetune',
    description: '强制触发一次增量微调',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'restart_gateway',
    description: '重启 OpenClaw Gateway（launchctl stop + start），重启后自动读取最新日志确认状态。修改插件代码后用此工具热重载。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_shell',
    description: '执行诊断用 shell 命令（白名单限制：curl/cat/tail/grep/wc/ls/ps/launchctl/pm2/python3）。用于查状态、验证端点、检查文件。',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的命令，例如：curl -s http://localhost:18789/api/health 或 tail -20 ~/.openclaw/logs/gateway.log',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'test_lucas',
    description: '向 Lucas 发送测试消息，走 wecom-entrance → Gateway 完整链路，返回 Lucas 的响应和耗时。用于修改插件或重启 Gateway 后验证全流程。',
    input_schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '发给 Lucas 的测试消息，默认"你好，系统测试"',
        },
      },
      required: [],
    },
  },
  {
    name: 'exec_script',
    description: '在 HomeAI 目录下执行 bash 或 python3 脚本，CWD 为 HomeAI 根目录，对本机所有目录有完整读写权限（无路径限制，可写 ~/Documents/Obsidian Vault/ 等任意位置）。适合写文件、合并数据、远程调试、生成报告等任务。',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '要执行的脚本内容（可多行）',
        },
        interpreter: {
          type: 'string',
          description: 'bash 或 python3，默认 bash',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'write_file',
    description: '将内容直接写入本机任意路径的文件（path 和 content 分开传，不需要生成代码）。适合写 Obsidian 笔记、保存文章摘要、更新配置文件等需要写入大段文本的场景。父目录不存在时自动创建。',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件的绝对路径，例如 /Users/xinbinanshan/Documents/Obsidian Vault/HomeAI/07-设计与技术外部参考/2026-03-26-标题.md',
        },
        content: {
          type: 'string',
          description: '要写入的文件内容（UTF-8 字符串，支持中文、Markdown 等）',
        },
        append: {
          type: 'boolean',
          description: '是否追加到文件末尾（默认 false = 覆盖写入）',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'send_file',
    description: '将 HomeAI 目录下的文件通过企业微信发送给业主。适合发日志、数据文件、生成的代码等。',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '相对于 HomeAI 根目录的文件路径，例如 data/learning/route-events.jsonl 或 crewclaw/crewclaw-routing/index.ts',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'evaluate_l0',
    description: '评估 L0（Agent记忆与认知质量·写入侧）：四维度蒸馏管道健康（语义/时间/实体/因果 × 三角色 embedding 有效率）、蒸馏产出（Andy design_learning / Lisa impl_learning）、家人档案注入完整性（Kuzu→inject.md）、Kuzu 知识图谱数据量；基础设施前提条件（进程存活/磁盘/内存/Gateway延迟/ChromaDB延迟/数据新鲜度）作为写入侧的运行保障。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'evaluate_l1',
    description: '评估 L1（Agent人格完整度·召回侧）：记忆语义召回质量（avg cosine distance，越低越好）、Skill 自动沉淀积累（native + archive 数量）、行为模式结晶（Kuzu has_pattern）、Lucas 输出合规率（问题率）、Andy/Lisa 交互活跃度、Main HEARTBEAT 状态、子 Agent 活跃度。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'inspect_agent_context',
    description: '查看 Andy 或 Lisa 当前实际注入的上下文快照：静态文件（ARCH/MEMORY/DESIGN-PRINCIPLES）摘要、Kuzu 设计模式积累、ChromaDB decisions 最新条目（含 design_learning/impl_learning/learning_objective）。用于排查上下文质量问题。业主发「看看 Andy 上下文」/「Andy 在看什么」时调用。',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['andy', 'lisa'], description: '要查看的 Agent（andy 或 lisa）' },
      },
      required: ['agent'],
    },
  },
  {
    name: 'evaluate_l2',
    description: '评估 L2（Engineering Anything · 开发即交付）：三角色闭环交付力——任务类型覆盖度 + 端到端交付成功率 + 交付物多样性 + 三角色流水线健康（task-registry 状态分布）。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'evaluate_l3',
    description: '评估 L3（组织协作进化）：四层机制——①成员画像（从交互蒸馏，inject.md质量）②关系图谱（Kuzu协作边）③影子Agent（演进环+访客Registry）④跨成员感知（关系蒸馏运行状态）。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'evaluate_l4',
    description: '评估 L4（系统自我演化·让 L0~L3 越来越好）两层：【系统层·Andy 主力】进化信号积累 + 知识内化 + Skill 积累 + Andy 巡检时效；【模型层】DPO 信号积累+趋势、本地模型就绪状态、模型能力评估（调用 evaluate_local_model 获取量化评分）。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'evaluate_local_model',
    description: '数据驱动评测本地模型智力。从 Kuzu 抽家人事实→生成知识题（0.4），从 ChromaDB 抽真实对话→测对话能力（0.6，需求理解/推理/边界三维度）。综合 ≥3.5 通过。零硬编码，第二个部署有数据就能跑。参数：model_name（可选，默认当前本地模型）。',
    input_schema: {
      type: 'object',
      properties: {
        model_name: { type: 'string', description: '要评测的 Ollama 模型名，为空则用 LOCAL_MODEL_NAME 环境变量' },
      },
      required: [],
    },
  },
  {
    name: 'generate_dpo_good_responses',
    description: '为 dpo-candidates.jsonl 中积累达阈值的负例 pattern 批量生成 good_response（由云端模型改写坏回复）。生成后推送样本供工程师用 approve_dpo_batch 审批。参数：pattern_type（可选，为空处理所有达阈值 pattern）、threshold（可选，默认 50）。',
    input_schema: {
      type: 'object',
      properties: {
        pattern_type: { type: 'string', description: '指定要处理的 pattern 类型，为空则处理所有达阈值 pattern' },
        threshold: { type: 'number', description: '触发阈值，默认 50' },
      },
      required: [],
    },
  },
  {
    name: 'approve_dpo_batch',
    description: '批准 dpo-candidates.jsonl 中指定 pattern 的已生成 good_response，将 confirmed 标记为 true，使其进入微调队列。需先运行 generate_dpo_good_responses 生成好回答。参数：pattern_type（必填）、limit（可选，默认 50）。',
    input_schema: {
      type: 'object',
      properties: {
        pattern_type: { type: 'string', description: '要批准的 pattern 类型，如 false_commitment / pretend_doing' },
        limit: { type: 'number', description: '最多批准条数，默认 50' },
      },
      required: ['pattern_type'],
    },
  },
  {
    name: 'evaluate_system',
    description: '系统全面评估（L0~L4）：依次运行 evaluate_l0 / evaluate_l1 / evaluate_l2 / evaluate_l3 / evaluate_l4，汇总为一张评分卡。业主发「系统评估」时调用此工具。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'evaluate_trend',
    description: '评分趋势分析：读取历史评估记录（evaluation-history.jsonl），输出各层分数变化表格 + 趋势方向 + 关键卡点分析（拖累得分的子维度）。业主发「评分趋势」「看看演进」时调用。',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '显示最近 N 次评估记录（默认 10）' },
      },
      required: [],
    },
  },
  // run_claude_code 暂时禁用（2026-03-26）：子进程 execFileSync 阻塞事件循环 120s，
  // 且 Main 容易在不该调用时触发（应改为按需启用，设计待确认后恢复）
  {
    name: 'scan_pipeline_health',
    description: '全面扫描 HomeAI 系统健康：PM2 进程状态、Gateway 存活、最近 1 小时日志错误摘要。返回结构化健康报告，用于监控循环和主动告警。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'scan_lucas_quality',
    description: '扫描 ChromaDB conversations 集合中最近 50 条 Lucas 对话，检测质量问题：Markdown 格式违规（**标题**/#标题）、幻觉承诺（说"已完成"但无工具调用证据）、空回复或过短回复（<10字）。返回发现的问题列表。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_heartbeat',
    description: '更新 HEARTBEAT.md 状态。operation=append_observation 时追加一条观察记录到「待汇总观察」节；operation=mark_daily_sent 时清空「待汇总观察」节并更新「上次日报发送」时间戳。',
    input_schema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['append_observation', 'mark_daily_sent'], description: 'append_observation: 追加观察；mark_daily_sent: 标记日报已发送并清空观察' },
        observation: { type: 'string', description: '观察描述（仅 append_observation 时使用）' },
      },
      required: ['operation'],
    },
  },
  {
    name: 'query_pipeline_tasks',
    description: '查看流水线任务看板（全量视图，含用户提交任务 + 系统自动生成任务）。返回所有状态任务，按 pending-review → queued → running → completed/failed 排序。SE 专属。',
    input_schema: {
      type: 'object',
      properties: {
        status_filter: { type: 'string', enum: ['all', 'pending-review', 'queued', 'running', 'active'], description: 'all=全部 | pending-review=待批准 | queued=排队中 | running=执行中 | active=进行中（queued+running）。默认 active' },
      },
      required: [],
    },
  },
  {
    name: 'approve_pipeline_task',
    description: 'SE 批准 pending-review 任务进队列执行。只有 requires_approval=true 的任务（认知文件修改、架构提案等）才进 pending-review。批准后自动进 queued 由 Lucas 调度。',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID（如 req_ev_1745xxx）' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'cancel_pipeline_task',
    description: 'SE 叫停任意流水线任务（不受 submittedBy 限制）。可叫停 pending-review / queued / running 的任何任务，含用户提交和系统自动生成的。',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string', description: '任务 ID（如 req_1745xxx）' },
        reason: { type: 'string', description: '叫停原因（可选）' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'log_improvement_task',
    description: '记录系统改进建议到流水线任务队列（~/HomeAI/Data/learning/task-registry.json）。适用于发现架构缺口、质量积累性问题、优化机会——不是立即告警的紧急问题，而是值得在下次工作周期处理的改进点。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '改进点标题（一句话，≤40字）' },
        description: { type: 'string', description: '详细描述：发现了什么问题、影响是什么、建议如何处理' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'low: 优化机会 | medium: 影响体验但不紧急 | high: 架构缺口或持续积累的系统性问题' },
        action_type: { type: 'string', enum: ['agents_md', 'code_fix', 'readme', 'observe'], description: '建议干预类型——agents_md: 行为问题（幻觉承诺/回复风格/工具滥用），改 AGENTS.md 行为规则可修 | code_fix: 功能缺失/工具 bug/插件逻辑错误，需改代码 | readme: 架构级调整，需修正 Readme 正朔再刷新 Agent 认知 | observe: 信号尚弱，先积累数据再判断，暂不干预' },
      },
      required: ['title', 'description', 'priority', 'action_type'],
    },
  },
  {
    name: 'recall_se_history',
    description: '召回最近 N 天的系统工程师通知历史（ChromaDB agent_interactions 集合）。用于建立跨对话记忆连续性——了解上次发现了什么问题、现在是否改善。返回通知摘要，按时间倒序。',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '返回条数（默认 20，最多 50）' },
        days:  { type: 'number', description: '查最近 N 天（默认 14）' },
      },
      required: [],
    },
  },
];

// OpenAI function-call 格式（由 MAIN_TOOLS Anthropic 格式转换）
const MAIN_TOOLS_OAI = MAIN_TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

// ─── 评估体系：数值评分框架 ────────────────────────────────────────────────────
const _evalScores = {};
let _rubricCache = null;

function loadRubric() {
  if (_rubricCache !== null) return _rubricCache;
  try {
    _rubricCache = JSON.parse(fs.readFileSync(
      path.join(INSTANCE_ROOT, 'CrewHiveClaw', 'CrewClaw', 'crewclaw-routing', 'config', 'evaluation-rubric.json'), 'utf8'
    ));
  } catch { _rubricCache = null; }
  return _rubricCache;
}

function scoreWithRubric(item, rawValue) {
  if (!item) return 3;
  if (item.direction === 'enum') return item.map?.[rawValue] ?? 3;
  if (item.direction === 'higher_better') {
    for (const [threshold, sc] of (item.thresholds || [])) {
      if (rawValue >= threshold) return sc;
    }
    return 0;
  }
  if (item.direction === 'lower_better') {
    for (const [threshold, sc] of (item.thresholds || [])) {
      if (rawValue <= threshold) return sc;
    }
    return 0;
  }
  return 3;
}

function trackScore(scores, layerItems, key, rawValue) {
  if (!layerItems?.[key]) return;
  const item = layerItems[key];
  scores.push({ key, name: item.name, score: scoreWithRubric(item, rawValue), weight: item.weight, raw: rawValue });
}

function calcWeightedAvg(scores) {
  let tw = 0, ts = 0;
  for (const s of scores) { tw += s.weight; ts += s.score * s.weight; }
  return tw > 0 ? ts / tw : 0;
}

// 工具执行
async function executeMainTool(toolName, toolInput) {
  const nameMap = { lucas: 'lucas-daemon', andy: 'andy-daemon', lisa: 'lisa-daemon', wecom: 'wecom-entrance' };
  const PYTHON311 = '/opt/homebrew/opt/python@3.11/bin/python3.11';

  if (toolName === 'get_system_status') {
    try {
      const pm2Out = execSync('pm2 jlist', { encoding: 'utf8' });
      const procs = JSON.parse(pm2Out);
      const lines = procs.map(p => {
        const status = p.pm2_env.status === 'online' ? '✅' : '❌';
        return `${status} ${p.name}  状态:${p.pm2_env.status}  重启:${p.pm2_env.restart_time}次  内存:${Math.round((p.monit?.memory || 0) / 1024 / 1024)}MB`;
      });
      // gateway 用 /health（OpenClaw Gateway 原生端点）；wecom 用 /api/health（自定义端点）
      const services = [['gateway', 18789, '/health'], ['wecom', 3003, '/api/health']];
      const health = await Promise.all(services.map(async ([name, port, healthPath]) => {
        try {
          await axios.get(`http://localhost:${port}${healthPath}`, { timeout: 2000 });
          return `✅ ${name}:${port}`;
        } catch (err) {
          const code = err.response?.status;
          // 4xx（含 404）= 服务在线但路径不对，不算无响应
          if (code && code >= 400 && code < 500) return `⚠️ ${name}:${port} 在线但端点异常(${code})`;
          return `❌ ${name}:${port} 无响应`;
        }
      }));
      return `PM2 进程：\n${lines.join('\n')}\n\n服务健康：\n${health.join('\n')}`;
    } catch (e) {
      return `获取状态失败：${e.message}`;
    }
  }

  if (toolName === 'get_logs') {
    const lines = toolInput.lines || 30;
    try {
      const home = process.env.HOME || '';
      const logFiles = {
        gateway:    [path.join(home, '.openclaw/logs/gateway.log'), path.join(home, '.openclaw/logs/gateway.err.log')],
        wecom:      [path.join(INSTANCE_ROOT, 'logs/pm2/wecom-out.log'), path.join(INSTANCE_ROOT, 'logs/pm2/wecom-error.log')],
        cloudflared:[path.join(INSTANCE_ROOT, 'logs/pm2/cloudflared-out.log'), path.join(INSTANCE_ROOT, 'logs/pm2/cloudflared-error.log')],
      };
      const [logFile, errFile] = logFiles[toolInput.service] || [];
      let result = '';
      if (logFile && fs.existsSync(logFile)) {
        // 只读文件末尾 64KB，避免 readFileSync 整个大文件（gateway.log 可达数十MB）
        const MAX_READ = 65536;
        const fd = fs.openSync(logFile, 'r');
        const stat = fs.fstatSync(fd);
        const start = Math.max(0, stat.size - MAX_READ);
        const buf = Buffer.alloc(Math.min(MAX_READ, stat.size));
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const tail = buf.toString('utf8').split('\n').filter(l => l.trim()).slice(-lines).join('\n');
        // 工具返回值最多 4000 字符，防止 messages 膨胀导致 API 超时
        const truncated = tail.length > 4000 ? '...(已截断)\n' + tail.slice(-4000) : tail;
        result += `[stdout 最近${lines}行]\n${truncated}\n`;
      }
      if (errFile && fs.existsSync(errFile)) {
        const content = fs.readFileSync(errFile, 'utf8');
        const errLines = content.split('\n').filter(l => l.trim()).slice(-10);
        if (errLines.length > 0) result += `\n[stderr 最近10行]\n${errLines.join('\n')}`;
      }
      return result || '日志文件为空';
    } catch (e) {
      return `读取日志失败：${e.message}`;
    }
  }

  if (toolName === 'read_file') {
    try {
      const absPath = path.join(INSTANCE_ROOT, toolInput.file_path);
      // 安全检查：只允许读 HomeAI 根目录下的文件
      if (!absPath.startsWith(INSTANCE_ROOT)) {
        return '只能读取 HomeAI 项目目录下的文件';
      }
      if (!fs.existsSync(absPath)) {
        return `文件不存在：${toolInput.file_path}`;
      }
      const content = fs.readFileSync(absPath, 'utf8');
      const allLines = content.split('\n');
      let result;
      if (toolInput.tail_lines) {
        result = allLines.slice(-toolInput.tail_lines).join('\n');
      } else {
        result = allLines.slice(0, 200).join('\n');
        if (allLines.length > 200) result += `\n\n[文件共 ${allLines.length} 行，只显示前 200 行]`;
      }
      return result;
    } catch (e) {
      return `读取文件失败：${e.message}`;
    }
  }

  if (toolName === 'restart_service') {
    const pm2Name = nameMap[toolInput.service] || toolInput.service;
    try {
      execSync(`pm2 restart ${pm2Name}`, { encoding: 'utf8' });
      return `${pm2Name} 已重启`;
    } catch (e) {
      return `重启失败：${e.message}`;
    }
  }

  if (toolName === 'trigger_finetune') {
    try {
      const schedulerPath = path.join(INSTANCE_ROOT, 'scripts/finetune-scheduler.js');
      execSync(`node ${schedulerPath} --force-run > /dev/null 2>&1 &`, { encoding: 'utf8' });
      return '增量微调已在后台启动，完成后日志见 logs/finetune.log';
    } catch (e) {
      return `微调启动失败：${e.message}`;
    }
  }

  if (toolName === 'restart_gateway') {
    try {
      execSync('launchctl stop ai.openclaw.gateway', { encoding: 'utf8' });
      await new Promise(r => setTimeout(r, 3000));
      execSync('launchctl start ai.openclaw.gateway', { encoding: 'utf8' });
      await new Promise(r => setTimeout(r, 3000));
      // 读启动后最新日志确认状态（只读末尾 64KB，避免 readFileSync 整个大文件）
      const logFile = path.join(process.env.HOME || '', '.openclaw/logs/gateway.log');
      let tail = '';
      if (fs.existsSync(logFile)) {
        const MAX_READ = 65536;
        const fd = fs.openSync(logFile, 'r');
        const stat = fs.fstatSync(fd);
        const start = Math.max(0, stat.size - MAX_READ);
        const buf = Buffer.alloc(Math.min(MAX_READ, stat.size));
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n').filter(l => l.trim()).slice(-10);
        tail = lines.join('\n');
      }
      return `Gateway 已重启。最新日志：\n${tail || '（日志为空）'}`;
    } catch (e) {
      return `Gateway 重启失败：${e.message}`;
    }
  }

  if (toolName === 'run_shell') {
    const cmd = (toolInput.command || '').trim();
    // 白名单：只允许以下命令开头，防止误操作
    const ALLOWED_PREFIXES = ['curl ', 'cat ', 'tail ', 'grep ', 'wc ', 'ls ', 'ps ', 'launchctl ', 'pm2 ', 'python3 '];
    const allowed = ALLOWED_PREFIXES.some(p => cmd.startsWith(p));
    if (!allowed) {
      return `命令不在白名单内（允许：${ALLOWED_PREFIXES.map(p => p.trim()).join('、')}）`;
    }
    // 禁止写入操作
    if (/[>|]/.test(cmd) && !/^\s*curl/.test(cmd)) {
      return '不允许重定向或管道写入操作';
    }
    try {
      const output = execSync(cmd, { encoding: 'utf8', timeout: 15000, env: process.env });
      return output.trim() || '（命令执行成功，无输出）';
    } catch (e) {
      return `执行失败（退出码 ${e.status}）：${e.stderr || e.message}`.slice(0, 1000);
    }
  }

  if (toolName === 'test_lucas') {
    const msg = toolInput.message || '你好，系统测试';
    const start = Date.now();
    try {
      const resp = await axios.post('http://localhost:3003/api/wecom/forward', {
        message: msg,
        userId: 'main-test',
      }, { timeout: 60000 });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const reply = resp.data?.response || resp.data?.reply || JSON.stringify(resp.data);
      return `✅ Lucas 响应（${elapsed}s）：\n${reply}`;
    } catch (e) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      return `❌ 测试失败（${elapsed}s）：${e.message}`;
    }
  }

  if (toolName === 'exec_script') {
    const interpreter = toolInput.interpreter === 'python3' ? '/usr/bin/python3' : '/bin/bash';
    const tmpScript = path.join(INSTANCE_ROOT, 'temp', `main-script-${Date.now()}.${interpreter.includes('python') ? 'py' : 'sh'}`);
    try {
      fs.mkdirSync(path.join(INSTANCE_ROOT, 'temp'), { recursive: true });
      fs.writeFileSync(tmpScript, toolInput.code, { mode: 0o755 });
      const output = execSync(`${interpreter} ${tmpScript}`, {
        encoding: 'utf8',
        timeout: 60000,
        cwd: INSTANCE_ROOT,
        env: { ...process.env, INSTANCE_ROOT },
      });
      fs.unlinkSync(tmpScript);
      return output.trim().slice(0, 2000) || '（脚本执行成功，无输出）';
    } catch (e) {
      try { fs.unlinkSync(tmpScript); } catch (_) {}
      const out = (e.stdout || '').trim();
      const err = (e.stderr || e.message || '').trim();
      return `执行失败（退出码 ${e.status}）：\n${err || out}`.slice(0, 2000);
    }
  }

  if (toolName === 'write_file') {
    const filePath = toolInput.path;
    const content  = toolInput.content;
    const append   = toolInput.append === true;
    if (!filePath || content === undefined) return '缺少 path 或 content 参数';
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (append) {
        fs.appendFileSync(filePath, content, 'utf8');
      } else {
        fs.writeFileSync(filePath, content, 'utf8');
      }
      const size = fs.statSync(filePath).size;
      return `✅ 已写入：${filePath}（${(size/1024).toFixed(1)}KB）`;
    } catch (e) {
      return `写入失败：${e.message}`;
    }
  }

  if (toolName === 'send_file') {
    const absPath = path.join(INSTANCE_ROOT, toolInput.file_path);
    if (!absPath.startsWith(INSTANCE_ROOT)) {
      return '只能发送 HomeAI 项目目录下的文件';
    }
    if (!fs.existsSync(absPath)) {
      return `文件不存在：${toolInput.file_path}`;
    }
    const stat = fs.statSync(absPath);
    if (stat.size > 20 * 1024 * 1024) {
      return `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），企业微信限制 20MB`;
    }
    try {
      await sendWeComFile(WECOM_OWNER_ID, absPath);
      return `✅ 已发送：${path.basename(absPath)}（${(stat.size / 1024).toFixed(1)}KB）`;
    } catch (e) {
      return `发送失败：${e.message}`;
    }
  }

  if (toolName === 'run_claude_code') {
    const task           = toolInput.task;
    const withObsidian   = toolInput.include_obsidian !== false;
    const OBSIDIAN_VAULT = OBSIDIAN_VAULT_PATH;
    const CLAUDE_BIN     = '/opt/homebrew/bin/claude';

    const args = [
      '-p', task,
      '--output-format', 'text',
      '--permission-mode', 'bypassPermissions',
      '--no-session-persistence',
      '--allowedTools', 'Read,Grep,Glob',
    ];
    if (withObsidian) {
      args.push('--add-dir', OBSIDIAN_VAULT);
    }

    try {
      const { execFileSync } = require('child_process');
      const output = execFileSync(CLAUDE_BIN, args, {
        cwd:      INSTANCE_ROOT,
        encoding: 'utf8',
        timeout:  120000,
        env:      { ...process.env },
      });
      return output.trim() || '（Claude Code 执行完毕，无文字输出）';
    } catch (e) {
      const stderr = e.stderr || '';
      return `run_claude_code 失败：${e.message}${stderr ? '\n' + stderr.slice(0, 500) : ''}`;
    }
  }

  if (toolName === 'scan_pipeline_health') {
    const report = { pm2: [], gateway: null, wecom: null, logErrors: [] };

    // PM2 状态
    try {
      const pm2Out = execSync('pm2 jlist', { encoding: 'utf8' });
      const procs = JSON.parse(pm2Out);
      report.pm2 = procs.map(p => ({
        name:     p.name,
        status:   p.pm2_env.status,
        restarts: p.pm2_env.restart_time,
        memMB:    Math.round((p.monit?.memory || 0) / 1024 / 1024),
        ok:       p.pm2_env.status === 'online',
      }));
    } catch (e) {
      report.pm2 = [{ name: 'pm2', status: 'error', ok: false, error: e.message }];
    }

    // Gateway 健康（正确端点 /health，不是 /api/health）
    try {
      const r = await axios.get('http://localhost:18789/health', { timeout: 3000 });
      report.gateway = { ok: r.data?.ok === true || r.status === 200 };
    } catch (e) {
      report.gateway = { ok: false, error: e.message };
    }

    // wecom 健康
    try {
      await axios.get(`http://localhost:${PORT}/api/health`, { timeout: 2000 });
      report.wecom = { ok: true };
    } catch (e) {
      report.wecom = { ok: false, error: e.message };
    }

    // 日志错误扫描（最近 1 小时）
    const home = process.env.HOME || '';
    const logsToScan = [
      path.join(home, '.openclaw/logs/gateway.log'),
      path.join(INSTANCE_ROOT, 'logs/pm2/wecom-error.log'),
    ];
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const logPath of logsToScan) {
      if (!fs.existsSync(logPath)) continue;
      try {
        const MAX_READ = 65536;
        const fd = fs.openSync(logPath, 'r');
        const stat = fs.fstatSync(fd);
        const start = Math.max(0, stat.size - MAX_READ);
        const buf = Buffer.alloc(Math.min(MAX_READ, stat.size));
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n');
        for (const line of lines) {
          if (!line.includes('error') && !line.includes('Error') && !line.includes('ERROR')) continue;
          // 已知噪音：未配对 WebSocket 连接缺少 operator.read scope（非致命，等 OpenClaw 升级解决）
          if (line.includes('missing scope: operator.read')) continue;
          // 尝试解析时间戳判断是否在 1h 内
          try {
            const tsMatch = line.match(/"timestamp":"([^"]+)"/);
            if (tsMatch && new Date(tsMatch[1]).getTime() < oneHourAgo) continue;
          } catch {}
          report.logErrors.push(`[${path.basename(logPath)}] ${line.slice(0, 200)}`);
          if (report.logErrors.length >= 5) break;
        }
      } catch (e) {
        report.logErrors.push(`读取 ${path.basename(logPath)} 失败：${e.message}`);
      }
    }

    // 汇总
    const pm2Issues = report.pm2.filter(p => !p.ok).map(p => `${p.name} 状态异常（${p.status}）`);
    const gatewayIssue = report.gateway?.ok === false ? `Gateway 无响应：${report.gateway.error}` : null;
    const wecomIssue   = report.wecom?.ok   === false ? `wecom-entrance 健康检查失败：${report.wecom.error}` : null;
    const allIssues = [...pm2Issues, ...(gatewayIssue ? [gatewayIssue] : []), ...(wecomIssue ? [wecomIssue] : [])];

    const summary = allIssues.length === 0
      ? '✅ 系统健康：所有进程在线，Gateway 和 wecom 均可达'
      : `⚠️ 发现 ${allIssues.length} 个问题：\n${allIssues.map(i => `  - ${i}`).join('\n')}`;

    return `${summary}\n\nPM2 进程：\n${report.pm2.map(p => `  ${p.ok ? '✅' : '❌'} ${p.name}（${p.status}，重启${p.restarts}次，内存${p.memMB}MB）`).join('\n')}\n\n日志错误（最近1h）：\n${report.logErrors.length === 0 ? '  无' : report.logErrors.slice(0, 5).map(e => `  ${e}`).join('\n')}`;
  }

  if (toolName === 'scan_lucas_quality') {
    const issues = [];
    try {
      // 获取 conversations 集合 UUID
      const colResp = await fetch(`${CHROMA_API_BASE}/conversations`);
      if (!colResp.ok) return `ChromaDB conversations 集合不可达：${colResp.status}`;
      const { id: colId } = await colResp.json();

      // 查最近 50 条 Lucas 回复（fromType=human 已过滤 pipeline 对话）
      const getResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          where:   { fromType: { '$eq': 'human' } },
          include: ['documents', 'metadatas'],
          limit:   50,
        }),
      });
      if (!getResp.ok) return `ChromaDB 查询失败：${getResp.status}`;
      const data = await getResp.json();
      const docs  = data.documents || [];
      const metas = data.metadatas || [];

      const MARKDOWN_TITLE_RE = /^#{1,4}\s+.{2,40}$/m;
      // 精确承诺词：只检测强承诺动词，排除「已了解/已知道/已确认」等合理用法
      const COMMITMENT_RE     = /已(提交|修复|告知|报告|转告|安排)(?!了解|知道|确认)/;
      const SHORT_REPLY_MAX   = 10;

      docs.forEach((doc, i) => {
        const meta   = metas[i] || {};
        const reply  = (meta.response || doc || '').toString();
        const ts     = meta.timestamp || '';
        const ctx    = ts ? `（${ts.slice(0, 10)}）` : '';

        if (!reply || reply.trim().length === 0) {
          issues.push({ type: '空回复', ctx, preview: '（空）' });
        } else if (reply.trim().length < SHORT_REPLY_MAX) {
          issues.push({ type: '过短回复', ctx, preview: reply.trim() });
        } else if (MARKDOWN_TITLE_RE.test(reply)) {
          issues.push({ type: 'Markdown 格式违规', ctx, preview: reply.slice(0, 80).trim() });
        } else if (COMMITMENT_RE.test(reply)) {
          issues.push({ type: '可能幻觉承诺', ctx, preview: reply.slice(0, 80).trim() });
        }
      });

      if (issues.length === 0) {
        return `✅ Lucas 质量扫描通过：最近 ${docs.length} 条对话无明显质量问题`;
      }
      const summary = issues.slice(0, 10).map((iss, i) => `  ${i + 1}. [${iss.type}] ${iss.ctx} ${iss.preview}`).join('\n');
      return `⚠️ 发现 ${issues.length} 个质量问题（展示前10条）：\n${summary}\n\n建议：将典型问题记录到 AGENTS.md 禁令 + 下次 before_prompt_build 注入示例`;
    } catch (e) {
      return `质量扫描失败：${e.message}`;
    }
  }

  if (toolName === 'update_heartbeat') {
    const heartbeatPath = `${process.env.HOME}/.openclaw/workspace-main/HEARTBEAT.md`;
    try {
      let hb = fs.readFileSync(heartbeatPath, 'utf8');
      const { operation, observation } = toolInput;
      const nowIso = nowCST();
      const nowLocal = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

      if (operation === 'append_observation') {
        if (!observation) return '错误：append_observation 需要提供 observation 字段';
        const line = `- [${nowLocal}] ${observation}`;
        hb = hb.replace(/(## 待汇总观察[^\n]*\n)/, `$1${line}\n`);
        fs.writeFileSync(heartbeatPath, hb, 'utf8');
        return `已追加观察：${line}`;
      }

      if (operation === 'mark_daily_sent') {
        // 清空待汇总观察节（保留节标题）
        hb = hb.replace(/(## 待汇总观察[^\n]*\n)([\s\S]*?)(## |$)/, (_, heading, _content, next) => {
          return `${heading}\n${next}`;
        });
        // 更新或新增「上次日报发送」字段
        if (hb.includes('- 上次日报发送：')) {
          hb = hb.replace(/- 上次日报发送：.*/, `- 上次日报发送：${nowIso}`);
        } else {
          hb = hb.replace(/(- 上次质量扫描：[^\n]*)/, `$1\n- 上次日报发送：${nowIso}`);
        }
        fs.writeFileSync(heartbeatPath, hb, 'utf8');
        return `日报已标记发送，待汇总观察已清空（${nowLocal}）`;
      }

      return `未知 operation：${operation}`;
    } catch (e) {
      return `update_heartbeat 失败：${e.message}`;
    }
  }

  if (toolName === 'query_pipeline_tasks') {
    try {
      const { status_filter = 'active' } = toolInput;
      const entries = readTaskRegistry();
      const filtered = status_filter === 'all' ? entries
        : status_filter === 'active' ? entries.filter(t => ['queued', 'running', 'pending-review'].includes(t.status))
        : entries.filter(t => t.status === status_filter);
      const order = { 'pending-review': 0, queued: 1, running: 2, completed: 3, failed: 4, cancelled: 5 };
      filtered.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || new Date(b.submittedAt) - new Date(a.submittedAt));
      if (filtered.length === 0) return `✅ 当前无${status_filter === 'all' ? '' : '进行中的'}任务`;
      const lines = filtered.map(t => {
        const age = Math.round((Date.now() - new Date(t.submittedAt)) / 3600000);
        const by = t.submittedBy || '未知';
        return `[${t.status}] ${t.id}\n  ${(t.title || t.requirement || '').slice(0, 60)}\n  提交：${by} | ${age}h 前`;
      });
      return `【流水线任务看板】共 ${filtered.length} 条\n\n${lines.join('\n\n')}`;
    } catch (e) {
      return `query_pipeline_tasks 失败：${e.message}`;
    }
  }

  if (toolName === 'approve_pipeline_task') {
    try {
      const { task_id } = toolInput;
      if (!task_id) return '错误：task_id 必填';
      const entries = readTaskRegistry();
      const idx = entries.findIndex(e => e.id === task_id);
      if (idx === -1) return `任务 ${task_id} 不存在`;
      if (entries[idx].status !== 'pending-review') return `当前状态 ${entries[idx].status}，只有 pending-review 可批准`;
      entries[idx].status = 'queued';
      entries[idx].approvedAt = new Date().toISOString();
      entries[idx].approvedBy = 'se';
      writeTaskRegistry(entries);
      logger.info('SE 批准任务进队列', { taskId: task_id, title: entries[idx].title });
      return `✅ 任务 [${task_id}] 已批准，进入队列等待执行\n标题：${entries[idx].title || entries[idx].requirement || ''}`;
    } catch (e) {
      return `approve_pipeline_task 失败：${e.message}`;
    }
  }

  if (toolName === 'cancel_pipeline_task') {
    try {
      const { task_id, reason = 'SE 叫停' } = toolInput;
      if (!task_id) return '错误：task_id 必填';
      const entries = readTaskRegistry();
      const idx = entries.findIndex(e => e.id === task_id);
      if (idx === -1) return `任务 ${task_id} 不存在`;
      if (['completed', 'cancelled'].includes(entries[idx].status)) return `任务已 ${entries[idx].status}，无法叫停`;
      const prevStatus = entries[idx].status;
      entries[idx].status = 'cancelled';
      entries[idx].cancelledAt = new Date().toISOString();
      entries[idx].cancelledBy = 'se';
      entries[idx].cancelReason = reason;
      writeTaskRegistry(entries);
      logger.info('SE 叫停任务', { taskId: task_id, prevStatus, reason });
      return `✅ 任务 [${task_id}] 已叫停（原状态：${prevStatus}）\n标题：${entries[idx].title || entries[idx].requirement || ''}`;
    } catch (e) {
      return `cancel_pipeline_task 失败：${e.message}`;
    }
  }

  if (toolName === 'log_improvement_task') {
    try {
      const { title, description, priority = 'medium', action_type = 'observe' } = toolInput;
      if (!title || !description) return '错误：title 和 description 必填';

      const entries = readTaskRegistry();
      // 重复检测：queued/pending-review 中存在标题关键词高度重叠的则跳过
      const activeEntries = entries.filter(t => ['queued', 'pending-review', 'running'].includes(t.status));
      const titleWords = title.toLowerCase().split(/[\s，。：、\-\(（\)）]+/).filter(w => w.length >= 3);
      const duplicate = activeEntries.find(t => {
        const existWords = (t.title || t.requirement || '').toLowerCase().split(/[\s，。：、\-\(（\)）]+/).filter(w => w.length >= 3);
        return titleWords.filter(w => existWords.includes(w)).length >= 2;
      });
      if (duplicate) {
        return `⚠️ 已存在类似任务 [${duplicate.id}]：「${duplicate.title || duplicate.requirement}」，跳过重复记录。`;
      }

      const requiresApproval = action_type === 'agents_md';
      const id = `req_main_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
      entries.push({
        id,
        requirement: description,
        title,
        submittedBy: 'main-monitor',
        submittedAt: new Date().toISOString(),
        status: requiresApproval ? 'pending-review' : 'queued',
        taskType: action_type,
        priority,
        requires_approval: requiresApproval,
        source: 'main_monitor',
        lucasAcked: false,
      });
      writeTaskRegistry(entries);
      const actionLabels = { agents_md: '改AGENTS.md（待SE批准）', code_fix: '改代码', readme: '改Readme', observe: '只观察' };
      return `✅ 已记录改进任务 [${id}]：${title}（优先级：${priority} | 动作：${actionLabels[action_type] ?? action_type}）`;
    } catch (e) {
      return `log_improvement_task 失败：${e.message}`;
    }
  }

  // ─── L0~L2 系统评估工具 ──────────────────────────────────────────────────────

  if (toolName === 'evaluate_l0') {
    const results = [];
    let score = '✅';

    // 1. gateway-watchdog 是否在 PM2
    try {
      const pmRaw = execSync('pm2 jlist', { encoding: 'utf8', timeout: 8000 });
      const procs = JSON.parse(pmRaw);
      const wdog  = procs.find(p => p.name === 'gateway-watchdog');
      if (!wdog) {
        results.push('❌ gateway-watchdog：不在 PM2，蒸馏定时触发缺失');
        score = '❌';
      } else if (wdog.pm2_env?.status !== 'online') {
        results.push(`⚠️ gateway-watchdog：状态 ${wdog.pm2_env?.status}（非 online）`);
        if (score === '✅') score = '⚠️';
      } else {
        const restarts = wdog.pm2_env?.restart_time ?? 0;
        results.push(`✅ gateway-watchdog：online（重启 ${restarts} 次）`);
      }
    } catch (e) {
      results.push(`⚠️ gateway-watchdog：检查失败（${e.message.slice(0, 60)}）`);
      if (score === '✅') score = '⚠️';
    }

    // 2. Kuzu 知识图谱 Fact 数量（Python 查询，os._exit(0) 防 SIGBUS）
    const kuzuPath  = path.join(INSTANCE_ROOT, 'Data', 'kuzu');
    const kuzuScript = `
import sys, json, os
sys.path.insert(0, '/opt/homebrew/lib/python3.11/site-packages')
try:
    import kuzu
    db   = kuzu.Database('${kuzuPath}')
    conn = kuzu.Connection(db)
    r1   = conn.execute('MATCH ()-[f:Fact]->() RETURN count(f)')
    facts = r1.get_next()[0]
    r2   = conn.execute("MATCH (e:Entity) WHERE e.type = 'person' RETURN count(e)")
    persons = r2.get_next()[0]
    r3   = conn.execute('MATCH (e:Entity) RETURN count(e)')
    entities = r3.get_next()[0]
    print(json.dumps({'facts': facts, 'persons': persons, 'entities': entities}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
sys.stdout.flush()
os._exit(0)
`.trim();
    try {
      const tmpPy = path.join(INSTANCE_ROOT, 'temp', `eval-l0-kuzu-${Date.now()}.py`);
      fs.mkdirSync(path.join(INSTANCE_ROOT, 'temp'), { recursive: true });
      fs.writeFileSync(tmpPy, kuzuScript);
      const kuzuOut = execSync(`${PYTHON311} ${tmpPy}`, { encoding: 'utf8', timeout: 20000 }).trim();
      try { fs.unlinkSync(tmpPy); } catch (_) {}
      const kd = JSON.parse(kuzuOut);
      if (kd.error) {
        results.push(`⚠️ Kuzu 查询失败：${kd.error.slice(0, 80)}`);
        if (score === '✅') score = '⚠️';
      } else {
        const factsOk = kd.facts > 0;
        results.push(`${factsOk ? '✅' : '⚠️'} Kuzu 知识图谱：${kd.facts} 条 Fact，${kd.entities} 个 Entity（其中 ${kd.persons} 个 Person）`);
        if (!factsOk && score === '✅') score = '⚠️';
      }
    } catch (e) {
      try { } catch (_) {}
      results.push(`⚠️ Kuzu 查询异常：${e.message.slice(0, 80)}`);
      if (score === '✅') score = '⚠️';
    }

    // 3. ChromaDB conversations 总量
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/conversations`);
      if (!colResp.ok) {
        results.push(`❌ ChromaDB conversations 不可达：${colResp.status}`);
        score = '❌';
      } else {
        const { id: colId } = await colResp.json();
        const countResp = await fetch(`${CHROMA_API_BASE}/${colId}/count`);
        const count = countResp.ok ? await countResp.json() : '?';
        results.push(`✅ ChromaDB conversations：${count} 条对话记录`);
      }
    } catch (e) {
      results.push(`⚠️ ChromaDB 查询失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 4. 上次蒸馏时间估算（取 data/family 最新 inject.md 修改时间）
    try {
      const familyDir = path.join(process.env.HOME, '.openclaw', 'workspace-lucas', 'family');
      if (fs.existsSync(familyDir)) {
        const files = fs.readdirSync(familyDir).filter(f => f.endsWith('.inject.md'));
        if (files.length === 0) {
          results.push('⚠️ 家人档案：无 inject.md 文件（蒸馏未生成档案）');
          if (score === '✅') score = '⚠️';
        } else {
          const mtimes = files.map(f => fs.statSync(path.join(familyDir, f)).mtimeMs);
          const latest = new Date(Math.max(...mtimes));
          const hoursAgo = ((Date.now() - latest.getTime()) / 3600000).toFixed(1);
          const stale = parseFloat(hoursAgo) > 48;
          results.push(`${stale ? '⚠️' : '✅'} 家人档案最后更新：${hoursAgo} 小时前（${files.length} 个成员）`);
          if (stale && score === '✅') score = '⚠️';
        }
      } else {
        results.push('⚠️ 家人档案目录不存在');
        if (score === '✅') score = '⚠️';
      }
    } catch (e) {
      results.push(`⚠️ 家人档案检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 5. ChromaDB decisions 集合可达性
    try {
      const decResp = await fetch(`${CHROMA_API_BASE}/decisions`);
      if (!decResp.ok) {
        results.push(`⚠️ ChromaDB decisions 集合不可达：${decResp.status}`);
        if (score === '✅') score = '⚠️';
      } else {
        const { id: decId } = await decResp.json();
        const cntResp = await fetch(`${CHROMA_API_BASE}/${decId}/count`);
        const decCount = cntResp.ok ? await cntResp.json() : '?';
        results.push(`✅ ChromaDB decisions：${decCount} 条决策记忆`);
      }
    } catch (e) {
      results.push(`⚠️ ChromaDB decisions 检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 6. 软硬件性能指标
    try {
      // 6a. 磁盘空间
      const dfRaw = execSync(`df -h "${INSTANCE_ROOT}"`, { encoding: 'utf8', timeout: 5000 });
      const dfLine = dfRaw.split('\n').find(l => l.includes('/'));
      if (dfLine) {
        const parts = dfLine.trim().split(/\s+/);
        const usePct = parts[parts.length - 1]; // e.g. 85%
        const avail = parts[parts.length - 2]; // e.g. 50Gi
        const pct = parseInt(usePct);
        if (pct > 95) {
          results.push(`❌ 磁盘空间：已用 ${usePct}，仅剩 ${avail}（严重不足）`);
          score = '❌';
        } else if (pct > 85) {
          results.push(`⚠️ 磁盘空间：已用 ${usePct}，剩余 ${avail}`);
          if (score === '✅') score = '⚠️';
        } else {
          results.push(`✅ 磁盘空间：已用 ${usePct}，剩余 ${avail}`);
        }
      }
    } catch (e) {
      results.push(`⚠️ 磁盘空间检查失败：${e.message.slice(0, 40)}`);
      if (score === '✅') score = '⚠️';
    }

    try {
      // 6b. 内存使用（macOS vm_stat）
      const vmRaw = execSync('vm_stat', { encoding: 'utf8', timeout: 5000 });
      const freeMatch = vmRaw.match(/Pages free:\s+(\d+)/);
      const activeMatch = vmRaw.match(/Pages active:\s+(\d+)/);
      const inactiveMatch = vmRaw.match(/Pages inactive:\s+(\d+)/);
      if (freeMatch && activeMatch) {
        const pageSize = 16384; // macOS ARM64
        const free = parseInt(freeMatch[1]) * pageSize;
        const active = parseInt(activeMatch[1]) * pageSize;
        const total = free + active + (inactiveMatch ? parseInt(inactiveMatch[1]) * pageSize : 0);
        const usedPct = Math.round(active / total * 100);
        const freeGB = (free / 1073741824).toFixed(1);
        if (usedPct > 90) {
          results.push(`⚠️ 内存：活跃 ${usedPct}%，空闲 ${freeGB}GB（偏高）`);
          if (score === '✅') score = '⚠️';
        } else {
          results.push(`✅ 内存：活跃 ${usedPct}%，空闲 ${freeGB}GB`);
        }
      }
    } catch (e) {
      // vm_stat 非关键，静默跳过
    }

    try {
      // 6c. Gateway 响应延迟
      const gwStart = Date.now();
      const gwResp = await fetch('http://localhost:18789/health', { signal: AbortSignal.timeout(10000) });
      const gwMs = Date.now() - gwStart;
      if (!gwResp.ok) {
        results.push(`❌ Gateway 延迟：响应 ${gwResp.status}（${gwMs}ms）`);
        score = '❌';
      } else if (gwMs > 3000) {
        results.push(`⚠️ Gateway 延迟：${gwMs}ms（偏慢）`);
        if (score === '✅') score = '⚠️';
      } else {
        results.push(`✅ Gateway 延迟：${gwMs}ms`);
      }
    } catch (e) {
      // Gateway 不可达已在 scan_pipeline_health 检查，此处不重复计分
    }

    try {
      // 6d. ChromaDB 响应延迟
      const chrStart = Date.now();
      const chrResp = await fetch(`${CHROMA_API_BASE}/heartbeat`, { signal: AbortSignal.timeout(10000) });
      const chrMs = Date.now() - chrStart;
      if (!chrResp.ok) {
        results.push(`⚠️ ChromaDB 延迟：响应 ${chrResp.status}（${chrMs}ms）`);
        if (score === '✅') score = '⚠️';
      } else if (chrMs > 2000) {
        results.push(`⚠️ ChromaDB 延迟：${chrMs}ms（偏慢）`);
        if (score === '✅') score = '⚠️';
      } else {
        results.push(`✅ ChromaDB 延迟：${chrMs}ms`);
      }
    } catch (e) {
      // ChromaDB 不可达已在其他检查覆盖
    }

    // 7. Kuzu 协作边数量（L3 数据就绪信号，co_discusses/requests_from/supports/role_in_context）
    const collabScript = `
import sys, json, os
sys.path.insert(0, '/opt/homebrew/lib/python3.11/site-packages')
try:
    import kuzu
    db   = kuzu.Database('${kuzuPath}')
    conn = kuzu.Connection(db)
    counts = {}
    for rel in ['co_discusses', 'requests_from', 'supports', 'role_in_context', 'active_thread']:
        r = conn.execute("MATCH ()-[f:Fact {relation: '" + rel + "'}]->() RETURN count(f)")
        counts[rel] = r.get_next()[0] if r.has_next() else 0
    collab_total = sum(v for k, v in counts.items() if k != 'active_thread')
    print(json.dumps({'counts': counts, 'total': collab_total}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
sys.stdout.flush()
os._exit(0)
`.trim();
    try {
      const tmpCollab = path.join(INSTANCE_ROOT, 'temp', `eval-l0-collab-${Date.now()}.py`);
      fs.mkdirSync(path.join(INSTANCE_ROOT, 'temp'), { recursive: true });
      fs.writeFileSync(tmpCollab, collabScript);
      const collabOut = execSync(`${PYTHON311} ${tmpCollab}`, { encoding: 'utf8', timeout: 20000 }).trim();
      try { fs.unlinkSync(tmpCollab); } catch (_) {}
      const cd = JSON.parse(collabOut);
      if (cd.error) {
        results.push(`⚠️ Kuzu 协作边查询失败：${cd.error.slice(0, 80)}`);
        if (score === '✅') score = '⚠️';
      } else {
        const c = cd.counts || {};
        const detail = Object.entries(c)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}:${v}`)
          .join(' / ') || '无';
        results.push(`${cd.total > 0 ? '✅' : '⚪'} Kuzu 协作边（L3）：${cd.total} 条（${detail}）`);
      }
    } catch (e) {
      results.push(`⚠️ Kuzu 协作边查询异常：${e.message.slice(0, 80)}`);
      if (score === '✅') score = '⚠️';
    }

    // 8. 四维度记忆写入健康（三角色：语义/时间/实体/因果）
    const _memCollections = [
      { name: 'conversations', label: 'Lucas', entityField: 'entityTags', hasCausal: true  },
      { name: 'decisions',     label: 'Andy',  entityField: 'agent',      hasCausal: false },
      { name: 'code_history',  label: 'Lisa',  entityField: 'file',       hasCausal: false },
    ];
    for (const mc of _memCollections) {
      try {
        const mcColResp = await fetch(`${CHROMA_API_BASE}/${mc.name}`);
        if (!mcColResp.ok) {
          results.push(`⚠️ ${mc.label} 记忆集合(${mc.name})不可达：${mcColResp.status}`);
          if (score === '✅') score = '⚠️';
          continue;
        }
        const { id: mcId } = await mcColResp.json();
        const mcGetResp = await fetch(`${CHROMA_API_BASE}/${mcId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 20, include: ['embeddings', 'metadatas'] }),
        });
        if (!mcGetResp.ok) {
          results.push(`⚠️ ${mc.label} 记忆写入健康：读取失败 ${mcGetResp.status}`);
          if (score === '✅') score = '⚠️';
          continue;
        }
        const mcData  = await mcGetResp.json();
        const mcMetas = mcData.metadatas || [];
        const mcEmbs  = mcData.embeddings || [];
        const mcTotal = mcMetas.length;
        if (mcTotal === 0) {
          results.push(`⚪ ${mc.label} 记忆写入健康：集合暂无记录`);
          continue;
        }
        // 语义维度：embedding 向量有效率（非 null / 非全零）
        const validEmb = mcEmbs.filter(e => e && e.length > 0 && e.some(v => v !== 0)).length;
        const embRate  = Math.round(validEmb / mcTotal * 100);
        // 时间维度：timestamp 字段完整率 + 最近写入时间
        const withTs      = mcMetas.filter(m => m.timestamp).length;
        const tsRate      = Math.round(withTs / mcTotal * 100);
        const tsValues    = mcMetas.filter(m => m.timestamp).map(m => new Date(m.timestamp).getTime()).filter(t => !isNaN(t));
        const latestTsMs  = tsValues.length > 0 ? Math.max(...tsValues) : 0;
        const writeHrsAgo = latestTsMs > 0 ? ((Date.now() - latestTsMs) / 3600000).toFixed(1) : null;
        // 实体维度：entityField 填充率
        const withEnt = mcMetas.filter(m => m[mc.entityField] && String(m[mc.entityField]).trim().length > 0).length;
        const entRate = Math.round(withEnt / mcTotal * 100);
        // 因果维度：causal 相关记录（仅 Lucas）
        let causalNote = '';
        if (mc.hasCausal) {
          const causalCnt = mcMetas.filter(m =>
            (m.type     && String(m.type).toLowerCase().includes('causal')) ||
            (m.relation && String(m.relation).toLowerCase().includes('causal'))
          ).length;
          causalNote = ` 因果⚪${causalCnt}条`;
        }
        // 综合判断
        const embStatus = embRate >= 80 ? '✅' : (embRate >= 50 ? '⚠️' : '❌');
        const tsStatus  = tsRate  >= 90 ? '✅' : '⚠️';
        const entStatus = entRate >= 50 ? '✅' : '⚪';
        const dimOk     = embRate >= 80 && tsRate >= 90;
        const timeNote  = writeHrsAgo !== null ? ` · 最近写入：${writeHrsAgo}小时前` : '';
        results.push(
          `${dimOk ? '✅' : '⚠️'} ${mc.label} 记忆写入健康（最近${mcTotal}条）：` +
          `语义${embStatus}${embRate}% 时间${tsStatus}${tsRate}% 实体${entStatus}${entRate}%${causalNote}${timeNote}`
        );
        if (!dimOk && score === '✅') score = '⚠️';
      } catch (e) {
        results.push(`⚠️ ${mc.label} 记忆写入健康检查失败：${e.message.slice(0, 60)}`);
        if (score === '✅') score = '⚠️';
      }
    }

    // 9. 家人档案注入文件完整性（L0 写入侧：Kuzu→inject.md 蒸馏产物）
    try {
      const familyDir = path.join(process.env.HOME, '.openclaw', 'workspace-lucas', 'family');
      if (!fs.existsSync(familyDir)) {
        results.push('⚠️ 家人档案目录不存在（before_prompt_build 注入将失败）');
        if (score === '✅') score = '⚠️';
      } else {
        const injects = fs.readdirSync(familyDir).filter(f => f.endsWith('.inject.md'));
        results.push(`${injects.length > 0 ? '✅' : '⚠️'} 家人档案注入文件：${injects.length} 个（${injects.map(f => f.replace('.inject.md', '')).join(', ') || '无'}）`);
        if (injects.length === 0 && score === '✅') score = '⚠️';
      }
    } catch (e) {
      results.push(`⚠️ 档案注入文件检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 10. Andy/Lisa 蒸馏产出（L0 蒸馏管道：design_learning / impl_learning）
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/decisions`);
      if (colResp.ok) {
        const { id: colId } = await colResp.json();
        // Andy design_learning
        const andyResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            where: { '$and': [{ agent: { '$eq': 'andy' } }, { type: { '$eq': 'design_learning' } }] },
            include: ['metadatas'], limit: 50,
          }),
        });
        const andyData = andyResp.ok ? await andyResp.json() : { ids: [] };
        const andyDistillCount = (andyData.ids || []).length;
        // Lisa impl_learning
        const lisaResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            where: { '$and': [{ agent: { '$eq': 'lisa' } }, { type: { '$eq': 'impl_learning' } }] },
            include: ['metadatas'], limit: 50,
          }),
        });
        const lisaData = lisaResp.ok ? await lisaResp.json() : { ids: [] };
        const lisaDistillCount = (lisaData.ids || []).length;
        const hasLearnings = andyDistillCount > 0 || lisaDistillCount > 0;
        results.push(`${hasLearnings ? '✅' : '⚠️'} Andy/Lisa 蒸馏产出：design_learning ${andyDistillCount} 条，impl_learning ${lisaDistillCount} 条${!hasLearnings ? '（尚未运行，每日凌晨 1 点触发）' : ''}`);
        if (!hasLearnings && score === '✅') score = '⚠️';
      }
    } catch (e) {
      results.push(`⚠️ Andy/Lisa 蒸馏产出检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // T. 外循环教师测试：时间分层退化检测（conversations 近30天 vs 90天前 embedding 有效率对比）
    // 真实数据直接比较，不合成——检测 L0 写入质量是否随时间退化
    let _temporalDegradationDiff = null;
    try {
      const tdColR = await fetch(`${CHROMA_API_BASE}/conversations`);
      if (tdColR.ok) {
        const { id: tdColId } = await tdColR.json();
        const tdGetR = await fetch(`${CHROMA_API_BASE}/${tdColId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 400, include: ['embeddings', 'metadatas'] }),
        });
        if (tdGetR.ok) {
          const tdData  = await tdGetR.json();
          const tdMetas = tdData.metadatas  || [];
          const tdEmbs  = tdData.embeddings || [];
          const nowMs   = Date.now();
          const _30d    = 30 * 24 * 3600 * 1000;
          const _90d    = 90 * 24 * 3600 * 1000;
          const nearIdx = [], oldIdx = [];
          tdMetas.forEach((m, i) => {
            if (!m || !m.timestamp) return;
            const ts = new Date(m.timestamp).getTime();
            if (isNaN(ts)) return;
            const age = nowMs - ts;
            if (age < _30d) nearIdx.push(i);
            else if (age > _90d) oldIdx.push(i);
          });
          const calcRate = (idxArr) => {
            const sample = idxArr.slice(0, 50);
            if (sample.length === 0) return null;
            const valid = sample.filter(i => { const e = tdEmbs[i]; return e && e.length > 0 && e.some(v => v !== 0); }).length;
            return Math.round(valid / sample.length * 100);
          };
          const nearRate = calcRate(nearIdx);
          const oldRate  = calcRate(oldIdx);
          if (nearRate !== null && oldRate !== null) {
            _temporalDegradationDiff = nearRate - oldRate; // 正值=历史期更差
            const degradeOk = _temporalDegradationDiff < 20;
            const sign = _temporalDegradationDiff > 0 ? `历史期低 ${_temporalDegradationDiff}pp` : `历史期不低于近期`;
            results.push(
              `${degradeOk ? '✅' : '⚠️'} 时间分层退化检测（教师工具）：近30天 ${nearRate}%，90天前 ${oldRate}%（${sign}${_temporalDegradationDiff >= 20 ? '，存在退化趋势' : ''}）`
            );
            if (!degradeOk && score === '✅') score = '⚠️';
          } else {
            results.push(`⚪ 时间分层退化检测：数据不足（近30天 ${nearIdx.length} 条，90天前 ${oldIdx.length} 条）`);
          }
        }
      }
    } catch (e) {
      results.push(`⚪ 时间分层退化检测失败：${e.message.slice(0, 60)}`);
    }

    // 数值评分：从 results 文本提取原始值，对照 rubric 计算 0-5 分
    const _rub0 = loadRubric();
    const _L0I = _rub0?.layers?.L0?.items;
    const _l0s = [];
    if (_L0I) {
      for (const r of results) {
        if (r.includes('gateway-watchdog')) trackScore(_l0s, _L0I, 'process_alive', r.includes('online') ? 'online' : (r.includes('不在') ? 'missing' : 'stopped'));
        if (r.includes('Kuzu 知识图谱')) { const m = r.match(/(\d+) 条 Fact/); if (m) trackScore(_l0s, _L0I, 'kuzu_data', +m[1]); }
        if (r.includes('ChromaDB conversations')) trackScore(_l0s, _L0I, 'chromadb_conversations', r.trim().startsWith('✅') ? 'reachable' : 'unreachable');
        if (r.includes('家人档案最后更新')) { const m = r.match(/([\d.]+) 小时前/); if (m) trackScore(_l0s, _L0I, 'data_freshness', +m[1]); }
        else if (r.includes('家人档案新鲜度') || (r.includes('家人档案') && !r.includes('注入文件'))) trackScore(_l0s, _L0I, 'data_freshness', 9999);
        if (r.includes('ChromaDB decisions') && !r.includes('延迟') && !r.includes('蒸馏')) trackScore(_l0s, _L0I, 'chromadb_decisions', r.trim().startsWith('✅') ? 'reachable' : 'unreachable');
        if (r.includes('磁盘空间')) { const m = r.match(/已用 (\d+)%/); if (m) trackScore(_l0s, _L0I, 'disk_space', +m[1]); }
        if (r.includes('Gateway 延迟')) { const m = r.match(/(\d+)ms/); if (m) trackScore(_l0s, _L0I, 'gateway_latency', +m[1]); }
        if (r.includes('ChromaDB 延迟')) { const m = r.match(/(\d+)ms/); if (m) trackScore(_l0s, _L0I, 'chromadb_latency', +m[1]); }
        if (r.includes('内存') && r.includes('活跃')) { const m = r.match(/活跃 (\d+)%/); if (m) trackScore(_l0s, _L0I, 'memory_usage', +m[1]); }
        if (r.includes('家人档案注入文件')) { const m = r.match(/(\d+) 个/); if (m) trackScore(_l0s, _L0I, 'family_inject', +m[1]); }
        if (r.includes('Andy/Lisa 蒸馏产出')) { const ac = (+((r.match(/design_learning (\d+)/)?.[1] || '0')) > 0); const lc = (+((r.match(/impl_learning (\d+)/)?.[1] || '0')) > 0); trackScore(_l0s, _L0I, 'distillation_output', ac && lc ? 'both_active' : (ac || lc ? 'one_active' : 'none_active')); }
      }
      // 记忆写入健康：取三角色 embedding 有效率最低值
      let _minEmbRate = null;
      for (const r of results) {
        if (r.includes('记忆写入健康')) {
          const m = r.match(/语义[✅⚠️❌](\d+)%/);
          if (m) { const rate = +m[1]; if (_minEmbRate === null || rate < _minEmbRate) _minEmbRate = rate; }
        }
      }
      if (_minEmbRate !== null) trackScore(_l0s, _L0I, 'memory_write_health', _minEmbRate);
      if (_temporalDegradationDiff !== null) trackScore(_l0s, _L0I, 'temporal_degradation', _temporalDegradationDiff);
      if (_l0s.length > 0) {
        const _wa = calcWeightedAvg(_l0s);
        _evalScores.L0 = { items: _l0s, weighted: _wa };
        score += ` · ${_wa.toFixed(1)}/5.0`;
      }
    }
    return `**L0 评估 ${score}**\n${results.map(r => `  ${r}`).join('\n')}`;
  }

  if (toolName === 'evaluate_l1') {
    const results = [];
    let score = '✅';

    // 1. Lucas 质量扫描（复用 scan_lucas_quality 逻辑）
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/conversations`);
      if (!colResp.ok) {
        results.push(`❌ Lucas：ChromaDB 不可达`);
        score = '❌';
      } else {
        const { id: colId } = await colResp.json();
        const getResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ where: { fromType: { '$eq': 'human' } }, include: ['documents', 'metadatas'], limit: 30 }),
        });
        if (!getResp.ok) {
          results.push(`⚠️ Lucas：ChromaDB 查询失败 ${getResp.status}`);
          if (score === '✅') score = '⚠️';
        } else {
          const data = await getResp.json();
          const docs  = data.documents || [];
          const metas = data.metadatas || [];
          const MARKDOWN_TITLE_RE = /^#{1,4}\s+.{2,40}$/m;
          // 精确承诺词：只检测强承诺动词，排除「已了解/已知道/已确认」等合理用法
          const COMMITMENT_RE = /已(提交|修复|告知|报告|转告|安排)(?!了解|知道|确认)/;
          let lucasIssues = 0;
          docs.forEach((doc, i) => {
            const reply = ((metas[i] || {}).response || doc || '').toString();
            if (!reply || reply.trim().length < 5) lucasIssues++;
            else if (MARKDOWN_TITLE_RE.test(reply)) lucasIssues++;
            else if (COMMITMENT_RE.test(reply)) lucasIssues++;
          });
          const issueRate = docs.length > 0 ? (lucasIssues / docs.length * 100).toFixed(0) : 0;
          const ok = lucasIssues <= 2;
          results.push(`${ok ? '✅' : '⚠️'} Lucas 质量：最近 ${docs.length} 条，${lucasIssues} 条疑似问题（问题率 ${issueRate}%）`);
          if (!ok && score === '✅') score = '⚠️';
        }
      }
    } catch (e) {
      results.push(`⚠️ Lucas 质量扫描失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 2. Andy/Lisa agent_interactions 抽查
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/agent_interactions`);
      if (!colResp.ok) {
        results.push(`⚠️ Andy/Lisa：agent_interactions 集合不可达`);
        if (score === '✅') score = '⚠️';
      } else {
        const { id: colId } = await colResp.json();
        const getResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ include: ['metadatas'], limit: 20 }),
        });
        if (getResp.ok) {
          const data  = await getResp.json();
          const metas = data.metadatas || [];
          const andyCount = metas.filter(m => (m.agentId || '').toLowerCase().includes('andy')).length;
          const lisaCount = metas.filter(m => (m.agentId || '').toLowerCase().includes('lisa')).length;
          results.push(`✅ Andy/Lisa 活跃：最近 20 条交互中 Andy ${andyCount} 条，Lisa ${lisaCount} 条`);
        } else {
          results.push(`⚠️ agent_interactions 查询失败：${getResp.status}`);
          if (score === '✅') score = '⚠️';
        }
      }
    } catch (e) {
      results.push(`⚠️ agent_interactions 检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 3. Kuzu has_pattern 积累量（Andy/Lisa 行为模式蒸馏节点数）
    const l1KuzuPath = path.join(INSTANCE_ROOT, 'Data', 'kuzu');
    try {
      const kuzuCheck = path.join(INSTANCE_ROOT, 'temp', `_l1_pattern_check_${Date.now()}.py`);
      fs.mkdirSync(path.join(INSTANCE_ROOT, 'temp'), { recursive: true });
      const script = `import sys, os, json
try:
    import kuzu
    db   = kuzu.Database("${l1KuzuPath}")
    conn = kuzu.Connection(db)
    counts = {}
    for agent in ['andy', 'lisa']:
        res = conn.execute(
            "MATCH (a:Entity {id: $aid})-[f:Fact {relation: 'has_pattern'}]->(p:Entity) "
            "WHERE f.valid_until IS NULL RETURN count(*)",
            {'aid': agent}
        )
        counts[agent] = res.get_next()[0] if res.has_next() else 0
    sys.stdout.write(json.dumps(counts))
    sys.stdout.flush()
except Exception as e:
    sys.stdout.write(json.dumps({'error': str(e)}))
    sys.stdout.flush()
os._exit(0)
`;
      fs.writeFileSync(kuzuCheck, script);
      const { execFileSync } = require('child_process');
      const out = execFileSync(PYTHON311, [kuzuCheck], { timeout: 20_000, encoding: 'utf8' }).trim();
      fs.unlinkSync(kuzuCheck);
      const counts = JSON.parse(out || '{}');
      if (counts.error) {
        results.push(`⚠️ Kuzu 模式积累查询失败：${counts.error.slice(0, 60)}`);
      } else {
        const andyP = counts.andy || 0;
        const lisaP = counts.lisa || 0;
        results.push(`${(andyP > 0 && lisaP > 0) ? '✅' : '⚠️'} Kuzu 模式积累：Andy ${andyP} 条，Lisa ${lisaP} 条 has_pattern`);
        if (andyP === 0 || lisaP === 0) {
          if (score === '✅') score = '⚠️';
        }
      }
    } catch (e) {
      results.push(`⚠️ Kuzu has_pattern 检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 6. Main 健康检查（HEARTBEAT 正常运行 + 最近日志无异常）
    try {
      const hbPath = path.join(process.env.HOME, '.openclaw', 'workspace-main', 'HEARTBEAT.md');
      if (fs.existsSync(hbPath)) {
        const hbContent = fs.readFileSync(hbPath, 'utf8');
        const lastCheck = hbContent.match(/上次健康检查：(.+)/);
        const lastQuality = hbContent.match(/上次质量扫描：(.+)/);
        const pending = (hbContent.match(/^- \[.*\]/gm) || []).length;
        results.push(`✅ Main：HEARTBEAT 正常（上次检查 ${lastCheck ? lastCheck[1].slice(0, 19) : '未知'}，待汇总 ${pending} 条）`);
      } else {
        results.push('⚠️ Main：HEARTBEAT.md 不存在');
        if (score === '✅') score = '⚠️';
      }
    } catch (e) {
      results.push(`⚠️ Main 检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 7. Lucas 子 Agent（访客影子 / evaluator）活跃度
    try {
      // 访客影子
      const shadowDir = path.join(INSTANCE_ROOT, 'Data', 'corpus');
      const shadowFiles = fs.existsSync(shadowDir) ? fs.readdirSync(shadowDir).filter(f => f.startsWith('shadow-')) : [];
      results.push(`${shadowFiles.length > 0 ? '✅' : '⚪'} Lucas 子 Agent：${shadowFiles.length} 个访客影子语料`);

      // evaluator 活跃度（从 agent_interactions 查 andy-evaluator / lisa-evaluator）
      const colResp = await fetch(`${CHROMA_API_BASE}/agent_interactions`);
      if (colResp.ok) {
        const { id: colId } = await colResp.json();
        for (const evalAgent of ['andy-evaluator', 'lisa-evaluator']) {
          const evalResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ where: { agentId: { '$eq': evalAgent } }, include: ['metadatas'], limit: 5 }),
          });
          if (evalResp.ok) {
            const evalData = await evalResp.json();
            const evalCount = (evalData.ids || []).length;
            results.push(`${evalCount > 0 ? '✅' : '⚪'} ${evalAgent}：最近 ${evalCount} 条交互`);
          }
        }
      }
    } catch (e) {
      results.push(`⚠️ 子 Agent 检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 6. Skill 自动沉淀（L1 人格完整度：native + archive skills 积累状态）
    try {
      const nativeBase = path.join(process.env.HOME, '.openclaw');
      let nativeTotal = 0;
      const nativePerAgent = {};
      for (const agent of ['lucas', 'andy', 'lisa']) {
        const skillsDir = path.join(nativeBase, `workspace-${agent}`, 'skills');
        const cnt = fs.existsSync(skillsDir)
          ? fs.readdirSync(skillsDir).filter(f => fs.statSync(path.join(skillsDir, f)).isDirectory()).length
          : 0;
        nativePerAgent[agent] = cnt;
        nativeTotal += cnt;
      }
      const archiveBase = path.join(INSTANCE_ROOT, 'Data', 'learning', 'auto-skills');
      let archiveTotal = 0;
      if (fs.existsSync(archiveBase)) {
        for (const agent of ['lucas', 'andy', 'lisa']) {
          const agentArchive = path.join(archiveBase, agent);
          if (fs.existsSync(agentArchive)) {
            archiveTotal += fs.readdirSync(agentArchive).filter(f => f.endsWith('.md')).length;
          }
        }
      }
      const skCandPath = path.join(INSTANCE_ROOT, 'Data', 'learning', 'skill-candidates.jsonl');
      let skPending = 0;
      if (fs.existsSync(skCandPath)) {
        const lines = fs.readFileSync(skCandPath, 'utf8').split('\n').filter(Boolean);
        skPending = lines.filter(l => { try { return JSON.parse(l).status === 'pending'; } catch { return false; } }).length;
      }
      const skillOk = nativeTotal >= 5;
      const agentDetail = Object.entries(nativePerAgent).map(([a, c]) => `${a}:${c}`).join('/');
      results.push(`${skillOk ? '✅' : '⚠️'} Skill 自动沉淀：native ${nativeTotal} 个（${agentDetail}），archive ${archiveTotal} 个，待处理 ${skPending} 条`);
      if (!skillOk && score === '✅') score = '⚠️';
    } catch (e) {
      results.push(`⚠️ Skill 沉淀检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // X. 三角色记忆召回质量（四维度 canary 查询：语义/时间/实体/因果）
    const _recallTests = [
      { collection: 'conversations', label: 'Lucas', query: '家庭日常对话',     entityField: 'entityTags', hasCausal: true  },
      { collection: 'decisions',     label: 'Andy',  query: '系统设计方案架构', entityField: 'agent',      hasCausal: false },
      { collection: 'code_history',  label: 'Lisa',  query: '代码实现交付',     entityField: 'file',       hasCausal: false },
    ];
    for (const rt of _recallTests) {
      try {
        // 获取 canary query 的 embedding
        const embR = await fetch('http://localhost:11434/api/embed', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'nomic-embed-text', input: rt.query }),
          signal: AbortSignal.timeout(15000),
        });
        if (!embR.ok) {
          results.push(`⚠️ ${rt.label} 召回质量：Ollama embedding 不可达 ${embR.status}`);
          if (score === '✅') score = '⚠️';
          continue;
        }
        const embJson  = await embR.json();
        const queryVec = embJson.embeddings?.[0];
        if (!queryVec || queryVec.length === 0) {
          results.push(`⚠️ ${rt.label} 召回质量：embedding 返回为空`);
          if (score === '✅') score = '⚠️';
          continue;
        }
        // 获取集合 ID
        const rcColR = await fetch(`${CHROMA_API_BASE}/${rt.collection}`);
        if (!rcColR.ok) {
          results.push(`⚠️ ${rt.label} 召回质量：集合 ${rt.collection} 不可达`);
          if (score === '✅') score = '⚠️';
          continue;
        }
        const { id: rcId } = await rcColR.json();
        // 语义 top-3 查询
        const qR = await fetch(`${CHROMA_API_BASE}/${rcId}/query`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query_embeddings: [queryVec], n_results: 3, include: ['distances', 'metadatas'] }),
          signal: AbortSignal.timeout(15000),
        });
        if (!qR.ok) {
          results.push(`⚠️ ${rt.label} 召回质量：查询失败 ${qR.status}`);
          if (score === '✅') score = '⚠️';
          continue;
        }
        const qData     = await qR.json();
        const distances = qData.distances?.[0] || [];
        const qMetas    = qData.metadatas?.[0]  || [];
        if (distances.length === 0) {
          results.push(`⚪ ${rt.label} 召回质量：集合为空，跳过`);
          continue;
        }
        // 语义维度：avg cosine distance（越低越好）
        const avgDist   = distances.reduce((a, b) => a + b, 0) / distances.length;
        const semStatus = avgDist < 0.4 ? '✅' : (avgDist < 0.65 ? '⚠️' : '❌');
        // 时间维度：结果中最近记录距今多久
        const qTs      = qMetas.filter(m => m.timestamp).map(m => new Date(m.timestamp).getTime()).filter(t => !isNaN(t));
        const qLatest  = qTs.length > 0 ? Math.max(...qTs) : 0;
        const qHrsAgo  = qLatest > 0 ? ((Date.now() - qLatest) / 3600000).toFixed(1) : null;
        const tsStatus2 = qHrsAgo !== null ? (parseFloat(qHrsAgo) < 48 ? '✅' : '⚠️') : '⚪';
        const timeNote2 = qHrsAgo !== null ? ` 时间${tsStatus2}最近结果${qHrsAgo}h前` : '';
        // 实体维度：结果中 entityField 填充率
        const qWithEnt  = qMetas.filter(m => m[rt.entityField] && String(m[rt.entityField]).trim().length > 0).length;
        const qEntRate  = qMetas.length > 0 ? Math.round(qWithEnt / qMetas.length * 100) : 0;
        const entStatus2 = qEntRate >= 60 ? '✅' : '⚪';
        // 因果维度：结果中含因果记录（仅 Lucas）
        let causalNote2 = '';
        if (rt.hasCausal) {
          const qCausal = qMetas.filter(m =>
            (m.type     && String(m.type).toLowerCase().includes('causal')) ||
            (m.relation && String(m.relation).toLowerCase().includes('causal'))
          ).length;
          causalNote2 = ` 因果⚪${qCausal}条`;
        }
        const recallOk = avgDist < 0.65;
        results.push(
          `${recallOk ? '✅' : '⚠️'} ${rt.label} 召回质量（"${rt.query}"，top-${distances.length}）：` +
          `语义${semStatus}avg_dist=${avgDist.toFixed(3)}${timeNote2} 实体${entStatus2}${qEntRate}%${causalNote2}`
        );
        if (!recallOk && score === '✅') score = '⚠️';
      } catch (e) {
        results.push(`⚠️ ${rt.label} 召回质量检查失败：${e.message.slice(0, 60)}`);
        if (score === '✅') score = '⚠️';
      }
    }

    // T1. 外循环教师测试：时间跨度召回（90天前真实用户消息 Hit Rate@3）
    // 从 conversations 取真实历史消息，embed 后查 top-3，检验历史记忆是否可召回
    let _teacherHitCount = 0, _teacherTestCount = 0;
    try {
      const tcColR = await fetch(`${CHROMA_API_BASE}/conversations`);
      if (tcColR.ok) {
        const { id: tcColId } = await tcColR.json();
        const tcGetR = await fetch(`${CHROMA_API_BASE}/${tcColId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 300, include: ['documents', 'metadatas', 'ids'] }),
        });
        if (tcGetR.ok) {
          const tcData  = await tcGetR.json();
          const tcDocs  = tcData.documents  || [];
          const tcMetas = tcData.metadatas  || [];
          const tcIds   = tcData.ids        || [];
          const _90dAgo = Date.now() - 90 * 24 * 3600 * 1000;
          const oldHumanIdx = [];
          tcMetas.forEach((m, i) => {
            if (!m || !m.timestamp) return;
            const ts = new Date(m.timestamp).getTime();
            if (isNaN(ts) || ts > _90dAgo) return;
            if (m.fromType !== 'human') return;
            if (!tcDocs[i] || tcDocs[i].length < 10) return;
            oldHumanIdx.push(i);
          });
          if (oldHumanIdx.length === 0) {
            results.push(`⚪ 外循环教师召回测试：90天前消息不足，系统数据较新，跳过`);
          } else {
            const sample = oldHumanIdx.sort(() => Math.random() - 0.5).slice(0, 3);
            _teacherTestCount = sample.length;
            for (const idx of sample) {
              try {
                const embR3 = await fetch('http://localhost:11434/api/embed', {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ model: 'nomic-embed-text', input: tcDocs[idx].slice(0, 500) }),
                  signal: AbortSignal.timeout(15000),
                });
                if (!embR3.ok) continue;
                const embJ3  = await embR3.json();
                const qVec3  = embJ3.embeddings?.[0];
                if (!qVec3 || qVec3.length === 0) continue;
                const qR3 = await fetch(`${CHROMA_API_BASE}/${tcColId}/query`, {
                  method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ query_embeddings: [qVec3], n_results: 3, include: ['ids'] }),
                  signal: AbortSignal.timeout(15000),
                });
                if (!qR3.ok) continue;
                const qD3 = await qR3.json();
                if ((qD3.ids?.[0] || []).includes(tcIds[idx])) _teacherHitCount++;
              } catch (_) { /* 单条失败不影响其他 */ }
            }
            const hitPct = Math.round(_teacherHitCount / _teacherTestCount * 100);
            const hitOk  = _teacherHitCount >= Math.ceil(_teacherTestCount / 2);
            results.push(
              `${hitOk ? '✅' : '⚠️'} 外循环教师召回测试（90天前真实消息 ${_teacherTestCount} 条）：` +
              `Hit@3 ${_teacherHitCount}/${_teacherTestCount}（${hitPct}%）${hitOk ? '' : '——历史记忆召回能力需关注'}`
            );
            if (!hitOk && score === '✅') score = '⚠️';
          }
        }
      }
    } catch (e) {
      results.push(`⚪ 外循环教师召回测试失败：${e.message.slice(0, 60)}`);
    }

    // T2. 外循环教师测试：未落地需求承诺追踪（requirements outcome='' 且 >30天）
    let _unresolvedReqCount = 0;
    try {
      const reqColR = await fetch(`${CHROMA_API_BASE}/requirements`);
      if (reqColR.ok) {
        const { id: reqColId } = await reqColR.json();
        const reqGetR = await fetch(`${CHROMA_API_BASE}/${reqColId}/get`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 200, include: ['metadatas'] }),
        });
        if (reqGetR.ok) {
          const reqData  = await reqGetR.json();
          const reqMetas = reqData.metadatas || [];
          const _30dAgo  = Date.now() - 30 * 24 * 3600 * 1000;
          _unresolvedReqCount = reqMetas.filter(m => {
            if (!m) return false;
            if (m.outcome && m.outcome !== '') return false;
            if (!m.timestamp) return true; // 无时间戳保守计入
            const ts = new Date(m.timestamp).getTime();
            return !isNaN(ts) && ts < _30dAgo;
          }).length;
          const reqOk = _unresolvedReqCount <= 3;
          results.push(
            `${reqOk ? '✅' : '⚠️'} 未落地需求追踪（教师工具）：${_unresolvedReqCount} 条需求 outcome='' 且 >30天${!reqOk ? '——承诺遗忘风险需关注' : ''}`
          );
          if (!reqOk && score === '✅') score = '⚠️';
        }
      } else {
        results.push(`⚪ 未落地需求追踪：requirements 集合不可达`);
      }
    } catch (e) {
      results.push(`⚪ 未落地需求追踪：${e.message.slice(0, 60)}`);
    }

    // 数值评分
    const _rub1 = loadRubric();
    const _L1I = _rub1?.layers?.L1?.items;
    const _l1s = [];
    if (_L1I) {
      for (const r of results) {
        if (r.includes('Lucas 质量')) { const m = r.match(/问题率 (\d+)%/); if (m) trackScore(_l1s, _L1I, 'lucas_output_quality', +m[1]); }
        if (r.includes('Andy/Lisa 活跃') || r.includes('Andy/Lisa：')) { const ac = (+((r.match(/Andy (\d+)/)?.[1] || '0')) > 0); const lc = (+((r.match(/Lisa (\d+)/)?.[1] || '0')) > 0); trackScore(_l1s, _L1I, 'agent_interactions', ac && lc ? 'both_active' : (ac || lc ? 'one_active' : 'none_active')); }
        if (r.includes('Kuzu 模式积累')) { const ac = (+((r.match(/Andy (\d+)/)?.[1] || '0')) > 0); const lc = (+((r.match(/Lisa (\d+)/)?.[1] || '0')) > 0); trackScore(_l1s, _L1I, 'pattern_accumulation', ac && lc ? 'both_active' : (ac || lc ? 'one_active' : 'none_active')); }
        if (r.includes('Main') && r.includes('HEARTBEAT')) trackScore(_l1s, _L1I, 'main_heartbeat', r.trim().startsWith('✅') ? 'ok' : 'missing');
        if (r.includes('Skill 自动沉淀')) { const m = r.match(/native (\d+) 个/); if (m) trackScore(_l1s, _L1I, 'skill_accumulation', +m[1]); }
        if (r.includes('子 Agent') || r.includes('andy-evaluator') || r.includes('lisa-evaluator')) { /* scored separately below */ }
        if (r.includes('召回质量') && r.includes('avg_dist=')) { /* aggregated below */ }
      }
      // 子 Agent 活跃度（汇总 evaluator + shadow 计数）
      let subCount = 0;
      for (const r of results) {
        if (r.includes('andy-evaluator') && r.trim().startsWith('✅')) subCount++;
        if (r.includes('lisa-evaluator') && r.trim().startsWith('✅')) subCount++;
        if (r.includes('访客影子语料') && !r.includes('0 个')) subCount++;
      }
      trackScore(_l1s, _L1I, 'sub_agent_activity', subCount);
      // 记忆召回质量：取三角色 avg_dist 均值
      let _recDistSum = 0, _recDistCnt = 0;
      for (const r of results) {
        if (r.includes('召回质量') && r.includes('avg_dist=')) {
          const m = r.match(/avg_dist=([\d.]+)/); if (m) { _recDistSum += parseFloat(m[1]); _recDistCnt++; }
        }
      }
      if (_recDistCnt > 0) trackScore(_l1s, _L1I, 'memory_recall_quality', _recDistSum / _recDistCnt);
      // 外循环教师测试指标
      if (_teacherTestCount > 0) trackScore(_l1s, _L1I, 'teacher_hit_rate', Math.round(_teacherHitCount / _teacherTestCount * 100));
      trackScore(_l1s, _L1I, 'unresolved_requirements', _unresolvedReqCount);
      if (_l1s.length > 0) {
        const _wa = calcWeightedAvg(_l1s);
        _evalScores.L1 = { items: _l1s, weighted: _wa };
        score += ` · ${_wa.toFixed(1)}/5.0`;
      }
    }

    return `**L1 评估 ${score}**\n` +
      `【模式沉淀】\n` + results.filter(r => r.includes('模式积累') || r.includes('Skill 自动沉淀')).map(r => `  ${r}`).join('\n') + '\n' +
      `【召回质量】\n` + results.filter(r => r.includes('召回质量')).map(r => `  ${r}`).join('\n') + '\n' +
      `【表达质量】\n` + results.filter(r => !r.includes('模式积累') && !r.includes('Skill 自动沉淀') && !r.includes('召回质量')).map(r => `  ${r}`).join('\n');
  }

  if (toolName === 'inspect_agent_context') {
    const agent = (toolInput.agent || 'andy').toLowerCase();
    const wsDir  = path.join(process.env.HOME, '.openclaw', `workspace-${agent}`);
    const lines  = [`**${agent.toUpperCase()} 上下文快照**\n`];

    // 1. 静态文件摘要（前 8 行，了解关键内容是否存在）
    const staticFiles = agent === 'andy'
      ? [['ARCH.md', '系统架构'], ['MEMORY.md', '设计积累'], ['DESIGN-PRINCIPLES.md', '判断规则']]
      : [['CODEBASE.md', '代码库上下文'], ['MEMORY.md', '实现积累']];
    lines.push('**── 常驻静态注入 ──**');
    for (const [fname, label] of staticFiles) {
      const fpath = path.join(wsDir, fname);
      if (!fs.existsSync(fpath)) {
        lines.push(`  ❌ ${label}（${fname}）：文件不存在`);
      } else {
        const content = fs.readFileSync(fpath, 'utf8');
        const preview = content.split('\n').filter(l => l.trim()).slice(0, 6).join('\n  ');
        const bytes   = Buffer.byteLength(content, 'utf8');
        lines.push(`  ✅ ${label}（${fname}，${(bytes/1024).toFixed(1)}KB）：\n  ${preview}`);
      }
      lines.push('');
    }

    // 2. ChromaDB decisions 最近条目（各类型分开展示）
    lines.push('**── decisions 蒸馏产出 ──**');
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/decisions`);
      if (colResp.ok) {
        const { id: colId } = await colResp.json();
        const typeLabels = agent === 'andy'
          ? [['design_learning', '设计判断'], ['learning_objective', '学习目标'], ['spec', '历史决策']]
          : [['impl_learning', '代码库认知'], ['learning_objective', '学习目标'], ['constraint', '平台约束']];
        for (const [type, label] of typeLabels) {
          const where = type === 'learning_objective'
            ? { '$and': [{ agent: { '$eq': agent } }, { type: { '$eq': type } }] }
            : { '$and': [{ agent: { '$eq': agent } }, { type: { '$eq': type } }] };
          const resp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ where, include: ['documents', 'metadatas'], limit: 5 }),
          });
          if (!resp.ok) continue;
          const data = await resp.json();
          const docs  = data.documents || [];
          const metas = data.metadatas || [];
          if (docs.length === 0) {
            lines.push(`  ⚪ ${label}（${type}）：0 条`);
          } else {
            lines.push(`  ✅ ${label}（${type}）：${docs.length} 条，最新：`);
            docs.slice(0, 3).forEach((d, i) => {
              const date = (metas[i]?.date || metas[i]?.timestamp || '').slice(0, 10);
              lines.push(`    - [${date}] ${d.slice(0, 120)}`);
            });
          }
        }
      }
    } catch (e) {
      lines.push(`  ⚠️ decisions 查询失败：${e.message.slice(0, 60)}`);
    }
    lines.push('');

    // 3. Kuzu has_pattern 积累
    lines.push('**── Kuzu 模式积累（has_pattern）──**');
    try {
      const tmpScript = path.join(INSTANCE_ROOT, 'scripts', '_inspect_ctx_kuzu.py');
      const script = `import sys, os, json
try:
    import kuzu
    db   = kuzu.Database("${path.join(INSTANCE_ROOT, 'Data', 'kuzu')}")
    conn = kuzu.Connection(db)
    res  = conn.execute(
        "MATCH (a:Entity {id: $aid})-[f:Fact {relation: 'has_pattern'}]->(p:Entity) "
        "WHERE f.valid_until IS NULL RETURN p.name, f.context, f.confidence ORDER BY f.confidence DESC LIMIT 5",
        {'aid': '${agent}'}
    )
    rows = []
    for row in res:
        rows.append({'name': row[0], 'context': row[1], 'confidence': row[2]})
    sys.stdout.write(json.dumps({'rows': rows}))
    sys.stdout.flush()
except Exception as e:
    sys.stdout.write(json.dumps({'error': str(e)}))
    sys.stdout.flush()
os._exit(0)
`;
      fs.writeFileSync(tmpScript, script);
      const { execFileSync } = require('child_process');
      const out = execFileSync(PYTHON311, [tmpScript], { timeout: 20_000, encoding: 'utf8' }).trim();
      fs.unlinkSync(tmpScript);
      const data = JSON.parse(out || '{}');
      if (data.error) {
        lines.push(`  ⚠️ 查询失败：${data.error.slice(0, 60)}`);
      } else if ((data.rows || []).length === 0) {
        lines.push('  ⚪ 尚无 has_pattern 节点（distill-agent-memories.py 尚未产出）');
      } else {
        for (const r of data.rows) {
          lines.push(`  ✅ [${(r.confidence || 0).toFixed(2)}] ${r.name}：${(r.context || '').slice(0, 100)}`);
        }
      }
    } catch (e) {
      lines.push(`  ⚠️ Kuzu 查询失败：${e.message.slice(0, 60)}`);
    }

    return lines.join('\n');
  }

  if (toolName === 'evaluate_l2') {
    const results = [];
    let score = '✅';
    const learningDir = path.join(INSTANCE_ROOT, 'Data', 'learning');

    // ── 维度 A：Engineering Anything（三角色闭环交付力）──

    // A1. 任务类型覆盖度：从 task-registry + ChromaDB decisions 统计成功交付的不同类型
    let taskTypes = new Set();
    try {
      // 从 task-registry.json
      const taskRegPath = path.join(learningDir, 'task-registry.json');
      if (fs.existsSync(taskRegPath)) {
        try {
          const tasks = JSON.parse(fs.readFileSync(taskRegPath, 'utf8'));
          for (const t of tasks) {
            if (t.status === 'completed' && t.taskType) taskTypes.add(t.taskType);
          }
        } catch (_) {}
      }
      // 从 ChromaDB decisions 补充类型
      const decResp = await fetch(`${CHROMA_API_BASE}/decisions`);
      if (decResp.ok) {
        const { id: decId } = await decResp.json();
        const cntResp = await fetch(`${CHROMA_API_BASE}/${decId}/count`);
        if (cntResp.ok) {
          const decCount = await cntResp.json();
          // 有 decisions 数据时，按最少3条记为一种类型
          if (decCount > 3) taskTypes.add('decision_memory');
        }
      }
      // 从 opencode-results 补充
      const ocPath = path.join(learningDir, 'opencode-results.jsonl');
      if (fs.existsSync(ocPath)) {
        const ocLines = fs.readFileSync(ocPath, 'utf8').split('\n').filter(l => l.trim());
        const ocSuccess = ocLines.filter(l => { try { return JSON.parse(l).success; } catch { return false; } }).length;
        if (ocSuccess > 0) taskTypes.add('code_generation');
      }
      const typeCount = taskTypes.size;
      const ok = typeCount >= 3;
      results.push(`${ok ? '✅' : '⚠️'} 任务类型覆盖度：${typeCount} 种${typeCount > 0 ? '（' + [...taskTypes].join(', ') + '）' : '（尚无成功交付记录）'}`);
      if (!ok && score === '✅') score = '⚠️';
    } catch (e) {
      results.push(`⚠️ 任务类型覆盖度检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // A2. 端到端交付成功率
    let deliveryTotal = 0, deliverySuccess = 0;
    try {
      // task-registry 已完成 + 进行中
      const taskRegPath = path.join(learningDir, 'task-registry.json');
      if (fs.existsSync(taskRegPath)) {
        try {
          const tasks = JSON.parse(fs.readFileSync(taskRegPath, 'utf8'));
          for (const t of tasks) {
            deliveryTotal++;
            if (t.status === 'completed' || t.status === 'delivered') deliverySuccess++;
          }
        } catch (_) {}
      }
      // opencode-results
      const ocPath = path.join(learningDir, 'opencode-results.jsonl');
      if (fs.existsSync(ocPath)) {
        const ocEntries = fs.readFileSync(ocPath, 'utf8').split('\n').filter(l => l.trim())
          .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        for (const e of ocEntries) {
          deliveryTotal++;
          if (e.success) deliverySuccess++;
        }
      }
      if (deliveryTotal === 0) {
        results.push('⚪ 端到端交付成功率：尚无交付记录');
      } else {
        const rate = (deliverySuccess / deliveryTotal * 100).toFixed(0);
        const ok = deliverySuccess >= deliveryTotal * 0.7;
        results.push(`${ok ? '✅' : '⚠️'} 端到端交付成功率：${deliverySuccess}/${deliveryTotal} = ${rate}%`);
        if (!ok && score === '✅') score = '⚠️';
      }
    } catch (e) {
      results.push(`⚠️ 交付成功率检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // A3. 交付物多样性：统计不同交付物类型
    let deliverableTypes = new Set();
    try {
      // app（生成的 Web 应用）
      const appDir = path.join(INSTANCE_ROOT, 'App', 'generated');
      if (fs.existsSync(appDir)) {
        const apps = fs.readdirSync(appDir).filter(f => !f.startsWith('.'));
        if (apps.length > 0) deliverableTypes.add('app');
      }
      // code（opencode 产出）
      const ocPath = path.join(learningDir, 'opencode-results.jsonl');
      if (fs.existsSync(ocPath)) {
        const ocSuccess = fs.readFileSync(ocPath, 'utf8').split('\n').filter(l => l.trim())
          .filter(l => { try { return JSON.parse(l).success; } catch { return false; } }).length;
        if (ocSuccess > 0) deliverableTypes.add('code');
      }
      // message（Lucas 主动推送）
      const followupPath = path.join(learningDir, 'followup-queue.jsonl');
      if (fs.existsSync(followupPath)) {
        const fLines = fs.readFileSync(followupPath, 'utf8').split('\n').filter(l => l.trim()).length;
        if (fLines > 0) deliverableTypes.add('message');
      }
      // research（ChromaDB decisions 含 type=research）
      deliverableTypes.add('chat'); // Lucas 对话本身就是交付物
      // 代码库洞察
      try {
        const cpResp = await fetch(`${CHROMA_API_BASE}/codebase_patterns`);
        if (cpResp.ok) {
          const { id: cpId } = await cpResp.json();
          const cntResp = await fetch(`${CHROMA_API_BASE}/${cpId}/count`);
          if (cntResp.ok) { const c = await cntResp.json(); if (c > 0) deliverableTypes.add('insight'); }
        }
      } catch (_) {}

      const typeCount = deliverableTypes.size;
      const ok = typeCount >= 3;
      results.push(`${ok ? '✅' : '⚠️'} 交付物多样性：${typeCount} 种（${[...deliverableTypes].join(', ')}）`);
      if (!ok && score === '✅') score = '⚠️';
    } catch (e) {
      results.push(`⚠️ 交付物多样性检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // ── 维度 B：三角色流水线健康 ──
    let pipelineCompleted = 0, pipelineFailed = 0, pipelineQueued = 0, pipelineCancelled = 0;
    try {
      const taskRegPath = path.join(learningDir, 'task-registry.json');
      if (fs.existsSync(taskRegPath)) {
        const tasks = JSON.parse(fs.readFileSync(taskRegPath, 'utf8'));
        for (const t of tasks) {
          if (t.status === 'completed' || t.status === 'delivered') pipelineCompleted++;
          else if (t.status === 'failed') pipelineFailed++;
          else if (t.status === 'queued' || t.status === 'in_progress') pipelineQueued++;
          else if (t.status === 'cancelled') pipelineCancelled++;
        }
      }
      const pipelineTotal = pipelineCompleted + pipelineFailed;
      if (pipelineTotal === 0 && pipelineQueued === 0) {
        results.push('⚪ 三角色流水线：尚无任务记录');
      } else {
        const healthRate = pipelineTotal > 0 ? Math.round(pipelineCompleted / pipelineTotal * 100) : 0;
        const pipelineOk = pipelineTotal === 0 || healthRate >= 60;
        const detail = `已完成:${pipelineCompleted} / 失败:${pipelineFailed} / 进行中+排队:${pipelineQueued} / 已取消:${pipelineCancelled}`;
        results.push(`${pipelineOk ? '✅' : '⚠️'} 三角色流水线健康：${pipelineTotal > 0 ? healthRate + '%' : 'N/A'}（${detail}）`);
        if (!pipelineOk && score === '✅') score = '⚠️';
      }
    } catch (e) {
      results.push(`⚠️ 流水线健康检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }


    // ── 外循环教师测试：逾期未交付需求检测（真实数据）──
    // 从 ChromaDB requirements 集合找 outcome 为空且 >30 天的需求，作为 L2 交付盲点
    try {
      const reqColR = await fetch(`${CHROMA_API_BASE}/requirements`);
      if (reqColR.ok) {
        const { id: reqColId } = await reqColR.json();
        const reqGetR = await fetch(`${CHROMA_API_BASE}/${reqColId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 200, include: ['documents', 'metadatas'] }),
        });
        if (reqGetR.ok) {
          const reqData  = await reqGetR.json();
          const reqMetas = reqData.metadatas  || [];
          const reqDocs  = reqData.documents  || [];
          const cutoff30 = Date.now() - 30 * 24 * 3600000;
          const overdueItems = reqMetas.map((m, i) => ({ m, doc: reqDocs[i] || '' })).filter(({ m }) => {
            const outcome  = (m?.outcome  || '').trim();
            const status   = (m?.status   || '').toLowerCase();
            const ts       = new Date(m?.timestamp || m?.created_at || '').getTime();
            if (outcome && outcome !== 'pending' && status !== 'open') return false; // 已有结果
            if (isNaN(ts) || ts >= cutoff30) return false; // 太新或无时间戳
            return true;
          });
          if (overdueItems.length === 0) {
            results.push('✅ 逾期未交付需求：无（所有 >30 天需求均已有 outcome）');
          } else {
            const examples = overdueItems.slice(0, 3).map(({ doc }) => doc.slice(0, 60)).join(' | ');
            results.push(`⚠️ 逾期未交付需求（外循环教师）：${overdueItems.length} 条需求 >30 天无 outcome（示例：${examples}...）`);
            if (score === '✅') score = '⚠️';
          }
        }
      }
    } catch (e) {
      results.push(`⚪ 逾期需求检测跳过：${e.message.slice(0, 60)}`);
    }

    // ── 数值评分 ──
    const _rub2 = loadRubric();
    const _L2I = _rub2?.layers?.L2?.items;
    const _l2s = [];
    if (_L2I) {
      for (const r of results) {
        if (r.includes('任务类型覆盖度')) { const m = r.match(/(\d+) 种/); if (m) trackScore(_l2s, _L2I, 'task_type_coverage', +m[1]); }
        if (r.includes('端到端交付成功率') && r.includes('=')) { const m = r.match(/= (\d+)%/); if (m) trackScore(_l2s, _L2I, 'delivery_success_rate', +m[1]); }
        if (r.includes('交付物多样性')) { const m = r.match(/(\d+) 种/); if (m) trackScore(_l2s, _L2I, 'deliverable_diversity', +m[1]); }
        if (r.includes('三角色流水线健康')) {
          const m = r.match(/健康：(\d+)%/);
          trackScore(_l2s, _L2I, 'pipeline_health', m ? +m[1] : 0);
        }
      }
      if (_l2s.length > 0) {
        const _wa = calcWeightedAvg(_l2s);
        _evalScores.L2 = { items: _l2s, weighted: _wa };
        score += ` · ${_wa.toFixed(1)}/5.0`;
      }
    }

    return `**L2 评估 ${score}**\n` +
      `【Engineering Anything · 三角色闭环交付力】\n` + (results.length ? results.map(r => `  ${r}`).join('\n') : '  ⚪ 暂无数据');
  }

  if (toolName === 'evaluate_l3') {
    // 四维度输出结构：D1成员画像 / D2关系图谱 / D3影子Agent / D4跨成员感知
    const d1Results = [];  // ①成员画像
    const d2Results = [];  // ②关系图谱
    const d3Results = [];  // ③影子Agent
    const d4Results = [];  // ④跨成员感知
    let score = '✅';

    // ── ①成员画像：inject.md 文件质量（包含蒸馏信息的比例）──
    let profileTotal = 0, profileWithDistilled = 0;
    try {
      const familyDir = path.join(process.env.HOME, '.openclaw', 'workspace-lucas', 'family');
      if (!fs.existsSync(familyDir)) {
        d1Results.push('⚪ 成员画像：family 目录不存在（档案未初始化）');
      } else {
        const injects = fs.readdirSync(familyDir).filter(f => f.endsWith('.inject.md'));
        profileTotal = injects.length;
        let withCollab = 0;
        for (const inj of injects) {
          const content = fs.readFileSync(path.join(familyDir, inj), 'utf8');
          // 蒸馏信息标志：行为模式 / 沟通风格 / 协作关系 / 角色 / 关注点
          const hasDistilled = /行为模式|沟通风格|协作关系|co_discusses|关注点|兴趣领域|工作状态/.test(content);
          const hasCollab = /组织协作关系|协作边|co_discusses|requests_from/.test(content);
          if (hasDistilled) profileWithDistilled++;
          if (hasCollab) withCollab++;
        }
        const profilePct = profileTotal > 0 ? Math.round(profileWithDistilled / profileTotal * 100) : 0;
        d1Results.push(`${profileWithDistilled > 0 ? '✅' : '⚪'} 成员画像：${profileTotal} 个档案，${profileWithDistilled} 个含蒸馏信息（${profilePct}%）`);
        d1Results.push(`${withCollab > 0 ? '✅' : '⚪'} 协作关系注入：${withCollab}/${profileTotal} 个档案含协作关系信息`);
      }
    } catch (e) {
      d1Results.push(`⚠️ 成员画像检查失败：${e.message.slice(0, 60)}`);
    }

    // ── ②关系图谱：Kuzu 协作边（distill-relationship-dynamics.py 产出）──
    const l3KuzuPath = path.join(INSTANCE_ROOT, 'Data', 'kuzu');
    const l3KuzuScript = `
import sys, json, os
sys.path.insert(0, '/opt/homebrew/lib/python3.11/site-packages')
try:
    import kuzu
    db   = kuzu.Database('${l3KuzuPath}')
    conn = kuzu.Connection(db)
    counts = {}
    for rel in ['co_discusses', 'requests_from', 'supports', 'role_in_context', 'active_thread']:
        r = conn.execute("MATCH ()-[f:Fact {relation: '" + rel + "'}]->() RETURN count(f)")
        counts[rel] = r.get_next()[0] if r.has_next() else 0
    print(json.dumps({'counts': counts}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
sys.stdout.flush()
os._exit(0)
`.trim();
    try {
      const tmpL3 = path.join(INSTANCE_ROOT, 'temp', `eval-l3-${Date.now()}.py`);
      fs.mkdirSync(path.join(INSTANCE_ROOT, 'temp'), { recursive: true });
      fs.writeFileSync(tmpL3, l3KuzuScript);
      const l3Out = execSync(`${PYTHON311} ${tmpL3}`, { encoding: 'utf8', timeout: 20000 }).trim();
      try { fs.unlinkSync(tmpL3); } catch (_) {}
      const ld = JSON.parse(l3Out);
      if (ld.error) {
        d2Results.push(`⚠️ Kuzu 协作边查询失败：${ld.error.slice(0, 80)}`);
        if (score === '✅') score = '⚠️';
      } else {
        const c = ld.counts || {};
        const collabTotal = (c.co_discusses || 0) + (c.requests_from || 0) + (c.supports || 0) + (c.role_in_context || 0);
        const activeThreads = c.active_thread || 0;
        d2Results.push(`${collabTotal > 0 ? '✅' : '⚪'} 协作关系图谱边：${collabTotal} 条（co_discusses:${c.co_discusses||0} / requests_from:${c.requests_from||0} / supports:${c.supports||0} / role_in_context:${c.role_in_context||0}）`);
        d2Results.push(`${activeThreads > 0 ? '✅' : '⚪'} 活跃话题线索（active_thread）：${activeThreads} 条`);
      }
    } catch (e) {
      d2Results.push(`⚠️ Kuzu L3 查询异常：${e.message.slice(0, 80)}`);
      if (score === '✅') score = '⚠️';
    }

    // ── ③影子Agent：演进环记录 + 访客Registry ──
    try {
      const siResp = await fetch(`${CHROMA_API_BASE}/shadow_interactions`);
      if (!siResp.ok) {
        d3Results.push('⚪ shadow_interactions：集合不存在（演进环尚未运行）');
      } else {
        const { id: siId } = await siResp.json();
        const cntResp = await fetch(`${CHROMA_API_BASE}/${siId}/count`);
        const siCount = cntResp.ok ? await cntResp.json() : '?';
        d3Results.push(`${siCount > 0 ? '✅' : '⚪'} shadow_interactions：${siCount} 条演进环记录`);
      }
    } catch (e) {
      d3Results.push(`⚠️ shadow_interactions 检查失败：${e.message.slice(0, 60)}`);
    }
    try {
      const registryPath = path.join(INSTANCE_ROOT, 'Data', 'visitor-registry.json');
      if (!fs.existsSync(registryPath)) {
        d3Results.push('⚪ 访客 Registry：文件不存在（无访客）');
      } else {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        const entries = Object.values(registry);
        const active   = entries.filter(e => e.shadow_status === 'active').length;
        const dormant  = entries.filter(e => e.shadow_status === 'dormant').length;
        const archived = entries.filter(e => e.shadow_status === 'archived').length;
        d3Results.push(`${entries.length > 0 ? '✅' : '⚪'} 访客影子：${entries.length} 个（active:${active} / dormant:${dormant} / archived:${archived}）`);
      }
    } catch (e) {
      d3Results.push(`⚠️ 访客 Registry 读取失败：${e.message.slice(0, 60)}`);
    }

    // ── ④跨成员感知：关系蒸馏运行状态 + 成员增强效果 ──
    try {
      const logPath = path.join(INSTANCE_ROOT, 'Logs', 'distill-relationship-dynamics.log');
      if (!fs.existsSync(logPath)) {
        d4Results.push('⚪ 关系蒸馏日志：尚无运行记录（每日凌晨 4am 触发）');
      } else {
        const logContent = fs.readFileSync(logPath, 'utf8');
        const logLines = logContent.split('\n').filter(l => l.trim());
        const runMatches = logContent.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/g);
        const lastRun = runMatches ? runMatches[runMatches.length - 1] : '未知';
        d4Results.push(`✅ 关系蒸馏：上次运行 ${lastRun}，日志 ${logLines.length} 行`);
      }
    } catch (e) {
      d4Results.push(`⚠️ 关系蒸馏日志读取失败：${e.message.slice(0, 60)}`);
    }
    // 成员增强效果 = 档案中含协作信息比例（已在 D1 中统计，这里汇总结论）
    if (profileTotal > 0) {
      const enhancePct = Math.round(profileWithDistilled / profileTotal * 100);
      d4Results.push(`${profileWithDistilled > 0 ? '✅' : '⚪'} 成员增强效果：${profileWithDistilled}/${profileTotal} 个档案含蒸馏画像（${enhancePct}%）`);
    }

    // ── 数值评分 ──
    const allL3Results = [...d1Results, ...d2Results, ...d3Results, ...d4Results];
    const _rub3 = loadRubric();
    const _L3I = _rub3?.layers?.L3?.items;
    const _l3s = [];
    if (_L3I) {
      // D1 成员画像
      for (const r of d1Results) {
        if (r.includes('成员画像') && r.includes('%')) {
          const m = r.match(/\((\d+)%\)/); if (m) trackScore(_l3s, _L3I, 'member_profile', +m[1]);
        }
      }
      // D2 关系图谱
      for (const r of d2Results) {
        if (r.includes('协作关系图谱边')) { const m = r.match(/：(\d+) 条/); if (m) trackScore(_l3s, _L3I, 'collab_edges', +m[1]); }
      }
      // D3 影子Agent
      for (const r of d3Results) {
        if (r.includes('shadow_interactions') || r.includes('演进环')) { const m = r.match(/(\d+) 条演进/); if (m) trackScore(_l3s, _L3I, 'shadow_interactions', +m[1]); }
        if (r.includes('访客影子') && r.includes('active')) {
          const m = r.match(/active:(\d+)/);
          trackScore(_l3s, _L3I, 'visitor_registry', (m && +m[1] > 0) ? 'active' : (r.includes('dormant') ? 'dormant_only' : 'none'));
        }
      }
      // D4 跨成员感知
      for (const r of d4Results) {
        if (r.includes('关系蒸馏')) trackScore(_l3s, _L3I, 'relationship_distill', r.trim().startsWith('✅') ? 'recent' : (r.includes('尚无') ? 'never' : 'exists'));
        if (r.includes('成员增强效果')) { const m = r.match(/\((\d+)%\)/); if (m) trackScore(_l3s, _L3I, 'member_enhancement', +m[1]); }
      }
      if (_l3s.length > 0) {
        const _wa = calcWeightedAvg(_l3s);
        _evalScores.L3 = { items: _l3s, weighted: _wa };
        score += ` · ${_wa.toFixed(1)}/5.0`;
      }
    }

    // 分段输出
    const l3Output = [];
    if (d1Results.length > 0) { l3Output.push('── 【①成员画像·从交互蒸馏】 ──'); d1Results.forEach(r => l3Output.push(`  ${r}`)); }
    if (d2Results.length > 0) { l3Output.push('── 【②关系图谱·Kuzu协作边】 ──'); d2Results.forEach(r => l3Output.push(`  ${r}`)); }
    if (d3Results.length > 0) { l3Output.push('── 【③影子Agent·演进环+访客】 ──'); d3Results.forEach(r => l3Output.push(`  ${r}`)); }
    if (d4Results.length > 0) { l3Output.push('── 【④跨成员感知·协作蒸馏】 ──'); d4Results.forEach(r => l3Output.push(`  ${r}`)); }
    return `**L3 评估 ${score}**\n${l3Output.join('\n')}`;
  }

  if (toolName === 'evaluate_l4') {
    const sysLayerResults = [];  // 系统层自我改进指标
    const mdlLayerResults = [];  // 模型层内化指标
    let score = '✅';
    const learningDir = path.join(INSTANCE_ROOT, 'Data', 'learning');

    // ══ 系统层：自我改进机制 ══

    // S1. 进化信号积累（区分"待处理"vs"已完成"，不堆总量）
    let totalDpo = 0, pendingDpo = 0, totalSkillCand = 0, pendingSkillCand = 0;
    try {
      const dpoCandPath = path.join(learningDir, 'dpo-candidates.jsonl');
      if (fs.existsSync(dpoCandPath)) {
        const lines = fs.readFileSync(dpoCandPath, 'utf8').split('\n').filter(l => l.trim());
        totalDpo = lines.length;
        pendingDpo = lines.filter(l => { try { return !JSON.parse(l).good_response; } catch { return false; } }).length;
      }
      const skillCandPath = path.join(learningDir, 'skill-candidates.jsonl');
      if (fs.existsSync(skillCandPath)) {
        const lines = fs.readFileSync(skillCandPath, 'utf8').split('\n').filter(l => l.trim());
        totalSkillCand = lines.length;
        pendingSkillCand = lines.filter(l => { try { return JSON.parse(l).status === 'pending'; } catch { return false; } }).length;
      }
      const hasSignals = totalDpo + totalSkillCand >= 3;
      sysLayerResults.push(`${hasSignals ? '✅' : '⚠️'} 进化信号：DPO ${totalDpo} 条（待处理 ${pendingDpo}）/ Skill候选 ${totalSkillCand} 条（待处理 ${pendingSkillCand}）`);
      if (!hasSignals && score === '✅') score = '⚠️';
    } catch (e) {
      sysLayerResults.push(`⚠️ 进化信号读取失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // S2. 知识内化率（蒸馏产出 + 代码库洞察）
    let internalizationCount = 0;
    try {
      try {
        const cpResp = await fetch(`${CHROMA_API_BASE}/codebase_patterns`);
        if (cpResp.ok) {
          const { id: cpId } = await cpResp.json();
          const cntResp = await fetch(`${CHROMA_API_BASE}/${cpId}/count`);
          if (cntResp.ok) internalizationCount += await cntResp.json();
        }
      } catch (_) {}
      try {
        const decResp = await fetch(`${CHROMA_API_BASE}/decisions`);
        if (decResp.ok) {
          const { id: decId } = await decResp.json();
          const cntResp = await fetch(`${CHROMA_API_BASE}/${decId}/count`);
          if (cntResp.ok) internalizationCount += await cntResp.json();
        }
      } catch (_) {}
      const ok = internalizationCount >= 5;
      sysLayerResults.push(`${ok ? '✅' : '⚪'} 知识内化：${internalizationCount} 条（codebase_patterns + decisions 蒸馏）${internalizationCount === 0 ? '（蒸馏管道待积累）' : ''}`);
    } catch (e) {
      sysLayerResults.push(`⚠️ 知识内化检查失败：${e.message.slice(0, 60)}`);
    }

    // S3. Skill 积累（native精选 + archive积累分开统计）
    // native：~/.openclaw/workspace-*/skills/（OpenClaw原生，全量注入，应保持精简）
    // archive：data/learning/auto-skills/*/（插件管理，按需召回，无上限）
    try {
      const ocHome = path.join(process.env.HOME, '.openclaw');
      const autoSkillsRoot = path.join(INSTANCE_ROOT, 'Data', 'learning', 'auto-skills');
      const agents = ['lucas', 'andy', 'lisa'];
      const skillLines = agents.map(agent => {
        const nativeDir = path.join(ocHome, `workspace-${agent}`, 'skills');
        const archiveDir = path.join(autoSkillsRoot, agent);
        const countDir = d => {
          if (!fs.existsSync(d)) return 0;
          try { return fs.readdirSync(d).filter(f => { try { return fs.statSync(path.join(d, f)).isDirectory(); } catch { return false; } }).length; } catch { return 0; }
        };
        return `${agent}:${countDir(nativeDir)}精选+${countDir(archiveDir)}积累`;
      });
      const totalNative  = skillLines.reduce((s, l) => s + parseInt(l.match(/:(\d+)/)?.[1] ?? '0'), 0);
      const totalArchive = skillLines.reduce((s, l) => s + parseInt(l.match(/\+(\d+)/)?.[1] ?? '0'), 0);
      sysLayerResults.push(`✅ Skill 积累：精选 ${totalNative} 个 + 归档 ${totalArchive} 个（${skillLines.join(' / ')}）`);
    } catch (e) {
      sysLayerResults.push(`⚠️ Skill 统计失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // S4. Andy HEARTBEAT 巡检时效
    let andyHbHours = 9999;
    try {
      const andyHbPath = path.join(process.env.HOME, '.openclaw', 'workspace-andy', 'HEARTBEAT.md');
      if (!fs.existsSync(andyHbPath)) {
        sysLayerResults.push('❌ Andy HEARTBEAT.md 不存在（自我演化巡检未激活）');
        score = '❌';
      } else {
        const hb = fs.readFileSync(andyHbPath, 'utf8');
        const lastCheckMatch = hb.match(/上次巡检[：:](.+)/);
        if (!lastCheckMatch) {
          sysLayerResults.push('⚠️ Andy HEARTBEAT：存在但无「上次巡检」字段');
          if (score === '✅') score = '⚠️';
        } else {
          const lastCheckRaw = lastCheckMatch[1].trim();
          const lastCheckStr = lastCheckRaw.slice(0, 19); // YYYY-MM-DDTHH:mm:ss
          // 时间戳可能含毫秒和时区（如 2026-04-14T16:47:56.064+08:00），直接解析原始值
          const lastCheckDate = new Date(lastCheckRaw.replace(' ', 'T'));
          andyHbHours = isNaN(lastCheckDate.getTime()) ? 9999 : (Date.now() - lastCheckDate.getTime()) / 3600000;
          const stale = andyHbHours > 30;
          sysLayerResults.push(`${stale ? '⚠️' : '✅'} Andy HEARTBEAT 上次巡检：${lastCheckStr}（${andyHbHours.toFixed(1)}h 前）`);
          if (stale && score === '✅') score = '⚠️';
        }
      }
    } catch (e) {
      sysLayerResults.push(`⚠️ Andy HEARTBEAT 读取失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // S5. AGENTS.md 规则收敛度（规则总条数，越少说明越多行为内化到权重，不靠外部注入）
    let totalAgentRules = 0;
    try {
      const ocHome = path.join(process.env.HOME, '.openclaw');
      for (const agentName of ['lucas', 'andy', 'lisa']) {
        const agentsPath = path.join(ocHome, `workspace-${agentName}`, 'AGENTS.md');
        if (fs.existsSync(agentsPath)) {
          const content = fs.readFileSync(agentsPath, 'utf8');
          // 统计规则行：以 - / * / 数字. 开头的非空行
          const ruleLines = content.split('\n').filter(l => /^\s*[-*]\s|^\s*\d+\.\s/.test(l)).length;
          totalAgentRules += ruleLines;
        }
      }
      // lower_better：规则多 = 系统仍在依赖临时注入干预，规则少 = 更成熟
      const maturityIcon = totalAgentRules <= 100 ? '✅' : totalAgentRules <= 200 ? '⚪' : '⚠️';
      const maturityDesc = totalAgentRules <= 100 ? '规则精简，行为内化程度高'
        : totalAgentRules <= 200 ? '规则适中（基线阶段）'
        : '规则偏多，仍依赖外部注入';
      sysLayerResults.push(`${maturityIcon} AGENTS.md 规则收敛：三角色合计 ${totalAgentRules} 条规则行（${maturityDesc}）`);
    } catch (e) {
      sysLayerResults.push(`⚠️ AGENTS.md 规则统计失败：${e.message.slice(0, 60)}`);
    }

    // S6. 路由阈值进化（路由事件中本地路由比例 + routing-thresholds.json 存在性）
    try {
      const routeEventsPath = path.join(INSTANCE_ROOT, 'Data', 'learning', 'route-events.jsonl');
      const thresholdsPath = path.join(INSTANCE_ROOT, 'Data', 'learning', 'routing-thresholds.json');
      let localRoutePct = 0;
      let recentTotal = 0, recentLocal = 0;
      if (fs.existsSync(routeEventsPath)) {
        const lines = fs.readFileSync(routeEventsPath, 'utf8').split('\n').filter(l => l.trim());
        // 取最近 200 条计算本地路由比例
        const recent = lines.slice(-200);
        for (const line of recent) {
          try {
            const ev = JSON.parse(line);
            recentTotal++;
            if (ev.routed_to === 'local' || ev.model_tier === 'local') recentLocal++;
          } catch (_) {}
        }
        localRoutePct = recentTotal > 0 ? Math.round(recentLocal / recentTotal * 100) : 0;
      }
      const hasThresholds = fs.existsSync(thresholdsPath);
      const routeIcon = recentTotal === 0 ? '⚪' : localRoutePct >= 5 ? '✅' : '⚪';
      const routeDesc = recentTotal === 0 ? '尚无路由事件（云端模型唯一路径）'
        : `近 ${recentTotal} 条事件中本地路由占 ${localRoutePct}%（local:${recentLocal}）`;
      sysLayerResults.push(`${routeIcon} 路由阈值进化：${routeDesc}${hasThresholds ? '，routing-thresholds.json 存在' : '，routing-thresholds.json 不存在'}`);
    } catch (e) {
      sysLayerResults.push(`⚠️ 路由阈值检查失败：${e.message.slice(0, 60)}`);
    }

    // ══ 模型层：行为内化 ══

    // M1. DPO 模式积累进度（按 pattern_type 分组，追踪距内化阈值的缺口）
    try {
      const dpoCandPath = path.join(learningDir, 'dpo-candidates.jsonl');
      if (!fs.existsSync(dpoCandPath)) {
        mdlLayerResults.push('⚪ dpo-candidates.jsonl：文件不存在（尚无 L4 模型层训练信号）');
      } else {
        const lines = fs.readFileSync(dpoCandPath, 'utf8').split('\n').filter(l => l.trim());
        const patternCounts = {};
        const nowTs = Date.now();
        const sevenDaysAgo = nowTs - 7 * 24 * 3600 * 1000;
        const fourteenDaysAgo = nowTs - 14 * 24 * 3600 * 1000;
        let recentCount = 0;
        let prevWeekCount = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const ts = new Date(entry.t).getTime();
            if (ts > sevenDaysAgo) recentCount++;
            else if (ts > fourteenDaysAgo) prevWeekCount++;
            for (const reason of (entry.reasons || [])) {
              const m = reason.match(/^([a-z_]+):/);
              if (m) {
                const pt = m[1];
                patternCounts[pt] = (patternCounts[pt] || 0) + 1;
              }
            }
          } catch (_) {}
        }

        const THRESHOLD = 50;
        const patternLines = Object.entries(patternCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([pt, n]) => {
            const icon = n >= THRESHOLD ? '🔴' : n >= 20 ? '🟡' : '⚪';
            return `${icon} ${pt}：${n} 条${n >= THRESHOLD ? '（已达阈值，待内化）' : `（距阈值还差 ${THRESHOLD - n} 条）`}`;
          });

        mdlLayerResults.push(`✅ DPO 信号总计：${lines.length} 条`);
        patternLines.forEach(l => mdlLayerResults.push(`   ${l}`));

        // 近 7 天趋势（判断 L4 系统层干预是否在收敛问题）
        const trendIcon = recentCount < prevWeekCount ? '📉' : recentCount > prevWeekCount ? '📈' : '➡️';
        const trendMsg  = recentCount < prevWeekCount ? 'L4 系统层干预有效，问题在收敛' : recentCount > prevWeekCount ? '问题在增加，L4 系统层干预需加强' : '持平';
        mdlLayerResults.push(`${trendIcon} 近 7 天新增 ${recentCount} 条 vs 前 7 天 ${prevWeekCount} 条（${trendMsg}）`);

        const ripePatterns = Object.entries(patternCounts).filter(([, n]) => n >= THRESHOLD);
        if (ripePatterns.length > 0) {
          score = '🔴';
          mdlLayerResults.push(`🔴 ${ripePatterns.length} 个模式已达内化阈值，等待工程师确认触发微调`);
        }
      }
    } catch (e) {
      mdlLayerResults.push(`⚠️ DPO 信号读取失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // M2. 本地模型就绪检查（双路：Ollama API + MLX 文件目录）
    try {
      // M2a. Ollama：查询已拉取模型列表
      const ollamaModels = [];
      try {
        const ollamaResp = execSync('curl -sf http://localhost:11434/api/tags', { timeout: 5000, stdio: 'pipe' }).toString();
        const ollamaJson = JSON.parse(ollamaResp);
        (ollamaJson.models || []).forEach(m => ollamaModels.push(m.name));
      } catch (_) {}

      // M2b. MLX：扫描 ~/HomeAI/Models/mlx/ 目录
      const mlxDir = path.join(INSTANCE_ROOT, 'Models', 'mlx');
      const mlxModels = [];
      try {
        if (fs.existsSync(mlxDir)) {
          fs.readdirSync(mlxDir).forEach(d => {
            const safetensors = path.join(mlxDir, d, 'model.safetensors');
            const weights = path.join(mlxDir, d, 'weights.npz');
            if (fs.existsSync(safetensors) || fs.existsSync(weights)) mlxModels.push(d);
          });
        }
      } catch (_) {}

      const totalLocal = ollamaModels.length + mlxModels.length;
      if (totalLocal === 0) {
        mdlLayerResults.push('⏳ 本地模型：未检测到就绪模型（Ollama 无模型 + MLX 目录为空）');
        if (score === '✅') score = '⚠️';
      } else {
        if (ollamaModels.length > 0) mdlLayerResults.push(`✅ Ollama 模型（${ollamaModels.length}）：${ollamaModels.slice(0, 3).join('、')}${ollamaModels.length > 3 ? '…' : ''}`);
        if (mlxModels.length > 0)   mdlLayerResults.push(`✅ MLX 模型（${mlxModels.length}）：${mlxModels.slice(0, 3).join('、')}${mlxModels.length > 3 ? '…' : ''}`);
        // Qwen2.5-Coder-32B 特别标注（L4 模型层 SFT 微调基础模型）
        const hasQwen = mlxModels.some(m => /Qwen2\.5.*Coder.*32B/i.test(m)) || ollamaModels.some(m => /qwen2\.5.*coder/i.test(m));
        if (hasQwen) mdlLayerResults.push('✅ Qwen2.5-Coder-32B-4bit 就绪（L4 模型层微调基础模型可用）');
        // Gemma 4 终态检查（非阻塞）
        const hasGemma4 = mlxModels.some(m => /gemma.*4/i.test(m)) || ollamaModels.some(m => /gemma.*4/i.test(m));
        mdlLayerResults.push(hasGemma4 ? '✅ Gemma 4 就绪（L4 模型层进化终态已达）' : '⏳ Gemma 4 尚未就绪（L4 模型层进化终态，不阻塞当前微调）');
      }
    } catch (e) {
      mdlLayerResults.push(`⚠️ 本地模型检查异常：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // M3. 模型能力评估提示（evaluate_local_model 已有完整实现）
    mdlLayerResults.push('💡 模型能力评估：调用 evaluate_local_model 运行 8 条测试用例 × 4 维度（行为合规/人格一致性/中文质量/指令遵从），获取本地模型量化评分');

    // 数值评分（扫描系统层 + 模型层结果）
    const _rub4 = loadRubric();
    const _L4I = _rub4?.layers?.L4?.items;
    const _l4s = [];
    if (_L4I) {
      // 系统层评分
      for (const r of sysLayerResults) {
        if (r.includes('AGENTS.md 规则收敛') && r.includes('条规则行')) {
          const m = r.match(/合计 (\d+) 条/); if (m) trackScore(_l4s, _L4I, 'agents_md_maturity', +m[1]);
        }
        if (r.includes('路由阈值进化') && r.includes('本地路由占')) {
          const m = r.match(/占 (\d+)%/); if (m) trackScore(_l4s, _L4I, 'routing_evolution', +m[1]);
        }
      }
      // 模型层评分
      for (const r of mdlLayerResults) {
        if (r.includes('已达内化阈值')) { const m = r.match(/(\d+) 个模式/); if (m) trackScore(_l4s, _L4I, 'dpo_accumulation', 100); }
        if (r.includes('本地模型') || r.includes('Ollama') || r.includes('MLX')) {
          const hasOllama = mdlLayerResults.some(x => x.includes('Ollama 模型'));
          const hasMlx = mdlLayerResults.some(x => x.includes('MLX 模型'));
          if (r.includes('未检测到')) trackScore(_l4s, _L4I, 'local_model_ready', 'none');
          else if (hasOllama && hasMlx) trackScore(_l4s, _L4I, 'local_model_ready', 'ready');
          else if (hasOllama || hasMlx) trackScore(_l4s, _L4I, 'local_model_ready', 'partial');
        }
      }
      // DPO 进度：从 pattern 行提取最高进度百分比
      if (!_l4s.some(s => s.key === 'dpo_accumulation')) {
        for (const r of mdlLayerResults) {
          if (r.includes('距阈值还差')) { const m = r.match(/还差 (\d+)/); if (m) { const pct = Math.max(0, Math.round((1 - +m[1] / 50) * 100)); trackScore(_l4s, _L4I, 'dpo_accumulation', pct); break; } }
        }
        if (!_l4s.some(s => s.key === 'dpo_accumulation')) {
          const totalLine = mdlLayerResults.find(x => x.includes('DPO 信号总计'));
          if (totalLine) { const m = totalLine.match(/(\d+) 条/); if (m) trackScore(_l4s, _L4I, 'dpo_accumulation', Math.min(+m[1], 50) > 0 ? Math.round(+m[1] / 50 * 100) : 0); }
        }
      }
      if (_l4s.length > 0) {
        const _wa = calcWeightedAvg(_l4s);
        _evalScores.L4 = { items: _l4s, weighted: _wa };
        score += ` · ${_wa.toFixed(1)}/5.0`;
      }
    }
    // 输出格式：系统层 + 模型层 分段展示
    const allResults = [];
    if (sysLayerResults.length > 0) {
      allResults.push('── 【系统层·自我改进机制】 ──');
      sysLayerResults.forEach(r => allResults.push(`  ${r}`));
    }
    if (mdlLayerResults.length > 0) {
      allResults.push('── 【模型层·行为内化】 ──');
      mdlLayerResults.forEach(r => allResults.push(`  ${r}`));
    }
    return `**L4 评估 ${score}**\n${allResults.join('\n')}`;
  }

  // ─── evaluate_local_model ────────────────────────────────────────────────────
  // 数据驱动评估：从 Kuzu（家人事实）+ ChromaDB（真实对话）自动生成测试题
  if (toolName === 'evaluate_local_model') {
    const modelName = toolInput.model_name || 'qwen2.5-coder:32b';
    const caseResults = [];
    const knowledgeScores = []; // 知识掌握（Kuzu）
    const dialogueScores = []; // 对话能力（ChromaDB）

    // ── Part 1: Kuzu 知识掌握 ──
    // 从 Kuzu 抽取家人活跃事实，用 Main 生成问题，测本地模型对家人的了解
    try {
      const kuzuScript = `
import sys, json, os
sys.path.insert(0, '/opt/homebrew/lib/python3.11/site-packages')
import kuzu
db = kuzu.Database(os.environ.get('INSTANCE_ROOT', os.path.expanduser('~/HomeAI')) + '/Data/kuzu')
conn = kuzu.Connection(db)
result = conn.execute("MATCH (p:Entity {type:'person'})-[f:Fact]->(t:Entity) WHERE f.valid_until IS NULL AND f.source_type='distill' RETURN p.name AS person, p.id AS pid, f.relation AS relation, t.name AS target, f.context AS context ORDER BY f.valid_from DESC LIMIT 30")
facts = []
while result.has_next():
    row = result.get_next()
    facts.append({'person': row[0], 'pid': row[1], 'relation': row[2], 'target': row[3], 'context': row[4]})
print(json.dumps(facts, ensure_ascii=False))
os._exit(0)
`;
      const kuzuRaw = execSync('/opt/homebrew/opt/python@3.11/bin/python3.11', { input: kuzuScript, encoding: 'utf8', timeout: 15000 });
      const facts = JSON.parse(kuzuRaw.trim());

      if (facts.length === 0) {
        caseResults.push('⚪ Kuzu 知识测试：无家人事实数据，跳过');
      } else {
        // 按 person 分组，每人取最多 3 条事实
        const byPerson = {};
        for (const f of facts) {
          if (!byPerson[f.person]) byPerson[f.person] = [];
          if (byPerson[f.person].length < 3) byPerson[f.person].push(f);
        }
        const selectedFacts = Object.values(byPerson).flat();

        // 用 Main 把事实转成自然语言问题
        const factsDesc = selectedFacts.map((f, i) =>
          `${i + 1}. 关于${f.person}：${f.relation} → ${f.target}（${f.context}）`
        ).join('\n');

        const questionGenPrompt = `已知以下家人事实，为每条生成一个自然语言问题（像家人会问的那样）。
只输出JSON数组，每个元素是 {"id": 数字, "question": "问题", "key_info": "答案必须包含的关键信息"}。

${factsDesc}`;

        const questionRaw = await callAgentModel('main',
          '你是测试题生成器，把结构化事实转为家人会问的自然语言问题。',
          [{ role: 'user', content: questionGenPrompt }], 800);
        let questions = [];
        try {
          const m = questionRaw.match(/\[[\s\S]*?\]/);
          if (m) questions = JSON.parse(m[0]);
        } catch (_) {}

        if (questions.length === 0) {
          caseResults.push(`⚠️ Kuzu 知识测试：Main 生成问题失败，跳过（${selectedFacts.length} 条事实已抽取）`);
        } else {
          // 逐题测试本地模型
          for (const q of questions.slice(0, 9)) {
            try {
              const ollamaBody = JSON.stringify({
                model: modelName,
                messages: [
                  { role: 'system', content: 'Lucas是家庭成员，了解家里的每个人。用中文自然回答，不编造不确定的信息。' },
                  { role: 'user', content: q.question },
                ],
                stream: false,
              });
              const ollamaRaw = execSync(
                `curl -sf http://localhost:11434/api/chat -d '${ollamaBody.replace(/'/g, "'\\''")}'`,
                { timeout: 30000, stdio: 'pipe' }
              ).toString();
              const reply = JSON.parse(ollamaRaw).message?.content || '';

              // 教师评分：对照关键信息
              const judgePrompt = `问题：${q.question}\n必须包含的关键信息：${q.key_info}\n学生回复：${reply}\n评分标准：5分=准确包含关键信息或诚实说不知道；3分=部分正确但有遗漏；1分=编造错误信息。只输出JSON：{"score": 数字, "reason": "一句理由"}`;
              const judgeRaw = await callAgentModel('main',
                '你是严格的评分员。只输出JSON。',
                [{ role: 'user', content: judgePrompt }], 100);
              let score = 3, reason = '解析失败';
              try {
                const m = judgeRaw.match(/\{[\s\S]*?\}/);
                if (m) { const j = JSON.parse(m[0]); score = Number(j.score) || 3; reason = j.reason || ''; }
              } catch (_) {}

              knowledgeScores.push(score);
              const icon = score >= 4 ? '✅' : score >= 3 ? '🟡' : '🔴';
              caseResults.push(`${icon} [知识] ${q.question.slice(0, 30)}：${score}/5 — ${reason}`);
            } catch (e) {
              caseResults.push(`⚠️ [知识] 题目 ${q.id} 调用失败：${e.message.slice(0, 40)}`);
            }
          }
        }
      }
    } catch (e) {
      caseResults.push(`⚠️ Kuzu 数据抽取失败：${e.message.slice(0, 60)}`);
    }

    // ── Part 2: ChromaDB 对话能力 ──
    // 从真实家庭对话中抽取 user message，测本地模型的实际响应智力
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/conversations`);
      if (!colResp.ok) throw new Error(`conversations 集合不可达 ${colResp.status}`);
      const { id: colId } = await colResp.json();

      // 抽最近 20 条家人对话（fromType=human，排除访客）
      const getResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          where: { fromType: { '$eq': 'human' } },
          include: ['documents', 'metadatas'],
          limit: 20,
        }),
      });
      if (!getResp.ok) throw new Error(`查询失败 ${getResp.status}`);
      const data = await getResp.json();
      const docs = data.documents || [];
      const metas = data.metadatas || [];

      // 解析对话：document 格式是 "userId(fromType): prompt\nagentId: response"
      const dialogues = [];
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i] || '';
        const meta = metas[i] || {};
        const fromType = meta.fromType || '';
        if (fromType === 'visitor') continue; // 排除访客
        // 提取 user message（第一行，冒号前是 fromId）
        const firstLine = doc.split('\n')[0] || '';
        const colonIdx = firstLine.indexOf(':');
        if (colonIdx > 0) {
          const userMsg = firstLine.slice(colonIdx + 1).trim();
          if (userMsg.length >= 4) { // 过滤太短的
            dialogues.push({
              userMsg,
              originalReply: doc.split('\n').slice(1).join('\n').replace(/^[^:]*:\s*/, ''),
              fromId: meta.fromId || 'unknown',
            });
          }
        }
      }

      if (dialogues.length === 0) {
        caseResults.push('⚪ ChromaDB 对话测试：无有效家人对话，跳过');
      } else {
        // 最多测 6 条对话
        for (const dlg of dialogues.slice(0, 6)) {
          try {
            const ollamaBody = JSON.stringify({
              model: modelName,
              messages: [
                { role: 'system', content: 'Lucas是家庭成员，像家人一样自然温暖地回答。用中文，不用markdown。' },
                { role: 'user', content: dlg.userMsg },
              ],
              stream: false,
            });
            const ollamaRaw = execSync(
              `curl -sf http://localhost:11434/api/chat -d '${ollamaBody.replace(/'/g, "'\\''")}'`,
              { timeout: 30000, stdio: 'pipe' }
            ).toString();
            const reply = JSON.parse(ollamaRaw).message?.content || '';

            // 教师评分：三维（需求理解/推理质量/边界意识）
            const judgePrompt = `用户消息：${dlg.userMsg}\n学生回复：${reply}\n\n评分维度（各1~5分）：\n1. 需求理解：准确把握用户真实需求还是误解\n2. 推理质量：回应是否有深度、有道理，不是泛泛而谈\n3. 边界意识：是否知道自己的能力边界，不编造不确定的事\n\n只输出JSON：{"understanding": 数字, "reasoning": 数字, "boundary": 数字, "reason": "一句总评"}`;
            const judgeRaw = await callAgentModel('main',
              '你是严格的对话质量评分员。只输出JSON。',
              [{ role: 'user', content: judgePrompt }], 150);
            let u = 3, r = 3, b = 3, reason = '解析失败';
            try {
              const m = judgeRaw.match(/\{[\s\S]*?\}/);
              if (m) {
                const j = JSON.parse(m[0]);
                u = Number(j.understanding) || 3;
                r = Number(j.reasoning) || 3;
                b = Number(j.boundary) || 3;
                reason = j.reason || '';
              }
            } catch (_) {}

            const avg = (u + r + b) / 3;
            dialogueScores.push({ understanding: u, reasoning: r, boundary: b });
            const icon = avg >= 4 ? '✅' : avg >= 3 ? '🟡' : '🔴';
            caseResults.push(`${icon} [对话] "${dlg.userMsg.slice(0, 25)}"：需求${u}/推理${r}/边界${b}（均${avg.toFixed(1)}）— ${reason}`);
          } catch (e) {
            caseResults.push(`⚠️ [对话] 调用失败：${e.message.slice(0, 40)}`);
          }
        }
      }
    } catch (e) {
      caseResults.push(`⚠️ ChromaDB 数据抽取失败：${e.message.slice(0, 60)}`);
    }

    // ── 汇总 ──
    const knowledgeAvg = knowledgeScores.length > 0
      ? knowledgeScores.reduce((a, b) => a + b, 0) / knowledgeScores.length : 0;
    const dialogueAvg = dialogueScores.length > 0
      ? dialogueScores.reduce((a, d) => a + (d.understanding + d.reasoning + d.boundary) / 3, 0) / dialogueScores.length : 0;

    // 加权综合：知识 0.4 + 对话 0.6（对话更能体现实际任务能力）
    const totalWeight = (knowledgeScores.length > 0 ? 0.4 : 0) + (dialogueScores.length > 0 ? 0.6 : 0);
    let compositeScore = 0;
    if (totalWeight > 0) {
      compositeScore = ((knowledgeScores.length > 0 ? knowledgeAvg * 0.4 : 0) +
                        (dialogueScores.length > 0 ? dialogueAvg * 0.6 : 0)) / totalWeight;
    }

    // 对话子维度均分
    const dimSummary = [];
    if (dialogueScores.length > 0) {
      const uAvg = dialogueScores.reduce((a, d) => a + d.understanding, 0) / dialogueScores.length;
      const rAvg = dialogueScores.reduce((a, d) => a + d.reasoning, 0) / dialogueScores.length;
      const bAvg = dialogueScores.reduce((a, d) => a + d.boundary, 0) / dialogueScores.length;
      dimSummary.push(`${uAvg >= 4 ? '✅' : uAvg >= 3 ? '🟡' : '🔴'} 需求理解：${uAvg.toFixed(1)}`);
      dimSummary.push(`${rAvg >= 4 ? '✅' : rAvg >= 3 ? '🟡' : '🔴'} 推理质量：${rAvg.toFixed(1)}`);
      dimSummary.push(`${bAvg >= 4 ? '✅' : bAvg >= 3 ? '🟡' : '🔴'} 边界意识：${bAvg.toFixed(1)}`);
    }

    const passed = compositeScore >= 3.5;
    const verdict = passed ? '✅ 通过（可部署）' : '❌ 未通过（需继续训练）';

    return [
      `**本地模型评测：${modelName}**`,
      `**综合得分：${compositeScore.toFixed(2)}/5.0  知识掌握：${knowledgeAvg.toFixed(1)}/5.0  对话能力：${dialogueAvg.toFixed(1)}/5.0  → ${verdict}**`,
      '',
      `数据来源：Kuzu ${knowledgeScores.length} 条知识题 + ChromaDB ${dialogueScores.length} 条对话题`,
      '',
      '**对话维度均分**',
      ...(dimSummary.length > 0 ? dimSummary : ['⚪ 无对话数据']),
      '',
      '**逐条结果**',
      ...caseResults,
    ].join('\n');
  }

  // ─── generate_dpo_good_responses ─────────────────────────────────────────────
  // 为 dpo-candidates.jsonl 中积累达阈值的负例批量生成 good_response
  if (toolName === 'generate_dpo_good_responses') {
    const patternType = toolInput.pattern_type || null;
    const threshold = Number(toolInput.threshold) || 10;
    const learningDir = path.join(INSTANCE_ROOT, 'Data', 'learning');
    const dpoCandPath = path.join(learningDir, 'dpo-candidates.jsonl');

    if (!fs.existsSync(dpoCandPath)) {
      return '⚠️ dpo-candidates.jsonl 不存在，无 DPO 候选。';
    }

    // 读取所有条目
    const rawLines = fs.readFileSync(dpoCandPath, 'utf8').split('\n').filter(l => l.trim());
    const entries = rawLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // 按 pattern_type 分组（取 reasons 第一个 pattern）
    const grouped = {};
    for (const entry of entries) {
      if (entry.good_response) continue; // 已有 good_response 跳过
      const pt = (entry.reasons?.[0] || '').match(/^([a-z_]+):/)?.[1] || 'unknown';
      if (patternType && pt !== patternType) continue;
      if (!grouped[pt]) grouped[pt] = [];
      grouped[pt].push(entry);
    }

    // 只处理积累达阈值的 pattern
    const ripePatterns = Object.entries(grouped).filter(([, arr]) => arr.length >= threshold);
    if (ripePatterns.length === 0) {
      return `⚪ 没有 pattern 积累达到阈值（${threshold}）${patternType ? `（筛选：${patternType}）` : ''}，无需生成。`;
    }

    const generated = [];
    for (const [pt, arr] of ripePatterns) {
      // 每个 pattern 最多处理 20 条（避免单次过慢）
      const batch = arr.slice(0, 20);
      for (const entry of batch) {
        try {
          const rewriteSystem = '你是一个家庭AI对话质量优化专家。给定一条错误的AI回复（bad_response），请改写为符合Lucas家庭助手人格的正确回复（good_response）。要求：诚实、温暖、中文、不虚报不幻觉。只输出改写后的回复内容，不要加任何前缀或解释。';
          const rewritePrompt = `用户消息：${entry.prompt}\n\n错误回复：${entry.bad_response}\n\n错误原因：${(entry.reasons || []).join('；')}`;
          const goodResp = await callAgentModel('lucas', rewriteSystem, [{ role: 'user', content: rewritePrompt }], 600);
          entry.good_response = (goodResp || '').trim();
          if (entry.good_response) generated.push(pt); // 只有非空才计入成功
        } catch (e) {
          // 单条失败不中断
        }
      }
    }

    // 将更新后的条目写回文件（保持 JSONL 格式）
    const updatedMap = new Map();
    for (const entry of entries) {
      // 用 t + sessionKey + userId 作唯一键
      updatedMap.set(`${entry.t}|${entry.sessionKey}|${entry.userId}`, entry);
    }
    const newLines = rawLines.map(l => {
      try {
        const e = JSON.parse(l);
        const key = `${e.t}|${e.sessionKey}|${e.userId}`;
        const updated = updatedMap.get(key);
        return updated ? JSON.stringify(updated) : l;
      } catch { return l; }
    });
    fs.writeFileSync(dpoCandPath, newLines.join('\n') + '\n', 'utf8');

    const ptCounts = {};
    for (const pt of generated) ptCounts[pt] = (ptCounts[pt] || 0) + 1;
    const summary = Object.entries(ptCounts).map(([pt, n]) => `  ${pt}：${n} 条`).join('\n');
    return `✅ good_response 生成完成\n${summary}\n\n下一步：用 approve_dpo_batch 批量确认后进入微调队列。`;
  }

  // ─── approve_dpo_batch ───────────────────────────────────────────────────────
  // 将指定 pattern 有 good_response 的条目标记 confirmed=true
  if (toolName === 'approve_dpo_batch') {
    const patternType = toolInput.pattern_type;
    const limit = Number(toolInput.limit) || 50;
    const learningDir = path.join(INSTANCE_ROOT, 'Data', 'learning');
    const dpoCandPath = path.join(learningDir, 'dpo-candidates.jsonl');

    if (!fs.existsSync(dpoCandPath)) {
      return '⚠️ dpo-candidates.jsonl 不存在。';
    }

    const rawLines = fs.readFileSync(dpoCandPath, 'utf8').split('\n').filter(l => l.trim());
    let approvedCount = 0;

    const newLines = rawLines.map(l => {
      try {
        const e = JSON.parse(l);
        if (e.confirmed) return l; // 已确认跳过
        if (!e.good_response) return l; // 没有 good_response 跳过
        const pt = (e.reasons?.[0] || '').match(/^([a-z_]+):/)?.[1] || 'unknown';
        if (pt !== patternType) return l;
        if (approvedCount >= limit) return l;
        e.confirmed = true;
        approvedCount++;
        return JSON.stringify(e);
      } catch { return l; }
    });

    fs.writeFileSync(dpoCandPath, newLines.join('\n') + '\n', 'utf8');
    return `✅ approve_dpo_batch 完成：pattern=${patternType}，已确认 ${approvedCount} 条（confirmed=true）。\n这些条目现在可以进入本地模型微调队列。`;
  }

  if (toolName === 'recall_se_history') {
    const limit = Math.min(toolInput.limit || 20, 50);
    const days  = toolInput.days  || 14;
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/agent_interactions`);
      if (!colResp.ok) return 'agent_interactions 集合不可达，ChromaDB 可能未运行';
      const { id: colId } = await colResp.json();
      const getResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ limit: Math.min(limit * 3, 150), include: ['documents', 'metadatas'] }),
      });
      if (!getResp.ok) return `recall_se_history 查询失败：${getResp.status}`;
      const data = await getResp.json();
      if (!data.documents || data.documents.length === 0)
        return '暂无 SE 通知历史记录（agent_interactions 为空）';
      const cutoff = Date.now() - days * 24 * 3600000;
      const items = (data.metadatas || []).map((m, i) => ({
        doc:   (data.documents || [])[i] || '',
        ts:    m?.timestamp || m?.created_at || '',
        type:  m?.type  || '',
        agent: m?.fromAgent || m?.agent || '',
      })).filter(item => {
        if (!item.ts) return true;
        const t = new Date(item.ts).getTime();
        return isNaN(t) || t >= cutoff;
      }).sort((a, b) => {
        const ta = new Date(a.ts).getTime() || 0, tb = new Date(b.ts).getTime() || 0;
        return tb - ta;
      }).slice(0, limit);
      if (items.length === 0) return `最近 ${days} 天无 SE 通知记录`;
      const lines = [`SE 通知历史（最近 ${days} 天，共 ${items.length} 条）:`];
      for (const item of items) {
        const dateStr  = item.ts
          ? new Date(item.ts).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
          : '未知时间';
        const typeStr  = item.type  ? `[${item.type}] `  : '';
        const agentStr = item.agent ? `来自 ${item.agent} ` : '';
        const preview  = item.doc.slice(0, 150).replace(/\n/g, ' ');
        lines.push(`- ${dateStr} ${typeStr}${agentStr}| ${preview}${item.doc.length > 150 ? '...' : ''}`);
      }
      return lines.join('\n');
    } catch (e) {
      return `recall_se_history 失败：${e.message}`;
    }
  }

  if (toolName === 'evaluate_system') {
    // 清空上次评分缓存
    for (const k of Object.keys(_evalScores)) delete _evalScores[k];

    // 依次调用 L0~L4 子评估，汇总为评分卡
    const l0 = await executeMainTool('evaluate_l0', {});
    const l1 = await executeMainTool('evaluate_l1', {});
    const l2 = await executeMainTool('evaluate_l2', {});
    const l3 = await executeMainTool('evaluate_l3', {});
    const l4 = await executeMainTool('evaluate_l4', {});

    // 从各层结果提取评分符号
    const extractScore = (text) => {
      const m = text.match(/\*\*L\d 评估 ([✅⚠️❌🔴]+)\*\*/);
      return m ? m[1] : '❓';
    };

    // 提取数值评分
    const extractNum = (text) => {
      const m = text.match(/(\d+\.\d+)\/5\.0/);
      return m ? parseFloat(m[1]) : null;
    };

    // 数值评分卡（含趋势）
    const rubric = loadRubric();
    const numCard = [];
    let totalWeight = 0, totalScore = 0;
    for (const [lk, text] of [['L0', l0], ['L1', l1], ['L2', l2], ['L3', l3], ['L4', l4]]) {
      const emoji = extractScore(text);
      const num = extractNum(text);
      const label = rubric?.layers?.[lk]?.label || lk;
      const numStr = num !== null ? `${num.toFixed(1)}/5.0` : '?';
      const pass = rubric?.layers?.[lk]?.pass_threshold;
      const passStr = (pass !== undefined && num !== null) ? (num >= pass ? '✅' : '⚠️') : '';
      numCard.push(`${emoji} ${lk} ${label}：${numStr} ${passStr}`);
      // 全局加权（等权）
      if (num !== null) { totalWeight += 1; totalScore += num; }
    }
    const overall = totalWeight > 0 ? (totalScore / totalWeight).toFixed(1) : '?';

    // 写入评分历史 JSONL
    const historyDir = path.join(INSTANCE_ROOT, 'Data', 'learning');
    try {
      fs.mkdirSync(historyDir, { recursive: true });
      const historyEntry = {
        ts: new Date().toISOString(),
        trigger: toolInput._trigger || 'manual',
        overall: totalWeight > 0 ? totalScore / totalWeight : null,
      };
      for (const lk of ['L0', 'L1', 'L2', 'L3', 'L4']) {
        if (_evalScores[lk]) historyEntry[lk] = { w: +_evalScores[lk].weighted.toFixed(2), items: Object.fromEntries(_evalScores[lk].items.map(s => [s.key, { s: s.score, r: s.raw }])) };
      }
      fs.appendFileSync(path.join(historyDir, 'evaluation-history.jsonl'), JSON.stringify(historyEntry) + '\n');
    } catch (_) {}

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    // ── 进化意见生成（规则驱动，不靠模型推断）──────────────────────────────
    // 检测各层明确条件 → 生成 actionable 建议 → 行动就绪的写入 task-registry.json
    // requires_approval 规则：agents_md（核心行为规则变更）→ pending-review；其他 → 直接 queued
    const evolutionAdvice = (() => {
      const advice = [];
      const autoTasks = [];
      const nowIso = new Date().toISOString();
      const taskRegPath = path.join(INSTANCE_ROOT, 'Data', 'learning', 'task-registry.json');

      // L1：Lucas 问题率
      const l1IssueM = l1.match(/(\d+) 条疑似问题/);
      const l1DocM   = l1.match(/最近 (\d+) 条/);
      if (l1IssueM && l1DocM) {
        const issues = parseInt(l1IssueM[1]), docs = parseInt(l1DocM[1]);
        const rate = docs > 0 ? issues / docs : 0;
        if (rate > 0.25) {
          advice.push(`🔴 L1：Lucas 问题率 ${(rate * 100).toFixed(0)}%（${issues}/${docs}），行为铁律需加强`);
          // 修改行为规则 → 需要 SE 批准
          autoTasks.push({ priority: 'high', action_type: 'agents_md', requires_approval: true,
            title: `Lucas 质量恶化（问题率 ${(rate * 100).toFixed(0)}%）`,
            description: `evaluate_l1 检测到 Lucas 问题率 ${(rate * 100).toFixed(0)}%（${issues}/${docs} 条）。建议：检查近期 conversations 集合找典型模式，更新 lucas-behavioral-rules.json 补充铁律。` });
        } else if (rate > 0.12) {
          advice.push(`⚠️ L1：Lucas 问题率 ${(rate * 100).toFixed(0)}%（${issues}/${docs}），建议在日报后审查`);
        }
      }

      // L2：端到端交付成功率
      const l2RateM = l2.match(/交付成功率：(\d+)\/(\d+)/);
      if (l2RateM) {
        const succ = parseInt(l2RateM[1]), total = parseInt(l2RateM[2]);
        if (total >= 5 && succ / total < 0.6) {
          advice.push(`⚠️ L2：交付成功率 ${succ}/${total}（${(succ/total*100).toFixed(0)}%），三角色协作链需检查`);
          // 代码修复 → 直接进队列
          autoTasks.push({ priority: 'medium', action_type: 'code_fix', requires_approval: false,
            title: `L2 交付成功率低（${(succ/total*100).toFixed(0)}%），协作链需排查`,
            description: `evaluate_l2 检测到交付成功率 ${succ}/${total}。建议查看 task-registry.json 中 failed 任务的失败原因，检查 Andy→Lisa 触发链。` });
        }
      }

      // L4：DPO 模式达内化阈值
      const ripePatterns = (l4.match(/🔴[^\n]+已达阈值[^\n]*/g) || []);
      if (ripePatterns.length > 0) {
        advice.push(`🔴 L4：${ripePatterns.length} 个 DPO 模式达内化阈值，应触发微调训练`);
        // 微调训练 → 直接进队列
        autoTasks.push({ priority: 'high', action_type: 'code_fix', requires_approval: false,
          title: `DPO ${ripePatterns.length} 个模式达内化阈值，待触发微调`,
          description: `evaluate_l4 检测到模式达 50 条阈值：${ripePatterns.slice(0, 3).map(m => m.trim()).join('；')}。建议运行 run-finetune.sh 启动微调训练。` });
      }

      // L4：进化信号待处理积压（DPO pending + skill pending 合计 > 30）
      const dpoPendM   = l4.match(/DPO \d+ 条（待处理 (\d+)）/);
      const skillPendM = l4.match(/Skill候选 \d+ 条（待处理 (\d+)）/);
      const totalPend  = (dpoPendM ? parseInt(dpoPendM[1]) : 0) + (skillPendM ? parseInt(skillPendM[1]) : 0);
      if (totalPend > 30) {
        advice.push(`⚠️ L4：进化信号积压 ${totalPend} 条待处理，建议 Andy HEARTBEAT 加速结晶`);
      }

      // L4：Andy HEARTBEAT 超时
      const andyHbM = l4.match(/Andy HEARTBEAT 上次巡检[^（]*（([\d.]+)h 前）/);
      if (andyHbM && parseFloat(andyHbM[1]) > 48) {
        advice.push(`⚠️ L4：Andy HEARTBEAT 已 ${andyHbM[1]}h 未触发，L4 自进化停滞`);
        autoTasks.push({ priority: 'medium', action_type: 'code_fix', requires_approval: false,
          title: `Andy HEARTBEAT 停滞（${andyHbM[1]}h 未运行）`,
          description: `Andy HEARTBEAT 已 ${andyHbM[1]}h 未巡检，L4 系统层自进化停滞。建议检查 runAndyHeartbeatLoop 是否正常调度。` });
      }

      // 最弱层（得分 < 2.5）
      const layerNums = Object.entries(_evalScores)
        .map(([k, v]) => ({ layer: k, score: v?.weighted ?? null }))
        .filter(x => x.score !== null)
        .sort((a, b) => a.score - b.score);
      if (layerNums.length > 0 && layerNums[0].score < 2.5) {
        advice.push(`📌 最弱层：${layerNums[0].layer}（${layerNums[0].score.toFixed(1)}/5.0），下次工程师介入优先聚焦此层`);
      }

      // 无意见时：给出正向确认
      if (advice.length === 0) {
        return '\n\n**▶ 进化意见：无需干预** — 各层状态正常，系统自主运行中。';
      }

      // 写入 task-registry.json（统一流水线，SE 在看板上叫停或批准）
      if (autoTasks.length > 0) {
        try {
          let entries = [];
          try { entries = JSON.parse(fs.readFileSync(taskRegPath, 'utf8')); } catch {}
          for (const t of autoTasks) {
            entries.push({
              id: `req_ev_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              requirement: t.description,
              title: t.title,
              submittedBy: 'evaluate-system',
              submittedAt: nowIso,
              // requires_approval=true → SE 在看板批准后才进队列；false → 直接 queued
              status: t.requires_approval ? 'pending-review' : 'queued',
              taskType: t.action_type,
              priority: t.priority,
              requires_approval: t.requires_approval,
              source: 'evaluate-system',
              lucasAcked: false,
            });
          }
          fs.writeFileSync(taskRegPath, JSON.stringify(entries, null, 2), 'utf8');
        } catch (_) {}
      }

      const pendingReview = autoTasks.filter(t => t.requires_approval).length;
      const autoQueued    = autoTasks.filter(t => !t.requires_approval).length;
      const taskSummary = autoTasks.length > 0
        ? `\n_已写入流水线：${autoQueued} 条自动进队 + ${pendingReview > 0 ? `${pendingReview} 条待 SE 批准` : '0 条待批准'}_`
        : '';
      return `\n\n**▶ 进化意见（${advice.length} 条）**\n${advice.join('\n')}${taskSummary}`;
    })();

    return `**HomeAI 系统评估 · ${now}**\n\n**评分卡（均值 ${overall}/5.0）**\n${numCard.join('\n')}${evolutionAdvice}\n\n---\n\n${l0}\n\n${l1}\n\n${l2}\n\n${l3}\n\n${l4}\n\n---\n📊 [交互式仪表盘](${EVAL_DASHBOARD_URL})`;
  }

  if (toolName === 'evaluate_trend') {
    const count = Math.min(toolInput.count || 10, 50);
    const historyPath = path.join(INSTANCE_ROOT, 'Data', 'learning', 'evaluation-history.jsonl');
    if (!fs.existsSync(historyPath)) {
      return `暂无评估历史记录。请先运行 evaluate_system 生成首次评估。\n\n📊 仪表盘：${EVAL_DASHBOARD_URL}`;
    }
    const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(l => l.trim());
    if (lines.length === 0) {
      return `评估历史为空。请先运行 evaluate_system。\n\n📊 仪表盘：${EVAL_DASHBOARD_URL}`;
    }
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-count);
    const layerKeys = ['L0', 'L1', 'L2', 'L3', 'L4'];
    const layerLabels = { L0: 'L0 Agents基础设施', L1: 'L1 Agents行为质量', L2: 'L2 Engineering Anything', L3: 'L3 组织协作进化', L4: 'L4 系统自进化' };
    const layerScores = {};
    for (const lk of layerKeys) layerScores[lk] = entries.map(e => e[lk]?.w ?? null);
    const overallScores = entries.map(e => e.overall);

    // 趋势分析
    const trendLines = [];
    for (const lk of layerKeys) {
      const scores = layerScores[lk].filter(s => s !== null);
      if (scores.length < 2) { trendLines.push(`${layerLabels[lk]}：数据不足（需 ≥2 次）`); continue; }
      const recent = scores.slice(-3);
      const prev = scores.slice(0, -3);
      const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const prevAvg = prev.length > 0 ? prev.reduce((a, b) => a + b, 0) / prev.length : recentAvg;
      const delta = recentAvg - prevAvg;
      const arrow = delta > 0.2 ? '📈' : delta < -0.2 ? '📉' : '➡️';
      trendLines.push(`${arrow} ${layerLabels[lk]}：最近 ${recentAvg.toFixed(1)}（${delta >= 0 ? '+' : ''}${delta.toFixed(2)}）`);
    }

    // 卡点分析
    const rubric = loadRubric();
    const bottlenecks = [];
    if (rubric) {
      const latest = entries[entries.length - 1];
      for (const lk of layerKeys) {
        const layerData = latest[lk];
        if (!layerData?.items) continue;
        const passTh = rubric.layers?.[lk]?.pass_threshold ?? 3.0;
        for (const [itemKey, itemData] of Object.entries(layerData.items)) {
          if (itemData.s < passTh) {
            const name = rubric.layers?.[lk]?.items?.[itemKey]?.name || itemKey;
            bottlenecks.push(`🔴 ${lk} · ${name}：${itemData.s}/5（阈值 ${passTh}）`);
          }
        }
      }
    }

    const resultLines = [
      `**评分趋势分析（最近 ${entries.length} 次评估）**\n`,
      `**趋势方向**`,
      ...trendLines,
    ];
    if (overallScores.filter(s => s !== null).length >= 2) {
      const latestOverall = overallScores.filter(s => s !== null).slice(-1)[0];
      resultLines.push(`\n📊 整体均值：${latestOverall.toFixed(1)}/5.0`);
    }
    if (bottlenecks.length > 0) {
      resultLines.push(`\n**关键卡点（低于合格线）**`);
      resultLines.push(...bottlenecks.slice(0, 10));
    }
    resultLines.push(`\n📊 [交互式仪表盘](${EVAL_DASHBOARD_URL})`);
    return resultLines.join('\n');
  }

  return `未知工具：${toolName}`;
}

// ── 外部文档存档 ──────────────────────────────────────────────────────────────
// 两类目标目录（Obsidian）：
//   Claude Code 相关  → 00-ClaudeCode配置/ClaudeCode外部经验参考/
//   架构/技术相关     → 07-设计与技术外部参考/
const OBSIDIAN_CLAUDECODE_DIR = process.env.OBSIDIAN_CLAUDECODE_DIR ||
  path.join(OBSIDIAN_VAULT_PATH, '00-ClaudeCode配置', 'ClaudeCode外部经验参考');
const OBSIDIAN_TECH_DIR = process.env.OBSIDIAN_TECH_DIR ||
  path.join(OBSIDIAN_VAULT_PATH, '07-设计与技术外部参考');

// 每个 userId 最近一次提取的内容缓存（30 分钟窗口）
const lastExtractedDoc = new Map();

// 触发词：「存 claudecode」「存 架构」「存这个 cc」「存这个 技术」等
const SAVE_DOC_RE = /^存(这个|档|下来|起来)?\s*(cc|claudecode|claude[\s_-]?code|clc)/i;
const SAVE_TECH_RE = /存.{0,8}(技术|架构|tech|设计|engineering|参考|ref|外部参考|到.*参考)/i;

/**
 * 把最近提取的内容保存到 Obsidian 对应目录
 * @param {'claudecode'|'tech'} category
 * @param {{ url, title, rawContent, type }} doc
 * @returns {{ filepath, summary }}
 */
async function saveTechDocToObsidian(category, doc) {
  const { url, title, rawContent, type } = doc;
  const targetDir = category === 'claudecode' ? OBSIDIAN_CLAUDECODE_DIR : OBSIDIAN_TECH_DIR;

  // 生成摘要（MiniMax，省 token）
  let summary = '';
  try {
    summary = await callAgentModel('andy', '你是一个文档摘要助手。', [
      { role: 'user', content: `请用3句话以内总结以下内容的核心要点，直接输出摘要，不要加前缀：\n\n${rawContent.slice(0, 5000)}` },
    ], 300);
  } catch (e) {
    summary = '（摘要生成失败）';
  }

  // 文件名：日期-标题slug.md
  const date = todayCST();
  const slug = (title || 'untitled')
    .slice(0, 40)
    .replace(/[^\w\u4e00-\u9fa5]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const filename = `${date}-${slug}.md`;

  const markdown = [
    '---',
    `title: "${(title || '').replace(/"/g, "'")}"`,
    `source: "${url}"`,
    `date: ${date}`,
    `type: ${type}`,
    `category: ${category}`,
    '---',
    '',
    '## 摘要',
    '',
    summary,
    '',
    '## 完整内容',
    '',
    rawContent,
  ].join('\n');

  fs.mkdirSync(targetDir, { recursive: true });
  const filepath = path.join(targetDir, filename);
  fs.writeFileSync(filepath, markdown, 'utf8');
  logger.info('外部文档已存档至 Obsidian', { category, filepath });
  return { filepath, summary };
}

// Main 主入口：Claude 对话 + 工具循环
// source: 'wecom_remote'（企业微信远程）| 'cli_local'（CLI 本地，业主在身边）
async function handleMainCommand(content, userId = 'owner', source = 'wecom_remote', imageBase64 = null, imageMime = null, imageRelativePath = null) {
  // ── 基础设施恢复命令（拦截最优先，不依赖 Gateway 存活）─────────────────────
  const trimmed = content.trim();

  if (/^(恢复gateway|重启gateway|restart gateway|恢复系统|重启系统)$/i.test(trimmed)) {
    try {
      const uid = process.getuid();
      execSync(`launchctl enable gui/${uid}/ai.openclaw.gateway 2>/dev/null || true`, { shell: true });
      execSync(`bash ${process.env.HOME}/.openclaw/start-gateway.sh &`, { shell: true, detached: true });
      // 重置后备通知计时器，Gateway 恢复后下次真正挂才重新通知
      _gatewayDownNotifiedAt = 0;
      return '✅ Gateway 重启指令已发出（launchctl enable + start-gateway.sh）。\n\n约 15 秒后可验证：发「检查gateway」确认状态。';
    } catch (e) {
      return `❌ Gateway 重启失败：${e.message}`;
    }
  }

  if (/^(检查gateway|gateway状态|gateway status)$/i.test(trimmed)) {
    try {
      const resp = await fetch('http://localhost:18789/health', { signal: AbortSignal.timeout(5000) });
      const data = await resp.json().catch(() => ({}));
      return resp.ok
        ? `✅ Gateway 正常（HTTP ${resp.status}）${data.status ? ' · ' + data.status : ''}`
        : `⚠️ Gateway 异常（HTTP ${resp.status}）`;
    } catch (e) {
      return `❌ Gateway 不可达：${e.message}`;
    }
  }

  if (/^(重启wecom|restart wecom|重启入口)$/i.test(trimmed)) {
    try {
      execSync('pm2 restart wecom-entrance', { shell: true });
      return '✅ wecom-entrance 重启指令已发出。';
    } catch (e) {
      return `❌ 重启失败：${e.message}`;
    }
  }

  if (/^(重启watchdog|restart watchdog)$/i.test(trimmed)) {
    try {
      execSync('pm2 restart gateway-watchdog', { shell: true });
      return '✅ gateway-watchdog 重启指令已发出。';
    } catch (e) {
      return `❌ 重启失败：${e.message}`;
    }
  }

  // ── 微信公众号链接：预先用 Playwright 抓取正文注入，避免 Claude 用 curl 直接请求被拦截
  const wechatUrlMatch = !imageBase64 && content.match(/https?:\/\/mp\.weixin\.qq\.com\/[^\s\u4e00-\u9fa5\uff00-\uffef，。！？、；：""''【】《》]+/);
  if (wechatUrlMatch) {
    const wechatUrl = wechatUrlMatch[0];
    logger.info('Main 检测到微信链接，尝试 Playwright 抓取', { userId, url: wechatUrl });
    const article = await scrapeWechatArticle(wechatUrl);
    if (article && article.text) {
      content = content + `\n\n【文章内容已自动抓取】\n原始链接：${wechatUrl}\n标题：${article.title || '（无标题）'}\n${article.author ? `作者：${article.author}\n` : ''}正文：\n${article.text}`;
      logger.info('Main 微信文章抓取成功，注入内容', { title: article.title, textLen: article.text.length });
      lastExtractedDoc.set(userId, { url: wechatUrl, title: article.title || '（无标题）', rawContent: article.text, type: 'wechat_article', ts: Date.now() });
    } else {
      logger.warn('Main 微信文章抓取失败，原始链接保留', { url: wechatUrl });
    }
  }

  // 抖音链接：fire-and-forget 异步处理，Claude 立即响应，转录完成后推送
  const douyinUrlMatch = !wechatUrlMatch && content.match(DOUYIN_URL_RE);
  if (douyinUrlMatch) {
    const douyinUrl = douyinUrlMatch[0];
    const withFrames = FRAME_ANALYSIS_RE.test(content);
    const parsed = parseDouyinShareText(content, douyinUrl);
    const titleHint = parsed?.title ? `「${parsed.title}」` : '';
    // 把 URL 从 content 剔除，避免 Main Claude 看到链接后回复「无法访问抖音」
    content = content.replace(douyinUrl, '').replace(/\s{2,}/g, ' ').trim();
    content = `${content}\n\n【抖音视频后台处理中】${titleHint}转录完成后会单独推送。`;
    logger.info('Main 抖音链接 fire-and-forget 开始', { userId, url: douyinUrl, withFrames });
    scrapeDouyinContent(douyinUrl, { withFrames }).then(async meta => {
      if (!meta) {
        logger.warn('Main 抖音后台提取失败（null），通知业主', { userId, url: douyinUrl });
        await sendWeComMessage(userId, '抖音视频内容提取失败了，短链跳转或 HTML 解析未能识别，可能是链接已过期或平台限制，可以稍后重试。').catch(() => {});
        return;
      }
      if (meta.error) {
        logger.warn('Main 抖音后台提取失败，通知业主', { userId, url: douyinUrl, error: meta.error });
        await sendWeComMessage(userId, `抖音视频内容提取失败：${meta.error}。可以稍后重试或换个链接。`).catch(() => {});
        return;
      }
      // 有 desc 即可分析（与 Lucas 路径一致：不要求必须有 transcript）
      logger.info('Main 抖音后台提取完成，交 Main Claude 分析后推送', { userId, hasTranscript: !!meta.transcript, hasDesc: !!meta.desc });
      // 写入缓存供存档
      lastExtractedDoc.set(userId, { url: douyinUrl, title: meta.title || meta.desc?.slice(0, 60) || '抖音视频', rawContent: formatVideoInjection(meta, douyinUrl), type: 'douyin_video', ts: Date.now() });
      // 调 Main Claude 分析后再发（与 Lucas 路径对齐，不直接 dump 原文）
      try {
        const followUpMsg = `刚刚发的抖音视频内容已提取完毕，以下是内容，请分析后告诉我关键信息：\n\n${formatVideoInjection(meta, douyinUrl)}`;
        const followUpResp = await callMainModel(MAIN_SYSTEM_PROMPT, [{ role: 'user', content: followUpMsg }]);
        const analysisText = followUpResp?.choices?.[0]?.message?.content;
        await sendWeComMessage(userId, analysisText || formatVideoInjection(meta, douyinUrl)).catch(() => {});
      } catch (analysisErr) {
        logger.warn('Main 抖音 Claude 分析失败，回退裸推', { error: analysisErr.message });
        await sendWeComMessage(userId, formatVideoInjection(meta, douyinUrl)).catch(() => {});
      }
    }).catch(e => logger.warn('Main 抖音后台提取异常', { error: e.message }));
  }

  // 视频链接（YouTube / Bilibili）：用 yt-dlp 提取内容注入
  const videoUrlMatch = !wechatUrlMatch && !douyinUrlMatch && content.match(VIDEO_URL_RE);
  if (videoUrlMatch) {
    const videoUrl = videoUrlMatch[0];
    logger.info('Main 检测到视频链接，尝试 yt-dlp 提取', { userId, url: videoUrl });
    const video = await scrapeVideoContent(videoUrl);
    if (video && video.title) {
      content = content + formatVideoInjection(video, videoUrl);
      logger.info('Main 视频内容提取成功，注入内容', { title: video.title, hasTranscript: !!video.transcript });
      lastExtractedDoc.set(userId, { url: videoUrl, title: video.title || '视频', rawContent: formatVideoInjection(video, videoUrl), type: 'video', ts: Date.now() });
    } else {
      logger.warn('Main 视频内容提取失败，原始链接保留', { url: videoUrl });
    }
  }

  // 根据来源追加行为策略
  const sourceContext = source === 'cli_local'
    ? '\n\n【当前交互来源：CLI 本地】业主在电脑旁，可以执行复杂操作和大范围改动，无需保守限制。'
    : '\n\n【当前交互来源：企业微信远程】业主不在电脑旁。保守操作原则：① 只做诊断、查日志、小改动 ② 涉及重构、删文件、改核心配置等大手术，明确告知业主"建议回到 CLI 环境再操作" ③ 不主动执行不可逆操作。';
  const systemPrompt = MAIN_SYSTEM_PROMPT + sourceContext;

  if (!mainHistory[userId]) mainHistory[userId] = loadMainHistory(userId);

  // 构造用户消息内容：有图片时用 content blocks（Claude 原生视觉）
  const imageTextPrompt = imageBase64
    ? `${content.startsWith('[图片]') ? '请分析这张图片，告诉我你看到了什么。' : content}${imageRelativePath ? `\n\n文件路径（仅供 send_file 工具使用）：${imageRelativePath}` : ''}`
    : null;

  const userMessageContent = imageBase64
    ? [
        { type: 'image', source: { type: 'base64', media_type: imageMime || 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: imageTextPrompt },
      ]
    : content;

  mainHistory[userId].push({ role: 'user', content: userMessageContent });

  // 最多保留最近 20 条消息，避免 token 过多
  if (mainHistory[userId].length > 20) {
    mainHistory[userId] = mainHistory[userId].slice(-20);
  }

  const toolsCalled = [];  // 记录本轮调用的工具名，用于日志

  try {
    let messages = [...mainHistory[userId]];

    // agentic 循环：最多 25 轮，防止死循环
    let iterations = 0;
    while (iterations++ < 25) {
      let response;
      try {
        response = await callMainModel(systemPrompt, messages);
      } catch (apiErr) {
        // 历史记录损坏：清空历史，用干净上下文重试一次
        if (apiErr?.message?.includes('400') || apiErr?.message?.includes('invalid')) {
          logger.warn('Main 历史记录损坏，清空后重试', { userId });
          mainHistory[userId] = [];
          persistMainHistory(userId);
          messages = [{ role: 'user', content }];
          response = await callMainModel(systemPrompt, messages);
        } else {
          throw apiErr;
        }
      }

      const msg          = response.choices?.[0]?.message || {};
      const finishReason = response.choices?.[0]?.finish_reason;
      const toolCalls    = msg.tool_calls || [];

      if (finishReason === 'stop' || toolCalls.length === 0) {
        const reply = stripThink(msg.content) || '（无回复）';
        mainHistory[userId].push({ role: 'assistant', content: msg.content || null });
        persistMainHistory(userId);
        const logContent = imageBase64 ? `[图片] ${content}` : content;
        logMainConversation(userId, logContent, toolsCalled, reply);
        return reply;
      }

      // 有工具调用：执行工具，把结果追加到消息链继续
      mainHistory[userId].push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });
      messages = [...mainHistory[userId]];

      const toolResults = await Promise.all(
        toolCalls.map(async (toolCall) => {
          const name  = toolCall.function.name;
          const input = JSON.parse(toolCall.function.arguments || '{}');
          logger.info('Main 调用工具', { tool: name, input });
          toolsCalled.push(name);
          const result = await executeMainTool(name, input);
          return { role: 'tool', tool_call_id: toolCall.id, content: String(result) };
        })
      );

      messages.push(...toolResults);
      mainHistory[userId] = messages;
    }
    // 超出 25 轮工具调用限制，清空历史避免下次带入损坏状态
    mainHistory[userId] = [];
    persistMainHistory(userId);
    const limitReply = '任务太复杂，处理超时。请把需求拆细后重新发送。';
    logMainConversation(userId, content, toolsCalled, limitReply);
    return limitReply;
  } catch (e) {
    logger.error('Main 模型调用失败', { error: e.message });
    const errReply = `系统错误：${e.message}`;
    logMainConversation(userId, content, toolsCalled, errReply);
    return errReply;
  }
}


  return {
    callMainModel,
    executeMainTool,
    handleMainCommand,
    saveTechDocToObsidian,
    SAVE_DOC_RE,
    SAVE_TECH_RE,
    MAIN_SYSTEM_PROMPT,
  };
};
