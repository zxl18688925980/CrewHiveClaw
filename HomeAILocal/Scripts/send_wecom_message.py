import os
import logging
from dotenv import load_dotenv
import requests
import json

# 加载环境变量（从 HomeAI 根目录）
load_dotenv(os.path.join(os.path.dirname(__file__), '../.env'))

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

WECOM_CORP_ID  = os.getenv('WECOM_CORP_ID')
WECOM_SECRET   = os.getenv('WECOM_SECRET')
WECOM_AGENT_ID = os.getenv('WECOM_AGENT_ID')
WECOM_OWNER_ID = os.getenv('WECOM_OWNER_ID')


def _get_access_token() -> str:
    """获取企业微信 access_token"""
    r = requests.get(
        'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
        params={'corpid': WECOM_CORP_ID, 'corpsecret': WECOM_SECRET},
        timeout=10
    )
    r.raise_for_status()
    data = r.json()
    if data.get('errcode', 0) != 0:
        raise RuntimeError(f"gettoken 失败: {data.get('errmsg')}")
    return data['access_token']


def send_message_to_wecom(message: str) -> bool:
    """
    使用企业微信应用 API 发送消息给业主
    （使用 WECOM_CORP_ID + WECOM_SECRET + WECOM_AGENT_ID）
    """
    if not message or not message.strip():
        logger.warning("消息内容为空，跳过发送")
        return False

    if not all([WECOM_CORP_ID, WECOM_SECRET, WECOM_AGENT_ID, WECOM_OWNER_ID]):
        logger.error("企业微信环境变量未完整配置，跳过推送")
        logger.info("消息内容：\n" + message)
        return False

    try:
        token = _get_access_token()
        resp = requests.post(
            f'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={token}',
            json={
                'touser': WECOM_OWNER_ID,
                'msgtype': 'text',
                'agentid': int(WECOM_AGENT_ID),
                'text': {'content': message.strip()}
            },
            timeout=15
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get('errcode', 0) == 0:
            logger.info(f"消息发送成功: {message[:50]}...")
            return True
        else:
            logger.error(f"企业微信API返回错误: {result}")
            return False

    except Exception as e:
        logger.error(f"发送消息时发生异常: {str(e)}")
        return False

def send_markdown_message_to_wecom(title: str, content: str) -> bool:
    """
    发送Markdown格式消息到家庭企业微信群
    
    Args:
        title: 消息标题
        content: Markdown格式的消息内容
        
    Returns:
        bool: 发送成功返回True，失败返回False
    """
    try:
        wecom_bot = WeComBot()
        
        payload = {
            "msgtype": "markdown",
            "markdown": {
                "content": content
            }
        }
        
        headers = {
            "Content-Type": "application/json"
        }
        
        response = requests.post(
            wecom_bot.webhook_url,
            data=json.dumps(payload, ensure_ascii=False).encode('utf-8'),
            headers=headers,
            timeout=30
        )
        
        if response.status_code == 200:
            result = response.json()
            if result.get('errcode') == 0:
                logger.info(f"Markdown消息发送成功: {title}")
                return True
            else:
                logger.error(f"企业微信API返回错误: {result}")
                return False
        else:
            logger.error(f"HTTP请求失败: {response.status_code}, {response.text}")
            return False
            
    except Exception as e:
        logger.error(f"发送Markdown消息时发生异常: {str(e)}")
        return False

if __name__ == "__main__":
    # 测试消息发送功能
    test_message = "这是一条测试消息，用于验证企业微信消息发送功能。"
    result = send_message_to_wecom(test_message)
    print(f"消息发送结果: {'成功' if result else '失败'}")