'use strict';
/**
 * lucas-routes.js — Lucas 消息回调 + 主动发送路由层
 *
 * 包含：push-reply / forward(test) /
 *       waitBotReady / send-to-group / send-file / send-voice /
 *       sendLongWeComMessage / notify-engineer /
 *       exec-main-tool(internal) / trigger-monitor(internal) /
 *       demo-proxy/pending / demo-proxy/visitor-tasks
 *
 * 工厂函数：module.exports = (logger, deps) => express.Router()
 * deps: { HOMEAI_ROOT, PORT, WECOM_OWNER_ID,
 *         getBotClient, getBotReady,
 *         botSend, sendWeComGroupFile, sendWeComMessage,
 *         sendVoiceChunks, stripMarkdownForWecom,
 *         appendChatHistory, chatHistoryKey, buildHistoryMessages,
 *         callGatewayAgent, executeMainTool, runMainMonitorLoop,
 *         loadInvites, isInviteValid, visitorPendingMessages }
 */
const express = require('express');
const fs      = require('fs');
const path    = require('path');

const CHROMA_API_BASE = 'http://localhost:8000/api/v1/collections';

module.exports = function createLucasRoutes(logger, {
  HOMEAI_ROOT, PORT, WECOM_OWNER_ID,
  getBotClient, getBotReady,
  botSend, sendWeComGroupFile, sendWeComMessage,
  sendVoiceChunks, stripMarkdownForWecom,
  appendChatHistory, chatHistoryKey, buildHistoryMessages,
  callGatewayAgent, executeMainTool, runMainMonitorLoop,
  loadInvites, isInviteValid, visitorPendingMessages,
}) {
  const router = express.Router();
  const app = router;  // block uses app.post/app.get — aliased to router

// ─── 异步回调接口（Lucas 开发任务完成后回调）──────────────────────────────

app.post('/api/wecom/push-reply', async (req, res) => {
  res.json({ success: true }); // 立即 ack

  const { response, replyTo, success: taskSuccess, alert: isAlert } = req.body;
  if (!response) return;

  // alert: true（alert_owner 告警）时不加 "❌ 处理失败：" 前缀——消息已有 ⚠️/🚨 图标，加前缀反而误导
  const rawText = taskSuccess === false && !isAlert ? `❌ 处理失败：${response}` : response;
  const text = stripMarkdownForWecom(rawText);

  // 解析 replyTo：支持两种格式
  //   格式 A（原 Lucas daemon）：{ fromUser, chatId, isGroup }
  //   格式 B（crewclaw-routing 插件）：{ fromUser: "group:chatId" } 或 { fromUser: "userId" }
  let fromUser, chatId, isGroup;
  if (replyTo) {
    if (replyTo.isGroup !== undefined) {
      // 格式 A
      ({ fromUser, chatId, isGroup } = replyTo);
    } else if (replyTo.fromUser?.startsWith('group:')) {
      // 格式 B（群）
      chatId   = replyTo.fromUser.replace('group:', '');
      isGroup  = true;
      fromUser = '';
    } else {
      // 格式 B（个人）
      fromUser = replyTo.fromUser || replyTo.userId || '';
      isGroup  = false;
    }
  }
  if (!fromUser && !chatId) {
    logger.warn('push-reply: 无法解析 replyTo', { replyTo });
    return;
  }

  // 非法 userId 过滤：群聊 chatId 为 "group" / 私聊 fromUser 为 system/UUID 等都不可达
  const _UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const isInvalidUser = (u) => !u || u.startsWith('system') || u === 'unknown' || u === 'test' ||
    u === 'group' || u === 'owner' || u === 'heartbeat-cron' || _UUID_RE.test(u);
  if (isGroup && isInvalidUser(chatId)) {
    logger.info('push-reply: 跳过非法群 chatId', { chatId });
    return;
  }
  if (!isGroup && isInvalidUser(fromUser)) {
    logger.info('push-reply: 跳过非法私聊 userId', { fromUser });
    return;
  }

  try {
    if (isGroup) {
      // 群聊：只走 bot 通道（显示「启灵」）；失败通知系统工程师，不降级
      try {
        await botSend(chatId, text);
        if (chatId) {
          appendChatHistory(chatHistoryKey(true, chatId, null), '[启灵主动发送]', text);
        }
        logger.info('异步回复已发送', { chatId, isGroup: true, channel: 'bot', actor: 'lucas' });
      } catch (botErr) {
        logger.error('群聊 bot 推送失败，通知系统工程师', { chatId, error: botErr.message });
        fetch(`http://localhost:${PORT}/api/wecom/notify-engineer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'intervention', fromAgent: 'lucas', message: `⚠️ 群聊推送失败，消息未送达。\n目标群：${chatId}\n异常：${botErr.message}\n原消息：${text.slice(0, 300)}` }),
        }).catch(() => {});
      }
      return;
    } else {
      // 私聊主动推送：只走 bot 通道（显示「启灵」）
      // bot 不可用或失败 = 消息丢失，通知系统工程师说明异常，不降级到企业应用
      if (getBotClient() && getBotReady()) {
        try {
          await getBotClient().sendMessage(fromUser, { msgtype: 'markdown', markdown: { content: text } });
          if (fromUser) {
            appendChatHistory(chatHistoryKey(false, null, fromUser), '[启灵主动发送]', text);
          }
          logger.info('异步回复已发送', { fromUser, isGroup: false, channel: 'bot', actor: 'lucas' });
        } catch (botErr) {
          logger.error('私聊 bot 推送失败，通知系统工程师', { fromUser, error: botErr.message });
          fetch(`http://localhost:${PORT}/api/wecom/notify-engineer`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'intervention', fromAgent: 'lucas', message: `⚠️ 私聊推送失败，消息未送达。\n目标用户：${fromUser}\n异常：${botErr.message}\n原消息：${text.slice(0, 300)}` }),
          }).catch(() => {});
        }
      } else {
        logger.warn('私聊推送时 bot 未就绪，通知系统工程师', { fromUser, globalBotReady: getBotReady() });
        fetch(`http://localhost:${PORT}/api/wecom/notify-engineer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'intervention', fromAgent: 'lucas', message: `⚠️ 私聊推送时 bot 未就绪（globalBotReady=${getBotReady()}），消息未送达。\n目标用户：${fromUser}\n原消息：${text.slice(0, 300)}` }),
        }).catch(() => {});
      }
      return; // 私聊路径已在上方处理日志，提前返回
    }
    const channel = isGroup ? (getBotReady() ? 'bot' : 'app') : 'bot';
    logger.info('异步回复已发送', { fromUser, chatId, isGroup, channel, actor: 'lucas' });
  } catch (e) {
    logger.error('异步回复发送失败', { error: e.message });
  }
});

// ─── 测试直发接口 ─────────────────────────────────────────────────────────

app.post('/api/wecom/forward', async (req, res) => {
  const { message, userId = 'test-user' } = req.body;
  if (!message) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }
  try {
    const histKey = chatHistoryKey(false, null, userId);
    const historyMessages = buildHistoryMessages(histKey);
    const response = await callGatewayAgent('lucas', message, `wecom-${userId}`, 180000, historyMessages);
    appendChatHistory(histKey, message, response || '');
    res.json({ success: true, response });
  } catch (e) {
    logger.error('Forward error', { error: e.message });
    res.status(500).json({ success: false, error: e.message });
  }
});


// 等待 bot 认证就绪（最多等 waitMs 毫秒）
function waitBotReady(waitMs = 15000) {
  if (getBotReady()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + waitMs;
    const check = setInterval(() => {
      if (getBotReady()) { clearInterval(check); resolve(); }
      else if (Date.now() > deadline) { clearInterval(check); reject(new Error('bot 认证超时')); }
    }, 500);
  });
}

app.post('/api/wecom/send-to-group', async (req, res) => {
  const { filePath, text, voiceText } = req.body || {};
  if (!filePath && !text) return res.status(400).json({ success: false, error: 'filePath or text required' });

  const familyInfo = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.homeai/family-info.json'), 'utf8'));
  const chatId = familyInfo.wecomFamilyChatId;

  try {
    const groupHistKey = chatHistoryKey(true, chatId, null);

    // 纯文字通知（可附带语音）
    if (text && !filePath) {
      // 群聊：只走 bot 通道（显示「启灵」）；失败通知 SE，不降级
      try {
        await botSend(chatId, text);
      } catch (botErr) {
        logger.error('群文字发送失败，通知系统工程师', { chatId, error: botErr.message });
        fetch(`http://localhost:${PORT}/api/wecom/notify-engineer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'intervention', fromAgent: 'lucas', message: `⚠️ 群消息未送达。\n目标群：${chatId}\n异常：${botErr.message}\n原消息：${text.slice(0, 300)}` }),
        }).catch(() => {});
        return res.json({ success: false, error: botErr.message });
      }
      appendChatHistory(groupHistKey, '[启灵主动发送]', text);
      logger.info('群文字消息已发送', { chatId, length: text.length, channel: 'bot', actor: 'lucas' });
      // 可选：同时发语音（fire-and-forget，失败不影响文字回复）
      if (voiceText) {
        sendVoiceChunks(chatId, voiceText).catch(() => {});
      }
      return res.json({ success: true });
    }

    const absPath = filePath.startsWith('/') ? filePath : path.join(HOMEAI_ROOT, filePath);
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ success: false, error: `文件不存在：${absPath}` });
    }
    const filename = path.basename(absPath);

    // 有文字则先发文字通知（只走 bot 通道，失败不阻塞后续文件发送）
    if (text) {
      try {
        await botSend(chatId, text);
        appendChatHistory(groupHistKey, '[启灵主动发送]', text);
      } catch (botErr) {
        logger.warn('群文件前置文字发送失败，继续发文件', { chatId, error: botErr.message });
      }
    }

    // 发文件到群
    await sendWeComGroupFile(chatId, absPath);

    logger.info('群文件已发送', { file: filename, chatId, actor: 'lucas' });
    res.json({ success: true, file: filename });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : (e?.errmsg || JSON.stringify(e));
    logger.error('家庭广播发送失败', { error: errMsg, stack: e?.stack });
    res.status(500).json({ success: false, error: errMsg });
  }
});

