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
const { chromium }   = require('playwright');
const { TaskManager } = require('./task-manager');
require('dotenv').config();

// ── 时区统一：所有时间戳使用 CST（UTC+8）──
const nowCST   = () => new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00');
const todayCST = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);

// ─── 全局路径常量（必须在任何函数定义之前）────────────────────────────────────
const HOMEAI_ROOT    = path.join(__dirname, '../../../../..');
const WHISPER_MODEL  = path.join(HOMEAI_ROOT, 'Models/whisper/ggml-base.bin');
const COOKIES_FILE   = path.join(HOMEAI_ROOT, 'config/douyin-cookies.txt');

// 视频平台 URL 正则
// yt-dlp 可处理的平台（YouTube / Bilibili / 微博 / 小红书）
const VIDEO_URL_RE   = /https?:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/|bilibili\.com\/video|b23\.tv\/|m\.weibo\.cn\/status\/|weibo\.com\/tv\/|video\.weibo\.com\/|t\.cn\/|xiaohongshu\.com\/(explore|discovery)|xhslink\.com\/)[^\s]*/i;
// 抖音单独处理（移动端分享页方案，无需登录/签名）
const DOUYIN_URL_RE  = /https?:\/\/(v\.douyin\.com\/|www\.douyin\.com\/video)[^\s]*/i;

/**
 * 从抖音分享文本中提取视频标题/摘要。
 * 抖音分享格式通常为：「6.64 复制打开抖音，看看【作者的作品】标题... URL」
 * 返回 { shareText, title } 或 null（仅 URL，无可用文本）
 */
function parseDouyinShareText(fullText, url) {
  // 去掉 URL 本身及之后内容
  const textBeforeUrl = fullText.replace(url, '').trim();
  // 去掉「X.XX 复制打开抖音，看看」等前缀噪音
  const cleaned = textBeforeUrl
    .replace(/^\d+\.\d+\s*复制打开抖音[，,]看看\s*/u, '')
    .replace(/^复制打开抖音[，,]看看\s*/u, '')
    .trim();
  if (!cleaned || cleaned.length < 4) return null;
  // 尝试提取【作者】后的标题
  const titleMatch = cleaned.match(/【[^】]+】(.+)/u);
  const title = titleMatch ? titleMatch[1].trim() : cleaned;
  return { shareText: cleaned, title };
}

/**
 * 用 yt-dlp 提取视频元数据 + 字幕，返回 { title, uploader, duration, desc, transcript } 或 null
 * transcript 优先取自动字幕（前 1000 字），无字幕则取 description 前 500 字
 *
 * 抖音需要登录态 cookie：
 *   方法一（推荐）：在 Chrome 登录抖音，yt-dlp 自动读取
 *   方法二（备用）：用浏览器插件导出 cookies.txt，保存到 HomeAI/config/douyin-cookies.txt
 */
async function scrapeVideoContent(url) {
  const YT_DLP        = '/opt/homebrew/bin/yt-dlp';
  const COOKIES_FILE  = path.join(HOMEAI_ROOT, 'config/douyin-cookies.txt');
  const { execFileSync } = require('child_process');

  // 尝试顺序：① cookies 文件 → ② Chrome 浏览器 cookies → ③ 裸跑（YouTube/Bilibili 不需要登录）
  let meta = null;
  const baseArgs   = ['--dump-json', '--no-download', '--quiet', url];
  const tryArgs    = [
    ...(fs.existsSync(COOKIES_FILE) ? [['--cookies', COOKIES_FILE, ...baseArgs]] : []),
    ['--cookies-from-browser', 'chrome', ...baseArgs],
    baseArgs,
  ];

  for (const args of tryArgs) {
    try {
      const raw = execFileSync(YT_DLP, args, { encoding: 'utf8', timeout: 30000 });
      meta = JSON.parse(raw.trim());
      break;
    } catch {}
  }

  if (!meta) return null;

  const title    = meta.title || '';
  const uploader = meta.uploader || meta.channel || '';
  const duration = meta.duration ? `${Math.floor(meta.duration / 60)}分${meta.duration % 60}秒` : '';
  const desc     = (meta.description || '').slice(0, 300);

  // 尝试提取自动字幕（中文优先，回落英文）
  let transcript = '';
  const tmpBase = `/tmp/yt-dlp-sub-${Date.now()}`;
  try {
    const subArgs = [
      '--no-download', '--quiet',
      '--write-auto-subs', '--sub-format', 'vtt',
      '--sub-langs', 'zh,zh-Hans,zh-CN,en',
      '-o', tmpBase + '.%(ext)s',
      url,
    ];
    execFileSync(YT_DLP, subArgs, { encoding: 'utf8', timeout: 30000 });

    // 找生成的 vtt 文件
    const { execSync } = require('child_process');
    const subFiles = execSync(`ls ${tmpBase}*.vtt 2>/dev/null || true`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    if (subFiles.length) {
      const vtt = fs.readFileSync(subFiles[0], 'utf8');
      // 去掉 VTT 头和时间戳行，提取纯文本
      transcript = vtt
        .split('\n')
        .filter(l => l.trim() && !l.startsWith('WEBVTT') && !l.match(/^\d{2}:\d{2}/) && !l.match(/^\d+$/))
        .join(' ')
        .replace(/<[^>]+>/g, '')
        .replace(/\s+/g, ' ')
        .slice(0, 1000);
      // 清理临时文件
      for (const f of subFiles) { try { fs.unlinkSync(f); } catch {} }
    }
  } catch {}

  return { title, uploader, duration, desc, transcript };
}

const DOUYIN_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TikTok/26.2.0 iPhone13,3';
const DOUYIN_HEADERS = {
  'User-Agent': DOUYIN_MOBILE_UA,
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': 'https://www.douyin.com/',
};
const WHISPER_CLI   = '/opt/homebrew/bin/whisper-cli';
// WHISPER_MODEL 依赖 HOMEAI_ROOT，在其定义后声明（见下方）

// TTS 配置
const TTS_PYTHON    = '/opt/homebrew/opt/python@3.11/bin/python3.11';  // edge-tts 安装在 3.11
const TTS_VOICE     = 'zh-CN-YunxiNeural';  // 普通话男声，edge-tts fallback 用
const LOCAL_TTS_URL = 'http://127.0.0.1:8082/tts';  // 本地 TTS 服务（优先，PM2: local-tts）

// 触发帧分析的关键词（家人说「看画面/截图/图片/文字」等时激活 LLaVA）
const FRAME_ANALYSIS_RE = /画面|截图|图片|文字|写的|画的|屏幕|PPT|幻灯|看看图/u;

/**
 * 通过移动端分享页提取抖音视频元数据 + 音频转录（+ 可选画面分析）
 * 流程：
 *   1. 短链 → 跟随跳转 → 提取 videoId
 *   2. iesdouyin.com/share/video/{id}/ → HTML 提取 desc/nickname/CDN URL
 *   3. ffmpeg 只提取音频（视频不落盘） → whisper-cli 中文 ASR → transcript
 *   4. 若 withFrames=true：ffmpeg 抽帧 → LLaVA 逐帧描述 → frameDesc
 * 返回 { title, uploader, desc, transcript, frameDesc } 或 null
 */
async function scrapeDouyinContent(url, { withFrames = false } = {}) {
  try {
    // Step 1: 提取 videoId
    let videoId = null;
    const directIdMatch = url.match(/\/video\/(\d{15,20})/);
    if (directIdMatch) {
      videoId = directIdMatch[1];
    } else {
      const resp = await axios.get(url, {
        headers: DOUYIN_HEADERS, maxRedirects: 5, timeout: 15000, validateStatus: () => true,
      });
      const finalUrl = resp.request?.res?.responseUrl || url;
      const m = finalUrl.match(/\/video\/(\d{15,20})/);
      if (m) videoId = m[1];
    }
    if (!videoId) {
      logger.warn('scrapeDouyinContent: videoId 提取失败，短链未跳转到 /video/{id}', { url });
      return { error: '短链跳转失败，无法识别视频ID，可能是链接已过期或格式错误' };
    }

    // Step 2: 分享页 HTML → 元数据 + CDN URL
    // iesdouyin.com 已改为客户端渲染（2026-04），视频数据嵌在 window._ROUTER_DATA 里
    const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;
    const resp2 = await axios.get(shareUrl, {
      headers: DOUYIN_HEADERS, timeout: 15000, validateStatus: () => true,
    });
    const html = typeof resp2.data === 'string' ? resp2.data : JSON.stringify(resp2.data);

    // 新路径：解析 window._ROUTER_DATA → videoInfoRes.item_list[0]
    let desc = '';
    let uploader = '';
    let cdnUrl = null;
    const rdMatch = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})(?=\s*<\/script>)/);
    if (rdMatch) {
      try {
        const rd = JSON.parse(rdMatch[1]);
        const page = rd.loaderData && rd.loaderData['video_(id)/page'];
        const item = page && page.videoInfoRes && page.videoInfoRes.item_list && page.videoInfoRes.item_list[0];
        if (item) {
          desc = item.desc || '';
          uploader = (item.author && item.author.nickname) || '';
          // download_addr 最通用（直接下载 URL），优先用它
          // play_addr 有 playwm（水印版，需特殊 Referer），降级备选
          const downloadUrls = item.video && item.video.download_addr && item.video.download_addr.url_list || [];
          const playUrls = item.video && item.video.play_addr && item.video.play_addr.url_list || [];
          cdnUrl = downloadUrls[0] || playUrls.find(u => !u.includes('playwm')) || playUrls[0] || null;
          // 构建 play（无水印）URL：从 playwm URL 去掉 "wm" 后缀
          if (cdnUrl && cdnUrl.includes('playwm')) {
            const playUrl = cdnUrl.replace('/playwm/', '/play/');
            if (playUrl !== cdnUrl) cdnUrl = playUrl;
          }
          if (cdnUrl) {
            logger.info('scrapeDouyinContent: CDN URL', { videoId, url: cdnUrl.slice(0, 80), isPlaywm: cdnUrl.includes('playwm') });
          }
          logger.info('scrapeDouyinContent: _ROUTER_DATA 解析成功', { videoId, desc: desc.slice(0, 40), hasCdn: !!cdnUrl });
        } else {
          const filterReason = page && page.videoInfoRes && page.videoInfoRes.filter_list && page.videoInfoRes.filter_list[0] && page.videoInfoRes.filter_list[0].filter_reason;
          logger.warn('scrapeDouyinContent: item_list 为空', { videoId, filterReason });
        }
      } catch (parseErr) {
        logger.warn('scrapeDouyinContent: _ROUTER_DATA 解析失败', { error: parseErr.message });
      }
    }

    // 旧路径降级：_ROUTER_DATA 不存在时，尝试直接扫正则（兼容旧格式）
    if (!desc) {
      const descMatch = html.match(/"desc"\s*:\s*"((?:[^"\\]|\\.)*)"/);
      const nickMatch = html.match(/"nickname"\s*:\s*"((?:[^"\\]|\\.){1,80})"/);
      if (descMatch && descMatch[1].length >= 5) {
        const unesc = s => s.replace(/\\n/g, '\n').replace(/\\\\u/g, '\\u').replace(/\\\\"/, '"').replace(/\\\\\\\\/g, '\\\\');
        desc = unesc(descMatch[1]);
        uploader = nickMatch ? unesc(nickMatch[1]) : '';
        logger.info('scrapeDouyinContent: 旧正则降级成功', { videoId });
      }
    }

    if (!desc) {
      logger.warn('scrapeDouyinContent: desc 提取失败', { shareUrl, htmlLen: html.length });
      return { error: '分享页解析失败，无法提取视频简介，可能是视频已删除或平台限制' };
    }

    // Step 4: 解析可下载的 CDN URL
    // 策略：直接用 _ROUTER_DATA 中的 play/playwm URL（已验证可下载），yt-dlp 作为备选
    // yt-dlp Douyin extractor 有已知 bug (#12669)，总是失败，白等 1-2 秒
    let resolvedCdnUrl = null;
    if (cdnUrl) {
      // cdnUrl 已在上方处理：playwm → play（无水印）
      resolvedCdnUrl = cdnUrl;
      logger.info('scrapeDouyinContent: 使用 _ROUTER_DATA CDN URL', { videoId, url: resolvedCdnUrl.slice(0, 80) });
    } else {
      // _ROUTER_DATA 未拿到 CDN URL（罕见），尝试 yt-dlp
      try {
        const cookiesArgs = fs.existsSync(COOKIES_FILE)
          ? ['--cookies', COOKIES_FILE]
          : ['--cookies-from-browser', 'chrome'];
        const ytOut = (await execFileAsync('/opt/homebrew/bin/yt-dlp', [
          '--get-url', '--quiet', '--no-warnings',
          '-f', 'bestaudio/best',
          ...cookiesArgs,
          `https://www.douyin.com/video/${videoId}`,
        ], { encoding: 'utf8', timeout: 15000 })).trim();
        if (ytOut && ytOut.startsWith('http')) {
          resolvedCdnUrl = ytOut.split('\n')[0].trim();
          logger.info('scrapeDouyinContent: yt-dlp 备选成功', { videoId, url: resolvedCdnUrl.slice(0, 80) });
        }
      } catch (ytErr) {
        logger.warn('scrapeDouyinContent: yt-dlp 备选也失败', { error: ytErr.message?.slice(0, 100) });
      }
    }
    let transcript = '';
    if (resolvedCdnUrl && fs.existsSync(WHISPER_CLI) && fs.existsSync(WHISPER_MODEL)) {
      transcript = await transcribeDouyinAudio(resolvedCdnUrl);
    }

    // Step 5: 画面帧分析（按需，withFrames=true 时才执行）
    let frameDesc = '';
    if (withFrames && resolvedCdnUrl) {
      frameDesc = await analyzeDouyinFrames(resolvedCdnUrl);
    }

    return { title: desc, uploader, desc, transcript, frameDesc };
  } catch (e) {
    logger.warn('scrapeDouyinContent 失败', { error: e.message });
    return { error: `提取过程异常：${e.message}` };
  }
}

/** 异步 execFile 包装，不阻塞 Node.js 事件循环 */
function execFileAsync(cmd, args, opts = {}) {
  const { execFile } = require('child_process');
  return new Promise((resolve, reject) => {
    execFile(cmd, args, opts, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * ffmpeg 从 CDN URL 提取音频（不落盘视频） → whisper-cli 转录
 * 使用异步 execFile，不阻塞事件循环
 * 返回转录文字字符串，失败返回 ''
 */
async function transcribeDouyinAudio(cdnUrl) {
  const tmpAudio = `/tmp/douyin-audio-${Date.now()}.wav`;
  try {
    await execFileAsync('/opt/homebrew/bin/ffmpeg', [
      '-y', '-loglevel', 'error',
      '-headers', 'Referer: https://www.iesdouyin.com/\r\n',
      '-user_agent', DOUYIN_MOBILE_UA,
      '-i', cdnUrl,
      '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav',
      '-t', '300',
      tmpAudio,
    ], { timeout: 60000 });

    const result = await execFileAsync(WHISPER_CLI, [
      '--model', WHISPER_MODEL,
      '--language', 'zh',
      '--no-timestamps',
      '-f', tmpAudio,
    ], { timeout: 120000, encoding: 'utf8' });

    return result.trim().slice(0, 3000);
  } catch (e) {
    logger.warn('transcribeDouyinAudio 失败', { error: e.message });
    return '';
  } finally {
    try { fs.unlinkSync(tmpAudio); } catch {}
  }
}

/**
 * ffmpeg 从本地视频文件提取音频 → whisper-cli 转录
 * 用于家人直接发来的视频文件（非链接）
 */
async function transcribeLocalVideo(videoPath) {
  const tmpAudio = `/tmp/local-video-audio-${Date.now()}.wav`;
  try {
    await execFileAsync('/opt/homebrew/bin/ffmpeg', [
      '-y', '-loglevel', 'error',
      '-i', videoPath,
      '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav',
      '-t', '300',
      tmpAudio,
    ], { timeout: 90000 });

    const result = await execFileAsync(WHISPER_CLI, [
      '--model', WHISPER_MODEL,
      '--language', 'zh',
      '--no-timestamps',
      '-f', tmpAudio,
    ], { timeout: 120000, encoding: 'utf8' });

    return result.trim().slice(0, 3000);
  } catch (e) {
    logger.warn('transcribeLocalVideo 失败', { error: e.message });
    return '';
  } finally {
    try { fs.unlinkSync(tmpAudio); } catch {}
  }
}

/**
 * ffmpeg 从 CDN URL 抽取关键帧 → LLaVA 逐帧描述 → 汇总画面内容
 * 策略：每 5 秒抽 1 帧，最多 8 帧，缩放到 480px 宽（减小 LLaVA 处理量）
 * 返回汇总描述字符串，失败返回 ''
 */
async function analyzeDouyinFrames(cdnUrl) {
  const tmpDir = `/tmp/douyin-frames-${Date.now()}`;
  try {
    fs.mkdirSync(tmpDir, { recursive: true });

    // 抽帧：每 5 秒 1 帧，最多 8 帧，480px 宽（异步，不阻塞事件循环）
    await execFileAsync('/opt/homebrew/bin/ffmpeg', [
      '-y', '-loglevel', 'error',
      '-user_agent', DOUYIN_MOBILE_UA,
      '-i', cdnUrl,
      '-vf', 'fps=0.2,scale=480:-1',
      '-frames:v', '8',
      path.join(tmpDir, 'frame_%02d.jpg'),
    ], { timeout: 60000 });

    const frames = fs.readdirSync(tmpDir)
      .filter(f => f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(tmpDir, f));

    if (!frames.length) return '';

    // 逐帧调 LLaVA 描述
    const descriptions = [];
    for (let i = 0; i < frames.length; i++) {
      const desc = await describeImageWithLlava(frames[i]);
      if (desc) descriptions.push(`第${i + 1}帧：${desc}`);
    }

    return descriptions.join('\n');
  } catch (e) {
    logger.warn('analyzeDouyinFrames 失败', { error: e.message });
    return '';
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
  }
}

/** 将视频提取结果格式化为注入字符串 */
function formatVideoInjection(video, url) {
  const audioBody = video.transcript
    ? `【语音转录】\n${video.transcript}`
    : video.desc
      ? `【视频描述】\n${video.desc}`
      : '（无语音转录/描述）';
  const frameBody = video.frameDesc
    ? `\n\n【画面内容（AI视觉分析）】\n${video.frameDesc}`
    : '';
  return [
    `\n\n【视频内容已自动提取】`,
    `原始链接：${url}`,
    `标题：${video.title}`,
    video.uploader ? `来源：${video.uploader}` : '',
    video.duration  ? `时长：${video.duration}` : '',
    '',
    audioBody + frameBody,
  ].filter(s => s !== null && s !== undefined && !(s === '' && !video.uploader && !video.duration)).join('\n');
}

/** 用 Playwright 抓取微信公众号文章正文，返回 { title, text } 或 null */
async function scrapeWechatArticle(url) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders({
      'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 MicroMessenger/8.0.50',
    });
    await page.goto(url, { waitUntil: 'commit', timeout: 30000 });
    await page.waitForSelector('#js_content', { timeout: 15000 }).catch(() => {});

    const result = await page.evaluate(() => {
      const titleEl  = document.querySelector('#activity-name') || document.querySelector('h1');
      const authorEl = document.querySelector('#js_name');
      const bodyEl   = document.querySelector('#js_content');
      if (!bodyEl) return null;
      // 移除图片、按钮等无关元素，只取文字
      bodyEl.querySelectorAll('img, video, iframe, br').forEach(el => {
        if (el.tagName === 'BR') el.replaceWith('\n');
        else el.remove();
      });
      return {
        title:  (titleEl?.innerText || document.title || '').trim(),
        author: (authorEl?.innerText || '').trim(),
        text:   bodyEl.innerText.replace(/\n{3,}/g, '\n\n').trim(),
      };
    });

    return result;
  } catch (e) {
    return null;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * 图片视觉描述：mlx-vision（主，8081）→ Gemma 4 mlx_lm.server（备，8083）→ GLM vision（降级）
 */
async function describeImageWithLlava(imagePath) {
  const base64Image = fs.readFileSync(imagePath).toString('base64');
  const ext = path.extname(imagePath).toLowerCase().replace('.', '') || 'jpeg';
  const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
  const prompt = '请用中文详细描述这张图片的所有内容，包括文字、数字、地址、人物、物品、场景等，不要遗漏任何可见文字。';

  // 主：本地 mlx-vision（Qwen2.5-VL-32B via mlx_vlm，8081）
  try {
    const resp = await axios.post(
      'http://127.0.0.1:8081/v1/chat/completions',
      {
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            { type: 'text', text: prompt },
          ],
        }],
        max_tokens: 512,
        temperature: 0,
      },
      { timeout: 120000 }
    );
    const result = resp.data?.choices?.[0]?.message?.content?.trim();
    if (result) {
      logger.info('本地 mlx-vision 描述成功', { model: 'qwen2.5-vl-32b' });
      return result;
    }
  } catch (e) {
    logger.warn('mlx-vision 失败，降级 gemma-4-lucas', { error: e.message });
  }

  // 备用：Gemma 4 本地微调模型（mlx_lm.server OpenAI 兼容接口，8083）
  try {
    const resp = await axios.post(
      'http://127.0.0.1:8083/v1/chat/completions',
      {
        model: 'gemma-4-lucas',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            { type: 'text', text: prompt },
          ],
        }],
        max_tokens: 512,
        temperature: 0,
      },
      { timeout: 120000 }
    );
    const result = resp.data?.choices?.[0]?.message?.content?.trim();
    // 有效性检验：模型无视觉能力时会返回托辞（"无法查看图片"等），视为失败继续降级
    const VISION_REFUSAL_RE = /无法(直接)?查看|没有(实际的?)?图片数据|无法(分析|处理)(图片|图像)|cannot (view|see|analyze|process) (the )?image/i;
    if (result && !VISION_REFUSAL_RE.test(result)) {
      logger.info('Gemma 4 (mlx_lm.server) 描述成功');
      return result;
    }
    if (result) {
      logger.warn('Gemma 4 返回拒绝回复，降级 GLM', { preview: result.slice(0, 80) });
    }
  } catch (e) {
    logger.warn('Gemma 4 vision 失败，降级 GLM', { error: e.message });
  }

  // 降级：GLM vision
  const zhipuKey = process.env.ZAI_API_KEY || process.env.ZHIPU_API_KEY;
  if (!zhipuKey) return null;
  try {
    const resp = await axios.post(
      'https://open.bigmodel.cn/api/paas/v4/chat/completions',
      {
        model: 'glm-4v-flash',
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            { type: 'text', text: '请用中文详细描述这张图片的所有内容，包括文字、数字、地址、人物、物品、场景等，不要遗漏任何可见文字。' },
          ],
        }],
        max_tokens: 500,
      },
      { headers: { Authorization: `Bearer ${zhipuKey}`, 'Content-Type': 'application/json' }, timeout: 30000 }
    );
    return resp.data?.choices?.[0]?.message?.content?.trim() || null;
  } catch (e) {
    logger.warn('GLM vision 失败', { error: e.message });
    return null;
  }
}

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
  loadChatHistory,
} = require('../chat-history');

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
      if (SAVE_DOC_RE.test(trimmed) || SAVE_TECH_RE.test(trimmed)) {
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
      // 群聊：优先走 bot 通道（显示「启灵」），bot 未就绪时降级到企业应用（显示「系统工程师」）
      if (globalBotClient && globalBotReady) {
        await globalBotClient.sendMessage(chatId, {
          msgtype: 'markdown',
          markdown: { content: text },
        });
      } else {
        await sendWeComGroupMessage(chatId, text);
      }
      // 无论走哪个通道，都以 Lucas 身份记录到群 chatHistory（actor 真实性）
      if (chatId) {
        appendChatHistory(chatHistoryKey(true, chatId, null), '[启灵主动发送]', text);
      }
    } else {
      // 私聊主动推送：bot 协议只支持 group chatId，对 userId 始终 40008，直接走 HTTP API
      await sendWeComMessage(fromUser, text);
      // 以 Lucas 身份记录到该用户的 chatHistory（actor 真实性）
      if (fromUser) {
        appendChatHistory(chatHistoryKey(false, null, fromUser), '[启灵主动发送]', text);
      }
    }
    const channel = isGroup ? (globalBotReady ? 'bot' : 'app') : 'app';
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

