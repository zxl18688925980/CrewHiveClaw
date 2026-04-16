#!/usr/bin/env pwsh
#Requires -Version 5.1
<#
.SYNOPSIS
    HomeAI Windows Node Setup Script
.DESCRIPTION
    Installs OpenClaw agent and Cloudflare Tunnel on Windows to enable
    remote node control from Mac mini HomeAI gateway.
.NOTES
    Version: 1.0.0
    Requires: Windows 10/11, PowerShell 5.1+, Admin privileges
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory=$false)]
    [string]$GatewayUrl = "https://wecom.homeai-wecom-zxl.top",
    
    [Parameter(Mandatory=$false)]
    [string]$NodeName = $env:COMPUTERNAME,
    
    [Parameter(Mandatory=$false)]
    [string]$ApiKey = "",
    
    [Parameter(Mandatory=$false)]
    [switch]$InstallCloudflared = $true,
    
    [Parameter(Mandatory=$false)]
    [switch]$ConfigureAutostart = $true
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$LOG_FILE = "$env:TEMP\HomeAINodeSetup_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"

function Write-Log {
    param([string]$Message, [string]$Level = "INFO")
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $logEntry = "[$timestamp] [$Level] $Message"
    Add-Content -Path $LOG_FILE -Value $logEntry
    switch ($Level) {
        "ERROR" { Write-Host "[ERROR] $Message" -ForegroundColor Red }
        "WARN"  { Write-Host "[WARN] $Message" -ForegroundColor Yellow }
        "SUCCESS" { Write-Host "[SUCCESS] $Message" -ForegroundColor Green }
        default { Write-Host "[INFO] $Message" -ForegroundColor Cyan }
    }
}

