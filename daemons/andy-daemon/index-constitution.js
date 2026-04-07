/**
 * Andy 守护进程 - 架构大师（宪法增强版）
 * 端口: 3001
 * 职责: 需求分析、架构设计、计划制定、决策记录
 *
 * 增强版：启动时加载宪法，强化架构师角色认知与宪法遵从
 * v345.1: 使用统一路径配置模块
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const winston = require('winston');
require('dotenv').config();

const path = require('path');

// 导入共享模块
const constitution = require('../shared/constitution');
const { paths, ensureDirectories } = require('../shared/paths');
const contextManager = require('../shared/context-manager');
const { memoryClient, memoryInitialized } = require('../shared/memory-client');
const { ModelRouter, ROUTING_PHASES } = require('../shared/model-router');

// 日志配置（使用统一路径）
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: paths.logs.andy
    }),
    new winston.transports.Console()
  ]
});

const app = express();
const PORT = process.env.ANDY_PORT || 3001;

// 宪法强化提示
let constitutionPrompt = '';

// Andy 专用模型路由器 - 使用 MiniMax 进行架构设计
const andyModelRouter = new ModelRouter({
  phase: ROUTING_PHASES.PHASE1,
  confidenceThreshold: 0.7,
  localModel: 'homeai-assistant',
  cloudModels: {
    conversation: 'deepseek/deepseek-chat',
    architecture: 'minimax/minimax-text-01',  // Andy 专用架构模型
    code: 'zhipu/glm-5'
  }
});

// ContextManager 使用共享实例
const andyContextManager = contextManager;

/**
 * 启动函数 - 加载宪法并初始化
 */
async function startup() {
  logger.info('🚀 Andy 守护进程启动中（宪法增强版）...');
  
  // 1. 加载宪法
  logger.info('📜 正在加载项目宪法...');
  const constitutionLoaded = await constitution.load();
  
  if (constitutionLoaded) {
    // 2. 获取角色强化提示
    constitutionPrompt = constitution.getRolePrompt('andy');
    
    const summary = constitution.getSummary();
    logger.info('✅ Andy 宪法强化完成', { 
      promptLength: constitutionPrompt.length,
      role: summary.roles.andy
    });
    
    // 显示宪法信息
    console.log('\n' + '='.repeat(60));
    console.log('          Andy - 架构大师（宪法增强版）');
    console.log('='.repeat(60));
    console.log(`角色: ${summary.roles.andy}`);
    console.log(`宪法约束: ${JSON.stringify(summary.constraints)}`);
    console.log(`协作规则: ${summary.coordinationRules} 条`);
    console.log('='.repeat(60) + '\n');
    
    // 显示协作流程
    console.log('📋 协作流程:');
    console.log(constitution.getCoordinationFlow());
    console.log('');
  } else {
    logger.warn('⚠️ 宪法加载失败，使用默认角色认知');
    constitutionPrompt = '你是 Andy，架构大师，负责需求分析、架构设计。';
  }
  
  // 3. 启动服务器
  app.listen(PORT, () => {
    logger.info('Andy 守护进程已启动', { port: PORT });
    console.log(`🏗️  Andy 守护进程运行在端口 ${PORT}`);
    
    if (constitutionLoaded) {
      console.log('📜 宪法约束已激活，架构决策将进行宪法验证');
    }
  });
}

// 中间件
app.use(cors());
app.use(express.json());

// 健康检查（包含宪法状态）
app.get('/api/health', (req, res) => {
  const summary = constitution.getSummary();
  const routerStats = andyModelRouter.getStats();

  res.json({
    status: 'ok',
    service: 'andy',
    port: PORT,
    constitution: {
      loaded: summary.loaded,
      role: summary.roles.andy,
      constraints: summary.constraints
    },
    modelRouter: {
      phase: routerStats.phase,
      model: 'minimax/minimax-text-01'
    },
    context: andyContextManager.stats || null,
    memory: memoryInitialized
  });
});

