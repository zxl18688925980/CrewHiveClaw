/**
 * 能力管理系统 (Capability Manager)
 * 整合能力发现、执行、学习三大模块
 * 核心: 实现自进化系统的自我感知和优化
 *
 * 分层能力查找逻辑:
 * 1. 本地能力 - 已有的Skill/MCP/软件
 * 2. 社区能力 - OpenClaw社区/第三方MCP
 * 3. Andy设计 - 组合现有能力或开发新Skill/软件
 */

const capabilityDiscovery = require('./capability-discovery');
const capabilityExecutor = require('./capability-executor');
const capabilityLearner = require('./capability-learner');
const layeredCapabilityFinder = require('./layered-capability-finder');

class CapabilityManager {
  constructor() {
    this.isInitialized = false;
  }

  /**
   * 初始化能力管理系统
   */
  async initialize() {
    console.log('🚀 初始化能力管理系统...');

    // 1. 发现能力
    await capabilityDiscovery.discover();

    // 2. 检查是否有新能力
    const newCapabilities = capabilityDiscovery.checkForNewCapabilities();

    if (newCapabilities.length > 0) {
      console.log(`🎉 检测到 ${newCapabilities.length} 个新能力!`);
    }

    // 3. 保存发现的能力列表
    capabilityDiscovery.savePreviousCapabilities();

    this.isInitialized = true;
    console.log('✅ 能力管理系统初始化完成');
  }

  /**
   * 执行能力
   */
  async execute(capabilityId, input, context = {}) {
    const capability = capabilityDiscovery.discoveredCapabilities.get(capabilityId);

    if (!capability) {
      return {
        success: false,
        error: `能力不存在: ${capabilityId}`
      };
    }

    return await capabilityExecutor.execute(capability, input, context);
  }

  /**
   * 搜索能力
   */
  search(query) {
    return capabilityDiscovery.search(query);
  }

  /**
   * 分层能力查找（核心方法）
   * 用户任务诉求进来，先查找本地，再查找社区，最后触发Andy设计
   */
  async findCapabilities(task) {
    console.log(`\n🎯 开始处理任务: "${task}"`);

    // 使用分层查找器
    const result = await layeredCapabilityFinder.findCapabilities(task);

    // 根据推荐行动
    if (result.finalRecommendation.action === 'USE_LOCAL') {
      console.log('✅ 建议使用本地能力');
      return result;
    }

    if (result.finalRecommendation.action === 'USE_COMMUNITY') {
      console.log('📦 建议安装社区能力');
      return result;
    }

    // 需要Andy设计
    console.log('📝 需要Andy设计实现');

    // 返回Andy设计所需信息
    return result;
  }

  /**
   * Andy设计时调用MCP查资料
   */
  async andyConsultMCP(query, mcpType = 'websearch') {
    return await layeredCapabilityFinder.andyConsultMCP(query, mcpType);
  }

  /**
   * 获取所有能力
   */
  getAllCapabilities() {
    return capabilityDiscovery.getAll();
  }

  /**
   * 学习能力使用模式
   */
  async learn() {
    const history = capabilityExecutor.getHistory();

    if (history.length === 0) {
      console.log('⏳ 没有执行历史可学习');
      return null;
    }

    return await capabilityLearner.learn(history);
  }

  /**
   * 获取能力统计
   */
  getStatistics() {
    return capabilityExecutor.getStatistics();
  }

  /**
   * 获取增强建议
   */
  getEnhancementRecommendations() {
    return capabilityLearner.generateEnhancementReport();
  }

  /**
   * 周期性任务
   */
  async runPeriodicTasks() {
    console.log('🔄 执行能力管理系统周期任务...');

    // 1. 重新发现能力（可能有新增）
    await capabilityDiscovery.discover();

    // 2. 学习执行模式
    await this.learn();

    console.log('✅ 周期任务完成');
  }
}

// 单例
const capabilityManager = new CapabilityManager();

module.exports = capabilityManager;