// Main 调用模型（OpenAI-compatible，带工具）
// 模型配置来自 ~/.openclaw/openclaw.json agents.list main 条目，独立于三角色 env var 层
async function callMainModel(systemPrompt, messages, retries = 2) {
  const { baseUrl, apiKey, model } = readAgentModelConfig('main');
  // Anthropic 的 OpenAI 兼容端点需要 /v1/ 前缀 + anthropic-version header
  const isAnthropic = baseUrl.includes('anthropic.com');
  const base = baseUrl.replace(/\/$/, '');
  const completionsUrl = isAnthropic ? `${base}/v1/chat/completions` : `${base}/chat/completions`;
  const headers = { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` };
  if (isAnthropic) headers['anthropic-version'] = '2023-06-01';
  for (let attempt = 0; attempt <= retries; attempt++) {
    const resp = await fetch(completionsUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
        tools: MAIN_TOOLS_OAI,
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
      // 429 限流：等待后重试
      if (resp.status === 429 && attempt < retries) {
        const delay = 3000 * (attempt + 1);
        logger.info('callMainModel 429 限流，等待重试', { attempt, delay, error: errText.slice(0, 100) });
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw new Error(`Main model API error ${resp.status}: ${errText.slice(0, 200)}`);
    }
    return resp.json();
  }
}

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
function resolveInviteCode(invites, code) {
  const upper = code.toUpperCase();
  if (invites[upper]) return upper; // 直接命中当前活跃码
  // 遍历所有条目，找 historicalTokens 包含此码的那个
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

// ─── Demo Chat 代理端点 ───────────────────────────────────────────────────────
// 把前端发来的聊天请求转发给本机 OpenClaw Gateway（18789），避免 API Key 暴露在前端
// 公网访问时 127.0.0.1:18789 对前端不可达，通过此代理解决跨域+内网访问问题
app.post('/api/demo-proxy/chat', async (req, res) => {
  if (isDemoDisabled()) return res.status(503).json({ error: 'demo_disabled', message: '演示功能暂时关闭' });
  const sessionToken = req.headers['x-session-uuid'];
  if (!sessionToken) {
    return res.status(401).json({ error: 'session_required' });
  }
  try {
    const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN || '696673d08d0ee98f3e66a30698ab4c1152b7c8784ae424d0';
    const gatewayUrl = process.env.GATEWAY_URL || 'http://localhost:18789';
    const body = req.body;
    // 有邀请码时解析到当前活跃主键（含 historicalToken 支持），无邀请码时退回 UUID
    const inviteCode = req.headers['x-invite-code'];
    const resolvedInviteCode = inviteCode
      ? (resolveInviteCode(loadInvites(), inviteCode) || inviteCode)
      : null;
    const demoBody = {
      ...body,
      user: `visitor:${resolvedInviteCode || sessionToken}`,
    };
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
    const reply = data?.choices?.[0]?.message?.content || '';
    const htmlMatch = reply.match(/```html\s*([\s\S]*?)```/i);
    if (htmlMatch && fetchResp.status === 200) {
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
    res.status(fetchResp.status).json(data);
  } catch (err) {
    logger.error('Demo proxy error', { err: err.message });
    res.status(500).json({ error: 'proxy error', message: err.message });
  }
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

// 每个业主会话的对话历史（进程内保留，重启清空）
const mainHistory = {};

// Main 历史持久化目录（重启后恢复上下文）
const MAIN_HISTORY_DIR = path.join(HOMEAI_ROOT, 'data', 'main');

function loadMainHistory(userId) {
  try {
    const file = path.join(MAIN_HISTORY_DIR, `history-${userId}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {}
  return [];
}

function persistMainHistory(userId) {
  try {
    fs.mkdirSync(MAIN_HISTORY_DIR, { recursive: true });
    // 图片 base64 不持久化，避免文件过大
    const toSave = (mainHistory[userId] || []).map(msg => {
      if (!Array.isArray(msg.content)) return msg;
      return { ...msg, content: msg.content.map(b =>
        b.type === 'image' ? { type: 'text', text: '[图片已省略]' } : b
      )};
    });
    fs.writeFileSync(path.join(MAIN_HISTORY_DIR, `history-${userId}.json`), JSON.stringify(toSave), 'utf8');
  } catch (e) {
    logger.warn('Main 历史持久化失败', { error: e.message });
  }
}

// Obsidian vault 路径（系统工程师信息域）
const OBSIDIAN_VAULT_PATH = process.env.OBSIDIAN_VAULT_PATH ||
  path.join(process.env.HOME || '', 'Documents', 'Obsidian Vault', 'HomeAI');

// Main 对话日志目录（本地）
const MAIN_LOG_DIR = path.join(HOMEAI_ROOT, 'logs', 'main');

/**
 * 记录 Main 对话到本地 jsonl + Obsidian Markdown
 * 双写：本地是可靠存储，Obsidian 是系统工程师可读视图
 */
function logMainConversation(userId, userMessage, toolsCalled, finalReply) {
  const now     = new Date();
  const dateStr = now.toISOString().split('T')[0];
  const timeStr = now.toTimeString().split(' ')[0];

  // 1. 本地 JSONL（主存储，不依赖 Obsidian）
  try {
    fs.mkdirSync(MAIN_LOG_DIR, { recursive: true });
    const entry = JSON.stringify({
      ts:      now.toISOString(),
      userId,
      message: userMessage,
      tools:   toolsCalled,
      reply:   finalReply,
    }) + '\n';
    fs.appendFileSync(path.join(MAIN_LOG_DIR, `${dateStr}.jsonl`), entry);
  } catch (e) {
    logger.warn('Main 日志写入失败（本地）', { error: e.message });
  }

  // 2. Obsidian Markdown（统一存入 01-系统决策日志/YYYY-MM/，与 ClaudeCode 会话并列）
  try {
    const monthStr = dateStr.slice(0, 7); // YYYY-MM
    const obsDir = path.join(OBSIDIAN_VAULT_PATH, '03-系统工程师工作日志', monthStr);
    fs.mkdirSync(obsDir, { recursive: true });
    const toolsStr = toolsCalled.length > 0 ? toolsCalled.join(', ') : '无';
    const mdEntry  = [
      `### ${timeStr}`,
      `**工具**: ${toolsStr}`,
      '',
      `**我**：`,
      userMessage,
      '',
      `**Main**：`,
      finalReply,
      '',
      '---',
      '',
    ].join('\n');
    // 第一次写入时追加文件头
    const filePath = path.join(obsDir, `${dateStr}-Main.md`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, `# Main 通道 · ${dateStr}\n\n## 对话原文\n\n`);
    }
    fs.appendFileSync(filePath, mdEntry);
  } catch (e) {
    logger.warn('Main 日志写入失败（Obsidian）', { error: e.message });
  }
}

const MAIN_SYSTEM_PROMPT = `你是 HomeAI 系统的系统工程师助理 Main，负责远程协助业主管理和调试 HomeAI 系统。

HomeAI 当前架构：
- OpenClaw Gateway（端口 18789，launchd 管理）：Lucas/Andy/Lisa 三个 Embedded Agent 运行于此，crewclaw-routing 插件处理三层路由。日志：~/.openclaw/logs/gateway.log
- wecom-entrance（PM2 管理，端口 3003）：企业微信入口，即你自己所在的进程
- cloudflared-tunnel（PM2 管理）：Cloudflare Tunnel，把公网请求转发到本地

重要：Lucas/Andy/Lisa 是 OpenClaw 内置 Embedded Agent，不是独立进程，PM2 里看不到它们，也不能用 PM2 重启。要重启 Gateway 只能用 launchctl（不在工具范围内，需要告知业主手动执行：launchctl stop ai.openclaw.gateway && launchctl start ai.openclaw.gateway）。

记忆说明：你在同一次 PM2 运行周期内有会话历史，每个业主的最近 20 条对话会保留在内存中。wecom-entrance 重启后历史清空，这是正常现象。

长期记忆：所有 Main 对话均记录在 Obsidian 工作日志（~/Documents/Obsidian Vault/HomeAI/03-系统工程师工作日志/）。

如果业主问历史决策或上次做了什么，直接告知「我的 session 记忆有限，请到 CLI 用 Claude Code 查 Obsidian 工作日志」，不要尝试自己搜索。

---
系统工程师工作方式（你的行为标准）：

遇到问题，先建立上下文，再动手。顺序：
1. 看日志（get_logs / run_shell tail）→ 定位症状
2. 读相关代码（read_file）→ 理解根因，不猜
3. 做修改（exec_script / write_file）→ 改最小必要的地方
4. 重启验证（restart_service / restart_gateway）→ test_lucas 确认
5. 报告：说清楚改了什么、为什么、验证结果

判断根因前不改代码。改完必须验证。不确定就告诉业主，不自作主张。

文档地图（遇到对应问题时主动去读）：
- 整体架构 / 当前状态：read_file crewclaw/../CLAUDE.md（即 ${HOMEAI_ROOT}/../CLAUDE.md 或用 run_shell cat ~/HomeAI/CLAUDE.md）
- 插件逻辑（记忆注入 / 路由）：${HOMEAI_ROOT}/crewclaw/crewclaw-routing/index.ts
- wecom 入口逻辑：${HOMEAI_ROOT}/crewclaw/daemons/entrances/wecom/index.js
- Gateway 启动 / 环境变量：~/.openclaw/start-gateway.sh
- Lucas/Andy/Lisa 人格规则：~/.openclaw/workspace-{lucas,andy,lisa}/AGENTS.md
- Lucas 工具清单：~/.openclaw/workspace-lucas/TOOLS.md
- 历史决策 / 会话记录：~/Documents/Obsidian Vault/HomeAI/03-系统工程师工作日志/（只读，无搜索工具，告知业主去 CLI 查）

项目根目录：${HOMEAI_ROOT}
PM2 日志目录：${HOMEAI_ROOT}/logs/pm2/

你可以使用以下工具帮助业主诊断问题、查看状态、管理服务：
- get_system_status：PM2 + 服务健康检查
- get_logs：查 gateway/wecom/cloudflared 日志
- read_file：读 HomeAI 目录下的文件
- restart_service：重启 PM2 管理的服务（wecom/cloudflared）
- restart_gateway：重启 OpenClaw Gateway（launchctl），改完插件代码后用
- run_shell：执行诊断命令（curl/cat/tail/grep/launchctl/pm2 等白名单命令）
- test_lucas：向 Lucas 发测试消息，验证 wecom→Gateway 全链路是否正常
- exec_script：在 HomeAI 根目录执行 bash/python3 脚本，对本机所有目录有完整读写权限（含 ~/Documents/Obsidian Vault/、系统配置等），无路径限制
- send_file：将 HomeAI 目录下的文件通过企业微信发给业主
- trigger_finetune：触发增量微调
- scan_pipeline_health：全面扫描系统健康（PM2 + Gateway + 最近 1h 日志错误），返回结构化报告
- scan_lucas_quality：扫描 ChromaDB 最近 50 条 Lucas 对话，检测 Markdown 违规、幻觉承诺、空回复等质量问题


收到文章/视频链接的默认行为：只做简要分析并回复，不自动存文件。
仅当业主明确说「存外部参考」「纳入参考」「记录下来」等指令时，根据内容类型选择目录：
- ClaudeCode 相关（使用技巧、插件、Skills、协作经验等）→ write_file 写入 /Users/xinbinanshan/Documents/Obsidian Vault/HomeAI/00-ClaudeCode配置/ClaudeCode外部经验参考/
- 其他设计/技术内容 → write_file 写入 /Users/xinbinanshan/Documents/Obsidian Vault/HomeAI/07-设计与技术外部参考/
文件名格式 YYYY-MM-DD-标题摘要.md，内容包含出处链接、摘要和要点。

典型调试流程：业主改完插件代码 → restart_gateway → test_lucas → 确认修复。
回答用中文，简洁直接，不要啰嗦。如果需要先看日志或文件再下结论，主动去看。

---

**汇报格式（强制）**：所有推送给工程师的状态报告必须按 Lx 分层组织：
## L0 基础设施
[各 PM2 进程名称+状态、Gateway、端口、数据量]
## L1 Agent 人格化
[Lucas 质量、Andy/Lisa 活跃度、蒸馏产出、evaluator 状态]
## L2 进化循环
[蒸馏/技能/进化信号/DPO]
## L3 组织协作
[协作边/成员分身/关系蒸馏/访客影子]
规则：某层无问题写 ✅ 无异常，不要省略。L0 必须包含具体进程状态。

系统评估工具（业主发「系统评估」时使用）：
- evaluate_system：依次调用 evaluate_l0~l4，输出 L0~L4 评分卡
- evaluate_l0 / evaluate_l1 / evaluate_l2 / evaluate_l3 / evaluate_l4：单层评估
- inspect_agent_context：查看 Andy 或 Lisa 上下文快照

L4 微调流水线工具（业主主导，按需调用）：
- evaluate_local_model：数据驱动评测本地模型智力（Kuzu 知识题 0.4 + ChromaDB 对话题 0.6，综合 ≥3.5 通过）
- generate_dpo_good_responses：为积累达阈值的 DPO 负例批量生成 good_response（云端改写）
- approve_dpo_batch：批准指定 pattern 的 good_response，标记 confirmed=true 进入微调队列`;

const MAIN_TOOLS = [
  {
    name: 'get_system_status',
    description: '获取 PM2 进程状态（wecom/cloudflared）及 Gateway/wecom 服务健康检查',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_logs',
    description: '获取指定服务的最近日志',
    input_schema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          enum: ['gateway', 'wecom', 'cloudflared'],
          description: '服务名称：gateway（OpenClaw Gateway，含 Lucas/Andy/Lisa）、wecom（企业微信入口）、cloudflared（隧道）',
        },
        lines: {
          type: 'number',
          description: '获取最近几行，默认 30',
        },
      },
      required: ['service'],
    },
  },
  {
    name: 'read_file',
    description: '读取 HomeAI 项目目录下的文件内容，用于诊断配置、代码或数据问题',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '相对于 crewclaw 目录的文件路径，例如 crewclaw-routing/index.ts 或 daemons/entrances/wecom/index.js',
        },
        tail_lines: {
          type: 'number',
          description: '只读最后 N 行（适合大文件），不填则读全部（限 200 行）',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'restart_service',
    description: '重启 PM2 管理的服务（仅限 wecom/cloudflared，Gateway 不在此管理）',
    input_schema: {
      type: 'object',
      properties: {
        service: {
          type: 'string',
          enum: ['wecom', 'cloudflared'],
          description: '要重启的服务名称',
        },
      },
      required: ['service'],
    },
  },
  {
    name: 'trigger_finetune',
    description: '强制触发一次增量微调',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'restart_gateway',
    description: '重启 OpenClaw Gateway（launchctl stop + start），重启后自动读取最新日志确认状态。修改插件代码后用此工具热重载。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_shell',
    description: '执行诊断用 shell 命令（白名单限制：curl/cat/tail/grep/wc/ls/ps/launchctl/pm2/python3）。用于查状态、验证端点、检查文件。',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: '要执行的命令，例如：curl -s http://localhost:18789/api/health 或 tail -20 ~/.openclaw/logs/gateway.log',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'test_lucas',
    description: '向 Lucas 发送测试消息，走 wecom-entrance → Gateway 完整链路，返回 Lucas 的响应和耗时。用于修改插件或重启 Gateway 后验证全流程。',
    input_schema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: '发给 Lucas 的测试消息，默认"你好，系统测试"',
        },
      },
      required: [],
    },
  },
  {
    name: 'exec_script',
    description: '在 HomeAI 目录下执行 bash 或 python3 脚本，CWD 为 HomeAI 根目录，对本机所有目录有完整读写权限（无路径限制，可写 ~/Documents/Obsidian Vault/ 等任意位置）。适合写文件、合并数据、远程调试、生成报告等任务。',
    input_schema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: '要执行的脚本内容（可多行）',
        },
        interpreter: {
          type: 'string',
          description: 'bash 或 python3，默认 bash',
        },
      },
      required: ['code'],
    },
  },
  {
    name: 'write_file',
    description: '将内容直接写入本机任意路径的文件（path 和 content 分开传，不需要生成代码）。适合写 Obsidian 笔记、保存文章摘要、更新配置文件等需要写入大段文本的场景。父目录不存在时自动创建。',
    input_schema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '文件的绝对路径，例如 /Users/xinbinanshan/Documents/Obsidian Vault/HomeAI/07-设计与技术外部参考/2026-03-26-标题.md',
        },
        content: {
          type: 'string',
          description: '要写入的文件内容（UTF-8 字符串，支持中文、Markdown 等）',
        },
        append: {
          type: 'boolean',
          description: '是否追加到文件末尾（默认 false = 覆盖写入）',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'send_file',
    description: '将 HomeAI 目录下的文件通过企业微信发送给业主。适合发日志、数据文件、生成的代码等。',
    input_schema: {
      type: 'object',
      properties: {
        file_path: {
          type: 'string',
          description: '相对于 HomeAI 根目录的文件路径，例如 data/learning/route-events.jsonl 或 crewclaw/crewclaw-routing/index.ts',
        },
      },
      required: ['file_path'],
    },
  },
  {
    name: 'evaluate_l0',
    description: '评估 L0（基础设施——稳不稳）：PM2 进程状态、软硬件性能指标（磁盘空间/内存/Gateway延迟/ChromaDB延迟）、Kuzu 知识图谱、ChromaDB 对话总量、家人档案新鲜度、定时任务执行健康。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'evaluate_l1',
    description: '评估 L1（行为质量——好不好）：两大维度——①记忆质量（上下文组装完整性 + recall 准确率）②输出质量（幻觉 + 人格化程度）。含 Lucas 质量扫描、Andy/Lisa 活跃度、档案注入完整性、模式积累。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'inspect_agent_context',
    description: '查看 Andy 或 Lisa 当前实际注入的上下文快照：静态文件（ARCH/MEMORY/DESIGN-PRINCIPLES）摘要、Kuzu 设计模式积累、ChromaDB decisions 最新条目（含 design_learning/impl_learning/learning_objective）。用于排查上下文质量问题。业主发「看看 Andy 上下文」/「Andy 在看什么」时调用。',
    input_schema: {
      type: 'object',
      properties: {
        agent: { type: 'string', enum: ['andy', 'lisa'], description: '要查看的 Agent（andy 或 lisa）' },
      },
      required: ['agent'],
    },
  },
  {
    name: 'evaluate_l2',
    description: '评估 L2（系统自进化——自身能力越来越强）：三个原始诉求——①开发流水线成效（opencode 成功率、spec 质量）②自进化机制运转（蒸馏/结晶/同类错误减少）③喂养成效（投喂内容提炼、L0~L2 得分趋势）。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'evaluate_l3',
    description: '评估 L3（组织协作进化——组织运作越来越优化）：协作边积累、演进环记录、访客影子生命周期、关系蒸馏运行状态、成员增强效果。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'evaluate_l4',
    description: '评估 L4（内化能力是否越来越强）：DPO 信号积累+趋势、本地模型就绪状态、模型能力评估（调用 evaluate_local_model 获取量化评分）。系统内化能力越强，对外依赖越少。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'evaluate_local_model',
    description: '数据驱动评测本地模型智力。从 Kuzu 抽家人事实→生成知识题（0.4），从 ChromaDB 抽真实对话→测对话能力（0.6，需求理解/推理/边界三维度）。综合 ≥3.5 通过。零硬编码，第二个部署有数据就能跑。参数：model_name（可选，默认当前本地模型）。',
    input_schema: {
      type: 'object',
      properties: {
        model_name: { type: 'string', description: '要评测的 Ollama 模型名，为空则用 LOCAL_MODEL_NAME 环境变量' },
      },
      required: [],
    },
  },
  {
    name: 'generate_dpo_good_responses',
    description: '为 dpo-candidates.jsonl 中积累达阈值的负例 pattern 批量生成 good_response（由云端模型改写坏回复）。生成后推送样本供工程师用 approve_dpo_batch 审批。参数：pattern_type（可选，为空处理所有达阈值 pattern）、threshold（可选，默认 50）。',
    input_schema: {
      type: 'object',
      properties: {
        pattern_type: { type: 'string', description: '指定要处理的 pattern 类型，为空则处理所有达阈值 pattern' },
        threshold: { type: 'number', description: '触发阈值，默认 50' },
      },
      required: [],
    },
  },
  {
    name: 'approve_dpo_batch',
    description: '批准 dpo-candidates.jsonl 中指定 pattern 的已生成 good_response，将 confirmed 标记为 true，使其进入微调队列。需先运行 generate_dpo_good_responses 生成好回答。参数：pattern_type（必填）、limit（可选，默认 50）。',
    input_schema: {
      type: 'object',
      properties: {
        pattern_type: { type: 'string', description: '要批准的 pattern 类型，如 false_commitment / pretend_doing' },
        limit: { type: 'number', description: '最多批准条数，默认 50' },
      },
      required: ['pattern_type'],
    },
  },
  {
    name: 'evaluate_system',
    description: '系统全面评估（L0~L4）：依次运行 evaluate_l0 / evaluate_l1 / evaluate_l2 / evaluate_l3 / evaluate_l4，汇总为一张评分卡。业主发「系统评估」时调用此工具。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'evaluate_trend',
    description: '评分趋势分析：读取历史评估记录（evaluation-history.jsonl），输出各层分数变化表格 + 趋势方向 + 关键卡点分析（拖累得分的子维度）。业主发「评分趋势」「看看演进」时调用。',
    input_schema: {
      type: 'object',
      properties: {
        count: { type: 'number', description: '显示最近 N 次评估记录（默认 10）' },
      },
      required: [],
    },
  },
  // run_claude_code 暂时禁用（2026-03-26）：子进程 execFileSync 阻塞事件循环 120s，
  // 且 Main 容易在不该调用时触发（应改为按需启用，设计待确认后恢复）
  {
    name: 'scan_pipeline_health',
    description: '全面扫描 HomeAI 系统健康：PM2 进程状态、Gateway 存活、最近 1 小时日志错误摘要。返回结构化健康报告，用于监控循环和主动告警。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'scan_lucas_quality',
    description: '扫描 ChromaDB conversations 集合中最近 50 条 Lucas 对话，检测质量问题：Markdown 格式违规（**标题**/#标题）、幻觉承诺（说"已完成"但无工具调用证据）、空回复或过短回复（<10字）。返回发现的问题列表。',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_heartbeat',
    description: '更新 HEARTBEAT.md 状态。operation=append_observation 时追加一条观察记录到「待汇总观察」节；operation=mark_daily_sent 时清空「待汇总观察」节并更新「上次日报发送」时间戳。',
    input_schema: {
      type: 'object',
      properties: {
        operation: { type: 'string', enum: ['append_observation', 'mark_daily_sent'], description: 'append_observation: 追加观察；mark_daily_sent: 标记日报已发送并清空观察' },
        observation: { type: 'string', description: '观察描述（仅 append_observation 时使用）' },
      },
      required: ['operation'],
    },
  },
  {
    name: 'log_improvement_task',
    description: '记录系统改进建议到 Claude Code CLI 任务队列（~/HomeAI/Data/main-pending-tasks.json）。供工程师下次打开 CLI 时处理。适用于：发现架构缺口、质量积累性问题、优化机会——不是立即告警的紧急问题，而是值得工程师在下次工作周期处理的改进点。',
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '改进点标题（一句话，≤40字）' },
        description: { type: 'string', description: '详细描述：发现了什么问题、影响是什么、建议如何处理' },
        priority: { type: 'string', enum: ['low', 'medium', 'high'], description: 'low: 优化机会 | medium: 影响体验但不紧急 | high: 架构缺口或持续积累的系统性问题' },
      },
      required: ['title', 'description', 'priority'],
    },
  },
];

