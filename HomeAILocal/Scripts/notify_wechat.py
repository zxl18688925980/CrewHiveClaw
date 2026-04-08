"""
企业微信消息推送模块
负责将股票财报披露信息推送到企业微信群
"""

import os
import json
import logging
from typing import Dict, Any
import requests

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class WeComNotifier:
    """企业微信通知器"""
    
    def __init__(self):
        """初始化企业微信配置"""
        self.webhook_url = os.getenv('WECOM_WEBHOOK_URL')
        self.bot_key = os.getenv('WECOM_BOT_KEY')
        
        if not self.webhook_url:
            logger.error("未设置企业微信Webhook URL")
            raise ValueError("WECOM_WEBHOOK_URL environment variable is required")
    
    def _build_message_payload(self, message: str) -> Dict[str, Any]:
        """构建消息负载"""
        return {
            "msgtype": "text",
            "text": {
                "content": message,
                "mentioned_list": ["@all"]  # @所有人
            }
        }
    
    def _send_request(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """发送HTTP请求到企业微信"""
        headers = {
            'Content-Type': 'application/json'
        }
        
        try:
            response = requests.post(
                self.webhook_url,
                data=json.dumps(payload, ensure_ascii=False),
                headers=headers,
                timeout=30
            )
            response.raise_for_status()
            return response.json()
            
        except requests.exceptions.RequestException as e:
            logger.error(f"发送企业微信消息失败: {e}")
            raise
        except json.JSONDecodeError as e:
            logger.error(f"解析响应JSON失败: {e}")
            raise

def send_notification(message: str) -> bool:
    """
    发送消息到企业微信群
    
    Args:
        message (str): 要发送的文本消息
        
    Returns:
        bool: 发送成功返回True，失败返回False
    """
    try:
        # 参数验证
        if not message or not message.strip():
            logger.warning("消息内容为空，跳过发送")
            return False
        
        # 初始化通知器
        notifier = WeComNotifier()
        
        # 构建消息负载
        payload = notifier._build_message_payload(message.strip())
        
        # 发送请求
        response = notifier._send_request(payload)
        
        # 检查响应
        if response.get('errcode') == 0:
            logger.info("企业微信消息发送成功")
            return True
        else:
            error_msg = response.get('errmsg', '未知错误')
            logger.error(f"企业微信消息发送失败: {error_msg}")
            return False
            
    except ValueError as e:
        logger.error(f"配置错误: {e}")
        return False
    except Exception as e:
        logger.error(f"发送企业微信消息时发生未预期错误: {e}")
        return False

def test_notification():
    """测试企业微信通知功能"""
    test_message = """📊 A股财报披露提醒测试

🏢 测试公司 (000001)
📅 披露日期: 2024-01-15
📝 报告类型: 年度报告

这是一条测试消息，用于验证企业微信推送功能。"""
    
    result = send_notification(test_message)
    if result:
        print("✅ 测试通知发送成功")
    else:
        print("❌ 测试通知发送失败")
    
    return result

if __name__ == "__main__":
    # 运行测试
    test_notification()