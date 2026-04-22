/**
 * 企业微信入口
 * 端口: 3003
 *
 * 双通道路由设计：
 *
 *   通道 A：企业自建应用（HTTP callback，端口 3003）
 *     业主单聊   → Main 系统工程师（Claude 驱动，带 10 工具）
 *     非业主单聊 → 拒绝（提示去找启灵）
 *     群消息     → 企业微信平台不推送，此通道永远不会收到，由通道 B 处理
 *
 *   通道 B：智能机器人（WebSocket 长连接，名称「启灵」）
 *     群里 @启灵  → Lucas 家庭管家（replyStream 被动回复，显示「启灵」）
 *     家庭成员私聊机器人 → Lucas 家庭管家（同上）
 *     ※ 群消息只有 @启灵 才能触发，未来可通过 MSGAUDIT（企业版）接收全量群消息
 *
 * 环境变量：
 *   WECOM_CORP_ID          企业ID
 *   WECOM_AGENT_ID         应用 agentid（数字）
 *   WECOM_SECRET           应用 Secret
 *   WECOM_TOKEN            消息校验 Token
 *   WECOM_ENCODING_AES_KEY 消息加解密 Key（43字符，不含末尾 =）
 *   WECOM_BOT_ID           智能机器人 Bot ID
 *   WECOM_BOT_SECRET       智能机器人 Secret
 */

const express        = require('express');
const cors           = require('cors');
const axios          = require('axios');
const crypto         = require('crypto');
const winston        = require('winston');
const path           = require('path');
const fs             = require('fs');
const { execSync }   = require('child_process');
const { WSClient }   = require('@wecom/aibot-node-sdk');
// Anthropic SDK 已移除（Main 改用 MiniMax，不再直接调用 Claude API）
// chromium (playwright) → lib/media.js
const { TaskManager } = require('./task-manager');
require('dotenv').config();
// task-registry 模块（logger 就绪后在下方 initTaskRegistry() 中初始化）
const _taskRegistryFactory = require('./lib/task-registry');
let _tr;  // 由 initTaskRegistry() 填充
const _mediaFactory = require('./lib/media');
let _media;  // 由 initMedia() 填充
const _mainToolsFactory = require('./lib/main-tools');
let _mt2;  // 由 initMainTools() 填充
const _loopsFactory = require('./lib/loops');
let _loops;  // 由 initLoops() 填充
const _wecomApiFactory = require('./lib/wecom-api');
let _wa;  // 由 initWecomApi() 填充
const _agentClientFactory = require('./lib/agent-client');
let _ac;  // 由 initAgentClient() 填充
const _evalDashboardFactory = require('./lib/eval-dashboard');
const _msgUtilsFactory = require('./lib/msg-utils');
const _demoRoutesFactory = require('./lib/demo-routes');
const _seDashboardFactory = require('./lib/se-dashboard');
const _lucasRoutesFactory = require('./lib/lucas-routes');
const _botConnectionFactory = require('./lib/bot-connection');
let _mu;  // 由 initMsgUtils() 填充

// ── 时区统一：所有时间戳使用 CST（UTC+8）──
const nowCST   = () => new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00');
const todayCST = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

// task-registry 函数占位符（由 initTaskRegistry() 在 logger 就绪后填充）
let readTaskRegistry, writeTaskRegistry, inferTaskAgent;
let readTaskRegistryRaw, markTaskLucasAcked;
let readL4Tasks, readL4Control, writeL4Control;

// media 函数/常量占位符（由 initMedia() 在 logger 就绪后填充）
let parseDouyinShareText, scrapeVideoContent, scrapeDouyinContent;
let transcribeDouyinAudio, transcribeLocalVideo, analyzeDouyinFrames;
let formatVideoInjection, scrapeWechatArticle, describeImageWithLlava;
let VIDEO_URL_RE, DOUYIN_URL_RE, FRAME_ANALYSIS_RE;

// main-tools 函数占位符（由 initMainTools() 在 sendWeComFile 就绪后填充）
let callMainModel, executeMainTool;
let handleMainCommand, saveTechDocToObsidian, SAVE_DOC_RE, SAVE_TECH_RE, MAIN_SYSTEM_PROMPT;

// loops 函数占位符（由 initLoops() 填充）
let runLucasProactiveLoop, runMainMonitorLoop, runMainWeeklyEvaluation, runAndyHeartbeatLoop;

// wecom-api 函数占位符（由 initWecomApi() 填充）
let aesDecrypt, extractXmlField, sha1Sort, getAccessToken;
let sendWeComGroupMessage, sendWeComGroupFile, sendWeComMessage, botSend, sendWeComFile;

// 超长消息按换行切段（企业微信单条上限 2000 字）— 供 loops 等模块使用
async function sendLongWeComMessage(userId, text) {
  const MAX = 2000;
  if (text.length <= MAX) { await sendWeComMessage(userId, text); return; }
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

// agent-client 函数占位符（由 initAgentClient() 填充）
let callGatewayAgent;
let readAgentModelConfig, callAgentModel, callClaudeFallback;

// msg-utils 函数/对象占位符（由 initMsgUtils() 填充）
let stripMarkdownForWecom, stripMarkdownForVoice, stripInternalTerms, splitTtsChunks;
let sendVoiceChunks, isDuplicateMsg, messageAggregator;
let enqueueUserRequest, transcriptionBuffer, checkReplyRepetition;

// demo-routes 导出的工具函数（由 initDemoRoutes() 填充）
let loadInvites, resolveInviteCode, isInviteValid;

// 群消息发送限流（bot throttle，shared with lib/bot-connection.js）
const groupBotLastSend = new Map(); // chatId -> timestamp
const GROUP_BOT_MIN_INTERVAL_MS = 5000;

let startBotLongConnection;  // 由 initBotConnection() 填充

// ─── 全局路径常量（必须在任何函数定义之前）────────────────────────────────────
const INSTANCE_ROOT     = process.env.INSTANCE_ROOT || path.join(__dirname, '../../../../..');
// WHISPER_MODEL / COOKIES_FILE → lib/media.js
// L4_TASKS_FILE / L4_CONTROL_FILE → lib/task-registry.js

// readL4Tasks / readL4Control / writeL4Control → lib/task-registry.js

// SE 远程 L4 控制命令正则
const L4_QUERY_RE  = /^查\s*l4$/i;
const L4_STOP_RE   = /^叫停\s+(l4-\d+)/i;
const L4_PAUSE_RE  = /^暂停\s*l4$/i;
const L4_RESUME_RE = /^恢复\s*l4$/i;

// VIDEO_URL_RE / DOUYIN_URL_RE → lib/media.js

// parseDouyinShareText / scrapeVideoContent → lib/media.js

// scrapeDouyinContent…describeImageWithLlava → lib/media.js

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: () => nowCST() }),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({
      filename: path.join(__dirname, '../../../logs/wecom-entrance.log')
    }),
    new winston.transports.Console()
  ]
});

