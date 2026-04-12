#!/usr/bin/env node
/**
 * gateway-watchdog.js
 * 三重保活：Gateway + Ollama + cloudflared tunnel。
 *
 * Gateway    ：每轮发一个真实 LLM 请求，3 分钟内无响应则重启。
 * Ollama     ：探测 /api/embed，失败则 launchctl kickstart 重启。
 * cloudflared：探测 metrics 端口（20241），进程退出则 pm2 delete+start 重新注册。
 *
 * 用 pm2 启动：pm2 start gateway-watchdog.js --name gateway-watchdog
 */

const { execSync, spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

// kuzu 安装在 Python 3.11 下；PM2 非交互 shell 的 python3 指向 3.14（无 kuzu）
// 必须用绝对路径确保正确的 Python 解释器
const PYTHON3 = '/opt/homebrew/opt/python@3.11/bin/python3.11';
const http = require('http');

const CHECK_INTERVAL_MS = 3_600_000;  // 1 小时检查一次
const PROBE_TIMEOUT_MS  = 180_000;  // 3 分钟内没回应 = 挂死（本地模型响应可能需要几分钟）
const LOG_FILE = path.join(__dirname, '../logs/pm2/gateway-watchdog.log');

const HOMEAI_ROOT           = path.join(__dirname, '..');       // ~/HomeAI/CrewHiveClaw
const SCRIPTS_DIR           = __dirname;                        // ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts
const DISTILL_SCRIPT        = path.join(SCRIPTS_DIR, 'distill-memories.py');
const DISTILL_LOG           = path.join(HOMEAI_ROOT, 'HomeAILocal', 'logs', 'distill-memories.log');
const DISTILL_AGENTS_SCRIPT  = path.join(SCRIPTS_DIR, 'distill-agent-memories.py');
const DISTILL_AGENTS_LOG     = path.join(HOMEAI_ROOT, 'HomeAILocal', 'logs', 'distill-agent-memories.log');
const TEAM_OBS_SCRIPT        = path.join(SCRIPTS_DIR, 'distill-team-observations.py');
const TEAM_OBS_LOG           = path.join(HOMEAI_ROOT, 'HomeAILocal', 'logs', 'distill-team-observations.log');
const DESIGN_LEARN_SCRIPT    = path.join(SCRIPTS_DIR, 'distill-design-learnings.py');
const DESIGN_LEARN_LOG       = path.join(HOMEAI_ROOT, 'HomeAILocal', 'logs', 'distill-design-learnings.log');
const IMPL_LEARN_SCRIPT      = path.join(SCRIPTS_DIR, 'distill-impl-learnings.py');
const IMPL_LEARN_LOG         = path.join(HOMEAI_ROOT, 'HomeAILocal', 'logs', 'distill-impl-learnings.log');
const LEARN_OBJ_SCRIPT       = path.join(SCRIPTS_DIR, 'distill-learning-objectives.py');
const LEARN_OBJ_LOG          = path.join(HOMEAI_ROOT, 'HomeAILocal', 'logs', 'distill-learning-objectives.log');
const KNOW_DISC_SCRIPT       = path.join(SCRIPTS_DIR, 'distill-knowledge-discussions.py');
const KNOW_DISC_LOG          = path.join(HOMEAI_ROOT, 'HomeAILocal', 'logs', 'distill-knowledge-discussions.log');
const COLLAB_DISTILL_SCRIPT  = path.join(SCRIPTS_DIR, 'distill-relationship-dynamics.py');
const COLLAB_DISTILL_LOG     = path.join(HOMEAI_ROOT, 'HomeAILocal', 'logs', 'distill-relationship-dynamics.log');
const CODE_GRAPH_SCRIPT      = path.join(SCRIPTS_DIR, 'build-code-graph.py');
const CODE_GRAPH_LOG         = path.join(HOMEAI_ROOT, 'HomeAILocal', 'logs', 'build-code-graph.log');

let token = '';
try {
  const cfg = JSON.parse(fs.readFileSync(
    path.join(process.env.HOME, '.openclaw', 'openclaw.json'), 'utf8'
  ));
  token = cfg?.gateway?.auth?.token || '';
} catch (_) {}

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (_) {}
}

function probe() {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'openclaw/lucas',
      messages: [{ role: 'user', content: 'watchdog probe' }],
      user: `watchdog:${Date.now()}`,
      stream: false,
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 18789,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        clearTimeout(hardTimer);
        try {
          const json = JSON.parse(data);
          const content = json?.choices?.[0]?.message?.content;
          // 必须有非空 content 才算正常——防止 Gateway 返回空 body 或 error JSON 被误判为正常
          resolve({ ok: !!content, status: res.statusCode, content: content?.substring(0, 30) });
        } catch (_) {
          resolve({ ok: false, status: res.statusCode, error: 'invalid JSON body' });
        }
      });
    });
    req.on('error', (e) => { clearTimeout(hardTimer); resolve({ ok: false, error: e.message }); });
    // req.setTimeout 只计 socket 空闲时间，收到 HTTP headers 后就复位，无法限制总响应时长。
    // 用独立 hardTimer 强制截止整个请求（包括 LLM 生成时间）。
    const hardTimer = setTimeout(() => {
      req.destroy();
      resolve({ ok: false, error: `timeout ${PROBE_TIMEOUT_MS}ms` });
    }, PROBE_TIMEOUT_MS);
    req.write(body);
    req.end();
  });
}

// ── Ollama 保活 ──────────────────────────────────────────────────────────────

const OLLAMA_TIMEOUT_MS = 10_000;  // embedding 请求应在 10 秒内返回

function probeOllama() {
  return new Promise((resolve) => {
    const body = JSON.stringify({ model: 'nomic-embed-text', input: 'watchdog' });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 11434,
      path: '/api/embed',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        clearTimeout(timer);
        try {
          const json = JSON.parse(data);
          // embeddings 是非空数组即为正常
          resolve({ ok: Array.isArray(json?.embeddings) && json.embeddings.length > 0, status: res.statusCode });
        } catch (_) {
          resolve({ ok: false, status: res.statusCode, error: 'invalid JSON' });
        }
      });
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    const timer = setTimeout(() => { req.destroy(); resolve({ ok: false, error: `timeout ${OLLAMA_TIMEOUT_MS}ms` }); }, OLLAMA_TIMEOUT_MS);
    req.write(body);
    req.end();
  });
}

function restartOllama() {
  log('Ollama embedding 异常，执行重启...');
  try {
    // Ollama 由 Ollama App 注册到 launchd（无 plist 文件），用 kickstart 重启
    execSync(
      'launchctl kickstart -k gui/$UID/com.ollama.ollama 2>/dev/null || true',
      { shell: true, env: { ...process.env, UID: String(process.getuid()) } }
    );
    log('Ollama 重启指令已发出，等待启动...');
  } catch (e) {
    log(`Ollama 重启失败: ${e.message}`);
  }
}

async function checkOllama() {
  const result = await probeOllama();
  if (result.ok) {
    log(`Ollama 正常 (HTTP ${result.status})`);
  } else {
    log(`Ollama 异常: ${result.error || result.status} → 触发重启`);
    restartOllama();
    // 等 15 秒让 Ollama 完成启动后再复查
    await new Promise(r => setTimeout(r, 15_000));
    const recheck = await probeOllama();
    log(recheck.ok
      ? `Ollama 重启后恢复正常 (HTTP ${recheck.status})`
      : `Ollama 重启后仍异常: ${recheck.error || recheck.status}`
    );
  }
}

// ── mlx-vision 保活（Qwen2.5-VL，端口 8081）─────────────────────────────────

const MLX_VISION_TIMEOUT_MS = 15_000;  // 轻量探活请求 15s 超时

function probeMlxVision() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: 8081,
      path: '/health',
      method: 'GET',
    }, (res) => {
      clearTimeout(timer);
      resolve({ ok: res.statusCode === 200, status: res.statusCode });
      res.resume();  // 消耗 body，防止 socket hang
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    const timer = setTimeout(() => { req.destroy(); resolve({ ok: false, error: `timeout ${MLX_VISION_TIMEOUT_MS}ms` }); }, MLX_VISION_TIMEOUT_MS);
    req.end();
  });
}

function restartMlxVision() {
  log('mlx-vision 异常，通过 PM2 重启...');
  try {
    execSync('pm2 restart mlx-vision 2>/dev/null || true', { shell: true });
    log('mlx-vision PM2 重启指令已发出（模型加载约 5s）');
  } catch (e) {
    log(`mlx-vision PM2 重启失败: ${e.message}`);
  }
}

