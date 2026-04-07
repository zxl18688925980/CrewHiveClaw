#!/opt/homebrew/opt/python@3.11/bin/python3.11
"""
本地 TTS 服务  (port 8082)
POST /tts   {"text": "...", "style": "normal"}  → WAV bytes
GET  /health → 200 ok

使用 edge-tts zh-CN-YunxiNeural（普通话男声）。
无需本地模型，edge-tts 在线生成，MP3 → 直接返回（wecom 接受 MP3/WAV）。

style 参数：
  normal  → 默认
  rap     → 语速加快（edge-tts 不支持 instruct，用 +15% 语速模拟节奏感）
"""

import asyncio
import io
import json
import logging
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

import edge_tts

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [local-tts] %(levelname)s %(message)s',
    stream=sys.stdout,
)
logger = logging.getLogger('local-tts')

VOICE     = 'zh-CN-YunxiNeural'
PORT      = 8082


async def _generate(text: str, style: str) -> bytes:
    rate = '+15%' if style == 'rap' else '+0%'
    communicate = edge_tts.Communicate(text, VOICE, rate=rate)
    buf = io.BytesIO()
    async for chunk in communicate.stream():
        if chunk['type'] == 'audio':
            buf.write(chunk['data'])
    return buf.getvalue()


def generate_speech(text: str, style: str = 'normal') -> bytes:
    return asyncio.run(_generate(text, style))


class TtsHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        logger.info(fmt % args)

    def _send_json(self, code: int, body: dict):
        data = json.dumps(body, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path == '/health':
            self._send_json(200, {'status': 'ready', 'model': 'edge-tts', 'voice': VOICE})
        else:
            self._send_json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/tts':
            self._send_json(404, {'error': 'not found'})
            return

        length = int(self.headers.get('Content-Length', 0))
        try:
            data = json.loads(self.rfile.read(length))
        except Exception:
            self._send_json(400, {'error': 'invalid JSON'})
            return

        text  = (data.get('text') or '').strip()
        style = data.get('style', 'normal')
        if not text:
            self._send_json(400, {'error': 'text is required'})
            return

        logger.info(f'生成语音 style={style} len={len(text)} text={text[:40]}')
        try:
            audio = generate_speech(text, style)
        except Exception as e:
            logger.error(f'生成失败: {e}')
            self._send_json(500, {'error': str(e)})
            return

        self.send_response(200)
        self.send_header('Content-Type', 'audio/mpeg')
        self.send_header('Content-Length', str(len(audio)))
        self.end_headers()
        self.wfile.write(audio)
        logger.info(f'语音发送完成: {len(audio)} bytes')


if __name__ == '__main__':
    server = HTTPServer(('127.0.0.1', PORT), TtsHandler)
    logger.info(f'edge-tts TTS server 启动，端口 {PORT}，voice={VOICE}')
    server.serve_forever()
