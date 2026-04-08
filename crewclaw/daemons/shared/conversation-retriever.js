/**
 * 对话历史检索模块 (Conversation Retriever)
 * 实现NDA长程依赖能力：从向量数据库检索历史对话
 *
 * 功能：
 * 1. 对话历史向量存储
 * 2. 语义检索相关历史
 * 3. 上下文注入
 */

const { ChromaClient } = require('chromadb');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');

const COLLECTION_NAME = 'conversation_history';

// Ollama 嵌入模型配置
const OLLAMA_EMBED_MODEL = 'nomic-embed-text';
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';

class ConversationRetriever {
  constructor() {
    this.client = null;
    this.collection = null;
    this.initialized = false;
    this.useFileSystem = false;
    this.fileStoragePath = path.join(__dirname, '../data/conversation_history');
    this.useOllamaEmbed = true; // 优先使用 Ollama 嵌入
  }

  /**
   * 初始化
   */
  async initialize() {
    if (this.initialized) return true;

    // 确保目录存在
    if (!fs.existsSync(this.fileStoragePath)) {
      fs.mkdirSync(this.fileStoragePath, { recursive: true });
    }

    // 尝试 ChromaDB
    try {
      this.client = new ChromaClient({
        path: 'http://localhost:8000'
      });

      await this.client.heartbeat();
      this.collection = await this.client.getOrCreateCollection({
        name: COLLECTION_NAME,
        metadata: { description: '对话历史向量存储' }
      });
      this.initialized = true;
      this.useFileSystem = false;
      console.log('✅ 对话历史检索初始化成功 (ChromaDB)');
      return true;
    } catch (error) {
      console.log('⚠️ ChromaDB 不可用，使用文件系统存储');
      this.useFileSystem = true;
      this.initialized = true;
      return true;
    }
  }

  /**
   * 存储对话到历史
   */
  async storeConversation(userId, messages) {
    if (!this.initialized) {
      await this.initialize();
    }

    const conversationId = uuidv4();
    const timestamp = new Date().toISOString();

    if (this.useFileSystem) {
      // 文件系统存储
      const filePath = path.join(this.fileStoragePath, `${conversationId}.json`);
      const data = {
        id: conversationId,
        userId,
        messages,
        timestamp,
        tokens: this.estimateTokens(JSON.stringify(messages))
      };
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
      console.log('[ConversationRetriever] 存储对话到文件系统成功:', conversationId);
      return { id: conversationId, stored: true, method: 'filesystem' };
    }

    // ChromaDB 向量存储
    try {
      // 将对话内容合并为一个字符串
      const content = messages.map(m => `${m.role}: ${m.content}`).join('\n');

      await this.collection.add({
        ids: [conversationId],
        embeddings: [await this.embedText(content)],
        metadatas: [{
          userId,
          timestamp,
          messageCount: messages.length
        }],
        documents: [content]
      });

      console.log('[ConversationRetriever] 存储对话到 ChromaDB 成功:', conversationId);
      return { id: conversationId, stored: true, method: 'chromadb' };
    } catch (error) {
      console.error('存储对话失败，回退到文件系统:', error.message);
      return this.storeConversationFallback(userId, messages);
    }
  }

  /**
   * 检索相关历史对话
   */
  async retrieveRelevantHistory(userId, query, options = {}) {
    const { maxResults = 3, minSimilarity = 0.3 } = options;

    if (!this.initialized) {
      await this.initialize();
    }

    if (this.useFileSystem) {
      return this.retrieveFromFileSystem(userId, query, maxResults);
    }

    try {
      const results = await this.collection.query({
        queryEmbeddings: [await this.embedText(query)],
        nResults: maxResults,
        where: { userId }
      });

      const relevant = [];
      for (let i = 0; i < results.ids[0]?.length; i++) {
        const distance = results.distances[0][i];
        const similarity = 1 - distance; // 转换为相似度

        if (similarity >= minSimilarity) {
          relevant.push({
            id: results.ids[0][i],
            content: results.documents[0][i],
            metadata: results.metadatas[0][i],
            similarity
          });
        }
      }

      return relevant;
    } catch (error) {
      console.error('检索历史失败:', error.message);
      return this.retrieveFromFileSystem(userId, query, maxResults);
    }
  }

