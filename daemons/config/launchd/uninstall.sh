#!/bin/bash
# HomeAI 守护进程 launchd 卸载脚本
# 用法: ./uninstall.sh

set -e

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

echo "=== HomeAI 守护进程 launchd 卸载 ==="

# 停止服务
echo "停止服务..."
launchctl stop ai.homeai.lisa 2>/dev/null || true
launchctl stop ai.homeai.andy 2>/dev/null || true
launchctl stop ai.homeai.daemon 2>/dev/null || true

sleep 1

# 卸载服务
echo "卸载服务..."
launchctl unload "$LAUNCH_AGENTS_DIR/homeai-daemon.plist" 2>/dev/null || true
launchctl unload "$LAUNCH_AGENTS_DIR/andy-daemon.plist" 2>/dev/null || true
launchctl unload "$LAUNCH_AGENTS_DIR/lisa-daemon.plist" 2>/dev/null || true

# 删除配置文件
echo "删除配置文件..."
rm -f "$LAUNCH_AGENTS_DIR/homeai-daemon.plist"
rm -f "$LAUNCH_AGENTS_DIR/andy-daemon.plist"
rm -f "$LAUNCH_AGENTS_DIR/lisa-daemon.plist"

echo "=== 卸载完成 ==="
