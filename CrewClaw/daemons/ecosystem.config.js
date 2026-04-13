const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../../../.env') });

// 从 .zshrc/环境变量读取 API keys（PM2 继承 shell env）
const envVars = {
  LOCAL_MODEL_URL:            process.env.LOCAL_MODEL_URL,
  LOCAL_MODEL_NAME:           process.env.LOCAL_MODEL_NAME,
  CHROMADB_URL:               process.env.CHROMADB_URL,
  CHROMA_URL:                 process.env.CHROMA_URL || 'http://localhost:8001',
  GATEWAY_URL:                process.env.GATEWAY_URL         || 'http://localhost:18789',
  OPENCLAW_GATEWAY_TOKEN:     process.env.OPENCLAW_GATEWAY_TOKEN || '696673d08d0ee98f3e66a30698ab4c1152b7c8784ae424d0',
  WECOM_PUSH_URL:             process.env.WECOM_PUSH_URL      || 'http://localhost:3003/api/wecom/push-reply',
  HOMEAI_ROOT:                process.env.HOMEAI_ROOT         || path.join(require('os').homedir(), 'HomeAI'),
  ZAI_API_KEY:                process.env.ZHIPU_API_KEY,  // OpenClaw zai provider
  ZHIPU_API_KEY:              process.env.ZHIPU_API_KEY,  // OpenCode zai provider
  DEEPSEEK_API_KEY:           process.env.DEEPSEEK_API_KEY,
  ANTHROPIC_API_KEY:          process.env.ANTHROPIC_API_KEY,  // Main 系统工程师通道（Claude）
  WECOM_CORP_ID:              process.env.WECOM_CORP_ID,
  WECOM_AGENT_ID:             process.env.WECOM_AGENT_ID,
  WECOM_SECRET:               process.env.WECOM_SECRET,
  WECOM_TOKEN:                process.env.WECOM_TOKEN,
  WECOM_ENCODING_AES_KEY:     process.env.WECOM_ENCODING_AES_KEY,
  WECOM_OWNER_ID:             process.env.WECOM_OWNER_ID,
  WECOM_FAMILY_CHAT_ID:       process.env.WECOM_FAMILY_CHAT_ID,
  WECOM_MOM_ID:               process.env.WECOM_MOM_ID,
  WECOM_AUNT_ID:              process.env.WECOM_AUNT_ID,
  WECOM_BOT_ID:               process.env.WECOM_BOT_ID,
  WECOM_BOT_SECRET:           process.env.WECOM_BOT_SECRET
};

const LOGS_DIR = path.join(__dirname, '../../../logs/pm2');

