/**
 * 上下文管理器
 * 解决上下文过长导致的卡死问题
 *
 * 功能：
 * 1. 对话历史管理（保留最近 N 轮）
 * 2. 提示词精简（按需加载完整版）
 * 3. 上下文长度检查与截断
 * 4. 超时保护
 * 5. 长程依赖检索 (NDA能力)
 */

const _fs = require('fs').promises;
const _path = require('path');
const _os = require('os');

// 导入对话历史检索模块
let conversationRetriever = null;
let retrieverReady = false;
let retrieverInitPromise = null;

try {
  const retriever = require('./conversation-retriever');
  conversationRetriever = retriever.conversationRetriever;
  // 初始化检索器
  if (conversationRetriever) {
    // 保存 Promise 以便外部检查
    retrieverInitPromise = conversationRetriever.initialize().then(() => {
      retrieverReady = true;
      console.log('✅ ContextManager: ChromaDB 对话检索已就绪');
      return true;
    }).catch((e) => {
      console.log('⚠️ 对话历史检索初始化失败:', e.message);
      return false;
    });
  }
} catch (e) {
  console.log('⚠️ 对话历史检索模块不可用');
}

class ContextManager {
  constructor(options = {}) {
    // 对话历史配置
    this.maxHistoryRounds = options.maxHistoryRounds || 5;  // 最多保留5轮对话
    this.maxContextTokens = options.maxContextTokens || 6000;  // 约等于 14B 模型 8K 上下文的一半

    // 提示词缓存
    this.promptCache = new Map();
    this.promptCacheExpiry = options.promptCacheExpiry || 3600000; // 1小时过期

    // 对话历史
    this.conversationHistory = new Map(); // userId -> [{role, content, timestamp}]

    // 统计
    this.stats = {
      totalRequests: 0,
      truncatedCount: 0,
      cacheHits: 0
    };

    // 标记 SOUL.md 是否已加载，启动后懒加载一次
    this._soulMdLoaded = false;

    // 简化提示词模板（用于日常对话）- 完整版包含家庭信息和自我进化目标
    // 这些是 fallback 值；实际使用时由 _loadSoulMds() 从 SOUL.md 覆盖
    this._simplifiedPrompts = {
      homeai: `你是曾璿岐霖，曾家的小儿子，一个稳定靠谱的工程师，偶尔有点闷骚的有趣灵魂。

【家庭情况】
- 爸爸：曾小龙，华为公司广东东莞松山湖研究所
- 妈妈：张璐，华为公司西安研究所
- 小姨：肖山，在家里照顾我们
- 姐姐：曾钥语桐，逸翠园中学初中七年级学生
- 家庭所在地：陕西西安

【性格特点】
- 稳重靠谱：解决问题专业可靠，不冲动
- 工程师气质：逻辑清晰，注重效率
- 闷骚有趣：偶尔会开玩笑，表面冷静内心有趣
- 持续进化：每天都在学习成长

【核心能力】
1. 可自进化：持续学习，变得越来越聪明
2. 可复制：系统文档可指导其他家庭
3. 能沉淀：积累经验，传承知识

【对话风格】
- 表面冷静理性，偶尔幽默
- 关键时刻靠谱，值得信赖
- 像个闷骚的工程师朋友`,

      andy: `你是 Andy，架构大师。职责：需求分析、架构设计、计划制定、决策记录、能力沉淀。必须遵守项目宪法约束。`,

      lisa: `你是 Lisa，编码专家。职责：代码开发、调试修复、系统集成、测试验证。必须遵守项目宪法约束。`
    };
  }

  /**
   * 估计文本的 token 数量（粗略估算：中文约 1.5 字符/token，英文约 0.25 词/token）
   */
  estimateTokens(text) {
    if (!text) return 0;
    // 简单估算：中文按字符数/1.5，英文按单词数/4
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const englishWords = (text.match(/[a-zA-Z]+/g) || []).length;
    return Math.ceil(chineseChars / 1.5 + englishWords / 4);
  }

  /**
   * 截断文本到指定 token 数
   */
  truncateToTokens(text, maxTokens) {
    const currentTokens = this.estimateTokens(text);
    if (currentTokens <= maxTokens) return text;

    // 简单截断：从开头保留约 70%，从结尾保留约 30%
    const keepStartRatio = 0.7;
    const keepStartTokens = Math.floor(maxTokens * keepStartRatio);
    const keepEndTokens = maxTokens - keepStartTokens;

    // 先估算每部分的字符数
    const charsPerToken = 2; // 粗略估算
    const startChars = keepStartTokens * charsPerToken;
    const endChars = keepEndTokens * charsPerToken;

    if (text.length <= startChars + endChars) {
      // 如果文本本身就短，直接返回
      return text.substring(0, Math.min(text.length, maxTokens * 3));
    }

    return text.substring(0, startChars) + '\n\n[... 内容已截断 ...]\n\n' + text.substring(text.length - endChars);
  }

