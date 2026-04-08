#!/bin/bash
# Gemma 4 31B 4-bit LoRA 微调
# 用法: nohup bash scripts/finetune-gemma4-lora.sh >> logs/finetune-gemma4.log 2>&1 &

HOMEAI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_DIR="$HOMEAI_DIR/models/mlx/gemma-4-31B-4bit"
DATA_DIR="$HOMEAI_DIR/models/data-gemma4"
ADAPTER_DIR="$HOMEAI_DIR/models/adapters/gemma4-lucas"
LOG_FILE="$HOMEAI_DIR/logs/finetune-gemma4.log"
PYTHON="/opt/homebrew/opt/python@3.11/bin/python3.11"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

mkdir -p "$ADAPTER_DIR"

log "=== 准备微调数据 ==="
$PYTHON "$HOMEAI_DIR/scripts/prepare-gemma-finetune-data.py" | tee -a "$LOG_FILE"

log "=== 开始 Gemma 4 LoRA 微调 ==="
log "模型: $MODEL_DIR"
log "数据: $DATA_DIR"
log "适配器输出: $ADAPTER_DIR"

$PYTHON -m mlx_lm lora \
    --model "$MODEL_DIR" \
    --train \
    --data "$DATA_DIR" \
    --num-layers 4 \
    --batch-size 1 \
    --learning-rate 2e-5 \
    --iters 300 \
    --adapter-path "$ADAPTER_DIR" \
    --save-every 100 \
    --val-batches 5 \
    --max-seq-length 1024 \
    --seed 42

EXIT_CODE=$?
if [ $EXIT_CODE -eq 0 ]; then
    log "=== 微调完成 ==="
    log "适配器位置: $ADAPTER_DIR"
    du -sh "$ADAPTER_DIR" | tee -a "$LOG_FILE"
else
    log "=== 微调失败，exit code: $EXIT_CODE ==="
fi
