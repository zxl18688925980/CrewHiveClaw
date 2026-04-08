#!/opt/homebrew/opt/python@3.11/bin/python3.11
"""
MLX Vision Server
提供 OpenAI 兼容的 /v1/chat/completions 接口，底层用 mlx_vlm 推理
加载 Qwen2.5-VL-32B-Instruct-4bit（mlx-vlm 0.4.2+，含 vision_tower）

使用: python3 mlx-vision-server.py
端口: 8081
"""

import sys
import os
import json
import base64
import tempfile
import logging
import time

from http.server import BaseHTTPRequestHandler, HTTPServer
from mlx_vlm import load, generate
from mlx_vlm.prompt_utils import apply_chat_template
from mlx_vlm.utils import load_config

logging.basicConfig(
    level=logging.INFO,
    format='[%(asctime)s] %(levelname)s %(message)s',
    datefmt='%H:%M:%S'
)
log = logging.getLogger('mlx-vision')

MODEL_PATH = os.path.expanduser('~/HomeAI/models/mlx/Qwen2.5-VL-32B-4bit')
PORT = 8081

log.info(f'Loading model: {MODEL_PATH}')

model, processor = load(MODEL_PATH)
config = load_config(MODEL_PATH)

# transformers >= 4.49 的 fast image processor 要求 return_tensors="pt"（PyTorch），
# 与 mlx_vlm 不兼容（mlx_vlm 用 MLX tensor，不传 return_tensors）。
# 换成 slow processor 绕过这个校验，推理结果完全等价。
if hasattr(processor, 'image_processor') and 'Fast' in type(processor.image_processor).__name__:
    try:
        from transformers import AutoImageProcessor
        processor.image_processor = AutoImageProcessor.from_pretrained(MODEL_PATH, use_fast=False)
        log.info('Switched to slow image processor (transformers fast-processor workaround)')
    except Exception as _wp_err:
        log.warning(f'Could not switch to slow image processor: {_wp_err}')

log.info('Model loaded and ready.')


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log.info(fmt % args)

    def do_GET(self):
        if self.path == '/health':
            self._json(200, {'status': 'ok', 'model': 'qwen2.5-vl-32b-4bit'})
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/v1/chat/completions':
            self._json(404, {'error': 'not found'})
            return

        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length))

        messages = body.get('messages', [])
        max_tokens = body.get('max_tokens', 512)
        temperature = body.get('temperature', 0.0)

        # Extract text prompt and images from messages
        prompt_text = ''
        image_paths = []
        tmp_files = []

        for msg in messages:
            content = msg.get('content', '')
            if isinstance(content, str):
                prompt_text += content + '\n'
            elif isinstance(content, list):
                for part in content:
                    if part.get('type') == 'text':
                        prompt_text += part.get('text', '') + '\n'
                    elif part.get('type') == 'image_url':
                        url = part.get('image_url', {}).get('url', '')
                        if url.startswith('data:'):
                            # base64 inline image
                            header, b64data = url.split(',', 1)
                            ext = 'jpg'
                            if 'png' in header:
                                ext = 'png'
                            tmp = tempfile.NamedTemporaryFile(suffix=f'.{ext}', delete=False)
                            tmp.write(base64.b64decode(b64data))
                            tmp.close()
                            image_paths.append(tmp.name)
                            tmp_files.append(tmp.name)
                        elif url.startswith('/') or url.startswith('file://'):
                            path = url.replace('file://', '')
                            image_paths.append(path)

        try:
            prompt_text = prompt_text.strip()
            if not prompt_text:
                prompt_text = '请用中文详细描述这张图片的所有内容，包括人物、物品、场景、文字等。'

            formatted_prompt = apply_chat_template(
                processor, config, prompt_text,
                num_images=len(image_paths) if image_paths else 0
            )

            image_arg = image_paths if image_paths else None
            t0 = time.time()
            result = generate(
                model, processor,
                formatted_prompt,
                image=image_arg,
                max_tokens=max_tokens,
                temperature=temperature,
                verbose=False,
            )
            elapsed = time.time() - t0
            result_text = result.text if hasattr(result, 'text') else str(result)
            log.info(f'Generated {len(result_text)} chars in {elapsed:.1f}s')

            self._json(200, {
                'id': f'chatcmpl-mlx-{int(t0)}',
                'object': 'chat.completion',
                'model': 'qwen2.5-vl-32b-4bit',
                'choices': [{
                    'index': 0,
                    'message': {'role': 'assistant', 'content': result_text},
                    'finish_reason': 'stop'
                }],
                'usage': {
                    'prompt_tokens': getattr(result, 'prompt_tokens', 0),
                    'completion_tokens': getattr(result, 'generation_tokens', 0),
                    'total_tokens': getattr(result, 'total_tokens', 0),
                }
            })
        except Exception as e:
            log.error(f'Generation error: {e}', exc_info=True)
            self._json(500, {'error': str(e)})
        finally:
            for f in tmp_files:
                try:
                    os.unlink(f)
                except Exception:
                    pass

    def _json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == '__main__':
    server = HTTPServer(('127.0.0.1', PORT), Handler)
    log.info(f'MLX Vision Server listening on 127.0.0.1:{PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info('Server stopped.')
