#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
推送模块 - 通过企业微信推送日报
"""

import requests
from typing import Dict, Any

import config


def push_to_wecom(user_id: str, content: str, msg_type: str = "text") -> Dict[str, Any]:
    """
    通过 wecom-entrance 推送消息
    
    Args:
        user_id: 企业微信用户ID
        content: 消息内容
        msg_type: 消息类型 (text/markdown) - 当前仅支持 text
        
    Returns:
        推送结果
    """
    # 使用正确的 wecom-entrance API
    url = "http://localhost:3003/api/wecom/send-message"
    
    payload = {
        "userId": user_id,
        "text": content,
    }
    
    try:
        print(f"正在推送消息给用户 {user_id}...")
        resp = requests.post(url, json=payload, timeout=10)
        result = resp.json()
        
        if result.get("success"):
            print(f"推送成功 ✓")
        else:
            print(f"推送失败: {result.get('error', '未知错误')}")
        
        return result
        
    except Exception as e:
        print(f"推送请求失败: {e}")
        return {"errcode": -1, "errmsg": str(e)}


def push_daily_report(report: str) -> Dict[str, Any]:
    """
    推送日报
    
    Args:
        report: 日报内容 (Markdown格式)
        
    Returns:
        推送结果
    """
    user_id = config.PUSH_CONFIG.get("target_user", "ZiFeiYu")
    
    # 企业微信的 text 消息有长度限制，超长内容需要截断或分段
    max_length = 2048
    
    if len(report) > max_length:
        print(f"日报内容过长 ({len(report)} 字符)，进行截断...")
        report = report[:max_length - 100] + "\n\n... (内容过长，已截断)"
    
    return push_to_wecom(user_id, report)


def push_test_message(user_id: str = None) -> Dict[str, Any]:
    """发送测试消息"""
    if not user_id:
        user_id = config.PUSH_CONFIG.get("target_user", "ZiFeiYu")
    
    test_content = "【测试消息】\nA股年报监控系统推送测试成功 ✓"
    return push_to_wecom(user_id, test_content)


if __name__ == "__main__":
    # 测试推送
    print("=" * 50)
    print("测试推送模块")
    print("=" * 50)
    
    # 发送测试消息
    result = push_test_message()
    print(f"推送结果: {result}")