// ─── Lucas 主动发消息接口 ──────────────────────────────────────────────────────
// Lucas 调用 send_wecom_message 工具时，插件通过此接口向指定成员发消息。
// userId 使用 BOOTSTRAP.md 中登记的家庭成员 userId（如 XiaMoQiuFengLiang）。

// ─── 文件发送端点（供 Lucas 工具调用，走 bot 长连接，显示「启灵」）─────────
// POST /api/wecom/send-file
// body: { target: string, filePath: string, text?: string }
//   target: userId（私聊）或家庭群 chatId（群聊），统一走 globalBotClient bot 通道
app.post('/api/wecom/send-file', async (req, res) => {
  const { target, filePath, text } = req.body || {};
  if (!target || !filePath) {
    return res.status(400).json({ success: false, error: 'target and filePath are required' });
  }
  const absPath = filePath.startsWith('/') ? filePath : path.join(HOMEAI_ROOT, filePath);
  if (!fs.existsSync(absPath)) {
    return res.status(404).json({ success: false, error: `文件不存在：${absPath}` });
  }
  try {
    await waitBotReady(10000);
    if (!getBotClient()) throw new Error('bot 客户端未初始化');
    const filename = path.basename(absPath);
    const buffer = fs.readFileSync(absPath);
    // 上传素材，获取 media_id（3天内有效）
    const uploaded = await getBotClient().uploadMedia(buffer, { type: 'file', filename });
    const mediaId = uploaded.media_id;
    // 先发说明文字（可选）— 私聊 userId 不支持 sendMessage text/markdown（errcode=40008），跳过
    if (text && target.startsWith('wr')) {  // chatId 以 wr 开头（群聊）
      await getBotClient().sendMessage(target, { msgtype: 'markdown', markdown: { content: text } });
    }
    // 发文件
    await getBotClient().sendMediaMessage(target, 'file', mediaId);
    logger.info('文件已发送（bot）', { target, file: filename, actor: 'lucas' });
    res.json({ success: true, file: filename });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logger.error('文件发送失败', { error: errMsg, target, filePath });
    res.status(500).json({ success: false, error: errMsg });
  }
});

