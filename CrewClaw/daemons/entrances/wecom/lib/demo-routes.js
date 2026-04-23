'use strict';
/**
 * demo-routes.js — 访客/Demo 路由层
 *
 * 包含：访客邀请管理 / Demo Chat 代理 / Windows 节点注册 /
 *       Demo TTS / STT / 语音对话 / Vision
 *
 * 工厂函数：module.exports = (logger, deps) => ({ router, loadInvites, resolveInviteCode, isInviteValid })
 * deps: { INSTANCE_ROOT, GATEWAY_URL, APP_GENERATED_DIR }
 */
const express      = require('express');
const fs           = require('fs');
const path         = require('path');
const { spawn, exec, execSync, execFile } = require('child_process');

const TTS_PYTHON    = '/opt/homebrew/opt/python@3.11/bin/python3.11';
const TTS_VOICE     = 'zh-CN-YunxiNeural';
const LOCAL_TTS_URL = 'http://127.0.0.1:8082/tts';
const WHISPER_CLI   = '/opt/homebrew/bin/whisper-cli';

module.exports = function createDemoRoutes(logger, { INSTANCE_ROOT, GATEWAY_URL, APP_GENERATED_DIR }) {
  const WHISPER_MODEL = path.join(INSTANCE_ROOT, 'Models/whisper/ggml-base.bin');

  function execFileAsync(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, opts, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }
  const router = express.Router();
  const app = router;  // block uses app.get/app.post — aliased to router

// ─── 访客邀请 / 对话管理 ─────────────────────────────────────────────────────
// visitor-registry.json: { TOKEN: { name, invitedBy, scopeTags, behaviorContext, status, expiresAt, shadowMemoryPath, createdAt } }
const VISITOR_REGISTRY_PATH  = path.join(INSTANCE_ROOT, 'data', 'visitor-registry.json');
// Lucas 主动推给访客的消息队列（内存，前端轮询取走）{ lowerToken: [{ id, text, ts }] }
const DEMO_CHAT_HISTORY_PATH = path.join(INSTANCE_ROOT, 'data', 'demo-chat-history.json');
const DEMO_DISABLED_FLAG     = path.join(INSTANCE_ROOT, 'data', 'demo-disabled.flag');
function isDemoDisabled() { return fs.existsSync(DEMO_DISABLED_FLAG); }

function loadAllChatHistory() {
  try {
    if (fs.existsSync(DEMO_CHAT_HISTORY_PATH)) {
      return JSON.parse(fs.readFileSync(DEMO_CHAT_HISTORY_PATH, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}
function saveChatHistory(token, messages) {
  try {
    const all = loadAllChatHistory();
    all[token] = messages;
    fs.writeFileSync(DEMO_CHAT_HISTORY_PATH, JSON.stringify(all, null, 2), 'utf8');
  } catch (e) { logger.warn('Demo chat history save failed', { err: e.message }); }
}
function getChatHistory(token) {
  return loadAllChatHistory()[token] || [];
}

// 从 ChromaDB 拉取访客历史对话并重建为消息列表
// 文档格式：「visitor(human): {用户消息}\nlucas: {回复}」
function parseConversationDoc(doc) {
  if (!doc) return null;
  let userMsg = '';
  let assistantLines = [];
  let phase = null;
  for (const line of doc.split('\n')) {
    const lo = line.toLowerCase();
    const userLineMatch = /^.+\((human|visitor)\): (.*)$/i.exec(line);
    if (userLineMatch) {
      userMsg = userLineMatch[2].trim();
      phase = 'user';
    } else if (lo.startsWith('lucas: ') || lo.startsWith('assistant: ')) {
      const prefix = line.slice(0, line.indexOf(': ') + 2);
      assistantLines = [line.slice(prefix.length)];
      phase = 'assistant';
    } else if (phase === 'assistant') {
      assistantLines.push(line);
    }
  }
  if (!userMsg && !assistantLines.length) return null;
  return { user: userMsg, assistant: assistantLines.join('\n').trim() };
}

// page=0 表示最近一页，page=1 表示往前一页，依此类推（倒序分页）
async function loadHistoryFromChroma(inviteCode, { page = 0, pageSize = 20 } = {}) {
  try {
    const registry = loadInvites();
    const upperCode = (resolveInviteCode(registry, inviteCode) || inviteCode).toUpperCase();
    const entry = registry[upperCode] || {};
    const historicalTokens = (entry.historicalTokens || []).map(t => t.toLowerCase());
    const allTokens = [upperCode.toLowerCase(), ...historicalTokens];
    const visitorName = entry.name || null;

    const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8001';
    const v2 = `${chromaUrl}/api/v2/tenants/default_tenant/databases/default_database`;
    const colResp = await fetch(`${v2}/collections/conversations`);
    if (!colResp.ok) return { messages: [], hasMore: false, totalTurns: 0 };
    const { id: colId } = await colResp.json();

    const getResp = await fetch(`${v2}/collections/${colId}/get`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ limit: 5000, include: ['documents', 'metadatas'] }),
    });
    if (!getResp.ok) return { messages: [], hasMore: false, totalTurns: 0 };
    const data = await getResp.json();
    const ids = data.ids || [];
    const docs = data.documents || [];
    const metas = data.metadatas || [];

    const records = [];
    const seen = new Set();
    for (let i = 0; i < ids.length; i++) {
      if (seen.has(ids[i])) continue;
      const sessionId = (metas[i]?.sessionId || '').toLowerCase();
      const fromId = metas[i]?.fromId || '';
      const matched = allTokens.some(t => sessionId.includes(`visitor:${t}`))
        || (visitorName && fromId === visitorName);
      if (!matched) continue;
      seen.add(ids[i]);
      const parsed = parseConversationDoc(docs[i]);
      if (!parsed) continue;
      const ts = metas[i]?.timestamp ? new Date(metas[i].timestamp).getTime() : 0;
      records.push({ ts, ...parsed });
    }

    records.sort((a, b) => a.ts - b.ts);
    const totalTurns = records.length;

    // 倒序分页：page=0 取最后 pageSize 条，page=1 取再往前 pageSize 条
    const endTurn = totalTurns - page * pageSize;
    const startTurn = Math.max(0, endTurn - pageSize);
    const slice = records.slice(startTurn, endTurn);
    const hasMore = startTurn > 0;

    const messages = [];
    for (const r of slice) {
      if (r.user) messages.push({ role: 'user', content: r.user, ts: r.ts });
      if (r.assistant) messages.push({ role: 'assistant', content: r.assistant, ts: r.ts });
    }
    return { messages, hasMore, totalTurns };
  } catch (e) {
    logger.warn('loadHistoryFromChroma failed', { err: e.message });
    return { messages: [], hasMore: false, totalTurns: 0 };
  }
}

function loadInvites() {
  try {
    if (fs.existsSync(VISITOR_REGISTRY_PATH)) {
      return JSON.parse(fs.readFileSync(VISITOR_REGISTRY_PATH, 'utf8'));
    }
  } catch (e) { /* ignore */ }
  return {};
}

function saveInvites(invites) {
  fs.writeFileSync(VISITOR_REGISTRY_PATH, JSON.stringify(invites, null, 2), 'utf8');
}

// 将 historicalToken（旧邀请码）解析到当前活跃主键；找不到则原样返回
// case-insensitive 查找：registry key 和 historicalTokens 都可能大小写不一致
function resolveInviteCode(invites, code) {
  const upper = code.toUpperCase();
  // 遍历所有条目，先做 case-insensitive 的 key 匹配
  for (const key of Object.keys(invites)) {
    if (key.toUpperCase() === upper) return key; // 直接命中当前活跃码
  }
  // 遍历所有条目，找 historicalTokens 包含此码的那个（case-insensitive）
  for (const [key, entry] of Object.entries(invites)) {
    if (Array.isArray(entry.historicalTokens) &&
        entry.historicalTokens.some(t => t.toUpperCase() === upper)) {
      return key; // 返回当前活跃主键
    }
  }
  return null; // 完全找不到
}

function isInviteValid(invites, code) {
  const resolved = resolveInviteCode(invites, code);
  if (!resolved) return false;
  const inv = invites[resolved];
  if (!inv) return false;
  if (Date.now() > inv.expiresAt) return false;
  return true;
}

// ─── LLM 调用队列管理器 ─────────────────────────────────────────────────────
// 内存队列：最多 3 并发，超过排队，队列 > 10 返回 503
// 重试：error.code === 2064 或 HTTP 529 时指数退避（1s, 2s），最多 2 次
class LLMQueueManager {
  constructor() {
    this.running = 0;
    this.queue = [];
    this.MAX_CONCURRENT = 3;
    this.MAX_QUEUE = 10;
  }

  async enqueue(task) {
    if (this.running >= this.MAX_CONCURRENT) {
      if (this.queue.length >= this.MAX_QUEUE) {
        return { ok: false, status: 503, message: 'AI 服务暂时繁忙，请稍后再试' };
      }
      return new Promise((resolve) => {
        this.queue.push({ task, resolve });
      });
    }
    return this._run(task);
  }

  async _run(task) {
    this.running++;
    try {
      return await task();
    } finally {
      this.running--;
      this._drain();
    }
  }

  _drain() {
    if (this.queue.length === 0) return;
    if (this.running >= this.MAX_CONCURRENT) return;
    const { task, resolve } = this.queue.shift();
    resolve(this._run(task));
  }
}

const llmQueue = new LLMQueueManager();

// ─── Demo Chat 代理端点 ───────────────────────────────────────────────────────
// 把前端发来的聊天请求转发给本机 OpenClaw Gateway（18789），避免 API Key 暴露在前端
// 公网访问时 127.0.0.1:18789 对前端不可达，通过此代理解决跨域+内网访问问题
app.post('/api/demo-proxy/chat', async (req, res) => {
  if (isDemoDisabled()) return res.status(503).json({ success: false, message: '演示功能暂时关闭' });
  const sessionToken = req.headers['x-session-uuid'];
  if (!sessionToken) {
    return res.status(401).json({ success: false, message: 'session_required' });
  }
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '696673d08d0ee98f3e66a30698ab4c1152b7c8784ae424d0';
  const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:18789';
  const body = req.body;
  const inviteCode = req.headers['x-invite-code'];
  const resolvedInviteCode = inviteCode
    ? (resolveInviteCode(loadInvites(), inviteCode) || inviteCode)
    : null;
  const demoBody = {
    ...body,
    user: `visitor:${resolvedInviteCode || sessionToken}`,
  };

  const result = await llmQueue.enqueue(async () => {
    for (let attempt = 0; attempt <= 2; attempt++) {
      const fetchResp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${gatewayToken}`,
          'x-openclaw-agent-id': 'lucas',
        },
        body: JSON.stringify(demoBody),
      });
      const data = await fetchResp.json();
      const isRetryable = fetchResp.status === 529 || (data?.error?.code === 2064);
      if (fetchResp.ok && !isRetryable) {
        const reply = data?.choices?.[0]?.message?.content || '';
        const htmlMatch = reply.match(/```html\s*([\s\S]*?)```/i);
        if (htmlMatch) {
          try {
            const htmlCode = htmlMatch[1].trim();
            const toolId = Date.now().toString(36).slice(-4) + Math.random().toString(36).slice(2, 4);
            const toolDir = path.join(APP_GENERATED_DIR, 'demo-tools', toolId);
            fs.mkdirSync(toolDir, { recursive: true });
            fs.writeFileSync(path.join(toolDir, 'index.html'), htmlCode, 'utf8');
            logger.info('Demo tool saved', { toolId, size: htmlCode.length });
            if (data.choices[0].message) {
              data.choices[0].message.content = reply.replace(
                /```html[\s\S]*?```/i,
                `\n\n✅ 工具已生成！[TOOL_LINK:${toolId}]`
              );
            }
          } catch (toolErr) {
            logger.warn('Demo tool save failed', { error: toolErr.message });
          }
        }
        return { ok: true, status: fetchResp.status, data };
      }
      if (isRetryable && attempt < 2) {
        const delay = 1000 * Math.pow(2, attempt);
        logger.info('LLM retry', { attempt, delay, status: fetchResp.status });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      return { ok: false, status: fetchResp.status, data };
    }
  });

  if (!result.ok) {
    return res.status(503).json({ success: false, message: 'AI 服务暂时繁忙，请稍后再试' });
  }
  res.status(result.status).json(result.data);
});

// 获取历史对话记录（单一来源：ChromaDB，支持倒序分页滑动窗口）
// query: page=0（最近）page=1（往前）…  pageSize=20（默认）
app.get('/api/demo-proxy/history', async (req, res) => {
  if (isDemoDisabled()) return res.status(503).json({ ok: false, error: 'demo_disabled' });
  const inviteCode = req.headers['x-invite-code'];
  if (!inviteCode) return res.status(401).json({ error: 'invite_code_required' });
  const page = Math.max(0, parseInt(req.query.page || '0'));
  const pageSize = Math.min(50, Math.max(5, parseInt(req.query.pageSize || '20')));
  const result = await loadHistoryFromChroma(inviteCode, { page, pageSize });
  res.json({ ok: true, ...result });
});

// 演示访客欢迎消息（访客打开页面时自动触发，启灵主动打招呼）
app.post('/api/demo-proxy/greet', async (req, res) => {
  if (isDemoDisabled()) return res.status(503).json({ ok: false, error: 'demo_disabled' });
  const sessionToken = req.headers['x-session-uuid'];
  const { visitorCode } = req.body || {};
  if (!sessionToken) {
    return res.status(401).json({ error: 'session_required' });
  }
  
  const invites = loadInvites();
  // visitorCode 是前端传来的邀请码（如 "DB334C"），sessionToken 是浏览器 UUID
  // registry key 是邀请码，必须用 visitorCode 查，不能用 UUID
  const lookupKey = (visitorCode || sessionToken).toUpperCase();
  const historyKey = visitorCode || sessionToken;
  const visitorName = invites[lookupKey]?.name || null;

  // 从 ChromaDB 检查是否有历史对话（单一来源）
  const { totalTurns } = await loadHistoryFromChroma(visitorCode || sessionToken, { page: 0, pageSize: 1 });
  if (totalTurns > 0) {
    return res.json({ ok: true, message: null, name: visitorName });
  }

  const botName = process.env.WECOM_BOT_NAME || '助理';
  const greetMessage = visitorName
    ? `您好，${visitorName}！我是${botName}，主人邀请您来体验的。有什么想聊的，或者想要个网页小工具，直接说就好。`
    : `您好！我是${botName}，主人邀请您来体验的。有什么想聊的，直接说就好——比如想要个网页小工具、或者有什么开发需求想试试，都可以跟我说。先告诉我您怎么称呼？`;

  res.json({ ok: true, message: greetMessage, name: visitorName });
});

// 校验邀请码
app.post('/api/demo-proxy/verify-invite', (req, res) => {
  if (isDemoDisabled()) return res.status(503).json({ ok: false, error: 'demo_disabled', message: '演示功能暂时关闭，请联系主人重新开放' });
  const { code } = req.body || {};
  if (!code) return res.json({ ok: false, error: 'missing_code' });
  const invites = loadInvites();
  const upperCode = code.toUpperCase();
  const resolvedKey = resolveInviteCode(invites, upperCode);
  if (resolvedKey && isInviteValid(invites, resolvedKey)) {
    const visitor = invites[resolvedKey];
    res.json({ ok: true, name: visitor.name || '访客', code: resolvedKey });
  } else {
    res.json({ ok: false, error: 'invalid_or_expired' });
  }
});

// 生成访客邀请码（内部接口，需 X-Internal-Secret header）
// 可选 body 参数：name（访客姓名）、invitedBy（邀请人，如"爸爸"/"妈妈"）、
//   scopeTags（知识标签数组，如["工作","科技"]）、behaviorContext（访客背景描述）、
//   expiresInDays（有效天数，默认7天，最长30天）、personId（稳定人员 ID，续期时继承计数）
app.post('/api/demo-proxy/gen-invite', (req, res) => {
  const secret = req.headers['x-internal-secret'];
  const internalSecret = process.env.DEMO_INVITE_SECRET || 'homeai-internal-2024';
  if (secret !== internalSecret) {
    return res.status(403).json({ ok: false, error: 'forbidden' });
  }
  const { name = null, invitedBy = null, scopeTags = [], behaviorContext = null, expiresInDays = 7, personId = null } = req.body || {};
  const code = require('crypto').randomBytes(3).toString('hex').toUpperCase(); // 6位，如 A3F9B2
  const registry = loadInvites();
  const now = Date.now();

  // personId 自动生成：若未传入，基于姓名生成稳定 ID（如 zhangsan-001），确保影子记忆可激活
  let resolvedPersonId = personId;
  if (!resolvedPersonId && name) {
    const slug = name.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '').slice(0, 8);
    const existingSlugs = Object.values(registry)
      .map(e => e.personId || '')
      .filter(p => p.includes('-'));
    let idx = 1;
    let candidate = `${slug}-${String(idx).padStart(3, '0')}`;
    while (existingSlugs.includes(candidate)) {
      idx++;
      candidate = `${slug}-${String(idx).padStart(3, '0')}`;
    }
    resolvedPersonId = candidate;
    logger.info('gen-invite: auto-generated personId', { name, personId: resolvedPersonId });
  }

  // 若提供 personId，从同 personId 的已有条目继承 conversationCount 和 shadowActive
  let conversationCount = 0;
  let shadowActive = false;
  if (personId) {
    const existingEntry = Object.values(registry).find(e => e.personId === personId);
    if (existingEntry) {
      conversationCount = existingEntry.conversationCount || 0;
      shadowActive = existingEntry.shadowActive || false;
    }
  }

  registry[code] = {
    name,
    invitedBy,
    scopeTags: Array.isArray(scopeTags) ? scopeTags : [],
    behaviorContext,
    status: 'active',
    createdAt: now,
    expiresAt: now + Math.max(1, Math.min(30, expiresInDays)) * 24 * 60 * 60 * 1000,
    shadowMemoryPath: null,
    personId: resolvedPersonId,
    conversationCount,
    shadowActive,
  };
  saveInvites(registry);

  // C2: 邀请创建后异步写入 Kuzu 访客节点（fire-and-forget，不阻塞响应）
  {
    const { spawn } = require('child_process');
    const initVisitorScript = path.join(INSTANCE_ROOT, 'scripts', 'init-visitor.py');
    const proc = spawn(
      '/opt/homebrew/opt/python@3.11/bin/python3.11',
      [initVisitorScript, code],
      { detached: true, stdio: 'ignore' }
    );
    proc.unref();
  }

  const expiresDate = new Date(registry[code].expiresAt).toLocaleDateString('zh-CN');
  logger.info('Visitor invite generated', { code, name, invitedBy, scopeTags, expiresAt: expiresDate });
  res.json({ ok: true, code, name, invitedBy, scopeTags, expiresAt: expiresDate });
});

// ─── Windows 节点注册代理端点 ──────────────────────────────────────────────
// 供 Windows 节点安装脚本 POST /api/node/register，实现节点注册到 Gateway
// 实际转发到 Gateway 内部路由，Windows 节点无需直接访问 127.0.0.1:18789
app.post('/api/node/register', async (req, res) => {
  const { node_name, owner_userId, platform, architecture, hostname, gateway_url, registered_at } = req.body || {};

  if (!node_name) {
    return res.status(400).json({ success: false, error: 'node_name is required' });
  }
  
  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '696673d08d0ee98f3e66a30698ab4c1152b7c8784ae424d0';
  const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:18789';
  
  try {
    const response = await fetch(`${gatewayUrl}/api/node/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`,
      },
      body: JSON.stringify(req.body),
    });
    
    if (response.ok) {
      const data = await response.json();
      res.json({ success: true, message: 'Node registered', data });
    } else {
      const data = await response.json().catch(() => ({}));
      res.status(response.status).json({ success: false, error: data.error || 'Registration failed' });
    }
  } catch (err) {
    logger.error('Node registration proxy error', { error: err.message });
    res.status(500).json({ success: false, error: 'Failed to connect to gateway' });
  }
});

// ━━ Windows 节点代理：heartbeat / commands / results ━━━━━━━━━━━━━━━━━━━━━
const _nodeGatewayUrl = () => process.env.GATEWAY_URL || 'http://localhost:18789';
const _nodeGatewayToken = () => process.env.OPENCLAW_GATEWAY_TOKEN || '696673d08d0ee98f3e66a30698ab4c1152b7c8784ae424d0';

app.post('/api/node/heartbeat', async (req, res) => {
  try {
    const response = await fetch(`${_nodeGatewayUrl()}/api/node/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_nodeGatewayToken()}` },
      body: JSON.stringify(req.body),
    });
    res.status(response.status).json(await response.json().catch(() => ({})));
  } catch (err) {
    logger.error('Node heartbeat proxy error', { error: err.message });
    res.status(502).json({ success: false, error: 'Gateway unreachable' });
  }
});

app.get('/api/node/commands/:nodeName', async (req, res) => {
  try {
    const response = await fetch(`${_nodeGatewayUrl()}/api/node/commands/${req.params.nodeName}`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${_nodeGatewayToken()}` },
    });
    res.status(response.status).json(await response.json().catch(() => ({})));
  } catch (err) {
    logger.error('Node commands proxy error', { error: err.message });
    res.status(502).json({ success: false, error: 'Gateway unreachable' });
  }
});

