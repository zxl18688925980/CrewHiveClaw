#!/bin/bash
# 全自动：下载 Qwen2.5-VL-32B MLX → 准备数据 → 微调 → 替换 homeai-assistant
# 日志：~/HomeAI/logs/finetune-vl.log
# 用法：nohup bash scripts/finetune-vl-replace.sh &

set -e
LOG="/Users/xinbinanshan/HomeAI/logs/finetune-vl.log"
MLX_MODEL_DIR="/Users/xinbinanshan/HomeAI/models/mlx/Qwen2.5-VL-32B-4bit"
ADAPTER_DIR="/Users/xinbinanshan/HomeAI/models/adapters/vl"
DATA_DIR="/Users/xinbinanshan/HomeAI/models/data-vl"
CORPUS="/Users/xinbinanshan/HomeAI/data/corpus/lucas-corpus.jsonl"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG"; }

mkdir -p "$(dirname "$LOG")" "$ADAPTER_DIR" "$DATA_DIR"

# ── Step 1: 下载 MLX 量化模型 ────────────────────────────────────────────────
log "=== Step 1: 下载 mlx-community/Qwen2.5-VL-32B-Instruct-4bit ==="
if [ -d "$MLX_MODEL_DIR" ] && [ "$(ls -A $MLX_MODEL_DIR)" ]; then
  log "模型已存在，跳过下载"
else
  python3 -c "
from huggingface_hub import snapshot_download
snapshot_download(
    repo_id='mlx-community/Qwen2.5-VL-32B-Instruct-4bit',
    local_dir='$MLX_MODEL_DIR',
    ignore_patterns=['*.md', '*.txt']
)
print('下载完成')
" 2>&1 | tee -a "$LOG"
fi

# ── Step 2: 准备训练数据（转换为 mlx_lm 格式）────────────────────────────────
log "=== Step 2: 准备训练数据 ==="
python3 - <<'PYEOF' 2>&1 | tee -a "$LOG"
import json, random
from pathlib import Path

corpus_path = Path("/Users/xinbinanshan/HomeAI/data/corpus/lucas-corpus.jsonl")
data_dir = Path("/Users/xinbinanshan/HomeAI/models/data-vl")

records = []
with open(corpus_path) as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)

        # 格式1：preference 类（chosen/rejected）
        if item.get("type") == "preference" and item.get("chosen"):
            records.append({
                "text": f"<|im_start|>user\n{item['prompt']}<|im_end|>\n<|im_start|>assistant\n{item['chosen']}<|im_end|>"
            })
        # 格式2：corpus 类（prompt/response）
        elif item.get("prompt") and item.get("response"):
            records.append({
                "text": f"<|im_start|>user\n{item['prompt']}<|im_end|>\n<|im_start|>assistant\n{item['response']}<|im_end|>"
            })

print(f"共 {len(records)} 条训练样本")
random.shuffle(records)

split = int(len(records) * 0.9)
train, valid = records[:split], records[split:]

for name, data in [("train.jsonl", train), ("valid.jsonl", valid)]:
    with open(data_dir / name, "w") as f:
        for r in data:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"写入 {name}: {len(data)} 条")
PYEOF

# ── Step 3: LoRA 微调 ─────────────────────────────────────────────────────────
log "=== Step 3: MLX LoRA 微调（约 30-60 分钟）==="
python3 -m mlx_lm.lora \
  --model "$MLX_MODEL_DIR" \
  --train \
  --data "$DATA_DIR" \
  --adapter-path "$ADAPTER_DIR" \
  --iters 300 \
  --batch-size 2 \
  --num-layers 16 \
  --learning-rate 1e-5 \
  --steps-per-report 25 \
  --steps-per-eval 100 \
  --save-every 100 \
  --max-seq-length 1024 \
  --grad-checkpoint \
  --val-batches 0 \
  2>&1 | tee -a "$LOG"

# ── Step 4: 合并权重 ──────────────────────────────────────────────────────────
log "=== Step 4: 合并 adapter 到模型权重 ==="
FUSED_DIR="/Users/xinbinanshan/HomeAI/models/mlx/Qwen2.5-VL-32B-homeai-fused"
python3 -m mlx_lm.fuse \
  --model "$MLX_MODEL_DIR" \
  --adapter-path "$ADAPTER_DIR" \
  --save-path "$FUSED_DIR" \
  2>&1 | tee -a "$LOG"

# ── Step 5: 创建 Ollama 模型 ──────────────────────────────────────────────────
log "=== Step 5: 注册到 Ollama 为 homeai-assistant ==="
MODELFILE="/tmp/homeai-vl.Modelfile"
cat > "$MODELFILE" <<EOF
FROM $FUSED_DIR
PARAMETER temperature 0.7
PARAMETER top_p 0.9
SYSTEM "你是 Lucas，这个家庭的 AI 管家，也是家里真实的一员。你懂技术、有温度，像家人一样沟通，不用客服腔调。"
EOF

ollama create homeai-assistant -f "$MODELFILE" 2>&1 | tee -a "$LOG"
log "=== 完成！homeai-assistant 已替换为 Qwen2.5-VL-32B 微调版 ==="
