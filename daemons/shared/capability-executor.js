/**
 * 能力执行模块 (Capability Executor)
 * 功能: 执行能力调用，记录输入输出和执行结果
 * 核心: 每次调用都被记录，用于后续学习
 */

const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);
const paths = require('./paths');

class CapabilityExecutor {
  constructor() {
    this.executionHistory = [];
    this.maxHistorySize = 1000; // 最多保留1000条记录

    // 执行超时时间（毫秒）
    this.defaultTimeout = 30000;
  }

  /**
   * 执行能力调用
   */
  async execute(capability, input, context = {}) {
    const executionId = `exec_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    const record = {
      executionId,
      capabilityId: capability.id,
      capabilityName: capability.name,
      input,
      context,
      status: 'pending',
      startTime: new Date().toISOString()
    };

    console.log(`⚡ 执行能力: ${capability.name}`);
    console.log(`   输入: ${JSON.stringify(input).substring(0, 100)}...`);

    try {
      // 根据能力类型选择执行方式
      let result;

      if (capability.type === 'service' || capability.type === 'app') {
        result = await this.executeService(capability, input);
      } else if (capability.type === 'skill') {
        result = await this.executeSkill(capability, input);
      } else if (capability.type === 'generated') {
        result = await this.executeGenerated(capability, input);
      } else {
        result = { success: false, error: `未知能力类型: ${capability.type}` };
      }

      record.status = result.success ? 'success' : 'failed';
      record.output = result.output;
      record.error = result.error;
      record.executionTime = result.executionTime;

      console.log(`   状态: ${record.status}, 耗时: ${result.executionTime}ms`);

    } catch (err) {
      record.status = 'error';
      record.error = err.message;
      console.log(`   错误: ${err.message}`);
    }

    record.endTime = new Date().toISOString();

    // 记录执行历史
    this.addToHistory(record);

    return record;
  }

  /**
   * 执行服务类型能力
   */
  async executeService(capability, input) {
    const startTime = Date.now();

    // 检查 package.json 中的启动命令
    const pkgPath = path.join(capability.path, 'package.json');

    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));

        // 优先使用 start 脚本
        const startScript = pkg.scripts?.start || pkg.scripts?.dev;

        if (startScript) {
          // 通过 API 调用（假设服务已启动）
          return await this.callServiceAPI(capability, input);
        }
      } catch (e) {
        // 忽略解析错误
      }
    }

    // 默认：尝试直接执行
    return {
      success: false,
      error: '无法确定执行方式',
      executionTime: Date.now() - startTime
    };
  }

  /**
   * 通过 API 调用服务
   */
  async callServiceAPI(capability, input) {
    const http = require('http');

    return new Promise((resolve) => {
      const startTime = Date.now();

      // 默认端口 3000，实际应该从配置读取
      const port = capability.port || 3000;
      const endpoint = capability.endpoint || '/api/execute';

      const postData = JSON.stringify(input);

      const options = {
        hostname: 'localhost',
        port,
        path: endpoint,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(postData)
        },
        timeout: this.defaultTimeout
      };

      const req = http.request(options, (res) => {
        let data = '';

        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const result = JSON.parse(data);
            resolve({
              success: res.statusCode === 200,
              output: result,
              executionTime: Date.now() - startTime
            });
          } catch (e) {
            resolve({
              success: res.statusCode === 200,
              output: data,
              executionTime: Date.now() - startTime
            });
          }
        });
      });

      req.on('error', (err) => {
        resolve({
          success: false,
          error: err.message,
          executionTime: Date.now() - startTime
        });
      });

      req.on('timeout', () => {
        req.destroy();
        resolve({
          success: false,
          error: '请求超时',
          executionTime: Date.now() - startTime
        });
      });

      req.write(postData);
      req.end();
    });
  }

  /**
   * 执行 Skill 类型能力
   */
  async executeSkill(capability, input) {
    // OpenClaw Skill 执行
    // 实际通过 OpenClaw CLI 调用
    const startTime = Date.now();

    try {
      // 检查是否有 SKILL.md 定义
      const skillMdPath = path.join(capability.path, 'SKILL.md');

      if (fs.existsSync(skillMdPath)) {
        // Skill 存在，执行
        // 这里简化处理，实际应该调用 OpenClaw
        return {
          success: true,
          output: { message: 'Skill executed', skill: capability.name },
          executionTime: Date.now() - startTime
        };
      }

      return {
        success: false,
        error: 'Skill 定义文件不存在',
        executionTime: Date.now() - startTime
      };

    } catch (err) {
      return {
        success: false,
        error: err.message,
        executionTime: Date.now() - startTime
      };
    }
  }

  /**
   * 执行自进化生成的能力
   */
  async executeGenerated(capability, input) {
    const startTime = Date.now();

    try {
      // 查找入口文件
      const entryFile = this.findEntryFile(capability.path);

      if (!entryFile) {
        return {
          success: false,
          error: '未找到入口文件',
          executionTime: Date.now() - startTime
        };
      }

      // 执行入口文件
      const ext = path.extname(entryFile);

      if (ext === '.js') {
        const result = await this.executeNodeScript(entryFile, input);
        return {
          ...result,
          executionTime: Date.now() - startTime
        };
      }

      return {
        success: false,
        error: `不支持的文件类型: ${ext}`,
        executionTime: Date.now() - startTime
      };

    } catch (err) {
      return {
        success: false,
        error: err.message,
        executionTime: Date.now() - startTime
      };
    }
  }

  /**
   * 查找入口文件
   */
  findEntryFile(dirPath) {
    const entryFiles = ['index.js', 'main.js', 'app.js', 'server.js'];

    for (const file of entryFiles) {
      const filePath = path.join(dirPath, file);
      if (fs.existsSync(filePath)) {
        return filePath;
      }
    }

    return null;
  }

  /**
   * 执行 Node.js 脚本
   */
  async executeNodeScript(scriptPath, input) {
    return new Promise((resolve) => {
      const inputStr = JSON.stringify(input);

      const child = spawn('node', [scriptPath], {
        input: inputStr,
        stdio: ['pipe', 'pipe', 'pipe']
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', data => stdout += data);
      child.stderr.on('data', data => stderr += data);

      const timeout = setTimeout(() => {
        child.kill();
        resolve({
          success: false,
          error: '执行超时'
        });
      }, this.defaultTimeout);

      child.on('close', (code) => {
        clearTimeout(timeout);

        if (code === 0) {
          try {
            const output = JSON.parse(stdout);
            resolve({ success: true, output });
          } catch (e) {
            resolve({ success: true, output: stdout });
          }
        } else {
          resolve({
            success: false,
            error: stderr || `进程退出码: ${code}`
          });
        }
      });
    });
  }

  /**
   * 添加到执行历史
   */
  addToHistory(record) {
    this.executionHistory.unshift(record);

    // 限制历史大小
    if (this.executionHistory.length > this.maxHistorySize) {
      this.executionHistory = this.executionHistory.slice(0, this.maxHistorySize);
    }

    // 持久化保存
    this.saveHistory();
  }

  /**
   * 保存执行历史
   */
  saveHistory() {
    const historyDir = path.join(paths.paths.data.evolution.base, 'capabilities');
    if (!fs.existsSync(historyDir)) {
      fs.mkdirSync(historyDir, { recursive: true });
    }

    const filePath = path.join(historyDir, 'execution_history.json');
    fs.writeFileSync(filePath, JSON.stringify(this.executionHistory, null, 2));
  }

  /**
   * 加载执行历史
   */
  loadHistory() {
    const filePath = path.join(paths.paths.data.evolution.base, 'capabilities', 'execution_history.json');

    if (fs.existsSync(filePath)) {
      try {
        this.executionHistory = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        console.log(`📜 加载了 ${this.executionHistory.length} 条执行历史`);
      } catch (e) {
        this.executionHistory = [];
      }
    }
  }

  /**
   * 获取执行历史
   */
  getHistory(capabilityId = null, limit = 100) {
    if (capabilityId) {
      return this.executionHistory
        .filter(r => r.capabilityId === capabilityId)
        .slice(0, limit);
    }

    return this.executionHistory.slice(0, limit);
  }

  /**
   * 获取能力统计
   */
  getStatistics() {
    const stats = {
      total: this.executionHistory.length,
      success: 0,
      failed: 0,
      error: 0,
      byCapability: {}
    };

    for (const record of this.executionHistory) {
      if (record.status === 'success') stats.success++;
      else if (record.status === 'failed') stats.failed++;
      else if (record.status === 'error') stats.error++;

      const capName = record.capabilityName;
      if (!stats.byCapability[capName]) {
        stats.byCapability[capName] = {
          total: 0,
          success: 0,
          failed: 0,
          avgTime: 0,
          times: []
        };
      }

      const capStats = stats.byCapability[capName];
      capStats.total++;
      if (record.status === 'success') capStats.success++;
      else if (record.status === 'failed') capStats.failed++;

      if (record.executionTime) {
        capStats.times.push(record.executionTime);
        capStats.avgTime = capStats.times.reduce((a, b) => a + b, 0) / capStats.times.length;
      }
    }

    return stats;
  }
}

const capabilityExecutor = new CapabilityExecutor();

// 启动时加载历史
capabilityExecutor.loadHistory();

module.exports = capabilityExecutor;
