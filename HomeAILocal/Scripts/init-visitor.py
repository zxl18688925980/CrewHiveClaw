#!/usr/bin/env python3
"""
init-visitor.py — 邀请创建时在 Kuzu 写入访客 Person 节点

调用场景：wecom-entrance gen-invite endpoint 写入 visitor-registry.json 后立即调用。
幂等：节点已存在时更新字段，不重复创建。

用法：
  python3 scripts/init-visitor.py <TOKEN>
  TOKEN 传大写（与 visitor-registry.json key 和 userId 前缀一致）

退出码：0=成功 1=参数缺失 2=kuzu 未安装 3=registry 读取失败
"""

import os, sys, json, datetime
from pathlib import Path

HOMEAI_ROOT       = Path(__file__).parent.parent
KUZU_DB_PATH      = HOMEAI_ROOT / "data" / "kuzu"
VISITOR_REGISTRY  = HOMEAI_ROOT / "data" / "visitor-registry.json"

def main():
    if len(sys.argv) < 2:
        sys.stderr.write("usage: init-visitor.py <TOKEN>\n")
        sys.stderr.flush()
        sys.exit(1)

    token = sys.argv[1].upper()
    entity_id = f"visitor:{token}"

    # ── 读取 visitor-registry.json ─────────────────────────────────────────
    try:
        with open(VISITOR_REGISTRY, "r", encoding="utf-8") as f:
            registry = json.load(f)
    except Exception as e:
        sys.stderr.write(f"ERROR: 无法读取 visitor-registry.json：{e}\n")
        sys.stderr.flush()
        sys.exit(3)

    entry = registry.get(token, {})
    visitor_name    = entry.get("name") or f"访客_{token[:4]}"
    invited_by      = entry.get("invitedBy") or ""
    scope_tags_list = entry.get("scopeTags") or []
    scope_tags      = ",".join(scope_tags_list) if scope_tags_list else ""
    shadow_status   = "active" if entry.get("status") == "active" else "active"

    # ── 写入 Kuzu ──────────────────────────────────────────────────────────
    try:
        import kuzu
    except ImportError:
        sys.stderr.write("ERROR: kuzu 未安装。运行：/opt/homebrew/opt/python@3.11/bin/pip3.11 install kuzu\n")
        sys.stderr.flush()
        sys.exit(2)

    db   = kuzu.Database(str(KUZU_DB_PATH))
    conn = kuzu.Connection(db)

    try:
        conn.execute(
            "MERGE (e:Entity {id: $id}) "
            "SET e.type = 'person', e.name = $name, "
            "    e.scope_tags = $tags, e.shadow_status = $status, "
            "    e.invited_by = $invby, e.shadow_memory_path = ''",
            {
                "id":    entity_id,
                "name":  visitor_name,
                "tags":  scope_tags,
                "status": shadow_status,
                "invby": invited_by,
            },
        )
        sys.stdout.write(f"visitor node: {entity_id} ({visitor_name}) 写入成功\n")
        sys.stdout.flush()
    except Exception as e:
        sys.stderr.write(f"ERROR: Kuzu 写入失败：{e}\n")
        sys.stderr.flush()
        os._exit(1)

    os._exit(0)  # bypass kuzu Database::~Database() SIGBUS on macOS ARM64

if __name__ == "__main__":
    main()