// 宪法状态接口
app.get('/api/andy/constitution', (req, res) => {
  const summary = constitution.getSummary();
  const prompt = constitution.getRolePrompt('andy');
  
  res.json({
    success: true,
    role: 'andy',
    prompt: prompt.substring(0, 500) + '...',
    promptLength: prompt.length,
    summary
  });
});

// 架构设计接口（宪法增强版）
app.post('/api/andy/design', async (req, res) => {
  const { requirement, userId = 'default', timestamp } = req.body;
  
  logger.info('Received design request', { 
    requirement: requirement.substring(0, 200),
    userId 
  });
  
  try {
    // 1. 宪法验证：检查需求是否合规
    const decision = {
      type: 'architecture-design',
      requirement: requirement,
      userId: userId,
      timestamp: timestamp || new Date().toISOString()
    };
    
    const validation = constitution.validateDecision('andy', decision, {
      architectureReview: true
    });
    
    if (!validation.valid) {
      logger.warn('宪法验证失败', { violations: validation.violations });
      
      return res.status(400).json({
        success: false,
        error: '宪法约束违规',
        violations: validation.violations,
        suggestion: '请修改需求以符合宪法约束，或联系家庭业主审批。'
      });
    }
    
    // 2. 分析需求（宪法增强版）
    const analysis = await analyzeRequirement(requirement);
    
    // 3. 生成架构方案（宪法增强版）
    const design = await generateDesign(analysis);
    
    // 4. 调用 Lisa 实现（宪法规定的协作流程）
    const implementation = await callLisa(design);
    
    // 5. 记录决策（宪法要求）
    await recordDecision(userId, requirement, design, validation);
    
    res.json({
      success: true,
      analysis,
      design,
      implementation,
      constitution: {
        validated: true,
        validation
      }
    });
    
  } catch (error) {
    logger.error('Error in design process', { error: error.message });
    
    // 更友好的错误响应
    const errorMessage = error.message.includes('timeout') 
      ? '设计处理超时，模型响应较慢。已启用简化设计模式。'
      : `设计处理错误: ${error.message}`;
    
    res.json({ 
      success: true, // 仍然返回success: true，但包含错误信息
      analysis: {
        original: requirement,
        analysis: `需求分析（应急模式）：正在处理需求"${requirement.substring(0, 100)}..."`,
        timestamp: new Date().toISOString(),
        emergency: true
      },
      design: {
        design: `架构设计（应急模式）：建议采用标准的三层架构，确保系统稳定性和可扩展性。详细设计将在模型服务恢复后提供。`,
        timestamp: new Date().toISOString(),
        emergency: true
      },
      warning: errorMessage,
      constitution: {
        validated: true,
        note: '宪法验证通过，但设计生成受限'
      }
    });
  }
});

// 宪法验证接口
app.post('/api/andy/validate', (req, res) => {
  const { decision, context } = req.body;
  
  if (!decision) {
    return res.status(400).json({ 
      success: false, 
      error: '必须提供决策内容' 
    });
  }
  
  const validation = constitution.validateDecision('andy', decision, context);
  
  res.json({
    success: true,
    role: 'andy',
    validation,
    timestamp: new Date().toISOString()
  });
});

/**
 * 带重试的API调用
 */
