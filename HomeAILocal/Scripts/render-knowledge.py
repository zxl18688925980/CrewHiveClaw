#!/usr/bin/env python3
"""
render-knowledge.py — 静态知识渲染管道

三个模式：
  --seed         从现有 .inject.md 文件提取结构化事实写入 Kuzu（一次性初始化）
  --agent AGENT  从 Kuzu pattern 节点渲染角色蒸馏节（DISTILLED-START/END 区块）
                 Andy/Lucas → MEMORY.md，Lisa → CODEBASE.md（实现模式属于代码库上下文）
  (默认)         读 Kuzu Entity+Fact → 渲染家人 .inject.md 文件

设计原则：
  - 模板拼接，不调模型，幂等可重复执行
  - 家人档案：只写 {userId}.inject.md，不碰 .md（全量档案，人工维护）
  - 角色 MEMORY.md：只替换 DISTILLED-START/END 标记区块，标记外人工内容永远不碰
  - 蒸馏结束后自动触发（distill-memories.py / distill-agent-memories.py 末尾调用）

用法：
  python3 scripts/render-knowledge.py                    # 渲染所有家人档案
  python3 scripts/render-knowledge.py --seed             # 初始化 Kuzu（从 .inject.md 提取）
  python3 scripts/render-knowledge.py --user ZengXiaoLong   # 单人渲染/初始化
  python3 scripts/render-knowledge.py --agent andy       # 渲染 Andy MEMORY.md 蒸馏节
  python3 scripts/render-knowledge.py --agent lisa       # 渲染 Lisa MEMORY.md 蒸馏节
  python3 scripts/render-knowledge.py --agent lucas      # 渲染 Lucas MEMORY.md 蒸馏节
"""

import os, sys, re, argparse, datetime
from pathlib import Path

# Kuzu 0.11.3 on macOS ARM64 crashes in Database::~Database() during checkpoint.
# All data ops commit before destructor; use os._exit(0) to bypass Python GC / kuzu dtor.

# ── 配置 ─────────────────────────────────────────────────────────────────────

_SCRIPTS_DIR  = Path(__file__).resolve().parent     # .../HomeAILocal/Scripts
HOMEAI_ROOT   = _SCRIPTS_DIR.parent.parent.parent  # ~/HomeAI
_DATA_ROOT    = Path(os.environ.get("HOMEAI_DATA_ROOT", str(HOMEAI_ROOT / "Data")))
KUZU_DB_PATH  = _DATA_ROOT / "kuzu"
FAMILY_DIR    = Path.home() / ".openclaw" / "workspace-lucas" / "family"
OPENCLAW_DIR  = Path.home() / ".openclaw"

AGENT_WORKSPACE = {
    "andy":  OPENCLAW_DIR / "workspace-andy",
    "lisa":  OPENCLAW_DIR / "workspace-lisa",
    "lucas": OPENCLAW_DIR / "workspace-lucas",
}

DISTILL_SECTION_START = "<!-- DISTILLED-START -->"
DISTILL_SECTION_END   = "<!-- DISTILLED-END -->"

# 各 agent 的 pattern 蒸馏节落地文件（默认 MEMORY.md，Lisa 的实现模式属于 CODEBASE.md）
AGENT_PATTERN_TARGET = {
    "andy":  "MEMORY.md",
    "lucas": "MEMORY.md",
    "lisa":  "CODEBASE.md",   # 实现模式/工程陷阱 → 代码库上下文，不是行为记忆
}

# 家庭成员注册表：userId → 显示名
FAMILY_MEMBERS = {
    "ZengXiaoLong":     "爸爸曾小龙",
    "XiaMoQiuFengLiang": "妈妈张璐",
    "ZiFeiYu":          "小姨肖山",
    "ZengYueYuTong":    "姐姐黟黟",
}

