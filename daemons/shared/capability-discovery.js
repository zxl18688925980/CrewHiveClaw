/**
 * 能力发现模块 (Capability Discovery)
 * 功能: 扫描 app/ 和 data/app/generated/ 目录，发现新开发的软件
 * 核心: 自进化系统开发出的软件需要被自动发现和注册
 */

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const pathsModule = require('./paths');
const PROJECT_ROOT = pathsModule.PROJECT_ROOT;

class CapabilityDiscovery {
  constructor() {
    this.discoveredCapabilities = new Map();
    this.scanPaths = [
      { path: 'app', type: 'app', desc: '应用目录' },
      { path: 'data/app/generated', type: 'generated', desc: '自进化生成的应用' }
    ];

    // 能力类型识别
    this.typeDetectors = [
      { pattern: /api|server|daemon/i, type: 'service', icon: '🔌' },
      { pattern: /web|frontend|ui|dashboard/i, type: 'web', icon: '🌐' },
      { pattern: /cli|tool|script/i, type: 'tool', icon: '🛠️' },
      { pattern: /skill|agent/i, type: 'skill', icon: '🎯' },
      { pattern: /mcp|plugin/i, type: 'plugin', icon: '🔌' }
    ];

    // 接口文件识别
    this.interfaceFiles = ['package.json', 'index.js', 'main.py', 'main.go', 'api.yaml', 'openapi.yaml'];
  }

  /**
   * 扫描所有路径，发现能力
   */
  async discover() {
    console.log('🔍 开始能力发现...');

    const discovered = [];

    for (const scanPath of this.scanPaths) {
      const fullPath = path.resolve(PROJECT_ROOT, scanPath.path);

      if (!fs.existsSync(fullPath)) {
        console.log(`  ⚠️ 目录不存在: ${scanPath.path}`);
        continue;
      }

      console.log(`  📂 扫描: ${scanPath.path}`);
      const capabilities = await this.scanDirectory(fullPath, scanPath.type, scanPath.desc);
      discovered.push(...capabilities);
    }

    // 存储发现的能力
    for (const cap of discovered) {
      this.discoveredCapabilities.set(cap.id, cap);
    }

    console.log(`✅ 能力发现完成: ${discovered.length} 个能力`);

    return discovered;
  }

