#!/usr/bin/env python3.11
from collections import defaultdict
from typing import Dict, List, Any

HALLUCINATION_MARKERS = ["我觉得", "可能大概", "应该没有问题", "好像是", "应该可以", "不太确定"]
ERROR_MARKERS = ["抱歉", "出现了错误", "没有成功", "失败了", "无法完成", "出了点问题"]
CLARIFICATION_MARKERS = ["你是说", "你指的是", "能再解释一下吗", "具体是"]

def detect_high_freq_patterns_from_conversations(conv_data: Dict[str, Any], threshold: int = 3) -> List[Dict[str, Any]]:
    pattern_counts: Dict[str, Dict[str, Any]] = defaultdict(lambda: {"count": 0, "examples": []})
    
    documents = conv_data.get("documents", [])
    
    for doc in documents:
        if not isinstance(doc, str):
            continue
        
        doc_lower = doc.lower()
        
        for marker in HALLUCINATION_MARKERS:
            if marker in doc:
                pattern_type = "hallucination_hint"
                pattern_counts[pattern_type]["count"] += 1
                if len(pattern_counts[pattern_type]["examples"]) < 2:
                    pattern_counts[pattern_type]["examples"].append(f"[{marker}] {doc[:150]}")
                break
        
        for marker in ERROR_MARKERS:
            if marker in doc:
                pattern_type = "error_acknowledgment"
                pattern_counts[pattern_type]["count"] += 1
                if len(pattern_counts[pattern_type]["examples"]) < 2:
                    pattern_counts[pattern_type]["examples"].append(f"[{marker}] {doc[:150]}")
                break
        
        for marker in CLARIFICATION_MARKERS:
            if marker in doc:
                pattern_type = "clarification_request"
                pattern_counts[pattern_type]["count"] += 1
                if len(pattern_counts[pattern_type]["examples"]) < 2:
                    pattern_counts[pattern_type]["examples"].append(f"[{marker}] {doc[:150]}")
                break
    
    high_freq = []
    for ptype, data in pattern_counts.items():
        if data["count"] >= threshold:
            high_freq.append({
                "pattern_type": ptype,
                "count": data["count"],
                "examples": data["examples"]
            })
    
    high_freq.sort(key=lambda x: x["count"], reverse=True)
    return high_freq

def detect_high_freq_patterns_from_decisions(decisions_data: Dict[str, Any], threshold: int = 3) -> List[Dict[str, Any]]:
    pattern_counts: Dict[str, Dict[str, Any]] = defaultdict(lambda: {"count": 0, "examples": []})
    
    metadatas = decisions_data.get("metadatas", [])
    
    for meta in metadatas:
        outcome = meta.get("outcome", "")
        decision = meta.get("decision", "")
        
        if outcome == "failure":
            if "timeout" in meta.get("outcome_note", "").lower():
                pattern_type = "timeout_failure"
            elif "aborted" in meta.get("outcome_note", "").lower():
                pattern_type = "aborted_failure"
            else:
                pattern_type = "general_failure"
            
            pattern_counts[pattern_type]["count"] += 1
            if len(pattern_counts[pattern_type]["examples"]) < 2:
                pattern_counts[pattern_type]["examples"].append(f"{decision[:150]}")
    
    high_freq = []
    for ptype, data in pattern_counts.items():
        if data["count"] >= threshold:
            high_freq.append({
                "pattern_type": ptype,
                "count": data["count"],
                "examples": data["examples"]
            })
    
    high_freq.sort(key=lambda x: x["count"], reverse=True)
    return high_freq

def detect_high_freq_patterns(collection_data: Dict[str, Any], threshold: int = 3) -> List[Dict[str, Any]]:
    return []

def classify_pattern_severity(pattern_type: str, count: int) -> str:
    critical_patterns = ["hallucination", "commitment_failure", "timeout_failure", "aborted_failure"]
    warning_patterns = ["error_acknowledgment", "clarification_request", "general_failure"]
    
    severity = "info"
    if any(cp in pattern_type.lower() for cp in critical_patterns):
        severity = "critical" if count >= 5 else "warning"
    elif any(wp in pattern_type.lower() for wp in warning_patterns):
        severity = "warning" if count >= 4 else "info"
    
    return severity
