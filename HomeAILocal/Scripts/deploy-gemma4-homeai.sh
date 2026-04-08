#!/bin/bash
# Gemma 4 LoRA 微调后部署：融合 → GGUF → Ollama homeai-assistant
# 用法: bash scripts/deploy-gemma4-homeai.sh

set -e

HOMEAI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PYTHON="/opt/homebrew/opt/python@3.11/bin/python3.11"
MLX_MODEL="$HOMEAI_DIR/models/mlx/gemma-4-31B-4bit"
ADAPTER_DIR="$HOMEAI_DIR/models/adapters/gemma4-lucas"
FUSED_DIR="$HOMEAI_DIR/models/mlx/gemma-4-31B-lucas-fused"
GGUF_PATH="$HOMEAI_DIR/models/gguf/homeai-assistant-gemma4.gguf"
MODELFILE="$HOMEAI_DIR/models/Modelfile-gemma4-homeai"
LOG_FILE="$HOMEAI_DIR/logs/deploy-gemma4.log"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

mkdir -p "$(dirname "$GGUF_PATH")"

# ── 步骤 1：融合 LoRA adapter ─────────────────────────────
log "=== Step 1: 融合 LoRA adapter ==="
log "基础模型: $MLX_MODEL"
log "Adapter:  $ADAPTER_DIR"
log "输出:     $FUSED_DIR"

$PYTHON -m mlx_lm fuse \
    --model "$MLX_MODEL" \
    --adapter-path "$ADAPTER_DIR" \
    --save-path "$FUSED_DIR"

log "融合完成，大小: $(du -sh "$FUSED_DIR" | cut -f1)"

# ── 步骤 2：转换为 GGUF ───────────────────────────────────
log "=== Step 2: 转换 MLX → GGUF ==="

# 检查 llama.cpp convert 脚本
LLAMACPP_CONVERT=""
for p in \
    "$HOMEAI_DIR/tools/llama.cpp/convert_hf_to_gguf.py" \
    "/opt/homebrew/share/llama.cpp/convert_hf_to_gguf.py" \
    "$HOME/llama.cpp/convert_hf_to_gguf.py"; do
    [ -f "$p" ] && LLAMACPP_CONVERT="$p" && break
done

if [ -z "$LLAMACPP_CONVERT" ]; then
    log "未找到 llama.cpp convert 脚本，跳过 GGUF 转换"
    log "如需 GGUF，请先: git clone https://github.com/ggerganov/llama.cpp $HOMEAI_DIR/tools/llama.cpp"
    SKIP_GGUF=1
else
    log "使用: $LLAMACPP_CONVERT"
    F16_PATH="${GGUF_PATH%.gguf}-f16.gguf"
    $PYTHON "$LLAMACPP_CONVERT" "$FUSED_DIR" \
        --outfile "$F16_PATH" \
        --outtype f16
    log "F16 转换完成: $F16_PATH ($(du -sh "$F16_PATH" | cut -f1))"
    log "量化为 q4_k_m..."
    llama-quantize "$F16_PATH" "$GGUF_PATH" q4_k_m
    rm -f "$F16_PATH"
    log "GGUF 量化完成: $GGUF_PATH ($(du -sh "$GGUF_PATH" | cut -f1))"
fi

# ── 步骤 3：导入 Ollama ───────────────────────────────────
log "=== Step 3: 导入 Ollama ==="

if [ -n "$SKIP_GGUF" ]; then
    log "GGUF 未生成，跳过 Ollama 导入"
    log "微调后模型可直接用 mlx_lm 推理:"
    log "  mlx_lm.generate --model $FUSED_DIR --prompt '你好'"
else
    cat > "$MODELFILE" <<MODELFILE_CONTENT
FROM $GGUF_PATH

PARAMETER temperature 0.8
PARAMETER top_p 0.9
PARAMETER top_k 40
PARAMETER num_ctx 32768
PARAMETER num_predict 2048

SYSTEM """
你是 Lucas（启灵），曾家的家庭智能助手，性格温暖、靠谱、有趣。
你帮助家庭成员（爸爸曾小龙、妈妈张璐、小姨肖山、姐姐曾钥语桐）处理日常需求。
回复简洁自然，像家人一样沟通，不用太正式。
"""
MODELFILE_CONTENT

    log "Modelfile: $MODELFILE"
    ollama create homeai-assistant -f "$MODELFILE"
    log "=== 部署完成：homeai-assistant 已更新为 Gemma 4 微调版 ==="
    ollama list | grep homeai-assistant
fi
