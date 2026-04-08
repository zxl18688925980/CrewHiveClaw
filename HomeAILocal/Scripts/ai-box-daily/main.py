#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys
import os
import logging
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent.parent / '.env')

from config import CONFIG
from fetch_boxes import fetch
from summarize import generate
from notify import send_with_retry

log_dir = Path(CONFIG['log_dir'])
log_dir.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.StreamHandler(),
        logging.FileHandler(log_dir / 'ai-box-daily.log', encoding='utf-8')
    ]
)
logger = logging.getLogger(__name__)


def format_report(summary: str, item_count: int) -> str:
    now = datetime.now()
    weekday = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][now.weekday()]
    
    report = f"""📰 AI算力盒子日报
📅 {now.strftime('%Y-%m-%d')} {weekday}

━━━━━━━━━━━━━━━━

{summary}

━━━━━━━━━━━━━━━━
📊 今日收录: {item_count} 款产品
⏰ 每天早上9点自动推送
👤 接收人：小姨肖山"""
    
    return report


def run():
    logger.info("=" * 50)
    logger.info("AI算力盒子日报系统启动")
    logger.info(f"时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    logger.info("=" * 50)
    
    print("\n📡 步骤 1/3: 数据采集...")
    try:
        items = fetch(CONFIG['keywords'])
        print(f"   ✅ 采集完成: {len(items)} 款产品")
    except Exception as e:
        print(f"   ❌ 采集失败: {e}")
        logger.error(f"数据采集失败: {e}")
        return False
    
    print("\n📝 步骤 2/3: 生成摘要...")
    try:
        summary = generate(items)
        print(f"   ✅ 摘要生成完成")
    except Exception as e:
        print(f"   ❌ 生成失败: {e}")
        logger.error(f"摘要生成失败: {e}")
        return False
    
    print("\n📤 步骤 3/3: 推送到企业微信...")
    try:
        report = format_report(summary, len(items))
        result = send_with_retry(CONFIG['target_user'], report)
        
        if result:
            print("   ✅ 推送成功")
        else:
            print("   ⚠️  推送失败")
    except Exception as e:
        print(f"   ⚠️  推送异常: {e}")
        logger.warning(f"推送异常: {e}")
    
    print("\n" + "=" * 50)
    print("📋 执行完成!")
    print(f"   产品数量: {len(items)}")
    print("=" * 50)
    
    return True


def main():
    try:
        success = run()
        return 0 if success else 1
    except Exception as e:
        logger.exception(f"执行异常: {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
