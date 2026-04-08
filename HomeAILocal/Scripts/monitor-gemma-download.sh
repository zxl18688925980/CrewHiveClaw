#!/bin/bash
# 监控 Gemma 4 下载进度，每 30 分钟检查一次，异常自动重启
# 用法: nohup bash scripts/monitor-gemma-download.sh >> logs/monitor-gemma.log 2>&1 &

HOMEAI_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MODEL_DIR="$HOMEAI_DIR/models/huggingface/google/gemma-4-31B"
DOWNLOAD_SCRIPT="$HOMEAI_DIR/scripts/download-gemma.sh"
LOG_FILE="$HOMEAI_DIR/logs/monitor-gemma.log"
INTERVAL=1800  # 30 分钟
STALL_THRESHOLD_MB=50  # 30 分钟内增长低于此值视为停滞

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $1" | tee -a "$LOG_FILE"; }

get_size_mb() {
    du -sm "$MODEL_DIR/.cache" 2>/dev/null | awk '{print $1}'
}

is_download_running() {
    pgrep -f "download-gemma.sh" > /dev/null 2>&1
}

restart_download() {
    log "重启下载进程..."
    pkill -f "download-gemma.sh" 2>/dev/null
    pkill -f "snapshot_download" 2>/dev/null
    sleep 3
    nohup bash "$DOWNLOAD_SCRIPT" >> "$HOMEAI_DIR/logs/download-gemma.log" 2>&1 &
    log "已重启，新 PID: $!"
}

log "=== 监控启动 ==="
log "监控目录: $MODEL_DIR"
log "检查间隔: ${INTERVAL}s"

LAST_SIZE=$(get_size_mb)
log "初始大小: ${LAST_SIZE}MB"

while true; do
    sleep $INTERVAL

    CURRENT_SIZE=$(get_size_mb)
    GROWTH=$((CURRENT_SIZE - LAST_SIZE))
    log "当前大小: ${CURRENT_SIZE}MB，本轮增长: ${GROWTH}MB"

    # 检查是否已完成（.incomplete 文件消失）
    INCOMPLETE_COUNT=$(ls "$MODEL_DIR/.cache/huggingface/download/"*.incomplete 2>/dev/null | wc -l | tr -d ' ')
    if [ "$INCOMPLETE_COUNT" -eq 0 ] && [ "$CURRENT_SIZE" -gt 50000 ]; then
        log "下载已完成！总大小: ${CURRENT_SIZE}MB"
        log "=== 监控结束 ==="
        exit 0
    fi

    # 检查进程是否存活
    if ! is_download_running; then
        log "下载进程不存在，重启..."
        restart_download
        LAST_SIZE=$(get_size_mb)
        continue
    fi

    # 检查是否停滞
    if [ "$GROWTH" -lt "$STALL_THRESHOLD_MB" ]; then
        log "增长 ${GROWTH}MB < 阈值 ${STALL_THRESHOLD_MB}MB，判定为停滞，重启..."
        restart_download
    else
        log "下载正常。"
    fi

    LAST_SIZE=$CURRENT_SIZE
done
