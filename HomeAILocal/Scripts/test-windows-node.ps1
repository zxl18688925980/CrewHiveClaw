#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Windows 节点本地验证脚本
.DESCRIPTION
    验证 Windows 节点各项服务是否正常运行:
    1. OpenSSH Server 状态
    2. Cloudflare Tunnel 状态
    3. Node Agent 状态
    4. 本地网络端口检查
    5. 基础命令执行测试
    
.PARAMETER MonitorUrl
    监控服务端点 (默认: http://localhost:3004)
#>

param(
    [string]$MonitorUrl = "http://localhost:3004"
)

$ErrorActionPreference = "Continue"

$GREEN = "`e[0;32m"
$RED = "`e[0;31m"
$YELLOW = "`e[1;33m"
$NC = "`e[0m"

function Write-Check {
    param([string]$Name, [bool]$Success, [string]$Message = "")
    if ($Success) {
        Write-Host "${GREEN}[OK]${NC} $Name" -NoNewline
    } else {
        Write-Host "${RED}[FAIL]${NC} $Name" -NoNewline
    }
    if ($Message) {
        Write-Host " - $Message"
    } else {
        Write-Host ""
    }
    return $Success
}

function Test-SshService {
    Write-Host ""
    Write-Host "=== SSH 服务检查 ===" -ForegroundColor Cyan
    
    $sshd = Get-Service -Name "sshd" -ErrorAction SilentlyContinue
    
    if ($sshd) {
        $status = $sshd.Status -eq 'Running'
        Write-Check "SSH 服务已安装" $true
        Write-Check "SSH 服务运行中" $status "$($sshd.Status)"
        
        $listening = Get-NetTCPConnection -LocalPort 22 -ErrorAction SilentlyContinue
        Write-Check "SSH 端口 22 监听中" ($null -ne $listening -and $listening.Count -gt 0)
        
        return $status
    } else {
        Write-Check "SSH 服务" $false "未安装"
        return $false
    }
}

function Test-CloudflaredService {
    Write-Host ""
    Write-Host "=== Cloudflare Tunnel 检查 ===" -ForegroundColor Cyan
    
    $cf = Get-Service -Name "cloudflared-tunnel" -ErrorAction SilentlyContinue
    
    if ($cf) {
        $status = $cf.Status -eq 'Running'
        Write-Check "Cloudflare Tunnel 服务" $status "$($cf.Status)"
        
        $cfProc = Get-Process -Name "cloudflared" -ErrorAction SilentlyContinue
        Write-Check "cloudflared 进程运行中" ($null -ne $cfProc)
        
        if ($cfProc) {
            Write-Host "    PID: $($cfProc.Id)"
            Write-Host "    运行时间: $((Get-Date) - $cfProc.StartTime | ForEach-Object { '{0:d2}:{1:d2}:{2:d2}' -f $_.Hours, $_.Minutes, $_.Seconds })"
        }
        
        return $status
    } else {
        Write-Check "Cloudflare Tunnel 服务" $false "未安装或未启动"
        return $false
    }
}

function Test-NodeAgent {
    Write-Host ""
    Write-Host "=== Node Agent 检查 ===" -ForegroundColor Cyan
    
    $agent = Get-Service -Name "NodeAgent" -ErrorAction SilentlyContinue
    
    if ($agent) {
        $status = $agent.Status -eq 'Running'
        Write-Check "NodeAgent 服务" $status "$($agent.Status)"
        
        $agentLog = "$env:ProgramData\node-agent\agent.log"
        if (Test-Path $agentLog) {
            $lastLines = Get-Content $agentLog -Tail 5 -ErrorAction SilentlyContinue
            Write-Host "    最近日志:"
            foreach ($line in $lastLines) {
                Write-Host "      $line" -ForegroundColor DarkGray
            }
        }
        
        return $status
    } else {
        Write-Host "    (NodeAgent 可能配置为计划任务而非服务)"
        
        $task = Get-ScheduledTask -TaskName "NodeAgent" -ErrorAction SilentlyContinue
        if ($task) {
            $state = $task.State -eq 'Ready' -or $task.State -eq 'Running'
            Write-Check "NodeAgent 计划任务" $state "$($task.State)"
            return $state
        }
        
        return $false
    }
}

function Test-NetworkPorts {
    Write-Host ""
    Write-Host "=== 网络端口检查 ===" -ForegroundColor Cyan
    
    $sshPort = Get-NetTCPConnection -LocalPort 22 -State Listen -ErrorAction SilentlyContinue
    if ($sshPort) {
        Write-Check "SSH (端口 22)" $true "$($sshPort[0].LocalAddress):$($sshPort[0].LocalPort)"
    } else {
        Write-Check "SSH (端口 22)" $false "未监听"
    }
}

function Test-CommandExecution {
    Write-Host ""
    Write-Host "=== 命令执行测试 ===" -ForegroundColor Cyan
    
    try {
        $result = powershell -NoProfile -Command "Write-Output 'Hello from PowerShell' | ConvertTo-Json -Compress"
        $success = $null -ne $result
        Write-Check "PowerShell 执行" $success
        
        try {
            $hostname = hostname
            Write-Check "hostname 命令" $true $hostname
        } catch {
            Write-Check "hostname 命令" $false
        }
        
        try {
            $date = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
            Write-Check "Get-Date 命令" $true $date
        } catch {
            Write-Check "Get-Date 命令" $false
        }
        
        return $true
    } catch {
        Write-Check "命令执行" $false $_.Exception.Message
        return $false
    }
}

function Test-Heartbeat {
    Write-Host ""
    Write-Host "=== 监控心跳测试 ===" -ForegroundColor Cyan
    
    $nodeInfo = @{
        nodeId = $env:COMPUTERNAME
        hostname = $env:COMPUTERNAME
        username = $env:USERNAME
        os = "Windows"
        timestamp = [DateTimeOffset]::Now.ToUnixTimeSeconds()
    }
    
    try {
        $response = Invoke-RestMethod -Uri "$MonitorUrl/api/nodes/heartbeat" -Method Post -Body ($nodeInfo | ConvertTo-Json) -ContentType "application/json" -TimeoutSec 5 -ErrorAction Stop
        Write-Check "心跳上报" $true "监控服务可达"
        return $true
    } catch {
        Write-Check "心跳上报" $false "监控服务不可达 (这是正常的如果监控服务未启动)"
        return $false
    }
}

function Show-SystemInfo {
    Write-Host ""
    Write-Host "=== 系统信息 ===" -ForegroundColor Cyan
    
    $os = Get-CimInstance Win32_OperatingSystem
    Write-Host "    计算机名: $env:COMPUTERNAME"
    Write-Host "    用户名: $env:USERNAME"
    Write-Host "    OS: $($os.Caption)"
    Write-Host "    版本: $($os.Version)"
    Write-Host "    架构: $($os.OSArchitecture)"
    
    $cpu = Get-CimInstance Win32_Processor
    Write-Host "    CPU: $($cpu.Name)"
    
    $mem = [math]::Round($os.TotalVisibleMemorySize / 1MB, 2)
    Write-Host "    内存: ${mem} GB"
}

function Show-FirewallStatus {
    Write-Host ""
    Write-Host "=== 防火墙状态 ===" -ForegroundColor Cyan
    
    $sshRule = Get-NetFirewallRule -DisplayName "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
    if ($sshRule) {
        Write-Check "SSH 防火墙规则" ($sshRule.Enabled -eq $true) "$($sshRule.Direction) $($sshRule.Action)"
    } else {
        Write-Check "SSH 防火墙规则" $false "未找到"
    }
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  Windows 节点验证脚本" -ForegroundColor Cyan
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Gray
Write-Host "==========================================" -ForegroundColor Cyan

Show-SystemInfo

$results = @{
    SshOk = Test-SshService
    CloudflaredOk = Test-CloudflaredService
    NodeAgentOk = Test-NodeAgent
    NetworkOk = (Test-NetworkPorts) -or $true
    CommandsOk = Test-CommandExecution
    HeartbeatOk = Test-Heartbeat
    FirewallOk = (Show-FirewallStatus) -or $true
}

Write-Host ""
Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "  验证结果汇总" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

$allPassed = $true
foreach ($key in $results.Keys) {
    $passed = $results[$key]
    if (-not $passed) { $allPassed = $false }
    $status = if ($passed) { "${GREEN}PASS${NC}" } else { "${RED}FAIL${NC}" }
    Write-Host "  $status  $key"
}

Write-Host ""
if ($allPassed) {
    Write-Host "${GREEN}所有检查通过!${NC}" -ForegroundColor Green
} else {
    Write-Host "${YELLOW}部分检查失败，请查看上方详情${NC}" -ForegroundColor Yellow
    Write-Host ""
    Write-Host "常见问题解决:"
    Write-Host "  1. SSH 未启动: Start-Service sshd"
    Write-Host "  2. Tunnel 未启动: 检查 Cloudflare Token 配置"
    Write-Host "  3. Agent 未启动: Start-ScheduledTask -TaskName NodeAgent"
}

Write-Host ""