// OpenAI function-call 格式（由 MAIN_TOOLS Anthropic 格式转换）
const MAIN_TOOLS_OAI = MAIN_TOOLS.map(t => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

// ─── 评估体系：数值评分框架 ────────────────────────────────────────────────────
const _evalScores = {};
let _rubricCache = null;

function loadRubric() {
  if (_rubricCache !== null) return _rubricCache;
  try {
    _rubricCache = JSON.parse(fs.readFileSync(
      path.join(HOMEAI_ROOT, 'CrewHiveClaw', 'CrewClaw', 'crewclaw-routing', 'config', 'evaluation-rubric.json'), 'utf8'
    ));
  } catch { _rubricCache = null; }
  return _rubricCache;
}

function scoreWithRubric(item, rawValue) {
  if (!item) return 3;
  if (item.direction === 'enum') return item.map?.[rawValue] ?? 3;
  if (item.direction === 'higher_better') {
    for (const [threshold, sc] of (item.thresholds || [])) {
      if (rawValue >= threshold) return sc;
    }
    return 0;
  }
  if (item.direction === 'lower_better') {
    for (const [threshold, sc] of (item.thresholds || [])) {
      if (rawValue <= threshold) return sc;
    }
    return 0;
  }
  return 3;
}

function trackScore(scores, layerItems, key, rawValue) {
  if (!layerItems?.[key]) return;
  const item = layerItems[key];
  scores.push({ key, name: item.name, score: scoreWithRubric(item, rawValue), weight: item.weight, raw: rawValue });
}

function calcWeightedAvg(scores) {
  let tw = 0, ts = 0;
  for (const s of scores) { tw += s.weight; ts += s.score * s.weight; }
  return tw > 0 ? ts / tw : 0;
}

// 工具执行
async function executeMainTool(toolName, toolInput) {
  const nameMap = { lucas: 'lucas-daemon', andy: 'andy-daemon', lisa: 'lisa-daemon', wecom: 'wecom-entrance' };
  const PYTHON311 = '/opt/homebrew/opt/python@3.11/bin/python3.11';

  if (toolName === 'get_system_status') {
    try {
      const pm2Out = execSync('pm2 jlist', { encoding: 'utf8' });
      const procs = JSON.parse(pm2Out);
      const lines = procs.map(p => {
        const status = p.pm2_env.status === 'online' ? '✅' : '❌';
        return `${status} ${p.name}  状态:${p.pm2_env.status}  重启:${p.pm2_env.restart_time}次  内存:${Math.round((p.monit?.memory || 0) / 1024 / 1024)}MB`;
      });
      const services = [['gateway', 18789], ['wecom', 3003]];
      const health = await Promise.all(services.map(async ([name, port]) => {
        try {
          await axios.get(`http://localhost:${port}/api/health`, { timeout: 2000 });
          return `✅ ${name}:${port}`;
        } catch {
          return `❌ ${name}:${port} 无响应`;
        }
      }));
      return `PM2 进程：\n${lines.join('\n')}\n\n服务健康：\n${health.join('\n')}`;
    } catch (e) {
      return `获取状态失败：${e.message}`;
    }
  }

  if (toolName === 'get_logs') {
    const lines = toolInput.lines || 30;
    try {
      const home = process.env.HOME || '';
      const logFiles = {
        gateway:    [path.join(home, '.openclaw/logs/gateway.log'), path.join(home, '.openclaw/logs/gateway.err.log')],
        wecom:      [path.join(HOMEAI_ROOT, 'logs/pm2/wecom-out.log'), path.join(HOMEAI_ROOT, 'logs/pm2/wecom-error.log')],
        cloudflared:[path.join(HOMEAI_ROOT, 'logs/pm2/cloudflared-out.log'), path.join(HOMEAI_ROOT, 'logs/pm2/cloudflared-error.log')],
      };
      const [logFile, errFile] = logFiles[toolInput.service] || [];
      let result = '';
      if (logFile && fs.existsSync(logFile)) {
        // 只读文件末尾 64KB，避免 readFileSync 整个大文件（gateway.log 可达数十MB）
        const MAX_READ = 65536;
        const fd = fs.openSync(logFile, 'r');
        const stat = fs.fstatSync(fd);
        const start = Math.max(0, stat.size - MAX_READ);
        const buf = Buffer.alloc(Math.min(MAX_READ, stat.size));
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const tail = buf.toString('utf8').split('\n').filter(l => l.trim()).slice(-lines).join('\n');
        // 工具返回值最多 4000 字符，防止 messages 膨胀导致 API 超时
        const truncated = tail.length > 4000 ? '...(已截断)\n' + tail.slice(-4000) : tail;
        result += `[stdout 最近${lines}行]\n${truncated}\n`;
      }
      if (errFile && fs.existsSync(errFile)) {
        const content = fs.readFileSync(errFile, 'utf8');
        const errLines = content.split('\n').filter(l => l.trim()).slice(-10);
        if (errLines.length > 0) result += `\n[stderr 最近10行]\n${errLines.join('\n')}`;
      }
      return result || '日志文件为空';
    } catch (e) {
      return `读取日志失败：${e.message}`;
    }
  }

  if (toolName === 'read_file') {
    try {
      const absPath = path.join(HOMEAI_ROOT, toolInput.file_path);
      // 安全检查：只允许读 HomeAI 根目录下的文件
      if (!absPath.startsWith(HOMEAI_ROOT)) {
        return '只能读取 HomeAI 项目目录下的文件';
      }
      if (!fs.existsSync(absPath)) {
        return `文件不存在：${toolInput.file_path}`;
      }
      const content = fs.readFileSync(absPath, 'utf8');
      const allLines = content.split('\n');
      let result;
      if (toolInput.tail_lines) {
        result = allLines.slice(-toolInput.tail_lines).join('\n');
      } else {
        result = allLines.slice(0, 200).join('\n');
        if (allLines.length > 200) result += `\n\n[文件共 ${allLines.length} 行，只显示前 200 行]`;
      }
      return result;
    } catch (e) {
      return `读取文件失败：${e.message}`;
    }
  }

  if (toolName === 'restart_service') {
    const pm2Name = nameMap[toolInput.service] || toolInput.service;
    try {
      execSync(`pm2 restart ${pm2Name}`, { encoding: 'utf8' });
      return `${pm2Name} 已重启`;
    } catch (e) {
      return `重启失败：${e.message}`;
    }
  }

  if (toolName === 'trigger_finetune') {
    try {
      const schedulerPath = path.join(HOMEAI_ROOT, 'scripts/finetune-scheduler.js');
      execSync(`node ${schedulerPath} --force-run > /dev/null 2>&1 &`, { encoding: 'utf8' });
      return '增量微调已在后台启动，完成后日志见 logs/finetune.log';
    } catch (e) {
      return `微调启动失败：${e.message}`;
    }
  }

  if (toolName === 'restart_gateway') {
    try {
      execSync('launchctl stop ai.openclaw.gateway', { encoding: 'utf8' });
      await new Promise(r => setTimeout(r, 3000));
      execSync('launchctl start ai.openclaw.gateway', { encoding: 'utf8' });
      await new Promise(r => setTimeout(r, 3000));
      // 读启动后最新日志确认状态（只读末尾 64KB，避免 readFileSync 整个大文件）
      const logFile = path.join(process.env.HOME || '', '.openclaw/logs/gateway.log');
      let tail = '';
      if (fs.existsSync(logFile)) {
        const MAX_READ = 65536;
        const fd = fs.openSync(logFile, 'r');
        const stat = fs.fstatSync(fd);
        const start = Math.max(0, stat.size - MAX_READ);
        const buf = Buffer.alloc(Math.min(MAX_READ, stat.size));
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n').filter(l => l.trim()).slice(-10);
        tail = lines.join('\n');
      }
      return `Gateway 已重启。最新日志：\n${tail || '（日志为空）'}`;
    } catch (e) {
      return `Gateway 重启失败：${e.message}`;
    }
  }

  if (toolName === 'run_shell') {
    const cmd = (toolInput.command || '').trim();
    // 白名单：只允许以下命令开头，防止误操作
    const ALLOWED_PREFIXES = ['curl ', 'cat ', 'tail ', 'grep ', 'wc ', 'ls ', 'ps ', 'launchctl ', 'pm2 ', 'python3 '];
    const allowed = ALLOWED_PREFIXES.some(p => cmd.startsWith(p));
    if (!allowed) {
      return `命令不在白名单内（允许：${ALLOWED_PREFIXES.map(p => p.trim()).join('、')}）`;
    }
    // 禁止写入操作
    if (/[>|]/.test(cmd) && !/^\s*curl/.test(cmd)) {
      return '不允许重定向或管道写入操作';
    }
    try {
      const output = execSync(cmd, { encoding: 'utf8', timeout: 15000, env: process.env });
      return output.trim() || '（命令执行成功，无输出）';
    } catch (e) {
      return `执行失败（退出码 ${e.status}）：${e.stderr || e.message}`.slice(0, 1000);
    }
  }

  if (toolName === 'test_lucas') {
    const msg = toolInput.message || '你好，系统测试';
    const start = Date.now();
    try {
      const resp = await axios.post('http://localhost:3003/api/wecom/forward', {
        message: msg,
        userId: 'main-test',
      }, { timeout: 60000 });
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      const reply = resp.data?.response || resp.data?.reply || JSON.stringify(resp.data);
      return `✅ Lucas 响应（${elapsed}s）：\n${reply}`;
    } catch (e) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      return `❌ 测试失败（${elapsed}s）：${e.message}`;
    }
  }

  if (toolName === 'exec_script') {
    const interpreter = toolInput.interpreter === 'python3' ? '/usr/bin/python3' : '/bin/bash';
    const tmpScript = path.join(HOMEAI_ROOT, 'temp', `main-script-${Date.now()}.${interpreter.includes('python') ? 'py' : 'sh'}`);
    try {
      fs.mkdirSync(path.join(HOMEAI_ROOT, 'temp'), { recursive: true });
      fs.writeFileSync(tmpScript, toolInput.code, { mode: 0o755 });
      const output = execSync(`${interpreter} ${tmpScript}`, {
        encoding: 'utf8',
        timeout: 60000,
        cwd: HOMEAI_ROOT,
        env: { ...process.env, HOMEAI_ROOT },
      });
      fs.unlinkSync(tmpScript);
      return output.trim().slice(0, 2000) || '（脚本执行成功，无输出）';
    } catch (e) {
      try { fs.unlinkSync(tmpScript); } catch (_) {}
      const out = (e.stdout || '').trim();
      const err = (e.stderr || e.message || '').trim();
      return `执行失败（退出码 ${e.status}）：\n${err || out}`.slice(0, 2000);
    }
  }

  if (toolName === 'write_file') {
    const filePath = toolInput.path;
    const content  = toolInput.content;
    const append   = toolInput.append === true;
    if (!filePath || content === undefined) return '缺少 path 或 content 参数';
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      if (append) {
        fs.appendFileSync(filePath, content, 'utf8');
      } else {
        fs.writeFileSync(filePath, content, 'utf8');
      }
      const size = fs.statSync(filePath).size;
      return `✅ 已写入：${filePath}（${(size/1024).toFixed(1)}KB）`;
    } catch (e) {
      return `写入失败：${e.message}`;
    }
  }

  if (toolName === 'send_file') {
    const absPath = path.join(HOMEAI_ROOT, toolInput.file_path);
    if (!absPath.startsWith(HOMEAI_ROOT)) {
      return '只能发送 HomeAI 项目目录下的文件';
    }
    if (!fs.existsSync(absPath)) {
      return `文件不存在：${toolInput.file_path}`;
    }
    const stat = fs.statSync(absPath);
    if (stat.size > 20 * 1024 * 1024) {
      return `文件过大（${(stat.size / 1024 / 1024).toFixed(1)}MB），企业微信限制 20MB`;
    }
    try {
      await sendWeComFile(WECOM_OWNER_ID, absPath);
      return `✅ 已发送：${path.basename(absPath)}（${(stat.size / 1024).toFixed(1)}KB）`;
    } catch (e) {
      return `发送失败：${e.message}`;
    }
  }

  if (toolName === 'run_claude_code') {
    const task           = toolInput.task;
    const withObsidian   = toolInput.include_obsidian !== false;
    const OBSIDIAN_VAULT = '/Users/xinbinanshan/Documents/Obsidian Vault/HomeAI';
    const CLAUDE_BIN     = '/opt/homebrew/bin/claude';

    const args = [
      '-p', task,
      '--output-format', 'text',
      '--permission-mode', 'bypassPermissions',
      '--no-session-persistence',
      '--allowedTools', 'Read,Grep,Glob',
    ];
    if (withObsidian) {
      args.push('--add-dir', OBSIDIAN_VAULT);
    }

    try {
      const { execFileSync } = require('child_process');
      const output = execFileSync(CLAUDE_BIN, args, {
        cwd:      HOMEAI_ROOT,
        encoding: 'utf8',
        timeout:  120000,
        env:      { ...process.env },
      });
      return output.trim() || '（Claude Code 执行完毕，无文字输出）';
    } catch (e) {
      const stderr = e.stderr || '';
      return `run_claude_code 失败：${e.message}${stderr ? '\n' + stderr.slice(0, 500) : ''}`;
    }
  }

  if (toolName === 'scan_pipeline_health') {
    const report = { pm2: [], gateway: null, wecom: null, logErrors: [] };

    // PM2 状态
    try {
      const pm2Out = execSync('pm2 jlist', { encoding: 'utf8' });
      const procs = JSON.parse(pm2Out);
      report.pm2 = procs.map(p => ({
        name:     p.name,
        status:   p.pm2_env.status,
        restarts: p.pm2_env.restart_time,
        memMB:    Math.round((p.monit?.memory || 0) / 1024 / 1024),
        ok:       p.pm2_env.status === 'online',
      }));
    } catch (e) {
      report.pm2 = [{ name: 'pm2', status: 'error', ok: false, error: e.message }];
    }

    // Gateway 健康（正确端点 /health，不是 /api/health）
    try {
      const r = await axios.get('http://localhost:18789/health', { timeout: 3000 });
      report.gateway = { ok: r.data?.ok === true || r.status === 200 };
    } catch (e) {
      report.gateway = { ok: false, error: e.message };
    }

    // wecom 健康
    try {
      await axios.get(`http://localhost:${PORT}/api/health`, { timeout: 2000 });
      report.wecom = { ok: true };
    } catch (e) {
      report.wecom = { ok: false, error: e.message };
    }

    // 日志错误扫描（最近 1 小时）
    const home = process.env.HOME || '';
    const logsToScan = [
      path.join(home, '.openclaw/logs/gateway.log'),
      path.join(HOMEAI_ROOT, 'logs/pm2/wecom-error.log'),
    ];
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    for (const logPath of logsToScan) {
      if (!fs.existsSync(logPath)) continue;
      try {
        const MAX_READ = 65536;
        const fd = fs.openSync(logPath, 'r');
        const stat = fs.fstatSync(fd);
        const start = Math.max(0, stat.size - MAX_READ);
        const buf = Buffer.alloc(Math.min(MAX_READ, stat.size));
        fs.readSync(fd, buf, 0, buf.length, start);
        fs.closeSync(fd);
        const lines = buf.toString('utf8').split('\n');
        for (const line of lines) {
          if (!line.includes('error') && !line.includes('Error') && !line.includes('ERROR')) continue;
          // 已知噪音：未配对 WebSocket 连接缺少 operator.read scope（非致命，等 OpenClaw 升级解决）
          if (line.includes('missing scope: operator.read')) continue;
          // 尝试解析时间戳判断是否在 1h 内
          try {
            const tsMatch = line.match(/"timestamp":"([^"]+)"/);
            if (tsMatch && new Date(tsMatch[1]).getTime() < oneHourAgo) continue;
          } catch {}
          report.logErrors.push(`[${path.basename(logPath)}] ${line.slice(0, 200)}`);
          if (report.logErrors.length >= 5) break;
        }
      } catch (e) {
        report.logErrors.push(`读取 ${path.basename(logPath)} 失败：${e.message}`);
      }
    }

    // 汇总
    const pm2Issues = report.pm2.filter(p => !p.ok).map(p => `${p.name} 状态异常（${p.status}）`);
    const gatewayIssue = report.gateway?.ok === false ? `Gateway 无响应：${report.gateway.error}` : null;
    const wecomIssue   = report.wecom?.ok   === false ? `wecom-entrance 健康检查失败：${report.wecom.error}` : null;
    const allIssues = [...pm2Issues, ...(gatewayIssue ? [gatewayIssue] : []), ...(wecomIssue ? [wecomIssue] : [])];

    const summary = allIssues.length === 0
      ? '✅ 系统健康：所有进程在线，Gateway 和 wecom 均可达'
      : `⚠️ 发现 ${allIssues.length} 个问题：\n${allIssues.map(i => `  - ${i}`).join('\n')}`;

    return `${summary}\n\nPM2 进程：\n${report.pm2.map(p => `  ${p.ok ? '✅' : '❌'} ${p.name}（${p.status}，重启${p.restarts}次，内存${p.memMB}MB）`).join('\n')}\n\n日志错误（最近1h）：\n${report.logErrors.length === 0 ? '  无' : report.logErrors.slice(0, 5).map(e => `  ${e}`).join('\n')}`;
  }

  if (toolName === 'scan_lucas_quality') {
    const issues = [];
    try {
      // 获取 conversations 集合 UUID
      const colResp = await fetch(`${CHROMA_API_BASE}/conversations`);
      if (!colResp.ok) return `ChromaDB conversations 集合不可达：${colResp.status}`;
      const { id: colId } = await colResp.json();

      // 查最近 50 条 Lucas 回复（fromType=human 已过滤 pipeline 对话）
      const getResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          where:   { fromType: { '$eq': 'human' } },
          include: ['documents', 'metadatas'],
          limit:   50,
        }),
      });
      if (!getResp.ok) return `ChromaDB 查询失败：${getResp.status}`;
      const data = await getResp.json();
      const docs  = data.documents || [];
      const metas = data.metadatas || [];

      const MARKDOWN_TITLE_RE = /^#{1,4}\s+.{2,40}$/m;
      // 精确承诺词：只检测强承诺动词，排除「已了解/已知道/已确认」等合理用法
      const COMMITMENT_RE     = /已(提交|修复|告知|报告|转告|安排)(?!了解|知道|确认)/;
      const SHORT_REPLY_MAX   = 10;

      docs.forEach((doc, i) => {
        const meta   = metas[i] || {};
        const reply  = (meta.response || doc || '').toString();
        const ts     = meta.timestamp || '';
        const ctx    = ts ? `（${ts.slice(0, 10)}）` : '';

        if (!reply || reply.trim().length === 0) {
          issues.push({ type: '空回复', ctx, preview: '（空）' });
        } else if (reply.trim().length < SHORT_REPLY_MAX) {
          issues.push({ type: '过短回复', ctx, preview: reply.trim() });
        } else if (MARKDOWN_TITLE_RE.test(reply)) {
          issues.push({ type: 'Markdown 格式违规', ctx, preview: reply.slice(0, 80).trim() });
        } else if (COMMITMENT_RE.test(reply)) {
          issues.push({ type: '可能幻觉承诺', ctx, preview: reply.slice(0, 80).trim() });
        }
      });

      if (issues.length === 0) {
        return `✅ Lucas 质量扫描通过：最近 ${docs.length} 条对话无明显质量问题`;
      }
      const summary = issues.slice(0, 10).map((iss, i) => `  ${i + 1}. [${iss.type}] ${iss.ctx} ${iss.preview}`).join('\n');
      return `⚠️ 发现 ${issues.length} 个质量问题（展示前10条）：\n${summary}\n\n建议：将典型问题记录到 AGENTS.md 禁令 + 下次 before_prompt_build 注入示例`;
    } catch (e) {
      return `质量扫描失败：${e.message}`;
    }
  }

  if (toolName === 'update_heartbeat') {
    const heartbeatPath = `${process.env.HOME}/.openclaw/workspace-main/HEARTBEAT.md`;
    try {
      let hb = fs.readFileSync(heartbeatPath, 'utf8');
      const { operation, observation } = toolInput;
      const nowIso = nowCST();
      const nowLocal = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

      if (operation === 'append_observation') {
        if (!observation) return '错误：append_observation 需要提供 observation 字段';
        const line = `- [${nowLocal}] ${observation}`;
        hb = hb.replace(/(## 待汇总观察[^\n]*\n)/, `$1${line}\n`);
        fs.writeFileSync(heartbeatPath, hb, 'utf8');
        return `已追加观察：${line}`;
      }

      if (operation === 'mark_daily_sent') {
        // 清空待汇总观察节（保留节标题）
        hb = hb.replace(/(## 待汇总观察[^\n]*\n)([\s\S]*?)(## |$)/, (_, heading, _content, next) => {
          return `${heading}\n${next}`;
        });
        // 更新或新增「上次日报发送」字段
        if (hb.includes('- 上次日报发送：')) {
          hb = hb.replace(/- 上次日报发送：.*/, `- 上次日报发送：${nowIso}`);
        } else {
          hb = hb.replace(/(- 上次质量扫描：[^\n]*)/, `$1\n- 上次日报发送：${nowIso}`);
        }
        fs.writeFileSync(heartbeatPath, hb, 'utf8');
        return `日报已标记发送，待汇总观察已清空（${nowLocal}）`;
      }

      return `未知 operation：${operation}`;
    } catch (e) {
      return `update_heartbeat 失败：${e.message}`;
    }
  }

  if (toolName === 'log_improvement_task') {
    const tasksPath = path.join(HOMEAI_ROOT, 'Data', 'main-pending-tasks.json');
    try {
      const { title, description, priority = 'medium' } = toolInput;
      if (!title || !description) return '错误：title 和 description 必填';

      // 读取现有任务文件（不存在则初始化）
      let data = { tasks: [] };
      if (fs.existsSync(tasksPath)) {
        try { data = JSON.parse(fs.readFileSync(tasksPath, 'utf8')); } catch {}
      }
      if (!Array.isArray(data.tasks)) data.tasks = [];

      // 重复检测：pending 任务中存在标题关键词高度重叠的则跳过
      // 防止每次巡检都写入同一类问题（如 operator.read、chromadb、false_commitment）
      const pendingTasks = data.tasks.filter(t => t.status === 'pending');
      const titleWords = title.toLowerCase().split(/[\s，。：、\-\(（\)）]+/).filter(w => w.length >= 3);
      const duplicate = pendingTasks.find(t => {
        const existWords = t.title.toLowerCase().split(/[\s，。：、\-\(（\)）]+/).filter(w => w.length >= 3);
        const overlap = titleWords.filter(w => existWords.includes(w)).length;
        // 2 个以上实质词重叠 = 同类任务
        return overlap >= 2;
      });
      if (duplicate) {
        return `⚠️ 已存在类似 pending 任务 [${duplicate.id}]：「${duplicate.title}」，跳过重复记录。如问题已处理请先将原任务标为 done。`;
      }

      // 生成任务 ID（日期+序号）
      const today = todayCST();
      const todayCount = data.tasks.filter(t => t.id.startsWith(`mt-${today}`)).length;
      const id = `mt-${today}-${String(todayCount + 1).padStart(3, '0')}`;

      const task = {
        id,
        createdAt: nowCST(),
        priority,
        title,
        description,
        status: 'pending',
        source: 'main_monitor',
      };
      data.tasks.push(task);

      fs.mkdirSync(path.dirname(tasksPath), { recursive: true });
      fs.writeFileSync(tasksPath, JSON.stringify(data, null, 2), 'utf8');
      return `✅ 已记录改进任务 [${id}]：${title}（优先级：${priority}）`;
    } catch (e) {
      return `log_improvement_task 失败：${e.message}`;
    }
  }

  // ─── L0~L2 系统评估工具 ──────────────────────────────────────────────────────

  if (toolName === 'evaluate_l0') {
    const results = [];
    let score = '✅';

    // 1. gateway-watchdog 是否在 PM2
    try {
      const pmRaw = execSync('pm2 jlist', { encoding: 'utf8', timeout: 8000 });
      const procs = JSON.parse(pmRaw);
      const wdog  = procs.find(p => p.name === 'gateway-watchdog');
      if (!wdog) {
        results.push('❌ gateway-watchdog：不在 PM2，蒸馏定时触发缺失');
        score = '❌';
      } else if (wdog.pm2_env?.status !== 'online') {
        results.push(`⚠️ gateway-watchdog：状态 ${wdog.pm2_env?.status}（非 online）`);
        if (score === '✅') score = '⚠️';
      } else {
        const restarts = wdog.pm2_env?.restart_time ?? 0;
        results.push(`✅ gateway-watchdog：online（重启 ${restarts} 次）`);
      }
    } catch (e) {
      results.push(`⚠️ gateway-watchdog：检查失败（${e.message.slice(0, 60)}）`);
      if (score === '✅') score = '⚠️';
    }

    // 2. Kuzu 知识图谱 Fact 数量（Python 查询，os._exit(0) 防 SIGBUS）
    const kuzuPath  = path.join(HOMEAI_ROOT, 'Data', 'kuzu');
    const kuzuScript = `
import sys, json, os
sys.path.insert(0, '/opt/homebrew/lib/python3.11/site-packages')
try:
    import kuzu
    db   = kuzu.Database('${kuzuPath}')
    conn = kuzu.Connection(db)
    r1   = conn.execute('MATCH ()-[f:Fact]->() RETURN count(f)')
    facts = r1.get_next()[0]
    r2   = conn.execute("MATCH (e:Entity) WHERE e.type = 'person' RETURN count(e)")
    persons = r2.get_next()[0]
    r3   = conn.execute('MATCH (e:Entity) RETURN count(e)')
    entities = r3.get_next()[0]
    print(json.dumps({'facts': facts, 'persons': persons, 'entities': entities}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
sys.stdout.flush()
os._exit(0)
`.trim();
    try {
      const tmpPy = path.join(HOMEAI_ROOT, 'temp', `eval-l0-kuzu-${Date.now()}.py`);
      fs.mkdirSync(path.join(HOMEAI_ROOT, 'temp'), { recursive: true });
      fs.writeFileSync(tmpPy, kuzuScript);
      const kuzuOut = execSync(`${PYTHON311} ${tmpPy}`, { encoding: 'utf8', timeout: 20000 }).trim();
      try { fs.unlinkSync(tmpPy); } catch (_) {}
      const kd = JSON.parse(kuzuOut);
      if (kd.error) {
        results.push(`⚠️ Kuzu 查询失败：${kd.error.slice(0, 80)}`);
        if (score === '✅') score = '⚠️';
      } else {
        const factsOk = kd.facts > 0;
        results.push(`${factsOk ? '✅' : '⚠️'} Kuzu 知识图谱：${kd.facts} 条 Fact，${kd.entities} 个 Entity（其中 ${kd.persons} 个 Person）`);
        if (!factsOk && score === '✅') score = '⚠️';
      }
    } catch (e) {
      try { } catch (_) {}
      results.push(`⚠️ Kuzu 查询异常：${e.message.slice(0, 80)}`);
      if (score === '✅') score = '⚠️';
    }

    // 3. ChromaDB conversations 总量
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/conversations`);
      if (!colResp.ok) {
        results.push(`❌ ChromaDB conversations 不可达：${colResp.status}`);
        score = '❌';
      } else {
        const { id: colId } = await colResp.json();
        const countResp = await fetch(`${CHROMA_API_BASE}/${colId}/count`);
        const count = countResp.ok ? await countResp.json() : '?';
        results.push(`✅ ChromaDB conversations：${count} 条对话记录`);
      }
    } catch (e) {
      results.push(`⚠️ ChromaDB 查询失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 4. 上次蒸馏时间估算（取 data/family 最新 inject.md 修改时间）
    try {
      const familyDir = path.join(process.env.HOME, '.openclaw', 'workspace-lucas', 'family');
      if (fs.existsSync(familyDir)) {
        const files = fs.readdirSync(familyDir).filter(f => f.endsWith('.inject.md'));
        if (files.length === 0) {
          results.push('⚠️ 家人档案：无 inject.md 文件（蒸馏未生成档案）');
          if (score === '✅') score = '⚠️';
        } else {
          const mtimes = files.map(f => fs.statSync(path.join(familyDir, f)).mtimeMs);
          const latest = new Date(Math.max(...mtimes));
          const hoursAgo = ((Date.now() - latest.getTime()) / 3600000).toFixed(1);
          const stale = parseFloat(hoursAgo) > 48;
          results.push(`${stale ? '⚠️' : '✅'} 家人档案最后更新：${hoursAgo} 小时前（${files.length} 个成员）`);
          if (stale && score === '✅') score = '⚠️';
        }
      } else {
        results.push('⚠️ 家人档案目录不存在');
        if (score === '✅') score = '⚠️';
      }
    } catch (e) {
      results.push(`⚠️ 家人档案检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 5. ChromaDB decisions 集合可达性
    try {
      const decResp = await fetch(`${CHROMA_API_BASE}/decisions`);
      if (!decResp.ok) {
        results.push(`⚠️ ChromaDB decisions 集合不可达：${decResp.status}`);
        if (score === '✅') score = '⚠️';
      } else {
        const { id: decId } = await decResp.json();
        const cntResp = await fetch(`${CHROMA_API_BASE}/${decId}/count`);
        const decCount = cntResp.ok ? await cntResp.json() : '?';
        results.push(`✅ ChromaDB decisions：${decCount} 条决策记忆`);
      }
    } catch (e) {
      results.push(`⚠️ ChromaDB decisions 检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 6. 软硬件性能指标
    try {
      // 6a. 磁盘空间
      const dfRaw = execSync(`df -h "${HOMEAI_ROOT}"`, { encoding: 'utf8', timeout: 5000 });
      const dfLine = dfRaw.split('\n').find(l => l.includes('/'));
      if (dfLine) {
        const parts = dfLine.trim().split(/\s+/);
        const usePct = parts[parts.length - 1]; // e.g. 85%
        const avail = parts[parts.length - 2]; // e.g. 50Gi
        const pct = parseInt(usePct);
        if (pct > 95) {
          results.push(`❌ 磁盘空间：已用 ${usePct}，仅剩 ${avail}（严重不足）`);
          score = '❌';
        } else if (pct > 85) {
          results.push(`⚠️ 磁盘空间：已用 ${usePct}，剩余 ${avail}`);
          if (score === '✅') score = '⚠️';
        } else {
          results.push(`✅ 磁盘空间：已用 ${usePct}，剩余 ${avail}`);
        }
      }
    } catch (e) {
      results.push(`⚠️ 磁盘空间检查失败：${e.message.slice(0, 40)}`);
      if (score === '✅') score = '⚠️';
    }

    try {
      // 6b. 内存使用（macOS vm_stat）
      const vmRaw = execSync('vm_stat', { encoding: 'utf8', timeout: 5000 });
      const freeMatch = vmRaw.match(/Pages free:\s+(\d+)/);
      const activeMatch = vmRaw.match(/Pages active:\s+(\d+)/);
      const inactiveMatch = vmRaw.match(/Pages inactive:\s+(\d+)/);
      if (freeMatch && activeMatch) {
        const pageSize = 16384; // macOS ARM64
        const free = parseInt(freeMatch[1]) * pageSize;
        const active = parseInt(activeMatch[1]) * pageSize;
        const total = free + active + (inactiveMatch ? parseInt(inactiveMatch[1]) * pageSize : 0);
        const usedPct = Math.round(active / total * 100);
        const freeGB = (free / 1073741824).toFixed(1);
        if (usedPct > 90) {
          results.push(`⚠️ 内存：活跃 ${usedPct}%，空闲 ${freeGB}GB（偏高）`);
          if (score === '✅') score = '⚠️';
        } else {
          results.push(`✅ 内存：活跃 ${usedPct}%，空闲 ${freeGB}GB`);
        }
      }
    } catch (e) {
      // vm_stat 非关键，静默跳过
    }

    try {
      // 6c. Gateway 响应延迟
      const gwStart = Date.now();
      const gwResp = await fetch('http://localhost:18789/health', { signal: AbortSignal.timeout(10000) });
      const gwMs = Date.now() - gwStart;
      if (!gwResp.ok) {
        results.push(`❌ Gateway 延迟：响应 ${gwResp.status}（${gwMs}ms）`);
        score = '❌';
      } else if (gwMs > 3000) {
        results.push(`⚠️ Gateway 延迟：${gwMs}ms（偏慢）`);
        if (score === '✅') score = '⚠️';
      } else {
        results.push(`✅ Gateway 延迟：${gwMs}ms`);
      }
    } catch (e) {
      // Gateway 不可达已在 scan_pipeline_health 检查，此处不重复计分
    }

    try {
      // 6d. ChromaDB 响应延迟
      const chrStart = Date.now();
      const chrResp = await fetch(`${CHROMA_API_BASE}/heartbeat`, { signal: AbortSignal.timeout(10000) });
      const chrMs = Date.now() - chrStart;
      if (!chrResp.ok) {
        results.push(`⚠️ ChromaDB 延迟：响应 ${chrResp.status}（${chrMs}ms）`);
        if (score === '✅') score = '⚠️';
      } else if (chrMs > 2000) {
        results.push(`⚠️ ChromaDB 延迟：${chrMs}ms（偏慢）`);
        if (score === '✅') score = '⚠️';
      } else {
        results.push(`✅ ChromaDB 延迟：${chrMs}ms`);
      }
    } catch (e) {
      // ChromaDB 不可达已在其他检查覆盖
    }

    // 7. Kuzu 协作边数量（L3 数据就绪信号，co_discusses/requests_from/supports/role_in_context）
    const collabScript = `
import sys, json, os
sys.path.insert(0, '/opt/homebrew/lib/python3.11/site-packages')
try:
    import kuzu
    db   = kuzu.Database('${kuzuPath}')
    conn = kuzu.Connection(db)
    counts = {}
    for rel in ['co_discusses', 'requests_from', 'supports', 'role_in_context', 'active_thread']:
        r = conn.execute("MATCH ()-[f:Fact {relation: '" + rel + "'}]->() RETURN count(f)")
        counts[rel] = r.get_next()[0] if r.has_next() else 0
    collab_total = sum(v for k, v in counts.items() if k != 'active_thread')
    print(json.dumps({'counts': counts, 'total': collab_total}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
sys.stdout.flush()
os._exit(0)
`.trim();
    try {
      const tmpCollab = path.join(HOMEAI_ROOT, 'temp', `eval-l0-collab-${Date.now()}.py`);
      fs.mkdirSync(path.join(HOMEAI_ROOT, 'temp'), { recursive: true });
      fs.writeFileSync(tmpCollab, collabScript);
      const collabOut = execSync(`${PYTHON311} ${tmpCollab}`, { encoding: 'utf8', timeout: 20000 }).trim();
      try { fs.unlinkSync(tmpCollab); } catch (_) {}
      const cd = JSON.parse(collabOut);
      if (cd.error) {
        results.push(`⚠️ Kuzu 协作边查询失败：${cd.error.slice(0, 80)}`);
        if (score === '✅') score = '⚠️';
      } else {
        const c = cd.counts || {};
        const detail = Object.entries(c)
          .filter(([, v]) => v > 0)
          .map(([k, v]) => `${k}:${v}`)
          .join(' / ') || '无';
        results.push(`${cd.total > 0 ? '✅' : '⚪'} Kuzu 协作边（L3）：${cd.total} 条（${detail}）`);
      }
    } catch (e) {
      results.push(`⚠️ Kuzu 协作边查询异常：${e.message.slice(0, 80)}`);
      if (score === '✅') score = '⚠️';
    }

    // 数值评分：从 results 文本提取原始值，对照 rubric 计算 0-5 分
    const _rub0 = loadRubric();
    const _L0I = _rub0?.layers?.L0?.items;
    const _l0s = [];
    if (_L0I) {
      for (const r of results) {
        if (r.includes('gateway-watchdog')) trackScore(_l0s, _L0I, 'process_alive', r.includes('online') ? 'online' : (r.includes('不在') ? 'missing' : 'stopped'));
        if (r.includes('Kuzu 知识图谱')) { const m = r.match(/(\d+) 条 Fact/); if (m) trackScore(_l0s, _L0I, 'kuzu_data', +m[1]); }
        if (r.includes('ChromaDB conversations')) trackScore(_l0s, _L0I, 'chromadb_conversations', r.trim().startsWith('✅') ? 'reachable' : 'unreachable');
        if (r.includes('家人档案最后更新')) { const m = r.match(/([\d.]+) 小时前/); if (m) trackScore(_l0s, _L0I, 'data_freshness', +m[1]); }
        else if (r.includes('家人档案')) trackScore(_l0s, _L0I, 'data_freshness', 9999);
        if (r.includes('ChromaDB decisions') && !r.includes('延迟')) trackScore(_l0s, _L0I, 'chromadb_decisions', r.trim().startsWith('✅') ? 'reachable' : 'unreachable');
        if (r.includes('磁盘空间')) { const m = r.match(/已用 (\d+)%/); if (m) trackScore(_l0s, _L0I, 'disk_space', +m[1]); }
        if (r.includes('Gateway 延迟')) { const m = r.match(/(\d+)ms/); if (m) trackScore(_l0s, _L0I, 'gateway_latency', +m[1]); }
        if (r.includes('ChromaDB 延迟')) { const m = r.match(/(\d+)ms/); if (m) trackScore(_l0s, _L0I, 'chromadb_latency', +m[1]); }
        if (r.includes('内存') && r.includes('活跃')) { const m = r.match(/活跃 (\d+)%/); if (m) trackScore(_l0s, _L0I, 'memory_usage', +m[1]); }
        if (r.includes('Kuzu 协作边（L3）')) { const m = r.match(/(\d+) 条（/); if (m) trackScore(_l0s, _L0I, 'collab_edges_readiness', +m[1]); }
      }
      if (_l0s.length > 0) {
        const _wa = calcWeightedAvg(_l0s);
        _evalScores.L0 = { items: _l0s, weighted: _wa };
        score += ` · ${_wa.toFixed(1)}/5.0`;
      }
    }
    return `**L0 评估 ${score}**\n${results.map(r => `  ${r}`).join('\n')}`;
  }

  if (toolName === 'evaluate_l1') {
    const results = [];
    let score = '✅';

    // 1. Lucas 质量扫描（复用 scan_lucas_quality 逻辑）
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/conversations`);
      if (!colResp.ok) {
        results.push(`❌ Lucas：ChromaDB 不可达`);
        score = '❌';
      } else {
        const { id: colId } = await colResp.json();
        const getResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ where: { fromType: { '$eq': 'human' } }, include: ['documents', 'metadatas'], limit: 30 }),
        });
        if (!getResp.ok) {
          results.push(`⚠️ Lucas：ChromaDB 查询失败 ${getResp.status}`);
          if (score === '✅') score = '⚠️';
        } else {
          const data = await getResp.json();
          const docs  = data.documents || [];
          const metas = data.metadatas || [];
          const MARKDOWN_TITLE_RE = /^#{1,4}\s+.{2,40}$/m;
          // 精确承诺词：只检测强承诺动词，排除「已了解/已知道/已确认」等合理用法
          const COMMITMENT_RE = /已(提交|修复|告知|报告|转告|安排)(?!了解|知道|确认)/;
          let lucasIssues = 0;
          docs.forEach((doc, i) => {
            const reply = ((metas[i] || {}).response || doc || '').toString();
            if (!reply || reply.trim().length < 5) lucasIssues++;
            else if (MARKDOWN_TITLE_RE.test(reply)) lucasIssues++;
            else if (COMMITMENT_RE.test(reply)) lucasIssues++;
          });
          const issueRate = docs.length > 0 ? (lucasIssues / docs.length * 100).toFixed(0) : 0;
          const ok = lucasIssues <= 2;
          results.push(`${ok ? '✅' : '⚠️'} Lucas 质量：最近 ${docs.length} 条，${lucasIssues} 条疑似问题（问题率 ${issueRate}%）`);
          if (!ok && score === '✅') score = '⚠️';
        }
      }
    } catch (e) {
      results.push(`⚠️ Lucas 质量扫描失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 2. Andy/Lisa agent_interactions 抽查
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/agent_interactions`);
      if (!colResp.ok) {
        results.push(`⚠️ Andy/Lisa：agent_interactions 集合不可达`);
        if (score === '✅') score = '⚠️';
      } else {
        const { id: colId } = await colResp.json();
        const getResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ include: ['metadatas'], limit: 20 }),
        });
        if (getResp.ok) {
          const data  = await getResp.json();
          const metas = data.metadatas || [];
          const andyCount = metas.filter(m => (m.agentId || '').toLowerCase().includes('andy')).length;
          const lisaCount = metas.filter(m => (m.agentId || '').toLowerCase().includes('lisa')).length;
          results.push(`✅ Andy/Lisa 活跃：最近 20 条交互中 Andy ${andyCount} 条，Lisa ${lisaCount} 条`);
        } else {
          results.push(`⚠️ agent_interactions 查询失败：${getResp.status}`);
          if (score === '✅') score = '⚠️';
        }
      }
    } catch (e) {
      results.push(`⚠️ agent_interactions 检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 3. 家人档案注入文件完整性
    try {
      const familyDir = path.join(process.env.HOME, '.openclaw', 'workspace-lucas', 'family');
      if (!fs.existsSync(familyDir)) {
        results.push('⚠️ 家人档案目录不存在（before_prompt_build 注入将失败）');
        if (score === '✅') score = '⚠️';
      } else {
        const injects = fs.readdirSync(familyDir).filter(f => f.endsWith('.inject.md'));
        results.push(`${injects.length > 0 ? '✅' : '⚠️'} 家人档案注入文件：${injects.length} 个（${injects.map(f => f.replace('.inject.md', '')).join(', ') || '无'}）`);
        if (injects.length === 0 && score === '✅') score = '⚠️';
      }
    } catch (e) {
      results.push(`⚠️ 档案注入文件检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 4. Andy/Lisa 蒸馏产出检查（decisions 集合 design_learning / impl_learning）
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/decisions`);
      if (colResp.ok) {
        const { id: colId } = await colResp.json();
        // Andy design_learning
        const andyResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            where: { '$and': [{ agent: { '$eq': 'andy' } }, { type: { '$eq': 'design_learning' } }] },
            include: ['metadatas'], limit: 50,
          }),
        });
        const andyData = andyResp.ok ? await andyResp.json() : { ids: [] };
        const andyCount = (andyData.ids || []).length;
        // Lisa impl_learning
        const lisaResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            where: { '$and': [{ agent: { '$eq': 'lisa' } }, { type: { '$eq': 'impl_learning' } }] },
            include: ['metadatas'], limit: 50,
          }),
        });
        const lisaData = lisaResp.ok ? await lisaResp.json() : { ids: [] };
        const lisaCount = (lisaData.ids || []).length;
        // learning_objective（andy+lisa）
        const objResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            where: { type: { '$eq': 'learning_objective' } },
            include: ['metadatas'], limit: 50,
          }),
        });
        const objData = objResp.ok ? await objResp.json() : { ids: [] };
        const objCount = (objData.ids || []).length;
        const hasLearnings = andyCount > 0 || lisaCount > 0;
        results.push(`${hasLearnings ? '✅' : '⚠️'} Andy/Lisa 每日自我进化产出：design_learning ${andyCount} 条，impl_learning ${lisaCount} 条${!hasLearnings ? '（尚未运行，每日凌晨 1 点触发）' : ''}`);
        results.push(`${objCount > 0 ? '✅' : '⚠️'} Andy 每日学习目标：${objCount} 条${objCount === 0 ? '（尚未运行，每日凌晨 1 点触发）' : ''}`);
        if (!hasLearnings && score === '✅') score = '⚠️';
      }
    } catch (e) {
      results.push(`⚠️ Andy/Lisa 每日自我进化产出检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 5. Kuzu has_pattern 积累量（Andy/Lisa 行为模式蒸馏节点数）
    const l1KuzuPath = path.join(HOMEAI_ROOT, 'Data', 'kuzu');
    try {
      const kuzuCheck = path.join(HOMEAI_ROOT, 'temp', `_l1_pattern_check_${Date.now()}.py`);
      fs.mkdirSync(path.join(HOMEAI_ROOT, 'temp'), { recursive: true });
      const script = `import sys, os, json
try:
    import kuzu
    db   = kuzu.Database("${l1KuzuPath}")
    conn = kuzu.Connection(db)
    counts = {}
    for agent in ['andy', 'lisa']:
        res = conn.execute(
            "MATCH (a:Entity {id: $aid})-[f:Fact {relation: 'has_pattern'}]->(p:Entity) "
            "WHERE f.valid_until IS NULL RETURN count(*)",
            {'aid': agent}
        )
        counts[agent] = res.get_next()[0] if res.has_next() else 0
    sys.stdout.write(json.dumps(counts))
    sys.stdout.flush()
except Exception as e:
    sys.stdout.write(json.dumps({'error': str(e)}))
    sys.stdout.flush()
os._exit(0)
`;
      fs.writeFileSync(kuzuCheck, script);
      const { execFileSync } = require('child_process');
      const out = execFileSync(PYTHON311, [kuzuCheck], { timeout: 20_000, encoding: 'utf8' }).trim();
      fs.unlinkSync(kuzuCheck);
      const counts = JSON.parse(out || '{}');
      if (counts.error) {
        results.push(`⚠️ Kuzu 模式积累查询失败：${counts.error.slice(0, 60)}`);
      } else {
        const andyP = counts.andy || 0;
        const lisaP = counts.lisa || 0;
        results.push(`${(andyP > 0 && lisaP > 0) ? '✅' : '⚠️'} Kuzu 模式积累：Andy ${andyP} 条，Lisa ${lisaP} 条 has_pattern`);
        if (andyP === 0 || lisaP === 0) {
          if (score === '✅') score = '⚠️';
        }
      }
    } catch (e) {
      results.push(`⚠️ Kuzu has_pattern 检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 6. Main 健康检查（HEARTBEAT 正常运行 + 最近日志无异常）
    try {
      const hbPath = path.join(process.env.HOME, '.openclaw', 'workspace-main', 'HEARTBEAT.md');
      if (fs.existsSync(hbPath)) {
        const hbContent = fs.readFileSync(hbPath, 'utf8');
        const lastCheck = hbContent.match(/上次健康检查：(.+)/);
        const lastQuality = hbContent.match(/上次质量扫描：(.+)/);
        const pending = (hbContent.match(/^- \[.*\]/gm) || []).length;
        results.push(`✅ Main：HEARTBEAT 正常（上次检查 ${lastCheck ? lastCheck[1].slice(0, 19) : '未知'}，待汇总 ${pending} 条）`);
      } else {
        results.push('⚠️ Main：HEARTBEAT.md 不存在');
        if (score === '✅') score = '⚠️';
      }
    } catch (e) {
      results.push(`⚠️ Main 检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 7. Lucas 子 Agent（访客影子 / evaluator）活跃度
    try {
      // 访客影子
      const shadowDir = path.join(HOMEAI_ROOT, 'Data', 'corpus');
      const shadowFiles = fs.existsSync(shadowDir) ? fs.readdirSync(shadowDir).filter(f => f.startsWith('shadow-')) : [];
      results.push(`${shadowFiles.length > 0 ? '✅' : '⚪'} Lucas 子 Agent：${shadowFiles.length} 个访客影子语料`);

      // evaluator 活跃度（从 agent_interactions 查 andy-evaluator / lisa-evaluator）
      const colResp = await fetch(`${CHROMA_API_BASE}/agent_interactions`);
      if (colResp.ok) {
        const { id: colId } = await colResp.json();
        for (const evalAgent of ['andy-evaluator', 'lisa-evaluator']) {
          const evalResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ where: { agentId: { '$eq': evalAgent } }, include: ['metadatas'], limit: 5 }),
          });
          if (evalResp.ok) {
            const evalData = await evalResp.json();
            const evalCount = (evalData.ids || []).length;
            results.push(`${evalCount > 0 ? '✅' : '⚪'} ${evalAgent}：最近 ${evalCount} 条交互`);
          }
        }
      }
    } catch (e) {
      results.push(`⚠️ 子 Agent 检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 数值评分
    const _rub1 = loadRubric();
    const _L1I = _rub1?.layers?.L1?.items;
    const _l1s = [];
    if (_L1I) {
      for (const r of results) {
        if (r.includes('Lucas 质量')) { const m = r.match(/问题率 (\d+)%/); if (m) trackScore(_l1s, _L1I, 'lucas_output_quality', +m[1]); }
        if (r.includes('Andy/Lisa 活跃') || r.includes('Andy/Lisa：')) { const ac = (r.match(/Andy (\d+)/)?.[1] || 0) > 0; const lc = (r.match(/Lisa (\d+)/)?.[1] || 0) > 0; trackScore(_l1s, _L1I, 'agent_interactions', ac && lc ? 'both_active' : (ac || lc ? 'one_active' : 'none_active')); }
        if (r.includes('家人档案注入文件')) { const m = r.match(/(\d+) 个/); if (m) trackScore(_l1s, _L1I, 'family_inject', +m[1]); }
        if (r.includes('每日自我进化产出')) { const ac = (r.match(/design_learning (\d+)/)?.[1] || 0) > 0; const lc = (r.match(/impl_learning (\d+)/)?.[1] || 0) > 0; trackScore(_l1s, _L1I, 'distillation_output', ac && lc ? 'both_active' : (ac || lc ? 'one_active' : 'none_active')); }
        if (r.includes('Kuzu 模式积累')) { const ac = (r.match(/Andy (\d+)/)?.[1] || 0) > 0; const lc = (r.match(/Lisa (\d+)/)?.[1] || 0) > 0; trackScore(_l1s, _L1I, 'pattern_accumulation', ac && lc ? 'both_active' : (ac || lc ? 'one_active' : 'none_active')); }
        if (r.includes('Main') && r.includes('HEARTBEAT')) trackScore(_l1s, _L1I, 'main_heartbeat', r.trim().startsWith('✅') ? 'ok' : 'missing');
        if (r.includes('子 Agent') || r.includes('andy-evaluator') || r.includes('lisa-evaluator')) { /* scored separately below */ }
      }
      // 子 Agent 活跃度（汇总 evaluator + shadow 计数）
      let subCount = 0;
      for (const r of results) {
        if (r.includes('andy-evaluator') && r.trim().startsWith('✅')) subCount++;
        if (r.includes('lisa-evaluator') && r.trim().startsWith('✅')) subCount++;
        if (r.includes('访客影子语料') && !r.includes('0 个')) subCount++;
      }
      trackScore(_l1s, _L1I, 'sub_agent_activity', subCount);
      if (_l1s.length > 0) {
        const _wa = calcWeightedAvg(_l1s);
        _evalScores.L1 = { items: _l1s, weighted: _wa };
        score += ` · ${_wa.toFixed(1)}/5.0`;
      }
    }

    return `**L1 评估 ${score}**\n` +
      `【记忆质量】\n` + results.filter(r => r.includes('档案') || r.includes('模式积累')).map(r => `  ${r}`).join('\n') + '\n' +
      `【输出质量】\n` + results.filter(r => !r.includes('档案') && !r.includes('模式积累')).map(r => `  ${r}`).join('\n');
  }

  if (toolName === 'inspect_agent_context') {
    const agent = (toolInput.agent || 'andy').toLowerCase();
    const wsDir  = path.join(process.env.HOME, '.openclaw', `workspace-${agent}`);
    const lines  = [`**${agent.toUpperCase()} 上下文快照**\n`];

    // 1. 静态文件摘要（前 8 行，了解关键内容是否存在）
    const staticFiles = agent === 'andy'
      ? [['ARCH.md', '系统架构'], ['MEMORY.md', '设计积累'], ['DESIGN-PRINCIPLES.md', '判断规则']]
      : [['CODEBASE.md', '代码库上下文'], ['MEMORY.md', '实现积累']];
    lines.push('**── 常驻静态注入 ──**');
    for (const [fname, label] of staticFiles) {
      const fpath = path.join(wsDir, fname);
      if (!fs.existsSync(fpath)) {
        lines.push(`  ❌ ${label}（${fname}）：文件不存在`);
      } else {
        const content = fs.readFileSync(fpath, 'utf8');
        const preview = content.split('\n').filter(l => l.trim()).slice(0, 6).join('\n  ');
        const bytes   = Buffer.byteLength(content, 'utf8');
        lines.push(`  ✅ ${label}（${fname}，${(bytes/1024).toFixed(1)}KB）：\n  ${preview}`);
      }
      lines.push('');
    }

    // 2. ChromaDB decisions 最近条目（各类型分开展示）
    lines.push('**── decisions 蒸馏产出 ──**');
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/decisions`);
      if (colResp.ok) {
        const { id: colId } = await colResp.json();
        const typeLabels = agent === 'andy'
          ? [['design_learning', '设计判断'], ['learning_objective', '学习目标'], ['spec', '历史决策']]
          : [['impl_learning', '代码库认知'], ['learning_objective', '学习目标'], ['constraint', '平台约束']];
        for (const [type, label] of typeLabels) {
          const where = type === 'learning_objective'
            ? { '$and': [{ agent: { '$eq': agent } }, { type: { '$eq': type } }] }
            : { '$and': [{ agent: { '$eq': agent } }, { type: { '$eq': type } }] };
          const resp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ where, include: ['documents', 'metadatas'], limit: 5 }),
          });
          if (!resp.ok) continue;
          const data = await resp.json();
          const docs  = data.documents || [];
          const metas = data.metadatas || [];
          if (docs.length === 0) {
            lines.push(`  ⚪ ${label}（${type}）：0 条`);
          } else {
            lines.push(`  ✅ ${label}（${type}）：${docs.length} 条，最新：`);
            docs.slice(0, 3).forEach((d, i) => {
              const date = (metas[i]?.date || metas[i]?.timestamp || '').slice(0, 10);
              lines.push(`    - [${date}] ${d.slice(0, 120)}`);
            });
          }
        }
      }
    } catch (e) {
      lines.push(`  ⚠️ decisions 查询失败：${e.message.slice(0, 60)}`);
    }
    lines.push('');

    // 3. Kuzu has_pattern 积累
    lines.push('**── Kuzu 模式积累（has_pattern）──**');
    try {
      const tmpScript = path.join(HOMEAI_ROOT, 'scripts', '_inspect_ctx_kuzu.py');
      const script = `import sys, os, json
try:
    import kuzu
    db   = kuzu.Database("${path.join(HOMEAI_ROOT, 'Data', 'kuzu')}")
    conn = kuzu.Connection(db)
    res  = conn.execute(
        "MATCH (a:Entity {id: $aid})-[f:Fact {relation: 'has_pattern'}]->(p:Entity) "
        "WHERE f.valid_until IS NULL RETURN p.name, f.context, f.confidence ORDER BY f.confidence DESC LIMIT 5",
        {'aid': '${agent}'}
    )
    rows = []
    for row in res:
        rows.append({'name': row[0], 'context': row[1], 'confidence': row[2]})
    sys.stdout.write(json.dumps({'rows': rows}))
    sys.stdout.flush()
except Exception as e:
    sys.stdout.write(json.dumps({'error': str(e)}))
    sys.stdout.flush()
os._exit(0)
`;
      fs.writeFileSync(tmpScript, script);
      const { execFileSync } = require('child_process');
      const out = execFileSync(PYTHON311, [tmpScript], { timeout: 20_000, encoding: 'utf8' }).trim();
      fs.unlinkSync(tmpScript);
      const data = JSON.parse(out || '{}');
      if (data.error) {
        lines.push(`  ⚠️ 查询失败：${data.error.slice(0, 60)}`);
      } else if ((data.rows || []).length === 0) {
        lines.push('  ⚪ 尚无 has_pattern 节点（distill-agent-memories.py 尚未产出）');
      } else {
        for (const r of data.rows) {
          lines.push(`  ✅ [${(r.confidence || 0).toFixed(2)}] ${r.name}：${(r.context || '').slice(0, 100)}`);
        }
      }
    } catch (e) {
      lines.push(`  ⚠️ Kuzu 查询失败：${e.message.slice(0, 60)}`);
    }

    return lines.join('\n');
  }

  if (toolName === 'evaluate_l2') {
    const results = [];
    let score = '✅';
    const learningDir = path.join(HOMEAI_ROOT, 'Data', 'learning');

    // 1. skill-candidates.jsonl（进化信号积累）
    try {
      const skillCandPath = path.join(learningDir, 'skill-candidates.jsonl');
      if (!fs.existsSync(skillCandPath)) {
        results.push('⚠️ skill-candidates.jsonl：文件不存在（flag_for_skill 从未触发）');
        score = '❌';
      } else {
        const lines = fs.readFileSync(skillCandPath, 'utf8').split('\n').filter(l => l.trim()).length;
        const ok = lines > 0;
        results.push(`${ok ? '✅' : '⚠️'} skill-candidates.jsonl：${lines} 条候选信号${lines === 0 ? '（L2 冷路径无输入）' : ''}`);
        if (!ok) score = '❌';
      }
    } catch (e) {
      results.push(`⚠️ skill-candidates 读取失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 2. dpo-candidates.jsonl（DPO 负例积累）
    try {
      const dpoCandPath = path.join(learningDir, 'dpo-candidates.jsonl');
      if (!fs.existsSync(dpoCandPath)) {
        results.push('⚠️ dpo-candidates.jsonl：文件不存在');
        if (score === '✅') score = '⚠️';
      } else {
        const lines = fs.readFileSync(dpoCandPath, 'utf8').split('\n').filter(l => l.trim()).length;
        const positive = lines > 5;
        results.push(`${positive ? '✅' : '⚠️'} dpo-candidates.jsonl：${lines} 条负例${lines < 5 ? '（积累量偏少）' : ''}`);
        if (!positive && score === '✅') score = '⚠️';
      }
    } catch (e) {
      results.push(`⚠️ dpo-candidates 读取失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 3. Andy HEARTBEAT 上次巡检时间
    try {
      const andyHbPath = path.join(process.env.HOME, '.openclaw', 'workspace-andy', 'HEARTBEAT.md');
      if (!fs.existsSync(andyHbPath)) {
        results.push('❌ Andy HEARTBEAT.md 不存在（L2 cron 未激活）');
        score = '❌';
      } else {
        const hb = fs.readFileSync(andyHbPath, 'utf8');
        const lastCheckMatch = hb.match(/上次巡检[：:](.+)/);
        if (!lastCheckMatch) {
          results.push('⚠️ Andy HEARTBEAT：存在但无「上次巡检」字段（cron 从未触发）');
          if (score === '✅') score = '⚠️';
        } else {
          const lastCheckStr = lastCheckMatch[1].trim().slice(0, 20);
          const lastCheckDate = new Date(lastCheckStr.replace(' ', 'T') + '+08:00');
          const hoursAgo = isNaN(lastCheckDate.getTime()) ? '?' : ((Date.now() - lastCheckDate.getTime()) / 3600000).toFixed(1);
          const stale = !isNaN(lastCheckDate.getTime()) && parseFloat(hoursAgo) > 30;
          results.push(`${stale ? '⚠️' : '✅'} Andy HEARTBEAT 上次巡检：${lastCheckStr}（${hoursAgo}h 前）${stale ? '——超过 30h，可能未正常触发' : ''}`);
          if (stale && score === '✅') score = '⚠️';
        }
      }
    } catch (e) {
      results.push(`⚠️ Andy HEARTBEAT 读取失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 4. opencode-results.jsonl 近期 matchRate 和成功率
    try {
      const ocResultsPath = path.join(learningDir, 'opencode-results.jsonl');
      if (!fs.existsSync(ocResultsPath)) {
        results.push('⚪ opencode-results.jsonl：尚无记录（流水线未触发过）');
      } else {
        const entries = fs.readFileSync(ocResultsPath, 'utf8')
          .split('\n').filter(l => l.trim())
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean);
        const recent = entries.slice(-10);
        if (recent.length === 0) {
          results.push('⚪ opencode-results.jsonl：文件存在但无有效记录');
        } else {
          const successCount = recent.filter(r => r.success === true).length;
          const matchRates = recent.filter(r => typeof r.matchRate === 'number').map(r => r.matchRate);
          const avgMatch = matchRates.length > 0
            ? (matchRates.reduce((s, v) => s + v, 0) / matchRates.length * 100).toFixed(0)
            : '?';
          const successRate = (successCount / recent.length * 100).toFixed(0);
          const ok = successCount >= recent.length * 0.7;
          results.push(`${ok ? '✅' : '⚠️'} opencode 近 ${recent.length} 次：成功率 ${successRate}%，平均 spec 吻合率 ${avgMatch}%`);
          if (!ok && score === '✅') score = '⚠️';
        }
      }
    } catch (e) {
      results.push(`⚠️ opencode-results 读取失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 5. ChromaDB codebase_patterns（Lisa 代码库洞察积累）
    try {
      const cpResp = await fetch(`${CHROMA_API_BASE}/codebase_patterns`);
      if (!cpResp.ok) {
        results.push('⚪ codebase_patterns：集合不存在（首次 opencode 完成后自动创建）');
      } else {
        const { id: cpId } = await cpResp.json();
        const cntResp = await fetch(`${CHROMA_API_BASE}/${cpId}/count`);
        const cpCount = cntResp.ok ? await cntResp.json() : '?';
        results.push(`${cpCount > 0 ? '✅' : '⚪'} codebase_patterns：${cpCount} 条代码库洞察`);
      }
    } catch (e) {
      results.push(`⚠️ codebase_patterns 检查失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 6. 三角色 Skill 数量
    try {
      const ocHome = path.join(process.env.HOME, '.openclaw');
      const agents = ['lucas', 'andy', 'lisa'];
      const skillCounts = agents.map(agent => {
        const skillDir = path.join(ocHome, `workspace-${agent}`, 'skills');
        if (!fs.existsSync(skillDir)) return `${agent}:0`;
        const skills = fs.readdirSync(skillDir).filter(f => {
          try { return fs.statSync(path.join(skillDir, f)).isDirectory(); } catch { return false; }
        });
        return `${agent}:${skills.length}`;
      });
      const total = skillCounts.reduce((sum, s) => sum + parseInt(s.split(':')[1]), 0);
      results.push(`✅ Skill 总量：${total} 个（${skillCounts.join(' / ')}）`);
    } catch (e) {
      results.push(`⚠️ Skill 统计失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 数值评分
    const _rub2 = loadRubric();
    const _L2I = _rub2?.layers?.L2?.items;
    const _l2s = [];
    if (_L2I) {
      for (const r of results) {
        if (r.includes('skill-candidates')) { const m = r.match(/(\d+) 条候选/); if (m) trackScore(_l2s, _L2I, 'skill_candidates', +m[1]); }
        if (r.includes('dpo-candidates') || (r.includes('dpo') && r.includes('负例'))) { const m = r.match(/(\d+) 条负例/); if (m) trackScore(_l2s, _L2I, 'dpo_candidates', +m[1]); }
        if (r.includes('Andy HEARTBEAT 上次巡检')) { const m = r.match(/([\d.]+)h 前/); if (m) trackScore(_l2s, _L2I, 'andy_heartbeat_check', +m[1]); }
        if (r.includes('opencode 近')) { const m = r.match(/成功率 (\d+)%/); if (m) trackScore(_l2s, _L2I, 'opencode_success_rate', +m[1]); }
        if (r.includes('codebase_patterns') && r.includes('洞察')) { const m = r.match(/(\d+) 条代码/); if (m) trackScore(_l2s, _L2I, 'codebase_patterns', +m[1]); }
        if (r.includes('Skill 总量')) { const m = r.match(/(\d+) 个/); if (m) trackScore(_l2s, _L2I, 'skill_count', +m[1]); }
      }
      if (_l2s.length > 0) {
        const _wa = calcWeightedAvg(_l2s);
        _evalScores.L2 = { items: _l2s, weighted: _wa };
        score += ` · ${_wa.toFixed(1)}/5.0`;
      }
    }

    // 按三个原始诉求分组输出
    const pipeline = results.filter(r => r.includes('opencode') || r.includes('Skill'));
    const mechanism = results.filter(r => r.includes('skill-candidates') || r.includes('dpo') || r.includes('HEARTBEAT') || r.includes('codebase_patterns'));
    const feeding = results.filter(r => !pipeline.includes(r) && !mechanism.includes(r));

    return `**L2 评估 ${score}**\n` +
      `【开发流水线成效】\n` + (pipeline.length ? pipeline.map(r => `  ${r}`).join('\n') : '  ⚪ 暂无数据') + '\n' +
      `【自进化机制运转】\n` + (mechanism.length ? mechanism.map(r => `  ${r}`).join('\n') : '  ⚪ 暂无数据') + '\n' +
      `【喂养成效】\n` + (feeding.length ? feeding.map(r => `  ${r}`).join('\n') : '  ⚪ 待评测方案落地后量化');
  }

  if (toolName === 'evaluate_l3') {
    const results = [];
    let score = '✅';

    // 1. Kuzu 协作边积累（distill-relationship-dynamics.py 产出）
    const l3KuzuPath = path.join(HOMEAI_ROOT, 'Data', 'kuzu');
    const l3KuzuScript = `
import sys, json, os
sys.path.insert(0, '/opt/homebrew/lib/python3.11/site-packages')
try:
    import kuzu
    db   = kuzu.Database('${l3KuzuPath}')
    conn = kuzu.Connection(db)
    counts = {}
    for rel in ['co_discusses', 'requests_from', 'supports', 'role_in_context', 'active_thread']:
        r = conn.execute("MATCH ()-[f:Fact {relation: '" + rel + "'}]->() RETURN count(f)")
        counts[rel] = r.get_next()[0] if r.has_next() else 0
    print(json.dumps({'counts': counts}))
except Exception as e:
    print(json.dumps({'error': str(e)}))
sys.stdout.flush()
os._exit(0)
`.trim();
    try {
      const tmpL3 = path.join(HOMEAI_ROOT, 'temp', `eval-l3-${Date.now()}.py`);
      fs.mkdirSync(path.join(HOMEAI_ROOT, 'temp'), { recursive: true });
      fs.writeFileSync(tmpL3, l3KuzuScript);
      const l3Out = execSync(`${PYTHON311} ${tmpL3}`, { encoding: 'utf8', timeout: 20000 }).trim();
      try { fs.unlinkSync(tmpL3); } catch (_) {}
      const ld = JSON.parse(l3Out);
      if (ld.error) {
        results.push(`⚠️ Kuzu 协作边查询失败：${ld.error.slice(0, 80)}`);
        if (score === '✅') score = '⚠️';
      } else {
        const c = ld.counts || {};
        const collabTotal = (c.co_discusses || 0) + (c.requests_from || 0) + (c.supports || 0) + (c.role_in_context || 0);
        const activeThreads = c.active_thread || 0;
        results.push(`${collabTotal > 0 ? '✅' : '⚪'} 协作关系边：${collabTotal} 条（co_discusses:${c.co_discusses||0} / requests_from:${c.requests_from||0} / supports:${c.supports||0} / role_in_context:${c.role_in_context||0}）`);
        results.push(`${activeThreads > 0 ? '✅' : '⚪'} 活跃话题线索（active_thread）：${activeThreads} 条`);
      }
    } catch (e) {
      results.push(`⚠️ Kuzu L3 查询异常：${e.message.slice(0, 80)}`);
      if (score === '✅') score = '⚠️';
    }

    // 2. ChromaDB shadow_interactions（演进环记录）
    try {
      const siResp = await fetch(`${CHROMA_API_BASE}/shadow_interactions`);
      if (!siResp.ok) {
        results.push('⚪ shadow_interactions：集合不存在（关系蒸馏管道尚未运行）');
      } else {
        const { id: siId } = await siResp.json();
        const cntResp = await fetch(`${CHROMA_API_BASE}/${siId}/count`);
        const siCount = cntResp.ok ? await cntResp.json() : '?';
        results.push(`${siCount > 0 ? '✅' : '⚪'} shadow_interactions：${siCount} 条演进环记录`);
      }
    } catch (e) {
      results.push(`⚠️ shadow_interactions 检查失败：${e.message.slice(0, 60)}`);
    }

    // 3. 访客影子 Registry 状态
    try {
      const registryPath = path.join(HOMEAI_ROOT, 'Data', 'visitor-registry.json');
      if (!fs.existsSync(registryPath)) {
        results.push('⚪ 访客 Registry：文件不存在（无访客）');
      } else {
        const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
        const entries = Object.values(registry);
        const active   = entries.filter(e => e.shadow_status === 'active').length;
        const dormant  = entries.filter(e => e.shadow_status === 'dormant').length;
        const archived = entries.filter(e => e.shadow_status === 'archived').length;
        results.push(`${entries.length > 0 ? '✅' : '⚪'} 访客影子：${entries.length} 个（active:${active} / dormant:${dormant} / archived:${archived}）`);
      }
    } catch (e) {
      results.push(`⚠️ 访客 Registry 读取失败：${e.message.slice(0, 60)}`);
    }

    // 4. 关系蒸馏日志（distill-relationship-dynamics.log）
    try {
      const logPath = path.join(HOMEAI_ROOT, 'Logs', 'distill-relationship-dynamics.log');
      if (!fs.existsSync(logPath)) {
        results.push('⚪ 关系蒸馏日志：尚无运行记录（每日凌晨 4am 触发）');
      } else {
        const logContent = fs.readFileSync(logPath, 'utf8');
        const logLines = logContent.split('\n').filter(l => l.trim());
        const runMatches = logContent.match(/\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}/g);
        const lastRun = runMatches ? runMatches[runMatches.length - 1] : '未知';
        results.push(`✅ 关系蒸馏：上次运行 ${lastRun}，日志 ${logLines.length} 行`);
      }
    } catch (e) {
      results.push(`⚠️ 关系蒸馏日志读取失败：${e.message.slice(0, 60)}`);
    }

    // 5. 成员增强效果（inject.md 中协作关系节是否存在）
    try {
      const familyDir = path.join(process.env.HOME, '.openclaw', 'workspace-lucas', 'family');
      if (fs.existsSync(familyDir)) {
        const injects = fs.readdirSync(familyDir).filter(f => f.endsWith('.inject.md'));
        let withCollab = 0;
        for (const inj of injects) {
          const content = fs.readFileSync(path.join(familyDir, inj), 'utf8');
          if (content.includes('组织协作关系') || content.includes('协作边') || content.includes('co_discusses')) withCollab++;
        }
        results.push(`${withCollab > 0 ? '✅' : '⚪'} 成员增强效果：${withCollab}/${injects.length} 个档案含协作关系信息`);
      }
    } catch (e) {
      // 非关键
    }

    // 数值评分
    const _rub3 = loadRubric();
    const _L3I = _rub3?.layers?.L3?.items;
    const _l3s = [];
    if (_L3I) {
      for (const r of results) {
        if (r.includes('协作关系边')) { const m = r.match(/(\d+) 条（/); if (m) trackScore(_l3s, _L3I, 'collab_edges', +m[1]); }
        if (r.includes('shadow_interactions') || r.includes('演进环')) { const m = r.match(/(\d+) 条演进/); if (m) trackScore(_l3s, _L3I, 'shadow_interactions', +m[1]); }
        if (r.includes('访客影子') && r.includes('active')) {
          const m = r.match(/active:(\d+)/);
          trackScore(_l3s, _L3I, 'visitor_registry', (m && +m[1] > 0) ? 'active' : (r.includes('dormant') ? 'dormant_only' : 'none'));
        }
        if (r.includes('关系蒸馏') && r.includes('运行')) trackScore(_l3s, _L3I, 'relationship_distill', r.trim().startsWith('✅') ? 'recent' : (r.includes('尚无') ? 'never' : 'exists'));
        if (r.includes('成员增强效果')) { const m = r.match(/(\d+)\/(\d+)/); if (m) trackScore(_l3s, _L3I, 'member_enhancement', +m[2] > 0 ? Math.round(+m[1] / +m[2] * 100) : 0); }
      }
      if (_l3s.length > 0) {
        const _wa = calcWeightedAvg(_l3s);
        _evalScores.L3 = { items: _l3s, weighted: _wa };
        score += ` · ${_wa.toFixed(1)}/5.0`;
      }
    }
    return `**L3 评估 ${score}**\n${results.map(r => `  ${r}`).join('\n')}`;
  }

  if (toolName === 'evaluate_l4') {
    const results = [];
    let score = '✅';
    const learningDir = path.join(HOMEAI_ROOT, 'Data', 'learning');

    // 1. DPO 模式积累进度（按 pattern_type 分组，追踪距内化阈值的缺口）
    try {
      const dpoCandPath = path.join(learningDir, 'dpo-candidates.jsonl');
      if (!fs.existsSync(dpoCandPath)) {
        results.push('⚪ dpo-candidates.jsonl：文件不存在（尚无 L4 训练信号）');
      } else {
        const lines = fs.readFileSync(dpoCandPath, 'utf8').split('\n').filter(l => l.trim());
        const patternCounts = {};
        const nowTs = Date.now();
        const sevenDaysAgo = nowTs - 7 * 24 * 3600 * 1000;
        const fourteenDaysAgo = nowTs - 14 * 24 * 3600 * 1000;
        let recentCount = 0;
        let prevWeekCount = 0;

        for (const line of lines) {
          try {
            const entry = JSON.parse(line);
            const ts = new Date(entry.t).getTime();
            if (ts > sevenDaysAgo) recentCount++;
            else if (ts > fourteenDaysAgo) prevWeekCount++;
            for (const reason of (entry.reasons || [])) {
              const m = reason.match(/^([a-z_]+):/);
              if (m) {
                const pt = m[1];
                patternCounts[pt] = (patternCounts[pt] || 0) + 1;
              }
            }
          } catch (_) {}
        }

        const THRESHOLD = 50;
        const patternLines = Object.entries(patternCounts)
          .sort((a, b) => b[1] - a[1])
          .map(([pt, n]) => {
            const icon = n >= THRESHOLD ? '🔴' : n >= 20 ? '🟡' : '⚪';
            return `${icon} ${pt}：${n} 条${n >= THRESHOLD ? '（已达阈值，待内化）' : `（距阈值还差 ${THRESHOLD - n} 条）`}`;
          });

        results.push(`✅ DPO 信号总计：${lines.length} 条`);
        patternLines.forEach(l => results.push(`   ${l}`));

        // 近 7 天趋势（判断 L2 干预是否在收敛问题）
        const trendIcon = recentCount < prevWeekCount ? '📉' : recentCount > prevWeekCount ? '📈' : '➡️';
        const trendMsg  = recentCount < prevWeekCount ? 'L2 干预有效，问题在收敛' : recentCount > prevWeekCount ? '问题在增加，L2 干预需加强' : '持平';
        results.push(`${trendIcon} 近 7 天新增 ${recentCount} 条 vs 前 7 天 ${prevWeekCount} 条（${trendMsg}）`);

        const ripePatterns = Object.entries(patternCounts).filter(([, n]) => n >= THRESHOLD);
        if (ripePatterns.length > 0) {
          score = '🔴';
          results.push(`🔴 ${ripePatterns.length} 个模式已达内化阈值，等待工程师确认触发微调`);
        }
      }
    } catch (e) {
      results.push(`⚠️ DPO 信号读取失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 2. L2 临时干预状态（Lucas AGENTS.md 幻觉禁令条数）
    try {
      const agentsPath = path.join(process.env.HOME, '.openclaw', 'workspace-lucas', 'AGENTS.md');
      if (!fs.existsSync(agentsPath)) {
        results.push('⚠️ Lucas AGENTS.md 不存在');
        if (score === '✅') score = '⚠️';
      } else {
        const content = fs.readFileSync(agentsPath, 'utf8');
        const halluLines = content.split('\n').filter(l =>
          /幻觉|承诺幻觉|已提交|pretend|false.*commit|禁止.*承诺|不得.*承诺/i.test(l)
        );
        if (halluLines.length > 0) {
          results.push(`✅ L2 临时拦截：AGENTS.md 中有 ${halluLines.length} 行幻觉/承诺禁令`);
        } else {
          results.push('⚠️ L2 临时拦截：AGENTS.md 未检测到幻觉禁令（L2 干预可能缺失）');
          if (score === '✅') score = '⚠️';
        }
      }
    } catch (e) {
      results.push(`⚠️ AGENTS.md 读取失败：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 3. 本地模型就绪检查（双路：Ollama API + MLX 文件目录）
    try {
      // 3a. Ollama：查询已拉取模型列表
      const ollamaModels = [];
      try {
        const ollamaResp = execSync('curl -sf http://localhost:11434/api/tags', { timeout: 5000, stdio: 'pipe' }).toString();
        const ollamaJson = JSON.parse(ollamaResp);
        (ollamaJson.models || []).forEach(m => ollamaModels.push(m.name));
      } catch (_) {}

      // 3b. MLX：扫描 ~/HomeAI/Models/mlx/ 目录
      const mlxDir = path.join(HOMEAI_ROOT, 'Models', 'mlx');
      const mlxModels = [];
      try {
        if (fs.existsSync(mlxDir)) {
          fs.readdirSync(mlxDir).forEach(d => {
            const safetensors = path.join(mlxDir, d, 'model.safetensors');
            const weights = path.join(mlxDir, d, 'weights.npz');
            if (fs.existsSync(safetensors) || fs.existsSync(weights)) mlxModels.push(d);
          });
        }
      } catch (_) {}

      const totalLocal = ollamaModels.length + mlxModels.length;
      if (totalLocal === 0) {
        results.push('⏳ 本地模型：未检测到就绪模型（Ollama 无模型 + MLX 目录为空）');
        if (score === '✅') score = '⚠️';
      } else {
        if (ollamaModels.length > 0) results.push(`✅ Ollama 模型（${ollamaModels.length}）：${ollamaModels.slice(0, 3).join('、')}${ollamaModels.length > 3 ? '…' : ''}`);
        if (mlxModels.length > 0)   results.push(`✅ MLX 模型（${mlxModels.length}）：${mlxModels.slice(0, 3).join('、')}${mlxModels.length > 3 ? '…' : ''}`);
        // Qwen2.5-Coder-32B 特别标注（L4 SFT 微调基础模型）
        const hasQwen = mlxModels.some(m => /Qwen2\.5.*Coder.*32B/i.test(m)) || ollamaModels.some(m => /qwen2\.5.*coder/i.test(m));
        if (hasQwen) results.push('✅ Qwen2.5-Coder-32B-4bit 就绪（L4 微调基础模型可用）');
        // Gemma 4 终态检查（非阻塞）
        const hasGemma4 = mlxModels.some(m => /gemma.*4/i.test(m)) || ollamaModels.some(m => /gemma.*4/i.test(m));
        results.push(hasGemma4 ? '✅ Gemma 4 就绪（L4 进化终态已达）' : '⏳ Gemma 4 尚未就绪（L4 进化终态，不阻塞当前微调）');
      }
    } catch (e) {
      results.push(`⚠️ 本地模型检查异常：${e.message.slice(0, 60)}`);
      if (score === '✅') score = '⚠️';
    }

    // 4. 模型能力评估提示（evaluate_local_model 已有完整实现）
    results.push('💡 模型能力评估：调用 evaluate_local_model 运行 8 条测试用例 × 4 维度（行为合规/人格一致性/中文质量/指令遵从），获取本地模型量化评分');

    // 数值评分
    const _rub4 = loadRubric();
    const _L4I = _rub4?.layers?.L4?.items;
    const _l4s = [];
    if (_L4I) {
      for (const r of results) {
        if (r.includes('DPO 信号总计')) { /* count tracked via patterns below */ }
        if (r.includes('已达内化阈值')) { const m = r.match(/(\d+) 个模式/); if (m) trackScore(_l4s, _L4I, 'dpo_accumulation', 100); }
        if (r.includes('幻觉') && r.includes('禁令')) trackScore(_l4s, _L4I, 'l2_intervention', r.trim().startsWith('✅') ? 'exists' : 'missing');
        if (r.includes('本地模型') || r.includes('Ollama') || r.includes('MLX')) {
          const hasOllama = results.some(x => x.includes('Ollama 模型'));
          const hasMlx = results.some(x => x.includes('MLX 模型'));
          if (r.includes('未检测到')) trackScore(_l4s, _L4I, 'local_model_ready', 'none');
          else if (hasOllama && hasMlx) trackScore(_l4s, _L4I, 'local_model_ready', 'ready');
          else if (hasOllama || hasMlx) trackScore(_l4s, _L4I, 'local_model_ready', 'partial');
        }
      }
      // DPO 进度：从 pattern 行提取最高进度百分比
      if (!_l4s.some(s => s.key === 'dpo_accumulation')) {
        for (const r of results) {
          if (r.includes('距阈值还差')) { const m = r.match(/还差 (\d+)/); if (m) { const pct = Math.max(0, Math.round((1 - +m[1] / 50) * 100)); trackScore(_l4s, _L4I, 'dpo_accumulation', pct); break; } }
        }
        if (!_l4s.some(s => s.key === 'dpo_accumulation')) {
          const totalLine = results.find(x => x.includes('DPO 信号总计'));
          if (totalLine) { const m = totalLine.match(/(\d+) 条/); if (m) trackScore(_l4s, _L4I, 'dpo_accumulation', Math.min(+m[1], 50) > 0 ? Math.round(+m[1] / 50 * 100) : 0); }
        }
      }
      if (_l4s.length > 0) {
        const _wa = calcWeightedAvg(_l4s);
        _evalScores.L4 = { items: _l4s, weighted: _wa };
        score += ` · ${_wa.toFixed(1)}/5.0`;
      }
    }
    return `**L4 评估 ${score}**\n${results.map(r => `  ${r}`).join('\n')}`;
  }

  // ─── evaluate_local_model ────────────────────────────────────────────────────
  // 数据驱动评估：从 Kuzu（家人事实）+ ChromaDB（真实对话）自动生成测试题
  if (toolName === 'evaluate_local_model') {
    const modelName = toolInput.model_name || 'qwen2.5-coder:32b';
    const caseResults = [];
    const knowledgeScores = []; // 知识掌握（Kuzu）
    const dialogueScores = []; // 对话能力（ChromaDB）

    // ── Part 1: Kuzu 知识掌握 ──
    // 从 Kuzu 抽取家人活跃事实，用 Main 生成问题，测本地模型对家人的了解
    try {
      const kuzuScript = `
import sys, json, os
sys.path.insert(0, '/opt/homebrew/lib/python3.11/site-packages')
import kuzu
db = kuzu.Database(os.path.expanduser('~/HomeAI/Data/kuzu'))
conn = kuzu.Connection(db)
result = conn.execute("MATCH (p:Entity {type:'person'})-[f:Fact]->(t:Entity) WHERE f.valid_until IS NULL AND f.source_type='distill' RETURN p.name AS person, p.id AS pid, f.relation AS relation, t.name AS target, f.context AS context ORDER BY f.valid_from DESC LIMIT 30")
facts = []
while result.has_next():
    row = result.get_next()
    facts.append({'person': row[0], 'pid': row[1], 'relation': row[2], 'target': row[3], 'context': row[4]})
print(json.dumps(facts, ensure_ascii=False))
os._exit(0)
`;
      const kuzuRaw = execSync('/opt/homebrew/opt/python@3.11/bin/python3.11', { input: kuzuScript, encoding: 'utf8', timeout: 15000 });
      const facts = JSON.parse(kuzuRaw.trim());

      if (facts.length === 0) {
        caseResults.push('⚪ Kuzu 知识测试：无家人事实数据，跳过');
      } else {
        // 按 person 分组，每人取最多 3 条事实
        const byPerson = {};
        for (const f of facts) {
          if (!byPerson[f.person]) byPerson[f.person] = [];
          if (byPerson[f.person].length < 3) byPerson[f.person].push(f);
        }
        const selectedFacts = Object.values(byPerson).flat();

        // 用 Main 把事实转成自然语言问题
        const factsDesc = selectedFacts.map((f, i) =>
          `${i + 1}. 关于${f.person}：${f.relation} → ${f.target}（${f.context}）`
        ).join('\n');

        const questionGenPrompt = `已知以下家人事实，为每条生成一个自然语言问题（像家人会问的那样）。
只输出JSON数组，每个元素是 {"id": 数字, "question": "问题", "key_info": "答案必须包含的关键信息"}。

${factsDesc}`;

        const questionRaw = await callAgentModel('main',
          '你是测试题生成器，把结构化事实转为家人会问的自然语言问题。',
          [{ role: 'user', content: questionGenPrompt }], 800);
        let questions = [];
        try {
          const m = questionRaw.match(/\[[\s\S]*?\]/);
          if (m) questions = JSON.parse(m[0]);
        } catch (_) {}

        if (questions.length === 0) {
          caseResults.push(`⚠️ Kuzu 知识测试：Main 生成问题失败，跳过（${selectedFacts.length} 条事实已抽取）`);
        } else {
          // 逐题测试本地模型
          for (const q of questions.slice(0, 9)) {
            try {
              const ollamaBody = JSON.stringify({
                model: modelName,
                messages: [
                  { role: 'system', content: 'Lucas是家庭成员，了解家里的每个人。用中文自然回答，不编造不确定的信息。' },
                  { role: 'user', content: q.question },
                ],
                stream: false,
              });
              const ollamaRaw = execSync(
                `curl -sf http://localhost:11434/api/chat -d '${ollamaBody.replace(/'/g, "'\\''")}'`,
                { timeout: 30000, stdio: 'pipe' }
              ).toString();
              const reply = JSON.parse(ollamaRaw).message?.content || '';

              // 教师评分：对照关键信息
              const judgePrompt = `问题：${q.question}\n必须包含的关键信息：${q.key_info}\n学生回复：${reply}\n评分标准：5分=准确包含关键信息或诚实说不知道；3分=部分正确但有遗漏；1分=编造错误信息。只输出JSON：{"score": 数字, "reason": "一句理由"}`;
              const judgeRaw = await callAgentModel('main',
                '你是严格的评分员。只输出JSON。',
                [{ role: 'user', content: judgePrompt }], 100);
              let score = 3, reason = '解析失败';
              try {
                const m = judgeRaw.match(/\{[\s\S]*?\}/);
                if (m) { const j = JSON.parse(m[0]); score = Number(j.score) || 3; reason = j.reason || ''; }
              } catch (_) {}

              knowledgeScores.push(score);
              const icon = score >= 4 ? '✅' : score >= 3 ? '🟡' : '🔴';
              caseResults.push(`${icon} [知识] ${q.question.slice(0, 30)}：${score}/5 — ${reason}`);
            } catch (e) {
              caseResults.push(`⚠️ [知识] 题目 ${q.id} 调用失败：${e.message.slice(0, 40)}`);
            }
          }
        }
      }
    } catch (e) {
      caseResults.push(`⚠️ Kuzu 数据抽取失败：${e.message.slice(0, 60)}`);
    }

    // ── Part 2: ChromaDB 对话能力 ──
    // 从真实家庭对话中抽取 user message，测本地模型的实际响应智力
    try {
      const colResp = await fetch(`${CHROMA_API_BASE}/conversations`);
      if (!colResp.ok) throw new Error(`conversations 集合不可达 ${colResp.status}`);
      const { id: colId } = await colResp.json();

      // 抽最近 20 条家人对话（fromType=human，排除访客）
      const getResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          where: { fromType: { '$eq': 'human' } },
          include: ['documents', 'metadatas'],
          limit: 20,
        }),
      });
      if (!getResp.ok) throw new Error(`查询失败 ${getResp.status}`);
      const data = await getResp.json();
      const docs = data.documents || [];
      const metas = data.metadatas || [];

      // 解析对话：document 格式是 "userId(fromType): prompt\nagentId: response"
      const dialogues = [];
      for (let i = 0; i < docs.length; i++) {
        const doc = docs[i] || '';
        const meta = metas[i] || {};
        const fromType = meta.fromType || '';
        if (fromType === 'visitor') continue; // 排除访客
        // 提取 user message（第一行，冒号前是 fromId）
        const firstLine = doc.split('\n')[0] || '';
        const colonIdx = firstLine.indexOf(':');
        if (colonIdx > 0) {
          const userMsg = firstLine.slice(colonIdx + 1).trim();
          if (userMsg.length >= 4) { // 过滤太短的
            dialogues.push({
              userMsg,
              originalReply: doc.split('\n').slice(1).join('\n').replace(/^[^:]*:\s*/, ''),
              fromId: meta.fromId || 'unknown',
            });
          }
        }
      }

      if (dialogues.length === 0) {
        caseResults.push('⚪ ChromaDB 对话测试：无有效家人对话，跳过');
      } else {
        // 最多测 6 条对话
        for (const dlg of dialogues.slice(0, 6)) {
          try {
            const ollamaBody = JSON.stringify({
              model: modelName,
              messages: [
                { role: 'system', content: 'Lucas是家庭成员，像家人一样自然温暖地回答。用中文，不用markdown。' },
                { role: 'user', content: dlg.userMsg },
              ],
              stream: false,
            });
            const ollamaRaw = execSync(
              `curl -sf http://localhost:11434/api/chat -d '${ollamaBody.replace(/'/g, "'\\''")}'`,
              { timeout: 30000, stdio: 'pipe' }
            ).toString();
            const reply = JSON.parse(ollamaRaw).message?.content || '';

            // 教师评分：三维（需求理解/推理质量/边界意识）
            const judgePrompt = `用户消息：${dlg.userMsg}\n学生回复：${reply}\n\n评分维度（各1~5分）：\n1. 需求理解：准确把握用户真实需求还是误解\n2. 推理质量：回应是否有深度、有道理，不是泛泛而谈\n3. 边界意识：是否知道自己的能力边界，不编造不确定的事\n\n只输出JSON：{"understanding": 数字, "reasoning": 数字, "boundary": 数字, "reason": "一句总评"}`;
            const judgeRaw = await callAgentModel('main',
              '你是严格的对话质量评分员。只输出JSON。',
              [{ role: 'user', content: judgePrompt }], 150);
            let u = 3, r = 3, b = 3, reason = '解析失败';
            try {
              const m = judgeRaw.match(/\{[\s\S]*?\}/);
              if (m) {
                const j = JSON.parse(m[0]);
                u = Number(j.understanding) || 3;
                r = Number(j.reasoning) || 3;
                b = Number(j.boundary) || 3;
                reason = j.reason || '';
              }
            } catch (_) {}

            const avg = (u + r + b) / 3;
            dialogueScores.push({ understanding: u, reasoning: r, boundary: b });
            const icon = avg >= 4 ? '✅' : avg >= 3 ? '🟡' : '🔴';
            caseResults.push(`${icon} [对话] "${dlg.userMsg.slice(0, 25)}"：需求${u}/推理${r}/边界${b}（均${avg.toFixed(1)}）— ${reason}`);
          } catch (e) {
            caseResults.push(`⚠️ [对话] 调用失败：${e.message.slice(0, 40)}`);
          }
        }
      }
    } catch (e) {
      caseResults.push(`⚠️ ChromaDB 数据抽取失败：${e.message.slice(0, 60)}`);
    }

    // ── 汇总 ──
    const knowledgeAvg = knowledgeScores.length > 0
      ? knowledgeScores.reduce((a, b) => a + b, 0) / knowledgeScores.length : 0;
    const dialogueAvg = dialogueScores.length > 0
      ? dialogueScores.reduce((a, d) => a + (d.understanding + d.reasoning + d.boundary) / 3, 0) / dialogueScores.length : 0;

    // 加权综合：知识 0.4 + 对话 0.6（对话更能体现实际任务能力）
    const totalWeight = (knowledgeScores.length > 0 ? 0.4 : 0) + (dialogueScores.length > 0 ? 0.6 : 0);
    let compositeScore = 0;
    if (totalWeight > 0) {
      compositeScore = ((knowledgeScores.length > 0 ? knowledgeAvg * 0.4 : 0) +
                        (dialogueScores.length > 0 ? dialogueAvg * 0.6 : 0)) / totalWeight;
    }

    // 对话子维度均分
    const dimSummary = [];
    if (dialogueScores.length > 0) {
      const uAvg = dialogueScores.reduce((a, d) => a + d.understanding, 0) / dialogueScores.length;
      const rAvg = dialogueScores.reduce((a, d) => a + d.reasoning, 0) / dialogueScores.length;
      const bAvg = dialogueScores.reduce((a, d) => a + d.boundary, 0) / dialogueScores.length;
      dimSummary.push(`${uAvg >= 4 ? '✅' : uAvg >= 3 ? '🟡' : '🔴'} 需求理解：${uAvg.toFixed(1)}`);
      dimSummary.push(`${rAvg >= 4 ? '✅' : rAvg >= 3 ? '🟡' : '🔴'} 推理质量：${rAvg.toFixed(1)}`);
      dimSummary.push(`${bAvg >= 4 ? '✅' : bAvg >= 3 ? '🟡' : '🔴'} 边界意识：${bAvg.toFixed(1)}`);
    }

    const passed = compositeScore >= 3.5;
    const verdict = passed ? '✅ 通过（可部署）' : '❌ 未通过（需继续训练）';

    return [
      `**本地模型评测：${modelName}**`,
      `**综合得分：${compositeScore.toFixed(2)}/5.0  知识掌握：${knowledgeAvg.toFixed(1)}/5.0  对话能力：${dialogueAvg.toFixed(1)}/5.0  → ${verdict}**`,
      '',
      `数据来源：Kuzu ${knowledgeScores.length} 条知识题 + ChromaDB ${dialogueScores.length} 条对话题`,
      '',
      '**对话维度均分**',
      ...(dimSummary.length > 0 ? dimSummary : ['⚪ 无对话数据']),
      '',
      '**逐条结果**',
      ...caseResults,
    ].join('\n');
  }

  // ─── generate_dpo_good_responses ─────────────────────────────────────────────
  // 为 dpo-candidates.jsonl 中积累达阈值的负例批量生成 good_response
  if (toolName === 'generate_dpo_good_responses') {
    const patternType = toolInput.pattern_type || null;
    const threshold = Number(toolInput.threshold) || 10;
    const learningDir = path.join(HOMEAI_ROOT, 'Data', 'learning');
    const dpoCandPath = path.join(learningDir, 'dpo-candidates.jsonl');

    if (!fs.existsSync(dpoCandPath)) {
      return '⚠️ dpo-candidates.jsonl 不存在，无 DPO 候选。';
    }

    // 读取所有条目
    const rawLines = fs.readFileSync(dpoCandPath, 'utf8').split('\n').filter(l => l.trim());
    const entries = rawLines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

    // 按 pattern_type 分组（取 reasons 第一个 pattern）
    const grouped = {};
    for (const entry of entries) {
      if (entry.good_response) continue; // 已有 good_response 跳过
      const pt = (entry.reasons?.[0] || '').match(/^([a-z_]+):/)?.[1] || 'unknown';
      if (patternType && pt !== patternType) continue;
      if (!grouped[pt]) grouped[pt] = [];
      grouped[pt].push(entry);
    }

    // 只处理积累达阈值的 pattern
    const ripePatterns = Object.entries(grouped).filter(([, arr]) => arr.length >= threshold);
    if (ripePatterns.length === 0) {
      return `⚪ 没有 pattern 积累达到阈值（${threshold}）${patternType ? `（筛选：${patternType}）` : ''}，无需生成。`;
    }

    const generated = [];
    for (const [pt, arr] of ripePatterns) {
      // 每个 pattern 最多处理 20 条（避免单次过慢）
      const batch = arr.slice(0, 20);
      for (const entry of batch) {
        try {
          const rewriteSystem = '你是一个家庭AI对话质量优化专家。给定一条错误的AI回复（bad_response），请改写为符合Lucas家庭助手人格的正确回复（good_response）。要求：诚实、温暖、中文、不虚报不幻觉。只输出改写后的回复内容，不要加任何前缀或解释。';
          const rewritePrompt = `用户消息：${entry.prompt}\n\n错误回复：${entry.bad_response}\n\n错误原因：${(entry.reasons || []).join('；')}`;
          const goodResp = await callAgentModel('main', rewriteSystem, [{ role: 'user', content: rewritePrompt }], 300);
          entry.good_response = (goodResp || '').trim();
          generated.push(pt);
        } catch (e) {
          // 单条失败不中断
        }
      }
    }

    // 将更新后的条目写回文件（保持 JSONL 格式）
    const updatedMap = new Map();
    for (const entry of entries) {
      // 用 t + sessionKey + userId 作唯一键
      updatedMap.set(`${entry.t}|${entry.sessionKey}|${entry.userId}`, entry);
    }
    const newLines = rawLines.map(l => {
      try {
        const e = JSON.parse(l);
        const key = `${e.t}|${e.sessionKey}|${e.userId}`;
        const updated = updatedMap.get(key);
        return updated ? JSON.stringify(updated) : l;
      } catch { return l; }
    });
    fs.writeFileSync(dpoCandPath, newLines.join('\n') + '\n', 'utf8');

    const ptCounts = {};
    for (const pt of generated) ptCounts[pt] = (ptCounts[pt] || 0) + 1;
    const summary = Object.entries(ptCounts).map(([pt, n]) => `  ${pt}：${n} 条`).join('\n');
    return `✅ good_response 生成完成\n${summary}\n\n下一步：用 approve_dpo_batch 批量确认后进入微调队列。`;
  }

  // ─── approve_dpo_batch ───────────────────────────────────────────────────────
  // 将指定 pattern 有 good_response 的条目标记 confirmed=true
  if (toolName === 'approve_dpo_batch') {
    const patternType = toolInput.pattern_type;
    const limit = Number(toolInput.limit) || 50;
    const learningDir = path.join(HOMEAI_ROOT, 'Data', 'learning');
    const dpoCandPath = path.join(learningDir, 'dpo-candidates.jsonl');

    if (!fs.existsSync(dpoCandPath)) {
      return '⚠️ dpo-candidates.jsonl 不存在。';
    }

    const rawLines = fs.readFileSync(dpoCandPath, 'utf8').split('\n').filter(l => l.trim());
    let approvedCount = 0;

    const newLines = rawLines.map(l => {
      try {
        const e = JSON.parse(l);
        if (e.confirmed) return l; // 已确认跳过
        if (!e.good_response) return l; // 没有 good_response 跳过
        const pt = (e.reasons?.[0] || '').match(/^([a-z_]+):/)?.[1] || 'unknown';
        if (pt !== patternType) return l;
        if (approvedCount >= limit) return l;
        e.confirmed = true;
        approvedCount++;
        return JSON.stringify(e);
      } catch { return l; }
    });

    fs.writeFileSync(dpoCandPath, newLines.join('\n') + '\n', 'utf8');
    return `✅ approve_dpo_batch 完成：pattern=${patternType}，已确认 ${approvedCount} 条（confirmed=true）。\n这些条目现在可以进入本地模型微调队列。`;
  }

  if (toolName === 'evaluate_system') {
    // 清空上次评分缓存
    for (const k of Object.keys(_evalScores)) delete _evalScores[k];

    // 依次调用 L0~L4 子评估，汇总为评分卡
    const l0 = await executeMainTool('evaluate_l0', {});
    const l1 = await executeMainTool('evaluate_l1', {});
    const l2 = await executeMainTool('evaluate_l2', {});
    const l3 = await executeMainTool('evaluate_l3', {});
    const l4 = await executeMainTool('evaluate_l4', {});

    // 从各层结果提取评分符号
    const extractScore = (text) => {
      const m = text.match(/\*\*L\d 评估 ([✅⚠️❌🔴]+)\*\*/);
      return m ? m[1] : '❓';
    };

    // 提取数值评分
    const extractNum = (text) => {
      const m = text.match(/(\d+\.\d+)\/5\.0/);
      return m ? parseFloat(m[1]) : null;
    };

    // 数值评分卡（含趋势）
    const rubric = loadRubric();
    const numCard = [];
    let totalWeight = 0, totalScore = 0;
    for (const [lk, text] of [['L0', l0], ['L1', l1], ['L2', l2], ['L3', l3], ['L4', l4]]) {
      const emoji = extractScore(text);
      const num = extractNum(text);
      const label = rubric?.layers?.[lk]?.label || lk;
      const numStr = num !== null ? `${num.toFixed(1)}/5.0` : '?';
      const pass = rubric?.layers?.[lk]?.pass_threshold;
      const passStr = (pass !== undefined && num !== null) ? (num >= pass ? '✅' : '⚠️') : '';
      numCard.push(`${emoji} ${lk} ${label}：${numStr} ${passStr}`);
      // 全局加权（等权）
      if (num !== null) { totalWeight += 1; totalScore += num; }
    }
    const overall = totalWeight > 0 ? (totalScore / totalWeight).toFixed(1) : '?';

    // 写入评分历史 JSONL
    const historyDir = path.join(HOMEAI_ROOT, 'Data', 'learning');
    try {
      fs.mkdirSync(historyDir, { recursive: true });
      const historyEntry = {
        ts: new Date().toISOString(),
        trigger: toolInput._trigger || 'manual',
        overall: totalWeight > 0 ? totalScore / totalWeight : null,
      };
      for (const lk of ['L0', 'L1', 'L2', 'L3', 'L4']) {
        if (_evalScores[lk]) historyEntry[lk] = { w: +_evalScores[lk].weighted.toFixed(2), items: Object.fromEntries(_evalScores[lk].items.map(s => [s.key, { s: s.score, r: s.raw }])) };
      }
      fs.appendFileSync(path.join(historyDir, 'evaluation-history.jsonl'), JSON.stringify(historyEntry) + '\n');
    } catch (_) {}

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    return `**HomeAI 系统评估 · ${now}**\n\n**评分卡（均值 ${overall}/5.0）**\n${numCard.join('\n')}\n\n---\n\n${l0}\n\n${l1}\n\n${l2}\n\n${l3}\n\n${l4}`;
  }

  if (toolName === 'evaluate_trend') {
    const count = Math.min(toolInput.count || 10, 50);
    const historyPath = path.join(HOMEAI_ROOT, 'Data', 'learning', 'evaluation-history.jsonl');
    if (!fs.existsSync(historyPath)) {
      return '暂无评估历史记录。请先运行 evaluate_system 生成首次评估。';
    }
    const lines = fs.readFileSync(historyPath, 'utf8').split('\n').filter(l => l.trim());
    if (lines.length === 0) {
      return '评估历史为空。请先运行 evaluate_system。';
    }
    // 解析历史
    const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).slice(-count);

    // 提取数据
    const timestamps = entries.map(e => e.ts?.slice(5, 16)?.replace('T', ' ') || '?');
    const layerKeys = ['L0', 'L1', 'L2', 'L3', 'L4'];
    const layerLabels = { L0: 'L0 基础设施', L1: 'L1 行为质量', L2: 'L2 自进化', L3: 'L3 组织协作', L4: 'L4 深度学习' };
    const layerScores = {};
    for (const lk of layerKeys) layerScores[lk] = entries.map(e => e[lk]?.w ?? null);
    const overallScores = entries.map(e => e.overall);

    // 趋势分析：最近3次 vs 之前
    const trendLines = [];
    for (const lk of layerKeys) {
      const scores = layerScores[lk].filter(s => s !== null);
      if (scores.length < 2) { trendLines.push(`${layerLabels[lk]}：数据不足（需 ≥2 次）`); continue; }
      const recent = scores.slice(-3);
      const prev = scores.slice(0, -3);
      const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
      const prevAvg = prev.length > 0 ? prev.reduce((a, b) => a + b, 0) / prev.length : recentAvg;
      const delta = recentAvg - prevAvg;
      const arrow = delta > 0.2 ? '📈' : delta < -0.2 ? '📉' : '➡️';
      trendLines.push(`${arrow} ${layerLabels[lk]}：最近 ${recentAvg.toFixed(1)}（${delta >= 0 ? '+' : ''}${delta.toFixed(2)}）`);
    }

    // 卡点分析：找拖累得分的子维度
    const rubric = loadRubric();
    const bottlenecks = [];
    if (rubric) {
      // 取最近一条记录的所有子维度分数
      const latest = entries[entries.length - 1];
      for (const lk of layerKeys) {
        const layerData = latest[lk];
        if (!layerData?.items) continue;
        const passTh = rubric.layers?.[lk]?.pass_threshold ?? 3.0;
        for (const [itemKey, itemData] of Object.entries(layerData.items)) {
          if (itemData.s < passTh) {
            const name = rubric.layers?.[lk]?.items?.[itemKey]?.name || itemKey;
            bottlenecks.push(`🔴 ${lk} · ${name}：${itemData.s}/5（阈值 ${passTh}）`);
          }
        }
      }
    }

    // 生成 matplotlib 图表
    const chartDir = path.join(HOMEAI_ROOT, 'Data', 'learning');
    const chartPath = path.join(chartDir, 'evaluation-trend.png');
    const chartScript = `
import sys, json, os
sys.path.insert(0, '/opt/homebrew/lib/python3.11/site-packages')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import matplotlib.dates as mdates
import numpy as np
from datetime import datetime

lines = open('${historyPath}').read().strip().split('\\n')
entries = [json.loads(l) for l in lines if l.strip()]
entries = entries[-${count}:]

layer_keys = ['L0', 'L1', 'L2', 'L3', 'L4']
layer_labels = ['L0 基础设施', 'L1 行为质量', 'L2 自进化', 'L3 组织协作', 'L4 深度学习']
colors = ['#2ecc71', '#3498db', '#e67e22', '#9b59b6', '#e74c3c']

ts = []
for e in entries:
    try:
        ts.append(datetime.fromisoformat(e['ts']))
    except:
        ts.append(datetime.now())

fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(10, 7), gridspec_kw={'height_ratios': [3, 1]})
fig.patch.set_facecolor('#1a1a2e')

# 上图：各层评分趋势
ax1.set_facecolor('#16213e')
for i, lk in enumerate(layer_keys):
    scores = [e.get(lk, {}).get('w') for e in entries]
    valid_idx = [j for j, s in enumerate(scores) if s is not None]
    if valid_idx:
        ax1.plot([ts[j] for j in valid_idx], [scores[j] for j in valid_idx],
                 color=colors[i], marker='o', markersize=4, linewidth=1.8, label=layer_labels[i])

# overall 趋势
overall = [e.get('overall') for e in entries]
valid_o = [j for j, s in enumerate(overall) if s is not None]
if valid_o:
    ax1.plot([ts[j] for j in valid_o], [overall[j] for j in valid_o],
             color='white', marker='D', markersize=5, linewidth=2.5, label='整体均值', linestyle='--')

ax1.set_ylim(0, 5.5)
ax1.axhline(y=3.0, color='#e74c3c', linestyle=':', alpha=0.5, label='合格线 3.0')
ax1.set_ylabel('评分 (0-5)', color='white', fontsize=11)
ax1.legend(loc='lower left', fontsize=8, facecolor='#16213e', edgecolor='#333', labelcolor='white')
ax1.tick_params(colors='white')
ax1.xaxis.set_major_formatter(mdates.DateFormatter('%m/%d %H:%M'))
ax1.set_title('HomeAI L0-L4 评分趋势', color='white', fontsize=14, fontweight='bold')
ax1.grid(True, alpha=0.15)

# 下图：最近一次各子维度柱状图
latest = entries[-1] if entries else {}
ax2.set_facecolor('#16213e')
item_names = []
item_scores = []
item_colors = []
for lk in layer_keys:
    items = latest.get(lk, {}).get('items', {})
    for ik, iv in items.items():
        if isinstance(iv, dict) and 's' in iv:
            item_names.append(f'{lk}.{ik[:8]}')
            item_scores.append(iv['s'])
            item_colors.append(colors[layer_keys.index(lk)])

if item_scores:
    bars = ax2.bar(range(len(item_scores)), item_scores, color=item_colors, alpha=0.8)
    ax2.axhline(y=3.0, color='#e74c3c', linestyle=':', alpha=0.7)
    ax2.set_ylim(0, 5.5)
    ax2.set_ylabel('分数', color='white', fontsize=9)
    ax2.set_xticks(range(len(item_names)))
    ax2.set_xticklabels(item_names, rotation=45, ha='right', fontsize=6, color='white')
    ax2.tick_params(colors='white')
    ax2.set_title('最近评估子维度', color='white', fontsize=10)

plt.tight_layout()
plt.savefig('${chartPath}', dpi=150, facecolor='#1a1a2e', bbox_inches='tight')
plt.close()
os._exit(0)
`;

    let chartGenerated = false;
    try {
      const tmpChart = path.join(HOMEAI_ROOT, 'temp', `eval-chart-${Date.now()}.py`);
      fs.mkdirSync(path.join(HOMEAI_ROOT, 'temp'), { recursive: true });
      fs.writeFileSync(tmpChart, chartScript);
      execSync(`${PYTHON311} ${tmpChart}`, { timeout: 30_000, encoding: 'utf8' });
      try { fs.unlinkSync(tmpChart); } catch (_) {}
      chartGenerated = fs.existsSync(chartPath);
    } catch (e) {
      // matplotlib 不可用时降级为纯文本
    }

    // 组装返回文本
    const resultLines = [
      `**评分趋势分析（最近 ${entries.length} 次评估）**\n`,
      `**趋势方向**`,
      ...trendLines,
    ];
    if (overallScores.filter(s => s !== null).length >= 2) {
      const latestOverall = overallScores.filter(s => s !== null).slice(-1)[0];
      resultLines.push(`\n📊 整体均值：${latestOverall.toFixed(1)}/5.0`);
    }
    if (bottlenecks.length > 0) {
      resultLines.push(`\n**关键卡点（低于合格线）**`);
      resultLines.push(...bottlenecks.slice(0, 10));
    }
    if (chartGenerated) {
      resultLines.push(`\n📈 趋势图已生成：Data/learning/evaluation-trend.png`);
      resultLines.push(`提示：调用 send_file 发送 file_path="Data/learning/evaluation-trend.png" 将图表发给业主。`);
    }

    return resultLines.join('\n');
  }

  return `未知工具：${toolName}`;
}

