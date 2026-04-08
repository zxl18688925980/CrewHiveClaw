/**
 * HomeAI 日志分析器
 * 文件: homeai/shared/log-analyzer.js
 * 描述: 分析系统日志，自动检测进化事件
 * 创建: 2026-03-07
 * 维护: Lisa (编码专家)
 */

const fs = require('fs').promises;
const path = require('path');
const { EVOLUTION_TYPES, SEVERITY_LEVELS } = require('./evolution-types');

class LogAnalyzer {
  constructor(options = {}) {
    this.options = {
      logDir: options.logDir || path.join(__dirname, '../../logs'),
      scanInterval: options.scanInterval || 10 * 60 * 1000, // 10分钟
      maxLogSize: options.maxLogSize || 10 * 1024 * 1024, // 10MB
      patterns: this.getDefaultPatterns(),
      ...options
    };
    
    this.processedFiles = new Set();
    this.lastScanTime = null;
  }
  
  /**
   * 获取默认模式匹配规则
   */
  getDefaultPatterns() {
    return {
      // 问题检测模式
      [EVOLUTION_TYPES.PROBLEM_DETECTED]: [
        { pattern: /error.*timeout/i, severity: SEVERITY_LEVELS.HIGH },
        { pattern: /failed to.*/i, severity: SEVERITY_LEVELS.MEDIUM },
        { pattern: /error.*connection/i, severity: SEVERITY_LEVELS.HIGH },
        { pattern: /crash|panic/i, severity: SEVERITY_LEVELS.CRITICAL },
        { pattern: /memory leak/i, severity: SEVERITY_LEVELS.HIGH },
        { pattern: /deadlock/i, severity: SEVERITY_LEVELS.CRITICAL }
      ],
      
      // 系统恢复模式
      [EVOLUTION_TYPES.SYSTEM_RECOVERED]: [
        { pattern: /守护进程.*启动|启动成功/i, severity: SEVERITY_LEVELS.INFO },
        { pattern: /recovered|restored/i, severity: SEVERITY_LEVELS.INFO },
        { pattern: /service.*started/i, severity: SEVERITY_LEVELS.INFO },
        { pattern: /back online/i, severity: SEVERITY_LEVELS.INFO }
      ],
      
      // 性能问题检测
      [EVOLUTION_TYPES.PERFORMANCE_ISSUE_DETECTED]: [
        { pattern: /slow.*response/i, severity: SEVERITY_LEVELS.MEDIUM },
        { pattern: /high.*latency/i, severity: SEVERITY_LEVELS.MEDIUM },
        { pattern: /timeout.*exceeded/i, severity: SEVERITY_LEVELS.HIGH },
        { pattern: /memory.*high/i, severity: SEVERITY_LEVELS.MEDIUM },
        { pattern: /cpu.*high/i, severity: SEVERITY_LEVELS.MEDIUM }
      ],
      
      // 功能部署
      [EVOLUTION_TYPES.FEATURE_DEPLOYED]: [
        { pattern: /feature.*deployed/i, severity: SEVERITY_LEVELS.INFO },
        { pattern: /新增.*功能/i, severity: SEVERITY_LEVELS.INFO },
        { pattern: /上线.*成功/i, severity: SEVERITY_LEVELS.INFO },
        { pattern: /release.*completed/i, severity: SEVERITY_LEVELS.INFO }
      ],
      
      // 安全事件
      [EVOLUTION_TYPES.SECURITY_ISSUE_DETECTED]: [
        { pattern: /security.*alert/i, severity: SEVERITY_LEVELS.CRITICAL },
        { pattern: /unauthorized.*access/i, severity: SEVERITY_LEVELS.CRITICAL },
        { pattern: /authentication.*failed/i, severity: SEVERITY_LEVELS.HIGH },
        { pattern: /brute.*force/i, severity: SEVERITY_LEVELS.CRITICAL }
      ]
    };
  }
  
  /**
   * 扫描日志文件
   */
  async scanLogs() {
    try {
      console.log('🔍 Scanning log files for evolution events...');
      
      const logFiles = await this.getLogFiles();
      const events = [];
      
      for (const file of logFiles) {
        const fileEvents = await this.analyzeLogFile(file);
        events.push(...fileEvents);
      }
      
      this.lastScanTime = new Date();
      console.log(`✅ Found ${events.length} potential evolution events`);
      
      return events;
      
    } catch (error) {
      console.error('Error scanning logs:', error.message);
      return [];
    }
  }
  
  /**
   * 获取日志文件列表
   */
  async getLogFiles() {
    try {
      const files = await fs.readdir(this.options.logDir);
      
      return files
        .filter(file => file.endsWith('.log'))
        .map(file => path.join(this.options.logDir, file))
        .filter(file => {
          // 检查文件大小
          try {
            const stats = fs.statSync(file);
            return stats.size > 0 && stats.size <= this.options.maxLogSize;
          } catch {
            return false;
          }
        });
    } catch (error) {
      console.error('Error reading log directory:', error.message);
      return [];
    }
  }
  