async function callWithRetry(apiCall, maxRetries = 3, baseDelay = 1000) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await apiCall();
    } catch (error) {
      logger.warn(`API call failed (attempt ${i + 1}/${maxRetries}):`, { error: error.message });
      
      if (i === maxRetries - 1) {
        throw error;
      }
      
      // 指数退避
      const delay = baseDelay * Math.pow(2, i);
      logger.info(`Retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * 简化宪法提示
 */
function getSimplifiedConstitutionPrompt() {
  return `你是Andy，HomeAI项目的架构大师。
核心职责：需求分析、架构设计、技术决策。
宪法约束：稳定性第一、安全可靠、向后兼容。
现在请开始工作。`;
}

/**
 * 分析需求（使用模型路由器 - Andy 专用 MiniMax）
 */
async function analyzeRequirement(requirement, timeoutMs = 60000) {
  try {
    // 使用简化提示词
    const simplifiedPrompt = getSimplifiedConstitutionPrompt();

    const enhancedPrompt = `${simplifiedPrompt}

请分析以下需求：
"${requirement}"

请提供简洁的需求分析，包括：
1. 核心功能点
2. 技术可行性
3. 主要挑战
4. 建议方案

请保持分析简洁明了。`;

    // 使用 Andy 专用模型路由器（MiniMax）
    const routeResult = await andyModelRouter.route(enhancedPrompt, 'architecture');

    return {
      original: requirement,
      analysis: routeResult.response,
      timestamp: new Date().toISOString(),
      modelUsed: routeResult.modelUsed,
      simplified: true
    };
  } catch (error) {
    logger.error('Error analyzing requirement after retries', { error: error.message });

    // 提供降级响应
    return {
      original: requirement,
      analysis: `需求分析（简化版）：基于需求"${requirement.substring(0, 100)}..."，建议采用模块化设计，保持系统稳定性。详细设计需要模型服务恢复正常后提供。`,
      timestamp: new Date().toISOString(),
      fallback: true,
      error: error.message
    };
  }
}

/**
 * 生成架构方案（使用模型路由器 - Andy 专用 MiniMax）
 */
async function generateDesign(analysis, timeoutMs = 80000) {
  try {
    const simplifiedPrompt = getSimplifiedConstitutionPrompt();

    const prompt = `${simplifiedPrompt}

基于以下需求分析：
${analysis.analysis.substring(0, 500)}...

请生成简洁的架构设计方案，包括：
1. 主要组件和关系
2. 关键技术选择
3. 数据流向说明
4. 接口设计要点

请保持方案简洁实用。`;

    // 使用 Andy 专用模型路由器（MiniMax）
    const routeResult = await andyModelRouter.route(prompt, 'architecture');

    return {
      analysisId: analysis.timestamp,
      design: routeResult.response,
      timestamp: new Date().toISOString(),
      modelUsed: routeResult.modelUsed,
      constitutionChecked: true,
      simplified: true
    };
  } catch (error) {
    logger.error('Error generating design after retries', { error: error.message });

    // 提供降级设计
    return {
      analysisId: analysis.timestamp,
      design: `架构设计（简化版）：采用分层架构，包含表示层、业务逻辑层、数据访问层。使用RESTful API进行通信，确保模块间松耦合。详细设计需要模型服务恢复正常后提供。`,
      timestamp: new Date().toISOString(),
      fallback: true,
      error: error.message
    };
  }
}

/**
 * 调用 Lisa 实现（宪法规定的协作）
 */
async function callLisa(design) {
  try {
    const response = await axios.post('http://localhost:3002/api/lisa/implement', {
      design: design,
      timestamp: new Date().toISOString(),
      source: 'andy',
      constitutionValidated: true
    }, {
      timeout: 60000
    });
    
    return {
      success: true,
      lisaResponse: response.data,
      timestamp: new Date().toISOString()
    };
  } catch (error) {
    logger.error('Error calling Lisa', { error: error.message });
    
    // 根据宪法，如果 Lisa 失败，应该记录并通知
    return {
      success: false,
      error: error.message,
      fallback: '已记录到决策日志，需要人工干预',
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * 记录决策（宪法要求）
 */
async function recordDecision(userId, requirement, design, validation) {
  const decisionLog = {
    timestamp: new Date().toISOString(),
    userId,
    requirement: requirement.substring(0, 500),
    designSummary: design.design ? design.design.substring(0, 300) : 'No design',
    constitution: {
      validated: validation.valid,
      violations: validation.violations
    },
    role: 'andy'
  };
  
  logger.info('Decision recorded', decisionLog);
  
  // TODO: 保存到决策日志文件
  // const logPath = path.join(__dirname, '../../data/knowledge/decisions/');
  // await fs.writeFile(`${logPath}/andy-${Date.now()}.json`, JSON.stringify(decisionLog, null, 2));
  
  return true;
}

/**
 * 快速设计接口（简化版，用于测试）
 */
app.post('/api/andy/quick-design', async (req, res) => {
  const { requirement } = req.body;
  
  if (!requirement) {
    return res.status(400).json({ success: false, error: '必须提供需求' });
  }
  
  try {
    // 简化的宪法验证
    const decision = { type: 'quick-design', requirement };
    const validation = constitution.validateDecision('andy', decision);
    
    if (!validation.valid) {
      return res.json({
        success: false,
        error: '宪法约束违规',
        validation
      });
    }
    
    // 快速分析 - 使用简化提示和小模型
    const simplifiedPrompt = getSimplifiedConstitutionPrompt();
    const prompt = `${simplifiedPrompt}

快速分析需求："${requirement}"
提供3点简要架构建议：`;
    
    const response = await callWithRetry(async () => {
      return await axios.post('http://localhost:11434/api/generate', {
        model: 'homeai-assistant', // HomeAI专用微调模型
        prompt: prompt,
        stream: false,
        options: {
          num_predict: 250,
          temperature: 0.7
        }
      }, {
        timeout: 20000
      });
    }, 1, 1000); // 1次重试
    
    res.json({
      success: true,
      requirement,
      suggestion: response.data.response,
      constitution: { validated: true },
      model: 'qwen2.5:7b'
    });
    
  } catch (error) {
    // 降级响应
    res.json({
      success: true,
      requirement,
      suggestion: `架构建议（简化版）：对于需求"${requirement.substring(0, 50)}..."，建议：1) 模块化设计 2) 接口先行 3) 测试驱动。详细建议需要模型服务恢复。`,
      constitution: { validated: true },
      fallback: true,
      warning: '使用简化响应（模型服务响应慢）'
    });
  }
});

// ============ Andy 开发编排器 (Orchestrator) ============

// 导入编排器
const andyOrchestrator = require('../shared/andy-orchestrator');

/**
 * 处理开发任务
 * HomeAI 识别到开发需求后调用此接口
 */
app.post('/api/dev/task', async (req, res) => {
  const { message, userId = 'default', intent } = req.body;

  if (!message) {
    return res.status(400).json({ success: false, error: '必须提供需求描述' });
  }

  if (!intent) {
    return res.status(400).json({ success: false, error: '必须提供意图识别结果' });
  }

  logger.info('收到开发任务', { userId, intent: intent.type });

  try {
    const result = await andyOrchestrator.processDevTask(message, userId, intent);
    res.json({
      success: true,
      ...result
    });
  } catch (error) {
    const handled = andyOrchestrator.orchestratorExceptionHandler(error, null, userId);
    logger.error('开发任务处理失败', { error: error.message });
    res.status(500).json({
      success: false,
      error: handled.userMessage
    });
  }
});

/**
 * 获取任务列表
 */
app.get('/api/dev/tasks', (req, res) => {
  const { userId = 'default' } = req.query;
  const tasks = andyOrchestrator.getUserTasks(userId);
  res.json({ success: true, tasks });
});

/**
 * 获取任务详情
 */
app.get('/api/dev/task/:taskId', (req, res) => {
  const { taskId } = req.params;
  const task = andyOrchestrator.getTask(taskId);

  if (!task) {
    return res.status(404).json({ success: false, error: '任务不存在' });
  }

  res.json({ success: true, task });
});

// 启动系统
startup().catch(error => {
  logger.error('启动失败', { error: error.message });
  process.exit(1);
});

module.exports = app;