// ── 外部文档存档 ──────────────────────────────────────────────────────────────
// 两类目标目录（Obsidian）：
//   Claude Code 相关  → 00-ClaudeCode配置/ClaudeCode外部经验参考/
//   架构/技术相关     → 07-设计与技术外部参考/
const OBSIDIAN_CLAUDECODE_DIR = '/Users/xinbinanshan/Documents/Obsidian Vault/HomeAI/00-ClaudeCode配置/ClaudeCode外部经验参考';
const OBSIDIAN_TECH_DIR       = '/Users/xinbinanshan/Documents/Obsidian Vault/HomeAI/07-设计与技术外部参考';

// 每个 userId 最近一次提取的内容缓存（30 分钟窗口）
const lastExtractedDoc = new Map();

// 触发词：「存 claudecode」「存 架构」「存这个 cc」「存这个 技术」等
const SAVE_DOC_RE = /^存(这个|档|下来|起来)?\s*(cc|claudecode|claude[\s_-]?code|clc)/i;
const SAVE_TECH_RE = /存.{0,8}(技术|架构|tech|设计|engineering|参考|ref|外部参考|到.*参考)/i;

/**
 * 把最近提取的内容保存到 Obsidian 对应目录
 * @param {'claudecode'|'tech'} category
 * @param {{ url, title, rawContent, type }} doc
 * @returns {{ filepath, summary }}
 */
