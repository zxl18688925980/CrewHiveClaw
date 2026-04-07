/**
 * 家庭开发需求追踪器
 *
 * 生命周期：
 *   discovered  — Lucas 收到开发意图，尚未确认
 *   confirmed   — 用户补充说明/无需澄清，准备分发
 *   designing   — 已交给 Andy/Lisa，正在处理
 *   delivered   — Andy/Lisa 返回结果，已推给用户，等待反馈
 *   validated   — 用户给出正面反馈，视为交付成功
 *   failed      — 处理失败或用户否定
 *
 * 存储：JSON 文件，路径 daemons/data/requirements/
 * 同 task-store.js 的模式，重启后自动恢复。
 */

const fs   = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const DATA_DIR = path.join(__dirname, '../data/requirements');

const STATUS = {
  DISCOVERED:  'discovered',
  CONFIRMED:   'confirmed',
  DESIGNING:   'designing',
  DELIVERED:   'delivered',
  VALIDATED:   'validated',
  FAILED:      'failed',
};

// 正面反馈关键词（中英文混合）
const POSITIVE_KEYWORDS = [
  '好的', '谢谢', '感谢', '完美', '不错', '太好了', '太棒了',
  '赞', '收到', '可以', '没问题', '测试通过', '成功了', '好用',
  '👍', 'ok', 'OK', 'yes', '正好', '就是这个', '完全正确',
];

// 负面反馈关键词
const NEGATIVE_KEYWORDS = [
  '不对', '有问题', '不好用', '错了', '再改', '帮我改',
  '还需要', '不够', '失败了', '没成功', '有 bug', '有bug',
];

class RequirementTracker {
  constructor() {
    this.requirements = new Map();
    this._ensureDir();
    this._loadFromDisk();
  }

  _ensureDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  _loadFromDisk() {
    try {
      const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const data = JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
        this.requirements.set(data.id, data);
      }
      if (this.requirements.size > 0) {
        console.log(`[RequirementTracker] 加载 ${this.requirements.size} 条需求记录`);
      }
    } catch (e) {
      console.log('[RequirementTracker] 加载失败:', e.message);
    }
  }

  _saveToDisk(req) {
    const filePath = path.join(DATA_DIR, `${req.id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(req, null, 2));
  }

  /**
   * 创建需求记录（status: discovered）
   * @param {string} userId
   * @param {string} message    原始需求文字
   * @param {string} intentType 意图分类
   * @param {object} replyTo    企业微信 replyTo（用于后续主动推送）
   * @returns {object} req
   */
  create(userId, message, intentType, replyTo = null) {
    const id = `req_${Date.now()}_${uuidv4().substring(0, 8)}`;
    const req = {
      id,
      userId,
      message: message.substring(0, 500),
      intentType,
      status: STATUS.DISCOVERED,
      replyTo,             // 保存以便后续主动推送
      deliveredResponse: null,
      techResponse: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    this.requirements.set(id, req);
    this._saveToDisk(req);
    return req;
  }

  /**
   * 更新需求状态
   * @param {string} reqId
   * @param {string} status
   * @param {object} extra  额外字段（如 deliveredResponse、error）
   * @returns {object|null}
   */
  updateStatus(reqId, status, extra = {}) {
    const req = this.requirements.get(reqId);
    if (!req) return null;
    Object.assign(req, { status, updatedAt: new Date().toISOString() }, extra);
    this.requirements.set(reqId, req);
    this._saveToDisk(req);
    return req;
  }

  /**
   * 按 ID 获取需求
   */
  get(reqId) {
    return this.requirements.get(reqId) || null;
  }

  /**
   * 获取某用户最近 24 小时内处于 delivered 状态的需求（等待反馈）
   * 返回最新的一条，若无则返回 null
   */
  getPendingFeedback(userId) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    let latest = null;
    for (const req of this.requirements.values()) {
      if (req.userId === userId && req.status === STATUS.DELIVERED) {
        const updatedMs = new Date(req.updatedAt).getTime();
        if (updatedMs > cutoff) {
          if (!latest || updatedMs > new Date(latest.updatedAt).getTime()) {
            latest = req;
          }
        }
      }
    }
    return latest;
  }

  /**
   * 判断一条消息是否是对已交付需求的正面/负面反馈
   * @returns {'positive'|'negative'|null}
   */
  detectFeedback(message) {
    const lower = message.toLowerCase();
    if (POSITIVE_KEYWORDS.some(k => lower.includes(k.toLowerCase()))) return 'positive';
    if (NEGATIVE_KEYWORDS.some(k => lower.includes(k.toLowerCase()))) return 'negative';
    return null;
  }

  /**
   * 获取某用户所有需求
   */
  getByUserId(userId) {
    return Array.from(this.requirements.values())
      .filter(r => r.userId === userId)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  /**
   * 获取所有需求
   */
  getAll() {
    return Array.from(this.requirements.values())
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const all = this.getAll();
    const byStatus = {};
    for (const s of Object.values(STATUS)) byStatus[s] = 0;
    for (const r of all) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    return { total: all.length, byStatus };
  }

  /**
   * 清理超过 N 天的已完结需求（validated / failed）
   */
  cleanup(daysToKeep = 30) {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    let cleaned = 0;
    for (const [id, req] of this.requirements) {
      const terminal = req.status === STATUS.VALIDATED || req.status === STATUS.FAILED;
      if (terminal && new Date(req.updatedAt).getTime() < cutoff) {
        this.requirements.delete(id);
        const filePath = path.join(DATA_DIR, `${id}.json`);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        cleaned++;
      }
    }
    if (cleaned > 0) console.log(`[RequirementTracker] 清理了 ${cleaned} 条过期需求`);
    return cleaned;
  }
}

const requirementTracker = new RequirementTracker();

// 每天清理一次
setInterval(() => requirementTracker.cleanup(30), 24 * 60 * 60 * 1000);

module.exports = { requirementTracker, STATUS };
