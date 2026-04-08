#!/bin/bash
#
# HomeAI 部署脚本
# 将 qwen2.5-coder:14b 训练并部署为 homeai-assistant
#

set -e

echo "========================================"
echo "HomeAI 训练与部署脚本"
echo "========================================"
echo ""

# 配置
MODEL_BASE="qwen2.5-coder:14b"
MODEL_NAME="homeai-assistant"
MODELFILE_PATH="/Users/xinbinanshan/HomeAI/models/Modelfile-homeai"

# 步骤1: 检查模型是否存在
echo "[1/3] 检查基础模型..."
if ollama list | grep -q "$MODEL_BASE"; then
    echo "✅ 基础模型 $MODEL_BASE 已安装"
else
    echo "❌ 基础模型 $MODEL_BASE 未安装，正在安装..."
    ollama pull $MODEL_BASE
fi
echo ""

# 步骤2: 检查 Modelfile
echo "[2/3] 检查 Modelfile..."
if [ -f "$MODELFILE_PATH" ]; then
    echo "✅ Modelfile 存在: $MODELFILE_PATH"
else
    echo "❌ Modelfile 不存在: $MODELFILE_PATH"
    exit 1
fi
echo ""

# 步骤3: 创建模型
echo "[3/3] 创建模型 $MODEL_NAME..."
ollama create $MODEL_NAME -f "$MODELFILE_PATH"

echo ""
echo "========================================"
echo "✅ 部署完成!"
echo "========================================"
echo ""
echo "测试模型:"
echo "  ollama run $MODEL_NAME"
echo ""
echo "API 调用:"
echo "  curl http://localhost:11434/api/generate -d '{\"model\": \"$MODEL_NAME\", \"prompt\": \"你好\"}'"
echo ""
