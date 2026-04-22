# Windows 节点安装指南

> 核心能力：让任何一台 Windows 个人电脑成为 HomeAI 的远程协同节点。
> 安装脚本：`https://wecom.your-domain.com/app/node-setup/windows-node-setup.ps1`

---

## 一、这是什么

每一台 Windows 电脑（小姨的笔记本、你的台式机、任何家人的 Windows 设备），装上这个脚本后，就成为 HomeAI 的一个远程节点：

- **启灵可以在上面调度 Claude Code** 跑任务
- **节点自动心跳上报**，启灵知道它在线/离线
- **远程命令执行**，启灵下发脚本，节点跑完回传结果
- **Cloudflare Tunnel**（可选），让节点穿透内网直达 Gateway

**架构概览**：

```
┌─────────────────────────────┐     heartbeat/commands     ┌──────────────────────┐
│  Windows 个人电脑（节点）     │◄─────────────────────────►│  Mac mini Gateway    │
│                             │                           │  （启灵 / Andy / Lisa）│
│  - Node.js v24              │                           │                      │
│  - Claude Code              │◄─── 远程调度 ───────────►│  启灵下发任务指令     │
│  - OpenClaw（可选）          │                           │  Claude Code 执行     │
│  - Node Agent（心跳服务）    │                           └──────────────────────┘
│  - Cloudflare Tunnel（可选） │
└─────────────────────────────┘
```

---

## 二、前置条件

| 条件 | 说明 |
|------|------|
| Windows 10/11 | 必须 |
| 管理员权限 | 安装脚本需要以「管理员身份运行 PowerShell」 |
| 网络可达 Gateway | 能访问 `https://wecom.your-domain.com` |
| Node.js v22+ | 脚本会自动安装，也可以提前手动装好 |

---

## 三、一键安装

### 3.1 下载安装脚本

在 Windows 电脑上，打开浏览器访问：

```
https://wecom.your-domain.com/app/node-setup/install.bat
```

下载 `install.bat` 到桌面。这个 `.bat` 文件会自动：
1. 以管理员身份启动 PowerShell
2. 下载 `windows-node-setup.ps1`
3. 执行安装

### 3.2 执行安装

**双击桌面的 `install.bat`**，脚本会自动弹起管理员 PowerShell 并执行。

或者直接下载 PS1 脚本手动执行：

```powershell
# 以管理员身份打开 PowerShell，然后执行：
powershell.exe -ExecutionPolicy Bypass -File "C:\Users\Administrator\Downloads\windows-node-setup.ps1"
```

### 3.3 安装流程

脚本会依次执行以下步骤（全部自动，无需手动干预）：

| 步骤 | 内容 | 失败影响 |
|------|------|---------|
| 1 | 检查/安装 Node.js | **阻断**——必须有 Node.js |
| 2 | 检查/安装 OpenClaw | 可选跳过——Windows 上 Claude Code 是主力 |
| 3 | 检查/安装 Claude Code | 可选——但建议安装 |
| 4 | 创建 OpenClaw 配置文件 | 可选 |
| 5 | 下载/安装 Cloudflare Tunnel | 可选——不装则只能 HTTP 直连 |
| 6 | 安装 Node Agent 心跳脚本 | **核心** |
| 7 | 创建 Windows 服务/计划任务 | **核心**——保证开机自启 |
| 8 | 创建节点配置（node.json） | **核心** |
| 9 | 向 Gateway 注册节点 | **当前有 Bug**，见下方已知问题 |

### 3.4 安装完成标志

看到以下输出即表示安装流程跑完：

```
=============================================================
 HomeAI Windows Node Setup Complete
=============================================================

 Node Name:     DESKTOP-XXXXXXX
 Gateway URL:   https://wecom.your-domain.com
 Service:       HomeAINode (Windows Service) 或 (Scheduled Task)
 OpenClaw:      Not installed 或 Installed
 Claude Code:   Installed 或 Not installed

 请把上面的输出全部复制给我（启灵），我来帮你判断下一步。
=============================================================
```

**把这段输出复制给启灵**，启灵会判断是否有卡点需要解决。

---

## 四、已知问题与修复

### 问题 1：Gateway 注册返回 404

**症状**：安装日志中出现：
```
[WARN] Registration request failed: The remote server returned an error: (404) Not Found.
[WARN] Node will register on next heartbeat.
```

**原因**：Gateway 后端尚未部署 `/api/node/register` 接口。脚本已做容错——注册失败不会中断安装，等后续心跳时自动补注册。

**修复**：需要在 Gateway 后端添加节点注册路由。联系 Andy 修复中。

**临时方案**：手动验证节点连通性：
```powershell
# 测试心跳端点是否可达
Invoke-RestMethod -Uri "https://wecom.your-domain.com/api/node/heartbeat" -Method Post -Body '{"node_name":"DESKTOP-XXXXXXX","status":"online"}' -ContentType "application/json"
```

