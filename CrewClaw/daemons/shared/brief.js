/**
 * Brief 生成和维护模块
 * 从项目宪法自动生成 Brief（≤500 chars）
 * 存储位置：homeai/shared/brief.md
 *
 * v345.1: 使用统一路径配置模块
 */

const fs = require('fs').promises;
const path = require('path');

const BRIEF_PATH = path.join(__dirname, 'brief.md');
// __dirname = homeclaw/daemons/shared，上三级到 ~/HomeAI/
const CONSTITUTION_PATH = path.join(__dirname, '../../../docs/04-project-constitution.md');

class BriefManager {
  constructor() {
    this.brief = null;
    this.lastGenerated = null;
  }

  /**
   * 从宪法生成 Brief
   */
  async generateFromConstitution() {
    try {
      const constitution = await fs.readFile(CONSTITUTION_PATH, 'utf8');

      // 提取关键信息生成 Brief
      const briefSections = [];

      // 1. 项目愿景
      const visionMatch = constitution.match(/#{1,2}\s*项目愿景[^\n]*\n([^\n]+)/);
      if (visionMatch) {
        briefSections.push(`愿景：${visionMatch[1].trim()}`);
      }

      // 2. 核心角色
      const rolesSection = constitution.match(/#{1,2}\s*角色定义[^\n]*\n([\s\S]*?)(?=#{1,2}\s*[^角色]|##\s*约束|$)/);
      if (rolesSection) {
        const roles = [];
        if (rolesSection[1].includes('HomeAI')) roles.push('HomeAI(家庭顾问)');
        if (rolesSection[1].includes('Andy')) roles.push('Andy(架构大师)');
        if (rolesSection[1].includes('Lisa')) roles.push('Lisa(编码专家)');
        if (roles.length > 0) {
          briefSections.push(`角色：${roles.join(' → ')}`);
        }
      }

      // 3. 核心约束
      const constraints = [];
      if (constitution.includes('稳定性约束')) {
        constraints.push('稳定优先');
      }
      if (constitution.includes('安全性约束')) {
        constraints.push('安全第一');
      }
      if (constitution.includes('不可破坏')) {
        constraints.push('核心功能不可破坏');
      }
      if (constraints.length > 0) {
        briefSections.push(`约束：${constraints.join('、')}`);
      }

      // 4. 协作流程
      briefSections.push('流程：需求→HomeAI→Andy(设计)→Lisa(实现)→交付');

      // 5. 关键目标
      briefSections.push('目标：可自进化、可复制、能集中沉淀');

      // 生成 Brief 文本，确保 ≤500 chars
      let briefText = briefSections.join('\n');
      if (briefText.length > 500) {
        briefText = briefText.substring(0, 497) + '...';
      }

      this.brief = briefText;
      this.lastGenerated = new Date().toISOString();

      return this.brief;
    } catch (error) {
      console.error('生成 Brief 失败:', error.message);
      // 返回默认 Brief
      return this.getDefaultBrief();
    }
  }

  /**
   * 获取默认 Brief
   */
  getDefaultBrief() {
    return `HomeAI 智慧家庭中枢
角色：HomeAI(家庭顾问) → Andy(架构大师) → Lisa(编码专家)
约束：稳定优先、安全第一、核心功能不可破坏
流程：需求→HomeAI→Andy(设计)→Lisa(实现)→交付
目标：可自进化、可复制、能集中沉淀`;
  }

  /**
   * 保存 Brief 到文件
   */
  async save() {
    try {
      const content = `# Brief - 项目宪法摘要

> 自动生成，请勿手动修改
> 最后更新：${this.lastGenerated || new Date().toISOString()}

${this.brief || this.getDefaultBrief()}

---
字符数：${(this.brief || this.getDefaultBrief()).length}`;
      await fs.writeFile(BRIEF_PATH, content, 'utf8');
      console.log(`✅ Brief 已保存到 ${BRIEF_PATH}`);
      return true;
    } catch (error) {
      console.error('保存 Brief 失败:', error.message);
      return false;
    }
  }

  /**
   * 加载现有 Brief
   */
  async load() {
    try {
      const content = await fs.readFile(BRIEF_PATH, 'utf8');
      // 提取 Brief 内容（跳过标题和元数据）
      const lines = content.split('\n');
      let inContent = false;
      const briefLines = [];

      for (const line of lines) {
        if (line.startsWith('---') || line.startsWith('>')) {
          inContent = true;
          continue;
        }
        if (inContent && line.trim()) {
          briefLines.push(line);
        }
      }

      this.brief = briefLines.join('\n').trim();
      return this.brief;
    } catch (error) {
      // 文件不存在，生成新的
      return await this.generateAndSave();
    }
  }

  /**
   * 生成并保存 Brief
   */
  async generateAndSave() {
    await this.generateFromConstitution();
    await this.save();
    return this.brief;
  }

  /**
   * 获取 Brief 用于注入到 prompt
   */
  async getBrief() {
    if (!this.brief) {
      await this.load();
    }
    return this.brief || this.getDefaultBrief();
  }

  /**
   * 检查 Brief 是否需要更新
   */
  async needsUpdate() {
    try {
      const stats = await fs.stat(BRIEF_PATH);
      const lastModified = new Date(stats.mtime);
      const now = new Date();
      // 超过24小时需要更新
      const hoursDiff = (now - lastModified) / (1000 * 60 * 60);
      return hoursDiff > 24;
    } catch {
      return true;
    }
  }

  /**
   * 定期更新 Brief
   */
  async ensureFresh() {
    if (await this.needsUpdate()) {
      console.log('Brief 已过期，正在重新生成...');
      await this.generateAndSave();
    }
    return this.brief;
  }
}

// 创建单例实例
const briefManager = new BriefManager();

module.exports = briefManager;
