#!/usr/bin/python3
# -*- coding: utf-8 -*-
"""报告生成模块 - 生成 Markdown 格式报告"""

import logging
from datetime import datetime
from pathlib import Path
from typing import Dict, Any

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

REPORT_DIR = Path("/Users/xinbinanshan/HomeAI/app/generated/ai-box-reports")


def generate_report(analysis: Dict[str, Any]) -> str:
    """生成 Markdown 报告"""
    logger.info("开始生成报告...")
    
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    
    now = datetime.now()
    date_str = now.strftime("%Y年%m月%d日")
    timestamp = now.strftime("%Y%m%d_%H%M%S")
    
    lines = []
    lines.append(f"# AI 算力盒子市场周报")
    lines.append(f"\n**生成时间**: {date_str}\n")
    lines.append("---\n")
    
    lines.append("## 📊 市场概况\n")
    lines.append(f"- {analysis.get('summary', '暂无数据')}\n")
    
    price_stats = analysis.get('price_stats', {})
    if price_stats:
        lines.append("## 💰 价格分析\n")
        lines.append(f"- **平均价格**: ¥{price_stats.get('avg', 0):,.0f}")
        lines.append(f"- **最低价格**: ¥{price_stats.get('min', 0):,.0f}")
        lines.append(f"- **最高价格**: ¥{price_stats.get('max', 0):,.0f}")
        lines.append(f"- **价格趋势**: {analysis.get('price_trend', '无数据')}\n")
    
    cheapest = analysis.get('cheapest', [])
    if cheapest:
        lines.append("## 🔥 性价比推荐（价格最低）\n")
        for i, p in enumerate(cheapest[:5], 1):
            lines.append(f"{i}. **{p.get('name', '未知')[:40]}**")
            lines.append(f"   - 价格: ¥{p.get('price', '暂无')}")
            lines.append(f"   - [查看详情]({p.get('link', '#')})\n")
    
    most_expensive = analysis.get('most_expensive', [])
    if most_expensive:
        lines.append("## 🚀 高端产品（价格最高）\n")
        for i, p in enumerate(most_expensive[:3], 1):
            lines.append(f"{i}. **{p.get('name', '未知')[:40]}**")
            lines.append(f"   - 价格: ¥{p.get('price', '暂无')}")
            lines.append(f"   - [查看详情]({p.get('link', '#')})\n")
    
    hot_keywords = analysis.get('hot_keywords', [])
    if hot_keywords:
        lines.append("## 📈 热门关键词\n")
        for kw, count in hot_keywords:
            lines.append(f"- **{kw}**: 出现 {count} 次")
        lines.append("")
    
    discussions = analysis.get('discussions', [])
    if discussions:
        lines.append("## 💬 社区讨论热点\n")
        for d in discussions[:3]:
            lines.append(f"- [{d.get('title', '未知话题')}]({d.get('link', '#')})")
        lines.append("")
    
    lines.append("---\n")
    lines.append("## 📌 购买建议\n")
    if price_stats:
        avg = price_stats.get('avg', 0)
        if avg > 15000:
            lines.append("- 当前市场以高端产品为主，建议关注性价比款型")
        elif avg < 8000:
            lines.append("- 入门级产品价格亲民，适合初次尝试")
        else:
            lines.append("- 中端产品选择丰富，可按需选购")
    else:
        lines.append("- 暂无足够数据，建议稍后查看")
    
    lines.append("\n---")
    lines.append("\n*本报告由 HomeAI 自动生成，仅供参考*")
    
    content = '\n'.join(lines)
    
    report_file = REPORT_DIR / f"ai-box-report-{timestamp}.md"
    with open(report_file, 'w', encoding='utf-8') as f:
        f.write(content)
    
    logger.info(f"报告已保存: {report_file}")
    return content, str(report_file)


if __name__ == "__main__":
    test_analysis = {
        'summary': '共采集 15 款产品，3 条讨论',
        'price_stats': {'avg': 12500, 'min': 2999, 'max': 39999},
        'cheapest': [
            {'name': 'AI算力盒子 Mini版', 'price': '2999', 'link': 'https://jd.com/1'}
        ],
        'most_expensive': [
            {'name': '专业级AI算力工作站', 'price': '39999', 'link': 'https://jd.com/2'}
        ],
        'hot_keywords': [('RTX', 8), ('NVIDIA', 6)],
        'price_trend': '均价基本持平'
    }
    content, path = generate_report(test_analysis)
    print(f"报告路径: {path}")
    print(content)
