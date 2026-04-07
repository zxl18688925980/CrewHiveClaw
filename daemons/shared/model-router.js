/**
 * HomeClaw 模型路由器 - Layer 2
 * 根据置信度决定路由到本地模型还是云端模型
 *
 * 所有云端模型均通过环境变量配置，无硬编码：
 *   LUCAS_CLOUD_URL / LUCAS_CLOUD_MODEL / LUCAS_CLOUD_API_KEY
 *   ANDY_CLOUD_URL  / ANDY_CLOUD_MODEL  / ANDY_CLOUD_API_KEY  [/ ANDY_CLOUD_GROUP_ID]
 *   LISA_CLOUD_URL  / LISA_CLOUD_MODEL  / LISA_CLOUD_API_KEY
 *
 * 默认值仅作示例，生产环境请在 .env 中覆盖。
 */

const axios = require('axios');

// 交互学习引擎（异步加载，避免循环依赖）
let interactionLearner = null;
try {
  interactionLearner = require('../homeclaw/learning/interaction-learner');
} catch (e) {
  // 学习引擎不可用时不影响路由
}

const ROUTING_PHASES = {
  PHASE1: 'phase1',  // 以云端为主
  PHASE2: 'phase2',  // 本地/云端均衡
  PHASE3: 'phase3'   // 以本地为主
};

// 置信度阈值：高于此值使用本地，低于使用云端
const CONFIDENCE_THRESHOLD = parseFloat(process.env.ROUTE_CONFIDENCE_THRESHOLD || '0.7');

/**
 * 从环境变量读取各角色云端模型配置
 * 每个角色独立配置，互不影响，可分别指向不同厂商
 */
function getCloudConfig(role) {
  const prefix = role.toUpperCase();
  return {
    url:      process.env[`${prefix}_CLOUD_URL`],
    model:    process.env[`${prefix}_CLOUD_MODEL`],
    apiKey:   process.env[`${prefix}_CLOUD_API_KEY`],
    groupId:  process.env[`${prefix}_CLOUD_GROUP_ID`]  // 部分厂商需要（如 MiniMax）
  };
}

// 本地模型配置
const LOCAL_MODEL = {
  url:   process.env.LOCAL_MODEL_URL   || 'http://localhost:11434/v1/chat/completions',
  model: process.env.LOCAL_MODEL_NAME  || 'homeai-assistant'
};

class ModelRouter {
  constructor() {
    this.config = {
      phase: ROUTING_PHASES.PHASE2, // homeai-assistant 已就绪，默认本地优先
      finetuneRound: 0,
      threshold: CONFIDENCE_THRESHOLD
    };
    this.stats = {
      totalRequests: 0,
      localRequests: 0,
      cloudRequests: 0,
      failedRequests: 0
    };
  }

  setPhase(phase) {
    if (!Object.values(ROUTING_PHASES).includes(phase)) {
      throw new Error(`无效的路由阶段: ${phase}`);
    }
    this.config.phase = phase;
    // phase3 时提高本地路由比例
    if (phase === ROUTING_PHASES.PHASE3) {
      this.config.threshold = 0.5;
    } else if (phase === ROUTING_PHASES.PHASE1) {
      this.config.threshold = 0.7;
    }
  }

  setFinetuneRound(round) {
    this.config.finetuneRound = round;
    // 每完成一轮微调，降低阈值（更多本地路由）
    if (round >= 3) this.setPhase(ROUTING_PHASES.PHASE3);
    else if (round >= 1) this.setPhase(ROUTING_PHASES.PHASE2);
  }

  getStats() {
    const cloudRatio = this.stats.totalRequests > 0
      ? (this.stats.cloudRequests / this.stats.totalRequests * 100).toFixed(1)
      : 0;
    return {
      ...this.stats,
      cloudRatio: `${cloudRatio}%`,
      phase: this.config.phase,
      threshold: this.config.threshold,
      finetuneRound: this.config.finetuneRound
    };
  }

  /**
   * routeToAgent: 兼容旧接口，返回 agentId 和路由信息
   * 用于需要知道路由决策但实际调用由调用方处理的场景
   */
  routeToAgent(intentType, isComplex = false) {
    this.stats.totalRequests++;

    // 复杂任务或 phase1 时倾向云端
    const useCloud = isComplex || this.config.phase === ROUTING_PHASES.PHASE1;

    if (useCloud) {
      this.stats.cloudRequests++;
      const cloudModel = process.env.LUCAS_CLOUD_MODEL || '(未配置)';
      return {
        agentId: 'lucas-cloud',
        isCloud: true,
        modelUsed: `cloud:${cloudModel}`,
        reasoning: `isComplex=${isComplex}, phase=${this.config.phase}`
      };
    } else {
      this.stats.localRequests++;
      return {
        agentId: 'lucas-local',
        isCloud: false,
        modelUsed: `local:${LOCAL_MODEL.model}`,
        reasoning: `phase=${this.config.phase}, threshold=${this.config.threshold}`
      };
    }
  }