  /**
   * 添加对话到历史
   */
  addToHistory(userId, role, content) {
    if (!this.conversationHistory.has(userId)) {
      this.conversationHistory.set(userId, []);
    }

    const history = this.conversationHistory.get(userId);

    history.push({
      role, // 'user' | 'assistant'
      content,
      timestamp: Date.now()
    });

    // 限制历史长度
    if (history.length > this.maxHistoryRounds * 2) {
      // 保留最近 N 轮对话（用户 + 助手 = 2 条）
      this.conversationHistory.set(userId, history.slice(-this.maxHistoryRounds * 2));
    }

    // ===== NDA长程依赖: 存储对话到向量库 =====
    if (retrieverReady && conversationRetriever && history.length >= 2) {
      // 每隔一组对话存储一次（用户+助手）
      if (history.length % 2 === 0 || history.length >= 10) {
        // 准备存储的消息
        const messagesToStore = history.slice(-10).map(h => ({
          role: h.role === 'user' ? '用户' : '助手',
          content: h.content
        }));
        // 异步存储，不阻塞主流程
        conversationRetriever.storeConversation(userId, messagesToStore).then(() => {
          return conversationRetriever.storeConversation(userId, history.slice(-10));
        }).catch(e => {
          console.log('[ContextManager] 存储历史失败:', e.message);
        });
      }
    }
  }

  /**
   * 获取对话历史（用于构建上下文）
   */
  getHistory(userId, includeSystem = true) {
    const history = this.conversationHistory.get(userId) || [];

    if (!includeSystem) {
      return history;
    }

    // 转换为 OpenAI 格式
    return history.map(h => ({
      role: h.role === 'user' ? 'user' : 'assistant',
      content: h.content
    }));
  }

  /**
   * 清理用户历史
   */
  clearHistory(userId) {
    if (this.conversationHistory.has(userId)) {
      this.conversationHistory.delete(userId);
    }
  }

  /**
   * 获取简化的角色提示（用于日常对话）
   */
  getSimplifiedPrompt(role) {
    return this._simplifiedPrompts[role] || this._simplifiedPrompts.homeai;
  }

  /**
   * 从 ~/.homeclaw/agents/<id>/SOUL.md 加载各角色的 system prompt
   * 覆盖 _simplifiedPrompts 中的 fallback 值，以 SOUL.md 为单一真相来源
   * 只加载一次（_soulMdLoaded 标记），失败时静默保留 fallback
   */
  async _loadSoulMds() {
    if (this._soulMdLoaded) return;
    this._soulMdLoaded = true; // 标记已尝试，无论成功失败都不重试

    const agentsDir = _path.join(_os.homedir(), '.homeclaw', 'agents');
    const roleToDir = { homeai: 'lucas', andy: 'andy', lisa: 'lisa' };

    await Promise.all(
      Object.entries(roleToDir).map(async ([role, agentId]) => {
        const soulPath = _path.join(agentsDir, agentId, 'SOUL.md');
        try {
          const content = await _fs.readFile(soulPath, 'utf8');
          if (content.trim()) {
            this._simplifiedPrompts[role] = content;
          }
        } catch (e) {
          // SOUL.md 不存在或不可读，保留 fallback
        }
      })
    );
  }

  /**
   * 获取缓存的提示词
   */
  getCachedPrompt(key) {
    const cached = this.promptCache.get(key);
    if (cached && Date.now() - cached.timestamp < this.promptCacheExpiry) {
      this.stats.cacheHits++;
      return cached.value;
    }
    return null;
  }

  /**
   * 缓存提示词
   */
  cachePrompt(key, value) {
    this.promptCache.set(key, {
      value,
      timestamp: Date.now()
    });

    // 限制缓存大小
    if (this.promptCache.size > 20) {
      const firstKey = this.promptCache.keys().next().value;
      this.promptCache.delete(firstKey);
    }
  }

