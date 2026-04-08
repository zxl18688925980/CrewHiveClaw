#!/usr/bin/env python3
"""
init-interaction-preferences.py — 手工初始化各家人与 Lucas 的协作交互风格

写入 Kuzu interaction_preference Fact，蒸馏管道后续可自动更新。
幂等：重复运行会覆盖旧值。

用法：
  /opt/homebrew/opt/python@3.11/bin/python3.11 scripts/init-interaction-preferences.py

运行后需执行：
  /opt/homebrew/opt/python@3.11/bin/python3.11 scripts/render-knowledge.py
  以刷新 .inject.md 文件。
"""

import os, sys, datetime
from pathlib import Path

HOMEAI_ROOT  = Path(__file__).parent.parent
KUZU_DB_PATH = HOMEAI_ROOT / "data" / "kuzu"

# ── 各家人初始交互偏好 ─────────────────────────────────────────────────────────
# name:    一行摘要（注入档案时显示为子标题）
# context: 多行结构化描述（换行分隔，每行渲染为一个 bullet）
#   格式约定：「默认：…」「例外：…」「信号：…」
INTERACTION_PREFERENCES = {
    "ZengXiaoLong": {
        "name": "高自主·少打扰",
        "context": (
            "默认：高自主，需求6项有答案后直接触发流水线，不需要复述确认，完成时报告结果。\n"
            "例外：涉及外部关系（访客/第三方）、修改影响全家的核心功能、首次做某类事→先复述理解再执行。\n"
            "信号：说「你看着办」「直接做」→减少打扰；问「进展怎么样」→他想了解，主动报一次进度。"
        ),
    },
    "XiaMoQiuFengLiang": {
        "name": "关注结果·轻量交互",
        "context": (
            "默认：告知「已安排处理中」即可，不汇报中间步骤，完成时说明结果。\n"
            "涉及黟黟：不自己做决策，先听完她的意思，她没问就不给建议，她问了才说。\n"
            "信号：她主动问「做到哪了」→才报进展；她说「你帮我想想」→才给选项，先陈述再问她倾向。"
        ),
    },
    "ZiFeiYu": {
        "name": "需要被看见·关键节点报进度",
        "context": (
            "默认：创业相关事项每个关键节点说一声，她需要感知到在往前走，安全感来自可见的进展。\n"
            "情感类：她说了什么，先认可她的付出和处境，再提具体建议；直接给方案会显得没听见她说话。\n"
            "信号：说「你直接帮我搞定」→重在结果，减少汇报；问「这样行吗」→她在等你的判断，给明确意见。"
        ),
    },
}


def main():
    try:
        import kuzu
    except ImportError:
        print("ERROR: kuzu 未安装。运行：/opt/homebrew/opt/python@3.11/bin/pip3.11 install kuzu",
              file=sys.stderr)
        sys.exit(1)

    print(f"初始化交互偏好 @ {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Kuzu DB: {KUZU_DB_PATH}\n")

    db   = kuzu.Database(str(KUZU_DB_PATH))
    conn = kuzu.Connection(db)
    now  = datetime.datetime.now().isoformat()

    for user_id, pref in INTERACTION_PREFERENCES.items():
        topic_id = f"interaction_preference_{user_id}"

        # Upsert topic entity
        conn.execute(
            "MERGE (e:Entity {id: $id}) SET e.type = 'topic', e.name = $name",
            {"id": topic_id, "name": pref["name"]},
        )

        # 删旧 Fact（幂等，忽略不存在的情况）
        try:
            conn.execute(
                "MATCH (p:Entity {id: $pid})-[f:Fact {relation: 'interaction_preference'}]->(o:Entity {id: $oid}) "
                "DELETE f",
                {"pid": user_id, "oid": topic_id},
            )
        except Exception:
            pass

        # 写新 Fact
        conn.execute(
            "MATCH (p:Entity {id: $pid}), (o:Entity {id: $oid}) "
            "CREATE (p)-[:Fact {"
            "  relation:    $rel,  "
            "  context:     $ctx,  "
            "  valid_from:  $from, "
            "  confidence:  0.9,   "
            "  source_type: 'manual', "
            "  source_id:   'init_interaction_prefs'"
            "}]->(o)",
            {
                "pid": user_id,
                "oid": topic_id,
                "rel": "interaction_preference",
                "ctx": pref["context"],
                "from": now,
            },
        )
        print(f"  ✓ {user_id}  →  {pref['name']}")

    sys.stdout.flush()
    print("\n完成。运行 render-knowledge.py 刷新 inject.md：")
    print("  /opt/homebrew/opt/python@3.11/bin/python3.11 scripts/render-knowledge.py")
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
