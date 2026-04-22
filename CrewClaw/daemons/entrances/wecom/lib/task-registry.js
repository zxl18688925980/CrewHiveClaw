'use strict';
/**
 * task-registry.js — 任务注册表 + L4 控制文件读写
 *
 * 导出工厂函数：module.exports = (logger) => ({ ... })
 * 调用方：const tr = require('./lib/task-registry')(logger)
 */

const fs   = require('fs');
const path = require('path');

const HOMEAI_ROOT     = path.join(__dirname, '../../../../../..');
const TASK_REG_FILE   = path.join(HOMEAI_ROOT, 'Data', 'learning', 'task-registry.json');
const L4_TASKS_FILE   = path.join(HOMEAI_ROOT, 'Data', 'learning', 'l4-tasks.json');
const L4_CONTROL_FILE = path.join(HOMEAI_ROOT, 'Data', 'learning', 'l4-control.json');

const nowCST = () =>
  new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00');

module.exports = function createTaskRegistry(logger) {

  // ── task-registry.json ──────────────────────────────────────────────────────

  function readTaskRegistry() {
    try {
      return fs.existsSync(TASK_REG_FILE)
        ? JSON.parse(fs.readFileSync(TASK_REG_FILE, 'utf8'))
        : [];
    } catch { return []; }
  }

  // readTaskRegistryRaw 与 readTaskRegistry 完全等价，保留别名供旧调用点使用
  const readTaskRegistryRaw = readTaskRegistry;

  function writeTaskRegistry(entries) {
    fs.writeFileSync(TASK_REG_FILE, JSON.stringify(entries, null, 2), 'utf8');
  }

  /** 根据任务当前阶段推断责任 Agent（用于 notify-engineer fromAgent） */
  function inferTaskAgent(task) {
    const phase = task.currentPhase || '';
    if (phase === 'implementing' || phase === 'verifying') return 'lisa';
    if (phase === 'planning'     || phase === 'delivering') return 'andy';
    if (task.designNote || task.deliveryBrief)              return 'andy';
    return 'system';
  }

  /** 标记任务已被 Lucas 告知家人（防止主动循环和 before_prompt_build 双发） */
  function markTaskLucasAcked(taskId) {
    try {
      if (!fs.existsSync(TASK_REG_FILE)) return;
      const entries = JSON.parse(fs.readFileSync(TASK_REG_FILE, 'utf8'));
      const idx = entries.findIndex(e => e.id === taskId);
      if (idx >= 0) {
        entries[idx].lucasAcked   = true;
        entries[idx].lucasAckedAt = nowCST();
        fs.writeFileSync(TASK_REG_FILE, JSON.stringify(entries, null, 2), 'utf8');
      }
      logger.info('任务标记 lucasAcked=true', { taskId });
    } catch (e) {
      logger.warn('markTaskLucasAcked 失败', { taskId, error: e.message });
    }
  }

  // ── L4 控制文件 ─────────────────────────────────────────────────────────────

  function readL4Tasks() {
    try {
      return fs.existsSync(L4_TASKS_FILE)
        ? JSON.parse(fs.readFileSync(L4_TASKS_FILE, 'utf8'))
        : [];
    } catch { return []; }
  }

  function readL4Control() {
    try {
      return fs.existsSync(L4_CONTROL_FILE)
        ? JSON.parse(fs.readFileSync(L4_CONTROL_FILE, 'utf8'))
        : { global_pause: false, stop_tasks: [], pause_reason: null };
    } catch {
      return { global_pause: false, stop_tasks: [], pause_reason: null };
    }
  }

  function writeL4Control(data) {
    try {
      fs.mkdirSync(path.dirname(L4_CONTROL_FILE), { recursive: true });
      fs.writeFileSync(
        L4_CONTROL_FILE,
        JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2),
        'utf8'
      );
    } catch (_e) {}
  }

  return {
    readTaskRegistry,
    readTaskRegistryRaw,
    writeTaskRegistry,
    inferTaskAgent,
    markTaskLucasAcked,
    readL4Tasks,
    readL4Control,
    writeL4Control,
    // 常量也暴露出去，让 index.js 里的路径引用可以统一
    TASK_REG_FILE,
    L4_TASKS_FILE,
    L4_CONTROL_FILE,
  };
};
