/**
 * 路由指标追踪器
 * 记录每日云端路由比例、平均置信度、新增样本数
 * 写入 data/metrics/daily-metrics.jsonl
 */

const fs = require('fs').promises;
const path = require('path');

const METRICS_FILE = path.join(__dirname, '../../../data/metrics/daily-metrics.jsonl');

// 内存中的当日指标（进程重启后从文件恢复）
let todayMetrics = null;

function getTodayKey() {
  return new Date().toISOString().substring(0, 10); // YYYY-MM-DD
}

async function getToday() {
  if (todayMetrics && todayMetrics.date === getTodayKey()) {
    return todayMetrics;
  }

  // 尝试从文件加载今日数据
  try {
    const content = await fs.readFile(METRICS_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = JSON.parse(lines[i]);
      if (m.date === getTodayKey()) {
        todayMetrics = m;
        return todayMetrics;
      }
    }
  } catch (e) { /* file may not exist */ }

  todayMetrics = {
    date: getTodayKey(),
    total_requests: 0,
    cloud_requests: 0,
    local_requests: 0,
    cloud_route_ratio: 0,
    avg_confidence: 0,
    confidence_sum: 0,
    sample_count: 0
  };
  return todayMetrics;
}

/**
 * 记录一次路由事件
 */
async function recordRoute({ isCloud, confidence = 0, sampleAdded = false }) {
  const m = await getToday();

  m.total_requests++;
  if (isCloud) m.cloud_requests++;
  else m.local_requests++;

  m.confidence_sum += confidence;
  m.avg_confidence = m.total_requests > 0
    ? m.confidence_sum / m.total_requests
    : 0;
  m.cloud_route_ratio = m.total_requests > 0
    ? m.cloud_requests / m.total_requests
    : 0;

  if (sampleAdded) m.sample_count++;

  await persist(m);
}

async function persist(metrics) {
  // 读现有文件，更新今日行，写回
  let lines = [];
  try {
    const content = await fs.readFile(METRICS_FILE, 'utf8');
    lines = content.trim().split('\n').filter(Boolean);
  } catch (e) { /* first write */ }

  const todayIdx = lines.findIndex(l => {
    try { return JSON.parse(l).date === metrics.date; } catch { return false; }
  });

  const newLine = JSON.stringify(metrics);
  if (todayIdx >= 0) lines[todayIdx] = newLine;
  else lines.push(newLine);

  await fs.writeFile(METRICS_FILE, lines.join('\n') + '\n', 'utf8');
}

/**
 * 获取最近 N 天的指标趋势
 */
async function getTrend(days = 7) {
  try {
    const content = await fs.readFile(METRICS_FILE, 'utf8');
    const lines = content.trim().split('\n').filter(Boolean);
    return lines.slice(-days).map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

module.exports = { recordRoute, getTrend };
