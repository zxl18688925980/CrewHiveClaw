/**
 * HomeAI 进化事件管理器
 * 文件: homeai/shared/evolution-manager.js
 * 描述: 管理系统的进化事件记录、存储和分析
 * 创建: 2026-03-07
 * 维护: Lisa (编码专家)
 * 版本: v345.0 - 使用统一路径配置
 */

const fs = require('fs').promises;
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const {
  EVOLUTION_TYPES,
  SEVERITY_LEVELS,
  IMPACT_SCOPES,
  SOLUTION_EFFECTIVENESS,
  VERIFICATION_STATUS,
  getEventTypeDescription,
  getEventCategory,
  isValidEventType
} = require('./evolution-types');
const { paths, ensureDirectories } = require('./paths');

class EvolutionManager {
  constructor(options = {}) {
    this.options = {
      // 使用统一路径配置（v345.0）
      storagePath: options.storagePath || paths.data.evolution.events,
      maxEvents: options.maxEvents || 1000,
      autoSave: options.autoSave !== false,
      backupCount: options.backupCount || 5,
      ...options
    };
    
    this.events = [];
    this.isInitialized = false;
    this.metrics = {
      totalEvents: 0,
      eventsByType: {},
      eventsByCategory: {},
      lastRecorded: null
    };
  }
  
  /**
   * 初始化管理器
   */
  async initialize() {
    try {
      // 确保存储目录存在
      const storageDir = path.dirname(this.options.storagePath);
      await fs.mkdir(storageDir, { recursive: true });
      
      // 加载现有事件
      await this.loadEvents();
      
      // 创建备份
      await this.createBackup();
      
      this.isInitialized = true;
      console.log(`✅ Evolution Manager initialized with ${this.events.length} events`);
      
      return true;
    } catch (error) {
      console.error('❌ Failed to initialize Evolution Manager:', error.message);
      
      // 创建空的事件数组
      this.events = [];
      this.isInitialized = true;
      
      return false;
    }
  }
  
  /**
   * 记录进化事件
   * @param {Object} eventData - 事件数据
   * @returns {Object} 记录的事件
   */
  async recordEvent(eventData) {
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    // 验证事件数据
    const validation = this.validateEventData(eventData);
    if (!validation.valid) {
      throw new Error(`Invalid event data: ${validation.errors.join(', ')}`);
    }
    
    // 创建完整事件对象
    const event = this.createEventObject(eventData);
    
    // 添加到事件列表
    this.events.unshift(event); // 最新事件在前面
    
    // 限制事件数量
    if (this.events.length > this.options.maxEvents) {
      this.events = this.events.slice(0, this.options.maxEvents);
    }
    
    // 更新指标
    this.updateMetrics(event);
    
    // 自动保存
    if (this.options.autoSave) {
      await this.saveEvents();
    }
    
    // 触发事件处理
    await this.processEvent(event);
    
    console.log(`📝 Evolution event recorded: ${event.title} (${event.id})`);
    
    return event;
  }
  
  /**
   * 创建事件对象
   * @param {Object} data - 事件数据
   * @returns {Object} 完整事件对象
   */
  createEventObject(data) {
    const timestamp = data.timestamp || new Date().toISOString();
    const eventId = data.id || `ev_${timestamp.replace(/[:\.]/g, '-')}_${uuidv4().substring(0, 8)}`;
    
    return {
      // 基础信息
      id: eventId,
      timestamp: timestamp,
      type: data.type,
      category: getEventCategory(data.type),
      title: data.title || getEventTypeDescription(data.type),
      description: data.description || '',
      
      // 问题相关信息
      problem: data.problem || {
        description: '',
        severity: SEVERITY_LEVELS.INFO,
        impact: IMPACT_SCOPES.NO_IMPACT,
        detected_at: timestamp,
        resolved_at: data.type === EVOLUTION_TYPES.PROBLEM_SOLVED ? timestamp : null
      },
      
      // 解决方案信息
      solution: data.solution || {
        approach: '',
        implementation: '',
        effectiveness: SOLUTION_EFFECTIVENESS.UNKNOWN,
        implemented_at: timestamp
      },
      
      // 量化指标
      metrics: data.metrics || {
        before: {},
        after: {},
        improvement: {}
      },
      
      // 关联信息
      related: data.related || {
        logs: [],
        documents: [],
        decisions: [],
        code: [],
        people: []
      },
      
      // 验证信息
      verification: data.verification || {
        status: VERIFICATION_STATUS.NOT_VERIFIED,
        verified_by: 'system',
        verified_at: null,
        evidence: []
      },
      
      // 元数据
      metadata: {
        version: '1.0',
        source: data.source || 'system',
        priority: data.priority || 'normal',
        tags: data.tags || [],
        ...data.metadata
      }
    };
  }
  