  /**
   * 分析单个日志文件
   */
  async analyzeLogFile(filePath) {
    const events = [];
    
    try {
      // 检查是否已处理过
      if (this.processedFiles.has(filePath)) {
        // 只读取新内容
        const newEvents = await this.analyzeNewLogContent(filePath);
        events.push(...newEvents);
      } else {
        // 首次处理，分析整个文件
        const allEvents = await this.analyzeFullLogFile(filePath);
        events.push(...allEvents);
        this.processedFiles.add(filePath);
      }
      
    } catch (error) {
      console.error(`Error analyzing log file ${filePath}:`, error.message);
    }
    
    return events;
  }
  
  /**
   * 分析完整日志文件
   */
  async analyzeFullLogFile(filePath) {
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    
    return this.analyzeLogLines(lines, filePath);
  }
  
  /**
   * 分析新的日志内容
   */
  async analyzeNewLogContent(filePath) {
    // 获取文件当前位置
    // 这里简化处理，实际应该记录上次读取的位置
    // 现在先分析最后100行
    const content = await fs.readFile(filePath, 'utf8');
    const lines = content.split('\n').filter(line => line.trim().length > 0);
    const recentLines = lines.slice(-100); // 只分析最近100行
    
    return this.analyzeLogLines(recentLines, filePath);
  }
  
  /**
   * 分析日志行
   */
  analyzeLogLines(lines, filePath) {
    const events = [];
    
    for (const line of lines) {
      const event = this.extractEventFromLine(line, filePath);
      if (event) {
        events.push(event);
      }
    }
    
    return events;
  }
  
  /**
   * 从日志行提取事件
   */
  extractEventFromLine(logLine, filePath) {
    // 尝试解析JSON格式日志
    let logEntry;
    try {
      logEntry = JSON.parse(logLine);
      return this.extractEventFromJsonLog(logEntry, filePath);
    } catch (e) {
      // 不是JSON格式，尝试文本匹配
      return this.extractEventFromTextLog(logLine, filePath);
    }
  }
  
  /**
   * 从JSON日志提取事件
   */
  extractEventFromJsonLog(logEntry, filePath) {
    const { level, message, timestamp, error, ...otherFields } = logEntry;
    
    // 根据日志级别和内容判断事件类型
    let eventType = null;
    let severity = SEVERITY_LEVELS.INFO;
    let description = message;
    
    // 错误日志通常表示问题
    if (level === 'error') {
      eventType = EVOLUTION_TYPES.PROBLEM_DETECTED;
      severity = this.determineErrorSeverity(message, error);
      description = `Error detected: ${message}`;
      
      if (error) {
        description += ` (${error})`;
      }
    }
    
    // 信息日志可能包含系统状态
    else if (level === 'info') {
      // 检查是否是系统启动/恢复
      if (message.includes('启动') || message.includes('started') || message.includes('running')) {
        eventType = EVOLUTION_TYPES.SYSTEM_RECOVERED;
        description = `System component: ${message}`;
      }
      
      // 检查是否是功能部署
      else if (message.includes('deployed') || message.includes('上线') || message.includes('feature')) {
        eventType = EVOLUTION_TYPES.FEATURE_DEPLOYED;
        description = `Feature deployment: ${message}`;
      }
    }
    
    // 警告日志可能表示潜在问题
    else if (level === 'warn') {
      eventType = EVOLUTION_TYPES.PROBLEM_DETECTED;
      severity = SEVERITY_LEVELS.MEDIUM;
      description = `Warning: ${message}`;
    }
    
    // 如果没有匹配到特定类型，尝试模式匹配
    if (!eventType) {
      const matchedType = this.matchPatterns(message);
      if (matchedType) {
        eventType = matchedType.type;
        severity = matchedType.severity;
      }
    }
    
    // 如果没有事件类型，返回null
    if (!eventType) {
      return null;
    }
    
    // 构建事件对象
    return {
      type: eventType,
      title: this.generateEventTitle(eventType, message),
      description: description,
      timestamp: timestamp || new Date().toISOString(),
      problem: {
        description: level === 'error' || level === 'warn' ? message : '',
        severity: severity,
        impact: this.determineImpact(level, message),
        detected_at: timestamp || new Date().toISOString()
      },
      related: {
        logs: [`${filePath}:${this.extractLineReference(logEntry)}`]
      },
      metadata: {
        source: 'log_analyzer',
        log_level: level,
        log_file: path.basename(filePath),
        raw_entry: logEntry
      }
    };
  }
  