module.exports = {
  apps: [
    // Lucas/Andy/Lisa 现在是 OpenClaw embedded agents，不再需要守护进程
    // 只保留 Channel 层（wecom-entrance）和基础设施（cloudflared）
    {
      name: 'chromadb',
      script: '/Users/xinbinanshan/HomeAI/App/chromadb-venv/bin/chroma',
      args: `run --path ${path.join(require('os').homedir(), 'HomeAI/Data/chroma')} --port 8001`,
      cwd: path.join(require('os').homedir(), 'HomeAI'),
      interpreter: 'none',
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // max_memory_restart 不设置：chromadb 稳定内存约 106MB，设置会被 PM2 误解析为 100MB 触发 SIGKILL
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(LOGS_DIR, 'chromadb-error.log'),
      out_file:   path.join(LOGS_DIR, 'chromadb-out.log'),
      combine_logs: true,
      merge_logs: true
    },
    {
      name: 'wecom-entrance',
      script: 'entrances/wecom/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      restart_delay: 3000,
      env: {
        NODE_ENV: 'production',
        WECOM_PORT: 3003,
        ...envVars
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(LOGS_DIR, 'wecom-error.log'),
      out_file:   path.join(LOGS_DIR, 'wecom-out.log'),
      combine_logs: true,
      merge_logs: true
    },
    // mlx-vision 暂停（2026-04-08）：等 mlx_vlm 支持 gemma4 后用 Gemma4 多模态一次性替换
    // 视觉功能当前降级到 GLM Vision 云端兜底
    // 恢复命令：pm2 start ecosystem.config.js --only mlx-vision
    // {
    //   name: 'mlx-vision',
    //   script: '/Users/xinbinanshan/HomeAI/CrewHiveClaw/CrewClaw/daemons/services/mlx-vision-server.py',
    //   interpreter: '/opt/homebrew/opt/python@3.11/bin/python3.11',
    //   ...
    // },
    // mlx-gemma4 暂停（2026-04-08）：
    //   - 对话路由 localThresholdInit=0.0，本地路由从未触发，无有效工作
    //   - mlx_lm.server 是纯文本接口，不支持 vision，图片路径直接降级到 GLM Vision
    // 恢复条件（满足其一）：
    //   A. evolveRouting() 把 localThreshold 抬高后，需要本地对话路由
    //   B. mlx_vlm 支持 Gemma4 → 届时改用 mlx_vlm（同时接管 vision），
    //      本地 provider 从 mlx_lm.server 切换到 mlx_vlm server，不再需要此条目
    // 恢复命令：pm2 start ecosystem.config.js --only mlx-gemma4
    // {
    //   name: 'mlx-gemma4',
    //   script: '/opt/homebrew/opt/python@3.11/bin/python3.11',
    //   args: '-m mlx_lm server --model /Users/xinbinanshan/HomeAI/Models/mlx/gemma-4-31B-lucas-fused --host 127.0.0.1 --port 8083',
    //   interpreter: 'none',
    //   cwd: path.join(require('os').homedir(), 'HomeAI'),
    //   instances: 1,
    //   exec_mode: 'fork',
    //   autorestart: true,
    //   watch: false,
    //   restart_delay: 10000,
    //   min_uptime: '60s',
    //   log_date_format: 'YYYY-MM-DD HH:mm:ss',
    //   error_file: path.join(LOGS_DIR, 'mlx-gemma4-error.log'),
    //   out_file:   path.join(LOGS_DIR, 'mlx-gemma4-out.log'),
    //   combine_logs: true,
    //   merge_logs: true
    // },
    {
      name: 'local-tts',
      script: '/Users/xinbinanshan/HomeAI/CrewHiveClaw/CrewClaw/daemons/services/tts-server.py',
      interpreter: '/opt/homebrew/opt/python@3.11/bin/python3.11',
      cwd: path.join(require('os').homedir(), 'HomeAI'),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      // 不设 max_memory_restart：模型约 4GB，不应被 PM2 杀掉
      restart_delay: 10000,
      min_uptime: '60s',  // 60s 内退出视为启动失败，避免模型文件未就绪时无限重启
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(LOGS_DIR, 'local-tts-error.log'),
      out_file:   path.join(LOGS_DIR, 'local-tts-out.log'),
      combine_logs: true,
      merge_logs: true
    },
    {
      name: 'gateway-watchdog',
      script: path.join(require('os').homedir(), 'HomeAI/CrewHiveClaw/HomeAILocal/Scripts/gateway-watchdog.js'),
      cwd: path.join(require('os').homedir(), 'HomeAI'),
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '200M',
      restart_delay: 5000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(LOGS_DIR, 'gateway-watchdog-error.log'),
      out_file:   path.join(LOGS_DIR, 'gateway-watchdog-out.log'),
      combine_logs: true,
      merge_logs: true
    },
    {
      name: 'cloudflared-tunnel',
      script: '/opt/homebrew/bin/cloudflared',
      args: 'tunnel run homeai-wecom',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '100M',
      restart_delay: 3000,
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      error_file: path.join(LOGS_DIR, 'cloudflared-error.log'),
      out_file:   path.join(LOGS_DIR, 'cloudflared-out.log'),
      combine_logs: true,
      merge_logs: true
    }
  ]
};
