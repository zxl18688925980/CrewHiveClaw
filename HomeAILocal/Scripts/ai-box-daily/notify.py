#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import requests
import json
import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, Any
from config import CONFIG

logger = logging.getLogger(__name__)


def save_record(record: Dict[str, Any]) -> None:
    data_dir = Path(CONFIG['data_dir'])
    data_dir.mkdir(parents=True, exist_ok=True)
    
    record_file = data_dir / 'sent_records.jsonl'
    with open(record_file, 'a', encoding='utf-8') as f:
        f.write(json.dumps(record, ensure_ascii=False) + '\n')


def send(user_id: str, text: str) -> bool:
    try:
        payload = {
            'userId': user_id,
            'text': text
        }
        
        response = requests.post(
            CONFIG['wecom_url'],
            json=payload,
            timeout=10
        )
        
        if response.status_code == 200:
            result = response.json()
            
            save_record({
                'timestamp': datetime.now().isoformat(),
                'user_id': user_id,
                'status': 'success',
                'response': result
            })
            
            logger.info(f"推送成功: {user_id}")
            return True
        else:
            logger.error(f"推送失败: HTTP {response.status_code}")
            
            save_record({
                'timestamp': datetime.now().isoformat(),
                'user_id': user_id,
                'status': 'failed',
                'error': f"HTTP {response.status_code}"
            })
            
            return False
            
    except Exception as e:
        logger.error(f"推送异常: {e}")
        
        save_record({
            'timestamp': datetime.now().isoformat(),
            'user_id': user_id,
            'status': 'error',
            'error': str(e)
        })
        
        return False


def send_with_retry(user_id: str, text: str, max_retries: int = 1) -> bool:
    for attempt in range(max_retries + 1):
        if send(user_id, text):
            return True
        
        if attempt < max_retries:
            logger.info(f"重试推送 ({attempt + 1}/{max_retries})")
    
    return False