// ─── 主动发语音端点（供 Lucas send_voice_message 工具调用）──────────────────
// POST /api/wecom/send-voice
// body: { target: string, text: string }
//   target: userId（私聊）或 "group"（家庭群）
app.post('/api/wecom/send-voice', async (req, res) => {
  const { target, text } = req.body || {};
  if (!target || !text) {
    return res.status(400).json({ success: false, error: 'target and text are required' });
  }
  const familyInfo = JSON.parse(fs.readFileSync(path.join(process.env.HOME, '.homeai/family-info.json'), 'utf8'));
  const chatId = target === 'group' ? familyInfo.wecomFamilyChatId : target;
  try {
    await sendVoiceChunks(chatId, text);
    logger.info('主动语音已发送', { target: chatId, textLen: text.length, actor: 'lucas' });
    res.json({ success: true });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logger.error('主动语音发送失败', { error: errMsg, target: chatId });
    res.status(500).json({ success: false, error: errMsg });
  }
});

// ─── 系统工程师通道通知（Lucas → 系统工程师）──────────────────────────────────
//
// POST /api/wecom/notify-engineer
// body: { message, type }
// 走企业应用 HTTP API（显示「系统工程师」），专门用于流程通报和系统干预请求。
// 与 push-reply（启灵私聊）区别：此端点不走 bot 通道，始终通过企业应用发出。
// 不记录到 chatHistory，不以 Lucas 身份出现。

