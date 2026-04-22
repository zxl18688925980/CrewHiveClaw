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
let handleMainCommand, saveTechDocToObsidian, SAVE_DOC_RE, SAVE_TECH_RE;

// loops 函数占位符（由 initLoops() 填充）
let runLucasProactiveLoop, runMainMonitorLoop, runMainWeeklyEvaluation, runAndyHeartbeatLoop;

// wecom-api 函数占位符（由 initWecomApi() 填充）
let aesDecrypt, extractXmlField, sha1Sort, getAccessToken;
let sendWeComGroupMessage, sendWeComGroupFile, sendWeComMessage, botSend, sendWeComFile;

// ─── 全局路径常量（必须在任何函数定义之前）────────────────────────────────────
const HOMEAI_ROOT     = path.join(__dirname, '../../../../..');
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
    HOMEAI_ROOT,
  });
  ({ callMainModel, executeMainTool, handleMainCommand, saveTechDocToObsidian, SAVE_DOC_RE, SAVE_TECH_RE } = _mt2);
}
function initLoops() {
  _loops = _loopsFactory(logger, {
    callGatewayAgent, callMainModel, executeMainTool,
    sendWeComMessage, sendLongWeComMessage,
    nowCST, HOMEAI_ROOT, PORT, WECOM_OWNER_ID,
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
let familyMembers = {};
try {
  const familyInfo = require('/Users/xinbinanshan/.homeai/family-info.json');
  familyMembers = familyInfo.wecomMembers || {};
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
      path.join(process.env.HOME || '', '.homeai', 'demo-group-config.json'), 'utf8'
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
let accessTokenCache = { token: null, expiresAt: 0 };

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

// ─── Gateway 调用 ────────────────────────────────────────────────────────────

/**
 * 通过 HomeClaw Gateway 调用指定 agent。
 * Lucas/Andy/Lisa 为标准嵌入式 agent，crewclaw-routing 插件在 Gateway 层提供三层路由。
 */
async function callGatewayAgent(agentId, message, userId, timeoutMs = 180000, historyMessages = []) {
  // 每次请求用独立 session（userId:timestamp），支持并发
  // Kuzu 注入 + ChromaDB 注入由 crewclaw-routing before_prompt_build 注入
  // 近期对话由调用方传入 historyMessages，作为真实 messages array 传给模型
  const sessionUserId = `${userId}:${Date.now()}`;

  // AbortController 实现硬超时：axios 的 timeout 只是 socket 空闲超时（有 keepalive 时不触发），
  // AbortController.abort() 强制断开连接，确保 timeoutMs 后一定抛出异常
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const messages = historyMessages.length > 0
    ? [...historyMessages, { role: 'user', content: message }]
    : [{ role: 'user', content: message }];

  try {
    const resp = await axios.post(
      `${GATEWAY_URL}/v1/chat/completions`,
      {
        model:    `openclaw/${agentId}`,
        messages,
        user:     sessionUserId,
        stream:   false,
      },
      {
        signal: controller.signal,
        headers: {
          'Content-Type':        'application/json',
          'x-openclaw-agent-id': agentId,
          ...(GATEWAY_TOKEN ? { Authorization: `Bearer ${GATEWAY_TOKEN}` } : {}),
        },
      }
    );
    return resp.data?.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}


app.use(cors());
// JSON 优先，企业微信回调的 XML 用 text 解析（不能用 '*/*' 否则会吞掉 JSON）
app.use(express.json({ limit: '50mb' }));
app.use(express.text({ type: ['text/xml', 'application/xml', 'text/plain'] }));

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

// ─── 评估仪表盘（Web Dashboard）────────────────────────────────────────────────
// 公网 URL: https://wecom.homeai-wecom-zxl.top/eval-dashboard
const EVAL_DASHBOARD_URL = 'https://wecom.homeai-wecom-zxl.top/eval-dashboard';

app.get('/api/eval/history', (req, res) => {
  const historyPath = path.join(HOMEAI_ROOT, 'Data', 'learning', 'evaluation-history.jsonl');
  const count = Math.min(parseInt(req.query.count) || 50, 200);
  if (!fs.existsSync(historyPath)) return res.json([]);
  const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(l => l.trim());
  const entries = lines.slice(-count).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  res.json(entries);
});

app.get('/eval-dashboard', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<title>HomeAI 系统评估仪表盘</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#0f0f23;color:#e0e0e0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:12px}
h1{font-size:18px;text-align:center;margin-bottom:8px;color:#fff}
.subtitle{font-size:12px;text-align:center;color:#888;margin-bottom:16px}
.card{background:#1a1a2e;border-radius:10px;padding:14px;margin-bottom:12px;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.card h2{font-size:14px;margin-bottom:8px;color:#fff;border-bottom:1px solid #333;padding-bottom:6px}
.chart-wrap{position:relative;height:280px}
.score-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.score-item{text-align:center;padding:8px 4px;background:#16213e;border-radius:8px}
.score-item .label{font-size:11px;color:#999;margin-bottom:2px}
.score-item .value{font-size:22px;font-weight:bold}
.score-item .pass{color:#2ecc71}
.score-item .warn{color:#e67e22}
.score-item .fail{color:#e74c3c}
.bottleneck{padding:6px 10px;margin:4px 0;border-radius:6px;font-size:12px;display:flex;justify-content:space-between;align-items:center}
.bottleneck.critical{background:rgba(231,76,60,.15);border-left:3px solid #e74c3c}
.bottleneck.warning{background:rgba(230,126,34,.15);border-left:3px solid #e67e22}
.bottleneck .name{flex:1}.bottleneck .score{font-weight:bold;min-width:40px;text-align:right}
.empty{text-align:center;color:#666;padding:40px;font-size:14px}
.refresh-btn{position:fixed;bottom:20px;right:20px;width:44px;height:44px;border-radius:50%;background:#3498db;color:#fff;border:none;font-size:20px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.4)}
</style>
</head>
<body>
<h1>HomeAI 系统评估仪表盘</h1>
<div class="subtitle" id="lastUpdate">加载中...</div>
<div class="card"><h2>总体评分</h2><div class="score-grid" id="scoreGrid"></div></div>
<div class="card"><h2>L0-L4 趋势</h2><div class="chart-wrap"><canvas id="trendChart"></canvas></div></div>
<div class="card"><h2>子维度分布（最近一次）</h2><div class="chart-wrap"><canvas id="barChart"></canvas></div></div>
<div class="card"><h2>关键卡点</h2><div id="bottlenecks"></div></div>
<button class="refresh-btn" onclick="loadData()" title="刷新">&#x21bb;</button>
<script>
const LAYER_COLORS={L0:'#2ecc71',L1:'#3498db',L2:'#e67e22',L3:'#9b59b6',L4:'#e74c3c'};
const LAYER_NAMES={L0:'L0 Agents基础设施',L1:'L1 Agents行为质量',L2:'L2 Engineering Anything',L3:'L3 组织协作进化',L4:'L4 系统自进化'};
const PASS_TH={L0:3.0,L1:3.0,L2:2.5,L3:2.0,L4:2.0};
let trendChart=null,barChart=null;
async function loadData(){
  try{
    const r=await fetch('/api/eval/history?count=30');
    const data=await r.json();
    if(!data.length){document.getElementById('scoreGrid').innerHTML='<div class="empty">暂无评估数据，请先运行 evaluate_system</div>';return;}
    renderScoreGrid(data);
    renderTrend(data);
    renderBar(data);
    renderBottlenecks(data);
    document.getElementById('lastUpdate').textContent='最近更新: '+new Date(data[data.length-1].ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})+' | 共 '+data.length+' 次评估';
  }catch(e){document.getElementById('lastUpdate').textContent='加载失败: '+e.message;}
}
function renderScoreGrid(data){
  const latest=data[data.length-1];
  const keys=['L0','L1','L2','L3','L4'];
  const avg=latest.overall||0;
  let html='<div class="score-item"><div class="label">整体均值</div><div class="value '+(avg>=3?'pass':avg>=2?'warn':'fail')+'">'+avg.toFixed(1)+'</div></div>';
  for(const k of keys){
    const s=latest[k]?.w;
    if(s==null)continue;
    const cls=s>=PASS_TH[k]?'pass':s>=PASS_TH[k]-1?'warn':'fail';
    html+='<div class="score-item"><div class="label">'+LAYER_NAMES[k]+'</div><div class="value '+cls+'">'+s.toFixed(1)+'</div></div>';
  }
  document.getElementById('scoreGrid').innerHTML=html;
}
function renderTrend(data){
  const keys=['L0','L1','L2','L3','L4'];
  const labels=data.map(e=>{try{return new Date(e.ts).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});}catch{return'?';}});
  const datasets=keys.map(k=>({label:LAYER_NAMES[k],data:data.map(e=>e[k]?.w??null),borderColor:LAYER_COLORS[k],backgroundColor:LAYER_COLORS[k]+'33',tension:.3,pointRadius:2,borderWidth:2,spanGaps:true}));
  datasets.push({label:'整体均值',data:data.map(e=>e.overall??null),borderColor:'#fff',backgroundColor:'#ffffff22',tension:.3,pointRadius:3,borderWidth:2.5,borderDash:[6,3],spanGaps:true});
  const ctx=document.getElementById('trendChart').getContext('2d');
  if(trendChart)trendChart.destroy();
  trendChart=new Chart(ctx,{type:'line',data:{labels,datasets},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{labels:{color:'#ccc',font:{size:10}}}},scales:{x:{ticks:{color:'#888',maxRotation:45,font:{size:9}},grid:{color:'#ffffff0a'}},y:{min:0,max:5.5,ticks:{color:'#888',stepSize:1},grid:{color:'#ffffff0a'}}}}});
}
function renderBar(data){
  const latest=data[data.length-1];
  const keys=['L0','L1','L2','L3','L4'];
  const names=[],scores=[],colors=[];
  for(const k of keys){
    const items=latest[k]?.items||{};
    for(const[ik,iv]of Object.entries(items)){
      if(iv?.s==null)continue;
      names.push(ik.replace(/_/g,' ').substring(0,12));
      scores.push(iv.s);
      colors.push(LAYER_COLORS[k]);
    }
  }
  const ctx=document.getElementById('barChart').getContext('2d');
  if(barChart)barChart.destroy();
  barChart=new Chart(ctx,{type:'bar',data:{labels:names,datasets:[{data:scores,backgroundColor:colors.map(c=>c+'cc'),borderColor:colors,borderWidth:1}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{x:{ticks:{color:'#888',font:{size:8},maxRotation:60},grid:{color:'#ffffff0a'}},y:{min:0,max:5.5,ticks:{color:'#888',stepSize:1},grid:{color:'#ffffff0a'}}}}});
}
function renderBottlenecks(data){
  const latest=data[data.length-1];
  const keys=['L0','L1','L2','L3','L4'];
  const items=[];
  for(const k of keys){
    const its=latest[k]?.items||{};
    for(const[ik,iv]of Object.entries(its)){
      if(iv?.s==null)continue;
      if(iv.s<PASS_TH[k])items.push({layer:k,key:ik,score:iv.s,threshold:PASS_TH[k],critical:iv.s<PASS_TH[k]-1});
    }
  }
  items.sort((a,b)=>a.score-b.score);
  const el=document.getElementById('bottlenecks');
  if(!items.length){el.innerHTML='<div style="color:#2ecc71;text-align:center;padding:12px;font-size:13px">所有子维度均达标</div>';return;}
  el.innerHTML=items.slice(0,15).map(i=>'<div class="bottleneck '+(i.critical?'critical':'warning')+'"><span class="name">'+LAYER_NAMES[i.layer]+' · '+i.key.replace(/_/g,' ')+'</span><span class="score">'+i.s.toFixed(1)+'/'+i.threshold+'</span></div>').join('');
}
loadData();
</script>
</body>
</html>`);
});

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
            const uploadDir = path.join(HOMEAI_ROOT, 'Data', 'uploads', dateStr, 'images');
            fs.mkdirSync(uploadDir, { recursive: true });
            const imgExt      = mainImageMime === 'image/png' ? '.png' : '.jpg';
            const imgFilename = `main-${Date.now()}${imgExt}`;
            const imgSavePath = path.join(uploadDir, imgFilename);
            fs.writeFileSync(imgSavePath, imgBuffer);
            mainImageRelativePath = path.relative(HOMEAI_ROOT, imgSavePath);
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
            const uploadDir = path.join(HOMEAI_ROOT, 'Data', 'uploads', dateStr, 'videos');
            fs.mkdirSync(uploadDir, { recursive: true });
            const vidFilename = `main-${Date.now()}.mp4`;
            const vidSavePath = path.join(uploadDir, vidFilename);
            fs.writeFileSync(vidSavePath, vidBuffer);
            const vidRelPath  = path.relative(HOMEAI_ROOT, vidSavePath);
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
            const uploadDir = path.join(HOMEAI_ROOT, 'Data', 'uploads', dateStr, 'voices');
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
    const member  = familyMembers[fromUser];
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
      reply = '此通道仅供系统工程师使用。如需帮助，请直接私聊启灵，或在群里@启灵。';

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
      if (globalBotClient && globalBotReady) {
        try {
          await globalBotClient.sendMessage(fromUser, { msgtype: 'markdown', markdown: { content: text } });
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
        logger.warn('私聊推送时 bot 未就绪，通知系统工程师', { fromUser, globalBotReady });
        fetch(`http://localhost:${PORT}/api/wecom/notify-engineer`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 'intervention', fromAgent: 'lucas', message: `⚠️ 私聊推送时 bot 未就绪（globalBotReady=${globalBotReady}），消息未送达。\n目标用户：${fromUser}\n原消息：${text.slice(0, 300)}` }),
        }).catch(() => {});
      }
      return; // 私聊路径已在上方处理日志，提前返回
    }
    const channel = isGroup ? (globalBotReady ? 'bot' : 'app') : 'bot';
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

// ─── Main 系统工程师：MiniMax 驱动，带工具 ────────────────────────────────────

// ─── 从 openclaw.json 读取 Agent 模型配置 ──────────────────────────────────────
// 返回 { baseUrl, apiKey, model } 供 OpenAI-compatible 调用
function readAgentModelConfig(agentId) {
  const configPath = path.join(process.env.HOME, '.openclaw/openclaw.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const agent = config.agents.list.find(a => a.id === agentId);
  if (!agent) throw new Error(`Agent ${agentId} not found in openclaw.json`);
  const [providerKey, modelId] = agent.model.split('/');
  const provider = config.models?.providers?.[providerKey];
  if (!provider) throw new Error(`Provider ${providerKey} not found in openclaw.json`);
  return { baseUrl: provider.baseUrl, apiKey: provider.apiKey, model: modelId };
}

// 剥离 MiniMax reasoning 模型的 <think>...</think> 块
function stripThink(text) {
  return (text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

// callMainModel → lib/main-tools.js

// OpenAI-compatible chat completion（适用于所有 openai-completions 类型 provider）
async function callAgentModel(agentId, systemPrompt, messages, maxTokens = 1024) {
  const { baseUrl, apiKey, model } = readAgentModelConfig(agentId);
  // 修复：baseUrl 如 https://api.anthropic.com 没有路径时需要补 /v1，
  // 否则拼出的 /chat/completions 会 404（正确路径是 /v1/chat/completions）
  let completionsUrl;
  try {
    const u = new URL(baseUrl);
    completionsUrl = (u.pathname === '/' || u.pathname === '')
      ? `${baseUrl.replace(/\/$/, '')}/v1/chat/completions`
      : `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  } catch {
    completionsUrl = `${baseUrl}/chat/completions`;
  }
  const resp = await fetch(completionsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: systemPrompt }, ...messages] }),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
    throw new Error(`Agent model API error ${resp.status}: ${errText.slice(0, 200)}`);
  }
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

// ─── Lucas 后备：Gateway 不可用时跟随 Lucas 的配置模型 ─────────────────────────
// 每次进程重启后第一次进入后备时通知系统工程师，之后静默（避免每条消息都推通知）
let _gatewayDownNotifiedAt = 0;
const GATEWAY_DOWN_NOTIFY_INTERVAL_MS = 30 * 60 * 1000; // 每 30 分钟最多推一次

let _lucasSoulCache = null;
function getLucasSoul() {
  if (_lucasSoulCache) return _lucasSoulCache;
  try {
    const soulPath = path.join(process.env.HOME, '.openclaw/workspace-lucas/SOUL.md');
    _lucasSoulCache = fs.readFileSync(soulPath, 'utf8');
  } catch {
    _lucasSoulCache = '你是启灵，曾家的小儿子，温暖直接，像家人一样说话。';
  }
  return _lucasSoulCache;
}

async function callClaudeFallback(userMessage, fromUser, historyMessages = []) {
  const soul = getLucasSoul();
  const messages = [...historyMessages, { role: 'user', content: userMessage }];

  // 跟随 Lucas 在 openclaw.json 里的模型配置，不硬编码任何 provider
  const text = await callAgentModel('lucas', soul, messages, 1024) || '收到～';
  logger.info('Agent model 后备回复成功', { fromUser, replyLen: text.length });
  return text;
}

// ─── 家庭 Web 应用入口 ───────────────────────────────────────────────────────
// Andy/Lisa 交付的 Web 应用统一放在 app/generated/，通过 /app/* 访问
// 公网地址：https://wecom.homeai-wecom-zxl.top/app/{应用名}/
// 新应用无需改动 Cloudflare Tunnel，直接可访问
const APP_GENERATED_DIR = path.join(HOMEAI_ROOT, 'app', 'generated');
fs.mkdirSync(APP_GENERATED_DIR, { recursive: true });
app.use('/app', express.static(APP_GENERATED_DIR));

// ─── 访客邀请 / 对话管理 ─────────────────────────────────────────────────────
// visitor-registry.json: { TOKEN: { name, invitedBy, scopeTags, behaviorContext, status, expiresAt, shadowMemoryPath, createdAt } }
const VISITOR_REGISTRY_PATH  = path.join(HOMEAI_ROOT, 'data', 'visitor-registry.json');
// Lucas 主动推给访客的消息队列（内存，前端轮询取走）{ lowerToken: [{ id, text, ts }] }
const visitorPendingMessages = {};
const DEMO_CHAT_HISTORY_PATH = path.join(HOMEAI_ROOT, 'data', 'demo-chat-history.json');
const DEMO_DISABLED_FLAG     = path.join(HOMEAI_ROOT, 'data', 'demo-disabled.flag');
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

  const greetMessage = visitorName
    ? `您好，${visitorName}叔叔！我是启灵，曾小龙的孩子。爸爸邀请您来体验的，有什么想聊的，或者想要个网页小工具，直接说就好。`
    : `您好！我是启灵，主人邀请您来体验的。有什么想聊的，直接说就好——比如想要个网页小工具、或者有什么开发需求想试试，都可以跟我说。先告诉我您怎么称呼？`;

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
    const initVisitorScript = path.join(HOMEAI_ROOT, 'scripts', 'init-visitor.py');
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

// ─── 工具 API 动态加载 ────────────────────────────────────────────────────────
// 约定：app/generated/{name}/server.js 存在时，自动挂载为 /api/{name}/*
// 工具自包含所有路由和逻辑，Channel 不感知工具内部实现。
// server.js 可选导出 router.setup(ctx) 接收环境注入：
//   ctx.HOMEAI_ROOT — HomeAI 根目录
//   ctx.logger      — 统一 logger
// tool contract: server.js exports a factory function
//   module.exports = function({ express, HOMEAI_ROOT, logger, Anthropic }) -> Router
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
        const router = factory({ express, HOMEAI_ROOT, logger, Anthropic });
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

initWecomApi();
initMainTools();
initLoops();

// ─── 智能机器人 WebSocket 长连接（通道 B：家庭群 + 成员私聊 → Lucas）────────

function startBotLongConnection() {
  if (!WECOM_BOT_ID || !WECOM_BOT_SECRET) {
    logger.warn('WECOM_BOT_ID 或 WECOM_BOT_SECRET 未配置，跳过智能机器人长连接');
    return;
  }

  const wsClient = new WSClient({
    botId:  WECOM_BOT_ID,
    secret: WECOM_BOT_SECRET
  });

  // 延长 chunk upload ack 超时（默认 5000ms，大 MP3 base64 后可能超时）
  if (wsClient.wsManager) wsClient.wsManager.replyAckTimeout = 30000;

  wsClient.on('connected', () => {
    logger.info('智能机器人 WebSocket 已连接');
    taskManager.setWsClient(wsClient);
  });

  wsClient.on('authenticated', () => {
    logger.info('智能机器人认证成功，开始接收家庭消息');
    globalBotReady = true;
  });

  wsClient.on('disconnected', () => {
    globalBotReady = false;
    logger.warn('智能机器人 WebSocket 断开，SDK 会自动重连');
  });

  // 监听文本消息（群聊 + 私聊均触发）
  wsClient.on('message.text', async (frame) => {
    const fromUser   = frame.body?.from?.userid || 'unknown';
    const content    = frame.body?.text?.content || '';
    const chatId     = frame.body?.chatid;       // 群消息才有
    const isGroup    = !!chatId;
    const rawMsgId   = frame.body?.msgid;

    // 去重：网络抖动时企业微信会重推同一 msgid，60s 内只处理一次
    if (isDuplicateMsg(rawMsgId)) {
      logger.info('Bot 文本消息去重跳过', { fromUser, msgId: rawMsgId });
      return;
    }

    logger.info('Bot 收到文本消息', {
      fromUser,
      isGroup,
      chatId,
      content: content.substring(0, 60)
    });

    // 群消息去掉 @机器人 前缀
    // 注意：WeChat 不总是在 @名称后加空格，/^@\S+\s*/ 贪婪匹配会吃掉没有空格的中文内容
    // 修复：先精确匹配已知 bot 名，再 fallback 到「@词+空格」格式
    let text = content;
    if (isGroup) {
      text = text
        .replace(/^@启灵\s*/, '')   // 精确匹配已知 bot 名（有无空格均处理）
        .replace(/^@啟靈\s*/, '')   // 繁体备用
        .trimStart();
      // 若还以 @ 开头（其他 bot 名），尝试空格分隔的通用剥离
      if (text.startsWith('@')) {
        text = text.replace(/^@\S+\s+/, '').trimStart();
      }
      if (!text) return;
    }

    // 身份标签（让 Lucas 知道是谁发的，含渠道信息）
    const member    = familyMembers[fromUser];
    const channel   = isGroup ? '群聊' : '私聊';
    const memberTag = member
      ? `【${channel}·${member.role}${member.name}】`
      : `【${channel}·${fromUser}】`;
    const memberName = member ? `${member.role}${member.name}` : fromUser;

    // 近期对话历史：私聊时自动前置最近群聊消息（跨渠道在场感），群聊保持原样
    const histKey = chatHistoryKey(isGroup, chatId, fromUser);
    const historyMessages = buildHistoryWithCrossChannel(isGroup, histKey);

    // 微信公众号链接：自动抓取正文注入给 Lucas
    let lucasText = text;
    const wechatUrlMatch = text.match(/https?:\/\/mp\.weixin\.qq\.com\/[^\s\u4e00-\u9fa5\uff00-\uffef，。！？、；：""''【】《》]+/);
    if (wechatUrlMatch) {
      const wechatUrl = wechatUrlMatch[0];
      logger.info('Bot 检测到微信链接，尝试抓取', { fromUser, url: wechatUrl });
      const article = await scrapeWechatArticle(wechatUrl);
      if (article && article.text) {
        lucasText = text + `\n\n【文章内容已自动抓取】\n原始链接：${wechatUrl}\n标题：${article.title || '（无标题）'}\n${article.author ? `作者：${article.author}\n` : ''}正文：\n${article.text}`;
        logger.info('Bot 微信文章抓取成功，注入给 Lucas', { title: article.title, textLen: article.text.length });
      } else {
        logger.warn('Bot 微信文章抓取失败', { url: wechatUrl });
      }
    }

    // 抖音链接：fire-and-forget 异步处理，Lucas 立即回应，转录完成后推送给家人
    const douyinUrlMatch = !wechatUrlMatch && lucasText.match(DOUYIN_URL_RE);
    if (douyinUrlMatch) {
      const douyinUrl = douyinUrlMatch[0];
      const withFrames = FRAME_ANALYSIS_RE.test(lucasText);
      // 立即给 Lucas 一个标题上下文（来自分享文本，不需等待 ASR）
      const parsed = parseDouyinShareText(lucasText, douyinUrl);
      const titleHint = parsed?.title ? `「${parsed.title}」` : '';
      lucasText = lucasText + `\n\n[系统提示] 家人分享了抖音视频${titleHint}，语音转录正在后台处理中（约30秒），完成后会单独推送给家人。请先基于现有信息自然回应，无需等待转录。`;
      // Fire-and-forget：异步提取，不阻塞当前消息处理
      const botTarget = isGroup ? chatId : fromUser;
      logger.info('Bot 抖音链接 fire-and-forget 开始', { fromUser, url: douyinUrl, withFrames });
      // 捕获当前 wecomUserId（msgId 在后面才赋值，先用 fromUser 作为 follow-up session key）
      const followUpSessionKey = isGroup ? `group:${fromUser}:followup` : fromUser;
      scrapeDouyinContent(douyinUrl, { withFrames }).then(async meta => {
        if (!meta) {
          // 提取失败：通知 Lucas 如实告知家人
          logger.warn('Bot 抖音后台提取失败（null），通知 Lucas', { fromUser, url: douyinUrl });
          const failPrompt = `${memberTag}[系统：刚才那个抖音视频语音提取失败了，无法获取内容。请如实告知家人"视频内容提取失败了，我没能看到里面的内容"，不要推测或编造视频内容。]`;
          try {
            const failReply = await callGatewayAgent('lucas', failPrompt, followUpSessionKey);
            if (failReply && globalBotClient && globalBotReady) {
              botSend(botTarget, failReply).catch(e => logger.warn('Bot 抖音提取失败通知推送失败(null)', { error: e?.message || String(e) }));
            }
          } catch (e) {
            logger.warn('Bot 抖音提取失败通知 Lucas 调用失败', { error: e.message });
          }
          return;
        }
        if (meta.error) {
          // 提取失败且有具体原因：通知 Lucas 告知家人具体错误
          logger.warn('Bot 抖音后台提取失败，通知 Lucas', { fromUser, url: douyinUrl, error: meta.error });
          const failPrompt = `${memberTag}[系统：刚才那个抖音视频提取失败了，原因是：${meta.error}。请如实告知家人"视频内容提取失败，原因是${meta.error}"，不要推测或编造视频内容。]`;
          try {
            const failReply = await callGatewayAgent('lucas', failPrompt, followUpSessionKey);
            if (failReply && globalBotClient && globalBotReady) {
              botSend(botTarget, failReply).catch(e => logger.warn('Bot 抖音提取失败通知推送失败(err)', { error: e?.message || String(e) }));
            }
          } catch (e) {
            logger.warn('Bot 抖音提取失败通知 Lucas 调用失败', { error: e.message });
          }
          return;
        }
        logger.info('Bot 抖音后台提取完成', { fromUser, hasTranscript: !!meta.transcript });
        transcriptionBuffer.add(fromUser, { meta, douyinUrl, memberTag });
        const buffered = transcriptionBuffer.get(fromUser);
        // 简单策略：如果 3 秒内没来新的转录结果，就推送当前所有
        // 用 debounce 方式：每次完成都延迟推送，新的完成会取消旧的定时器
        if (!transcriptionBuffer._timers) transcriptionBuffer._timers = new Map();
        clearTimeout(transcriptionBuffer._timers.get(fromUser));
        transcriptionBuffer._timers.set(fromUser, setTimeout(async () => {
          transcriptionBuffer._timers.delete(fromUser);
          const items = transcriptionBuffer.flush(fromUser);
          if (!items || items.length === 0) return;
          try {
            // 单条转录截断 1500 字，多条每条截断 600 字，避免合并 prompt 过大超时
            const truncateInjection = (meta, url, maxChars) => {
              const full = formatVideoInjection(meta, url);
              return full.length > maxChars ? full.slice(0, maxChars) + '\n…（内容已截断）' : full;
            };
            let followUpPrompt;
            if (items.length === 1) {
              // 单条：原逻辑，截断到 1500 字
              const b = items[0];
              followUpPrompt = `${b.memberTag}[系统：刚才你分享的抖音视频语音转录已完成，以下是内容，请做简洁总结后直接回复家人：]\n${truncateInjection(b.meta, b.douyinUrl, 1500)}`;
            } else {
              // 多条：合并，每条截断到 600 字
              const mergedParts = items.map((b, i) =>
                `视频${i+1}「${b.meta.title || '未知'}」:\n${truncateInjection(b.meta, b.douyinUrl, 600)}`
              ).join('\n---\n');
              followUpPrompt = `${items[0].memberTag}[系统：${items.length} 个抖音视频语音转录全部完成，请做简洁总结：]\n${mergedParts}`;
            }
            // 批量视频转录 prompt 可能较大，超时设 5 分钟
            const analysis = await callGatewayAgent('lucas', followUpPrompt, followUpSessionKey, 300000);
            if (analysis && globalBotClient && globalBotReady) {
              botSend(botTarget, analysis).catch(e => logger.warn('Bot 抖音转录合并推送失败', { error: e?.message || String(e) }));
            }
          } catch (e) {
            logger.warn('Bot 抖音转录合并分析 Lucas 调用失败', { error: e.message });
          }
        }, 3000));
      }).catch(e => logger.warn('Bot 抖音后台提取异常', { error: e.message }));
    }

    // 视频链接（Bilibili / YouTube）：用 yt-dlp 提取内容注入给 Lucas
    const videoUrlMatch = !wechatUrlMatch && !douyinUrlMatch && lucasText.match(VIDEO_URL_RE);
    if (videoUrlMatch) {
      const videoUrl = videoUrlMatch[0];
      logger.info('Bot 检测到视频链接，尝试 yt-dlp 提取', { fromUser, url: videoUrl });
      const video = await scrapeVideoContent(videoUrl);
      if (video && video.title) {
        lucasText = lucasText + formatVideoInjection(video, videoUrl);
        logger.info('Bot 视频内容提取成功，注入给 Lucas', { title: video.title, hasTranscript: !!video.transcript });
      } else {
        logger.warn('Bot 视频内容提取失败，链接保留', { url: videoUrl });
      }
    }

    const messageToLucas = `${memberTag}${lucasText}`;

    // wecomUserId 编码：crewclaw-routing 插件从 requesterSenderId 解析此格式
    // 群消息用 group:fromUser:msgId（per-message 独立 session），避免一条消息卡住后续所有群消息排队
    const msgId = frame.body?.msgid || crypto.randomUUID();
    const wecomUserId = isGroup ? `group:${chatId}:${fromUser}:${msgId}` : fromUser;

    // sendMessage 有时挂起（WebSocket 等待 ACK 但永不到来），加超时保护
    const sendWithTimeout = (fn, ms = 15000) =>
      Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`sendMessage timeout ${ms}ms`)), ms))]);

    // 群消息 ACK：只在明确的长操作（开发需求/bug 上报/重启）时才发，普通对话不发
    // 长操作通常需要 trigger_development_pipeline / report_bug / restart_service，耗时 1-3 分钟
    const GROUP_ACK_PATTERNS = [
      /开发|做个|做一个|帮我做|新功能|实现一下|需要.{0,15}功能|上线|加个|整个/,
      /报.{0,3}bug|有.{0,3}bug|坏了|修一下|修复|出问题了/,
      /重启|restart/,
    ];
    const mightBeLongOp = isGroup && GROUP_ACK_PATTERNS.some(p => p.test(text));
    let groupAckSent = false;
    let groupAckTimer = null;
    if (mightBeLongOp) {
      groupAckTimer = setTimeout(async () => {
        if (!groupAckSent) {
          groupAckSent = true;
          try {
            await sendWithTimeout(() => wsClient.sendMessage(chatId, {
              msgtype: 'markdown', markdown: { content: '收到～' }
            }));
            logger.info('群消息 ack 已发送（长操作，30s 无回复）', { fromUser, chatId });
          } catch (ackErr) {
            logger.warn('群消息 ack 发送失败', { error: ackErr.message });
          }
        }
      }, 30000);
    }

    // ── 演示群：独立通用人格，绕过家庭记忆插件层 ────────────────────────
    if (isGroup && isDemoGroup(chatId)) {
      logger.info('演示群消息，走通用人格', { fromUser, chatId });
      try {
        const demoReply = await callAgentModel('lucas', demoGroupConfig.systemPrompt, [
          { role: 'user', content: text }
        ], demoGroupConfig.maxTokens);
        clearTimeout(groupAckTimer);
        await sendWithTimeout(() => wsClient.sendMessage(chatId, {
          msgtype: 'markdown',
          markdown: { content: demoReply || '好的，稍等一下～' },
        }));
        logger.info('演示群回复已发送', { fromUser, chatId, replyLen: demoReply?.length });
      } catch (demoErr) {
        logger.warn('演示群回复失败', { error: demoErr.message });
        try {
          await wsClient.sendMessage(chatId, {
            msgtype: 'markdown',
            markdown: { content: '抱歉，我现在有点忙，请稍后再试～' },
          });
        } catch {}
      }
      return; // 不走家庭群流程
    }
    // ── 演示群分支结束 ─────────────────────────────────────────────────

    // ── 消息聚合：判断消息类型标签，走聚合器 ────────────────────────────
    let typeTag = 'text';
    if (douyinUrlMatch) typeTag = 'douyin';
    else if (videoUrlMatch) typeTag = 'video';
    else if (wechatUrlMatch) typeTag = 'article';
    const aggKey = `${fromUser}:${isGroup}:${typeTag}`;

    messageAggregator.add(aggKey, {
      rawText: text,
      messageToLucas,
      wecomUserId,
      historyMessages,
      memberTag,
      extra: { isGroup, chatId, frame, groupAckSent, groupAckTimer, histKey, text },
      sendFn: (msg, userId, history, extra) => {
        // sendFn 在聚合器 flush 时被调用，msg 可能是原 messageToLucas 或合并后的 prompt
        const { isGroup: _isGroup, chatId: _chatId, frame: _frame, groupAckTimer: _ackTimer, histKey: _histKey, text: _text } = extra;
        enqueueUserRequest(fromUser, async () => {
          try {
            // 通过 Gateway → Lucas 嵌入式 agent（crewclaw-routing 插件处理三层路由）
            logger.info('callGatewayAgent 开始', { fromUser, historyRounds: history.length / 2 | 0 });

            let replyText;
            try {
              replyText = await callGatewayAgent('lucas', msg, userId, 180000, history) || '收到～';
            } catch (firstErr) {
              // socket hang up / ECONNRESET：DeepSeek R1 偶发网络断连，自动重试一次
              const isNetErr = /socket hang up|ECONNRESET|ECONNABORTED|ETIMEDOUT/i.test(firstErr?.message || '');
              if (isNetErr) {
                logger.warn('Gateway 网络错误，2s 后重试一次', { fromUser, error: firstErr.message });
                await new Promise(r => setTimeout(r, 2000));
                replyText = await callGatewayAgent('lucas', msg, userId, 180000, history) || '收到～';
              } else {
                throw firstErr;
              }
            }

            clearTimeout(_ackTimer);
            logger.info('callGatewayAgent 返回', { fromUser, replyLen: replyText.length });

            // ── 重复回复防护：检测是否陷入循环 ──
            const isRepetition = checkReplyRepetition(fromUser, replyText);
            if (isRepetition) {
              logger.warn('重复回复防护触发，替换为简短提示', { fromUser });
              replyText = '我检测到自己在重复回复，可能系统工具暂时不可用。我正在恢复中，稍后回复你。';
            }

            // 写回本轮对话到 chatHistory buffer（供下条消息使用）
            appendChatHistory(_histKey, `${memberTag}${_text}`, stripMarkdownForWecom(replyText));

            // [VOICE] / [RAP] 检测
            const hasVoiceTag = replyText.includes('[VOICE]');
            const hasRapTag   = replyText.includes('[RAP]');
            const needVoice   = hasVoiceTag || hasRapTag;
            const wecomSafeText = stripInternalTerms(stripMarkdownForWecom(replyText));
            const displayText = needVoice ? stripMarkdownForVoice(wecomSafeText) : wecomSafeText;
            const voiceTarget = _isGroup ? _chatId : fromUser;

            if (_isGroup) {
              // 群消息限流：同一群 5s 内只发一条，避免 errcode=846607
              const now = Date.now();
              const lastSend = groupBotLastSend.get(_chatId) || 0;
              const wait = Math.max(0, GROUP_BOT_MIN_INTERVAL_MS - (now - lastSend));
              if (wait > 0) {
                logger.info('群消息限流等待', { chatId: _chatId, waitMs: wait });
                await new Promise(r => setTimeout(r, wait));
              }
              await sendWithTimeout(() => wsClient.sendMessage(_chatId, { msgtype: 'markdown', markdown: { content: displayText } }));
              groupBotLastSend.set(_chatId, Date.now());
            } else {
              // 私聊：replyStream
              const streamId = crypto.randomUUID();
              await sendWithTimeout(() => wsClient.replyStream(_frame, streamId, displayText, true), 30000);
            }
            if (needVoice) {
              const ttsStyle = hasRapTag ? 'rap' : 'normal';
              sendVoiceChunks(voiceTarget, displayText, ttsStyle).catch(() => {});
            }

            logger.info('Bot 已回复', { fromUser, isGroup: _isGroup, length: replyText.length, channel: 'bot' });
          } catch (e) {
            clearTimeout(_ackTimer);
            logger.error('Bot 消息处理失败，启用 Claude 后备', { error: e?.message || String(e), fromUser });
            try {
              // 第一次进入后备时通知系统工程师（每 30 分钟最多推一次）
              const now = Date.now();
              if (now - _gatewayDownNotifiedAt > GATEWAY_DOWN_NOTIFY_INTERVAL_MS) {
                _gatewayDownNotifiedAt = now;
                fetch(`http://localhost:${PORT}/api/wecom/notify-engineer`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    type: 'error',
                    fromAgent: 'wecom-entrance',
                    message: `⚠️ **Gateway 不可用，系统进入应急模式**\n\nGateway (18789) 无响应，Lucas 已切换为无工具/无记忆的后备模型。\n\n**影响**：工具调用、记忆检索、ChromaDB/Kuzu 全部失效，Lucas 人格保留但能力为零。\n\n**恢复方式**：系统工程师手动执行\n\`\`\`\nlaunchctl enable gui/$(id -u)/ai.openclaw.gateway\nbash ~/.openclaw/start-gateway.sh\n\`\`\``,
                  }),
                }).catch(() => {});
              }

              const fallbackReply = await callClaudeFallback(msg, fromUser, history).catch(fallbackErr => {
                logger.error('Claude 后备也失败了', { error: fallbackErr.message });
                return '我现在有点忙，稍后回你～';
              });

              // 在回复前加应急声明，让用户知道当前是降级状态
              const emergencyPrefix = '⚠️ **系统应急模式**：后台服务异常，我现在没有工具和记忆能力，需要系统工程师介入恢复。\n\n---\n\n';
              const fullReply = emergencyPrefix + fallbackReply;

              appendChatHistory(_histKey, `${memberTag}${_text}`, fallbackReply);
              if (_isGroup) {
                const nowSend = Date.now();
                const lastSend = groupBotLastSend.get(_chatId) || 0;
                const wait = Math.max(0, GROUP_BOT_MIN_INTERVAL_MS - (nowSend - lastSend));
                if (wait > 0) await new Promise(r => setTimeout(r, wait));
                await sendWithTimeout(() => wsClient.sendMessage(_chatId, { msgtype: 'markdown', markdown: { content: fullReply } }));
                groupBotLastSend.set(_chatId, nowSend);
              } else {
                const errStreamId = crypto.randomUUID();
                await sendWithTimeout(() => wsClient.replyStream(_frame, errStreamId, fullReply, true), 30000);
              }
              logger.info('Claude 后备回复已发送', { fromUser, isGroup: _isGroup });
            } catch (fallbackSendErr) {
              logger.error('后备回复发送失败', { error: fallbackSendErr.message });
            }
          }
        });
      },
    });
  });


  // ─── 文件 / 图片 / 语音 消息处理 ──────────────────────────────────────────────
  //
  // 设计原则：
  //   文件/图片 → 下载保存到 data/uploads/YYYY-MM-DD/ → 写入 chatHistory 作为系统记录
  //             → 回复"已存好，等你指令"，下条消息 Lucas 自动从 chatHistory 前缀看到文件信息
  //   语音     → WeChat 已转录成文字，直接当文本发给 Lucas

  async function handleMediaMessage(frame, mediaType) {
    // 去重：网络抖动时企业微信会重推同一 msgid
    if (isDuplicateMsg(frame.body?.msgid)) {
      logger.info('Bot 媒体消息去重跳过', { mediaType, msgId: frame.body?.msgid });
      return;
    }

    const fromUser = frame.body?.from?.userid || 'unknown';
    const chatId   = frame.body?.chatid;
    const isGroup  = !!chatId;
    const body     = frame.body;

    // 演示群：不处理媒体消息，给友好提示
    if (isGroup && isDemoGroup(chatId)) {
      try {
        await wsClient.sendMessage(chatId, {
          msgtype: 'markdown',
          markdown: { content: '演示版暂时只支持文字消息，请直接输入文字提问～' },
        });
      } catch {}
      return;
    }

    const member     = familyMembers[fromUser];
    const channel    = isGroup ? '群聊' : '私聊';
    const memberTag  = member ? `【${channel}·${member.role}${member.name}】` : `【${channel}·${fromUser}】`;
    const memberName = member ? `${member.role}${member.name}` : fromUser;

    const mediaBody = body[mediaType];
    if (!mediaBody?.url) {
      logger.warn('handleMediaMessage: 无 url，忽略', { fromUser, mediaType });
      return;
    }

    // 视频大小预检（快速 HEAD，不阻塞主流程）
    if (mediaType === 'video') {
      try {
        const headResp = await axios.head(mediaBody.url, { timeout: 8000 });
        const size = parseInt(headResp.headers['content-length'] || '0', 10);
        if (size > 50 * 1024 * 1024) {
          logger.warn('Bot 视频超过 50MB，拒绝', { size, fromUser });
          const msg = '视频文件超过 50MB，我暂时没法处理这么大的视频。可以把视频压缩一下再发，或者直接告诉我视频里说了什么～';
          const streamId = crypto.randomUUID();
          isGroup
            ? await wsClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: msg } })
            : await wsClient.replyStream(frame, streamId, msg, true);
          return;
        }
      } catch (_) { /* HEAD 失败继续，交给 TaskManager 处理 */ }
    }

    // ── 1. 立即 ACK（< 1秒，不等任何处理结果）────────────────────────────────
    const ACK_MSGS = {
      video: '视频收到了～正在转录语音，完成后马上告诉你内容（大约 1-2 分钟）。',
      image: '图片收到了～正在识别内容，稍等一下。',
      file:  '文件收到了～稍等处理。',
    };
    const ackMsg  = ACK_MSGS[mediaType] || '收到了～稍等。';
    const streamId = crypto.randomUUID();
    try {
      isGroup
        ? await wsClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: ackMsg } })
        : await wsClient.replyStream(frame, streamId, ackMsg, true);
    } catch (e) {
      // ACK 失败不中断任务创建（response_url 可能已过期，但任务仍要处理）
      logger.warn('handleMediaMessage ACK 发送失败', { fromUser, mediaType, error: e?.message });
    }

    // ── 2. 写 ACK 到 chatHistory（在 await 之前完成，不存在竞态）─────────────
    const histKey    = chatHistoryKey(isGroup, chatId, fromUser) + ':' + streamId;
    const mediaLabel = mediaType === 'video' ? '视频' : mediaType === 'image' ? '图片' : '文件';
    appendChatHistory(histKey, `${memberTag}发了一个${mediaLabel}`, ackMsg);

    // ── 3. 创建任务并入队（per-user 串行，异步执行）────────────────────────────
    const taskType = mediaType === 'video' ? 'video_transcription'
                   : mediaType === 'image' ? 'image_analysis'
                   : 'file_processing';

    // PDF 文件单独标记，TaskManager _execFile 完成后由 Notifier 走 homework 对话流
    const isPdf = mediaType === 'file' &&
      (body.file?.filename || '').toLowerCase().endsWith('.pdf');

    taskManager.enqueue({
      type:       taskType,
      userId:     fromUser,
      chatId,
      isGroup,
      histKey,
      streamId,
      memberTag,
      memberName,
      isPdf,
      input: {
        url:      mediaBody.url,
        aeskey:   mediaBody.aeskey,
        filename: body[mediaType]?.filename || '',
        mediaType,
      },
    });

    logger.info('handleMediaMessage 任务已入队', { fromUser, mediaType, taskType });
  }

  const safeHandle = (fn) => (...args) => fn(...args).catch(e => logger.error('媒体处理未捕获异常', { error: e?.message || String(e) }));
  wsClient.on('message.file',  safeHandle((frame) => handleMediaMessage(frame, 'file')));
  wsClient.on('message.image', safeHandle((frame) => handleMediaMessage(frame, 'image')));
  // SDK 不发 message.video，video 走通用 message 事件
  wsClient.on('message', safeHandle(async (frame) => {
    if (frame.body?.msgtype === 'video') await handleMediaMessage(frame, 'video');
  }));

  // 图文混排消息：用户在群里 @机器人 并同时发送图片+文字时触发（msgtype=mixed）
  wsClient.on('message.mixed', safeHandle(async (frame) => {
    const fromUser = frame.body?.from?.userid || 'unknown';
    const chatId   = frame.body?.chatid;
    const isGroup  = !!chatId;
    const items    = frame.body?.mixed?.msg_item || [];

    const member     = familyMembers[fromUser];
    const channel    = isGroup ? '群聊' : '私聊';
    const memberTag  = member ? `【${channel}·${member.role}${member.name}】` : `【${channel}·${fromUser}】`;
    const memberName = member ? `${member.role}${member.name}` : fromUser;

    // 提取文本部分，并去掉 @启灵 前缀
    const rawText = items
      .filter(it => it.msgtype === 'text')
      .map(it => it.text?.content || '')
      .join(' ')
      .replace(/^@启灵\s*/g, '')
      .replace(/^@啟靈\s*/g, '')
      .trim();

    // 提取图片部分
    const imageItems = items.filter(it => it.msgtype === 'image' && it.image?.url);

    logger.info('Bot 收到图文混排消息', { fromUser, isGroup, textLen: rawText.length, imageCount: imageItems.length });

    if (imageItems.length === 0 && !rawText) return;

    // 若只有文字（无图），退化为文本处理：不触发 message.text 是因为 SDK 两者互斥
    if (imageItems.length === 0) {
      // 直接透传给 Lucas 作为文本
      const histKey = chatHistoryKey(isGroup, chatId, fromUser);
      const historyMessages = buildHistoryWithCrossChannel(isGroup, histKey);
      const msgId = frame.body?.msgid || crypto.randomUUID();
      const wecomUserId = isGroup ? `group:${chatId}:${fromUser}:${msgId}` : fromUser;
      const replyText = await callGatewayAgent('lucas', `${memberTag}${rawText}`, wecomUserId, 180000, historyMessages) || '收到～';
      appendChatHistory(histKey, `${memberTag}${rawText}`, replyText);
      const streamId = crypto.randomUUID();
      if (isGroup) {
        await wsClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: replyText } });
      } else {
        await wsClient.replyStream(frame, streamId, replyText, true);
      }
      return;
    }

    // 逐张图片下载 + GLM vision 分析
    const imageDescs = [];
    const dateStr = todayCST();
    const uploadDir = path.join(HOMEAI_ROOT, 'data', 'uploads', dateStr, 'images');
    fs.mkdirSync(uploadDir, { recursive: true });

    for (let i = 0; i < imageItems.length; i++) {
      const imgItem = imageItems[i];
      try {
        const { buffer } = await wsClient.downloadFile(imgItem.image.url, imgItem.image.aeskey);
        const savePath = path.join(uploadDir, `${Date.now()}-mixed_img${i + 1}.jpg`);
        fs.writeFileSync(savePath, buffer);
        const desc = await describeImageWithLlava(savePath);
        if (desc) {
          try { fs.writeFileSync(savePath + '.desc.txt', desc, 'utf8'); } catch {}
          imageDescs.push(desc);
        } else {
          imageDescs.push('（图片识别失败）');
        }
      } catch (e) {
        logger.warn('混排图片下载/识别失败', { error: e?.message, i });
        imageDescs.push('（图片下载失败）');
      }
    }

    // 组装发给 Lucas 的消息
    const histKey = chatHistoryKey(isGroup, chatId, fromUser);
    const historyMessages = buildHistoryWithCrossChannel(isGroup, histKey);
    const msgId = frame.body?.msgid || crypto.randomUUID();
    const wecomUserId = isGroup ? `group:${chatId}:${fromUser}:${msgId}` : fromUser;

    const imgSection = imageDescs.map((d, i) =>
      `【图片${imageDescs.length > 1 ? i + 1 : ''}内容（AI视觉识别）】\n${d}`
    ).join('\n\n');

    const textSection = rawText ? `${memberTag}说：${rawText}\n\n` : `${memberTag}发了图片：\n\n`;
    const messageToLucas = `${textSection}${imgSection}\n\n请基于以上图片识别内容和文字回复家人。禁止用 read_file 访问图片路径。`;

    appendChatHistory(histKey, `${memberTag}发了图文消息`, `[系统] 图文混排：文字=${rawText || '无'}，图片=${imageDescs.length}张`);

    const replyText = await callGatewayAgent('lucas', messageToLucas, wecomUserId, 180000, historyMessages) || '收到～';
    const streamId = crypto.randomUUID();
    if (isGroup) {
      await wsClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: replyText } });
    } else {
      await wsClient.replyStream(frame, streamId, replyText, true);
    }
    logger.info('Bot 已回复（图文混排）', { fromUser, imageCount: imageDescs.length });
  }));

  // 语音消息：WeChat 已转录，直接当文本给 Lucas
  wsClient.on('message.voice', async (frame) => {
    const fromUser  = frame.body?.from?.userid || 'unknown';
    const chatId    = frame.body?.chatid;
    const isGroup   = !!chatId;
    const voiceText = frame.body?.voice?.content || '';

    // 去重：网络抖动时企业微信会重推同一 msgid
    if (isDuplicateMsg(frame.body?.msgid)) {
      logger.info('Bot 语音消息去重跳过', { fromUser, msgId: frame.body?.msgid });
      return;
    }

    if (!voiceText) return;

    // 演示群：不处理语音，给友好提示
    if (isGroup && isDemoGroup(chatId)) {
      try {
        await wsClient.sendMessage(chatId, {
          msgtype: 'markdown',
          markdown: { content: '演示版暂时只支持文字消息，请直接输入文字提问～' },
        });
      } catch {}
      return;
    }

    const member     = familyMembers[fromUser];
    const channel    = isGroup ? '群聊' : '私聊';
    const memberTag  = member ? `【${channel}·${member.role}${member.name}】` : `【${channel}·${fromUser}】`;
    const histKey    = chatHistoryKey(isGroup, chatId, fromUser);
    const historyMessages = buildHistoryWithCrossChannel(isGroup, histKey);

    logger.info('Bot 收到语音消息', { fromUser, voiceText: voiceText.substring(0, 60) });

    const msgId       = frame.body?.msgid || crypto.randomUUID();
    const wecomUserId = isGroup ? `group:${chatId}:${fromUser}:${msgId}` : fromUser;
    const messageToLucas = `${memberTag}（语音）${voiceText}`;

    const sendWithTimeout = (fn, ms = 15000) =>
      Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`sendMessage timeout ${ms}ms`)), ms))]);

    try {
      const replyText = await callGatewayAgent('lucas', messageToLucas, wecomUserId, 180000, historyMessages) || '收到～';
      const wecomSafeReply = stripMarkdownForWecom(replyText);  // 剥离 <think> 块等，统一入口
      appendChatHistory(histKey, `${memberTag}（语音）${voiceText}`, wecomSafeReply);

      // [VOICE] / [RAP] 检测（与文字消息路径对齐）
      const hasVoiceTag = wecomSafeReply.includes('[VOICE]');
      const hasRapTag   = wecomSafeReply.includes('[RAP]');
      const needVoice   = hasVoiceTag || hasRapTag;
      const ttsText     = stripMarkdownForVoice(wecomSafeReply);  // TTS 始终用干净文本
      const displayText = needVoice ? ttsText : wecomSafeReply;   // 有标记时展示也用干净文本
      const ttsStyle    = hasRapTag ? 'rap' : 'normal';
      const voiceTarget = isGroup ? chatId : fromUser;

      const streamId = crypto.randomUUID();
      if (isGroup) {
        // 群消息限流：同一群 5s 内只发一条，避免 errcode=846607
        const now  = Date.now();
        const last = groupBotLastSend.get(chatId) || 0;
        if (now - last < GROUP_BOT_MIN_INTERVAL_MS) {
          await new Promise(r => setTimeout(r, GROUP_BOT_MIN_INTERVAL_MS - (now - last)));
        }
        groupBotLastSend.set(chatId, Date.now());
        await wsClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: displayText } });
        // 群聊：仅 [VOICE]/[RAP] 时发语音
        if (needVoice) sendVoiceChunks(voiceTarget, ttsText, ttsStyle).catch(() => {});
      } else {
        await sendWithTimeout(() => wsClient.replyStream(frame, streamId, displayText, true), 30000);
        // 私聊语音输入：无论是否有 [VOICE] 标记，总追加一条语音（镜像模式）
        sendVoiceChunks(fromUser, ttsText, ttsStyle).catch(() => {});
      }
      logger.info('Bot 已回复（语音）', { fromUser, isGroup, needVoice });
    } catch (e) {
      logger.error('语音消息处理失败', { error: e?.message || String(e), fromUser });
    }
  });

  wsClient.on('error', (err) => {
    logger.error('智能机器人 WebSocket 错误', { error: err.message });
  });

  wsClient.on('reconnecting', (attempt) => {
    logger.info('智能机器人重连中', { attempt });
  });

  // 建立长连接
  wsClient.connect();

  return wsClient;
}

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

