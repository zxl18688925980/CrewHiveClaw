#!/usr/bin/env python3
"""
活跃话题线索蒸馏：从最近对话提取活跃 topic thread，写入 Kuzu active_thread Fact 边。

设计原则：
  - 由 index.ts agent_end 触发（每用户 6h 冷却），也可手动运行
  - 读取最近 7 天对话（ChromaDB conversations）
  - LLM 提炼当前活跃话题线索（state + summary）
  - Kuzu：过期旧 active_thread 边 → 写入新边（valid_until = today + 45d）
  - valid_until 即老化机制：45d 无提及后查询自动排除，无需额外清理
  - before_prompt_build 通过 active-threads Kuzu source 注入「当前活跃话题」

用法：
  python3 scripts/distill-active-threads.py               # 全量（所有家庭成员）
  python3 scripts/distill-active-threads.py --user ZengXiaoLong
  python3 scripts/distill-active-threads.py --force       # 忽略冷却和最小记录数限制
"""

import os, sys, json, argparse, datetime, re, requests
from pathlib import Path

# ── 配置 ──────────────────────────────────────────────────────────────────────
_SCRIPTS_DIR = Path(__file__).resolve().parent     # .../HomeAILocal/Scripts
HOMEAI_ROOT  = _SCRIPTS_DIR.parent.parent.parent  # ~/HomeAI
_DATA_ROOT   = Path(os.environ.get("HOMEAI_DATA_ROOT", str(HOMEAI_ROOT / "Data")))
CHROMA_URL   = os.environ.get("CHROMA_URL", "http://localhost:8001")
CHROMA_BASE  = f"{CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections"
DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
ZAI_KEY      = os.environ.get("ZAI_API_KEY", "")
KUZU_DB_PATH = _DATA_ROOT / "kuzu"
STATE_FILE   = _DATA_ROOT / "learning" / "active-threads-state.json"

ACTIVE_THREAD_DAYS  = 45   # valid_until = today + N days（老化机制：超期自动不注入）
LOOKBACK_DAYS       = 7    # 读取最近 N 天对话
MIN_RECORDS         = 2    # 少于此数则跳过（无足够上下文）
COOLDOWN_SECONDS    = 6 * 3600   # 同一用户 6h 冷却

# ChromaDB userId（小写）→ Kuzu Entity ID
CHROMA_TO_KUZU_ID = {
    "zengxiaolong":         "ZengXiaoLong",
    "xiamogqiufengliang":   "XiaMoQiuFengLiang",
    "zifeiyu":              "ZiFeiYu",
    "zengyueyutong":        "ZengYueYuTong",
}

KUZU_TO_DISPLAY_NAME = {
    "ZengXiaoLong":         "爸爸曾小龙",
    "XiaMoQiuFengLiang":    "妈妈张璐",
    "ZiFeiYu":              "小姨肖山",
    "ZengYueYuTong":        "姐姐黟黟",
}

THREAD_EXTRACT_PROMPT = """\
你是 Lucas 的记忆助手。以下是 Lucas 和「{member}」最近 {days} 天的对话（共 {count} 条，按时间排序）。

请提取这些对话中**正在进行的话题线索**——即双方共同关注、尚未结束、后续需要跟进的事情，包括：
- 正在推进的项目或计划（未完成）
- 提到了但没有结论的问题
- 约定要做的某件事
- 家人在等待结果的事
- 一起讨论过、下次还会继续的话题

输出 JSON（严格遵守，不添加额外字段）：
{{
  "threads": [
    {{
      "name": "线索名称（15字以内，简洁具体，如「抖音脚本计划」「黟黟期末备考」）",
      "state": "open|in_progress|paused",
      "summary": "当前进展和停在哪里（60字以内）"
    }}
  ]
}}

规则：
- 只提取真实出现的活跃话题，不推断，不补充
- 已明确结束的话题（说了「好了」「搞定了」「算了」）不要提取
- 日常闲聊（今天吃什么、天气好不好）不要提取
- 没有活跃话题时返回 {{ "threads": [] }}

对话记录：
{conversations}
"""


# ── ChromaDB 工具 ──────────────────────────────────────────────────────────────

def get_collection_id(name: str) -> str | None:
    r = requests.get(f"{CHROMA_BASE}/{name}", timeout=10)
    return r.json().get("id") if r.status_code == 200 else None


