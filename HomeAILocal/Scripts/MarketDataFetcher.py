#!/usr/bin/env python3
# -*- coding: utf-8 -*-

import scrapy
import requests
import json
import time
import logging
from typing import List, Dict, Any
from scrapy.crawler import CrawlerProcess
from scrapy.utils.project import get_project_settings
from urllib.parse import urljoin, urlparse
import re

# 配置日志
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

class AIBoxSpider(scrapy.Spider):
    """AI算力盒子数据爬虫"""
    
    name = 'ai_box_spider'
    
    def __init__(self):
        self.results = []
        
    def start_requests(self):
        """生成初始请求"""
        urls = [
            # 京东搜索AI算力盒子
            'https://search.jd.com/Search?keyword=AI%E7%AE%97%E5%8A%9B%E7%9B%92%E5%AD%90&enc=utf-8',
            'https://search.jd.com/Search?keyword=%E7%AE%97%E5%8A%9B%E7%9B%92%E5%AD%90&enc=utf-8',
            # 淘宝搜索AI算力盒子
            'https://s.taobao.com/search?q=AI%E7%AE%97%E5%8A%9B%E7%9B%92%E5%AD%90',
            'https://s.taobao.com/search?q=%E7%AE%97%E5%8A%9B%E7%9B%92%E5%AD%90',
        ]
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1'
        }
        
        for url in urls:
            yield scrapy.Request(
                url=url,
                headers=headers,
                callback=self.parse_product_list,
                dont_filter=True,
                meta={'download_delay': 3}
            )
    
    def parse_product_list(self, response):
        """解析商品列表页"""
        try:
            domain = urlparse(response.url).netloc
            
            if 'jd.com' in domain:
                yield from self.parse_jd_products(response)
            elif 'taobao.com' in domain:
                yield from self.parse_taobao_products(response)
                
        except Exception as e:
            logger.error(f"解析商品列表失败: {e}")
    
    def parse_jd_products(self, response):
        """解析京东商品"""
        try:
            # 提取商品信息
            products = response.css('.gl-item')
            
            for product in products[:10]:  # 限制抓取数量
                try:
                    title = product.css('.p-name em::text').getall()
                    title = ''.join(title).strip() if title else ''
                    
                    price = product.css('.p-price .J_price::text').get()
                    if not price:
                        price = product.css('.p-price .price::text').get()
                    
                    # 提取评论数
                    comment_count = product.css('.p-commit a::text').get()
                    if comment_count:
                        comment_count = re.findall(r'\d+', comment_count)
                        comment_count = int(comment_count[0]) if comment_count else 0
                    else:
                        comment_count = 0
                    
                    # 商品链接
                    product_url = product.css('.p-name a::attr(href)').get()
                    if product_url:
                        product_url = urljoin('https://item.jd.com', product_url)
                    
                    if title and '算力' in title:
                        item = {
                            'platform': '京东',
                            'title': title,
                            'price': price,
                            'comment_count': comment_count,
                            'url': product_url,
                            'crawl_time': time.strftime('%Y-%m-%d %H:%M:%S')
                        }
                        self.results.append(item)
                        logger.info(f"京东商品: {title[:50]}...")
                        
                except Exception as e:
                    logger.warning(f"解析京东单个商品失败: {e}")
                    continue
                    
        except Exception as e:
            logger.error(f"解析京东商品列表失败: {e}")
    
    def parse_taobao_products(self, response):
        """解析淘宝商品"""
        try:
            # 淘宝反爬较严格，简化处理
            products = response.css('.item')
            
            for product in products[:10]:  # 限制抓取数量
                try:
                    title = product.css('.title a::text').get()
                    if not title:
                        title = product.css('.title::text').get()
                    
                    price = product.css('.price .num::text').get()
                    
                    # 销量信息
                    sales = product.css('.deal-cnt::text').get()
                    sales_count = 0
                    if sales:
                        sales_match = re.findall(r'\d+', sales)
                        sales_count = int(sales_match[0]) if sales_match else 0
                    
                    product_url = product.css('.title a::attr(href)').get()
                    if product_url and not product_url.startswith('http'):
                        product_url = 'https:' + product_url
                    
                    if title and '算力' in title:
                        item = {
                            'platform': '淘宝',
                            'title': title.strip(),
                            'price': price,
                            'sales_count': sales_count,
                            'url': product_url,
                            'crawl_time': time.strftime('%Y-%m-%d %H:%M:%S')
                        }
                        self.results.append(item)
                        logger.info(f"淘宝商品: {title[:50]}...")
                        
                except Exception as e:
                    logger.warning(f"解析淘宝单个商品失败: {e}")
                    continue
                    
        except Exception as e:
            logger.error(f"解析淘宝商品列表失败: {e}")