async function saveTechDocToObsidian(category, doc) {
  const { url, title, rawContent, type } = doc;
  const targetDir = category === 'claudecode' ? OBSIDIAN_CLAUDECODE_DIR : OBSIDIAN_TECH_DIR;

  // 生成摘要（MiniMax，省 token）
  let summary = '';
  try {
    summary = await callAgentModel('andy', '你是一个文档摘要助手。', [
      { role: 'user', content: `请用3句话以内总结以下内容的核心要点，直接输出摘要，不要加前缀：\n\n${rawContent.slice(0, 5000)}` },
    ], 300);
  } catch (e) {
    summary = '（摘要生成失败）';
  }

  // 文件名：日期-标题slug.md
  const date = todayCST();
  const slug = (title || 'untitled')
    .slice(0, 40)
    .replace(/[^\w\u4e00-\u9fa5]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const filename = `${date}-${slug}.md`;

  const markdown = [
    '---',
    `title: "${(title || '').replace(/"/g, "'")}"`,
    `source: "${url}"`,
    `date: ${date}`,
    `type: ${type}`,
    `category: ${category}`,
    '---',
    '',
    '## 摘要',
    '',
    summary,
    '',
    '## 完整内容',
    '',
    rawContent,
  ].join('\n');

  fs.mkdirSync(targetDir, { recursive: true });
  const filepath = path.join(targetDir, filename);
  fs.writeFileSync(filepath, markdown, 'utf8');
  logger.info('外部文档已存档至 Obsidian', { category, filepath });
  return { filepath, summary };
}

// Main 主入口：Claude 对话 + 工具循环
// source: 'wecom_remote'（企业微信远程）| 'cli_local'（CLI 本地，业主在身边）
async function handleMainCommand(content, userId = 'owner', source = 'wecom_remote', imageBase64 = null, imageMime = null, imageRelativePath = null) {
  // 微信公众号链接：预先用 Playwright 抓取正文注入，避免 Claude 用 curl 直接请求被拦截
  const wechatUrlMatch = !imageBase64 && content.match(/https?:\/\/mp\.weixin\.qq\.com\/[^\s\u4e00-\u9fa5\uff00-\uffef，。！？、；：""''【】《》]+/);
  if (wechatUrlMatch) {
    const wechatUrl = wechatUrlMatch[0];
    logger.info('Main 检测到微信链接，尝试 Playwright 抓取', { userId, url: wechatUrl });
    const article = await scrapeWechatArticle(wechatUrl);
    if (article && article.text) {
      content = content + `\n\n【文章内容已自动抓取】\n原始链接：${wechatUrl}\n标题：${article.title || '（无标题）'}\n${article.author ? `作者：${article.author}\n` : ''}正文：\n${article.text}`;
      logger.info('Main 微信文章抓取成功，注入内容', { title: article.title, textLen: article.text.length });
      lastExtractedDoc.set(userId, { url: wechatUrl, title: article.title || '（无标题）', rawContent: article.text, type: 'wechat_article', ts: Date.now() });
    } else {
      logger.warn('Main 微信文章抓取失败，原始链接保留', { url: wechatUrl });
    }
  }

  // 抖音链接：fire-and-forget 异步处理，Claude 立即响应，转录完成后推送
  const douyinUrlMatch = !wechatUrlMatch && content.match(DOUYIN_URL_RE);
  if (douyinUrlMatch) {
    const douyinUrl = douyinUrlMatch[0];
    const withFrames = FRAME_ANALYSIS_RE.test(content);
    const parsed = parseDouyinShareText(content, douyinUrl);
    const titleHint = parsed?.title ? `「${parsed.title}」` : '';
    // 把 URL 从 content 剔除，避免 Main Claude 看到链接后回复「无法访问抖音」
    content = content.replace(douyinUrl, '').replace(/\s{2,}/g, ' ').trim();
    content = `${content}\n\n【抖音视频后台处理中】${titleHint}转录完成后会单独推送。`;
    logger.info('Main 抖音链接 fire-and-forget 开始', { userId, url: douyinUrl, withFrames });
    scrapeDouyinContent(douyinUrl, { withFrames }).then(async meta => {
      if (!meta) {
        logger.warn('Main 抖音后台提取失败（null），通知业主', { userId, url: douyinUrl });
        await sendWeComMessage(userId, '抖音视频内容提取失败了，短链跳转或 HTML 解析未能识别，可能是链接已过期或平台限制，可以稍后重试。').catch(() => {});
        return;
      }
      if (meta.error) {
        logger.warn('Main 抖音后台提取失败，通知业主', { userId, url: douyinUrl, error: meta.error });
        await sendWeComMessage(userId, `抖音视频内容提取失败：${meta.error}。可以稍后重试或换个链接。`).catch(() => {});
        return;
      }
      // 有 desc 即可分析（与 Lucas 路径一致：不要求必须有 transcript）
      logger.info('Main 抖音后台提取完成，交 Main Claude 分析后推送', { userId, hasTranscript: !!meta.transcript, hasDesc: !!meta.desc });
      // 写入缓存供存档
      lastExtractedDoc.set(userId, { url: douyinUrl, title: meta.title || meta.desc?.slice(0, 60) || '抖音视频', rawContent: formatVideoInjection(meta, douyinUrl), type: 'douyin_video', ts: Date.now() });
      // 调 Main Claude 分析后再发（与 Lucas 路径对齐，不直接 dump 原文）
      try {
        const followUpMsg = `刚刚发的抖音视频内容已提取完毕，以下是内容，请分析后告诉我关键信息：\n\n${formatVideoInjection(meta, douyinUrl)}`;
        const followUpResp = await callMainModel(MAIN_SYSTEM_PROMPT, [{ role: 'user', content: followUpMsg }]);
        const analysisText = followUpResp?.choices?.[0]?.message?.content;
        await sendWeComMessage(userId, analysisText || formatVideoInjection(meta, douyinUrl)).catch(() => {});
      } catch (analysisErr) {
        logger.warn('Main 抖音 Claude 分析失败，回退裸推', { error: analysisErr.message });
        await sendWeComMessage(userId, formatVideoInjection(meta, douyinUrl)).catch(() => {});
      }
    }).catch(e => logger.warn('Main 抖音后台提取异常', { error: e.message }));
  }

  // 视频链接（YouTube / Bilibili）：用 yt-dlp 提取内容注入
  const videoUrlMatch = !wechatUrlMatch && !douyinUrlMatch && content.match(VIDEO_URL_RE);
  if (videoUrlMatch) {
    const videoUrl = videoUrlMatch[0];
    logger.info('Main 检测到视频链接，尝试 yt-dlp 提取', { userId, url: videoUrl });
    const video = await scrapeVideoContent(videoUrl);
    if (video && video.title) {
      content = content + formatVideoInjection(video, videoUrl);
      logger.info('Main 视频内容提取成功，注入内容', { title: video.title, hasTranscript: !!video.transcript });
      lastExtractedDoc.set(userId, { url: videoUrl, title: video.title || '视频', rawContent: formatVideoInjection(video, videoUrl), type: 'video', ts: Date.now() });
    } else {
      logger.warn('Main 视频内容提取失败，原始链接保留', { url: videoUrl });
    }
  }

  // 根据来源追加行为策略
  const sourceContext = source === 'cli_local'
    ? '\n\n【当前交互来源：CLI 本地】业主在电脑旁，可以执行复杂操作和大范围改动，无需保守限制。'
    : '\n\n【当前交互来源：企业微信远程】业主不在电脑旁。保守操作原则：① 只做诊断、查日志、小改动 ② 涉及重构、删文件、改核心配置等大手术，明确告知业主"建议回到 CLI 环境再操作" ③ 不主动执行不可逆操作。';
  const systemPrompt = MAIN_SYSTEM_PROMPT + sourceContext;

  if (!mainHistory[userId]) mainHistory[userId] = loadMainHistory(userId);

  // 构造用户消息内容：有图片时用 content blocks（Claude 原生视觉）
  const imageTextPrompt = imageBase64
    ? `${content.startsWith('[图片]') ? '请分析这张图片，告诉我你看到了什么。' : content}${imageRelativePath ? `\n\n文件路径（仅供 send_file 工具使用）：${imageRelativePath}` : ''}`
    : null;

  const userMessageContent = imageBase64
    ? [
        { type: 'image', source: { type: 'base64', media_type: imageMime || 'image/jpeg', data: imageBase64 } },
        { type: 'text', text: imageTextPrompt },
      ]
    : content;

  mainHistory[userId].push({ role: 'user', content: userMessageContent });

  // 最多保留最近 20 条消息，避免 token 过多
  if (mainHistory[userId].length > 20) {
    mainHistory[userId] = mainHistory[userId].slice(-20);
  }

  const toolsCalled = [];  // 记录本轮调用的工具名，用于日志

  try {
    let messages = [...mainHistory[userId]];

    // agentic 循环：最多 25 轮，防止死循环
    let iterations = 0;
    while (iterations++ < 25) {
      let response;
      try {
        response = await callMainModel(systemPrompt, messages);
      } catch (apiErr) {
        // 历史记录损坏：清空历史，用干净上下文重试一次
        if (apiErr?.message?.includes('400') || apiErr?.message?.includes('invalid')) {
          logger.warn('Main 历史记录损坏，清空后重试', { userId });
          mainHistory[userId] = [];
          persistMainHistory(userId);
          messages = [{ role: 'user', content }];
          response = await callMainModel(systemPrompt, messages);
        } else {
          throw apiErr;
        }
      }

      const msg          = response.choices?.[0]?.message || {};
      const finishReason = response.choices?.[0]?.finish_reason;
      const toolCalls    = msg.tool_calls || [];

      if (finishReason === 'stop' || toolCalls.length === 0) {
        const reply = stripThink(msg.content) || '（无回复）';
        mainHistory[userId].push({ role: 'assistant', content: msg.content || null });
        persistMainHistory(userId);
        const logContent = imageBase64 ? `[图片] ${content}` : content;
        logMainConversation(userId, logContent, toolsCalled, reply);
        return reply;
      }

      // 有工具调用：执行工具，把结果追加到消息链继续
      mainHistory[userId].push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });
      messages = [...mainHistory[userId]];

      const toolResults = await Promise.all(
        toolCalls.map(async (toolCall) => {
          const name  = toolCall.function.name;
          const input = JSON.parse(toolCall.function.arguments || '{}');
          logger.info('Main 调用工具', { tool: name, input });
          toolsCalled.push(name);
          const result = await executeMainTool(name, input);
          return { role: 'tool', tool_call_id: toolCall.id, content: String(result) };
        })
      );

      messages.push(...toolResults);
      mainHistory[userId] = messages;
    }
    // 超出 25 轮工具调用限制，清空历史避免下次带入损坏状态
    mainHistory[userId] = [];
    persistMainHistory(userId);
    const limitReply = '任务太复杂，处理超时。请把需求拆细后重新发送。';
    logMainConversation(userId, content, toolsCalled, limitReply);
    return limitReply;
  } catch (e) {
    logger.error('Main 模型调用失败', { error: e.message });
    const errReply = `系统错误：${e.message}`;
    logMainConversation(userId, content, toolsCalled, errReply);
    return errReply;
  }
}

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

    // 近期对话历史：把同一个 chat 的最近 N 轮作为 messages array 传给 Lucas
    const histKey = chatHistoryKey(isGroup, chatId, fromUser);
    const historyMessages = buildHistoryMessages(histKey);

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
              globalBotClient.sendMessage(botTarget, {
                msgtype: 'markdown',
                markdown: { content: failReply },
              }).catch(e => logger.warn('Bot 抖音提取失败通知推送失败', { error: e.message }));
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
              globalBotClient.sendMessage(botTarget, {
                msgtype: 'markdown',
                markdown: { content: failReply },
              }).catch(e => logger.warn('Bot 抖音提取失败通知推送失败', { error: e.message }));
            }
          } catch (e) {
            logger.warn('Bot 抖音提取失败通知 Lucas 调用失败', { error: e.message });
          }
          return;
        }
        logger.info('Bot 抖音后台提取完成，经 Lucas 分析后推送', { fromUser, hasTranscript: !!meta.transcript });
        // 把转录内容喂给 Lucas，让他分析后再发给家人（而不是直接推送生肉转录）
        const followUpPrompt = `${memberTag}[系统：刚才你分享的抖音视频语音转录已完成，以下是内容，请做简洁总结后直接回复家人：]\n${formatVideoInjection(meta, douyinUrl)}`;
        try {
          const analysis = await callGatewayAgent('lucas', followUpPrompt, followUpSessionKey);
          if (analysis && globalBotClient && globalBotReady) {
            globalBotClient.sendMessage(botTarget, {
              msgtype: 'markdown',
              markdown: { content: analysis },
            }).catch(e => logger.warn('Bot 抖音转录分析推送失败', { error: e.message }));
          }
        } catch (e) {
          logger.warn('Bot 抖音转录分析 Lucas 调用失败', { error: e.message });
        }
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
    const wecomUserId = isGroup ? `group:${fromUser}:${msgId}` : fromUser;

    // sendMessage 有时挂起（WebSocket 等待 ACK 但永不到来），加超时保护
    const sendWithTimeout = (fn, ms = 15000) =>
      Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error(`sendMessage timeout ${ms}ms`)), ms))]);

    // 群消息：30s 内没有回复就先发"收到了"，让家人知道消息收到在处理
    // 避免复杂请求（trigger_development_pipeline / exec 工具）导致家人等待 3 分钟无反应
    let groupAckSent = false;
    let groupAckTimer = null;
    if (isGroup) {
      groupAckTimer = setTimeout(async () => {
        if (!groupAckSent) {
          groupAckSent = true;
          try {
            await sendWithTimeout(() => wsClient.sendMessage(chatId, {
              msgtype: 'text', text: { content: '收到～在想想……' }
            }));
            logger.info('群消息 ack 已发送（30s 无回复）', { fromUser, chatId });
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
          msgtype: 'text',
          text: { content: demoReply || '好的，稍等一下～' },
        }));
        logger.info('演示群回复已发送', { fromUser, chatId, replyLen: demoReply?.length });
      } catch (demoErr) {
        logger.warn('演示群回复失败', { error: demoErr.message });
        try {
          await wsClient.sendMessage(chatId, {
            msgtype: 'text',
            text: { content: '抱歉，我现在有点忙，请稍后再试～' },
          });
        } catch {}
      }
      return; // 不走家庭群流程
    }
    // ── 演示群分支结束 ─────────────────────────────────────────────────

    try {
      // 通过 Gateway → Lucas 嵌入式 agent（crewclaw-routing 插件处理三层路由）
      logger.info('callGatewayAgent 开始', { fromUser, historyRounds: historyMessages.length / 2 | 0 });

      let replyText;
      try {
        replyText = await callGatewayAgent('lucas', messageToLucas, wecomUserId, 180000, historyMessages) || '收到～';
      } catch (firstErr) {
        // socket hang up / ECONNRESET：DeepSeek R1 偶发网络断连，自动重试一次
        const isNetErr = /socket hang up|ECONNRESET|ECONNABORTED|ETIMEDOUT/i.test(firstErr?.message || '');
        if (isNetErr) {
          logger.warn('Gateway 网络错误，2s 后重试一次', { fromUser, error: firstErr.message });
          await new Promise(r => setTimeout(r, 2000));
          replyText = await callGatewayAgent('lucas', messageToLucas, wecomUserId, 180000, historyMessages) || '收到～';
        } else {
          throw firstErr;
        }
      }

      clearTimeout(groupAckTimer);
      groupAckSent = true; // 有正常回复，不需要再发 ack
      logger.info('callGatewayAgent 返回', { fromUser, replyLen: replyText.length });

      // 写回本轮对话到 chatHistory buffer（供下条消息使用）
      // 存储剥离后的文本，避免 <think> 块污染下一轮历史注入
      appendChatHistory(histKey, `${memberTag}${text}`, stripMarkdownForWecom(replyText));

      // [VOICE] / [RAP] 检测：Lucas 在回复末尾加标记时，剥离 markdown 后发文字 + fire-and-forget 语音
      const hasVoiceTag = replyText.includes('[VOICE]');
      const hasRapTag   = replyText.includes('[RAP]');
      const needVoice   = hasVoiceTag || hasRapTag;
      // 基础设施层：先统一剥离 ## 标题和 --- 分割线（微信不渲染），再按需剥语音 markdown
      const wecomSafeText = stripMarkdownForWecom(replyText);
      const displayText = needVoice ? stripMarkdownForVoice(wecomSafeText) : wecomSafeText;
      const voiceTarget = isGroup ? chatId : fromUser;

      if (isGroup) {
        // 群消息限流：同一群 5s 内只发一条，避免 errcode=846607
        const now = Date.now();
        const lastSend = groupBotLastSend.get(chatId) || 0;
        const wait = Math.max(0, GROUP_BOT_MIN_INTERVAL_MS - (now - lastSend));
        if (wait > 0) {
          logger.info('群消息限流等待', { chatId, waitMs: wait });
          await new Promise(r => setTimeout(r, wait));
        }
        await sendWithTimeout(() => wsClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: displayText } }));
        groupBotLastSend.set(chatId, Date.now());
      } else {
        // 私聊：sendMessage 私聊不支持任何消息类型（40008）
        // 必须用 replyStream(frame, streamId, content, finish) —— 被动回复已收到消息的唯一正确方式
        const streamId = crypto.randomUUID();
        await sendWithTimeout(() => wsClient.replyStream(frame, streamId, displayText, true), 30000);
      }
      // [VOICE]/[RAP] 模式：文字发出后 fire-and-forget 追加一条语音（失败不影响主流程）
      if (needVoice) {
        const ttsStyle = hasRapTag ? 'rap' : 'normal';
        sendVoiceChunks(voiceTarget, displayText, ttsStyle).catch(() => {});
      }

      logger.info('Bot 已回复', { fromUser, isGroup, length: replyText.length, channel: 'bot' });
    } catch (e) {
      clearTimeout(groupAckTimer);
      groupAckSent = true;
      logger.error('Bot 消息处理失败，启用 Claude 后备', { error: e?.message || String(e), fromUser });
      try {
        // Gateway / Lucas 不可用，直接用 Claude + SOUL.md 顶上，体验不中断
        const fallbackReply = await callClaudeFallback(messageToLucas, fromUser, historyMessages).catch(fallbackErr => {
          logger.error('Claude 后备也失败了', { error: fallbackErr.message });
          return '我现在有点忙，稍后回你～';
        });
        appendChatHistory(histKey, `${memberTag}${text}`, fallbackReply);
        if (isGroup) {
          const now = Date.now();
          const lastSend = groupBotLastSend.get(chatId) || 0;
          const wait = Math.max(0, GROUP_BOT_MIN_INTERVAL_MS - (now - lastSend));
          if (wait > 0) await new Promise(r => setTimeout(r, wait));
          await sendWithTimeout(() => wsClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: fallbackReply } }));
          groupBotLastSend.set(chatId, Date.now());
        } else {
          const errStreamId = crypto.randomUUID();
          await sendWithTimeout(() => wsClient.replyStream(frame, errStreamId, fallbackReply, true), 30000);
        }
        logger.info('Claude 后备回复已发送', { fromUser, isGroup });
      } catch (fallbackSendErr) {
        logger.error('后备回复发送失败', { error: fallbackSendErr.message });
      }
    }
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
          msgtype: 'text',
          text: { content: '演示版暂时只支持文字消息，请直接输入文字提问～' },
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
    const histKey    = chatHistoryKey(isGroup, chatId, fromUser);
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
      const historyMessages = buildHistoryMessages(histKey);
      const msgId = frame.body?.msgid || crypto.randomUUID();
      const wecomUserId = isGroup ? `group:${fromUser}:${msgId}` : fromUser;
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
    const historyMessages = buildHistoryMessages(histKey);
    const msgId = frame.body?.msgid || crypto.randomUUID();
    const wecomUserId = isGroup ? `group:${fromUser}:${msgId}` : fromUser;

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
          msgtype: 'text',
          text: { content: '演示版暂时只支持文字消息，请直接输入文字提问～' },
        });
      } catch {}
      return;
    }

    const member     = familyMembers[fromUser];
    const channel    = isGroup ? '群聊' : '私聊';
    const memberTag  = member ? `【${channel}·${member.role}${member.name}】` : `【${channel}·${fromUser}】`;
    const histKey    = chatHistoryKey(isGroup, chatId, fromUser);
    const historyMessages = buildHistoryMessages(histKey);

    logger.info('Bot 收到语音消息', { fromUser, voiceText: voiceText.substring(0, 60) });

    const msgId       = frame.body?.msgid || crypto.randomUUID();
    const wecomUserId = isGroup ? `group:${fromUser}:${msgId}` : fromUser;
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
      // 群聊：优先走 bot 通道（显示「启灵」），bot 未就绪时降级到企业应用（显示「系统工程师」）
      // ack 超时不报错（微信服务器有时不回 ack 但消息实际已投递）
      try {
        if (globalBotClient && globalBotReady) {
          await globalBotClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: text } });
        } else {
          await sendWeComGroupMessage(chatId, text);
        }
      } catch (sendErr) {
        logger.warn('群文字发送 ack 超时（消息可能已投递）', { error: sendErr?.message });
      }
      appendChatHistory(groupHistKey, '[启灵主动发送]', text);
      logger.info('群文字消息已发送', { chatId, length: text.length, channel: globalBotReady ? 'bot' : 'app', actor: 'lucas' });
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

    // 有文字则先发文字通知（优先 bot 通道）
    if (text) {
      if (globalBotClient && globalBotReady) {
        await globalBotClient.sendMessage(chatId, { msgtype: 'markdown', markdown: { content: text } });
      } else {
        await sendWeComGroupMessage(chatId, text);
      }
      appendChatHistory(groupHistKey, '[启灵主动发送]', text);
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
    // 先发说明文字（可选）
    if (text) {
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
  const agentLabel = { lucas: 'Lucas', andy: 'Andy', lisa: 'Lisa', main: 'Main', pipeline: '流水线' }[fromAgent] ?? fromAgent;
  const text = `${icon} [${agentLabel} → 系统工程师]\n${message}`;
  try {
    await sendLongWeComMessage(WECOM_OWNER_ID, text);
    logger.info('notify-engineer 已发送 (app)', { type, length: message.length });
    res.json({ success: true, channel: 'app' });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    logger.warn('notify-engineer app 通道失败，fallback 到 bot', { error: errMsg });
    if (globalBotClient && globalBotReady) {
      try {
        await globalBotClient.sendMessage(WECOM_OWNER_ID, { msgtype: 'text', text: { content: text } });
        logger.info('notify-engineer 已发送 (bot fallback)', { type, length: message.length });
        res.json({ success: true, channel: 'bot' });
      } catch (botErr) {
        const botErrMsg = botErr instanceof Error ? botErr.message : JSON.stringify(botErr);
        logger.error('notify-engineer 两通道均失败', { appError: errMsg, botError: botErrMsg });
        res.status(500).json({ success: false, error: errMsg, botError: botErrMsg });
      }
    } else {
      logger.error('notify-engineer 发送失败，bot 通道不可用', { error: errMsg });
      res.status(500).json({ success: false, error: errMsg });
    }
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

  // 非法 userId 过滤：系统会话 / UUID / 群聊简写 / 测试用户 → 静默跳过，不发企微
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (userId.startsWith('system') || userId === 'unknown' || userId === 'test' ||
      userId === 'group' || userId === 'owner' || userId === 'heartbeat-cron' ||
      UUID_RE.test(userId)) {
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
    // 私聊主动推送：aibot sendMessage(userId) 实测 40008（bot 协议只支持 group chatId），
    // 先尝试 bot 通道（显示「启灵」），失败则 fallback 到企业应用 HTTP API（显示「系统工程师」）
    let botSent = false;
    if (globalBotClient && globalBotReady) {
      try {
        await globalBotClient.sendMessage(userId, { msgtype: 'markdown', markdown: { content: displayText } });
        botSent = true;
      } catch (botErr) {
        logger.warn('私聊 bot sendMessage 失败，fallback 到 HTTP API', { userId, error: botErr.message });
      }
    }
    if (!botSent) {
      await sendWeComMessage(userId, displayText);
    }
    const channel = botSent ? 'bot' : 'app';
    appendChatHistory(chatHistoryKey(false, null, userId), '[启灵主动发送]', displayText);
    logger.info('主动发消息已发送', { userId, channel, actor: 'lucas' });
    // 语音：显式 voiceText 或 [VOICE]/[RAP] 标记，fire-and-forget
    if (voiceText) {
      sendVoiceChunks(userId, voiceText).catch(() => {});
    } else if (needVoice) {
      sendVoiceChunks(userId, displayText, ttsStyle).catch(() => {});
    }
    res.json({ success: true, userId });
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : (e?.errmsg || JSON.stringify(e));
    logger.error('主动发消息失败', { userId, error: errMsg });
    res.status(500).json({ success: false, error: errMsg });
  }
});

// ─── Lucas 主动循环（Proactive Loop）────────────────────────────────────────
//
// 每隔 LUCAS_PROACTIVE_INTERVAL_MS 触发一次。
//
// 设计意图：Lucas 作为协调者，主动跟进待办承诺。
// 实现方式：从 ChromaDB decisions 集合查出未交付承诺，逐条以原始家人 userId
//   重新发给 Lucas——让 Lucas 以正常请求处理路径响应，而不是抽象的"检查清单"。
//   每条承诺独立一次 session，Lucas 在正确的家人上下文里决策并调工具。

const LUCAS_PROACTIVE_INTERVAL_MS = 60 * 60 * 1000; // 每小时一次
const CHROMA_URL_WECOM = process.env.CHROMA_URL || 'http://localhost:8001';
const CHROMA_API_BASE  = `${CHROMA_URL_WECOM}/api/v2/tenants/default_tenant/databases/default_database/collections`;

// 从 ChromaDB 直接查 lucas 的未交付承诺
async function fetchPendingCommitments() {
  try {
    // Step 1: 获取 decisions 集合 UUID
    const colResp = await fetch(`${CHROMA_API_BASE}/decisions`);
    if (!colResp.ok) return [];
    const col = await colResp.json();
    const colId = col.id;

    // Step 2: 查 outcome="" 的 lucas 承诺
    const getResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        where:   { '$and': [{ agent: { '$eq': 'lucas' } }, { outcome: { '$eq': '' } }] },
        include: ['metadatas'],
        limit:   20,
      }),
    });
    if (!getResp.ok) return [];
    const data = await getResp.json();
    return (data.ids || []).map((id, i) => ({ id, ...data.metadatas[i] }));
  } catch (e) {
    logger.error('fetchPendingCommitments 失败', { error: e.message });
    return [];
  }
}

