#!/usr/bin/env python3
"""
prepare-vl-corpus.py — 为 Qwen3-VL-32B LoRA 训练准备分角色语料

输入来源：
  - Data/corpus/{lucas,andy,lisa}-corpus.jsonl：主语料（prompt/chosen 格式）
  - Data/learning/dpo-candidates.jsonl：DPO 负例语料（bad_response/good_response 格式）
  - Data/learning/positive-dpo-samples.jsonl：积极反馈正例

输出格式（mlx_vlm.lora 兼容的 messages 格式）：
  {"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}

角色系统提示：注入各角色 SOUL.md 摘要，让模型学会角色身份
"""

import json
import os
import sys
import random
from pathlib import Path

DATA_ROOT = Path(os.environ.get("HOMEAI_ROOT", Path.home() / "HomeAI"))
CORPUS_DIR = DATA_ROOT / "Data/corpus"
LEARNING_DIR = DATA_ROOT / "Data/learning"
OUTPUT_DIR = DATA_ROOT / "Data/finetune/vl-training"

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 各角色的系统提示（轻量版，让模型学会身份感）
ROLE_SYSTEM_PROMPTS = {
    "lucas": (
        "你是 Lucas，这个家庭的 AI 伴侣。你温暖、诚实、自然，像真正的家人一样对话。"
        "你绝不虚报已完成的操作（如「消息已发给」「正在处理」等，除非工具确实被调用）。"
        "你回复简洁，直接，像家人之间的对话。"
    ),
    "andy": (
        "你是 Andy，团队的方案设计师。你负责把需求转化为精确的技术规格（spec），"
        "判断技术可行性，设计系统架构。你的回复结构清晰、有技术深度，避免模糊承诺。"
    ),
    "lisa": (
        "你是 Lisa，团队的开发工程师。你负责按 Andy 的 spec 实现代码，"
        "追求代码质量和可维护性，遇到问题直接说明而不是绕过。"
    ),
}


def load_jsonl(path):
    path = Path(path)
    if not path.exists():
        return []
    items = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                items.append(json.loads(line))
            except Exception:
                pass
    return items


def to_message_format(system_prompt, user_content, assistant_content):
    """转换为 mlx_vlm.lora 需要的 messages 格式"""
    return {
        "messages": [
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": user_content},
            {"role": "assistant", "content": assistant_content},
        ]
    }


def prepare_role(role):
    system = ROLE_SYSTEM_PROMPTS[role]
    samples = []

    # ── 1. 主语料（corpus）——各角色字段名不同 ──
    corpus = load_jsonl(CORPUS_DIR / f"{role}-corpus.jsonl")
    for item in corpus:
        if role == "andy":
            # andy 语料两种格式：
            # 主体(536条)：{prompt, response}
            # 设计决策(30条)：{requirement, adr_summary/design_decision}
            # 旧格式(1条)：{requirement, design}
            user = (item.get("prompt") or item.get("requirement") or "").strip()
            assistant = (item.get("response") or item.get("adr_summary") or item.get("design_decision") or item.get("design") or "").strip()
        elif role == "lisa":
            # lisa: {prompt, response}
            user = item.get("prompt", "").strip()
            assistant = item.get("response", "").strip()
        else:
            # lucas: {prompt, chosen/rejected}
            user = item.get("prompt", "").strip()
            assistant = (item.get("chosen") or item.get("rejected") or "").strip()
        if user and assistant and len(assistant) > 20:
            samples.append(to_message_format(system, user, assistant))

    # ── 2. DPO good_response（正向纠正语料）──
    if role == "lucas":  # 当前 DPO 数据全是 lucas
        dpo = load_jsonl(LEARNING_DIR / "dpo-candidates.jsonl")
        for item in dpo:
            if not item.get("good_response") or not item.get("phase2_eligible"):
                continue
            user = item.get("prompt", "").strip()
            assistant = item.get("good_response", "").strip()
            if user and assistant and len(assistant) > 10:
                # 截掉 prompt 里的 Sender metadata（前 10 行杂音）
                lines = user.split("\n")
                clean_lines = [l for l in lines if not l.startswith("```") and "Sender" not in l]
                clean_user = "\n".join(clean_lines).strip()
                if clean_user:
                    samples.append(to_message_format(system, clean_user, assistant))

    # ── 3. 积极反馈正例（positive-dpo-samples）──
    if role == "lucas":
        pos = load_jsonl(LEARNING_DIR / "positive-dpo-samples.jsonl")
        for item in pos:
            if not item.get("positive_response") or not item.get("phase2_eligible"):
                continue
            # positive_response 是历史 assistant 消息，没有对应 user
            # 用 user_feedback 做 user（倒推对话）
            user = item.get("user_feedback", "").strip()
            assistant = item.get("positive_response", "").strip()
            if user and assistant and len(assistant) > 20:
                samples.append(to_message_format(system, user, assistant))

    # 去重（以 user+assistant 前 100 字为 key）
    seen = set()
    unique = []
    for s in samples:
        key = (s["messages"][1]["content"][:100], s["messages"][2]["content"][:100])
        if key not in seen:
            seen.add(key)
            unique.append(s)

    # 随机打乱，分 train/valid（9:1）
    random.seed(42)
    random.shuffle(unique)
    n_valid = max(1, len(unique) // 10)
    valid = unique[:n_valid]
    train = unique[n_valid:]

    # 如果训练样本不足 MIN_TRAIN_SAMPLES，重复数据集（等价于多轮 epoch）
    # mlx_vlm.lora --iters N 会取数据集前 N 条，训练集必须 ≥ iters
    MIN_TRAIN_SAMPLES = 220  # 略大于 iters=200，留 10% 余量
    if len(train) < MIN_TRAIN_SAMPLES:
        repeats = (MIN_TRAIN_SAMPLES // len(train)) + 1
        train = (train * repeats)[:MIN_TRAIN_SAMPLES]
        random.shuffle(train)

    # 写出
    role_dir = OUTPUT_DIR / role
    role_dir.mkdir(exist_ok=True)

    for split, data in [("train", train), ("valid", valid)]:
        out_path = role_dir / f"{split}.jsonl"
        with open(out_path, "w") as f:
            for item in data:
                f.write(json.dumps(item, ensure_ascii=False) + "\n")

    print(f"[{role}] unique={len(unique)} → train={len(train)} / valid={len(valid)}")
    print(f"  output: {role_dir}")
    return len(unique)


def main():
    print(f"数据根目录：{DATA_ROOT}")
    print(f"输出目录：{OUTPUT_DIR}\n")

    totals = {}
    for role in ["lucas", "andy", "lisa"]:
        totals[role] = prepare_role(role)

    print(f"\n总计：{sum(totals.values())} 条")
    print("\n下一步训练命令：")
    for role in ["lucas", "andy", "lisa"]:
        adapter_out = DATA_ROOT / f"Models/adapters/qwen3vl-{role}"
        data_path = OUTPUT_DIR / role
        print(f"\n# {role}")
        print(f"python3.11 -m mlx_vlm.lora \\")
        print(f"  --model-path ~/HomeAI/Models/mlx/Qwen3-VL-32B-4bit \\")
        print(f"  --dataset {data_path} \\")
        print(f"  --output-path {adapter_out} \\")
        print(f"  --train-mode sft \\")
        print(f"  --iters 200 --batch-size 1 --grad-checkpoint \\")
        print(f"  --lora-rank 8 --lora-alpha 16 \\")
        print(f"  --max-seq-length 2048 --learning-rate 1e-5")


if __name__ == "__main__":
    main()