  /**
   * 扫描目录，递归发现能力
   */
  async scanDirectory(dirPath, type, desc) {
    const capabilities = [];

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const entry of entries) {
        const entryPath = path.join(dirPath, entry.name);

        if (entry.isDirectory()) {
          // 递归扫描子目录
          const subCaps = await this.scanDirectory(entryPath, type, desc);
          capabilities.push(...subCaps);
        } else if (entry.isFile()) {
          // 检查是否为接口文件
          const capability = await this.analyzeFile(entryPath, type, desc);
          if (capability) {
            capabilities.push(capability);
          }
        }
      }
    } catch (e) {
      console.warn(`  ⚠️ 扫描失败: ${dirPath} - ${e.message}`);
    }

    return capabilities;
  }

  /**
   * 分析文件，提取能力信息
   */
  async analyzeFile(filePath, parentType, parentDesc) {
    const ext = path.extname(filePath).toLowerCase();
    const basename = path.basename(filePath);

    // 只处理特定类型的文件
    if (!this.interfaceFiles.includes(basename) && !['.js', '.py', '.go', '.yaml'].includes(ext)) {
      return null;
    }

    const dirPath = path.dirname(filePath);
    const capability = {
      id: `cap_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      name: path.basename(dirPath),
      type: parentType,
      interfaceFile: basename,
      path: dirPath,
      discoveredAt: new Date().toISOString(),
      source: parentDesc
    };

    // 解析接口文件获取更多信息
    try {
      if (basename === 'package.json') {
        const pkg = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        capability.description = pkg.description || `${capability.name} 应用`;
        capability.version = pkg.version;
        capability.capabilities = this.extractCapabilitiesFromPackage(pkg);
      } else if (basename === 'index.js' || basename.endsWith('.py')) {
        capability.description = await this.extractCapabilitiesFromCode(filePath, ext);
      }
    } catch (e) {
      capability.description = `${capability.name} - 未能解析详细信息`;
    }

    // 检测能力类型
    const typeInfo = this.detectType(capability);
    capability.capabilityType = typeInfo.type;
    capability.icon = typeInfo.icon;

    return capability;
  }

  /**
   * 从 package.json 提取能力
   */
  extractCapabilitiesFromPackage(pkg) {
    const capabilities = [];

    // 从 scripts 提取
    if (pkg.scripts) {
      for (const [name, cmd] of Object.entries(pkg.scripts)) {
        capabilities.push({
          type: 'script',
          name,
          command: cmd
        });
      }
    }

    // 从 dependencies 推断
    if (pkg.dependencies) {
      const deps = Object.keys(pkg.dependencies);
      if (deps.some(d => d.includes('express') || d.includes('koa'))) {
        capabilities.push({ type: 'framework', name: 'web' });
      }
      if (deps.some(d => d.includes('discord') || d.includes('telegram'))) {
        capabilities.push({ type: 'messaging', name: 'bot' });
      }
    }

    return capabilities;
  }

  /**
   * 从代码文件提取能力
   */
  async extractCapabilitiesFromCode(filePath, ext) {
    try {
      const content = fs.readFileSync(filePath, 'utf8');

      // 简单分析：查找函数定义
      const functions = [];

      if (ext === '.js') {
        const funcMatches = content.match(/function\s+(\w+)/g) || [];
        functions.push(...funcMatches.map(f => f.replace('function ', '')));
      }

      if (functions.length > 0) {
        return `提供 ${functions.slice(0, 3).join(', ')} 等功能`;
      }

      return '可执行程序';
    } catch (e) {
      return '可执行程序';
    }
  }

  /**
   * 检测能力类型
   */
  detectType(capability) {
    const desc = (capability.description || '').toLowerCase();
    const name = capability.name.toLowerCase();

    for (const detector of this.typeDetectors) {
      if (detector.pattern.test(desc) || detector.pattern.test(name)) {
        return { type: detector.type, icon: detector.icon };
      }
    }

    // 默认类型
    return { type: capability.type || 'app', icon: '📦' };
  }

  /**
   * 获取所有发现的能力
   */
  getAll() {
    return Array.from(this.discoveredCapabilities.values());
  }

  /**
   * 搜索能力
   */
  search(query) {
    const q = query.toLowerCase();
    return this.getAll().filter(cap =>
      cap.name.toLowerCase().includes(q) ||
      (cap.description && cap.description.toLowerCase().includes(q))
    );
  }

  /**
   * 检查是否有新能力
   */
  checkForNewCapabilities() {
    const previous = this.loadPreviousCapabilities();
    const current = this.getAll();

    const newCapabilities = current.filter(cap =>
      !previous.some(p => p.path === cap.path && p.name === cap.name)
    );

    if (newCapabilities.length > 0) {
      console.log(`🎉 发现 ${newCapabilities.length} 个新能力!`);
      for (const cap of newCapabilities) {
        console.log(`  - ${cap.icon} ${cap.name}: ${cap.description}`);
      }
    }

    return newCapabilities;
  }

  /**
   * 保存能力列表
   */
  savePreviousCapabilities() {
    const dataPath = path.join(pathsModule.paths.data.evolution.base, 'capabilities');
    if (!fs.existsSync(dataPath)) {
      fs.mkdirSync(dataPath, { recursive: true });
    }

    const filePath = path.join(dataPath, 'discovered.json');
    fs.writeFileSync(filePath, JSON.stringify(this.getAll(), null, 2));
  }

  /**
   * 加载之前发现的能力
   */
  loadPreviousCapabilities() {
    const filePath = path.join(pathsModule.paths.data.evolution.base, 'capabilities', 'discovered.json');

    if (fs.existsSync(filePath)) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch (e) {
        return [];
      }
    }

    return [];
  }
}

const capabilityDiscovery = new CapabilityDiscovery();

module.exports = capabilityDiscovery;
