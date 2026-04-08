#!/usr/bin/env python3
"""
init-capabilities.py — 能力注册表初始化到 Kuzu

从两个权威来源读取能力定义，写入 Kuzu capability 节点 + has_capability Fact：
  1. TOOLS.md（各角色工具）     → 提炼自人工维护的角色工具清单
  2. app-capabilities.jsonl   → Lisa 交付的 Web 应用

数据结构（Kuzu）：
  capability Entity {id='capability_{slug}', type='capability', name=工具名}
  agent Entity {id='andy'/'lisa'/'lucas', type='agent'}  ← 已存在
  Fact {relation='has_capability', context=描述, source_type='registry', source_id='init-capabilities'}

用法：
  python3 scripts/init-capabilities.py          # 全量初始化（幂等，可重复运行）
  python3 scripts/init-capabilities.py --dry-run  # 预览，不写入

注意：
  - 幂等：已有同 id 的 capability Entity 直接 SET name，不重复创建
  - Fact 不做 full refresh，用 MERGE 风格（同 agent+capability 对去重）
  - 手动增删能力：直接修改本文件的 CAPABILITY_REGISTRY，重新运行
"""

import os, sys, json, argparse, datetime
from pathlib import Path

HOMEAI_ROOT = Path(__file__).parent.parent
KUZU_DB_PATH = HOMEAI_ROOT / "data" / "kuzu"
APP_CAP_PATH = HOMEAI_ROOT / "data" / "corpus" / "app-capabilities.jsonl"

