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

const DATA_DIR = path.join(__dirname, '../data');
const PENDING_FILE = path.join(DATA_DIR, 'finetune/pending-samples.jsonl');
const HISTORY_FILE = path.join(DATA_DIR, 'finetune/finetune-history.jsonl');
const LOG_FILE = path.join(__dirname, '../logs/finetune.log');

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

async function checkConditions() {
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