async function markCommitmentNotified(id, outcome = 'proactive_notified') {
  try {
    const colResp = await fetch(`${CHROMA_API_BASE}/decisions`);
    if (!colResp.ok) return;
    const { id: colId } = await colResp.json();
    await fetch(`${CHROMA_API_BASE}/${colId}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: [id],
        metadatas: [{ outcome, notified_at: nowCST() }],
      }),
    });
    logger.info('承诺标记为已触达', { id, outcome });
  } catch (e) {
    logger.warn('markCommitmentNotified 失败', { id, error: e.message });
  }
}

async function runLucasProactiveLoop() {
  logger.info('Lucas 主动循环触发');
  try {
    const commitments = await fetchPendingCommitments();
    if (commitments.length === 0) {
      logger.info('Lucas 主动循环：无待办承诺');
      return;
    }

    // 构建大小写不敏感的 userId 反查表：zifeiyu → ZiFeiYu
    // 历史数据中 userId 以 "wecom-zifeiyu"（小写+前缀）格式存储，需还原为真实微信 userId
    const familyUserIdMap = {};
    for (const realId of Object.keys(familyMembers)) {
      familyUserIdMap[realId.toLowerCase()] = realId;
    }

    for (const c of commitments) {
      const storedUserId = c.userId || '';
      // 剥离 wecom- 前缀（历史数据存储格式为 wecom-zifeiyu）
      const strippedId = storedUserId.startsWith('wecom-') ? storedUserId.slice(6) : storedUserId;
      // 大小写不敏感查找真实 WeChat userId；跳过非家庭成员（system-* / test / unknown）
      const realUserId = familyUserIdMap[strippedId.toLowerCase()];
      if (!realUserId) continue;

      const requirement = (c.context || '').trim();
      if (!requirement) continue;

      // 异步触发 Gateway（不 await）：主动循环不阻塞实时消息，Gateway 并发处理
      // 消息仍过 Gateway，保证路由日志、记忆注入、DPO 数据正常积累
      // 注意：不要让 Lucas 重新触发流水线——只需告知用户进度或提醒关注
      // 如果 Andy/Lisa 已在处理，说"在处理中"即可；只有明确未提交时才考虑再触发
      const message = `提醒：以下需求你之前已经提交给开发团队，请**告知用户**当前状态（进行中/已完成/卡住）。不要重新触发流水线，除非你确认从未提交过。\n\n需求内容：${requirement}`;

      logger.info('Lucas 主动跟进承诺（异步触发）', { userId: realUserId, requirement: requirement.slice(0, 60) });
      // 先标记已触达，防止下次循环重复处理（无论 Gateway 是否成功）
      markCommitmentNotified(c.id).catch(() => {});
      // 异步发出，不等结果
      callGatewayAgent('lucas', message, realUserId)
        .then(reply => {
          logger.info('Lucas 主动跟进完成', { userId: realUserId, reply: (reply || '').slice(0, 100) });
          // 通知工程师：Lucas 主动触达了哪位家人、说了什么
          if (WECOM_OWNER_ID) {
            const notifyText = [
              `📋 [Lucas → 系统工程师]`,
              `[主动跟进] 对象：${realUserId}`,
              `承诺：${requirement.slice(0, 100)}`,
              ``,
              `Lucas 回复摘要：${(reply || '（无回复）').slice(0, 200)}`,
            ].join('\n');
            sendLongWeComMessage(WECOM_OWNER_ID, notifyText).catch(() => {});
          }
        })
        .catch(e  => logger.error('Lucas 主动跟进失败', { userId: realUserId, error: e.message }));
    }
  } catch (e) {
    logger.error('Lucas 主动循环失败', { error: e.message });
  }
}

// ─── Main 主动监控循环 ─────────────────────────────────────────────────────────
//
// 每隔 MAIN_MONITOR_INTERVAL_MS 触发一次健康检查。
// Main agent 读取 HEARTBEAT.md → 调 scan_pipeline_health / scan_lucas_quality
// → 有异常才推送给业主；正常回复 HEARTBEAT_OK 不推送。

const MAIN_MONITOR_INTERVAL_MS = 4 * 60 * 60 * 1000; // 每 4 小时（紧急故障探测足够；日报在 HEARTBEAT.md 时间控制下每日一次）

async function runMainMonitorLoop() {
  if (!WECOM_OWNER_ID) return;
  logger.info('Main 监控循环触发');
  try {
    // 读取 HEARTBEAT.md 作为状态上下文
    const heartbeatPath = `${process.env.HOME}/.openclaw/workspace-main/HEARTBEAT.md`;
    let heartbeatContent = '';
    try {
      heartbeatContent = fs.readFileSync(heartbeatPath, 'utf8');
    } catch {}

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const heartbeatPrompt = `[HEARTBEAT ${now}]\n\nHEARTBEAT.md 当前内容：\n${heartbeatContent}\n\n**三层监控协议（严格执行，禁止混层）**：\n\n【告警级别 3 · 紧急故障探测】\n调用 scan_pipeline_health。\n- 任何进程不在线 / Gateway 不可达 → 立即调用 notify_engineer 推送，一句话说清楚问题，然后回复 HEARTBEAT_OK 结束。\n- 一切正常 → 不推送，继续告警级别 2 判断。\n\n【告警级别 2 · 每日巡检日报】\n仅当「上次日报发送」距今超过 20 小时时才执行，否则跳过直接回复 HEARTBEAT_OK。\n执行时：\n1. 依次调用 evaluate_l0 / evaluate_l1 / evaluate_l2 / evaluate_l3 / evaluate_l4\n2. 汇总为一条日报（按 L0~L4 分层），包含：各层状态、DPO 积累进度（审核待办）、待处理改进点\n3. 调用 notify_engineer 发送日报\n4. 更新「上次日报发送」时间\n\n【告警级别 1 · 正常静默】\n以上两层均无需推送时 → 直接回复 HEARTBEAT_OK，不生成任何其他内容。\n\n**铁律：除 notify_engineer 推送和日报发送外，禁止生成面向工程师的文字内容。OK 就是 OK。**`;

    // 使用独立消息历史，不污染业主会话
    const messages = [{ role: 'user', content: heartbeatPrompt }];
    const toolsCalled = [];
    let iterations = 0;
    let reply = '';

    const heartbeatSystem = MAIN_SYSTEM_PROMPT + '\n\n【当前交互来源：HEARTBEAT 自动触发】这是定时监控检查，不是业主主动发消息。只在发现真实异常时才通知业主，正常状态回复 HEARTBEAT_OK。\n\n**汇报格式（强制）**：所有推送给工程师的消息必须按 Lx 分层组织：\n## L0 基础设施\n[各 PM2 进程名称+状态+运行时长+重启次数、Gateway 状态、关键端口]\n## L1 Agent 人格化\n[Lucas 质量、Andy/Lisa 活跃度、蒸馏产出、evaluator 状态]\n## L2 进化循环\n[蒸馏/技能/进化信号/DPO]\n## L3 组织协作\n[协作边/成员分身/关系蒸馏/访客影子]\n## L4 行为内化\n[DPO 积累进度（各 pattern 条数/阈值）、L2 临时干预状态、Gemma 4 就绪状态]\n规则：某层无问题写 ✅ 无异常，不要省略该层。L0 必须包含具体进程状态和数据。\n\n可用评估工具：evaluate_l0 / evaluate_l1 / evaluate_l2 / evaluate_l3 / evaluate_l4 / evaluate_system（依次调用 L0~L4）。';
    while (iterations++ < 10) {
      const response = await callMainModel(heartbeatSystem, messages);

      const msg          = response.choices?.[0]?.message || {};
      const finishReason = response.choices?.[0]?.finish_reason;
      const toolCalls    = msg.tool_calls || [];

      if (finishReason === 'stop' || toolCalls.length === 0) {
        reply = stripThink(msg.content);
        break;
      }

      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });
      const toolResults = await Promise.all(
        toolCalls.map(async (toolCall) => {
          const name  = toolCall.function.name;
          const input = JSON.parse(toolCall.function.arguments || '{}');
          toolsCalled.push(name);
          logger.info('Main 监控循环调用工具', { tool: name });
          const result = await executeMainTool(name, input);
          return { role: 'tool', tool_call_id: toolCall.id, content: String(result) };
        })
      );
      messages.push(...toolResults);
    }

    logger.info('Main 监控循环完成', { reply: reply.slice(0, 100), toolsCalled });

    // 只在有异常时推送（非 HEARTBEAT_OK）
    if (reply && !reply.toUpperCase().includes('HEARTBEAT_OK')) {
      // 从回复中提取告警等级
      let alertLevel = '🟡';
      if (reply.includes('🔴') || reply.includes('❌')) alertLevel = '🔴';
      else if (reply.includes('🟢') || (!reply.includes('⚠️') && !reply.includes('❌'))) alertLevel = '🟢';
      const alertText = `[Main 监控报告] 告警等级：${alertLevel}\n${reply}`;
      // bot 协议不支持 userId，只走 HTTP API
      try {
        await sendWeComMessage(WECOM_OWNER_ID, alertText);
        logger.info('Main 监控：异常已推送给业主 (app)');
      } catch (e) {
        logger.error('Main 监控推送失败', { error: e.message });
      }
    }

    // 更新 HEARTBEAT.md 的运行记录
    try {
      const nowIso = nowCST();
      let hb = fs.readFileSync(heartbeatPath, 'utf8');
      hb = hb.replace(/- 上次健康检查：.*/,  `- 上次健康检查：${nowIso}`);
      if (toolsCalled.includes('evaluate_l1') || toolsCalled.includes('scan_lucas_quality')) {
        hb = hb.replace(/- 上次质量扫描：.*/, `- 上次质量扫描：${nowIso}`);
        hb = hb.replace(/  - 上次扫描：.*/,   `  - 上次扫描：${nowIso}`);
      }
      if (toolsCalled.includes('evaluate_l2') || toolsCalled.includes('evaluate_l3') || toolsCalled.includes('evaluate_l4')) {
        hb = hb.replace(/- 上次L2~L4巡检：.*/, `- 上次L2~L4巡检：${nowIso}`);
      }
      fs.writeFileSync(heartbeatPath, hb, 'utf8');
    } catch (e) {
      logger.warn('Main 监控：更新 HEARTBEAT.md 失败', { error: e.message });
    }
  } catch (e) {
    logger.error('Main 监控循环失败', { error: e.message });
  }
}

// ─── Andy HEARTBEAT 巡检循环（L2 进化循环）────────────────────────────────────
//
// 每 24 小时触发一次，预计算 Kuzu 结晶候选 + skill-candidates.jsonl pending 条目，
// 拼入 heartbeat prompt 后调 Andy，Andy 决策是否固化、发送提案给系统工程师。

const ANDY_HEARTBEAT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 每 24 小时

async function runAndyHeartbeatLoop() {
  logger.info('Andy HEARTBEAT 巡检循环触发');
  try {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const PYTHON311 = '/opt/homebrew/opt/python@3.11/bin/python3.11';
    const kuzuPath  = path.join(HOMEAI_ROOT, 'data', 'kuzu');

    // 预计算1：高置信度结晶候选（has_pattern, confidence >= 0.8）
    let precomputedPatterns = '无高置信度候选（confidence >= 0.8）';
    const kuzuScript = `
import sys, json, os
sys.path.insert(0, '/opt/homebrew/lib/python3.11/site-packages')
try:
    import kuzu
    db   = kuzu.Database('${kuzuPath}')
    conn = kuzu.Connection(db)
    r    = conn.execute("""
        MATCH (a:Entity)-[f:Fact]->(p:Entity)
        WHERE f.relation = 'has_pattern' AND f.confidence >= 0.8
        RETURN a.name, p.name, f.confidence, f.context
        ORDER BY f.confidence DESC LIMIT 20
    """)
    rows = []
    while r.has_next():
        row = r.get_next()
        rows.append({'agent': row[0], 'pattern': row[1], 'confidence': row[2], 'context': row[3]})
    print(json.dumps(rows))
except Exception as e:
    print(json.dumps({'error': str(e)}))
sys.stdout.flush()
os._exit(0)
`.trim();
    try {
      const tmpPy = path.join(HOMEAI_ROOT, 'temp', `andy-hb-kuzu-${Date.now()}.py`);
      fs.mkdirSync(path.join(HOMEAI_ROOT, 'temp'), { recursive: true });
      fs.writeFileSync(tmpPy, kuzuScript);
      const raw = execSync(`${PYTHON311} ${tmpPy}`, { encoding: 'utf8', timeout: 20000 }).trim();
      try { fs.unlinkSync(tmpPy); } catch (_) {}
      const patterns = JSON.parse(raw);
      if (Array.isArray(patterns) && patterns.length > 0) {
        precomputedPatterns = patterns.map(p =>
          `- [${(p.confidence * 100).toFixed(0)}%] ${p.pattern}（${p.agent}）${p.context ? `\n  上下文：${p.context.slice(0, 80)}` : ''}`
        ).join('\n');
      }
    } catch (e) {
      precomputedPatterns = `查询失败：${e.message.slice(0, 80)}`;
    }

    // 预计算2：skill-candidates.jsonl 中的 pending 条目
    let precomputedSkillCandidates = '无 pending 候选';
    const skillCandPath = path.join(HOMEAI_ROOT, 'data/learning/skill-candidates.jsonl');
    try {
      if (fs.existsSync(skillCandPath)) {
        const lines = fs.readFileSync(skillCandPath, 'utf8').split('\n').filter(l => l.trim());
        const pending = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean)
          .filter(c => !c.status || c.status === 'pending');
        if (pending.length > 0) {
          precomputedSkillCandidates = pending.map(c =>
            `- ${c.pattern_name}：${c.description}（建议形式：${c.suggested_form || '未指定'}，时间：${(c.timestamp || '').slice(0, 10)}）`
          ).join('\n');
        }
      }
    } catch (e) {
      precomputedSkillCandidates = `读取失败：${e.message.slice(0, 60)}`;
    }

    // 预计算3：andy-goals.jsonl 上轮 in_progress 条目（Loop 2 目标闭环）
    let precomputedInProgressGoals = '无上轮进行中目标';
    const goalsPath = path.join(HOMEAI_ROOT, 'Data', 'learning', 'andy-goals.jsonl');
    try {
      if (fs.existsSync(goalsPath)) {
        const lines = fs.readFileSync(goalsPath, 'utf8').split('\n').filter(l => l.trim());
        const inProgress = lines
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean)
          .filter(g => g.status === 'in_progress');
        if (inProgress.length > 0) {
          precomputedInProgressGoals = inProgress.map(g =>
            `- [${g.id}] ${g.description}\n  触发：${g.trigger}，时间：${(g.generatedAt || '').slice(0, 10)}\n  当前行动：${g.actionTaken}`
          ).join('\n');
        }
      }
    } catch (e) {
      precomputedInProgressGoals = `读取失败：${e.message.slice(0, 60)}`;
    }

    // 读 Andy HEARTBEAT.md 作为行为规则上下文
    const andyHbPath = path.join(process.env.HOME, '.openclaw', 'workspace-andy', 'HEARTBEAT.md');
    let andyHeartbeatContent = '';
    try { andyHeartbeatContent = fs.readFileSync(andyHbPath, 'utf8'); } catch {}

    // 预计算4：behavior_patterns（检查 5 需要的 Andy 行为模式）
    let precomputedBehaviorPatterns = '无近期 behavior_patterns 数据';
    try {
      const bpColResp = await fetch(`${CHROMA_API_BASE}/behavior_patterns`);
      if (bpColResp.ok) {
        const { id: bpColId } = await bpColResp.json();
        const bpResp = await fetch(`${CHROMA_API_BASE}/${bpColId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            where: { agent: { '$eq': 'andy' } },
            include: ['documents', 'metadatas'],
            limit: 20,
          }),
        });
        if (bpResp.ok) {
          const bpData = await bpResp.json();
          const bpDocs = bpData.documents || [];
          const bpMetas = bpData.metadatas || [];
          if (bpDocs.length > 0) {
            precomputedBehaviorPatterns = bpDocs.map((doc, i) => {
              const m = bpMetas[i] || {};
              return `- [${m.pattern_type || 'unknown'}] ${(doc || '').slice(0, 120)}（${(m.timestamp || '').slice(0, 10)}）`;
            }).join('\n');
          }
        }
      }
    } catch (e) {
      precomputedBehaviorPatterns = `读取失败：${e.message.slice(0, 60)}`;
    }

    // 预计算5：knowledge_injection（检查 7 需要的近期知识注入）
    let precomputedKnowledgeInjections = '无近期知识注入';
    try {
      const decColResp = await fetch(`${CHROMA_API_BASE}/decisions`);
      if (decColResp.ok) {
        const { id: decColId } = await decColResp.json();
        const kiResp = await fetch(`${CHROMA_API_BASE}/${decColId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            where: { '$and': [{ agent: { '$eq': 'andy' } }, { type: { '$eq': 'knowledge_injection' } }] },
            include: ['documents', 'metadatas'],
            limit: 10,
          }),
        });
        if (kiResp.ok) {
          const kiData = await kiResp.json();
          const kiDocs = kiData.documents || [];
          const kiMetas = kiData.metadatas || [];
          if (kiDocs.length > 0) {
            precomputedKnowledgeInjections = kiDocs.map((doc, i) => {
              const m = kiMetas[i] || {};
              return `- [${(m.timestamp || '').slice(0, 10)}] ${m.topic || '无主题'}：${(doc || '').slice(0, 150)}`;
            }).join('\n');
          }
        }
      }
    } catch (e) {
      precomputedKnowledgeInjections = `读取失败：${e.message.slice(0, 60)}`;
    }

    // 预计算6：主动学习状态（检查 9 需要的学习进度）
    let precomputedLearningState = '无学习记录（首次学习）';
    try {
      const learningStatePath = path.join(os.homedir(), 'HomeAI', 'Data', 'learning', 'andy-learning-state.json');
      if (fs.existsSync(learningStatePath)) {
        const ls = JSON.parse(fs.readFileSync(learningStatePath, 'utf8'));
        const lastStudy = ls.lastStudyAt || '从未';
        const readFiles = ls.readFiles || [];
        const daysSince = ls.lastStudyAt
          ? Math.floor((Date.now() - new Date(ls.lastStudyAt).getTime()) / 86400000)
          : Infinity;
        precomputedLearningState = `上次学习：${lastStudy}（${daysSince === Infinity ? '从未学习' : `${daysSince} 天前`}）\n已读文件（${readFiles.length} 篇）：${readFiles.length > 0 ? readFiles.join('、') : '无'}\n${daysSince >= 7 ? '⚡ 距上次学习已超 7 天，建议本轮触发学习' : '距上次学习不足 7 天，可跳过'}`;
      }
    } catch (e) {
      precomputedLearningState = `读取失败：${e.message.slice(0, 60)}`;
    }

    // ── 预计算7：spec 回溯数据（检查 10，每周一次）──────────────────────────
    let precomputedSpecRetro = '无 spec 数据';
    try {
      const retroStatePath = path.join(os.homedir(), 'HomeAI', 'Data', 'learning', 'andy-spec-retro-state.json');
      const retroState = fs.existsSync(retroStatePath) ? JSON.parse(fs.readFileSync(retroStatePath, 'utf8')) : {};
      const lastRetro = retroState.lastRetroAt;
      const daysSinceRetro = lastRetro ? Math.floor((Date.now() - new Date(lastRetro).getTime()) / 86400000) : Infinity;
      if (daysSinceRetro < 7) {
        precomputedSpecRetro = `本周已回溯（${daysSinceRetro} 天前），跳过`;
      } else {
        // 从 opencode-results.jsonl 读最近 7 天的 spec 结果
        const resultsPath = path.join(os.homedir(), 'HomeAI', 'CrewHiveClaw', 'data', 'learning', 'opencode-results.jsonl');
        if (fs.existsSync(resultsPath)) {
          const lines = fs.readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean);
          const weekAgo = Date.now() - 7 * 86400000;
          const recentSpecs = lines.slice(-30).map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(r => r && new Date(r.timestamp).getTime() > weekAgo);
          if (recentSpecs.length > 0) {
            const successCount = recentSpecs.filter(r => r.success).length;
            const matchRates = recentSpecs.filter(r => r.matchRate !== undefined).map(r => r.matchRate);
            const avgMatch = matchRates.length > 0 ? Math.round(matchRates.reduce((a, b) => a + b, 0) / matchRates.length) : 'N/A';
            precomputedSpecRetro = [
              `近 7 天 opencode 结果：${recentSpecs.length} 次（成功 ${successCount}）`,
              `spec 吻合率：平均 ${avgMatch}%`,
              `⚡ 距上次回溯已 ${daysSinceRetro === Infinity ? '从未' : `${daysSinceRetro} 天`}，建议本轮触发`,
              ...recentSpecs.slice(-5).map(r => `  - ${r.taskSummary?.slice(0, 60) || '未知'}：${r.success ? '✅' : '❌'}（${r.matchRate !== undefined ? `${r.matchRate}%` : 'N/A'}）`),
            ].join('\n');
          } else {
            precomputedSpecRetro = '近 7 天无 opencode 记录，跳过';
          }
        }
      }
    } catch (e) {
      precomputedSpecRetro = `读取失败：${e.message.slice(0, 60)}`;
    }

    // ── 预计算8：技术雷达状态（检查 11，每两周一次）──────────────────────────
    let precomputedTechRadar = '冷却中';
    try {
      const searchStatePath = path.join(os.homedir(), 'HomeAI', 'Data', 'learning', 'andy-self-search-state.json');
      const searchState = fs.existsSync(searchStatePath) ? JSON.parse(fs.readFileSync(searchStatePath, 'utf8')) : {};
      const lastSearch = searchState.lastSearchAt;
      const daysSinceSearch = lastSearch ? Math.floor((Date.now() - new Date(lastSearch).getTime()) / 86400000) : Infinity;
      if (daysSinceSearch >= 14) {
        const searchedTopics = searchState.searchedTopics || [];
        precomputedTechRadar = `距上次技术搜索已 ${daysSinceSearch === Infinity ? '∞' : `${daysSinceSearch} 天`}（≥14 天可触发）\n已搜索主题：${searchedTopics.length > 0 ? searchedTopics.slice(-5).join('、') : '无'}\n⚡ 建议本轮触发技术雷达搜索`;
      } else {
        precomputedTechRadar = `距上次搜索 ${daysSinceSearch} 天（<14 天，跳过）`;
      }
    } catch (e) {
      precomputedTechRadar = `读取失败：${e.message.slice(0, 60)}`;
    }

    // ── 预计算9：代码图谱变化摘要（检查 12，每日）──────────────────────────
    let precomputedCodeGraphChanges = '未运行';
    try {
      const graphLogPath = path.join(os.homedir(), 'HomeAI', 'Logs', 'build-code-graph.log');
      if (fs.existsSync(graphLogPath)) {
        const logContent = fs.readFileSync(graphLogPath, 'utf8').trim();
        const lastRunLine = logContent.split('\n').filter(l => l.includes('增量重建完成') || l.includes('Done')).slice(-1)[0];
        if (lastRunLine) {
          // 提取最近一次运行的统计
          const recentLines = logContent.split('\n').slice(-20);
          const stats = recentLines.filter(l =>
            l.includes('新增') || l.includes('删除') || l.includes('更新') ||
            l.includes('节点') || l.includes('边') || l.includes('文件')
          ).join('\n');
          if (stats) {
            precomputedCodeGraphChanges = stats.slice(0, 500);
          } else {
            precomputedCodeGraphChanges = '增量重建已完成，无显著变化';
          }
        } else {
          precomputedCodeGraphChanges = '今日尚未运行';
        }
      }
    } catch (e) {
      precomputedCodeGraphChanges = `读取失败：${e.message.slice(0, 60)}`;
    }

    // ── 预计算10：架构提案信号（检查 13，每月一次）────────────────────────
    let precomputedArchProposalSignals = '信号不足';
    try {
      // 查 ChromaDB decisions 中近 30 天的反思类条目
      const chromaUrl = `http://localhost:8001/api/v1/collections`;
      // 先获取 decisions collection ID
      const collectionsResp = await fetch(chromaUrl, { method: 'GET' });
      const collections = await collectionsResp.json();
      const decisionsCol = (collections || []).find(c => c.name === 'decisions');
      if (decisionsCol) {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().replace('Z', '+08:00');
        // 查反思类信号数量
        const signalTypes = ['spec_reflection', 'capability_gap_proposal', 'architecture_drift', 'spec_retrospective'];
        let signalParts = [];
        for (const st of signalTypes) {
          const where = { type: { $eq: st } };
          const getResp = await fetch(`http://localhost:8001/api/v1/collections/${decisionsCol.id}/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ where, include: ['documents', 'metadatas'], limit: 10 }),
          });
          if (getResp.ok) {
            const data = await getResp.json();
            const count = (data.ids || []).length;
            if (count > 0) {
              const topics = (data.documents || []).slice(0, 3).map(d => d.slice(0, 80)).join('；');
              signalParts.push(`${st}：${count} 条（${topics}）`);
            }
          }
        }
        if (signalParts.length > 0) {
          // 检查冷却
          const proposalStatePath = path.join(os.homedir(), 'HomeAI', 'Data', 'learning', 'andy-arch-proposal-state.json');
          const proposalState = fs.existsSync(proposalStatePath) ? JSON.parse(fs.readFileSync(proposalStatePath, 'utf8')) : {};
          const daysSinceProposal = proposalState.lastProposalAt
            ? Math.floor((Date.now() - new Date(proposalState.lastProposalAt).getTime()) / 86400000) : Infinity;
          precomputedArchProposalSignals = [
            signalParts.join('\n'),
            daysSinceProposal >= 30 ? '⚡ 距上次提案已超 30 天，建议本轮审查并决定是否提案' : `距上次提案 ${daysSinceProposal} 天（<30 天，冷却中）`,
          ].join('\n');
        }
      }
    } catch (e) {
      precomputedArchProposalSignals = `读取失败：${e.message.slice(0, 60)}`;
    }

    // ── 预计算11：技术债信号（检查 14，每两周一次）────────────────────────
    let precomputedTechDebtSignals = '无异常';
    try {
      // 检查冷却
      const debtStatePath = path.join(os.homedir(), 'HomeAI', 'Data', 'learning', 'andy-tech-debt-state.json');
      const debtState = fs.existsSync(debtStatePath) ? JSON.parse(fs.readFileSync(debtStatePath, 'utf8')) : {};
      const daysSinceDebt = debtState.lastDebtScanAt
        ? Math.floor((Date.now() - new Date(debtState.lastDebtScanAt).getTime()) / 86400000) : Infinity;
      if (daysSinceDebt >= 14) {
        // 读 opencode-results.jsonl 找高频修改文件
        const resultsPath = path.join(os.homedir(), 'HomeAI', 'CrewHiveClaw', 'data', 'learning', 'opencode-results.jsonl');
        if (fs.existsSync(resultsPath)) {
          const lines = fs.readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean);
          const recentResults = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          // 统计文件变更频率
          const fileChangeCount = {};
          for (const r of recentResults) {
            if (r.filesChanged) {
              for (const f of r.filesChanged.split(',').filter(Boolean)) {
                fileChangeCount[f] = (fileChangeCount[f] || 0) + 1;
              }
            }
          }
          const hotFiles = Object.entries(fileChangeCount)
            .filter(([_, c]) => c >= 3)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
          if (hotFiles.length > 0) {
            precomputedTechDebtSignals = [
              '⚡ 高频修改文件（近 50 次变更中出现 ≥3 次）：',
              ...hotFiles.map(([f, c]) => `  - ${f}：${c} 次`),
              `距上次扫描已 ${daysSinceDebt === Infinity ? '∞' : `${daysSinceDebt} 天`}（≥14 天可触发）`,
            ].join('\n');
          } else {
            precomputedTechDebtSignals = `无高频修改文件（距上次扫描 ${daysSinceDebt === Infinity ? '∞' : `${daysSinceDebt} 天`}）`;
          }
        }
      } else {
        precomputedTechDebtSignals = `冷却中（距上次扫描 ${daysSinceDebt} 天，<14 天）`;
      }
    } catch (e) {
      precomputedTechDebtSignals = `读取失败：${e.message.slice(0, 60)}`;
    }

    const heartbeatPrompt = `[ANDY HEARTBEAT ${now}]

${andyHeartbeatContent}

---

【预计算数据 - 检查 0 前置：上轮进行中目标（Loop 2 闭环）】
${precomputedInProgressGoals}

【预计算数据 - 检查 1：Kuzu 结晶候选（has_pattern, confidence >= 0.8）】
${precomputedPatterns}

【预计算数据 - 检查 2：skill-candidates.jsonl pending 条目】
${precomputedSkillCandidates}

【预计算数据 - 检查 3：链路健康】
当前 skill-candidates pending 数量：${precomputedSkillCandidates.startsWith('无') ? 0 : precomputedSkillCandidates.split('\n').filter(l => l.startsWith('-')).length}
最后 HEARTBEAT 巡检时间：${now}

【预计算数据 - 检查 4：behavior_patterns（Andy 近期行为模式）】
${precomputedBehaviorPatterns}

【预计算数据 - 检查 5：knowledge_injection（近期知识注入）】
${precomputedKnowledgeInjections}

【预计算数据 - 检查 8：主动学习状态】
${precomputedLearningState}

【预计算数据 - 检查 10：spec 回溯数据（每周一次）】
${precomputedSpecRetro}

【预计算数据 - 检查 11：技术雷达状态（每两周一次）】
${precomputedTechRadar}

【预计算数据 - 检查 12：代码图谱变化摘要（每日）】
${precomputedCodeGraphChanges}

【预计算数据 - 检查 13：架构提案信号（每月一次）】
${precomputedArchProposalSignals}

【预计算数据 - 检查 14：技术债信号（每两周一次）】
${precomputedTechDebtSignals}

请按 HEARTBEAT.md 中的检查流程执行巡检。所有预计算数据已注入，直接读取即可，无需 exec 查询。检查 8（主动学习）满足条件时用 read_file 读决策记录。检查 10-14 为新增主动性检查（事件感知/知识获取/自主判断 三维度），按触发条件执行。`;

    // 调用 Andy（独立 session，不影响正常流水线）
    logger.info('Andy HEARTBEAT：发送巡检 prompt', { patternCount: precomputedPatterns === '无高置信度候选（confidence >= 0.8）' ? 0 : 'N/A' });
    callGatewayAgent('andy', heartbeatPrompt, 'heartbeat-cron')
      .then(reply => {
        logger.info('Andy HEARTBEAT 巡检完成', { reply: (reply || '').slice(0, 150) });

        // 有主动行动时推送工程师通道（fire-and-forget，不阻塞时间戳更新）
        if (reply && !reply.toUpperCase().includes('HEARTBEAT_OK') && WECOM_OWNER_ID) {
          sendLongWeComMessage(WECOM_OWNER_ID, `[Andy HEARTBEAT 报告] 告警等级：${reply.includes('❌') || reply.includes('🔴') ? '🔴' : '🟡'}\n[${now}]\n\n${reply}`)
            .then(() => logger.info('Andy HEARTBEAT：巡检报告已推送工程师'))
            .catch(e => logger.warn('Andy HEARTBEAT：推送工程师失败', { error: e.message }));
        }

        // 更新 Andy HEARTBEAT.md 时间戳
        try {
          const nowIso = nowCST();
          let hb = fs.readFileSync(andyHbPath, 'utf8');
          if (hb.includes('- 上次巡检：')) {
            hb = hb.replace(/- 上次巡检：.*/, `- 上次巡检：${nowIso}`);
          } else {
            hb += `\n\n---\n\n- 上次巡检：${nowIso}\n`;
          }
          fs.writeFileSync(andyHbPath, hb, 'utf8');
        } catch (e) {
          logger.warn('Andy HEARTBEAT：更新时间戳失败', { error: e.message });
        }
      })
      .catch(e => logger.error('Andy HEARTBEAT 调用失败', { error: e.message }));

  } catch (e) {
    logger.error('Andy HEARTBEAT 循环失败', { error: e.message });
  }
}

// ─── 启动 ────────────────────────────────────────────────────────────────────

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
    setInterval(runLucasProactiveLoop, LUCAS_PROACTIVE_INTERVAL_MS);
  }, 5 * 60 * 1000);
  logger.info('Lucas 主动循环已注册', { intervalMinutes: LUCAS_PROACTIVE_INTERVAL_MS / 60000 });

  // 启动 Main 监控循环（启动后延迟 10 分钟首次触发）
  if (WECOM_OWNER_ID) {
    setTimeout(() => {
      runMainMonitorLoop();
      setInterval(runMainMonitorLoop, MAIN_MONITOR_INTERVAL_MS);
    }, 10 * 60 * 1000);
    logger.info('Main 监控循环已注册', { intervalHours: MAIN_MONITOR_INTERVAL_MS / 3600000, 协议: '告警级别3紧急/告警级别2日报/告警级别1静默' });
  }

  // 启动 Andy HEARTBEAT 巡检循环（L2 进化循环，启动后延迟 15 分钟首次触发，之后每 24 小时）
  setTimeout(() => {
    runAndyHeartbeatLoop();
    setInterval(runAndyHeartbeatLoop, ANDY_HEARTBEAT_INTERVAL_MS);
  }, 15 * 60 * 1000);
  logger.info('Andy HEARTBEAT 巡检循环已注册', { intervalHours: ANDY_HEARTBEAT_INTERVAL_MS / 3600000 });
});

module.exports = app;
