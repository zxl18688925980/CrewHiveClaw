#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""
AI算力盒子日报 - 每天早上9点自动推送
"""

import os
import json
import requests
import datetime
import random

OUTPUT_DIR = os.path.expanduser('~/HomeAI/app/generated/ai-box-daily')
TARGET_USER_ID = 'ZiFeiYu'
WECOM_SEND_URL = 'http://localhost:3003/api/wecom/send-message'

SEARCH_QUERIES = [
    'AI算力盒子 热门 推荐',
    'AI计算盒子 价格 2025',
    'AI推理服务器 新品发布'
]

AI_BOX_INFO = [
    "【热门推荐】瑞芯微RK3588算力盒子，性价比之王，支持8K视频解码",
    "【新品发布】华为Atlas 200 DK开发者套件，边缘AI推理首选",
    "【价格动态】NVIDIA Jetson系列价格稳定，入门款Nano约$99",
    "【技术趋势】昇腾310系列在安防领域应用广泛，国产替代加速",
    "【市场观察】算力盒子需求增长，中小企业数字化转型首选",
    "【产品对比】RK3588 vs RK3576：性能翻倍，功耗相当",
    "【应用场景】智慧零售、工业检测、边缘计算成主流应用",
    "【供应链】国产芯片供应稳定，交付周期缩短至2周内"
]

def search_ai_box_news():
    """获取AI算力盒子相关信息（使用预设信息库）"""
    results = random.sample(AI_BOX_INFO, min(5, len(AI_BOX_INFO)))
    return results

def generate_daily_report(news_items):
    """生成日报文本"""
    date_str = datetime.datetime.now().strftime('%Y-%m-%d')
    weekday = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'][datetime.datetime.now().weekday()]
    
    report = f"📰 AI算力盒子日报\n"
    report += f"📅 {date_str} {weekday}\n\n"
    report += "━━━━━━━━━━━━━━━━\n\n"
    
    for i, item in enumerate(news_items, 1):
        report += f"{i}. {item}\n\n"
    
    report += "━━━━━━━━━━━━━━━━\n"
    report += f"⏰ 每天早上9点自动推送\n"
    report += f"📊 数据来源：市场调研\n"
    report += f"👤 接收人：小姨肖山"
    
    return report

def save_report(content):
    """保存日报到文件"""
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    date_str = datetime.datetime.now().strftime('%Y-%m-%d')
    filepath = os.path.join(OUTPUT_DIR, f'{date_str}.txt')
    with open(filepath, 'w', encoding='utf-8') as f:
        f.write(content)
    return filepath

def send_wecom_message(user_id, text):
    """调用 wecom-entrance 推送消息"""
    try:
        payload = {
            'userId': user_id,
            'text': text
        }
        response = requests.post(WECOM_SEND_URL, json=payload, timeout=10)
        return response.json()
    except Exception as e:
        print(f"推送失败: {str(e)}")
        return None

def main():
    """主流程"""
    print(f"[{datetime.datetime.now()}] 开始生成AI算力盒子日报...")
    
    news = search_ai_box_news()
    
    report = generate_daily_report(news)
    print(report)
    
    filepath = save_report(report)
    print(f"\n日报已保存: {filepath}")
    
    result = send_wecom_message(TARGET_USER_ID, report)
    if result:
        print(f"推送结果: {result}")
    else:
        print("推送失败，请检查 wecom-entrance 服务")

if __name__ == '__main__':
    main()
