'use strict';
/**
 * msg-utils.js — 消息处理工具层
 *
 * 包含：
 *   stripMarkdownForWecom / stripMarkdownForVoice / stripInternalTerms
 *   splitTtsChunks / sendOneTts / sendVoiceChunks
 *   isDuplicateMsg / MessageAggregator / enqueueUserRequest
 *   transcriptionBuffer / jaccardSimilarity / checkReplyRepetition
 *
 * 工厂函数：module.exports = (logger, deps) => ({ ... })
 * deps: { getBotClient, getBotReady }
 */
const { execSync } = require('child_process');

const TTS_PYTHON    = '/opt/homebrew/opt/python@3.11/bin/python3.11';
const TTS_VOICE     = 'zh-CN-YunxiNeural';
const LOCAL_TTS_URL = 'http://127.0.0.1:8082/tts';

module.exports = function createMsgUtils(logger, { getBotClient, getBotReady }) {

// ─── 群文件推送端点（供脚本/工具内部调用）──────────────────────────────────────
//
// POST /api/wecom/send-to-group
// body: { filePath: "绝对路径或相对HomeAI根目录的路径", text: "附带文字（可选）" }
// 用 bot 长连接推送文件到家庭群（wra6wXbgAAu_7v2qu1wnc8Lu3-Za3diQ）

/**
 * TTS 语音回复（私聊专用）
 * 文字 → edge-tts MP3 → uploadMedia → sendMediaMessage(voice)
 * fire-and-forget，失败静默忽略不影响文字回复
 */
/**
 * 将文字按自然断句拆成 ≤ maxLen 字的片段：
 * 优先在句末（。！？…）断，其次在子句（，；）断，最后硬切。
 */
/** 剥离 markdown 符号 + [VOICE] 标记，用于文字发送和 TTS 朗读 */
// 企业微信文本输出：把 Markdown 标题和分割线转成微信能渲染的格式
// 企业微信 bot markdown 支持 **加粗**，不支持 ## 标题和 --- 分割线
// 约束本应在 AGENTS.md 里由模型遵守，但模型违规概率不为零
// 此函数在基础设施层做最后防线：无论模型输出什么，用户看到的都是正确格式
function stripMarkdownForWecom(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')   // 剥离 reasoning 模型 <think> 块
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')   // ## 标题 → **标题**
    .replace(/^---+\s*$/gm, '')                 // 独立 --- 分割线 → 空行
    .replace(/\n{3,}/g, '\n\n')                 // 多余空行压缩
    .trim();
}

// ── 内部术语清洗：发给家人前替换掉内部架构术语 ──────────────────────────
// Andy/Lisa 是家人们熟知的名字，不替换；只清洗技术术语
function stripInternalTerms(text) {
  return text
    .replace(/\bpm2\s+restart\b/gi, '重启服务')
    .replace(/\bpm2\b/gi, '服务管理')
    .replace(/\bGateway\b/gi, '系统')
    .replace(/\bspec\b/gi, '方案')
    .replace(/\bpipeline\b/gi, '流程')
    .replace(/\btask-manager\b/gi, '任务管理')
    .replace(/\bwecom-entrance\b/gi, '消息服务')
    .replace(/\bcrewclaw-routing\b/gi, '路由服务');
}

function stripMarkdownForVoice(text) {
  return text
    .replace(/\[VOICE\]/g, '')
    .replace(/\[RAP\]/g, '')
    .replace(/\*\*([\s\S]*?)\*\*/g, '$1')
    .replace(/\*([\s\S]*?)\*/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[>\-*+]\s+/gm, '')
    .replace(/`{1,3}[^`]*`{1,3}/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitTtsChunks(text, maxLen = 80) {
  const chunks = [];
  let remaining = text.replace(/\s+/g, ' ').trim();
  const sentenceEnd = /[。！？…]+/;
  const clauseEnd   = /[，；、]+/;
  while (remaining.length > maxLen) {
    // 在 maxLen 以内找最后一个句末符号
    const sub = remaining.substring(0, maxLen);
    let cut = -1;
    for (let i = sub.length - 1; i >= 0; i--) {
      if (sentenceEnd.test(sub[i])) { cut = i + 1; break; }
    }
    if (cut <= 0) {
      for (let i = sub.length - 1; i >= 0; i--) {
        if (clauseEnd.test(sub[i])) { cut = i + 1; break; }
      }
    }
    if (cut <= 0) cut = maxLen; // 无合适断点，硬切
    chunks.push(remaining.substring(0, cut).trim());
    remaining = remaining.substring(cut).trim();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * 单条语音：Fish-Speech（优先）或 edge-tts（fallback）→ uploadMedia → sendMediaMessage
 * style: 'normal'（默认）| 'rap'（节奏感强，传给 Fish-Speech 的 instruct）
 * 返回是否成功
 */
async function sendOneTts(toUserId, ttsText, style = 'normal') {
  // ── 尝试本地 TTS（端口 8082，模型加载后才可用）──
  let audioBuf = null;
  try {
    const resp = await Promise.race([
      fetch(LOCAL_TTS_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: ttsText, style }),
      }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('Fish-Speech timeout')), 60000)),
    ]);
    if (resp.ok) {
      const ab = await resp.arrayBuffer();
      audioBuf = Buffer.from(ab);
      logger.info('Fish-Speech TTS 成功', { toUserId, style, bytes: audioBuf.length });
    } else {
      logger.warn('Fish-Speech 返回非 200，降级 edge-tts', { status: resp.status });
    }
  } catch (fishErr) {
    logger.warn('Fish-Speech 不可用，降级 edge-tts', { error: fishErr?.message });
  }

  // ── fallback：edge-tts ──
  const tmpFile = `/tmp/tts-${Date.now()}.mp3`;
  if (!audioBuf) {
    try {
      await new Promise((resolve, reject) => {
        const proc = require('child_process').spawn(TTS_PYTHON, [
          '-m', 'edge_tts',
          '--voice', TTS_VOICE,
          '--text', ttsText,
          '--write-media', tmpFile,
        ]);
        proc.on('close', code => code === 0 ? resolve() : reject(new Error(`edge-tts exit ${code}`)));
        proc.on('error', reject);
        setTimeout(() => { proc.kill(); reject(new Error('edge-tts timeout')); }, 30000);
      });
      audioBuf = require('fs').readFileSync(tmpFile);
    } catch (edgeErr) {
      logger.warn('edge-tts 也失败', { error: edgeErr?.message, toUserId, ttsText: ttsText.substring(0, 30) });
      return false;
    } finally {
      try { require('fs').unlinkSync(tmpFile); } catch {}
    }
  }

  // ── 上传并发送语音泡泡 ──
  try {
    const uploaded = await globalBotClient.uploadMedia(audioBuf, { type: 'voice', filename: `reply-${Date.now()}.wav` });
    const mediaId = uploaded?.media_id || uploaded;
    await globalBotClient.sendMediaMessage(toUserId, 'voice', mediaId);
    return true;
  } catch (e) {
    logger.warn('语音上传/发送失败', { error: e?.message || String(e), toUserId });
    return false;
  }
}

/** 文字 → 多条语音（每段 ≤200 字，顺序发送，fire-and-forget）
 * style: 'normal'（默认）| 'rap'（节奏感强，传给 Fish-Speech） */
async function sendVoiceChunks(toUserId, text, style = 'normal') {
  if (!globalBotClient || !globalBotReady) return;
  const chunks = splitTtsChunks(text, 200);
  let sent = 0;
  for (const chunk of chunks) {
    const ok = await sendOneTts(toUserId, chunk, style);
    if (ok) sent++;
  }
  if (sent > 0) {
    logger.info('TTS 语音回复已发送', { toUserId, style, textLen: text.length, chunks: chunks.length, sent });
  } else {
    logger.warn('TTS 语音回复全部失败（已忽略）', { toUserId });
  }
}


// 消息去重：企业微信 WebSocket 在网络抖动时会重推同一 msgid
// 用 Set 记录已处理的 msgid，60 秒后自动清除（防内存泄漏）
const processedMsgIds = new Set();
function isDuplicateMsg(msgId) {
  if (!msgId || processedMsgIds.has(msgId)) return true;
  processedMsgIds.add(msgId);
  setTimeout(() => processedMsgIds.delete(msgId), 60_000);
  return false;
}


// ─── 消息聚合器：短时间内多条同类消息合并为一次 Lucas 调用 ─────────────────
class MessageAggregator {
  constructor() {
    this._buffers = new Map(); // key → { items: [], timer }
    this.DEBOUNCE_MS = 3000;   // 等用户停止说话 3 秒（trailing-edge）
    this.MAX_ITEMS   = 10;     // 最多聚合 10 条
  }

  // key = `${fromUser}:${isGroup}:${typeTag}` (typeTag: 'douyin'|'video'|'article'|'text')
  add(key, item) {
    if (this._buffers.has(key)) {
      const buf = this._buffers.get(key);
      buf.items.push(item);
      if (buf.items.length >= this.MAX_ITEMS) { this._flush(key); return; }
      // trailing-edge debounce：每来一条新消息都重置计时器，等用户停止说话再处理
      clearTimeout(buf.timer);
      buf.timer = setTimeout(() => this._flush(key), this.DEBOUNCE_MS);
      return;
    }
    const buf = { items: [item], timer: setTimeout(() => this._flush(key), this.DEBOUNCE_MS) };
    this._buffers.set(key, buf);
  }

  _flush(key) {
    const buf = this._buffers.get(key);
    if (!buf) return;
    clearTimeout(buf.timer);
    this._buffers.delete(key);
    if (buf.items.length === 0) return;

    const first = buf.items[0];
    if (buf.items.length === 1) {
      // 单条消息：直接走原流程
      first.sendFn(first.messageToLucas, first.wecomUserId, first.historyMessages, first.extra);
      return;
    }

    // 多条消息：合并为一条 prompt
    const count = buf.items.length;
    const sceneHint = count >= 3
      ? `\n[系统提示：家人在短时间内连续发送了 ${count} 条同类型消息。请用最短的回复确认收到并简要概括，不要逐条重复分析。回复控制在 100 字以内。]`
      : `\n[系统提示：家人连续发送了 ${count} 条消息，请合并回复。]`;

    const messages = buf.items.map((it, i) => `${i + 1}. ${it.rawText}`).join('\n');
    const mergedMessage = `${first.messageToLucas}${sceneHint}\n${messages}`;

    first.sendFn(mergedMessage, first.wecomUserId, first.historyMessages, first.extra);
  }
}

const messageAggregator = new MessageAggregator();

// ─── per-user 请求队列：同一用户的请求串行化，防止并发打挂 Gateway ────────
// 每个用户同时只有一个 callGatewayAgent 在跑，后续消息等前一条回来再发。
const _userQueues = new Map(); // userId → Promise
function enqueueUserRequest(userId, fn) {
  const prev = _userQueues.get(userId) || Promise.resolve();
  const next = prev.then(fn).catch(() => {});
  _userQueues.set(userId, next);
  next.then(() => { if (_userQueues.get(userId) === next) _userQueues.delete(userId); });
}

// ─── 抖音转录结果缓冲：多条抖音完成时合并推送 ──────────────────────────
const transcriptionBuffer = new Map(); // userId → Array<{ meta, douyinUrl, memberTag }>
transcriptionBuffer.add = function(userId, item) {
  if (!this.has(userId)) this.set(userId, []);
  this.get(userId).push(item);
};
transcriptionBuffer.flush = function(userId) {
  const items = this.get(userId) || [];
  this.delete(userId);
  return items;
};


// ─── 重复回复防护 ────────────────────────────────────────────────────
// 当 Agent 工具不可用或模型异常时，可能对同一上下文重复输出相似内容。
// 检测最近 N 条回复的相似度，超过阈值时替换为简短提示，防止刷屏。
const REPEAT_GUARD_MAX_HISTORY = 3;
const REPEAT_GUARD_SIMILARITY_THRESHOLD = 0.75; // bigram Jaccard 阈值（原 0.6 单字符导致中文误杀）
const replyHistory = new Map(); // userId → string[]（最近 N 条回复的前 200 字符）

// 用 bigram（字符对）而非单字符计算 Jaccard，对中文更准确
// 单字符集合在中文中误杀率高：同一话题的不同回复共享大量高频汉字
function jaccardSimilarity(a, b) {
  if (!a || !b) return 0;
  const toBigrams = s => {
    const bg = new Set();
    for (let i = 0; i < s.length - 1; i++) bg.add(s.slice(i, i + 2));
    return bg;
  };
  const setA = toBigrams(a);
  const setB = toBigrams(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const bg of setA) if (setB.has(bg)) intersection++;
  return intersection / (setA.size + setB.size - intersection);
}

function checkReplyRepetition(userId, replyText) {
  const fingerprint = (replyText || '').slice(0, 200).replace(/\s+/g, '');
  const history = replyHistory.get(userId) || [];

  // 与最近 N 条比较
  let similarCount = 0;
  for (const prev of history) {
    if (jaccardSimilarity(fingerprint, prev) > REPEAT_GUARD_SIMILARITY_THRESHOLD) {
      similarCount++;
    }
  }

  // 更新历史
  history.push(fingerprint);
  if (history.length > REPEAT_GUARD_MAX_HISTORY) history.shift();
  replyHistory.set(userId, history);

  // 连续 2+ 条高度相似 → 判定为重复循环
  if (similarCount >= 2) {
    // 清空历史，避免后续消息也触发
    replyHistory.delete(userId);
    return true;
  }
  return false;
}


  return {
    stripMarkdownForWecom,
    stripMarkdownForVoice,
    stripInternalTerms,
    splitTtsChunks,
    sendVoiceChunks,
    isDuplicateMsg,
    messageAggregator,
    enqueueUserRequest,
    transcriptionBuffer,
    checkReplyRepetition,
  };
};
