/**
 * 知识库工具函数模块
 * 提供需求、决策、约束、假设的增删改查功能
 * 优先使用 ChromaDB，失败时使用文件系统存储
 */

const { ChromaClient } = require('chromadb');
const { v4: uuidv4 } = require('uuid');

// 尝试加载简单知识库作为后备
let simpleKB = null;
let simpleKBLoaded = false;
try {
  simpleKB = require('./simple-knowledge-db');
  simpleKBLoaded = true;
} catch (e) {
  console.log('⚠️ 简单知识库模块不可用');
}

const COLLECTION_NAMES = {
  requirements: 'knowledge_requirements',
  decisions: 'knowledge_decisions',
  constraints: 'knowledge_constraints',
  assumptions: 'knowledge_assumptions'
};

// 需求状态枚举
const REQUIREMENT_STATUS = {
  OPEN: 'open',
  ADDRESSED: 'addressed',
  VERIFIED: 'verified',
  CONFLICT: 'conflict'
};

class KnowledgeBase {
  constructor() {
    this.client = null;
    this.initialized = false;
    this.useSimple = false;
  }

  /**
   * 初始化 ChromaDB 客户端，失败时使用简化模式
   */
  async initialize() {
    if (this.initialized) return true;

    // 尝试 ChromaDB
    try {
      this.client = new ChromaClient({
        path: 'http://localhost:8000'
      });

      await this.client.heartbeat();
      this.initialized = true;
      this.useSimple = false;
      console.log('✅ 知识库客户端初始化成功 (ChromaDB)');
      return true;
    } catch (error) {
      console.log('⚠️ ChromaDB 不可用，使用文件系统存储');
      this.useSimple = true;
      this.initialized = true;

      // 初始化简化模式的集合
      if (simpleKB) {
        for (const [key, name] of Object.entries(COLLECTION_NAMES)) {
          await simpleKB.getOrCreateCollection(name, { type: key });
        }
      }
      return true;
    }
  }

  /**
   * 获取或创建集合
   */
  async ensureCollection(type) {
    const name = COLLECTION_NAMES[type];
    if (!name) {
      throw new Error(`Unknown knowledge type: ${type}`);
    }

    if (this.useSimple) {
      if (simpleKB) {
        return await simpleKB.getOrCreateCollection(name, { type, created_at: new Date().toISOString() });
      }
      throw new Error('简化知识库不可用');
    }

    return await this.client.getOrCreateCollection({
      name,
      metadata: { type, created_at: new Date().toISOString() }
    });
  }

  // ==================== 需求管理 ====================