### 问题 2：OpenClaw 安装被跳过

**症状**：输出显示 `OpenClaw: Not installed`。

**原因**：Windows 节点以 Claude Code 为主要 Agent，OpenClaw 标记为可选。脚本跳过 `npm install -g openclaw` 以避免国内 npm 网络问题。

**修复**：如果需要 OpenClaw，手动执行：
```powershell
npm install -g openclaw
```

### 问题 3：Cloudflare Tunnel 未注册

**症状**：
```
[WARN] Cloudflare Tunnel certificate not found
[WARN] Skipping tunnel registration. Node will connect as HTTP client only.
```

**原因**：未执行 `cloudflared tunnel login` 认证。这是正常行为——内网穿透隧道需要额外的 Cloudflare 账号认证。

**影响**：不影响基础连通性。节点通过 HTTP 直连 Gateway。需要内网穿透时再配置。

---

## 五、安装后验证

### 5.1 检查服务状态

```powershell
# 检查 Node Agent 服务/计划任务
Get-ScheduledTask -TaskName "HomeAINodeAgent" | Select State
# 或
Get-Service -Name "HomeAINode" -ErrorAction SilentlyContinue | Select Status
```

### 5.2 检查节点配置

```powershell
Get-Content "C:\ProgramData\HomeAI Node\node.json"
```

应输出类似：
```json
{
    "node_name": "DESKTOP-XXXXXXX",
    "gateway_url": "https://wecom.your-domain.com",
    "api_key": "",
    "installed_at": "2026-04-16T..."
}
```

### 5.3 检查 Node Agent 日志

```powershell
Get-Content "C:\ProgramData\HomeAI Node\agent.log" -Tail 20
```

应看到心跳发送记录。

### 5.4 验证 Claude Code 可用

```powershell
claude --version
```

### 5.5 验证 Gateway 连通性

```powershell
# 测试 Gateway 是否可达
Invoke-WebRequest -Uri "https://wecom.your-domain.com" -Method Head
# 应返回 200 或 301，不报连接错误
```

---

## 六、节点安装后：启灵远程调度

节点安装完成后，启灵可以：

1. **通过 Claude Code 远程执行任务**——启灵下发编程任务到节点的 Claude Code
2. **通过 Node Agent 心跳监控节点状态**——在线/离线、CPU/内存/磁盘
3. **通过 Node Agent 下发远程命令**——脚本执行、日志查看、文件操作

**典型使用场景**：
- 小姨的电脑：启灵调度 Claude Code 帮她处理文档、数据整理
- 爸爸的 Windows 台式机：远程执行脚本、环境配置
- 任何家人的 Windows 设备：一键接入 HomeAI 生态

---

## 七、卸载

如果需要从节点上移除 HomeAI：

```powershell
# 以管理员身份执行

# 1. 停止并删除服务/计划任务
Stop-Service -Name "HomeAINode" -Force -ErrorAction SilentlyContinue
sc.exe delete HomeAINode
Unregister-ScheduledTask -TaskName "HomeAINodeAgent" -Confirm:$false -ErrorAction SilentlyContinue

# 2. 删除文件
Remove-Item "C:\Program Files\HomeAI Node" -Recurse -Force
Remove-Item "C:\ProgramData\HomeAI Node" -Recurse -Force
Remove-Item "C:\Program Files\Cloudflare" -Recurse -Force -ErrorAction SilentlyContinue

# 3. 删除 OpenClaw（如果安装了）
npm uninstall -g openclaw
Remove-Item "$env:HOME\.openclaw" -Recurse -Force -ErrorAction SilentlyContinue
```

---

## 八、常见问题

| 问题 | 解决 |
|------|------|
| 脚本执行被策略拦截 | `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` |
| Node.js 下载超时 | 手动从 nodejs.org 下载安装 |
| Claude Code 下载超时 | 配置 npm 国内镜像：`npm config set registry https://registry.npmmirror.com` |
| 服务未启动 | 手动启动：`Start-Service -Name "HomeAINode"` 或 `schtasks /run /tn HomeAINodeAgent` |
| 日志文件为空 | 确认 agent.log 路径权限，`icacls` 检查 |
| 节点注册 404 | 已知问题，等 Gateway 端修复，不影响其他功能 |

---

## 九、脚本文件清单

部署在 `https://wecom.your-domain.com/app/node-setup/`：

| 文件 | 用途 |
|------|------|
| `windows-node-setup.ps1` | 主安装脚本 |
| `install.bat` | 一键启动器（自动管理员提权） |
| `cloudflared-windows-amd64.exe` | Cloudflare Tunnel 客户端 |
| `index.html` | 安装指引页面 |

---

**版本**：1.0.0  
**最后更新**：2026-04-16  
**维护**：启灵（Lucas）