# ── 能力注册表（来自 TOOLS.md 人工提炼）─────────────────────────────────────
#
# 字段说明：
#   id      — Kuzu capability Entity id（capability_{slug}）
#   name    — 工具/应用名称（显示用）
#   desc    — 一句话描述（写入 Fact.context）
#   owners  — 拥有此能力的 agent 列表（每个 agent 写一条 has_capability Fact）
#
CAPABILITY_REGISTRY = [

    # ── Lucas 工具 ────────────────────────────────────────────────────────────
    # 关键原则：Lucas 绝对不自己写代码实现软件功能，有软件/自动化/数据处理需求必须调 trigger_development_pipeline
    {
        "id":    "capability_send_message",
        "name":  "send_message",
        "desc":  "主动给家人发文字消息（私聊或群聊）。何时用：主动联系家人、发通知、发链接；家人说要链接时发链接而不是粘贴内容。私聊 userId 见 TOOLS.md；群聊 chatId=wra6wXbgAAu_7v2qu1wnc8Lu3-Za3diQ",
        "owners": ["lucas"],
    },
    {
        "id":    "capability_send_file",
        "name":  "send_file",
        "desc":  "把实际文件通过企业微信发给家人（私聊或群聊）。何时用：家人说「发给我」「发到群里」时必须用此工具，不能把文件内容粘贴成文字。私聊填 userId，群聊 target 填 \"group\"",
        "owners": ["lucas"],
    },
    {
        "id":    "capability_send_voice",
        "name":  "send_voice",
        "desc":  "把文字转成男声语音消息发给家人。何时用：生日/节日祝福、家人要求语音、需要温暖感的场合。私聊发语音时家人发语音消息则自动触发，无需手动调用",
        "owners": ["lucas"],
    },
    {
        "id":    "capability_search_web",
        "name":  "search_web",
        "desc":  "搜索互联网实时信息（DeepSeek 联网搜索）。何时用：股价/价格/新闻/最新动态等实时信息，不能靠自己的知识编造。不能靠记忆回答的实时问题必须用此工具",
        "owners": ["lucas"],
    },
    {
        "id":    "capability_recall_memory",
        "name":  "recall_memory",
        "desc":  "语义检索 ChromaDB 家庭对话记忆。何时用：家人说「上次」「之前」时、需要了解某人情况时、判断是否对某人做过承诺时。隐私规则：私聊内容默认不公开",
        "owners": ["lucas"],
    },
    {
        "id":    "capability_queue_knowledge",
        "name":  "queue_knowledge",
        "desc":  "把家人分享的 URL 或文字内容加入学习队列。何时用：家人说「帮我存下来」「这个挺有意思」、或转发了明显有价值的文章时。普通聊天不触发。category 选 family_insight/reference/other",
        "owners": ["lucas"],
    },
    {
        "id":    "capability_flag_for_skill",
        "name":  "flag_for_skill",
        "desc":  "记录反复出现的需求信号，供 Andy 判断是否结晶为 Skill。何时用：同类场景第 3 次出现时触发，积累信号让系统自我进化。不是每次需求都触发，只在反复出现时触发",
        "owners": ["lucas"],
    },
    {
        "id":    "capability_trigger_development_pipeline",
        "name":  "trigger_development_pipeline",
        "desc":  "把家人需求提交给 Andy+Lisa 开发流水线。何时用：任何需要写代码/构建软件/自动化/数据处理的需求。Lucas 绝对不自己实现代码，有开发需求必须调此工具提交给流水线。提交后告知家人「已安排，完成会通知」",
        "owners": ["lucas"],
    },
    {
        "id":    "capability_alert_owner",
        "name":  "alert_owner",
        "desc":  "向爸爸（系统工程师）发重要提醒。何时用：① 提交开发需求后同步通知爸爸 ② 系统异常或工具失败时上报 ③ Skill 结晶信号积累需要人工判断时。普通家庭对话不触发",
        "owners": ["lucas"],
    },
    {
        "id":    "capability_record_outcome_feedback",
        "name":  "record_outcome_feedback",
        "desc":  "记录需求完成的结果反馈（好用/不好用/需改进）到 ChromaDB。何时用：家人确认某个功能好用时、或反馈不好用时记录。让系统知道哪些交付真正有效",
        "owners": ["lucas"],
    },
    {
        "id":    "capability_follow_up_requirement",
        "name":  "follow_up_requirement",
        "desc":  "跟进某个需求在 Andy/Lisa 流水线中的当前进度状态。何时用：需要了解某个已提交需求的进展时、家人询问进度时。不是每次对话都调，只在真正需要查进度时使用",
        "owners": ["lucas"],
    },
    {
        "id":    "capability_create_member_shadow",
        "name":  "create_member_shadow",
        "desc":  "创建家庭成员影子 Agent，深度理解某位家人的目标和处境。何时用：需要爸爸明确授权才可使用，普通家庭对话不触发",
        "owners": ["lucas"],
    },

    # ── Andy 工具 ────────────────────────────────────────────────────────────
    {
        "id":    "capability_research_task",
        "name":  "research_task",
        "desc":  "深度调研（DeepSeek 联网搜索），适合技术选型、方案调研，出 spec 前使用",
        "owners": ["andy"],
    },
    {
        "id":    "capability_trigger_lisa_implementation",
        "name":  "trigger_lisa_implementation",
        "desc":  "把完整 spec 交棒给 Lisa 实现，启动 V 字流水线的实现阶段",
        "owners": ["andy"],
    },

    # ── Lisa 工具 ────────────────────────────────────────────────────────────
    {
        "id":    "capability_run_opencode",
        "name":  "run_opencode",
        "desc":  "主力编码工具（OpenCode CLI + GLM-5），自主读文件、写代码、运行验证",
        "owners": ["lisa"],
    },
    {
        "id":    "capability_get_opencode_result",
        "name":  "get_opencode_result",
        "desc":  "轮询 opencode 任务执行状态，等待异步实现完成后取结果",
        "owners": ["lisa"],
    },

    # ── 共享工具 ──────────────────────────────────────────────────────────────
    {
        "id":    "capability_create_sub_agent",
        "name":  "create_sub_agent",
        "desc":  "创建并行子 Agent 处理独立子任务，Andy 用于并行调研，Lisa 用于拆分复杂实现",
        "owners": ["andy", "lisa"],
    },
]


