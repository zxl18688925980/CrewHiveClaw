#!/usr/bin/env node
/**
 * HomeClaw Monitor - TUI 监控面板
 * 观察语料质量、路由趋势、本地模型状态、云端模拟器协同
 *
 * 用法：node scripts/monitor.js
 * 退出：q 或 Ctrl+C
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const blessed = require('blessed');
const contrib  = require('blessed-contrib');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const { execSync } = require('child_process');

const DATA_DIR    = path.join(__dirname, '../data');
const REFRESH_MS  = 5000;
const CLOUD_SIM   = process.env.CLOUD_SIM_PORT
  ? `http://localhost:${process.env.CLOUD_SIM_PORT}`
  : 'http://localhost:4000';

// ── 布局（16行 × 12列）────────────────────────────────────────

const screen = blessed.screen({
  smartCSR:    true,
  title:       'HomeClaw Monitor',
  fullUnicode: true,        // 支持 CJK 双宽字符
  encoding:    'utf8'
});
const grid   = new contrib.grid({ rows: 16, cols: 12, screen });

// 左上：服务状态
const serviceBox = grid.set(0, 0, 4, 3, blessed.box, {
  label: ' 服务状态 ',
  border: { type: 'line' },
  style: { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } },
  tags: true,
  padding: { left: 1 }
});

// 右上：云端路由比例趋势折线图
const routeChart = grid.set(0, 3, 4, 9, contrib.line, {
  label: ' 云端路由比例趋势（7天，越低越好）',
  border: { type: 'line' },
  style: { border: { fg: 'yellow' }, label: { fg: 'yellow', bold: true }, line: 'red' },
  minY: 0,
  maxY: 100,
  xLabelPadding: 3,
  xPadding: 5,
  numYLabels: 5,
  showLegend: true
});

// 中左：语料 & 样本统计
const corpusBox = grid.set(4, 0, 4, 4, blessed.box, {
  label: ' 语料 & 样本 ',
  border: { type: 'line' },
  style: { border: { fg: 'green' }, label: { fg: 'green', bold: true } },
  tags: true,
  padding: { left: 1 }
});

// 中右：最近路由事件
const eventsTable = grid.set(4, 4, 4, 8, contrib.table, {
  label: ' 最近路由事件 ',
  border: { type: 'line' },
  style: { border: { fg: 'magenta' }, label: { fg: 'magenta', bold: true }, header: { fg: 'white', bold: true } },
  columnSpacing: 2,
  columnWidth: [10, 8, 6, 40]
});

// 下左：模型快测
const modelBox = grid.set(8, 0, 4, 4, blessed.box, {
  label: ' 本地模型质量 ',
  border: { type: 'line' },
  style: { border: { fg: 'blue' }, label: { fg: 'blue', bold: true } },
  tags: true,
  padding: { left: 1 }
});

// 下右：日志滚动
const logBox = grid.set(8, 4, 4, 8, contrib.log, {
  label: ' 系统日志 ',
  border: { type: 'line' },
  style: { border: { fg: 'white' }, label: { fg: 'white', bold: true } },
  tags: true
});

// ── 新增：云端模拟器面板（第12-16行）────────────────────────────

// 云端状态（左）
const cloudBox = grid.set(12, 0, 4, 5, blessed.box, {
  label: ' 云端模拟器状态 ',
  border: { type: 'line' },
  style: { border: { fg: 'cyan' }, label: { fg: 'cyan', bold: true } },
  tags: true,
  padding: { left: 1 }
});

// 本地↔云端协同状态（中）
const syncBox = grid.set(12, 5, 4, 4, blessed.box, {
  label: ' 本地↔云端同步 ',
  border: { type: 'line' },
  style: { border: { fg: 'yellow' }, label: { fg: 'yellow', bold: true } },
  tags: true,
  padding: { left: 1 }
});

// 群体进化效应（右）
const evolutionBox = grid.set(12, 9, 4, 3, blessed.box, {
  label: ' 群体进化效应 ',
  border: { type: 'line' },
  style: { border: { fg: 'green' }, label: { fg: 'green', bold: true } },
  tags: true,
  padding: { left: 1 }
});

// 退出 & 刷新
screen.key(['q', 'C-c'], () => process.exit(0));
screen.key(['r'], () => { sysLog('{yellow-fg}手动刷新{/}'); refresh(); });

// ── 工具函数 ─────────────────────────────────────────────────

function sysLog(msg) {
  const ts = new Date().toLocaleTimeString('zh-CN');
  logBox.log(`{gray-fg}[${ts}]{/} ${msg}`);
}

function fileLines(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    return content.trim().split('\n').filter(Boolean).length;
  } catch (e) { return 0; }
}

function lastJsonLines(filePath, n = 5) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8')
      .trim().split('\n').filter(Boolean).slice(-n);
    return lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch (e) { return []; }
}

// ── 数据获取 ──────────────────────────────────────────────────

async function fetchServices() {
  const checks = [
    { name: 'lucas', url: 'http://localhost:3000/api/health' },
    { name: 'andy',  url: 'http://localhost:3001/api/health' },
    { name: 'lisa',  url: 'http://localhost:3002/api/health' },
    { name: 'ollama', url: 'http://localhost:11434/api/tags' },
    { name: 'chroma', url: 'http://localhost:8000/api/v2/heartbeat' },
    { name: 'cloud-sim', url: `${CLOUD_SIM}/status` }
  ];

  return Promise.all(checks.map(async s => {
    try {
      await axios.get(s.url, { timeout: 3000 });
      return { name: s.name, ok: true };
    } catch (e) {
      return { name: s.name, ok: false };
    }
  }));
}

async function fetchMetrics() {
  try {
    const r = await axios.get('http://localhost:3000/api/metrics', { timeout: 5000 });
    return r.data;
  } catch (e) {
    return null;
  }
}

async function fetchCloudSim() {
  try {
    const [statusRes, reportRes] = await Promise.all([
      axios.get(`${CLOUD_SIM}/status`, { timeout: 5000 }),
      axios.get(`${CLOUD_SIM}/simulate/evolution-report`, { timeout: 5000 })
    ]);
    return { status: statusRes.data, report: reportRes.data };
  } catch (e) {
    return null;
  }
}

async function testLocalModel() {
  const questions = [
    '你是谁？',
    '今天天气不错',
    '帮我写一首短诗'
  ];

  const results = [];
  for (const q of questions) {
    try {
      const start = Date.now();
      const r = await axios.post('http://localhost:11434/v1/chat/completions', {
        model: process.env.LOCAL_MODEL_NAME || 'homeai-assistant',
        messages: [{ role: 'user', content: q }],
        max_tokens: 60
      }, {
        headers: { Authorization: 'Bearer ollama' },
        timeout: 15000
      });
      const ms = Date.now() - start;
      const resp = r.data.choices?.[0]?.message?.content || '';
      results.push({ q, resp: resp.substring(0, 40), ms, ok: true });
    } catch (e) {
      results.push({ q, resp: e.message.substring(0, 30), ms: 0, ok: false });
    }
  }
  return results;
}

// ── 渲染 ──────────────────────────────────────────────────────

function renderServices(services) {
  const lines = services.map(s => {
    const dot   = s.ok ? '{green-fg}●{/}' : '{red-fg}●{/}';
    const state = s.ok ? '{green-fg}online{/}' : '{red-fg}offline{/}';
    const name  = s.name.padEnd(10);
    return `  ${dot} ${name} ${state}`;
  });
  serviceBox.setContent(lines.join('\n'));
}

function renderRouteChart(metrics) {
  if (!metrics?.trend?.length) {
    routeChart.setData([{
      title: '云端路由%',
      x: ['暂无数据'],
      y: [0],
      style: { line: 'red' }
    }]);
    return;
  }

  const trend  = metrics.trend;
  const labels = trend.map(d => d.date.substring(5)); // MM-DD
  const values = trend.map(d => Math.round(d.cloud_route_ratio * 100));

  routeChart.setData([{
    title: `云端路由% (当前 ${values[values.length - 1]}%)`,
    x: labels,
    y: values,
    style: { line: 'red' }
  }]);
}

function renderCorpus(metrics) {
  const roles = ['lucas', 'andy', 'lisa'];
  const counts = roles.map(r => {
    const n = fileLines(path.join(DATA_DIR, `corpus/${r}-corpus.jsonl`));
    const color = n > 0 ? 'green' : 'gray';
    return `  {${color}-fg}${r.padEnd(8)}{/} ${String(n).padStart(4)} 条`;
  });

  const events = fileLines(path.join(DATA_DIR, 'learning/route-events.jsonl'));
  const pending = metrics?.pendingCount ?? fileLines(path.join(DATA_DIR, 'finetune/pending-samples.jsonl'));
  const history = fileLines(path.join(DATA_DIR, 'finetune/finetune-history.jsonl'));

  const pendingColor = pending >= 50 ? 'green' : pending > 10 ? 'yellow' : 'red';

  corpusBox.setContent([
    '{bold}语料文件{/}',
    ...counts,
    '',
    '{bold}学习数据{/}',
    `  路由事件    ${String(events).padStart(4)} 条`,
    `  待微调样本  {${pendingColor}-fg}${String(pending).padStart(4)} 条{/} (阈值 50)`,
    `  微调历史    ${String(history).padStart(4)} 次`,
    '',
    `  云端路由率  ${metrics?.routerStats ? (parseFloat(metrics.routerStats.cloudRatio)) + '' : 'N/A'}`
  ].join('\n'));
}

function renderEvents(metrics) {
  const events = metrics?.recentEvents || lastJsonLines(path.join(DATA_DIR, 'learning/route-events.jsonl'), 8);

  const rows = events.slice().reverse().map(e => {
    const ts    = e.timestamp ? e.timestamp.substring(11, 19) : '--:--:--';
    const model = e.isCloud ? 'cloud' : 'local';
    const score = e.quality?.score != null ? e.quality.score.toFixed(2) : ' -- ';
    const req   = (e.request || '').substring(0, 35).replace(/\n/g, ' ');
    return [ts, model, score, req];
  });

  eventsTable.setData({
    headers: ['时间', '模型', '质量', '请求摘要'],
    data: rows.length ? rows : [['--', '--', '--', '暂无事件']]
  });
}

function renderModelTest(results) {
  if (!results) {
    modelBox.setContent('  {gray-fg}Ollama 不可用或未响应{/}');
    return;
  }

  const lines = ['{bold}测试问题 → 响应摘要{/}', ''];
  for (const r of results) {
    const icon  = r.ok ? '{green-fg}✓{/}' : '{red-fg}✗{/}';
    const ms    = r.ok ? `{gray-fg}${r.ms}ms{/}` : '';
    const resp  = r.ok ? `{white-fg}${r.resp}{/}` : `{red-fg}${r.resp}{/}`;
    lines.push(`  ${icon} {cyan-fg}${r.q}{/} ${ms}`);
    lines.push(`      ${resp}`);
    lines.push('');
  }
  modelBox.setContent(lines.join('\n'));
}

function renderCloudSim(cloudData, localMetrics) {
  if (!cloudData) {
    cloudBox.setContent('  {red-fg}云端模拟器离线{/}\n  启动：node scripts/cloud-simulator.js');
    syncBox.setContent('  {gray-fg}等待云端模拟器{/}');
    evolutionBox.setContent('  {gray-fg}暂无数据{/}');
    return;
  }

  const { status, report } = cloudData;

  // ── 云端状态面板 ──
  const roles = ['lucas', 'andy', 'lisa'];
  const cloudCorpus = roles.map(r => {
    const c = status.corpus?.[r];
    if (!c) return `  {gray-fg}${r.padEnd(6)}{/}  0条`;
    const color = c.total_lines > 0 ? 'green' : 'gray';
    return `  {${color}-fg}${r.padEnd(6)}{/}  ${c.total_lines}条 (${c.families}家庭)`;
  });

  cloudBox.setContent([
    `{bold}地址{/} {cyan-fg}${CLOUD_SIM}{/}   {green-fg}● running{/}`,
    '',
    `  家庭数:   {yellow-fg}${status.families}{/}`,
    `  微调轮次: {yellow-fg}${status.finetune_rounds}{/}`,
    `  Readme版本: {yellow-fg}v${status.readme_version}{/}`,
    '',
    '{bold}云端语料库{/}',
    ...cloudCorpus
  ].join('\n'));

  // ── 同步状态面板 ──
  const localCounts = roles.map(r => {
    return fileLines(path.join(DATA_DIR, `corpus/${r}-corpus.jsonl`));
  });
  const cloudCounts = roles.map(r => status.corpus?.[r]?.total_lines || 0);

  const syncLines = ['{bold}本地 → 云端{/}', ''];
  roles.forEach((r, i) => {
    const local = localCounts[i];
    const cloud = cloudCounts[i];
    const arrow = local > 0 ? '{green-fg}→{/}' : '{gray-fg}→{/}';
    syncLines.push(`  ${r.padEnd(6)} ${String(local).padStart(3)} ${arrow} ${String(cloud).padStart(3)}`);
  });

  const cloudRatio = localMetrics?.routerStats?.cloudRatio ?? 'N/A';
  syncLines.push('');
  syncLines.push(`{bold}当前云端路由率{/}`);
  syncLines.push(`  {yellow-fg}${cloudRatio}{/}`);

  const lastFt = status.last_finetune
    ? status.last_finetune.substring(0, 16).replace('T', ' ')
    : '暂无';
  syncLines.push('');
  syncLines.push(`{bold}末次微调{/}`);
  syncLines.push(`  {gray-fg}${lastFt}{/}`);
  syncBox.setContent(syncLines.join('\n'));

  // ── 群体进化效应面板 ──
  if (!report || report.message) {
    evolutionBox.setContent('  {gray-fg}暂无微调记录{/}\n\n  执行:\n  POST /simulate/finetune');
    return;
  }

  const latest = report.quality_trend?.[report.quality_trend.length - 1];
  const lines = [
    `{bold}家庭数{/}  {yellow-fg}${report.summary?.families}{/}`,
    `{bold}轮次{/}    {yellow-fg}${report.summary?.finetune_rounds}{/}`,
    ''
  ];

  if (latest) {
    const imp = latest.quality?.improvement || '';
    const isMulti = imp.startsWith('+');
    const color = isMulti ? 'green' : 'yellow';
    lines.push(`{bold}单家庭{/} ${latest.quality?.single_family_baseline}`);
    lines.push(`{bold}多家庭{/} ${latest.quality?.multi_family_result}`);
    lines.push('');
    lines.push(`{${color}-fg}${imp}{/}`);
  }

  evolutionBox.setContent(lines.join('\n'));
}

// ── 主刷新循环 ────────────────────────────────────────────────

let modelTestCache = null;
let modelTestTs    = 0;
let cloudSimCache  = null;
let cloudSimTs     = 0;

async function refresh() {
  sysLog('刷新中...');

  const [services, metrics] = await Promise.all([
    fetchServices(),
    fetchMetrics()
  ]);

  renderServices(services);
  renderRouteChart(metrics);
  renderCorpus(metrics);
  renderEvents(metrics);

  // 本地模型测试每 60 秒刷新一次
  if (Date.now() - modelTestTs > 60000) {
    modelTestTs = Date.now();
    sysLog('测试本地模型...');
    modelTestCache = await testLocalModel().catch(() => null);
  }
  renderModelTest(modelTestCache);

  // 云端模拟器状态每 10 秒刷新一次
  if (Date.now() - cloudSimTs > 10000) {
    cloudSimTs = Date.now();
    cloudSimCache = await fetchCloudSim().catch(() => null);
  }
  renderCloudSim(cloudSimCache, metrics);

  const onlineCount = services.filter(s => s.ok).length;
  sysLog(`刷新完成 — 服务 ${onlineCount}/${services.length} online, 云端 ${cloudSimCache ? '✓' : '✗'}`);

  screen.render();
}

// ── 启动 ─────────────────────────────────────────────────────

screen.render();
sysLog('{cyan-fg}HomeClaw Monitor 启动{/} (q 退出, r 手动刷新)');
sysLog(`云端模拟器: {yellow-fg}${CLOUD_SIM}{/}`);

refresh();
setInterval(refresh, REFRESH_MS);
