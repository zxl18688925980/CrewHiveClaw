/**
 * 记忆系统客户端 - ChromaDB 接口
 * 为三守护进程提供统一的向量记忆存储
 */

let ChromaClient, OllamaEmbeddingFunction;
try {
  ({ ChromaClient, OllamaEmbeddingFunction } = require('chromadb'));
} catch (e) {
  console.warn('[memory-client] chromadb 包未安装，记忆系统不可用');
}

const CHROMA_URL  = process.env.CHROMADB_URL    || 'http://localhost:8000';
const OLLAMA_URL  = process.env.LOCAL_MODEL_URL  || 'http://localhost:11434';
const EMBED_MODEL = 'nomic-embed-text';

class MemoryClient {
  constructor() {
    this.client = null;
    this.collections = {};
    this.initialized = false;
  }

  async initialize() {
    if (!ChromaClient) {
      throw new Error('chromadb 包未安装');
    }

    this.client = new ChromaClient({ path: CHROMA_URL });

    // 测试连接
    await this.client.heartbeat();

    // 使用 Ollama 嵌入函数，避免下载 transformers 模型
    const embedFn = new OllamaEmbeddingFunction({
      url:   `${OLLAMA_URL}/api/embeddings`,
      model: EMBED_MODEL,
    });

    // 初始化三个 collection
    this.collections.family_memory = await this.client.getOrCreateCollection({
      name: 'family_memory',
      embeddingFunction: embedFn,
    });
    this.collections.decisions = await this.client.getOrCreateCollection({
      name: 'decisions',
      embeddingFunction: embedFn,
    });
    this.collections.code_patterns = await this.client.getOrCreateCollection({
      name: 'code_patterns',
      embeddingFunction: embedFn,
    });

    this.initialized = true;
    console.log('[memory-client] ChromaDB 连接成功，collections 已就绪');
  }

  /**
   * 保存对话记录
   */
  async addConversation(userId, role, message) {
    if (!this.initialized) return false;

    try {
      const id = `${userId}_${role}_${Date.now()}`;
      await this.collections.family_memory.add({
        ids: [id],
        documents: [message],
        metadatas: [{ userId, role, timestamp: new Date().toISOString() }]
      });
      return true;
    } catch (e) {
      console.warn('[memory-client] addConversation 失败:', e.message);
      return false;
    }
  }

  /**
   * 检索相关历史对话
   */
  async queryConversations(userId, queryText, topK = 5) {
    if (!this.initialized) return [];

    try {
      const results = await this.collections.family_memory.query({
        queryTexts: [queryText],
        nResults: topK,
        where: { userId }
      });
      return results.documents?.[0] || [];
    } catch (e) {
      console.warn('[memory-client] queryConversations 失败:', e.message);
      return [];
    }
  }

  /**
   * 保存决策记录 (Andy 使用)
   */
  async addDecision(decisionId, requirement, design, rationale) {
    if (!this.initialized) return false;

    try {
      await this.collections.decisions.add({
        ids: [decisionId],
        documents: [design],
        metadatas: [{
          requirement: requirement.substring(0, 500),
          rationale: (rationale || '').substring(0, 500),
          timestamp: new Date().toISOString()
        }]
      });
      return true;
    } catch (e) {
      console.warn('[memory-client] addDecision 失败:', e.message);
      return false;
    }
  }
}

const memoryClient = new MemoryClient();

module.exports = { memoryClient };
