#!/usr/bin/env python3
"""
distill-team-observations.py — Andy 视角的家人行为模式分析，写入 Kuzu team_observation Fact 边。

设计原则：
  - 由 gateway-watchdog 每日定时调用，也可手动运行
  - 读取最近 LOOKBACK_DAYS 天对话（ChromaDB conversations）
  - 读取现有 team_observation facts（增量更新：有新信息→追加，无新信息→保留，新话题→新增）
  - LLM 以「架构大师 Andy」视角分析家人行为模式，产出结构化洞察
  - 写入 Kuzu：andy -[Fact{relation:'team_observation'}]-> person
  - 边方向：andy → person（与 person → topic 的 Fact 边方向不同，render-knowledge.py 单独查询）
  - 全局 6h 冷却（单次运行跨所有家庭成员），状态存 data/learning/team-obs-state.json

用法：
  python3 scripts/distill-team-observations.py               # 全量（所有家庭成员）
  python3 scripts/distill-team-observations.py --user ZengXiaoLong
  python3 scripts/distill-team-observations.py --force       # 忽略冷却和最小记录数限制
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
STATE_FILE   = _DATA_ROOT / "learning" / "team-obs-state.json"

LOOKBACK_DAYS    = 7     # 读取最近 N 天对话
MIN_RECORDS      = 3     # 少于此数则跳过（无足够上下文）
COOLDOWN_SECONDS = 6 * 3600   # 全局 6h 冷却（同一批次不重复跑）
OBS_VALID_DAYS   = 30    # team_observation 有效期（30 天后过期，不再注入）

# ChromaDB userId（小写）→ Kuzu Entity ID
CHROMA_TO_KUZU_ID = {
    "zengxiaolong":         "ZengXiaoLong",
    "xiamoqiufengliang":   "XiaMoQiuFengLiang",
    "zifeiyu":              "ZiFeiYu",
    "zengyueyutong":        "ZengYueYuTong",
}

KUZU_TO_DISPLAY_NAME = {
    "ZengXiaoLong":         "爸爸曾小龙",
    "XiaMoQiuFengLiang":    "妈妈张璐",
    "ZiFeiYu":              "小姨肖山",
    "ZengYueYuTong":        "姐姐黟黟",
}

# ── Prompt ─────────────────────────────────────────────────────────────────────

OBSERVE_PROMPT = """\
你是 Andy，Lucas 团队里的架构大师，负责从对话数据中提炼对家人的分析性洞察，帮助 Lucas 在对话时有更深的理解。

【分析对象】{member}
【对话时间范围】最近 {days} 天（共 {count} 条）

【现有洞察基础】（上次分析结果，请在此基础上做增量更新）
{existing_obs}

【最近对话记录】
{conversations}

请从「架构大师」视角分析：不要关注日常闲聊，聚焦在：
- 这个人最近的状态变化（情绪、压力、关注点转移）
- 反复出现的模式（同一话题多次提及、相似的情绪信号）
- 未说出口的诉求（表面在问A，实际需要B）
- Lucas 下次对话时特别需要注意的事

增量更新规则：
- 有新信息或模式变化 → 更新或追加已有洞察的 detail
- 没有新信息 → 原样保留已有洞察
- 发现全新维度 → 新增一条
- 已过时的洞察（对话中已明确结束）→ 从输出中删去

输出严格 JSON（不添加额外字段）：
{{
  "observations": [
    {{
      "summary": "核心观察，一句话（40字以内）",
      "detail": "Lucas 对话时需要知道的背景和模式（80字以内）",
      "signal": "给 Lucas 的行动提示（25字以内，如「先听完她的再给建议」）",
      "confidence": 0.8
    }}
  ]
}}

规则：
- 只提取对话中真实出现的信号，不推断，不补充
- 日常闲聊（吃饭睡觉问候）不提取
- 没有值得提炼的洞察时返回 {{ "observations": [] }}
- confidence 范围 0.6～0.95，反映信号的明确程度
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


