/**
 * 生成检查模块
 * 包含：生成前检查、生成后自动更新
 */

const { knowledgeBase, REQUIREMENT_STATUS } = require('./knowledge-base');
const { validationFramework } = require('./validation-framework');

class GenerationChecker {
  constructor() {
    this.checkResults = null;
  }

  /**
   * 生成前检查：检查未满足的 must 需求
   * @param {Object} options - 检查选项
   * @returns {Object} 检查结果
   */
  async preGenerationCheck(options = {}) {
    console.log('🔍 开始生成前检查...');

    const result = {
      canProceed: true,
      warnings: [],
      errors: [],
      unsatisfiedMustRequirements: [],
      checkedAt: new Date().toISOString()
    };

    try {
      // 1. 获取未满足的 must 需求
      const unsatisfiedMust = await knowledgeBase.requirement_get_unsatisfied_must();

      if (unsatisfiedMust.length > 0) {
        result.unsatisfiedMustRequirements = unsatisfiedMust;
        result.canProceed = false;

        for (const req of unsatisfiedMust) {
          result.errors.push({
            type: 'unsatisfied_must_requirement',
            requirement_id: req.id,
            content: req.content,
            current_status: req.status,
            message: `强制需求未满足: ${req.content} (当前状态: ${req.status})`
          });
        }

        result.errors.push({
          type: 'block',
          message: `存在 ${unsatisfiedMust.length} 个未满足的 must 需求，请先补充设计或确认是否继续`
        });
      }

      // 2. 检查是否有待处理的冲突需求
      const conflictRequirements = await knowledgeBase.requirement_list({
        status: REQUIREMENT_STATUS.CONFLICT
      });

      if (conflictRequirements.length > 0) {
        result.warnings.push({
          type: 'conflict_requirements',
          count: conflictRequirements.length,
          message: `存在 ${conflictRequirements.length} 个冲突状态的需求，可能需要人工干预`
        });
      }

      // 3. 检查约束合规性（快速检查）
      const constraints = await knowledgeBase.constraint_list({ priority: 'critical' });
      if (constraints.length === 0) {
        result.warnings.push({
          type: 'no_constraints',
          message: '系统中没有定义关键约束，请检查宪法配置'
        });
      }

      // 4. 检查决策记录（如果需要）
      if (options.requireDesignDoc) {
        const decisions = await knowledgeBase.decision_list();
        if (decisions.length === 0 && !options.allowNoDecisions) {
          result.warnings.push({
            type: 'no_decisions',
            message: '没有找到已记录的设计决策，请确保已完成架构设计'
          });
        }
      }

      this.checkResults = result;

      console.log(`✅ 生成前检查完成: ${result.canProceed ? '可以继续' : '需要阻断'}`);
      if (!result.canProceed) {
        console.log(`   未满足的 must 需求: ${unsatisfiedMust.length}`);
      }

      return result;
    } catch (error) {
      console.error('❌ 生成前检查失败:', error.message);
      return {
        canProceed: false,
        errors: [{ type: 'check_failed', message: error.message }],
        checkedAt: new Date().toISOString()
      };
    }
  }

