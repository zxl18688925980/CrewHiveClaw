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
const CHAT_HISTORY_INJECT = 15;                        // 每次注入轮数（≤ STORE）
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

function buildHistoryMessages(key) {
  const history = loadChatHistory(key);
  if (history.length === 0) return [];
  const win = history.slice(-(CHAT_HISTORY_INJECT * 2));
  return win.map(h => ({
    role:    h.role,
    content: h.role === 'assistant'
      ? h.text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/\[VOICE\]/g, '').trim().slice(0, 300)
      : h.text,
  })).filter(m => m.content.length > 0);
}

// ─── 导出 ────────────────────────────────────────────────────────────────────

module.exports = {
  chatHistoryKey,
  shadowHistoryKey,
  appendChatHistory,
  buildHistoryMessages,
  loadChatHistory,
  CHAT_HISTORY_DIR,
  CHAT_HISTORY_STORE,
  CHAT_HISTORY_INJECT,
};
