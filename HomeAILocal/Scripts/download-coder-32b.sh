#!/bin/bash
# 下载 Qwen2.5-Coder-32B-Instruct（关闭梯子后执行）
# 用法：bash scripts/download-coder-32b.sh

set -e

TARGET_DIR="/Users/xinbinanshan/HomeAI/models/huggingface/Qwen/Qwen2.5-Coder-32B-Instruct"

echo "[$(date '+%H:%M:%S')] 开始下载 Qwen2.5-Coder-32B-Instruct"
echo "目标路径: $TARGET_DIR"
echo "源: modelscope.cn（国内直连）"
echo ""

# config 文件已存在，直接下载模型权重
modelscope download \
  --model Qwen/Qwen2.5-Coder-32B-Instruct \
  --local_dir "$TARGET_DIR"

echo ""
echo "[$(date '+%H:%M:%S')] 下载完成: $TARGET_DIR"
echo "文件列表:"
ls "$TARGET_DIR"