def get_recent_conversations(chroma_user_id: str, lookback_days: int = LOOKBACK_DAYS) -> list[dict]:
    """获取该用户最近 lookback_days 天的人类发起对话"""
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=lookback_days)).isoformat()
    all_records = chroma_get_all(
        "conversations",
        where={"userId": {"$eq": chroma_user_id}},
        limit=300,
    )
    filtered = []
    for r in all_records:
        m  = r["metadata"]
        ts = str(m.get("timestamp", m.get("created_at", "")))
        if ts >= cutoff and m.get("fromType", "human") not in ("agent",):
            filtered.append(r)
    filtered.sort(key=lambda x: str(x["metadata"].get("timestamp", "")))
    return filtered


# ── Kuzu 读取现有 team_observation ────────────────────────────────────────────

def load_existing_observations(conn, kuzu_user_id: str) -> str:
    """读取现有 andy→person team_observation facts，格式化为文字供 LLM 参考"""
    try:
        res = conn.execute(
            "MATCH (a:Entity {id: 'andy'})-[f:Fact {relation: 'team_observation'}]->(p:Entity {id: $pid}) "
            "WHERE f.valid_until IS NULL OR f.valid_until > $today "
            "RETURN f.context ORDER BY f.valid_from DESC",
            {"pid": kuzu_user_id, "today": datetime.date.today().isoformat()},
        )
        contexts = []
        for row in res:
            if row[0]:
                contexts.append(f"- {row[0]}")
        return "\n".join(contexts) if contexts else "（无已有洞察，本次为首次分析）"
    except Exception:
        return "（读取已有洞察失败，请从对话记录全量分析）"


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
                    "max_tokens": 1000, "temperature": 0.3,
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


def extract_observations(records: list[dict], member_name: str, existing_obs: str, lookback_days: int = LOOKBACK_DAYS) -> list[dict]:
    """用 LLM 从对话记录中提炼 Andy 视角的行为模式洞察"""
    conv_text = ""
    for r in records[-25:]:   # 最多取最近 25 条，控制 token 用量
        m   = r["metadata"]
        ts  = str(m.get("timestamp", ""))[:16]
        doc = r["document"][:250]
        conv_text += f"[{ts}] {doc}\n\n"

    prompt = OBSERVE_PROMPT.format(
        member=member_name,
        days=lookback_days,
        count=len(records),
        existing_obs=existing_obs,
        conversations=conv_text.strip(),
    )

    raw = _call_llm(prompt)
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if not m:
        return []
    try:
        data = json.loads(m.group())
        return data.get("observations", [])
    except Exception:
        return []


# ── Kuzu 写入 ─────────────────────────────────────────────────────────────────