async function checkMlxVision() {
  const result = await probeMlxVision();
  if (result.ok) {
    log(`mlx-vision 正常 (HTTP ${result.status})`);
  } else {
    log(`mlx-vision 异常: ${result.error || result.status} → 触发 PM2 重启`);
    restartMlxVision();
    await new Promise(r => setTimeout(r, 30_000));  // 等 30s 让模型重新加载
    const recheck = await probeMlxVision();
    log(recheck.ok
      ? `mlx-vision 重启后恢复正常 (HTTP ${recheck.status})`
      : `mlx-vision 重启后仍异常: ${recheck.error || recheck.status}`
    );
  }
}

// ── ChromaDB 保活 ────────────────────────────────────────────────────────────

const CHROMADB_PORT       = 8001;
const CHROMADB_TIMEOUT_MS = 10_000;

function probeChromaDB() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: 'localhost',   // 用 localhost 而非 127.0.0.1，兼容 IPv4/IPv6 双栈
      port: CHROMADB_PORT,
      path: '/api/v2/heartbeat',
      method: 'GET',
    }, (res) => {
      clearTimeout(timer);
      resolve({ ok: res.statusCode === 200, status: res.statusCode });
      res.resume();
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    const timer = setTimeout(() => { req.destroy(); resolve({ ok: false, error: `timeout ${CHROMADB_TIMEOUT_MS}ms` }); }, CHROMADB_TIMEOUT_MS);
    req.end();
  });
}

function restartChromaDB() {
  log('ChromaDB 异常，通过 PM2 重新注册启动...');
  try {
    execSync(`pm2 delete chromadb 2>/dev/null || true`, { shell: true });
    execSync(`pm2 start "${ECOSYSTEM_CONFIG}" --only chromadb`, { shell: true });
    execSync(`pm2 save`, { shell: true });  // 持久化干净 entry，防止 resurrect 恢复旧 max_memory_restart
    log('ChromaDB PM2 重新注册完成（已持久化）');
  } catch (e) {
    log(`ChromaDB 重启失败: ${e.message}`);
  }
}

async function checkChromaDB() {
  // 首次探测：短暂失败不等同于崩溃，可能正在启动中，先重试 3 次
  let result = await probeChromaDB();
  if (result.ok) {
    log(`ChromaDB 正常 (HTTP ${result.status})`);
    return;
  }
  // 第一次失败，等 5 秒重试
  log(`ChromaDB 首次探测失败: ${result.error || result.status}，5s 后重试...`);
  await new Promise(r => setTimeout(r, 5_000));
  result = await probeChromaDB();
  if (result.ok) {
    log(`ChromaDB 重试恢复正常 (HTTP ${result.status})`);
    return;
  }
  // 第二次失败，再等 5 秒重试
  log(`ChromaDB 二次探测仍失败: ${result.error || result.status}，5s 后最后一次重试...`);
  await new Promise(r => setTimeout(r, 5_000));
  result = await probeChromaDB();
  if (result.ok) {
    log(`ChromaDB 第三次探测恢复正常 (HTTP ${result.status})`);
    return;
  }
  // 三次都失败，确认需要重启
  log(`ChromaDB 三次探测均失败: ${result.error || result.status} → 触发重启`);
  restartChromaDB();
  await new Promise(r => setTimeout(r, 20_000));  // ChromaDB 启动需 ~10s（20 集合 + 81MB SQLite）
  const recheck = await probeChromaDB();
  log(recheck.ok
    ? `ChromaDB 重启后恢复正常 (HTTP ${recheck.status})`
    : `ChromaDB 重启后仍异常: ${recheck.error || recheck.status}`
  );
}

// ── cloudflared tunnel 保活 ───────────────────────────────────────────────────
// 探测 metrics 端口（默认 20241）；进程存在且端口响应 = 正常
// 重启用 pm2 delete + start，避免旧注册状态导致 pid 显示 N/A 的问题

const CLOUDFLARED_METRICS_PORT = 20241;
const CLOUDFLARED_TIMEOUT_MS   = 10_000;
const ECOSYSTEM_CONFIG = path.join(__dirname, '../../CrewClaw/daemons/ecosystem.config.js');

function probeCloudflared() {
  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: CLOUDFLARED_METRICS_PORT,
      path: '/metrics',
      method: 'GET',
    }, (res) => {
      clearTimeout(timer);
      resolve({ ok: res.statusCode === 200, status: res.statusCode });
      res.resume();
    });
    req.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    const timer = setTimeout(() => { req.destroy(); resolve({ ok: false, error: `timeout ${CLOUDFLARED_TIMEOUT_MS}ms` }); }, CLOUDFLARED_TIMEOUT_MS);
    req.end();
  });
}

function restartCloudflared() {
  log('cloudflared tunnel 异常，通过 PM2 重新注册启动...');
  try {
    execSync(`pm2 delete cloudflared-tunnel 2>/dev/null || true`, { shell: true });
    execSync(`pm2 start "${ECOSYSTEM_CONFIG}" --only cloudflared-tunnel`, { shell: true });
    log('cloudflared PM2 重新注册完成');
  } catch (e) {
    log(`cloudflared 重启失败: ${e.message}`);
  }
}

async function checkCloudflared() {
  const result = await probeCloudflared();
  if (result.ok) {
    log(`cloudflared 正常 (HTTP ${result.status})`);
  } else {
    log(`cloudflared 异常: ${result.error || result.status} → 触发重启`);
    restartCloudflared();
    await new Promise(r => setTimeout(r, 8_000));
    const recheck = await probeCloudflared();
    log(recheck.ok
      ? `cloudflared 重启后恢复正常 (HTTP ${recheck.status})`
      : `cloudflared 重启后仍异常: ${recheck.error || recheck.status}`
    );
  }
}

// ── Gateway 保活 ─────────────────────────────────────────────────────────────

function restartGateway() {
  // 重启前先检查插件是否能编译——parse error 导致重启没有意义且会让工具全部消失
  try {
    const checkScript = path.join(__dirname, 'check-plugin.sh');
    execSync(`bash "${checkScript}"`, { shell: true, stdio: 'pipe' });
    log('插件编译检查通过，继续重启 Gateway...');
  } catch (e) {
    const output = (e.stdout || e.stderr || '').toString().trim();
    log(`[BLOCK] 插件编译失败，跳过 Gateway 重启！修复 index.ts 后才能重启。\n${output}`);
    return;
  }

  log('Gateway 无响应，执行重启...');
  try {
    execSync('kill -9 $(pgrep -f openclaw-gateway) 2>/dev/null || true', { shell: true });
    execSync('sleep 2', { shell: true });
    execSync(
      'launchctl bootstrap gui/$UID ~/Library/LaunchAgents/ai.openclaw.gateway.plist 2>/dev/null || true',
      { shell: true, env: { ...process.env, UID: String(process.getuid()) } }
    );
    log('Gateway 重启指令已发出，等待启动...');
  } catch (e) {
    log(`重启失败: ${e.message}`);
  }
}

async function checkGateway() {
  const result = await probe();
  if (result.ok) {
    log(`Gateway 正常 (HTTP ${result.status}, reply: "${result.content}")`);
  } else {
    log(`Gateway 异常: ${result.error || result.status} → 触发重启`);
    restartGateway();
    // 重启后等 20 秒再确认（Gateway 启动需要时间）
    await new Promise(r => setTimeout(r, 20_000));
    const recheck = await probe();
    log(recheck.ok
      ? `Gateway 重启后恢复正常 (HTTP ${recheck.status})`
      : `Gateway 重启后仍异常: ${recheck.error || recheck.status}`
    );
  }
}

// ── Andy HEARTBEAT（每日凌晨 2 点）───────────────────────────────────────────
//
// 每天凌晨 2 点触发 Andy 日常巡检（结晶候选评估 + skill-candidates 评估 + 需求覆盖评估）。
// Andy 的 HEARTBEAT.md 已注入 system prompt，触发词即可启动巡检。
// session key 含 "heartbeat" 但不含 "test|watchdog"，ChromaDB 写入正常。
// 预计算数据注入消息内容，Andy 无需 exec Python，直接读文字做判断。

