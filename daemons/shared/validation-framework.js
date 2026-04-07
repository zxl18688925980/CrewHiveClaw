/**
 * 四层验证框架模块
 * L1: 数据一致性验证
 * L2: 约束合规性验证
 * L3: 决策一致性验证
 * L4: 需求覆盖度验证
 */

const { knowledgeBase, REQUIREMENT_STATUS } = require('./knowledge-base');

class ValidationFramework {
  constructor() {
    this.validationResults = [];
  }

  /**
   * L1: 数据一致性验证
   * 验证设备名/配置与 DataStore 的一致性
   */
  async validateDataConsistency(data, datastore) {
    const errors = [];
    const warnings = [];

    // 检查必需字段
    const requiredFields = data.requiredFields || [];
    for (const field of requiredFields) {
      if (!data[field] && data[field] !== 0) {
        errors.push({
          layer: 'L1',
          type: 'missing_field',
          field,
          message: `缺少必需字段: ${field}`
        });
      }
    }

    // 检查数据类型
    const fieldTypes = data.fieldTypes || {};
    for (const [field, expectedType] of Object.entries(fieldTypes)) {
      if (data[field] !== undefined) {
        const actualType = typeof data[field];
        if (actualType !== expectedType) {
          errors.push({
            layer: 'L1',
            type: 'type_mismatch',
            field,
            expected: expectedType,
            actual: actualType,
            message: `字段 ${field} 类型不匹配: 期望 ${expectedType}, 实际 ${actualType}`
          });
        }
      }
    }

    // 检查设备配置一致性（如果有 DataStore）
    if (datastore && data.deviceId) {
      const storedDevice = datastore[data.deviceId];
      if (storedDevice) {
        // 验证配置值是否一致
        const configFields = ['name', 'type', 'location'];
        for (const field of configFields) {
          if (data[field] && storedDevice[field] && data[field] !== storedDevice[field]) {
            warnings.push({
              layer: 'L1',
              type: 'config_mismatch',
              field,
              message: `设备: ${field} 在数据中是配置不一致 "${data[field]}", 在存储中是 "${storedDevice[field]}"`
            });
          }
        }
      }
    }

    return {
      layer: 'L1',
      passed: errors.length === 0,
      errors,
      warnings,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * L2: 约束合规性验证
   * 验证是否满足宪法约束和用户明确约束
   */
  async validateConstraintCompliance(design) {
    const violations = [];
    const warnings = [];

    // 获取所有约束
    const constraints = await knowledgeBase.constraint_list();

    // 检查每个约束
    for (const constraint of constraints) {
      const result = this.checkConstraint(design, constraint);
      if (!result.compliant) {
        if (constraint.priority === 'critical') {
          violations.push({
            layer: 'L2',
            type: 'constraint_violation',
            constraint_id: constraint.id,
            constraint: constraint.content,
            severity: 'critical',
            message: `违反关键约束: ${constraint.content}`
          });
        } else {
          warnings.push({
            layer: 'L2',
            type: 'constraint_warning',
            constraint_id: constraint.id,
            constraint: constraint.content,
            severity: constraint.priority,
            message: `可能违反约束: ${constraint.content}`
          });
        }
      }
    }

    // 额外检查稳定性约束
    if (design.changes && design.changes.length > 0) {
      const hasRollback = design.rollbackPlan || design.canRollback;
      if (!hasRollback) {
        warnings.push({
          layer: 'L2',
          type: 'stability_constraint',
          message: '改动缺少回滚计划，可能违反稳定性约束'
        });
      }
    }

    return {
      layer: 'L2',
      passed: violations.length === 0,
      violations,
      warnings,
      constraints_checked: constraints.length,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 检查单个约束是否被满足
   */
  checkConstraint(design, constraint) {
    const content = constraint.content.toLowerCase();

    // 稳定性约束检查
    if (constraint.type === 'stability') {
      if (content.includes('回滚') && !design.rollbackPlan && !design.canRollback) {
        return { compliant: false, reason: '缺少回滚计划' };
      }
      if (content.includes('破坏') && content.includes('现有功能')) {
        if (design.destroysExisting) {
          return { compliant: false, reason: '设计会破坏现有功能' };
        }
      }
    }

    // 安全性约束检查
    if (constraint.type === 'safety') {
      if (content.includes('敏感信息') && design.exposesSensitiveData) {
        return { compliant: false, reason: '设计会暴露敏感信息' };
      }
      if (content.includes('删除用户数据') && design.deletesUserData) {
        return { compliant: false, reason: '设计会删除用户数据' };
      }
    }

    // 兼容性约束检查
    if (constraint.type === 'compatibility') {
      if (content.includes('api') && design.breaksAPI) {
        return { compliant: false, reason: '设计会破坏 API 兼容性' };
      }
    }

    return { compliant: true };
  }

  /**
   * L3: 决策一致性验证
   * 验证文档内容与已记录的设计决策是否矛盾
   */
  async validateDecisionConsistency(design, designDocument) {
    const contradictions = [];
    const warnings = [];

    // 获取所有已记录的决策
    const existingDecisions = await knowledgeBase.decision_list({
      type: design.type || 'design'
    });

    // 检查每个决策与当前设计的一致性
    for (const decision of existingDecisions) {
      // 简单的关键词冲突检测
      const decisionKeywords = this.extractKeywords(decision.title + ' ' + decision.description);
      const designKeywords = this.extractKeywords(
        (designDocument || '') + ' ' + JSON.stringify(design)
      );

      // 检查是否有明显的矛盾
      const contradictions = this.findContradictions(decision, design, designDocument);
      contradictions.push(...contradictions);
    }

    // 检查设计中的决策是否被记录
    if (design.decisions && Array.isArray(design.decisions)) {
      for (const designDecision of design.decisions) {
        const isRecorded = existingDecisions.some(
          d => d.title === designDecision.title || d.description === designDecision.description
        );
        if (!isRecorded) {
          warnings.push({
            layer: 'L3',
            type: 'unrecorded_decision',
            message: `设计决策未被记录: ${designDecision.title || designDecision}`
          });
        }
      }
    }

    return {
      layer: 'L3',
      passed: contradictions.length === 0,
      contradictions,
      warnings,
      decisions_checked: existingDecisions.length,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 提取关键词
   */
  extractKeywords(text) {
    return text.toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 3);
  }

  /**
   * 查找矛盾
   */
  findContradictions(decision, design, document) {
    const contradictions = [];
    const decisionText = (decision.title + ' ' + decision.description).toLowerCase();
    const designText = JSON.stringify(design).toLowerCase();

    // 检测常见的矛盾模式
    const contradictionPatterns = [
      { keywords: ['不使用', '禁止', '禁用'], conflict: ['使用', '采用', '启用'] },
      { keywords: ['只能'], conflict: ['可以', '支持', '允许'] }
    ];

    for (const pattern of contradictionPatterns) {
      const hasDecisionNegation = pattern.keywords.some(k => decisionText.includes(k));
      const hasDesignAffirmation = pattern.conflict.some(k => designText.includes(k));

      if (hasDecisionNegation && hasDesignAffirmation) {
        contradictions.push({
          layer: 'L3',
          type: 'decision_contradiction',
          decision_id: decision.id,
          message: `设计与已有决策矛盾: ${decision.title}`
        });
      }
    }

    return contradictions;
  }

  /**
   * L4: 需求覆盖度验证
   * 验证所有 must 需求是否被设计覆盖
   */
  async validateRequirementCoverage(design, designDocument = '') {
    const uncovered = [];
    const partial = [];
    const covered = [];

    // 获取所有未完成的需求
    const requirements = await knowledgeBase.requirement_list();

    for (const req of requirements) {
      // 只检查 must 和 should 优先级
      if (req.priority !== 'must' && req.priority !== 'should') {
        continue;
      }

      // 检查需求是否被设计覆盖
      const coverage = this.checkRequirementCoverage(req, design, designDocument);

      if (coverage === 'covered') {
        covered.push(req);
      } else if (coverage === 'partial') {
        partial.push(req);
      } else {
        if (req.priority === 'must') {
          uncovered.push(req);
        }
      }
    }

    return {
      layer: 'L4',
      passed: uncovered.length === 0,
      covered: covered.length,
      partial: partial.length,
      uncovered: uncovered,
      uncovered_must: uncovered.filter(r => r.priority === 'must'),
      requirements_checked: requirements.length,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 检查单个需求的覆盖情况
   */
  checkRequirementCoverage(requirement, design, document) {
    const reqText = requirement.content.toLowerCase();
    const designText = (JSON.stringify(design) + ' ' + document).toLowerCase();

    // 简单关键词匹配
    const reqKeywords = reqText.split(/\s+/).filter(w => w.length > 2);
    let matchCount = 0;

    for (const keyword of reqKeywords) {
      if (designText.includes(keyword)) {
        matchCount++;
      }
    }

    if (matchCount === 0) {
      return 'uncovered';
    } else if (matchCount < reqKeywords.length * 0.5) {
      return 'partial';
    } else {
      return 'covered';
    }
  }

  /**
   * 执行完整四层验证
   */
  async validate(design, options = {}) {
    const results = {
      summary: {
        totalLayers: 4,
        passedLayers: 0,
        failedLayers: 0,
        timestamp: new Date().toISOString()
      },
      layers: {}
    };

    // L1: 数据一致性
    if (options.skipL1 !== true) {
      const l1Result = await this.validateDataConsistency(
        design.data || {},
        options.datastore
      );
      results.layers.L1 = l1Result;
      if (l1Result.passed) results.summary.passedLayers++;
      else results.summary.failedLayers++;
    }

    // L2: 约束合规性
    if (options.skipL2 !== true) {
      const l2Result = await this.validateConstraintCompliance(design);
      results.layers.L2 = l2Result;
      if (l2Result.passed) results.summary.passedLayers++;
      else results.summary.failedLayers++;
    }

    // L3: 决策一致性
    if (options.skipL3 !== true) {
      const l3Result = await this.validateDecisionConsistency(
        design,
        options.designDocument || ''
      );
      results.layers.L3 = l3Result;
      if (l3Result.passed) results.summary.passedLayers++;
      else results.summary.failedLayers++;
    }

    // L4: 需求覆盖度
    if (options.skipL4 !== true) {
      const l4Result = await this.validateRequirementCoverage(
        design,
        options.designDocument || ''
      );
      results.layers.L4 = l4Result;
      if (l4Result.passed) results.summary.passedLayers++;
      else results.summary.failedLayers++;
    }

    results.summary.allPassed = results.summary.passedLayers === results.summary.totalLayers;

    return results;
  }

  /**
   * 生成验证报告
   */
  generateReport(validationResults) {
    let report = '# 验证报告\n\n';

    report += '## 摘要\n';
    report += `- 通过层级: ${validationResults.summary.passedLayers}/${validationResults.summary.totalLayers}\n`;
    report += `- 总体结果: ${validationResults.summary.allPassed ? '✅ 通过' : '❌ 未通过'}\n\n`;

    // L1
    if (validationResults.layers.L1) {
      const l1 = validationResults.layers.L1;
      report += `## L1: 数据一致性 ${l1.passed ? '✅' : '❌'}\n`;
      if (l1.errors.length > 0) {
        report += '### 错误\n';
        for (const err of l1.errors) {
          report += `- ${err.message}\n`;
        }
      }
      report += '\n';
    }

    // L2
    if (validationResults.layers.L2) {
      const l2 = validationResults.layers.L2;
      report += `## L2: 约束合规性 ${l2.passed ? '✅' : '❌'}\n`;
      if (l2.violations.length > 0) {
        report += '### 违规\n';
        for (const v of l2.violations) {
          report += `- [${v.severity}] ${v.message}\n`;
        }
      }
      report += '\n';
    }

    // L3
    if (validationResults.layers.L3) {
      const l3 = validationResults.layers.L3;
      report += `## L3: 决策一致性 ${l3.passed ? '✅' : '❌'}\n`;
      if (l3.contradictions.length > 0) {
        report += '### 矛盾\n';
        for (const c of l3.contradictions) {
          report += `- ${c.message}\n`;
        }
      }
      report += '\n';
    }

    // L4
    if (validationResults.layers.L4) {
      const l4 = validationResults.layers.L4;
      report += `## L4: 需求覆盖度 ${l4.passed ? '✅' : '❌'}\n`;
      report += `- 已覆盖: ${l4.covered}\n`;
      report += `- 部分覆盖: ${l4.partial}\n`;
      if (l4.uncovered.length > 0) {
        report += '### 未覆盖的 must 需求\n';
        for (const req of l4.uncovered) {
          report += `- ${req.content} (状态: ${req.status})\n`;
        }
      }
      report += '\n';
    }

    return report;
  }
}

// 创建单例实例
const validationFramework = new ValidationFramework();

module.exports = {
  validationFramework,
  ValidationFramework
};
