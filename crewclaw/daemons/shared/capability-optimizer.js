/**
 * 能力组合优化器 (Capability Optimizer)
 * 推荐能力组合方案
 */

const capabilityRegistry = require('./capability-registry');

class CapabilityOptimizer {
  constructor() {
    // 预定义的能力组合模板
    this.combinationTemplates = [
      {
        id: 'full_development',
        name: '完整开发流程',
        capabilities: ['daemon_andy', 'daemon_lisa'],
       适用场景: ['新功能开发', '系统重构', '复杂需求'],
        description: 'Andy负责架构设计，Lisa负责代码实现'
      },
      {
        id: 'quick_fix',
        name: '快速修复',
        capabilities: ['daemon_lisa'],
       适用场景: ['Bug修复', '小改动', '紧急修复'],
        description: 'Lisa直接完成修复任务'
      },
      {
        id: 'research_design',
        name: '调研设计',
        capabilities: ['daemon_andy'],
       适用场景: ['技术调研', '方案评估', '架构规划'],
        description: 'Andy进行深度分析和设计'
      },
      {
        id: 'smart_home',
        name: '智能家居控制',
        capabilities: ['app_smart_home', 'voice'],
       适用场景: ['设备控制', '场景联动', '自动化'],
        description: '语音控制智能设备'
      },
      {
        id: 'entertainment',
        name: '娱乐服务',
        capabilities: ['app_music', 'voice'],
       适用场景: ['播放音乐', '讲故事', '语音助手'],
        description: '语音娱乐服务'
      }
    ];
  }

  /**
   * 优化能力组合
   */
  optimize(message, extractedCapabilities) {
    const recommendations = [];

    // 1. 基于提取的能力推荐组合
    const capIds = extractedCapabilities.map(c => c.id);

    for (const template of this.combinationTemplates) {
      const matchCount = template.capabilities.filter(c => capIds.includes(c)).length;
      if (matchCount > 0) {
        recommendations.push({
          template: template.name,
          matchScore: matchCount / template.capabilities.length,
          capabilities: template.capabilities,
          description: template.description,
          reason: this.getMatchReason(matchCount, template.capabilities.length)
        });
      }
    }

    // 2. 添加完整开发流程（如果涉及开发）
    if (this.isDevelopmentRequest(message)) {
      recommendations.push({
        template: '完整开发流程',
        matchScore: 0.8,
        capabilities: ['daemon_andy', 'daemon_lisa'],
        description: 'Andy负责架构设计，Lisa负责代码实现',
        reason: '检测到开发相关需求'
      });
    }

    // 3. 添加智能家居（如果涉及控制）
    if (this.isControlRequest(message)) {
      recommendations.push({
        template: '智能家居控制',
        matchScore: 0.9,
        capabilities: ['app_smart_home'],
        description: '控制智能设备',
        reason: '检测到设备控制需求'
      });
    }

    // 按匹配度排序
    recommendations.sort((a, b) => b.matchScore - a.matchScore);

    return {
      originalRequest: message,
      extractedCapabilities: capIds,
      recommendations: recommendations.slice(0, 3),
      optimizedAt: new Date().toISOString()
    };
  }

  /**
   * 判断是否为开发请求
   */
  isDevelopmentRequest(message) {
    const keywords = ['开发', '编写', '实现', '创建', '设计', '架构', '开发', '写代码', '编程'];
    return keywords.some(k => message.includes(k));
  }

  /**
   * 判断是否为控制请求
   */
  isControlRequest(message) {
    const keywords = ['控制', '开关', '调节', '设置', '执行'];
    return keywords.some(k => message.includes(k));
  }

  /**
   * 获取匹配原因
   */
  getMatchReason(matchCount, totalCount) {
    const percentage = Math.round((matchCount / totalCount) * 100);
    return `${matchCount}/${totalCount} 能力匹配 (${percentage}%)`;
  }

  /**
   * 生成能力组合计划
   */
  generatePlan(requirements) {
    const plans = [];

    for (const req of requirements) {
      const plan = {
        requirement: req,
        selectedTemplate: null,
        executionOrder: []
      };

      // 选择最匹配的模板
      for (const template of this.combinationTemplates) {
        if (this.matchesRequirement(req, template)) {
          plan.selectedTemplate = template;
          plan.executionOrder = template.capabilities.map((capId, index) => ({
            order: index + 1,
            capabilityId: capId,
            capability: capabilityRegistry.get(capId)
          }));
          break;
        }
      }

      plans.push(plan);
    }

    return {
      requirements,
      plans,
      generatedAt: new Date().toISOString()
    };
  }

  /**
   * 匹配需求和模板
   */
  matchesRequirement(requirement, template) {
    const lowerReq = requirement.toLowerCase();
    return template.适用场景.some(scenario => lowerReq.includes(scenario));
  }
}

const capabilityOptimizer = new CapabilityOptimizer();

module.exports = capabilityOptimizer;
