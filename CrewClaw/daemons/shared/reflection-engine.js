/**
 * reflection-engine.js - 反思引擎
 * 定期扫描 evolution_traces，生成改进假设，
 * 自动投递给 Andy（/api/dev/task），触发 Andy→Lisa 流水线改进守护进程自身代码。
 *
 * 触发条件：每 50 次请求 OR 每 24 小时（取先到者）
 * 投递策略：high → 立即投递；medium → 距上次 3 天后再投；info/system → 不投
 * 去重机制：dispatched-proposals.jsonl 记录已投递指纹 + 时间戳
 */

const fs   = require('fs').promises;
const path = require('path');
const http = require('http');

const { evolutionTracker } = require('./evolution-tracker');

const ROUTE_EVENTS_FILE = path.join(__dirname, '../../../data/learning/route-events.jsonl');

const DISPATCHED_FILE = path.join(__dirname, '../../../data/learning/dispatched-proposals.jsonl');
const ANDY_URL        = process.env.ANDY_URL || 'http://localhost:3001';

const TTL_DAYS = { high: 7, medium: 3 };

const REFLECTION_EVERY_N  = 50;
const REFLECTION_EVERY_MS = 24 * 60 * 60 * 1000; // 24h

class ReflectionEngine {
  constructor() {
    this.requestCount      = 0;
    this.lastReflectionTs  = 0;
    this.lastHypotheses    = [];
  }

  /**
   * 每次请求后调用，满足条件时自动触发反思
   * 非阻塞 —— 异常只打日志
   */
  async tick() {
    this.requestCount++;
    const now           = Date.now();
    const enoughRequests = (this.requestCount % REFLECTION_EVERY_N) === 0;
    const enoughTime     = (now - this.lastReflectionTs) > REFLECTION_EVERY_MS;

    if (enoughRequests || enoughTime) {
      this.reflect()
        .then(async h => {
          this.lastHypotheses   = h;
          this.lastReflectionTs = Date.now();
          await this._maybeDispatch(h);
        })
        .catch(e => console.warn('[reflection-engine] 反思失败:', e.message));
    }
  }

