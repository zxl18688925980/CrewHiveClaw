/**
 * 样本策划器
 * 从质量评估结果中筛选微调样本，写入 pending-samples.jsonl
 * 去重：相似度 > 0.9 的样本只保留一条
 */

const fs = require('fs').promises;
const path = require('path');

const PENDING_FILE  = path.join(__dirname, '../../../data/finetune/pending-samples.jsonl');
const CORPUS_DIR    = path.join(__dirname, '../../../data/corpus');
const QUALITY_THRESHOLD = 0.75;

// 各角色语料文件映射
const CORPUS_FILES = {
  lucas: path.join(CORPUS_DIR, 'lucas-corpus.jsonl'),
  andy:  path.join(CORPUS_DIR, 'andy-corpus.jsonl'),
  lisa:  path.join(CORPUS_DIR, 'lisa-corpus.jsonl')
};

/**
 * 尝试将一条云端响应纳入微调候选
 * role 决定写入哪个角色的语料库（默认兜底写 pending-samples）
 */
async function curate(prompt, response, qualityScore, domain = 'general', role = null) {
  if (qualityScore < QUALITY_THRESHOLD) {
    return { added: false, reason: `质量分 ${qualityScore.toFixed(2)} < 阈值 ${QUALITY_THRESHOLD}` };
  }

  const sample = {
    prompt: prompt.substring(0, 1000),
    response: response.substring(0, 2000),
    quality_score: qualityScore,
    domain,
    role: role || 'unknown',
    timestamp: new Date().toISOString()
  };

  // 去重检查（在目标文件中查）
  const targetFile = (role && CORPUS_FILES[role]) || PENDING_FILE;
  const isDuplicate = await checkDuplicate(sample.prompt, targetFile);
  if (isDuplicate) {
    return { added: false, reason: '相似样本已存在' };
  }

  await fs.appendFile(targetFile, JSON.stringify(sample) + '\n', 'utf8');
  return { added: true, file: path.basename(targetFile), sample };
}

/**
 * 写入负例/正例对（由用户 👎 + correction 触发）
 * 技术修正类统一写入 lisa-corpus；业务修正写对应角色
 */
async function curateNegative({ prompt, badResponse, goodResponse, domain = 'general', role = 'lisa' }) {
  // 技术类错误（代码/架构）归 Lisa，业务类归原角色
  const targetRole = (domain === 'code' || domain === 'architecture') ? 'lisa' : role;
  const targetFile = CORPUS_FILES[targetRole] || CORPUS_FILES.lisa;

  const sample = {
    prompt: prompt.substring(0, 1000),
    rejected: badResponse.substring(0, 2000),   // 负例：被纠正的回答
    chosen:   goodResponse.substring(0, 2000),   // 正例：用户给的正确回答
    type: 'preference',   // DPO 格式，区别于普通 SFT 样本
    domain,
    role: targetRole,
    timestamp: new Date().toISOString()
  };

  await fs.appendFile(targetFile, JSON.stringify(sample) + '\n', 'utf8');
  return { added: true, file: path.basename(targetFile), type: 'preference' };
}

/**
 * 简单去重：检查最近 200 条样本是否有高度相似的 prompt
 */
async function checkDuplicate(prompt) {
  try {
    const content = await fs.readFile(PENDING_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean).slice(-200);
    const promptWords = new Set(prompt.substring(0, 100).split(''));

    for (const line of lines) {
      try {
        const existing = JSON.parse(line);
        const existingWords = new Set(existing.prompt.substring(0, 100).split(''));
        const intersection = [...promptWords].filter(w => existingWords.has(w)).length;
        const similarity = intersection / Math.max(promptWords.size, existingWords.size);
        if (similarity > 0.9) return true;
      } catch (e) { /* skip malformed lines */ }
    }
  } catch (e) {
    // 文件不存在，不需要去重
  }
  return false;
}

async function appendSample(sample) {
  await fs.appendFile(PENDING_FILE, JSON.stringify(sample) + '\n', 'utf8');
}

/**
 * 获取当前待处理样本数量
 */
async function getPendingCount() {
  try {
    const content = await fs.readFile(PENDING_FILE, 'utf8');
    return content.trim().split('\n').filter(Boolean).length;
  } catch (e) {
    return 0;
  }
}

module.exports = { curate, curateNegative, getPendingCount };
