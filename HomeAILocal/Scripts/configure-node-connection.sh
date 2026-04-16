#!/bin/bash
# =============================================================================
# HomeAI Node Connection Configuration Script
# =============================================================================
# Configures Mac gateway to accept Windows node connections via Cloudflare Tunnel
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT_NAME="$(basename "${BASH_SOURCE[0]}")"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
GATEWAY_URL="${GATEWAY_URL:-http://localhost:${GATEWAY_PORT}}"
NODE_REGISTRY_DIR="${HOME}/.openclaw/node-registry"
NODE_API_KEY_FILE="${NODE_REGISTRY_DIR}/api-key.txt"
NODE_DB_FILE="${NODE_REGISTRY_DIR}/nodes.json"
LOG_FILE="${HOME}/.openclaw/logs/node-connection.log"

NODES_API_BASE="${GATEWAY_URL}/api/node"

mkdir -p "${NODE_REGISTRY_DIR}" "${HOME}/.openclaw/logs"

log() {
    local level="$1"
    shift
    local timestamp
    timestamp=$(date '+%Y-%m-%d %H:%M:%S')
    echo "[${timestamp}] [${level}] $*" | tee -a "${LOG_FILE}"
}

info() { log "INFO" "$@"; }
warn() { log "WARN" "$@"; }
error() { log "ERROR" "$@"; }

usage() {
    cat <<EOF
Usage: ${SCRIPT_NAME} [OPTIONS] <command>

Commands:
    register <node_name> [--api-key <key>]   Register a new Windows node
    unregister <node_name>                   Remove a node from registry
    list                                     List all registered nodes
    invoke <node_name> <command>             Execute command on remote node
    status [node_name]                       Check node health status
    generate-key                             Generate new API key
    setup-gateway                            Configure gateway for node support
    test-connection <node_name>              Test connectivity to node

Options:
    --gateway-url <url>                      Gateway URL (default: ${GATEWAY_URL})
    --api-key <key>                          API key for node authentication
    --force                                  Force operation (skip confirmations)
    -h, --help                               Show this help message

Examples:
    # Register a new Windows node
    ${SCRIPT_NAME} register windows-pc --api-key abc123
    
    # List all nodes
    ${SCRIPT_NAME} list
    
    # Execute command on remote node
    ${SCRIPT_NAME} invoke windows-pc "Get-Process | Select-Object -First 5"
    
    # Check node status
    ${SCRIPT_NAME} status windows-pc
    
    # Setup gateway for node support
    ${SCRIPT_NAME} setup-gateway
    
    # Generate new API key
    ${SCRIPT_NAME} generate-key

EOF
}

check_dependencies() {
    local missing_deps=()
    
    command -v curl >/dev/null 2>&1 || missing_deps+=("curl")
    command -v jq >/dev/null 2>&1 || missing_deps+=("jq")
    command -v python3 >/dev/null 2>&1 || missing_deps+=("python3")
    
    if [[ ${#missing_deps[@]} -gt 0 ]]; then
        error "Missing dependencies: ${missing_deps[*]}"
        error "Install with: brew install ${missing_deps[*]}"
        exit 1
    fi
}

http_request() {
    local method="$1"
    local endpoint="$2"
    shift 2
    local api_key="${API_KEY:-$(cat "${NODE_API_KEY_FILE}" 2>/dev/null || echo "")}"
    
    local headers=(
        -H "Content-Type: application/json"
        -H "X-Node-ApiKey: ${api_key}"
    )
    
    if [[ -n "${api_key}" ]]; then
        headers+=(-H "Authorization: Bearer ${api_key}")
    fi
    
    case $method in
        GET)
            curl -s -X GET "${headers[@]}" "$@" "${NODES_API_BASE}${endpoint}"
            ;;
        POST)
            curl -s -X POST "${headers[@]}" "$@" "${NODES_API_BASE}${endpoint}"
            ;;
        DELETE)
            curl -s -X DELETE "${headers[@]}" "$@" "${NODES_API_BASE}${endpoint}"
            ;;
        PUT)
            curl -s -X PUT "${headers[@]}" "$@" "${NODES_API_BASE}${endpoint}"
            ;;
    esac
}

