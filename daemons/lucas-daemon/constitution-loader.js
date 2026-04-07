/**
 * 项目宪法加载器
 * 负责加载和解析项目宪法，强化角色认知与协调模式
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const winston = require('winston');

// 日志配置
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.Console()
  ]
});

class ConstitutionLoader {
  constructor() {
    this.constitution = null;
    this.roles = {
      lucas: null,
      andy: null,
      lisa: null
    };
    this.constraints = {
      stability: [],
      safety: [],
      compatibility: [],
      decision: []
    };
    this.coordinationRules = [];
  }

  /**
   * 加载项目宪法
   */
  async loadConstitution() {
    try {
      const constitutionPath = path.join(__dirname, '../../../docs/04-project-constitution.md');
      
      const content = await fsp.readFile(constitutionPath, 'utf8');
      this.constitution = content;
      
      logger.info('项目宪法加载成功', { 
        size: content.length,
        path: constitutionPath 
      });
      
      // 解析宪法内容
      await this.parseConstitution();
      
      return true;
    } catch (error) {
      logger.error('加载项目宪法失败', { error: error.message });
      return false;
    }
  }

  /**
   * 解析宪法内容
   */
  async parseConstitution() {
    if (!this.constitution) return;

    // 解析角色职责
    this.parseRoles();
    
    // 解析约束条件
    this.parseConstraints();
    
    // 解析协作规则
    this.parseCoordinationRules();
    
    logger.info('项目宪法解析完成', {
      roles: Object.keys(this.roles).filter(k => this.roles[k]),
      constraints: Object.keys(this.constraints).map(k => ({
        type: k,
        count: this.constraints[k].length
      })),
      coordinationRules: this.coordinationRules.length
    });
  }

  /**
   * 解析角色职责
   */
  parseRoles() {
    const lines = this.constitution.split('\n');
    
    // 查找角色职责部分
    let inRolesSection = false;
    let currentRole = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // 查找角色职责标题
      if (line.includes('### 角色职责简要说明')) {
        inRolesSection = true;
        continue;
      }
      
      if (inRolesSection && line.includes('###')) {
        // 进入下一节，结束解析
        break;
      }
      
      if (inRolesSection) {
        // 解析 HomeAI 角色
        if (line.includes('**HomeAI**') || line.includes('业务架构师')) {
          currentRole = 'lucas';
          this.roles.lucas = this.extractRoleDescription(lines, i);
        }
        
        // 解析 Andy 角色
        if (line.includes('**Andy**') || line.includes('架构大师')) {
          currentRole = 'andy';
          this.roles.andy = this.extractRoleDescription(lines, i);
        }
        
        // 解析 Lisa 角色
        if (line.includes('**Lisa**') || line.includes('编码专家')) {
          currentRole = 'lisa';
          this.roles.lisa = this.extractRoleDescription(lines, i);
        }
      }
    }
    
    // 如果没有找到详细角色描述，使用默认描述
    if (!this.roles.lucas) {
      this.roles.lucas = {
        name: '曾璿岐霖',
        role: '业务架构师',
        responsibilities: [
          '对话交互、意图识别',
          '任务编排、协调 Andy 和 Lisa',
          '长记忆存储、家庭认知',
          '设备管理、家庭服务'
        ],
        constraints: [
          '必须遵守项目宪法所有约束',
          '不得绕过 Andy 直接调用 Lisa',
          '必须记录所有决策和变更'
        ]
      };
    }
  }

  /**
   * 提取角色描述
   */
  extractRoleDescription(lines, startIndex) {
    const description = {
      name: '',
      role: '',
      responsibilities: [],
      constraints: []
    };
    
    for (let i = startIndex; i < Math.min(startIndex + 20, lines.length); i++) {
      const line = lines[i];
      
      if (line.includes('**名称**') || line.includes('**Name**')) {
        description.name = line.split('：')[1] || line.split(':')[1] || '';
      }
      
      if (line.includes('**角色**') || line.includes('**Role**')) {
        description.role = line.split('：')[1] || line.split(':')[1] || '';
      }
      
      if (line.includes('**职责**') || line.includes('**Responsibilities**')) {
        // 提取职责列表
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const respLine = lines[j];
          if (respLine.trim().startsWith('- ') || respLine.trim().startsWith('* ')) {
            description.responsibilities.push(respLine.trim().substring(2));
          } else if (respLine.trim() === '' || respLine.includes('**')) {
            break;
          }
        }
      }
      
      if (line.includes('**约束**') || line.includes('**Constraints**')) {
        // 提取约束列表
        for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
          const constrLine = lines[j];
          if (constrLine.trim().startsWith('- ') || constrLine.trim().startsWith('* ')) {
            description.constraints.push(constrLine.trim().substring(2));
          } else if (constrLine.trim() === '' || constrLine.includes('**')) {
            break;
          }
        }
      }
    }
    
    return description;
  }

  /**
   * 解析约束条件
   */
  parseConstraints() {
    const lines = this.constitution.split('\n');
    
    let currentSection = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // 检测章节标题
      if (line.startsWith('### ')) {
        const title = line.substring(4).toLowerCase();
        
        if (title.includes('稳定性约束')) {
          currentSection = 'stability';
        } else if (title.includes('安全性约束')) {
          currentSection = 'safety';
        } else if (title.includes('兼容性约束')) {
          currentSection = 'compatibility';
        } else if (title.includes('决策约束')) {
          currentSection = 'decision';
        } else {
          currentSection = null;
        }
        continue;
      }
      
      // 解析约束规则
      if (currentSection && (line.trim().startsWith('- ') || line.trim().startsWith('* '))) {
        const constraint = {
          rule: line.trim().substring(2),
          section: currentSection,
          lineNumber: i + 1
        };
        
        this.constraints[currentSection].push(constraint);
      }
    }
  }

  /**
   * 解析协作规则
   */
  parseCoordinationRules() {
    // 默认协作规则
    this.coordinationRules = [
      {
        rule: 'HomeAI 负责接收用户需求，进行意图识别',
        priority: 1
      },
      {
        rule: '开发需求必须通过 Andy 进行架构设计',
        priority: 1
      },
      {
        rule: 'Lisa 只能接收来自 Andy 的设计文档进行实现',
        priority: 1
      },
      {
        rule: '所有变更必须记录到决策日志',
        priority: 2
      },
      {
        rule: '重大变更必须人工审批',
        priority: 3
      },
      {
        rule: '禁止绕过宪法约束',
        priority: 3
      }
    ];
    
    // 尝试从宪法中提取更多规则
    const lines = this.constitution.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      if (line.includes('协作') && line.includes('规则')) {
        for (let j = i + 1; j < Math.min(i + 20, lines.length); j++) {
          const ruleLine = lines[j];
          if (ruleLine.trim().startsWith('- ') || ruleLine.trim().startsWith('* ')) {
            this.coordinationRules.push({
              rule: ruleLine.trim().substring(2),
              priority: 2,
              source: 'constitution'
            });
          } else if (ruleLine.trim() === '' || ruleLine.includes('###')) {
            break;
          }
        }
      }
    }
  }

  /**
   * 获取角色强化提示
   * @param {string} role - 角色名称
   * @returns {string} 强化提示
   */
  getRoleEnhancementPrompt(role) {
    if (!this.roles[role]) {
      return '';
    }
    
    const roleInfo = this.roles[role];
    const constraints = this.getRoleConstraints(role);
    
    return `
作为 ${roleInfo.name || roleInfo.role}，你必须遵守以下宪法规定：

角色职责：
${roleInfo.responsibilities.map(r => `- ${r}`).join('\n')}

宪法约束：
${constraints.map(c => `- ${c.rule}`).join('\n')}

协作规则：
${this.coordinationRules.slice(0, 5).map(r => `- ${r.rule}`).join('\n')}

请严格按照以上规定执行你的职责。
    `.trim();
  }

  /**
   * 获取角色相关约束
   */
  getRoleConstraints(role) {
    const roleConstraints = [];
    
    // 添加通用约束
    roleConstraints.push(...this.constraints.stability);
    roleConstraints.push(...this.constraints.safety);
    roleConstraints.push(...this.constraints.compatibility);
    
    // 添加决策约束（对 Andy 和 Lisa 特别重要）
    if (role === 'andy' || role === 'lisa') {
      roleConstraints.push(...this.constraints.decision);
    }
    
    return roleConstraints.slice(0, 10); // 返回前10个最重要的约束
  }

  /**
   * 获取协调模式提示
   */
  getCoordinationPrompt() {
    return `
项目宪法规定的协作模式：

1. 用户需求 → HomeAI（意图识别）
2. 开发需求 → Andy（架构设计）
3. 设计文档 → Lisa（代码实现）
4. 实现结果 → HomeAI（验证交付）
5. 所有步骤 → 记录到决策日志

禁止绕过任何环节，所有变更必须符合宪法约束。
    `.trim();
  }

  /**
   * 验证决策是否符合宪法
   * @param {Object} decision - 决策内容
   * @returns {Object} 验证结果
   */
  validateDecision(decision) {
    const violations = [];
    
    // 检查稳定性约束
    for (const constraint of this.constraints.stability) {
      if (this.checkConstraintViolation(decision, constraint)) {
        violations.push({
          type: 'stability',
          constraint: constraint.rule,
          severity: 'high'
        });
      }
    }
    
    // 检查安全性约束
    for (const constraint of this.constraints.safety) {
      if (this.checkConstraintViolation(decision, constraint)) {
        violations.push({
          type: 'safety',
          constraint: constraint.rule,
          severity: 'critical'
        });
      }
    }
    
    return {
      valid: violations.length === 0,
      violations,
      message: violations.length > 0 
        ? `发现 ${violations.length} 个宪法违规`
        : '决策符合宪法规定'
    };
  }

  /**
   * 检查约束违规
   */
  checkConstraintViolation(decision, constraint) {
    const decisionText = JSON.stringify(decision).toLowerCase();
    const constraintText = constraint.rule.toLowerCase();
    
    // 简单关键词匹配（实际应该更复杂）
    const dangerKeywords = ['删除', '破坏', '绕过', '禁用', '关闭', '停止'];
    for (const keyword of dangerKeywords) {
      if (constraintText.includes(keyword) && decisionText.includes(keyword)) {
        return true;
      }
    }
    
    return false;
  }

  /**
   * 获取宪法摘要
   */
  getSummary() {
    return {
      loaded: !!this.constitution,
      roles: Object.keys(this.roles).reduce((acc, key) => {
        if (this.roles[key]) acc[key] = this.roles[key].role || key;
        return acc;
      }, {}),
      constraintCounts: {
        stability: this.constraints.stability.length,
        safety: this.constraints.safety.length,
        compatibility: this.constraints.compatibility.length,
        decision: this.constraints.decision.length
      },
      coordinationRules: this.coordinationRules.length
    };
  }
}

module.exports = ConstitutionLoader;