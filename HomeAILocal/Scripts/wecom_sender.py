#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
企业微信推送基础设施 — 系统工程层
使用 app API（WECOM_CORP_ID + WECOM_SECRET + WECOM_AGENT_ID + WECOM_OWNER_ID）
所有需要推送企业微信的脚本直接 import 本文件，不要自行实现推送逻辑。

用法：
    from wecom_sender import send_to_wecom
    ok = send_to_wecom("消息内容")
"""

import os
import logging
import requests
from dotenv import load_dotenv

load_dotenv(os.path.join(os.path.dirname(__file__), '../.env'))

logger = logging.getLogger(__name__)

CORP_ID   = os.getenv('WECOM_CORP_ID')
SECRET    = os.getenv('WECOM_SECRET')
AGENT_ID  = os.getenv('WECOM_AGENT_ID')
OWNER_ID  = os.getenv('WECOM_OWNER_ID')


def _get_token() -> str:
    r = requests.get(
        'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
        params={'corpid': CORP_ID, 'corpsecret': SECRET},
        timeout=10
    )
    r.raise_for_status()
    data = r.json()
    if data.get('errcode', 0) != 0:
        raise RuntimeError(f"gettoken 失败: {data.get('errmsg')}")
    return data['access_token']


def send_to_wecom(message: str) -> bool:
    """
    发送文本消息给业主（WECOM_OWNER_ID）。
    成功返回 True，失败返回 False（不抛异常，方便 cron 脚本调用）。
    """
    if not message or not message.strip():
        logger.warning("消息为空，跳过推送")
        return False

    if not all([CORP_ID, SECRET, AGENT_ID, OWNER_ID]):
        logger.error("企业微信环境变量未完整配置（WECOM_CORP_ID/SECRET/AGENT_ID/OWNER_ID）")
        logger.info("消息内容：\n" + message)
        return False

    try:
        token = _get_token()
        resp = requests.post(
            f'https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={token}',
            json={
                'touser': OWNER_ID,
                'msgtype': 'text',
                'agentid': int(AGENT_ID),
                'text': {'content': message.strip()}
            },
            timeout=15
        )
        resp.raise_for_status()
        result = resp.json()
        if result.get('errcode', 0) == 0:
            logger.info("企业微信推送成功")
            return True
        logger.error(f"企业微信 API 错误: {result}")
        return False
    except Exception as e:
        logger.error(f"企业微信推送异常: {e}")
        return False


if __name__ == '__main__':
    import sys
    logging.basicConfig(level=logging.INFO)
    msg = sys.argv[1] if len(sys.argv) > 1 else "测试推送 from wecom_sender.py"
    ok = send_to_wecom(msg)
    sys.exit(0 if ok else 1)
