/**
 * HomeAI 进化事件类型定义
 * 文件: homeai/shared/evolution-types.js
 * 描述: 定义系统进化过程中可能发生的各种事件类型
 * 创建: 2026-03-07
 * 维护: Lisa (编码专家)
 */

/**
 * 进化事件类型枚举
 * 扩展了原有的learning类型，支持完整的进化记录
 */
const EVOLUTION_TYPES = {
  // 原有类型 - 保持向后兼容
  LEARNING: 'learning',           // 学习认知 - 系统学习新知识或认知更新
  
  // 新增类型 - 问题解决相关
  PROBLEM_DETECTED: 'problem_detected',     // 问题检测 - 发现系统问题
  PROBLEM_SOLVED: 'problem_solved',         // 问题解决 - 成功解决问题
  WORKAROUND_IMPLEMENTED: 'workaround_implemented', // 临时解决方案
  
  // 新增类型 - 功能开发相关
  FEATURE_REQUESTED: 'feature_requested',   // 功能需求 - 用户请求新功能
  FEATURE_DESIGNED: 'feature_designed',     // 功能设计 - 完成功能设计
  FEATURE_IMPLEMENTED: 'feature_implemented', // 功能实现 - 完成功能开发
  FEATURE_TESTED: 'feature_tested',         // 功能测试 - 完成功能测试
  FEATURE_DEPLOYED: 'feature_deployed',     // 功能部署 - 功能上线运行
  
  // 新增类型 - 性能优化相关
  PERFORMANCE_ISSUE_DETECTED: 'performance_issue_detected', // 性能问题检测
  PERFORMANCE_IMPROVED: 'performance_improved', // 性能改进
  OPTIMIZATION_COMPLETED: 'optimization_completed', // 优化完成
  
  // 新增类型 - 系统运维相关
  SYSTEM_STARTED: 'system_started',         // 系统启动
  SYSTEM_RECOVERED: 'system_recovered',     // 系统恢复
  SYSTEM_UPGRADED: 'system_upgraded',       // 系统升级
  SYSTEM_BACKUP_CREATED: 'system_backup_created', // 系统备份
  SYSTEM_RESTORED: 'system_restored',       // 系统恢复
  
  // 新增类型 - 文档与知识相关
  DOCUMENTATION_CREATED: 'documentation_created', // 文档创建
  DOCUMENTATION_UPDATED: 'documentation_updated', // 文档更新
  DOCUMENTATION_REVIEWED: 'documentation_reviewed', // 文档审查
  KNOWLEDGE_CAPTURED: 'knowledge_captured', // 知识捕获
  DECISION_RECORDED: 'decision_recorded',   // 决策记录
  
  // 新增类型 - 安全与合规相关
  SECURITY_ISSUE_DETECTED: 'security_issue_detected', // 安全问题检测
  SECURITY_ENHANCED: 'security_enhanced',   // 安全增强
  COMPLIANCE_VERIFIED: 'compliance_verified', // 合规验证
  CONSTITUTION_UPDATED: 'constitution_updated', // 宪法更新
  
  // 新增类型 - 用户体验相关
  USER_FEEDBACK_RECEIVED: 'user_feedback_received', // 用户反馈
  USER_EXPERIENCE_IMPROVED: 'user_experience_improved', // 用户体验改进
  ACCESSIBILITY_ENHANCED: 'accessibility_enhanced', // 可访问性增强
  
  // 新增类型 - 协作与集成相关
  INTEGRATION_COMPLETED: 'integration_completed', // 集成完成
  API_ENDPOINT_ADDED: 'api_endpoint_added', // API端点添加
  THIRD_PARTY_SERVICE_CONNECTED: 'third_party_service_connected', // 第三方服务连接
  
  // 新增类型 - 监控与告警相关
  MONITORING_ADDED: 'monitoring_added',     // 监控添加
  ALERT_TRIGGERED: 'alert_triggered',       // 告警触发
  ALERT_RESOLVED: 'alert_resolved',         // 告警解决
};

/**
 * 事件类型分类
 */
