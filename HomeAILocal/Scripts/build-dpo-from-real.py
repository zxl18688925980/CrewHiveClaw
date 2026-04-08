#!/usr/bin/env python3
"""
从 ChromaDB 真实对话中提取 rejected 样本，按 AGENTS.md 铁律生成 chosen，
输出 data/finetune/dpo-review.jsonl 供人工审核，
审核通过后写入 data/finetune/dpo-final.jsonl。
"""

import json
import re
import os

os.environ.setdefault("ANONYMIZED_TELEMETRY", "False")
import chromadb

OUTPUT_REVIEW = os.path.expanduser("~/HomeAI/data/finetune/dpo-review.jsonl")
OUTPUT_FINAL  = os.path.expanduser("~/HomeAI/data/finetune/dpo-final.jsonl")
os.makedirs(os.path.dirname(OUTPUT_REVIEW), exist_ok=True)

client = chromadb.HttpClient(host="localhost", port=8000)
col = client.get_collection("conversations")
results = col.get(limit=500, include=["documents", "metadatas"])

pairs = []

# ─────────────────────────────────────────
# 规则 1：## / ### 标题滥用 → 去掉 Markdown 标题符号
# ─────────────────────────────────────────
def fix_headers(text):
    """把 ## xxx 改成 **xxx**，把 ### xxx 改成 **xxx**，保留 ** bold 和列表"""
    # ## 标题 → **标题**
    text = re.sub(r'^#{1,3}\s+(.+)$', r'**\1**', text, flags=re.MULTILINE)
    # 独立的 --- 分割线直接删除
    text = re.sub(r'^\s*---+\s*$', '', text, flags=re.MULTILINE)
    # 多余空行压缩为最多两行
    text = re.sub(r'\n{3,}', '\n\n', text)
    return text.strip()

for doc, meta in zip(results["documents"], results["metadatas"]):
    prompt   = meta.get("prompt", "").strip()
    response = meta.get("response", "").strip()
    source   = meta.get("source", "")
    ts       = meta.get("timestamp", "")

    if not prompt or not response:
        continue

    # ── 规则 1：## 标题 ──────────────────────────
    if re.search(r'^#{1,3}\s+', response, re.MULTILINE):
        chosen = fix_headers(response)
        if chosen != response:
            pairs.append({
                "rule": "no_markdown_headers",
                "prompt": prompt,
                "rejected": response,
                "chosen": chosen,
                "source": source,
                "timestamp": ts,
                "review_status": "pending",   # human 改为 approved / edited / rejected
                "review_note": ""
            })

    # ── 规则 2：幻觉承诺（声称已检查/权限已开通） ──
    hallucination_patterns = [
        r'我刚才检查了一下',
        r'权限应该已经开通',
        r'我的权限已经开通',
        r'已经检查过了',
        r'系统配置已检查',
    ]
    if any(re.search(p, response) for p in hallucination_patterns):
        # 找到幻觉句，替换为铁律规定的诚实回复
        chosen = re.sub(
            r'[（\(]?我刚才检查了一下[，,].*?[。\.）\)]',
            '（这个我没有工具确认，需要爸爸在后台核实一下。）',
            response
        )
        chosen = re.sub(
            r'[（\(]?我的权限已经开通了[，,].*?[。\.）\)]',
            '',
            chosen
        )
        chosen = re.sub(
            r'权限应该已经开通了[？?]?',
            '权限状态我这边看不到，需要爸爸确认一下',
            chosen
        )
        chosen = chosen.strip()
        if chosen != response:
            pairs.append({
                "rule": "no_hallucination",
                "prompt": prompt,
                "rejected": response,
                "chosen": chosen,
                "source": source,
                "timestamp": ts,
                "review_status": "pending",
                "review_note": ""
            })

print(f"共提取 {len(pairs)} 个 DPO 候选对")
print(f"  - no_markdown_headers: {sum(1 for p in pairs if p['rule'] == 'no_markdown_headers')}")
print(f"  - no_hallucination:    {sum(1 for p in pairs if p['rule'] == 'no_hallucination')}")

with open(OUTPUT_REVIEW, "w") as f:
    for p in pairs:
        f.write(json.dumps(p, ensure_ascii=False) + "\n")

print(f"\n输出到：{OUTPUT_REVIEW}")
print("请打开该文件，将 review_status 改为：")
print("  approved  → 直接使用")
print("  edited    → 修改了 chosen 字段后使用")
print("  rejected  → 不用这条")
print(f"\n审核完成后运行：python3 {__file__} --finalize")

# ── finalize 模式：把 approved/edited 的写入 dpo-final.jsonl ──
import sys
if "--finalize" in sys.argv:
    final = []
    with open(OUTPUT_REVIEW) as f:
        for line in f:
            p = json.loads(line)
            if p.get("review_status") in ("approved", "edited"):
                final.append({
                    "prompt":   p["prompt"],
                    "chosen":   p["chosen"],
                    "rejected": p["rejected"],
                    "type":     "preference",
                    "rule":     p["rule"],
                })
    with open(OUTPUT_FINAL, "w") as f:
        for item in final:
            f.write(json.dumps(item, ensure_ascii=False) + "\n")
    print(f"最终 DPO 数据：{len(final)} 条 → {OUTPUT_FINAL}")
