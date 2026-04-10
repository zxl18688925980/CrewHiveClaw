#!/usr/bin/env python3
"""
distill-learning-objectives.py — Track C：组织期待提取（Lucas → Andy/Lisa 学习目标）

从最近的家庭成员对话中，提取成员对系统（Andy/Lisa）的隐性能力期待，
写入 decisions（type=learning_objective, agent=andy 或 agent=lisa）。

设计原则：
  - 每周日凌晨 1 点由 gateway-watchdog 调用，也可手动运行
  - 读取最近 30 天所有家庭成员对话（ChromaDB conversations）
  - LLM 以「Lucas 中间人」视角，提取哪些期待隐含着对 Andy/Lisa 的能力诉求
  - 写入 ChromaDB decisions（type=learning_objective, agent=andy 或 agent=lisa）
  - 全局 12h 冷却，状态存 data/learning/learning-objectives-state.json

注：Track C 是外部输入轨道（成员视角），不依赖 Andy/Lisa 自身工作记录。
    与 Track A（自身经验）互补：一个从内向外，一个从外向内。

用法：
  python3 scripts/distill-learning-objectives.py          # 全量分析，12h 冷却
  python3 scripts/distill-learning-objectives.py --force  # 忽略冷却
"""

import os, sys, json, argparse, datetime, re, requests
from pathlib import Path

# ── 配置 ──────────────────────────────────────────────────────────────────────
_SCRIPTS_DIR = Path(__file__).resolve().parent     # .../HomeAILocal/Scripts
HOMEAI_ROOT  = _SCRIPTS_DIR.parent.parent.parent  # ~/HomeAI
_DATA_ROOT   = Path(os.environ.get("HOMEAI_DATA_ROOT", str(HOMEAI_ROOT / "Data")))
CHROMA_URL   = os.environ.get("CHROMA_URL", "http://localhost:8001")
CHROMA_BASE  = f"{CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections"
OLLAMA_URL   = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
ZAI_KEY      = os.environ.get("ZAI_API_KEY", "")
STATE_FILE   = _DATA_ROOT / "learning" / "learning-objectives-state.json"

LOOKBACK_DAYS    = 30
MIN_RECORDS      = 5    # 至少 5 条对话才值得分析
COOLDOWN_SECONDS = 12 * 3600

# ChromaDB userId（小写）→ 显示名称
USER_DISPLAY = {
    "zengxiaolong":         "爸爸曾小龙",
    "xiamogqiufengliang":   "妈妈张璐",
    "zifeiyu":              "小姨肖山",
    "zengyueyutong":        "姐姐黟黟",
}


# ── ChromaDB 工具 ──────────────────────────────────────────────────────────────

def get_collection_id(name: str) -> str | None:
    r = requests.get(f"{CHROMA_BASE}/{name}", timeout=10)
    return r.json().get("id") if r.status_code == 200 else None


def ensure_collection(name: str) -> str:
    r = requests.post(CHROMA_BASE, json={"name": name, "metadata": {"hnsw:space": "cosine"}}, timeout=10)
    if r.status_code in (200, 409):
        cid = get_collection_id(name)
        if cid:
            return cid
    raise RuntimeError(f"无法确保集合 {name} 存在")


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


def embed_text(text: str) -> list[float]:
    r = requests.post(f"{OLLAMA_URL}/api/embed",
                      json={"model": "nomic-embed-text", "input": text}, timeout=30)
    r.raise_for_status()
    return r.json()["embeddings"][0]


def chroma_upsert(collection: str, doc_id: str, document: str, metadata: dict, embedding: list[float]):
    cid = ensure_collection(collection)
    payload = {
        "ids":        [doc_id],
        "documents":  [document],
        "metadatas":  [metadata],
        "embeddings": [embedding],
    }
    r = requests.post(f"{CHROMA_BASE}/{cid}/upsert", json=payload, timeout=30)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"ChromaDB upsert 失败 {r.status_code}: {r.text[:200]}")


# ── 读取成员对话 ───────────────────────────────────────────────────────────────