const app  = express();
const PORT = process.env.WECOM_PORT || 3003;

const WECOM_CORP_ID          = process.env.WECOM_CORP_ID          || '';
const WECOM_AGENT_ID         = parseInt(process.env.WECOM_AGENT_ID  || '0', 10);
const WECOM_SECRET           = process.env.WECOM_SECRET           || '';
const WECOM_TOKEN            = process.env.WECOM_TOKEN            || '';
const WECOM_ENCODING_AES_KEY = process.env.WECOM_ENCODING_AES_KEY || '';
const WECOM_OWNER_ID         = process.env.WECOM_OWNER_ID         || '';
const WECOM_BOT_ID           = process.env.WECOM_BOT_ID           || '';
const WECOM_BOT_SECRET       = process.env.WECOM_BOT_SECRET       || '';

// OpenClaw Gateway：所有 agent 请求经此路由，crewclaw-routing 插件处理三层路由
// 初始化 task-registry 模块（logger 就绪后）
// _tr 暴露所有 task-registry 函数，同时解构为顶层变量保持向后兼容
function initTaskRegistry() {
  _tr = _taskRegistryFactory(logger);
  ({ readTaskRegistry, writeTaskRegistry, inferTaskAgent,
     readTaskRegistryRaw, markTaskLucasAcked,
     readL4Tasks, readL4Control, writeL4Control } = _tr);
}
function initMedia() {
  _media = _mediaFactory(logger);
  ({ parseDouyinShareText, scrapeVideoContent, scrapeDouyinContent,
     transcribeDouyinAudio, transcribeLocalVideo, analyzeDouyinFrames,
     formatVideoInjection, scrapeWechatArticle, describeImageWithLlava,
     VIDEO_URL_RE, DOUYIN_URL_RE, FRAME_ANALYSIS_RE } = _media);
}
function initMainTools() {
  _mt2 = _mainToolsFactory(logger, {
    readAgentModelConfig,
    callAgentModel,
    nowCST,
    sendWeComFile,
    INSTANCE_ROOT,
    VIDEO_URL_RE, DOUYIN_URL_RE, FRAME_ANALYSIS_RE,
  });
  ({ callMainModel, executeMainTool, handleMainCommand, saveTechDocToObsidian, SAVE_DOC_RE, SAVE_TECH_RE, MAIN_SYSTEM_PROMPT } = _mt2);
}
function initLoops() {
  _loops = _loopsFactory(logger, {
    callGatewayAgent, callMainModel, executeMainTool,
    sendWeComMessage, sendLongWeComMessage,
    nowCST, INSTANCE_ROOT, PORT, WECOM_OWNER_ID,
    getOrgMembers: () => orgMembers,
    MAIN_SYSTEM_PROMPT,
    readTaskRegistryRaw,
    markTaskLucasAcked,
  });
  ({ runLucasProactiveLoop, runMainMonitorLoop, runMainWeeklyEvaluation, runAndyHeartbeatLoop } = _loops);
}
function initWecomApi() {
  _wa = _wecomApiFactory(logger, {
    AES_KEY,
    WECOM_CORP_ID,
    WECOM_AGENT_ID,
    WECOM_SECRET,
    getBotClient: () => globalBotClient,
    getBotReady:  () => globalBotReady,
  });
  ({ aesDecrypt, extractXmlField, sha1Sort, getAccessToken,
     sendWeComGroupMessage, sendWeComGroupFile, sendWeComMessage,
     botSend, sendWeComFile } = _wa);
}
function initAgentClient() {
  _ac = _agentClientFactory(logger, { GATEWAY_URL, GATEWAY_TOKEN });
  ({ callGatewayAgent, readAgentModelConfig, callAgentModel, callClaudeFallback } = _ac);
}
function initMsgUtils() {
  _mu = _msgUtilsFactory(logger, {
    getBotClient: () => globalBotClient,
    getBotReady:  () => globalBotReady,
  });
  ({ stripMarkdownForWecom, stripMarkdownForVoice, stripInternalTerms, splitTtsChunks,
     sendVoiceChunks, isDuplicateMsg, messageAggregator,
     enqueueUserRequest, transcriptionBuffer, checkReplyRepetition } = _mu);
}
function initDemoRoutes() {
  const result = _demoRoutesFactory(logger, { INSTANCE_ROOT, GATEWAY_URL, APP_GENERATED_DIR });
  app.use(result.router);
  ({ loadInvites, resolveInviteCode, isInviteValid } = result);
}
function initSEDashboard() {
  app.use(_seDashboardFactory(logger, { WECOM_OWNER_ID, INSTANCE_ROOT, readTaskRegistry, writeTaskRegistry, loadInvites }));
}
function initLucasRoutes() {
  app.use(_lucasRoutesFactory(logger, {
    INSTANCE_ROOT, PORT, WECOM_OWNER_ID,
    getBotClient: () => globalBotClient,
    getBotReady:  () => globalBotReady,
    botSend, sendWeComGroupFile, sendWeComMessage,
    sendVoiceChunks, stripMarkdownForWecom,
    appendChatHistory, chatHistoryKey, buildHistoryMessages,
    callGatewayAgent, executeMainTool, runMainMonitorLoop,
    runLucasProactiveLoop, runAndyHeartbeatLoop,
    loadInvites, isInviteValid, visitorPendingMessages,
  }));
}
function initBotConnection() {
  startBotLongConnection = _botConnectionFactory(logger, {
    WECOM_BOT_ID, WECOM_BOT_SECRET, INSTANCE_ROOT, PORT, WECOM_OWNER_ID,
    setGlobalBotReady: (v) => { globalBotReady = v; },
    setGlobalBotClient: (v) => { globalBotClient = v; },
    getBotClient: () => globalBotClient,
    getBotReady:  () => globalBotReady,
    getOrgMembers: () => orgMembers,
    getTaskManager:   () => taskManager,
    getDemoGroupConfig: () => demoGroupConfig,
    isDemoGroup,
    groupBotLastSend, GROUP_BOT_MIN_INTERVAL_MS,
    _gatewayDownNotifiedAt_ref, GATEWAY_DOWN_NOTIFY_INTERVAL_MS,
    callGatewayAgent, callAgentModel, callClaudeFallback,
    botSend, sendWeComMessage, sendWeComGroupMessage, getAccessToken,
    sendVoiceChunks, splitTtsChunks, isDuplicateMsg, enqueueUserRequest,
    transcriptionBuffer, checkReplyRepetition, messageAggregator,
    stripMarkdownForWecom, stripMarkdownForVoice, stripInternalTerms,
    appendChatHistory, chatHistoryKey, buildHistoryWithCrossChannel,
    executeMainTool, handleMainCommand,
    parseDouyinShareText, scrapeVideoContent, scrapeDouyinContent,
    transcribeDouyinAudio, transcribeLocalVideo, analyzeDouyinFrames,
    formatVideoInjection, scrapeWechatArticle, describeImageWithLlava,
    VIDEO_URL_RE, DOUYIN_URL_RE, FRAME_ANALYSIS_RE,
    runMainMonitorLoop,
  });
}

