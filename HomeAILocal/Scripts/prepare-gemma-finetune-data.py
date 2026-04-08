#!/usr/bin/env python3
"""
准备 Gemma 4 LoRA 微调数据
将 lucas-corpus.jsonl（DPO格式）转换为 mlx_lm chat 格式
"""
import json
import random
import os
from pathlib import Path

CORPUS_FILE = Path("/Users/xinbinanshan/HomeAI/data/corpus/lucas-corpus.jsonl")
OUTPUT_DIR  = Path("/Users/xinbinanshan/HomeAI/models/data-gemma4")
SYSTEM_PROMPT = (
    "你是 Lucas（启灵），曾家的家庭智能助手，性格温暖、靠谱、有趣。"
    "你帮助家庭成员（爸爸曾小龙、妈妈张璐、小姨肖山、姐姐曾钥语桐）处理日常需求。"
    "回复简洁自然，像家人一样沟通，不用太正式。"
)
TRAIN_RATIO = 0.9
RANDOM_SEED = 42

def load_corpus(path):
    samples = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                samples.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return samples

def to_text_format(sample):
    """转为 Gemma4 text 格式（手动拼 turn 标记，不依赖 chat_template）
    格式:
      <start_of_turn>user
      {system}\\n\\n{prompt}<end_of_turn>
      <start_of_turn>model
      {response}<end_of_turn>
    """
    prompt   = sample.get("prompt", "").strip()
    response = (sample.get("response") or sample.get("chosen") or "").strip()
    if not prompt or not response:
        return None
    user_content = f"{SYSTEM_PROMPT}\n\n{prompt}"
    text = (
        f"<start_of_turn>user\n{user_content}<end_of_turn>\n"
        f"<start_of_turn>model\n{response}<end_of_turn>"
    )
    return {"text": text}

def main():
    print(f"读取语料: {CORPUS_FILE}")
    raw = load_corpus(CORPUS_FILE)
    print(f"原始条数: {len(raw)}")

    samples = [s for s in (to_text_format(r) for r in raw) if s]
    print(f"有效条数: {len(samples)}")

    random.seed(RANDOM_SEED)
    random.shuffle(samples)

    split = int(len(samples) * TRAIN_RATIO)
    train = samples[:split]
    valid = samples[split:]
    print(f"训练集: {len(train)} 条，验证集: {len(valid)} 条")

    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    for name, data in [("train.jsonl", train), ("valid.jsonl", valid)]:
        path = OUTPUT_DIR / name
        with open(path, "w", encoding="utf-8") as f:
            for s in data:
                f.write(json.dumps(s, ensure_ascii=False) + "\n")
        print(f"写入: {path}")

    print("数据准备完成。")

if __name__ == "__main__":
    main()