// 超长消息按换行切段发送（企业微信单条上限 2000 字）
async function sendLongWeComMessage(userId, text) {
  const MAX = 2000;
  if (text.length <= MAX) {
    await sendWeComMessage(userId, text);
    return;
  }
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    if ((chunk + '\n' + line).length > MAX) {
      if (chunk) await sendWeComMessage(userId, chunk.trim());
      chunk = line;
    } else {
      chunk = chunk ? chunk + '\n' + line : line;
    }
  }
  if (chunk.trim()) await sendWeComMessage(userId, chunk.trim());
}

app.post('/api/wecom/notify-engineer', async (req, res) => {
  const { message, type = 'info', fromAgent = 'main' } = req.body || {};
  if (!message) {
    return res.status(400).json({ success: false, error: 'message is required' });
  }
  if (!WECOM_OWNER_ID) {
    return res.status(500).json({ success: false, error: 'WECOM_OWNER_ID not configured' });
  }
  const icon = type === 'intervention' ? '🔧' : type === 'pipeline' ? '📋' : 'ℹ️';
  const agentLabel = { lucas: 'Lucas', andy: 'Andy', lisa: 'Lisa', main: 'Main', pipeline: '流水线', watchdog: 'Watchdog' }[fromAgent] ?? fromAgent;
  const text = `${icon} [${agentLabel} → 系统工程师]\n${message}`;
  try {
    await sendLongWeComMessage(WECOM_OWNER_ID, text);
    logger.info('notify-engineer 已发送 (app)', { type, length: message.length });
    res.json({ success: true, channel: 'app' });
    // fire-and-forget：写入 ChromaDB agent_interactions，供 Main recall_memory 做过程分析
    (async () => {
      try {
        const embResp = await fetch('http://localhost:11434/api/embeddings', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: 'nomic-embed-text', prompt: text.slice(0, 400) }),
          signal: AbortSignal.timeout(10000),
        });
        if (!embResp.ok) return;
        const { embedding } = await embResp.json();
        const colResp = await fetch(`${CHROMA_API_BASE}/agent_interactions`);
        if (!colResp.ok) return;
        const { id: colId } = await colResp.json();
        await fetch(`${CHROMA_API_BASE}/${colId}/add`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ids: [`notify-engineer-${Date.now()}`],
            embeddings: [embedding],
            documents: [text],
            metadatas: [{ agentId: fromAgent, toAgent: 'engineer', interactionType: `notify_${type}`, timestamp: new Date().toISOString() }],
          }),
        });
      } catch (_e) { /* 写入失败静默处理 */ }
    })();
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logger.error('notify-engineer 发送失败', { error: errMsg });
    res.status(500).json({ success: false, error: errMsg });
  }
});

