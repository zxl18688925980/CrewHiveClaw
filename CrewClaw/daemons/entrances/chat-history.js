'use strict';

/**
 * chat-history.js — 渠道无关的对话历史模块
 *
 * 所有 entrance（wecom / feishu / email / ...）和 shadow agent 共用此模块。
 * chatHistoryKey 格式：{channel}:{type}:{id}[:thread:{threadId}]
 *   普通对话：  wecom:user:ZengXiaoLong
 *   指定线程：  wecom:user:ZengXiaoLong:thread:project-abc
 *   影子 Agent：shadow:{agentId}:wecom:user:ZengXiaoLong
 *   Agent协作：shadow:{agentId}:wecom:user:ZengXiaoLong:thread:task-xyz
 *
 * threadId 用于同一用户/群的多条对话线（如不同项目、Andy↔Lisa 协作任务）。
 * 不传或传 'default' 时行为与旧版完全一致，文件名不变，零迁移成本。
 *
 * 文件位置：~/.homeai/chat-history/{key}.json
 */

const fs   = require('fs');
const path = require('path');

// ─── 常量 ────────────────────────────────────────────────────────────────────

const CHAT_HISTORY_STORE  = 50;                        // 持久化保留轮数上限
const CHAT_HISTORY_INJECT = 10;                        // 每次注入轮数（≤ STORE）
const CHAT_HISTORY_TTL    = 7 * 24 * 60 * 60 * 1000;  // 一周过期

const CHAT_HISTORY_DIR = path.join(process.env.HOME || '', '.homeai', 'chat-history');
try { fs.mkdirSync(CHAT_HISTORY_DIR, { recursive: true }); } catch {}

// ─── 旧格式迁移（一次性，启动时执行）────────────────────────────────────────
// 旧格式：user:X.json / group:X.json
// 新格式：wecom:user:X.json / wecom:group:X.json
(function migrateOldFiles() {
  try {
    const files = fs.readdirSync(CHAT_HISTORY_DIR);
    for (const f of files) {
      if (f.startsWith('user:') || f.startsWith('group:')) {
        const oldPath = path.join(CHAT_HISTORY_DIR, f);
        const newName = 'wecom:' + f;
        const newPath = path.join(CHAT_HISTORY_DIR, newName);
        if (!fs.existsSync(newPath)) {
          fs.renameSync(oldPath, newPath);
        }
      }
    }
  } catch {}
})();

// ─── Key / 文件名 ────────────────────────────────────────────────────────────

/**
 * 生成 chatHistoryKey。
 * @param {string}       channel    渠道标识，如 'wecom'、'feishu'、'email'
 * @param {boolean}      isGroup    是否群聊
 * @param {string|null}  chatId     群 ID（isGroup=true 时必填）
 * @param {string|null}  fromUser   用户 ID（isGroup=false 时必填）
 * @param {string}       [threadId] 对话线 ID，默认 'default'（不改变文件名）
 */
function chatHistoryKey(channel, isGroup, chatId, fromUser, threadId = 'default') {
  const base = isGroup
    ? `${channel}:group:${chatId}`
    : `${channel}:user:${fromUser}`;
  return threadId === 'default' ? base : `${base}:thread:${threadId}`;
}

/**
 * 影子 Agent 专用 key，避免与主 Agent 历史混淆。
 * @param {string}  agentId    影子 Agent ID，如 'shadow-ZengXiaoLong'
 * @param {string}  channel
 * @param {boolean} isGroup
 * @param {string|null} chatId
 * @param {string|null} fromUser
 * @param {string}  [threadId] 对话线 ID，默认 'default'
 */
function shadowHistoryKey(agentId, channel, isGroup, chatId, fromUser, threadId = 'default') {
  const base = isGroup
    ? `shadow:${agentId}:${channel}:group:${chatId}`
    : `shadow:${agentId}:${channel}:user:${fromUser}`;
  return threadId === 'default' ? base : `${base}:thread:${threadId}`;
}

function chatHistoryFile(key) {
  return path.join(CHAT_HISTORY_DIR, key.replace(/[^a-zA-Z0-9_\-:]/g, '_') + '.json');
}

// ─── 读写 ────────────────────────────────────────────────────────────────────

function loadChatHistory(key) {
  try {
    const raw = JSON.parse(fs.readFileSync(chatHistoryFile(key), 'utf8'));
    const now = Date.now();
    const valid = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      if (now - raw[i].ts < CHAT_HISTORY_TTL) {
        valid.push(raw[i], raw[i + 1]);
      }
    }
    return valid;
  } catch {
    return [];
  }
}

