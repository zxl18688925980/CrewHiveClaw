#!/usr/bin/env python3.11
THRESHOLD_HALLUCINATION_KEYWORDS = ["我觉得", "可能大概", "应该没有问题", "好像是", "应该可以"]
THRESHOLD_PATTERN_FREQ = 3
WEEKS_TO_ANALYZE = 1
SCORE_WEIGHTS = {
    "tool_accuracy": 0.25,
    "requirement_accuracy": 0.25,
    "commitment_fulfillment": 0.25,
    "hallucination_rate": 0.15,
    "self_correction": 0.10
}
CHROMA_HOST = "localhost"
CHROMA_PORT = 8001
OUTPUT_DIR = "output"
TRACKER_FILE = "data/evolution-tracker.jsonl"
