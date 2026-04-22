'use strict';
/**
 * media.js — 视频/图片/文章媒体处理
 *
 * 包含：抖音爬取、yt-dlp 提取、Whisper 转录、LLaVA 图片描述、微信公众号抓取
 *
 * 导出工厂函数：module.exports = (logger) => ({ ... })
 */

const fs   = require('fs');
const path = require('path');
const axios = require('axios');
const { execFile, execFileSync, execSync } = require('child_process');
const { chromium } = require('playwright');

const HOMEAI_ROOT   = path.join(__dirname, '../../../../../..');
const WHISPER_MODEL = path.join(HOMEAI_ROOT, 'Models/whisper/ggml-base.bin');
const COOKIES_FILE  = path.join(HOMEAI_ROOT, 'config/douyin-cookies.txt');
const WHISPER_CLI   = '/opt/homebrew/bin/whisper-cli';

// 视频平台 URL 正则
const VIDEO_URL_RE = /https?:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/|bilibili\.com\/video|b23\.tv\/|m\.weibo\.cn\/status\/|weibo\.com\/tv\/|video\.weibo\.com\/|t\.cn\/|xiaohongshu\.com\/(explore|discovery)|xhslink\.com\/)[^\s]*/i;
const DOUYIN_URL_RE = /https?:\/\/(v\.douyin\.com\/|www\.douyin\.com\/video)[^\s]*/i;

// 触发帧分析的关键词（家人说「看画面/截图/图片/文字」等时激活视觉分析）
const FRAME_ANALYSIS_RE = /画面|截图|图片|文字|写的|画的|屏幕|PPT|幻灯|看看图/u;

const DOUYIN_MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TikTok/26.2.0 iPhone13,3';
const DOUYIN_HEADERS = {
  'User-Agent': DOUYIN_MOBILE_UA,
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': 'https://www.douyin.com/',
};

