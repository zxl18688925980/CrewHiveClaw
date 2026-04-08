/**
 * 简化的知识库实现
 * 使用文件系统作为存储后备，当 ChromaDB 不可用时使用
 */

const fs = require('fs');
const path = require('path');

// 项目根目录
const PROJECT_ROOT = path.resolve(__dirname, '../../');
const DATA_DIR = path.resolve(PROJECT_ROOT, 'data/knowledge');

class SimpleKnowledgeDB {
  constructor() {
    this.collections = {};
  }

  // 确保目录存在
  ensureDir(collectionName) {
    const dir = path.join(DATA_DIR, collectionName);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  // 获取或创建集合
  async getOrCreateCollection(name, metadata = {}) {
    this.ensureDir(name);

    const collection = {
      name,
      metadata,
      dir: path.join(DATA_DIR, name)
    };

    this.collections[name] = collection;
    console.log(`✅ 集合 ${name} 已创建/获取`);

    return collection;
  }

  // 添加文档
  async add(collectionName, documents, ids, metadatas = []) {
    const collection = this.collections[collectionName];
    if (!collection) {
      throw new Error(`集合 ${collectionName} 不存在`);
    }

    const dir = collection.dir;

    for (let i = 0; i < documents.length; i++) {
      const docPath = path.join(dir, `${ids[i]}.json`);
      const doc = {
        id: ids[i],
        document: documents[i],
        metadata: metadatas[i] || {},
        createdAt: new Date().toISOString()
      };
      fs.writeFileSync(docPath, JSON.stringify(doc, null, 2));
    }

    return { added: documents.length };
  }

  // 查询文档
  async query(collectionName, queryTexts, nResults = 5) {
    const collection = this.collections[collectionName];
    if (!collection) {
      return { ids: [[]], documents: [[]], metadatas: [[]], distances: [[]] };
    }

    const dir = collection.dir;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

    const results = [];

    for (const file of files) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      const doc = JSON.parse(content);

      // 简单的文本匹配评分
      let score = 0;
      for (const query of queryTexts) {
        if (doc.document.toLowerCase().includes(query.toLowerCase())) {
          score += 1;
        }
      }

      results.push({
        id: doc.id,
        document: doc.document,
        metadata: doc.metadata,
        score
      });
    }

    // 按评分排序
    results.sort((a, b) => b.score - a.score);

    // 返回top N结果
    const topResults = results.slice(0, nResults);

    return {
      ids: [topResults.map(r => r.id)],
      documents: [topResults.map(r => r.document)],
      metadatas: [topResults.map(r => r.metadata)],
      distances: [topResults.map(r => 1 - r.score)]  // 距离 = 1 - 分数
    };
  }

  // 获取集合中的文档数量
  async count(collectionName) {
    const collection = this.collections[collectionName];
    if (!collection) return 0;

    const dir = collection.dir;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    return files.length;
  }

  // 列出所有文档
  async get(collectionName, limit = 100) {
    const collection = this.collections[collectionName];
    if (!collection) return [];

    const dir = collection.dir;
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));

    const results = [];
    for (const file of files.slice(0, limit)) {
      const content = fs.readFileSync(path.join(dir, file), 'utf8');
      results.push(JSON.parse(content));
    }

    return results;
  }
}

// 导出单例
const knowledgeDB = new SimpleKnowledgeDB();

module.exports = knowledgeDB;