const EVOLUTION_CATEGORIES = {
  PROBLEM_MANAGEMENT: [EVOLUTION_TYPES.PROBLEM_DETECTED, EVOLUTION_TYPES.PROBLEM_SOLVED, EVOLUTION_TYPES.WORKAROUND_IMPLEMENTED],
  FEATURE_DEVELOPMENT: [EVOLUTION_TYPES.FEATURE_REQUESTED, EVOLUTION_TYPES.FEATURE_DESIGNED, EVOLUTION_TYPES.FEATURE_IMPLEMENTED, EVOLUTION_TYPES.FEATURE_TESTED, EVOLUTION_TYPES.FEATURE_DEPLOYED],
  PERFORMANCE_OPTIMIZATION: [EVOLUTION_TYPES.PERFORMANCE_ISSUE_DETECTED, EVOLUTION_TYPES.PERFORMANCE_IMPROVED, EVOLUTION_TYPES.OPTIMIZATION_COMPLETED],
  SYSTEM_OPERATIONS: [EVOLUTION_TYPES.SYSTEM_STARTED, EVOLUTION_TYPES.SYSTEM_RECOVERED, EVOLUTION_TYPES.SYSTEM_UPGRADED, EVOLUTION_TYPES.SYSTEM_BACKUP_CREATED, EVOLUTION_TYPES.SYSTEM_RESTORED],
  DOCUMENTATION_KNOWLEDGE: [EVOLUTION_TYPES.DOCUMENTATION_CREATED, EVOLUTION_TYPES.DOCUMENTATION_UPDATED, EVOLUTION_TYPES.DOCUMENTATION_REVIEWED, EVOLUTION_TYPES.KNOWLEDGE_CAPTURED, EVOLUTION_TYPES.DECISION_RECORDED],
  SECURITY_COMPLIANCE: [EVOLUTION_TYPES.SECURITY_ISSUE_DETECTED, EVOLUTION_TYPES.SECURITY_ENHANCED, EVOLUTION_TYPES.COMPLIANCE_VERIFIED, EVOLUTION_TYPES.CONSTITUTION_UPDATED],
  USER_EXPERIENCE: [EVOLUTION_TYPES.USER_FEEDBACK_RECEIVED, EVOLUTION_TYPES.USER_EXPERIENCE_IMPROVED, EVOLUTION_TYPES.ACCESSIBILITY_ENHANCED],
  INTEGRATION_MONITORING: [EVOLUTION_TYPES.INTEGRATION_COMPLETED, EVOLUTION_TYPES.API_ENDPOINT_ADDED, EVOLUTION_TYPES.THIRD_PARTY_SERVICE_CONNECTED, EVOLUTION_TYPES.MONITORING_ADDED, EVOLUTION_TYPES.ALERT_TRIGGERED, EVOLUTION_TYPES.ALERT_RESOLVED],
  LEARNING_COGNITION: [EVOLUTION_TYPES.LEARNING]
};

/**
 * 事件严重程度级别
 */
const SEVERITY_LEVELS = {
  CRITICAL: 'critical',     // 关键 - 系统不可用或数据丢失
  HIGH: 'high',             // 高 - 主要功能受影响
  MEDIUM: 'medium',         // 中 - 次要功能受影响
  LOW: 'low',               // 低 - 轻微影响
  INFO: 'info'              // 信息 - 无影响，仅记录
};

/**
 * 事件影响范围
 */
const IMPACT_SCOPES = {
  SYSTEM_WIDE: 'system_wide',       // 全系统影响
  MULTIPLE_COMPONENTS: 'multiple_components', // 多组件影响
  SINGLE_COMPONENT: 'single_component', // 单个组件影响
  USER_SPECIFIC: 'user_specific',   // 特定用户影响
  NO_IMPACT: 'no_impact'            // 无影响
};

/**
 * 解决方案效果评估
 */
const SOLUTION_EFFECTIVENESS = {
  COMPLETE: 'complete',     // 完全解决
  PARTIAL: 'partial',       // 部分解决
  WORKAROUND: 'workaround', // 临时解决方案
  INEFFECTIVE: 'ineffective', // 无效
  UNKNOWN: 'unknown'        // 效果未知
};

/**
 * 验证状态
 */
const VERIFICATION_STATUS = {
  NOT_VERIFIED: 'not_verified',     // 未验证
  SELF_VERIFIED: 'self_verified',   // 自验证
  USER_VERIFIED: 'user_verified',   // 用户验证
  SYSTEM_VERIFIED: 'system_verified', // 系统验证
  EXTERNAL_VERIFIED: 'external_verified' // 外部验证
};

/**
 * 获取事件类型描述
 * @param {string} type - 事件类型
 * @returns {string} 类型描述
 */
