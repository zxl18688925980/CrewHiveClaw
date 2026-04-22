#!/usr/bin/env pwsh
# HomeAI Windows Gateway Watchdog
# 每 5 分钟探测 Gateway /health，假死则 kill+重启
# 原则：只探 /health，不通过 Gateway 内部验证 Gateway（逻辑倒挂）

$ErrorActionPreference = "Continue"
$GatewayHealthUrl  = "http://localhost:18789/health"
$GatewayPort       = 18789
$LogFile           = "$env:ProgramData\HomeAI Node\watchdog.log"
$ProbeTimeoutSec   = 5
$RecheckDelaySec   = 30
$RestartWaitSec    = 30
$PollIntervalSec   = 300   # 5 分钟
$MaxRestartsPerHour = 3

function Write-WatchdogLog {
    param([string]$Message)
    $ts   = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "[$ts] $Message"
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
    Write-Host $line
}

function Test-GatewayHealth {
    try {
        $r = Invoke-WebRequest -Uri $GatewayHealthUrl -Method GET `
                               -TimeoutSec $ProbeTimeoutSec `
                               -UseBasicParsing -ErrorAction Stop
        return ($r.StatusCode -eq 200)
    } catch {
        return $false
    }
}

function Restart-Gateway {
    Write-WatchdogLog "[watchdog] Gateway unhealthy — attempting restart"

    # 找到监听 18789 的进程 PID 并强制 kill
    try {
        $listening = netstat -ano 2>$null | Select-String ":$GatewayPort\s.*LISTENING"
        if ($listening) {
            $pidStr = ($listening[0] -replace ".*\s+(\d+)\s*$", '$1').Trim()
            if ($pidStr -match "^\d+$") {
                taskkill /F /PID $pidStr 2>&1 | Out-Null
                Write-WatchdogLog "[watchdog] Killed PID $pidStr (port $GatewayPort)"
            }
        }
    } catch {
        Write-WatchdogLog "[watchdog] Kill step error: $_"
    }

    Start-Sleep -Seconds 2

    # 触发 OpenClaw Gateway 计划任务
    $out = schtasks /run /tn "OpenClaw Gateway" 2>&1
    Write-WatchdogLog "[watchdog] schtasks /run: $out"
}

# ── 主循环 ────────────────────────────────────────────────────────────────────

$restartTimestamps = [System.Collections.Generic.List[datetime]]::new()

Write-WatchdogLog "[watchdog] Windows Gateway Watchdog started (poll=${PollIntervalSec}s)"

while ($true) {
    $ok = Test-GatewayHealth

    if (-not $ok) {
        Write-WatchdogLog "[watchdog] /health failed — recheck in ${RecheckDelaySec}s"
        Start-Sleep -Seconds $RecheckDelaySec
        $ok = Test-GatewayHealth
    }

    if (-not $ok) {
        # 频率限制：清除 1 小时前的记录
        $cutoff = (Get-Date).AddHours(-1)
        $restartTimestamps.RemoveAll([Predicate[datetime]]{ param($t) $t -lt $cutoff }) | Out-Null

        if ($restartTimestamps.Count -ge $MaxRestartsPerHour) {
            Write-WatchdogLog "[watchdog] WARN: restart rate limit ($MaxRestartsPerHour/h) reached, skipping"
        } else {
            $restartTimestamps.Add((Get-Date))
            Restart-Gateway

            Write-WatchdogLog "[watchdog] Waiting ${RestartWaitSec}s for Gateway to come up..."
            Start-Sleep -Seconds $RestartWaitSec

            if (Test-GatewayHealth) {
                Write-WatchdogLog "[watchdog] Gateway recovered OK"
            } else {
                Write-WatchdogLog "[watchdog] ERROR: Gateway still not responding after restart"
            }
        }
    }

    Start-Sleep -Seconds $PollIntervalSec
}