  /**
   * 执行一次完整反思，返回假设列表
   * 每条假设可直接作为消息发给 Lucas，触发 Andy→Lisa 流水线改进守护进程代码
   */
  async reflect() {
    const [lucasStats, andyStats, lisaStats] = await Promise.all([
      evolutionTracker.getStats('lucas'),
      evolutionTracker.getStats('andy'),
      evolutionTracker.getStats('lisa')
    ]);

    const hypotheses = [];

    // ── Lucas：人格漂移检查（技术词汇出现率）────────────────────
    try {
      const raw = await fs.readFile(ROUTE_EVENTS_FILE, 'utf8');
      const recentLucasEvents = raw.trim().split('\n')
        .filter(Boolean)
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(e => e && e.role === 'lucas')
        .slice(-100); // 最近 100 条 lucas 事件

      if (recentLucasEvents.length >= 5) {
        const driftCount = recentLucasEvents.filter(e => e.personaViolations?.length > 0).length;
        const driftRate  = driftCount / recentLucasEvents.length;

        if (driftRate > 0.1) { // 超过 10% 的回复出现技术词汇
          hypotheses.push({
            role:       'lucas',
            dimension:  '人格一致性-技术词汇漂移',
            metric:     `近 ${recentLucasEvents.length} 条回复中 ${driftCount} 条含技术词汇（漂移率 ${(driftRate * 100).toFixed(0)}%）`,
            hypothesis: 'Lucas 在处理开发类需求后的回复中出现技术词汇，说话方式偏离"家庭成员"定位。'
                      + '根因通常是 forwardToAndy 的 humanize 步骤未能覆盖所有技术词汇，或 prompt 指令不够强。',
            action:     '检查 lucas-daemon/index.js humanizeDevResult() 的 prompt，'
                      + '在禁用词列表中补充近期出现的漂移词汇，并加强"不得包含任何技术术语"的指令约束',
            priority:   driftRate > 0.3 ? 'high' : 'medium'
          });
        }
      }
    } catch (_) {}

    // ── Lucas：意图识别 & 路由 ─────────────────────────────────
    if (lucasStats) {
      const cloudPct   = parseFloat(lucasStats.cloudRatio);
      const successPct = parseFloat(lucasStats.successRate);

      if (cloudPct > 30) {
        hypotheses.push({
          role:       'lucas',
          dimension:  '意图识别-关键词覆盖',
          metric:     `云端路由率 ${lucasStats.cloudRatio}（建议 <30%）`,
          hypothesis: 'Layer 1 关键词命中率低，Layer 2 模型介入过多。'
                    + '建议扩充 INTENT_PATTERNS，或把高频模型分类结果回收为关键词。',
          action:     '优化 lucas-daemon/index.js 的 INTENT_PATTERNS，'
                    + '增加 Layer 1 命中率，减少 Layer 2 调用次数',
          priority:   'high'
        });
      }

      // 意图识别方法分布
      const methods = lucasStats.intentMethods || {};
      const modelCalls = methods['model'] || 0;
      const totalIntents = Object.values(methods).reduce((a, b) => a + b, 0);
      if (totalIntents > 10 && modelCalls / totalIntents > 0.4) {
        hypotheses.push({
          role:       'lucas',
          dimension:  '本地模型利用率',
          metric:     `模型分类调用占比 ${(modelCalls / totalIntents * 100).toFixed(0)}%`,
          hypothesis: '大量意图分类仍走云端，本地 homeai-assistant 可接管这部分。'
                    + '建议将 Layer 2 意图分类切换到本地模型（短 prompt，低延迟）。',
          action:     '在 model-router.js 中为 intent 类型强制 phase=phase2',
          priority:   'medium'
        });
      }

      if (successPct < 90) {
        hypotheses.push({
          role:       'lucas',
          dimension:  '响应成功率',
          metric:     `成功率 ${lucasStats.successRate}`,
          hypothesis: '响应失败率偏高，建议检查云端模型可用性或增加本地降级策略。',
          action:     '检查 _callCloud 错误日志，加强 fallback 逻辑',
          priority:   'high'
        });
      }
    }

    // ── Andy：SE 流水线各步骤 JSON 解析率 ───────────────────────
    if (andyStats?.stepStats) {
      for (const [stepName, s] of Object.entries(andyStats.stepStats)) {
        if (s.total < 3) continue; // 样本太少，不下结论
        const parseRate = Math.round(s.jsonParsed / s.total * 100);
        if (parseRate < 80) {
          hypotheses.push({
            role:       'andy',
            dimension:  `SE流水线-${stepName}`,
            metric:     `JSON解析率 ${parseRate}%（${s.jsonParsed}/${s.total}）`,
            hypothesis: `${stepName} 的模型输出 JSON 格式不稳定，触发 fallback 过多。`
                      + '建议在对应 prompt 中增加 few-shot 示例，或在 extractJSON 中加宽松兼容逻辑。',
            action:     `优化 andy-daemon/index.js 中 ${stepName} 对应函数的 prompt`,
            priority:   'medium'
          });
        }
      }

      if (andyStats.avgDurationMs > 120000) {
        hypotheses.push({
          role:       'andy',
          dimension:  'SE流水线-总耗时',
          metric:     `平均 ${Math.round(andyStats.avgDurationMs / 1000)}s`,
          hypothesis: 'SE 六步流水线总耗时过长，建议评估哪些步骤可并行或简化 prompt 长度。',
          action:     '分析各步骤耗时分布，考虑 Step 2+3 并行，或对简单需求跳过 Step 5',
          priority:   'low'
        });
      }
    }

    // ── Lisa：代码生成 ───────────────────────────────────────────
    if (lisaStats) {
      if (lisaStats.avgDurationMs > 60000) {
        hypotheses.push({
          role:       'lisa',
          dimension:  '代码生成速度',
          metric:     `平均 ${Math.round(lisaStats.avgDurationMs / 1000)}s`,
          hypothesis: '代码生成时间过长，可能 spec 过大或模型上下文溢出。'
                    + '建议对大 spec 拆分为多个子文件分批生成。',
          action:     '在 lisa-daemon/index.js generateCode() 中增加 spec 大小检测和分批逻辑',
          priority:   'low'
        });
      }

      const successPct = parseFloat(lisaStats.successRate);
      if (successPct < 85) {
        hypotheses.push({
          role:       'lisa',
          dimension:  '代码生成成功率',
          metric:     `成功率 ${lisaStats.successRate}`,
          hypothesis: '代码生成失败率偏高，建议增加重试机制和错误日志分析。',
          action:     '在 lisa-daemon/index.js 中增加生成失败重试（最多 2 次），记录失败 spec 特征',
          priority:   'medium'
        });
      }
    }

    // 无假设时返回健康摘要
    if (hypotheses.length === 0) {
      const totalTraces = (lucasStats?.total || 0) + (andyStats?.total || 0) + (lisaStats?.total || 0);
      hypotheses.push({
        role:      'system',
        dimension: '整体健康',
        metric:    `已分析 ${totalTraces} 条执行轨迹`,
        hypothesis:'系统运行正常，暂无明显改进点',
        action:    '继续积累轨迹数据',
        priority:  'info'
      });
    }

    console.log(`[reflection-engine] 反思完成，生成 ${hypotheses.length} 条假设`);
    return hypotheses;
  }

