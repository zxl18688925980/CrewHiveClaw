/**
 * 交互学习引擎 - 高级版核心
 * 每次云端路由后自动触发：评估质量 → 筛选样本 → 记录指标
 *
 * 使用方式：在模型路由成功后调用 learn()
 */

const fs = require('fs').promises;
const path = require('path');
const qualityEvaluator = require('./quality-evaluator');
const sampleCurator = require('./sample-curator');
const routeMetrics = require('./route-metrics');

const ROUTE_EVENTS_FILE = path.join(__dirname, '../../../data/learning/route-events.jsonl');
const FEEDBACK_FILE     = path.join(__dirname, '../../../data/learning/feedback.jsonl');

/**
 * 主入口：记录一次路由事件并执行学习
 * @param {object} params
 *   - request:   用户请求内容
 *   - response:  模型响应内容
 *   - isCloud:   是否为云端路由
 *   - modelUsed: 使用的模型名
 *   - latencyMs: 响应延迟（毫秒）
 *   - domain:    领域标签（chat/code/architecture）
 *   - role:      角色标识（lucas/andy/lisa），决定语料归属
 */
async function learn({ request, response, isCloud, modelUsed, latencyMs = 0, domain = 'chat', role = 'lucas' }) {
  const eventId = `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

  // 1. 记录路由事件（含 role 字段）
  const event = {
    id: eventId,
    timestamp: new Date().toISOString(),
    role,
    request: request.substring(0, 500),
    response: response.substring(0, 1000),
    isCloud,
    modelUsed,
    latencyMs,
    domain
  };

  await appendEvent(event);

  let qualityResult = null;
  let curateResult = null;

  // 2. 云端路由才需要学习（本地路由无需采样）
  if (isCloud && response) {
    try {
      // 质量评估（传入 role，Lucas 会额外做人格检查）
      qualityResult = await qualityEvaluator.evaluate(request, response, role);
      event.quality = qualityResult;

      // 人格漂移：Lucas 回复包含技术词汇 → 自动生成负例，不等用户标记
      if (role === 'lucas' && qualityResult.personaViolations?.length > 0) {
        event.personaViolations = qualityResult.personaViolations;
        await sampleCurator.curateNegative({
          prompt:       request,
          badResponse:  response,
          goodResponse: `（Lucas 应用温暖自然的家人口吻回复，不包含技术词汇：${qualityResult.personaViolations.join('、')}）`,
          domain:       'persona',
          role:         'lucas'
        });
        console.warn('[interaction-learner] Lucas 人格漂移，自动生成负例:', qualityResult.personaViolations);
      }

      // 样本策划（传入 role，按角色分流到对应语料库）
      curateResult = await sampleCurator.curate(
        request,
        response,
        qualityResult.score,
        domain,
        role
      );
      event.curated = curateResult.added;
    } catch (e) {
      console.warn('[interaction-learner] 学习流程异常:', e.message);
    }
  }

  // 3. 更新路由指标
  await routeMetrics.recordRoute({
    isCloud,
    confidence: isCloud ? 0.4 : 0.8,  // 粗略置信度
    sampleAdded: curateResult?.added || false
  });

  return {
    eventId,
    isCloud,
    quality: qualityResult?.score,
    sampleAdded: curateResult?.added || false
  };
}

/**
 * 用户反馈入口：👍/👎 写回事件，👎+correction 生成 Lisa 负例/正例对
 * @param {object} params
 *   - eventId:    路由事件 ID
 *   - rating:     'up' | 'down'
 *   - role:       反馈归属角色（lucas/andy/lisa）
 *   - correction: 用户提供的正确回答（可选，仅 rating=down 时有效）
 */
async function feedback({ eventId, rating, role = 'lucas', correction = null }) {
  const record = {
    eventId,
    rating,
    role,
    correction: correction ? correction.substring(0, 2000) : null,
    timestamp: new Date().toISOString()
  };

  // 写入 feedback.jsonl
  try {
    await fs.appendFile(FEEDBACK_FILE, JSON.stringify(record) + '\n', 'utf8');
  } catch (e) {
    console.warn('[interaction-learner] 写入 feedback 失败:', e.message);
  }

  // 👎 + correction → 生成负例/正例对，写入 Lisa 语料（技术修正归 Lisa）
  if (rating === 'down' && correction) {
    // 找原始事件取 request/response
    try {
      const content = await fs.readFile(ROUTE_EVENTS_FILE, 'utf8');
      const original = content.trim().split('\n')
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean)
        .find(e => e.id === eventId);

      if (original) {
        await sampleCurator.curateNegative({
          prompt:      original.request,
          badResponse: original.response,
          goodResponse: correction,
          domain:      original.domain || 'chat',
          role:        original.role || role
        });
      }
    } catch (e) {
      console.warn('[interaction-learner] 负例生成失败:', e.message);
    }
  }

  return { ok: true, eventId, rating };
}

async function appendEvent(event) {
  try {
    await fs.appendFile(ROUTE_EVENTS_FILE, JSON.stringify(event) + '\n', 'utf8');
  } catch (e) {
    console.warn('[interaction-learner] 写入路由事件失败:', e.message);
  }
}

/**
 * 获取最近 N 条路由事件（调试用）
 */
async function getRecentEvents(n = 10) {
  try {
    const content = await fs.readFile(ROUTE_EVENTS_FILE, 'utf8');
    return content.trim().split('\n').filter(Boolean).slice(-n).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

module.exports = { learn, feedback, getRecentEvents };
