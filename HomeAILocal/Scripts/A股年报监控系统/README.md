# A股年报监控系统

自动监控A股上市公司年报披露异常，每日推送日报到企业微信。

## 功能

- 监控三类异常：
  1. 年报披露日期变更（提前/推迟）
  2. 业绩预告与实际差异过大
  3. 审计意见异常
- 数据源：巨潮资讯网 (cninfo)
- 每日定时推送日报
- SQLite 去重，避免重复推送

## 快速开始

### 1. 安装依赖

```bash
cd scripts/A股年报监控系统
pip3 install -r requirements.txt
```

### 2. 配置监控股票

编辑 `config.py`，添加需要监控的股票代码：

```python
WATCHLIST = [
    "000001",  # 平安银行
    "000002",  # 万科A
]
```

### 3. 测试运行

```bash
# 测试推送功能
python3 main.py --test-push

# 测试抓取单只股票
python3 main.py --test-fetch 000001

# 完整运行
python3 main.py
```

### 4. 配置定时任务

添加到 crontab（每天早上 9:00 运行）：

```bash
crontab -e
```

添加以下行：

```
0 9 * * * /usr/bin/python3 /Users/xinbinanshan/HomeAI/scripts/A股年报监控系统/main.py >> /Users/xinbinanshan/HomeAI/logs/年报监控.log 2>&1
```

## 目录结构

```
A股年报监控系统/
├── main.py          # 主入口
├── config.py        # 配置
├── storage.py       # 数据存储
├── fetcher.py       # 数据抓取
├── detector.py      # 异常检测
├── reporter.py      # 日报生成
├── pusher.py        # 消息推送
├── data/            # SQLite 数据库
├── logs/            # 日志文件
└── requirements.txt # 依赖
```

## 配置说明

在 `config.py` 中可调整：

- `WATCHLIST`: 监控股票列表
- `THRESHOLDS`: 异常检测阈值（业绩差异阈值、去重时间）
- `PUSH_CONFIG`: 推送目标用户

## 注意事项

1. 数据抓取依赖巨潮资讯网页面结构，可能需要定期更新解析逻辑
2. 如遇反爬，可适当增加请求间隔
3. 首次运行会创建数据库和日志目录

## 依赖服务

- wecom-entrance (端口 3003) - 用于企业微信推送