generate_api_key() {
    local key_length="${1:-32}"
    python3 -c "import secrets, string; print(secrets.token_urlsafe(${key_length}))"
}

generate_node_key() {
    openssl rand -hex 32
}

cmd_generate_key() {
    info "Generating new API key..."
    local new_key
    new_key=$(generate_api_key)
    echo "${new_key}" > "${NODE_API_KEY_FILE}"
    chmod 600 "${NODE_API_KEY_FILE}"
    info "New API key saved to ${NODE_API_KEY_FILE}"
    echo ""
    echo "IMPORTANT: Share this key securely with your Windows node:"
    echo "${new_key}"
    echo ""
    echo "Add this to your Windows node setup:"
    echo "  -ApiKey '${new_key}'"
}

load_node_db() {
    if [[ -f "${NODE_DB_FILE}" ]]; then
        cat "${NODE_DB_FILE}"
    else
        echo '{"nodes": {}}'
    fi
}

save_node_db() {
    local db="$1"
    echo "${db}" | jq '.' > "${NODE_DB_FILE}" 2>/dev/null || {
        error "Failed to save node database"
        return 1
    }
    chmod 600 "${NODE_DB_FILE}"
}

cmd_register() {
    local node_name="$1"
    local api_key="${API_KEY:-}"
    
    if [[ -z "${api_key}" ]]; then
        if [[ -f "${NODE_API_KEY_FILE}" ]]; then
            api_key=$(cat "${NODE_API_KEY_FILE}")
        else
            api_key=$(generate_api_key)
            echo "${api_key}" > "${NODE_API_KEY_FILE}"
            chmod 600 "${NODE_API_KEY_FILE}"
            info "Generated new API key: ${api_key}"
        fi
    fi
    
    if [[ -z "${node_name}" ]]; then
        error "Node name is required"
        echo "Usage: ${SCRIPT_NAME} register <node_name> [--api-key <key>]"
        exit 1
    fi
    
    info "Registering node: ${node_name}..."
    
    local db
    db=$(load_node_db)
    
    local existing_node
    existing_node=$(echo "${db}" | jq -r ".nodes[\"${node_name}\"] // null")
    
    if [[ "${existing_node}" != "null" ]] && [[ "${FORCE:-}" != "true" ]]; then
        warn "Node '${node_name}' already exists. Use --force to overwrite."
        exit 1
    fi
    
    local node_key
    node_key=$(generate_node_key)
    
    local registration_data
    registration_data=$(jq -n \
        --arg name "${node_name}" \
        --arg key "${node_key}" \
        --arg platform "windows" \
        --arg api_key "${api_key}" \
        --arg created_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{
            name: $name,
            node_key: $key,
            platform: $platform,
            api_key: $api_key,
            created_at: $created_at,
            last_seen: null,
            status: "pending",
            capabilities: ["powershell", "file_transfer", "metrics"]
        }')
    
    db=$(echo "${db}" | jq ".nodes[\"${node_name}\"] = ${registration_data}")
    save_node_db "${db}"
    
    info "Node '${node_name}' registered successfully!"
    echo ""
    echo "Node Configuration:"
    echo "  Node Name:   ${node_name}"
    echo "  Node Key:    ${node_key}"
    echo "  API Key:     ${api_key}"
    echo ""
    echo "On Windows, run:"
    echo "  ./windows-node-setup.ps1 -NodeName '${node_name}' -ApiKey '${api_key}' -GatewayUrl '${GATEWAY_URL}'"
}

cmd_unregister() {
    local node_name="$1"
    
    if [[ -z "${node_name}" ]]; then
        error "Node name is required"
        exit 1
    fi
    
    info "Unregistering node: ${node_name}..."
    
    local db
    db=$(load_node_db)
    
    local existing_node
    existing_node=$(echo "${db}" | jq -r ".nodes[\"${node_name}\"] // null")
    
    if [[ "${existing_node}" == "null" ]]; then
        error "Node '${node_name}' not found"
        exit 1
    fi
    
    if [[ "${FORCE:-}" != "true" ]]; then
        echo "Are you sure you want to unregister node '${node_name}'? [y/N]"
        read -r confirm
        if [[ "${confirm}" != "y" && "${confirm}" != "Y" ]]; then
            info "Cancelled"
            exit 0
        fi
    fi
    
    http_request DELETE "/${node_name}" 2>/dev/null || true
    
    db=$(echo "${db}" | jq "del(.nodes[\"${node_name}\"])")
    save_node_db "${db}"
    
    info "Node '${node_name}' unregistered successfully"
}

cmd_list() {
    local db
    db=$(load_node_db)
    
    local nodes
    nodes=$(echo "${db}" | jq -r '.nodes | keys[]' 2>/dev/null || echo "")
    
    if [[ -z "${nodes}" ]]; then
        info "No nodes registered"
        return 0
    fi
    
    echo ""
    echo "Registered Nodes:"
    echo "================="
    echo ""
    printf "%-20s %-12s %-10s %-20s\n" "NODE NAME" "PLATFORM" "STATUS" "LAST SEEN"
    printf "%-20s %-12s %-10s %-20s\n" "---------" "--------" "------" "---------"
    
    while IFS= read -r node_name; do
        if [[ -n "${node_name}" ]]; then
            local node_info
            node_info=$(echo "${db}" | jq ".nodes[\"${node_name}\"]")
            local platform status last_seen
            platform=$(echo "${node_info}" | jq -r '.platform // "unknown"')
            status=$(echo "${node_info}" | jq -r '.status // "unknown"')
            last_seen=$(echo "${node_info}" | jq -r '.last_seen // "never"')
            
            if [[ "${last_seen}" != "null" && "${last_seen}" != "never" ]]; then
                last_seen=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "${last_seen}" "+%Y-%m-%d %H:%M" 2>/dev/null || echo "${last_seen}")
            fi
            
            printf "%-20s %-12s %-10s %-20s\n" "${node_name}" "${platform}" "${status}" "${last_seen}"
        fi
    done <<< "${nodes}"
    
    echo ""
}

