#!/bin/bash
# MLX LoRA 增量微调脚本
# 由 finetune-scheduler.js 调用（每周日凌晨 2 点，满足样本/间隔/负载条件后触发）
#
# 关键设计：
#   - 训练参数从 config/machine-profile.json 读取（Setup 阶段业主+Claude Code 共同记录）
#   - 基于 setup 微调产出的 MLX 4-bit 模型持续迭代，不重新转换
#   - 每次从上一次 adapter 继续训练（增量叠加）

set -eo pipefail

HOMEAI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# 统一数据根目录：与插件 PROJECT_ROOT 一致
DATA_ROOT="${HOMEAI_ROOT:-$HOME/HomeAI}"

PROFILE="$HOMEAI_DIR/config/machine-profile.json"
MLX_MODEL_PATH="$DATA_ROOT/Models/mlx/Qwen3.6-35B-A3B-4bit"
SETUP_ADAPTER_DIR="$DATA_ROOT/Models/adapters/setup"
ADAPTERS_BASE="$DATA_ROOT/Models/adapters"
PENDING_FILE="$DATA_ROOT/data/finetune/pending-samples.jsonl"
DATA_SPLIT_DIR="$DATA_ROOT/data/finetune/incremental-split"
LOG_FILE="$DATA_ROOT/Logs/finetune.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

mkdir -p "$(dirname "$LOG_FILE")"
log "=== HomeAI 增量微调开始 ==="

# 1. 读取 machine-profile（训练参数 + 内存管理策略）
if [ ! -f "$PROFILE" ]; then
  log "ERROR config/machine-profile.json 不存在，请先完成 Setup 阶段"
  exit 1
fi

BATCH_SIZE=$(python3 -c "import json; p=json.load(open('$PROFILE')); print(p['mlx_training']['safe_params']['batch_size'])")
NUM_LAYERS=$(python3 -c "import json; p=json.load(open('$PROFILE')); print(p['mlx_training']['safe_params']['num_layers'])")
MAX_SEQ=$(python3 -c "import json; p=json.load(open('$PROFILE')); print(p['mlx_training']['safe_params']['max_seq_length'])")
VAL_BATCHES=$(python3 -c "import json; p=json.load(open('$PROFILE')); print(p['mlx_training']['safe_params']['val_batches'])")
LR=$(python3 -c "import json; p=json.load(open('$PROFILE')); print(p['mlx_training']['safe_params']['learning_rate'])")
ITERS=$(python3 -c "import json; p=json.load(open('$PROFILE')); print(p['mlx_training']['safe_params']['iters_incremental'])")
WAIT_SECS=$(python3 -c "import json; p=json.load(open('$PROFILE')); print(p['mlx_training']['pre_training']['wait_seconds'])")
STOP_MODELS=$(python3 -c "import json; p=json.load(open('$PROFILE')); print('\n'.join(p['mlx_training']['pre_training']['stop_ollama_models']))")

log "machine-profile 读取完成: batch=$BATCH_SIZE, layers=$NUM_LAYERS, seq=$MAX_SEQ, val=$VAL_BATCHES, lr=$LR, iters=$ITERS"

# 2. 检查 mlx_lm
if ! python3 -c "import mlx_lm" 2>/dev/null; then
  log "安装 mlx-lm ..."
  pip3 install mlx-lm -i https://mirrors.aliyun.com/pypi/simple/ || pip3 install mlx-lm
fi

# 3. 检查 MLX 4-bit 模型（由 setup-finetune.sh 生成，不重新转换）
if [ ! -f "$MLX_MODEL_PATH/config.json" ]; then
  log "ERROR MLX 4-bit 模型不存在: $MLX_MODEL_PATH"
  log "请先运行 setup-finetune.sh 完成初始化微调"
  exit 1
fi
log "MLX 4-bit 模型: $MLX_MODEL_PATH"

# 4. 检查训练数据
PENDING_COUNT=$(wc -l < "$PENDING_FILE" 2>/dev/null || echo 0)
if [ "$PENDING_COUNT" -eq 0 ]; then
  log "ERROR 无待训练样本: $PENDING_FILE"
  exit 1