module.exports = function createMedia(logger) {

  /** 异步 execFile 包装，不阻塞 Node.js 事件循环 */
  function execFileAsync(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
      execFile(cmd, args, opts, (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout);
      });
    });
  }

  /**
   * 从抖音分享文本中提取视频标题/摘要。
   * 返回 { shareText, title } 或 null
   */
  function parseDouyinShareText(fullText, url) {
    const textBeforeUrl = fullText.replace(url, '').trim();
    const cleaned = textBeforeUrl
      .replace(/^\d+\.\d+\s*复制打开抖音[，,]看看\s*/u, '')
      .replace(/^复制打开抖音[，,]看看\s*/u, '')
      .trim();
    if (!cleaned || cleaned.length < 4) return null;
    const titleMatch = cleaned.match(/【[^】]+】(.+)/u);
    const title = titleMatch ? titleMatch[1].trim() : cleaned;
    return { shareText: cleaned, title };
  }

  /**
   * 用 yt-dlp 提取视频元数据 + 字幕（YouTube/Bilibili/微博/小红书）
   * 返回 { title, uploader, duration, desc, transcript } 或 null
   */
  async function scrapeVideoContent(url) {
    const YT_DLP = '/opt/homebrew/bin/yt-dlp';
    const baseArgs = ['--dump-json', '--no-download', '--quiet', url];
    const tryArgs = [
      ...(fs.existsSync(COOKIES_FILE) ? [['--cookies', COOKIES_FILE, ...baseArgs]] : []),
      ['--cookies-from-browser', 'chrome', ...baseArgs],
      baseArgs,
    ];

    let meta = null;
    for (const args of tryArgs) {
      try {
        const raw = execFileSync(YT_DLP, args, { encoding: 'utf8', timeout: 30000 });
        meta = JSON.parse(raw.trim());
        break;
      } catch {}
    }
    if (!meta) return null;

    const title    = meta.title    || '';
    const uploader = meta.uploader || meta.channel || '';
    const duration = meta.duration
      ? `${Math.floor(meta.duration / 60)}分${meta.duration % 60}秒`
      : '';
    const desc = (meta.description || '').slice(0, 300);

    let transcript = '';
    const tmpBase = `/tmp/yt-dlp-sub-${Date.now()}`;
    try {
      execFileSync(YT_DLP, [
        '--no-download', '--quiet',
        '--write-auto-subs', '--sub-format', 'vtt',
        '--sub-langs', 'zh,zh-Hans,zh-CN,en',
        '-o', tmpBase + '.%(ext)s',
        url,
      ], { encoding: 'utf8', timeout: 30000 });
      const subFiles = execSync(`ls ${tmpBase}*.vtt 2>/dev/null || true`, { encoding: 'utf8' })
        .trim().split('\n').filter(Boolean);
      if (subFiles.length) {
        const vtt = fs.readFileSync(subFiles[0], 'utf8');
        transcript = vtt
          .split('\n')
          .filter(l => l.trim() && !l.startsWith('WEBVTT') && !l.match(/^\d{2}:\d{2}/) && !l.match(/^\d+$/))
          .join(' ')
          .replace(/<[^>]+>/g, '')
          .replace(/\s+/g, ' ')
          .slice(0, 1000);
        for (const f of subFiles) { try { fs.unlinkSync(f); } catch {} }
      }
    } catch {}

    return { title, uploader, duration, desc, transcript };
  }

  /**
   * 通过移动端分享页提取抖音视频元数据 + 音频转录（+ 可选画面分析）
   * 返回 { title, uploader, desc, transcript, frameDesc } 或 { error }
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
        logger.warn('scrapeDouyinContent: videoId 提取失败', { url });
        return { error: '短链跳转失败，无法识别视频ID，可能是链接已过期或格式错误' };
      }

      // Step 2: 分享页 HTML → 元数据 + CDN URL
      const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;
      const resp2 = await axios.get(shareUrl, {
        headers: DOUYIN_HEADERS, timeout: 15000, validateStatus: () => true,
      });
      const html = typeof resp2.data === 'string' ? resp2.data : JSON.stringify(resp2.data);

      let desc = '', uploader = '', cdnUrl = null;
      const rdMatch = html.match(/window\._ROUTER_DATA\s*=\s*(\{[\s\S]*?\})(?=\s*<\/script>)/);
      if (rdMatch) {
        try {
          const rd = JSON.parse(rdMatch[1]);
          const page = rd.loaderData?.['video_(id)/page'];
          const item = page?.videoInfoRes?.item_list?.[0];
          if (item) {
            desc = item.desc || '';
            uploader = item.author?.nickname || '';
            const downloadUrls = item.video?.download_addr?.url_list || [];
            const playUrls     = item.video?.play_addr?.url_list     || [];
            cdnUrl = downloadUrls[0] || playUrls.find(u => !u.includes('playwm')) || playUrls[0] || null;
            if (cdnUrl?.includes('playwm')) cdnUrl = cdnUrl.replace('/playwm/', '/play/');
            logger.info('scrapeDouyinContent: _ROUTER_DATA 解析成功', { videoId, desc: desc.slice(0, 40) });
          } else {
            const filterReason = page?.videoInfoRes?.filter_list?.[0]?.filter_reason;
            logger.warn('scrapeDouyinContent: item_list 为空', { videoId, filterReason });
          }
        } catch (parseErr) {
          logger.warn('scrapeDouyinContent: _ROUTER_DATA 解析失败', { error: parseErr.message });
        }
      }

      // 旧路径降级
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

      // Step 3: 解析 CDN URL（_ROUTER_DATA 已处理，yt-dlp 作备选）
      let resolvedCdnUrl = cdnUrl || null;
      if (!resolvedCdnUrl) {
        try {
          const cookiesArgs = fs.existsSync(COOKIES_FILE)
            ? ['--cookies', COOKIES_FILE]
            : ['--cookies-from-browser', 'chrome'];
          const ytOut = (await execFileAsync('/opt/homebrew/bin/yt-dlp', [
            '--get-url', '--quiet', '--no-warnings', '-f', 'bestaudio/best',
            ...cookiesArgs,
            `https://www.douyin.com/video/${videoId}`,
          ], { encoding: 'utf8', timeout: 15000 })).trim();
          if (ytOut?.startsWith('http')) resolvedCdnUrl = ytOut.split('\n')[0].trim();
        } catch (ytErr) {
          logger.warn('scrapeDouyinContent: yt-dlp 备选也失败', { error: ytErr.message?.slice(0, 100) });
        }
      }

      // Step 4: 音频转录
      let transcript = '';
      if (resolvedCdnUrl && fs.existsSync(WHISPER_CLI) && fs.existsSync(WHISPER_MODEL)) {
        transcript = await transcribeDouyinAudio(resolvedCdnUrl);
      }

      // Step 5: 画面帧分析（按需）
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

  /**
   * ffmpeg 从 CDN URL 提取音频 → whisper-cli 转录
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
        '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', '-t', '300',
        tmpAudio,
      ], { timeout: 60000 });
      const result = await execFileAsync(WHISPER_CLI, [
        '--model', WHISPER_MODEL, '--language', 'zh', '--no-timestamps', '-f', tmpAudio,
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
   */
  async function transcribeLocalVideo(videoPath) {
    const tmpAudio = `/tmp/local-video-audio-${Date.now()}.wav`;
    try {
      await execFileAsync('/opt/homebrew/bin/ffmpeg', [
        '-y', '-loglevel', 'error',
        '-i', videoPath,
        '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', '-t', '300',
        tmpAudio,
      ], { timeout: 90000 });
      const result = await execFileAsync(WHISPER_CLI, [
        '--model', WHISPER_MODEL, '--language', 'zh', '--no-timestamps', '-f', tmpAudio,
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
   * ffmpeg 从 CDN URL 抽取关键帧 → 视觉模型逐帧描述 → 汇总
   */
  async function analyzeDouyinFrames(cdnUrl) {
    const tmpDir = `/tmp/douyin-frames-${Date.now()}`;
    try {
      fs.mkdirSync(tmpDir, { recursive: true });
      await execFileAsync('/opt/homebrew/bin/ffmpeg', [
        '-y', '-loglevel', 'error',
        '-user_agent', DOUYIN_MOBILE_UA,
        '-i', cdnUrl,
        '-vf', 'fps=0.2,scale=480:-1',
        '-frames:v', '8',
        path.join(tmpDir, 'frame_%02d.jpg'),
      ], { timeout: 60000 });
      const frames = fs.readdirSync(tmpDir).filter(f => f.endsWith('.jpg')).sort().map(f => path.join(tmpDir, f));
      if (!frames.length) return '';
      const descriptions = [];
      for (let i = 0; i < frames.length; i++) {
        const d = await describeImageWithLlava(frames[i]);
        if (d) descriptions.push(`第${i + 1}帧：${d}`);
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
    const frameBody = video.frameDesc ? `\n\n【画面内容（AI视觉分析）】\n${video.frameDesc}` : '';
    return [
      `\n\n【视频内容已自动提取】`,
      `原始链接：${url}`,
      `标题：${video.title}`,
      video.uploader ? `来源：${video.uploader}` : '',
      video.duration  ? `时长：${video.duration}`  : '',
      '',
      audioBody + frameBody,
    ].filter(s => s !== null && s !== undefined && !(s === '' && !video.uploader && !video.duration)).join('\n');
  }

  /** 用 Playwright 抓取微信公众号文章正文，返回 { title, author, text } 或 null */
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
    } catch { return null; }
    finally { if (browser) await browser.close().catch(() => {}); }
  }

  /**
   * 图片视觉描述：qwen3.6 Ollama（主）→ GLM vision 云端（降级）
   */
  async function describeImageWithLlava(imagePath) {
    const base64Image = fs.readFileSync(imagePath).toString('base64');
    const ext = path.extname(imagePath).toLowerCase().replace('.', '') || 'jpeg';
    const mimeType = ext === 'png' ? 'image/png' : 'image/jpeg';
    const prompt = '请用中文详细描述这张图片的所有内容，包括文字、数字、地址、人物、物品、场景等，不要遗漏任何可见文字。';
    const VISION_REFUSAL_RE = /无法(直接)?查看|没有(实际的?)?图片数据|无法(分析|处理)(图片|图像)|cannot (view|see|analyze|process) (the )?image/i;

    // 主：Ollama qwen3.6 原生多模态
    try {
      const resp = await axios.post(
        'http://127.0.0.1:11434/v1/chat/completions',
        {
          model: 'qwen3.6',
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            { type: 'text', text: prompt },
          ]}],
          max_tokens: 512,
          temperature: 0,
        },
        { timeout: 120000 }
      );
      const result = resp.data?.choices?.[0]?.message?.content?.trim();
      if (result && !VISION_REFUSAL_RE.test(result)) {
        logger.info('qwen3.6 多模态描述成功');
        return result;
      }
      if (result) logger.warn('qwen3.6 返回拒绝回复，降级 GLM', { preview: result.slice(0, 80) });
    } catch (e) {
      logger.warn('qwen3.6 vision 失败，降级 GLM', { error: e.message });
    }

    // 降级：GLM vision
    const zhipuKey = process.env.ZAI_API_KEY || process.env.ZHIPU_API_KEY;
    if (!zhipuKey) return null;
    try {
      const resp = await axios.post(
        'https://open.bigmodel.cn/api/paas/v4/chat/completions',
        {
          model: 'glm-4v-flash',
          messages: [{ role: 'user', content: [
            { type: 'image_url', image_url: { url: `data:${mimeType};base64,${base64Image}` } },
            { type: 'text', text: prompt },
          ]}],
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

  return {
    // 函数
    parseDouyinShareText,
    scrapeVideoContent,
    scrapeDouyinContent,
    transcribeDouyinAudio,
    transcribeLocalVideo,
    analyzeDouyinFrames,
    formatVideoInjection,
    scrapeWechatArticle,
    describeImageWithLlava,
    // 常量（供 index.js 直接使用）
    VIDEO_URL_RE,
    DOUYIN_URL_RE,
    FRAME_ANALYSIS_RE,
  };
};