const HEARTBEAT_TIMEOUT_MS = 600_000;  // 10 分钟（Andy 可能需要通知 Lucas）
const SKILL_CANDIDATES_FILE = path.join(__dirname, '../data/learning/skill-candidates.jsonl');
const FOLLOWUP_QUEUE_FILE   = path.join(__dirname, '../data/learning/followup-queue.jsonl');
const ANDY_GOALS_FILE         = path.join(__dirname, '../data/learning/andy-goals.jsonl');
const SELF_SEARCH_STATE_FILE  = path.join(__dirname, '../data/learning/andy-self-search-state.json');
const SELF_SEARCH_COOLDOWN_MS = 72 * 60 * 60 * 1000;  // 72h = 每周约 2~3 次

function buildHeartbeatContext() {
  const sections = [];

  // 检查 0：系统健康快照（Andy 自评目标生成用）
  // 三条数据源：opencode 执行指标（纯 JS 文件读）+ decisions 进化条目数（Python）+ andy-goals 上次状态（纯 JS 文件读）
  try {
    const snapshot = {};

    // ① opencode 最近 10 次执行指标
    const opencodeResultsFile = path.join(HOMEAI_ROOT, 'data/learning/opencode-results.jsonl');
    if (fs.existsSync(opencodeResultsFile)) {
      const lines = fs.readFileSync(opencodeResultsFile, 'utf8').trim().split('\n').filter(Boolean);
      const recent = lines.slice(-10).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      if (recent.length > 0) {
        const rates = recent.filter(r => r.matchRate != null).map(r => Number(r.matchRate));
        snapshot.opencodeCount         = recent.length;
        snapshot.opencodeSuccessRate   = (recent.filter(r => r.success).length / recent.length).toFixed(2);
        snapshot.opencodeMatchRate     = rates.length > 0
          ? (rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(2)
          : 'N/A';
      }
    }

    // ② decisions 集合各进化类型条目数（chromadb HTTP client，走 Python）
    const decisionsCheckScript = path.join(__dirname, '../scripts/_heartbeat_decisions_check.py');
    fs.writeFileSync(decisionsCheckScript, [
      'import chromadb, json, sys',
      "c = chromadb.HttpClient(host='localhost', port=8001)",
      "col = c.get_collection('decisions')",
      "types = ['design_learning', 'impl_learning', 'learning_objective', 'knowledge_injection']",
      'counts = {}',
      'for t in types:',
      '    try:',
      "        r = col.get(where={'type': {'$eq': t}}, include=[])",
      "        counts[t] = len(r.get('ids', []))",
      '    except:',
      '        counts[t] = -1',
      'print(json.dumps(counts))',
      'sys.stdout.flush()',
    ].join('\n'), 'utf8');
    try {
      const out = execSync(`${PYTHON3} ${decisionsCheckScript}`, { encoding: 'utf8', timeout: 10_000 }).trim();
      snapshot.decisionCounts = JSON.parse(out);
    } catch (_) {
      snapshot.decisionCounts = null;
    }

    // ③ andy-goals 上次目标状态
    if (fs.existsSync(ANDY_GOALS_FILE)) {
      const goalLines = fs.readFileSync(ANDY_GOALS_FILE, 'utf8').trim().split('\n').filter(Boolean);
      if (goalLines.length > 0) {
        try {
          const last = JSON.parse(goalLines[goalLines.length - 1]);
          snapshot.lastGoal = { description: last.description, status: last.status, generatedAt: last.generatedAt };
        } catch (_) {}
      }
    }

    sections.push(`【预计算数据 - 检查 0：系统健康快照（自评用）】\n${JSON.stringify(snapshot, null, 2)}`);
  } catch (e) {
    log(`HEARTBEAT 预计算系统健康快照失败: ${e.message}`);
    sections.push('【预计算数据 - 检查 0：系统健康快照】\n（预计算失败，Andy 跳过此项）');
  }

  // 检查 1：Kuzu 结晶候选
  const kuzuScript = path.join(__dirname, '../scripts/_heartbeat_kuzu_check.py');
  try {
    const scriptContent = [
      'import kuzu, os, json, sys',
      "db = kuzu.Database(os.path.expanduser('~/HomeAI/Data/kuzu'))",
      'conn = kuzu.Connection(db)',
      "res = conn.execute(",
      "    \"MATCH (a:Entity {id: 'andy'})-[f:Fact {relation: 'has_pattern'}]->(p:Entity {type: 'pattern'}) \"",
      "    \"WHERE f.valid_until IS NULL AND f.confidence >= 0.8 \"",
      "    \"RETURN p.name, p.id, f.context, f.confidence ORDER BY f.confidence DESC\"",
      ')',
      'rows = []',
      'while res.has_next():',
      '    row = res.get_next()',
      "    rows.append({'name': row[0], 'id': row[1], 'context': row[2], 'confidence': row[3]})",
      'print(json.dumps(rows, ensure_ascii=False))',
      'sys.stdout.flush()  # os._exit(0) bypasses buffer flush; must flush explicitly',
      'os._exit(0)  # bypass kuzu Database::~Database() SIGBUS on macOS ARM64',
    ].join('\n');
    fs.writeFileSync(kuzuScript, scriptContent, 'utf8');
    const output = execSync(`${PYTHON3} ${kuzuScript}`, { encoding: 'utf8', timeout: 15_000 }).trim();
    const rows = JSON.parse(output);
    if (rows.length > 0) {
      sections.push(`【预计算数据 - 检查 1：Kuzu 结晶候选（confidence >= 0.8）】\n${JSON.stringify(rows, null, 2)}`);
    } else {
      sections.push('【预计算数据 - 检查 1：Kuzu 结晶候选】\n（无高置信度候选）');
    }
  } catch (e) {
    log(`HEARTBEAT 预计算 Kuzu 失败: ${e.message}`);
    sections.push('【预计算数据 - 检查 1：Kuzu 结晶候选】\n（查询失败，Andy 跳过此项）');
  }

  // 检查 2：skill-candidates.jsonl pending 条目
  try {
    const pending = [];
    if (fs.existsSync(SKILL_CANDIDATES_FILE)) {
      const lines = fs.readFileSync(SKILL_CANDIDATES_FILE, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        const entry = JSON.parse(line);
        if (entry.status === 'pending') pending.push(entry);
      }
    }
    if (pending.length > 0) {
      sections.push(`【预计算数据 - 检查 2：skill-candidates.jsonl pending 条目】\n${JSON.stringify(pending, null, 2)}`);
    } else {
      sections.push('【预计算数据 - 检查 2：skill-candidates.jsonl】\n（无 pending 条目）');
    }
  } catch (e) {
    log(`HEARTBEAT 预计算 skill-candidates 失败: ${e.message}`);
    sections.push('【预计算数据 - 检查 2：skill-candidates.jsonl】\n（读取失败，Andy 跳过此项）');
  }

  // 检查 3（链路健康）：积压热点 + 能力冷热度
  try {
    const chainHealth = {};

    // ① 积压热点：skill-candidates pending 数量
    let pendingCount = 0;
    const pendingDomains = {};
    if (fs.existsSync(SKILL_CANDIDATES_FILE)) {
      const lines = fs.readFileSync(SKILL_CANDIDATES_FILE, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (entry.status === 'pending') {
            pendingCount++;
            const domain = entry.domain || entry.suggested_form || 'unknown';
            pendingDomains[domain] = (pendingDomains[domain] || 0) + 1;
          }
        } catch (_) {}
      }
    }
    chainHealth.skillCandidateBacklog = { pendingCount, domains: pendingDomains };

    // ② 能力冷热度：读 capability-events 最近 14 天工具调用统计
    const cutoff14d = Date.now() - 14 * 24 * 60 * 60 * 1000;
    const toolStats = {};
    const capFiles = ['andy-capability-events.jsonl', 'lucas-capability-events.jsonl', 'lisa-capability-events.jsonl'];
    for (const fname of capFiles) {
      const fpath = path.join(__dirname, '../data/learning', fname);
      if (!fs.existsSync(fpath)) continue;
      const lines = fs.readFileSync(fpath, 'utf8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const entry = JSON.parse(line);
          if (!entry.timestamp || new Date(entry.timestamp).getTime() < cutoff14d) continue;
          for (const [tool, count] of Object.entries(entry.toolCalls || {})) {
            toolStats[tool] = (toolStats[tool] || 0) + Number(count);
          }
        } catch (_) {}
      }
    }
    chainHealth.recentToolUsage = toolStats;

    const summary = JSON.stringify(chainHealth, null, 2);
    sections.push(`【预计算数据 - 检查 3：链路健康（近14天）】\n${summary}`);
  } catch (e) {
    log(`HEARTBEAT 预计算链路健康失败: ${e.message}`);
    sections.push('【预计算数据 - 检查 3：链路健康】\n（预计算失败，Andy 跳过此项）');
  }

  // 检查 8：主动知识搜索候选（空闲时触发，72h 冷却）
  // 只在冷却结束后才注入目标 objective；Andy 仅在 Checks 0-7 全部 OK 时执行
  try {
    // ① 读冷却状态
    let searchState = { lastSearchAt: null, searchedTopics: [] };
    if (fs.existsSync(SELF_SEARCH_STATE_FILE)) {
      try { searchState = JSON.parse(fs.readFileSync(SELF_SEARCH_STATE_FILE, 'utf8')); } catch (_) {}
    }
    const lastSearchMs = searchState.lastSearchAt ? new Date(searchState.lastSearchAt).getTime() : 0;
    const cooldownRemaining = SELF_SEARCH_COOLDOWN_MS - (Date.now() - lastSearchMs);

    if (cooldownRemaining > 0) {
      const hoursLeft = Math.ceil(cooldownRemaining / 3_600_000);
      sections.push(`【预计算数据 - 检查 8：主动知识搜索】\n冷却中（距下次可搜索还有约 ${hoursLeft}h），跳过本次。`);
    } else {
      // ② 查 learning_objective 中未搜索过的条目（Python 查 ChromaDB）
      const searchedTopics = searchState.searchedTopics || [];
      const objScript = path.join(__dirname, '../scripts/_heartbeat_search_objective.py');
      fs.writeFileSync(objScript, [
        'import chromadb, json, sys',
        "c = chromadb.HttpClient(host='localhost', port=8001)",
        "col = c.get_collection('decisions')",
        "res = col.get(where={'$and': [{'type': {'$eq': 'learning_objective'}}, {'agent': {'$eq': 'andy'}}]},",
        "              include=['documents', 'metadatas'])",
        'items = []',
        "for doc, meta in zip(res.get('documents', []), res.get('metadatas', [])):",
        "    items.append({'topic': meta.get('topic', ''), 'document': doc, 'timestamp': meta.get('timestamp', '')})",
        "items.sort(key=lambda x: x['timestamp'])",
        'print(json.dumps(items, ensure_ascii=False))',
        'sys.stdout.flush()',
      ].join('\n'), 'utf8');

      let objective = null;
      try {
        const out = execSync(`${PYTHON3} ${objScript}`, { encoding: 'utf8', timeout: 10_000 }).trim();
        const items = JSON.parse(out);
        // 取最旧的、未搜索过的
        objective = items.find(it => !searchedTopics.includes(it.topic)) || null;
        // 若全部搜索过，重置轮次从头再来
        if (!objective && items.length > 0) {
          objective = items[0];
        }
      } catch (_) {}

      if (objective) {
        sections.push(
          `【预计算数据 - 检查 8：主动知识搜索候选】\n` +
          `目标主题：${objective.topic}\n` +
          `目标描述：${objective.document.slice(0, 400)}\n` +
          `（冷却已结束，Andy 空闲时执行搜索）`
        );
      } else {
        sections.push('【预计算数据 - 检查 8：主动知识搜索】\n（无 learning_objective 条目，跳过）');
      }
    }
  } catch (e) {
    log(`HEARTBEAT 预计算主动搜索失败: ${e.message}`);
    sections.push('【预计算数据 - 检查 8：主动知识搜索】\n（预计算失败，Andy 跳过此项）');
  }

  return sections.join('\n\n');
}

