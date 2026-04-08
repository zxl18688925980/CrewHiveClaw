#!/usr/bin/env python3
"""
export-dpo-confirmed.py — 将已确认的 DPO 候选追加到训练集

用法：
  python3 scripts/export-dpo-confirmed.py

输入：data/learning/dpo-candidates.jsonl（confirmed=true, good_response 非空）
输出：追加到 data/finetune/dpo-final.jsonl（不重复，按 sessionKey+timestamp 去重）

输出格式与 build-dpo-from-real.py 一致：
  {prompt, chosen, rejected, type, rule}

之后运行 prepare-finetune-data.py 重新生成 train.jsonl / valid.jsonl。
"""

import json
import os
import sys
from pathlib import Path

HOMEAI_ROOT     = Path(os.environ.get("HOMEAI_ROOT", Path.home() / "HomeAI"))
CANDIDATES_FILE  = HOMEAI_ROOT / "data/learning/dpo-candidates.jsonl"
FINAL_FILE       = HOMEAI_ROOT / "data/finetune/dpo-final.jsonl"

FINAL_FILE.parent.mkdir(parents=True, exist_ok=True)


def load_existing_ids() -> set[str]:
    """读取已存在的 dpo-final.jsonl，提取去重 key（prompt 前 80 字符）。"""
    ids: set[str] = set()
    if not FINAL_FILE.exists():
        return ids
    with open(FINAL_FILE) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
                ids.add(rec.get("prompt", "")[:80])
            except Exception:
                pass
    return ids


def process():
    if not CANDIDATES_FILE.exists():
        print(f"候选文件不存在：{CANDIDATES_FILE}")
        return

    existing_ids = load_existing_ids()

    candidates = []
    with open(CANDIDATES_FILE) as f:
        for line in f:
            line = line.strip()
            if line:
                candidates.append(json.loads(line))

    confirmed = [
        c for c in candidates
        if c.get("confirmed") and c.get("good_response", "").strip()
    ]

    new_pairs = []
    for rec in confirmed:
        prompt_key = rec["prompt"][:80]
        if prompt_key in existing_ids:
            continue  # 已导出，跳过

        # 提取 reason label 作为 rule 字段
        reasons = rec.get("reasons", [])
        rule = reasons[0].split(":")[0] if reasons else "unknown"

        pair = {
            "prompt":   rec["prompt"],
            "chosen":   rec["good_response"],
            "rejected": rec["bad_response"],
            "type":     "dpo_candidate",
            "rule":     rule,
        }
        new_pairs.append(pair)
        existing_ids.add(prompt_key)

    if not new_pairs:
        print(f"没有新的已确认候选需要导出（共 {len(confirmed)} 条已确认，全部已在 dpo-final.jsonl）。")
        return

    with open(FINAL_FILE, "a") as f:
        for pair in new_pairs:
            f.write(json.dumps(pair, ensure_ascii=False) + "\n")

    print(f"已导出 {len(new_pairs)} 条新训练对 → {FINAL_FILE}")
    print(f"dpo-final.jsonl 当前共 {len(existing_ids)} 条。")


if __name__ == "__main__":
    process()
    import os as _os
    _os.sys.exit(0)