// POST /api/internal/exec-main-tool — 内部调试 API，直接执行 Main 工具（不经过模型）
app.post('/api/internal/exec-main-tool', async (req, res) => {
  const { tool, input } = req.body;
  if (!tool) return res.status(400).json({ error: 'tool required' });
  try {
    const result = await executeMainTool(tool, input || {});
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// POST /api/internal/trigger-monitor — 手动触发 Main 监控循环（走完整的工具调用循环+企业微信推送）
app.post('/api/internal/trigger-monitor', async (req, res) => {
  if (!WECOM_OWNER_ID) return res.status(500).json({ error: 'WECOM_OWNER_ID not set' });
  res.json({ ok: true, message: '监控循环已触发，结果将推送至企业微信' });
  // 异步执行，不阻塞响应
  setImmediate(() => runMainMonitorLoop().catch(e => logger.error('手动触发监控循环失败', { error: e.message })));
});

// GET /api/demo-proxy/pending — 前端轮询 Lucas 主动推送给访客的消息
app.get('/api/demo-proxy/pending', (req, res) => {
  const inviteCode = (req.headers['x-invite-code'] || '').toUpperCase();
  if (!inviteCode) return res.json({ messages: [] });
  const invites = loadInvites();
  if (!isInviteValid(invites, inviteCode)) return res.json({ messages: [] });
  // historicalTokens 也视为当前用户
  const inv = invites[inviteCode];
  const allTokens = [inviteCode.toLowerCase(), ...((inv && inv.historicalTokens) || []).map(t => t.toLowerCase())];
  const msgs = [];
  for (const t of allTokens) {
    if (visitorPendingMessages[t] && visitorPendingMessages[t].length) {
      msgs.push(...visitorPendingMessages[t]);
      visitorPendingMessages[t] = [];
    }
  }
  msgs.sort((a, b) => a.id - b.id);
  res.json({ messages: msgs });
});

// GET /api/demo-proxy/visitor-tasks — 访客查看自己的任务列表
app.get('/api/demo-proxy/visitor-tasks', (req, res) => {
  const inviteCode = (req.headers['x-invite-code'] || '').trim().toUpperCase();
  if (!inviteCode) {
    return res.status(401).json({ success: false, message: '缺少邀请码' });
  }
  try {
    const TASK_FILE = path.join(HOMEAI_ROOT, 'data/learning/task-registry.json');
    if (!fs.existsSync(TASK_FILE)) {
      return res.json({ success: true, tasks: [] });
    }
    const raw = fs.readFileSync(TASK_FILE, 'utf8');
    const entries = JSON.parse(raw);
    const tasks = entries.filter(e =>
      (e.visitorCode || '').toUpperCase() === inviteCode &&
      ['completed', 'running', 'failed', 'queued'].includes(e.status)
    ).map(e => ({
      id: e.id,
      title: (e.requirement || e.desc || '未知需求').slice(0, 60),
      status: e.status,
      submittedAt: e.submittedAt,
      completedAt: e.completedAt,
      cancelledAt: e.cancelledAt,
      failureReason: e.failureReason || null,
    }));
    res.json({ success: true, tasks });
  } catch (e) {
    logger.error('visitor-tasks error', { error: e.message });
    res.status(500).json({ success: false, message: '获取任务失败' });
  }
});


  return router;
};
