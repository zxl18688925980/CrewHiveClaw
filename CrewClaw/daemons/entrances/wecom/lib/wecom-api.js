'use strict';
/**
 * wecom-api.js — 企业微信通信层
 *
 * 包含：AES 解密 / XML 工具 / 签名工具 / 企业微信 HTTP API /
 *       Bot 推送（botSend） / 文件发送（sendWeComFile）
 *
 * 工厂函数：module.exports = (logger, deps) => ({ ... })
 * 调用方：
 *   const _wecomApiFactory = require('./lib/wecom-api');
 *   const wa = _wecomApiFactory(logger, {
 *     AES_KEY, WECOM_CORP_ID, WECOM_AGENT_ID, WECOM_SECRET,
 *     getBotClient, getBotReady,
 *   });
 */

const fs      = require('fs');
const path    = require('path');
const crypto  = require('crypto');
const axios   = require('axios');

module.exports = function createWecomApi(logger, deps) {
  const {
    AES_KEY, WECOM_CORP_ID, WECOM_AGENT_ID, WECOM_SECRET,
    getBotClient, getBotReady,
  } = deps;

// ─── AES 解密 ───────────────────────────────────────────────────────────────

/**
 * 解密企业微信 AES 消息
 * 格式：random(16) + msgLen(4 bytes, big-endian) + msgContent + appId
 */
function aesDecrypt(encrypted) {
  if (!AES_KEY) throw new Error('WECOM_ENCODING_AES_KEY 未配置');

  const iv       = AES_KEY.slice(0, 16);
  const decipher = crypto.createDecipheriv('aes-256-cbc', AES_KEY, iv);
  decipher.setAutoPadding(false);

  const buf      = Buffer.from(encrypted, 'base64');
  const raw      = Buffer.concat([decipher.update(buf), decipher.final()]);

  // 去除 PKCS7 填充
  const padLen   = raw[raw.length - 1];
  const unpadded = raw.slice(0, raw.length - padLen);

  // 跳过随机 16 字节，读取消息长度
  const msgLen   = unpadded.readUInt32BE(16);
  const content  = unpadded.slice(20, 20 + msgLen).toString('utf8');
  const appId    = unpadded.slice(20 + msgLen).toString('utf8');

  return { content, appId };
}

// ─── XML 工具 ────────────────────────────────────────────────────────────────

function extractXmlField(xml, field) {
  if (!xml || typeof xml !== 'string') return null;
  const re = new RegExp(`<${field}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${field}>`);
  const m  = xml.match(re) || xml.match(new RegExp(`<${field}>([^<]*)<\\/${field}>`));
  return m ? m[1] : null;
}

// ─── 签名工具 ────────────────────────────────────────────────────────────────

function sha1Sort(parts) {
  return crypto.createHash('sha1').update(parts.sort().join('')).digest('hex');
}

// ─── 企业微信 API ────────────────────────────────────────────────────────────

async function getAccessToken() {
  if (accessTokenCache.token && Date.now() < accessTokenCache.expiresAt) {
    return accessTokenCache.token;
  }
  const resp = await axios.get('https://qyapi.weixin.qq.com/cgi-bin/gettoken', {
    params: { corpid: WECOM_CORP_ID, corpsecret: WECOM_SECRET }
  });
  if (resp.data.errcode !== 0) {
    throw new Error(`WeCom gettoken error: ${resp.data.errmsg}`);
  }
  accessTokenCache = {
    token:     resp.data.access_token,
    expiresAt: Date.now() + (resp.data.expires_in - 60) * 1000
  };
  return accessTokenCache.token;
}

async function sendWeComGroupMessage(chatId, text) {
  const token = await getAccessToken();
  const resp  = await axios.post(
    `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${token}`,
    {
      chatid:  chatId,
      msgtype: 'text',
      text:    { content: text }
    }
  );
  if (resp.data.errcode !== 0) {
    throw new Error(`WeCom group send error: ${resp.data.errmsg}`);
  }
  logger.info('WeCom group reply sent', { chatId, length: text.length });
}

async function sendWeComGroupFile(chatId, absPath) {
  const FormData = require('form-data');
  const token = await getAccessToken();

  // 上传文件
  const form = new FormData();
  form.append('media', require('fs').createReadStream(absPath), { filename: require('path').basename(absPath) });
  const uploadResp = await axios.post(
    `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=file`,
    form,
    { headers: form.getHeaders() }
  );
  if (uploadResp.data.errcode !== 0) {
    throw new Error(`WeCom media upload error: ${uploadResp.data.errmsg}`);
  }
  const mediaId = uploadResp.data.media_id;

  // 发到群
  const sendResp = await axios.post(
    `https://qyapi.weixin.qq.com/cgi-bin/appchat/send?access_token=${token}`,
    {
      chatid:  chatId,
      msgtype: 'file',
      file:    { media_id: mediaId }
    }
  );
  if (sendResp.data.errcode !== 0) {
    throw new Error(`WeCom group file send error: ${sendResp.data.errmsg}`);
  }
  logger.info('WeCom group file sent', { chatId, file: require('path').basename(absPath) });
}

async function sendWeComMessage(toUser, text) {
  const token = await getAccessToken();
  const resp  = await axios.post(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
    {
      touser:  toUser,
      msgtype: 'text',
      agentid: WECOM_AGENT_ID,
      text:    { content: text }
    }
  );
  if (resp.data.errcode !== 0) {
    throw new Error(`WeCom send error: ${resp.data.errmsg}`);
  }
  logger.info('WeCom reply sent', { toUser, length: text.length });
}

/**
 * 通过 bot 通道推送消息到 target（群 chatId 或私聊 userId）。
 * 只走 bot，失败直接抛出——调用方决定如何处理错误，不在此降级污染信息。
 */
async function botSend(target, text) {
  if (!globalBotClient || !globalBotReady) {
    throw new Error(`bot 未就绪（globalBotReady=${globalBotReady}）`);
  }
  await globalBotClient.sendMessage(target, { msgtype: 'markdown', markdown: { content: text } });
}

async function sendWeComFile(toUser, absPath) {
  const FormData = require('form-data');
  const token = await getAccessToken();

  // 上传文件，获取 media_id
  const form = new FormData();
  form.append('media', fs.createReadStream(absPath), { filename: path.basename(absPath) });
  const uploadResp = await axios.post(
    `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=file`,
    form,
    { headers: form.getHeaders() }
  );
  if (uploadResp.data.errcode !== 0) {
    throw new Error(`WeCom media upload error: ${uploadResp.data.errmsg}`);
  }
  const mediaId = uploadResp.data.media_id;

  // 发送文件消息
  const sendResp = await axios.post(
    `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`,
    {
      touser:  toUser,
      msgtype: 'file',
      agentid: WECOM_AGENT_ID,
      file:    { media_id: mediaId }
    }
  );
  if (sendResp.data.errcode !== 0) {
    throw new Error(`WeCom file send error: ${sendResp.data.errmsg}`);
  }
  logger.info('WeCom file sent', { toUser, file: path.basename(absPath) });
}


  return {
    aesDecrypt,
    extractXmlField,
    sha1Sort,
    getAccessToken,
    sendWeComGroupMessage,
    sendWeComGroupFile,
    sendWeComMessage,
    botSend,
    sendWeComFile,
  };
};
