#!/usr/bin/env node
/**
 * 健康监控脚本
 * cron: 每 5 分钟执行一次
 * 检查 OpenClaw Gateway、Ollama、ChromaDB、mlx-vision、local-tts 状态
 *
 * 注意：Lucas/Andy/Lisa 是 OpenClaw 内嵌 Agent，无独立端口，
 *       健康状态由 Gateway 统一反映。
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, '../logs/health.log');

const SERVICES = [
  {
    name: 'Gateway',
    url: 'http://localhost:18789/health',
    timeout: 10000,
    // Gateway 通过 launchd 管理，不是 PM2
  },
  {
    name: 'Ollama',
    url: 'http://localhost:11434/api/tags',
    timeout: 5000,
  },
  {
    name: 'ChromaDB',
    url: 'http://localhost:8001/api/v2/heartbeat',
    timeout: 5000,
  },
  {
    name: 'mlx-vision',
    url: 'http://localhost:8081/health',
    timeout: 5000,
  },
  {
    name: 'local-tts',
    url: 'http://localhost:8082/health',
    timeout: 5000,
  },
];

async function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf8');
  } catch (_) {}
}

async function checkService(service) {
  return new Promise((resolve) => {
    const url = new URL(service.url);
    const req = http.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      timeout: service.timeout,
    }, (res) => {
      resolve({ name: service.name, ok: res.statusCode === 200 });
    });
    req.on('error', (e) => resolve({ name: service.name, ok: false, error: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ name: service.name, ok: false, error: 'timeout' }); });
    req.end();
  });
}

async function main() {
  const results = await Promise.all(SERVICES.map(checkService));
  const failed = results.filter(r => !r.ok);

  if (failed.length === 0) {
    await log(`OK ${SERVICES.length}/${SERVICES.length}`);
  } else {
    const names = failed.map(f => `${f.name}(${f.error})`).join(', ');
    await log(`FAIL ${failed.length}/${SERVICES.length}: ${names}`);
  }
}

main().catch(e => {
  console.error('[health-monitor]', e.message);
  process.exit(1);
});