  /**
   * 验证事件数据
   * @param {Object} data - 事件数据
   * @returns {Object} 验证结果
   */
  validateEventData(data) {
    const errors = [];
    
    // 检查事件类型
    if (!data.type || !isValidEventType(data.type)) {
      errors.push(`Invalid event type: ${data.type}`);
    }
    
    // 检查标题
    if (!data.title || data.title.trim().length === 0) {
      errors.push('Event title is required');
    }
    
    // 检查描述
    if (!data.description || data.description.trim().length === 0) {
      errors.push('Event description is required');
    }
    
    // 检查问题描述（如果是问题相关事件）
    if ([EVOLUTION_TYPES.PROBLEM_DETECTED, EVOLUTION_TYPES.PROBLEM_SOLVED].includes(data.type)) {
      if (!data.problem || !data.problem.description) {
        errors.push('Problem description is required for problem-related events');
      }
    }
    
    // 检查解决方案（如果是问题解决事件）
    if (data.type === EVOLUTION_TYPES.PROBLEM_SOLVED) {
      if (!data.solution || !data.solution.approach) {
        errors.push('Solution approach is required for problem solved events');
      }
    }
    
    return {
      valid: errors.length === 0,
      errors
    };
  }
  
  /**
   * 处理事件
   * @param {Object} event - 事件对象
   */
  async processEvent(event) {
    try {
      // 根据事件类型执行不同的处理逻辑
      switch (event.type) {
        case EVOLUTION_TYPES.PROBLEM_SOLVED:
          await this.handleProblemSolved(event);
          break;
          
        case EVOLUTION_TYPES.FEATURE_DEPLOYED:
          await this.handleFeatureDeployed(event);
          break;
          
        case EVOLUTION_TYPES.PERFORMANCE_IMPROVED:
          await this.handlePerformanceImproved(event);
          break;
          
        case EVOLUTION_TYPES.DOCUMENTATION_UPDATED:
          await this.handleDocumentationUpdated(event);
          break;
          
        case EVOLUTION_TYPES.SYSTEM_RECOVERED:
          await this.handleSystemRecovered(event);
          break;
          
        default:
          // 默认处理
          await this.handleGenericEvent(event);
      }
      
      // 触发通知
      await this.sendNotifications(event);
      
    } catch (error) {
      console.error(`Error processing event ${event.id}:`, error.message);
    }
  }
  
  /**
   * 处理问题解决事件
   */
  async handleProblemSolved(event) {
    console.log(`🔧 Problem solved: ${event.problem.description}`);
    
    // 可以在这里添加问题解决后的处理逻辑，比如：
    // - 更新问题跟踪系统
    // - 发送解决通知
    // - 更新相关文档
  }
  
  /**
   * 处理功能部署事件
   */
  async handleFeatureDeployed(event) {
    console.log(`🚀 Feature deployed: ${event.title}`);
    
    // 可以在这里添加功能部署后的处理逻辑
  }
  
  /**
   * 处理性能改进事件
   */
  async handlePerformanceImproved(event) {
    console.log(`⚡ Performance improved: ${event.title}`);
    
    // 记录性能指标变化
    if (event.metrics && event.metrics.improvement) {
      console.log(`   Improvement: ${JSON.stringify(event.metrics.improvement)}`);
    }
  }
  
  /**
   * 处理文档更新事件
   */
  async handleDocumentationUpdated(event) {
    console.log(`📚 Documentation updated: ${event.title}`);
    
    // 可以在这里触发文档同步或重建
  }
  
  /**
   * 处理系统恢复事件
   */
  async handleSystemRecovered(event) {
    console.log(`🔄 System recovered: ${event.title}`);
    
    // 可以在这里执行系统恢复后的检查
  }
  
  /**
   * 处理通用事件
   */
  async handleGenericEvent(event) {
    // 通用事件处理逻辑
    console.log(`📝 Event recorded: ${event.title} (${event.type})`);
  }
  
  /**
   * 发送通知
   */
  async sendNotifications(event) {
    // 根据事件类型和严重程度决定是否发送通知
    const shouldNotify = this.shouldSendNotification(event);
    
    if (shouldNotify) {
      // 这里可以集成邮件、Slack、飞书等通知渠道
      console.log(`🔔 Notification triggered for event: ${event.title}`);
      
      // 示例：记录到通知日志
      const notification = {
        eventId: event.id,
        eventType: event.type,
        title: event.title,
        timestamp: new Date().toISOString(),
        sent: false // 实际发送后会更新为true
      };
      
      // 保存通知记录
      await this.saveNotification(notification);
    }
  }
  