def write_team_observations(conn, kuzu_user_id: str, observations: list[dict]) -> int:
    """
    全量刷新该 person 的 team_observation Fact 边（andy → person）：
    1. 过期该 person 现有的所有 team_observation 边
    2. 写入新的观察（每条一个 Fact 边，context = summary + detail + signal）
    返回写入数量。
    """
    now_iso   = datetime.datetime.now().isoformat()
    today     = datetime.date.today()
    until_iso = (today + datetime.timedelta(days=OBS_VALID_DAYS)).isoformat()
    sid       = f"team-obs-{today.isoformat()}"

    # 过期旧 team_observation 边
    try:
        conn.execute(
            "MATCH (a:Entity {id: 'andy'})-[f:Fact {relation: 'team_observation'}]->(p:Entity {id: $pid}) "
            "SET f.valid_until = $today",
            {"pid": kuzu_user_id, "today": today.isoformat()},
        )
    except Exception as e:
        print(f"  WARN: 过期旧 team_observation 失败：{e}", file=sys.stderr)

    written = 0
    for obs in observations:
        summary = obs.get("summary", "").strip()[:60]
        detail  = obs.get("detail", "").strip()[:120]
        signal  = obs.get("signal", "").strip()[:40]
        conf    = float(obs.get("confidence", 0.75))
        if not summary:
            continue

        # context 格式：可读文本，render-knowledge.py 直接渲染为 bullet
        parts = [summary]
        if detail:
            parts.append(detail)
        if signal:
            parts.append(f"→ {signal}")
        ctx_str = "；".join(parts)

        try:
            conn.execute(
                "MATCH (a:Entity {id: 'andy'}), (p:Entity {id: $pid}) "
                "CREATE (a)-[:Fact {"
                "  relation:    'team_observation', "
                "  context:     $ctx, "
                "  valid_from:  $from, "
                "  valid_until: $until, "
                "  confidence:  $conf, "
                "  source_type: 'team_obs_distill', "
                "  source_id:   $sid"
                "}]->(p)",
                {
                    "pid":   kuzu_user_id,
                    "ctx":   ctx_str,
                    "from":  now_iso,
                    "until": until_iso,
                    "conf":  conf,
                    "sid":   sid,
                },
            )
            written += 1
        except Exception as e:
            print(f"  WARN: 写入观察 [{summary}] 失败：{e}", file=sys.stderr)

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

    lookback = 30 if force else LOOKBACK_DAYS
    records = get_recent_conversations(chroma_user_id.lower(), lookback_days=lookback)
    if len(records) < MIN_RECORDS and not force:
        print(f"  [{chroma_user_id}] 最近 {lookback} 天对话不足 {MIN_RECORDS} 条，跳过")
        return

    member_name  = KUZU_TO_DISPLAY_NAME.get(kuzu_user_id, chroma_user_id)
    existing_obs = load_existing_observations(conn, kuzu_user_id)
    print(f"  [{chroma_user_id}] 读取 {len(records)} 条对话（回溯 {lookback} 天），提炼 Andy 视角洞察...")

    observations = extract_observations(records, member_name, existing_obs, lookback_days=lookback)
    print(f"  [{chroma_user_id}] 提炼 {len(observations)} 条观察")

    if not observations:
        print(f"  [{chroma_user_id}] LLM 未产出洞察，跳过写入")
        return

    written = write_team_observations(conn, kuzu_user_id, observations)
    print(f"  [{chroma_user_id}] 写入 {written} 条 team_observation Fact 边")


def main():
    parser = argparse.ArgumentParser(description="Andy 视角家人行为模式分析（team_observation）")
    parser.add_argument("--user",  help="指定用户 Kuzu ID（如 ZengXiaoLong）或 ChromaDB ID（如 zengxiaolong）")
    parser.add_argument("--force", action="store_true", help="忽略冷却和最小记录数限制")
    args = parser.parse_args()

    # 全局冷却检查（非 --force 时）
    if not args.force and not args.user:
        state    = load_state()
        last_run = state.get("last_global_run", "")
        if last_run:
            last_dt = datetime.datetime.fromisoformat(last_run)
            if (datetime.datetime.now() - last_dt).total_seconds() < COOLDOWN_SECONDS:
                print(f"全局冷却中（距上次 < 6h），跳过。使用 --force 强制执行。")
                sys.stdout.flush()
                os._exit(0)

    # 确定要处理的用户列表
    if args.user:
        # 支持 Kuzu ID 和 ChromaDB ID 两种输入
        if args.user in CHROMA_TO_KUZU_ID.values():
            # 反查 chroma ID
            users = [k for k, v in CHROMA_TO_KUZU_ID.items() if v == args.user]
        else:
            users = [args.user.lower()]
    else:
        users = list(CHROMA_TO_KUZU_ID.keys())

    print(f"team_observation 分析 @ {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")
    print(f"处理用户：{users}\n")

    import kuzu
    db   = kuzu.Database(str(KUZU_DB_PATH))
    conn = kuzu.Connection(db)

    for user_id in users:
        try:
            process_user(conn, user_id, force=args.force)
        except Exception as e:
            print(f"  ERROR [{user_id}]: {e}", file=sys.stderr)

    # 更新全局运行时间
    if not args.user:
        state = load_state()
        state["last_global_run"] = datetime.datetime.now().isoformat()
        save_state(state)

    sys.stdout.flush()
    os._exit(0)  # bypass kuzu Database::~Database() SIGBUS on macOS ARM64


if __name__ == "__main__":
    main()
