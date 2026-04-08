/**
 * HomeAI 守护进程 - 业务架构师入口
 * 端口: 3000
 * 职责: 对话交互、意图识别、dev_orchestrator开发协调
 *
 * dev_orchestrator核心功能：
 * - 意图识别（开发/修复/优化/重构/文档）
 * - 角色分配（简单→Lisa，复杂→Andy+Lisa）
 * - 多轮对话管理
 * - 任务跟踪
 * - 异常处理
 * - 自动上线
 *
 * v345.1: 使用统一路径配置模块
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const winston = require('winston');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const path = require('path');

// 导入共享模块
const { paths, ensureDirectories } = require('../shared/paths');

// 导入宪法加载器
const ConstitutionLoader = require('./constitution-loader');
// 导入进化目标系统
const EvolutionGoals = require('../shared/evolution-goals');
// 导入上下文管理器
const ContextManager = require('../shared/context-manager');
// 导入NDA知识库模块
const briefManager = require('../shared/brief');
const { knowledgeBase, REQUIREMENT_STATUS } = require('../shared/knowledge-base');
// 导入能力查找与优化模块
const capabilityRegistry = require('../shared/capability-registry');
const capabilityExtractor = require('../shared/capability-extractor');
const capabilityOptimizer = require('../shared/capability-optimizer');
const { taskStore } = require('../shared/task-store');
const { requirementTracker, STATUS: REQ_STATUS } = require('../shared/requirement-tracker');
// 导入记忆系统客户端（v356.0）
const { memoryClient } = require('../shared/memory-client');
// 导入模型路由器（v357.0）
const { modelRouter, ROUTING_PHASES } = require('../shared/model-router');
const { spawn } = require('child_process');
// 导入轨迹追踪与反思引擎
const { evolutionTracker } = require('../shared/evolution-tracker');
const { reflectionEngine } = require('../shared/reflection-engine');
// 导入成员专属 Agent 管理器
const { memberAgentManager } = require('../shared/member-agent-manager');
// 导入 workspace 加载器（遵照 OpenClaw workspace 标准）
const workspaceLoader = require('../shared/workspace-loader');

// 需求澄清状态机：记录等待用户澄清的开发任务
// userId → { originalMessage, intent, replyTo, callbackUrl, clarifyingQuestion, timestamp }
const pendingClarifications = new Map();
const CLARIFICATION_TTL_MS = 10 * 60 * 1000; // 10分钟内没有回复则丢弃

// 定期清理超时的澄清请求
setInterval(() => {
  const now = Date.now();
  for (const [userId, state] of pendingClarifications) {
    if (now - state.timestamp > CLARIFICATION_TTL_MS) {
      pendingClarifications.delete(userId);
    }
  }
}, 60000);

// 初始化记忆系统 + 轨迹追踪器
let memoryInitialized = false;
(async () => {
  try {
    await memoryClient.initialize();
    memoryInitialized = true;
    console.log('✅ HomeAI: 记忆系统已初始化');
  } catch (e) {
    console.warn('⚠️ HomeAI: 记忆系统初始化失败', e.message);
  }
  try {
    await evolutionTracker.initialize();
    console.log('✅ HomeAI: 轨迹追踪器已初始化');
  } catch (e) {
    console.warn('⚠️ HomeAI: 轨迹追踪器初始化失败', e.message);
  }
})();

// 日志配置（使用统一路径）
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: paths.logs.homeai
    }),
    new winston.transports.Console()
  ]
});

const app = express();
const PORT = process.env.HOMEAI_PORT || 3000;

// 宪法加载器实例
const constitutionLoader = new ConstitutionLoader();
// 进化目标实例
const evolutionGoals = EvolutionGoals;

// dev_orchestrator: 任务跟踪存储（已改为持久化，使用 task-store.js）

/**
 * 意图识别 - 分层设计
 *
 * Layer 1：高置信度关键词匹配（无延迟）
 *   命中明确信号 → 直接返回，不调模型
 *
 * Layer 2：模型语义分类（仅 Layer 1 未命中时触发）
 *   短小聚焦的 prompt，识别自然语言中模糊的意图
 *
 * 设计原则：
 *   - 开发类意图优先于其他匹配，避免背景词（"错误规律"）误触 bug_fix
 *   - 关键词匹配用完整词组，不用单字（"优化" 比 "快" 可靠）
 *   - 模型调用结果记录到 trace，供未来进化分析
 */

// Layer 1 关键词库
const INTENT_PATTERNS = {
  query_tasks: {
    // 用户询问 Lucas 记录了哪些待办需求/任务
    patterns: [
      '你记了', '你记录了', '有哪些需求', '有哪些任务', '有哪些待办',
      '你有什么任务', '你有哪些工作', '你在做什么', '你要做什么',
      '有什么工作要', '记了什么', '你接了哪些', '待办事项',
      '你有哪些要', '记录了哪些', '帮我看看任务', '任务列表'
    ],
    confidence: 0.90,
    complexity: 'simple'
  },
  develop_feature: {
    // 自然语言中"要做某个东西"的各种表达
    // 包括周期性推送/报告类需求（需要写代码才能实现的自动化任务）
    patterns: [
      '开发', '创建', '新增', '搭建', '构建', '建立',
      '做一个', '做个', '帮我做', '帮我开发', '帮我实现', '帮我创建', '帮我搭建',
      '需要一个', '想要一个', '写一个', '写个',
      '实现一个', '开发一个', '需要开发',
      // 周期性推送/报告（需要写代码实现的自动化任务）
      '每天推送', '每周推送', '每天发', '每周发', '定期发', '定期推送',
      '帮我推', '自动推送', '自动发送', '每天报告', '每周报告', '定期报告',
      '每周调研', '定期调研', '每周整理', '定期整理', '每天汇总', '每周汇总',
      '帮我每', '每周在这个群', '每天在这个群'
    ],
    confidence: 0.92,
    complexity: 'complex'
  },
  bug_fix: {
    // 明确的故障信号，排除"错误分析/错误规律"等业务词
    patterns: [
      '修复', 'bug', '报错', '崩溃', '出错了', '用不了',
      '不能用了', '出问题了', '启动失败', '无法运行', '程序挂了'
    ],
    confidence: 0.88,
    complexity: 'simple'
  },
  optimize: {
    patterns: ['优化性能', '运行太慢', '响应慢', '内存占用', '提升效率', '性能问题'],
    confidence: 0.85,
    complexity: 'simple'
  },
  refactor: {
    patterns: ['重构', '整理代码', '简化代码', '重写'],
    confidence: 0.88,
    complexity: 'complex'
  },
  update_doc: {
    patterns: ['更新文档', '写文档', '补充说明', '完善文档'],
    confidence: 0.85,
    complexity: 'simple'
  },
  tool: {
    patterns: [
      '帮我查一下', '查找文件', '搜索文件', '列出文件',
      '执行命令', '查看日志', '检查状态', '查看配置'
    ],
    confidence: 0.88,
    complexity: 'simple'
  },
  member_deep: {
    // 成员深度个人事务——高度个性化、持续性、需要专属 Agent 处理
    // 关键词触发置信度刻意设低（0.75），优先交给模型语义判断
    // 注意：「每周推送/报告」属于 develop_feature，不在此类
    patterns: [
      '我需要一个专门', '帮我建一个助手', '给我一个专属',
      '我一直想要', '能不能帮我持续', '帮我长期跟踪',
      '副业', '创业方向', '居家赚钱',           // 小姨高频需求
      '姐姐的学习', '学习进度',                  // 妈妈高频需求
      '考试复习', '我的错题', '帮我制定学习计划'  // 姐姐高频需求
    ],
    confidence: 0.75,
    complexity: 'simple'
  }
};

/**
 * Layer 1：关键词快速匹配
 * 返回高置信度结果或 null（未命中）
 */
function matchByKeyword(message) {
  const lower = message.toLowerCase();

  // develop_feature 先检查，避免含"错误/失败"的功能描述被误判为 bug_fix
  for (const [type, config] of Object.entries(INTENT_PATTERNS)) {
    if (config.patterns.some(p => message.includes(p) || lower.includes(p))) {
      return {
        type,
        confidence: config.confidence,
        complexity: type === 'develop_feature' && message.length > 60 ? 'complex' : config.complexity,
        method: 'keyword'
      };
    }
  }
  return null;
}

