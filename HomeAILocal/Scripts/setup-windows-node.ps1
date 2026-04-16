#!/usr/bin/env pwsh
<#
.SYNOPSIS
    Windows 节点安装脚本 - Cloudflare Tunnel + SSH 远程控制
.DESCRIPTION
    在 Windows 电脑上安装和配置：
    1. OpenSSH Server (远程命令行)
    2. Cloudflare Tunnel (安全内网穿透)
    3. SSH 密钥配置 (免密码登录)
    4. 节点监控客户端 (心跳上报)
    
    使用方式 (PowerShell 管理员):
        .\setup-windows-node.ps1 -CloudflareToken <your-token> [-SshUser <username>] [-MonitorUrl <url>]
    
.PARAMETER CloudflareToken
    Cloudflare Tunnel token (从 Cloudflare Zero Trust dashboard 获取)
.PARAMETER SshUser
    Windows 用户名 (默认: 当前用户)
.PARAMETER MonitorUrl
    监控服务端点 (默认: http://localhost:3004)
.PARAMETER SshPort
    SSH 端口 (默认: 22)
#>

param(
    [Parameter(Mandatory=$true)]
    [string]$CloudflareToken,
    
    [string]$SshUser = $env:USERNAME,
    
    [string]$MonitorUrl = "http://localhost:3004",
    
    [int]$SshPort = 22
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$LOG_FILE = "$env:TEMP\windows-node-setup-$(Get-Date -Format 'yyyyMMdd-HHmmss').log"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logLine = "[$timestamp] [$Level] $Message"
    Write-Host $logLine
    Add-Content -Path $LOG_FILE -Value $logLine
}

function Test-Admin {
    $currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    return $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-WindowsSSHStatus {
    $sshService = Get-Service -Name "sshd" -ErrorAction SilentlyContinue
    if ($sshService) {
        return @{
            Installed = $true
            Running = $sshService.Status -eq 'Running'
        }
    }
    return @{ Installed = $false; Running = $false }
}

function Install-OpenSSH {
    Write-Log "检查 OpenSSH Server 安装状态..."
    
    $sshStatus = Get-WindowsSSHStatus
    
    if (-not $sshStatus.Installed) {
        Write-Log "安装 OpenSSH Server..."
        
        $features = Get-WindowsOptionalFeature -Online | Where-Object { $_.FeatureName -like "*OpenSSH*" }
        
        if ($features) {
            Enable-WindowsOptionalFeature -Online -FeatureName $features[0].FeatureName -All -NoRestart -WarningAction SilentlyContinue | Out-Null
            Write-Log "OpenSSH Server 已安装"
        } else {
            Write-Log "通过包管理器安装 OpenSSH..."
            try {
                Add-WindowsCapability -Online -Name "OpenSSH.Server~~~~0.0.1.0" -ErrorAction Stop
                Write-Log "OpenSSH Server 已安装"
            } catch {
                Write-Log "安装 OpenSSH 失败: $_" "ERROR"
                throw "请手动安装 OpenSSH Server: 设置 -> 应用 -> 可选功能 -> 添加功能 -> OpenSSH Server"
            }
        }
    } else {
        Write-Log "OpenSSH Server 已安装"
    }
    
    Start-Service sshd -ErrorAction SilentlyContinue
    Set-Service -Name sshd -StartupType Automatic -ErrorAction SilentlyContinue
    
    Write-Log "配置 SSH..."
    
    $sshdConfig = "$env:ProgramData\ssh\sshd_config"
    if (Test-Path $sshdConfig) {
        $config = Get-Content $sshdConfig -Raw
        
        if ($config -notmatch "PasswordAuthentication no") {
            $config = $config -replace "(#)?PasswordAuthentication yes", "PasswordAuthentication no"
            Set-Content -Path $sshdConfig -Value $config -NoNewline
            Write-Log "已禁用密码认证"
        }
        
        if ($config -notmatch "PubkeyAuthentication yes") {
            $config = $config -replace "(#)?PubkeyAuthentication no", "PubkeyAuthentication yes"
            Set-Content -Path $sshdConfig -Value $config -NoNewline
            Write-Log "已启用公钥认证"
        }
    }
    
    Restart-Service sshd -ErrorAction SilentlyContinue
    Write-Log "SSH 服务已配置完成"
}

function Install-Cloudflared {
    Write-Log "检查 cloudflared 安装状态..."
    
    $cloudflaredPath = "$env:ProgramFiles\cloudflared\cloudflared.exe"
    
    if (-not (Test-Path $cloudflaredPath)) {
        Write-Log "下载并安装 cloudflared..."
        
        $cloudflaredUrl = "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe"
        $tempPath = "$env:TEMP\cloudflared.exe"
        
        try {
            [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
            Invoke-WebRequest -Uri $cloudflaredUrl -OutFile $tempPath -UseBasicParsing -TimeoutSec 60
            
            New-Item -ItemType Directory -Path "$env:ProgramFiles\cloudflared" -Force | Out-Null
            Move-Item -Path $tempPath -Destination $cloudflaredPath -Force
            
            Write-Log "cloudflared 已安装到 $cloudflaredPath"
        } catch {
            Write-Log "下载 cloudflared 失败: $_" "ERROR"
            throw "请手动下载 cloudflared: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/"
        }
    } else {
        Write-Log "cloudflared 已安装"
    }
    
    $env:PATH = "$env:ProgramFiles\cloudflared;$env:PATH"
    
    return $cloudflaredPath
}

function Start-CloudflaredTunnel {
    param(
        [string]$Token,
        [string]$CloudflaredPath
    )
    
    Write-Log "启动 Cloudflare Tunnel..."
    
    $tunnelName = "windows-node-$SshUser-$(hostname)"
    $serviceName = "cloudflared-tunnel"
    
    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $serviceName | Out-Null
    }
    
    $runPath = "$env:ProgramData\cloudflared-tunnel"
    New-Item -ItemType Directory -Path $runPath -Force | Out-Null
    
    $logFile = "$runPath\cloudflared.log"
    
    $cmd = "$CloudflaredPath tunnel --protocol http2 run --token $Token"
    
    $svcXml = @"
<?xml version="1.0" encoding="UTF-16"?>
<scmanager>
    <service>
        <name>$serviceName</name>
        <display>Cloudflare Tunnel</display>
        <description>Windows 节点 Cloudflare Tunnel 连接</description>
        <executable>$cmd</executable>
        <arguments>--no-autoupdate</arguments>
        <workingdirectory>$runPath</workingdirectory>
        <loglevel>info</loglevel>
    </service>
</scmanager>
"@
    
    Write-Log "Tunnel 配置完成 (token 隐藏)"
}

function New-SshKeyPair {
    param([string]$User)
    
    $userHome = if ($User -eq $env:USERNAME) { $env:USERPROFILE } else { "$env:SystemDrive\Users\$User" }
    $sshDir = "$userHome\.ssh"
    
    if (-not (Test-Path $sshDir)) {
        New-Item -ItemType Directory -Path $sshDir -Force | Out-Null
        Write-Log "创建 .ssh 目录: $sshDir"
    }
    
    $authKeys = "$sshDir\authorized_keys"
    
    Write-Log "authorized_keys 路径: $authKeys"
    Write-Log ""
    Write-Log "=========================================="
    Write-Log "  重要: 请在 Mac 端运行以下命令获取公钥:"
    Write-Log "  cat ~/.ssh/id_ed25519.pub"
    Write-Log ""
    Write-Log "  然后将公钥内容添加到 authorized_keys:"
    Write-Log "  echo '<mac-public-key>' | Out-File -FilePath '$authKeys' -Encoding utf8 -Append"
    Write-Log "=========================================="
    Write-Log ""
}

function Install-NodeAgent {
    Write-Log "安装节点监控客户端..."
    
    $agentDir = "$env:ProgramData\node-agent"
    New-Item -ItemType Directory -Path $agentDir -Force | Out-Null
    
    $agentScript = @"
#!/usr/bin/env pwsh
`$ErrorActionPreference = "SilentlyContinue"

`$NODE_ID = "$(hostname)"
`$MONITOR_URL = "$MonitorUrl"
`$HEARTBEAT_INTERVAL = 30

function Get-NodeInfo {
    @{
        nodeId = `$env:COMPUTERNAME
        hostname = `$env:COMPUTERNAME
        username = `$env:USERNAME
        os = "Windows"
        osVersion = (Get-WmiObject Win32_OperatingSystem).Caption
        ipAddress = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { `$_.IPAddress -notlike "127.*" } | Select-Object -First 1).IPAddress
        timestamp = [DateTimeOffset]::Now.ToUnixTimeSeconds()
        sshPort = $SshPort
        cloudflaredStatus = (Get-Service -Name "cloudflared-tunnel" -ErrorAction SilentlyContinue).Status
        sshStatus = (Get-Service -Name "sshd" -ErrorAction SilentlyContinue).Status
    }
}

function Send-Heartbeat {
    try {
        `$info = Get-NodeInfo
        `$json = `$info | ConvertTo-Json -Compress
        Invoke-RestMethod -Uri "`$MONITOR_URL/api/nodes/heartbeat" -Method Post -Body `$json -ContentType "application/json" -TimeoutSec 10
        return `$true
    } catch {
        return `$false
    }
}

Write-Host "Node Agent 启动 - NodeID: `$NODE_ID"
Write-Host "监控服务端: `$MONITOR_URL"

while (`$true) {
    `$ok = Send-Heartbeat
    if (`$ok) {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 心跳成功"
    } else {
        Write-Host "[$(Get-Date -Format 'HH:mm:ss')] 心跳失败 (监控服务可能未启动)"
    }
    Start-Sleep -Seconds `$HEARTBEAT_INTERVAL
}
"@
    
    Set-Content -Path "$agentDir\node-agent.ps1" -Value $agentScript -Encoding UTF8
    
    $serviceName = "NodeAgent"
    $existing = Get-Service -Name $serviceName -ErrorAction SilentlyContinue
    if ($existing) {
        Stop-Service -Name $serviceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $serviceName | Out-Null
    }
    
    $nssm = "$env:TEMP\nssm.exe"
    $nssmUrl = "https://github.com/Nickeubank/nssm/releases/download/nssm-2.24/nssm-2.24.zip"
    
    try {
        Write-Log "下载 nssm..."
        Invoke-WebRequest -Uri $nssmUrl -OutFile "$env:TEMP\nssm.zip" -UseBasicParsing -TimeoutSec 30
        Expand-Archive -Path "$env:TEMP\nssm.zip" -DestinationPath "$env:TEMP\nssm" -Force
        Copy-Item -Path "$env:TEMP\nssm\nssm-2.24\win64\nssm.exe" -Destination "$agentDir\nssm.exe" -Force
        
        $agentExe = "$agentDir\node-agent.ps1"
        $createCmd = "$agentDir\nssm.exe install NodeAgent $env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
        $createCmd += " -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$agentExe`""
        
        Write-Log "注册 NodeAgent 服务..."
    } catch {
        Write-Log "nssm 下载失败，使用计划任务方式" "WARN"
        
        $taskName = "NodeAgent"
        $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$agentDir\node-agent.ps1`""
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
        
        Start-ScheduledTask -TaskName $taskName
        Write-Log "NodeAgent 已注册为计划任务"
        return
    }
    
    try {
        & "$agentDir\nssm.exe" install NodeAgent "powershell.exe" " -ExecutionPolicy Bypass -NoProfile -WindowStyle Hidden -File `"$agentDir\node-agent.ps1`"" | Out-Null
        & "$agentDir\nssm.exe" set NodeAgent AppDirectory "$agentDir" | Out-Null
        & "$agentDir\nssm.exe" set NodeAgent AppStdout "$agentDir\agent.log" | Out-Null
        & "$agentDir\nssm.exe" set NodeAgent AppStderr "$agentDir\error.log" | Out-Null
        Start-Service NodeAgent -ErrorAction Stop
        Write-Log "NodeAgent 服务已启动"
    } catch {
        Write-Log "服务注册失败: $_" "ERROR"
        Write-Log "NodeAgent 将以交互方式运行"
    }
}

function Show-FirewallRules {
    Write-Log "检查防火墙规则..."
    
    $rule = Get-NetFirewallRule -DisplayName "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue
    if ($rule) {
        if ($rule.Enabled -ne $true) {
            Enable-NetFirewallRule -DisplayName "OpenSSH-Server-In-TCP"
            Write-Log "已启用 SSH 防火墙规则"
        }
    }
}

function Show-Summary {
    Write-Log ""
    Write-Log "=========================================="
    Write-Log "  Windows 节点安装完成!"
    Write-Log "=========================================="
    Write-Log ""
    Write-Log "节点信息:"
    Write-Log "  主机名: $(hostname)"
    Write-Log "  用户名: $SshUser"
    Write-Log "  SSH 端口: $SshPort"
    Write-Log ""
    Write-Log "服务状态:"
    $sshSvc = Get-Service -Name "sshd" -ErrorAction SilentlyContinue
    Write-Log "  SSH: $($sshSvc.Status)"
    $cfSvc = Get-Service -Name "cloudflared-tunnel" -ErrorAction SilentlyContinue
    Write-Log "  Cloudflare Tunnel: $($cfSvc.Status)"
    $agentSvc = Get-Service -Name "NodeAgent" -ErrorAction SilentlyContinue
    Write-Log "  Node Agent: $($agentSvc.Status)"
    Write-Log ""
    Write-Log "日志文件: $LOG_FILE"
    Write-Log ""
    Write-Log "=========================================="
    Write-Log "  下一步操作:"
    Write-Log "  1. 在 Mac 端运行 setup-mac-config.sh"
    Write-Log "  2. 将 Mac 公钥添加到 Windows authorized_keys"
    Write-Log "  3. 运行 test-windows-node.ps1 验证安装"
    Write-Log "=========================================="
}

Write-Log "=========================================="
Write-Log "  Windows 节点安装脚本"
Write-Log "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Log "=========================================="

if (-not (Test-Admin)) {
    Write-Log "需要管理员权限，请以管理员身份运行 PowerShell" "ERROR"
    Write-Log "右键 PowerShell -> 以管理员身份运行" "INFO"
    exit 1
}

Write-Log "当前用户: $SshUser"
Write-Log "计算机名: $(hostname)"

try {
    Install-OpenSSH
    Show-FirewallRules
    
    $cloudflaredPath = Install-Cloudflared
    Start-CloudflaredTunnel -Token $CloudflareToken -CloudflaredPath $cloudflaredPath
    
    New-SshKeyPair -User $SshUser
    Install-NodeAgent
    
    Show-Summary
    
    exit 0
} catch {
    Write-Log "安装过程出错: $_" "ERROR"
    Write-Log "详细日志: $LOG_FILE"
    exit 1
}
