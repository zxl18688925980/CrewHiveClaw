#!/usr/bin/env python3.11
import json
from datetime import datetime
from typing import Dict, List, Any, Tuple
import config

def generate_report(scores: Dict[str, float], high_freq_patterns: List[Dict[str, Any]], week_offset: int = 0) -> Tuple[Dict[str, Any], str]:
    date_str = datetime.now().strftime("%Y-%m-%d")
    
    overall_score = sum(
        scores.get(dim, 0) * weight 
        for dim, weight in config.SCORE_WEIGHTS.items()
    )
    
    recommendations = []
    if scores.get("tool_accuracy", 100) < 80:
        recommendations.append("工具调用准确率偏低，建议检查工具选择逻辑")
    if scores.get("commitment_fulfillment", 100) < 70:
        recommendations.append("承诺兑现率不足，需要加强任务跟踪机制")
    if scores.get("hallucination_rate", 0) > 20:
        recommendations.append("幻觉发生率偏高，建议增强知识检索前置")
    if high_freq_patterns:
        recommendations.append(f"发现 {len(high_freq_patterns)} 个高频错误模式，建议针对性优化")
    
    report = {
        "report_date": date_str,
        "period": f"last {config.WEEKS_TO_ANALYZE} week(s)",
        "scores": scores,
        "overall_score": round(overall_score, 2),
        "high_freq_patterns": high_freq_patterns,
        "recommendations": recommendations
    }
    
    pattern_summary = ""
    if high_freq_patterns:
        pattern_lines = []
        for p in high_freq_patterns[:3]:
            severity = classify_pattern_severity(p["pattern_type"], p["count"])
            pattern_lines.append(f"  - {p['pattern_type']}: {p['count']}次 [{severity}]")
        pattern_summary = "\n".join(pattern_lines)
    else:
        pattern_summary = "  无高频错误模式"
    
    summary = f"""【启灵本周自评报告】{date_str}
整体得分：{overall_score:.1f}/100

【各项指标】
工具准确率：{scores.get('tool_accuracy', 0):.1f}/100
需求理解率：{scores.get('requirement_accuracy', 0):.1f}/100
承诺兑现率：{scores.get('commitment_fulfillment', 0):.1f}/100
幻觉发生率：{scores.get('hallucination_rate', 0):.1f}/100（越低越好）
自我修正率：{scores.get('self_correction', 0):.1f}/100

【高频问题】
{pattern_summary}

【改进建议】
{chr(10).join(f"{i+1}. {r}" for i, r in enumerate(recommendations)) if recommendations else "暂无"}
"""
    
    return report, summary

def classify_pattern_severity(pattern_type: str, count: int) -> str:
    critical_patterns = ["hallucination", "commitment_failure", "tool_misuse"]
    warning_patterns = ["confusion", "incomplete_response"]
    
    severity = "info"
    if any(cp in pattern_type.lower() for cp in critical_patterns):
        severity = "critical" if count >= 5 else "warning"
    elif any(wp in pattern_type.lower() for wp in warning_patterns):
        severity = "warning" if count >= 4 else "info"
    
    return severity

def save_report(report: Dict[str, Any], output_dir: str = config.OUTPUT_DIR) -> str:
    import os
    os.makedirs(output_dir, exist_ok=True)
    
    filename = f"{report['report_date']}-weekly-eval.json"
    filepath = os.path.join(output_dir, filename)
    
    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    
    return filepath

def append_to_tracker(report: Dict[str, Any], tracker_file: str = config.TRACKER_FILE) -> None:
    import os
    os.makedirs(os.path.dirname(tracker_file), exist_ok=True)
    
    tracker_entry = {
        "date": report["report_date"],
        "overall_score": report["overall_score"],
        "dimensions": report["scores"],
        "high_freq_patterns": len(report["high_freq_patterns"]),
        "new_patterns": len([p for p in report["high_freq_patterns"] if p["count"] >= config.THRESHOLD_PATTERN_FREQ])
    }
    
    with open(tracker_file, "a", encoding="utf-8") as f:
        f.write(json.dumps(tracker_entry, ensure_ascii=False) + "\n")
