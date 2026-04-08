/**
 * 能力学习模块 (Capability Learner)
 * 功能: 分析执行记录，学习用户习惯，生成增强决策建议
 * 核心: 从执行结果中学习，决定是否需要增强能力
 */

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

class CapabilityLearner {
  constructor() {
    // 学习阈值配置
    this.config = {
      minSampleSize: 5,        // 最少样本数才开始分析
      successRateThreshold: 0.6,  // 成功率低于此值建议增强
      avgTimeThreshold: 10000,    // 平均执行时间超过此值建议优化
      userFeedbackWeight: 0.3,    // 用户反馈权重
    };

    // 学习模式
    this.modes = {
      PASSIVE: 'passive',    // 被动学习：仅记录
      ACTIVE: 'active',      // 主动学习：分析并建议
      AUTO: 'auto'          // 自动学习：自动优化
    };

    this.currentMode = this.modes.ACTIVE;
  }

  /**
   * 学习主入口
   */
  async learn(executionHistory) {
    console.log('🧠 开始能力学习...');

    const analysis = {
      timestamp: new Date().toISOString(),
      totalExecutions: executionHistory.length,
      insights: [],
      recommendations: []
    };

    if (executionHistory.length < this.config.minSampleSize) {
      console.log(`  ⏳ 样本不足: ${executionHistory.length} < ${this.config.minSampleSize}`);
      return analysis;
    }

    // 1. 分析成功率
    const successAnalysis = this.analyzeSuccessRate(executionHistory);
    analysis.insights.push(successAnalysis);

    // 2. 分析执行时间
    const timeAnalysis = this.analyzeExecutionTime(executionHistory);
    analysis.insights.push(timeAnalysis);

    // 3. 分析用户习惯
    const habitAnalysis = this.analyzeUserHabits(executionHistory);
    analysis.insights.push(habitAnalysis);

    // 4. 分析能力组合效果
    const comboAnalysis = await this.analyzeCapabilityCombos(executionHistory);
    analysis.insights.push(comboAnalysis);

    // 5. 生成增强建议
    analysis.recommendations = this.generateRecommendations(analysis.insights);

    console.log(`  📊 生成 ${analysis.recommendations.length} 条建议`);

    // 保存分析结果
    this.saveAnalysis(analysis);

    return analysis;
  }

  /**
   * 分析成功率
   */
  analyzeSuccessRate(history) {
    const byCapability = {};

    for (const record of history) {
      const name = record.capabilityName;
      if (!byCapability[name]) {
        byCapability[name] = { success: 0, failed: 0, error: 0 };
      }

      if (record.status === 'success') byCapability[name].success++;
      else if (record.status === 'failed') byCapability[name].failed++;
      else if (record.status === 'error') byCapability[name].error++;
    }

    const results = [];

    for (const [name, stats] of Object.entries(byCapability)) {
      const total = stats.success + stats.failed + stats.error;
      const rate = stats.success / total;

      results.push({
        capability: name,
        total,
        successRate: rate,
        needsEnhancement: rate < this.config.successRateThreshold
      });
    }

    return {
      type: 'success_rate',
      data: results,
      summary: `${results.filter(r => r.needsEnhancement).length} 个能力需要增强`
    };
  }

  /**
   * 分析执行时间
   */
  analyzeExecutionTime(history) {
    const byCapability = {};

    for (const record of history) {
      if (!record.executionTime) continue;

      const name = record.capabilityName;
      if (!byCapability[name]) {
        byCapability[name] = [];
      }
      byCapability[name].push(record.executionTime);
    }

    const results = [];

    for (const [name, times] of Object.entries(byCapability)) {
      if (times.length === 0) continue;

      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const max = Math.max(...times);
      const min = Math.min(...times);

      results.push({
        capability: name,
        avgTime: Math.round(avg),
        maxTime: max,
        minTime: min,
        count: times.length,
        needsOptimization: avg > this.config.avgTimeThreshold
      });
    }

    return {
      type: 'execution_time',
      data: results,
      summary: `${results.filter(r => r.needsOptimization).length} 个能力需要优化性能`
    };
  }

  /**
   * 分析用户习惯
   */
  analyzeUserHabits(history) {
    // 按时间段统计
    const byHour = new Array(24).fill(0);
    const intents = {};

    for (const record of history) {
      // 提取时间
      const hour = new Date(record.startTime).getHours();
      byHour[hour]++;

      // 提取意图（从输入中）
      const input = JSON.stringify(record.input);
      const intentMatch = input.match(/"intent"\s*:\s*"([^"]+)"/);
      if (intentMatch) {
        const intent = intentMatch[1];
        intents[intent] = (intents[intent] || 0) + 1;
      }
    }

    // 找出高峰时段
    const peakHours = byHour
      .map((count, hour) => ({ hour, count }))
      .filter(h => h.count > 0)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map(h => `${h.hour}:00`);