function probeAndyHeartbeat() {
  const heartbeatContext = buildHeartbeatContext();
  const messageContent = `HEARTBEAT\n\n${heartbeatContext}`;
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'openclaw/andy',
      messages: [{ role: 'user', content: messageContent }],
      user: `heartbeat:andy:${Date.now()}`,
      stream: false,
    });
    const req = http.request({
      hostname: '127.0.0.1',
      port: 18789,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-openclaw-agent-id': 'andy',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        clearTimeout(hardTimer);
        try {
          const json = JSON.parse(data);
          const content = json?.choices?.[0]?.message?.content || '';
          const ok = !!content;
          const summary = content.includes('HEARTBEAT_OK')
            ? 'HEARTBEAT_OK（无待处理事项）'
            : `有处理事项（${content.substring(0, 60)}...）`;
          resolve({ ok, status: res.statusCode, summary });
        } catch (_) {
          resolve({ ok: false, status: res.statusCode, error: 'invalid JSON body' });
        }
      });
    });
    req.on('error', (e) => { clearTimeout(hardTimer); resolve({ ok: false, error: e.message }); });
    const hardTimer = setTimeout(() => {
      req.destroy();
      resolve({ ok: false, error: `timeout ${HEARTBEAT_TIMEOUT_MS / 1000}s` });
    }, HEARTBEAT_TIMEOUT_MS);
    req.write(body);
    req.end();
  });
}

function shouldRunAndyHeartbeat() {
  const now = new Date();
  // 每天凌晨 2~3 点之间
  return now.getHours() === 2;
}

let lastHeartbeatDay = '';  // 防止同一天重复触发

// 运行 decisions 条目数检查，返回 { design_learning, impl_learning, learning_objective, knowledge_injection } 或 null
function runDecisionsCheck() {
  const script = [
    'import chromadb, json, sys',
    "c = chromadb.HttpClient(host='localhost', port=8001)",
    "col = c.get_collection('decisions')",
    "types = ['design_learning', 'impl_learning', 'learning_objective', 'knowledge_injection']",
    'counts = {}',
    'for t in types:',
    '    try:',
    "        r = col.get(where={'type': {'$eq': t}}, include=[])",
    "        counts[t] = len(r.get('ids', []))",
    '    except:',
    '        counts[t] = -1',
    'print(json.dumps(counts))',
    'sys.stdout.flush()',
  ].join('\n');
  const tmpScript = path.join(__dirname, '../scripts/_heartbeat_decisions_check.py');
  fs.writeFileSync(tmpScript, script, 'utf8');
  try {
    const out = execSync(`${PYTHON3} ${tmpScript}`, { encoding: 'utf8', timeout: 10_000 }).trim();
    return JSON.parse(out);
  } catch (_) {
    return null;
  }
}

async function runAndyHeartbeat() {
  log('Andy HEARTBEAT 开始...');

  // HEARTBEAT 前快照：用于事后对比 Andy 是否写入了 decisions 条目
  const preCountsSnap = runDecisionsCheck();

  const result = await probeAndyHeartbeat();
  if (result.ok) {
    log(`Andy HEARTBEAT 完成：${result.summary}`);

    // 基础设施层写时间戳，不依赖模型合规
    try {
      const heartbeatPath = path.join(process.env.HOME, '.openclaw/workspace-andy/HEARTBEAT.md');
      let content = fs.readFileSync(heartbeatPath, 'utf8');
      const ts = new Date().toISOString();
      if (/^- 上次巡检：.*/m.test(content)) {
        content = content.replace(/^- 上次巡检：.*/m, `- 上次巡检：${ts}`);
      } else {
        content = content.trimEnd() + `\n\n---\n\n- 上次巡检：${ts}\n`;
      }
      fs.writeFileSync(heartbeatPath, content, 'utf8');
    } catch (e) {
      log(`Andy HEARTBEAT 时间戳写入失败: ${e.message}`);
    }

    // 基础设施层补写 andy-goals.jsonl：对比 HEARTBEAT 前后 decisions 变化
    // Andy 应该自己写，但模型有时跳过此步骤；基础设施层兜底确保追踪不丢失
    try {
      const postCounts = runDecisionsCheck();
      if (preCountsSnap && postCounts) {
        // 低于阈值时才算"薄弱指标"（threshold=1 → 0条才触发）
        const thresholds = { design_learning: 1, impl_learning: 1, learning_objective: 1 };
        for (const [type, threshold] of Object.entries(thresholds)) {
          const pre = preCountsSnap[type] ?? 0;
          const post = postCounts[type] ?? 0;
          if (post > pre && pre < threshold) {
            const entry = {
              id: `goal-${Date.now()}`,
              generatedAt: new Date().toISOString(),
              trigger: pre === 0 ? `${type}_zero` : `${type}_low`,
              description: `HEARTBEAT 期间 ${type} 从 ${pre} 增至 ${post} 条（基础设施层补录）`,
              actionTaken: 'direct_distill_during_heartbeat',
              status: 'completed',
            };
            fs.appendFileSync(ANDY_GOALS_FILE, JSON.stringify(entry) + '\n', 'utf8');
            log(`Andy 目标补录：${entry.trigger} → andy-goals.jsonl`);
          }
        }
      }
    } catch (e) {
      log(`Andy 目标补录失败: ${e.message}`);
    }
  } else {
    log(`Andy HEARTBEAT 失败：${result.error || result.status}`);
  }
}

