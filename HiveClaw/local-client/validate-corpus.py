#!/usr/bin/env python3
"""
语料格式校验工具（本地端，可实际运行）

用法：
  # 校验格式
  python3 validate-corpus.py --file corpus.jsonl

  # Dry-run 模式（校验但不上传，打印将上传的内容摘要）
  python3 validate-corpus.py --file corpus.jsonl --dry-run

  # 指定角色过滤
  python3 validate-corpus.py --file corpus.jsonl --role andy
"""

import argparse
import json
import sys
from pathlib import Path
from typing import Any


REQUIRED_FIELDS = {"role", "type", "instance_id", "content", "tags", "quality_score", "uploaded_at"}
VALID_ROLES     = {"lucas", "andy", "lisa"}
VALID_TYPES     = {"dpo", "sft", "pattern"}


def validate_entry(item: dict[str, Any], idx: int) -> list[str]:
    errors: list[str] = []

    # 必填字段
    for field in REQUIRED_FIELDS:
        if field not in item:
            errors.append(f"第{idx}条：缺少必填字段 `{field}`")

    if errors:
        return errors  # 缺字段时跳过后续校验

    # 角色和类型合法性
    if item["role"] not in VALID_ROLES:
        errors.append(f"第{idx}条：role `{item['role']}` 不合法，应为 {VALID_ROLES}")

    if item["type"] not in VALID_TYPES:
        errors.append(f"第{idx}条：type `{item['type']}` 不合法，应为 {VALID_TYPES}")

    # content 结构校验
    content = item.get("content", {})
    if not isinstance(content, dict):
        errors.append(f"第{idx}条：content 必须是对象")
        return errors

    if not content.get("prompt"):
        errors.append(f"第{idx}条：content.prompt 不可为空")

    if item["type"] == "dpo":
        if not content.get("chosen"):
            errors.append(f"第{idx}条：type=dpo 时 content.chosen 不可为空")
        if not content.get("rejected"):
            errors.append(f"第{idx}条：type=dpo 时 content.rejected 不可为空")

    if item["type"] == "sft":
        if not content.get("output"):
            errors.append(f"第{idx}条：type=sft 时 content.output 不可为空")

    # 质量分范围
    score = item.get("quality_score", -1)
    if not isinstance(score, (int, float)) or not (0.0 <= score <= 1.0):
        errors.append(f"第{idx}条：quality_score 应在 0-1 之间，当前值：{score}")

    # tags 结构
    if not isinstance(item.get("tags"), list):
        errors.append(f"第{idx}条：tags 必须是数组")

    return errors


def main() -> None:
    parser = argparse.ArgumentParser(description="HiveClaw 语料格式校验工具")
    parser.add_argument("--file",     required=True, help="JSONL 语料文件路径")
    parser.add_argument("--role",     default=None,  help="只校验指定角色（lucas/andy/lisa）")
    parser.add_argument("--dry-run",  action="store_true", help="校验通过后打印将上传的内容摘要")
    args = parser.parse_args()

    path = Path(args.file)
    if not path.exists():
        print(f"错误：文件不存在：{path}", file=sys.stderr)
        sys.exit(1)

    lines = path.read_text(encoding="utf-8").splitlines()
    lines = [l.strip() for l in lines if l.strip()]

    all_errors: list[str] = []
    valid_items: list[dict[str, Any]] = []

    for i, line in enumerate(lines, 1):
        try:
            item = json.loads(line)
        except json.JSONDecodeError as e:
            all_errors.append(f"第{i}条：JSON 解析失败 ({e})")
            continue

        if args.role and item.get("role") != args.role:
            continue  # 角色过滤

        errs = validate_entry(item, i)
        if errs:
            all_errors.extend(errs)
        else:
            valid_items.append(item)

    # ── 输出结果 ──────────────────────────────────────────────────────────────

    print(f"\n{'='*60}")
    print(f"文件：{path}")
    print(f"总行数：{len(lines)}  有效：{len(valid_items)}  错误：{len(all_errors)}")
    print(f"{'='*60}")

    if all_errors:
        print("\n❌ 校验错误：")
        for err in all_errors:
            print(f"  {err}")

    if valid_items and args.dry_run:
        print("\n📋 Dry-run 摘要（将上传的语料）：")

        by_role: dict[str, list[dict[str, Any]]] = {}
        for item in valid_items:
            r = item["role"]
            by_role.setdefault(r, []).append(item)

        for role, items in sorted(by_role.items()):
            by_type: dict[str, int] = {}
            scores = [item["quality_score"] for item in items]
            for item in items:
                by_type[item["type"]] = by_type.get(item["type"], 0) + 1
            avg_score = sum(scores) / len(scores) if scores else 0
            type_summary = ", ".join(f"{t}×{c}" for t, c in sorted(by_type.items()))
            print(f"  [{role}] {len(items)} 条 | 类型：{type_summary} | 平均质量分：{avg_score:.3f}")

        print(f"\n注意：Dry-run 模式，以上内容未实际上传。")
        print(f"实际上传命令（云端就绪后）：")
        print(f"  curl -X POST https://hive.{{domain}}/api/corpus/upload \\")
        print(f"    -H 'Authorization: Bearer {{api_key}}' \\")
        print(f"    -H 'Content-Type: application/x-ndjson' \\")
        print(f"    --data-binary @{path}")

    if all_errors:
        sys.exit(1)
    else:
        print("\n✅ 校验通过")
        sys.exit(0)


if __name__ == "__main__":
    main()
