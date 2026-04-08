#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
配置模块 - A股年报监控系统
"""

import os

# 监控股票池（示例，需要用户补充）
WATCHLIST = [
    "000001",  # 平安银行
    "000002",  # 万科A
    # 在这里添加更多股票代码
]

# 异常检测阈值
THRESHOLDS = {
    "forecast_diff_ratio": 0.3,  # 业绩预告差异阈值 30%
    "dedup_hours": 24,           # 去重时间窗口 24小时
}

# 推送配置
PUSH_CONFIG = {
    "target_user": "ZiFeiYu",    # 企业微信用户ID
    "wecom_entrance_url": "http://localhost:3003/send",
}

# 数据源配置
DATA_SOURCE = {
    "cninfo_search_url": "http://www.cninfo.com.cn/new/fulltextSearch",
    "cninfo_detail_url": "http://www.cninfo.com.cn/new/disclosure/detail",
    "request_timeout": 10,
    "retry_times": 3,
    "retry_delay": 2,  # 秒
}

# 存储路径
STORAGE_PATH = os.path.join(os.path.dirname(__file__), "data")
DB_PATH = os.path.join(STORAGE_PATH, "annual_report.db")

# 日志路径
LOG_PATH = os.path.join(os.path.dirname(__file__), "logs")

# 请求头（模拟浏览器）
REQUEST_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Connection": "keep-alive",
}
