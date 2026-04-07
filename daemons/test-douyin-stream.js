/**
 * 测试：从 iesdouyin.com 分享页提取 CDN 视频 URL，然后流式 ASR
 * 流程：短链 → videoId → iesdouyin HTML → CDN URL → ffmpeg pipe → whisper-cli
 */
const axios  = require('axios');
const { spawn } = require('child_process');

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TikTok/26.2.0 iPhone13,3';
const HEADERS = {
  'User-Agent': MOBILE_UA,
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'zh-CN,zh;q=0.9',
  'Referer': 'https://www.douyin.com/',
};

// 用上次测试验证通过的视频 ID
const TEST_URL = 'https://v.douyin.com/PYZxmAXw5Vw/';
const WHISPER  = '/opt/homebrew/bin/whisper-cli';
const MODEL    = '/Users/xinbinanshan/HomeAI/models/whisper/ggml-base.bin';

async function extractDouyinStream(url) {
  // Step 1: 短链 → videoId
  let videoId = null;
  const directMatch = url.match(/\/video\/(\d{15,20})/);
  if (directMatch) {
    videoId = directMatch[1];
  } else {
    const resp = await axios.get(url, {
      headers: HEADERS, maxRedirects: 5, timeout: 15000, validateStatus: () => true,
    });
    const finalUrl = resp.request?.res?.responseUrl || url;
    console.log('最终 URL:', finalUrl);
    const m = finalUrl.match(/\/video\/(\d{15,20})/);
    if (m) videoId = m[1];
  }
  if (!videoId) { console.log('无法提取 videoId'); return null; }
  console.log('videoId:', videoId);

  // Step 2: 请求分享页，提取 desc + CDN URL
  const shareUrl = `https://www.iesdouyin.com/share/video/${videoId}/`;
  const resp2 = await axios.get(shareUrl, { headers: HEADERS, timeout: 15000, validateStatus: () => true });
  const html = resp2.data || '';
  console.log('HTML 长度:', html.length);

  const descMatch = html.match(/"desc"\s*:\s*"([^"]{5,300})"/);
  const nickMatch = html.match(/"nickname"\s*:\s*"([^"]{1,50})"/);
  console.log('desc:', descMatch?.[1] || '未找到');
  console.log('nickname:', nickMatch?.[1] || '未找到');

  // Step 3: 从 _ROUTER_DATA 提取 play_addr / video CDN URL
  // 抖音视频 URL 通常是 v3-dy.ixigua.com 或 v*.douyinvod.com
  const cdnPatterns = [
    /"play_addr":\s*\{[^}]*"url_list":\s*\["([^"]+)"/,
    /"url_list":\s*\["(https:\/\/[^"]*\.mp4[^"]*)"/,
    /"playAddr":\s*"(https:\/\/[^"]+\.mp4[^"]*)"/,
    /"url":\s*"(https:\/\/v\d+-dy[^"]+\.mp4[^"]*)"/,
    /"uri":\s*"([^"]+)"[^}]*"url_list":\s*\["(https:\/\/[^"]+)"/,
  ];

  // 解码 Unicode 转义（JSON 字符串里的 \u002F 等）
  const decodeUnicode = s => s.replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)));

  let cdnUrl = null;
  for (const pat of cdnPatterns) {
    const m = html.match(pat);
    if (m) {
      cdnUrl = decodeUnicode(m[m.length - 1]);
      console.log('CDN URL (pattern match):', cdnUrl.substring(0, 120));
      break;
    }
  }

  if (!cdnUrl) {
    // 宽泛搜索 douyinvod / ixigua / snssdk CDN 域名（含 Unicode 转义版本）
    const wideMatch = html.match(/https?(?:\\u003A|:)(?:\\u002F\\u002F|\/\/)(?:[^"'\s\\]*?)(?:douyinvod|ixigua|bytecdn|snssdk)(?:[^"'\s\\]*?)(?:\.mp4|\/play|\/playwm)[^"'\s\\]*/);
    if (wideMatch) {
      cdnUrl = decodeUnicode(wideMatch[0]);
      console.log('CDN URL (wide match):', cdnUrl.substring(0, 120));
    }
  }

  if (!cdnUrl) {
    console.log('未找到 CDN 视频 URL，打印 HTML 片段供分析...');
    const idx = html.indexOf('"url_list"');
    if (idx !== -1) {
      console.log('url_list 附近（500字）:', html.substring(idx, idx + 500));
    } else {
      const idx2 = html.indexOf('play_addr');
      if (idx2 !== -1) console.log('play_addr 附近（500字）:', html.substring(idx2, idx2 + 500));
      else console.log('HTML 前 800 字:', html.substring(0, 800));
    }
    return { desc: descMatch?.[1], uploader: nickMatch?.[1], cdnUrl: null };
  }

  return { desc: descMatch?.[1], uploader: nickMatch?.[1], cdnUrl };
}

