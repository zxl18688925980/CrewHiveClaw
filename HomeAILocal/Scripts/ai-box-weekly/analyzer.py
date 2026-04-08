#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""数据分析模块 - 分析价格趋势、热门产品"""

import json
import logging
from typing import Dict, Any, List
from pathlib import Path
from datetime import datetime

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

CACHE_FILE = Path("/Users/xinbinanshan/HomeAI/Data/ai-box-cache.jsonl")


def load_cache() -> List[Dict[str, Any]]:
    """加载历史缓存数据"""
    if not CACHE_FILE.exists():
        return []
    
    items = []
    try:
        with open(CACHE_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line:
                    items.append(json.loads(line))
    except Exception as e:
        logger.warning(f"加载缓存失败: {e}")
    
    return items


def save_cache(data: Dict[str, Any]) -> None:
    """保存数据到缓存"""
    CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
    
    record = {
        'timestamp': datetime.now().isoformat(),
        'data': data
    }
    
    with open(CACHE_FILE, 'a', encoding='utf-8') as f:
        f.write(json.dumps(record, ensure_ascii=False) + '\n')
    
    logger.info(f"数据已缓存到 {CACHE_FILE}")


def analyze(new_data: Dict[str, Any]) -> Dict[str, Any]:
    """分析数据"""
    logger.info("开始数据分析...")
    
    products = new_data.get('jd_products', [])
    discussions = new_data.get('zhihu_discussions', [])
    
    if not products:
        logger.warning("无产品数据可供分析")
        return {
            'summary': '本周暂无有效数据',
            'products': [],
            'price_stats': {},
            'trends': []
        }
    
    valid_products = [p for p in products if p.get('price_numeric', 0) > 0]
    
    prices = [p['price_numeric'] for p in valid_products]
    price_stats = {}
    if prices:
        price_stats = {
            'avg': round(sum(prices) / len(prices), 2),
            'min': min(prices),
            'max': max(prices),
            'count': len(prices)
        }
    
    sorted_by_price = sorted(valid_products, key=lambda x: x.get('price_numeric', 0))
    cheapest = sorted_by_price[:5] if sorted_by_price else []
    most_expensive = sorted_by_price[-5:][::-1] if sorted_by_price else []
    
    old_cache = load_cache()
    price_trend = "首次采集，无历史对比"
    if old_cache and len(old_cache) > 0:
        last_record = old_cache[-1]
        old_products = last_record.get('data', {}).get('jd_products', [])
        old_prices = [p.get('price_numeric', 0) for p in old_products if p.get('price_numeric', 0) > 0]
        if old_prices and price_stats:
            old_avg = sum(old_prices) / len(old_prices)
            change = ((price_stats['avg'] - old_avg) / old_avg) * 100
            if change > 5:
                price_trend = f"均价上涨 {change:.1f}%"
            elif change < -5:
                price_trend = f"均价下降 {abs(change):.1f}%"
            else:
                price_trend = f"均价基本持平（变化 {change:.1f}%）"
    
    hot_keywords = []
    all_names = ' '.join([p.get('name', '') for p in products])
    keyword_counts = {}
    for kw in ['RTX', '4090', '4080', '4070', 'NVIDIA', 'AMD', 'Intel', 'Mini', '便携', '静音', '散热']:
        count = all_names.lower().count(kw.lower())
        if count > 0:
            keyword_counts[kw] = count
    
    hot_keywords = sorted(keyword_counts.items(), key=lambda x: x[1], reverse=True)[:5]
    
    result = {
        'summary': f"共采集 {len(products)} 款产品，{len(discussions)} 条讨论",
        'products': products[:20],
        'price_stats': price_stats,
        'cheapest': cheapest,
        'most_expensive': most_expensive,
        'price_trend': price_trend,
        'hot_keywords': hot_keywords,
        'discussions': discussions[:5],
        'analysis_time': datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    }
    
    save_cache(new_data)
    
    logger.info("数据分析完成")
    return result


if __name__ == "__main__":
    from scraper import scrape_all
    data = scrape_all()
    result = analyze(data)
    print(json.dumps(result, ensure_ascii=False, indent=2))
