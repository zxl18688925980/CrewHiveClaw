#!/usr/bin/env python3
"""
初始化家庭成员人际关系（Kuzu person→person Fact 边）

包含：婚姻 / 亲子 / 姐妹 / 姻亲等静态结构性关系
幂等可重复运行：先清除 source_type='family_structure' 旧边，再写入新边

运行后自动触发 render-knowledge.py，刷新所有家人的 .inject.md

用法：
  python3 scripts/init-family-relations.py
"""

import os, sys, datetime, subprocess
from pathlib import Path

HOMEAI_ROOT  = Path(__file__).parent.parent
KUZU_DB_PATH = HOMEAI_ROOT / "data" / "kuzu"

# ── 家庭成员显示名（用于日志）────────────────────────────────────────────────
MEMBER_NAMES = {
    "ZengXiaoLong":      "爸爸曾小龙",
    "XiaMoQiuFengLiang": "妈妈张璐",
    "ZiFeiYu":           "小姨肖山",
    "ZengYueYuTong":     "姐姐黟黟",
    "lucas":             "Lucas曾璿岐霖",
}

# ── 结构性人际关系表 ──────────────────────────────────────────────────────────
# (from_id, to_id, relation, context)
#
# relation 语义：
#   spouse_of  — 配偶
#   parent_of  — 子女（from 是家长视角）
#   child_of   — 家长（from 是孩子视角）
#   sibling_of — 兄弟姐妹
#   in_law_of  — 姻亲（含妻妹、姐夫、外甥女等）
#
# context = 从 from 视角描述此关系的一句话（渲染进 inject.md 括号内）

FAMILY_RELATIONS = [
    # ── 夫妻 ─────────────────────────────────────────────────────────────────
    ("ZengXiaoLong",      "XiaMoQiuFengLiang", "spouse_of",  ""),
    ("XiaMoQiuFengLiang", "ZengXiaoLong",      "spouse_of",  ""),

    # ── 父母→子女（姐姐 + Lucas）──────────────────────────────────────────────
    ("ZengXiaoLong",      "ZengYueYuTong",     "parent_of",  "女儿，七年级"),
    ("XiaMoQiuFengLiang", "ZengYueYuTong",     "parent_of",  "女儿，七年级"),
    ("ZengXiaoLong",      "lucas",             "parent_of",  "儿子"),
    ("XiaMoQiuFengLiang", "lucas",             "parent_of",  "儿子"),

    # ── 子女→父母 ─────────────────────────────────────────────────────────────
    ("ZengYueYuTong",     "ZengXiaoLong",      "child_of",   ""),
    ("ZengYueYuTong",     "XiaMoQiuFengLiang", "child_of",   ""),
    ("lucas",             "ZengXiaoLong",      "child_of",   ""),
    ("lucas",             "XiaMoQiuFengLiang", "child_of",   ""),

    # ── 姐弟 ─────────────────────────────────────────────────────────────────
    ("ZengYueYuTong",     "lucas",             "sibling_of", "弟弟"),
    ("lucas",             "ZengYueYuTong",     "sibling_of", "姐姐"),

    # ── 姐妹（小姨是妈妈的妹妹）──────────────────────────────────────────────
    ("XiaMoQiuFengLiang", "ZiFeiYu",           "sibling_of", "妹妹"),
    ("ZiFeiYu",           "XiaMoQiuFengLiang", "sibling_of", "姐姐"),

    # ── 姻亲 ─────────────────────────────────────────────────────────────────
    ("ZengXiaoLong",      "ZiFeiYu",           "in_law_of",  "妻妹"),
    ("ZiFeiYu",           "ZengXiaoLong",      "in_law_of",  "姐夫"),
    ("ZengYueYuTong",     "ZiFeiYu",           "in_law_of",  "小姨"),
    ("ZiFeiYu",           "ZengYueYuTong",     "in_law_of",  "外甥女"),
    ("lucas",             "ZiFeiYu",           "in_law_of",  "小姨"),
    ("ZiFeiYu",           "lucas",             "in_law_of",  "外甥"),
]


def get_kuzu_conn():
    try:
        import kuzu
        db = kuzu.Database(str(KUZU_DB_PATH))
        return kuzu.Connection(db)
    except ImportError:
        print("ERROR: kuzu 未安装，运行 pip3 install kuzu", file=sys.stderr)
        sys.exit(1)


def main():
    try:
        conn = get_kuzu_conn()
        now_iso = datetime.datetime.now().isoformat()

        # ── 确保 lucas 实体名称正确（agent 节点已存在，更新显示名）─────────────────
        try:
            conn.execute(
                "MATCH (e:Entity {id: 'lucas'}) SET e.name = 'Lucas曾璿岐霖'",
            )
            print("已更新 lucas 实体名称")
        except Exception as e:
            print(f"lucas 实体名称更新：{e}")

        # ── 清除旧 family_structure 边（含旧命名如 married_to）────────────────────
        try:
            # 清除新命名的 family_structure 边
            conn.execute(
                "MATCH ()-[f:Fact {source_type: 'family_structure'}]->() DELETE f"
            )
            # 清除曾用过的 married_to 边（旧命名，统一替换）
            conn.execute(
                "MATCH ()-[f:Fact {relation: 'married_to'}]->() DELETE f"
            )
            print("已清除旧关系边（family_structure / married_to）")
        except Exception as e:
            print(f"清除旧边：{e}（可能无旧数据，继续）")

        # ── 写入新边 ──────────────────────────────────────────────────────────────
        written = 0
        for from_id, to_id, relation, context in FAMILY_RELATIONS:
            from_name = MEMBER_NAMES.get(from_id, from_id)
            to_name   = MEMBER_NAMES.get(to_id, to_id)
            try:
                conn.execute(
                    "MATCH (a:Entity {id: $fid}), (b:Entity {id: $tid}) "
                    "CREATE (a)-[:Fact {relation: $rel, context: $ctx, "
                    "valid_from: $now, confidence: 1.0, "
                    "source_type: 'family_structure', source_id: 'init-family-relations'}]->(b)",
                    {"fid": from_id, "tid": to_id, "rel": relation, "ctx": context, "now": now_iso},
                )
                ctx_str = f"（{context}）" if context else ""
                print(f"  + {from_name} -[{relation}]-> {to_name}{ctx_str}")
                written += 1
            except Exception as e:
                print(f"  ! {from_id} -[{relation}]-> {to_id}: {e}")

        print(f"\n写入完成：{written}/{len(FAMILY_RELATIONS)} 条关系边")

        # ── 触发知识渲染（Popen fire-and-forget：父进程 os._exit 释放 Kuzu 锁后子进程再接管）
        print("\n── 触发知识渲染（父进程退出后运行）──")
        subprocess.Popen(
            [sys.executable, str(HOMEAI_ROOT / "scripts" / "render-knowledge.py")],
            cwd=str(HOMEAI_ROOT),
            start_new_session=True,
        )
        print("完成。inject.md 将在后台刷新，下次 Gateway 重启后生效。")
    finally:
        os._exit(0)  # 释放 Kuzu 文件锁；bypass Database::~Database() SIGBUS on macOS ARM64；异常路径同样触发


if __name__ == "__main__":
    main()
