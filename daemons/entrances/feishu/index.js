/**
 * 飞书入口 - 接收飞书 Webhook 消息并转发给 HomeAI
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const winston = require('winston');
require('dotenv').config();

const path = require('path');

// 日志配置
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ 
      filename: path.join(__dirname, '../../../logs/feishu-entrance.log')
    }),
    new winston.transports.Console()
  ]
});

const app = express();
const PORT = process.env.FEISHU_PORT || 3003;

// 中间件
app.use(cors());
app.use(express.json());

// 健康检查
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'feishu-entrance', 
    port: PORT,
    homeaiUrl: 'http://localhost:3000/api/chat'
  });
});

// 飞书 Webhook 接收接口
app.post('/api/feishu/webhook', async (req, res) => {
  const { challenge, token, type, header, event } = req.body;
  
  logger.info('Received Feishu webhook', { 
    type, 
    token: token ? 'present' : 'missing',
    eventType: event?.type
  });
  
  // 处理飞书 URL 验证
  if (type === 'url_verification') {
    logger.info('Feishu URL verification request', { challenge });
    return res.json({ challenge });
  }
  
  try {
    // 提取消息内容
    const message = extractMessage(event);
    const userId = extractUserId(event);
    
    if (!message) {
      logger.warn('No message content found in webhook');
      return res.json({ success: true, message: 'No content to process' });
    }
    
    logger.info('Forwarding message to HomeAI', { message, userId });
    
    // 转发给 HomeAI 守护进程
    const homeaiResponse = await axios.post('http://localhost:3000/api/chat', {
      message,
      userId: `feishu-${userId}`
    }, {
      timeout: 30000
    });
    
    const homeaiData = homeaiResponse.data;
    
    logger.info('Received response from HomeAI', { 
      success: homeaiData.success,
      responseLength: homeaiData.response?.length || 0
    });
    
    // 构建飞书响应
    const feishuResponse = buildFeishuResponse(homeaiData.response);
    
    res.json(feishuResponse);
    
  } catch (error) {
    logger.error('Error processing Feishu webhook', { 
      error: error.message,
      stack: error.stack 
    });
    
    res.status(500).json({ 
      success: false, 
      error: 'Internal server error',
      message: error.message 
    });
  }
});

// 直接消息转发接口（用于测试）
app.post('/api/feishu/forward', async (req, res) => {
  const { message, userId = 'test-user' } = req.body;
  
  if (!message) {
    return res.status(400).json({ success: false, error: 'Message is required' });
  }
  
  try {
    logger.info('Forwarding test message to HomeAI', { message, userId });
    
    const homeaiResponse = await axios.post('http://localhost:3000/api/chat', {
      message,
      userId: `feishu-${userId}`
    }, {
      timeout: 30000
    });
    
    const homeaiData = homeaiResponse.data;
    
    res.json({
      success: true,
      originalMessage: message,
      homeaiResponse: homeaiData
    });
    
  } catch (error) {
    logger.error('Error forwarding message', { error: error.message });
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * 从飞书事件中提取消息内容
 */
function extractMessage(event) {
  if (!event) return null;
  
  // 处理消息事件
  if (event.type === 'message') {
    const message = event.message;
    
    if (message.content) {
      try {
        const content = JSON.parse(message.content);
        return content.text || content;
      } catch (e) {
        return message.content;
      }
    }
    
    return message.text || message.content;
  }
  
  // 处理其他事件类型
  return event.text || event.content || JSON.stringify(event);
}

/**
 * 从飞书事件中提取用户ID
 */
function extractUserId(event) {
  if (!event) return 'unknown';
  
  if (event.sender) {
    return event.sender.sender_id?.user_id || 
           event.sender.sender_id?.open_id ||
           event.sender.user_id ||
           'unknown';
  }
  
  return event.user_id || event.open_id || 'unknown';
}

/**
 * 构建飞书响应
 */
function buildFeishuResponse(text) {
  return {
    success: true,
    data: {
      content: JSON.stringify({
        text: text || '已收到消息，正在处理...',
        post: {
          zh_cn: {
            title: 'HomeAI 回复',
            content: [
              [
                {
                  tag: 'text',
                  text: text || '已收到消息，正在处理...'
                }
              ]
            ]
          }
        }
      })
    }
  };
}

// 启动服务器
app.listen(PORT, () => {
  logger.info('飞书入口已启动', { port: PORT });
  console.log(`🚀 飞书入口运行在 http://localhost:${PORT}`);
  console.log(`📞 健康检查: http://localhost:${PORT}/api/health`);
  console.log(`🤖 测试接口: POST http://localhost:${PORT}/api/feishu/forward`);
});

module.exports = app;