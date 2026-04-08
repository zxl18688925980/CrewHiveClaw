/**
 * Lisa 守护进程 - 编码专家
 * 端口: 3002
 * 职责: 代码生成、调试修复、测试验证、指令优化
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const winston = require('winston');
const fs = require('fs').promises;
const path = require('path');
const { spawn } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
require('dotenv').config();

// 初始化 Anthropic SDK
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// 导入上下文管理器
const ContextManager = require('../shared/context-manager');
// 导入NDA知识库模块
const briefManager = require('../shared/brief');
const { knowledgeBase, REQUIREMENT_STATUS } = require('../shared/knowledge-base');
const { generationChecker } = require('../shared/generation-checker');
// 导入模型路由器（v357.0）
const { modelRouter } = require('../shared/model-router');
const { evolutionTracker } = require('../shared/evolution-tracker');
const workspaceLoader = require('../shared/workspace-loader');

// Lisa soul（角色认知），启动时懒加载
let _lisaSoul = null;
async function loadLisaSoul() {
  if (_lisaSoul) return _lisaSoul;
  const soul = await workspaceLoader.loadSoul('lisa');
  _lisaSoul = soul || '你是 Lisa，HomeAI 系统的编码专家，负责把 Andy 的设计方案转化为可运行的代码。';
  return _lisaSoul;
}

// Claude Code 配置
const CLAUDE_CONFIG = {
  maxRetries: 2,
  timeoutMs: 120000,
  workingDir: path.join(__dirname, '../../')
};

// 日志配置
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ 
      filename: path.join(__dirname, '../../logs/lisa-daemon.log')
    }),
    new winston.transports.Console()
  ]
});

const app = express();
const PORT = process.env.LISA_PORT || 3002;

// 中间件
app.use(cors());
app.use(express.json());

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'lisa', 
    port: PORT,
    config: CLAUDE_CONFIG 
  });
});

// 代码实现接口
app.post('/api/lisa/implement', async (req, res) => {
  const { design, timestamp, userId = 'default' } = req.body;
  const implStart = Date.now();

  logger.info('Received implementation request', {
    design: JSON.stringify(design).substring(0, 200),
    timestamp,
    userId
  });

  // 记录到长程记忆
  ContextManager.addToHistory(userId, 'user', `设计: ${JSON.stringify(design).substring(0, 200)}`);
  
  try {
    // ===== NDA整合: 生成前检查 =====
    let preflightCheck = { canContinue: true, issues: [] };
    try {
      preflightCheck = await generationChecker.preGenerationCheck(design);
      logger.info('NDA: 生成前检查完成', { canContinue: preflightCheck.canContinue, issues: preflightCheck.issues });
    } catch (e) {
      logger.warn('NDA: 生成前检查失败', { error: e.message });
    }

    // 如果有未满足的强制需求，记录警告
    if (!preflightCheck.canContinue && preflightCheck.mustUnsatisfied > 0) {
      logger.warn('NDA: 存在未满足的强制需求', { count: preflightCheck.mustUnsatisfied });
    }

    // ===== NDA整合: 加载Brief上下文 =====
    let briefContext = '';
    try {
      const brief = await briefManager.getBrief();
      briefContext = `\n【项目Brief】${brief}\n`;
    } catch (e) {
      logger.debug('Brief加载失败', { error: e.message });
    }

    // 1. 调用 Agent SDK（主路径）：读代码 → 写文件 → 验证 → 自修复
    let agentResult;
    let usedFallback = false;
    try {
      agentResult = await invokeAgentWithSpec(design, briefContext);
      logger.info('Agent SDK 完成实现', { resultLength: agentResult.length });
    } catch (agentError) {
      logger.warn('Agent SDK 失败，回退旧流程', { error: agentError.message });
      usedFallback = true;
    }

    if (usedFallback) {
      // Fallback：原有 messages.create 流程
      const code = await generateCode(design, briefContext);
      const savedPath = await saveCode(code, design);
      const totalLength = Array.isArray(code)
        ? code.reduce((s, f) => s + f.code.length, 0)
        : code.length;
      ContextManager.addToHistory(userId, 'assistant', `代码生成完成（fallback）: 保存至 ${savedPath}`);
      evolutionTracker.track({
        role: 'lisa', type: 'implement', success: true,
        codeLength: totalLength, savedPath,
        durationMs: Date.now() - implStart, isCloud: false
      }).catch(() => {});
      return res.json({
        success: true,
        message: `代码已生成，保存至 ${savedPath}`,
        savedPath, fileCount: Array.isArray(code) ? code.length : 1,
        preflightCheck
      });
    }

    // ===== NDA整合: 生成后自动更新 =====
    try {
      const updateResult = await generationChecker.postGenerationUpdate(agentResult, design);
      logger.info('NDA: 生成后更新完成', { updatedReqs: updateResult.updatedReqs, newDecisions: updateResult.newDecisions });
    } catch (e) {
      logger.warn('NDA: 生成后更新失败', { error: e.message });
    }

    // 2. 写 summary JSON 供 evolution-tracker 追踪
    const projectRoot = path.join(__dirname, '../../../');
    const tsStr = new Date().toISOString().replace(/[:.]/g, '-');
    const summaryDir = path.join(projectRoot, 'app/generated');
    await fs.mkdir(summaryDir, { recursive: true });
    const savedPath = path.join(summaryDir, `generated-${tsStr}.json`);
    const expectedPaths = (design.files || []).map(f => f.path);
    await fs.writeFile(savedPath, JSON.stringify({
      files: expectedPaths, design: design?.summary, agentResult
    }, null, 2), 'utf8');

    const fileCount = design.files?.length || 0;
    ContextManager.addToHistory(userId, 'assistant', `代码实现完成: ${fileCount} 个文件`);

    evolutionTracker.track({
      role: 'lisa', type: 'implement', success: true,
      codeLength: agentResult.length, savedPath,
      durationMs: Date.now() - implStart, isCloud: true
    }).catch(() => {});

    res.json({
      success: true,
      message: `Lisa 已完成实现，写入了 ${fileCount} 个文件，通过语法验证`,
      savedPath,
      fileCount,
      agentResult,
      preflightCheck
    });

  } catch (error) {
    logger.error('Error in implementation', { error: error.message });
    evolutionTracker.track({
      role: 'lisa', type: 'implement', success: false,
      durationMs: Date.now() - implStart
    }).catch(() => {});
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// CrewClaw Gateway 统一入口（daemon proxy 调用此端点）
app.post('/api/chat', async (req, res) => {
  const { message, prompt: promptField, userId = 'default' } = req.body;
  const prompt = message || promptField || '';
  logger.info('收到 /api/chat 请求', { prompt: prompt.substring(0, 100), userId });
  ContextManager.addToHistory(userId, 'user', `代码需求: ${prompt.substring(0, 200)}`);
  try {
    const code = await generateCodeFromPrompt(prompt, 'javascript');
    ContextManager.addToHistory(userId, 'assistant', `代码生成完成: ${code.length}字符`);
    res.json({ success: true, response: `【Lisa】\n${code}` });
  } catch (error) {
    logger.error('Error in /api/chat', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// 代码生成接口（直接调用）
app.post('/api/lisa/generate', async (req, res) => {
  const { prompt, language = 'javascript', userId = 'default' } = req.body;

  logger.info('Received code generation request', { prompt, language, userId });

  // 记录到长程记忆
  ContextManager.addToHistory(userId, 'user', `代码需求: ${prompt.substring(0, 200)}`);

  try {
    const code = await generateCodeFromPrompt(prompt, language);

    // 记录到长程记忆
    ContextManager.addToHistory(userId, 'assistant', `代码生成完成: ${code.length}字符`);
    
    res.json({
      success: true,
      code,
      language
    });
    
  } catch (error) {
    logger.error('Error generating code', { error: error.message });
    res.status(500).json({ 
      success: false, 
      error: error.message
    });
  }
});

/**
 * 调用 Claude Code CLI 生成代码（带重试）
 */
