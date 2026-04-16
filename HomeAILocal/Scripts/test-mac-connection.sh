#!/bin/bash
# ==============================================================================
# Mac 连接测试脚本 - 验证 Windows 远程节点连接
# ==============================================================================
# 功能：
#   1. 验证 SSH 连接 (通过 cloudflared tunnel)
#   2. 测试命令执行
#   3. 测试监控心跳上报
#   4. 测试文件传输
#
# 使用方式:
#   chmod +x test-mac-connection.sh
#   ./test-mac-connection.sh [--node-id <节点ID>] [--monitor-url <url>]
#
# 示例:
#   ./test-mac-connection.sh --node-id "xian-aunt"
# ==============================================================================

set -eo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
HOMEAI_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NODES_CONFIG_DIR="$HOMEAI_ROOT/Data/nodes"

NODE_ID=""
MONITOR_URL="http://localhost:3004"
SSH_ALIAS=""
MONITOR_PORT="3004"

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

log_ok() {
    local name="$1"
    local msg="$2"
    if [[ -n "$msg" ]]; then
        echo -e "${GREEN}[OK]${NC} $name - $msg"
    else
        echo -e "${GREEN}[OK]${NC} $name"
    fi
}

log_fail() {
    local name="$1"
    local msg="$2"
    if [[ -n "$msg" ]]; then
        echo -e "${RED}[FAIL]${NC} $name - $msg"
    else
        echo -e "${RED}[FAIL]${NC} $name"
    fi
}

