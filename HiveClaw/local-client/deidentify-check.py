#!/usr/bin/env python3
"""
去标识化检查工具（本地端，上传前必跑）

检测语料中的高风险 PII（个人可识别信息），
帮助 SE 在上传前发现需要处理的内容。

用法：
  python3 deidentify-check.py --file corpus.jsonl
  python3 deidentify-check.py --file corpus.jsonl --strict  # 严格模式，任何命中都阻断
"""

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any


# ─── PII 检测规则 ────────────────────────────────────────────────────────────

# (规则名, 正则, 风险级别: high/medium, 处理建议)
PII_PATTERNS: list[tuple[str, re.Pattern[str], str, str]] = [
    # 高风险：直接可识别
    ("手机号",        re.compile(r'1[3-9]\d{9}'),                     "high",   "替换为 [手机号]"),
    ("身份证号",      re.compile(r'\d{17}[\dXx]'),                     "high",   "替换为 [身份证]"),
    ("银行卡号",      re.compile(r'\d{16,19}'),                        "high",   "替换为 [卡号]"),
    ("邮箱地址",      re.compile(r'[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}'), "high", "替换为 [邮箱]"),
    ("具体金额",      re.compile(r'[￥¥]\s*\d+[\d,]*(\.\d+)?'),       "medium", "替换为 [金额]"),
    ("具体日期",      re.compile(r'20\d{2}[年\-/]\d{1,2}[月\-/]\d{1,2}[日]?'), "medium", "替换为 [某天]"),
    # 中风险：需人工判断
    ("IP地址",        re.compile(r'\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b'), "medium", "替换为 [IP]"),
    ("微信号",        re.compile(r'微信[号：:]\s*\S+'),                "medium", "替换为 [微信号]"),
    ("地址信息",      re.compile(r'(省|市|区|县|街道|路|号楼|室).{0,20}(省|市|区|县|街道|路|号楼|室)'), "medium", "替换为 [地址]"),
]


def check_text(text: str) -> list[dict[str, Any]]:
    """返回在 text 中检测到的 PII 条目列表。"""
    findings: list[dict[str, Any]] = []
    for name, pattern, level, suggestion in PII_PATTERNS:
        matches = list(pattern.finditer(text))
        for m in matches:
            findings.append({
                "type": name,
                "level": level,
                "match": m.group()[:50],   # 只展示前 50 字符
                "position": m.start(),
                "suggestion": suggestion,
            })
    return findings


def check_entry(item: dict[str, Any], idx: int) -> list[dict[str, Any]]:
    """检查单条语料的所有文本字段。"""
    texts_to_check: list[tuple[str, str]] = []  # (字段名, 内容)

    content = item.get("content", {})
    for field in ("prompt", "chosen", "rejected", "output"):
        val = content.get(field)
        if val:
            texts_to_check.append((f"content.{field}", val))

    all_findings: list[dict[str, Any]] = []
    for field_name, text in texts_to_check:
        findings = check_text(text)
        for f in findings:
            all_findings.append({**f, "entry_idx": idx, "field": field_name})

    return all_findings


def main() -> None:
    parser = argparse.ArgumentParser(description="HiveClaw 去标识化检查工具")
    parser.add_argument("--file",   required=True, help="JSONL 语料文件路径")
    parser.add_argument("--strict", action="store_true",
                        help="严格模式：任何命中（包括 medium）都以非零退出码阻断上传")
    args = parser.parse_args()

    path = Path(args.file)
    if not path.exists():
        print(f"错误：文件不存在：{path}", file=sys.stderr)
        sys.exit(1)

    lines = path.read_text(encoding="utf-8").splitlines()
    lines = [l.strip() for l in lines if l.strip()]

    all_findings: list[dict[str, Any]] = []
    parse_errors = 0

    for i, line in enumerate(lines, 1):
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            parse_errors += 1
            continue
        findings = check_entry(item, i)
        all_findings.extend(findings)

    # ── 输出 ──────────────────────────────────────────────────────────────────

    high_risk   = [f for f in all_findings if f["level"] == "high"]
    medium_risk = [f for f in all_findings if f["level"] == "medium"]

    print(f"\n{'='*60}")
    print(f"文件：{path}  共 {len(lines)} 条")
    print(f"高风险命中：{len(high_risk)}  中风险命中：{len(medium_risk)}")
    print(f"{'='*60}")

    if high_risk:
        print("\n🔴 高风险（必须处理后才能上传）：")
        for f in high_risk:
            print(f"  第{f['entry_idx']}条 [{f['field']}] {f['type']}：「{f['match']}」→ {f['suggestion']}")

    if medium_risk:
        print("\n🟡 中风险（请人工判断是否需要处理）：")
        for f in medium_risk:
            print(f"  第{f['entry_idx']}条 [{f['field']}] {f['type']}：「{f['match']}」→ {f['suggestion']}")

    if not all_findings:
        print("\n✅ 未检测到 PII，可以进入上传流程")
        print("   提醒：自动检测有局限性，请人工再确认一遍组织名称、成员姓名等未被规则覆盖的内容")
        sys.exit(0)

    if high_risk or (args.strict and medium_risk):
        print(f"\n❌ 请处理以上风险后重新运行检查")
        sys.exit(1)
    else:
        print(f"\n⚠️  存在中风险条目，已人工确认后可继续")
        print(f"    使用 --strict 模式可将中风险也视为阻断")
        sys.exit(0)


if __name__ == "__main__":
    main()