def get_all_member_conversations(lookback_days: int = LOOKBACK_DAYS) -> list[dict]:
    """读取所有家庭成员最近 lookback_days 天的对话（仅人类发起）"""
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=lookback_days)).isoformat()
    all_records = chroma_get_all("conversations", limit=500)
    filtered = []
    for r in all_records:
        m    = r["metadata"]
        ts   = str(m.get("timestamp", m.get("created_at", "")))
        uid  = str(m.get("userId", "")).lower()
        if ts >= cutoff and m.get("fromType", "human") not in ("agent",) and uid in USER_DISPLAY:
            r["metadata"]["_display_name"] = USER_DISPLAY[uid]
            filtered.append(r)
    filtered.sort(key=lambda x: str(x["metadata"].get("timestamp", "")))
    return filtered


def get_existing_objectives() -> list[dict]:
    """读取现有 learning_objective 条目"""
    return chroma_get_all(
        "decisions",
        where={"type": {"$eq": "learning_objective"}},
        limit=50,
    )


# ── LLM ───────────────────────────────────────────────────────────────────────

DISTILL_PROMPT = """\
你是 Lucas，团队里的需求官，负责感知家人的需求并把期待传递给 Andy（架构大师）和 Lisa（实现工程师）。

你的任务：从最近的家庭对话中，识别家人对「系统能力」的隐性期待，
翻译成 Andy/Lisa 可以行动的学习方向。

【现有学习目标基础】（上次提取结果，请在此基础上增量更新）
{existing_objectives}

【最近 {days} 天的家人对话】（{count} 条，来自 {members} 位家庭成员）
{conversations}

请识别对话中隐含的能力期待：
- 家人觉得「应该做到但没做到」的事
- 多次提到的同一类问题（暗示系统性缺口）
- 对系统能力的直接或间接评价
- 完成任务时遇到的摩擦（可转化为改进方向）

区分 Andy（设计/架构/理解层）和 Lisa（实现/代码/功能层）：
- Andy 的目标：更好地理解需求意图、设计更合适的方案、提前预判架构风险
- Lisa 的目标：实现更可靠、减少失败率、代码质量和可维护性

增量更新规则：
- 已有目标有新证据支持 → 更新 detail（注明新来源）
- 没有新期待 → 原样保留已有目标
- 发现新的能力缺口 → 新增一条
- 已满足的目标 → 标注「已实现」并保留（作为成长记录）

输出严格 JSON（不添加额外字段）：
{{
  "objectives": [
    {{
      "agent": "andy",
      "gap": "能力缺口描述（30字以内，如「更准确理解情感类需求的优先级」）",
      "evidence": "来自对话的证据（50字以内，引用具体场景）",
      "direction": "建议的学习/改进方向（40字以内）",
      "source_member": "提出期待的家庭成员（如「爸爸」，可选）",
      "confidence": 0.7
    }}
  ]
}}

规则：
- 只从对话中提取真实出现的期待，不推断
- 纯日常闲聊（吃饭问候）不提取
- 没有值得提炼的能力期待时返回 {{ "objectives": [] }}（保留已有目标）
- confidence 范围 0.5～0.9（Track C 是外部视角，天然不确定性高）
"""


def _call_llm(prompt: str) -> str:
    if DEEPSEEK_KEY:
        r = requests.post(
            "https://api.deepseek.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {DEEPSEEK_KEY}", "Content-Type": "application/json"},
            json={
                "model": "deepseek-chat",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 1500, "temperature": 0.3,
            },
            timeout=90,
        )
        if r.status_code == 200:
            return r.json()["choices"][0]["message"]["content"].strip()
    if ZAI_KEY:
        r = requests.post(
            "https://api.zaiasktheai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {ZAI_KEY}", "Content-Type": "application/json"},
            json={
                "model": "glm-5",
                "messages": [{"role": "user", "content": prompt}],
                "max_tokens": 1500, "temperature": 0.3,
            },
            timeout=90,
        )
        if r.status_code == 200:
            return r.json()["choices"][0]["message"]["content"].strip()
    raise RuntimeError("无可用 LLM（DEEPSEEK_API_KEY 或 ZAI_API_KEY 均未设置）")