/**
 * Layer 2：模型语义分类
 * 仅在关键词未命中时调用，避免给日常对话增加延迟
 */
async function classifyByModel(message) {
  const prompt = `将下面这条消息分类为以下意图之一，只输出 JSON，不要解释：

消息：「${message}」

可选意图：
- query_tasks：用户询问 Lucas 记录了哪些需求/任务/待办事项（如「你记了哪些需求」「有什么任务要做」「你有哪些工作」）
- develop_feature：用户想开发/创建/实现一个新功能、系统或自动化任务，需要写代码才能完成。包括：①「帮我做一个xxx」②「每天/每周推送/发/报告xxx」③「定期整理/汇总xxx」④「自动发送xxx」——这类周期性推送任务本质是需要开发代码实现的自动化，必须归为 develop_feature
- bug_fix：用户报告某个现有功能坏了/出错/无法运行
- optimize：用户想提升现有功能的性能或效率
- refactor：用户想整理/重构已有代码
- update_doc：用户想更新/补充文档
- tool：用户想立即执行一个已有的工具/命令/查询（系统中已有该能力，直接调用即可，不需要开发）
- member_deep：成员提出深度个人化的咨询/陪伴需求，需要专属 Agent 处理（如副业方向探索、学习跟踪）。注意：如果消息包含「每周/每天/定期 + 发/推/报告」，优先归为 develop_feature 而非 member_deep
- chat：普通对话、问候、询问 Lucas 自身状态，不涉及开发或查询任务

输出格式：{"type":"意图名","confidence":0.0~1.0,"complexity":"simple|complex","reasoning":"一句话说明"}`;

  try {
    const result = await modelRouter.route(prompt, 'intent', 'lucas', { timeoutMs: 15000 });
    const raw = result.response;

    // 提取 JSON
    const match = raw.match(/\{[\s\S]*?\}/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      if (parsed.type && parsed.confidence) {
        logger.info('意图识别（模型）', { type: parsed.type, confidence: parsed.confidence, reasoning: parsed.reasoning });
        return { ...parsed, method: 'model' };
      }
    }
  } catch (e) {
    logger.warn('意图模型分类失败，回退 chat', { error: e.message });
  }

  return { type: 'chat', confidence: 0.6, complexity: 'simple', method: 'fallback' };
}

/**
 * 意图识别主入口（async）
 * Layer 1 命中 → 立即返回
 * Layer 1 未命中 → 调模型
 */
async function recognizeIntent(message) {
  // Layer 1
  const keywordResult = matchByKeyword(message);
  if (keywordResult) {
    logger.info('意图识别（关键词）', { type: keywordResult.type, confidence: keywordResult.confidence });
    return keywordResult;
  }

  // Layer 2：消息太短（< 5字）直接当 chat，不浪费模型调用
  if (message.trim().length < 5) {
    return { type: 'chat', confidence: 0.8, complexity: 'simple', method: 'length' };
  }

  logger.info('意图识别：关键词未命中，调用模型分类...');
  return classifyByModel(message);
}

/**
 * dev_orchestrator: 角色分配
 * 根据意图类型分配处理角色
 */
function devRoleAssignment(intent) {
  switch (intent.type) {
    case 'develop_feature':
      return {
        steps: ['andy_design', 'lisa_implement'],
        description: '复杂任务：Andy规划 → Lisa实现'
      };
    case 'bug_fix':
      return {
        steps: ['lisa_implement'],
        description: '简单任务：直接Lisa实现'
      };
    case 'optimize':
      return {
        steps: ['lisa_implement'],
        description: '简单任务：直接Lisa优化'
      };
    case 'refactor':
      return {
        steps: ['andy_design', 'lisa_implement'],
        description: '复杂任务：Andy分析 → Lisa重构'
      };
    case 'update_doc':
      return {
        steps: ['lisa_implement'],
        description: '简单任务：直接Lisa更新文档'
      };
    case 'research':
      return {
        steps: ['andy_research'],
        description: '调研任务：Andy分析后决策'
      };
    case 'tool':
      return {
        steps: ['worker'],
        description: '工具任务：调用 OpenClaw Worker 执行'
      };
    case 'member_deep':
      // 成员深度个人需求——待接入 MemberAgentManager
      // 当前阶段：识别后降级为 chat 处理，记录日志供未来分析
      return {
        steps: ['member_agent'],
        description: '成员深度需求：转发成员专属 Agent（当前降级为 chat）'
      };
    default:
      return {
        steps: ['chat'],
        description: '对话任务：直接回复'
      };
  }
}

/**
 * dev_orchestrator: 任务跟踪（持久化版本）
 */
function createTask(userId, intent, message) {
  return taskStore.create(userId, intent, message);
}

function updateTask(taskId, updates) {
  return taskStore.update(taskId, updates);
}

function getTask(taskId) {
  return taskStore.get(taskId);
}

function getUserTasks(userId) {
  return taskStore.getUserTasks(userId);
}

/**
 * dev_orchestrator: 异常处理
 * 只记录日志，不向用户展示错误
 */
function devExceptionHandler(error, taskId, userId) {
  logger.error('dev_orchestrator exception', {
    taskId,
    userId,
    error: error.message,
    stack: error.stack
  });

  // 更新任务状态为失败
  if (taskId) {
    updateTask(taskId, {
      status: 'failed',
      error: error.message
    });
  }

  // 返回友好的错误消息
  return {
    handled: true,
    userMessage: '我遇到了一些问题，已经记录下来并将通知家庭业主处理。',
    notification: {
      type: 'exception',
      taskId,
      message: error.message,
      timestamp: new Date().toISOString()
    }
  };
}

// 中间件
app.use(cors());
app.use(express.json());

/**
 * 启动函数 - 加载宪法并初始化系统
 */
async function startup() {
  logger.info('🚀 Lucas 守护进程启动中...');

  // 0. 确保 workspace 存在（第一次启动自动从模板初始化，幂等）
  try {
    await workspaceLoader.ensureWorkspace('lucas');
    logger.info('✅ Lucas workspace 已就绪', { dir: workspaceLoader.resolveWorkspaceDir('lucas') });
  } catch (e) {
    logger.warn('⚠️ Lucas workspace 初始化失败', { error: e.message });
  }

  // 1. 加载项目宪法
  logger.info('📜 正在加载项目宪法...');
  const constitutionLoaded = await constitutionLoader.loadConstitution();

  if (constitutionLoaded) {
    const summary = constitutionLoader.getSummary();
    logger.info('✅ 项目宪法加载完成', { summary });

    console.log('\n' + '='.repeat(60));
    console.log('          项目宪法已加载');
    console.log('='.repeat(60));
    console.log(`角色定义: ${JSON.stringify(summary.roles)}`);
    console.log(`约束条件: 稳定性(${summary.constraintCounts.stability}) | ` +
                `安全性(${summary.constraintCounts.safety}) | ` +
                `兼容性(${summary.constraintCounts.compatibility}) | ` +
                `决策(${summary.constraintCounts.decision})`);
    console.log('='.repeat(60) + '\n');

    // 显示进化目标
    const evolutionSummary = evolutionGoals.getSummary();
    console.log('🎯 自我进化目标:');
    console.log('-'.repeat(40));
    console.log(`核心目标: ${evolutionSummary.coreGoal}`);
    console.log(`当前阶段: ${evolutionSummary.currentStage}`);
    console.log(`总体进度: ${evolutionSummary.overallProgress}%`);
    console.log('-'.repeat(40) + '\n');
  } else {
    logger.warn('⚠️ 项目宪法加载失败，使用默认角色认知');
  }

  // 3. 初始化能力注册表
  try {
    await capabilityRegistry.initialize();
    logger.info('🎯 能力注册表初始化完成', { total: capabilityRegistry.getAll().length });
    console.log(`🎯 能力注册表: ${capabilityRegistry.getAll().length} 个能力已注册`);
  } catch (e) {
    logger.warn('⚠️ 能力注册表初始化失败', { error: e.message });
  }

  // 2. 启动服务器
  app.listen(PORT, () => {
    logger.info('HomeAI 守护进程已启动', { port: PORT });
    console.log(`🏠 HomeAI 守护进程运行在端口 ${PORT}`);
    console.log(`🤖 dev_orchestrator 已激活：意图识别、角色分配、任务跟踪`);

    if (constitutionLoaded) {
      console.log('📜 项目宪法已激活');
    }

    // 延迟 10s 推送 bore 端口通知（等 bore-tunnel 稳定连接后再读日志）
    setTimeout(notifyBorePort, 10000);
  });
}

