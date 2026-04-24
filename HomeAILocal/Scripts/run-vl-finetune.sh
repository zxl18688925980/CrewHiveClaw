#!/bin/bash
# run-vl-finetune.sh — Qwen3-VL-32B LoRA 三角色训练脚本（L5 Phase 1）
#
# 用法：
#   bash run-vl-finetune.sh            # 训练三个角色（顺序执行）
#   bash run-vl-finetune.sh lucas      # 只训练 lucas
#   bash run-vl-finetune.sh andy lisa  # 训练指定角色
#
# 产出：~/HomeAI/Models/adapters/qwen3vl-{lucas,andy,lisa}/adapters.safetensors
# 生效：训练完成后 callLocalMLX 自动检测 adapter 存在并切入，无需重启任何服务

set -eo pipefail

PYTHON="/opt/homebrew/opt/python@3.11/bin/python3.11"
DATA_ROOT="${HOMEAI_ROOT:-$HOME/HomeAI}"
MLX_MODEL="$DATA_ROOT/Models/mlx/Qwen3-VL-32B-4bit"
ADAPTERS_BASE="$DATA_ROOT/Models/adapters"
TRAINING_DATA="$DATA_ROOT/Data/finetune/vl-training"
LOG_DIR="$DATA_ROOT/../Logs"
RUN_DATE=$(date +%Y%m%d-%H%M%S)

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# 训练参数（基于 M1 Max 36GB 经验，Qwen3-VL-32B-4bit 约占 18-20GB）
ITERS=200
BATCH_SIZE=1
LORA_RANK=8
LORA_ALPHA=16
MAX_SEQ=2048
LR=1e-5

# 验证环境
if [ ! -f "$MLX_MODEL/config.json" ]; then
    log "ERROR: MLX base 模型不存在: $MLX_MODEL"
    exit 1
fi

if ! $PYTHON -c "import mlx_vlm" 2>/dev/null; then
    log "ERROR: mlx_vlm 未安装"
    exit 1
fi

# 先准备语料
log "准备训练语料..."
$PYTHON "$DATA_ROOT/../HomeAI/CrewHiveClaw/HomeAILocal/Scripts/prepare-vl-corpus.py" 2>&1 | grep -v "^W[0-9]"

# 确定要训练的角色
if [ $# -gt 0 ]; then
    ROLES=("$@")
else
    ROLES=("lucas" "andy" "lisa")
fi

log "训练角色：${ROLES[*]}"
log "MLX base：$MLX_MODEL"
log "iters=$ITERS  batch=$BATCH_SIZE  rank=$LORA_RANK  alpha=$LORA_ALPHA  lr=$LR"

for ROLE in "${ROLES[@]}"; do
    ADAPTER_OUT="$ADAPTERS_BASE/qwen3vl-$ROLE"
    DATA_DIR="$TRAINING_DATA/$ROLE"
    TRAIN_FILE="$DATA_DIR/train.jsonl"
    LOG_FILE="$LOG_DIR/vl-finetune-$ROLE-$RUN_DATE.log"

    if [ ! -f "$TRAIN_FILE" ]; then
        log "SKIP $ROLE: 训练数据不存在 ($TRAIN_FILE)"
        continue
    fi

    TRAIN_COUNT=$(wc -l < "$TRAIN_FILE")
    if [ "$TRAIN_COUNT" -lt 5 ]; then
        log "SKIP $ROLE: 训练样本不足（$TRAIN_COUNT 条，需 ≥5）"
        continue
    fi

    log "=== 开始训练 $ROLE（$TRAIN_COUNT 条样本）==="
    mkdir -p "$ADAPTER_OUT"

    $PYTHON -m mlx_vlm.lora \
        --model-path "$MLX_MODEL" \
        --dataset "$DATA_DIR" \
        --output-path "$ADAPTER_OUT" \
        --train-mode sft \
        --iters $ITERS \
        --batch-size $BATCH_SIZE \
        --grad-checkpoint \
        --lora-rank $LORA_RANK \
        --lora-alpha $LORA_ALPHA \
        --max-seq-length $MAX_SEQ \
        --learning-rate $LR \
        --steps-per-report 20 \
        --steps-per-save 100 \
        2>&1 | tee "$LOG_FILE" | grep -E "iter|loss|val|ERROR|WARNING|Saved" || true

    # 验证产出
    if [ -f "$ADAPTER_OUT/adapters.safetensors" ]; then
        SIZE=$(du -sh "$ADAPTER_OUT/adapters.safetensors" | cut -f1)
        log "✅ $ROLE adapter 训练完成：$ADAPTER_OUT/adapters.safetensors ($SIZE)"
    else
        log "⚠️ $ROLE adapter 文件未生成，检查日志：$LOG_FILE"
    fi
done

log "=== 全部完成 ==="
log ""
log "验证命令："
log "  python3.11 -c \"from local_inference import listLocalModels; import json; print(json.dumps(listLocalModels(), indent=2))\""
log ""
log "生效方式：callLocalMLX 自动检测 adapter，下次调用即生效，无需重启"
