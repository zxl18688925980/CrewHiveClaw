'use strict';
/**
 * bot-connection.js — 智能机器人 WebSocket 长连接层
 *
 * 包含：startBotLongConnection (WSClient 启动 + 全部消息事件处理)
 * 双通道 B：家庭群 @启灵 + 成员私聊 → Lucas
 *
 * 工厂函数：module.exports = (logger, deps) => startBotLongConnection
 * deps: {
 *   WECOM_BOT_ID, WECOM_BOT_SECRET, HOMEAI_ROOT, PORT, WECOM_OWNER_ID,
 *   setGlobalBotReady, setGlobalBotClient,
 *   getFamilyMembers, getTaskManager, getDemoGroupConfig, isDemoGroup,
 *   groupBotLastSend, GROUP_BOT_MIN_INTERVAL_MS,
 *   _gatewayDownNotifiedAt_ref, GATEWAY_DOWN_NOTIFY_INTERVAL_MS,
 *   callGatewayAgent, callAgentModel, callClaudeFallback,
 *   botSend, sendWeComMessage, sendWeComGroupMessage, getAccessToken,
 *   sendVoiceChunks, splitTtsChunks, isDuplicateMsg, enqueueUserRequest,
 *   transcriptionBuffer, checkReplyRepetition, messageAggregator,
 *   stripMarkdownForWecom, stripMarkdownForVoice, stripInternalTerms,
 *   appendChatHistory, chatHistoryKey, buildHistoryWithCrossChannel,
 *   executeMainTool, handleMainCommand,
 *   parseDouyinShareText, scrapeVideoContent, scrapeDouyinContent,
 *   transcribeDouyinAudio, transcribeLocalVideo, analyzeDouyinFrames,
 *   formatVideoInjection, scrapeWechatArticle, describeImageWithLlava,
 *   VIDEO_URL_RE, DOUYIN_URL_RE, FRAME_ANALYSIS_RE,
 *   runMainMonitorLoop,
 * }
 */
const { WSClient } = require('@wecom/aibot-node-sdk');

module.exports = function createBotConnection(logger, deps) {
  const {
    WECOM_BOT_ID, WECOM_BOT_SECRET, HOMEAI_ROOT, PORT, WECOM_OWNER_ID,
    setGlobalBotReady, setGlobalBotClient,
    getFamilyMembers, getTaskManager, getDemoGroupConfig, isDemoGroup,
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
  } = deps;

  // _gatewayDownNotifiedAt is a mutable ref object { value: 0 }
  // so both index.js and this module share the same counter
  function getGatewayDownNotifiedAt() { return _gatewayDownNotifiedAt_ref.value; }
  function setGatewayDownNotifiedAt(v) { _gatewayDownNotifiedAt_ref.value = v; }

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
    getTaskManager().setWsClient(wsClient);
  });

  wsClient.on('authenticated', () => {
    logger.info('智能机器人认证成功，开始接收家庭消息');
    setGlobalBotReady(true);
  });

  wsClient.on('disconnected', () => {
    setGlobalBotReady(false);
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
    const member    = getFamilyMembers()[fromUser];
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
        const demoReply = await callAgentModel('lucas', getDemoGroupConfig().systemPrompt, [
          { role: 'user', content: text }
        ], getDemoGroupConfig().maxTokens);
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
              if (now - getGatewayDownNotifiedAt() > GATEWAY_DOWN_NOTIFY_INTERVAL_MS) {
                setGatewayDownNotifiedAt(now);
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

    const member     = getFamilyMembers()[fromUser];
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

    getTaskManager().enqueue({
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

    const member     = getFamilyMembers()[fromUser];
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

    const member     = getFamilyMembers()[fromUser];
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


  return startBotLongConnection;
};