app.post('/api/node/results', async (req, res) => {
  try {
    const response = await fetch(`${_nodeGatewayUrl()}/api/node/results`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_nodeGatewayToken()}` },
      body: JSON.stringify(req.body),
    });
    res.status(response.status).json(await response.json().catch(() => ({})));
  } catch (err) {
    logger.error('Node results proxy error', { error: err.message });
    res.status(502).json({ success: false, error: 'Gateway unreachable' });
  }
});

// ─── Demo TTS 端点 ──────────────────────────────────────────────────────────
// 接受文本，调用 edge-tts 生成 MP3，返回 base64 给前端播放
app.post('/api/demo-proxy/tts', async (req, res) => {
  const sessionToken = req.headers['x-session-uuid'];
  if (!sessionToken) return res.status(401).json({ error: 'session_required' });
  const { text } = req.body || {};
  if (!text || typeof text !== 'string' || text.trim().length === 0) {
    return res.status(400).json({ ok: false, error: 'text required' });
  }
  const safeText = text.trim().slice(0, 300);
  const tmpFile = `/tmp/demo-tts-${Date.now()}.mp3`;
  try {
    await new Promise((resolve, reject) => {
      const proc = require('child_process').spawn(
        TTS_PYTHON,
        ['-m', 'edge_tts', '--voice', TTS_VOICE, '--text', safeText, '--write-media', tmpFile]
      );
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`edge-tts exit ${code}`)));
      proc.on('error', reject);
      setTimeout(() => { proc.kill(); reject(new Error('edge-tts timeout')); }, 15000);
    });
    const audioBuf = require('fs').readFileSync(tmpFile);
    require('fs').unlinkSync(tmpFile);
    const b64 = audioBuf.toString('base64');
    res.json({ ok: true, audio: b64 });
    logger.info('Demo TTS generated', { chars: safeText.length });
  } catch (err) {
    logger.warn('Demo TTS failed', { error: err.message });
    if (require('fs').existsSync(tmpFile)) require('fs').unlinkSync(tmpFile);
    res.status(500).json({ ok: false, error: 'tts_failed' });
  }
});

// ─── Demo STT（MediaRecorder fallback，手机浏览器用）─────────────────────────
app.post('/api/demo-proxy/stt', async (req, res) => {
  const sessionToken = req.headers['x-session-uuid'];
  if (!sessionToken) return res.status(401).json({ error: 'session_required' });
  const { audio, mimeType } = req.body || {};
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ ok: false, error: 'audio base64 required' });
  }
  const ext = (mimeType && mimeType.includes('ogg')) ? 'ogg' : 'webm';
  const tmpIn  = `/tmp/demo-stt-in-${Date.now()}.${ext}`;
  const tmpWav = `/tmp/demo-stt-${Date.now()}.wav`;
  try {
    fs.writeFileSync(tmpIn, Buffer.from(audio, 'base64'));
    await execFileAsync('/opt/homebrew/bin/ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', tmpIn,
      '-ar', '16000', '-ac', '1', '-f', 'wav',
      tmpWav,
    ], { timeout: 30000 });
    const result = await execFileAsync(WHISPER_CLI, [
      '--model', WHISPER_MODEL,
      '--language', 'zh',
      '--no-timestamps',
      '-f', tmpWav,
    ], { timeout: 60000, encoding: 'utf8' });
    const text = result.trim().replace(/^\[.*?\]\s*/gm, '').trim().slice(0, 500);
    res.json({ ok: true, text });
    logger.info('Demo STT ok', { chars: text.length });
  } catch (err) {
    logger.warn('Demo STT failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'stt_failed' });
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
  }
});

// ─── Demo 语音对话端点（双向语音闭环）───────────────────────────────────────────
// 接受语音，STT → Lucas pipeline → TTS → 返回文字+语音
app.post('/api/demo-proxy/voice-chat', async (req, res) => {
  if (isDemoDisabled()) return res.status(503).json({ error: 'demo_disabled', message: '演示功能暂时关闭' });
  const sessionToken = req.headers['x-session-uuid'];
  if (!sessionToken) return res.status(401).json({ error: 'session_required' });
  const { audio, mimeType } = req.body || {};
  if (!audio || typeof audio !== 'string') {
    return res.status(400).json({ ok: false, error: 'audio base64 required' });
  }

  const ext = (mimeType && mimeType.includes('ogg')) ? 'ogg' : 'webm';
  const tmpIn  = `/tmp/demo-vc-in-${Date.now()}.${ext}`;
  const tmpWav = `/tmp/demo-vc-${Date.now()}.wav`;
  const tmpMp3 = `/tmp/demo-vc-tts-${Date.now()}.mp3`;

  try {
    // Step 1: STT
    fs.writeFileSync(tmpIn, Buffer.from(audio, 'base64'));
    await execFileAsync('/opt/homebrew/bin/ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', tmpIn,
      '-ar', '16000', '-ac', '1', '-f', 'wav',
      tmpWav,
    ], { timeout: 30000 });

    const sttResult = await execFileAsync(WHISPER_CLI, [
      '--model', WHISPER_MODEL,
      '--language', 'zh',
      '--no-timestamps',
      '-f', tmpWav,
    ], { timeout: 60000, encoding: 'utf8' });
    const sttText = sttResult.trim().replace(/^\[.*?\]\s*/gm, '').trim().slice(0, 500);
    logger.info('Demo voice-chat STT ok', { chars: sttText.length });

    // Step 2: Send to Lucas pipeline
    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '696673d08d0ee98f3e66a30698ab4c1152b7c8784ae424d0';
    const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:18789';
    const inviteCode = req.headers['x-invite-code'];
    const resolvedInviteCode = inviteCode
      ? (resolveInviteCode(loadInvites(), inviteCode) || inviteCode)
      : null;

    const chatResp = await fetch(`${gatewayUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gatewayToken}`,
        'x-openclaw-agent-id': 'lucas',
      },
      body: JSON.stringify({
        model: 'openclaw',
        messages: [
          { role: 'user', content: sttText }
        ],
        user: `visitor:${resolvedInviteCode || sessionToken}`,
        stream: false,
      }),
    });

    if (!chatResp.ok) {
      throw new Error(`Gateway returned ${chatResp.status}`);
    }

    const chatData = await chatResp.json();
    const replyText = chatData?.choices?.[0]?.message?.content || '';
    logger.info('Demo voice-chat reply ok', { chars: replyText.length });

    // Step 3: TTS
    const safeText = replyText.trim().slice(0, 300);
    await new Promise((resolve, reject) => {
      const proc = require('child_process').spawn(
        TTS_PYTHON,
        ['-m', 'edge_tts', '--voice', TTS_VOICE, '--text', safeText, '--write-media', tmpMp3]
      );
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(`edge-tts exit ${code}`)));
      proc.on('error', reject);
      setTimeout(() => { proc.kill(); reject(new Error('edge-tts timeout')); }, 15000);
    });

    const audioBuf = fs.readFileSync(tmpMp3);
    const audioB64 = audioBuf.toString('base64');

    res.json({ ok: true, text: replyText, audio: audioB64 });
    logger.info('Demo voice-chat ok', { sttChars: sttText.length, replyChars: replyText.length });
  } catch (err) {
    logger.warn('Demo voice-chat failed', { error: err.message });
    if (err.message.includes('Gateway returned')) {
      res.status(502).json({ ok: false, error: 'gateway_error' });
    } else {
      res.status(500).json({ ok: false, error: 'voice_chat_failed' });
    }
  } finally {
    try { fs.unlinkSync(tmpIn); } catch {}
    try { fs.unlinkSync(tmpWav); } catch {}
    try { fs.unlinkSync(tmpMp3); } catch {}
  }
});

// ─── Demo Vision 端点（访客图片理解）────────────────────────────────────────────
// 接受 base64 图片，复用 describeImageWithLlava，返回中文描述
app.post('/api/demo-proxy/vision', async (req, res) => {
  const sessionToken = req.headers['x-session-uuid'];
  if (!sessionToken) return res.status(401).json({ error: 'session_required' });
  const { image, mimeType } = req.body || {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ ok: false, error: 'image base64 required' });
  }
  const ext = (mimeType && mimeType.includes('png')) ? 'png' : 'jpg';
  const tmpImg = `/tmp/demo-vision-${Date.now()}.${ext}`;
  try {
    fs.writeFileSync(tmpImg, Buffer.from(image, 'base64'));
    const description = await describeImageWithLlava(tmpImg);
    if (!description) {
      return res.status(500).json({ ok: false, error: 'vision_failed' });
    }
    res.json({ ok: true, description });
    logger.info('Demo vision ok', { chars: description.length });
  } catch (err) {
    logger.warn('Demo vision failed', { error: err.message });
    res.status(500).json({ ok: false, error: 'vision_failed' });
  } finally {
    try { fs.unlinkSync(tmpImg); } catch {}
  }
});


  return { router, loadInvites, resolveInviteCode, isInviteValid };
};