let globalBotClient = null;   // bot 长连接实例，启动后赋值
let globalBotReady  = false;  // 认证成功后置 true

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

// ─── 长流程任务管理器 ─────────────────────────────────────────────────────────
const taskManager = new TaskManager({
  homeaiRoot:           HOMEAI_ROOT,
  logger,
  callGatewayAgent,
  appendChatHistory,
  transcribeLocalVideo,
  describeImageWithLlava,
  getFamilyMembers:     () => familyMembers,
  getBotClient:         () => globalBotClient,
});
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

// 群消息发送限流：避免 errcode=846607（aibot 频率限制）
// WeCom aibot 同一群每次发送间隔至少 5s，否则触发频率限制静默丢弃
const groupBotLastSend = new Map(); // chatId -> timestamp
const GROUP_BOT_MIN_INTERVAL_MS = 5000;

// 等待 bot 认证就绪（最多等 waitMs 毫秒）
function waitBotReady(waitMs = 15000) {
  if (globalBotReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + waitMs;
    const check = setInterval(() => {
      if (globalBotReady) { clearInterval(check); resolve(); }
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
    if (!globalBotClient) throw new Error('bot 客户端未初始化');
    const filename = path.basename(absPath);
    const buffer = fs.readFileSync(absPath);
    // 上传素材，获取 media_id（3天内有效）
    const uploaded = await globalBotClient.uploadMedia(buffer, { type: 'file', filename });
    const mediaId = uploaded.media_id;
    // 先发说明文字（可选）— 私聊 userId 不支持 sendMessage text/markdown（errcode=40008），跳过
    if (text && target.startsWith('wr')) {  // chatId 以 wr 开头（群聊）
      await globalBotClient.sendMessage(target, { msgtype: 'markdown', markdown: { content: text } });
    }
    // 发文件
    await globalBotClient.sendMediaMessage(target, 'file', mediaId);
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

// ─── SE 流水线任务看板（Main 专属，全量视图 + 叫停 + 批准）────────────────────
// 认证：X-SE-Token 必须等于 WECOM_OWNER_ID（SE 身份）
function verifySEToken(req, res) {
  const token = (req.headers['x-se-token'] || '').trim();
  if (!token || token !== WECOM_OWNER_ID) {
    res.status(403).json({ success: false, message: 'SE 身份验证失败' });
    return false;
  }
  return true;
}
// readTaskRegistry / writeTaskRegistry / inferTaskAgent → lib/task-registry.js

// GET /api/main/pipeline-tasks — SE 看全量任务（所有 submittedBy，含系统生成的）
app.get('/api/main/pipeline-tasks', (req, res) => {
  if (!verifySEToken(req, res)) return;
  const entries = readTaskRegistry();
  // 按状态排序：pending-review → queued → running → completed/failed（最近的在前）
  const order = { 'pending-review': 0, queued: 1, running: 2, completed: 3, failed: 4, cancelled: 5 };
  entries.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || new Date(b.submittedAt) - new Date(a.submittedAt));
  res.json({ success: true, total: entries.length, tasks: entries });
});

// POST /api/main/pipeline-tasks/:id/approve — pending-review → queued（SE 批准）
app.post('/api/main/pipeline-tasks/:id/approve', (req, res) => {
  if (!verifySEToken(req, res)) return;
  const { id } = req.params;
  const entries = readTaskRegistry();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: '任务不存在' });
  if (entries[idx].status !== 'pending-review') {
    return res.status(400).json({ success: false, message: `当前状态 ${entries[idx].status}，只有 pending-review 可批准` });
  }
  entries[idx].status = 'queued';
  entries[idx].approvedAt = new Date().toISOString();
  entries[idx].approvedBy = 'se';
  writeTaskRegistry(entries);
  logger.info('SE 批准任务进队列', { taskId: id, title: entries[idx].title });
  res.json({ success: true, task: entries[idx] });
});

// POST /api/main/pipeline-tasks/:id/cancel — SE 叫停任意任务（不受 submittedBy 限制）
app.post('/api/main/pipeline-tasks/:id/cancel', (req, res) => {
  if (!verifySEToken(req, res)) return;
  const { id } = req.params;
  const { reason = 'SE 叫停' } = req.body || {};
  const entries = readTaskRegistry();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: '任务不存在' });
  if (['completed', 'cancelled'].includes(entries[idx].status)) {
    return res.status(400).json({ success: false, message: `任务已 ${entries[idx].status}，无法叫停` });
  }
  const prevStatus = entries[idx].status;
  entries[idx].status = 'cancelled';
  entries[idx].cancelledAt = new Date().toISOString();
  entries[idx].cancelledBy = 'se';
  entries[idx].cancelReason = reason;
  writeTaskRegistry(entries);
  logger.info('SE 叫停任务', { taskId: id, prevStatus, reason });
  res.json({ success: true, task: entries[idx] });
});

