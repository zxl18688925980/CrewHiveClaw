#!/usr/bin/env python3
"""
distill-design-learnings.py — Andy Track A：设计判断蒸馏

从 Andy 的历史决策记录（decisions 集合 type=spec/research/pipeline）和团队交互记录
（agent_interactions）中，提炼 Andy 的设计判断积累，写入 decisions（type=design_learning）。

设计原则：
  - 每周日凌晨 1 点由 gateway-watchdog 调用，也可手动运行
  - 读取最近 30 天 Andy 的决策上下文（decisions 集合 type=spec/research/pipeline）
  - 读取现有 design_learning 条目（增量更新：有新场景→追加，无新信息→保留）
  - LLM 以「Andy 自我反思」视角提炼「场景+选择+依据+结果」四元组
  - 写入 ChromaDB decisions（type=design_learning, agent=andy）
  - 全局 12h 冷却，状态存 data/learning/design-learnings-state.json

用法：
  python3 scripts/distill-design-learnings.py          # 全量分析，12h 冷却
  python3 scripts/distill-design-learnings.py --force  # 忽略冷却
"""

import os, sys, json, argparse, datetime, re, requests, uuid
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
STATE_FILE   = _DATA_ROOT / "learning" / "design-learnings-state.json"

LOOKBACK_DAYS    = 30    # 读取最近 N 天 decisions
MIN_RECORDS      = 3     # 少于此数则跳过
COOLDOWN_SECONDS = 12 * 3600   # 12h 冷却


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


def chroma_get_all(collection: str, where: dict = None, limit: int = 200) -> list[dict]:
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


# ── 读取 Andy 历史决策 ─────────────────────────────────────────────────────────

def get_andy_decisions(lookback_days: int = LOOKBACK_DAYS) -> list[dict]:
    """读取最近 lookback_days 天 Andy 的 spec/research/pipeline 类型 decisions"""
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=lookback_days)).isoformat()
    all_records = chroma_get_all(
        "decisions",
        where={"agent": {"$eq": "andy"}},
        limit=200,
    )
    filtered = []
    for r in all_records:
        m    = r["metadata"]
        ts   = str(m.get("timestamp", ""))
        rtype = m.get("type", "")
        if ts >= cutoff and rtype in ("spec", "research", "pipeline", "revision"):
            filtered.append(r)
    filtered.sort(key=lambda x: str(x["metadata"].get("timestamp", "")))
    return filtered


def get_existing_design_learnings() -> list[dict]:
    """读取现有 design_learning 条目（供 LLM 做增量更新参考）"""
    return chroma_get_all(
        "decisions",
        where={"$and": [{"agent": {"$eq": "andy"}}, {"type": {"$eq": "design_learning"}}]},
        limit=50,
    )


# ── LLM ───────────────────────────────────────────────────────────────────────

