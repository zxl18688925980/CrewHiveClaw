#!/usr/bin/env node
/**
 * MLX 增量微调调度器
 * cron: 每周日凌晨 2 点触发
 * 触发条件：样本数 >= 50 && 距上次微调 >= 7 天 && 系统负载 < 70%
 *
 * 用法：
 *   node scripts/finetune-scheduler.js           # 正常检查条件后执行
 *   node scripts/finetune-scheduler.js --force-run  # 跳过条件检查，强制执行
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs').promises;
const path = require('path');
const { execSync, spawn } = require('child_process');

// 统一数据根目录：与插件 PROJECT_ROOT 一致（~/HomeAI/data）
const HOMEAI_ROOT = process.env.HOMEAI_ROOT || path.join(require('os').homedir(), 'HomeAI');
const DATA_DIR = path.join(HOMEAI_ROOT, 'data');
const FINETUNE_QUEUE_FILE = path.join(DATA_DIR, 'learning/finetune-queue.jsonl');  // 插件写入
const PENDING_FILE = path.join(DATA_DIR, 'finetune/pending-samples.jsonl');         // 训练脚本读取
const HISTORY_FILE = path.join(DATA_DIR, 'finetune/finetune-history.jsonl');
const LOG_FILE = path.join(HOMEAI_ROOT, 'Logs/finetune.log');

const MIN_SAMPLES = 50;
const MIN_DAYS_BETWEEN = 7;

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  await fs.appendFile(LOG_FILE, line + '\n', 'utf8').catch(() => {});
}

async function getPendingCount() {
  try {
    const content = await fs.readFile(PENDING_FILE, 'utf8');
    return content.trim().split('\n').filter(Boolean).length;
  } catch (e) { return 0; }
}

async function getLastFinetuneDate() {
  try {
    const content = await fs.readFile(HISTORY_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return new Date(last.timestamp);
  } catch (e) { return null; }
}

function getSystemLoad() {
  try {
    const out = execSync('sysctl -n vm.loadavg', { encoding: 'utf8' });
    const match = out.match(/([\d.]+)/);
    if (match) return parseFloat(match[1]) * 10; // rough % on single core
    return 0;
  } catch (e) { return 0; }
}

/**
 * 桥接：finetune-queue.jsonl（插件写入，{prompt,response,qualityScore}）
 *     → pending-samples.jsonl（训练脚本读取，{input,output}）
 * 追加模式：只转尚未转换的新条目（通过 pending 行数跳过已转换的）。
 */
async function convertQueueToPending() {
  try {
    // 读取 queue
    const queueContent = await fs.readFile(FINETUNE_QUEUE_FILE, 'utf8').catch(() => '');
    if (!queueContent.trim()) return;
    const queueLines = queueContent.trim().split('\n').filter(Boolean);

    // 读取已有的 pending（计算已转换数量）
    const pendingContent = await fs.readFile(PENDING_FILE, 'utf8').catch(() => '');
    const alreadyConverted = pendingContent.trim() ? pendingContent.trim().split('\n').filter(Boolean).length : 0;

    if (alreadyConverted >= queueLines.length) return;  // 无新数据

    // 转换新条目
    const newSamples = [];
    for (let i = alreadyConverted; i < queueLines.length; i++) {
      try {
        const entry = JSON.parse(queueLines[i]);
        if (entry.prompt && entry.response) {
          newSamples.push(JSON.stringify({
            input: entry.prompt,
            output: entry.response,
            agentId: entry.agentId || 'unknown',
            qualityScore: entry.qualityScore || 0,
          }));
        }
      } catch (_) { /* skip malformed */ }
    }

    if (newSamples.length === 0) return;

    await fs.mkdir(path.dirname(PENDING_FILE), { recursive: true });
    await fs.appendFile(PENDING_FILE, newSamples.join('\n') + '\n', 'utf8');
    await log(`桥接完成: ${newSamples.length} 条新样本 → ${PENDING_FILE}（总计 ${alreadyConverted + newSamples.length} 条）`);
  } catch (e) {
    await log(`桥接失败: ${e.message}`);
  }
}

async function checkConditions() {
  // 先将 finetune-queue 转为 pending-samples（桥接插件→训练脚本）
  await convertQueueToPending();

  const pendingCount = await getPendingCount();
  const lastDate = await getLastFinetuneDate();
  const daysSinceLast = lastDate
    ? (Date.now() - lastDate.getTime()) / 86400000
    : 999;
  const load = getSystemLoad();

  await log(`条件检查 — 样本数: ${pendingCount}, 距上次微调: ${daysSinceLast.toFixed(1)}天, 系统负载: ${load.toFixed(1)}%`);

  if (pendingCount < MIN_SAMPLES) {
    await log(`❌ 样本不足（${pendingCount} < ${MIN_SAMPLES}），跳过`);
    return false;
  }
  if (daysSinceLast < MIN_DAYS_BETWEEN) {
    await log(`❌ 距上次微调不足 ${MIN_DAYS_BETWEEN} 天，跳过`);
    return false;
  }
  if (load > 70) {
    await log(`❌ 系统负载过高（${load.toFixed(1)}%），跳过`);
    return false;
  }
  return true;
}

async function runFinetune() {
  await log('🚀 开始执行微调...');

  return new Promise((resolve, reject) => {
    const script = path.join(__dirname, 'run-finetune.sh');
    const proc = spawn('bash', [script], {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env }
    });

    proc.stdout.on('data', d => log(`[finetune] ${d.toString().trim()}`).catch(() => {}));
    proc.stderr.on('data', d => log(`[finetune:err] ${d.toString().trim()}`).catch(() => {}));

    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`run-finetune.sh 退出码: ${code}`));
    });
  });
}

async function recordHistory(success, detail = '') {
  const record = {
    timestamp: new Date().toISOString(),
    success,
    detail,
    pendingCount: await getPendingCount()
  };
  await fs.appendFile(HISTORY_FILE, JSON.stringify(record) + '\n', 'utf8');
}

async function main() {
  const forceRun = process.argv.includes('--force-run');
  await log(`=== 微调调度器启动 ${forceRun ? '(强制模式)' : ''} ===`);

  const shouldRun = forceRun || await checkConditions();
  if (!shouldRun) {
    await log('调度器退出，条件未满足');
    process.exit(0);
  }

  try {
    await runFinetune();
    await recordHistory(true, '微调完成');
    await log('✅ 微调成功完成');
    process.exit(0);
  } catch (e) {
    await recordHistory(false, e.message);
    await log(`❌ 微调失败: ${e.message}`);
    process.exit(1);
  }
}

main();