# relation → 渲染时的中文标签（用于模板）
RELATION_LABELS = {
    # 个人档案（distill-memories.py 产出）
    "role_in_family":     "角色",
    "communication_style": "说话方式",
    "cares_most_about":   "最在意",
    "relationship_tip":   "相处要点",
    "current_status":     "当前",
    "dual_identity":      "两个身份",
    "recent_concern":     "近期关注",
    "key_event":          "重要事件",
    "cares_about":        "关注",
    "works_at":           "工作",
    "relationship":       "与家人关系",
    "shared_activity":    "一起做过的事",
    "causal_relation":    "因果关系",
    # 人际关系（init-family-relations.py 产出，person→person 边）
    "spouse_of":          "配偶",
    "parent_of":          "子女",
    "child_of":           "家长",
    "sibling_of":         "兄弟姐妹",
    "in_law_of":          "姻亲",
    # 动态关系（distill-memories.py relationship_with，待启用）
    "relationship_with":  "与TA的关系",
    # 互动方式（distill-memories.py interaction_style）
    "interaction_style":  "互动方式",
    # Andy 视角（team_observation，andy→person 边，单独查询渲染）
    "team_observation":       "Andy 的视角",
    # 与Lucas协作风格（手工初始化 + 蒸馏可自动更新）
    "interaction_preference": "与Lucas协作风格",
    # 待跟进事项（distill-memories.py has_pending_event）
    "has_pending_event":  "待跟进",
    # 动态协作边（distill-relationship-dynamics.py，person→person，source_type='collab_distill'）
    "co_discusses":       "共同关注",
    "requests_from":      "依赖协作",
    "supports":           "支持提供",
    "role_in_context":    "协作角色",
}

# ── Kuzu 连接 ─────────────────────────────────────────────────────────────────

def get_kuzu_conn(max_retries: int = 6, retry_delay: float = 5.0):
    """连接 Kuzu，遇锁冲突最多重试 max_retries 次（Gateway subprocess 持锁为短暂竞争）。"""
    import time
    try:
        import kuzu
    except ImportError:
        print("ERROR: kuzu 未安装，运行 pip3 install kuzu", file=sys.stderr)
        sys.exit(1)
    for attempt in range(max_retries):
        try:
            db = kuzu.Database(str(KUZU_DB_PATH))
            return kuzu.Connection(db)
        except Exception as e:
            if "lock" in str(e).lower() and attempt < max_retries - 1:
                print(f"  Kuzu 锁冲突（尝试 {attempt+1}/{max_retries}），{retry_delay}s 后重试...", file=sys.stderr)
                time.sleep(retry_delay)
            else:
                print(f"ERROR: Kuzu 连接失败：{e}", file=sys.stderr)
                sys.exit(1)

# ── 默认模式：渲染 Kuzu → .inject.md ─────────────────────────────────────────