cmd_status() {
    local node_name="${1:-}"
    local api_key="${API_KEY:-$(cat "${NODE_API_KEY_FILE}" 2>/dev/null || echo "")}"
    
    if [[ -n "${node_name}" ]]; then
        check_node_status "${node_name}"
    else
        local db
        db=$(load_node_db)
        local nodes
        nodes=$(echo "${db}" | jq -r '.nodes | keys[]' 2>/dev/null || echo "")
        
        while IFS= read -r n; do
            if [[ -n "${n}" ]]; then
                check_node_status "${n}"
            fi
        done <<< "${nodes}"
    fi
}

check_node_status() {
    local node_name="$1"
    
    echo ""
    echo "Checking status of: ${node_name}"
    echo "--------------------"
    
    local response
    response=$(http_request GET "/${node_name}/status" 2>/dev/null)
    
    if [[ -z "${response}" ]]; then
        echo "  Status: OFFLINE (no response)"
        return 1
    fi
    
    local status online_time
    status=$(echo "${response}" | jq -r '.status // "unknown"')
    online_time=$(echo "${response}" | jq -r '.online_since // "unknown"')
    
    echo "  Status: ${status}"
    echo "  Online Since: ${online_time}"
    
    local metrics
    metrics=$(echo "${response}" | jq -r '.metrics // empty')
    if [[ -n "${metrics}" && "${metrics}" != "null" ]]; then
        echo "  Metrics:"
        echo "${metrics}" | jq -r 'to_entries | .[] | "    \(.key): \(.value)"' 2>/dev/null || true
    fi
}

