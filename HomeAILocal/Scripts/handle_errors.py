import logging
from typing import Exception
from modules.send_wecom_message import send_message_to_wecom

# 配置日志
logging.basicConfig(level=logging.ERROR, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

def handle_akshare_failure(error: Exception) -> None:
    """
    处理 akshare 请求失败时的错误推送
    
    Args:
        error: 异常信息
    """
    try:
        # 记录错误日志
        logger.error(f"Akshare请求失败: {str(error)}")
        
        # 构建错误消息
        error_message = f"""
📊 A股财报披露提醒系统 - 错误通知
        
❌ 数据获取失败
时间: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
错误信息: {str(error)}

💡 可能原因:
• 网络连接问题
• akshare接口异常
• 数据源暂时不可用

🔧 建议操作:
• 稍后重试
• 检查网络连接
• 联系技术支持
        """
        
        # 发送错误消息到企业微信群
        send_message_to_wecom(error_message)
        
        logger.info("错误消息已发送到企业微信群")
        
    except Exception as send_error:
        # 如果发送消息也失败，只记录日志
        logger.error(f"发送错误消息失败: {str(send_error)}")
        logger.error(f"原始错误: {str(error)}")

def handle_general_error(error: Exception, context: str = "") -> None:
    """
    处理一般性错误
    
    Args:
        error: 异常信息
        context: 错误上下文
    """
    try:
        logger.error(f"系统错误 [{context}]: {str(error)}")
        
        error_message = f"""
📊 A股财报披露提醒系统 - 系统错误
        
⚠️ 系统异常
时间: {__import__('datetime').datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
模块: {context}
错误信息: {str(error)}

🔧 系统正在尝试自动恢复...
        """
        
        send_message_to_wecom(error_message)
        logger.info(f"系统错误消息已发送 [{context}]")
        
    except Exception as send_error:
        logger.error(f"发送系统错误消息失败: {str(send_error)}")
        logger.error(f"原始错误 [{context}]: {str(error)}")