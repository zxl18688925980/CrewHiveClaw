'use strict';
/**
 * group-registry.js — 群组注册表
 *
 * 管理 bot 发现的所有群，持久化到 data/groups.json。
 * 首次发现新群时记录；首次启动时向默认群发送帮助消息。
 *
 * 工厂函数：module.exports = (logger, { HOMEAI_ROOT }) => ({ ... })
 */

const fs   = require('fs');
const path = require('path');

module.exports = function createGroupRegistry(logger, { HOMEAI_ROOT }) {
  const GROUPS_FILE = path.join(HOMEAI_ROOT, 'data', 'groups.json');

  // 内存缓存
  let groups = null;

  function loadGroups() {
    if (groups) return groups;
    try {
      const raw = fs.readFileSync(GROUPS_FILE, 'utf8');
      groups = JSON.parse(raw);
      if (!Array.isArray(groups)) groups = [];
    } catch {
      groups = [];
    }
    return groups;
  }

  function saveGroups() {
    const dir = path.dirname(GROUPS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(GROUPS_FILE, JSON.stringify(loadGroups(), null, 2), 'utf8');
  }

  /**
   * 注册/更新群信息。
   * 已存在 → 更新 lastActive；不存在 → 新增。
   * @param {string} chatId
   * @param {object} [metadata] - 附加信息（fromUser 等）
   * @returns {boolean} 是否为新群
   */
  function registerGroup(chatId, metadata) {
    const list = loadGroups();
    const existing = list.find(g => g.chatId === chatId);
    if (existing) {
      existing.lastActive = new Date().toISOString();
      if (metadata) Object.assign(existing, metadata);
      saveGroups();
      return false; // 已有群
    }
    const entry = {
      chatId,
      firstSeen:  new Date().toISOString(),
      lastActive: new Date().toISOString(),
      helpSent:   false,
      ...(metadata || {}),
    };
    list.push(entry);
    saveGroups();
    logger.info('新群已注册', { chatId });
    return true; // 新群
  }

  function getDefaultGroupChatId() {
    return process.env.WECOM_ORG_GROUP_CHAT_ID || process.env.WECOM_FAMILY_GROUP_CHAT_ID || '';
  }

  function getDefaultGroup() {
    const chatId = getDefaultGroupChatId();
    if (!chatId) return null;
    const list = loadGroups();
    return list.find(g => g.chatId === chatId) || null;
  }

  function setDefaultGroup(chatId) {
    // 内存态更新——让后续 getDefaultGroupChatId 返回新值
    process.env.WECOM_ORG_GROUP_CHAT_ID = chatId;
    logger.info('默认群已设置', { chatId });
  }

  function markHelpSent(chatId) {
    const list = loadGroups();
    const entry = list.find(g => g.chatId === chatId);
    if (entry && !entry.helpSent) {
      entry.helpSent = true;
      saveGroups();
      logger.info('群帮助消息已标记发送', { chatId });
    }
  }

  /**
   * 获取群信息（含 name / positioning 等元数据）。
   * 未找到返回 null；新群发现时 name/positioning 为空，调用方需容错。
   */
  function getGroupInfo(chatId) {
    if (!chatId) return null;
    const list = loadGroups();
    return list.find(g => g.chatId === chatId) || null;
  }

  return {
    loadGroups,
    saveGroups,
    registerGroup,
    getGroupInfo,
    getDefaultGroup,
    getDefaultGroupChatId,
    setDefaultGroup,
    markHelpSent,
  };
};
