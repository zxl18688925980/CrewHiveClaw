#!/bin/bash
# ==============================================================================
# Mac 端配置脚本 - Windows 远程节点 SSH + Cloudflare Tunnel 控制
# ==============================================================================
# 功能：
#   1. 安装 cloudflared (Cloudflare Tunnel 客户端)
#   2. 配置 SSH 密钥对 (用于免密码登录 Windows)
#   3. 创建 SSH config 快捷别名
#   4. 配置节点连接信息
#
# 使用方式:
#   chmod +x setup-mac-config.sh
#   ./setup-mac-config.sh --node-id <节点ID> --tunnel-host <cloudflared-hostname> --ssh-user <windows-user>
#
# 示例:
#   ./setup-mac-config.sh --node-id "xian-aunt" --tunnel-host "xian-aunt.trycloudflare.com" --ssh-user "Aunt"
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPTS_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOMEAI_ROOT="$(cd "$SCRIPTS_ROOT/../.." && pwd)"
NODES_CONFIG_DIR="$HOMEAI_ROOT/Data/nodes"

NODE_ID=""
TUNNEL_HOST=""
SSH_USER=""
SSH_PORT="22"

NODES_CONFIG_FILE="$NODES_CONFIG_DIR/config.json"
SSH_DIR="$HOME/.ssh"
CONFIG_FILE="$SSH_DIR/config"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

usage() {
    cat << EOF
用法: $0 --node-id <节点ID> --tunnel-host <Cloudflare域名> --ssh-user <Windows用户名> [--ssh-port <端口>]

必需参数:
  --node-id       节点标识符 (如 xian-aunt, parents-bedroom)
  --tunnel-host   Cloudflare Tunnel 域名 (如 xxxxx.trycloudflare.com)
  --ssh-user      Windows 用户名

可选参数:
  --ssh-port      SSH 端口 (默认: 22)

示例:
  ./setup-mac-config.sh --node-id "xian-aunt" --tunnel-host "abc123.trycloudflare.com" --ssh-user "Aunt"
EOF
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --node-id)
            NODE_ID="$2"
            shift 2
            ;;
        --tunnel-host)
            TUNNEL_HOST="$2"
            shift 2
            ;;
        --ssh-user)
            SSH_USER="$2"
            shift 2
            ;;
        --ssh-port)
            SSH_PORT="$2"
            shift 2
            ;;
        -h|--help)
            usage
            ;;
        *)
            log_error "未知参数: $1"
            usage
            ;;
    esac
done

if [[ -z "$NODE_ID" ]] || [[ -z "$TUNNEL_HOST" ]] || [[ -z "$SSH_USER" ]]; then
    log_error "缺少必需参数"
    usage
fi

install_cloudflared() {
    log_info "检查 cloudflared..."
    
    if command -v cloudflared &> /dev/null; then
        local version=$(cloudflared --version 2>/dev/null | head -1)
        log_info "cloudflared 已安装: $version"
        return 0
    fi
    
    log_info "安装 cloudflared..."
    
    if [[ "$(uname)" == "Darwin" ]]; then
        if command -v brew &> /dev/null; then
            brew install cloudflared
        else
            log_error "Homebrew 未安装，请先安装: https://brew.sh"
            exit 1
        fi
    else
        curl -L --output /tmp/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
        chmod +x /tmp/cloudflared
        sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
    fi
    
    log_info "cloudflared 安装完成"
}

generate_ssh_key() {
    log_info "检查 SSH 密钥..."
    
    mkdir -p "$SSH_DIR"
    chmod 700 "$SSH_DIR"
    
    if [[ -f "$SSH_DIR/id_ed25519" ]]; then
        log_info "SSH 密钥已存在"
    else
        log_info "生成 SSH 密钥对 (ed25519)..."
        ssh-keygen -t ed25519 -C "homeai-windows-node-$NODE_ID" -f "$SSH_DIR/id_ed25519" -N ""
        log_info "SSH 密钥已生成"
    fi
    
    echo ""
    echo "=========================================="
    echo "  请将以下公钥添加到 Windows 节点:"
    echo "=========================================="
    echo ""
    cat "$SSH_DIR/id_ed25519.pub"
    echo ""
    echo "=========================================="
    echo "  操作步骤:"
    echo "  1. 复制上方公钥内容"
    echo "  2. 在 Windows 上运行:"
    echo "     notepad \\$env:USERPROFILE\\.ssh\\authorized_keys"
    echo "  3. 粘贴公钥并保存"
    echo "=========================================="
    echo ""
}

