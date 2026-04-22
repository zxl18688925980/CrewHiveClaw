'use strict';
/**
 * agent-client.js — Gateway / 模型直调 客户端层
 *
 * 包含：callGatewayAgent / readAgentModelConfig / callAgentModel / callClaudeFallback
 *
 * 工厂函数：module.exports = (logger, deps) => ({ ... })
 * 调用方：
 *   const _agentClientFactory = require('./lib/agent-client');
 *   const ac = _agentClientFactory(logger, { GATEWAY_URL, GATEWAY_TOKEN });
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

module.exports = function createAgentClient(logger, { GATEWAY_URL, GATEWAY_TOKEN }) {

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
  // GPT-5 系列（及部分新 OpenAI 模型）用 max_completion_tokens，其余用 max_tokens
  const isOpenAI = completionsUrl.includes('api.openai.com');
  const tokenParam = isOpenAI ? { max_completion_tokens: maxTokens } : { max_tokens: maxTokens };
  const resp = await fetch(completionsUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model, ...tokenParam, messages: [{ role: 'system', content: systemPrompt }, ...messages] }),
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

let _lucasSoulCache = null;
function getLucasSoul() {
  if (_lucasSoulCache) return _lucasSoulCache;
  try {
    const soulPath = path.join(process.env.HOME, '.openclaw/workspace-lucas/SOUL.md');
    _lucasSoulCache = fs.readFileSync(soulPath, 'utf8');
  } catch {
    _lucasSoulCache = '你是一位智能助理，请友好自然地回答用户的问题。';
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


  return {
    callGatewayAgent,
    readAgentModelConfig,
    callAgentModel,
    callClaudeFallback,
  };
};