def render_person(conn, user_id: str, display_name: str) -> str | None:
    """从 Kuzu 查询此人的所有 Fact，渲染为 .inject.md 内容。
    若无数据（Kuzu 还没有此人事实），返回 None（调用方保留旧文件）。"""
    try:
        r = conn.execute(
            "MATCH (p:Entity {id: $uid})-[f:Fact]->(o:Entity) "
            "WHERE f.valid_until IS NULL "
            "RETURN f.relation, o.name, f.context, f.valid_from "
            "ORDER BY f.confidence DESC",
            {"uid": user_id},
        )
        rows = []
        while r.has_next():
            rows.append(r.get_next())
    except Exception as e:
        print(f"  Kuzu 查询失败 {user_id}: {e}", file=sys.stderr)
        return None

    if not rows:
        return None  # 无数据，保留旧文件

    # ── 单独查询 pending_event（valid_until 非 NULL，不在主查询里）────────
    today_str = datetime.date.today().isoformat()
    pending_events: list[tuple[str, str, str, str]] = []
    try:
        r2 = conn.execute(
            "MATCH (p:Entity {id: $uid})-[f:Fact {relation: 'has_pending_event'}]->(e:Entity) "
            "WHERE f.valid_until >= $today "
            "RETURN e.name, f.context, f.valid_until, f.source_type "
            "ORDER BY f.valid_until ASC LIMIT 10",
            {"uid": user_id, "today": today_str},
        )
        while r2.has_next():
            pending_events.append(r2.get_next())
    except Exception as e:
        print(f"  WARN: pending_event 查询失败 {user_id}: {e}", file=sys.stderr)

    # ── 单独查询 team_observation（andy→person 边，方向与主查询相反）───────────
    # 由 distill-team-observations.py 写入，Andy 对这个人的分析性洞察
    team_observations: list[str] = []
    try:
        r3 = conn.execute(
            "MATCH (a:Entity {id: 'andy'})-[f:Fact {relation: 'team_observation'}]->(p:Entity {id: $uid}) "
            "WHERE f.valid_until >= $today "
            "RETURN f.context, f.confidence "
            "ORDER BY f.confidence DESC LIMIT 5",
            {"uid": user_id, "today": today_str},
        )
        for row in r3:
            ctx = row[0]
            if ctx:
                team_observations.append(ctx)
    except Exception as e:
        print(f"  WARN: team_observation 查询失败 {user_id}: {e}", file=sys.stderr)

    # ── 单独查询协作边（person→person，source_type='collab_distill'）──────────
    # 由 distill-relationship-dynamics.py 写入，记录此人与其他成员的动态协作关系
    collab_edges: list[tuple[str, str, str]] = []   # (relation, to_name, context)
    try:
        r4 = conn.execute(
            "MATCH (p:Entity {id: $uid})-[f:Fact]->(o:Entity) "
            "WHERE f.source_type = 'collab_distill' AND f.valid_until >= $today "
            "RETURN f.relation, o.name, f.context "
            "ORDER BY f.relation",
            {"uid": user_id, "today": today_str},
        )
        while r4.has_next():
            row = r4.get_next()
            if row[0] and row[1]:
                collab_edges.append((row[0], row[1], row[2] or ""))
    except Exception as e:
        print(f"  WARN: 协作边查询失败 {user_id}: {e}", file=sys.stderr)

    # 按 relation 分组；interaction_style / interaction_preference 单独收集，渲染为独立子节
    groups: dict[str, list[str]] = {}
    interaction_styles: list[str] = []
    interaction_prefs: list[tuple[str, str]] = []   # (name, context)
    today = datetime.date.today()
    for relation, obj_name, context, valid_from in rows:
        label = RELATION_LABELS.get(relation, relation)
        # relationship_with：context 是关系描述，obj_name 是对方姓名 → 格式：「姓名：描述」
        # 新鲜度标记：从 valid_from 提取日期，超 60 天加警告
        date_tag = ""
        if valid_from:
            try:
                vf_date = datetime.date.fromisoformat(str(valid_from)[:10])
                age_days = (today - vf_date).days
                date_tag = f"（{vf_date.isoformat()}）"
                if age_days > 60:
                    date_tag = f"⚠️ 可能已过时（更新于 {vf_date.isoformat()}，{age_days}天前）"
            except Exception:
                pass
        if relation == "relationship_with":
            value = f"{obj_name}：{context}" if context else obj_name
            if date_tag:
                value = f"{value} {date_tag}"
        else:
            value = obj_name if obj_name else ""
            if context:
                value = f"{value}（{context}）" if value else context
            if date_tag:
                value = f"{value} {date_tag}"
        # 单独收集，不进主 groups
        if relation == "interaction_style":
            if value:
                interaction_styles.append(value)
        elif relation == "interaction_preference":
            interaction_prefs.append((obj_name or "", context or ""))
        else:
            groups.setdefault(label, []).append(value)

    # 渲染主 section（档案事实）
    lines = [f"## {display_name}"]
    for label, values in groups.items():
        if len(values) == 1:
            lines.append(f"- {label}：{values[0]}")
        else:
            lines.append(f"- {label}：")
            for v in values:
                lines.append(f"  - {v}")

    # 渲染 Andy 视角子节（team_observation，动态更新，置最前）
    if team_observations:
        lines.append("")
        lines.append("### Andy 的视角")
        for obs in team_observations:
            lines.append(f"- {obs}")

    # 渲染协作关系子节（来自 distill-relationship-dynamics.py，动态协作边）
    if collab_edges:
        lines.append("")
        lines.append("### 组织协作关系")
        label_map = {
            "co_discusses":    "共同关注",
            "requests_from":   "依赖协作",
            "supports":        "支持提供",
            "role_in_context": "协作角色",
        }
        for rel, to_name, ctx in collab_edges:
            label = label_map.get(rel, rel)
            entry = f"{label}→{to_name}"
            if ctx:
                entry = f"{entry}（{ctx}）"
            lines.append(f"- {entry}")

    # 渲染与Lucas协作风格子节（手工初始化 + 蒸馏更新）
    if interaction_prefs:
        lines.append("")
        lines.append("### 与Lucas协作风格")
        for pref_name, pref_ctx in interaction_prefs:
            if pref_name:
                lines.append(f"**{pref_name}**")
            for line in pref_ctx.split("\n"):
                line = line.strip()
                if line:
                    lines.append(f"- {line}")

    # 渲染互动方式子节（来自蒸馏，动态更新）
    if interaction_styles:
        lines.append("")
        lines.append("### 与启灵的互动方式")
        for v in interaction_styles:
            lines.append(f"- {v}")

    # 渲染待跟进事项子节（来自 pending_event 节点，按日期排序）
    if pending_events:
        lines.append("")
        lines.append("### 近期待跟进")
        for name, context, valid_until, source_type in pending_events:
            date_hint   = f"（{valid_until}）" if valid_until else ""
            detail      = f"：{context}" if context and context != name else ""
            unconfirmed = "（待确认）" if source_type == "distill" else ""
            lines.append(f"- {name}{detail}{date_hint}{unconfirmed}")

    lines.append("")  # trailing newline

    return "\n".join(lines)