// POST /api/demo-proxy/submit-requirement — 访客提交开发需求
app.post('/api/demo-proxy/submit-requirement', async (req, res) => {
  const { requirement, visitorCode } = req.body || {};
  if (!requirement || !visitorCode) {
    return res.status(400).json({ success: false, message: '缺少 requirement 或 visitorCode' });
  }
  const code = visitorCode.trim().toUpperCase();
  try {
    // 验证邀请码是否有效
    const invites = loadInvites();
    const inviteEntry = Object.entries(invites).find(([token]) => token.toUpperCase() === code);
    if (!inviteEntry) {
      return res.status(401).json({ success: false, message: '邀请码无效' });
    }
    const visitorName = inviteEntry[1].name;
    const wecomUserId = `visitor:${code}`;

    // 生成需求 ID（与 trigger_development_pipeline 保持一致）
    const requirementId = `req_${Date.now()}`;

    // 写入 task-registry.json（模拟 upsertTaskRegistry）
    const TASK_REGISTRY_FILE = path.join(HOMEAI_ROOT, 'data/learning/task-registry.json');
    let entries = [];
    try {
      if (fs.existsSync(TASK_REGISTRY_FILE)) {
        entries = JSON.parse(fs.readFileSync(TASK_REGISTRY_FILE, 'utf8'));
      }
    } catch {}
    const nowCST = new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00');
    const idx = entries.findIndex(e => e.id === requirementId);
    const entry = {
      id: requirementId,
      requirement,
      submittedBy: wecomUserId,
      submittedAt: nowCST,
      status: 'running',
      currentPhase: 'andy_designing',
      visitorCode: code,
    };
    if (idx >= 0) entries[idx] = entry; else entries.push(entry);
    fs.writeFileSync(TASK_REGISTRY_FILE, JSON.stringify(entries, null, 2), 'utf8');

    // 异步触发 Andy 流水线（fire-and-forget）
    const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:18789';
    const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
    const andyMessage = [
      `【访客开发需求 · ${requirementId}】`,
      `访客：${visitorName}（${code}）`,
      ``,
      requirement,
      ``,
      `请按顺序完成以下步骤：`,
      `1. 调用 research_task 调研技术背景和可行性`,
      `2. 输出完整 Implementation Spec`,
      `3. 调用 trigger_lisa_implementation，传入 spec、user_id="${wecomUserId}"、requirement_id="${requirementId}"`,
      ``,
      `完成后用一句话总结规划方案。`,
    ].join('\n');

    fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'x-openclaw-agent-id': 'andy',
      },
      body: JSON.stringify({
        model: 'openclaw/andy',
        messages: [{ role: 'user', content: andyMessage }],
        stream: false,
      }),
    }).catch(err => logger.error('submit-requirement: Andy trigger failed', { err: err.message }));

    logger.info('访客需求已提交', { visitorCode: code, visitorName, requirementId, requirement: requirement.slice(0, 50) });
    res.json({ success: true, message: '需求已提交，我们会尽快处理' });
  } catch (e) {
    logger.error('submit-requirement error', { error: e.message, visitorCode: code });
    res.status(500).json({ success: false, message: '提交失败，请稍后重试' });
  }
});