cmd_invoke() {
    local node_name="$1"
    local command="$2"
    
    if [[ -z "${node_name}" || -z "${command}" ]]; then
        error "Node name and command are required"
        echo "Usage: ${SCRIPT_NAME} invoke <node_name> <command>"
        exit 1
    fi
    
    info "Invoking command on '${node_name}'..."
    info "Command: ${command}"
    
    local db
    db=$(load_node_db)
    local node_info
    node_info=$(echo "${db}" | jq ".nodes[\"${node_name}\"]")
    
    if [[ "${node_info}" == "null" ]]; then
        error "Node '${node_name}' not found"
        exit 1
    fi
    
    local api_key
    api_key=$(echo "${node_info}" | jq -r '.api_key // empty')
    
    if [[ -z "${api_key}" ]]; then
        if [[ -f "${NODE_API_KEY_FILE}" ]]; then
            api_key=$(cat "${NODE_API_KEY_FILE}")
        else
            error "No API key found for node '${node_name}'"
            exit 1
        fi
    fi
    
    local command_id
    command_id="cmd_$(date +%s)_$$"
    
    local payload
    payload=$(jq -n \
        --arg cmd_id "${command_id}" \
        --arg script "${command}" \
        --arg type "powershell" \
        '{
            id: $cmd_id,
            script: $script,
            type: $type,
            created_at: (now | strftime("%Y-%m-%dT%H:%M:%SZ"))
        }')
    
    local response
    response=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "X-Node-ApiKey: ${api_key}" \
        -H "X-Command-Id: ${command_id}" \
        -d "${payload}" \
        "${NODES_API_BASE}/commands/${node_name}" 2>&1)
    
    if [[ $? -ne 0 ]]; then
        error "Failed to send command: ${response}"
        exit 1
    fi
    
    local accepted
    accepted=$(echo "${response}" | jq -r '.accepted // false')
    
    if [[ "${accepted}" == "true" ]]; then
        info "Command sent successfully. ID: ${command_id}"
        echo ""
        echo "Waiting for result..."
        
        local max_wait=60
        local waited=0
        
        while [[ ${waited} -lt ${max_wait} ]]; do
            sleep 2
            waited=$((waited + 2))
            
            local result
            result=$(curl -s -X GET \
                -H "X-Node-ApiKey: ${api_key}" \
                "${NODES_API_BASE}/results/${command_id}" 2>/dev/null)
            
            if [[ -n "${result}" && "${result}" != "null" ]]; then
                echo ""
                info "Result received:"
                echo "${result}" | jq '.'
                return 0
            fi
        done
        
        warn "Timeout waiting for result. Command may still be executing on node."
        info "Check result later with: ${SCRIPT_NAME} result ${command_id}"
    else
        error "Command rejected: $(echo "${response}" | jq -r '.reason // "unknown"')"
        exit 1
    fi
}

cmd_test_connection() {
    local node_name="$1"
    
    if [[ -z "${node_name}" ]]; then
        error "Node name is required"
        exit 1
    fi
    
    info "Testing connection to node: ${node_name}..."
    
    local db
    db=$(load_node_db)
    local node_info
    node_info=$(echo "${db}" | jq ".nodes[\"${node_name}\"]")
    
    if [[ "${node_info}" == "null" ]]; then
        error "Node '${node_name}' not found"
        exit 1
    fi
    
    local api_key
    api_key=$(echo "${node_info}" | jq -r '.api_key // empty')
    
    local test_result
    test_result=$(curl -s -X POST \
        -H "Content-Type: application/json" \
        -H "X-Node-ApiKey: ${api_key}" \
        -H "X-Command-Id: test_$$" \
        -d '{"script": "Write-Output \"Connection OK\"", "type": "powershell"}' \
        "${NODES_API_BASE}/commands/${node_name}" 2>&1)
    
    if [[ $? -eq 0 ]]; then
        info "Connection test successful"
        echo "${test_result}" | jq '.' 2>/dev/null || echo "${test_result}"
    else
        error "Connection test failed: ${test_result}"
        exit 1
    fi
}