const GATEWAY_URL   = process.env.GATEWAY_URL   || 'http://localhost:18789';
const GATEWAY_TOKEN = (() => {
  if (process.env.OPENCLAW_GATEWAY_TOKEN) return process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const cfg = JSON.parse(fs.readFileSync(
      path.join(process.env.HOME || '', '.openclaw', 'openclaw.json'), 'utf8'
    ));
    return cfg?.gateway?.auth?.token || '';
  } catch { return ''; }
})();

// Andy 后端服务（crewclaw-routing 插件的 trigger_development_pipeline 工具使用）
// 注：Lucas 已迁移为 OpenClaw 嵌入式 agent，不再直连

// 加载家庭成员信息
// 组织成员配置：ORG_MEMBERS_CONFIG env var 指定路径（不设则回退 .homeai/family-info.json 兼容 HomeAI）
let orgMembers = {};
try {
  const membersConfigPath = process.env.ORG_MEMBERS_CONFIG
    || require('path').join(process.env.HOME, '.homeai', 'family-info.json');
  const membersInfo = JSON.parse(require('fs').readFileSync(membersConfigPath, 'utf8'));
  orgMembers = membersInfo.wecomMembers || membersInfo.members || {};
} catch (e) {
  // 加载失败不影响运行
}

// 演示群配置（独立于家庭配置，按 chatId 路由到通用 AI 人格）
let demoGroupConfig = { chatIds: [], systemPrompt: '', maxTokens: 512 };
initTaskRegistry();
initMedia();

function loadDemoGroupConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(
      process.env.DEMO_GROUP_CONFIG || path.join(process.env.HOME || '', '.homeai', 'demo-group-config.json'), 'utf8'
    ));
    demoGroupConfig = {
      chatIds: Array.isArray(cfg.chatIds) ? cfg.chatIds : [],
      systemPrompt: cfg.systemPrompt || '',
      maxTokens: cfg.maxTokens || 512,
    };
    logger.info('演示群配置已加载', { chatIds: demoGroupConfig.chatIds });
  } catch (e) {
    // 配置文件不存在或解析失败不影响运行（功能降级：无演示群）
  }
}
loadDemoGroupConfig();

function isDemoGroup(chatId) {
  return demoGroupConfig.chatIds.length > 0 && demoGroupConfig.chatIds.includes(chatId);
}

// AES-256 key（32 bytes），由 43 字符 Base64 + "=" 补位解码
const AES_KEY = WECOM_ENCODING_AES_KEY
  ? Buffer.from(WECOM_ENCODING_AES_KEY + '=', 'base64')
  : null;

// access_token 缓存
// ─── 近期对话持久化（chatHistory）────────────────────────────────────────────
//
// 解决问题：每条消息是独立 session，Lucas 对上下文一无所知。
//
// 存储层、注入层逻辑统一在 ../chat-history.js，wecom 只传渠道标识 'wecom'。
// 影子 Agent 上线时使用 shadowHistoryKey() 获得独立命名空间，其余逻辑完全复用。

const {
  chatHistoryKey: _chatHistoryKey,
  shadowHistoryKey,
  appendChatHistory,
  buildHistoryMessages,
  buildGroupContextMessages,
  getMostRecentGroupKey,
  loadChatHistory,
} = require('../chat-history');

/**
 * 构建历史消息，私聊时自动前置最近群聊记录，恢复 Lucas 跨渠道在场感。
 * 群聊对话保持原样，不注入私聊内容（单向注入，避免循环）。
 */
function buildHistoryWithCrossChannel(isGroup, histKey) {
  const privateMsgs = buildHistoryMessages(histKey);
  if (isGroup) return privateMsgs;
  const groupKey = getMostRecentGroupKey('wecom');
  const groupMsgs = groupKey ? buildGroupContextMessages(groupKey, 4) : [];
  return [...groupMsgs, ...privateMsgs];
}

// wecom 渠道包装：透传 isGroup/chatId/fromUser，固定 channel='wecom'
function chatHistoryKey(isGroup, chatId, fromUser) {
  return _chatHistoryKey('wecom', isGroup, chatId, fromUser);
}

// callGatewayAgent → lib/agent-client.js


app.use(cors());
// JSON 优先，企业微信回调的 XML 用 text 解析（不能用 '*/*' 否则会吞掉 JSON）
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: ['text/xml', 'application/xml', 'text/plain'] }));
app.use(_evalDashboardFactory(logger, { INSTANCE_ROOT }));

// ─── 健康检查 ────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'wecom-entrance',
    port: PORT,
    configured: {
      corpId:  !!WECOM_CORP_ID,
      agentId: !!WECOM_AGENT_ID,
      secret:  !!WECOM_SECRET,
      token:   !!WECOM_TOKEN,
      aesKey:  !!WECOM_ENCODING_AES_KEY
    }
  });
});

// /api/eval/history + /eval-dashboard → lib/eval-dashboard.js

// ─── 回调 URL 验证（GET）────────────────────────────────────────────────────
// 企业微信首次保存回调 URL 时发送 GET，需要解密 echostr 后原样返回

