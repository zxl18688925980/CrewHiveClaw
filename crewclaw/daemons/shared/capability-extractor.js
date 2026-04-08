/**
 * 能力提取器 (Capability Extractor)
 * 从对话中识别需要的能力
 */

const capabilityRegistry = require('./capability-registry');

class CapabilityExtractor {
  constructor() {
    // 意图到能力映射
    this.intentToCapability = {
      'develop_feature': ['daemon_lisa', 'daemon_andy'],
      'bug_fix': ['daemon_lisa'],
      'optimize': ['daemon_lisa'],
      'refactor': ['daemon_andy', 'daemon_lisa'],
      'update_doc': ['daemon_lisa'],
      'research': ['daemon_andy'],
      'control_device': ['app_smart_home'],
      'play_music': ['app_music'],
      'check_weather': ['app_weather'],
      'chat': ['daemon_homeai']
    };

    // 关键词到能力映射
    this.keywordToCapability = {
      '开发': ['daemon_andy', 'daemon_lisa'],
      '写代码': ['daemon_lisa'],
      '修复': ['daemon_lisa'],
      '优化': ['daemon_lisa'],
      '设计': ['daemon_andy'],
      '架构': ['daemon_andy'],
      '调研': ['daemon_andy'],
      '研究': ['daemon_andy'],
      '控制': ['app_smart_home'],
      '开关': ['app_smart_home'],
      '播放': ['app_music'],
      '音乐': ['app_music'],
      '天气': ['app_weather'],
      '查询': ['daemon_homeai'],
      '对话': ['daemon_homeai']
    };
  }

  /**
   * 从消息中提取需要的能力
   */
  async extract(message, intentType = null) {
    const matchedCapabilities = new Set();

    // 1. 根据意图类型匹配
    if (intentType && this.intentToCapability[intentType]) {
      this.intentToCapability[intentType].forEach(capId => {
        matchedCapabilities.add(capId);
      });
    }

    // 2. 根据关键词匹配
    const lowerMessage = message.toLowerCase();
    for (const [keyword, capIds] of Object.entries(this.keywordToCapability)) {
      if (lowerMessage.includes(keyword)) {
        capIds.forEach(capId => matchedCapabilities.add(capId));
      }
    }

    // 3. 向量检索匹配（如果知识库可用）
    try {
      const vectorMatches = await this.vectorSearch(message);
      vectorMatches.forEach(cap => matchedCapabilities.add(cap.id));
    } catch (e) {
      // 知识库不可用时跳过
    }

    // 获取能力详情
    const capabilities = Array.from(matchedCapabilities).map(id => {
      const cap = capabilityRegistry.get(id);
      return cap ? {
        id: cap.id,
        name: cap.name,
        capability: cap.capability,
        description: cap.description,
        matchReason: this.getMatchReason(message, intentType, cap)
      } : null;
    }).filter(Boolean);

    return {
      message,
      intentType,
      matchedCapabilities: capabilities,
      confidence: this.calculateConfidence(capabilities),
      extractedAt: new Date().toISOString()
    };
  }

  /**
   * 向量检索匹配
   */
  async vectorSearch(message) {
    // 简化实现：直接搜索
    const allCaps = capabilityRegistry.getAll();
    return allCaps.slice(0, 3); // 返回前3个作为示例
  }

  /**
   * 获取匹配原因
   */
  getMatchReason(message, intentType, capability) {
    if (intentType && this.intentToCapability[intentType]?.includes(capability.id)) {
      return `意图类型 "${intentType}" 匹配`;
    }

    const lowerMessage = message.toLowerCase();
    for (const [keyword, capIds] of Object.entries(this.keywordToCapability)) {
      if (capIds.includes(capability.id) && lowerMessage.includes(keyword)) {
        return `关键词 "${keyword}" 匹配`;
      }
    }

    return '向量检索匹配';
  }

  /**
   * 计算置信度
   */
  calculateConfidence(capabilities) {
    if (capabilities.length === 0) return 0;
    if (capabilities.length === 1) return 0.9;
    if (capabilities.length === 2) return 0.7;
    return 0.5;
  }

  /**
   * 建议能力组合
   */
  suggestCombinations(requirements) {
    const combinations = [];

    // 基于需求推荐组合
    const hasDesign = requirements.some(r => r.includes('设计') || r.includes('架构'));
    const hasCode = requirements.some(r => r.includes('开发') || r.includes('代码'));

    if (hasDesign && hasCode) {
      combinations.push({
        name: '完整开发流程',
        capabilities: ['daemon_andy', 'daemon_lisa'],
        description: 'Andy负责设计，Lisa负责实现'
      });
    } else if (hasCode) {
      combinations.push({
        name: '直接实现',
        capabilities: ['daemon_lisa'],
        description: 'Lisa直接完成编码任务'
      });
    }

    return combinations;
  }
}

const capabilityExtractor = new CapabilityExtractor();

module.exports = capabilityExtractor;
