#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""企业微信推送模块"""

import requests
import logging
import json
from typing import Optional

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

WECOM_GROUP_API = "http://localhost:3003/api/wecom/send-to-group"
WECOM_FAMILY_CHAT_ID = None


def push_to_wecom(content: str, title: str = "AI算力盒子周报") -> bool:
    """通过 wecom-entrance 推送消息到家庭群"""
    
    if not content or not content.strip():
        logger.warning("推送内容为空")
        return False
    
    max_len = 4000
    if len(content) > max_len:
        content = content[:max_len] + "\n\n... (内容过长已截断)"
    
    payload = {"text": content}
    
    try:
        logger.info(f"正在推送报告到企业微信群...")
        resp = requests.post(
            WECOM_GROUP_API,
            json=payload,
            headers={"Content-Type": "application/json"},
            timeout=30
        )
        
        if resp.status_code == 200:
            result = resp.json()
            if result.get('success'):
                logger.info("✅ 推送成功")
                return True
            else:
                logger.error(f"推送失败: {result}")
        else:
            logger.error(f"HTTP 错误: {resp.status_code} - {resp.text}")
            
    except requests.exceptions.ConnectionError:
        logger.error("无法连接 wecom-entrance (localhost:3003)，请检查服务是否运行")
    except Exception as e:
        logger.error(f"推送异常: {e}")
    
    return False


def push_text(text: str) -> bool:
    """推送纯文本消息"""
    payload = {"text": text}
    
    try:
        resp = requests.post(
            WECOM_GROUP_API,
            json=payload,
            timeout=15
        )
        return resp.status_code == 200
    except Exception as e:
        logger.error(f"推送失败: {e}")
        return False


if __name__ == "__main__":
    test_content = """# AI 算力盒子周报

**测试消息**

这是一个测试推送。"""
    
    result = push_to_wecom(test_content)
    print(f"推送结果: {'成功' if result else '失败'}")
