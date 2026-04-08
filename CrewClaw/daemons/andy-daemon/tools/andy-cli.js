/**
 * Andy 架构设计调试工具
 * 用 ClaudeCode CLI 封装 Andy 的能力，方便持续调试
 *
 * 使用方式:
 *   node tools/andy-cli.js "需求描述"
 *   node tools/andy-cli.js --file requirements.txt
 *   node tools/andy-cli.js --interactive
 */

const { spawn } = require('child_process');
const readline = require('readline');
const fs = require('fs');
const path = require('path');

const ANDY_PROMPT = `你是 Andy（规划架构师），HomeAI 系统的架构大师。

## 你的角色
- 产品经理 + 架构师 + 软件项目经理
- 职责：需求分析、架构设计、计划制定、决策记录、质量把控

## 工作流程
1. 理解用户需求
2. 分析功能点和技术要求
3. 识别风险和依赖
4. 设计架构方案
5. 输出结构化的设计文档

## 输出格式要求
请按以下 JSON 格式输出架构设计：

\`\`\`json
{
  "requirement_summary": "需求摘要",
  "functional_requirements": ["功能点1", "功能点2"],
  "technical_requirements": ["技术要求1", "技术要求2"],
  "architecture": {
    "type": "架构类型",
    "components": [
      {
        "name": "组件名",
        "responsibility": "职责",
        "technology": "技术栈"
      }
    ],
    "data_flow": "数据流向"
  },
  "risks": ["风险1"],
  "dependencies": ["依赖1"],
  "next_steps": ["下一步1"]
}
\`\`\`

## 约束
- 只输出 JSON，不要其他内容
- 如果需求不明确，先指出需要澄清的问题
- 保持设计简洁实用`;

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Andy 架构设计调试工具');
  console.log('=====================');
  console.log('用法:');
  console.log('  node andy-cli.js "<需求描述>"     # 直接分析需求');
  console.log('  node andy-cli.js --file <文件>    # 从文件读取需求');
  console.log('  node andy-cli.js --interactive    # 交互模式');
  process.exit(0);
}

// 处理参数
if (args[0] === '--interactive') {
  runInteractiveMode();
} else if (args[0] === '--file') {
  const filePath = args[1];
  if (!filePath) {
    console.error('错误: 请指定文件路径');
    process.exit(1);
  }
  analyzeRequirement(readFile(filePath));
} else {
  // 直接分析需求
  analyzeRequirement(args.join(' '));
}

function readFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch (error) {
    console.error(`读取文件失败: ${error.message}`);
    process.exit(1);
  }
}

function runInteractiveMode() {
  console.log('Andy 交互模式 - 输入需求进行架构设计');
  console.log('输入 "quit" 或 "exit" 退出\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '需求> '
  });

  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();

    if (input === 'quit' || input === 'exit') {
      console.log('退出 Andy 交互模式');
      process.exit(0);
    }

    if (input) {
      analyzeRequirement(input);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    console.log('\n退出 Andy 交互模式');
    process.exit(0);
  });
}

function analyzeRequirement(requirement) {
  console.log('\n📋 需求:', requirement);
  console.log('🤔 Andy 正在分析...\n');

  const fullPrompt = `${ANDY_PROMPT}

用户需求：${requirement}

请直接输出 JSON 格式的架构设计结果：`;

  // 调用 Claude Code（需要取消设置 CLAUDECODE 环境变量以避免嵌套会话问题）
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const claude = spawn('claude', [
    '-p',
    '--print',
    '--max-turns', '1',
    fullPrompt
  ], {
    cwd: process.cwd(),
    env
  });

  let stdout = '';
  let stderr = '';

  claude.stdout.on('data', (data) => {
    stdout += data.toString();
  });

  claude.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  claude.on('error', (error) => {
    console.error('❌ Claude Code 调用失败:', error.message);
    process.exit(1);
  });

  claude.on('close', (code) => {
    if (code !== 0 && stderr) {
      console.error('❌ 错误:', stderr);
      process.exit(1);
    }

    // 提取 JSON
    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const result = JSON.parse(jsonMatch[0]);
        console.log('✅ 架构设计结果:\n');
        console.log(JSON.stringify(result, null, 2));
      } catch (parseError) {
        console.log('📄 Claude Code 响应:\n');
        console.log(stdout);
      }
    } else {
      console.log('📄 Claude Code 响应:\n');
      console.log(stdout);
    }
  });
}