def run_render(conn, user_ids: list[str]):
    """渲染指定用户的 .inject.md 文件。"""
    FAMILY_DIR.mkdir(parents=True, exist_ok=True)
    updated = 0

    for uid in user_ids:
        display_name = FAMILY_MEMBERS.get(uid, uid)
        content = render_person(conn, uid, display_name)
        if content is None:
            print(f"  跳过 {uid}（Kuzu 无数据）")
            continue

        inject_path = FAMILY_DIR / f"{_inject_key(uid)}.inject.md"
        inject_path.write_text(content, encoding="utf-8")
        print(f"  渲染完成 → {inject_path.name}")
        updated += 1

    print(f"\n渲染完成：{updated}/{len(user_ids)} 个档案已更新")


def _inject_key(user_id: str) -> str:
    """userId → inject 文件名 key（小写，兼容旧文件命名约定）"""
    mapping = {
        "ZengXiaoLong":     "zengxiaolong",
        "XiaMoQiuFengLiang": "xiamoqiufengliang",
        "ZiFeiYu":          "zifeitu",   # 历史文件名 zifeitu
        "ZengYueYuTong":    "zengyueyutong",
    }
    return mapping.get(user_id, user_id.lower())


# ── --seed 模式：.inject.md → Kuzu ────────────────────────────────────────────

# 解析规则：把 "- 标签：内容" 的 bullet 行映射到 Kuzu Fact relation
SEED_PARSE_RULES = [
    (re.compile(r"^-\s*角色[：:]\s*(.+)"),            "role_in_family"),
    (re.compile(r"^-\s*风格[：:]\s*(.+)"),            "communication_style"),
    (re.compile(r"^-\s*说话方式[：:]\s*(.+)"),        "communication_style"),
    (re.compile(r"^-\s*最在意[：:]\s*(.+)"),          "cares_most_about"),
    (re.compile(r"^-\s*相处[要点]*[：:]\s*(.+)"),     "relationship_tip"),
    (re.compile(r"^-\s*当前[：:]\s*(.+)"),            "current_status"),
    (re.compile(r"^-\s*两个身份[：:]\s*(.+)"),        "dual_identity"),
]