def extract_objectives(conversations: list[dict], existing: list[dict]) -> list[dict]:
    existing_text = ""
    for r in existing:
        agent = r["metadata"].get("agent", "?")
        existing_text += f"- [{agent}] {r['document'][:200]}\n"
    if not existing_text:
        existing_text = "（无已有目标，本次为首次提取）"

    conv_text = ""
    for r in conversations[-40:]:   # 最多 40 条
        m    = r["metadata"]
        ts   = str(m.get("timestamp", ""))[:16]
        name = m.get("_display_name", m.get("userId", ""))
        doc  = r["document"][:200]
        conv_text += f"[{ts}][{name}] {doc}\n\n"

    member_count = len(set(
        str(r["metadata"].get("userId", "")).lower()
        for r in conversations
        if str(r["metadata"].get("userId", "")).lower() in USER_DISPLAY
    ))

    prompt = DISTILL_PROMPT.format(
        existing_objectives=existing_text.strip(),
        days=LOOKBACK_DAYS,
        count=len(conversations),
        members=member_count,
        conversations=conv_text.strip(),
    )

    raw = _call_llm(prompt)
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if not m:
        return []
    try:
        data = json.loads(m.group())
        return data.get("objectives", [])
    except Exception:
        return []


# ── 写入 ChromaDB ──────────────────────────────────────────────────────────────

def write_learning_objectives(objectives: list[dict]) -> int:
    now_iso = datetime.datetime.now().isoformat()
    today   = datetime.date.today().isoformat()
    written = 0

    for idx, o in enumerate(objectives):
        agent    = o.get("agent", "andy").strip().lower()
        if agent not in ("andy", "lisa"):
            agent = "andy"
        gap       = o.get("gap", "").strip()[:50]
        evidence  = o.get("evidence", "").strip()[:80]
        direction = o.get("direction", "").strip()[:60]
        member    = o.get("source_member", "").strip()[:20]
        conf      = float(o.get("confidence", 0.65))
        if not gap:
            continue

        document = f"能力缺口：{gap}；方向：{direction}"
        if evidence:
            document += f"；依据：{evidence}"
        if member:
            document += f"（来自{member}）"

        doc_id = f"learning-obj-{agent}-{idx}"
        try:
            embedding = embed_text(document[:300])
            chroma_upsert("decisions", doc_id, document, {
                "agent":         agent,
                "type":          "learning_objective",
                "timestamp":     now_iso,
                "date":          today,
                "confidence":    conf,
                "source_member": member,
            }, embedding)
            written += 1
        except Exception as e:
            print(f"  WARN: 写入目标 [{gap}] 失败：{e}", file=sys.stderr)

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

def main():
    parser = argparse.ArgumentParser(description="Track C：从成员对话提取 Andy/Lisa 学习目标")
    parser.add_argument("--force", action="store_true", help="忽略冷却限制")
    args = parser.parse_args()

    if not args.force:
        state    = load_state()
        last_run = state.get("last_run", "")
        if last_run:
            last_dt = datetime.datetime.fromisoformat(last_run)
            if (datetime.datetime.now() - last_dt).total_seconds() < COOLDOWN_SECONDS:
                print(f"冷却中（距上次 < 12h），跳过。使用 --force 强制执行。")
                sys.stdout.flush()
                os._exit(0)

    print(f"Track C 学习目标提取 @ {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")

    conversations = get_all_member_conversations(LOOKBACK_DAYS)
    print(f"读取最近 {LOOKBACK_DAYS} 天家庭成员对话：{len(conversations)} 条")

    if len(conversations) < MIN_RECORDS and not args.force:
        print(f"对话不足 {MIN_RECORDS} 条，跳过。使用 --force 强制执行。")
        sys.stdout.flush()
        os._exit(0)

    existing = get_existing_objectives()
    print(f"现有 learning_objective 条目：{len(existing)} 条（andy+lisa 合计）")

    objectives = extract_objectives(conversations, existing)
    print(f"LLM 提取学习目标：{len(objectives)} 条")

    if not objectives:
        print("LLM 未产出目标，跳过写入")
        sys.stdout.flush()
        os._exit(0)

    written = write_learning_objectives(objectives)
    andy_n = sum(1 for o in objectives if o.get("agent") == "andy")
    lisa_n = sum(1 for o in objectives if o.get("agent") == "lisa")
    print(f"写入 decisions（learning_objective）：{written} 条（Andy {andy_n} 条 / Lisa {lisa_n} 条）")

    state = load_state()
    state["last_run"]   = datetime.datetime.now().isoformat()
    state["last_count"] = written
    save_state(state)

    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
