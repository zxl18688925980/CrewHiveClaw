#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
AI 算力盒子周报系统 - 主入口

使用方法:
    /usr/bin/python3 ~/HomeAI/CrewHiveClaw/HomeAILocal/Scripts/ai-box-weekly/main.py

依赖安装:
    pip3 install requests beautifulsoup4 --user
"""

import sys
import os
import logging
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from dotenv import load_dotenv
load_dotenv('/Users/xinbinanshan/HomeAI/.env')

from scraper import scrape_all
from analyzer import analyze
from reporter import generate_report
from pusher import push_to_wecom

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)
logger = logging.getLogger(__name__)


def main():
    """主流程"""
    logger.info("=" * 50)
    logger.info("AI 算力盒子周报系统启动")
    logger.info(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    logger.info("=" * 50)
    
    print("\n📡 步骤 1/4: 数据采集...")
    try:
        raw_data = scrape_all()
        products_count = raw_data.get('total_products', 0)
        discussions_count = raw_data.get('total_discussions', 0)
        print(f"   ✅ 采集完成: {products_count} 款产品, {discussions_count} 条讨论")
    except Exception as e:
        print(f"   ❌ 采集失败: {e}")
        logger.error(f"数据采集失败: {e}")
        return False
    
    print("\n📊 步骤 2/4: 数据分析...")
    try:
        analysis_result = analyze(raw_data)
        price_stats = analysis_result.get('price_stats', {})
        if price_stats:
            print(f"   ✅ 分析完成: 均价 ¥{price_stats.get('avg', 0):,.0f}")
        else:
            print("   ⚠️  无有效价格数据")
    except Exception as e:
        print(f"   ❌ 分析失败: {e}")
        logger.error(f"数据分析失败: {e}")
        return False
    
    print("\n📝 步骤 3/4: 生成报告...")
    try:
        report_content, report_path = generate_report(analysis_result)
        print(f"   ✅ 报告已保存: {report_path}")
    except Exception as e:
        print(f"   ❌ 生成失败: {e}")
        logger.error(f"报告生成失败: {e}")
        return False
    
    print("\n📤 步骤 4/4: 推送到企业微信...")
    try:
        push_result = push_to_wecom(report_content)
        if push_result:
            print("   ✅ 推送成功")
        else:
            print("   ⚠️  推送失败，报告已保存到本地")
    except Exception as e:
        print(f"   ⚠️  推送异常: {e}")
        logger.warning(f"推送失败，报告仍保存在本地: {report_path}")
    
    print("\n" + "=" * 50)
    print("📋 执行完成!")
    print(f"   报告路径: {report_path}")
    print(f"   产品数量: {raw_data.get('total_products', 0)}")
    print(f"   讨论数量: {raw_data.get('total_discussions', 0)}")
    print("=" * 50)
    
    return True


if __name__ == "__main__":
    success = main()
    sys.exit(0 if success else 1)
