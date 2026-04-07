/**
 * 角色定义加载器
 * 从 skills/SKILL.md 文件加载角色定义
 */

const fs = require('fs').promises;
const path = require('path');

const SKILLS_PATH = path.join(__dirname, '../../skills');

class RoleLoader {
  constructor() {
    this.roles = {};
    this.initialized = false;
  }

  /**
   * 加载所有角色的 SKILL.md
   */
  async initialize() {
    if (this.initialized) return;

    const skillDirs = ['homeai_skill', 'andy_skill', 'lisa_skill'];

    for (const dir of skillDirs) {
      const skillPath = path.join(SKILLS_PATH, dir, 'SKILL.md');
      try {
        const content = await fs.readFile(skillPath, 'utf8');
        const roleName = dir.replace('_skill', '').toLowerCase();
        this.roles[roleName] = this.parseSkillMd(content, roleName);
        console.log(`✅ 角色定义已加载: ${roleName}`);
      } catch (e) {
        console.log(`⚠️ 加载角色定义失败: ${dir}`, e.message);
      }
    }

    this.initialized = true;
  }

  /**
   * 解析 SKILL.md 内容
   */
  parseSkillMd(content, roleName) {
    // 提取角色定义
    const roleDefMatch = content.match(/我是\s*([^，。\n]+)/);
    const roleDef = roleDefMatch ? roleDefMatch[1] : roleName;

    // 提取职责列表
    const responsibilities = [];
    const respMatch = content.match(/##\s*职责\s*([\s\S]*?)(?=##|$)/);
    if (respMatch) {
      const lines = respMatch[1].split('\n');
      for (const line of lines) {
        const match = line.match(/^\d+\.\s*(.+)/);
        if (match) {
          responsibilities.push(match[1].trim());
        }
      }
    }

    // 提取系统约束
    const constraints = [];
    const constrMatch = content.match(/##\s*系统约束\s*([\s\S]*?)(?=##|$)/);
    if (constrMatch) {
      const lines = constrMatch[1].split('\n');
      for (const line of lines) {
        if (line.trim() && !line.startsWith('#')) {
          constraints.push(line.trim());
        }
      }
    }

    return {
      roleName,
      roleDef,
      responsibilities,
      constraints,
      raw: content.substring(0, 500) // 保留原始内容片段
    };
  }

  /**
   * 获取角色定义
   */
  getRole(roleName) {
    return this.roles[roleName.toLowerCase()] || null;
  }

  /**
   * 获取所有角色
   */
  getAllRoles() {
    return this.roles;
  }

  /**
   * 生成角色提示词
   */
  getRolePrompt(roleName, options = {}) {
    const role = this.getRole(roleName);
    if (!role) return null;

    const { includeResponsibilities = true, includeConstraints = true } = options;

    let prompt = `你是 ${role.roleDef}。`;

    if (includeResponsibilities && role.responsibilities.length > 0) {
      prompt += `\n\n职责：\n`;
      role.responsibilities.forEach((r, i) => {
        prompt += `${i + 1}. ${r}\n`;
      });
    }

    if (includeConstraints && role.constraints.length > 0) {
      prompt += `\n系统约束：\n`;
      role.constraints.forEach(c => {
        prompt += `- ${c}\n`;
      });
    }

    return prompt;
  }
}

// 单例实例
const roleLoader = new RoleLoader();

module.exports = {
  roleLoader,
  RoleLoader
};