// ── Lucas HEARTBEAT（每日 20:00，跟进开发任务结果）──────────────────────────

function shouldRunLucasHeartbeat() {
  return new Date().getHours() === 20;
}

let lastLucasHeartbeatDay = '';

function buildLucasFollowupContext() {
  try {
    if (!fs.existsSync(FOLLOWUP_QUEUE_FILE)) return '';
    const lines = fs.readFileSync(FOLLOWUP_QUEUE_FILE, 'utf8').trim().split('\n').filter(Boolean);
    const now = Date.now();
    const pending = [];
    const updated = [];
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        const age = now - new Date(entry.deliveredAt).getTime();
        const ageH = age / 3600000;
        // pending 且交付 20h~7天 之内的才跟进
        if (entry.status === 'pending' && ageH >= 20 && ageH < 168) {
          pending.push(entry);
          updated.push(JSON.stringify({ ...entry, status: 'sent' }));
        } else if (entry.status === 'pending' && ageH >= 168) {
          // 超过 7 天未回应，自动过期
          updated.push(JSON.stringify({ ...entry, status: 'expired' }));
        } else {
          updated.push(line);
        }
      } catch { updated.push(line); }
    }
    // 回写更新后的队列
    fs.writeFileSync(FOLLOWUP_QUEUE_FILE, updated.join('\n') + '\n', 'utf8');
    if (pending.length === 0) return '';
    return `【待跟进开发任务】\n${JSON.stringify(pending, null, 2)}`;
  } catch (e) {
    log(`Lucas HEARTBEAT 跟进队列读取失败: ${e.message}`);
    return '';
  }
}

async function runLucasHeartbeat() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastLucasHeartbeatDay === today) return;

  const followupCtx = buildLucasFollowupContext();
  if (!followupCtx) {
    log('Lucas HEARTBEAT：无待跟进任务，跳过');
    lastLucasHeartbeatDay = today;
    return;
  }

  log('Lucas HEARTBEAT 开始（开发任务跟进）...');
  const messageContent = `HEARTBEAT\n\n${followupCtx}`;
  const body = JSON.stringify({
    model: 'openclaw/lucas',
    messages: [{ role: 'user', content: messageContent }],
    user: `heartbeat:lucas:${Date.now()}`,
    stream: false,
  });

  await new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1', port: 18789,
      path: '/v1/chat/completions', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'x-openclaw-agent-id': 'lucas',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        clearTimeout(hardTimer);
        try {
          const json = JSON.parse(data);
          const content = json?.choices?.[0]?.message?.content || '';
          log(`Lucas HEARTBEAT 完成：${content.substring(0, 80)}...`);
        } catch { log('Lucas HEARTBEAT 响应解析失败'); }
        resolve();
      });
    });
    req.on('error', (e) => { clearTimeout(hardTimer); log(`Lucas HEARTBEAT 失败：${e.message}`); resolve(); });
    const hardTimer = setTimeout(() => { req.destroy(); log('Lucas HEARTBEAT 超时'); resolve(); }, 300_000);
    req.write(body);
    req.end();
  });

  lastLucasHeartbeatDay = today;
}

// ── 家人记忆蒸馏（每日凌晨 2 点）────────────────────────────────────────────
// 读取 ChromaDB 对话记录 → LLM 提炼 → 写入 Kuzu 知识图谱（家人的事实、话题、关系）
// Lucas 下次和家人聊天时，Kuzu 里的知识会注入上下文，让 Lucas 更了解这个家

function shouldRunDistill() {
  const now = new Date();
  // 每日凌晨 2~3 点之间
  return now.getHours() === 2;
}

function runDistill() {
  if (!fs.existsSync(DISTILL_SCRIPT)) {
    log('蒸馏脚本不存在，跳过');
    return;
  }
  log('开始运行记忆蒸馏...');
  const env = { ...process.env };
  const child = spawn(PYTHON3, [DISTILL_SCRIPT], {
    env,
    detached: true,
    stdio: ['ignore', fs.openSync(DISTILL_LOG, 'a'), fs.openSync(DISTILL_LOG, 'a')],
  });
  child.unref();
  log(`记忆蒸馏已启动（PID ${child.pid}），日志：${DISTILL_LOG}`);

  // Agent 蒸馏（distill-agent-memories.py）必须在 distill-memories.py 退出后再启动：
  //   两者都需要 Kuzu 独占锁；distill-memories.py 末尾还会 spawn render-knowledge.py，
  //   所以等 distill-memories.py 退出后再延迟 5 分钟，确保 render-knowledge.py 也完成。
  // Andy HEARTBEAT 也在蒸馏完成后、Agent 蒸馏之前触发（避免 Kuzu 锁冲突）。
  child.on('close', (code) => {
    log(`记忆蒸馏完成（code ${code}）`);

    // 先触发 Andy HEARTBEAT（蒸馏新数据可用，Kuzu 锁已释放）
    if (pendingHeartbeatToday && lastHeartbeatDay !== new Date().toDateString()) {
      lastHeartbeatDay = new Date().toDateString();
      pendingHeartbeatToday = false;
      log('蒸馏完成后触发 Andy HEARTBEAT...');
      runAndyHeartbeat().catch(e => log(`Andy HEARTBEAT 异常: ${e.message}`));
    }

    // 5 分钟后启动 Agent 蒸馏（等待 HEARTBEAT 和 render-knowledge.py 完成）
    if (fs.existsSync(DISTILL_AGENTS_SCRIPT)) {
      log('5 分钟后启动 Agent 记忆蒸馏...');
      setTimeout(() => {
        const agentChild = spawn(PYTHON3, [DISTILL_AGENTS_SCRIPT], {
          env,
          detached: true,
          stdio: ['ignore', fs.openSync(DISTILL_AGENTS_LOG, 'a'), fs.openSync(DISTILL_AGENTS_LOG, 'a')],
        });
        agentChild.unref();
        log(`Agent 记忆蒸馏已启动（PID ${agentChild.pid}），日志：${DISTILL_AGENTS_LOG}`);
      }, 5 * 60 * 1000);
    }
  });
}

let lastDistillDay       = -1;  // 防止同一天重复触发
let pendingHeartbeatToday = false;  // 蒸馏完成后触发 HEARTBEAT（串行避免 Kuzu 锁冲突）
let lastTeamObsDay       = '';  // team_observation 蒸馏每日触发去重
let lastPersonalizeDay   = '';  // Andy/Lisa 每日自我进化触发去重
let lastCollabDistillDay = '';  // 协作关系蒸馏每日触发去重
let lastCodeGraphDay     = '';  // 代码图谱每日增量重建触发去重
let lastL4ScanWeek       = '';  // L4 DPO 周级扫描去重（格式 yyyy-Www）

function shouldRunTeamObs() {
  // 每天凌晨 3~4 点之间（错开 Andy HEARTBEAT 的 2~3 点，避免 Kuzu 锁竞争）
  return new Date().getHours() === 3;
}

function runTeamObsDistill() {
  if (!fs.existsSync(TEAM_OBS_SCRIPT)) {
    log('team_observation 蒸馏脚本不存在，跳过');
    return;
  }
  log('开始运行 team_observation 蒸馏（Andy 视角家人洞察）...');
  const child = spawn(PYTHON3, [TEAM_OBS_SCRIPT], {
    env: { ...process.env },
    detached: true,
    stdio: ['ignore', fs.openSync(TEAM_OBS_LOG, 'a'), fs.openSync(TEAM_OBS_LOG, 'a')],
  });
  child.unref();
  log(`team_observation 蒸馏已启动（PID ${child.pid}），日志：${TEAM_OBS_LOG}`);
}

// ── 代码图谱每日增量重建（凌晨 5 点）────────────────────────────────────────────
// 错开 collab distill（4am）；--incremental 快速模式仅扫关键路径（~39s，89 文件）
function shouldRunCodeGraph() {
  return new Date().getHours() === 5;
}