async function transcribeStream(cdnUrl) {
  const fs = require('fs');
  if (!fs.existsSync(MODEL)) {
    console.log('whisper 模型未找到:', MODEL);
    return null;
  }

  // whisper-cli 不支持 stdin pipe（WAV 需可寻址）
  // 方案：ffmpeg 只提取音频存 /tmp，transcribe 后删除（视频不落盘）
  const tmpAudio = `/tmp/douyin-audio-${Date.now()}.wav`;
  console.log('\n用 ffmpeg 提取音频（仅音频，不含视频）...');

  await new Promise((resolve, reject) => {
    const ffmpeg = spawn('/opt/homebrew/bin/ffmpeg', [
      '-y',
      '-user_agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)',
      '-i', cdnUrl,
      '-vn',           // 只取音频，视频流不处理
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      '-t', '300',     // 最多 5 分钟
      tmpAudio,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let ffmpegErr = '';
    ffmpeg.stderr.on('data', d => { ffmpegErr += d.toString(); });
    ffmpeg.on('close', code => {
      if (code !== 0) { console.log('ffmpeg 退出码:', code, '\n', ffmpegErr.slice(-500)); reject(new Error('ffmpeg failed')); }
      else resolve();
    });
    ffmpeg.on('error', reject);
    // 最多 60 秒下载
    setTimeout(() => { ffmpeg.kill('SIGKILL'); reject(new Error('ffmpeg timeout')); }, 60000);
  });

  const stat = fs.statSync(tmpAudio);
  console.log('音频文件大小:', (stat.size / 1024 / 1024).toFixed(1), 'MB');
  console.log('开始转录（whisper base 中文）...');

  return new Promise((resolve) => {
    const whisper = spawn(WHISPER, [
      '--model', MODEL,
      '--language', 'zh',
      '--no-timestamps',
      '-f', tmpAudio,
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    let transcript = '';
    whisper.stdout.on('data', d => { transcript += d.toString(); process.stdout.write(d); });
    whisper.stderr.on('data', () => {});
    whisper.on('close', () => {
      try { fs.unlinkSync(tmpAudio); } catch {}  // 删除临时音频文件
      console.log('\n转录完成');
      resolve(transcript.trim());
    });
    setTimeout(() => { whisper.kill(); resolve(transcript.trim() || null); }, 120000);
  });
}

(async () => {
  console.log('=== 测试 URL:', TEST_URL, '===\n');
  const meta = await extractDouyinStream(TEST_URL);
  if (!meta) return;

  console.log('\n--- 元数据 ---');
  console.log('标题:', meta.desc);
  console.log('作者:', meta.uploader);
  console.log('CDN:', meta.cdnUrl ? meta.cdnUrl.substring(0, 80) + '...' : '无');

  if (meta.cdnUrl) {
    const transcript = await transcribeStream(meta.cdnUrl);
    console.log('\n--- 转录结果 ---');
    console.log(transcript || '（无转录内容）');
  }
})().catch(console.error);