function appendChatHistory(key, userText, assistantText) {
  const history = loadChatHistory(key);
  history.push({ role: 'user',      text: userText,      ts: Date.now() });
  history.push({ role: 'assistant', text: assistantText, ts: Date.now() });
  while (history.length > CHAT_HISTORY_STORE * 2) history.splice(0, 2);
  try { fs.writeFileSync(chatHistoryFile(key), JSON.stringify(history)); } catch {}
}

/**
 * 将 Unix 毫秒时间戳转为北京时间相对描述（"今天 22:38" / "昨天 10:15" / "3天前"）。
 * 用于 chatHistory 消息前缀，让 Lucas 感知"这是刚才说的"还是"这是上个月的"。
 */
function _relativeTimeLabel(ts) {
  const now      = Date.now();
  const diffDay  = Math.floor((now - ts) / 86400000);
  const cstNow   = new Date(now + 8 * 3600000);
  const cstTs    = new Date(ts  + 8 * 3600000);
  const todayStr = cstNow.toISOString().slice(0, 10);
  const yestStr  = new Date(now - 86400000 + 8 * 3600000).toISOString().slice(0, 10);
  const tsStr    = cstTs.toISOString().slice(0, 10);
  const hh = String(cstTs.getUTCHours()).padStart(2, '0');
  const mm = String(cstTs.getUTCMinutes()).padStart(2, '0');
  if (tsStr === todayStr) return `今天 ${hh}:${mm}`;
  if (tsStr === yestStr)  return `昨天 ${hh}:${mm}`;
  if (diffDay < 7)        return `${diffDay}天前`;
  return `${Math.floor(diffDay / 7)}周前`;
}

function buildHistoryMessages(key) {
  const history = loadChatHistory(key);
  if (history.length === 0) return [];
  const win = history.slice(-(CHAT_HISTORY_INJECT * 2));
  return win.map(h => {
    const label = _relativeTimeLabel(h.ts || 0);
    let content = h.role === 'assistant'
      ? h.text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\[VOICE\]/g, '').trim().slice(0, 300)
      : h.text.slice(0, 500);
    if (!content) return null;
    return { role: h.role, content: `[${label}] ${content}` };
  }).filter(m => m !== null && m.content.length > 0);
}

/**
 * 找到最近活跃的群聊历史 key（按文件修改时间倒排）。
 * 用于私聊时注入群聊背景，恢复 Lucas 的跨渠道在场感。
 * @param {string} channel  渠道标识，如 'wecom'
 * @returns {string|null}   chatHistoryKey 或 null（没有群聊文件时）
 */
function getMostRecentGroupKey(channel) {
  try {
    const prefix = `${channel}:group:`;
    const files = fs.readdirSync(CHAT_HISTORY_DIR)
      .filter(f => f.startsWith(prefix) && f.endsWith('.json'))
      .map(f => ({ key: f.replace(/\.json$/, ''), mtime: fs.statSync(path.join(CHAT_HISTORY_DIR, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? files[0].key : null;
  } catch { return null; }
}

/**
 * 构建最近群聊消息（供私聊注入跨渠道背景感知）。
 * 只取 48h 内的消息（更早的群聊对当前私聊无实质帮助）。
 * 每条消息加 [群聊 - 今天 22:38] 前缀，让 Lucas 知道来源。
 * @param {string} groupKey  chatHistoryKey（群聊）
 * @param {number} n         取最近 n 轮（默认 4，即最多 8 条消息）
 * @returns {Array<{role:string, content:string}>}
 */
function buildGroupContextMessages(groupKey, n = 4) {
  const history = loadChatHistory(groupKey);
  if (history.length === 0) return [];
  const now = Date.now();
  const win = history.slice(-(n * 2)).filter(h => (now - (h.ts || 0)) < 48 * 3600 * 1000);
  if (win.length === 0) return [];
  return win.map(h => {
    const label = _relativeTimeLabel(h.ts || 0);
    let content = h.role === 'assistant'
      ? h.text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\[VOICE\]/g, '').trim().slice(0, 200)
      : h.text.slice(0, 300);
    if (!content) return null;
    return { role: h.role, content: `[群聊 - ${label}] ${content}` };
  }).filter(m => m !== null && m.content.length > 0);
}

// ─── 导出 ────────────────────────────────────────────────────────────────────

module.exports = {
  chatHistoryKey,
  shadowHistoryKey,
  appendChatHistory,
  buildHistoryMessages,
  buildGroupContextMessages,
  getMostRecentGroupKey,
  loadChatHistory,
  CHAT_HISTORY_DIR,
  CHAT_HISTORY_STORE,
  CHAT_HISTORY_INJECT,
};