function runCodeGraphRebuild() {
  if (!fs.existsSync(CODE_GRAPH_SCRIPT)) {
    log('代码图谱脚本不存在，跳过');
    return;
  }
  log('开始代码图谱增量重建（--incremental --paths）...');
  const child = spawn(PYTHON3, [
    CODE_GRAPH_SCRIPT,
    '--incremental',
    '--paths', 'CrewClaw/crewclaw-routing', 'HomeAILocal/Scripts',
  ], {
    env: { ...process.env },
    detached: true,
    stdio: ['ignore', fs.openSync(CODE_GRAPH_LOG, 'a'), fs.openSync(CODE_GRAPH_LOG, 'a')],
  });
  child.unref();
  log(`代码图谱重建已启动（PID ${child.pid}），日志：${CODE_GRAPH_LOG}`);
}

// ── L4 DPO 周级自动扫描（每周一凌晨 6 点）──────────────────────────────────────
// 调 generate_dpo_good_responses（threshold=10），有可处理的 pattern 时生成 good_response
// 并推送工程师通知，工程师用 approve_dpo_batch 审批后进入微调队列
function getISOWeek() {
  const d = new Date();
  const day = d.getDay() || 7;  // 周日=7
  d.setDate(d.getDate() + 4 - day);
  const yearStart = new Date(d.getFullYear(), 0, 1);
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function shouldRunL4Scan() {
  const now = new Date();
  // 每周一凌晨 6 点（错开所有凌晨 1~5 点的每日任务）
  return now.getDay() === 1 && now.getHours() === 6;
}

async function runL4DpoScan() {
  const week = getISOWeek();
  log(`[L4] 周级 DPO 扫描启动（${week}），调用 generate_dpo_good_responses...`);
  try {
    const body = JSON.stringify({ tool: 'generate_dpo_good_responses', input: { threshold: 10 } });
    const result = await new Promise((resolve, reject) => {
      const req = http.request({
        hostname: 'localhost', port: 3003,
        path: '/api/internal/exec-main-tool',
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve({ ok: false, result: data }); } });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    if (result.ok && result.result) {
      const summary = String(result.result).slice(0, 300);
      log(`[L4] DPO 扫描完成：${summary}`);
      // 只在有实际生成时才推送通知（有 good_response 生成才有审批需要）
      if (!summary.includes('无需生成') && !summary.includes('没有 pattern')) {
        sendEngineerAlert(`📊 L4 周报（${week}）\n\n${summary}\n\n请用「approve_dpo_batch pattern_type=<类型>」批准进入微调队列。`, 'heartbeat');
      } else {
        log(`[L4] 本周无达阈值 pattern，无需推送通知`);
      }
    } else {
      log(`[L4] DPO 扫描调用失败：${JSON.stringify(result).slice(0, 100)}`);
    }
  } catch (e) {
    log(`[L4] DPO 扫描异常：${e.message}`);
  }
}

// ── Andy/Lisa 自我进化蒸馏（每日凌晨 1 点）──────────────────────────────────────
// Andy 从自己的历史设计决策中提炼判断规律（下次写 spec 更准）
// Lisa 从历史 opencode 运行记录中提炼代码库认知（哪些模块容易出错、哪些陷阱要绕）
// 从家庭对话中提取「成员隐含的能力期待」注入 Andy/Lisa（他们知道组织想要什么）
// 从知识讨论对话中提炼外部知识摘要注入 Andy（外部输入不丢失）
// 各脚本有 12h 冷却防重复，脚本内无 Kuzu 操作不竞争锁。
function shouldRunPersonalizationDistill() {
  const now = new Date();
  return now.getHours() === 1;
}

function runPersonalizationDistill() {
  for (const [script, logFile, label] of [
    [DESIGN_LEARN_SCRIPT, DESIGN_LEARN_LOG, 'Andy 设计判断提炼（历史决策 → 规律）'],
    [IMPL_LEARN_SCRIPT,   IMPL_LEARN_LOG,   'Lisa 代码库认知提炼（opencode 记录 → 陷阱规律）'],
    [LEARN_OBJ_SCRIPT,    LEARN_OBJ_LOG,    '成员期待提取（家庭对话 → Andy/Lisa 能力方向）'],
    [KNOW_DISC_SCRIPT,    KNOW_DISC_LOG,    '外部知识蒸馏（知识讨论对话 → Andy 知识注入）'],
  ]) {
    if (!fs.existsSync(script)) {
      log(`${label} 脚本不存在，跳过`);
      continue;
    }
    log(`开始运行 ${label}...`);
    const child = spawn(PYTHON3, [script], {
      env: { ...process.env },
      detached: true,
      stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
    });
    child.unref();
    log(`${label} 已启动（PID ${child.pid}），日志：${logFile}`);
  }
}

// ── 家人协作关系蒸馏（每日凌晨 4 点）────────────────────────────────────────
// 分析家人之间的协作对话（谁经常一起讨论什么、谁向谁求助），写入 Kuzu 协作边
// Lucas 能感知家庭协作动态，不只是和每个人单聊，而是理解家人之间的关系
// 错开 2am 记忆蒸馏 + 3am team_observation，避免 Kuzu 锁竞争
function shouldRunCollabDistill() {
  const now = new Date();
  return now.getHours() === 4;
}

function runCollabDistill() {
  if (!fs.existsSync(COLLAB_DISTILL_SCRIPT)) {
    log('协作关系蒸馏脚本不存在，跳过');
    return;
  }
  log('开始运行协作关系蒸馏（distill-relationship-dynamics.py）...');
  const child = spawn(PYTHON3, [COLLAB_DISTILL_SCRIPT], {
    env: { ...process.env },
    detached: true,
    stdio: ['ignore', fs.openSync(COLLAB_DISTILL_LOG, 'a'), fs.openSync(COLLAB_DISTILL_LOG, 'a')],
  });
  child.unref();
  log(`协作关系蒸馏已启动（PID ${child.pid}），日志：${COLLAB_DISTILL_LOG}`);
}

async function check() {
  await checkGateway();
  await checkOllama();
  await checkChromaDB();
  await checkCloudflared();
  // mlx-vision 暂停（2026-04-08）：等 mlx_vlm 支持 gemma4 后恢复
  // await checkMlxVision();

  const today = new Date().toDateString();

  // 记忆蒸馏：每日凌晨 2 点触发
  if (shouldRunDistill()) {
    if (lastDistillDay !== today) {
      lastDistillDay = today;
      runDistill();
      // Andy HEARTBEAT 改为蒸馏完成后触发（串行，避免 Kuzu 锁冲突）
      // 标记今日需要运行 HEARTBEAT，由 runDistill 的 child.on('close') 回调链触发
      pendingHeartbeatToday = true;
    }
  }

  // Andy HEARTBEAT：如果今日没有蒸馏任务（非 2 点时段），则在原时段直接触发
  if (shouldRunAndyHeartbeat()) {
    if (lastHeartbeatDay !== today && !pendingHeartbeatToday) {
      lastHeartbeatDay = today;
      // fire-and-forget：不阻塞 check() 的返回，HEARTBEAT 可能需要 10 分钟
      runAndyHeartbeat().catch(e => log(`Andy HEARTBEAT 异常: ${e.message}`));
    }
  }

  // team_observation 蒸馏：每日凌晨 3 点触发（错开 HEARTBEAT，避免 Kuzu 锁竞争）
  if (shouldRunTeamObs()) {
    if (lastTeamObsDay !== today) {
      lastTeamObsDay = today;
      runTeamObsDistill();
    }
  }

  // Andy/Lisa 自我进化蒸馏：每日凌晨 1 点触发（设计判断提炼 + 代码库认知 + 成员期待 + 外部知识）
  if (shouldRunPersonalizationDistill()) {
    if (lastPersonalizeDay !== today) {
      lastPersonalizeDay = today;
      runPersonalizationDistill();
    }
  }

  // 家人协作关系蒸馏：每日凌晨 4 点触发
  if (shouldRunCollabDistill()) {
    if (lastCollabDistillDay !== today) {
      lastCollabDistillDay = today;
      runCollabDistill();
    }
  }

  // 代码图谱增量重建：每日凌晨 5 点触发（错开 collab distill 的 4am）
  if (shouldRunCodeGraph()) {
    if (lastCodeGraphDay !== today) {
      lastCodeGraphDay = today;
      runCodeGraphRebuild();
    }
  }

  // L4 DPO 周级扫描：每周一凌晨 6 点触发（错开所有每日凌晨任务）
  if (shouldRunL4Scan()) {
    const currentWeek = getISOWeek();
    if (lastL4ScanWeek !== currentWeek) {
      lastL4ScanWeek = currentWeek;
      runL4DpoScan().catch(e => log(`[L4] 周级扫描异常: ${e.message}`));
    }
  }

  // Lucas HEARTBEAT：每日 20:00 触发（开发任务跟进）
  if (shouldRunLucasHeartbeat()) {
    if (lastLucasHeartbeatDay !== today) {
      runLucasHeartbeat().catch(e => log(`Lucas HEARTBEAT 异常: ${e.message}`));
    }
  }
}

// ─── 群消息推送中断检测 ────────────────────────────────────────────────────────
// 现象：企业微信平台偶发性中断对 bot 的群消息推送（WebSocket 心跳正常，但 message.text 不触发）。
// 检测逻辑：若 group: chatHistory 文件中最新消息时间早于阈值，且同期私聊有更新消息（bot 正常），
//           则判断群推送中断，通过 notify-engineer 端点告警业主。
// 恢复方式：将启灵踢出群 → 重新拉入，强制刷新平台侧 bot-group subscription。
const CHAT_HISTORY_DIR              = path.join(process.env.HOME || '', '.homeai', 'chat-history');
const GROUP_SILENCE_THRESHOLD_MS    = 2 * 60 * 60 * 1000;   // 2小时群消息无动静 → 可疑
const GROUP_SILENCE_ALERT_INTERVAL_MS = 4 * 60 * 60 * 1000; // 同一中断最多每4小时告警一次
const GROUP_SILENCE_SCAN_MS         = 30 * 60 * 1000;        // 每30分钟扫一次

let lastGroupSilenceAlertTs = 0;

/** 返回 chatHistory 目录下、文件名匹配 prefix 的文件中，user 角色消息的最新时间戳（毫秒）。 */
function getLastUserMsgTs(prefix) {
  if (!fs.existsSync(CHAT_HISTORY_DIR)) return 0;
  let latest = 0;
  try {
    const files = fs.readdirSync(CHAT_HISTORY_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(CHAT_HISTORY_DIR, file), 'utf8'));
        if (!Array.isArray(data)) continue;
        for (let i = data.length - 1; i >= 0; i--) {
          if (data[i].role === 'user' && data[i].ts) {
            if (data[i].ts > latest) latest = data[i].ts;
            break;
          }
        }
      } catch {}
    }
  } catch {}
  return latest;
}