usage() {
    cat << EOF
用法: $0 --node-id <节点ID> [--monitor-url <url>]

必需参数:
  --node-id       节点标识符 (如 xian-aunt)

可选参数:
  --monitor-url   监控服务端点 (默认: http://localhost:3004)

示例:
  ./test-mac-connection.sh --node-id "xian-aunt"
EOF
    exit 1
}

while [[ $# -gt 0 ]]; do
    case $1 in
        --node-id)
            NODE_ID="$2"
            shift 2
            ;;
        --monitor-url)
            MONITOR_URL="$2"
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

if [[ -z "$NODE_ID" ]]; then
    log_error "缺少 --node-id 参数"
    usage
fi

SSH_ALIAS="windows-$NODE_ID"
MONITOR_PORT=$(echo "$MONITOR_URL" | sed -E 's/.*://g' | sed 's/\/.*//')

load_node_config() {
    local config_file="$NODES_CONFIG_DIR/$NODE_ID.json"
    
    if [[ -f "$config_file" ]]; then
        log_info "加载节点配置: $config_file"
        SSH_ALIAS=$(jq -r '.sshAlias // "windows-'"$NODE_ID"'"' "$config_file")
        log_info "SSH 别名: $SSH_ALIAS"
    else
        log_warn "节点配置文件不存在: $config_file"
        log_info "使用默认 SSH 别名: $SSH_ALIAS"
    fi
}

test_ssh_connection() {
    log_info ""
    log_info "=== SSH 连接测试 ==="
    
    if ! command -v ssh &> /dev/null; then
        log_fail "SSH 客户端" "未安装"
        return 1
    fi
    log_ok "SSH 客户端已安装"
    
    local connected=false
    local output
    local start_time=$(date +%s)
    
    log_info "尝试连接 $SSH_ALIAS..."
    
    output=$(ssh -o ConnectTimeout=10 \
               -o BatchMode=yes \
               -o StrictHostKeyChecking=accept-new \
               "$SSH_ALIAS" \
               "hostname && whoami && echo 'SSH_CONNECTION_OK'" 2>&1) && {
        connected=true
    } || {
        connected=false
        output="$output"
    }
    
    local elapsed=$(($(date +%s) - start_time))
    
    if $connected; then
        log_ok "SSH 连接成功" "(耗时: ${elapsed}s)"
        echo "    $output" | head -5 | sed 's/^/    /'
        return 0
    else
        log_fail "SSH 连接失败" "$output"
        return 1
    fi
}

test_command_execution() {
    log_info ""
    log_info "=== 命令执行测试 ==="
    
    local commands=(
        "hostname"
        "whoami"
        "date '+%Y-%m-%d %H:%M:%S'"
        "uname -a"
        "echo '测试中文'"
    )
    
    local all_passed=true
    
    for cmd in "${commands[@]}"; do
        log_info "执行: $cmd"
        
        local result
        local success=false
        
        if result=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_ALIAS" "$cmd" 2>&1); then
            success=true
            log_ok "$cmd" "$result"
        else
            success=false
            log_fail "$cmd" "$result"
            all_passed=false
        fi
    done
    
    $all_passed
}

test_powershell_execution() {
    log_info ""
    log_info "=== PowerShell 命令测试 ==="
    
    local ps_cmd='Write-Output "PowerShell test" | ConvertTo-Json -Compress'
    
    log_info "执行: $ps_cmd"
    
    local result
    if result=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_ALIAS" "powershell -NoProfile -Command '$ps_cmd'" 2>&1); then
        log_ok "PowerShell" "$result"
        return 0
    else
        log_fail "PowerShell" "$result"
        return 1
    fi
}

test_file_transfer() {
    log_info ""
    log_info "=== 文件传输测试 ==="
    
    local test_file="/tmp/test-upload-$(date +%s).txt"
    local remote_path="C:\\Users\\$NODE_ID\\test-upload.txt"
    local test_content="HomeAI Node Transfer Test - $(date)"
    
    echo "$test_content" > "$test_file"
    
    if scp -o ConnectTimeout=10 -o BatchMode=yes "$test_file" "$SSH_ALIAS:/tmp/test-upload.txt" 2>&1; then
        log_ok "文件上传" "成功"
    else
        log_fail "文件上传" "失败"
        rm -f "$test_file"
        return 1
    fi
    
    rm -f "$test_file"
    
    local downloaded="/tmp/test-download-$(date +%s).txt"
    if scp -o ConnectTimeout=10 -o BatchMode=yes "$SSH_ALIAS:/tmp/test-upload.txt" "$downloaded" 2>&1; then
        log_ok "文件下载" "成功"
    else
        log_fail "文件下载" "失败"
        return 1
    fi
    
    rm -f "$downloaded" /tmp/test-upload.txt
    
    return 0
}

test_heartbeat() {
    log_info ""
    log_info "=== 监控心跳测试 ==="
    
    local hostname_val=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_ALIAS" "hostname" 2>/dev/null | tr -d '\r\n')
    local username_val=$(ssh -o ConnectTimeout=10 -o BatchMode=yes "$SSH_ALIAS" "echo %username%" 2>/dev/null | tr -d '\r\n')
    
    local payload=$(cat << EOF
{
    "nodeId": "$hostname_val",
    "hostname": "$hostname_val",
    "username": "$username_val",
    "os": "Windows",
    "timestamp": $(date +%s)
}
EOF
)
    
    log_info "发送心跳到 $MONITOR_URL..."
    
    local response
    local http_code
    
    if response=$(curl -s -w "\n%{http_code}" -X POST \
        -H "Content-Type: application/json" \
        -d "$payload" \
        "$MONITOR_URL/api/nodes/heartbeat" 2>&1); then
        
        http_code=$(echo "$response" | tail -1)
        
        if [[ "$http_code" == "200" ]]; then
            log_ok "心跳上报" "HTTP $http_code"
            return 0
        else
            log_warn "心跳上报" "HTTP $http_code (监控服务可能未启动)"
            return 0
        fi
    else
        log_warn "心跳上报" "监控服务不可达 (这是正常的如果监控服务未启动)"
        return 0
    fi
}

test_monitor_api() {
    log_info ""
    log_info "=== 监控 API 测试 ==="
    
    if ! command -v curl &> /dev/null; then
        log_warn "curl 未安装，跳过 API 测试"
        return 0
    fi
    
    log_info "获取节点列表..."
    
    local response
    if response=$(curl -s -X GET "$MONITOR_URL/api/nodes" 2>&1); then
        log_ok "GET /api/nodes" "$response"
    else
        log_warn "GET /api/nodes" "请求失败 (监控服务可能未启动)"
    fi
    
    return 0
}

show_summary() {
    log_info ""
    log_info "=========================================="
    log_info "  测试完成"
    log_info "=========================================="
    log_info ""
    log_info "节点: $NODE_ID"
    log_info "SSH 别名: $SSH_ALIAS"
    log_info "监控服务: $MONITOR_URL"
    log_info ""
    log_info "常用命令:"
    log_info "  ssh $SSH_ALIAS"
    log_info "  scp file.txt $SSH_ALIAS:/path/"
    log_info "  ssh $SSH_ALIAS 'powershell -Command \"...\"'"
    log_info ""
}

main() {
    echo "=========================================="
    echo "  Mac 连接测试脚本"
    echo "  节点: $NODE_ID"
    echo "  $(date)"
    echo "=========================================="
    
    load_node_config
    
    local results=()
    
    test_ssh_connection && results+=("SSH:OK") || results+=("SSH:FAIL")
    test_command_execution && results+=("CMD:OK") || results+=("CMD:FAIL")
    test_powershell_execution && results+=("PS:OK") || results+=("PS:FAIL")
    test_file_transfer && results+=("FTP:OK") || results+=("FTP:FAIL")
    test_heartbeat && results+=("HB:OK") || results+=("HB:FAIL")
    test_monitor_api && results+=("API:OK") || results+=("API:FAIL")
    
    echo ""
    echo "=========================================="
    echo "  结果汇总"
    echo "=========================================="
    
    local all_ok=true
    for r in "${results[@]}"; do
        local status="${r#*:}"
        local name="${r%:*}"
        if [[ "$status" == "OK" ]]; then
            echo -e "  ${GREEN}[OK]${NC} $name"
        else
            echo -e "  ${RED}[FAIL]${NC} $name"
            all_ok=false
        fi
    done
    
    echo ""
    if $all_ok; then
        echo -e "${GREEN}所有测试通过!${NC}"
    else
        echo -e "${YELLOW}部分测试失败，请检查上方输出${NC}"
    fi
    
    show_summary
    
    exit 0
}

main "$@"
