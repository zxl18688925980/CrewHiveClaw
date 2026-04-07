/**
 * 本地语音入口 - 语音识别和TTS播报
 * 注意：需要安装 Vosk 和 TTS 依赖
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const winston = require('winston');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// 检查依赖
const DEPENDENCIES = {
  vosk: false,
  tts: false
};

// 尝试导入 Vosk（可选）
try {
  require('vosk');
  DEPENDENCIES.vosk = true;
} catch (e) {
  console.warn('Vosk 未安装，语音识别功能将受限');
}

// 检查 TTS 命令
async function checkTTS() {
  try {
    // 检查 say 命令（macOS）
    const { exec } = require('child_process');
    await new Promise((resolve, reject) => {
      exec('which say', (error) => {
        if (!error) {
          DEPENDENCIES.tts = true;
        }
        resolve();
      });
    });
  } catch (e) {
    // 忽略错误
  }
}

// 日志配置
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ 
      filename: path.join(__dirname, '../../../logs/voice-entrance.log')
    }),
    new winston.transports.Console()
  ]
});

const app = express();
const PORT = process.env.VOICE_PORT || 3004;

// 中间件
app.use(cors());
app.use(express.json());

// 健康检查
app.get('/api/health', async (req, res) => {
  await checkTTS();
  
  res.json({ 
    status: 'ok', 
    service: 'voice-entrance', 
    port: PORT,
    dependencies: DEPENDENCIES,
    homeaiUrl: 'http://localhost:3000/api/chat',
    endpoints: {
      textToSpeech: 'POST /api/voice/speak',
      processVoice: 'POST /api/voice/process'
    }
  });
});

// 文本转语音接口
app.post('/api/voice/speak', async (req, res) => {
  const { text, voice = 'Tingting' } = req.body;
  
  if (!text) {
    return res.status(400).json({ success: false, error: 'Text is required' });
  }
  
  try {
    logger.info('Text to speech request', { textLength: text.length, voice });
    
    // macOS 使用 say 命令
    const sayCommand = spawn('say', ['-v', voice, text]);
    
    sayCommand.on('close', (code) => {
      if (code === 0) {
        logger.info('Speech completed successfully', { textLength: text.length });
        res.json({ success: true, message: 'Speech completed' });
      } else {
        logger.error('Speech command failed', { code });
        res.status(500).json({ success: false, error: `Speech command failed with code ${code}` });
      }
    });
    
    sayCommand.on('error', (error) => {
      logger.error('Speech command error', { error: error.message });
      res.status(500).json({ success: false, error: error.message });
    });
    
    // 设置超时
    setTimeout(() => {
      if (!sayCommand.killed) {
        sayCommand.kill();
        res.status(500).json({ success: false, error: 'Speech timeout' });
      }
    }, 30000);
    
  } catch (error) {
    logger.error('Error in text to speech', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// 处理语音消息（模拟接口，实际需要音频输入）
app.post('/api/voice/process', async (req, res) => {
  const { text, audioUrl, userId = 'voice-user' } = req.body;
  
  // 如果没有文本但有音频URL，这里应该处理音频识别
  // 目前只处理文本输入
  const message = text || '[语音输入]';
  
  try {
    logger.info('Processing voice message', { 
      hasText: !!text,
      hasAudioUrl: !!audioUrl,
      userId 
    });
    
    // 转发给 HomeAI 守护进程
    const homeaiResponse = await axios.post('http://localhost:3000/api/chat', {
      message,
      userId: `voice-${userId}`
    }, {
      timeout: 30000
    });
    
    const homeaiData = homeaiResponse.data;
    
    logger.info('Received response from HomeAI', { 
      success: homeaiData.success,
      responseLength: homeaiData.response?.length || 0
    });
    
    // 如果请求中包含 speak=true，则使用TTS播报
    if (req.body.speak !== false && homeaiData.response) {
      try {
        const ttsResponse = await axios.post(`http://localhost:${PORT}/api/voice/speak`, {
          text: homeaiData.response,
          voice: req.body.voice || 'Tingting'
        }, {
          timeout: 10000
        });
        
        logger.info('TTS response', { success: ttsResponse.data.success });
      } catch (ttsError) {
        logger.warn('TTS failed, continuing without speech', { error: ttsError.message });
      }
    }
    
    res.json({
      success: true,
      originalInput: { text, audioUrl: !!audioUrl },
      homeaiResponse: homeaiData,
      ttsEnabled: req.body.speak !== false
    });
    
  } catch (error) {
    logger.error('Error processing voice message', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// 语音识别测试接口（需要 Vosk）
app.post('/api/voice/recognize', async (req, res) => {
  if (!DEPENDENCIES.vosk) {
    return res.status(501).json({ 
      success: false, 
      error: 'Vosk not installed',
      instructions: 'Install with: npm install vosk'
    });
  }
  
  const { audioData, sampleRate = 16000 } = req.body;
  
  if (!audioData) {
    return res.status(400).json({ success: false, error: 'Audio data is required' });
  }
  
  try {
    // 这里应该实现 Vosk 语音识别
    // 由于 Vosk 需要模型文件，这里只提供框架
    logger.info('Voice recognition request', { 
      audioDataLength: audioData.length,
      sampleRate 
    });
    
    // 模拟识别结果
    const recognizedText = '[语音识别结果] 这是一段模拟的语音识别文本';
    
    res.json({
      success: true,
      recognizedText,
      sampleRate,
      processingTime: '模拟处理'
    });
    
  } catch (error) {
    logger.error('Error in voice recognition', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

// 启动服务器
checkTTS().then(() => {
  app.listen(PORT, () => {
    logger.info('语音入口已启动', { 
      port: PORT,
      dependencies: DEPENDENCIES
    });
    
    console.log(`🎤 语音入口运行在 http://localhost:${PORT}`);
    console.log(`📊 健康检查: http://localhost:${PORT}/api/health`);
    console.log(`🗣️  文本转语音: POST http://localhost:${PORT}/api/voice/speak`);
    console.log(`🎧 处理语音消息: POST http://localhost:${PORT}/api/voice/process`);
    
    if (!DEPENDENCIES.vosk) {
      console.log('⚠️  Vosk 未安装，语音识别功能受限');
      console.log('   安装命令: npm install vosk');
    }
    
    if (!DEPENDENCIES.tts) {
      console.log('⚠️  TTS 命令不可用（macOS say 命令）');
    }
  });
});

module.exports = app;