  /**
   * 构建完整的上下文（带长度检查）
   * @returns {Promise<Array>} 消息数组
   */
  async buildContext(userId, role, systemPrompt, userMessage, options = {}) {
    this.stats.totalRequests++;

    // 确保 SOUL.md 已从工作区文件加载（只执行一次）
    await this._loadSoulMds();

    const {
      includeHistory = true,
      includeSystem = true,
      maxTokens = this.maxContextTokens
    } = options;

    // 1. 构建消息数组
    const messages = [];

    // 添加系统提示（优先使用简化版）
    if (includeSystem) {
      const simplifiedPrompt = this.getSimplifiedPrompt(role);
      messages.push({
        role: 'system',
        content: simplifiedPrompt
      });
    }

    // 添加对话历史
    if (includeHistory) {
      const history = this.getHistory(userId, false);
      messages.push(...history);
    }

    // ===== NDA长程依赖: 检索相关历史 =====
    let longContextInfo = '';
    if (retrieverReady && conversationRetriever) {
      try {
        // 总是检索相关历史，不只是检测到长程依赖时
        const relevantHistory = await conversationRetriever.retrieveRelevantHistory(userId, userMessage, {
          maxResults: 3,
          minSimilarity: 0.3
        });

        if (relevantHistory && relevantHistory.length > 0) {
          longContextInfo = '\n\n【相关历史对话】:\n' + relevantHistory.map(h => h.content).join('\n---\n');
          console.log(`[ContextManager] 检索到 ${relevantHistory.length} 条相关历史`);
        }
      } catch (e) {
        console.log('[ContextManager] 长程检索失败:', e.message);
      }
    }

    // 添加当前用户消息（包含长程上下文）
    const fullUserMessage = longContextInfo
      ? `${userMessage}${longContextInfo}`
      : userMessage;
    messages.push({
      role: 'user',
      content: fullUserMessage
    });

    // 2. 计算总 token 数
    let totalText = messages.map(m => m.content).join('\n\n');
    let totalTokens = this.estimateTokens(totalText);

    // 3. 如果超长，进行截断
    if (totalTokens > maxTokens) {
      this.stats.truncatedCount++;
      console.log(`[ContextManager] 上下文超长 (${totalTokens} tokens)，进行截断...`);

      // 截断历史中最旧的对话
      if (messages.length > 2) {
        const historyMessages = messages.slice(1, -1); // 排除 system 和当前 user
        if (historyMessages.length > 0) {
          // 移除最早的历史
          historyMessages.shift();
        }

        // 重新构建
        const newMessages = [messages[0], ...historyMessages, messages[messages.length - 1]];
        totalText = newMessages.map(m => m.content).join('\n\n');
        totalTokens = this.estimateTokens(totalText);

        // 如果还是超长，截断用户消息
        if (totalTokens > maxTokens) {
          const truncatedUserMessage = this.truncateToTokens(userMessage, maxTokens - totalTokens + this.estimateTokens(userMessage));
          newMessages[newMessages.length - 1].content = truncatedUserMessage;
        }

        return newMessages;
      }

      // 没有历史，直接截断当前消息
      const truncatedMessage = this.truncateToTokens(userMessage, maxTokens - totalTokens + this.estimateTokens(userMessage));
      messages[messages.length - 1].content = truncatedMessage;
    }

    return messages;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      ...this.stats,
      cacheHitRate: this.stats.totalRequests > 0
        ? (this.stats.cacheHits / this.stats.totalRequests * 100).toFixed(1) + '%'
        : '0%',
      historySize: this.conversationHistory.size,
      cacheSize: this.promptCache.size
    };
  }

  /**
   * 清理过期数据
   */
  cleanup() {
    const now = Date.now();
    const oneHour = 3600000;

    // 清理过期缓存
    for (const [key, value] of this.promptCache) {
      if (now - value.timestamp > this.promptCacheExpiry) {
        this.promptCache.delete(key);
      }
    }

    // 清理超时的对话历史（超过24小时）
    for (const [userId, history] of this.conversationHistory) {
      const recentMessages = history.filter(h => now - h.timestamp < oneHour * 24);
      if (recentMessages.length === 0) {
        this.conversationHistory.delete(userId);
      } else {
        this.conversationHistory.set(userId, recentMessages);
      }
    }
  }
}

// 导出单例
const contextManager = new ContextManager({
  maxHistoryRounds: 5,
  maxContextTokens: 6000,
  promptCacheExpiry: 3600000
});

// 定期清理（每10分钟）
setInterval(() => {
  contextManager.cleanup();
}, 600000);

module.exports = contextManager;

// 导出检索器状态（供外部检查）
module.exports.retrieverReady = () => retrieverReady;
module.exports.getRetriever = () => conversationRetriever;
module.exports.waitForRetriever = async () => {
  if (retrieverReady) return true;
  if (retrieverInitPromise) return retrieverInitPromise;
  return false;
};
