#!/bin/bash
# check-plugin.sh — 修改 index.ts 后、重启 Gateway 前必须先跑这个
#
# 用法：
#   bash ~/HomeAI/scripts/check-plugin.sh
#   exit 0 = 编译通过，可以重启
#   exit 1 = 有语法/parse 错误，禁止重启

PLUGIN="$HOME/HomeAI/CrewHiveClaw/CrewClaw/crewclaw-routing/index.ts"

echo "检查插件编译..."
output=$(node --experimental-strip-types --check "$PLUGIN" 2>&1)
code=$?

if [ $code -eq 0 ]; then
  echo "OK: 编译通过，可以重启 Gateway"
else
  echo "FAIL: 编译失败，禁止重启 Gateway"
  echo ""
  echo "$output"
fi

exit $code