  /**
   * routeWithMessages: 直接调用模型并返回响应（传入结构化 messages 数组）
   * 适用于已有 system/user/assistant 多轮上下文的场景（对话历史等）
   * role: 'lucas' | 'andy' | 'lisa'
   */
  async routeWithMessages(messages, type = 'chat', role = 'lucas', options = {}) {
    this.stats.totalRequests++;

    const timeoutMs = options.timeoutMs || 60000;

    if (this.config.phase !== ROUTING_PHASES.PHASE1) {
      try {
        const response = await this._callLocal(messages, timeoutMs);
        this.stats.localRequests++;
        return {
          response,
          modelUsed: `local:${LOCAL_MODEL.model}`,
          confidence: 0.8,
          isCloud: false
        };
      } catch (e) {
        console.warn('[model-router] 本地模型失败，回退云端:', e.message);
      }
    }

    try {
      const startTs = Date.now();
      const response = await this._callCloud(messages, role, timeoutMs);
      const latencyMs = Date.now() - startTs;
      this.stats.cloudRequests++;

      const result = {
        response,
        modelUsed: `cloud:${process.env[`${role.toUpperCase()}_CLOUD_MODEL`] || 'unknown'}`,
        confidence: 0.5,
        isCloud: true
      };

      if (interactionLearner) {
        const reqText = messages[messages.length - 1]?.content || '';
        interactionLearner.learn({
          request: reqText,
          response,
          isCloud: true,
          modelUsed: result.modelUsed,
          latencyMs,
          domain: type || 'chat',
          role: role || 'lucas'
        }).catch(e => console.warn('[model-router] 学习引擎异常:', e.message));
      }

      return result;
    } catch (e) {
      this.stats.failedRequests++;
      console.error('[model-router] 云端模型失败:', e.message);
      throw e;
    }
  }

  /**
   * route: 直接调用模型并返回响应（传入单条 prompt 字符串）
   * role: 'lucas' | 'andy' | 'lisa' (决定使用哪个云端模型)
   * options.timeoutMs: 超时毫秒数（默认 60000，架构设计类建议 90000）
   */
  async route(prompt, type = 'chat', role = 'lucas', options = {}) {
    this.stats.totalRequests++;

    const timeoutMs = options.timeoutMs || 60000;
    const messages = [{ role: 'user', content: prompt }];

    // 先尝试本地
    if (this.config.phase !== ROUTING_PHASES.PHASE1) {
      try {
        const response = await this._callLocal(messages, timeoutMs);
        this.stats.localRequests++;
        return {
          response,
          modelUsed: `local:${LOCAL_MODEL.model}`,
          confidence: 0.8,
          isCloud: false
        };
      } catch (e) {
        console.warn('[model-router] 本地模型失败，回退云端:', e.message);
      }
    }

    // 调用云端
    try {
      const startTs = Date.now();
      const response = await this._callCloud(messages, role, timeoutMs);
      const latencyMs = Date.now() - startTs;
      this.stats.cloudRequests++;

      const result = {
        response,
        modelUsed: `cloud:${process.env[`${role.toUpperCase()}_CLOUD_MODEL`] || 'unknown'}`,
        confidence: 0.5,
        isCloud: true
      };

      // 异步触发交互学习（不阻塞响应）
      if (interactionLearner) {
        const reqText = messages[messages.length - 1]?.content || '';
        interactionLearner.learn({
          request: reqText,
          response,
          isCloud: true,
          modelUsed: result.modelUsed,
          latencyMs,
          domain: type || 'chat',
          role: role || 'lucas'   // 透传角色，样本按角色分流到对应语料库
        }).catch(e => console.warn('[model-router] 学习引擎异常:', e.message));
      }

      return result;
    } catch (e) {
      this.stats.failedRequests++;
      console.error('[model-router] 云端模型失败:', e.message);
      throw e;
    }
  }

  async _callLocal(messages, timeoutMs = 60000) {
    const resp = await axios.post(LOCAL_MODEL.url, {
      model: LOCAL_MODEL.model,
      messages,
      stream: false,
      stop: ['<|im_end|>']  // Qwen2.5 ChatML stop token，防止模板 token 泄漏到输出
    }, {
      headers: { Authorization: 'Bearer ollama' },
      timeout: timeoutMs
    });
    return resp.data.choices?.[0]?.message?.content || '';
  }

  async _callCloud(messages, role = 'lucas', timeoutMs = 60000) {
    const config = getCloudConfig(role);

    if (!config.url)    throw new Error(`${role.toUpperCase()}_CLOUD_URL 未配置`);
    if (!config.model)  throw new Error(`${role.toUpperCase()}_CLOUD_MODEL 未配置`);
    if (!config.apiKey) throw new Error(`${role.toUpperCase()}_CLOUD_API_KEY 未配置`);

    // 如果配置了 GROUP_ID（MiniMax 等需要），拼入 query string
    const url = config.groupId
      ? `${config.url}?GroupId=${config.groupId}`
      : config.url;

    const resp = await axios.post(url, {
      model: config.model,
      messages
    }, {
      headers: { Authorization: `Bearer ${config.apiKey}` },
      timeout: timeoutMs
    });
    return resp.data.choices?.[0]?.message?.content || '';
  }
}

const modelRouter = new ModelRouter();

module.exports = { modelRouter, ROUTING_PHASES };
