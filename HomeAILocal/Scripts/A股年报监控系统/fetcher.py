#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
数据抓取模块 - 从巨潮资讯网抓取年报披露信息
"""

import re
import time
import random
import requests
from bs4 import BeautifulSoup
from typing import Dict, Any, Optional, List

import config


def _make_request(url: str, params: dict = None) -> Optional[requests.Response]:
    """发起HTTP请求，带重试"""
    for attempt in range(config.DATA_SOURCE["retry_times"]):
        try:
            resp = requests.get(
                url,
                params=params,
                headers=config.REQUEST_HEADERS,
                timeout=config.DATA_SOURCE["request_timeout"],
            )
            resp.raise_for_status()
            return resp
        except Exception as e:
            print(f"请求失败 (尝试 {attempt + 1}/{config.DATA_SOURCE['retry_times']}): {e}")
            if attempt < config.DATA_SOURCE["retry_times"] - 1:
                time.sleep(config.DATA_SOURCE["retry_delay"] + random.uniform(0, 1))
    return None


def fetch_annual_report_info(stock_code: str) -> Optional[Dict[str, Any]]:
    """
    抓取指定股票的年报披露信息
    
    返回格式:
    {
        "stock_code": "000001",
        "stock_name": "平安银行",
        "report_year": 2023,
        "disclosure_date": "2024-03-15",
        "forecast_type": "预增",  # 预增/预减/续亏/扭亏/首亏/续盈 等
        "forecast_value": "增长50%-70%",
        "actual_value": "增长65%",
        "audit_opinion": "标准无保留意见",
        "source_url": "http://..."
    }
    """
    print(f"正在抓取股票 {stock_code} 的年报信息...")
    
    # 巨潮资讯搜索接口
    search_url = config.DATA_SOURCE["cninfo_search_url"]
    params = {
        "notautosubmit": "",
        "keyWord": stock_code,
        "type": "sh",  # 上市公司公告
    }
    
    resp = _make_request(search_url, params)
    if not resp:
        print(f"无法获取股票 {stock_code} 的搜索结果")
        return None
    
    # 解析搜索结果页面
    soup = BeautifulSoup(resp.text, "lxml")
    
    # 提取年报相关公告链接
    annual_report_links = _extract_annual_report_links(soup, stock_code)
    
    if not annual_report_links:
        print(f"未找到股票 {stock_code} 的年报公告")
        return None
    
    # 抓取最新年报详情
    for link_info in annual_report_links[:1]:  # 只取最新的
        detail_data = _fetch_report_detail(link_info, stock_code)
        if detail_data:
            return detail_data
    
    return None


def _extract_annual_report_links(soup: BeautifulSoup, stock_code: str) -> List[Dict[str, str]]:
    """从搜索结果页提取年报链接"""
    links = []
    
    # 巨潮资讯的搜索结果通常在特定的div或table中
    # 这里需要根据实际页面结构调整选择器
    result_items = soup.select("div.result-list a, table tbody tr a")
    
    for item in result_items:
        href = item.get("href", "")
        title = item.get_text(strip=True)
        
        # 过滤年报相关公告
        if any(kw in title for kw in ["年度报告", "年报", "业绩预告", "审计报告"]):
            # 确保链接完整
            if href.startswith("/"):
                href = "http://www.cninfo.com.cn" + href
            
            links.append({
                "url": href,
                "title": title,
            })
    
    return links


def _fetch_report_detail(link_info: Dict[str, str], stock_code: str) -> Optional[Dict[str, Any]]:
    """抓取公告详情页"""
    resp = _make_request(link_info["url"])
    if not resp:
        return None
    
    soup = BeautifulSoup(resp.text, "lxml")
    
    # 解析详情页内容
    # 这里需要根据巨潮资讯的实际页面结构提取信息
    detail_data = {
        "stock_code": stock_code,
        "source_url": link_info["url"],
    }
    
    # 尝试从标题提取年份
    title = link_info.get("title", "")
    year_match = re.search(r"(\d{4})年", title)
    if year_match:
        detail_data["report_year"] = int(year_match.group(1))
    else:
        detail_data["report_year"] = datetime.datetime.now().year - 1
    
    # 尝试从内容提取关键信息
    content_div = soup.select_one("div.content, div.disclosure-content")
    if content_div:
        content_text = content_div.get_text()
        
        # 提取披露日期
        date_match = re.search(r"(\d{4}年\d{1,2}月\d{1,2}日).*披露", content_text)
        if date_match:
            detail_data["disclosure_date"] = date_match.group(1)
        
        # 提取业绩预告类型
        for kw in ["预增", "预减", "续亏", "扭亏", "首亏", "续盈", "略增", "略减"]:
            if kw in content_text:
                detail_data["forecast_type"] = kw
                break
    
    # 从搜索结果页面直接解析JSON数据（巨潮资讯可能返回JSON格式）
    # 这部分需要根据实际API调整
    script_tags = soup.find_all("script")
    for script in script_tags:
        script_text = script.string or ""
        if "disclosure" in script_text.lower() or "annualReport" in script_text.lower():
            # 尝试从JavaScript变量中提取数据
            pass
    
    print(f"已获取股票 {stock_code} 的年报信息: {detail_data}")
    return detail_data


def fetch_mock_data(stock_code: str) -> Dict[str, Any]:
    """
    返回模拟数据（用于测试，当真实抓取失败时使用）
    
    实际部署时应删除此函数或返回None
    """
    print(f"[模拟数据] 返回股票 {stock_code} 的测试数据")
    
    mock_data = {
        "000001": {
            "stock_code": "000001",
            "stock_name": "平安银行",
            "report_year": 2023,
            "disclosure_date": "2024-03-20",
            "forecast_type": "预增",
            "forecast_value": "增长20%-30%",
            "actual_value": "增长25%",
            "audit_opinion": "标准无保留意见",
            "source_url": "http://www.cninfo.com.cn/mock",
        },
        "000002": {
            "stock_code": "000002",
            "stock_name": "万科A",
            "report_year": 2023,
            "disclosure_date": "2024-03-25",
            "forecast_type": "预减",
            "forecast_value": "下降40%-50%",
            "actual_value": "下降60%",  # 差异过大，触发异常
            "audit_opinion": "标准无保留意见",
            "source_url": "http://www.cninfo.com.cn/mock",
        },
    }
    
    return mock_data.get(stock_code, {
        "stock_code": stock_code,
        "stock_name": f"股票{stock_code}",
        "report_year": 2023,
        "disclosure_date": "2024-03-30",
        "forecast_type": None,
        "forecast_value": None,
        "actual_value": None,
        "audit_opinion": "标准无保留意见",
        "source_url": None,
    })


if __name__ == "__main__":
    # 测试抓取
    print("=" * 50)
    print("测试数据抓取模块")
    print("=" * 50)
    
    test_code = "000001"
    result = fetch_annual_report_info(test_code)
    
    if not result:
        print("真实抓取失败，使用模拟数据测试...")
        result = fetch_mock_data(test_code)
    
    print(f"抓取结果: {result}")
