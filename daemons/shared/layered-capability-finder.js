/**
 * 分层能力查找器 (Layered Capability Finder)
 *
 * 分层查找逻辑：
 * 1. 本地能力 - 已有的Skill/MCP/软件
 * 2. 社区能力 - OpenClaw社区/第三方MCP
 * 3. Andy设计 - 组合现有能力或开发新Skill/软件
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');

const os = require('os');
const execAsync = promisify(exec);
const pathsModule = require('./paths');
const PROJECT_ROOT = pathsModule.PROJECT_ROOT;

class LayeredCapabilityFinder {
  constructor() {
    // 能力来源层级
    this.layers = {
      LOCAL: 'local',         // 本地能力
      COMMUNITY: 'community', // 社区能力
      ANDY_DESIGN: 'andy'    // Andy设计
    };

    // 本地扫描路径
    this.localScanPaths = [
      { path: 'skills', type: 'skill', desc: '本地Skills' },
      { path: 'app', type: 'app', desc: '应用软件' },
      { path: 'data/app/generated', type: 'generated', desc: '自进化生成软件' },
      { path: '.homeclaw/plugins', type: 'mcp', desc: '本地MCP插件' }
    ];

    // MCP能力列表（已知可用）
    this.knownMCPs = [
      { id: 'mcp-websearch', name: 'WebSearch', type: 'mcp', desc: '网络搜索', capability: 'search' },
      { id: 'mcp-webreader', name: 'WebReader', type: 'mcp', desc: '网页读取', capability: 'read' },
      { id: 'mcp-vision', name: 'Vision', type: 'mcp', desc: '图片分析', capability: 'vision' },
      { id: 'mcp-office', name: 'Office', type: 'mcp', desc: '文档处理', capability: 'document' }
    ];

    // 能力缓存
    this.capabilities = new Map();
  }

  /**
   * 能力边界定义
   * 系统无法做到的事情
   */
  getCapabilityBoundaries() {
    return {
      // 物理世界操作
      physical: {
        keywords: ['打扫', '做饭', '按摩', '洗衣服', '洗碗', '收拾', '搬运', '遛狗', '喂猫'],
        reason: '需要物理身体才能完成的任务',
        alternatives: ['可以提醒您做这些事', '可以记录任务提醒']
      },
      // 情感陪伴 - 部分可以做
      emotion: {
        keywords: ['拥抱', '真实的陪伴', '代替我'],
        reason: 'AI无法物理陪伴或代替家人',
        alternatives: ['可以聊天对话', '可以讲故事', '可以播放音乐']
      },
      // 未知物理状态
      unknown_physical: {
        keywords: ['现在有人吗', '家里怎么样', '孩子在干嘛', '谁在家'],
        reason: '没有安装物理传感器无法感知',
        alternatives: ['建议安装摄像头或传感器', '可以定时询问您']
      },
      // 未接入设备
      uncontrolled: {
        keywords: ['控制电视', '控制空调', '控制窗帘', '打开门'],
        reason: '设备未接入智能家居系统',
        alternatives: ['可以帮您查询如何接入', '可以记录需求后续实现']
      },
      // 跨系统操作
      cross_system: {
        keywords: ['帮我发邮件', '帮我打电话', '帮我发短信'],
        reason: '需要获取系统权限',
        alternatives: ['可以提供操作指导', '可以记录到待办事项']
      }
    };
  }

  /**
   * 检测任务是否超出能力边界
   */
  checkFeasibility(task) {
    const boundaries = this.getCapabilityBoundaries();
    const taskLower = task.toLowerCase();

    for (const [key, boundary] of Object.entries(boundaries)) {
      for (const keyword of boundary.keywords) {
        if (taskLower.includes(keyword)) {
          return {
            feasible: false,
            boundary: key,
            reason: boundary.reason,
            alternatives: boundary.alternatives,
            message: `抱歉，这个任务我做不到：${boundary.reason}`
          };
        }
      }
    }

    return { feasible: true };
  }

  /**
   * 分层能力查找主入口
   */
  async findCapabilities(task) {
    console.log(`\n🎯 开始分层能力查找: "${task}"`);

    const results = {
      task,
      feasibility: null,
      layers: {},
      finalRecommendation: null
    };

    // 0. 首先检测可行性（能力边界）
    console.log('\n📍 第零层：可行性检测');
    results.feasibility = this.checkFeasibility(task);

    if (!results.feasibility.feasible) {
      console.log(`  ❌ 超出能力边界: ${results.feasibility.reason}`);
      results.finalRecommendation = {
        action: 'NOT_FEASIBLE',
        message: results.feasibility.message,
        alternatives: results.feasibility.alternatives
      };
      return results;
    }

    console.log('  ✅ 可行，继续查找能力');

    // 第一层：本地能力查找
    console.log('\n📍 第一层：本地能力查找');
    results.layers.local = await this.findLocalCapabilities(task);
    console.log(`  本地找到 ${results.layers.local.length} 个能力`);

    // 第二层：社区能力查找
    console.log('\n📍 第二层：社区能力查找');
    results.layers.community = await this.findCommunityCapabilities(task);
    console.log(`  社区找到 ${results.layers.community.length} 个能力`);

    // 综合推荐
    results.finalRecommendation = this.makeRecommendation(results.layers);

    return results;
  }

  /**
   * 第一层：本地能力查找
   */
  async findLocalCapabilities(task) {
    const capabilities = [];
    const taskLower = task.toLowerCase();

    // 1. 扫描本地Skills
    const localSkills = await this.scanLocalSkills();
    capabilities.push(...localSkills);

    // 2. 扫描本地MCP
    const localMCPs = await this.scanLocalMCPs();
    capabilities.push(...localMCPs);

    // 3. 扫描已安装软件
    const localApps = await this.scanLocalApps();
    capabilities.push(...localApps);

    // 4. 匹配任务关键词
    const matched = this.matchTask(capabilities, taskLower);

    return matched;
  }

  /**
   * 扫描本地Skills
   */
  async scanLocalSkills() {
    const skills = [];
    const skillsPath = path.resolve(PROJECT_ROOT, 'skills');

    if (!fs.existsSync(skillsPath)) {
      return skills;
    }

    try {
      const entries = fs.readdirSync(skillsPath, { withFileTypes: true });

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const skillPath = path.join(skillsPath, entry.name);
          const skillMdPath = path.join(skillPath, 'SKILL.md');

          let description = entry.name;
          let capability = 'general';

          if (fs.existsSync(skillMdPath)) {
            const content = fs.readFileSync(skillMdPath, 'utf8');
            const descMatch = content.match(/description:\s*(.+)/);
            const capMatch = content.match(/capability:\s*(.+)/);
            if (descMatch) description = descMatch[1].trim();
            if (capMatch) capability = capMatch[1].trim();
          }

          skills.push({
            id: `skill_${entry.name}`,
            name: entry.name,
            type: 'skill',
            layer: this.layers.LOCAL,
            source: '本地Skills',
            capability,
            description,
            path: skillPath
          });
        }
      }
    } catch (e) {
      console.warn('  ⚠️ 扫描Skills失败:', e.message);
    }

    return skills;
  }

  /**
   * 扫描本地MCPs
   */
  async scanLocalMCPs() {
    const mcps = [];

    // 添加已知MCP
    for (const mcp of this.knownMCPs) {
      mcps.push({
        ...mcp,
        layer: this.layers.LOCAL,
        source: '本地MCP'
      });
    }

    // 扫描 ~/.homeclaw/plugins 目录
    const pluginsPath = path.join(os.homedir(), '.homeclaw/plugins');

    if (fs.existsSync(pluginsPath)) {
      try {
        const entries = fs.readdirSync(pluginsPath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            mcps.push({
              id: `mcp_${entry.name}`,
              name: entry.name,
              type: 'mcp',
              layer: this.layers.LOCAL,
              source: '本地MCP插件',
              capability: 'custom',
              description: `本地MCP: ${entry.name}`,
              path: path.join(pluginsPath, entry.name)
            });
          }
        }
      } catch (e) {
        // 忽略
      }
    }

    return mcps;
  }

  /**
   * 扫描本地应用
   */
  async scanLocalApps() {
    const apps = [];
    const appPaths = ['app', 'data/app/generated'];

    for (const appPath of appPaths) {
      const fullPath = path.resolve(PROJECT_ROOT, appPath);

      if (!fs.existsSync(fullPath)) continue;

      try {
        const entries = fs.readdirSync(fullPath, { withFileTypes: true });

        for (const entry of entries) {
          if (entry.isDirectory()) {
            const entryPath = path.join(fullPath, entry.name);
            const pkgPath = path.join(entryPath, 'package.json');

            let description = entry.name;

            if (fs.existsSync(pkgPath)) {
              try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                description = pkg.description || entry.name;
              } catch (e) {}
            }

            apps.push({
              id: `app_${entry.name}`,
              name: entry.name,
              type: 'app',
              layer: this.layers.LOCAL,
              source: appPath,
              capability: 'application',
              description,
              path: entryPath
            });
          }
        }
      } catch (e) {}
    }

    return apps;
  }

  /**
   * 第二层：社区能力查找
   */
  async findCommunityCapabilities(task) {
    const capabilities = [];
    const taskLower = task.toLowerCase();

    // 1. 模拟搜索OpenClaw社区Skills
    const communitySkills = await this.searchCommunitySkills(taskLower);
    capabilities.push(...communitySkills);

    // 2. 模拟搜索社区MCPs
    const communityMCPs = await this.searchCommunityMCPs(taskLower);
    capabilities.push(...communityMCPs);

    return capabilities;
  }

  /**
   * 搜索OpenClaw社区Skills
   * 实际实现需要调用OpenClaw API或搜索目录
   */
  async searchCommunitySkills(taskKeywords) {
    // 模拟：实际应该调用 OpenClaw 社区API
    // 这里返回示例数据
    const examples = [
      { id: 'community_skill_weather', name: 'weather-skill', desc: '天气查询', keywords: ['天气', 'weather', '温度'] },
      { id: 'community_skill_calendar', name: 'calendar-skill', desc: '日历管理', keywords: ['日历', 'calendar', '日程'] },
      { id: 'community_skill_iot', name: 'iot-control-skill', desc: '物联网控制', keywords: ['控制', 'iot', '设备'] }
    ];

    const matched = [];
    for (const ex of examples) {
      for (const kw of ex.keywords) {
        if (taskKeywords.includes(kw)) {
          matched.push({
            id: ex.id,
            name: ex.name,
            type: 'skill',
            layer: this.layers.COMMUNITY,
            source: 'OpenClaw社区',
            capability: 'community',
            description: ex.desc,
            installCommand: `openclaw skill install ${ex.name}`
          });
          break;
        }
      }
    }

    return matched;
  }

  /**
   * 搜索社区MCPs
   */
  async searchCommunityMCPs(taskKeywords) {
    const examples = [
      { id: 'community_mcp_slack', name: 'slack-mcp', desc: 'Slack消息', keywords: ['slack', '消息'] },
      { id: 'community_mcp_github', name: 'github-mcp', desc: 'GitHub操作', keywords: ['github', 'git'] },
      { id: 'community_mcp_filesystem', name: 'filesystem-mcp', desc: '文件操作', keywords: ['文件', 'file'] }
    ];

    const matched = [];
    for (const ex of examples) {
      for (const kw of ex.keywords) {
        if (taskKeywords.includes(kw)) {
          matched.push({
            id: ex.id,
            name: ex.name,
            type: 'mcp',
            layer: this.layers.COMMUNITY,
            source: '社区MCP',
            capability: 'community',
            description: ex.desc,
            installCommand: `openclaw mcp install ${ex.name}`
          });
          break;
        }
      }
    }

    return matched;
  }

  /**
   * 匹配任务关键词
   */
  matchTask(capabilities, taskKeywords) {
    const matched = [];

    for (const cap of capabilities) {
      const name = cap.name.toLowerCase();
      const desc = (cap.description || '').toLowerCase();

      // 简单关键词匹配
      const keywords = taskKeywords.split(/\s+/).filter(k => k.length > 2);

      for (const kw of keywords) {
        if (name.includes(kw) || desc.includes(kw)) {
          matched.push({
            ...cap,
            matchReason: `关键词 "${kw}" 匹配`,
            matchScore: name.includes(kw) ? 0.9 : 0.7
          });
          break;
        }
      }
    }

    // 按匹配度排序
    matched.sort((a, b) => (b.matchScore || 0) - (a.matchScore || 0));

    return matched;
  }

  /**
   * 生成最终推荐
   */
  makeRecommendation(layers) {
    const local = layers.local || [];
    const community = layers.community || [];

    // 优先推荐本地能力
    if (local.length > 0) {
      return {
        action: 'USE_LOCAL',
        message: `本地有 ${local.length} 个可用能力，可直接组合调用`,
        capabilities: local.slice(0, 3),
        nextLayer: null
      };
    }

    // 次选社区能力
    if (community.length > 0) {
      return {
        action: 'USE_COMMUNITY',
        message: `本地无匹配能力，社区有 ${community.length} 个可用能力，建议安装`,
        capabilities: community.slice(0, 3),
        installCommand: community[0]?.installCommand,
        nextLayer: null
      };
    }

    // 需要Andy设计
    return {
      action: 'ANDY_DESIGN',
      message: '本地和社区均无匹配能力，需要Andy设计实现',
      capabilities: [],
      nextLayer: this.layers.ANDY_DESIGN,
      andyPrompt: this.generateAndyPrompt(layers)
    };
  }

  /**
   * 生成Andy设计提示
   */
  generateAndyPrompt(layers) {
    return `
## 能力查找结果

本地能力：${layers.local?.length || 0} 个
社区能力：${layers.community?.length || 0} 个

## 需要设计的任务

请根据用户需求设计实现方案：

1. 首先评估是否可以通过组合现有能力实现
2. 如果需要开发新能力：
   - 首先考虑开发 Skill（提示词模板）
   - 如果处理逻辑复杂，评估：
     - 现有程序是否可以修改进化满足
     - 是否需要新增软件实现
3. 设计完成后，记录决策到决策库

## Andy 设计时可用的辅助能力

- MCP WebSearch: 查询最新资料
- MCP WebReader: 读取技术文档
- 向量检索: 查询历史设计方案
`;
  }

  /**
   * Andy设计时调用MCP查资料
   */
  async andyConsultMCP(query, mcpType = 'websearch') {
    console.log(`\n🔍 Andy 调用 MCP 查资料: ${mcpType} - "${query}"`);

    // 模拟MCP调用
    // 实际实现需要通过OpenClaw MCP接口

    const mockResults = {
      websearch: [
        { title: '相关技术文章1', url: 'https://example.com/1', snippet: '...' },
        { title: '相关技术文章2', url: 'https://example.com/2', snippet: '...' }
      ],
      webreader: {
        title: '读取的页面',
        content: '页面内容...',
        summary: '页面摘要'
      },
      vision: {
        description: '图片描述',
        tags: ['tag1', 'tag2']
      }
    };

    console.log(`  ✅ MCP 返回结果`);

    return mockResults[mcpType] || mockResults.websearch;
  }

  /**
   * 获取所有能力（用于展示）
   */
  getAllCapabilities() {
    return Array.from(this.capabilities.values());
  }
}

const layeredCapabilityFinder = new LayeredCapabilityFinder();

module.exports = layeredCapabilityFinder;
