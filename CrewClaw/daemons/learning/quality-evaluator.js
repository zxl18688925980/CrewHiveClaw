/**
 * 响应质量评估器
 * 对云端响应进行自动质量评分（0-1）
 * 评分维度：完整性、相关性、家庭风格
 */

const axios = require('axios');

const LOCAL_MODEL_URL = process.env.LOCAL_MODEL_URL || 'http://localhost:11434/v1/chat/completions';
const LOCAL_MODEL_NAME = process.env.LOCAL_MODEL_NAME || 'homeai-assistant';

/**
 * 使用规则+本地模型混合评分
 */
async function evaluate(request, response, role = 'lucas') {
  // 1. 基础规则评分（快速，不依赖模型）
  const ruleScore = ruleBasedScore(request, response);

  // 2. 尝试本地模型评分（更准确，可能失败）
  let modelScore = null;
  try {
    modelScore = await modelBasedScore(request, response);
  } catch (e) {
    // 本地模型不可用时仅用规则评分
  }

  // 3. 人格检查（Lucas 专属：禁止技术词汇）
  const { penalty, violations } = personaCheck(role, response);

  const baseScore = modelScore !== null
    ? (ruleScore * 0.4 + modelScore * 0.6)
    : ruleScore;

  return {
    score: Math.min(1, Math.max(0, baseScore - penalty)),
    ruleScore,
    modelScore,
    personaViolations: violations,
    method: modelScore !== null ? 'hybrid' : 'rule_only'
  };
}

// Lucas 回复中禁止出现的技术词汇（属于 Andy/Lisa 内部语言）
const LUCAS_FORBIDDEN_TERMS = [
  '流水线', '技术栈', 'SE Step', '领域建模', '需求分析', '风险评估',
  '实现规格', '模块设计', '交付文件', 'JSON', 'Node.js', 'npm',
  'axios', 'Express', 'ChromaDB', 'webpack', 'API接口', '数据库表'
];

/**
 * Lucas 人格检查：检测回复是否包含不该说的技术词汇
 * 返回 { penalty: 0-0.5, violations: string[] }
 */
function personaCheck(role, response) {
  if (role !== 'lucas') return { penalty: 0, violations: [] };

  const violations = LUCAS_FORBIDDEN_TERMS.filter(term => response.includes(term));
  if (violations.length === 0) return { penalty: 0, violations: [] };

  // 每个违规词扣 0.1，最多扣 0.5
  const penalty = Math.min(0.5, violations.length * 0.1);
  return { penalty, violations };
}

/**
 * 规则评分（0-1）
 */
function ruleBasedScore(request, response) {
  if (!response || response.length < 10) return 0;

  let score = 0;

  // 响应长度合理（50-2000字为佳）
  const len = response.length;
  if (len >= 50 && len <= 2000) score += 0.3;
  else if (len > 10) score += 0.1;

  // 包含中文（说明模型理解了语言）
  if (/[\u4e00-\u9fa5]/.test(response)) score += 0.2;

  // 响应与请求有关联（简单关键词重叠）
  const reqWords = request.replace(/[^\u4e00-\u9fa5a-zA-Z]/g, ' ').split(/\s+/).filter(w => w.length > 1);
  const overlapCount = reqWords.filter(w => response.includes(w)).length;
  if (reqWords.length > 0) {
    score += Math.min(0.3, (overlapCount / reqWords.length) * 0.3);
  }

  // 没有明显错误标志
  const errorPatterns = ['error', 'Error', '错误', '无法', '抱歉，我不'];
  if (!errorPatterns.some(p => response.startsWith(p))) score += 0.2;

  return Math.min(1, score);
}

/**
 * 本地模型评分
 */
async function modelBasedScore(request, response) {
  const prompt = `请对以下AI响应质量打分（0-10分，只输出数字）：
请求：${request.substring(0, 200)}
响应：${response.substring(0, 500)}
评分标准：相关性、完整性、自然度
分数：`;

  const resp = await axios.post(LOCAL_MODEL_URL, {
    model: LOCAL_MODEL_NAME,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: 5
  }, {
    headers: { Authorization: 'Bearer ollama' },
    timeout: 8000
  });

  const text = resp.data.choices?.[0]?.message?.content || '';
  const match = text.match(/\d+(\.\d+)?/);
  if (!match) return null;

  const score10 = parseFloat(match[0]);
  return Math.min(1, score10 / 10);
}

module.exports = { evaluate, personaCheck };
