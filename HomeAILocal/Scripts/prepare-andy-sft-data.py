#!/usr/bin/env python3
"""
prepare-andy-sft-data.py

把 andy-spec-finetune-queue.jsonl 中 eligibleForTraining=True 的条目
转换为 MLX SFT 训练格式（messages 数组），输出到：
  ~/HomeAI/Data/finetune/andy-spec/train.jsonl
  ~/HomeAI/Data/finetune/andy-spec/valid.jsonl

MLX 格式（每行一个 JSON）：
{
  "messages": [
    {"role": "system",  "content": "<系统提示>"},
    {"role": "user",    "content": "<需求+上下文>"},
    {"role": "assistant","content": "<spec JSON>"}
  ]
}

用法：
    python3 prepare-andy-sft-data.py [--min-ip 1] [--valid-ratio 0.1] [--dry-run]
"""

import argparse
import json
import random
from pathlib import Path

QUEUE_FILE  = Path.home() / "HomeAI" / "Data" / "learning" / "andy-spec-finetune-queue.jsonl"
OUTPUT_DIR  = Path.home() / "HomeAI" / "Data" / "finetune" / "andy-spec"

ANDY_SYSTEM_PROMPT = """你是 Andy，HomeAI 系统的架构设计师。
你的核心职责是：把家庭成员的自然语言需求转化为严谨、可执行的技术 spec。

输出必须是标准 JSON 格式，包含以下字段：
- requirement_id: 需求编号
- user_id: 提出需求的家庭成员 ID
- title: 需求标题（10字以内）
- solution: 解决方案描述（面向家庭成员，非技术语言，≤120字）
- integration_points: 代码集成点列表（file/change/reason/type）
- acceptance_criteria: 验收标准列表（可量化）
- code_evidence: 现有代码依据（file/relevant_code/relevance）
- estimatedHours: 预计工时（数字）
- planning_mode: 是否启用并行模式（true/false）

quality bar：
- integration_points 必须有至少 1 个具体文件路径
- acceptance_criteria 必须有至少 2 条可量化标准
- 不得凭空假设代码结构，必须基于 code_evidence 中的实际代码""".strip()


def load_queue(min_ip: int) -> list[dict]:
    if not QUEUE_FILE.exists():
        print(f"[ERROR] 队列文件不存在：{QUEUE_FILE}")
        return []

    entries = []
    skipped = 0
    for line in QUEUE_FILE.read_text("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
        except Exception:
            skipped += 1
            continue

        if not e.get("eligibleForTraining"):
            skipped += 1
            continue
        if not e.get("spec"):
            skipped += 1
            continue
        # 质量门：至少有 min_ip 个 integration_points
        q = e.get("specQuality", {})
        if q.get("integrationPointCount", 0) < min_ip:
            skipped += 1
            continue

        entries.append(e)

    print(f"合格条目：{len(entries)}，跳过：{skipped}")
    return entries


def build_user_message(entry: dict) -> str:
    parts = []
    if entry.get("requirement"):
        parts.append(f"需求描述：{entry['requirement']}")
    if entry.get("lucasContext"):
        parts.append(f"Lucas 上下文：{entry['lucasContext']}")
    if entry.get("requirementId"):
        parts.append(f"需求编号：{entry['requirementId']}")
    if not parts:
        # fallback：从 spec 提取前 3 行作为伪需求
        spec_lines = [l for l in entry["spec"].splitlines() if l.strip()]
        parts.append("需求描述：" + " ".join(spec_lines[:3])[:200])
    return "\n".join(parts)


def entry_to_mlx(entry: dict) -> dict:
    return {
        "messages": [
            {"role": "system",    "content": ANDY_SYSTEM_PROMPT},
            {"role": "user",      "content": build_user_message(entry)},
            {"role": "assistant", "content": entry["spec"]},
        ]
    }


def write_jsonl(path: Path, records: list[dict]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        for r in records:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--min-ip",      type=int,   default=1,   help="最少 integration_points 数量（默认 1）")
    parser.add_argument("--valid-ratio", type=float, default=0.1, help="验证集比例（默认 0.1）")
    parser.add_argument("--seed",        type=int,   default=42)
    parser.add_argument("--dry-run",     action="store_true")
    args = parser.parse_args()

    entries = load_queue(min_ip=args.min_ip)
    if not entries:
        print("没有合格数据，退出")
        return

    random.seed(args.seed)
    random.shuffle(entries)

    n_valid = max(1, int(len(entries) * args.valid_ratio))
    valid_entries = entries[:n_valid]
    train_entries = entries[n_valid:]

    print(f"训练集：{len(train_entries)}，验证集：{len(valid_entries)}")

    if args.dry_run:
        print("[dry-run] 不写入文件")
        return

    if len(train_entries) == 0:
        print("[WARN] 训练集为空（数据量不足），跳过写入")
        return

    train_records = [entry_to_mlx(e) for e in train_entries]
    valid_records = [entry_to_mlx(e) for e in valid_entries]

    write_jsonl(OUTPUT_DIR / "train.jsonl", train_records)
    write_jsonl(OUTPUT_DIR / "valid.jsonl", valid_records)

    print(f"已写入：")
    print(f"  {OUTPUT_DIR}/train.jsonl  ({len(train_records)} 条)")
    print(f"  {OUTPUT_DIR}/valid.jsonl  ({len(valid_records)} 条)")

    # 判断是否达到 SFT 起训门槛
    if len(train_records) >= 50:
        print(f"\n✅ 训练集已达 {len(train_records)} 条，可以启动 LoRA SFT：")
        print(f"   mlx_lm.lora --model ~/HomeAI/Models/mlx/Qwen2.5-Coder-32B-4bit \\")
        print(f"     --data {OUTPUT_DIR} --train --iters 500 --batch-size 2 \\")
        print(f"     --adapter-path ~/HomeAI/Models/adapters/andy-spec/")
    else:
        remaining = 50 - len(train_records)
        print(f"\n⚠️  训练集 {len(train_records)} 条，还需积累约 {remaining} 条后再训练")


if __name__ == "__main__":
    main()