  /**
   * 添加需求
   */
  async requirement_add(requirement) {
    await this.initialize();

    const id = requirement.id || `req_${uuidv4().substring(0, 8)}`;
    const doc = {
      content: requirement.content,
      priority: requirement.priority || 'should', // must, should, could, wont
      status: requirement.status || REQUIREMENT_STATUS.OPEN,
      source: requirement.source || 'user',
      tags: requirement.tags || [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    if (this.useSimple && simpleKB) {
      await simpleKB.add(
        COLLECTION_NAMES.requirements,
        [JSON.stringify(doc)],
        [id],
        [{
          requirement_id: id,
          content: requirement.content,
          priority: doc.priority,
          status: doc.status,
          source: doc.source,
          tags: doc.tags.join(',')
        }]
      );
    } else {
      const collection = await this.ensureCollection('requirements');
      await collection.add({
        ids: [id],
        documents: [JSON.stringify(doc)],
        metadatas: [{
          requirement_id: id,
          content: requirement.content,
          priority: doc.priority,
          status: doc.status,
          source: doc.source,
          tags: doc.tags.join(','),
          created_at: doc.created_at,
          updated_at: doc.updated_at
        }]
      });
    }

    console.log(`✅ 需求添加成功: ${id}`);
    return { id, ...doc };
  }

  /**
   * 更新需求状态
   */
  async requirement_update(id, updates) {
    await this.initialize();

    // 获取现有需求
    let existingMetadata;
    if (this.useSimple && simpleKB) {
      const results = await simpleKB.get(COLLECTION_NAMES.requirements);
      const found = results.find(r => r.id === id);
      if (!found) {
        throw new Error(`需求不存在: ${id}`);
      }
      existingMetadata = found.metadata;
    } else {
      const collection = await this.ensureCollection('requirements');
      const existing = await collection.get({ ids: [id] });
      if (!existing.ids || existing.ids.length === 0) {
        throw new Error(`需求不存在: ${id}`);
      }
      existingMetadata = existing.metadatas[0];
    }

    const newStatus = updates.status || existingMetadata.status;
    const newContent = updates.content || existingMetadata.content;
    const newPriority = updates.priority || existingMetadata.priority;

    const updatedDoc = {
      content: newContent,
      priority: newPriority,
      status: newStatus,
      source: existingMetadata.source,
      tags: existingMetadata.tags ? existingMetadata.tags.split(',') : [],
      created_at: existingMetadata.created_at,
      updated_at: new Date().toISOString()
    };

    // 更新文档和元数据
    if (this.useSimple && simpleKB) {
      // 简化模式：重新写入
      await simpleKB.add(
        COLLECTION_NAMES.requirements,
        [JSON.stringify(updatedDoc)],
        [id],
        [{
          requirement_id: id,
          content: newContent,
          priority: newPriority,
          status: newStatus,
          source: existingMetadata.source,
          tags: updatedDoc.tags.join(',')
        }]
      );
    } else {
      const collection = await this.ensureCollection('requirements');
      await collection.update({
        ids: [id],
        documents: [JSON.stringify(updatedDoc)],
        metadatas: [{
          requirement_id: id,
          content: newContent,
          priority: newPriority,
          status: newStatus,
          source: existingMetadata.source,
          tags: updatedDoc.tags.join(','),
          created_at: existingMetadata.created_at,
          updated_at: new Date().toISOString()
        }]
      });
    }

    console.log(`✅ 需求更新成功: ${id} -> ${newStatus}`);
    return { id, ...updatedDoc };
  }

  /**
   * 获取需求列表
   */
  async requirement_list(filters = {}) {
    await this.initialize();

    let results;
    if (this.useSimple && simpleKB) {
      results = await simpleKB.get(COLLECTION_NAMES.requirements);
    } else {
      const collection = await this.ensureCollection('requirements');
      results = await collection.get({});
    }

    let requirements;
    if (this.useSimple && simpleKB) {
      requirements = results.map(r => ({
        id: r.id,
        content: r.metadata.content,
        priority: r.metadata.priority,
        status: r.metadata.status,
        source: r.metadata.source,
        tags: r.metadata.tags ? r.metadata.tags.split(',') : [],
        created_at: r.metadata.created_at,
        updated_at: r.metadata.updated_at
      }));
    } else {
      requirements = (results.ids || []).map((id, i) => ({
        id,
        content: results.metadatas[i].content,
        priority: results.metadatas[i].priority,
        status: results.metadatas[i].status,
        source: results.metadatas[i].source,
        tags: results.metadatas[i].tags ? results.metadatas[i].tags.split(',') : [],
        created_at: results.metadatas[i].created_at,
        updated_at: results.metadatas[i].updated_at
      }));
    }

    // 应用过滤
    if (filters.status) {
      requirements = requirements.filter(r => r.status === filters.status);
    }
    if (filters.priority) {
      requirements = requirements.filter(r => r.priority === filters.priority);
    }
    if (filters.source) {
      requirements = requirements.filter(r => r.source === filters.source);
    }

    return requirements;
  }

  /**
   * 搜索需求
   */
  async requirement_search(query, filters = {}) {
    await this.initialize();

    let results;
    if (this.useSimple && simpleKB) {
      results = await simpleKB.query(COLLECTION_NAMES.requirements, [query], filters.limit || 10);
    } else {
      const collection = await this.ensureCollection('requirements');
      results = await collection.query({
        queryTexts: [query],
        nResults: filters.limit || 10
      });
    }

    if (this.useSimple && simpleKB) {
      return results.documents[0].map((doc, i) => ({
        id: results.ids[0][i],
        content: results.metadatas[0][i].content,
        priority: results.metadatas[0][i].priority,
        status: results.metadatas[0][i].status,
        distance: results.distances[0][i]
      }));
    }

    return (results.ids || []).map((id, i) => ({
      id,
      content: results.metadatas[i].content,
      priority: results.metadatas[i].priority,
      status: results.metadatas[i].status,
      distance: results.distances ? results.distances[0][i] : null
    }));
  }

  /**
   * 获取未满足的 must 需求
   */
  async requirement_get_unsatisfied_must() {
    await this.initialize();

    const requirements = await this.requirement_list();
    return requirements.filter(r => r.priority === 'must' && r.status !== REQUIREMENT_STATUS.VERIFIED);
  }

  // ==================== 决策管理 ====================

  /**
   * 添加决策
   */
  async decision_add(decision) {
    await this.initialize();

    const id = decision.id || `dec_${uuidv4().substring(0, 8)}`;
    const metadata = {
      decision_id: id,
      title: decision.title,
      description: decision.description,
      type: decision.type || 'design', // design, technical, implementation
      category: decision.category || 'general',
      related_requirements: decision.related_requirements ? decision.related_requirements.join(',') : '',
      created_at: new Date().toISOString(),
      created_by: decision.created_by || 'system'
    };

    if (this.useSimple && simpleKB) {
      await simpleKB.add(
        COLLECTION_NAMES.decisions,
        [decision.description],
        [id],
        [metadata]
      );
    } else {
      const collection = await this.ensureCollection('decisions');
      await collection.add({
        ids: [id],
        documents: [decision.description],
        metadatas: [metadata]
      });
    }

    console.log(`✅ 决策添加成功: ${id}`);
    return { id, ...decision };
  }

  /**
   * 获取决策列表
   */
  async decision_list(filters = {}) {
    await this.initialize();

    let results;
    if (this.useSimple && simpleKB) {
      results = await simpleKB.get(COLLECTION_NAMES.decisions);
    } else {
      const collection = await this.ensureCollection('decisions');
      results = await collection.get({});
    }

    let decisions;
    if (this.useSimple && simpleKB) {
      decisions = results.map(r => ({
        id: r.id,
        title: r.metadata.title,
        description: r.metadata.description,
        type: r.metadata.type,
        category: r.metadata.category,
        related_requirements: r.metadata.related_requirements ?
          r.metadata.related_requirements.split(',').filter(r => r) : [],
        created_at: r.metadata.created_at,
        created_by: r.metadata.created_by
      }));
    } else {
      decisions = (results.ids || []).map((id, i) => ({
        id,
        title: results.metadatas[i].title,
        description: results.metadatas[i].description,
        type: results.metadatas[i].type,
        category: results.metadatas[i].category,
        related_requirements: results.metadatas[i].related_requirements ?
          results.metadatas[i].related_requirements.split(',').filter(r => r) : [],
        created_at: results.metadatas[i].created_at,
        created_by: results.metadatas[i].created_by
      }));
    }

    // 应用过滤
    if (filters.type) {
      decisions = decisions.filter(d => d.type === filters.type);
    }
    if (filters.category) {
      decisions = decisions.filter(d => d.category === filters.category);
    }

    return decisions;
  }

  /**
   * 搜索决策
   */
  async decision_search(query, filters = {}) {
    await this.initialize();

    let results;
    if (this.useSimple && simpleKB) {
      results = await simpleKB.query(COLLECTION_NAMES.decisions, [query], filters.limit || 10);
    } else {
      const collection = await this.ensureCollection('decisions');
      results = await collection.query({
        queryTexts: [query],
        nResults: filters.limit || 10
      });
    }

    if (this.useSimple && simpleKB) {
      return results.documents[0].map((doc, i) => ({
        id: results.ids[0][i],
        title: results.metadatas[0][i].title,
        description: results.metadatas[0][i].description,
        type: results.metadatas[0][i].type,
        distance: results.distances[0][i]
      }));
    }

    return (results.ids || []).map((id, i) => ({
      id,
      title: results.metadatas[i].title,
      description: results.metadatas[i].description,
      type: results.metadatas[i].type,
      distance: results.distances ? results.distances[0][i] : null
    }));
  }

  // ==================== 约束管理 ====================

  /**
   * 添加约束
   */
  async constraint_add(constraint) {
    await this.initialize();

    const id = constraint.id || `con_${uuidv4().substring(0, 8)}`;
    const metadata = {
      constraint_id: id,
      content: constraint.content,
      type: constraint.type || 'general', // stability, safety, compatibility
      source: constraint.source || 'constitution', // constitution, user
      priority: constraint.priority || 'high', // critical, high, medium, low
      created_at: new Date().toISOString()
    };

    if (this.useSimple && simpleKB) {
      await simpleKB.add(
        COLLECTION_NAMES.constraints,
        [constraint.content],
        [id],
        [metadata]
      );
    } else {
      const collection = await this.ensureCollection('constraints');
      await collection.add({
        ids: [id],
        documents: [constraint.content],
        metadatas: [metadata]
      });
    }

    console.log(`✅ 约束添加成功: ${id}`);
    return { id, ...constraint };
  }

  /**
   * 获取约束列表
   */
  async constraint_list(filters = {}) {
    await this.initialize();

    let results;
    if (this.useSimple && simpleKB) {
      results = await simpleKB.get(COLLECTION_NAMES.constraints);
    } else {
      const collection = await this.ensureCollection('constraints');
      results = await collection.get({});
    }

    let constraints;
    if (this.useSimple && simpleKB) {
      constraints = results.map(r => ({
        id: r.id,
        content: r.metadata.content,
        type: r.metadata.type,
        source: r.metadata.source,
        priority: r.metadata.priority,
        created_at: r.metadata.created_at
      }));
    } else {
      constraints = (results.ids || []).map((id, i) => ({
        id,
        content: results.metadatas[i].content,
        type: results.metadatas[i].type,
        source: results.metadatas[i].source,
        priority: results.metadatas[i].priority,
        created_at: results.metadatas[i].created_at
      }));
    }

    // 应用过滤
    if (filters.type) {
      constraints = constraints.filter(c => c.type === filters.type);
    }
    if (filters.source) {
      constraints = constraints.filter(c => c.source === filters.source);
    }
    if (filters.priority) {
      constraints = constraints.filter(c => c.priority === filters.priority);
    }

    return constraints;
  }

  /**
   * 搜索约束
   */
  async constraint_search(query, filters = {}) {
    await this.initialize();

    let results;
    if (this.useSimple && simpleKB) {
      results = await simpleKB.query(COLLECTION_NAMES.constraints, [query], filters.limit || 10);
    } else {
      const collection = await this.ensureCollection('constraints');
      results = await collection.query({
        queryTexts: [query],
        nResults: filters.limit || 10
      });
    }

    if (this.useSimple && simpleKB) {
      return results.documents[0].map((doc, i) => ({
        id: results.ids[0][i],
        content: results.metadatas[0][i].content,
        type: results.metadatas[0][i].type,
        distance: results.distances[0][i]
      }));
    }

    return (results.ids || []).map((id, i) => ({
      id,
      content: results.metadatas[i].content,
      type: results.metadatas[i].type,
      distance: results.distances ? results.distances[0][i] : null
    }));
  }

  // ==================== 假设管理 ====================

  /**
   * 添加假设
   */
  async assumption_add(assumption) {
    await this.initialize();

    const id = assumption.id || `ass_${uuidv4().substring(0, 8)}`;
    const metadata = {
      assumption_id: id,
      content: assumption.content,
      type: assumption.type || 'general', // environment, capability, assumption
      risk_level: assumption.risk_level || 'medium', // high, medium, low
      related_requirements: assumption.related_requirements ? assumption.related_requirements.join(',') : '',
      created_at: new Date().toISOString()
    };

    if (this.useSimple && simpleKB) {
      await simpleKB.add(
        COLLECTION_NAMES.assumptions,
        [assumption.content],
        [id],
        [metadata]
      );
    } else {
      const collection = await this.ensureCollection('assumptions');
      await collection.add({
        ids: [id],
        documents: [assumption.content],
        metadatas: [metadata]
      });
    }

    console.log(`✅ 假设添加成功: ${id}`);
    return { id, ...assumption };
  }

  /**
   * 获取假设列表
   */
  async assumption_list(filters = {}) {
    await this.initialize();

    let results;
    if (this.useSimple && simpleKB) {
      results = await simpleKB.get(COLLECTION_NAMES.assumptions);
    } else {
      const collection = await this.ensureCollection('assumptions');
      results = await collection.get({});
    }

    let assumptions;
    if (this.useSimple && simpleKB) {
      assumptions = results.map(r => ({
        id: r.id,
        content: r.metadata.content,
        type: r.metadata.type,
        risk_level: r.metadata.risk_level,
        related_requirements: r.metadata.related_requirements ?
          r.metadata.related_requirements.split(',').filter(r => r) : [],
        created_at: r.metadata.created_at
      }));
    } else {
      assumptions = (results.ids || []).map((id, i) => ({
        id,
        content: results.metadatas[i].content,
        type: results.metadatas[i].type,
        risk_level: results.metadatas[i].risk_level,
        related_requirements: results.metadatas[i].related_requirements ?
          results.metadatas[i].related_requirements.split(',').filter(r => r) : [],
        created_at: results.metadatas[i].created_at
      }));
    }

    // 应用过滤
    if (filters.type) {
      assumptions = assumptions.filter(a => a.type === filters.type);
    }
    if (filters.risk_level) {
      assumptions = assumptions.filter(a => a.risk_level === filters.risk_level);
    }

    return assumptions;
  }

  // ==================== 通用查询 ====================

  /**
   * 获取完整上下文（用于注入到 prompt）
   */
  async getFullContext() {
    await this.initialize();

    const requirements = await this.requirement_list();
    const decisions = await this.decision_list();
    const constraints = await this.constraint_list();
    const assumptions = await this.assumption_list();

    return {
      requirements,
      decisions,
      constraints,
      assumptions,
      summary: {
        requirements_count: requirements.length,
        decisions_count: decisions.length,
        constraints_count: constraints.length,
        assumptions_count: assumptions.length
      }
    };
  }
}

// 创建单例实例
const knowledgeBase = new KnowledgeBase();

module.exports = {
  knowledgeBase,
  REQUIREMENT_STATUS,
  REQUIREMENT_STATUS: REQUIREMENT_STATUS
};
