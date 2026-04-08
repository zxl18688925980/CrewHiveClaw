#!/bin/bash
# 下载 Gemma 4 31B Dense (Base 版本) 从国内镜像
# 用法: bash scripts/download-gemma.sh

set -e

HOMEAI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_NAME="google/gemma-4-31B"
TARGET_DIR="$HOMEAI_DIR/models/huggingface/google/gemma-4-31B"
LOG_FILE="$HOMEAI_DIR/logs/download-gemma.log"

export HF_ENDPOINT="https://hf-mirror.com"
export HF_HUB_OFFLINE=0

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$TARGET_DIR"

log "=== 开始下载 Gemma 4 31B ==="
log "模型: $MODEL_NAME"
log "目标目录: $TARGET_DIR"
log "镜像: $HF_ENDPOINT"

python3 - <<PYEOF
import os
import sys

os.environ['HF_ENDPOINT'] = 'https://hf-mirror.com'
os.environ['HF_HUB_OFFLINE'] = '0'

from huggingface_hub import snapshot_download

try:
    print("开始下载，这可能需要 30-60 分钟...")
    path = snapshot_download(
        repo_id="google/gemma-4-31B",
        local_dir="$TARGET_DIR",
        local_dir_use_symlinks=False,
        resume_download=True,
    )
    print(f"下载完成: {path}")
except Exception as e:
    print(f"下载失败: {e}")
    sys.exit(1)
PYEOF

log "=== 下载完成 ==="
