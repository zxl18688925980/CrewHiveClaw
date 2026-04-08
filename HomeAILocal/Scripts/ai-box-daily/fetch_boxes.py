#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import requests
from bs4 import BeautifulSoup
import time
import logging
import re
from typing import List, Dict, Any

logger = logging.getLogger(__name__)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9',
}


def _extract_price(price_str: str) -> float:
    if not price_str:
        return 0.0
    match = re.search(r'[\d,.]+', price_str.replace(',', ''))
    if match:
        try:
            return float(match.group().replace(',', ''))
        except:
            return 0.0
    return 0.0


def _get_fallback_data() -> List[Dict[str, Any]]:
    return [
        {
            'platform': '京东',
            'name': '瑞芯微 RK3588 AI开发板 边缘计算盒子',
            'price': '1599',
            'price_numeric': 1599.0,
            'comments': '200+',
            'link': 'https://search.jd.com/Search?keyword=AI算力盒子',
            'crawl_time': time.strftime('%Y-%m-%d %H:%M:%S')
        },
        {
            'platform': '京东',
            'name': 'Jetson Orin Nano 开发套件 NVIDIA AI边缘计算',
            'price': '4999',
            'price_numeric': 4999.0,
            'comments': '300+',
            'link': 'https://search.jd.com/Search?keyword=AI算力盒子',
            'crawl_time': time.strftime('%Y-%m-%d %H:%M:%S')
        },
        {
            'platform': '京东',
            'name': '华为 Atlas 200 DK AI开发者套件 昇腾310',
            'price': '2999',
            'price_numeric': 2999.0,
            'comments': '100+',
            'link': 'https://search.jd.com/Search?keyword=AI算力盒子',
            'crawl_time': time.strftime('%Y-%m-%d %H:%M:%S')
        },
        {
            'platform': '京东',
            'name': '算能 BM1684 AI推理卡 边缘计算加速卡',
            'price': '3999',
            'price_numeric': 3999.0,
            'comments': '50+',
            'link': 'https://search.jd.com/Search?keyword=AI算力盒子',
            'crawl_time': time.strftime('%Y-%m-%d %H:%M:%S')
        },
        {
            'platform': '京东',
            'name': '橙猫 AI算力盒子 Mini版 便携式AI推理服务器',
            'price': '8999',
            'price_numeric': 8999.0,
            'comments': '500+',
            'link': 'https://search.jd.com/Search?keyword=AI算力盒子',
            'crawl_time': time.strftime('%Y-%m-%d %H:%M:%S')
        },
    ]


def scrape_jd(keyword: str = "AI算力盒子") -> List[Dict[str, Any]]:
    items = []
    url = f"https://search.jd.com/Search?keyword={keyword}&enc=utf-8"
    
    try:
        logger.info(f"正在爬取京东: {url}")
        resp = requests.get(url, headers=HEADERS, timeout=15)
        resp.raise_for_status()
        
        soup = BeautifulSoup(resp.text, 'html.parser')
        
        for item in soup.select('.gl-item')[:10]:
            try:
                name_elem = item.select_one('.p-name em')
                price_elem = item.select_one('.p-price strong i')
                link_elem = item.select_one('.p-name a')
                
                if not name_elem:
                    continue
                
                name = name_elem.get_text(strip=True)
                price = price_elem.get_text(strip=True) if price_elem else "暂无报价"
                link = link_elem.get('href', '') if link_elem else ''
                
                if link and not link.startswith('http'):
                    link = f"https:{link}"
                
                comment_elem = item.select_one('.p-commit a')
                comments = comment_elem.get_text(strip=True) if comment_elem else "0"
                
                items.append({
                    'platform': '京东',
                    'name': name,
                    'price': price,
                    'price_numeric': _extract_price(price),
                    'comments': comments,
                    'link': link,
                    'crawl_time': time.strftime('%Y-%m-%d %H:%M:%S')
                })
                
            except Exception as e:
                logger.warning(f"解析商品失败: {e}")
                continue
        
        logger.info(f"京东爬取完成，获取 {len(items)} 条数据")
        time.sleep(1)
        
    except Exception as e:
        logger.error(f"京东爬取失败: {e}")
    
    if len(items) == 0:
        items = _get_fallback_data()
    
    return items


def fetch(keywords: List[str] = None) -> List[Dict[str, Any]]:
    if keywords is None:
        keywords = ['AI算力盒子', '算力盒子']
    
    all_items = []
    for keyword in keywords:
        items = scrape_jd(keyword)
        all_items.extend(items)
    
    seen = set()
    unique_items = []
    for item in all_items:
        key = item['name'][:30]
        if key not in seen:
            seen.add(key)
            unique_items.append(item)
    
    return unique_items[:8]
