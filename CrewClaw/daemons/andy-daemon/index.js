/**
 * Andy 守护进程 - 方案设计师
 * 端口: 3001
 * 职责: 软件工程六步流水线 —— 需求分析 → 领域建模 → 技术选型 → 模块设计 → 风险评估 → 实现规格
 *
 * 设计原则：软件工程方法论代码化
 *   每一步独立调用模型，结果显式传递，不依赖单次调用的发挥好坏
 *   任何一步 JSON 解析失败，fallback 是有意义的降级，而非空壳
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const winston = require('winston');
const path = require('path');

const ContextManager = require('../shared/context-manager');
const { modelRouter } = require('../shared/model-router');
const { evolutionTracker } = require('../shared/evolution-tracker');
const workspaceLoader = require('../shared/workspace-loader');

// Andy soul（角色认知），启动时懒加载
let _andySoul = null;
async function loadAndySoul() {
  if (_andySoul) return _andySoul;
  const soul = await workspaceLoader.loadSoul('andy');
  _andySoul = soul || '你是 Andy，HomeAI 系统的系统架构师，负责把需求转化为可执行的技术方案。';
  return _andySoul;
}

// ─── 日志 ──────────────────────────────────────────────────────────────────

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, '../../logs/andy-daemon.log')
    }),
    new winston.transports.Console()
  ]
});

// ─── Express ───────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.ANDY_PORT || 3001;

app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', service: 'andy', port: PORT });
});

// Lucas 调用的统一入口（兼容 message / task / requirement 三种字段名）
app.post('/api/dev/task', async (req, res) => {
  const { message, task, requirement: reqField, userId = 'default', intent } = req.body;
  const requirement = message || task || reqField || '';
  logger.info('收到 Lucas 开发任务', { requirement: requirement.substring(0, 100), intent });
  req.body.requirement = requirement;
  return designHandler(req, res);
});

app.post('/api/andy/design', designHandler);

// CrewClaw Gateway 统一入口（daemon proxy 调用此端点）
app.post('/api/chat', async (req, res) => {
  const { message, task, requirement: reqField, userId = 'default', intent } = req.body;
  const requirement = message || task || reqField || '';
  logger.info('收到 /api/chat 请求', { requirement: requirement.substring(0, 100), intent });
  req.body.requirement = requirement;
  return designHandler(req, res);
});

// ─── 主流水线入口 ──────────────────────────────────────────────────────────

async function designHandler(req, res) {
  const { requirement, userId = 'default' } = req.body;
  logger.info('Received design request', { requirement: requirement?.substring(0, 100), userId });

  ContextManager.addToHistory(userId, 'user', `需求: ${requirement}`);

  const pipelineStart = Date.now();
  const executionTrace = [];  // 可观测性：记录每步执行情况，供未来自主进化分析

  try {
    const step1 = await runStep('需求分析',     1, () => analyzeRequirements(requirement), executionTrace);
    const step2 = await runStep('领域建模',     2, () => modelDomain(requirement, step1), executionTrace);
    const step3 = await runStep('技术选型',     3, () => selectTechnology(requirement, step1, step2), executionTrace);
    const step4 = await runStep('模块设计',     4, () => designModules(requirement, step1, step2, step3), executionTrace);
    const step5 = await runStep('风险评估',     5, () => assessRisks(step1, step2, step3, step4), executionTrace);
    const spec   = await runStep('实现规格',    6, () => generateImplementationSpec(requirement, step1, step2, step3, step4, step5), executionTrace);

    const totalMs = Date.now() - pipelineStart;
    logger.info('SE 流水线完成', { totalMs, steps: executionTrace.map(s => ({ name: s.name, ok: s.success, ms: s.durationMs })) });
    evolutionTracker.track({ role: 'andy', type: 'pipeline', success: true, durationMs: totalMs }).catch(() => {});

    const implementation = await callLisa(spec);
    await recordDecision(userId, requirement, spec, executionTrace);

    ContextManager.addToHistory(userId, 'assistant', `架构设计完成: ${spec.summary}`);

    const response = buildSummaryText(spec, executionTrace, implementation);
    res.json({ success: true, response, spec, implementation, executionTrace });

  } catch (error) {
    logger.error('SE 流水线异常终止', { error: error.message, trace: executionTrace });
    res.status(500).json({ success: false, error: error.message, executionTrace });
  }
}

// ─── 流水线执行器（可观测性包装）─────────────────────────────────────────

async function runStep(name, stepNo, fn, trace) {
  const start = Date.now();
  logger.info(`[SE Step ${stepNo}/6] ${name}...`);
  try {
    const result = await fn();
    const durationMs = Date.now() - start;
    trace.push({ step: stepNo, name, success: true, durationMs, jsonParsed: !result._rawFallback });
    logger.info(`[SE Step ${stepNo}/6] ${name} 完成`, { durationMs });
    evolutionTracker.track({ role: 'andy', type: 'design_step', stepName: name, stepNo, success: true, jsonParsed: !result._rawFallback, durationMs }).catch(() => {});
    return result;
  } catch (err) {
    const durationMs = Date.now() - start;
    trace.push({ step: stepNo, name, success: false, durationMs, error: err.message });
    logger.error(`[SE Step ${stepNo}/6] ${name} 失败`, { error: err.message, durationMs });
    evolutionTracker.track({ role: 'andy', type: 'design_step', stepName: name, stepNo, success: false, jsonParsed: false, durationMs }).catch(() => {});
    throw err;
  }
}

// ─── JSON 提取（鲁棒解析）────────────────────────────────────────────────

function extractJSON(text) {
  if (!text) return null;

  // 1. 直接解析
  try { return JSON.parse(text); } catch {}

  // 2. markdown 代码块
  const codeBlock = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlock) {
    try { return JSON.parse(codeBlock[1].trim()); } catch {}
  }

  // 3. 最外层 { }
  const fb = text.indexOf('{'), lb = text.lastIndexOf('}');
  if (fb !== -1 && lb > fb) {
    try { return JSON.parse(text.substring(fb, lb + 1)); } catch {}
  }

  // 4. 最外层 [ ]
  const fa = text.indexOf('['), la = text.lastIndexOf(']');
  if (fa !== -1 && la > fa) {
    try { return JSON.parse(text.substring(fa, la + 1)); } catch {}
  }

  return null;
}

// ─── 模型调用（统一走 Andy 角色）────────────────────────────────────────

async function callModel(prompt) {
  const result = await modelRouter.route(prompt, 'architecture', 'andy', { timeoutMs: 90000 });
  return result.response;
}

// ─── SE STEP 1：需求分析 ──────────────────────────────────────────────────

async function analyzeRequirements(requirement) {
  const prompt = `你是一名资深软件工程师，正在执行需求分析阶段（Requirements Analysis）。

【原始需求】
${requirement}

【HomeAI 项目上下文】
运行平台：macOS（Mac Mini）
已有基础设施：企业微信 webhook、ChromaDB 向量数据库、Ollama 本地模型、Node.js/Express 生态
目标用户：家庭成员，非技术背景，交互以自然语言为主

请严格按照 MoSCoW 优先级方法和 IEEE 830 需求规范进行分析。
只输出 JSON，不要有任何解释文字：

{
  "functional": [
    {"id": "F1", "description": "...", "priority": "must|should|could", "acceptanceCriteria": "..."}
  ],
  "nonFunctional": [
    {"type": "performance|security|reliability|usability|maintainability", "requirement": "..."}
  ],
  "constraints": ["技术约束或业务限制..."],
  "successCriteria": ["可量化的验收标准..."],
  "ambiguities": ["需要与用户澄清的问题..."],
  "outOfScope": ["本次明确不做的..."]
}`;

  const raw = await callModel(prompt);
  const parsed = extractJSON(raw);

  if (parsed?.functional) {
    logger.info('[Step 1] JSON 解析成功', { functionalCount: parsed.functional.length });
    return parsed;
  }

  logger.warn('[Step 1] JSON 解析失败，构建语义 fallback', { rawLength: raw?.length });
  return {
    functional: [{ id: 'F1', description: requirement, priority: 'must', acceptanceCriteria: '功能可运行' }],
    nonFunctional: [{ type: 'reliability', requirement: '主流程不能崩溃' }],
    constraints: ['Node.js 生态', 'macOS 平台', '现有 HomeAI 基础设施'],
    successCriteria: ['核心功能可正常运行'],
    ambiguities: [],
    outOfScope: [],
    _rawFallback: raw
  };
}

// ─── SE STEP 2：领域建模 ──────────────────────────────────────────────────

async function modelDomain(requirement, requirements) {
  const functionalSummary = requirements.functional
    ?.map(f => `  - [${f.priority.toUpperCase()}] ${f.description}`)
    .join('\n') || requirement;

  const prompt = `你是一名领域驱动设计（DDD）专家，正在执行领域建模阶段。

【需求】
${requirement}

【功能需求清单】
${functionalSummary}

请识别核心领域概念、业务流程和外部系统集成点。
只输出 JSON，不要有任何解释文字：

{
  "entities": [
    {"name": "实体名", "attributes": ["属性1", "属性2"], "description": "业务含义"}
  ],
  "processes": [
    {"name": "流程名", "trigger": "触发条件", "steps": ["步骤1", "步骤2"], "output": "产出物"}
  ],
  "externalSystems": [
    {"name": "系统名", "interaction": "交互方式", "dataExchanged": "交换的数据"}
  ],
  "dataFlows": ["从A到B的数据流：传递什么数据..."]
}`;

  const raw = await callModel(prompt);
  const parsed = extractJSON(raw);

  if (parsed?.entities || parsed?.processes) {
    logger.info('[Step 2] JSON 解析成功', { entities: parsed.entities?.length, processes: parsed.processes?.length });
    return parsed;
  }

  logger.warn('[Step 2] JSON 解析失败，构建 fallback');
  return {
    entities: [{ name: '核心实体', attributes: [], description: requirement.substring(0, 50) }],
    processes: [{ name: '主流程', trigger: '用户操作', steps: ['接收输入', '处理', '返回结果'], output: '处理结果' }],
    externalSystems: [],
    dataFlows: [],
    _rawFallback: raw
  };
}

// ─── SE STEP 3：技术选型 ──────────────────────────────────────────────────

async function selectTechnology(requirement, requirements, domain) {
  const externalSystems = domain.externalSystems?.map(s => `${s.name}（${s.interaction}）`).join('、') || '无';
  const mustFeatures = requirements.functional?.filter(f => f.priority === 'must').map(f => f.description).join('\n  - ') || '';

  const prompt = `你是一名技术架构师，正在执行技术选型阶段（Technology Selection）。

【核心需求（must）】
  - ${mustFeatures}

【需要集成的外部系统】
${externalSystems}

【HomeAI 已有技术栈（优先复用）】
- Node.js + Express（所有守护进程的运行时）
- ChromaDB（向量数据库，localhost:8000，已运行）
- Ollama（本地 AI 模型，localhost:11434，已运行）
- 企业微信 wecom-bot-mcp-server（已下载，未集成）
- npm 生态（可自由安装）

请为每个技术关注点做出选型决策，说明理由。
只输出 JSON，不要有任何解释文字：

{
  "selections": [
    {
      "concern": "技术关注点（如：PDF解析、OCR、消息接收）",
      "chosen": "选定的技术或 npm 包",
      "rationale": "选择理由（30字以内）",
      "alternatives": ["备选方案"],
      "alreadyAvailable": true
    }
  ],
  "newDependencies": ["npm install package-a package-b"],
  "techStack": ["最终技术栈简洁列表"],
  "architecturePattern": "选用的架构模式",
  "architectureRationale": "选用理由"
}`;

  const raw = await callModel(prompt);
  const parsed = extractJSON(raw);

  if (parsed?.selections || parsed?.techStack) {
    logger.info('[Step 3] JSON 解析成功', { selections: parsed.selections?.length });
    return parsed;
  }

  logger.warn('[Step 3] JSON 解析失败，构建 fallback');
  return {
    selections: [],
    newDependencies: [],
    techStack: ['Node.js', 'Express', 'ChromaDB'],
    architecturePattern: '单体服务',
    architectureRationale: '当前规模下足够，后续可拆分',
    _rawFallback: raw
  };
}

// ─── SE STEP 4：模块设计 ──────────────────────────────────────────────────

async function designModules(requirement, requirements, domain, tech) {
  const processSummary = domain.processes
    ?.map(p => `  - ${p.name}：${p.steps?.join(' → ')}`)
    .join('\n') || '';
  const techStack = tech.techStack?.join(', ') || 'Node.js';

  const prompt = `你是一名软件架构师，正在执行模块设计阶段（Module Design）。

【需求】
${requirement}

【业务流程】
${processSummary}

【技术栈】${techStack}
【架构模式】${tech.architecturePattern || '单体服务'}

请遵循单一职责原则（SRP）进行模块分解。每个模块只做一件事。
只输出 JSON，不要有任何解释文字：

{
  "modules": [
    {
      "name": "模块名（英文，驼峰）",
      "file": "建议的文件路径（相对于项目根目录）",
      "responsibility": "这个模块唯一的职责（一句话）",
      "exports": ["对外暴露的函数或类名"],
      "dependencies": ["依赖的其他模块名或npm包"],
      "keyLogic": "核心实现逻辑描述（Lisa 实现参考，50字以内）"
    }
  ],
  "entryPoint": "入口文件路径",
  "dataFlow": "数据在模块间流转的完整描述",
  "interfaces": [
    {"from": "模块A", "to": "模块B", "data": "传递的数据结构简述"}
  ]
}`;

  const raw = await callModel(prompt);
  const parsed = extractJSON(raw);

  if (parsed?.modules?.length) {
    logger.info('[Step 4] JSON 解析成功', { modules: parsed.modules.length });
    return parsed;
  }

  logger.warn('[Step 4] JSON 解析失败，构建 fallback');
  return {
    modules: [{ name: 'main', file: 'index.js', responsibility: '主逻辑', exports: ['start'], dependencies: ['express'], keyLogic: requirement.substring(0, 100) }],
    entryPoint: 'index.js',
    dataFlow: '线性处理流程',
    interfaces: [],
    _rawFallback: raw
  };
}

// ─── SE STEP 5：风险评估 ──────────────────────────────────────────────────

async function assessRisks(requirements, domain, tech, modules) {
  const externalDeps = domain.externalSystems?.map(s => s.name).join('、') || '无';
  const newDeps = tech.newDependencies?.join('、') || '无';
  const mustFeatures = requirements.functional?.filter(f => f.priority === 'must').map(f => f.description) || [];

  const prompt = `你是一名有丰富经验的工程师，正在执行风险评估阶段（Risk Assessment）。

【功能需求数量】${requirements.functional?.length || 0} 项（must: ${mustFeatures.length} 项）
【外部系统依赖】${externalDeps}
【新增 npm 依赖】${newDeps}
【模块数量】${modules.modules?.length || 0} 个

请识别主要技术风险，并给出 MVP 范围建议。
只输出 JSON，不要有任何解释文字：

{
  "risks": [
    {
      "type": "technical|integration|requirement|dependency",
      "description": "风险描述",
      "likelihood": "high|medium|low",
      "impact": "high|medium|low",
      "mitigation": "缓解策略"
    }
  ],
  "criticalPath": ["实现的关键路径步骤，按顺序"],
  "mvpScope": ["MVP 最小可用版本必须包含的功能"],
  "deferredScope": ["可以后续版本实现的功能"]
}`;

  const raw = await callModel(prompt);
  const parsed = extractJSON(raw);

  if (parsed?.risks || parsed?.mvpScope) {
    logger.info('[Step 5] JSON 解析成功', { risks: parsed.risks?.length });
    return parsed;
  }

  logger.warn('[Step 5] JSON 解析失败，构建 fallback');
  return {
    risks: [{ type: 'requirement', description: '需求可能存在未明确的边界', likelihood: 'medium', impact: 'medium', mitigation: '先实现 must 功能，逐步迭代' }],
    criticalPath: ['搭建项目结构', '实现核心流程', '测试主路径'],
    mvpScope: mustFeatures,
    deferredScope: [],
    _rawFallback: raw
  };
}

// ─── SE STEP 6：生成实现规格（Lisa 的任务单）────────────────────────────

async function generateImplementationSpec(requirement, requirements, domain, tech, modules, risks) {
  const mustFeatures = requirements.functional
    ?.filter(f => f.priority === 'must')
    .map(f => `  - ${f.description}`)
    .join('\n') || '';

  const moduleSummary = modules.modules
    ?.map(m => `  - ${m.name} (${m.file}): ${m.responsibility}`)
    .join('\n') || '';

  const mvpScope = risks.mvpScope?.map(s => `  - ${s}`).join('\n') || '';

  const prompt = `你是一名技术负责人，正在为实现工程师（Lisa）撰写完整的实现规格书（Implementation Spec）。
Lisa 是编码专家，只需要告诉她"做什么"，她知道"怎么做"。规格书必须足够具体，让她不需要做任何架构决策。

【原始需求】
${requirement}

【必须实现的功能（MVP）】
${mvpScope || mustFeatures}

【技术栈】${tech.techStack?.join(', ') || 'Node.js'}
【新增依赖（需要安装）】${tech.newDependencies?.join(', ') || '无'}

【模块清单】
${moduleSummary}

━━━━━ 强制约束，不可违反 ━━━━━

【约束1：文件路径前缀】
- 需求包含 Python/akshare/pandas/定时脚本/数据抓取：所有文件路径前缀必须是 scripts/（示例：scripts/daily-task.py）
- Node.js Web 服务：文件路径前缀用 src/
- 禁止在 scripts/ 或 src/ 下再建 modules/ 子目录——同级平铺，直接用文件名互相 import

【约束2：跨文件接口一致性（严格执行）】
每个文件的 keyFunctions 列表必须完整声明所有对外方法，名称与实际实现一致。
在 integrationNotes 里明确写出每一条调用链：「文件A 的 X方法 → 调用 文件B 的 Y方法 → 返回 Z类型」
特别要求：格式化模块（format_xxx）如果被主入口调用，必须返回 str 类型（即发送就绪的消息字符串），而不是 Dict。
主入口脚本的调用模式必须是：data = fetch_xxx()  →  msg = format_xxx(data)  →  ok = send_to_wecom(msg)

【约束3：企业微信推送 API】
如果需求包含"企业微信推送/发消息"，Python 脚本必须直接使用已有的基础设施文件（禁止自行实现推送逻辑，禁止使用 webhook/WECOM_BOT_TOKEN/WECOM_WEBHOOK_URL）：
  导入方式：from wecom_sender import send_to_wecom
  调用方式：ok = send_to_wecom("消息字符串")  # 成功返回 True，失败返回 False
  wecom_sender.py 已存在于 scripts/ 目录，直接 import 即可，无需任何配置

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

只输出 JSON，不要有任何解释文字：

{
  "summary": "一句话描述这个系统是什么、解决什么问题",
  "techStack": ["技术栈列表"],
  "newDependencies": ["pip install ... 或 npm install ..."],
  "files": [
    {
      "path": "相对路径（Python 定时脚本示例：scripts/daily-task.py；Node.js 示例：src/service.js）",
      "type": "entry|module|config|util",
      "description": "这个文件的职责",
      "keyFunctions": [
        {
          "name": "函数名（必须与其他文件 import 时用的名字完全一致）",
          "params": "参数描述",
          "returns": "返回值类型和格式（如：List[Dict] 每项含 stock_code/stock_name/disclosure_date）",
          "logic": "实现逻辑（Lisa 直接参考实现，不超过80字）"
        }
      ],
      "dependencies": ["import 的模块名（同级文件直接写文件名，不加 modules. 前缀）"]
    }
  ],
  "implementationOrder": ["按依赖关系排列的文件路径，先实现哪个后实现哪个"],
  "integrationNotes": ["调用链说明，格式：文件A 的 X方法 → 调用 文件B 的 Y方法 → 返回 Z类型"],
  "testCases": [
    {"scenario": "测试场景", "input": "输入示例", "expectedOutput": "期望输出"}
  ],
  "modules": ${JSON.stringify(modules.modules || [])}
}`;

  const raw = await callModel(prompt);
  const parsed = extractJSON(raw);

  if (parsed?.files?.length) {
    logger.info('[Step 6] JSON 解析成功', { files: parsed.files.length });
    if (!parsed.modules) parsed.modules = modules.modules || [];
    return parsed;
  }

  logger.warn('[Step 6] JSON 解析失败，构建语义 fallback');
  return {
    summary: requirement.substring(0, 100),
    techStack: tech.techStack || ['Node.js', 'Express'],
    newDependencies: tech.newDependencies || [],
    files: modules.modules?.map(m => ({
      path: m.file,
      type: 'module',
      description: m.responsibility,
      keyFunctions: m.exports?.map(e => ({ name: e, params: '', returns: '', logic: m.keyLogic || '' })) || [],
      dependencies: m.dependencies || []
    })) || [],
    implementationOrder: modules.modules?.map(m => m.file) || [],
    integrationNotes: modules.interfaces?.map(i => `${i.from} → ${i.to}: ${i.data}`) || [],
    testCases: [],
    modules: modules.modules || [],
    _rawFallback: raw
  };
}

// ─── 调用 Lisa ────────────────────────────────────────────────────────────

async function callLisa(spec) {
  try {
    const response = await axios.post('http://localhost:3002/api/lisa/implement', {
      design: spec,
      timestamp: new Date().toISOString()
    }, { timeout: 300000 }); // 5分钟，Agent SDK 需要更多时间
    const data = response.data;
    if (data.success) {
      return data.message || `代码已生成，保存至 ${data.savedPath}`;
    }
    return data.error || 'Lisa 实现失败';
  } catch (error) {
    logger.error('Error calling Lisa', { error: error.message });
    return 'Lisa 暂时无法响应：' + error.message;
  }
}

// ─── 记录决策（供未来自主进化分析）─────────────────────────────────────

async function recordDecision(userId, requirement, spec, executionTrace) {
  const allPassed    = executionTrace.every(s => s.success);
  const jsonParsed   = executionTrace.filter(s => s.jsonParsed).length;
  const totalSteps   = executionTrace.length;
  logger.info('Recording decision', {
    userId,
    requirement: (requirement || '').substring(0, 50),
    specFiles: spec.files?.length,
    totalSteps,
    allStepsPassed: allPassed,
    jsonParseRate: `${jsonParsed}/${totalSteps}`
  });
  // 持久化到 evolution_traces
  await evolutionTracker.track({
    role:          'andy',
    type:          'decision',
    userId,
    success:       allPassed,
    specFileCount: spec.files?.length || 0,
    jsonParseRate: totalSteps > 0 ? jsonParsed / totalSteps : 0
  }).catch(() => {});
}

// ─── 响应摘要 ─────────────────────────────────────────────────────────────

function buildSummaryText(spec, trace, implementation) {
  const stepStatus = trace.map(s => `${s.name}(${s.success ? '✓' : '✗'}${s.jsonParsed === false ? '/fallback' : ''})`).join(' → ');
  const fileList = spec.files?.slice(0, 5).map(f => `  - ${f.path}: ${f.description}`).join('\n') || '';
  const deps = spec.newDependencies?.join(', ') || '无';
  // implementation is already a string (from callLisa), safe to interpolate directly
  const implLine = implementation ? `\n\n【实现结果】${implementation}` : '';

  return `SE 流水线完成。\n\n【系统】${spec.summary}\n\n【技术栈】${spec.techStack?.join(', ')}\n【新增依赖】${deps}\n\n【交付文件（共 ${spec.files?.length || 0} 个）】\n${fileList}\n\n【流水线追踪】${stepStatus}${implLine}`;
}

// ─── 启动 ─────────────────────────────────────────────────────────────────

async function startup() {
  // 确保 workspace 存在（幂等，第一次启动自动从模板初始化）
  try {
    await workspaceLoader.ensureWorkspace('andy');
    logger.info('✅ Andy workspace 已就绪', { dir: workspaceLoader.resolveWorkspaceDir('andy') });
  } catch (e) {
    logger.warn('⚠️ Andy workspace 初始化失败', { error: e.message });
  }

  // 预加载 soul（缓存到 _andySoul）
  await loadAndySoul();

  app.listen(PORT, () => {
    logger.info('Andy 守护进程已启动', { port: PORT });
    console.log(`Andy 守护进程运行在端口 ${PORT}`);
  });
}

startup();

evolutionTracker.initialize().catch(e => console.warn('[andy] evolution-tracker 初始化失败:', e.message));

process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});
