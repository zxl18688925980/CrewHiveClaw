'use strict';
/**
 * token-daily-summary.js
 * 每日 Token 消耗摘要：构建文案 + 发送企业微信私聊给 ZengXiaoLong
 *
 * 导出：
 *   buildTokenDailySummary()   → Promise<string>  摘要文案
 *   sendTokenDailySummary(sendWeComMessage) → Promise<void>
 *
 * 被 wecom/index.js 在每日 CST 21:30 窗口调用，不依赖独立 PM2 或外部 cron。
 */

const path = require('path');

// 复用 token-dashboard server.js 的共享 helper，避免两套漂移逻辑
const SERVER_PATH = path.join(
  process.env.HOME, 'HomeAI', 'App', 'generated', 'token-dashboard', 'server.js'
);

const OWNER_ID = 'ZengXiaoLong';

// ── 辅助格式化 ─────────────────────────────────────────────────────────────
function fmtCost(v) {
  if (v == null || isNaN(v)) return '$0.0000';
  return '$' + v.toFixed(4);
}

function fmtChange(pct) {
  if (pct == null) return '（无对比数据）';
  const sign = pct >= 0 ? '↑' : '↓';
  return `${sign}${Math.abs(pct)}%`;
}

// ── 构建摘要文案 ────────────────────────────────────────────────────────────
async function buildTokenDailySummary() {
  // 动态 require，确保每次调用都读最新数据（server.js 内部有 5 分钟缓存，这里绕过）
  let serverModule;
  try {
    // 清除模块缓存，确保读到最新 budget.json
    delete require.cache[require.resolve(SERVER_PATH)];
    serverModule = require(SERVER_PATH);
  } catch (e) {
    throw new Error(`加载 token-dashboard server.js 失败: ${e.message}`);
  }

  const { buildStats, readBudget } = serverModule;
  const stats  = buildStats();
  const budget = readBudget();

  const today     = stats.today_cost_usd     ?? 0;
  const yesterday = stats.yesterday_cost_usd ?? 0;
  const month     = stats.month_cost_usd     ?? 0;
  const budgetVal = budget.monthlyBudgetUsd;

  // 与昨日、上周对比
  const vsDayPct  = stats.comparisons?.today_vs_yesterday;
  const vsWeekPct = stats.comparisons?.today_vs_last_week;

  // Agent 月度分布（最多显示 5 个）
  const breakdown = (stats.agent_monthly_breakdown || []).slice(0, 5);

  // ── 组装文案 ──────────────────────────────────────────────────────────────
  const lines = [];
  lines.push('📊 HomeAI Token 日报');
  lines.push('');

  // 今日
  lines.push(`🗓 今日消耗：${fmtCost(today)}`);
  lines.push(`  较昨日：${fmtChange(vsDayPct)}  较上周同日：${fmtChange(vsWeekPct)}`);
  lines.push(`  昨日消耗：${fmtCost(yesterday)}`);
  lines.push('');

  // 本月
  if (budgetVal != null) {
    const remaining = budgetVal - month;
    const pct = budgetVal > 0 ? Math.round(month / budgetVal * 100) : 0;
    const overBudget = month > budgetVal;
    lines.push(`📅 本月累计：${fmtCost(month)}`);
    lines.push(`💰 本月预算：$${budgetVal.toFixed(2)}`);
    if (overBudget) {
      lines.push(`🔴 已超预算！超出 ${fmtCost(Math.abs(remaining))}（已用 ${pct}%）`);
    } else {
      lines.push(`✅ 剩余：${fmtCost(remaining)}（已用 ${pct}%）`);
    }
  } else {
    lines.push(`📅 本月累计：${fmtCost(month)}`);
    lines.push(`💰 本月预算：未设置`);
  }
  lines.push('');

  // Agent 月度分布
  if (breakdown.length > 0) {
    lines.push('🤖 本月 Agent 分布（按费用）：');
    for (const item of breakdown) {
      const name = (item.agent.charAt(0).toUpperCase() + item.agent.slice(1)).padEnd(12);
      lines.push(`  ${name} ${fmtCost(item.cost)}`);
    }
  }

  lines.push('');
  lines.push(`📌 数据截止 CST ${new Date(Date.now() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16)}`);

  return lines.join('\n');
}

// ── 发送摘要 ────────────────────────────────────────────────────────────────
// sendWeComMessageFn: 由 wecom/index.js 注入的 sendWeComMessage 函数
async function sendTokenDailySummary(sendWeComMessageFn) {
  const text = await buildTokenDailySummary();
  await sendWeComMessageFn(OWNER_ID, text);
}

module.exports = { buildTokenDailySummary, sendTokenDailySummary };