cmd_setup_gateway() {
    info "Setting up gateway for node support..."
    
    local plugin_dir="${HOME}/HomeAI/CrewHiveClaw/CrewClaw/crewclaw-routing"
    
    if [[ ! -d "${plugin_dir}" ]]; then
        error "Plugin directory not found: ${plugin_dir}"
        exit 1
    fi
    
    info "Checking for existing node routes..."
    
    local node_routes_file="${plugin_dir}/routes/nodes.ts"
    if [[ ! -f "${node_routes_file}" ]]; then
        info "Creating node routes file..."
        cat > "${node_routes_file}" << 'NODE_ROUTES'
import { Router } from 'express';
import { NodeRegistry } from '../services/node-registry';
import { NodeAuthMiddleware } from '../middleware/node-auth';

const router = Router();
const nodeRegistry = new NodeRegistry();

router.post('/register', async (req, res) => {
    try {
        const { node_name, platform, gateway_url } = req.body;
        const result = await nodeRegistry.register(node_name, { platform, gateway_url });
        res.json({ success: true, node: result });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

router.get('/status/:nodeName', async (req, res) => {
    try {
        const status = await nodeRegistry.getStatus(req.params.nodeName);
        res.json(status);
    } catch (error) {
        res.status(404).json({ error: 'Node not found' });
    }
});

router.post('/commands/:nodeName', async (req, res) => {
    try {
        const command = await nodeRegistry.queueCommand(req.params.nodeName, req.body);
        res.json({ accepted: true, command_id: command.id });
    } catch (error) {
        res.status(500).json({ accepted: false, reason: error.message });
    }
});

router.get('/results/:commandId', async (req, res) => {
    try {
        const result = await nodeRegistry.getResult(req.params.commandId);
        if (result) {
            res.json(result);
        } else {
            res.status(404).json({ error: 'Result not ready' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

router.post('/heartbeat', async (req, res) => {
    try {
        const { node_name, status, metrics } = req.body;
        await nodeRegistry.updateHeartbeat(node_name, { status, metrics });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

export default router;
NODE_ROUTES
        info "Node routes created at ${node_routes_file}"
    fi
    
    info "Gateway node support setup complete!"
    echo ""
    echo "Next steps:"
    echo "1. Restart the gateway: pm2 restart gateway-watchdog"
    echo "2. Register a Windows node: ${SCRIPT_NAME} register <node_name>"
    echo "3. On Windows, run the setup script with the provided credentials"
}

check_gateway_health() {
    local max_attempts="${1:-3}"
    local attempt=1
    
    while [[ ${attempt} -le ${max_attempts} ]]; do
        if curl -s -f "${GATEWAY_URL}/health" > /dev/null 2>&1; then
            return 0
        fi
        warn "Gateway health check failed (attempt ${attempt}/${max_attempts})"
        attempt=$((attempt + 1))
        sleep 2
    done
    
    error "Gateway is not responding at ${GATEWAY_URL}"
    return 1
}

main() {
    check_dependencies
    
    if [[ $# -eq 0 ]]; then
        usage
        exit 0
    fi
    
    API_KEY="${API_KEY:-}"
    FORCE="${FORCE:-}"
    GATEWAY_URL="${GATEWAY_URL:-}"
    
    while [[ $# -gt 0 ]]; do
        case "$1" in
            -h|--help)
                usage
                exit 0
                ;;
            --gateway-url)
                GATEWAY_URL="$2"
                shift 2
                ;;
            --api-key)
                API_KEY="$2"
                shift 2
                ;;
            --force)
                FORCE="true"
                shift
                ;;
            -*)
                error "Unknown option: $1"
                usage
                exit 1
                ;;
            *)
                break
                ;;
        esac
    done
    
    local command="${1:-}"
    shift || true
    
    case "${command}" in
        generate-key)
            cmd_generate_key
            ;;
        register)
            local node_name="${1:-}"
            cmd_register "${node_name}"
            ;;
        unregister)
            local node_name="${1:-}"
            cmd_unregister "${node_name}"
            ;;
        list)
            cmd_list
            ;;
        invoke)
            local node_name="${1:-}"
            local cmd="${2:-}"
            cmd_invoke "${node_name}" "${cmd}"
            ;;
        status)
            local node_name="${1:-}"
            cmd_status "${node_name}"
            ;;
        test-connection)
            local node_name="${1:-}"
            cmd_test_connection "${node_name}"
            ;;
        setup-gateway)
            cmd_setup_gateway
            ;;
        help)
            usage
            ;;
        *)
            error "Unknown command: ${command}"
            usage
            exit 1
            ;;
    esac
}

main "$@"
