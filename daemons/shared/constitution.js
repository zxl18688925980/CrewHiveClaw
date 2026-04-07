/**
 * 共享宪法模块
 * 供 HomeAI、Andy、Lisa 三个守护进程使用
 */

const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');

class SharedConstitution {
  constructor() {
    this.constitution = null;
    this.parsedData = {
      roles: {},
      constraints: {},
      coordinationRules: []
    };
    this.loaded = false;
  }

  /**
   * 加载宪法（单例模式）
   */
  async load() {
    if (this.loaded) return true;
    
    try {
      const constitutionPath = path.join(__dirname, '../../../docs/04-project-constitution.md');
      const content = await fsp.readFile(constitutionPath, 'utf8');
      this.constitution = content;
      this.loaded = true;
      
      // 解析宪法
      await this.parse();
      
      console.log(`✅ 宪法加载成功 (${content.length} 字符)`);
      return true;
    } catch (error) {
      console.error('❌ 宪法加载失败:', error.message);
      return false;
    }
  }

  /**
   * 解析宪法内容
   */
  async parse() {
    if (!this.constitution) return;
    
    const lines = this.constitution.split('\n');
    
    // 解析角色信息
    this.parseRoles(lines);
    
    // 解析约束条件
    this.parseConstraints(lines);
    
    // 解析协作规则
    this.parseCoordinationRules(lines);
    
    console.log('📊 宪法解析完成:', {
      roles: Object.keys(this.parsedData.roles),
      constraints: Object.keys(this.parsedData.constraints).map(k => ({
        type: k,
        count: this.parsedData.constraints[k].length
      })),
      coordinationRules: this.parsedData.coordinationRules.length
    });
  }

  /**
   * 解析角色信息
   */
  parseRoles(lines) {
    // 默认角色定义（如果宪法中没有明确定义）
    this.parsedData.roles = {
      homeai: {
        name: '曾璿岐霖',
        role: '家庭顾问',
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
      },
      andy: {
        name: 'Andy',
        role: '架构大师',
        responsibilities: [
          '需求分析、架构设计',
          '计划制定、质量把控',
          '文档维护、决策记录',
          '协调 Lisa 进行实现'
        ],
        constraints: [
          '必须遵守技术选型约束',
          '必须进行架构变更评估',
          '必须记录设计决策',
          '不得绕过宪法约束'
        ]
      },
      lisa: {
        name: 'Lisa',
        role: '编码专家',
        responsibilities: [
          '代码生成、调试修复',
          '系统集成、单元测试',
          'E2E测试、功能验收',
          '代码优化、性能调优'
        ],
        constraints: [
          '必须遵守代码规范',
          '必须编写测试用例',
          '必须进行代码审查',
          '不得绕过宪法约束'
        ]
      }
    };
    
    // 尝试从宪法中提取更详细的角色信息
    // （这里可以添加更复杂的解析逻辑）
  }