class MarketDataFetcher:
    """市场数据抓取器"""
    
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        })
    
    def fetch_weekly_market_data(self) -> List[Dict[str, Any]]:
        """
        获取本周AI算力盒子市场数据
        
        Returns:
            List[Dict]: 包含商品信息的字典列表
        """
        logger.info("开始抓取AI算力盒子市场数据...")
        
        all_data = []
        
        # 使用Scrapy抓取数据
        scrapy_data = self._fetch_with_scrapy()
        all_data.extend(scrapy_data)
        
        # 使用requests抓取什么值得买数据
        smzdm_data = self._fetch_smzdm_data()
        all_data.extend(smzdm_data)
        
        # 数据去重和清洗
        cleaned_data = self._clean_data(all_data)
        
        logger.info(f"共抓取到 {len(cleaned_data)} 条市场数据")
        return cleaned_data
    
    def _fetch_with_scrapy(self) -> List[Dict[str, Any]]:
        """使用Scrapy抓取数据"""
        try:
            # 配置Scrapy设置
            settings = get_project_settings()
            settings.update({
                'USER_AGENT': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                'ROBOTSTXT_OBEY': False,
                'DOWNLOAD_DELAY': 2,
                'RANDOMIZE_DOWNLOAD_DELAY': True,
                'CONCURRENT_REQUESTS': 1,
                'CONCURRENT_REQUESTS_PER_DOMAIN': 1,
                'COOKIES_ENABLED': True,
                'TELNETCONSOLE_ENABLED': False,
                'LOG_LEVEL': 'WARNING'
            })
            
            # 运行爬虫
            process = CrawlerProcess(settings)
            spider = AIBoxSpider()
            process.crawl(spider)
            process.start(stop_after_crawl=True)
            
            return spider.results
            
        except Exception as e:
            logger.error(f"Scrapy抓取失败: {e}")
            return []
    
    def _fetch_smzdm_data(self) -> List[Dict[str, Any]]:
        """抓取什么值得买数据"""
        try:
            smzdm_data = []
            
            # 什么值得买搜索API
            search_urls = [
                'https://search-api.smzdm.com/v1/search?keyword=AI算力盒子',
                'https://search-api.smzdm.com/v1/search?keyword=算力盒子'
            ]
            
            for url in search_urls:
                try:
                    response = self.session.get(url, timeout=10)
                    
                    if response.status_code == 200:
                        data = response.json()
                        
                        # 解析搜索结果
                        if 'data' in data and 'list' in data['data']:
                            for item in data['data']['list'][:5]:  # 限制数量
                                try:
                                    smzdm_item = {
                                        'platform': '什么值得买',
                                        'title': item.get('title', ''),
                                        'price': item.get('price', ''),
                                        'worth_count': item.get('worth_count', 0),
                                        'url': item.get('url', ''),
                                        'crawl_time': time.strftime('%Y-%m-%d %H:%M:%S')
                                    }
                                    smzdm_data.append(smzdm_item)
                                    
                                except Exception as e:
                                    logger.warning(f"解析什么值得买单条数据失败: {e}")
                                    continue
                    
                    time.sleep(2)  # 防止请求过快
                    
                except Exception as e:
                    logger.warning(f"请求什么值得买失败: {e}")
                    continue
            
            logger.info(f"从什么值得买获取到 {len(smzdm_data)} 条数据")
            return smzdm_data
            
        except Exception as e:
            logger.error(f"抓取什么值得买数据失败: {e}")
            return []
    
    def _clean_data(self, data: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """清洗和去重数据"""
        try:
            # 去重
            seen_titles = set()
            cleaned_data = []
            
            for item in data:
                title = item.get('title', '').strip()
                
                # 跳过空标题和重复标题
                if not title or title in seen_titles:
                    continue
                
                # 过滤不相关的商品
                if not any(keyword in title.lower() for keyword in ['算力', 'ai', '盒子', 'gpu']):
                    continue
                
                seen_titles.add(title)
                
                # 标准化价格格式
                price = item.get('price', '')
                if price:
                    # 提取数字价格
                    price_match = re.findall(r'[\d.]+', str(price))
                    if price_match:
                        try:
                            item['price_numeric'] = float(price_match[0])
                        except:
                            item['price_numeric'] = 0
                    else:
                        item['price_numeric'] = 0
                else:
                    item['price_numeric'] = 0
                
                cleaned_data.append(item)
            
            # 按价格排序
            cleaned_data.sort(key=lambda x: x.get('price_numeric', 0), reverse=True)
            
            return cleaned_data
            
        except Exception as e:
            logger.error(f"数据清洗失败: {e}")
            return data

def main():
    """测试函数"""
    fetcher = MarketDataFetcher()
    data = fetcher.fetch_weekly_market_data()
    
    print(f"获取到 {len(data)} 条数据:")
    for item in data[:5]:  # 打印前5条
        print(json.dumps(item, ensure_ascii=False, indent=2))

if __name__ == '__main__':
    main()