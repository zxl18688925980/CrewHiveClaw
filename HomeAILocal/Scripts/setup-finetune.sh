#!/bin/bash
# setup-finetune.sh — HomeAI 初始化训练脚本（一次性）
# 使用 Qwen3.6-35B-A3B（Qwen3-35B-A3B）+ MLX LoRA
# 用法：bash scripts/setup-finetune.sh

set -eo pipefail

HOMEAI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
HF_MODEL_PATH="$HOMEAI_DIR/models/huggingface/Qwen/Qwen3-35B-A3B"
MLX_MODEL_PATH="$HOMEAI_DIR/models/mlx/Qwen3.6-35B-A3B-4bit"
RAW_DATA="$HOMEAI_DIR/data/finetune/prepared/train.jsonl"
DATA_DIR="$HOMEAI_DIR/data/finetune/setup-split"
ADAPTER_DIR="$HOMEAI_DIR/models/adapters/setup"
FUSED_DIR="$HOMEAI_DIR/models/homeai-finetuned"
LOG_FILE="$HOMEAI_DIR/logs/setup-finetune.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

mkdir -p "$(dirname "$LOG_FILE")"

log "=== HomeAI Setup 微调开始 ==="
log "HF 模型: $HF_MODEL_PATH"
log "MLX 目标: $MLX_MODEL_PATH"
log "数据: $RAW_DATA"

# 1. 检查 mlx-lm
if ! python3 -c "import mlx_lm" 2>/dev/null; then
  log "安装 mlx-lm ..."
  pip3 install mlx-lm -i https://mirrors.aliyun.com/pypi/simple/ || pip3 install mlx-lm
fi

# 2. 检查 HuggingFace 源模型
if [ ! -d "$HF_MODEL_PATH" ]; then
  log "ERROR HF 模型目录不存在: $HF_MODEL_PATH"
  exit 1
fi
log "HF 模型文件数: $(ls "$HF_MODEL_PATH"/*.safetensors 2>/dev/null | wc -l | tr -d ' ') 个 safetensors"

# 3. 转换为 MLX 4-bit 格式（48GB RAM 无法直接跑 32B fp16，需量化到 ~18GB）
if [ -f "$MLX_MODEL_PATH/config.json" ]; then
  log "MLX 4-bit 模型已存在，跳过转换: $MLX_MODEL_PATH"
else
  # 清理上次失败留下的残留目录
  rm -rf "$MLX_MODEL_PATH"
  log "转换 HF 模型 → MLX 4-bit 格式（预计 30-60 分钟）..."
  mlx_lm.convert \
    --hf-path "$HF_MODEL_PATH" \
    --mlx-path "$MLX_MODEL_PATH" \
    --quantize \
    --q-bits 4 \
    2>&1 | tee -a "$LOG_FILE"
  log "MLX 转换完成: $MLX_MODEL_PATH"
fi

# 4. 检查训练数据
if [ ! -f "$RAW_DATA" ]; then
  log "ERROR 训练数据不存在: $RAW_DATA"
  exit 1
fi
TOTAL=$(wc -l < "$RAW_DATA")
log "原始数据: $TOTAL 条"

# 5. 切分 train / valid（80/20）
log "切分数据集 ..."
mkdir -p "$DATA_DIR"

python3 - <<PYEOF
import json, math

with open("$RAW_DATA") as f:
    lines = [l for l in f if l.strip()]

split = math.floor(len(lines) * 0.8)
train, valid = lines[:split], lines[split:]

with open("$DATA_DIR/train.jsonl", "w") as f:
    f.writelines(train)
with open("$DATA_DIR/valid.jsonl", "w") as f:
    f.writelines(valid)

print(f"train: {len(train)} 条, valid: {len(valid)} 条")
PYEOF

# 6. 释放尽量多的 GPU 内存（避免 Metal OOM → kernel panic）
log "停止所有 Ollama 已加载模型，释放 GPU 内存..."
ollama stop homeai-assistant 2>/dev/null || true
ollama stop qwen3.6 2>/dev/null || true
sleep 5
log "当前空闲内存: $(vm_stat | awk '/Pages free/{print $3*16/1024"MB"}')"

# 7. LoRA 微调 — Coder-32B 4-bit 专用参数
#    32B 4-bit 模型 ~18GB，加上训练开销约需 28-30GB
#    val-batches=0 : 跳过验证（验证阶段会触发额外内存峰值导致 kernel panic）
#    max-seq-length=256 : 减半峰值 activation 内存（数据平均 1758 chars，截断可接受）
#    grad-checkpoint : 用计算换内存（已有）
log "开始 LoRA 微调（Coder-32B 4-bit: batch=1, num-layers=8, seq=256, lr=1e-5, iters=300, val-batches=0, grad-checkpoint）..."
mkdir -p "$ADAPTER_DIR"

mlx_lm.lora \
  --model "$MLX_MODEL_PATH" \
  --train \
  --data "$DATA_DIR" \
  --batch-size 1 \
  --num-layers 8 \
  --learning-rate 1e-5 \
  --iters 300 \
  --val-batches 0 \
  --save-every 100 \
  --max-seq-length 256 \
  --grad-checkpoint \
  --adapter-path "$ADAPTER_DIR" \
  2>&1 | tee -a "$LOG_FILE" || { log "ERROR: LoRA 微调失败"; exit 1; }

if [ ! -f "$ADAPTER_DIR/adapter_config.json" ]; then
  log "ERROR: adapter_config.json 未生成，训练失败"
  exit 1
fi
log "LoRA 微调完成，适配器: $ADAPTER_DIR"

# 8. 融合适配器
log "融合适配器到 Coder-32B 4-bit 模型 ..."
mkdir -p "$FUSED_DIR"

mlx_lm.fuse \
  --model "$MLX_MODEL_PATH" \
  --adapter-path "$ADAPTER_DIR" \
  --save-path "$FUSED_DIR" \
  2>&1 | tee -a "$LOG_FILE"

log "融合完成: $FUSED_DIR"

# 9. 注册到 Ollama
# Method A：极简 Modelfile，不含 SYSTEM（由插件 before_prompt_build 动态注入，避免双重 token 消耗）
# 注意：MLX fuse 产出 safetensors 格式，Ollama 不支持直接导入
# 此处以 qwen3.6（Ollama 已有 GGUF）为 base 建立 homeai-assistant
log "注册 homeai-assistant（基于 qwen3.6，Method A 极简 Modelfile）到 Ollama ..."
cat > /tmp/homeai-setup-modelfile <<EOF
FROM qwen3.6
PARAMETER temperature 0.6
PARAMETER top_p 0.95
PARAMETER top_k 20
PARAMETER num_ctx 8192
PARAMETER stop "<|im_end|>"
PARAMETER stop "<|endoftext|>"
EOF

ollama create homeai-assistant -f /tmp/homeai-setup-modelfile
rm /tmp/homeai-setup-modelfile

log "homeai-assistant 注册完成（qwen3.6 base，Method A）"
log "LoRA adapter 路径: $ADAPTER_DIR"
log "MLX 推理命令: mlx_lm.generate --model $MLX_MODEL_PATH --adapter-path $ADAPTER_DIR --prompt '你好'"
log "=== Setup 微调全部完成 ==="
log "验证命令: ollama run homeai-assistant '你好'"
