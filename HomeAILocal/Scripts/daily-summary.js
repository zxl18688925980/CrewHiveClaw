#!/usr/bin/env node
/**
 * 每日摘要推送
 * cron: 每天早上 8 点执行
 * 功能：汇总昨日系统运行数据，通过企业微信推送给家庭业主
 *
 * 用法：node scripts/daily-summary.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');

const DATA_DIR = path.join(__dirname, '../data');
const LOG_FILE = path.join(__dirname, '../logs/daily-summary.log');

const WECOM_CORP_ID  = process.env.WECOM_CORP_ID;
const WECOM_SECRET   = process.env.WECOM_SECRET;
const WECOM_AGENT_ID = process.env.WECOM_AGENT_ID;
const WECOM_OWNER_ID = process.env.WECOM_OWNER_ID;

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  await fs.appendFile(LOG_FILE, line + '\n', 'utf8').catch(() => {});
}

// ── 数据采集 ──────────────────────────────────────────────────

async function countTodayRouteEvents() {
  try {
    const file = path.join(DATA_DIR, 'learning/route-events.jsonl');
    const content = await fs.readFile(file, 'utf8');
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const lines = content.trim().split('\n').filter(Boolean);
    const total = lines.length;
    const todayLines = lines.filter(l => {
      try { return JSON.parse(l).timestamp?.startsWith(yesterday); } catch { return false; }
    });
    const cloudCount = todayLines.filter(l => {
      try { return JSON.parse(l).isCloud; } catch { return false; }
    }).length;
    return { total, yesterday: todayLines.length, cloud: cloudCount };
  } catch { return { total: 0, yesterday: 0, cloud: 0 }; }
}

async function countPendingSamples() {
  try {
    const file = path.join(DATA_DIR, 'finetune/pending-samples.jsonl');
    const content = await fs.readFile(file, 'utf8');
    return content.trim().split('\n').filter(Boolean).length;
  } catch { return 0; }
}

async function getConversationCount() {
  try {
    const dir = path.join(__dirname, '../homeclaw/daemons/data/conversation_history');
    const files = await fs.readdir(dir);
    return files.filter(f => f.endsWith('.json')).length;
  } catch { return 0; }
}

async function checkServicesHealth() {
  const services = [
    { name: 'Lucas', url: 'http://localhost:3000/api/health' },
    { name: 'Andy',  url: 'http://localhost:3001/api/health' },
    { name: 'Lisa',  url: 'http://localhost:3002/api/health' },
    { name: '企业微信', url: 'http://localhost:3003/api/health' },
  ];
  const results = await Promise.all(services.map(async s => {
    try {
      await axios.get(s.url, { timeout: 3000 });
      return { name: s.name, ok: true };
    } catch {
      return { name: s.name, ok: false };
    }
  }));
  return results;
}

async function getLastFinetuneDate() {
  try {
    const file = path.join(DATA_DIR, 'finetune/finetune-history.jsonl');
    const content = await fs.readFile(file, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;
    const last = JSON.parse(lines[lines.length - 1]);
    return last.timestamp ? new Date(last.timestamp).toLocaleDateString('zh-CN') : null;
  } catch { return null; }
}

// ── 企业微信推送 ──────────────────────────────────────────────

async function getWeComToken() {
  const r = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
    params: { corpid: WECOM_CORP_ID, corpsecret: WECOM_SECRET }
  });
  if (r.data.errcode !== 0) throw new Error(`gettoken: ${r.data.errmsg}`);
  return r.data.access_token;
}

async function sendWecom(text) {
  if (!WECOM_CORP_ID || !WECOM_SECRET || !WECOM_OWNER_ID) {
    await log('企业微信未配置，跳过推送，摘要内容：\n' + text);
    return;
  }
  const token = await getWeComToken();
  await axios.post(`https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`, {
    touser: WECOM_OWNER_ID, msgtype: 'text',
    agentid: WECOM_AGENT_ID, text: { content: text }
  });
}

// ── 主流程 ────────────────────────────────────────────────────

async function main() {
  await log('=== 每日摘要开始 ===');

  const [routeStats, pendingSamples, convCount, serviceResults, lastFinetune] = await Promise.all([
    countTodayRouteEvents(),
    countPendingSamples(),
    getConversationCount(),
    checkServicesHealth(),
    getLastFinetuneDate(),
  ]);

  const onlineServices = serviceResults.filter(s => s.ok).map(s => s.name);
  const offlineServices = serviceResults.filter(s => !s.ok).map(s => s.name);
  const cloudRatio = routeStats.yesterday > 0
    ? Math.round(routeStats.cloud / routeStats.yesterday * 100)
    : 0;
  const today = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' });

  const summary = [
    `HomeAI 每日摘要 · ${today}`,
    '',
    `服务状态：${onlineServices.length}/4 在线${offlineServices.length > 0 ? '，异常：' + offlineServices.join('、') : '，全部正常'}`,
    '',
    `昨日数据：`,
    `  对话路由：${routeStats.yesterday} 次（云端 ${cloudRatio}%，越低越好）`,
    `  对话用户：${convCount} 个`,
    '',
    `积累进度：`,
    `  微调样本：${pendingSamples}/50 条${pendingSamples >= 50 ? '（已满足微调条件）' : ''}`,
    `  上次微调：${lastFinetune || '尚未执行'}`,
    '',
    `累计路由事件：${routeStats.total} 条`,
  ].join('\n');

  await sendWecom(summary);
  await log('摘要已推送');
  await log('=== 每日摘要完成 ===');
}

main().catch(async e => {
  await log(`致命错误: ${e.message}`);
  process.exit(1);
});