def seed_person(conn, user_id: str) -> int:
    """解析 .inject.md → 写入 Kuzu Facts。返回写入的 Fact 数量。"""
    inject_key = _inject_key(user_id)
    inject_path = FAMILY_DIR / f"{inject_key}.inject.md"
    if not inject_path.exists():
        print(f"  {user_id}: .inject.md 不存在，跳过")
        return 0

    # 确保 person 实体存在
    display_name = FAMILY_MEMBERS.get(user_id, user_id)
    conn.execute(
        "MERGE (e:Entity {id: $id}) SET e.type = 'person', e.name = $name",
        {"id": user_id, "name": display_name},
    )

    content = inject_path.read_text(encoding="utf-8")
    now_iso = datetime.datetime.now().isoformat()
    written = 0

    for line in content.splitlines():
        line = line.strip()
        for pattern, relation in SEED_PARSE_RULES:
            m = pattern.match(line)
            if not m:
                continue
            value = m.group(1).strip()
            if not value:
                continue

            # 目标 topic entity（以 relation_userId 为唯一 key）
            topic_id   = f"{relation}_{user_id}"
            topic_name = value[:120]  # 名字截断，详情放 context
            context    = value if len(value) > 120 else ""

            try:
                # Upsert topic entity
                conn.execute(
                    "MERGE (e:Entity {id: $id}) SET e.type = 'topic', e.name = $name",
                    {"id": topic_id, "name": topic_name},
                )
                # 先删除旧 Fact（同 relation，避免重复）
                conn.execute(
                    "MATCH (p:Entity {id: $pid})-[f:Fact]->(o:Entity {id: $oid}) DELETE f",
                    {"pid": user_id, "oid": topic_id},
                )
                # 写入新 Fact
                conn.execute(
                    "MATCH (p:Entity {id: $pid}), (o:Entity {id: $oid}) "
                    "CREATE (p)-[:Fact {relation: $rel, context: $ctx, "
                    "valid_from: $from, confidence: 0.8, "
                    "source_type: 'seed', source_id: 'inject_md'}]->(o)",
                    {
                        "pid": user_id, "oid": topic_id,
                        "rel": relation, "ctx": context, "from": now_iso,
                    },
                )
                written += 1
            except Exception as e:
                print(f"    Fact 写入失败 ({relation}): {e}", file=sys.stderr)
            break  # 每行只匹配一个规则

    print(f"  {user_id}: 写入 {written} 条 Fact")
    return written


def run_seed(conn, user_ids: list[str]):
    """从 .inject.md 文件初始化 Kuzu Facts。"""
    total = 0
    for uid in user_ids:
        n = seed_person(conn, uid)
        total += n
    print(f"\n初始化完成：共写入 {total} 条 Fact")

    # seed 完成后立即渲染，验证效果
    print("\n── 渲染验证 ──")
    run_render(conn, user_ids)


# ── --agent 模式：Kuzu pattern 节点 → MEMORY.md 蒸馏节 ───────────────────────