  /**
   * 判断是否应该发送通知
   */
  shouldSendNotification(event) {
    // 根据事件类型和严重程度决定
    const criticalTypes = [
      EVOLUTION_TYPES.PROBLEM_DETECTED,
      EVOLUTION_TYPES.SECURITY_ISSUE_DETECTED,
      EVOLUTION_TYPES.SYSTEM_RECOVERED
    ];
    
    const importantTypes = [
      EVOLUTION_TYPES.PROBLEM_SOLVED,
      EVOLUTION_TYPES.FEATURE_DEPLOYED,
      EVOLUTION_TYPES.PERFORMANCE_IMPROVED
    ];
    
    if (criticalTypes.includes(event.type)) {
      return true;
    }
    
    if (importantTypes.includes(event.type) && 
        event.problem.severity === SEVERITY_LEVELS.CRITICAL) {
      return true;
    }
    
    return false;
  }
  
  /**
   * 保存通知记录
   */
  async saveNotification(notification) {
    const notificationsPath = path.join(
      path.dirname(this.options.storagePath),
      'notifications.json'
    );
    
    try {
      let notifications = [];
      
      // 加载现有通知
      try {
        const data = await fs.readFile(notificationsPath, 'utf8');
        notifications = JSON.parse(data);
      } catch (error) {
        // 文件不存在，创建空数组
      }
      
      // 添加新通知
      notifications.unshift(notification);
      
      // 限制数量
      if (notifications.length > 100) {
        notifications = notifications.slice(0, 100);
      }
      
      // 保存
      await fs.writeFile(
        notificationsPath,
        JSON.stringify(notifications, null, 2),
        'utf8'
      );
      
    } catch (error) {
      console.error('Error saving notification:', error.message);
    }
  }
  
  /**
   * 更新指标
   */
  updateMetrics(event) {
    this.metrics.totalEvents++;
    this.metrics.lastRecorded = event.timestamp;
    
    // 按类型统计
    if (!this.metrics.eventsByType[event.type]) {
      this.metrics.eventsByType[event.type] = 0;
    }
    this.metrics.eventsByType[event.type]++;
    
    // 按分类统计
    if (!this.metrics.eventsByCategory[event.category]) {
      this.metrics.eventsByCategory[event.category] = 0;
    }
    this.metrics.eventsByCategory[event.category]++;
  }
  
  /**
   * 加载事件
   */
  async loadEvents() {
    try {
      const data = await fs.readFile(this.options.storagePath, 'utf8');
      this.events = JSON.parse(data);
      
      // 重新计算指标
      this.recalculateMetrics();
      
      console.log(`📂 Loaded ${this.events.length} evolution events`);
      return this.events;
    } catch (error) {
      if (error.code === 'ENOENT') {
        // 文件不存在，创建空数组
        this.events = [];
        await this.saveEvents();
        return this.events;
      }
      throw error;
    }
  }
  
  /**
   * 保存事件
   */
  async saveEvents() {
    try {
      const data = JSON.stringify(this.events, null, 2);
      await fs.writeFile(this.options.storagePath, data, 'utf8');
      
      // 创建备份
      await this.createBackup();
      
      return true;
    } catch (error) {
      console.error('Error saving evolution events:', error.message);
      return false;
    }
  }
  
  /**
   * 创建备份
   */
  async createBackup() {
    try {
      const backupDir = path.join(path.dirname(this.options.storagePath), 'backups');
      await fs.mkdir(backupDir, { recursive: true });
      
      const timestamp = new Date().toISOString().replace(/[:\.]/g, '-');
      const backupPath = path.join(backupDir, `evolution-events-${timestamp}.json`);
      
      const data = JSON.stringify(this.events, null, 2);
      await fs.writeFile(backupPath, data, 'utf8');
      
      // 清理旧备份
      await this.cleanupOldBackups(backupDir);
      
      return backupPath;
    } catch (error) {
      console.error('Error creating backup:', error.message);
      return null;
    }
  }
  
