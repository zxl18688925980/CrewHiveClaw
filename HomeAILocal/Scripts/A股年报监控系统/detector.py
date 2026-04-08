#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
异常检测模块 - 检测三类年报异常
"""

import re
import datetime
from typing import Dict, Any, List, Optional

import config


def detect_anomalies(
    current_data: Dict[str, Any],
    previous_data: Optional[Dict[str, Any]] = None
) -> List[Dict[str, Any]]:
    """
    检测年报异常
    
    返回异常列表:
    [
        {
            "type": "disclosure_date_change" | "forecast_diff" | "audit_issue",
            "stock_code": "000001",
            "stock_name": "平安银行",
            "severity": "high" | "medium" | "low",
            "detail": "描述信息",
            "old_value": "...",
            "new_value": "...",
        }
    ]
    """
    anomalies = []
    stock_code = current_data.get("stock_code", "未知")
    stock_name = current_data.get("stock_name", "未知")
    
    # 1. 检测披露日期变更
    if previous_data:
        date_anomaly = _check_disclosure_date_change(
            current_data, previous_data, stock_code, stock_name
        )
        if date_anomaly:
            anomalies.append(date_anomaly)
    
    # 2. 检测业绩预告与实际差异过大
    forecast_anomaly = _check_forecast_diff(
        current_data, stock_code, stock_name
    )
    if forecast_anomaly:
        anomalies.append(forecast_anomaly)
    
    # 3. 检测审计意见异常
    audit_anomaly = _check_audit_opinion(
        current_data, stock_code, stock_name
    )
    if audit_anomaly:
        anomalies.append(audit_anomaly)
    
    return anomalies


def _check_disclosure_date_change(
    current: Dict[str, Any],
    previous: Dict[str, Any],
    stock_code: str,
    stock_name: str
) -> Optional[Dict[str, Any]]:
    """检测披露日期变更"""
    current_date = current.get("disclosure_date")
    previous_date = previous.get("disclosure_date")
    
    if not current_date or not previous_date:
        return None
    
    if current_date != previous_date:
        # 判断是提前还是推迟
        try:
            # 尝试解析日期（支持多种格式）
            curr_dt = _parse_date(current_date)
            prev_dt = _parse_date(previous_date)
            
            if curr_dt < prev_dt:
                change_type = "提前"
                severity = "high"
            else:
                change_type = "推迟"
                severity = "medium"
            
            return {
                "type": "disclosure_date_change",
                "stock_code": stock_code,
                "stock_name": stock_name,
                "severity": severity,
                "detail": f"年报披露日期{change_type}",
                "old_value": previous_date,
                "new_value": current_date,
            }
        except Exception as e:
            print(f"日期解析失败: {e}")
    
    return None


def _parse_date(date_str: str) -> datetime.datetime:
    """解析日期字符串"""
    # 支持多种格式
    formats = [
        "%Y-%m-%d",
        "%Y年%m月%d日",
        "%Y/%m/%d",
    ]
    
    for fmt in formats:
        try:
            return datetime.datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    
    raise ValueError(f"无法解析日期: {date_str}")


def _check_forecast_diff(
    data: Dict[str, Any],
    stock_code: str,
    stock_name: str
) -> Optional[Dict[str, Any]]:
    """检测业绩预告与实际差异"""
    forecast_type = data.get("forecast_type")
    forecast_value = data.get("forecast_value")
    actual_value = data.get("actual_value")
    
    if not forecast_type or not forecast_value or not actual_value:
        return None
    
    # 提取数值进行比较
    forecast_nums = _extract_percentage(forecast_value)
    actual_nums = _extract_percentage(actual_value)
    
    if not forecast_nums or not actual_nums:
        return None
    
    # 计算差异（使用中点比较）
    forecast_mid = (forecast_nums[0] + forecast_nums[1]) / 2
    actual_mid = (actual_nums[0] + actual_nums[1]) / 2 if len(actual_nums) > 1 else actual_nums[0]
    
    diff_ratio = abs(actual_mid - forecast_mid) / max(abs(forecast_mid), 1)
    
    if diff_ratio > config.THRESHOLDS["forecast_diff_ratio"]:
        return {
            "type": "forecast_diff",
            "stock_code": stock_code,
            "stock_name": stock_name,
            "severity": "high",
            "detail": f"业绩预告与实际差异超过阈值 ({diff_ratio:.1%})",
            "old_value": forecast_value,
            "new_value": actual_value,
        }
    
    return None


def _extract_percentage(text: str) -> Optional[List[float]]:
    """
    从文本提取百分比数值
    
    例如: "增长20%-30%" -> [20.0, 30.0]
          "下降50%" -> [-50.0]
    """
    # 匹配百分比数字
    matches = re.findall(r"(\d+(?:\.\d+)?)\s*%", text)
    
    if not matches:
        return None
    
    nums = [float(m) for m in matches]
    
    # 如果是下降/减少，取负值
    if any(kw in text for kw in ["下降", "减少", "预减", "续亏", "首亏"]):
        nums = [-n for n in nums]
    
    return nums


def _check_audit_opinion(
    data: Dict[str, Any],
    stock_code: str,
    stock_name: str
) -> Optional[Dict[str, Any]]:
    """检测审计意见异常"""
    audit_opinion = data.get("audit_opinion")
    
    if not audit_opinion:
        return None
    
    # 标准无保留意见以外的都视为异常
    normal_opinions = [
        "标准无保留意见",
        "无保留意见",
        "标准无保留",
    ]
    
    is_normal = any(op in audit_opinion for op in normal_opinions)
    
    if not is_normal:
        return {
            "type": "audit_issue",
            "stock_code": stock_code,
            "stock_name": stock_name,
            "severity": "high",
            "detail": f"审计意见异常: {audit_opinion}",
            "old_value": None,
            "new_value": audit_opinion,
        }
    
    return None


if __name__ == "__main__":
    # 测试异常检测
    print("=" * 50)
    print("测试异常检测模块")
    print("=" * 50)
    
    # 测试用例1：披露日期变更
    current1 = {
        "stock_code": "000001",
        "stock_name": "平安银行",
        "disclosure_date": "2024-03-15",
    }
    previous1 = {
        "disclosure_date": "2024-03-20",
    }
    result1 = detect_anomalies(current1, previous1)
    print(f"测试1 (日期提前): {result1}")
    
    # 测试用例2：业绩差异过大
    current2 = {
        "stock_code": "000002",
        "stock_name": "万科A",
        "forecast_type": "预增",
        "forecast_value": "增长20%-30%",
        "actual_value": "增长50%",
    }
    result2 = detect_anomalies(current2, None)
    print(f"测试2 (业绩差异): {result2}")
    
    # 测试用例3：审计意见异常
    current3 = {
        "stock_code": "000003",
        "stock_name": "测试股票",
        "audit_opinion": "保留意见",
    }
    result3 = detect_anomalies(current3, None)
    print(f"测试3 (审计异常): {result3}")
