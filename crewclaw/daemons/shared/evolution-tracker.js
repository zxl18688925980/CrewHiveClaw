/**
 * evolution-tracker.js - 执行轨迹追踪器
 * 将三守护进程的结构化执行记录存入 ChromaDB，供反思引擎分析
 *
 * 使用方式（各守护进程）：
 *   const { evolutionTracker } = require('../shared/evolution-tracker');
 *   await evolutionTracker.track({ role: 'lucas', type: 'intent', ... });
 */

const { v4: uuidv4 } = require('uuid');

let ChromaClient, OllamaEmbeddingFunction;
try { ({ ChromaClient, OllamaEmbeddingFunction } = require('chromadb')); } catch (_) {}

const CHROMA_URL  = process.env.CHROMADB_URL || 'http://localhost:8000';
const COLLECTION  = 'evolution_traces';
const BUFFER_MAX  = 500;

class EvolutionTracker {
  constructor() {
    this.client      = null;
    this.collection  = null;
    this.initialized = false;
    this.buffer      = []; // ChromaDB 不可用时的内存缓冲
  }

  async initialize() {
    if (!ChromaClient) {
      console.warn('[evolution-tracker] chromadb 未安装，使用内存模式');
      return;
    }
    try {
      this.client = new ChromaClient({ path: CHROMA_URL });
      await this.client.heartbeat();
      const embedFn = new OllamaEmbeddingFunction({
        url:   `${process.env.LOCAL_MODEL_URL || 'http://localhost:11434'}/api/embeddings`,
        model: 'nomic-embed-text',
      });
      this.collection = await this.client.getOrCreateCollection({
        name: COLLECTION,
        embeddingFunction: embedFn,
      });
      this.initialized = true;
      // 刷新缓冲
      if (this.buffer.length > 0) {
        const toFlush = this.buffer.splice(0);
        for (const entry of toFlush) await this._persist(entry).catch(() => {});
        console.log(`[evolution-tracker] 已刷新 ${toFlush.length} 条缓冲轨迹`);
      }
      console.log('[evolution-tracker] ChromaDB 已连接，evolution_traces 就绪');
    } catch (e) {
      console.warn('[evolution-tracker] ChromaDB 连接失败，使用内存缓冲:', e.message);
    }
  }

  /**
   * 记录一条执行轨迹
   *
   * 通用字段：
   *   role        'lucas' | 'andy' | 'lisa'
   *   type        'intent' | 'chat' | 'design_step' | 'implement' | 'route'
   *   success     boolean
   *   durationMs  number
   *   isCloud     boolean
   *   modelUsed   string
   *
   * Lucas 专属：
   *   intentType  string    意图类型
   *   method      string    'keyword' | 'model' | 'length' | 'fallback'
   *   confidence  number
   *   routedTo    string    'andy' | 'lisa' | 'chat' | 'tool'
   *
   * Andy 专属：
   *   stepName    string    SE 步骤名（'需求分析' 等）
   *   stepNo      number
   *   jsonParsed  boolean   是否成功解析 JSON
   *
   * Lisa 专属：
   *   codeLength  number
   *   savedPath   string
   */
  async track(entry) {
    const record = {
      id:        uuidv4(),
      timestamp: new Date().toISOString(),
      success:   true,
      ...entry
    };

    if (this.initialized) {
      await this._persist(record);
    } else {
      this.buffer.push(record);
      if (this.buffer.length > BUFFER_MAX) this.buffer.shift();
    }
    return record.id;
  }

  async _persist(record) {
    try {
      await this.collection.add({
        ids:       [record.id],
        documents: [JSON.stringify(record)],
        metadatas: [{
          role:      record.role      || 'unknown',
          type:      record.type      || 'unknown',
          success:   String(record.success ?? true),
          isCloud:   String(record.isCloud ?? false),
          timestamp: record.timestamp
        }]
      });
    } catch (e) {
      console.warn('[evolution-tracker] 持久化失败:', e.message);
    }
  }

  /**
   * 查询指定角色的近期轨迹
   * @param {string|null} role  null = 查全部
   * @param {number} limit
   */
  async query(role, limit = 100) {
    if (!this.initialized) {
      const buf = role ? this.buffer.filter(e => e.role === role) : this.buffer;
      return buf.slice(-limit);
    }
    try {
      const params = { limit };
      if (role) params.where = { role };
      const results = await this.collection.get(params);
      return (results.documents || [])
        .map(d => { try { return JSON.parse(d); } catch { return null; } })
        .filter(Boolean);
    } catch (e) {
      console.warn('[evolution-tracker] 查询失败:', e.message);
      return [];
    }
  }

  /**
   * 统计聚合指标，供反思引擎使用
   * @param {string} role
   */
  async getStats(role) {
    const traces = await this.query(role, 200);
    if (!traces.length) return null;

    const total        = traces.length;
    const cloudCount   = traces.filter(t => t.isCloud === true || t.isCloud === 'true').length;
    const successCount = traces.filter(t => t.success !== false && t.success !== 'false').length;
    const durations    = traces.map(t => t.durationMs || 0).filter(v => v > 0);
    const avgDuration  = durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0;

    // Andy 专属：各步骤 JSON 解析率
    const stepStats = {};
    for (const t of traces.filter(t2 => t2.type === 'design_step' && t2.stepName)) {
      if (!stepStats[t.stepName]) stepStats[t.stepName] = { total: 0, jsonParsed: 0 };
      stepStats[t.stepName].total++;
      if (t.jsonParsed) stepStats[t.stepName].jsonParsed++;
    }

    // Lucas 专属：意图识别方法分布
    const intentMethods = {};
    for (const t of traces.filter(t2 => t2.type === 'intent' && t2.method)) {
      intentMethods[t.method] = (intentMethods[t.method] || 0) + 1;
    }

    return {
      role,
      total,
      cloudRatio:   (total > 0 ? cloudCount   / total * 100 : 0).toFixed(1) + '%',
      successRate:  (total > 0 ? successCount / total * 100 : 0).toFixed(1) + '%',
      avgDurationMs: avgDuration,
      stepStats,
      intentMethods
    };
  }

  /**
   * 获取内存缓冲中的轨迹数（调试用）
   */
  getBufferSize() {
    return this.buffer.length;
  }
}

const evolutionTracker = new EvolutionTracker();
module.exports = { evolutionTracker };