  /**
   * 解析约束条件
   */
  parseConstraints(lines) {
    this.parsedData.constraints = {
      stability: [],
      safety: [],
      compatibility: [],
      decision: []
    };
    
    let currentSection = null;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
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
      
      if (currentSection && (line.trim().startsWith('- ') || line.trim().startsWith('* '))) {
        this.parsedData.constraints[currentSection].push({
          rule: line.trim().substring(2),
          line: i + 1
        });
      }
    }
  }

  /**
   * 解析协作规则
   */
  parseCoordinationRules(lines) {
    this.parsedData.coordinationRules = [
      'HomeAI 负责接收用户需求，进行意图识别',
      '开发需求必须通过 Andy 进行架构设计',
      'Lisa 只能接收来自 Andy 的设计文档进行实现',
      '所有变更必须记录到决策日志',
      '重大变更必须人工审批',
      '禁止绕过宪法约束'
    ];
  }

  /**
   * 获取角色强化提示
   */
  getRolePrompt(role) {
    if (!this.parsedData.roles[role]) {
      return this.getDefaultRolePrompt(role);
    }
    
    const roleInfo = this.parsedData.roles[role];
    const constraints = this.getRoleConstraints(role);
    
    return `
作为 ${roleInfo.name}（${roleInfo.role}），你必须严格遵守项目宪法：

你的职责：
${roleInfo.responsibilities.map(r => `• ${r}`).join('\n')}

宪法约束：
${constraints.map(c => `• ${c.rule}`).join('\n')}

协作规则：
${this.parsedData.coordinationRules.map(r => `• ${r}`).join('\n')}

请严格按照以上规定执行你的工作，确保系统稳定、安全、可协作。
    `.trim();
  }

  /**
   * 获取默认角色提示
   */
  getDefaultRolePrompt(role) {
    const prompts = {
      homeai: `你是曾璿岐霖，曾家的小儿子贾维斯，家庭智能助手。你必须遵守项目宪法，协调 Andy 和 Lisa 完成开发任务。`,
      andy: `你是 Andy，架构大师。你必须遵守项目宪法，负责需求分析、架构设计，并协调 Lisa 进行实现。`,
      lisa: `你是 Lisa，编码专家。你必须遵守项目宪法，根据 Andy 的设计文档生成代码，并确保代码质量。`
    };
    
    return prompts[role] || `你是 ${role}，必须遵守项目宪法。`;
  }

  /**
   * 获取角色相关约束
   */
  getRoleConstraints(role) {
    const allConstraints = [];
    
    // 添加通用约束
    allConstraints.push(...this.parsedData.constraints.stability);
    allConstraints.push(...this.parsedData.constraints.safety);
    allConstraints.push(...this.parsedData.constraints.compatibility);
    
    // 添加决策约束（对 Andy 和 Lisa 特别重要）
    if (role === 'andy' || role === 'lisa') {
      allConstraints.push(...this.parsedData.constraints.decision);
    }
    
    // 添加角色特定约束
    if (this.parsedData.roles[role] && this.parsedData.roles[role].constraints) {
      this.parsedData.roles[role].constraints.forEach(constraint => {
        allConstraints.push({ rule: constraint });
      });
    }
    
    return allConstraints.slice(0, 15); // 返回前15个最重要的约束
  }

  /**
   * 验证决策是否符合宪法
   */
  validateDecision(role, decision, context = {}) {
    const violations = [];
    const decisionStr = JSON.stringify(decision).toLowerCase();
    
    // 检查危险操作
    const dangerKeywords = ['删除', '破坏', '绕过', '禁用', '关闭', '停止', '移除'];
    const dangerTargets = ['核心功能', '宪法', '约束', '安全', '稳定'];
    
    for (const keyword of dangerKeywords) {
      if (decisionStr.includes(keyword)) {
        for (const target of dangerTargets) {
          if (decisionStr.includes(target)) {
            violations.push({
              type: 'safety',
              rule: `禁止${keyword}${target}`,
              severity: 'critical',
              decision: decisionStr
            });
          }
        }
      }
    }
    
    // 角色特定检查
    if (role === 'andy') {
      // Andy 必须进行架构评估
      if (!context.architectureReview && decision.type === 'architecture-change') {
        violations.push({
          type: 'decision',
          rule: '架构变更必须进行评估',
          severity: 'high'
        });
      }
    }
    
    if (role === 'lisa') {
      // Lisa 必须编写测试
      if (!context.hasTests && decision.type === 'code-implementation') {
        violations.push({
          type: 'decision',
          rule: '代码实现必须包含测试',
          severity: 'high'
        });
      }
    }
    
    return {
      valid: violations.length === 0,
      violations,
      timestamp: new Date().toISOString()
    };
  }

  /**
   * 获取宪法摘要
   */
  getSummary() {
    return {
      loaded: this.loaded,
      roles: Object.keys(this.parsedData.roles).reduce((acc, key) => {
        acc[key] = this.parsedData.roles[key].role;
        return acc;
      }, {}),
      constraints: Object.keys(this.parsedData.constraints).reduce((acc, key) => {
        acc[key] = this.parsedData.constraints[key].length;
        return acc;
      }, {}),
      coordinationRules: this.parsedData.coordinationRules.length
    };
  }

  /**
   * 获取协作流程图
   */
  getCoordinationFlow() {
    return `
用户需求
    ↓
HomeAI（意图识别）
    ↓
┌─ 聊天需求 → 直接回复
└─ 开发需求 → Andy（架构设计）
                ↓
            Lisa（代码实现）
                ↓
            HomeAI（验证交付）
                ↓
            记录到决策日志
    `.trim();
  }
}

// 创建单例实例
const constitutionInstance = new SharedConstitution();

module.exports = constitutionInstance;