function getEventTypeDescription(type) {
  const descriptions = {
    [EVOLUTION_TYPES.LEARNING]: '系统学习新知识或认知更新',
    [EVOLUTION_TYPES.PROBLEM_DETECTED]: '检测到系统问题',
    [EVOLUTION_TYPES.PROBLEM_SOLVED]: '成功解决系统问题',
    [EVOLUTION_TYPES.WORKAROUND_IMPLEMENTED]: '实施临时解决方案',
    [EVOLUTION_TYPES.FEATURE_REQUESTED]: '用户请求新功能',
    [EVOLUTION_TYPES.FEATURE_DESIGNED]: '完成功能设计',
    [EVOLUTION_TYPES.FEATURE_IMPLEMENTED]: '完成功能开发',
    [EVOLUTION_TYPES.FEATURE_TESTED]: '完成功能测试',
    [EVOLUTION_TYPES.FEATURE_DEPLOYED]: '功能上线运行',
    [EVOLUTION_TYPES.PERFORMANCE_ISSUE_DETECTED]: '检测到性能问题',
    [EVOLUTION_TYPES.PERFORMANCE_IMPROVED]: '性能得到改进',
    [EVOLUTION_TYPES.OPTIMIZATION_COMPLETED]: '优化完成',
    [EVOLUTION_TYPES.SYSTEM_STARTED]: '系统启动',
    [EVOLUTION_TYPES.SYSTEM_RECOVERED]: '系统恢复运行',
    [EVOLUTION_TYPES.SYSTEM_UPGRADED]: '系统升级',
    [EVOLUTION_TYPES.SYSTEM_BACKUP_CREATED]: '创建系统备份',
    [EVOLUTION_TYPES.SYSTEM_RESTORED]: '系统从备份恢复',
    [EVOLUTION_TYPES.DOCUMENTATION_CREATED]: '创建新文档',
    [EVOLUTION_TYPES.DOCUMENTATION_UPDATED]: '更新现有文档',
    [EVOLUTION_TYPES.DOCUMENTATION_REVIEWED]: '审查文档',
    [EVOLUTION_TYPES.KNOWLEDGE_CAPTURED]: '捕获重要知识',
    [EVOLUTION_TYPES.DECISION_RECORDED]: '记录重要决策',
    [EVOLUTION_TYPES.SECURITY_ISSUE_DETECTED]: '检测到安全问题',
    [EVOLUTION_TYPES.SECURITY_ENHANCED]: '安全得到增强',
    [EVOLUTION_TYPES.COMPLIANCE_VERIFIED]: '合规性验证',
    [EVOLUTION_TYPES.CONSTITUTION_UPDATED]: '更新项目宪法',
    [EVOLUTION_TYPES.USER_FEEDBACK_RECEIVED]: '收到用户反馈',
    [EVOLUTION_TYPES.USER_EXPERIENCE_IMPROVED]: '用户体验改进',
    [EVOLUTION_TYPES.ACCESSIBILITY_ENHANCED]: '可访问性增强',
    [EVOLUTION_TYPES.INTEGRATION_COMPLETED]: '完成系统集成',
    [EVOLUTION_TYPES.API_ENDPOINT_ADDED]: '添加API端点',
    [EVOLUTION_TYPES.THIRD_PARTY_SERVICE_CONNECTED]: '连接第三方服务',
    [EVOLUTION_TYPES.MONITORING_ADDED]: '添加监控',
    [EVOLUTION_TYPES.ALERT_TRIGGERED]: '触发告警',
    [EVOLUTION_TYPES.ALERT_RESOLVED]: '解决告警'
  };
  
  return descriptions[type] || '未知事件类型';
}

/**
 * 获取事件类型分类
 * @param {string} type - 事件类型
 * @returns {string} 分类名称
 */
function getEventCategory(type) {
  for (const [category, types] of Object.entries(EVOLUTION_CATEGORIES)) {
    if (types.includes(type)) {
      return category;
    }
  }
  return 'UNCATEGORIZED';
}

/**
 * 判断事件类型是否有效
 * @param {string} type - 事件类型
 * @returns {boolean} 是否有效
 */
function isValidEventType(type) {
  return Object.values(EVOLUTION_TYPES).includes(type);
}

/**
 * 获取所有事件类型
 * @returns {Array} 所有事件类型数组
 */
function getAllEventTypes() {
  return Object.values(EVOLUTION_TYPES);
}

/**
 * 获取按分类分组的事件类型
 * @returns {Object} 按分类分组的事件类型
 */
function getEventTypesByCategory() {
  return EVOLUTION_CATEGORIES;
}

module.exports = {
  EVOLUTION_TYPES,
  EVOLUTION_CATEGORIES,
  SEVERITY_LEVELS,
  IMPACT_SCOPES,
  SOLUTION_EFFECTIVENESS,
  VERIFICATION_STATUS,
  getEventTypeDescription,
  getEventCategory,
  isValidEventType,
  getAllEventTypes,
  getEventTypesByCategory
};