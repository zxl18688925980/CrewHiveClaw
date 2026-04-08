#!/usr/bin/env python3
"""
将 lucas-corpus.jsonl 转换为 mlx_lm.lora 所需的 chat template 格式。
输出：data/finetune/train.jsonl 和 data/finetune/valid.jsonl
"""

import json
import random
import os

CORPUS_PATH = os.path.expanduser("~/HomeAI/data/corpus/lucas-corpus.jsonl")
OUTPUT_DIR = os.path.expanduser("~/HomeAI/data/finetune")
VALID_RATIO = 0.1
SEED = 42

os.makedirs(OUTPUT_DIR, exist_ok=True)

records = []
skipped = 0

with open(CORPUS_PATH) as f:
    for i, line in enumerate(f):
        line = line.strip()
        if not line:
            continue
        d = json.loads(line)

        # 获取 prompt
        prompt = d.get("prompt", "").strip()

        # 获取 response：preference 条目用 chosen，其余用 response
        if d.get("type") == "preference":
            response = d.get("chosen", "").strip()
        else:
            response = d.get("response", "").strip()

        if not prompt or not response:
            skipped += 1
            continue

        records.append({
            "messages": [
                {"role": "user", "content": prompt},
                {"role": "assistant", "content": response}
            ]
        })

random.seed(SEED)
random.shuffle(records)

n_valid = max(1, int(len(records) * VALID_RATIO))
valid_set = records[:n_valid]
train_set = records[n_valid:]

def write_jsonl(path, data):
    with open(path, "w") as f:
        for item in data:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")

train_path = os.path.join(OUTPUT_DIR, "train.jsonl")
valid_path = os.path.join(OUTPUT_DIR, "valid.jsonl")

write_jsonl(train_path, train_set)
write_jsonl(valid_path, valid_set)

print(f"总记录：{len(records)}（跳过 {skipped} 条空记录）")
print(f"训练集：{len(train_set)} 条 → {train_path}")
print(f"验证集：{len(valid_set)} 条 → {valid_path}")
print("完成。")