async function callClaudeCode(prompt, cwd = CLAUDE_CONFIG.workingDir) {
  for (let attempt = 0; attempt <= CLAUDE_CONFIG.maxRetries; attempt++) {
    try {
      return await executeClaudeCode(prompt, cwd);
    } catch (error) {
      if (attempt === CLAUDE_CONFIG.maxRetries) {
        logger.error('Claude Code failed after retries', { error: error.message });
        throw error;
      }
      logger.warn(`Claude Code retry ${attempt + 1}/${CLAUDE_CONFIG.maxRetries}`, { error: error.message });
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

/**
 * 执行 Claude Code SDK
 */
async function executeClaudeCode(prompt, cwd) {
  const startTime = Date.now();

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: prompt
      }],
      system: [
        {
          type: 'text',
          text: 'You are a senior software engineer. When asked to write code, output ONLY the code in a markdown code block. Do not include any explanations or surrounding text outside the code block.'
        }
      ]
    });

    const duration = Date.now() - startTime;

    // 提取文本内容
    const output = response.content[0].type === 'text' ? response.content[0].text : '';
    const code = extractCode(output);

    logger.info('Claude SDK succeeded', { duration, outputLength: code.length });
    return code;

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Claude SDK failed', { duration, error: error.message });
    throw new Error(`Claude SDK failed: ${error.message}`);
  }
}

