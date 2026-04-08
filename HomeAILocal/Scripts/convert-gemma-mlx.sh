#!/bin/bash
# 将 Gemma 4 31B 转换为 MLX 4-bit 格式
# 用法: nohup bash scripts/convert-gemma-mlx.sh >> logs/convert-gemma-mlx.log 2>&1 &

HOMEAI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$HOMEAI_DIR/models/huggingface/google/gemma-4-31B"
DST="$HOMEAI_DIR/models/mlx/gemma-4-31B-4bit"
LOG_FILE="$HOMEAI_DIR/logs/convert-gemma-mlx.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$(dirname "$DST")"

log "=== 开始转换 Gemma 4 31B → MLX 4-bit ==="
log "源目录: $SRC"
log "目标目录: $DST"
log "量化: 4-bit (q_group_size=64)"

/opt/homebrew/opt/python@3.11/bin/python3.11 -m mlx_lm convert \
    --hf-path "$SRC" \
    --mlx-path "$DST" \
    --quantize \
    --q-bits 4 \
    --q-group-size 64

EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
    log "=== 转换完成 ==="
    du -sh "$DST" | tee -a "$LOG_FILE"
else
    log "=== 转换失败，exit code: $EXIT_CODE ==="
fi
