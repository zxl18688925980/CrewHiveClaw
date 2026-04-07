/**
 * Lisa 代码实现调试工具
 * 用 ClaudeCode CLI 封装 Lisa 的能力，方便持续调试
 *
 * 使用方式:
 *   node tools/lisa-cli.js "实现需求"
 *   node tools/lisa-cli.js --file design.json
 *   node tools/lisa-cli.js --interactive
 */

const { spawn } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const readline = require('readline');
const fs = require('fs');

// 初始化 Anthropic SDK
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const LISA_PROMPT = `你是 Lisa（编码专家），HomeAI 系统的实现大师。

## 你的角色
- 高级开发工程师 + 测试工程师
- 职责：代码开发、调试修复、系统集成、单元测试、E2E测试、功能验收

## 工作流程
1. 理解设计和需求
2. 编写代码实现
3. 编写测试用例
4. 验证代码正确性

## 输出格式要求
请按以下 JSON 格式输出实现方案：

\`\`\`json
{
  "files": [
    {
      "path": "文件路径",
      "action": "create/update/delete",
      "content": "文件内容或修改说明"
    }
  ],
  "tests": [
    {
      "path": "测试文件路径",
      "content": "测试代码"
    }
  ],
  "verification": {
    "steps": ["验证步骤1", "验证步骤2"],
    "expected_result": "预期结果"
  },
  "notes": ["备注1"]
}
\`\`\`

## 约束
- 只输出 JSON，不要其他内容
- 保持代码简洁实用
- 优先使用现代 JavaScript/TypeScript 语法`;

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log('Lisa 代码实现调试工具');
  console.log('=====================');
  console.log('用法:');
  console.log('  node lisa-cli.js "<实现需求>"     # 直接实现');
  console.log('  node lisa-cli.js --file <文件>    # 从文件读取');
  console.log('  node lisa-cli.js --interactive    # 交互模式');
  process.exit(0);
}

if (args[0] === '--interactive') {
  runInteractiveMode();
} else if (args[0] === '--file') {
  const filePath = args[1];
  if (!filePath) {
    console.error('错误: 请指定文件路径');
    process.exit(1);
  }
  implementFeature(readFile(filePath));
} else {
  implementFeature(args.join(' '));
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
  console.log('Lisa 交互模式 - 输入实现需求');
  console.log('输入 "quit" 或 "exit" 退出\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '实现需求> '
  });

  rl.prompt();

  rl.on('line', (line) => {
    const input = line.trim();

    if (input === 'quit' || input === 'exit') {
      console.log('退出 Lisa 交互模式');
      process.exit(0);
    }

    if (input) {
      implementFeature(input);
    }

    rl.prompt();
  });

  rl.on('close', () => {
    process.exit(0);
  });
}

async function implementFeature(requirement) {
  console.log('\n📋 实现需求:', requirement);
  console.log('💻 Lisa 正在编码...\n');

  const fullPrompt = `${LISA_PROMPT}

用户需求：${requirement}

请直接输出 JSON 格式的实现方案：`;

  // 调用 Claude SDK
  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: fullPrompt
      }]
    });

    const stdout = response.content[0].type === 'text' ? response.content[0].text : '';

    const jsonMatch = stdout.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        const result = JSON.parse(jsonMatch[0]);
        console.log('✅ 实现方案:\n');
        console.log(JSON.stringify(result, null, 2));
      } catch (parseError) {
        console.log('📄 Claude 响应:\n');
        console.log(stdout);
      }
    } else {
      console.log('📄 Claude 响应:\n');
      console.log(stdout);
    }
  } catch (error) {
    console.error('❌ Claude SDK 调用失败:', error.message);
    process.exit(1);
  }
}