function Test-AdminPrivileges {
    $currentUser = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($currentUser)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-Architecture {
    $arch = $env:PROCESSOR_ARCHITECTURE
    switch ($arch) {
        "AMD64" { return "amd64" }
        "ARM64" { return "arm64" }
        "x86"   { return "386" }
        default { return "amd64" }
    }
}

function Install-Cloudflared {
    Write-Log "Downloading Cloudflare Tunnel client..."
    
    $arch = Get-Architecture
    $version = "2024.8.3"
    $downloadUrl = "https://github.com/cloudflare/cloudflared/releases/download/${version}/cloudflared-windows-${arch}.exe"
    $installPath = "$env:ProgramFiles\Cloudflare\cloudflared.exe"
    
    try {
        if (!(Test-Path (Split-Path $installPath -Parent))) {
            New-Item -ItemType Directory -Path (Split-Path $installPath -Parent) -Force | Out-Null
        }
        
        Invoke-WebRequest -Uri $downloadUrl -OutFile $installPath -UseBasicParsing -TimeoutSec 120
        Write-Log "Cloudflare Tunnel installed to $installPath" -Level "SUCCESS"
        
        $env:PATH += ";$env:ProgramFiles\Cloudflare"
        return $installPath
    }
    catch {
        Write-Log "Failed to download Cloudflared: $_" -Level "ERROR"
        throw
    }
}

function Register-CloudflaredTunnel {
    param(
        [string]$CloudflaredPath,
        [string]$TunnelName
    )
    
    Write-Log "Registering Cloudflare Tunnel '$TunnelName'..."
    
    $cloudflaredDir = "$env:ProgramData\Cloudflare"
    if (!(Test-Path $cloudflaredDir)) {
        New-Item -ItemType Directory -Path $cloudflaredDir -Force | Out-Null
    }
    
    $certFile = "$cloudflaredDir\cert.pem"
    
    if (!(Test-Path $certFile)) {
        Write-Log "Cloudflare Tunnel certificate not found at $certFile" -Level "WARN"
        Write-Log "Please ensure cloudflared has been authenticated with 'cloudflared tunnel login'" -Level "WARN"
        Write-Log "Skipping tunnel registration. Node will connect as HTTP client only."
        return $null
    }
    
    try {
        $tunnelIdFile = "$cloudflaredDir\tunnel_id.txt"
        $existingTunnelId = $null
        if (Test-Path $tunnelIdFile) {
            $existingTunnelId = Get-Content $tunnelIdFile -Raw
        }
        
        if ($existingTunnelId) {
            Write-Log "Using existing tunnel ID: $existingTunnelId"
            return $existingTunnelId
        }
        
        $createOutput = & $CloudflaredPath tunnel create $TunnelName 2>&1
        if ($LASTEXITCODE -eq 0) {
            $tunnelId = ($createOutput | Select-String -Pattern "Created tunnel" | ForEach-Object { $_.Line.Split()[3] })
            if ($tunnelId) {
                $tunnelId | Out-File $tunnelIdFile -Encoding ASCII
                Write-Log "Created new tunnel with ID: $tunnelId" -Level "SUCCESS"
                return $tunnelId
            }
        }
        
        Write-Log "Could not create tunnel. Proceeding without tunnel ID." -Level "WARN"
        return $null
    }
    catch {
        Write-Log "Tunnel registration failed: $_" -Level "WARN"
        return $null
    }
}

function Install-NodeAgent {
    param(
        [string]$GatewayUrl,
        [string]$NodeName,
        [string]$ApiKey,
        [string]$CloudflaredPath
    )
    
    Write-Log "Installing HomeAI Node Agent..."
    
    $nodeInstallDir = "$env:ProgramFiles\HomeAI Node"
    if (!(Test-Path $nodeInstallDir)) {
        New-Item -ItemType Directory -Path $nodeInstallDir -Force | Out-Null
    }
    
    $nodeAgentScript = @"
#!/usr/bin/env pwsh
# HomeAI Windows Node Agent
# Auto-started service that connects to Mac gateway

`$ErrorActionPreference = "Continue"
`$nodeName = "$NodeName"
`$gatewayUrl = "$GatewayUrl"
`$apiKey = "$ApiKey"
`$cloudflaredPath = "$CloudflaredPath"
`$heartbeatInterval = 60
`$logFile = "`$env:ProgramData\HomeAI Node\agent.log"

function Write-AgentLog {
    param([string]`$Message)
    `$timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    Add-Content -Path `$logFile -Value "[`$timestamp] `$Message" -ErrorAction SilentlyContinue
}

function Get-NodeStatus {
    try {
        `$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
        `$mem = (Get-CimInstance Win32_OperatingSystem)
        `$memUsed = [math]::Round(((`$mem.TotalVisibleMemorySize - `$mem.FreePhysicalMemory) / `$mem.TotalVisibleMemorySize) * 100, 1)
        `$disk = (Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'").FreeSpace / 1GB
        
        return @{
            cpu = `$cpu
            memory = `$memUsed
            disk_gb = [math]::Round(`$disk, 2)
            uptime = (Get-Date) - (Get-CimInstance Win32_OperatingSystem).LastBootUpTime
            hostname = `$env:COMPUTERNAME
        }
    }
    catch {
        return @{ error = `$_.Exception.Message }
    }
}

function Send-Heartbeat {
    param(`$status)
    
    try {
        `$body = @{
            node_name = `$nodeName
            status = "online"
            metrics = `$status
            timestamp = (Get-Date -Format "o")
        } | ConvertTo-Json -Compress
        
        `$headers = @{
            "Content-Type" = "application/json"
            "X-Node-ApiKey" = `$apiKey
            "X-Node-Name" = `$nodeName
        }
        
        Invoke-RestMethod -Uri "`$gatewayUrl/api/node/heartbeat" -Method Post -Body `$body -Headers `$headers -TimeoutSec 10 -ErrorAction SilentlyContinue | Out-Null
        Write-AgentLog "Heartbeat sent successfully"
    }
    catch {
        Write-AgentLog "Heartbeat failed: `$_"
    }
}

function Receive-Command {
    try {
        `$headers = @{
            "X-Node-ApiKey" = `$apiKey
            "X-Node-Name" = `$nodeName
        }
        
        `$response = Invoke-RestMethod -Uri "`$gatewayUrl/api/node/commands/`$nodeName" -Method Get -Headers `$headers -TimeoutSec 30
        return `$response
    }
    catch {
        if (`$_.Exception.Response.StatusCode -eq 404) {
            return `$null
        }
        Write-AgentLog "Command fetch failed: `$_"
        return `$null
    }
}

function Execute-Command {
    param(`$cmd)
    
    try {
        `$result = Invoke-Expression `$cmd.script -ErrorAction Stop
        return @{ success = `$true; output = `$result }
    }
    catch {
        return @{ success = `$false; error = `$_.Exception.Message }
    }
}

function Report-Result {
    param(`$commandId, `$result)
    
    try {
        `$body = @{
            command_id = `$commandId
            node_name = `$nodeName
            result = `$result
            completed_at = (Get-Date -Format "o")
        } | ConvertTo-Json -Compress
        
        `$headers = @{
            "Content-Type" = "application/json"
            "X-Node-ApiKey" = `$apiKey
        }
        
        Invoke-RestMethod -Uri "`$gatewayUrl/api/node/results" -Method Post -Body `$body -Headers `$headers -TimeoutSec 10 -ErrorAction SilentlyContinue | Out-Null
    }
    catch {
        Write-AgentLog "Result report failed: `$_"
    }
}

Write-AgentLog "HomeAI Node Agent starting..."
Write-AgentLog "Gateway: `$gatewayUrl"
Write-AgentLog "Node Name: `$nodeName"

while (`$true) {
    `$status = Get-NodeStatus
    Send-Heartbeat -status `$status
    
    `$command = Receive-Command
    if (`$command) {
        Write-AgentLog "Received command: `$(`$command.id)"
        `$result = Execute-Command -cmd `$command
        Report-Result -commandId `$command.id -result `$result
    }
    
    Start-Sleep -Seconds `$heartbeatInterval
}
"@
    
    $agentScriptPath = "$nodeInstallDir\node-agent.ps1"
    $nodeAgentScript | Out-File -FilePath $agentScriptPath -Encoding UTF8
    Write-Log "Node agent script installed to $agentScriptPath" -Level "SUCCESS"
    
    return $agentScriptPath
}

function New-WindowsService {
    param(
        [string]$ServiceName,
        [string]$ScriptPath,
        [switch]$Autostart
    )
    
    Write-Log "Creating Windows service '$ServiceName'..."
    
    $existingService = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
    if ($existingService) {
        Write-Log "Service already exists, removing..."
        Stop-Service -Name $ServiceName -Force -ErrorAction SilentlyContinue
        sc.exe delete $ServiceName | Out-Null
        Start-Sleep -Seconds 2
    }
    
    $nssmPath = "$env:TEMP\nssm.exe"
    $nssmUrl = "https://github.com/gdombiak/nssm/releases/download/2.24/nssm-2.24.zip"
    
    try {
        Write-Log "Downloading NSSM (Non-Sucking Service Manager)..."
        Invoke-WebRequest -Uri $nssmUrl -OutFile "$env:TEMP\nssm.zip" -UseBasicParsing -TimeoutSec 60
        Expand-Archive -Path "$env:TEMP\nssm.zip" -DestinationPath "$env:TEMP\nssm" -Force
        $nssmPath = (Get-ChildItem "$env:TEMP\nssm" -Filter "nssm.exe" -Recurse | Select-Object -First 1).FullName
        
        if ($Autostart) {
            & $nssmPath install $ServiceName "powershell.exe" "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
            & $nssmPath set $ServiceName Start SERVICE_AUTO_START
        } else {
            & $nssmPath install $ServiceName "powershell.exe" "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
        }
        
        Write-Log "Service '$ServiceName' created successfully" -Level "SUCCESS"
    }
    catch {
        Write-Log "NSSM download failed, using schtasks fallback: $_" -Level "WARN"
        
        $taskName = "HomeAINodeAgent"
        $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$ScriptPath`""
        $trigger = New-ScheduledTaskTrigger -AtLogOn
        $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
        
        Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
        Write-Log "Scheduled task '$taskName' created (fallback)" -Level "SUCCESS"
    }
}

function Initialize-NodeConfiguration {
    param(
        [string]$NodeName,
        [string]$GatewayUrl,
        [string]$ApiKey,
        [string]$TunnelId
    )
    
    Write-Log "Creating node configuration..."
    
    $configDir = "$env:ProgramData\HomeAI Node"
    if (!(Test-Path $configDir)) {
        New-Item -ItemType Directory -Path $configDir -Force | Out-Null
    }
    
    $config = @{
        node_name = $NodeName
        gateway_url = $GatewayUrl
        api_key = $ApiKey
        tunnel_id = $TunnelId
        installed_at = (Get-Date -Format "o")
        architecture = Get-Architecture
    }
    
    $configPath = "$configDir\node.json"
    $config | ConvertTo-Json -Depth 3 | Out-File -FilePath $configPath -Encoding UTF8
    Write-Log "Configuration saved to $configPath" -Level "SUCCESS"
}

function Invoke-NodeRegistration {
    param(
        [string]$GatewayUrl,
        [string]$NodeName,
        [string]$ApiKey
    )
    
    Write-Log "Registering node with gateway..."
    
    try {
        $body = @{
            node_name = $NodeName
            platform = "windows"
            architecture = Get-Architecture
            gateway_url = $GatewayUrl
            registered_at = (Get-Date -Format "o")
        } | ConvertTo-Json -Compress
        
        $headers = @{
            "Content-Type" = "application/json"
            "X-Node-ApiKey" = $ApiKey
        }
        
        $response = Invoke-RestMethod -Uri "$GatewayUrl/api/node/register" -Method Post -Body $body -Headers $headers -TimeoutSec 30
        Write-Log "Node registered successfully: $($response | ConvertTo-Json)" -Level "SUCCESS"
        return $true
    }
    catch {
        Write-Log "Registration request failed: $_" -Level "WARN"
        Write-Log "Node will register on next heartbeat." -Level "WARN"
        return $false
    }
}

function Write-CompletionSummary {
    param(
        [string]$NodeName,
        [string]$GatewayUrl,
        [bool]$ServiceCreated
    )
    
    $summary = @"


=============================================================
 HomeAI Windows Node Setup Complete
=============================================================

 Node Name:    $NodeName
 Gateway URL:  $GatewayUrl
 Service:      $(if ($ServiceCreated) { "HomeAINode (Windows Service)" } else { "HomeAINode (Scheduled Task)" })

 Next Steps:
 1. On Mac mini, run:
    ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/configure-node-connection.sh --node-name $NodeName --api-key <YOUR_API_KEY>

 2. Test connection:
    Invoke-RestMethod -Uri "$GatewayUrl/api/node/health" -Method Get

 3. View agent logs:
    Get-Content "$env:ProgramData\HomeAI Node\agent.log" -Wait -Tail 50

=============================================================
"@
    
    Write-Host $summary -ForegroundColor Green
    Add-Content -Path $LOG_FILE -Value $summary
}

Write-Log "=========================================="
Write-Log "HomeAI Windows Node Setup Starting"
Write-Log "=========================================="

if (-not (Test-AdminPrivileges)) {
    Write-Log "This script requires Administrator privileges." -Level "ERROR"
    Write-Log "Please run PowerShell as Administrator and try again." -Level "ERROR"
    Write-Host "Press Enter to exit..."; Read-Host
    exit 1
}

Write-Log "System: $env:COMPUTERNAME"
Write-Log "Architecture: $(Get-Architecture)"
Write-Log "Gateway: $GatewayUrl"

$cloudflaredPath = $null
if ($InstallCloudflared) {
    try {
        $cloudflaredPath = Install-Cloudflared
    }
    catch {
        Write-Log "Cloudflare installation failed: $_" -Level "ERROR"
        Write-Log "Continuing without Cloudflare Tunnel..." -Level "WARN"
    }
}

$tunnelId = $null
if ($cloudflaredPath) {
    $tunnelId = Register-CloudflaredTunnel -CloudflaredPath $cloudflaredPath -TunnelName "homeai-node-$NodeName"
}

$agentScriptPath = Install-NodeAgent -GatewayUrl $GatewayUrl -NodeName $NodeName -ApiKey $ApiKey -CloudflaredPath $cloudflaredPath

Initialize-NodeConfiguration -NodeName $NodeName -GatewayUrl $GatewayUrl -ApiKey $ApiKey -TunnelId $tunnelId

if ($ConfigureAutostart) {
    New-WindowsService -ServiceName "HomeAINode" -ScriptPath $agentScriptPath -Autostart
    $serviceCreated = $true
}
else {
    $serviceCreated = $false
}

Invoke-NodeRegistration -GatewayUrl $GatewayUrl -NodeName $NodeName -ApiKey $ApiKey

Write-CompletionSummary -NodeName $NodeName -GatewayUrl $GatewayUrl -ServiceCreated $serviceCreated

Write-Log "Setup completed successfully" -Level "SUCCESS"
exit 0