  /**
   * 从文本日志提取事件
   */
  extractEventFromTextLog(logLine, filePath) {
    // 简单的文本模式匹配
    const matchedType = this.matchPatterns(logLine);
    
    if (!matchedType) {
      return null;
    }
    
    return {
      type: matchedType.type,
      title: this.generateEventTitle(matchedType.type, logLine),
      description: `Log event: ${logLine.substring(0, 200)}`,
      timestamp: this.extractTimestampFromText(logLine) || new Date().toISOString(),
      problem: {
        description: logLine,
        severity: matchedType.severity,
        impact: this.determineImpact('unknown', logLine),
        detected_at: this.extractTimestampFromText(logLine) || new Date().toISOString()
      },
      related: {
        logs: [filePath]
      },
      metadata: {
        source: 'log_analyzer_text',
        log_file: path.basename(filePath),
        raw_line: logLine.substring(0, 500)
      }
    };
  }
  
  /**
   * 匹配模式
   */
  matchPatterns(text) {
    for (const [eventType, patterns] of Object.entries(this.options.patterns)) {
      for (const patternConfig of patterns) {
        if (patternConfig.pattern.test(text)) {
          return {
            type: eventType,
            severity: patternConfig.severity
          };
        }
      }
    }
    
    return null;
  }
  
  /**
   * 生成事件标题
   */
  generateEventTitle(eventType, message) {
    const shortMessage = message.length > 100 ? message.substring(0, 100) + '...' : message;
    
    const titles = {
      [EVOLUTION_TYPES.PROBLEM_DETECTED]: `Problem detected: ${shortMessage}`,
      [EVOLUTION_TYPES.SYSTEM_RECOVERED]: `System recovered: ${shortMessage}`,
      [EVOLUTION_TYPES.PERFORMANCE_ISSUE_DETECTED]: `Performance issue: ${shortMessage}`,
      [EVOLUTION_TYPES.FEATURE_DEPLOYED]: `Feature deployed: ${shortMessage}`,
      [EVOLUTION_TYPES.SECURITY_ISSUE_DETECTED]: `Security alert: ${shortMessage}`
    };
    
    return titles[eventType] || `Log event: ${shortMessage}`;
  }
  
  /**
   * 确定错误严重程度
   */
  determineErrorSeverity(message, error) {
    const criticalKeywords = ['crash', 'panic', 'deadlock', 'fatal', '不可用', '崩溃'];
    const highKeywords = ['timeout', 'connection', 'failed', '错误', '失败'];
    const mediumKeywords = ['warning', 'slow', '延迟', '警告'];
    
    const fullText = `${message} ${error || ''}`.toLowerCase();
    
    if (criticalKeywords.some(keyword => fullText.includes(keyword))) {
      return SEVERITY_LEVELS.CRITICAL;
    }
    
    if (highKeywords.some(keyword => fullText.includes(keyword))) {
      return SEVERITY_LEVELS.HIGH;
    }
    
    if (mediumKeywords.some(keyword => fullText.includes(keyword))) {
      return SEVERITY_LEVELS.MEDIUM;
    }
    
    return SEVERITY_LEVELS.LOW;
  }
  
  /**
   * 确定影响范围
   */
  determineImpact(level, message) {
    const text = message.toLowerCase();
    
    if (text.includes('system') || text.includes('all') || text.includes('全局')) {
      return 'system_wide';
    }
    
    if (text.includes('multiple') || text.includes('several') || text.includes('多个')) {
      return 'multiple_components';
    }
    
    if (text.includes('component') || text.includes('service') || text.includes('组件')) {
      return 'single_component';
    }
    
    if (text.includes('user') || text.includes('用户')) {
      return 'user_specific';
    }
    
    return 'unknown';
  }
  
  /**
   * 提取行引用
   */
  extractLineReference(logEntry) {
    // 在实际实现中，可能需要记录行号
    // 这里返回一个占位符
    return 'line_ref';
  }
  
  /**
   * 从文本提取时间戳
   */
  extractTimestampFromText(text) {
    // 尝试匹配常见的时间戳格式
    const timestampPatterns = [
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/, // ISO格式
      /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/, // 简单格式
      /\d{2}:\d{2}:\d{2}/, // 时间格式
    ];
    
    for (const pattern of timestampPatterns) {
      const match = text.match(pattern);
      if (match) {
        return match[0];
      }
    }
    
    return null;
  }
  
  /**
   * 开始定期扫描
   */
  startPeriodicScan() {
    console.log(`🔄 Starting periodic log scan every ${this.options.scanInterval / 60000} minutes`);
    
    this.scanInterval = setInterval(async () => {
      try {
        await this.scanLogs();
      } catch (error) {
        console.error('Error in periodic log scan:', error.message);
      }
    }, this.options.scanInterval);
    
    // 立即执行一次扫描
    this.scanLogs().catch(error => {
      console.error('Error in initial log scan:', error.message);
    });
  }
  
  /**
   * 停止定期扫描
   */
  stopPeriodicScan() {
    if (this.scanInterval) {
      clearInterval(this.scanInterval);
      console.log('⏹️ Stopped periodic log scan');
    }
  }
  
  /**
   * 获取分析统计
   */
  getStats() {
    return {
      processedFiles: this.processedFiles.size,
      lastScanTime: this.lastScanTime,
      scanInterval: this.options.scanInterval
    };
  }
}

// 导出分析器类
module.exports = LogAnalyzer;