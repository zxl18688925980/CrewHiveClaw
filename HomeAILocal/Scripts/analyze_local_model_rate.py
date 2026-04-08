#!/usr/bin/python3
"""
每日本地模型调用率统计脚本
读取 route-events.jsonl，按天统计本地/云端调用比例
"""

import json
import os
from collections import defaultdict
from datetime import datetime
from pathlib import Path


def main():
    home_dir = Path.home() / "HomeAI"
    jsonl_path = home_dir / "data" / "learning" / "route-events.jsonl"
    output_dir = home_dir / "app" / "generated"
    
    if not jsonl_path.exists():
        print(f"错误：数据文件不存在 - {jsonl_path}")
        return 1
    
    output_dir.mkdir(parents=True, exist_ok=True)
    
    stats = defaultdict(lambda: {"total": 0, "local": 0})
    error_count = 0
    
    print(f"正在读取: {jsonl_path}")
    
    with open(jsonl_path, 'r', encoding='utf-8') as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
                timestamp = event.get("timestamp", "")
                if not timestamp:
                    continue
                date = timestamp[:10]
                stats[date]["total"] += 1
                if not event.get("isCloud", True):
                    stats[date]["local"] += 1
            except json.JSONDecodeError as e:
                error_count += 1
                if error_count <= 3:
                    print(f"警告：第 {line_num} 行 JSON 解析失败 - {e}")
    
    if error_count > 3:
        print(f"警告：共 {error_count} 行解析失败")
    
    if not stats:
        print("提示：数据文件为空或无有效记录")
        return 0
    
    sorted_dates = sorted(stats.keys())
    
    total_calls = sum(s["total"] for s in stats.values())
    total_local = sum(s["local"] for s in stats.values())
    avg_rate = (total_local / total_calls * 100) if total_calls > 0 else 0
    
    now = datetime.now().strftime("%Y%m%d")
    report_path = output_dir / f"local-model-report-{now}.txt"
    
    report_lines = []
    report_lines.append("=== 本地模型调用率报告 ===")
    report_lines.append(f"生成时间: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    report_lines.append(f"数据文件: data/learning/route-events.jsonl")
    report_lines.append("")
    report_lines.append("日期         总调用    本地调用   本地率")
    report_lines.append("----------  ------  --------  ------")
    
    for date in sorted_dates:
        s = stats[date]
        rate = (s["local"] / s["total"] * 100) if s["total"] > 0 else 0
        report_lines.append(f"{date}    {s['total']:>4}      {s['local']:>4}   {rate:>5.1f}%")
    
    report_lines.append("")
    report_lines.append(f"总计: {total_calls} 次调用，本地 {total_local} 次，平均本地率 {avg_rate:.1f}%")
    
    report_content = "\n".join(report_lines)
    
    with open(report_path, 'w', encoding='utf-8') as f:
        f.write(report_content)
    
    print(report_content)
    print()
    print(f"报告已保存: {report_path}")
    
    return 0


if __name__ == '__main__':
    exit(main())
