/**
 * HomeAI 路径配置模块
 * 统一管理所有守护进程的数据存储路径
 * 版本: v345.0
 *
 * 使用方式：
 *   const paths = require('./paths');
 *   const evolutionPath = paths.data.evolution.events;
 */

const path = require('path');
const fs = require('fs');

// 项目根目录
const PROJECT_ROOT = path.join(__dirname, '../..');

// 确保 PROJECT_ROOT 解析正确
const resolvedRoot = fs.existsSync(path.join(PROJECT_ROOT, 'package.json'))
  ? PROJECT_ROOT
  : path.join(process.cwd());

/**
 * 路径配置对象
 */
const paths = {
  // 项目根目录
  root: resolvedRoot,

  // 数据目录
  data: {
    base: path.join(resolvedRoot, 'data'),

    // 进化事件
    evolution: {
      base: path.join(resolvedRoot, 'data/evolution'),
      events: path.join(resolvedRoot, 'data/evolution/evolution-events.json'),
      log: path.join(resolvedRoot, 'data/evolution/evolution-log.json'),
      notifications: path.join(resolvedRoot, 'data/evolution/notifications.json'),
      backups: path.join(resolvedRoot, 'data/evolution/backups'),
    },

    // 决策记录
    decisions: {
      base: path.join(resolvedRoot, 'data/decisions'),
      andy: path.join(resolvedRoot, 'data/decisions/andy'),
      lisa: path.join(resolvedRoot, 'data/decisions/lisa'),
      log: path.join(resolvedRoot, 'data/decisions/decision-log.json'),
    },

    // 微调数据
    finetune: {
      base: path.join(resolvedRoot, 'data/finetune'),
      corpus: path.join(resolvedRoot, 'data/finetune/corpus'),
      prepared: path.join(resolvedRoot, 'data/finetune/prepared'),
      output: path.join(resolvedRoot, 'data/finetune/output'),
      trainingData: path.join(resolvedRoot, 'data/finetune/prepared/training-data.jsonl'),
    },

    // 向量数据库
    chroma: {
      base: path.join(resolvedRoot, 'data/chroma'),
      db: path.join(resolvedRoot, 'data/chroma/chroma.sqlite3'),
    },

    // 记忆系统
    memory: {
      base: path.join(resolvedRoot, 'data/memory'),
      dialogue: path.join(resolvedRoot, 'data/memory/dialogue'),
      context: path.join(resolvedRoot, 'data/memory/context'),
    },

    // 知识库（纳入 Git）
    knowledge: {
      base: path.join(resolvedRoot, 'data/knowledge'),
      corpus: path.join(resolvedRoot, 'data/knowledge/corpus'),
      learning: path.join(resolvedRoot, 'data/knowledge/learning'),
      audit: path.join(resolvedRoot, 'data/knowledge/audit'),
      readmeFinetune: path.join(resolvedRoot, 'data/knowledge/corpus/readme_finetune.jsonl'),
    },
  },

  // 应用目录
  app: {
    base: path.join(resolvedRoot, 'app'),
    generated: path.join(resolvedRoot, 'app/generated'),
  },

  // 模型目录
  models: {
    base: path.join(resolvedRoot, 'models'),
    modelfile: path.join(resolvedRoot, 'models/Modelfile'),
    finetuned: path.join(resolvedRoot, 'models/finetuned'),
    checkpoints: path.join(resolvedRoot, 'models/checkpoints'),
  },

  // 日志目录
  logs: {
    base: path.join(resolvedRoot, 'logs'),
    pm2: path.join(resolvedRoot, 'logs/pm2'),
    homeai: path.join(resolvedRoot, 'logs/homeai-daemon.log'),
    andy: path.join(resolvedRoot, 'logs/andy-daemon.log'),
    lisa: path.join(resolvedRoot, 'logs/lisa-daemon.log'),
  },

  // 临时目录
  temp: path.join(resolvedRoot, 'temp'),

  // 配置目录
  config: {
    base: path.join(resolvedRoot, 'config'),
    openclaw: path.join(resolvedRoot, 'config/openclaw.example.json'),
    prompts: path.join(resolvedRoot, 'config/prompts'),
  },

  // 文档目录
  docs: path.join(resolvedRoot, 'docs'),
};

/**
 * 确保所有必要目录存在
 */
function ensureDirectories() {
  const dirs = [
    paths.data.evolution.base,
    paths.data.evolution.backups,
    paths.data.decisions.base,
    paths.data.decisions.andy,
    paths.data.decisions.lisa,
    paths.data.finetune.base,
    paths.data.finetune.corpus,
    paths.data.finetune.prepared,
    paths.data.finetune.output,
    paths.data.chroma.base,
    paths.data.memory.base,
    paths.data.memory.dialogue,
    paths.data.memory.context,
    paths.data.knowledge.base,
    paths.data.knowledge.corpus,
    paths.data.knowledge.learning,
    paths.data.knowledge.audit,
    paths.app.generated,
    paths.models.finetuned,
    paths.models.checkpoints,
    paths.logs.base,
    paths.logs.pm2,
    paths.temp,
  ];

  dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  });
}

/**
 * 获取相对于项目根目录的路径
 * @param {string} relativePath - 相对路径
 * @returns {string} 绝对路径
 */
function resolve(relativePath) {
  return path.join(resolvedRoot, relativePath);
}

module.exports = {
  paths,
  ensureDirectories,
  resolve,
  PROJECT_ROOT: resolvedRoot,
};