def render_agent_memory(conn, agent_id: str) -> bool:
    """
    从 Kuzu 查询此 agent 的有效 pattern 节点，渲染为 markdown，
    替换目标文件中的 DISTILLED-START/END 区块。
    目标文件由 AGENT_PATTERN_TARGET 决定：Andy/Lucas → MEMORY.md，Lisa → CODEBASE.md。
    若 Kuzu 无数据，跳过（不覆盖已有内容）。
    返回是否实际写入。
    """
    workspace = AGENT_WORKSPACE.get(agent_id)
    if workspace is None:
        print(f"  ERROR: 未知 agent_id '{agent_id}'，可用：{list(AGENT_WORKSPACE.keys())}", file=sys.stderr)
        return False

    target_filename = AGENT_PATTERN_TARGET.get(agent_id, "MEMORY.md")
    memory_path = workspace / target_filename
    if not memory_path.exists():
        print(f"  WARN: {memory_path} 不存在，跳过", file=sys.stderr)
        return False

    # 查 Kuzu pattern 节点
    try:
        r = conn.execute(
            "MATCH (a:Entity {id: $aid, type: 'agent'})"
            "-[f:Fact {relation: 'has_pattern'}]->(p:Entity {type: 'pattern'}) "
            "WHERE f.valid_until IS NULL "
            "RETURN p.name, f.context, f.confidence "
            "ORDER BY f.confidence DESC",
            {"aid": agent_id},
        )
        rows = []
        while r.has_next():
            rows.append(r.get_next())
    except Exception as e:
        print(f"  Kuzu 查询失败 ({agent_id}): {e}", file=sys.stderr)
        return False

    if not rows:
        print(f"  跳过 {agent_id}（Kuzu 无 pattern 数据）")
        return False

    # 渲染 markdown 内容
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    lines = [f"> 最后从 Kuzu 渲染：{now_str}，共 {len(rows)} 条模式\n"]
    for name, context, confidence in rows:
        lines.append(f"### {name}")
        lines.append(context.strip())
        lines.append("")  # 空行分隔

    rendered_content = "\n".join(lines).strip()

    new_section = (
        f"{DISTILL_SECTION_START}\n"
        f"{rendered_content}\n"
        f"{DISTILL_SECTION_END}"
    )

    # 替换或追加 DISTILLED 区块
    content = memory_path.read_text(encoding="utf-8")
    if DISTILL_SECTION_START in content:
        pattern = re.compile(
            re.escape(DISTILL_SECTION_START) + r".*?" + re.escape(DISTILL_SECTION_END),
            re.DOTALL,
        )
        updated = pattern.sub(lambda m: new_section, content)
    else:
        updated = content.rstrip() + "\n\n---\n\n" + new_section + "\n"

    memory_path.write_text(updated, encoding="utf-8")
    print(f"  {target_filename} 已更新：{memory_path}（{len(rows)} 条 pattern）")
    return True


def run_render_agent(conn, agent_ids: list[str]):
    """渲染指定 agent 的 MEMORY.md 蒸馏节。"""
    updated = 0
    for aid in agent_ids:
        ok = render_agent_memory(conn, aid)
        if ok:
            updated += 1
    print(f"\n渲染完成：{updated}/{len(agent_ids)} 个 MEMORY.md 已更新")


# ── main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="HomeAI 知识渲染管道")
    parser.add_argument("--seed",  action="store_true", help="从 .inject.md 初始化 Kuzu Facts（一次性）")
    parser.add_argument("--user",  help="只处理指定 userId（家人档案模式）")
    parser.add_argument("--agent", help="渲染指定 agent 的 MEMORY.md 蒸馏节（andy/lisa/lucas，逗号分隔）")
    args = parser.parse_args()

    print(f"render-knowledge.py @ {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Kuzu DB: {KUZU_DB_PATH}")

    try:
        if args.agent:
            # --agent 模式：从 Kuzu pattern 节点渲染 MEMORY.md
            agent_ids = [a.strip() for a in args.agent.split(",") if a.strip()]
            unknown = [a for a in agent_ids if a not in AGENT_WORKSPACE]
            if unknown:
                print(f"ERROR: 未知 agent：{unknown}，可用：{list(AGENT_WORKSPACE.keys())}", file=sys.stderr)
                sys.exit(1)
            print(f"渲染 agent MEMORY.md：{agent_ids}\n")
            conn = get_kuzu_conn()
            run_render_agent(conn, agent_ids)
        else:
            # 家人档案模式
            if args.user:
                user_ids = [args.user]
            else:
                user_ids = list(FAMILY_MEMBERS.keys())
            print(f"渲染家人档案：{user_ids}\n")
            conn = get_kuzu_conn()
            if args.seed:
                run_seed(conn, user_ids)
            else:
                run_render(conn, user_ids)
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)  # bypass kuzu Database::~Database() SIGBUS on macOS ARM64；异常路径同样触发


if __name__ == "__main__":
    main()
