#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import requests
import logging
from typing import List, Dict, Any
from config import CONFIG

logger = logging.getLogger(__name__)


def generate_fallback_summary(items: List[Dict[str, Any]]) -> str:
    lines = []
    for item in items:
        name = item.get('name', '未知产品')[:25]
        price = item.get('price', '暂无报价')
        lines.append(f"• {name} - ¥{price}")
    return '\n'.join(lines)


def generate_llm_summary(items: List[Dict[str, Any]]) -> str:
    try:
        product_list = '\n'.join([
            f"{i+1}. {item.get('name', '未知')} - ¥{item.get('price', '暂无')} ({item.get('comments', '0')}评价)"
            for i, item in enumerate(items[:6])
        ])
        
        prompt = f"""你是一个科技产品分析师。请用简洁的中文总结以下AI算力盒子产品信息，每条不超过15字，突出产品特点或价格优势。

产品列表:
{product_list}

请直接输出总结内容，每行一条，不要序号。"""

        response = requests.post(
            CONFIG['ollama_url'],
            json={
                'model': CONFIG['ollama_model'],
                'prompt': prompt,
                'stream': False,
                'options': {
                    'temperature': 0.3,
                    'num_predict': 200
                }
            },
            timeout=30
        )
        
        if response.status_code == 200:
            result = response.json()
            summary = result.get('response', '').strip()
            if summary and len(summary) > 10:
                return summary
        
    except Exception as e:
        logger.warning(f"LLM 生成失败: {e}")
    
    return generate_fallback_summary(items)


def generate(items: List[Dict[str, Any]]) -> str:
    if not items:
        return "今日暂无新产品信息"
    
    return generate_llm_summary(items)