  /**
   * 清理旧备份
   */
  async cleanupOldBackups(backupDir) {
    try {
      const files = await fs.readdir(backupDir);
      const backupFiles = files
        .filter(file => file.startsWith('evolution-events-') && file.endsWith('.json'))
        .map(file => ({
          name: file,
          path: path.join(backupDir, file),
          time: fs.statSync(path.join(backupDir, file)).mtime.getTime()
        }))
        .sort((a, b) => b.time - a.time); // 按时间倒序排列
      
      // 删除超出数量的旧备份
      if (backupFiles.length > this.options.backupCount) {
        const toDelete = backupFiles.slice(this.options.backupCount);
        
        for (const file of toDelete) {
          await fs.unlink(file.path);
          console.log(`🗑️  Deleted old backup: ${file.name}`);
        }
      }
    } catch (error) {
      console.error('Error cleaning up old backups:', error.message);
    }
  }
  
  /**
   * 重新计算指标
   */
  recalculateMetrics() {
    this.metrics = {
      totalEvents: this.events.length,
      eventsByType: {},
      eventsByCategory: {},
      lastRecorded: this.events.length > 0 ? this.events[0].timestamp : null
    };
    
    for (const event of this.events) {
      // 按类型统计
      if (!this.metrics.eventsByType[event.type]) {
        this.metrics.eventsByType[event.type] = 0;
      }
      this.metrics.eventsByType[event.type]++;
      
      // 按分类统计
      if (!this.metrics.eventsByCategory[event.category]) {
        this.metrics.eventsByCategory[event.category] = 0;
      }
      this.metrics.eventsByCategory[event.category]++;
    }
  }
  
  /**
   * 查询事件
   */
  queryEvents(options = {}) {
    let results = [...this.events];
    
    // 按类型过滤
    if (options.type) {
      results = results.filter(event => event.type === options.type);
    }
    
    // 按分类过滤
    if (options.category) {
      results = results.filter(event => event.category === options.category);
    }
    
    // 按时间范围过滤
    if (options.startDate) {
      const start = new Date(options.startDate);
      results = results.filter(event => new Date(event.timestamp) >= start);
    }
    
    if (options.endDate) {
      const end = new Date(options.endDate);
      results = results.filter(event => new Date(event.timestamp) <= end);
    }
    
    // 按关键词搜索
    if (options.search) {
      const searchTerm = options.search.toLowerCase();
      results = results.filter(event => 
        event.title.toLowerCase().includes(searchTerm) ||
        event.description.toLowerCase().includes(searchTerm) ||
        (event.problem.description && event.problem.description.toLowerCase().includes(searchTerm))
      );
    }
    
    // 排序
    const sortField = options.sortBy || 'timestamp';
    const sortOrder = options.sortOrder || 'desc';
    
    results.sort((a, b) => {
      let aValue = a[sortField];
      let bValue = b[sortField];
      
      // 处理嵌套字段
      if (sortField.includes('.')) {
        const fields = sortField.split('.');
        aValue = fields.reduce((obj, field) => obj && obj[field], a);
        bValue = fields.reduce((obj, field) => obj && obj[field], b);
      }
      
      // 比较值
      if (aValue < bValue) return sortOrder === 'asc' ? -1 : 1;
      if (aValue > bValue) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });
    
    // 分页
    const page = options.page || 1;
    const limit = options.limit || 20;
    const startIndex = (page - 1) * limit;
    const endIndex = startIndex + limit;
    
    const paginatedResults = results.slice(startIndex, endIndex);
    
    return {
      total: results.length,
      page,
      limit,
      totalPages: Math.ceil(results.length / limit),
      events: paginatedResults
    };
  }
  
  /**
   * 获取事件统计
   */
  getStatistics() {
    return {
      ...this.metrics,
      firstRecorded: this.events.length > 0 ? this.events[this.events.length - 1].timestamp : null,
      eventTypes: Object.keys(this.metrics.eventsByType).map(type => ({
        type,
        count: this.metrics.eventsByType[type],
        description: getEventTypeDescription(type)
      })),
      categories: Object.keys(this.metrics.eventsByCategory).map(category => ({
        category,
        count: this.metrics.eventsByCategory[category]
      }))
    };
  }
  
  /**
   * 获取最近事件
   */
  getRecentEvents(limit = 10) {
    return this.events.slice(0, limit);
  }
  
  /**
   * 获取问题解决时间线
   */
  getProblemResolutionTimeline() {
    const problemEvents = this.events.filter(event => 
      event.type === EVOLUTION_TYPES.PROBLEM_SOLVED
    );
    
    return problemEvents.map(event => ({
      id: event.id,
      timestamp: event.timestamp,
      problem: event.problem.description,
      solution: event.solution.approach,
      effectiveness: event.solution.effectiveness,
      resolutionTime: this.calculateResolutionTime(event)
    }));
  }
  