DISTILL_PROMPT = """\
你是 Andy，CrewClaw 系统里的架构大师。请对你最近的决策记录做自我反思，提炼设计判断积累。

【现有设计判断基础】（上次蒸馏结果，请在此基础上增量更新）
{existing_learnings}

【最近 {days} 天的决策记录】（{count} 条）
{decisions}

请提炼「场景+选择+依据+结果」四元组，代表你作为架构大师的判断积累。

增量更新规则：
- 已有判断有新证据支持或有变化 → 更新 detail（追加新观察）
- 没有新场景 → 原样保留已有判断
- 发现新的设计选择模式 → 新增一条
- 已证明错误或过时的判断 → 在 detail 中标注「已修正」并说明原因

输出严格 JSON（不添加额外字段）：
{{
  "learnings": [
    {{
      "scenario": "场景描述（20字以内，如「微服务拆分粒度决策」）",
      "choice": "做出了什么选择（30字以内）",
      "rationale": "选择依据（60字以内，包含权衡考量）",
      "outcome": "结果观察（40字以内，可为「待验收」）",
      "confidence": 0.8
    }}
  ]
}}

规则：
- 只从决策记录中提炼，不凭空推断
- 日常协调（路由/转发类 pipeline 记录）不作为判断对象
- 没有值得提炼的新判断时返回现有判断原样（避免丢失积累）
- confidence 范围 0.6～0.95
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


def extract_learnings(decisions: list[dict], existing: list[dict]) -> list[dict]:
    existing_text = ""
    for r in existing:
        existing_text += f"- {r['document'][:200]}\n"
    if not existing_text:
        existing_text = "（无已有判断，本次为首次蒸馏）"

    decisions_text = ""
    for r in decisions[-30:]:   # 最多 30 条控制 token
        m   = r["metadata"]
        ts  = str(m.get("timestamp", ""))[:16]
        t   = m.get("type", "")
        doc = r["document"][:300]
        decisions_text += f"[{ts}][{t}] {doc}\n\n"

    prompt = DISTILL_PROMPT.format(
        existing_learnings=existing_text.strip(),
        days=LOOKBACK_DAYS,
        count=len(decisions),
        decisions=decisions_text.strip(),
    )

    raw = _call_llm(prompt)
    m = re.search(r'\{.*\}', raw, re.DOTALL)
    if not m:
        return []
    try:
        data = json.loads(m.group())
        return data.get("learnings", [])
    except Exception:
        return []


# ── 写入 ChromaDB ──────────────────────────────────────────────────────────────

def write_design_learnings(learnings: list[dict]) -> int:
    """
    全量刷新 Andy 的 design_learning 条目：
    1. 所有旧 design_learning 条目做软删除（通过 upsert 覆盖为新版本）
    2. 写入新的判断积累（每条一个 ChromaDB 文档）
    返回写入数量。
    """
    now_iso = datetime.datetime.now().isoformat()
    today   = datetime.date.today().isoformat()
    written = 0

    for idx, l in enumerate(learnings):
        scenario  = l.get("scenario", "").strip()[:30]
        choice    = l.get("choice", "").strip()[:50]
        rationale = l.get("rationale", "").strip()[:100]
        outcome   = l.get("outcome", "").strip()[:60]
        conf      = float(l.get("confidence", 0.75))
        if not scenario:
            continue

        # document 是可读文本，直接注入 Andy 上下文
        document = f"场景：{scenario}；选择：{choice}；依据：{rationale}"
        if outcome and outcome != "待验收":
            document += f"；结果：{outcome}"

        doc_id = f"design-learning-andy-{idx}"
        try:
            embedding = embed_text(document[:300])
            chroma_upsert("decisions", doc_id, document, {
                "agent":     "andy",
                "type":      "design_learning",
                "timestamp": now_iso,
                "date":      today,
                "confidence": conf,
                "scenario":  scenario,
            }, embedding)
            written += 1
        except Exception as e:
            print(f"  WARN: 写入判断 [{scenario}] 失败：{e}", file=sys.stderr)

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
    parser = argparse.ArgumentParser(description="Andy 设计判断蒸馏（Track A）")
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

    print(f"Andy 设计判断蒸馏 @ {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")

    decisions = get_andy_decisions(LOOKBACK_DAYS)
    print(f"读取最近 {LOOKBACK_DAYS} 天 Andy decisions：{len(decisions)} 条")

    if len(decisions) < MIN_RECORDS and not args.force:
        print(f"记录不足 {MIN_RECORDS} 条，跳过。使用 --force 强制执行。")
        sys.stdout.flush()
        os._exit(0)

    existing = get_existing_design_learnings()
    print(f"现有 design_learning 条目：{len(existing)} 条")

    learnings = extract_learnings(decisions, existing)
    print(f"LLM 提炼设计判断：{len(learnings)} 条")

    if not learnings:
        print("LLM 未产出判断，跳过写入")
        sys.stdout.flush()
        os._exit(0)

    written = write_design_learnings(learnings)
    print(f"写入 decisions（design_learning）：{written} 条")

    state = load_state()
    state["last_run"] = datetime.datetime.now().isoformat()
    state["last_count"] = written
    save_state(state)

    sys.stdout.flush()
    os._exit(0)   # bypass kuzu Database::~Database() SIGBUS on macOS ARM64


if __name__ == "__main__":
    main()