/**
 * 从 Claude Code 输出中提取代码
 */
function extractCode(output) {
  if (!output) return '';
  
  // 查找代码块
  const codeBlockMatch = output.match(/```(?:\w+)?\n([\s\S]*?)```/);
  if (codeBlockMatch) {
    return codeBlockMatch[1].trim();
  }
  
  // 如果没有代码块，返回原输出
  return output.trim();
}

/**
 * 调用 Claude Code Agent SDK 实现完整 spec
 * Agent 会：读现有代码 → 逐文件实现 → 验证语法 → 自行修复 → 汇报结果
 * @param {Object} design - Andy 的实现规格（含 files / implementationOrder）
 * @param {string} briefContext - Brief 上下文
 * @returns {string} agent 完成汇报
 */
async function invokeAgentWithSpec(design, briefContext = '') {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const soul = await loadLisaSoul();

  const files = design.files || [];
  const order = design.implementationOrder || files.map(f => f.path);

  const filesDesc = files.map(f => {
    const fns = (f.keyFunctions || [])
      .map(fn => `    - ${fn.name}(${fn.params || ''}): ${fn.logic || fn.returns || ''}`)
      .join('\n') || '    （无）';
    return `文件：${f.path}\n  职责：${f.description}\n  类型：${f.type}\n  关键函数：\n${fns}\n  依赖：${(f.dependencies || []).join(', ') || '无'}`;
  }).join('\n\n');

  const depsSection = design.newDependencies?.length
    ? `\n【需要安装的依赖】\n${design.newDependencies.map(d => `- ${d}`).join('\n')}`
    : '';

  const integrationSection = (design.integrationNotes || []).length
    ? (design.integrationNotes || []).map(n => `- ${n}`).join('\n')
    : '无';

  const prompt = `根据以下实现规格，在 HomeAI 项目中实现所有代码文件。

【项目摘要】${design.summary || ''}
【技术栈】${(design.techStack || []).join(', ')}${depsSection}

【实现顺序】
${order.join(' → ')}

【文件规格】
${filesDesc}

【集成说明】
${integrationSection}

${briefContext ? `【项目 Brief】\n${briefContext}\n` : ''}
要求：
1. 严格按照实现顺序逐个文件实现，确保函数名与规格一致
2. 文件路径相对于当前工作目录写入（scripts/xxx.py 直接写到 scripts/ 目录）
3. 每个文件写完后做基本语法验证：
   - Python 文件：python3 -m py_compile <文件>
   - Node.js 文件：node --check <文件>
4. 如果验证失败，自行修复后再继续下一个文件
5. 全部完成后，汇报：实现了哪些文件、各多少行、验证结果是否全部通过`;

  let result = '';
  for await (const message of query({ prompt, options: {
    cwd: path.join(__dirname, '../../../'),
    allowed_tools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
    permission_mode: 'acceptEdits',
    system_prompt: soul,
    model: 'claude-opus-4-6',
    max_turns: 40,
  }})) {
    if (message.type === 'result') {
      result = message.result || result;
    }
  }

  return result || '实现完成';
}