const FAMILY_GROUP_CHAT_ID = process.env.WECOM_FAMILY_GROUP_CHAT_ID || 'wra6wXbgAAu_7v2qu1wnc8Lu3-Za3diQ';

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
  const resolvedTarget = isGroupSend ? FAMILY_GROUP_CHAT_ID : userId;

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
      appendChatHistory(chatHistoryKey(true, FAMILY_GROUP_CHAT_ID, null), '[启灵主动发送]', displayText);
      logger.info('群消息已发送', { chatId: FAMILY_GROUP_CHAT_ID, channel: 'bot', actor: 'lucas' });
    } else {
      appendChatHistory(chatHistoryKey(false, null, userId), '[启灵主动发送]', displayText);
      logger.info('主动发消息已发送', { userId, channel: 'bot', actor: 'lucas' });
    }
    // 语音：显式 voiceText 或 [VOICE]/[RAP] 标记，fire-and-forget
    const voiceTarget = isGroupSend ? FAMILY_GROUP_CHAT_ID : userId;
    if (voiceText) {
      sendVoiceChunks(voiceTarget, voiceText).catch(() => {});
    } else if (needVoice) {
      sendVoiceChunks(voiceTarget, displayText, ttsStyle).catch(() => {});
    }
    res.json({ success: true, userId: resolvedTarget });
  } catch (botErr) {
    const errMsg = botErr instanceof Error ? botErr.message : (botErr?.errmsg || JSON.stringify(botErr));
    const dest = isGroupSend ? `家庭群(${FAMILY_GROUP_CHAT_ID})` : userId;
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