/** 通过 wecom-entrance /api/wecom/notify-engineer 发告警给业主（企业应用通道，不走 bot/Lucas）。 */
function sendEngineerAlert(message, type = 'intervention') {
  const body = JSON.stringify({ message, type });
  const req = http.request({
    hostname: 'localhost', port: 3003,
    path: '/api/wecom/notify-engineer',
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
  }, (res) => log(`[GroupSilence] 告警已发送，HTTP ${res.statusCode}`));
  req.on('error', (e) => log(`[GroupSilence] 告警发送失败: ${e.message}`));
  req.write(body);
  req.end();
}

function checkGroupMessageSilence() {
  const groupLatest = getLastUserMsgTs('group:');
  if (groupLatest === 0) return; // 从未有过群消息，不检测

  const now = Date.now();
  const groupSilenceMs = now - groupLatest;
  if (groupSilenceMs < GROUP_SILENCE_THRESHOLD_MS) return; // 群消息正常

  // 私聊有比群更晚的消息 → bot 正常接收私聊，群推送断了
  const privateLatest = getLastUserMsgTs('user:');
  if (privateLatest <= groupLatest) return; // 两边一样沉默，可能只是没人说话

  const sinceLastAlert = now - lastGroupSilenceAlertTs;
  if (sinceLastAlert < GROUP_SILENCE_ALERT_INTERVAL_MS) return; // 4小时内已告过警

  const silenceHours = (groupSilenceMs / 3_600_000).toFixed(1);
  log(`[GroupSilence] 群消息中断 ${silenceHours}h（私聊仍正常），发送告警`);
  lastGroupSilenceAlertTs = now;

  sendEngineerAlert(
    `群聊消息推送中断 ${silenceHours} 小时（私聊消息仍正常接收）\n` +
    `处理方式：将启灵踢出群 → 重新拉入 → 群里 @启灵 测试`,
  );
}

setInterval(checkGroupMessageSilence, GROUP_SILENCE_SCAN_MS);

// ─── 长流程任务卡死检测 ────────────────────────────────────────────────────────
// 扫描 data/tasks/ 里超过 10 分钟仍处于 processing 状态的任务，重置为 pending。
// TaskManager 下次运行时会自动重跑（per-user 队列在进程内；重置文件是给下次进程重启后恢复用）。
const TASK_DIR        = path.join(__dirname, '../data/tasks');
const TASK_STUCK_MS   = 10 * 60 * 1000; // 10 分钟
const TASK_SCAN_INTERVAL_MS = 5 * 60 * 1000; // 每 5 分钟扫一次

function scanStuckTasks() {
  if (!fs.existsSync(TASK_DIR)) return;
  try {
    const files = fs.readdirSync(TASK_DIR).filter(f => f.endsWith('.json'));
    let recovered = 0;
    for (const file of files) {
      try {
        const filePath = path.join(TASK_DIR, file);
        const task = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (task.status !== 'processing') continue;
        const age = Date.now() - new Date(task.updatedAt || task.createdAt).getTime();
        if (age > TASK_STUCK_MS) {
          task.status = 'pending';
          task.updatedAt = new Date().toISOString();
          fs.writeFileSync(filePath, JSON.stringify(task, null, 2));
          log(`[TaskScan] 卡住任务已重置: ${task.taskId} (type=${task.type}, age=${Math.round(age/60000)}min)`);
          recovered++;
        }
      } catch {}
    }
    if (recovered > 0) log(`[TaskScan] 本次重置 ${recovered} 个卡住任务`);
  } catch (e) {
    log(`[TaskScan] 扫描失败: ${e.message}`);
  }
}

setInterval(scanStuckTasks, TASK_SCAN_INTERVAL_MS);

// ─── 访客沉寂检测 + Shadow Agent 归档 ─────────────────────────────────────────
// 每日凌晨 3 点扫描 visitor-registry.json：
//   1. expiresAt 已过期（邀请函到期）→ 触发蒸馏 + 标记 archived
//   2. 状态已是 archived → 跳过
// 归档操作：registry status='archived' + Kuzu shadow_status='archived'
// 蒸馏：spawn distill-memories.py --user visitor:TOKEN --force（即使数据少也蒸馏留档）
const VISITOR_REGISTRY_PATH      = path.join(__dirname, '../data/visitor-registry.json');
const VISITOR_SILENCE_SCAN_MS    = 60 * 60 * 1000;  // 每小时扫一次（确保凌晨 3 点命中）

let lastVisitorSilenceScanDay    = '';

function shouldRunVisitorSilenceScan() {
  const now = new Date();
  return now.getHours() === 3;  // 凌晨 3 点
}

function archiveVisitorInKuzu(visitorToken) {
  // 生成临时脚本更新 Kuzu shadow_status，fire-and-forget
  const entityId  = `visitor:${visitorToken.toUpperCase()}`;
  const scriptContent = [
    'import kuzu, os, sys',
    `db = kuzu.Database(os.path.expanduser('~/HomeAI/Data/kuzu'))`,
    'conn = kuzu.Connection(db)',
    `conn.execute("MATCH (e:Entity {id: '${entityId}'}) SET e.shadow_status = 'archived'")`,
    `sys.stdout.write('archived ${entityId}\\n')`,
    'sys.stdout.flush()',
    'os._exit(0)',
  ].join('\n');
  const tmpPath = path.join(__dirname, `_archive_visitor_${visitorToken}.py`);
  try {
    fs.writeFileSync(tmpPath, scriptContent, 'utf8');
    const proc = spawn(PYTHON3, [tmpPath], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.unref();
    // 30s 后清理临时文件
    setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 30_000);
  } catch (e) {
    log(`[VisitorSilence] Kuzu 归档失败 ${visitorToken}: ${e.message}`);
  }
}