/**
 * 根据设计生成代码（使用上下文管理器）
 * 当 design.files 存在时，按 implementationOrder 逐文件生成，每次聚焦单一文件。
 * @param {Object} design - 架构设计（Andy spec 格式，含 files / implementationOrder）
 * @param {string} briefContext - Brief上下文（NDA整合）
 * @returns {Array<{path:string,code:string}>|string} 多文件时返回数组，fallback 时返回字符串
 */
async function generateCode(design, briefContext = '') {
  const files = design.files || [];

  // 有多文件 spec：按 implementationOrder 逐文件生成
  if (files.length > 0) {
    const order = design.implementationOrder || files.map(f => f.path);
    const orderedFiles = order
      .map(p => files.find(f => f.path === p))
      .filter(Boolean);

    logger.info('Lisa 多文件生成模式', { totalFiles: orderedFiles.length, order });

    const results = [];
    for (const file of orderedFiles) {
      logger.info('生成文件', { path: file.path });
      const code = await generateSingleFile(file, design, briefContext);
      results.push({ path: file.path, code });
    }
    return results;
  }

  // 无 files 字段（旧格式或简单请求）：沿用原有逻辑
  return generateLegacyCode(design, briefContext);
}

/**
 * 为单个文件生成代码
 */
async function generateSingleFile(file, design, briefContext) {
  const simplifiedPrompt = ContextManager.getSimplifiedPrompt('lisa');

  const keyFunctionsDesc = (file.keyFunctions || [])
    .map(fn => `  - ${fn.name}(${fn.params || ''}): ${fn.logic || fn.returns || ''}`)
    .join('\n') || '  （无）';

  const prompt = `${simplifiedPrompt}
${briefContext}

你是一名编码专家，正在实现一个多文件项目中的单个文件。
**只输出这一个文件的完整代码，不要输出其他文件。**

项目概述：${design.summary || ''}
技术栈：${(design.techStack || []).join(', ')}

当前文件：
  路径：${file.path}
  类型：${file.type || 'module'}
  职责：${file.description || ''}
  依赖模块：${(file.dependencies || []).join(', ') || '无'}

需要实现的关键函数：
${keyFunctionsDesc}

集成注意事项：
${(design.integrationNotes || []).map(n => `  - ${n}`).join('\n') || '  无'}

要求：
1. 输出完整可运行的代码，不要省略任何实现细节
2. 代码包含必要注释
3. 遵循 Node.js 最佳实践
4. 只输出代码块，不要解释

\`\`\`javascript`;

  try {
    const code = await callClaudeCode(prompt);
    return code;
  } catch (claudeError) {
    logger.warn('Claude Code 失败，回退模型路由器', { path: file.path, error: claudeError.message });
    try {
      const routeResult = await modelRouter.route(prompt, 'code');
      return extractCode(routeResult.response);
    } catch (routerError) {
      logger.error('模型路由器也失败，使用模板', { path: file.path, error: routerError.message });
      return generateTemplateCode(design);
    }
  }
}

/**
 * 旧格式（无 files 字段）的代码生成——保持向后兼容
 */
async function generateLegacyCode(design, briefContext) {
  const simplifiedPrompt = ContextManager.getSimplifiedPrompt('lisa');

  const prompt = `${simplifiedPrompt}
${briefContext}

作为编码专家，根据以下架构设计生成代码：

架构设计：
${JSON.stringify(design, null, 2)}

要求：
1. 使用 Node.js + Express
2. 代码需要包含注释
3. 遵循最佳实践
4. 生成完整的可运行代码

请生成代码：`;

  try {
    return await callClaudeCode(prompt);
  } catch (claudeError) {
    logger.warn('Claude Code 失败，回退模型路由器', { error: claudeError.message });
    try {
      const routeResult = await modelRouter.route(prompt, 'code');
      return extractCode(routeResult.response);
    } catch (routerError) {
      logger.error('模型路由器也失败，使用模板', { error: routerError.message });
      return generateTemplateCode(design);
    }
  }
}

/**
 * 根据提示词生成代码
 */