/**
 * 启动完成后推送 cpolar 回调 URL 到家庭群。
 * cpolar 使用固定子域名，URL 不随重启变化。
 */
async function notifyBorePort() {
  const chatId = process.env.WECOM_FAMILY_CHAT_ID;
  if (!chatId) return;

  try {
    const callbackUrl = process.env.WECOM_CALLBACK_URL || 'https://wecom.homeai-wecom-zxl.top/wecom/callback';
    const msg = `HomeAI 已启动\n\n企业微信回调 URL：\n${callbackUrl}\n\n（固定地址，无需重新配置）`;
    await axios.post('http://localhost:3003/api/wecom/push-reply', {
      response: msg,
      replyTo: { chatId, isGroup: true }
    });
    logger.info('cpolar 回调 URL 已推送至家庭群', { callbackUrl });
  } catch (e) {
    logger.warn('cpolar 通知推送失败', { error: e.message });
  }
}

// ============ API 接口 ============

// 健康检查
app.get('/api/health', (req, res) => {
  const summary = constitutionLoader.getSummary();
  const evolutionSummary = evolutionGoals.getSummary();
  const contextStats = ContextManager.getStats();

  res.json({
    status: 'ok',
    service: 'lucas',
    port: PORT,
    dev_orchestrator: taskStore.getStats(),
    constitution: {
      loaded: summary.loaded,
      roles: summary.roles,
      constraints: summary.constraintCounts
    },
    evolution: evolutionSummary,
    context: {
      historyRounds: contextStats.historySize,
      cacheSize: contextStats.cacheSize,
      truncatedCount: contextStats.truncatedCount
    }
  });
});

// dev_orchestrator: 获取用户任务列表
app.get('/api/dev/tasks', (req, res) => {
  const { userId } = req.query;
  const tasks = userId ? getUserTasks(userId) : taskStore.getAll();
  res.json({ success: true, tasks });
});

// 家庭需求生命周期看板
app.get('/api/requirements', (req, res) => {
  const { userId, status } = req.query;
  let reqs = userId ? requirementTracker.getByUserId(userId) : requirementTracker.getAll();
  if (status) reqs = reqs.filter(r => r.status === status);
  res.json({ success: true, requirements: reqs, stats: requirementTracker.getStats() });
});

// dev_orchestrator: 获取单个任务详情
app.get('/api/dev/task/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = getTask(taskId);
  if (task) {
    res.json({ success: true, task });
  } else {
    res.status(404).json({ success: false, error: '任务不存在' });
  }
});

// ===== 异步任务回调接口 =====
app.post('/api/dev/task/:taskId/callback', async (req, res) => {
  const { taskId } = req.params;
  const { step, status, result, error } = req.body;

  logger.info('收到任务回调', { taskId, step, status });

  const task = getTask(taskId);
  if (!task) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }

  // 更新步骤状态
  if (task.steps) {
    const stepIndex = task.steps.findIndex(s => s.step === step);
    if (stepIndex >= 0) {
      task.steps[stepIndex].status = status;
      if (result) task.steps[stepIndex].result = result;
      if (error) task.steps[stepIndex].error = error;
    }
  }

  // 更新任务整体状态
  if (status === 'completed') {
    const allCompleted = task.steps?.every(s => s.status === 'completed');
    if (allCompleted) {
      updateTask(taskId, { status: 'completed', result });
    }
  } else if (status === 'failed') {
    updateTask(taskId, { status: 'failed', error });
  }

  res.json({ success: true, task: getTask(taskId) });
});

// 上下文管理器统计
app.get('/api/context/stats', (req, res) => {
  res.json({ success: true, stats: ContextManager.getStats() });
});

// 获取用户对话历史
app.get('/api/context/history', (req, res) => {
  const userId = req.query.userId || 'default';
  const history = ContextManager.getHistory(userId, false);
  res.json({ success: true, history });
});

// 清理用户上下文
app.post('/api/context/clear', (req, res) => {
  const { userId } = req.body;
  if (userId) {
    ContextManager.clearHistory(userId);
    res.json({ success: true, message: `已清理用户 ${userId} 的对话历史` });
  } else {
    res.status(400).json({ success: false, error: '需要提供 userId' });
  }
});

