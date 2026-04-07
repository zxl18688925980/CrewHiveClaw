/**
 * Andy 开发编排器 (Andy Orchestrator)
 * 职责: 任务管理、角色分配、调用Lisa、结果验收
 *
 * 迁移自 HomeAI 守护进程
 * v351.0: 从HomeAI迁移，负责完整的开发流程协调
 */

const axios = require('axios');
const { v4: uuidv4 } = require('uuid');
const winston = require('winston');
const path = require('path');

// 使用paths模块获取统一路径
let paths;
try {
  const pathsModule = require('./paths');
  paths = pathsModule.paths;
} catch (e) {
  // 后备路径
  paths = {
    data: path.resolve(__dirname, '../../data'),
    logs: path.resolve(__dirname, '../../logs')
  };
}

// 日志目录
const LOG_DIR = path.dirname(paths.logs.andy || '');

// 任务存储（内存）
const tasks = new Map();

// Logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: `${LOG_DIR}/andy-orchestrator.log` }),
    new winston.transports.Console()
  ]
});

/**
 * 角色分配逻辑
 * 判断任务类型和复杂度
 */
function devRoleAssignment(intent) {
  const steps = [];

  if (intent.type === 'chat') {
    steps.push('homeai_chat');
  }
  else if (intent.type === 'simple_implement') {
    // 简单实现任务：直接 Lisa
    steps.push('lisa_implement');
  }
  else if (intent.type === 'research') {
    // 调研任务：Andy 调研
    steps.push('andy_research');
  }
  else if (intent.type === 'complex') {
    // 复杂任务：Andy 设计 + Lisa 实现
    steps.push('andy_design', 'lisa_implement');
  }

  return {
    type: intent.type,
    steps,
    reason: getRoleReason(intent.type)
  };
}

/**
 * 获取角色分配原因
 */
function getRoleReason(type) {
  const reasons = {
    chat: '对话任务，由HomeAI直接处理',
    simple_implement: '简单实现任务，直接交给Lisa编码',
    research: '调研任务，需要Andy分析',
    complex: '复杂任务，需要Andy设计后交给Lisa实现'
  };
  return reasons[type] || '未知任务类型';
}

/**
 * 创建任务
 */