function markVisitorDormantInKuzu(visitorToken) {
  // 生成临时脚本将 Kuzu shadow_status 设为 dormant，fire-and-forget
  const entityId  = `visitor:${visitorToken.toUpperCase()}`;
  const scriptContent = [
    'import kuzu, os, sys',
    `db = kuzu.Database(os.path.expanduser('~/HomeAI/Data/kuzu'))`,
    'conn = kuzu.Connection(db)',
    `conn.execute("MATCH (e:Entity {id: '${entityId}'}) SET e.shadow_status = 'dormant'")`,
    `sys.stdout.write('dormant ${entityId}\\n')`,
    'sys.stdout.flush()',
    'os._exit(0)',
  ].join('\n');
  const tmpPath = path.join(__dirname, `_dormant_visitor_${visitorToken}.py`);
  try {
    fs.writeFileSync(tmpPath, scriptContent, 'utf8');
    const proc = spawn(PYTHON3, [tmpPath], {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    proc.unref();
    setTimeout(() => { try { fs.unlinkSync(tmpPath); } catch {} }, 30_000);
  } catch (e) {
    log(`[VisitorSilence] Kuzu dormant 标记失败 ${visitorToken}: ${e.message}`);
  }
}

function runVisitorDistill(visitorUserId) {
  if (!fs.existsSync(DISTILL_SCRIPT)) return;
  const logPath = path.join(__dirname, '../logs/distill-visitor.log');
  const proc = spawn(PYTHON3, [DISTILL_SCRIPT, '--user', visitorUserId, '--force'], {
    detached: true,
    stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
  });
  proc.unref();
  log(`[VisitorSilence] 蒸馏已启动 ${visitorUserId}（PID ${proc.pid}）`);
}

const DORMANT_SILENCE_MS   = 30 * 24 * 60 * 60 * 1000;  // 30 天无对话 → dormant
const DORMANT_ARCHIVE_MS   = 90 * 24 * 60 * 60 * 1000;  // dormant 后再 90 天 → archived

function checkVisitorSilence() {
  if (!shouldRunVisitorSilenceScan()) return;
  const today = new Date().toDateString();
  if (lastVisitorSilenceScanDay === today) return;
  lastVisitorSilenceScanDay = today;

  let registry;
  try {
    if (!fs.existsSync(VISITOR_REGISTRY_PATH)) return;
    registry = JSON.parse(fs.readFileSync(VISITOR_REGISTRY_PATH, 'utf8'));
  } catch (e) {
    log(`[VisitorSilence] 读取 registry 失败: ${e.message}`);
    return;
  }

  const now = Date.now();
  let changed = false;

  for (const [token, entry] of Object.entries(registry)) {
    if (!entry || entry.status === 'archived') continue;

    // ── 路径1：邀请到期 → archived（不论当前 status）────────────────────────
    const expired = entry.expiresAt && now > entry.expiresAt;
    if (expired) {
      log(`[VisitorSilence] 邀请已过期，归档访客 ${token}（名：${entry.name || '未知'}）`);
      registry[token].status     = 'archived';
      registry[token].archivedAt = now;
      changed = true;
      archiveVisitorInKuzu(token);
      runVisitorDistill(`visitor:${token.toUpperCase()}`);
      continue;
    }

    // ── 路径2：dormant 超 90 天 → archived（蒸馏留档）────────────────────────
    if (entry.status === 'dormant') {
      const dormantAge = entry.dormantAt ? now - entry.dormantAt : 0;
      if (dormantAge > DORMANT_ARCHIVE_MS) {
        log(`[VisitorSilence] dormant 超 90 天，归档访客 ${token}（名：${entry.name || '未知'}）`);
        registry[token].status     = 'archived';
        registry[token].archivedAt = now;
        changed = true;
        archiveVisitorInKuzu(token);
        runVisitorDistill(`visitor:${token.toUpperCase()}`);
      }
      continue;
    }

    // ── 路径3：active 且 30 天无对话 → dormant（不蒸馏，仅标记）─────────────
    if (entry.status === 'active' && entry.lastInteractionAt) {
      const silenceAge = now - entry.lastInteractionAt;
      if (silenceAge > DORMANT_SILENCE_MS) {
        log(`[VisitorSilence] 30 天无对话，标记 dormant 访客 ${token}（名：${entry.name || '未知'}）`);
        registry[token].status    = 'dormant';
        registry[token].dormantAt = now;
        changed = true;
        markVisitorDormantInKuzu(token);
      }
    }
  }

  if (changed) {
    try {
      fs.writeFileSync(VISITOR_REGISTRY_PATH, JSON.stringify(registry, null, 2), 'utf8');
      log('[VisitorSilence] registry 已更新');
    } catch (e) {
      log(`[VisitorSilence] 写入 registry 失败: ${e.message}`);
    }
  }
}

setInterval(checkVisitorSilence, VISITOR_SILENCE_SCAN_MS);

// ─── Coordinator pipeline 目录清理 ──────────────────────────────────────────
// data/pipeline/{reqId}/ 目录 15 天后自动删除，防止长期积累。
// 每日凌晨 4 点执行一次。
const PIPELINE_ROOT = path.join(
  process.env.HOMEAI_ROOT || path.join(process.env.HOME, 'HomeAI'),
  'data', 'pipeline'
);
const PIPELINE_TTL_MS = 15 * 24 * 3_600_000; // 15 天

function cleanPipelineDirs() {
  if (!fs.existsSync(PIPELINE_ROOT)) return;
  const now = Date.now();
  let removed = 0;
  try {
    for (const entry of fs.readdirSync(PIPELINE_ROOT)) {
      const dirPath = path.join(PIPELINE_ROOT, entry);
      try {
        const stat = fs.statSync(dirPath);
        if (stat.isDirectory() && now - stat.mtimeMs > PIPELINE_TTL_MS) {
          fs.rmSync(dirPath, { recursive: true, force: true });
          removed++;
        }
      } catch (_) {}
    }
    if (removed > 0) log(`pipeline 清理：删除 ${removed} 个超过 15 天的目录`);
  } catch (e) {
    log(`pipeline 清理失败：${e.message}`);
  }
}

function schedulePipelineCleanup() {
  const now = new Date();
  const next4am = new Date(now);
  next4am.setHours(4, 0, 0, 0);
  if (next4am <= now) next4am.setDate(next4am.getDate() + 1);
  const msUntil4am = next4am - now;
  setTimeout(() => {
    cleanPipelineDirs();
    setInterval(cleanPipelineDirs, 24 * 3_600_000); // 之后每天执行
  }, msUntil4am);
}
schedulePipelineCleanup();

log(`Watchdog 启动，每 ${CHECK_INTERVAL_MS / 1000}s 检查 Gateway + Ollama + ChromaDB + cloudflared，Gateway 超时阈值 ${PROBE_TIMEOUT_MS / 1000}s`);
log('凌晨 1 点：Andy/Lisa 自我进化蒸馏（设计判断 + 代码库认知 + 成员期待 + 外部知识）');
log('凌晨 2 点：家人记忆蒸馏（对话 → Kuzu 知识图谱）+ Andy HEARTBEAT 巡检');
log('凌晨 3 点：team_observation（Andy 分析家人行为模式 → Lucas 理解更深）');
log('凌晨 4 点：家人协作关系蒸馏（谁和谁一起讨论什么 → Kuzu 协作边）');
log('凌晨 5 点：代码图谱增量重建（CrewClaw + Scripts，~39s）');
log('每周一凌晨 6 点：L4 DPO 周级扫描（generate_dpo_good_responses threshold=10，有结果推工程师审批）');
log(`长流程任务扫描：每 ${TASK_SCAN_INTERVAL_MS / 1000}s 扫描 processing 超时任务（阈值 ${TASK_STUCK_MS / 60000} 分钟）`);
log(`群消息推送检测：每 ${GROUP_SILENCE_SCAN_MS / 60000} 分钟扫描（静默阈值 ${GROUP_SILENCE_THRESHOLD_MS / 3_600_000} 小时，告警间隔 ${GROUP_SILENCE_ALERT_INTERVAL_MS / 3_600_000} 小时）`);
log('访客沉寂检测：每小时扫描一次，凌晨 3 点执行——30 天无对话 → dormant；expiresAt 到期或 dormant 超 90 天 → 蒸馏 + 归档（shadow_status=archived）');
// 全局异常兜底：防止 unhandled rejection 静默杀死进程
process.on('unhandledRejection', (err) => {
  log(`[FATAL] unhandledRejection: ${err && err.stack ? err.stack : err}`);
});

check(); // 启动时立即检查一次
setInterval(check, CHECK_INTERVAL_MS);