app.get('/wecom/callback', (req, res) => {
  const { msg_signature, timestamp, nonce, echostr } = req.query;
  logger.info('WeCom GET verification', { timestamp, nonce });

  try {
    // 签名校验：SHA1(sort([token, timestamp, nonce, echostr]).join(''))
    const sig = sha1Sort([WECOM_TOKEN, timestamp, nonce, echostr]);
    if (sig !== msg_signature) {
      logger.warn('WeCom GET signature mismatch', { expected: sig, received: msg_signature });
      return res.status(403).send('Invalid signature');
    }

    // 解密 echostr，返回其中的 content
    const { content } = aesDecrypt(echostr);
    logger.info('WeCom verification passed');
    res.send(content);
  } catch (e) {
    logger.error('WeCom GET verification error', { error: e.message });
    res.status(500).send('Verification failed');
  }
});

// ─── 接收消息（POST）────────────────────────────────────────────────────────

app.post('/wecom/callback', async (req, res) => {
  const { msg_signature, timestamp, nonce } = req.query;
  const rawBody = req.body;

  logger.info('WeCom POST message received');

  // 先立即返回空串，避免超时（企业微信要求 5s 内响应）
  res.send('');

  try {
    const encrypt = extractXmlField(rawBody, 'Encrypt');
    if (!encrypt) {
      logger.warn('No Encrypt field in WeCom message');
      return;
    }

    // 签名校验
    const sig = sha1Sort([WECOM_TOKEN, timestamp, nonce, encrypt]);
    if (sig !== msg_signature) {
      logger.warn('WeCom POST signature mismatch');
      return;
    }

    // 解密
    const { content: innerXml } = aesDecrypt(encrypt);

    // 提取消息字段
    const msgType  = extractXmlField(innerXml, 'MsgType');
    const fromUser = extractXmlField(innerXml, 'FromUserName');
    const chatId   = extractXmlField(innerXml, 'ChatId');  // 群消息才有
    const isGroup  = !!chatId;
    let content    = msgType === 'text' ? extractXmlField(innerXml, 'Content') : null;

    // Main 通道图片处理：下载图片并转 base64，供 Claude 原生视觉 API 使用
    let mainImageBase64        = null;
    let mainImageMime          = null;
    let mainImageRelativePath  = null;

    logger.info('WeCom message parsed', { fromUser, msgType, isGroup, chatId, content: content?.substring(0, 60) });

    if (!content) {
      const isOwnerMsg = WECOM_OWNER_ID && fromUser === WECOM_OWNER_ID;
      if (msgType === 'image' && isOwnerMsg && !isGroup) {
        // Main 通道图片：下载 + 落盘 + 本地 mlx-vision 描述（省 Claude 视觉 token）
        const picUrl = extractXmlField(innerXml, 'PicUrl');
        if (picUrl) {
          try {
            logger.info('Main 收到图片，下载中', { picUrl: picUrl.substring(0, 80) });
            const imgResp = await axios.get(picUrl, { responseType: 'arraybuffer', timeout: 15000 });
            const imgBuffer = Buffer.from(imgResp.data);
            const ct = imgResp.headers['content-type'] || '';
            mainImageMime = ct.includes('png') ? 'image/png' : 'image/jpeg';
            // 落盘
            const dateStr   = todayCST();
            const uploadDir = path.join(INSTANCE_ROOT, 'Data', 'uploads', dateStr, 'images');
            fs.mkdirSync(uploadDir, { recursive: true });
            const imgExt      = mainImageMime === 'image/png' ? '.png' : '.jpg';
            const imgFilename = `main-${Date.now()}${imgExt}`;
            const imgSavePath = path.join(uploadDir, imgFilename);
            fs.writeFileSync(imgSavePath, imgBuffer);
            mainImageRelativePath = path.relative(INSTANCE_ROOT, imgSavePath);
            // 本地视觉描述（mlx-vision 主，GLM 降级），不传 base64 给 Claude
            const imgDesc = await describeImageWithLlava(imgSavePath);
            if (imgDesc) {
              try { fs.writeFileSync(imgSavePath + '.desc.txt', imgDesc, 'utf8'); } catch {}
              content = `【图片内容（AI识别）】\n${imgDesc}\n\n文件路径（仅供 send_file 工具使用）：${mainImageRelativePath}`;
              logger.info('Main 图片本地描述成功', { path: mainImageRelativePath });
            } else {
              content = `[图片] ${imgFilename}（本地识别失败）\n\n文件路径（仅供 send_file 工具使用）：${mainImageRelativePath}`;
              logger.warn('Main 图片本地描述失败', { path: mainImageRelativePath });
            }
            // 不再传 base64，Claude 收到的是纯文本描述
            mainImageBase64 = null;
            logger.info('Main 图片处理完成', { mime: mainImageMime, path: mainImageRelativePath });
          } catch (e) {
            logger.warn('Main 图片下载/落盘失败', { error: e.message });
            content = '[图片（下载失败，无法分析）]';
          }
        } else {
          content = '[图片（无 PicUrl，无法下载）]';
        }

      } else if (msgType === 'video' && isOwnerMsg && !isGroup) {
        // Main 通道视频：通过 MediaId 下载 + 落盘 + Whisper 转录
        const mediaId = extractXmlField(innerXml, 'MediaId');
        if (mediaId) {
          try {
            logger.info('Main 收到视频，下载中', { mediaId });
            const token = await getAccessToken();
            const vidResp = await axios.get(
              `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${token}&media_id=${mediaId}`,
              { responseType: 'arraybuffer', timeout: 60000 }
            );
            const vidBuffer = Buffer.from(vidResp.data);
            const dateStr   = todayCST();
            const uploadDir = path.join(INSTANCE_ROOT, 'Data', 'uploads', dateStr, 'videos');
            fs.mkdirSync(uploadDir, { recursive: true });
            const vidFilename = `main-${Date.now()}.mp4`;
            const vidSavePath = path.join(uploadDir, vidFilename);
            fs.writeFileSync(vidSavePath, vidBuffer);
            const vidRelPath  = path.relative(INSTANCE_ROOT, vidSavePath);
            logger.info('Main 视频落盘成功', { path: vidRelPath, bytes: vidBuffer.length });
            // Whisper 转录（同步等待，完成后再传给 Claude）
            const transcript = await transcribeLocalVideo(vidSavePath);
            if (transcript) {
              try { fs.writeFileSync(vidSavePath + '.transcript.txt', transcript, 'utf8'); } catch {}
              content = `[视频] ${vidFilename}\n\n【视频语音转录】\n${transcript}\n\n文件路径（仅供 send_file 使用）：${vidRelPath}`;
            } else {
              content = `[视频] ${vidFilename}（语音转录失败或无语音）\n\n文件路径（仅供 send_file 使用）：${vidRelPath}`;
            }
            logger.info('Main 视频处理完成', { vidFilename, hasTranscript: !!transcript });
          } catch (e) {
            logger.warn('Main 视频下载/转录失败', { error: e.message });
            content = '[视频（下载失败，无法处理）]';
          }
        } else {
          content = '[视频（无 MediaId，无法下载）]';
        }

      } else if (msgType === 'voice' && isOwnerMsg && !isGroup) {
        // Main 通道语音：MediaId 下载（AMR）→ ffmpeg 转 WAV → Whisper 转录
        const mediaId = extractXmlField(innerXml, 'MediaId');
        if (mediaId) {
          try {
            logger.info('Main 收到语音，下载中', { mediaId });
            const token = await getAccessToken();
            const voiceResp = await axios.get(
              `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${token}&media_id=${mediaId}`,
              { responseType: 'arraybuffer', timeout: 30000 }
            );
            const voiceBuffer = Buffer.from(voiceResp.data);
            const dateStr   = todayCST();
            const uploadDir = path.join(INSTANCE_ROOT, 'Data', 'uploads', dateStr, 'voices');
            fs.mkdirSync(uploadDir, { recursive: true });
            const voiceFilename = `main-${Date.now()}.amr`;
            const voiceSavePath = path.join(uploadDir, voiceFilename);
            fs.writeFileSync(voiceSavePath, voiceBuffer);
            logger.info('Main 语音落盘成功', { path: voiceSavePath, bytes: voiceBuffer.length });
            // Whisper 转录（复用 transcribeLocalVideo，ffmpeg 能直接处理 AMR）
            const transcript = await transcribeLocalVideo(voiceSavePath);
            if (transcript) {
              try { fs.writeFileSync(voiceSavePath + '.transcript.txt', transcript, 'utf8'); } catch {}
              content = `【语音转录】${transcript}`;
              logger.info('Main 语音转录成功', { transcript: transcript.slice(0, 60) });
            } else {
              content = '[语音（转录失败）]';
              logger.warn('Main 语音转录失败');
            }
          } catch (e) {
            logger.warn('Main 语音下载/转录失败', { error: e.message });
            content = '[语音（下载失败）]';
          }
        } else {
          content = '[语音（无 MediaId）]';
        }

      } else {
        logger.info('Non-text WeCom message, skipping', { msgType });
        return;
      }
    }

    // 识别身份
    const member  = orgMembers[fromUser];
    const isOwner = WECOM_OWNER_ID && fromUser === WECOM_OWNER_ID;
    const replyTo = { fromUser, chatId, isGroup };

    let reply;

    if (isOwner && !isGroup) {
      // ── 存档触发检测（优先于 handleMainCommand）
      const trimmed = content.trim();

      // ── SE 远程 L4 控制命令（零 token，直接处理）──────────────────────────
      if (L4_QUERY_RE.test(trimmed)) {
        const tasks = readL4Tasks();
        const running = tasks.filter(t => t.status === 'running');
        const recent  = tasks.filter(t => t.status !== 'running').slice(-5);
        const ctrl    = readL4Control();
        let msg = '【L4 任务看板】\n\n';
        if (running.length === 0) {
          msg += '当前无运行中的 L4 任务\n';
        } else {
          msg += `运行中（${running.length} 个）：\n`;
          running.forEach(t => { msg += `• [${t.id}] ${t.type}\n  ${t.description}\n  可叫停: ${t.can_stop ? '是' : '否'}\n\n`; });
        }
        if (recent.length > 0) {
          const icon = s => s === 'completed' ? '✅' : s === 'stopped' ? '⏹' : '❌';
          msg += `最近完成（${recent.length} 个）：\n`;
          recent.forEach(t => { msg += `${icon(t.status)} [${t.id.slice(-8)}] ${(t.description || '').slice(0, 40)}\n`; });
        }
        if (ctrl.global_pause) msg += `\n⚠️ 全局暂停中\n原因：${ctrl.pause_reason || '未说明'}\n发「恢复 L4」解除`;
        else if (running.length > 0) msg += `\n发「叫停 [ID]」可中止指定任务\n发「暂停 L4」可暂停所有主动改进`;
        reply = msg;
      } else if (L4_STOP_RE.test(trimmed)) {
        const match = L4_STOP_RE.exec(trimmed);
        const taskId = match[1];
        const ctrl = readL4Control();
        if (!ctrl.stop_tasks.includes(taskId)) ctrl.stop_tasks.push(taskId);
        ctrl.pause_reason = `SE 叫停 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
        writeL4Control(ctrl);
        reply = `✅ 已发出叫停信号：${taskId}\nAndy 下次检查 L4 控制信号时将停止执行`;
      } else if (L4_PAUSE_RE.test(trimmed)) {
        const ctrl = readL4Control();
        ctrl.global_pause = true;
        ctrl.pause_reason = `SE 全局暂停 ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`;
        writeL4Control(ctrl);
        reply = '✅ L4 全局暂停已启动\nAndy 下次 HEARTBEAT 开始时将跳过所有主动改进\n\n发「恢复 L4」解除暂停';
      } else if (L4_RESUME_RE.test(trimmed)) {
        const ctrl = readL4Control();
        ctrl.global_pause = false;
        ctrl.stop_tasks = [];
        ctrl.pause_reason = null;
        writeL4Control(ctrl);
        reply = '✅ L4 已恢复运行\n全局暂停解除，叫停列表已清空';
      } else if (SAVE_DOC_RE.test(trimmed) || SAVE_TECH_RE.test(trimmed)) {
        const category = SAVE_DOC_RE.test(trimmed) ? 'claudecode' : 'tech';
        const cached = lastExtractedDoc.get(fromUser);
        if (!cached || Date.now() - cached.ts > 30 * 60 * 1000) {
          // cache 为空：fallthrough 到 handleMainCommand，让 Main Claude 接着处理
          reply = await handleMainCommand(content, fromUser, 'wecom_remote', mainImageBase64, mainImageMime, mainImageRelativePath);
        } else {
          try {
            await sendWeComMessage(fromUser, '正在生成摘要并存档，稍等…');
            const { filepath, summary } = await saveTechDocToObsidian(category, cached);
            const dirLabel = category === 'claudecode' ? 'ClaudeCode外部经验参考' : '设计与技术外部参考';
            reply = `已存档到 Obsidian/${dirLabel}/\n\n📄 ${path.basename(filepath)}\n\n摘要：\n${summary}`;
          } catch (e) {
            logger.warn('存档失败', { error: e.message });
            reply = `存档失败：${e.message}`;
          }
        }
      } else {
        // ── 业主单聊 → Main 系统工程师（Claude 驱动，带工具）
        reply = await handleMainCommand(content, fromUser, 'wecom_remote', mainImageBase64, mainImageMime, mainImageRelativePath);
      }

    } else if (!isGroup) {
      // ── 非业主单聊企业应用 → 无权限
      // 家人应通过「启灵」机器人单聊，企业应用通道仅供系统工程师使用
      logger.info('非业主单聊企业应用，拒绝访问', { fromUser });
      const _botN = process.env.WECOM_BOT_NAME || '启灵';
      reply = `此通道仅供系统工程师使用。如需帮助，请直接私聊${_botN}，或在群里@${_botN}。`;

    } else {
      // ── 群消息（此分支在企业微信平台上不会触发）
      // 企业微信应用 callback 仅接收用户主动给应用发的单聊消息，不接收群消息。
      // 群消息（包括 @启灵）由 aibot WebSocket 通道处理（见下方 startBotLongConnection）。
      // 若未来升级企业版并启用 MSGAUDIT 会话存档，可在此处补充实现。
      logger.warn('企业应用 callback 收到疑似群消息，预期不应发生', { fromUser, chatId });
      return;
    }

    // 回复单聊（加身份前缀，企业应用显示「系统工程师」，需明示发言者）
    await sendWeComMessage(fromUser, `[Main]\n${reply}`);

  } catch (e) {
    logger.error('WeCom POST processing error', { error: e.message });
  }
});

// push-reply / forward → lib/lucas-routes.js

// readAgentModelConfig / callAgentModel / callClaudeFallback → lib/agent-client.js

const _gatewayDownNotifiedAt_ref = { value: 0 };  // shared with lib/bot-connection.js
let _gatewayDownNotifiedAt = 0;  // kept for any remaining local refs
const GATEWAY_DOWN_NOTIFY_INTERVAL_MS = 30 * 60 * 1000; // 每 30 分钟最多推一次

// ─── 家庭 Web 应用入口 ───────────────────────────────────────────────────────
// Andy/Lisa 交付的 Web 应用统一放在 app/generated/，通过 /app/* 访问
// 公网地址：https://wecom.homeai-wecom-zxl.top/app/{应用名}/
// 新应用无需改动 Cloudflare Tunnel，直接可访问
const APP_GENERATED_DIR = path.join(INSTANCE_ROOT, 'app', 'generated');
fs.mkdirSync(APP_GENERATED_DIR, { recursive: true });
app.use('/app', express.static(APP_GENERATED_DIR));

// 访客管理 / Demo Chat / Windows节点 / TTS/STT/Vision → lib/demo-routes.js

const visitorPendingMessages = {};  // 访客消息队列（shared: send-message写 / pending读）

// ─── 工具 API 动态加载 ────────────────────────────────────────────────────────
// 约定：app/generated/{name}/server.js 存在时，自动挂载为 /api/{name}/*
// 工具自包含所有路由和逻辑，Channel 不感知工具内部实现。
// server.js 可选导出 router.setup(ctx) 接收环境注入：
//   ctx.INSTANCE_ROOT — HomeAI 根目录
//   ctx.logger      — 统一 logger
// tool contract: server.js exports a factory function
//   module.exports = function({ express, INSTANCE_ROOT, logger, Anthropic }) -> Router
// Channel 把依赖注入工厂，工具无需自带 node_modules。
function mountGeneratedTools() {
  try {
    const { Anthropic } = require('@anthropic-ai/sdk');
    const entries = fs.readdirSync(APP_GENERATED_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const serverFile = path.join(APP_GENERATED_DIR, entry.name, 'server.js');
      if (!fs.existsSync(serverFile)) continue;
      try {
        const factory = require(serverFile);
        if (typeof factory !== 'function') {
          logger.warn('Tool server.js must export a factory function', { name: entry.name });
          continue;
        }
        const router = factory({ express, INSTANCE_ROOT, logger, Anthropic });
        app.use(`/api/${entry.name}`, router);
        logger.info('Tool API mounted', { name: entry.name, path: `/api/${entry.name}` });
      } catch (e) {
        logger.error('Tool mount failed', { name: entry.name, error: e.message });
      }
    }
  } catch (e) {
    logger.warn('mountGeneratedTools scan failed', { error: e.message });
  }
}
mountGeneratedTools();

// mainHistory / MAIN_SYSTEM_PROMPT / MAIN_TOOLS / executeMainTool / handleMainCommand → lib/main-tools.js

// aesDecrypt / extractXmlField / sha1Sort / getAccessToken
// sendWeComGroupMessage / sendWeComGroupFile / sendWeComMessage / botSend / sendWeComFile → lib/wecom-api.js

initDemoRoutes();
initSEDashboard();
initMsgUtils();
initAgentClient();
initWecomApi();
initMainTools();
initLoops();
initBotConnection();
initLucasRoutes();

// startBotLongConnection → lib/bot-connection.js

// stripMarkdownForWecom / stripMarkdownForVoice / stripInternalTerms
// splitTtsChunks / sendVoiceChunks → lib/msg-utils.js

let globalBotClient = null;   // bot 长连接实例，启动后赋值
let globalBotReady  = false;  // 认证成功后置 true

// MessageAggregator / enqueueUserRequest / transcriptionBuffer → lib/msg-utils.js

// ─── 长流程任务管理器 ─────────────────────────────────────────────────────────
const taskManager = new TaskManager({
  instanceRoot:         INSTANCE_ROOT,
  logger,
  callGatewayAgent,
  appendChatHistory,
  transcribeLocalVideo,
  describeImageWithLlava,
  getOrgMembers:     () => orgMembers,
  getBotClient:         () => globalBotClient,
});
// jaccardSimilarity / checkReplyRepetition → lib/msg-utils.js

// waitBotReady / send-to-group / send-file / send-voice /
// notify-engineer / exec-main-tool / trigger-monitor /
// demo-proxy/pending / visitor-tasks → lib/lucas-routes.js

// verifySEToken / pipeline-tasks / submit-requirement → lib/se-dashboard.js


const ORG_GROUP_CHAT_ID = process.env.WECOM_ORG_GROUP_CHAT_ID || process.env.WECOM_FAMILY_GROUP_CHAT_ID || '';

app.post('/api/wecom/send-message', async (req, res) => {
  const { userId, text, voiceText } = req.body || {};
  if (!userId || !text) {
    return res.status(400).json({ success: false, error: 'userId and text are required' });
  }
  // visitor:姓名 → 推送到访客待消息队列，前端轮询取走
  if (userId.startsWith('visitor:')) {
    const visitorName = userId.slice('visitor:'.length).trim();
    const invites = loadInvites();
    const entry = Object.entries(invites).find(([, v]) => v.name === visitorName);
    if (!entry) return res.status(404).json({ success: false, error: `未找到访客：${visitorName}` });
    const token = entry[0].toLowerCase();
    if (!visitorPendingMessages[token]) visitorPendingMessages[token] = [];
    visitorPendingMessages[token].push({ id: Date.now(), text: stripMarkdownForWecom(text), ts: nowCST() });
    logger.info('访客消息已推送到队列', { visitorName, token });
    return res.json({ success: true, userId, channel: 'visitor-push' });
  }

  // 群消息：userId === 'group' → 解析为家庭群 chatId，走 bot 群发
  const isGroupSend = userId === 'group';
  const resolvedTarget = isGroupSend ? ORG_GROUP_CHAT_ID : userId;

  // 非法 userId 过滤：系统会话 / UUID / 测试用户 → 静默跳过，不发企微
  // 注意：'group' 已在上方处理，不再跳过
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!isGroupSend && (userId.startsWith('system') || userId === 'unknown' || userId === 'test' ||
      userId === 'owner' || userId === 'heartbeat-cron' ||
      UUID_RE.test(userId))) {
    logger.info('send-message: 跳过非法 userId', { userId, textLen: text.length });
    return res.json({ success: true, skipped: true, reason: 'non-human-user' });
  }

  // [VOICE]/[RAP] 自动检测：Lucas 工具发消息时正文含标记，自动触发语音
  const hasVoiceTag = text.includes('[VOICE]');
  const hasRapTag   = text.includes('[RAP]');
  const needVoice   = hasVoiceTag || hasRapTag;
  const wecomSafe   = stripMarkdownForWecom(text);
  const displayText = needVoice ? stripMarkdownForVoice(wecomSafe) : wecomSafe;
  const ttsStyle    = hasRapTag ? 'rap' : 'normal';

  try {
    await botSend(resolvedTarget, displayText);
    if (isGroupSend) {
      appendChatHistory(chatHistoryKey(true, ORG_GROUP_CHAT_ID, null), `[${process.env.WECOM_BOT_NAME || '启灵'}主动发送]`, displayText);
      logger.info('群消息已发送', { chatId: ORG_GROUP_CHAT_ID, channel: 'bot', actor: 'lucas' });
    } else {
      appendChatHistory(chatHistoryKey(false, null, userId), `[${process.env.WECOM_BOT_NAME || '启灵'}主动发送]`, displayText);
      logger.info('主动发消息已发送', { userId, channel: 'bot', actor: 'lucas' });
    }
    // 语音：显式 voiceText 或 [VOICE]/[RAP] 标记，fire-and-forget
    const voiceTarget = isGroupSend ? ORG_GROUP_CHAT_ID : userId;
    if (voiceText) {
      sendVoiceChunks(voiceTarget, voiceText).catch(() => {});
    } else if (needVoice) {
      sendVoiceChunks(voiceTarget, displayText, ttsStyle).catch(() => {});
    }
    res.json({ success: true, userId: resolvedTarget });
  } catch (botErr) {
    const errMsg = botErr instanceof Error ? botErr.message : (botErr?.errmsg || JSON.stringify(botErr));
    const dest = isGroupSend ? `家庭群(${ORG_GROUP_CHAT_ID})` : userId;
    logger.error('主动发消息失败，通知系统工程师', { dest, error: errMsg });
    fetch(`http://localhost:${PORT}/api/wecom/notify-engineer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'intervention', fromAgent: 'lucas', message: `⚠️ ${isGroupSend ? '群聊' : '私聊'}消息未送达。\n目标：${dest}\n异常：${errMsg}\n原消息：${displayText.slice(0, 300)}` }),
    }).catch(() => {});
    res.status(500).json({ success: false, error: errMsg });
  }
});

