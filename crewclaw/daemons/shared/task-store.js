/**
 * 任务持久化模块
 * 将任务状态持久化到文件系统，支持进程重启后恢复
 */

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const TASKS_DIR = path.join(__dirname, '../data/tasks');

class TaskStore {
  constructor() {
    this.tasks = new Map(); // taskId -> task
    this._ensureDir();
    this._loadFromDisk();
  }

  /**
   * 确保任务目录存在
   */
  _ensureDir() {
    if (!fs.existsSync(TASKS_DIR)) {
      fs.mkdirSync(TASKS_DIR, { recursive: true });
    }
  }

  /**
   * 从磁盘加载任务
   */
  _loadFromDisk() {
    try {
      const files = fs.readdirSync(TASKS_DIR).filter(f => f.endsWith('.json'));
      for (const file of files) {
        const taskPath = path.join(TASKS_DIR, file);
        const taskData = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
        this.tasks.set(taskData.id, taskData);
      }
      console.log(`[TaskStore] 已从磁盘加载 ${this.tasks.size} 个任务`);
    } catch (e) {
      console.log('[TaskStore] 加载任务失败:', e.message);
    }
  }

  /**
   * 保存任务到磁盘
   */
  _saveToDisk(task) {
    const taskPath = path.join(TASKS_DIR, `${task.id}.json`);
    fs.writeFileSync(taskPath, JSON.stringify(task, null, 2));
  }

  /**
   * 从磁盘删除任务
   */
  _deleteFromDisk(taskId) {
    const taskPath = path.join(TASKS_DIR, `${taskId}.json`);
    if (fs.existsSync(taskPath)) {
      fs.unlinkSync(taskPath);
    }
  }

  /**
   * 创建任务
   */
  create(userId, intent, message) {
    const taskId = `task_${Date.now()}_${uuidv4().substring(0, 8)}`;
    const task = {
      id: taskId,
      userId,
      type: intent.type,
      complexity: intent.complexity,
      message,
      status: 'pending',
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      result: null,
      error: null
    };

    this.tasks.set(taskId, task);
    this._saveToDisk(task);
    return task;
  }

  /**
   * 更新任务
   */
  update(taskId, updates) {
    const task = this.tasks.get(taskId);
    if (!task) return null;

    Object.assign(task, updates, { updatedAt: new Date().toISOString() });
    this.tasks.set(taskId, task);
    this._saveToDisk(task);
    return task;
  }

  /**
   * 获取任务
   */
  get(taskId) {
    return this.tasks.get(taskId);
  }

  /**
   * 获取用户所有任务
   */
  getUserTasks(userId) {
    return Array.from(this.tasks.values())
      .filter(t => t.userId === userId)
      .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }

  /**
   * 获取所有任务
   */
  getAll() {
    return Array.from(this.tasks.values());
  }

  /**
   * 删除任务
   */
  delete(taskId) {
    this.tasks.delete(taskId);
    this._deleteFromDisk(taskId);
  }

  /**
   * 清理旧任务（保留最近 N 天）
   */
  cleanup(daysToKeep = 30) {
    const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
    let cleaned = 0;

    for (const [taskId, task] of this.tasks) {
      if (new Date(task.updatedAt).getTime() < cutoff) {
        this.delete(taskId);
        cleaned++;
      }
    }

    console.log(`[TaskStore] 清理了 ${cleaned} 个过期任务`);
    return cleaned;
  }

  /**
   * 获取统计信息
   */
  getStats() {
    const tasks = Array.from(this.tasks.values());
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      inProgress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length
    };
  }
}

// 单例实例
const taskStore = new TaskStore();

// 定期清理（每天）
setInterval(() => {
  taskStore.cleanup(30);
}, 24 * 60 * 60 * 1000);

module.exports = {
  taskStore,
  TaskStore
};