  /**
   * 计算问题解决时间
   */
  calculateResolutionTime(event) {
    if (!event.problem.detected_at || !event.solution.implemented_at) {
      return null;
    }
    
    const detected = new Date(event.problem.detected_at);
    const resolved = new Date(event.solution.implemented_at);
    const diffMs = resolved - detected;
    
    // 转换为小时
    return Math.round(diffMs / (1000 * 60 * 60) * 100) / 100;
  }
  
  /**
   * 导出事件数据
   */
  async exportEvents(format = 'json', options = {}) {
    let data;
    
    switch (format) {
      case 'json':
        data = JSON.stringify(this.events, null, 2);
        break;
        
      case 'csv':
        data = this.convertToCSV(this.events);
        break;
        
      case 'markdown':
        data = this.convertToMarkdown(this.events, options);
        break;
        
      default:
        throw new Error(`Unsupported export format: ${format}`);
    }
    
    return data;
  }
  
  /**
   * 转换为CSV
   */
  convertToCSV(events) {
    if (events.length === 0) return '';
    
    const headers = ['id', 'timestamp', 'type', 'title', 'description', 'problem_description', 'solution_approach'];
    const rows = events.map(event => [
      event.id,
      event.timestamp,
      event.type,
      `"${event.title.replace(/"/g, '""')}"`,
      `"${event.description.replace(/"/g, '""')}"`,
      `"${(event.problem.description || '').replace(/"/g, '""')}"`,
      `"${(event.solution.approach || '').replace(/"/g, '""')}"`
    ]);
    
    const csv = [
      headers.join(','),
      ...rows.map(row => row.join(','))
    ].join('\n');
    
    return csv;
  }
  
  /**
   * 转换为Markdown
   */
  convertToMarkdown(events, options = {}) {
    const title = options.title || 'HomeAI Evolution Events';
    const limit = options.limit || 50;
    
    const limitedEvents = events.slice(0, limit);
    
    let markdown = `# ${title}\n\n`;
    markdown += `*Generated on ${new Date().toISOString()}*\n\n`;
    markdown += `Total events: ${events.length}\n\n`;
    
    // 按类型分组
    const eventsByType = {};
    for (const event of limitedEvents) {
      if (!eventsByType[event.type]) {
        eventsByType[event.type] = [];
      }
      eventsByType[event.type].push(event);
    }
    
    // 生成每个类型的事件列表
    for (const [type, typeEvents] of Object.entries(eventsByType)) {
      const typeDescription = getEventTypeDescription(type);
      markdown += `## ${typeDescription} (${typeEvents.length})\n\n`;
      
      for (const event of typeEvents) {
        markdown += `### ${event.title}\n`;
        markdown += `*ID: ${event.id} | ${event.timestamp}*\n\n`;
        markdown += `${event.description}\n\n`;
        
        if (event.problem.description) {
          markdown += `**Problem**: ${event.problem.description}\n\n`;
        }
        
        if (event.solution.approach) {
          markdown += `**Solution**: ${event.solution.approach}\n\n`;
        }
        
        markdown += `---\n\n`;
      }
    }
    
    return markdown;
  }
  
  /**
   * 迁移旧数据
   */
  async migrateLegacyData() {
    const legacyPath = path.join(__dirname, '../../data/evolution/evolution-log.json');
    
    try {
      const data = await fs.readFile(legacyPath, 'utf8');
      const legacyEvents = JSON.parse(data);
      
      console.log(`Found ${legacyEvents.length} legacy events to migrate`);
      
      for (const legacyEvent of legacyEvents) {
        // 转换旧格式到新格式
        const newEvent = {
          type: EVOLUTION_TYPES.LEARNING,
          title: legacyEvent.description || 'Legacy learning event',
          description: legacyEvent.learning || 'Migrated from legacy system',
          timestamp: legacyEvent.timestamp,
          problem: {
            description: '',
            severity: SEVERITY_LEVELS.INFO,
            impact: IMPACT_SCOPES.NO_IMPACT
          },
          solution: {
            approach: 'Migration',
            effectiveness: SOLUTION_EFFECTIVENESS.COMPLETE
          },
          metadata: {
            source: 'legacy_migration',
            original_data: legacyEvent
          }
        };
        
        await this.recordEvent(newEvent);
      }
      
      console.log(`✅ Migrated ${legacyEvents.length} legacy events`);
      
      // 备份旧文件
      const backupPath = `${legacyPath}.backup-${new Date().toISOString().replace(/[:\.]/g, '-')}`;
      await fs.copyFile(legacyPath, backupPath);
      
      return legacyEvents.length;
      
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log('No legacy data found to migrate');
        return 0;
      }
      throw error;
    }
  }
}

// 导出管理器类
module.exports = EvolutionManager;