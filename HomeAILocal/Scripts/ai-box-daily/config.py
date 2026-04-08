#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import os
import sys
from pathlib import Path
from dotenv import load_dotenv

dotenv_path = Path(__file__).parent.parent.parent / '.env'
load_dotenv(dotenv_path)

CONFIG = {
    'target_user': 'ZiFeiYu',
    'push_time': '9:00',
    'keywords': ['AI算力盒子', 'GPU服务器', '算力主机'],
    'sources': ['京东', '天猫'],
    'ollama_url': 'http://localhost:11434/api/generate',
    'ollama_model': 'homeai-assistant',
    'wecom_url': 'http://localhost:3003/api/wecom/send-message',
    'log_dir': Path(__file__).parent.parent.parent / 'logs',
    'data_dir': Path(__file__).parent.parent.parent / 'data' / 'ai-box-daily',
}
