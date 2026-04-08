#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
日报生成模块 - 生成 Markdown 格式的日报
"""

import datetime
from typing import List, Dict, Any


def generate_daily_report(anomalies: List[Dict[str, Any]]) -> str:
    """
    生成日报内容
    
    Args:
        anomalies: 异常列表
        
    Returns:
        Markdown 格式的日报文本
    """
    if not anomalies:
        return generate_empty_report()
    
    now = datetime.datetime.now()
    date_str = now.strftime("%Y年%m月%d日")
    
    lines = []
    lines.append(f"# 📊 A股年报披露异常日报")
    lines.append(f"")
    lines.append(f"**生成时间**: {date_str} {now.strftime('%H:%M')}")
    lines.append(f"**发现异常**: {len(anomalies)} 条")
    lines.append(f"")
    lines.append("---")
    lines.append(f"")
    
    # 按严重程度分组
    high_severity = [a for a in anomalies if a.get("severity") == "high"]
    medium_severity = [a for a in anomalies if a.get("severity") == "medium"]
    
    if high_severity:
        lines.append("## 🔴 高优先级异常")
        lines.append(f"")
        for i, anomaly in enumerate(high_severity, 1):
            lines.append(format_anomaly(anomaly, i))
    
    if medium_severity:
        lines.append("## 🟡 中优先级异常")
        lines.append(f"")
        for i, anomaly in enumerate(medium_severity, 1):
            lines.append(format_anomaly(anomaly, i))
    
    lines.append("---")
    lines.append(f"")
    lines.append("*由 HomeAI 年报监控系统自动生成*")
    
    return "\n".join(lines)


def format_anomaly(anomaly: Dict[str, Any], index: int) -> str:
    """格式化单个异常"""
    lines = []
    
    anomaly_type = anomaly.get("type", "unknown")
    stock_code = anomaly.get("stock_code", "")
    stock_name = anomaly.get("stock_name", "")
    detail = anomaly.get("detail", "")
    
    type_icons = {
        "disclosure_date_change": "📅",
        "forecast_diff": "📈",
        "audit_issue": "🔍",
    }
    icon = type_icons.get(anomaly_type, "⚠️")
    
    lines.append(f"### {index}. {icon} {stock_name} ({stock_code})")
    lines.append(f"")
    lines.append(f"**类型**: {get_type_name(anomaly_type)}")
    lines.append(f"**详情**: {detail}")
    
    old_value = anomaly.get("old_value")
    new_value = anomaly.get("new_value")
    
    if old_value and new_value:
        lines.append(f"**变更**: {old_value} → {new_value}")
    elif new_value:
        lines.append(f"**当前值**: {new_value}")
    
    lines.append(f"")
    
    return "\n".join(lines)


def get_type_name(anomaly_type: str) -> str:
    """获取异常类型的中文名称"""
    type_names = {
        "disclosure_date_change": "披露日期变更",
        "forecast_diff": "业绩预告差异过大",
        "audit_issue": "审计意见异常",
    }
    return type_names.get(anomaly_type, anomaly_type)


def generate_empty_report() -> str:
    """生成空日报（无异常）"""
    now = datetime.datetime.now()
    date_str = now.strftime("%Y年%m月%d日")
    
    lines = []
    lines.append(f"# 📊 A股年报披露异常日报")
    lines.append(f"")
    lines.append(f"**生成时间**: {date_str} {now.strftime('%H:%M')}")
    lines.append(f"")
    lines.append("---")
    lines.append(f"")
    lines.append("✅ **今日无异常**")
    lines.append(f"")
    lines.append("所有监控股票的年报披露信息正常。")
    lines.append(f"")
    lines.append("---")
    lines.append(f"")
    lines.append("*由 HomeAI 年报监控系统自动生成*")
    
    return "\n".join(lines)


if __name__ == "__main__":
    # 测试日报生成
    print("=" * 50)
    print("测试日报生成模块")
    print("=" * 50)
    
    # 测试用例
    test_anomalies = [
        {
            "type": "disclosure_date_change",
            "stock_code": "000001",
            "stock_name": "平安银行",
            "severity": "high",
            "detail": "年报披露日期提前",
            "old_value": "2024-03-20",
            "new_value": "2024-03-15",
        },
        {
            "type": "forecast_diff",
            "stock_code": "000002",
            "stock_name": "万科A",
            "severity": "high",
            "detail": "业绩预告与实际差异超过阈值 (35.0%)",
            "old_value": "增长20%-30%",
            "new_value": "增长50%",
        },
    ]
    
    report = generate_daily_report(test_anomalies)
    print(report)
    print()
    print("=" * 50)
    print("空日报测试:")
    print("=" * 50)
    print(generate_empty_report())
