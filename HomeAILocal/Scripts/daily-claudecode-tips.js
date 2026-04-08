#!/usr/bin/env node
/**
 * 每日 Claude Code 技巧推送
 * 每天早上9点给业主推送一条来自中文社区的 Claude Code 实践技巧
 * crontab: 0 9 * * * cd /Users/xinbinanshan/HomeAI && node scripts/daily-claudecode-tips.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
require('dotenv').config({ path: path.join(__dirname, '../.env') });

const CORP_ID   = process.env.WECOM_CORP_ID;
const SECRET    = process.env.WECOM_SECRET;
const AGENT_ID  = process.env.WECOM_AGENT_ID;
const OWNER_ID  = process.env.WECOM_OWNER_ID;

const TIPS_FILE    = path.join(__dirname, '../data/claudecode-tips.json');
const COUNTER_FILE = path.join(__dirname, '../data/claudecode-tips-counter.json');

// ── 读取今日技巧（按天轮播）────────────────────────────────────────────────

function getTodayTip() {
  const tips = JSON.parse(fs.readFileSync(TIPS_FILE, 'utf8'));

  // 读取/更新计数器
  let counter = { index: 0, lastDate: '' };
  if (fs.existsSync(COUNTER_FILE)) {
    counter = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
  }

  const today = new Date().toISOString().slice(0, 10);
  if (counter.lastDate !== today) {
    counter.index = (counter.index + 1) % tips.length;
    counter.lastDate = today;
    fs.writeFileSync(COUNTER_FILE, JSON.stringify(counter, null, 2));
  }

  return tips[counter.index];
}

// ── 构建消息文本 ──────────────────────────────────────────────────────────

function buildMessage(tip) {
  const date = new Date().toLocaleDateString('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' });
  return [
    `【系统工程师日课】${date}`,
    ``,
    `📌 技巧 #${tip.id}：${tip.title}`,
    ``,
    `💡 核心要点`,
    `${tip.corePoints}`,
    ``,
    `🛠 实战案例`,
    `${tip.scenario}`,
    ``,
    `📎 来源：${tip.source}`
  ].join('\n');
}

// ── 企业微信 API ──────────────────────────────────────────────────────────

function httpsPost(url, data) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    };
    const req = https.request(options, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve(JSON.parse(raw)));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let raw = '';
      res.on('data', chunk => raw += chunk);
      res.on('end', () => resolve(JSON.parse(raw)));
    }).on('error', reject);
  });
}

async function getToken() {
  const data = await httpsGet(
    `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${CORP_ID}&corpsecret=${SECRET}`
  );
  if (data.errcode !== 0) throw new Error(`获取 token 失败: ${data.errmsg}`);
  return data.access_token;
}

async function sendText(token, toUser, content) {
  const data = await httpsPost(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
    { touser: toUser, msgtype: 'text', agentid: parseInt(AGENT_ID), text: { content } }
  );
  if (data.errcode !== 0) throw new Error(`发送消息失败: ${data.errmsg}`);
  return data;
}

// ── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  if (!CORP_ID || !SECRET || !AGENT_ID || !OWNER_ID) {
    console.error('缺少企业微信环境变量，请检查 .env');
    process.exit(1);
  }

  const tip = getTodayTip();
  const message = buildMessage(tip);

  console.log(`推送技巧 #${tip.id}：${tip.title}`);

  const token = await getToken();
  await sendText(token, OWNER_ID, message);

  console.log('推送成功');
}

main().catch(err => {
  console.error('推送失败:', err.message);
  process.exit(1);
});