def chroma_get_all(collection: str, where: dict = None, limit: int = 300) -> list[dict]:
    cid = get_collection_id(collection)
    if not cid:
        return []
    payload = {"limit": limit, "include": ["documents", "metadatas"]}
    if where:
        payload["where"] = where
    r = requests.post(f"{CHROMA_BASE}/{cid}/get", json=payload, timeout=30)
    if r.status_code != 200:
        return []
    data  = r.json()
    ids   = data.get("ids", [])
    docs  = data.get("documents") or []
    metas = data.get("metadatas") or []
    return [
        {"id": ids[i], "document": docs[i] if i < len(docs) else "",
         "metadata": metas[i] if i < len(metas) else {}}
        for i in range(len(ids))
    ]


def get_recent_conversations(chroma_user_id: str) -> list[dict]:
    """获取该用户最近 LOOKBACK_DAYS 天的对话（Python 侧过滤时间戳，绕开 ChromaDB 不支持 $gte 的限制）"""
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    all_records = chroma_get_all(
        "conversations",
        where={"fromId": {"$eq": chroma_user_id}},
        limit=300,
    )
    filtered = []
    for r in all_records:
        m  = r["metadata"]
        ts = str(m.get("timestamp", m.get("created_at", "")))
        # 只取时间范围内的 human 对话
        if ts >= cutoff and m.get("fromType", "human") not in ("agent",):
            filtered.append(r)
    filtered.sort(key=lambda x: str(x["metadata"].get("timestamp", "")))
    return filtered


# ── LLM ───────────────────────────────────────────────────────────────────────

def _call_llm(prompt: str) -> str:
    """调用 LLM，异常安全：SSL/网络错误自动 fallback 到下一个 endpoint。"""
    endpoints = []
    if DEEPSEEK_KEY:
        endpoints.append(("DeepSeek", "https://api.deepseek.com/v1/chat/completions", DEEPSEEK_KEY, "deepseek-chat"))
    if ZAI_KEY:
        endpoints.append(("ZAI", "https://api.zaiasktheai.com/v1/chat/completions", ZAI_KEY, "glm-5"))
    last_err = None
    for name, url, key, model in endpoints:
        try:
            r = requests.post(
                url,
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 800, "temperature": 0.2,
                },
                timeout=60,
            )
            if r.status_code == 200:
                return r.json()["choices"][0]["message"]["content"].strip()
            print(f"  WARN: {name} API 返回 {r.status_code}，尝试下一个", file=sys.stderr)
        except requests.exceptions.RequestException as e:
            print(f"  WARN: {name} API 异常 ({type(e).__name__})，尝试下一个", file=sys.stderr)
            last_err = e
    raise RuntimeError(f"所有 LLM API 均失败: {last_err}")


def _slugify(text: str) -> str:
    s = text.lower().strip()
    s = re.sub(r'\s+', '_', s)
    s = re.sub(r'[^\w\u4e00-\u9fff]', '', s)
    return s[:40]


def extract_threads(records: list[dict], member_name: str) -> list[dict]:
    """用 LLM 从对话记录中提取活跃话题线索"""
    conv_text = ""
    for r in records[-20:]:  # 最多取最近 20 条，控制 token 用量
        m   = r["metadata"]
        ts  = str(m.get("timestamp", ""))[:16]
        doc = r["document"][:300]
        conv_text += f"[{ts}] {doc}\n\n"

    prompt = THREAD_EXTRACT_PROMPT.format(
        member=member_name,
        days=LOOKBACK_DAYS,
        count=len(records),
        conversations=conv_text.strip(),
    )

    raw = _call_llm(prompt)
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if not m:
        return []
    try:
        data = json.loads(m.group())
        return data.get("threads", [])
    except Exception:
        return []


# ── Kuzu 写入 ─────────────────────────────────────────────────────────────────