fi
log "待训练样本: $PENDING_COUNT 条"

# 5. 释放 GPU 内存（按 machine-profile 的 pre_training 策略执行）
log "释放 Ollama 已加载模型（按 machine-profile.pre_training 策略）..."
while IFS= read -r model; do
  [ -n "$model" ] && ollama stop "$model" 2>/dev/null || true
done <<< "$STOP_MODELS"
sleep "$WAIT_SECS"
log "当前空闲内存: $(vm_stat | awk '/Pages free/{print $3*16/1024"MB"}')"

# 5. 确定起点 adapter（优先用最新 incremental，fallback 到 setup）
LATEST_ADAPTER=$(ls -d "$ADAPTERS_BASE"/incremental-* 2>/dev/null | sort | tail -1)
if [ -n "$LATEST_ADAPTER" ] && [ -f "$LATEST_ADAPTER/adapter_config.json" ]; then
  BASE_ADAPTER="$LATEST_ADAPTER"
  log "继续上次增量 adapter: $BASE_ADAPTER"
elif [ -f "$SETUP_ADAPTER_DIR/adapter_config.json" ]; then
  BASE_ADAPTER="$SETUP_ADAPTER_DIR"
  log "从 setup adapter 开始增量: $BASE_ADAPTER"
else
  log "ERROR 未找到可用 adapter，请先运行 setup-finetune.sh"
  exit 1
fi

