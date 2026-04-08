#!/usr/bin/env python3
"""
confirm-dpo-candidates.py — DPO 候选批量确认（规则派生 good_response）

用法：
  python3 scripts/confirm-dpo-candidates.py          # 处理所有未确认候选
  python3 scripts/confirm-dpo-candidates.py --dry-run  # 预览，不写文件

逻辑：
  对 dpo-candidates.jsonl 中 confirmed=false 且 good_response="" 的记录，
  按 reason 类型用规则自动派生 good_response：
    pretend_doing / false_commitment → 把假承诺语言替换成"我现在去做"表述
    capability_hallucination       → 把幻觉能力描述替换成降级说明
  生成的 good_response 写回文件（confirmed=true），
  同时调用 export-dpo-confirmed.py 追加到 dpo-final.jsonl。

注意：规则派生质量足够用于训练负例对齐（把幻觉方向推低），
      但不如教师模型精确。积累到 100+ 对之后建议切换教师模型确认。
"""

import json
import os
import re
import sys
from pathlib import Path

HOMEAI_ROOT    = Path(os.environ.get("HOMEAI_ROOT", Path.home() / "HomeAI"))
CANDIDATES_FILE = HOMEAI_ROOT / "data/learning/dpo-candidates.jsonl"

DRY_RUN = "--dry-run" in sys.argv

# ── 规则：假承诺语言 → 正确表述 ──────────────────────────────────────────────

# 需要替换的假承诺词语（对应 dpo-patterns.json 里的模式）
FALSE_COMMIT_PATTERNS = [
    ("已提交开发", "我现在触发开发流程"),
    ("已交给Andy", "我去联系 Andy"),
    ("已触发开发", "我现在触发开发流程"),
    ("已发送", "我现在发送"),
    ("已告知", "我现在告知"),
    ("已通知", "我现在通知"),
    ("已转达", "我现在转达"),
    ("已查到", "我去查一下"),
    ("已搜索", "我去搜索"),
    ("已叫停", "我去叫停"),
    ("已取消", "我去取消"),
    ("正在为你", "我去帮你"),
    ("正在帮你", "我去帮你"),
    ("正在处理", "我去处理"),
]

# 幻觉能力模式
HALLUCIN_PATTERNS = [
    ("我可以直接控制", "我没有直接控制的能力，"),
    ("我能直接", "我没有直接操作的能力，"),
]


def derive_good_response(bad_response: str, reasons: list[str]) -> str:
    """按 reason 类型派生 good_response。"""
    text = bad_response

    has_pretend     = any("pretend_doing" in r for r in reasons)
    has_commit      = any("false_commitment" in r for r in reasons)
    has_hallucin    = any("capability_hallucination" in r for r in reasons)

    if has_pretend or has_commit:
        for wrong, right in FALSE_COMMIT_PATTERNS:
            text = text.replace(wrong, right)
        # 通用降级：把 Markdown 粗体里的假承诺也处理掉
        text = re.sub(r"(✅|✓)\s*(.*?)(已提交|已完成|已发送|已触发)", r"⏳ \2（待触发）", text)

    if has_hallucin:
        for wrong, right in HALLUCIN_PATTERNS:
            text = text.replace(wrong, right)

    return text.strip()


def process():
    if not CANDIDATES_FILE.exists():
        print(f"候选文件不存在：{CANDIDATES_FILE}")
        return

    records = []
    with open(CANDIDATES_FILE) as f:
        for line in f:
            line = line.strip()
            if line:
                records.append(json.loads(line))

    updated = 0
    for rec in records:
        if rec.get("confirmed") or rec.get("good_response"):
            continue  # 已处理，跳过

        good = derive_good_response(rec["bad_response"], rec.get("reasons", []))
        if good and good != rec["bad_response"]:
            rec["good_response"] = good
            rec["confirmed"] = True
            rec["confirm_method"] = "rule_based"
            updated += 1
            if DRY_RUN:
                print(f"\n--- 候选 (reason: {rec['reasons']}) ---")
                print(f"BAD:  {rec['bad_response'][:120]}")
                print(f"GOOD: {good[:120]}")

    print(f"共 {len(records)} 条候选，本次规则派生确认 {updated} 条。")

    if DRY_RUN:
        print("\n[dry-run 模式，未写文件]")
        return

    # 写回
    with open(CANDIDATES_FILE, "w") as f:
        for rec in records:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print(f"已写回 {CANDIDATES_FILE}")

    # 触发导出
    export_script = HOMEAI_ROOT / "scripts/export-dpo-confirmed.py"
    if export_script.exists():
        import subprocess
        subprocess.run([sys.executable, str(export_script)], check=False)


if __name__ == "__main__":
    process()
    import os as _os
    _os.sys.exit(0)