  /**
   * 从文件系统检索
   */
  async retrieveFromFileSystem(userId, query, maxResults = 3) {
    const queryLower = query.toLowerCase();
    const files = fs.readdirSync(this.fileStoragePath).filter(f => f.endsWith('.json'));

    const results = [];
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.fileStoragePath, file), 'utf8');
        const data = JSON.parse(content);

        // 过滤用户
        if (data.userId !== userId) continue;

        // 简单关键词匹配
        const contentLower = JSON.stringify(data.messages).toLowerCase();
        let score = 0;
        const queryWords = queryLower.split(/\s+/);
        for (const word of queryWords) {
          if (word.length > 2 && contentLower.includes(word)) {
            score += 1;
          }
        }

        if (score > 0) {
          results.push({
            id: data.id,
            content: JSON.stringify(data.messages),
            metadata: { timestamp: data.timestamp, messageCount: data.messages?.length },
            similarity: score
          });
        }
      } catch (e) {
        // 跳过损坏的文件
      }
    }

    // 按相似度排序
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, maxResults);
  }

  /**
   * 检测是否需要长程检索
   */
  needsLongContextRetrieval(message) {
    const patterns = [
      /接着上次的/i,
      /之前那个/i,
      /之前说的/i,
      /上次我们谈/i,
      /之前提到/i,
      /继续之前/i,
      /刚才那个/i,
      / Earlier /i,
      / before /i,
      / previously /i
    ];

    return patterns.some(p => p.test(message));
  }

  /**
   * 使用 Ollama 生成嵌入向量 (真正的语义嵌入)
   */
  async embedText(text) {
    // 优先使用 Ollama 嵌入
    if (this.useOllamaEmbed) {
      try {
        const response = await fetch(`${OLLAMA_BASE_URL}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: OLLAMA_EMBED_MODEL,
            prompt: text
          })
        });

        if (response.ok) {
          const data = await response.json();
          console.log(`[ConversationRetriever] Ollama 嵌入生成成功 (${data.embedding.length} 维)`);
          return data.embedding;
        } else {
          console.warn(`[ConversationRetriever] Ollama 嵌入失败: ${response.status}，回退到哈希`);
        }
      } catch (e) {
        console.warn(`[ConversationRetriever] Ollama 连接失败: ${e.message}，回退到哈希`);
      }
    }

    // 回退：简单哈希作为占位符（仅用于测试）
    const hash = require('crypto').createHash('sha256');
    const hashResult = hash.update(text).digest();

    // 转换为固定维度的向量
    const dimensions = 384;
    const embedding = [];
    for (let i = 0; i < dimensions; i++) {
      embedding.push((hashResult[i % hashResult.length] / 255) * 2 - 1);
    }
    return embedding;
  }

  /**
   * 估算token数量
   */
  estimateTokens(text) {
    // 简单估算: 中文约1.5字符/token，英文约4字符/token
    const chineseChars = (text.match(/[\u4e00-\u9fa5]/g) || []).length;
    const otherChars = text.length - chineseChars;
    return Math.ceil(chineseChars / 1.5 + otherChars / 4);
  }

  /**
   * 文件系统回退存储
   */
  async storeConversationFallback(userId, messages) {
    const conversationId = uuidv4();
    const filePath = path.join(this.fileStoragePath, `${conversationId}.json`);
    const data = {
      id: conversationId,
      userId,
      messages,
      timestamp: new Date().toISOString()
    };
    fs.writeFileSync(filePath, JSON.stringify(data));
    return { id: conversationId, stored: true, method: 'filesystem-fallback' };
  }

  /**
   * 获取统计信息
   */
  getStats() {
    return {
      initialized: this.initialized,
      useFileSystem: this.useFileSystem,
      method: this.useFileSystem ? 'filesystem' : 'chromadb'
    };
  }
}

// 单例实例
const conversationRetriever = new ConversationRetriever();

module.exports = {
  ConversationRetriever,
  conversationRetriever
};