  /**
   * 生成后自动更新
   * @param {Object} generationResult - 代码生成结果
   * @param {Object} options - 更新选项
   * @returns {Object} 更新结果
   */
  async postGenerationUpdate(generationResult, options = {}) {
    console.log('🔄 开始生成后自动更新...');

    const result = {
      success: true,
      updatedRequirements: [],
      addedDecisions: [],
      errors: [],
      updatedAt: new Date().toISOString()
    };

    try {
      // 1. 自动识别并更新需求状态
      if (options.relatedRequirements && Array.isArray(options.relatedRequirements)) {
        for (const reqId of options.relatedRequirements) {
          try {
            const updated = await knowledgeBase.requirement_update(reqId, {
              status: REQUIREMENT_STATUS.ADDRESSED
            });
            result.updatedRequirements.push({
              id: reqId,
              new_status: REQUIREMENT_STATUS.ADDRESSED
            });
            console.log(`   ✅ 需求 ${reqId} 状态已更新为 ADDRESSED`);
          } catch (error) {
            result.errors.push({
              type: 'update_failed',
              requirement_id: reqId,
              message: error.message
            });
          }
        }
      }

      // 2. 根据生成内容智能识别相关需求并更新
      if (generationResult.generatedContent) {
        const requirements = await knowledgeBase.requirement_list({
          status: REQUIREMENT_STATUS.OPEN
        });

        for (const req of requirements) {
          // 简单的关键词匹配
          const reqKeywords = req.content.toLowerCase().split(/\s+/).filter(w => w.length > 2);
          const contentText = generationResult.generatedContent.toLowerCase();
          const matchCount = reqKeywords.filter(k => contentText.includes(k)).length;

          // 如果匹配度超过50%，则认为已覆盖
          if (matchCount >= reqKeywords.length * 0.5) {
            try {
              const updated = await knowledgeBase.requirement_update(req.id, {
                status: REQUIREMENT_STATUS.ADDRESSED
              });
              result.updatedRequirements.push({
                id: req.id,
                new_status: REQUIREMENT_STATUS.ADDRESSED,
                matched_by: 'auto_detection'
              });
              console.log(`   ✅ 自动匹配需求 ${req.id} 并更新状态为 ADDRESSED`);
            } catch (error) {
              // 忽略更新失败
            }
          }
        }
      }

      // 3. 记录新决策（如果生成中包含设计决策）
      if (options.newDecisions && Array.isArray(options.newDecisions)) {
        for (const decision of options.newDecisions) {
          try {
            const added = await knowledgeBase.decision_add({
              title: decision.title,
              description: decision.description,
              type: decision.type || 'implementation',
              category: decision.category || 'code',
              related_requirements: options.relatedRequirements || [],
              created_by: 'Lisa'
            });
            result.addedDecisions.push(added);
            console.log(`   ✅ 决策已记录: ${decision.title}`);
          } catch (error) {
            result.errors.push({
              type: 'decision_add_failed',
              message: error.message
            });
          }
        }
      }

      // 4. 如果生成涉及重大变更，更新 Brief
      if (options.majorChange) {
        const brief = require('./brief');
        await brief.generateAndSave();
        result.briefUpdated = true;
        console.log('   ✅ Brief 已更新');
      }

      console.log(`✅ 生成后更新完成: 更新了 ${result.updatedRequirements.length} 个需求`);
      console.log(`   新增决策: ${result.addedDecisions.length} 条`);

      return result;
    } catch (error) {
      console.error('❌ 生成后更新失败:', error.message);
      return {
        success: false,
        errors: [{ type: 'update_failed', message: error.message }],
        updatedAt: new Date().toISOString()
      };
    }
  }

  /**
   * 验证通过后的需求确认（人工确认后调用）
   * @param {string} requirementId - 需求ID
   * @returns {Object} 更新结果
   */
  async confirmRequirementVerification(requirementId) {
    try {
      const updated = await knowledgeBase.requirement_update(requirementId, {
        status: REQUIREMENT_STATUS.VERIFIED
      });

      console.log(`✅ 需求 ${requirementId} 已确认为 VERIFIED`);

      return {
        success: true,
        requirement_id: requirementId,
        new_status: REQUIREMENT_STATUS.VERIFIED
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 冲突需求处理
   * @param {string} requirementId - 需求ID
   * @param {string} resolution - 解决方案描述
   * @param {string} resolutionType - 解决类型：addressed,superseded,invalid
   * @returns {Object} 处理结果
   */
  async resolveConflict(requirementId, resolution, resolutionType = 'addressed') {
    try {
      const newStatus = resolutionType === 'superseded' ?
        REQUIREMENT_STATUS.CONFLICT :
        REQUIREMENT_STATUS.ADDRESSED;

      const updated = await knowledgeBase.requirement_update(requirementId, {
        status: newStatus
      });

      // 记录解决决策
      await knowledgeBase.decision_add({
        title: `需求冲突解决: ${requirementId}`,
        description: resolution,
        type: 'conflict_resolution',
        category: 'resolution',
        related_requirements: [requirementId],
        created_by: 'system'
      });

      console.log(`✅ 需求冲突已解决: ${requirementId} -> ${newStatus}`);

      return {
        success: true,
        requirement_id: requirementId,
        resolution,
        new_status: newStatus
      };
    } catch (error) {
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 生成用户警告消息
   * @param {Object} checkResult - 检查结果
   * @returns {string} 警告消息
   */
  generateWarningMessage(checkResult) {
    if (checkResult.canProceed) {
      return '';
    }

    let message = '⚠️ 强制需求未满足，是否继续？\n\n';
    message += '未满足的 must 需求:\n';

    for (const req of checkResult.unsatisfiedMustRequirements) {
      message += `- ${req.content} (状态: ${req.status})\n`;
    }

    message += '\n您可以选择：\n';
    message += '1. 继续生成（不推荐）\n';
    message += '2. 先补充设计\n';
    message += '3. 确认需求已满足，手动更新状态\n';

    return message;
  }
}

// 创建单例实例
const generationChecker = new GenerationChecker();

module.exports = {
  generationChecker,
  GenerationChecker
};