def write_active_threads(conn, kuzu_user_id: str, threads: list[dict]) -> int:
    """
    全量刷新该用户的 active_thread Fact 边：
    1. 过期所有当前活跃的 active_thread 边（SET valid_until = today）
    2. 为每条提取出的线索写入新 Fact 边（valid_until = today + ACTIVE_THREAD_DAYS）
    返回写入数量。
    """
    now_iso   = datetime.datetime.now().isoformat()
    today     = datetime.date.today()
    until_iso = (today + datetime.timedelta(days=ACTIVE_THREAD_DAYS)).isoformat()
    sid       = f"thread-{today.isoformat()}"

    # 过期旧 active_thread 边（valid_until 到期 = 自动从注入中消失）
    try:
        conn.execute(
            "MATCH (p:Entity {id: $uid})-[f:Fact {relation: 'active_thread'}]->(t:Entity) "
            "WHERE f.valid_until IS NULL OR f.valid_until > $today "
            "SET f.valid_until = $today",
            {"uid": kuzu_user_id, "today": today.isoformat()},
        )
    except Exception as e:
        print(f"  WARN: 过期旧 active_thread 失败：{e}", file=sys.stderr)

    written = 0
    for thread in threads:
        name    = thread.get("name", "").strip()[:50]
        state   = thread.get("state", "open")
        summary = thread.get("summary", "").strip()[:150]
        if not name:
            continue

        topic_id   = f"topic_{_slugify(name)}"
        topic_name = name
        state_labels = {"open": "计划中", "in_progress": "进行中", "paused": "暂停中"}
        state_label  = state_labels.get(state, state)
        ctx_str      = f"[{state_label}] {summary}（{today.isoformat()} 更新）"

        try:
            # MERGE topic 节点（与正式蒸馏 topic 节点共享命名空间，相同概念自然聚合）
            conn.execute(
                "MERGE (e:Entity {id: $id}) SET e.type = 'topic', e.name = $name",
                {"id": topic_id, "name": topic_name},
            )
            # CREATE active_thread Fact 边（旧边已过期，不会重复）
            conn.execute(
                "MATCH (p:Entity {id: $pid}), (o:Entity {id: $oid}) "
                "CREATE (p)-[:Fact {relation: 'active_thread', context: $ctx, "
                "valid_from: $from, valid_until: $until, confidence: 0.75, "
                "source_type: 'thread_distill', source_id: $sid}]->(o)",
                {
                    "pid": kuzu_user_id, "oid": topic_id,
                    "ctx": ctx_str,      "from": now_iso,
                    "until": until_iso,  "sid": sid,
                },
            )
            written += 1
        except Exception as e:
            print(f"  WARN: 写入线索 [{name}] 失败：{e}", file=sys.stderr)

    return written


# ── 状态管理 ──────────────────────────────────────────────────────────────────

def load_state() -> dict:
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {}


def save_state(state: dict):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2))


# ── 主流程 ────────────────────────────────────────────────────────────────────

def process_user(conn, chroma_user_id: str, force: bool = False) -> None:
    kuzu_user_id = CHROMA_TO_KUZU_ID.get(chroma_user_id.lower())
    if not kuzu_user_id:
        print(f"  跳过未知用户：{chroma_user_id}")
        return

    # 冷却检查
    state      = load_state()
    user_state = state.get(chroma_user_id, {})
    last_run   = user_state.get("last_run", "")
    if not force and last_run:
        last_dt = datetime.datetime.fromisoformat(last_run)
        if (datetime.datetime.now() - last_dt).total_seconds() < COOLDOWN_SECONDS:
            print(f"  [{chroma_user_id}] 冷却中（距上次 < 6h），跳过")
            return

    # 获取最近对话
    records = get_recent_conversations(chroma_user_id.lower())
    if len(records) < MIN_RECORDS and not force:
        print(f"  [{chroma_user_id}] 最近 {LOOKBACK_DAYS} 天对话不足 {MIN_RECORDS} 条，跳过")
        return

    member_name = KUZU_TO_DISPLAY_NAME.get(kuzu_user_id, chroma_user_id)
    print(f"  [{chroma_user_id}] 读取 {len(records)} 条对话，提取活跃话题线索...")

    # LLM 提取
    threads = extract_threads(records, member_name)
    print(f"  [{chroma_user_id}] 提取 {len(threads)} 条：{[t['name'] for t in threads]}")

    # 写 Kuzu
    written = write_active_threads(conn, kuzu_user_id, threads)
    print(f"  [{chroma_user_id}] 写入 {written} 条 active_thread Fact 边")

    # 更新状态
    state[chroma_user_id] = {
        "last_run":   datetime.datetime.now().isoformat(),
        "last_count": written,
        "last_threads": [t["name"] for t in threads],
    }
    save_state(state)


def main():
    parser = argparse.ArgumentParser(description="活跃话题线索蒸馏")
    parser.add_argument("--user",  help="指定用户 ID（chromaDB 格式，如 zengxiaolong）")
    parser.add_argument("--force", action="store_true", help="忽略冷却和最小记录数限制")
    args = parser.parse_args()

    users = [args.user] if args.user else list(CHROMA_TO_KUZU_ID.keys())

    import kuzu
    db   = kuzu.Database(str(KUZU_DB_PATH))
    conn = kuzu.Connection(db)

    for user_id in users:
        try:
            process_user(conn, user_id, force=args.force)
        except Exception as e:
            print(f"  ERROR [{user_id}]: {e}", file=sys.stderr)

    os._exit(0)  # bypass kuzu Database::~Database() SIGBUS on macOS ARM64


if __name__ == "__main__":
    main()