def load_app_capabilities() -> list[dict]:
    """从 app-capabilities.jsonl 加载 Web 应用能力。"""
    if not APP_CAP_PATH.exists():
        print(f"  WARN: {APP_CAP_PATH} 不存在，跳过 Web 应用能力", file=sys.stderr)
        return []
    caps = []
    with open(APP_CAP_PATH, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue
            cap_id = f"capability_webapp_{item['id']}"
            owner  = item.get("owner", "lisa")
            desc   = item.get("desc", item.get("name", ""))
            # 把 full_url 拼进 desc，方便 Andy/Lisa 出 spec 时直接引用
            full_url = item.get("full_url", "")
            if full_url:
                desc = f"{desc} | url: {full_url}"
            caps.append({
                "id":     cap_id,
                "name":   item.get("name", item["id"]),
                "desc":   desc[:400],
                "owners": ["lucas", owner] if owner != "lucas" else ["lucas"],
            })
    return caps


def get_kuzu_conn():
    try:
        import kuzu as _kuzu
        db = _kuzu.Database(str(KUZU_DB_PATH))
        return _kuzu.Connection(db)
    except ImportError:
        print("ERROR: kuzu 未安装，运行 pip3 install kuzu", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"ERROR: Kuzu 连接失败：{e}", file=sys.stderr)
        sys.exit(1)


def write_capabilities(conn, capabilities: list[dict], dry_run: bool) -> int:
    """将能力清单写入 Kuzu。返回写入的 Fact 数量。"""
    now_iso = datetime.datetime.now().isoformat()
    written = 0

    for cap in capabilities:
        cap_id = cap["id"]
        name   = cap["name"]
        desc   = cap["desc"]

        if dry_run:
            print(f"  [DRY] capability: {cap_id!r:50s} name={name}")
            for owner in cap["owners"]:
                print(f"         owner: {owner}")
            continue

        # Upsert capability Entity
        try:
            conn.execute(
                "MERGE (e:Entity {id: $id}) SET e.type = 'capability', e.name = $name",
                {"id": cap_id, "name": name},
            )
        except Exception as e:
            print(f"  WARN: capability entity 写入失败 ({cap_id}): {e}", file=sys.stderr)
            continue

        # 为每个 owner 写 has_capability Fact（先清除旧 Fact，再写新的）
        for owner in cap["owners"]:
            try:
                # 过期旧 Fact（same agent → same capability）
                conn.execute(
                    "MATCH (a:Entity {id: $aid})-[f:Fact {relation: 'has_capability'}]->(c:Entity {id: $cid}) "
                    "WHERE f.valid_until IS NULL SET f.valid_until = $now",
                    {"aid": owner, "cid": cap_id, "now": now_iso},
                )
                # 写新 Fact
                conn.execute(
                    "MATCH (a:Entity {id: $aid}), (c:Entity {id: $cid}) "
                    "CREATE (a)-[:Fact {relation: 'has_capability', context: $ctx, "
                    "valid_from: $from, confidence: 1.0, "
                    "source_type: 'registry', source_id: 'init-capabilities'}]->(c)",
                    {"aid": owner, "cid": cap_id, "ctx": desc, "from": now_iso},
                )
                written += 1
            except Exception as e:
                print(f"  WARN: has_capability Fact 写入失败 ({owner} → {cap_id}): {e}", file=sys.stderr)

    return written


def verify(conn):
    """写入后验证：按 agent 打印能力清单。"""
    print("\n── 验证：Kuzu 能力清单 ──")
    for agent_id in ["lucas", "andy", "lisa"]:
        r = conn.execute(
            "MATCH (a:Entity {id: $aid})-[f:Fact {relation: 'has_capability'}]->(c:Entity {type: 'capability'}) "
            "WHERE f.valid_until IS NULL RETURN c.name, f.context",
            {"aid": agent_id},
        )
        rows = []
        while r.has_next():
            rows.append(r.get_next())
        print(f"\n  {agent_id}（{len(rows)} 项）：")
        for name, ctx in rows:
            print(f"    - {name}: {ctx[:60]}...")


def main():
    parser = argparse.ArgumentParser(description="能力注册表初始化到 Kuzu")
    parser.add_argument("--dry-run", action="store_true", help="预览写入内容，不实际写入")
    args = parser.parse_args()

    # 合并两个来源
    all_caps = CAPABILITY_REGISTRY + load_app_capabilities()
    print(f"init-capabilities.py @ {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"Kuzu DB: {KUZU_DB_PATH}")
    print(f"能力条目：{len(all_caps)} 个（工具 {len(CAPABILITY_REGISTRY)} + Web 应用 {len(all_caps) - len(CAPABILITY_REGISTRY)}）")
    print()

    try:
        conn = get_kuzu_conn()
        written = write_capabilities(conn, all_caps, dry_run=args.dry_run)

        if args.dry_run:
            print(f"\nDRY RUN 完成，实际写入：0（共预览 {len(all_caps)} 个能力）")
        else:
            print(f"\n写入完成：{written} 条 has_capability Fact")
            verify(conn)
    finally:
        os._exit(0)  # bypass kuzu Database::~Database() SIGBUS on macOS ARM64；异常路径同样触发


if __name__ == "__main__":
    main()