// 清理所有需求（NDA）
app.post('/api/nda/clear-requirements', async (req, res) => {
  try {
    await knowledgeBase.requirement_clear_all();
    res.json({ success: true, message: '已清理所有需求' });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 查看需求列表
app.get('/api/nda/requirements', async (req, res) => {
  try {
    const reqs = await knowledgeBase.requirement_list({});
    res.json({ success: true, requirements: reqs });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 宪法状态
app.get('/api/constitution/status', (req, res) => {
  const summary = constitutionLoader.getSummary();
  res.json({ success: true, constitution: summary });
});

// 进化目标
app.get('/api/evolution/status', (req, res) => {
  const summary = evolutionGoals.getSummary();
  const report = evolutionGoals.getEvolutionReport();
  const suggestions = evolutionGoals.getEvolutionSuggestions();
  res.json({ success: true, summary, report, suggestions });
});

// ============ 能力查找与优化系统 API ============

// 自我认知报告 - 系统有哪些能力
app.get('/api/capabilities', async (req, res) => {
  try {
    const report = capabilityRegistry.generateSelfAwarenessReport();
    res.json({ success: true, ...report });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 能力检索 - 根据需求搜索能力
app.get('/api/capabilities/search', async (req, res) => {
  const { q } = req.query;
  if (!q) {
    return res.status(400).json({ success: false, error: '请提供搜索关键词' });
  }

  try {
    const results = capabilityRegistry.search(q);
    res.json({ success: true, query: q, results, count: results.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 能力提取 - 从消息中提取需要的能力
app.post('/api/capabilities/extract', async (req, res) => {
  const { message, intentType } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, error: '请提供消息内容' });
  }

  try {
    const extraction = await capabilityExtractor.extract(message, intentType);
    res.json({ success: true, ...extraction });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 能力优化 - 推荐能力组合
app.post('/api/capabilities/optimize', async (req, res) => {
  const { message, capabilities } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, error: '请提供需求描述' });
  }

  try {
    // 先提取能力
    const extraction = await capabilityExtractor.extract(message);
    // 再优化组合
    const optimization = capabilityOptimizer.optimize(message, extraction.matchedCapabilities);
    res.json({ success: true, ...optimization });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ===== 高级版：学习引擎指标 API =====

const routeMetrics = (() => {
  try { return require('../learning/route-metrics'); } catch (e) { return null; }
})();
const interactionLearner = (() => {
  try { return require('../learning/interaction-learner'); } catch (e) { return null; }
})();
const sampleCurator = (() => {
  try { return require('../learning/sample-curator'); } catch (e) { return null; }
})();

// 获取过去 7 天路由指标趋势
app.get('/api/metrics', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7');
    const trend = routeMetrics ? await routeMetrics.getTrend(days) : [];
    const pendingCount = sampleCurator ? await sampleCurator.getPendingCount() : 0;
    const recentEvents = interactionLearner ? await interactionLearner.getRecentEvents(5) : [];
    const routerStats = modelRouter.getStats();

    res.json({
      success: true,
      trend,
      pendingCount,
      recentEvents,
      routerStats
    });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== 用户反馈 API（👍/👎 → 语料标注）=====

// POST /api/feedback  { eventId, rating: 'up'|'down', role?, correction? }
app.post('/api/feedback', async (req, res) => {
  const { eventId, rating, role, correction } = req.body || {};
  if (!eventId || !['up', 'down'].includes(rating)) {
    return res.status(400).json({ success: false, error: 'eventId 和 rating(up/down) 必填' });
  }
  try {
    const result = interactionLearner
      ? await interactionLearner.feedback({ eventId, rating, role: role || 'lucas', correction })
      : { ok: false, reason: '学习引擎未加载' };
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ===== v357.0: 模型路由器 API =====

// 获取路由统计
app.get('/api/router/stats', (req, res) => {
  const stats = modelRouter.getStats();
  res.json({ success: true, stats });
});

// 设置路由阶段
app.post('/api/router/phase', (req, res) => {
  const { phase } = req.body;

  if (!phase) {
    return res.status(400).json({ success: false, error: '请提供阶段 (phase1/phase2/phase3)' });
  }

  try {
    modelRouter.setPhase(phase);
    res.json({ success: true, phase: modelRouter.config.phase });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 更新微调轮次（自动调整阶段）
app.post('/api/router/finetune-round', (req, res) => {
  const { round } = req.body;

  if (round === undefined) {
    return res.status(400).json({ success: false, error: '请提供微调轮次' });
  }

  modelRouter.setFinetuneRound(round);
  const stats = modelRouter.getStats();
  res.json({ success: true, stats });
});

// 记录进化事件
app.post('/api/evolution/record', async (req, res) => {
  const { type, dimension, description, learning, improvement } = req.body;
  if (!description) {
    return res.status(400).json({ success: false, error: '必须提供事件描述' });
  }

  try {
    const recorded = await evolutionGoals.recordEvolutionEvent({
      type: type || 'interaction',
      dimension: dimension || 'general',
      description,
      learning,
      improvement
    });

    res.json({
      success: recorded,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// 验证决策
app.post('/api/constitution/validate', (req, res) => {
  const { decision, context } = req.body;
  if (!decision) {
    return res.status(400).json({ success: false, error: '必须提供决策内容' });
  }

  const validation = constitutionLoader.validateDecision(decision);
  res.json({ success: true, validation, timestamp: new Date().toISOString() });
});

// ─── Evolution & Reflection API ──────────────────────────────────────────────

// 查询执行轨迹
app.get('/api/evolution/traces', async (req, res) => {
  const { role, limit } = req.query;
  try {
    const traces = await evolutionTracker.query(role || null, parseInt(limit || '50', 10));
    res.json({ success: true, count: traces.length, traces });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// 获取上次反思假设
app.get('/api/reflection/hypotheses', (req, res) => {
  res.json({ success: true, hypotheses: reflectionEngine.getLastHypotheses() });
});

// 立即触发一次反思
app.post('/api/reflection/force', async (req, res) => {
  try {
    const hypotheses = await reflectionEngine.forceReflect();
    res.json({ success: true, count: hypotheses.length, hypotheses });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ============ 需求澄清辅助函数 ============

/**
 * 判断开发需求是否有关键信息缺失，若有则生成一个澄清问题。
 * 返回问题字符串，或 null（需求已足够清晰，直接转 Andy）。
 */
async function generateClarifyingQuestion(message) {
  const prompt = `用户提出了一个开发需求："${message}"

请判断这个需求是否有关键信息缺失（如数据来源、具体范围、推送对象、格式、频率等），让你无法准确实现。

如果需求已经足够清晰，回复：CLEAR
如果有关键信息缺失，回复一个简短的中文问题，只问最重要的一个点。

规则：
- 不要解释，只输出问题或 CLEAR
- 问题要简洁（20字以内）
- 不要加引号或标点前缀`;

  try {
    const result = await modelRouter.route(prompt, 'clarify', 'lucas', { timeoutMs: 30000 });
    const answer = (result.response || '').trim();
    if (!answer || answer === 'CLEAR' || answer.toUpperCase().startsWith('CLEAR')) return null;
    return answer;
  } catch (e) {
    logger.warn('澄清问题生成失败，直接转 Andy', { error: e.message });
    return null;
  }
}

// ============ 主对话接口 ============

/**
 * 主对话接口
 * 职责：
 * 1. 意图识别（判断是聊天还是开发任务）
 * 2. 聊天任务：直接处理
 * 3. 开发任务：先澄清模糊需求，再转发给 Andy 处理
 *
 * v351.0: 开发任务转发给 Andy 处理（架构优化）
 */
app.post('/api/chat', async (req, res) => {
  const { message, userId = 'default', callbackUrl, replyTo } = req.body;

  logger.info('Received message', { message, userId, hasCallback: !!callbackUrl });

  // ===== Step -0.5: 消息到达即时写入 ChromaDB（不等 LLM 回复）=====
  // 确保 recall_memory 在同一轮就能查到用户刚发的消息，消除 session 缓存滞后
  if (memoryInitialized) {
    memoryClient.addConversation(userId, 'user', message).catch(e => {
      logger.warn('用户消息预写入 ChromaDB 失败（非阻塞）', { error: e.message });
    });
  }

  // ===== Step -1: 检查是否是对已交付需求的反馈 =====
  // 非阻塞：识别到反馈就更新状态 + 写 DPO，消息本身继续正常处理
  try {
    const pendingReq = requirementTracker.getPendingFeedback(userId);
    if (pendingReq) {
      const feedbackType = requirementTracker.detectFeedback(message);
      if (feedbackType === 'positive') {
        requirementTracker.updateStatus(pendingReq.id, REQ_STATUS.VALIDATED);
        logger.info('需求已验证', { reqId: pendingReq.id, userId });
        // 写 DPO 正例：用户验证通过 = humanized 回答是 chosen
        if (sampleCurator && pendingReq.deliveredResponse) {
          sampleCurator.curateNegative({
            prompt:       pendingReq.message,
            badResponse:  pendingReq.techResponse || '任务未能满足需求',
            goodResponse: pendingReq.deliveredResponse,
            domain:       'general',
            role:         'lucas',
          }).catch(() => {});
        }
      } else if (feedbackType === 'negative') {
        requirementTracker.updateStatus(pendingReq.id, REQ_STATUS.FAILED, { error: '用户反馈不满意' });
        logger.info('需求标记失败（用户否定）', { reqId: pendingReq.id, userId });
      }
    }
  } catch (e) {
    logger.debug('反馈检测失败（非阻塞）', { error: e.message });
  }

  // ===== Step 0: 检查是否是对之前澄清问题的回复 =====
  if (pendingClarifications.has(userId)) {
    const pending = pendingClarifications.get(userId);
    pendingClarifications.delete(userId);
    logger.info('收到澄清回复，合并原始需求转 Andy', { userId });

    const enrichedMessage = `${pending.originalMessage}\n\n用户补充说明：${message}`;

    if (pending.callbackUrl) {
      res.json({
        success: true,
        response: '明白了！Lucas 去找 Andy 帮你搞定 🔧',
        isAsync: true,
        modelUsed: null,
        isCloud: false
      });
      setImmediate(async () => {
        const clarReqId = pending.reqId || null;
        if (clarReqId) requirementTracker.updateStatus(clarReqId, REQ_STATUS.CONFIRMED);
        try {
          const andyResponse = await forwardToAndyTracked(enrichedMessage, userId, { type: pending.intent }, clarReqId, pending.replyTo);
          await storeToMemory(userId, enrichedMessage, andyResponse);
          evolutionTracker.track({
            role: 'lucas', type: 'route',
            routedTo: 'andy', isCloud: false, modelUsed: null, success: true
          }).catch(() => {});
          reflectionEngine.tick().catch(() => {});
          await axios.post(pending.callbackUrl, {
            success: true, response: andyResponse,
            replyTo: pending.replyTo, modelUsed: null, isCloud: false
          }, { timeout: 10000 });
        } catch (err) {
          logger.error('澄清后 Andy 处理失败', { error: err.message });
          if (clarReqId) requirementTracker.updateStatus(clarReqId, REQ_STATUS.FAILED, { error: err.message });
          try {
            await axios.post(pending.callbackUrl, {
              success: false, response: `处理失败：${err.message}`,
              replyTo: pending.replyTo
            }, { timeout: 10000 });
          } catch (_) {}
        }
      });
      return;
    }
  }

  try {
    // ===== Step 1: 意图识别（分层：关键词 → 模型）=====
    const intent = await recognizeIntent(message);
    logger.info('意图识别完成', { intent });

    // 追踪意图识别结果（非阻塞）
    evolutionTracker.track({
      role: 'lucas', type: 'intent',
      intentType: intent.type, method: intent.method,
      confidence: intent.confidence, success: true
    }).catch(() => {});

    // ===== Step 2: 根据意图类型处理 =====
    // chat/tool(同步降级)/member_deep/query_tasks 有自己的路由，不走 Andy 异步路径
    // tool 在有 callbackUrl 时会在下面单独处理（转 Andy）
    const isDevIntent = intent.type !== 'chat' && intent.type !== 'tool'
      && intent.type !== 'member_deep' && intent.type !== 'query_tasks';

    // 任务查询：用户问 Lucas 有哪些待办/需求 → 查 task store，用人话回答
    if (intent.type === 'query_tasks') {
      const allTasks = taskStore.getAll();
      const activeTasks = allTasks.filter(t => t.status !== 'completed' && t.status !== 'failed');
      let taskReply;
      if (activeTasks.length === 0) {
        taskReply = '目前我这里没有记录到正在处理的需求哦。如果你有新需求，直接告诉我就好！';
      } else {
        const statusLabel = { pending: '待处理', in_progress: '处理中', completed: '已完成', failed: '失败' };
        const lines = activeTasks.map((t, i) => {
          const label = statusLabel[t.status] || t.status;
          const when = new Date(t.createdAt).toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });
          return `${i + 1}. 【${label}】${t.message}（${when} 提交）`;
        });
        taskReply = `我这里记录了 ${activeTasks.length} 个待办需求：\n\n${lines.join('\n')}\n\n有什么需要我跟进的吗？`;
      }
      return res.json({
        success: true, response: taskReply, intent,
        isAsync: false, modelUsed: 'local:task-store', isCloud: false
      });
    }

    // 开发任务 + 提供了 callbackUrl：先澄清模糊需求，再异步处理
    if (isDevIntent && callbackUrl) {
      // 先尝试生成澄清问题，需求不清晰时先问用户
      const clarifyingQuestion = await generateClarifyingQuestion(message);
      if (clarifyingQuestion) {
        logger.info('开发需求不明确，向用户提问', { userId, question: clarifyingQuestion });
        // 创建需求记录（discovered），等用户澄清后推进到 confirmed
        const clarifyReq = requirementTracker.create(userId, message, intent.type, replyTo);
        pendingClarifications.set(userId, {
          originalMessage: message,
          intent: intent.type,
          callbackUrl,
          replyTo,
          reqId: clarifyReq.id,
          timestamp: Date.now()
        });
        res.json({
          success: true,
          response: clarifyingQuestion,
          intent,
          isAsync: false,
          isPendingClarification: true,
          modelUsed: null,
          isCloud: false
        });
        return;
      }

      logger.info('开发任务异步处理', { intent: intent.type, callbackUrl });
      // 创建需求记录并立即推进到 confirmed（需求已确认，准备分发）
      const asyncReq = requirementTracker.create(userId, message, intent.type, replyTo);
      requirementTracker.updateStatus(asyncReq.id, REQ_STATUS.CONFIRMED);
      res.json({
        success: true,
        response: 'Lucas 收到，正在处理（可能需要几分钟），完成后会通知你 🔧',
        intent,
        isAsync: true,
        reqId: asyncReq.id,
        modelUsed: null,
        isCloud: false
      });

      // 后台继续处理，完成后回调
      setImmediate(async () => {
        try {
          const response = await forwardToAndyTracked(message, userId, intent, asyncReq.id, replyTo);
          await storeToMemory(userId, message, response);
          evolutionTracker.track({
            role: 'lucas', type: 'route',
            routedTo: 'andy', isCloud: false,
            modelUsed: null, success: true
          }).catch(() => {});
          reflectionEngine.tick().catch(() => {});
          // 回调通知调用方
          await axios.post(callbackUrl, {
            success: true, response, intent,
            replyTo, modelUsed: null, isCloud: false
          }, { timeout: 10000 });
        } catch (err) {
          logger.error('异步开发任务处理失败', { error: err.message });
          requirementTracker.updateStatus(asyncReq.id, REQ_STATUS.FAILED, { error: err.message });
          try {
            await axios.post(callbackUrl, {
              success: false,
              response: `处理失败：${err.message}`,
              intent, replyTo
            }, { timeout: 10000 });
          } catch (_) {}
        }
      });
      return;
    }

    let response;
    let routeResult = null;

    if (intent.type === 'chat') {
      // 对话任务：先查是否有专属 Agent，有则转发；没有则 Lucas 直接处理
      // 设计依据：成员专属 Agent 是该成员所有对话的首选处理者，不只是"深度需求"
      const chatMemberId = await memberAgentManager.resolveMemberId(userId);
      if (chatMemberId) {
        logger.info('chat 意图转发给成员专属 Agent', { userId, memberId: chatMemberId });
        try {
          const agentResult = await memberAgentManager.forwardToMemberAgent(chatMemberId, message);
          response = agentResult.response;
          routeResult = { modelUsed: agentResult.modelUsed };
        } catch (agentErr) {
          logger.warn('成员专属 Agent 调用失败，Lucas 直接处理', { memberId: chatMemberId, error: agentErr.message });
          const chatResult = await handleChat(message, userId);
          response = chatResult.response;
          routeResult = chatResult.routeResult;
        }
      } else {
        const chatResult = await handleChat(message, userId);
        response = chatResult.response;
        routeResult = chatResult.routeResult;
      }
    }
    else if (intent.type === 'tool') {
      // 工具任务：区分「调用现有工具」和「需要开发新工具/功能」
      // 如果有 callbackUrl（异步模式），转给 Andy 开发；否则降级为对话
      // 典型案例：「每天发股票信息」= 需要新建功能，应走 Andy
      if (callbackUrl) {
        // 先澄清，再转 Andy
        const clarifyingQuestion = await generateClarifyingQuestion(message);
        if (clarifyingQuestion) {
          logger.info('工具需求不明确，向用户提问', { userId, question: clarifyingQuestion });
          pendingClarifications.set(userId, {
            originalMessage: message,
            intent: 'dev_feature',
            callbackUrl,
            replyTo,
            timestamp: Date.now()
          });
          res.json({
            success: true,
            response: clarifyingQuestion,
            intent,
            isAsync: false,
            isPendingClarification: true,
            modelUsed: null,
            isCloud: false
          });
          return;
        }

        logger.info('工具任务转 Andy 开发', { intent: intent.type });
        const toolReq = requirementTracker.create(userId, message, 'dev_feature', replyTo);
        requirementTracker.updateStatus(toolReq.id, REQ_STATUS.CONFIRMED);
        res.json({
          success: true,
          response: 'Lucas 收到，我去找 Andy 帮你实现这个功能 🔧',
          intent,
          isAsync: true,
          reqId: toolReq.id,
          modelUsed: null,
          isCloud: false
        });
        setImmediate(async () => {
          try {
            const response = await forwardToAndyTracked(message, userId, { ...intent, type: 'dev_feature' }, toolReq.id, replyTo);
            await storeToMemory(userId, message, response);
            await axios.post(callbackUrl, { success: true, response, intent, replyTo, modelUsed: null, isCloud: false }, { timeout: 10000 });
          } catch (err) {
            logger.error('工具任务 Andy 处理失败', { error: err.message });
            requirementTracker.updateStatus(toolReq.id, REQ_STATUS.FAILED, { error: err.message });
            try { await axios.post(callbackUrl, { success: false, response: `处理失败：${err.message}`, intent, replyTo }, { timeout: 10000 }); } catch (_) {}
          }
        });
        return;
      }
      // 没有 callbackUrl（同步模式，如 TUI）：降级为对话
      logger.info('工具任务降级为对话（同步模式）', { intent: intent.type });
      const toolResult = await handleChat(message, userId);
      response = toolResult.response;
      routeResult = toolResult.routeResult;
    }
    else if (intent.type === 'member_deep') {
      // 成员深度个人需求：查找专属 Agent → 转发 / 降级
      const memberId = await memberAgentManager.resolveMemberId(userId);
      if (memberId) {
        logger.info('转发给成员专属 Agent', { userId, memberId, confidence: intent.confidence });
        try {
          const agentResult = await memberAgentManager.forwardToMemberAgent(memberId, message);
          response = agentResult.response;
          routeResult = { modelUsed: agentResult.modelUsed };
          logger.info('成员专属 Agent 回复完成', { memberId, agentName: agentResult.agentName });
        } catch (agentErr) {
          logger.warn('成员专属 Agent 调用失败，降级为 chat', { memberId, error: agentErr.message });
          const fallback = await handleChat(message, userId);
          response = fallback.response;
          routeResult = fallback.routeResult;
        }
      } else {
        // 没有找到对应专属 Agent → 评估是否应该创建，降级为 chat
        logger.info('成员深度需求：未找到专属 Agent，降级为 chat', { userId, confidence: intent.confidence });
        const chatResult = await handleChat(message, userId);
        response = chatResult.response;
        routeResult = chatResult.routeResult;
        // 记录一次 member_deep 交互，供后续 assessCreationTriggers 使用
        evolutionTracker.track({
          role: 'lucas', type: 'member_deep_unrouted',
          userId, intentConfidence: intent.confidence
        }).catch(() => {});
      }
    }
    else {
      // 开发任务（无 callbackUrl）：同步等待
      logger.info('转发开发任务给Andy（同步）', { intent: intent.type });
      const syncReq = requirementTracker.create(userId, message, intent.type, null);
      requirementTracker.updateStatus(syncReq.id, REQ_STATUS.CONFIRMED);
      response = await forwardToAndyTracked(message, userId, intent, syncReq.id, null);
    }

    // ===== Step 3: 存储到长记忆 =====
    await storeToMemory(userId, message, response);

    const isCloudModel = routeResult?.modelUsed?.startsWith('cloud:');

    // 追踪路由结果 + 触发反思引擎（非阻塞）
    evolutionTracker.track({
      role: 'lucas', type: intent.type === 'chat' ? 'chat' : 'route',
      routedTo: intent.type === 'chat' ? 'chat' : 'andy',
      isCloud: isCloudModel || false,
      modelUsed: routeResult?.modelUsed, success: true
    }).catch(() => {});
    reflectionEngine.tick().catch(() => {});

    res.json({
      success: true,
      response,
      intent,
      modelUsed: routeResult?.modelUsed || null,
      isCloud: isCloudModel
    });

  } catch (error) {
    const handled = devExceptionHandler(error, null, userId);
    logger.error('Error processing message', { error: error.message });
    res.status(500).json({
      success: false,
      error: handled.userMessage,
      logged: true
    });
  }
});

/**
 * 处理工具任务
 * 调用 OpenClaw Worker 执行文件/命令操作
 */
async function handleToolTask(message, userId) {
  // 工具类意图降级为对话处理：让 Lucas 直接用模型回答
  logger.info('工具任务转为对话处理', { userId });
  const chatResult = await handleChat(message, userId);
  return typeof chatResult === 'object' ? chatResult.response : chatResult;
}

/**
 * forwardToAndy 的需求追踪包装版
 * 在调用前后更新 requirementTracker 状态，并在交付时附加反馈引导语
 *
 * @param {string}      message
 * @param {string}      userId
 * @param {object}      intent
 * @param {string|null} reqId    requirementTracker 记录 ID，null 表示不追踪
 * @param {object|null} replyTo  企业微信 replyTo（用于判断是否需要反馈引导）
 */
async function forwardToAndyTracked(message, userId, intent, reqId, replyTo) {
  if (reqId) requirementTracker.updateStatus(reqId, REQ_STATUS.DESIGNING);
  try {
    const result = await forwardToAndy(message, userId, intent);
    if (reqId) {
      // 保存 techResponse（forwardToAndy 已包含 humanize 后的人话版本，存入 deliveredResponse）
      requirementTracker.updateStatus(reqId, REQ_STATUS.DELIVERED, { deliveredResponse: result });
    }
    // 如果是企业微信异步场景，在响应末尾附加反馈引导
    if (replyTo) {
      return `${result}\n\n做好了~ 有需要的话随时说，或者告诉我哪里还不对。`;
    }
    return result;
  } catch (err) {
    if (reqId) requirementTracker.updateStatus(reqId, REQ_STATUS.FAILED, { error: err.message });
    throw err;
  }
}

/**
 * 转发开发任务给 Andy
 * Andy 负责：角色分配、任务编排、调用Lisa、结果验收
 */
async function forwardToAndy(message, userId, intent) {
  const ANDY_URL = process.env.ANDY_URL || 'http://localhost:3001';

  logger.info('调用Andy开发编排器', { userId, intent: intent.type });

  try {
    const response = await axios.post(`${ANDY_URL}/api/dev/task`, {
      message,
      userId,
      intent
    }, {
      timeout: 660000 // 11分钟：Andy SE 六步(~4min) + Lisa 实现(~2min) + buffer
    });

    logger.info('Andy处理完成', { taskId: response.data.taskId });
    const techResult = response.data.response;

    // 按用户偏好决定返回技术版还是人话版
    return await humanizeDevResult(message, techResult, userId);
  } catch (error) {
    logger.error('调用Andy失败', { error: error.message });
    throw new Error(`开发任务处理失败: ${error.message}`);
  }
}

// 偏好技术详情的用户（系统工程师 / owner），收人话+技术摘要两段式
const TECHNICAL_USERS = new Set(
  (process.env.WECOM_OWNER_ID ? [process.env.WECOM_OWNER_ID] : [])
    .concat((process.env.TECHNICAL_USER_IDS || '').split(',').filter(Boolean))
);

// Lucas 身份基底 + 成员档案，启动时懒加载，之后缓存
let _lucasIdentity = null;
let _memberProfiles = null;

async function loadLucasIdentity() {
  if (_lucasIdentity) return _lucasIdentity;

  // 从 workspace 加载 SOUL.md（标准路径：~/.homeclaw/workspace-lucas/SOUL.md）
  // workspace-loader 会自动 fallback 到 daemons/workspace-templates/lucas/SOUL.md
  const soul = await workspaceLoader.loadSoul('lucas');
  if (soul) {
    _lucasIdentity = soul;
    return _lucasIdentity;
  }

  // 最终兜底：硬编码最小身份，不含家庭信息
  _lucasIdentity = '你是 Lucas，这个家庭的 AI 管家，也是家里的一员。温暖可靠，像家人一样亲近。';
  logger.warn('Lucas SOUL.md 加载失败，使用最小默认身份（建议运行 scripts/setup-daemons.js）');
  return _lucasIdentity;
}

async function getMemberNote(userId) {
  if (!_memberProfiles) {
    try {
      const profileMd = path.join(__dirname, '../../../HomeAIDocs/00-家庭信息/成员档案.md');
      const raw = await require('fs').promises.readFile(profileMd, 'utf8');
      // 解析各成员的"Lucas 交互注意"段落
      _memberProfiles = {};
      const sections = raw.split(/^###\s+/m).slice(1);
      for (const section of sections) {
        const nameMatch = section.match(/^(.+)/);
        const noteMatch = section.match(/\*\*Lucas 交互注意\*\*：(.+)/);
        if (nameMatch && noteMatch) {
          // 用名字片段做宽松匹配 key
          _memberProfiles[nameMatch[1].trim()] = noteMatch[1].trim();
        }
      }
    } catch (e) {
      _memberProfiles = {};
    }
  }
  // 用 userId 模糊匹配成员名（如 "小姨" 匹配 "小姨·肖山"）
  for (const [name, note] of Object.entries(_memberProfiles)) {
    if (name.includes(userId) || userId.includes(name.replace(/·.+/, '').replace(/（.+）/, ''))) {
      return note;
    }
  }
  return null;
}

/**
 * 根据用户偏好决定返回技术版还是人话版
 * - 技术用户（owner）：直接返回 Andy 原始技术报告
 * - 家庭成员：翻译成温暖自然的1-3句话，并生成完整 DPO 正例对
 */
async function humanizeDevResult(originalRequest, techResult, userId) {
  const isTechnicalUser = TECHNICAL_USERS.has(userId);
  const [lucasIdentity, memberNote] = await Promise.all([
    loadLucasIdentity(),
    getMemberNote(userId)
  ]);

  const memberGuidance = memberNote
    ? `\n与此人沟通注意：${memberNote}`
    : '';

  const prompt = isTechnicalUser
    ? `${lucasIdentity}${memberGuidance}

对方说：「${originalRequest}」

程序员团队（Andy + Lisa）已经开始处理，技术摘要如下：
${techResult}

请分两段回复：
第一段：1-2句话，用家人的口吻说清楚会做什么、什么时候能用
第二段：简明技术摘要，包含方案要点、新增依赖、交付文件（供审阅）

开口说【Lucas】，语气温暖，不像客服汇报。`
    : `${lucasIdentity}${memberGuidance}

对方说：「${originalRequest}」

程序员团队（Andy + Lisa）已经开始处理，技术摘要如下：
${techResult}

请用1-3句话，用对家人说话的方式告诉对方：
1. 收到了这个需求
2. 大概会做什么（说功能结果，不说技术细节）
3. 怎么收到或什么时候能用（如果信息里有的话）

开口说【Lucas】。不要出现：流水线、技术栈、模块、JSON、Node.js 等词汇。`;

  try {
    const result = await modelRouter.route(prompt, 'chat', 'lucas');
    const humanized = result.response;

    // 生成完整 DPO 正例对：rejected=技术话, chosen=人话
    // 这是真实训练数据，不依赖用户标记
    if (sampleCurator) {
      sampleCurator.curateNegative({
        prompt:       originalRequest,
        badResponse:  techResult,
        goodResponse: humanized,
        domain:       'persona',
        role:         'lucas'
      }).catch(() => {});
    }

    return humanized;
  } catch (e) {
    logger.warn('humanizeDevResult 失败，使用降级回复', { error: e.message });
    return '好的，我已经帮你把这个需求交给我们的程序员团队了，他们会尽快做出来的！做好了我来通知你。';
  }
}

/**
 * dev_orchestrator: 处理对话任务
 */
async function handleChat(message, userId) {
  // ===== 宪法预检查: 验证用户请求 =====
  const requestValidation = constitutionLoader.validateDecision({ type: 'request', message });
  if (!requestValidation.valid) {
    logger.warn('用户请求违反宪法约束', { violations: requestValidation.violations });
    return `抱歉，我无法处理这个请求。因为：${requestValidation.violations.map(v => v.constraint).join('；')}。如有疑问，请联系家庭业主确认。`;
  }

  // ===== NDA整合: Brief注入 =====
  let briefContext = '';
  try {
    const brief = await briefManager.getBrief();
    briefContext = `\n\n【项目Brief】${brief}\n`;
  } catch (e) {
    logger.warn('Brief加载失败，使用默认上下文', { error: e.message });
  }

  // ===== NDA整合: 加载需求摘要 =====
  let reqSummary = '';
  try {
    const openReqs = await knowledgeBase.requirement_list({ status: 'open' });
    if (openReqs.length > 0) {
      reqSummary = `\n\n【待处理需求】共${openReqs.length}条:\n${openReqs.slice(0, 3).map(r => `- ${r.id}: ${r.description}`).join('\n')}${openReqs.length > 3 ? '\n...' : ''}\n`;
    }
  } catch (e) {
    logger.debug('需求摘要加载失败', { error: e.message });
  }

  // 使用上下文管理器构建结构化 messages 数组（异步调用，需要await）
  const messages = await ContextManager.buildContext(
    userId,
    'lucas',
    null,
    message,
    { includeHistory: true, maxTokens: 6000 }
  );

  // 将 brief 和需求摘要注入 system 消息（不打平成 user 消息，保留多轮对话结构）
  if (briefContext || reqSummary) {
    const sysMsg = messages.find(m => m.role === 'system');
    if (sysMsg) {
      sysMsg.content = `${sysMsg.content}${briefContext}${reqSummary}`;
    }
  }

  // ===== 使用 model-router 直接传入结构化 messages，避免打平历史导致模型续写 =====
  const isComplex = message.length > 500 || message.includes('@');
  const routeResult = modelRouter.routeToAgent('conversation', isComplex);

  logger.info('模型路由结果', {
    modelUsed: routeResult.modelUsed,
    isCloud: routeResult.isCloud
  });

  const routeResponse = await modelRouter.routeWithMessages(messages, 'chat', 'lucas');
  const response = routeResponse.response;

  // ===== 宪法后检查: 验证系统响应 =====
  const responseValidation = constitutionLoader.validateDecision({ type: 'response', message, response });
  if (!responseValidation.valid) {
    logger.warn('系统响应违反宪法约束，已过滤', { violations: responseValidation.violations });
    return `抱歉，处理过程中发现内容不符合安全规范，请重新尝试或联系家庭业主。`;
  }

  // 添加到历史记录
  ContextManager.addToHistory(userId, 'user', message);
  ContextManager.addToHistory(userId, 'assistant', response);

  // 存储到 ChromaDB 记忆系统（v356.0）
  if (memoryInitialized) {
    try {
      await memoryClient.addConversation(userId, 'user', message);
      await memoryClient.addConversation(userId, 'assistant', response);
    } catch (e) {
      logger.warn('记忆系统存储失败', { error: e.message });
    }
  }

  return { response, routeResult };
}

/**
 * dev_orchestrator: 处理简单任务（直接Lisa）- 异步执行
 * 启动任务后立即返回，不等待完成
 */
async function handleSimpleTask(message, userId, taskId, intent) {
  updateTask(taskId, { status: 'in_progress', steps: [{ step: 'lisa_implement', status: 'pending' }] });

  // ===== NDA整合: 提取需求并记录 =====
  let reqId = null;
  try {
    reqId = await extractAndSaveRequirement(message, intent.type);
    if (reqId) {
      logger.info('NDA: 需求已记录', { reqId, taskId });
    }
  } catch (e) {
    logger.warn('需求提取失败', { error: e.message });
  }

  // 异步执行任务，不等待结果
  executeLisaTask(message, userId, taskId, intent, reqId).catch(error => {
    logger.error('异步任务执行失败', { taskId, error: error.message });
  });

  // 立即返回，不等待
  return `任务已提交，正在异步处理中...（任务ID: ${taskId}）`;
}

/**
 * 异步执行Lisa任务
 */
async function executeLisaTask(message, userId, taskId, intent, reqId) {
  updateTask(taskId, { steps: [{ step: 'lisa_implement', status: 'in_progress' }] });

  try {
    const response = await callLisa(message, userId);
    updateTask(taskId, {
      steps: [{ step: 'lisa_implement', status: 'completed', result: response }],
      status: 'completed',
      result: response
    });

    // 记录进化事件
    await evolutionGoals.recordEvolutionEvent({
      type: 'task_completed',
      dimension: 'implementation',
      description: `完成${intent.type}任务`,
      improvement: '代码实现能力提升'
    });

    logger.info('异步任务完成', { taskId });
  } catch (error) {
    updateTask(taskId, {
      steps: [{ step: 'lisa_implement', status: 'failed', error: error.message }],
      status: 'failed',
      error: error.message
    });
    logger.error('异步任务失败', { taskId, error: error.message });
  }
}

/**
 * dev_orchestrator: 处理调研任务（Andy分析）
 */
async function handleResearchTask(message, userId, taskId, intent) {
  updateTask(taskId, { status: 'in_progress', steps: [{ step: 'andy_research', status: 'pending' }] });

  try {
    // 调用Andy进行调研
    updateTask(taskId, { steps: [{ step: 'andy_research', status: 'in_progress' }] });
    const response = await callAndyResearch(message, userId);
    updateTask(taskId, { steps: [{ step: 'andy_research', status: 'completed' }] });

    return response;
  } catch (error) {
    updateTask(taskId, {
      steps: [{ step: 'andy_research', status: 'failed', error: error.message }]
    });
    throw error;
  }
}

/**
 * dev_orchestrator: 处理复杂任务（Andy + Lisa）- 异步执行
 * 启动任务后立即返回，不等待完成
 */
async function handleComplexTask(message, userId, taskId, intent, roleAssignment) {
  updateTask(taskId, {
    status: 'in_progress',
    steps: [
      { step: 'andy_design', status: 'pending' },
      { step: 'lisa_implement', status: 'pending' }
    ]
  });

  // 异步执行任务，不等待结果
  executeComplexTask(message, userId, taskId, intent).catch(error => {
    logger.error('异步任务执行失败', { taskId, error: error.message });
  });

  // 立即返回，不等待
  return `任务已提交，正在异步处理中...（任务ID: ${taskId}）\n\n您可以：\n1. 使用任务ID查询状态：GET /api/dev/task/${taskId}\n2. 等待回调通知`;
}

/**
 * 异步执行复杂任务（Andy + Lisa）
 */
async function executeComplexTask(message, userId, taskId, intent) {
  try {
    // Step 1: Andy架构设计
    updateTask(taskId, { steps: [{ step: 'andy_design', status: 'in_progress' }] });
    logger.info('dev_orchestrator: 调用Andy进行架构设计', { taskId });
    const designResult = await callAndy(message, userId);
    updateTask(taskId, {
      steps: [{ step: 'andy_design', status: 'completed', result: designResult }],
      design: designResult
    });

    // Step 2: Lisa代码实现
    updateTask(taskId, { steps: [
      { step: 'andy_design', status: 'completed' },
      { step: 'lisa_implement', status: 'in_progress' }
    ]});
    logger.info('dev_orchestrator: 调用Lisa进行代码实现', { taskId });
    const implementResult = await callLisaWithDesign(message, designResult, userId);
    updateTask(taskId, {
      steps: [{ step: 'andy_design', status: 'completed' }, { step: 'lisa_implement', status: 'completed' }],
      status: 'completed',
      result: implementResult
    });

    // 记录进化事件
    await evolutionGoals.recordEvolutionEvent({
      type: 'task_completed',
      dimension: 'collaboration',
      description: `完成${intent.type}任务（Andy+Lisa协作）`,
      improvement: '协作效率提升'
    });

    logger.info('复杂任务完成', { taskId });
  } catch (error) {
    updateTask(taskId, { status: 'failed', error: error.message });
    logger.error('复杂任务失败', { taskId, error: error.message });
  }
}

/**
 * 调用本地模型
 */
async function callLocalModel(prompt) {
  try {
    // 检查并截断过长的 prompt
    const maxPromptLength = 8000;
    if (prompt.length > maxPromptLength) {
      console.log(`[HomeAI] Prompt 过长 (${prompt.length} chars)，进行截断...`);
      prompt = prompt.substring(0, maxPromptLength) + '\n\n[... 已截断 ...]';
    }

    const response = await axios.post('http://localhost:11434/api/generate', {
      model: 'homeai-assistant',
      prompt: prompt,
      stream: false
    }, {
      timeout: 30000
    });

    return response.data.response;
  } catch (error) {
    logger.error('Error calling local model', { error: error.message });
    throw error;
  }
}

/**
 * 调用 Andy（架构设计）
 */
async function callAndy(message, userId) {
  const response = await axios.post('http://localhost:3001/api/andy/design', {
    requirement: message,
    userId: userId,
    timestamp: new Date().toISOString()
  }, {
    timeout: 60000
  });

  return response.data.design || 'Andy 已完成架构设计。';
}

/**
 * 调用 Andy（调研分析）
 */
async function callAndyResearch(message, userId) {
  const response = await axios.post('http://localhost:3001/api/andy/research', {
    topic: message,
    userId: userId,
    timestamp: new Date().toISOString()
  }, {
    timeout: 60000
  });

  return response.data.research || 'Andy 已完成调研分析。';
}

/**
 * 调用 Lisa（直接实现）
 */
async function callLisa(message, userId) {
  const response = await axios.post('http://localhost:3002/api/lisa/implement', {
    requirement: message,
    userId: userId,
    timestamp: new Date().toISOString()
  }, {
    timeout: 120000
  });

  const data = response.data;
  // Lisa returns { success, code, savedPath, ... } — no 'result' field.
  // Build a human-readable string so template literals never produce [object Object].
  if (data.success && data.code) {
    return `代码实现完成，已保存至 ${data.savedPath}（${data.code.length} 字符）`;
  }
  return typeof data.message === 'string' ? data.message : 'Lisa 已完成实现。';
}

/**
 * 调用 Lisa（基于设计实现）
 */
async function callLisaWithDesign(message, design, userId) {
  const response = await axios.post('http://localhost:3002/api/lisa/implement', {
    requirement: message,
    design: design,
    userId: userId,
    timestamp: new Date().toISOString()
  }, {
    timeout: 120000
  });

  const data = response.data;
  // Lisa returns { success, code, savedPath, ... } — no 'result' field.
  if (data.success && data.code) {
    return `代码实现完成，已保存至 ${data.savedPath}（${data.code.length} 字符）`;
  }
  return typeof data.message === 'string' ? data.message : 'Lisa 已基于设计完成实现。';
}

/**
 * 存储到长记忆
 */
async function storeToMemory(userId, message, response) {
  logger.info('Storing to memory', { userId, messageLength: message.length });
  return true;
}

/**
 * 调用 OpenClaw worker agent 执行工具任务
 * @param {string} taskDescription - 任务描述
 * @returns {Promise<string>} - 执行结果
 */
/**
 * 调用 OpenClaw Agent
 * @param {string} agentId - Agent ID (如 homeai-local, andy-cloud 等)
 * @param {string} taskDescription - 任务描述
 * @returns {Promise<string>} - 执行结果
 */
async function callOpenClawAgent(agentId, taskDescription) {
  return new Promise((resolve, reject) => {
    logger.info(`调用 OpenClaw Agent: ${agentId}`, { task: taskDescription.substring(0, 100) });

    const openclaw = spawn('openclaw', [
      'agent',
      '--agent', agentId,
      '-m', taskDescription,
      '--json',
      '--timeout', '120'  // 2分钟超时
    ], {
      cwd: '/Users/xinbinanshan/.openclaw/workspace',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    let stdout = '';
    let stderr = '';

    openclaw.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    openclaw.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    const timeout = setTimeout(() => {
      openclaw.kill();
      reject(new Error('OpenClaw worker 超时（60秒）'));
    }, 60000);

    openclaw.on('close', (code) => {
      clearTimeout(timeout);

      if (code === 0) {
        logger.info('OpenClaw worker 执行成功', { outputLength: stdout.length });
        try {
          // 尝试解析 JSON 输出
          const result = JSON.parse(stdout);
          resolve(result.message || result.response || stdout);
        } catch {
          // 如果不是 JSON，直接返回原始输出
          resolve(stdout);
        }
      } else {
        logger.error('OpenClaw worker 执行失败', { code, stderr });
        reject(new Error(`OpenClaw worker failed: ${stderr || stdout}`));
      }
    });

    openclaw.on('error', (error) => {
      clearTimeout(timeout);
      logger.error('OpenClaw worker 启动失败', { error: error.message });
      reject(error);
    });
  });
}

/**
 * NDA整合: 提取并保存需求
 */
async function extractAndSaveRequirement(message, intentType) {
  const priorityMap = {
    'develop_feature': 'should',
    'bug_fix': 'must',
    'optimize': 'could',
    'refactor': 'should',
    'update_doc': 'could'
  };

  const priority = priorityMap[intentType] || 'should';

  const requirement = {
    content: message.substring(0, 500),
    priority,
    status: 'open',
    source: `user_message_${intentType}`,
    tags: [intentType]
  };

  const reqId = await knowledgeBase.requirement_add(requirement);
  return reqId;
}

// 启动系统
startup().catch(error => {
  logger.error('启动失败', { error: error.message });
  process.exit(1);
});

module.exports = app;
