#!/bin/bash
# HomeAI 守护进程 launchd 安装脚本
# 位置: homeai/config/launchd/install.sh
# 用法: cd homeai && node package.json start

set -e

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CONFIG_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"

echo "=== HomeAI 守护进程 launchd 安装 ==="
echo "项目根目录: $PROJECT_ROOT"
echo "配置目录: $CONFIG_DIR"
echo "目标目录: $LAUNCH_AGENTS_DIR"
echo ""

# 创建 LaunchAgents 目录
mkdir -p "$LAUNCH_AGENTS_DIR"

# 安装服务配置
install_service() {
    local service_name=$1
    local plist_file="$CONFIG_DIR/${service_name}.plist"
    local target="$LAUNCH_AGENTS_DIR/${service_name}.plist"

    if [ -f "$plist_file" ]; then
        echo "安装 $service_name..."
        cp "$plist_file" "$target"
        chmod 644 "$target"
        echo "  ✓ $target"
    else
        echo "  ✗ $plist_file 不存在"
    fi
}

# 安装三个守护进程
install_service "homeai-daemon"
install_service "andy-daemon"
install_service "lisa-daemon"

echo ""
echo "=== 启动服务 ==="

# 启动服务
launchctl load "$LAUNCH_AGENTS_DIR/homeai-daemon.plist" 2>/dev/null || true
launchctl load "$LAUNCH_AGENTS_DIR/andy-daemon.plist" 2>/dev/null || true
launchctl load "$LAUNCH_AGENTS_DIR/lisa-daemon.plist" 2>/dev/null || true

# 启动
launchctl start ai.homeai.daemon 2>/dev/null || echo "  ! HomeAI 启动中..."
sleep 2
launchctl start ai.homeai.andy 2>/dev/null || echo "  ! Andy 启动中..."
sleep 1
launchctl start ai.homeai.lisa 2>/dev/null || echo "  ! Lisa 启动中..."

echo ""
echo "=== 验证服务状态 ==="
sleep 2
lsof -i :3000 -i :3001 -i :3002 || echo "端口检查..."

echo ""
echo "=== 安装完成 ==="
echo "PM2 启动: cd $PROJECT_ROOT/homeai && npm run pm2:start"
echo "查看日志: tail -f $PROJECT_ROOT/logs/homeai-daemon.stdout.log"
echo "停止服务: $CONFIG_DIR/uninstall.sh"