async function generateCodeFromPrompt(prompt, language) {
  const fullPrompt = `请用 ${language} 编写代码实现以下需求：

${prompt}

要求：
1. 代码清晰、有注释
2. 遵循 ${language} 最佳实践
3. 提供完整实现

代码：`;
  
  // 优先使用 Claude Code CLI（带重试）
  try {
    logger.info('Attempting Claude Code CLI for prompt');
    const code = await callClaudeCode(fullPrompt);
    return code;
  } catch (claudeError) {
    logger.warn('Claude Code failed, falling back to Ollama', { 
      error: claudeError.message 
    });
    
    // 回退到 Ollama
    try {
      const response = await axios.post('http://localhost:11434/api/generate', {
        model: 'homeai-assistant',
        prompt: fullPrompt,
        stream: false
      }, {
        timeout: 60000
      });
      
      return extractCode(response.data.response);
    } catch (ollamaError) {
      logger.error('Both Claude Code and Ollama failed', { 
        error: ollamaError.message 
      });
      throw new Error(`Code generation failed: ${claudeError.message}, ${ollamaError.message}`);
    }
  }
}

/**
 * 生成模板代码
 */
function generateTemplateCode(design) {
  return `/**
 * 自动生成的代码模板
 * 基于架构设计：${design.architecture || 'Default'}
 * 生成时间：${new Date().toISOString()}
 */

const express = require('express');
const app = express();

// 中间件
app.use(express.json());

// 健康检查
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 业务路由
app.post('/api/action', (req, res) => {
  // TODO: 实现业务逻辑
  const { data } = req.body;
  res.json({ success: true, data });
});

// 启动服务器
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(\`服务运行在端口 \${PORT}\`);
});

module.exports = app;
`;
}

/**
 * 保存代码到文件
 * - 多文件模式（code 为数组）：每个文件写到 projectRoot/<path>，并在 app/generated/ 留副本
 * - 单文件模式（code 为字符串）：写到 app/generated/generated-*.js（向后兼容）
 */
async function saveCode(code, design) {
  const projectRoot = path.join(__dirname, '../../../');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

  // 多文件模式
  if (Array.isArray(code)) {
    const savedPaths = [];
    for (const { path: filePath, code: fileCode } of code) {
      const absPath = path.join(projectRoot, filePath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, fileCode, 'utf8');
      logger.info('文件已写入', { path: absPath, length: fileCode.length });
      savedPaths.push(absPath);
    }
    // 同时在 app/generated/ 保存一份汇总（方便 evolution-tracker 追踪）
    const summaryDir = path.join(projectRoot, 'app/generated');
    await fs.mkdir(summaryDir, { recursive: true });
    const summaryPath = path.join(summaryDir, `generated-${timestamp}.json`);
    await fs.writeFile(summaryPath, JSON.stringify({ files: savedPaths, design: design?.summary }, null, 2), 'utf8');
    return savedPaths.join(', ');
  }

  // 单文件模式（向后兼容）
  const saveDir = path.join(projectRoot, 'app/generated');
  await fs.mkdir(saveDir, { recursive: true });
  const filePath = path.join(saveDir, `generated-${timestamp}.js`);
  await fs.writeFile(filePath, code, 'utf8');
  logger.info('Code saved', { filePath, codeLength: code.length });
  return filePath;
}

// 启动服务器
async function startup() {
  // 确保 workspace 存在（幂等，第一次启动自动从模板初始化）
  try {
    await workspaceLoader.ensureWorkspace('lisa');
    logger.info('✅ Lisa workspace 已就绪', { dir: workspaceLoader.resolveWorkspaceDir('lisa') });
  } catch (e) {
    logger.warn('⚠️ Lisa workspace 初始化失败', { error: e.message });
  }

  // 预加载 soul
  await loadLisaSoul();

  await evolutionTracker.initialize().catch(e => console.warn('[lisa] evolution-tracker 初始化失败:', e.message));

  app.listen(PORT, () => {
    logger.info(`Lisa 守护进程已启动`, {
      port: PORT,
      config: CLAUDE_CONFIG
    });
    console.log(`Lisa 守护进程运行在端口 ${PORT}`);
    console.log(`配置: 超时=${CLAUDE_CONFIG.timeoutMs}ms, 重试=${CLAUDE_CONFIG.maxRetries}次`);
  });
}

startup();

// 优雅关闭
process.on('SIGTERM', () => {
  logger.info('SIGTERM received, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  logger.info('SIGINT received, shutting down gracefully');
  process.exit(0);
});