configure_ssh_config() {
    log_info "配置 SSH config..."
    
    mkdir -p "$SSH_DIR"
    chmod 700 "$SSH_DIR"
    
    if [[ ! -f "$CONFIG_FILE" ]]; then
        touch "$CONFIG_FILE"
        chmod 600 "$CONFIG_FILE"
    fi
    
    if grep -q "Host windows-$NODE_ID" "$CONFIG_FILE" 2>/dev/null; then
        log_warn "节点 $NODE_ID 的 SSH config 已存在，将更新"
        sed -i '' "/# Begin windows-$NODE_ID/,/# End windows-$NODE_ID/d" "$CONFIG_FILE"
    fi
    
    cat >> "$CONFIG_FILE" << EOF

# Begin windows-$NODE_ID
Host windows-$NODE_ID
    HostName $TUNNEL_HOST
    User $SSH_USER
    Port $SSH_PORT
    IdentityFile ~/.ssh/id_ed25519
    StrictHostKeyChecking accept-new
    ServerAliveInterval 60
    ServerAliveCountMax 3
    LogLevel ERROR
# End windows-$NODE_ID

EOF
    
    chmod 600 "$CONFIG_FILE"
    log_info "SSH config 已配置: windows-$NODE_ID"
}

save_node_config() {
    log_info "保存节点配置..."
    
    mkdir -p "$NODES_CONFIG_DIR"
    
    local node_config=$(cat << EOF
{
    "nodeId": "$NODE_ID",
    "tunnelHost": "$TUNNEL_HOST",
    "sshUser": "$SSH_USER",
    "sshPort": $SSH_PORT,
    "sshAlias": "windows-$NODE_ID",
    "createdAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
    "lastModified": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF
)
    
    echo "$node_config" > "$NODES_CONFIG_DIR/$NODE_ID.json"
    
    if [[ -f "$NODES_CONFIG_FILE" ]]; then
        local existing=$(cat "$NODES_CONFIG_FILE")
        local nodes_array=$(echo "$existing" | jq -r '.nodes[] | select(.nodeId == "'"$NODE_ID"'")' 2>/dev/null || echo "")
        
        if [[ -n "$nodes_array" ]]; then
            log_warn "节点 $NODE_ID 已存在，将更新配置"
            local temp=$(mktemp)
            jq ".nodes = [.nodes[] | select(.nodeId != \"$NODE_ID\")] + [$(echo "$node_config" | jq -c '.')]" \
                < "$NODES_CONFIG_FILE" > "$temp" && mv "$temp" "$NODES_CONFIG_FILE"
        else
            jq ".nodes += [$(echo "$node_config" | jq -c '.')]" \
                < "$NODES_CONFIG_FILE" > "$NODES_CONFIG_FILE.tmp" && mv "$NODES_CONFIG_FILE.tmp" "$NODES_CONFIG_FILE"
        fi
    else
        echo "{\"nodes\": [$(echo "$node_config" | jq -c '.')]}" > "$NODES_CONFIG_FILE"
    fi
    
    log_info "节点配置已保存: $NODES_CONFIG_DIR/$NODE_ID.json"
}

test_connection() {
    log_info ""
    log_info "=========================================="
    log_info "  测试 SSH 连接..."
    log_info "=========================================="
    echo ""
    echo "别名: windows-$NODE_ID"
    echo "主机: $TUNNEL_HOST"
    echo "用户: $SSH_USER"
    echo "端口: $SSH_PORT"
    echo ""
    echo "提示: 首次连接需要确认 host key，请在 Windows 节点上确认公钥已添加"
    echo ""
    
    read -p "是否立即测试连接? (y/N): " confirm
    if [[ "$confirm" =~ ^[Yy]$ ]]; then
        log_info "尝试连接..."
        ssh -o ConnectTimeout=10 -o BatchMode=yes "windows-$NODE_ID" "echo '连接成功!'" 2>/dev/null && {
            log_info "连接测试成功!"
        } || {
            log_warn "连接测试失败，请检查:"
            log_warn "1. Windows 节点是否运行了 setup-windows-node.ps1"
            log_warn "2. Cloudflare Tunnel 是否已连接"
            log_warn "3. authorized_keys 是否已配置"
        }
    fi
}

show_summary() {
    echo ""
    echo "=========================================="
    echo -e "  ${GREEN}Mac 端配置完成!${NC}"
    echo "=========================================="
    echo ""
    echo "节点信息:"
    echo "  节点ID: $NODE_ID"
    echo "  别名: windows-$NODE_ID"
    echo "  主机: $TUNNEL_HOST"
    echo "  用户: $SSH_USER"
    echo "  端口: $SSH_PORT"
    echo ""
    echo "使用方式:"
    echo "  ssh windows-$NODE_ID"
    echo "  scp file.txt windows-$NODE_ID:/path/"
    echo ""
    echo "快速命令参考:"
    echo "  ~/.ssh/config           SSH 别名配置"
    echo "  ~/HomeAI/Data/nodes/    节点配置目录"
    echo ""
    echo "=========================================="
    echo "  下一步:"
    echo "  1. 将公钥添加到 Windows (见上方提示)"
    echo "  2. 运行 test-mac-connection.sh 测试"
    echo "  3. 启动 node-monitor 服务"
    echo "=========================================="
}

main() {
    echo "=========================================="
    echo "  Mac 端配置脚本"
    echo "  Windows 远程节点控制"
    echo "  $(date)"
    echo "=========================================="
    
    install_cloudflared
    generate_ssh_key
    configure_ssh_config
    save_node_config
    test_connection
    show_summary
}

main "$@"