function createTask(userId, intent, message) {
  const task = {
    id: `task_${uuidv4().substring(0, 8)}`,
    userId,
    message,
    intent,
    status: 'pending',
    steps: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  tasks.set(task.id, task);
  logger.info('任务创建', { taskId: task.id, userId, intent: intent.type });
  return task;
}

/**
 * 更新任务
 */
function updateTask(taskId, updates) {
  const task = tasks.get(taskId);
  if (!task) {
    logger.warn('任务不存在', { taskId });
    return null;
  }

  Object.assign(task, updates, { updatedAt: new Date().toISOString() });
  tasks.set(taskId, task);
  logger.info('任务更新', { taskId, status: task.status });
  return task;
}

/**
 * 获取任务
 */
function getTask(taskId) {
  return tasks.get(taskId);
}

/**
 * 获取用户所有任务
 */
function getUserTasks(userId) {
  return Array.from(tasks.values())
    .filter(t => t.userId === userId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

/**
 * 调用 Lisa 进行代码实现
 */
async function callLisa(message, userId, taskId, design = null) {
  const LISA_URL = process.env.LISA_URL || 'http://localhost:3002';

  logger.info('调用Lisa进行代码实现', { taskId, message: message.substring(0, 100) });

  try {
    const response = await axios.post(`${LISA_URL}/api/lisa/implement`, {
      design: design || { requirement: message, description: message },
      timestamp: new Date().toISOString(),
      source: 'andy',
      constitutionValidated: true,
      userId,
      context: { taskId, source: 'andy_orchestrator' }
    }, {
      timeout: 180000 // 3分钟超时
    });

    logger.info('Lisa代码实现完成', { taskId });
    return response.data;
  } catch (error) {
    logger.error('调用Lisa失败', { taskId, error: error.message });
    throw new Error(`Lisa调用失败: ${error.message}`);
  }
}

/**
 * Andy 架构设计
 */
async function andyDesign(message, userId, taskId) {
  const ANDY_URL = process.env.ANDY_URL || 'http://localhost:3001';

  logger.info('调用Andy进行架构设计', { taskId });

  try {
    const response = await axios.post(`${ANDY_URL}/api/andy/design`, {
      requirement: message,
      userId,
      context: { taskId, mode: 'design' }
    }, {
      timeout: 120000 // 2分钟超时
    });

    logger.info('Andy架构设计完成', { taskId });
    return response.data;
  } catch (error) {
    logger.error('Andy设计失败', { taskId, error: error.message });
    throw new Error(`Andy设计失败: ${error.message}`);
  }
}

/**
 * 处理简单任务（直接 Lisa 实现）
 */
async function handleSimpleTask(message, userId, taskId, intent) {
  updateTask(taskId, {
    status: 'in_progress',
    steps: [{ step: 'lisa_implement', status: 'pending' }]
  });

  try {
    updateTask(taskId, { steps: [{ step: 'lisa_implement', status: 'in_progress' }] });

    const result = await callLisa(message, userId, taskId);

    updateTask(taskId, {
      steps: [{ step: 'lisa_implement', status: 'completed', result }],
      status: 'completed',
      result: result.response || result
    });

    return {
      success: true,
      response: result.response || result,
      taskId,
      steps: ['lisa_implement']
    };
  } catch (error) {
    updateTask(taskId, {
      steps: [{ step: 'lisa_implement', status: 'failed', error: error.message }],
      status: 'failed',
      error: error.message
    });
    throw error;
  }
}

/**
 * 处理复杂任务（Andy 设计 + Lisa 实现）
 */
async function handleComplexTask(message, userId, taskId, intent) {
  updateTask(taskId, {
    status: 'in_progress',
    steps: [
      { step: 'andy_design', status: 'pending' },
      { step: 'lisa_implement', status: 'pending' }
    ]
  });

  try {
    // Step 1: Andy 架构设计
    updateTask(taskId, { steps: [{ step: 'andy_design', status: 'in_progress' }] });
    const designResult = await andyDesign(message, userId, taskId);
    updateTask(taskId, { steps: [{ step: 'andy_design', status: 'completed', result: designResult }] });

    // Step 2: Lisa 代码实现
    updateTask(taskId, { steps: [{ step: 'lisa_implement', status: 'in_progress' }] });
    const implementResult = await callLisa(message, userId, taskId);
    updateTask(taskId, { steps: [{ step: 'lisa_implement', status: 'completed', result: implementResult }] });

    // 完成
    updateTask(taskId, {
      status: 'completed',
      result: implementResult.response || implementResult
    });

    return {
      success: true,
      response: implementResult.response || implementResult,
      taskId,
      design: designResult,
      steps: ['andy_design', 'lisa_implement']
    };
  } catch (error) {
    updateTask(taskId, {
      status: 'failed',
      error: error.message
    });
    throw error;
  }
}

/**
 * 处理调研任务（Andy 调研）
 */
async function handleResearchTask(message, userId, taskId, intent) {
  updateTask(taskId, {
    status: 'in_progress',
    steps: [{ step: 'andy_research', status: 'pending' }]
  });

  try {
    updateTask(taskId, { steps: [{ step: 'andy_research', status: 'in_progress' }] });

    const result = await andyDesign(message, userId, taskId);

    updateTask(taskId, {
      steps: [{ step: 'andy_research', status: 'completed', result }],
      status: 'completed',
      result
    });

    return {
      success: true,
      response: result.response || result,
      taskId,
      steps: ['andy_research']
    };
  } catch (error) {
    updateTask(taskId, {
      steps: [{ step: 'andy_research', status: 'failed', error: error.message }],
      status: 'failed',
      error: error.message
    });
    throw error;
  }
}

/**
 * 异常处理
 */
function orchestratorExceptionHandler(error, taskId, userId) {
  logger.error('Orchestrator异常', { taskId, userId, error: error.message });

  if (taskId) {
    updateTask(taskId, {
      status: 'failed',
      error: error.message
    });
  }

  return {
    userMessage: '处理您的请求时出现问题，请稍后重试或联系管理员',
    logId: `err_${uuidv4().substring(0, 8)}`
  };
}

/**
 * 主入口：处理来自 HomeAI 的开发任务
 */
async function processDevTask(message, userId, intent) {
  const roleAssignment = devRoleAssignment(intent);
  const task = createTask(userId, intent, message);

  logger.info('开始处理开发任务', {
    taskId: task.id,
    intent: intent.type,
    steps: roleAssignment.steps
  });

  let result;

  if (roleAssignment.steps.length === 1 && roleAssignment.steps[0] === 'lisa_implement') {
    // 简单任务
    result = await handleSimpleTask(message, userId, task.id, intent);
  }
  else if (roleAssignment.steps[0] === 'andy_research') {
    // 调研任务
    result = await handleResearchTask(message, userId, task.id, intent);
  }
  else {
    // 复杂任务
    result = await handleComplexTask(message, userId, task.id, intent);
  }

  return {
    taskId: task.id,
    ...result,
    roleAssignment
  };
}

module.exports = {
  // 核心功能
  processDevTask,
  devRoleAssignment,
  createTask,
  updateTask,
  getTask,
  getUserTasks,

  // 任务处理
  handleSimpleTask,
  handleComplexTask,
  handleResearchTask,

  // 异常处理
  orchestratorExceptionHandler,

  // 外部调用
  callLisa,
  andyDesign
};