# 6. 创建本次 adapter 目录，复制上次 adapter 作为起点
RUN_DATE=$(date '+%Y%m%d-%H%M%S')
NEW_ADAPTER_DIR="$ADAPTERS_BASE/incremental-$RUN_DATE"
mkdir -p "$NEW_ADAPTER_DIR"
cp "$BASE_ADAPTER"/*.safetensors "$NEW_ADAPTER_DIR/" 2>/dev/null || true
cp "$BASE_ADAPTER/adapter_config.json" "$NEW_ADAPTER_DIR/"
log "本次 adapter 目录: $NEW_ADAPTER_DIR"

# 7. 转换 pending-samples 为 MLX 训练格式（纯 train，不切 valid）
log "准备训练数据 ..."
mkdir -p "$DATA_SPLIT_DIR"

python3 - <<PYEOF
import json, sys

input_file = "$PENDING_FILE"
output_file = "$DATA_SPLIT_DIR/train.jsonl"

converted = []
with open(input_file) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        sample = json.loads(line)
        # pending-samples 格式: {input, output} 或 {messages} 或已是 mlx 格式
        if "messages" in sample:
            converted.append({"text": json.dumps(sample["messages"], ensure_ascii=False)})
        elif "input" in sample and "output" in sample:
            converted.append({"text": f"用户：{sample['input']}\n助手：{sample['output']}"})
        elif "text" in sample:
            converted.append({"text": sample["text"]})
        else:
            converted.append({"text": json.dumps(sample, ensure_ascii=False)})

with open(output_file, "w") as f:
    for item in converted:
        f.write(json.dumps(item, ensure_ascii=False) + "\n")

print(f"转换完成: {len(converted)} 条 -> {output_file}")
PYEOF

# 8. LoRA 增量微调（参数全部来自 machine-profile，原因见 machine-profile.mlx_training.learnings）
GRAD_CHECKPOINT_FLAG=""
GRAD_CHECKPOINT=$(python3 -c "import json; p=json.load(open('$PROFILE')); print(p['mlx_training']['safe_params']['grad_checkpoint'])")
[ "$GRAD_CHECKPOINT" = "True" ] && GRAD_CHECKPOINT_FLAG="--grad-checkpoint"

log "开始 LoRA 增量微调（来自 machine-profile: batch=$BATCH_SIZE, layers=$NUM_LAYERS, seq=$MAX_SEQ, val=$VAL_BATCHES, lr=$LR, iters=$ITERS）..."

mlx_lm.lora \
  --model "$MLX_MODEL_PATH" \
  --train \
  --data "$DATA_SPLIT_DIR" \
  --batch-size "$BATCH_SIZE" \
  --num-layers "$NUM_LAYERS" \
  --learning-rate "$LR" \
  --iters "$ITERS" \
  --val-batches "$VAL_BATCHES" \
  --save-every 100 \
  --max-seq-length "$MAX_SEQ" \
  $GRAD_CHECKPOINT_FLAG \
  --adapter-path "$NEW_ADAPTER_DIR" \
  2>&1 | tee -a "$LOG_FILE" || { log "ERROR: LoRA 微调失败"; exit 1; }

if [ ! -f "$NEW_ADAPTER_DIR/adapter_config.json" ]; then
  log "ERROR adapter_config.json 未生成，训练失败"
  exit 1
fi
log "增量 adapter 已保存: $NEW_ADAPTER_DIR"

# 9. 更新 latest 软链
ln -sfn "$NEW_ADAPTER_DIR" "$ADAPTERS_BASE/latest"
log "latest 软链已更新 -> $NEW_ADAPTER_DIR"

# 10. 清空 pending-samples（已训练）
cp "$PENDING_FILE" "$HOMEAI_DIR/data/finetune/pending-samples-backup-$RUN_DATE.jsonl"
> "$PENDING_FILE"
log "pending-samples 已清空（备份: pending-samples-backup-$RUN_DATE.jsonl）"

# 注意：MLX adapter 格式不兼容 Ollama 直接导入
# homeai-assistant（Ollama）继续使用 qwen2.5-coder:32b base + 系统提示
# LoRA 推理走 mlx_lm.generate --adapter-path 叠加最新 adapter
log "MLX 推理命令: mlx_lm.generate --model $MLX_MODEL_PATH --adapter-path $NEW_ADAPTER_DIR --prompt '...'"

# 11. Fuse adapter → 导出 GGUF → 更新 Ollama homeai-assistant
log "=== 开始 fuse + 导出 GGUF ==="
FUSED_DIR="$ADAPTERS_BASE/fused-$RUN_DATE"
GGUF_FILE="$ADAPTERS_BASE/homeai-assistant-$RUN_DATE.gguf"

python3 -m mlx_lm fuse \
  --model "$MLX_MODEL_PATH" \
  --adapter-path "$NEW_ADAPTER_DIR" \
  --save-path "$FUSED_DIR" \
  --export-gguf \
  --gguf-path "$GGUF_FILE" \
  2>&1 | tee -a "$LOG_FILE" || { log "WARNING: fuse/GGUF 导出失败，MLX adapter 仍可用于 mlx_lm 推理"; exit 0; }

if [ -f "$GGUF_FILE" ]; then
  log "GGUF 导出成功: $GGUF_FILE"

  # 创建 Ollama Modelfile 并更新 homeai-assistant
  # Method A：极简 Modelfile，不含 SYSTEM（由插件 before_prompt_build 动态注入，避免双重 token 消耗）
  MODELFILE_TMP="/tmp/homeai-assistant-modelfile-$RUN_DATE"
  cat > "$MODELFILE_TMP" << MODELEOF
FROM $GGUF_FILE
PARAMETER temperature 0.6
PARAMETER top_p 0.95
PARAMETER top_k 20
PARAMETER num_ctx 8192
PARAMETER stop "<|im_end|>"
PARAMETER stop "<|endoftext|>"
MODELEOF

  # 替换 GGUF 路径
  sed -i '' "s|__GGUF_PATH__|$GGUF_FILE|g" "$MODELFILE_TMP"

  log "更新 Ollama homeai-assistant ..."
  ollama create homeai-assistant -f "$MODELFILE_TMP" 2>&1 | tee -a "$LOG_FILE" || {
    log "WARNING: ollama create 失败，旧版 homeai-assistant 继续运行"
  }

  if ollama list 2>/dev/null | grep -q "homeai-assistant"; then
    log "✅ homeai-assistant 已更新为微调后版本"
  fi
  rm -f "$MODELFILE_TMP"
else
  log "WARNING: GGUF 文件未生成，跳过 Ollama 更新"
fi

log "=== 增量微调完成 ==="
