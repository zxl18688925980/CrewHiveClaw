#!/bin/bash
#
# HomeAI 启动脚本
# 由 launchd 调用：开机自启（com.homeai.startup）+ 每 30 秒健康巡检（com.homeai.launcher）
# 设计原则：幂等——已在线则跳过，未在线则启动

# launchd 不继承 shell PATH，必须显式设置
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

HOMEAI_ROOT="/Users/xinbinanshan/HomeAI"
PM2="/opt/homebrew/bin/pm2"
ECOSYSTEM="$HOMEAI_ROOT/CrewHiveClaw/CrewClaw/daemons/ecosystem.config.js"
LOG="$HOMEAI_ROOT/Logs/startup.log"
CHROMA_PORT=8001

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"
}

# ── 检查两个服务是否都正常 ──────────────────────────────────────────────────
WECOM_OK=false
CHROMA_OK=false

"$PM2" list 2>/dev/null | grep -q "wecom-entrance.*online" && WECOM_OK=true
curl -sf "http://localhost:${CHROMA_PORT}/api/v2/heartbeat" > /dev/null 2>&1 && CHROMA_OK=true

if [ "$WECOM_OK" = "true" ] && [ "$CHROMA_OK" = "true" ]; then
  # 两个服务都正常运行中，静默退出（避免 30 秒巡检刷日志）
  exit 0
fi

log "=== start-homeai.sh 触发 ==="

# 确保 PM2 log 目录存在
mkdir -p "$HOMEAI_ROOT/CrewHiveClaw/CrewClaw/daemons/logs/pm2"

# ── 启动/恢复 ChromaDB ─────────────────────────────────────────────────────
if [ "$CHROMA_OK" = "false" ]; then
  log "ChromaDB 不在线，尝试通过 PM2 启动..."
  cd "$HOMEAI_ROOT/CrewHiveClaw/CrewClaw/daemons" && "$PM2" start "$ECOSYSTEM" --only chromadb >> "$LOG" 2>&1
  sleep 5
  if curl -sf "http://localhost:${CHROMA_PORT}/api/v2/heartbeat" > /dev/null 2>&1; then
    log "ChromaDB 启动成功"
    CHROMA_OK=true
  else
    log "WARNING: ChromaDB 启动后仍无响应，请检查 PM2 日志"
    "$PM2" logs chromadb --lines 20 --nostream >> "$LOG" 2>&1
  fi
fi

# ── 启动/恢复 wecom-entrance ───────────────────────────────────────────────
if [ "$WECOM_OK" = "false" ]; then
  log "wecom-entrance 不在线，尝试启动..."
  cd "$HOMEAI_ROOT/CrewHiveClaw/CrewClaw/daemons" && "$PM2" start "$ECOSYSTEM" >> "$LOG" 2>&1
  if "$PM2" list 2>/dev/null | grep -q "wecom-entrance.*online"; then
    log "wecom-entrance 启动成功"
  else
    log "WARNING: wecom-entrance 启动后仍未 online，请检查 PM2 日志"
    "$PM2" list >> "$LOG" 2>&1
  fi
fi