  /**
   * 获取上次反思的假设列表（供 API 查询）
   */
  getLastHypotheses() {
    return this.lastHypotheses;
  }

  /**
   * 立即执行一次反思并返回结果（供调试/API 调用）
   */
  async forceReflect() {
    const result = await this.reflect();
    this.lastHypotheses   = result;
    this.lastReflectionTs = Date.now();
    await this._maybeDispatch(result);
    return result;
  }

  // ── 投递逻辑 ──────────────────────────────────────────────────────────────

  /**
   * 按优先级过滤假设，跳过已近期投递的，其余逐条发给 Andy
   */
  async _maybeDispatch(hypotheses) {
    for (const h of hypotheses) {
      if (h.priority === 'info' || h.role === 'system') continue;
      const ttlDays = TTL_DAYS[h.priority];
      if (!ttlDays) continue; // 未知优先级，跳过

      const fp = `${h.role}:${h.dimension}`;
      const recentlyDispatched = await this._hasRecentlyDispatched(fp, ttlDays);
      if (recentlyDispatched) continue;

      await this._dispatchToAndy(h);
      await this._markDispatched(fp, h);
    }
  }

  /**
   * 检查某指纹在 ttlDays 内是否已投递过
   */
  async _hasRecentlyDispatched(fingerprint, ttlDays) {
    try {
      const raw = await fs.readFile(DISPATCHED_FILE, 'utf8');
      const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
      for (const line of raw.trim().split('\n')) {
        if (!line) continue;
        try {
          const rec = JSON.parse(line);
          if (rec.fingerprint === fingerprint && rec.dispatchedAt > cutoff) return true;
        } catch (_) {}
      }
    } catch (_) {}
    return false;
  }

  /**
   * 将指纹写入去重文件
   */
  async _markDispatched(fingerprint, hypothesis) {
    const rec = { fingerprint, dispatchedAt: Date.now(), role: hypothesis.role, dimension: hypothesis.dimension };
    await fs.mkdir(path.dirname(DISPATCHED_FILE), { recursive: true });
    await fs.appendFile(DISPATCHED_FILE, JSON.stringify(rec) + '\n');
  }

  /**
   * 把假设格式化为需求文本，POST 给 Andy /api/dev/task
   */
  async _dispatchToAndy(h) {
    const message = [
      `【反思引擎自主改进提案】`,
      `角色: ${h.role}  维度: ${h.dimension}`,
      `指标: ${h.metric}`,
      `分析: ${h.hypothesis}`,
      `改进方向: ${h.action}`
    ].join('\n');

    const body = JSON.stringify({
      message,
      userId: 'reflection-engine',
      intent: { type: 'dev_request', source: 'reflection', priority: h.priority }
    });

    return new Promise((resolve) => {
      const req = http.request(
        `${ANDY_URL}/api/dev/task`,
        { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
        (res) => {
          res.resume();
          console.log(`[reflection-engine] 已投递提案给 Andy: ${h.role}/${h.dimension} (HTTP ${res.statusCode})`);
          resolve();
        }
      );
      req.on('error', (e) => {
        console.warn(`[reflection-engine] 投递 Andy 失败: ${e.message}`);
        resolve(); // 非阻塞，失败不影响反思流程
      });
      req.write(body);
      req.end();
    });
  }
}

const reflectionEngine = new ReflectionEngine();
module.exports = { reflectionEngine };
