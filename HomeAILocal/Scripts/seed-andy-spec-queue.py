#!/usr/bin/env python3
"""
seed-andy-spec-queue.py

把 ~/.openclaw/workspace-andy/ 下已有的 spec 文件作为种子数据写入
andy-spec-finetune-queue.jsonl。

种子数据没有真实的 requirementId 对应，outcome 设为
{"exitCode": 0, "specMatchRate": null, "timestamp": "seed", "note": "manual-seed"}，
eligibleForTraining = True（人工确认质量良好）。

用法：
    python3 seed-andy-spec-queue.py [--dry-run]
"""

import json
import os
import re
import sys
from datetime import datetime
from pathlib import Path

ANDY_WORKSPACE = Path.home() / ".openclaw" / "workspace-andy"
QUEUE_FILE = Path.home() / "HomeAI" / "Data" / "learning" / "andy-spec-finetune-queue.jsonl"
TASK_REGISTRY = Path.home() / "HomeAI" / "Data" / "learning" / "task-registry.json"

DRY_RUN = "--dry-run" in sys.argv

# spec 文件候选（root + specs/ 子目录）
SPEC_CANDIDATES = [
    "spec.md",
    "spec_final.md",
    "spec_json.md",
    "spec_json_v2.md",
    "spec_v2.md",
    "spec_lucas_self_improvement.md",
    "spec-demo-chat-voice.md",
    "specs/agent-skill-self-solidification.md",
    "specs/agent-skill-self-solidification-simplified.md",
    "specs/agent-skill-self-solidification-full.md",
    "specs/l2-planning-mode.md",
    "specs/l2-planning-mode-full.md",
]


def load_task_registry():
    if not TASK_REGISTRY.exists():
        return []
    try:
        return json.loads(TASK_REGISTRY.read_text("utf-8"))
    except Exception:
        return []


def extract_spec_quality(spec_text: str) -> dict:
    """从 spec 文本提取质量指标。"""
    quality = {
        "hasIntegrationPoints": False,
        "hasAcceptanceCriteria": False,
        "hasCodeEvidence": False,
        "integrationPointCount": 0,
    }
    m = re.search(r"```json\s*([\s\S]*?)```", spec_text)
    if m:
        try:
            sd = json.loads(m.group(1))
            ips = sd.get("integration_points", [])
            acs = sd.get("acceptance_criteria", [])
            ce  = sd.get("code_evidence", [])
            quality["hasIntegrationPoints"]  = len(ips) > 0
            quality["hasAcceptanceCriteria"] = len(acs) > 0
            quality["hasCodeEvidence"]       = len(ce)  > 0
            quality["integrationPointCount"] = len(ips)
        except Exception:
            pass
    return quality


def load_existing_ids() -> set:
    """读取队列中已有的条目 id，避免重复写入。"""
    if not QUEUE_FILE.exists():
        return set()
    ids = set()
    for line in QUEUE_FILE.read_text("utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            e = json.loads(line)
            ids.add(e.get("id", ""))
        except Exception:
            pass
    return ids


def main():
    tasks = load_task_registry()
    existing_ids = load_existing_ids()

    entries = []
    for rel_path in SPEC_CANDIDATES:
        spec_path = ANDY_WORKSPACE / rel_path
        if not spec_path.exists():
            print(f"  [skip] {rel_path} — 文件不存在")
            continue

        spec_text = spec_path.read_text("utf-8")
        spec_quality = extract_spec_quality(spec_text)

        # 尝试从 spec 文件名或内容中推断 requirementId
        req_id = ""
        m_req = re.search(r'requirement_id["\s:]+([a-z0-9_]+)', spec_text, re.IGNORECASE)
        if m_req:
            req_id = m_req.group(1)

        # 匹配 task-registry 中的需求
        task_entry = None
        if req_id:
            task_entry = next((t for t in tasks if t.get("id") == req_id), None)

        seed_id = f"seed-{spec_path.stem}-{int(spec_path.stat().st_mtime)}"
        if seed_id in existing_ids:
            print(f"  [skip] {rel_path} — 已存在（id={seed_id}）")
            continue

        entry = {
            "id": seed_id,
            "createdAt": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "requirementId": req_id,
            "requirement": task_entry.get("requirement", "") if task_entry else "",
            "lucasContext": task_entry.get("lucasContext", "") if task_entry else "",
            "spec": spec_text,
            "specQuality": spec_quality,
            "outcome": {
                "exitCode": 0,
                "specMatchRate": None,
                "timestamp": "seed",
                "note": "manual-seed",
            },
            "eligibleForTraining": True,
            "sourceFile": rel_path,
        }
        entries.append(entry)
        q_mark = "✅" if spec_quality["hasIntegrationPoints"] else "⚠️ "
        print(f"  {q_mark} {rel_path} "
              f"(ip={spec_quality['integrationPointCount']}, "
              f"ac={spec_quality['hasAcceptanceCriteria']}, "
              f"ce={spec_quality['hasCodeEvidence']})")

    print(f"\n共找到 {len(entries)} 条新种子数据")

    if DRY_RUN:
        print("[dry-run] 不写入文件")
        return

    if not entries:
        print("没有新数据，退出")
        return

    QUEUE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with QUEUE_FILE.open("a", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")

    print(f"已写入 {QUEUE_FILE}")
    # 统计队列总量
    total = sum(1 for line in QUEUE_FILE.read_text("utf-8").splitlines() if line.strip())
    print(f"队列总条目：{total}")


if __name__ == "__main__":
    main()