    // 找出常用意图
    const topIntents = Object.entries(intents)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([intent, count]) => ({ intent, count }));

    return {
      type: 'user_habits',
      data: {
        peakHours,
        topIntents
      },
      summary: `用户活跃时段: ${peakHours.join(', ')}`
    };
  }

  /**
   * 分析能力组合效果
   */
  async analyzeCapabilityCombos(history) {
    // 查找连续执行的能力组合
    const combos = {};

    for (let i = 1; i < history.length; i++) {
      const prev = history[i - 1];
      const curr = history[i];

      // 如果是连续执行（时间间隔<1分钟）
      const timeDiff = new Date(curr.startTime) - new Date(prev.endTime);
      if (timeDiff < 60000) {
        const comboKey = `${prev.capabilityName} → ${curr.capabilityName}`;

        if (!combos[comboKey]) {
          combos[comboKey] = { count: 0, success: 0 };
        }

        combos[comboKey].count++;
        if (curr.status === 'success') combos[comboKey].success++;
      }
    }

    const results = [];

    for (const [combo, stats] of Object.entries(combos)) {
      if (stats.count >= 2) {  // 至少出现2次
        results.push({
          combo,
          count: stats.count,
          successRate: stats.success / stats.count,
          effectiveness: this.calculateEffectiveness(stats)
        });
      }
    }

    // 按效果排序
    results.sort((a, b) => b.effectiveness - a.effectiveness);

    return {
      type: 'capability_combos',
      data: results.slice(0, 10),
      summary: `发现 ${results.length} 种能力组合模式`
    };
  }

  /**
   * 计算组合效果
   */
  calculateEffectiveness(stats) {
    // 简单效果计算：成功率 * 频率
    const rate = stats.success / stats.count;
    const frequency = Math.min(stats.count / 10, 1); // 最多10次为满分
    return rate * 0.7 + frequency * 0.3;
  }

  /**
   * 生成增强建议
   */
  generateRecommendations(insights) {
    const recommendations = [];

    // 从成功率分析生成建议
    const successInsight = insights.find(i => i.type === 'success_rate');
    if (successInsight) {
      for (const cap of successInsight.data) {
        if (cap.needsEnhancement) {
          recommendations.push({
            type: 'enhance_capability',
            priority: 'high',
            capability: cap.capability,
            reason: `成功率低: ${Math.round(cap.successRate * 100)}%`,
            suggestion: this.suggestEnhancement(cap.capability)
          });
        }
      }
    }

    // 从执行时间分析生成建议
    const timeInsight = insights.find(i => i.type === 'execution_time');
    if (timeInsight) {
      for (const cap of timeInsight.data) {
        if (cap.needsOptimization) {
          recommendations.push({
            type: 'optimize_performance',
            priority: 'medium',
            capability: cap.capability,
            reason: `平均执行时间: ${cap.avgTime}ms`,
            suggestion: '考虑添加缓存、优化算法或异步处理'
          });
        }
      }
    }

    // 从用户习惯生成建议
    const habitInsight = insights.find(i => i.type === 'user_habits');
    if (habitInsight) {
      const { peakHours, topIntents } = habitInsight.data;

      if (peakHours.length > 0) {
        recommendations.push({
          type: 'optimize_resources',
          priority: 'low',
          reason: `高峰时段: ${peakHours.join(', ')}`,
          suggestion: '可在高峰时段前预热服务'
        });
      }
    }

    // 排序：优先级高的在前
    const priorityOrder = { high: 0, medium: 1, low: 2 };
    recommendations.sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority]);

    return recommendations;
  }

  /**
   * 建议增强方式
   */
  suggestEnhancement(capabilityName) {
    const suggestions = {
      'Lisa编码': '分析错误类型，考虑添加更详细的错误处理或预检查',
      'Andy架构设计': '增加设计模式知识库，提高方案生成质量',
      'HomeAI对话': '优化意图识别，增加更多训练语料',
      'default': '检查接口定义，增加输入验证，提供更详细的错误信息'
    };

    return suggestions[capabilityName] || suggestions['default'];
  }

  /**
   * 保存分析结果
   */
  saveAnalysis(analysis) {
    const analysisDir = path.join(paths.paths.data.evolution.base, 'capabilities');
    if (!fs.existsSync(analysisDir)) {
      fs.mkdirSync(analysisDir, { recursive: true });
    }

    const filePath = path.join(analysisDir, 'latest_analysis.json');
    fs.writeFileSync(filePath, JSON.stringify(analysis, null, 2));

    // 同时保存到历史
    const historyPath = path.join(analysisDir, 'analysis_history.json');
    let history = [];

    if (fs.existsSync(historyPath)) {
      try {
        history = JSON.parse(fs.readFileSync(historyPath, 'utf8'));
      } catch (e) {
        history = [];
      }
    }

    history.push(analysis);

    // 只保留最近30次分析
    if (history.length > 30) {
      history = history.slice(-30);
    }

    fs.writeFileSync(historyPath, JSON.stringify(history, null, 2));
  }

  /**
   * 加载最新分析结果
   */
  loadLatestAnalysis() {
    const filePath = path.join(paths.paths.data.evolution.base, 'capabilities', 'latest_analysis.json');

    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        return null;
      }
    }

    return null;
  }

  /**
   * 生成能力增强报告（供 Andy 使用）
   */
  generateEnhancementReport() {
    const analysis = this.loadLatestAnalysis();

    if (!analysis) {
      return '# 能力增强报告\n\n暂无分析数据';
    }

    let report = '# 能力增强报告\n\n';
    report += `> 生成时间: ${analysis.timestamp}\n`;
    report += `> 总执行次数: ${analysis.totalExecutions}\n\n`;

    report += '## 分析摘要\n\n';
    report += analysis.insights.map(i => `- ${i.summary}`).join('\n');

    if (analysis.recommendations.length > 0) {
      report += '\n## 增强建议\n\n';

      for (const rec of analysis.recommendations) {
        report += `### ${rec.priority.toUpperCase()}: ${rec.type}\n\n`;
        report += `- 能力: ${rec.capability || 'N/A'}\n`;
        report += `- 原因: ${rec.reason}\n`;
        report += `- 建议: ${rec.suggestion}\n\n`;
      }
    } else {
      report += '\n## 结论\n\n✅ 所有能力运行正常，无需增强\n';
    }

    return report;
  }
}

const capabilityLearner = new CapabilityLearner();

module.exports = capabilityLearner;
