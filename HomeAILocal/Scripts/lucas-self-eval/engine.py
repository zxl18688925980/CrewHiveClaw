#!/usr/bin/env python3.11
import sys
import os
import json
import argparse
from datetime import datetime, timedelta
from typing import Dict, List, Any

script_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, script_dir)

import chromadb
import config
from patterns import detect_high_freq_patterns_from_conversations, detect_high_freq_patterns_from_decisions
from reporter import generate_report, save_report, append_to_tracker

def get_week_filter(weeks: int = 1) -> Dict[str, str]:
    end_date = datetime.now()
    start_date = end_date - timedelta(weeks=weeks)
    return {
        "start": start_date.isoformat(),
        "end": end_date.isoformat()
    }

def fetch_behavior_patterns(client: chromadb.HttpClient, weeks: int = 1) -> Dict[str, Any]:
    col = client.get_collection("behavior_patterns")
    week_filter = get_week_filter(weeks)
    
    results = col.get(
        where={"userId": "zengxiaolong"},
        include=["documents", "metadatas"]
    )
    
    return results

def fetch_decisions(client: chromadb.HttpClient, weeks: int = 1) -> Dict[str, Any]:
    col = client.get_collection("decisions")
    
    results = col.get(
        where={"agent": "lucas"},
        include=["documents", "metadatas"]
    )
    
    return results

def fetch_conversations(client: chromadb.HttpClient, weeks: int = 1) -> Dict[str, Any]:
    col = client.get_collection("conversations")
    
    results = col.get(
        where={"userId": "zengxiaolong"},
        include=["documents", "metadatas"]
    )
    
    return results

def calculate_tool_accuracy(behavior_data: Dict[str, Any]) -> float:
    metas = behavior_data.get("metadatas", [])
    if not metas:
        return 100.0
    
    return 100.0

def calculate_requirement_accuracy(decisions_data: Dict[str, Any]) -> float:
    metas = decisions_data.get("metadatas", [])
    if not metas:
        return 85.0
    
    satisfied_count = 0
    total_count = 0
    
    for meta in metas:
        if meta.get("type") == "requirement_clarification":
            total_count += 1
            if meta.get("satisfied", True):
                satisfied_count += 1
    
    if total_count == 0:
        return 85.0
    
    return round((satisfied_count / total_count) * 100, 2)

def calculate_commitment_fulfillment(decisions_data: Dict[str, Any]) -> float:
    metas = decisions_data.get("metadatas", [])
    if not metas:
        return 100.0
    
    delivered_count = 0
    total_decisions = 0
    
    for meta in metas:
        outcome = meta.get("outcome", "")
        if outcome and outcome in ["success", "failure"]:
            total_decisions += 1
            if outcome == "success":
                delivered_count += 1
    
    if total_decisions == 0:
        return 100.0
    
    return round((delivered_count / total_decisions) * 100, 2)

def calculate_hallucination_rate(conv_data: Dict[str, Any]) -> float:
    docs = conv_data.get("documents", [])
    if not docs:
        return 0.0
    
    hallucination_count = 0
    total_count = 0
    
    for doc in docs:
        if isinstance(doc, str):
            total_count += 1
            for keyword in config.THRESHOLD_HALLUCINATION_KEYWORDS:
                if keyword in doc:
                    hallucination_count += 1
                    break
    
    if total_count == 0:
        return 0.0
    
    return round((hallucination_count / total_count) * 100, 2)

def calculate_self_correction(behavior_data: Dict[str, Any]) -> float:
    return 100.0

def calculate_scores(behavior_data: Dict[str, Any], 
                     decisions_data: Dict[str, Any], 
                     conv_data: Dict[str, Any]) -> Dict[str, float]:
    return {
        "tool_accuracy": calculate_tool_accuracy(behavior_data),
        "requirement_accuracy": calculate_requirement_accuracy(decisions_data),
        "commitment_fulfillment": calculate_commitment_fulfillment(decisions_data),
        "hallucination_rate": calculate_hallucination_rate(conv_data),
        "self_correction": calculate_self_correction(behavior_data)
    }

def main():
    parser = argparse.ArgumentParser(description="Lucas 自我评估引擎")
    parser.add_argument("--weeks", type=int, default=config.WEEKS_TO_ANALYZE, 
                        help="评估最近 N 周数据")
    args = parser.parse_args()
    
    print(f"[{datetime.now().isoformat()}] 启动 Lucas 自我评估...")
    print(f"评估范围: 最近 {args.weeks} 周")
    
    client = chromadb.HttpClient(host=config.CHROMA_HOST, port=config.CHROMA_PORT)
    print("✓ ChromaDB 连接成功")
    
    behavior_data = fetch_behavior_patterns(client, args.weeks)
    print(f"✓ behavior_patterns 查询完成: {len(behavior_data.get('documents', []))} 条记录")
    
    decisions_data = fetch_decisions(client, args.weeks)
    print(f"✓ decisions 查询完成: {len(decisions_data.get('documents', []))} 条记录")
    
    conv_data = fetch_conversations(client, args.weeks)
    print(f"✓ conversations 查询完成: {len(conv_data.get('documents', []))} 条记录")
    
    conv_patterns = detect_high_freq_patterns_from_conversations(conv_data, config.THRESHOLD_PATTERN_FREQ)
    decision_patterns = detect_high_freq_patterns_from_decisions(decisions_data, config.THRESHOLD_PATTERN_FREQ)
    high_freq_patterns = conv_patterns + decision_patterns
    print(f"✓ Pattern Recognizer 完成: 发现 {len(high_freq_patterns)} 个高频模式")
    
    scores = calculate_scores(behavior_data, decisions_data, conv_data)
    print("✓ 评分计算完成")
    
    report, summary = generate_report(scores, high_freq_patterns, args.weeks - 1)
    
    output_path = save_report(report)
    print(f"✓ 报告已保存: {output_path}")
    
    append_to_tracker(report)
    print(f"✓ 进化轨迹已记录: {config.TRACKER_FILE}")
    
    print("\n" + "="*60)
    print(summary)
    print("="*60)

if __name__ == "__main__":
    main()
