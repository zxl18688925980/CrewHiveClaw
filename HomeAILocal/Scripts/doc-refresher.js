#!/usr/bin/env node
/**
 * 文档自动刷新脚本
 * cron: 每天凌晨 1 点
 * 刷新 CLAUDE.md 中「## 当前状态」区块，更新版本号
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs').promises;
const path = require('path');
const { execSync } = require('child_process');
const axios = require('axios');

const CLAUDE_MD = path.join(__dirname, '../CLAUDE.md');
const LOG_FILE  = path.join(__dirname, '../logs/doc-refresh.log');

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  await fs.appendFile(LOG_FILE, line + '\n', 'utf8').catch(() => {});
}

async function getPM2Status() {
  try {
    const out = execSync('pm2 jlist', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
    const list = JSON.parse(out);
    return list.map(p => `${p.name}: ${p.pm2_env?.status || 'unknown'}`).join(', ');
  } catch (e) {
    return '无法获取';
  }
}

async function getMetrics() {
  try {
    const resp = await axios.get('http://localhost:3000/api/metrics', { timeout: 5000 });
    const d = resp.data;
    const latest = d.trend?.[d.trend.length - 1];
    return {
      cloudRatio: latest ? (latest.cloud_route_ratio * 100).toFixed(1) + '%' : 'N/A',
      pendingCount: d.pendingCount || 0,
      routerStats: d.routerStats
    };
  } catch (e) {
    return { cloudRatio: 'N/A', pendingCount: 0 };
  }
}

async function getCorpusCounts() {
  const roles = ['lucas', 'andy', 'lisa'];
  const counts = {};
  for (const role of roles) {
    try {
      const f = path.join(__dirname, `../data/corpus/${role}-corpus.jsonl`);
      const content = await fs.readFile(f, 'utf8');
      counts[role] = content.trim().split('\n').filter(Boolean).length;
    } catch (e) {
      counts[role] = 0;
    }
  }
  return counts;
}

async function getFinetuneCount() {
  try {
    const f = path.join(__dirname, '../data/finetune/finetune-history.jsonl');
    const content = await fs.readFile(f, 'utf8');
    return content.trim().split('\n').filter(Boolean).length;
  } catch (e) { return 0; }
}

async function main() {
  await log('=== 文档刷新开始 ===');

  const [pm2Status, metrics, corpus, finetuneCount] = await Promise.all([
    getPM2Status(),
    getMetrics(),
    getCorpusCounts(),
    getFinetuneCount()
  ]);

  const now = new Date();
  const dateStr = now.toISOString().replace('T', ' ').substring(0, 19);

  const newStatusBlock = `## 当前状态

- 最后刷新：${dateStr}
- PM2 进程：${pm2Status}
- 云端路由比例：${metrics.cloudRatio}（下降趋势 = 本地模型进化中）
- 微调次数：${finetuneCount} 次
- 待微调样本：${metrics.pendingCount} 条
- 语料采集：Lucas ${corpus.lucas}条 / Andy ${corpus.andy}条 / Lisa ${corpus.lisa}条`;

  // 替换 CLAUDE.md 中的当前状态区块
  try {
    let content = await fs.readFile(CLAUDE_MD, 'utf8');
    const statusRegex = /## 当前状态[\s\S]*?(?=\n## |\n# |$)/;

    if (statusRegex.test(content)) {
      content = content.replace(statusRegex, newStatusBlock + '\n\n');
    } else {
      content += '\n\n' + newStatusBlock + '\n';
    }

    await fs.writeFile(CLAUDE_MD, content, 'utf8');
    await log('✅ CLAUDE.md 当前状态区块已更新');
  } catch (e) {
    await log(`❌ CLAUDE.md 更新失败: ${e.message}`);
  }

  await log('=== 文档刷新完成 ===');
}

main().catch(e => {
  console.error('[doc-refresher] 错误:', e.message);
  process.exit(1);
});
