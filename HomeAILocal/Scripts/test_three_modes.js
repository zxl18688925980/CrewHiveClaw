#!/usr/bin/env node
/**
 * 三模式切换测试
 * 测试 homeai-assistant 在业务/架构/实现三种模式下的表现
 */

const OLLAMA_URL = 'http://localhost:11434';
const MODEL = 'homeai-assistant';

// 三套模式 prompt
const MODES = {
  // 业务模式 - HomeAI 家庭助手
  business: {
    name: "业务模式 (HomeAI)",
    system: `你是曾璿岐霖，曾家的小儿子，家庭智能助手。你的主要职责是与家庭成员进行日常对话，理解需求，提供帮助。

对话风格：调皮但靠谱，幽默风趣，像家人一样交流。
重点：理解用户意图，提供友好的对话体验。`
  },

  // 架构模式 - Andy 架构大师
  architecture: {
    name: "架构模式 (Andy)",
    system: `你是 Andy，HomeAI 项目的架构大师，产品经理+架构师+软件项目经理。

你的职责：
- 需求分析，理解用户想要什么
- 架构设计，规划系统如何实现
- 决策记录，保留设计选择的原因
- 质量把控，确保方案可行

输出格式：结构化的架构文档，包含组件设计、技术选型、风险评估。`
  },

  // 实现模式 - Lisa 编码专家
  implementation: {
    name: "实现模式 (Lisa)",
    system: `你是 Lisa，HomeAI 项目的编码专家，高级开发工程师+测试工程师。

你的职责：
- 代码开发，按照设计实现功能
- 调试修复，解决技术问题
- 系统集成，确保各模块协同
- 测试验证，保证功能正确

编码规范：
- 代码即文档，注释清晰
- 单一职责，模块化设计

输出格式：完整的代码实现。`
  }
};

// 测试问题
const TESTS = {
  business: [
    "你好",
    "今天天气怎么样？",
    "姐姐在干嘛？"
  ],
  architecture: [
    "设计一个用户登录模块",
    "如何设计家庭设备控制架构？"
  ],
  implementation: [
    "写一个获取天气的函数",
    "实现一个简单的日志系统"
  ]
};

async function chat(systemPrompt, userMessage) {
  const response = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage }
      ],
      stream: false
    })
  });

  const data = await response.json();
  return data.message?.content || data.error || 'No response';
}

async function testMode(modeKey, mode, questions) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`🧪 ${mode.name}`);
  console.log('='.repeat(60));

  for (const q of questions) {
    console.log(`\n❓ 问题: ${q}`);
    console.log('-'.repeat(50));

    try {
      const start = Date.now();
      const response = await chat(mode.system, q);
      const elapsed = (Date.now() - start) / 1000;

      // 截断过长响应
      const display = response.length > 600
        ? response.slice(0, 600) + '...\n(截断)'
        : response;

      console.log(`💬 回答 (${elapsed.toFixed(1)}s):\n${display}`);
    } catch (e) {
      console.log(`❌ 错误: ${e.message}`);
    }
  }
}

async function main() {
  console.log('🚀 三模式切换测试开始');
  console.log(`📦 使用模型: ${MODEL}`);

  // 检查模型
  try {
    const health = await fetch(`${OLLAMA_URL}/api/tags`);
    const models = await health.json();
    const modelList = (models.models || []).map(m => m.name);

    console.log('可用模型:', modelList.join(', '));

    // 检查模型（支持完整名称或简称）
    const modelFound = modelList.some(m => m === MODEL || m.startsWith(MODEL + ':'));
    if (!modelFound) {
      console.error(`❌ 模型 ${MODEL} 未找到`);
      process.exit(1);
    }
    console.log('✅ 模型可用\n');
  } catch (e) {
    console.error('❌ Ollama 未运行:', e.message);
    process.exit(1);
  }

  // 测试三种模式
  await testMode('business', MODES.business, TESTS.business);
  await testMode('architecture', MODES.architecture, TESTS.architecture);
  await testMode('implementation', MODES.implementation, TESTS.implementation);

  console.log(`\n${'='.repeat(60)}`);
  console.log('✅ 测试完成');
  console.log('='.repeat(60));
}

main().catch(console.error);