// runLucasProactiveLoop / runMainMonitorLoop / runMainWeeklyEvaluation / runAndyHeartbeatLoop → lib/loops.js

// ─── 启动 ────────────────────────────────────────────────────────────────────

// 全局异常兜底：防止 unhandledRejection / uncaughtException 导致进程 crash → PM2 重启
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection（已拦截，不 crash）', { error: reason instanceof Error ? reason.message : String(reason), stack: reason?.stack });
});
process.on('uncaughtException', (err) => {
  logger.error('uncaughtException（已拦截，不 crash）', { error: err.message, stack: err.stack });
});

app.listen(PORT, () => {
  logger.info('企业微信入口已启动', { port: PORT });
  console.log(`企业微信入口运行在 http://localhost:${PORT}`);
  console.log(`健康检查: http://localhost:${PORT}/api/health`);
  console.log(`测试接口: POST http://localhost:${PORT}/api/wecom/forward`);
  console.log(`回调地址: GET/POST http://localhost:${PORT}/wecom/callback`);

  // 启动智能机器人长连接（通道 B）
  globalBotClient = startBotLongConnection();

  // 启动 Lucas 主动循环（启动后延迟 5 分钟首次触发，避免和启动流程冲突）
  setTimeout(() => {
    runLucasProactiveLoop();
    setInterval(runLucasProactiveLoop, 60 * 60 * 1000);
  }, 5 * 60 * 1000);
  logger.info('Lucas 主动循环已注册', { intervalMinutes: 60 });

  // 启动 Main 监控循环（启动后延迟 10 分钟首次触发）
  if (WECOM_OWNER_ID) {
    setTimeout(() => {
      runMainMonitorLoop();
      setInterval(runMainMonitorLoop, 4 * 60 * 60 * 1000);
    }, 10 * 60 * 1000);
    logger.info('Main 监控循环已注册', { intervalHours: 4, 协议: '告警级别3紧急/告警级别2日报/告警级别1静默' });
  }

  // Andy HEARTBEAT：每天 23:00-23:30 CST 固定窗口，每 5 分钟检查一次是否到窗口
  // 夜间批量模式：收集全天信号 → Andy 综合规划 → 逐条提交 task-registry.json
  let _andyHbLastDate = '';
  setInterval(() => {
    const cstNow = new Date(Date.now() + 8 * 3600000); // UTC+8
    const h = cstNow.getUTCHours(), m = cstNow.getUTCMinutes();
    const dateStr = cstNow.toISOString().slice(0, 10);
    if (h === 23 && m < 30 && _andyHbLastDate !== dateStr) {
      _andyHbLastDate = dateStr;
      runAndyHeartbeatLoop();
    }
  }, 5 * 60 * 1000);
  logger.info('Andy HEARTBEAT 夜间规划循环已注册', { window: '23:00-23:30 CST' });

  // Main 周度自动评估：每周日 22:00-22:30 CST，每 5 分钟检查一次
  let _mainWeeklyLastDate = '';
  setInterval(() => {
    const cstNow = new Date(Date.now() + 8 * 3600000); // UTC+8
    const day = cstNow.getUTCDay(); // 0=Sunday
    const h = cstNow.getUTCHours(), m = cstNow.getUTCMinutes();
    const dateStr = cstNow.toISOString().slice(0, 10);
    if (day === 0 && h === 22 && m < 30 && _mainWeeklyLastDate !== dateStr) {
      _mainWeeklyLastDate = dateStr;
      runMainWeeklyEvaluation().catch(e => logger.error('Main 周度评估异常', { error: e.message }));
    }
  }, 5 * 60 * 1000);
  logger.info('Main 周度自动评估已注册', { window: '每周日 22:00-22:30 CST' });


  // ── Layer 2：启动扫描——检测进程重启导致的孤儿任务 ───────────────────────
  // 进程崩溃时 catch 块不执行，running 任务永远卡住；启动时扫描并清零
  ;(function startupOrphanScan() {
    try {
      const entries = readTaskRegistry();
      const now = Date.now();
      const STALE_MS = 5 * 60 * 1000; // running > 5 分钟 = 进程重启前就在跑的孤儿
      const orphans = entries.filter(e =>
        e.status === 'running' &&
        (now - new Date(e.startedAt || e.submittedAt).getTime()) > STALE_MS
      );
      if (orphans.length === 0) {
        logger.info('启动扫描：无孤儿任务');
        return;
      }
      // 标记为 interrupted
      const updated = entries.map(e => {
        if (!orphans.find(o => o.id === e.id)) return e;
        return { ...e, status: 'interrupted', interruptedAt: new Date().toISOString(), interruptReason: 'process-restart' };
      });
      writeTaskRegistry(updated);
      logger.warn('启动扫描：检测到孤儿任务，已标记 interrupted', { count: orphans.length, ids: orphans.map(o => o.id) });
      // 通知系统工程师
      for (const task of orphans) {
        const msg = `【任务中断恢复】进程重启导致任务中断\n任务ID: ${task.id}\n标题: ${task.title || task.requirement?.slice(0, 50) || '(无标题)'}\n中断阶段: ${task.currentPhase || '未知'}\nrunning→interrupted\n提交时间: ${task.submittedAt}`;
        fetch(`http://localhost:${PORT}/api/wecom/notify-engineer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'intervention', fromAgent: inferTaskAgent(task), message: msg }),
        }).catch(err => logger.error('notify-engineer 失败（启动扫描）', { error: err.message }));
      }
      // 延迟 2 分钟等 Gateway 稳定后通知 Lucas，由他决定是否重触发
      setTimeout(async () => {
        try {
          const summary = orphans.map(t => `- ${t.id}（${t.title || t.requirement?.slice(0, 40) || '无标题'}）`).join('\n');
          const lucasMsg = `系统刚刚重启，检测到 ${orphans.length} 个任务在重启前被中断，已标记 interrupted：\n${summary}\n\n你来判断是否需要重新触发这些任务。`;
          await callGatewayAgent('lucas', lucasMsg, 'system:startup', 60000);
          logger.info('已通知 Lucas 处理孤儿任务', { count: orphans.length });
        } catch (err) {
          logger.error('通知 Lucas 孤儿任务失败', { error: err.message });
        }
      }, 2 * 60 * 1000);
    } catch (err) {
      logger.error('启动扫描失败', { error: err.message });
    }
  })();

  // ── Layer 3：周期性卡住检查（每 30 分钟，超过 2 小时未完成通知 SE）──────
  setInterval(() => {
    try {
      const entries = readTaskRegistry();
      const now = Date.now();
      const STUCK_MS = 2 * 60 * 60 * 1000;       // running > 2h = 疑似卡住
      const NOTIFY_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 每个任务最多每 2h 通知一次
      let dirty = false;
      for (const entry of entries) {
        if (entry.status !== 'running') continue;
        const runningFor = now - new Date(entry.startedAt || entry.submittedAt).getTime();
        if (runningFor <= STUCK_MS) continue;
        const lastNotified = entry.stuckNotifiedAt ? new Date(entry.stuckNotifiedAt).getTime() : 0;
        if (now - lastNotified < NOTIFY_COOLDOWN_MS) continue;
        const hours = (runningFor / 3600000).toFixed(1);
        const msg = `【任务疑似卡住】已 running ${hours}h 未完成\n任务ID: ${entry.id}\n标题: ${entry.title || entry.requirement?.slice(0, 50) || '(无标题)'}\n当前阶段: ${entry.currentPhase || '未知'}\n提交时间: ${entry.submittedAt}`;
        fetch(`http://localhost:${PORT}/api/wecom/notify-engineer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'intervention', fromAgent: inferTaskAgent(entry), message: msg }),
        }).catch(err => logger.error('notify-engineer 失败（卡住检查）', { error: err.message }));
        entry.stuckNotifiedAt = new Date().toISOString();
        dirty = true;
      }
      if (dirty) writeTaskRegistry(entries);
    } catch (err) {
      logger.error('卡住检查失败', { error: err.message });
    }
  }, 30 * 60 * 1000);
  logger.info('任务卡住检查已注册', { intervalMinutes: 30, stuckThresholdHours: 2 });
});

module.exports = app;
