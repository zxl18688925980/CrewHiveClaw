#!/opt/homebrew/opt/python@3.11/bin/python3.11
"""
Fish-Speech TTS 服务 (port 8082)
POST /tts   {"text": "...", "style": "normal"}  → WAV bytes
GET  /health → 200 ok

使用 mlx-community/fish-audio-s2-pro（Fish Audio S2 Pro）
音色克隆：ref_audio = ~/HomeAI/data/voice-samples/lucas.wav
           ref_text  = ~/HomeAI/data/voice-samples/lucas.txt

style 参数：
  normal  → 默认，无额外控制标签
  rap     → 在文本前插入 [excited] 使语气更活泼有节奏感

inline 控制标签（直接嵌入 text 中也生效）：
  [pause] [emphasis] [laughing] [excited] [whisper] [sad] [angry] 等
"""

import io
import json
import logging
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import numpy as np

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s [fish-tts] %(levelname)s %(message)s',
    stream=sys.stdout,
)
log = logging.getLogger('fish-tts')

MODEL_PATH  = os.path.expanduser('~/HomeAI/models/fish-audio/s2-pro')
REF_AUDIO   = os.path.expanduser('~/HomeAI/data/voice-samples/lucas.wav')
REF_TEXT_F  = os.path.expanduser('~/HomeAI/data/voice-samples/lucas.txt')
PORT        = 8082

_model        = None
_ref_text     = ''
_ref_audio    = None  # mx.array，启动时预加载
_model_loaded = False
_model_error  = None
_lock         = threading.Lock()


def _load_ref_audio():
    """加载 lucas.wav → mx.array，采样率与模型对齐"""
    import soundfile as sf
    import mlx.core as mx
    data, sr = sf.read(REF_AUDIO, dtype='float32', always_2d=False)
    # 重采样至模型采样率（如不一致）
    target_sr = 44100  # Fish-Speech S2 Pro 默认采样率
    if sr != target_sr:
        try:
            import resampy
            data = resampy.resample(data, sr, target_sr)
        except ImportError:
            log.warning(f'resampy 未安装，采样率不匹配 ({sr} vs {target_sr})，继续尝试')
    return mx.array(data)


def _load_model():
    global _model, _ref_text, _ref_audio, _model_loaded, _model_error
    try:
        log.info(f'加载 Fish-Speech S2 Pro 模型: {MODEL_PATH}')
        from mlx_audio.tts.utils import load_model
        _model = load_model(MODEL_PATH)

        if os.path.exists(REF_TEXT_F):
            with open(REF_TEXT_F, 'r', encoding='utf-8') as f:
                _ref_text = f.read().strip()
        log.info(f'ref_text: {_ref_text[:40]}...')

        # 预加载 ref_audio
        _ref_audio = _load_ref_audio()
        log.info(f'ref_audio 加载完成，shape={_ref_audio.shape}')

        # warm-up
        log.info('warm-up 推理中...')
        list(_model.generate(
            text='你好',
            ref_audio=_ref_audio,
            ref_text=_ref_text,
        ))
        _model_loaded = True
        log.info('Fish-Speech 模型加载完成，服务就绪')
    except Exception as e:
        _model_error = str(e)
        log.error(f'模型加载失败: {e}', exc_info=True)


def _audio_to_wav_bytes(audio_array, sample_rate: int) -> bytes:
    """mx.array / np.ndarray → WAV bytes（16-bit PCM）"""
    import soundfile as sf
    arr = np.array(audio_array, dtype=np.float32)
    if arr.ndim > 1:
        arr = arr.squeeze()
    buf = io.BytesIO()
    sf.write(buf, arr, sample_rate, format='WAV', subtype='PCM_16')
    return buf.getvalue()


def generate_speech(text: str, style: str = 'normal') -> bytes:
    if not _model_loaded:
        raise RuntimeError(f'模型未就绪: {_model_error or "loading"}')

    if style == 'rap':
        text = f'[excited]{text}'

    log.info(f'生成语音 style={style} len={len(text)} text={text[:50]}')

    chunks = list(_model.generate(
        text=text,
        ref_audio=_ref_audio,
        ref_text=_ref_text,
        chunk_length=200,
    ))

    if not chunks:
        raise RuntimeError('generate 未返回任何 chunk')

    audio_parts = [np.array(c.audio, dtype=np.float32) for c in chunks]
    audio = np.concatenate(audio_parts) if len(audio_parts) > 1 else audio_parts[0]
    sample_rate = _model.sample_rate
    return _audio_to_wav_bytes(audio, sample_rate)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        log.info(fmt % args)

    def do_GET(self):
        if self.path == '/health':
            status = 'ready' if _model_loaded else ('error' if _model_error else 'loading')
            self._json(200, {
                'status': status,
                'model': 'fish-audio-s2-pro',
                'voice': 'lucas',
                'error': _model_error,
            })
        else:
            self._json(404, {'error': 'not found'})

    def do_POST(self):
        if self.path != '/tts':
            self._json(404, {'error': 'not found'})
            return

        length = int(self.headers.get('Content-Length', 0))
        try:
            data = json.loads(self.rfile.read(length))
        except Exception:
            self._json(400, {'error': 'invalid JSON'})
            return

        text  = (data.get('text') or '').strip()
        style = data.get('style', 'normal')
        if not text:
            self._json(400, {'error': 'text is required'})
            return

        if not _model_loaded:
            self._json(503, {'error': f'model not ready: {_model_error or "loading"}'})
            return

        try:
            with _lock:
                wav = generate_speech(text, style)
        except Exception as e:
            log.error(f'生成失败: {e}', exc_info=True)
            self._json(500, {'error': str(e)})
            return

        self.send_response(200)
        self.send_header('Content-Type', 'audio/wav')
        self.send_header('Content-Length', str(len(wav)))
        self.end_headers()
        self.wfile.write(wav)
        log.info(f'语音发送完成: {len(wav)} bytes')

    def _json(self, code, body):
        data = json.dumps(body, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


if __name__ == '__main__':
    threading.Thread(target=_load_model, daemon=True).start()
    server = HTTPServer(('127.0.0.1', PORT), Handler)
    log.info(f'Fish-Speech TTS server 启动，端口 {PORT}')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log.info('Server stopped.')
