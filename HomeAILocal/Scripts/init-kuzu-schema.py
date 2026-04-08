#!/usr/bin/env python3
"""
init-kuzu-schema.py — 初始化 Kuzu 图数据库 schema

在空数据库上创建：
  - Entity 节点表（person / agent / capability / topic / pending_event / pattern）
  - Fact 关系表（人际事实、能力、事件、行为模式等）

幂等：已有表不会报错（IF NOT EXISTS）。

C1 扩展（2026-03-30）：Entity 新增 scope_tags / shadow_status / invited_by / shadow_memory_path
用于 L3 Shadow Agent（访客节点权限控制 + 生命周期管理）。

用法：
  python3 scripts/init-kuzu-schema.py
"""

import os, sys
from pathlib import Path

HOMEAI_ROOT  = Path(__file__).parent.parent
KUZU_DB_PATH = HOMEAI_ROOT / "data" / "kuzu"

def main():
    try:
        import kuzu
    except ImportError:
        print("ERROR: kuzu 未安装。运行：/opt/homebrew/opt/python@3.11/bin/pip3.11 install kuzu", file=sys.stderr)
        sys.exit(1)

    print(f"初始化 Kuzu schema：{KUZU_DB_PATH}")
    db   = kuzu.Database(str(KUZU_DB_PATH))
    conn = kuzu.Connection(db)

    # ── Entity 节点表 ─────────────────────────────────────────────────────────
    # 通用节点：person / agent / capability / topic / pending_event / pattern
    # C1 扩展字段（Shadow Agent）：
    #   scope_tags        — 逗号分隔的标签列表（访客可见知识范围）
    #   shadow_status     — 访客/Shadow Agent 状态：active / archived / revived
    #   invited_by        — 邀请人（userId，如 ZengXiaoLong）
    #   shadow_memory_path — 归档记忆文件路径
    conn.execute("""
        CREATE NODE TABLE IF NOT EXISTS Entity (
            id               STRING,
            type             STRING,
            name             STRING,
            scope_tags       STRING DEFAULT '',
            shadow_status    STRING DEFAULT '',
            invited_by       STRING DEFAULT '',
            shadow_memory_path STRING DEFAULT '',
            PRIMARY KEY (id)
        )
    """)
    print("  ✓ Entity 节点表（含 C1 Shadow Agent 字段）")

    # ── Fact 关系表 ─────────────────────────────────────────────────────────
    # 通用边：人际事实 / 能力 / 事件 / 行为模式 / 话题关联
    # privacy_level: 'public'（群聊）| 'private'（私聊）| 'visitor'（访客）
    conn.execute("""
        CREATE REL TABLE IF NOT EXISTS Fact (
            FROM Entity TO Entity,
            relation        STRING,
            context         STRING,
            valid_from      STRING,
            valid_until     STRING,
            confidence      DOUBLE,
            source_type     STRING,
            source_id       STRING,
            privacy_level   STRING DEFAULT 'private'
        )
    """)
    print("  ✓ Fact 关系表")

    # ── 种子节点：家庭成员（person）+ Agent 锚点 ──────────────────────────────
    # 这些节点是 init-family-relations.py 和 init-capabilities.py 的前提
    seed_entities = [
        # 家庭成员
        {"id": "ZengXiaoLong",      "type": "person", "name": "爸爸曾小龙"},
        {"id": "XiaMoQiuFengLiang", "type": "person", "name": "妈妈张璐"},
        {"id": "ZiFeiYu",           "type": "person", "name": "小姨肖山"},
        {"id": "ZengYueYuTong",     "type": "person", "name": "姐姐黟黟"},
        # lucas 同时是 person 和 agent 锚点，以 person type 为主
        {"id": "lucas",             "type": "person", "name": "Lucas曾璿岐霖"},
        {"id": "andy",              "type": "agent",  "name": "Andy"},
        {"id": "lisa",              "type": "agent",  "name": "Lisa"},
    ]
    for e in seed_entities:
        try:
            conn.execute(
                "MERGE (n:Entity {id: $id}) SET n.type = $type, n.name = $name",
                e,
            )
        except Exception as ex:
            import sys as _sys
            _sys.stderr.write(f"  WARN: 种子节点 {e['id']} 写入失败：{ex}\n")
            _sys.stderr.flush()
    import sys
    sys.stdout.write(f"  ✓ 种子节点写入（{len(seed_entities)} 个）\n")
    sys.stdout.flush()

    # 验证
    r = conn.execute("MATCH (e:Entity) RETURN count(e) AS cnt")
    for row in r:
        sys.stdout.write(f"  当前 Entity 节点数：{row[0]}\n")
        sys.stdout.flush()

    r2 = conn.execute("MATCH ()-[f:Fact]->() RETURN count(f) AS cnt")
    for row in r2:
        sys.stdout.write(f"  当前 Fact 边数：{row[0]}\n")
        sys.stdout.flush()

    sys.stdout.write("schema 初始化完成\n")
    sys.stdout.flush()
    os._exit(0)

if __name__ == "__main__":
    main()
