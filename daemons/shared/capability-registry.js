/**
 * 能力注册表 (Capability Registry)
 * 记录和管理系统所有可用能力
 */

const fs = require('fs').promises;
const path = require('path');

class CapabilityRegistry {
  constructor() {
    this.capabilities = new Map();
    // 修复路径：__dirname = ~/HomeAI/homeai/shared/
    this.skillsPath = path.join(__dirname, '../../skills');
    this.appPath = path.join(__dirname, '../../app');
  }

  /**
   * 初始化能力注册表
   */
  async initialize() {
    // 从skills目录扫描能力
    await this.scanSkills();

    // 从app目录扫描能力
    await this.scanApps();

    // 扫描守护进程能力
    await this.scanDaemons();

    console.log(`✅ 能力注册表初始化完成: ${this.capabilities.size} 个能力`);
    return this.capabilities;
  }

  /**
   * 扫描skills目录
   */
  async scanSkills() {
    try {
      const entries = await fs.readdir(this.skillsPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillName = entry.name;
          const skillPath = path.join(this.skillsPath, skillName);

          // 读取SKILL.md获取能力描述
          let description = skillName;
          let capability = 'unknown';

          try {
            const skillMd = await fs.readFile(path.join(skillPath, 'SKILL.md'), 'utf8');
            const descMatch = skillMd.match(/description:\s*(.+)/);
            const nameMatch = skillMd.match(/name:\s*(.+)/);
            if (descMatch) description = descMatch[1].trim();
            if (nameMatch) capability = nameMatch[1].trim();
          } catch (e) {
            // SKILL.md不存在，使用默认描述
          }

          this.register({
            id: `skill_${skillName}`,
            name: skillName,
            type: 'skill',
            capability,
            description,
            path: skillPath,
            enabled: true
          });
        }
      }
    } catch (e) {
      console.warn('⚠️ 扫描skills目录失败:', e.message);
    }
  }

  /**
   * 扫描app目录
   */
  async scanApps() {
    try {
      const entries = await fs.readdir(this.appPath, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const appName = entry.name;

          this.register({
            id: `app_${appName}`,
            name: appName,
            type: 'app',
            capability: 'application',
            description: `应用: ${appName}`,
            path: path.join(this.appPath, appName),
            enabled: true
          });
        }
      }
    } catch (e) {
      console.warn('⚠️ 扫描app目录失败:', e.message);
    }
  }

  /**
   * 扫描守护进程能力
   */
  async scanDaemons() {
    // 守护进程内置能力
    const daemonCapabilities = [
      {
        id: 'daemon_homeai',
        name: 'HomeAI对话',
        type: 'daemon',
        capability: 'conversation',
        description: '家庭对话交互入口',
        enabled: true
      },
      {
        id: 'daemon_andy',
        name: 'Andy架构设计',
        type: 'daemon',
        capability: 'architecture',
        description: '架构设计和规划',
        enabled: true
      },
      {
        id: 'daemon_lisa',
        name: 'Lisa编码',
        type: 'daemon',
        capability: 'implementation',
        description: '代码生成和实现',
        enabled: true
      },
      {
        id: 'feishu',
        name: '飞书入口',
        type: 'entrance',
        capability: 'messaging',
        description: '飞书消息交互',
        enabled: true
      },
      {
        id: 'voice',
        name: '语音入口',
        type: 'entrance',
        capability: 'voice',
        description: '本地语音交互',
        enabled: true
      }
    ];

    for (const cap of daemonCapabilities) {
      this.register(cap);
    }
  }

  /**
   * 注册能力
   */
  register(capability) {
    this.capabilities.set(capability.id, {
      ...capability,
      registeredAt: new Date().toISOString()
    });
  }

  /**
   * 获取所有能力
   */
  getAll() {
    return Array.from(this.capabilities.values());
  }

  /**
   * 按类型获取能力
   */
  getByType(type) {
    return this.getAll().filter(c => c.type === type);
  }

  /**
   * 按能力类型获取
   */
  getByCapability(capability) {
    return this.getAll().filter(c => c.capability === capability);
  }

  /**
   * 获取能力详情
   */
  get(id) {
    return this.capabilities.get(id);
  }

  /**
   * 搜索能力
   */
  search(query) {
    const lowerQuery = query.toLowerCase();
    return this.getAll().filter(c =>
      c.name.toLowerCase().includes(lowerQuery) ||
      c.description.toLowerCase().includes(lowerQuery) ||
      c.capability.toLowerCase().includes(lowerQuery)
    );
  }

  /**
   * 生成自我认知报告
   */
  generateSelfAwarenessReport() {
    const caps = this.getAll();

    const byType = {
      skill: caps.filter(c => c.type === 'skill'),
      app: caps.filter(c => c.type === 'app'),
      daemon: caps.filter(c => c.type === 'daemon'),
      entrance: caps.filter(c => c.type === 'entrance')
    };

    return {
      totalCapabilities: caps.length,
      byType: {
        skills: byType.skill.length,
        apps: byType.app.length,
        daemons: byType.daemon.length,
        entrances: byType.entrance.length
      },
      capabilities: caps.map(c => ({
        id: c.id,
        name: c.name,
        type: c.type,
        capability: c.capability,
        description: c.description,
        enabled: c.enabled
      })),
      generatedAt: new Date().toISOString()
    };
  }
}

// 单例
const capabilityRegistry = new CapabilityRegistry();

module.exports = capabilityRegistry;
