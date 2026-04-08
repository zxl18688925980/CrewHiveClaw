#!/usr/bin/env python3
"""
distill-impl-learnings.py — Lisa Track A：代码库认知蒸馏

从 Lisa 的 code_history（实现历史）和 codebase_patterns（opencode 运行观察）中，
按模块/文件维度提炼 Lisa 的代码库认知，写入 decisions（type=impl_learning, agent=lisa）。

设计原则：
  - 每周日凌晨 1 点由 gateway-watchdog 调用，也可手动运行
  - 读取最近 30 天 code_history + codebase_patterns
  - 读取现有 impl_learning 条目（增量更新）
  - LLM 以「Lisa 自我反思」视角，按模块/文件维度提炼「模块+模式+陷阱+建议」四元组
  - 写入 ChromaDB decisions（type=impl_learning, agent=lisa）
  - 全局 12h 冷却，状态存 data/learning/impl-learnings-state.json

用法：
  python3 scripts/distill-impl-learnings.py          # 全量分析，12h 冷却
  python3 scripts/distill-impl-learnings.py --force  # 忽略冷却
"""

import os, sys, json, argparse, datetime, re, requests
from pathlib import Path

# ── 配置 ──────────────────────────────────────────────────────────────────────
HOMEAI_ROOT  = Path(__file__).parent.parent
CHROMA_URL   = os.environ.get("CHROMA_URL", "http://localhost:8001")
CHROMA_BASE  = f"{CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections"
OLLAMA_URL   = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
ZAI_KEY      = os.environ.get("ZAI_API_KEY", "")
STATE_FILE   = HOMEAI_ROOT / "data" / "learning" / "impl-learnings-state.json"

LOOKBACK_DAYS    = 30
MIN_RECORDS      = 3
COOLDOWN_SECONDS = 12 * 3600


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


# ── 读取源数据 ─────────────────────────────────────────────────────────────────

def get_lisa_code_history(lookback_days: int = LOOKBACK_DAYS) -> list[dict]:
    """读取最近 lookback_days 天 Lisa 的 code_history"""
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=lookback_days)).isoformat()
    all_records = chroma_get_all("code_history", limit=200)
    filtered = []
    for r in all_records:
        ts = str(r["metadata"].get("timestamp", r["metadata"].get("created_at", "")))
        if ts >= cutoff:
            filtered.append(r)
    filtered.sort(key=lambda x: str(x["metadata"].get("timestamp", "")))
    return filtered


def get_codebase_patterns(lookback_days: int = LOOKBACK_DAYS) -> list[dict]:
    """读取最近 lookback_days 天的 codebase_patterns（opencode 运行记录）"""
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=lookback_days)).isoformat()
    all_records = chroma_get_all("codebase_patterns", limit=100)
    filtered = []
    for r in all_records:
        ts = str(r["metadata"].get("timestamp", ""))
        if ts >= cutoff:
            filtered.append(r)
    filtered.sort(key=lambda x: str(x["metadata"].get("timestamp", "")))
    return filtered


def get_existing_impl_learnings() -> list[dict]:
    """读取现有 impl_learning 条目"""
    return chroma_get_all(
        "decisions",
        where={"$and": [{"agent": {"$eq": "lisa"}}, {"type": {"$eq": "impl_learning"}}]},
        limit=50,
    )


# ── LLM ───────────────────────────────────────────────────────────────────────

DISTILL_PROMPT = """\
你是 Lisa，CrewClaw 系统里的业务大师（实现工程师）。请对你最近的代码实现记录做自我反思，
提炼代码库认知积累，帮助你在下次实现时能更准确地定位和修改。

【现有代码库认知基础】（上次蒸馏结果，请在此基础上增量更新）
{existing_learnings}

【最近 {days} 天的实现记录】（code_history：{history_count} 条，opencode 运行记录：{pattern_count} 条）
--- code_history（实现结果） ---
{code_history}

--- codebase_patterns（opencode 运行质量） ---
{codebase_patterns}

请按模块/文件维度提炼「模块+模式+陷阱+建议」四元组，代表你对代码库的认知积累。

增量更新规则：
- 已有认知有新证据 → 更新 detail
- 发现新的模块/陷阱 → 新增一条
- 已解决/不再存在的陷阱 → 标注「已解决」并保留（避免重蹈覆辙）

输出严格 JSON（不添加额外字段）：
{{
  "learnings": [
    {{
      "module": "模块/文件标识（20字以内，如「index.ts 工具注册」或「task-manager.js」）",
      "pattern": "这个模块的关键规律（40字以内，正面规律）",
      "pitfall": "已知陷阱或易错点（40字以内，null 表示无已知陷阱）",
      "advice": "下次处理此模块时的行动建议（30字以内）",
      "confidence": 0.8
    }}
  ]
}}

规则：
- 只从实现记录中提炼，不推断
- spec 吻合率低的运行（matchRate < 60）值得特别关注
- 没有新认知时返回现有认知原样
- confidence 范围 0.6～0.95
"""


def _call_llm(prompt: str) -> str:
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
    raise RuntimeError("无可用 LLM（DEEPSEEK_API_KEY 或 ZAI_API_KEY 均未设置）")


def extract_learnings(
    code_history: list[dict],
    codebase_patterns: list[dict],
    existing: list[dict],
) -> list[dict]:
    existing_text = ""
    for r in existing:
        existing_text += f"- {r['document'][:200]}\n"
    if not existing_text:
        existing_text = "（无已有认知，本次为首次蒸馏）"

    history_text = ""
    for r in code_history[-20:]:
        m   = r["metadata"]
        ts  = str(m.get("timestamp", ""))[:16]
        doc = r["document"][:250]
        history_text += f"[{ts}] {doc}\n\n"

    pattern_text = ""
    for r in codebase_patterns[-15:]:
        m       = r["metadata"]
        ts      = str(m.get("timestamp", ""))[:16]
        success = "✅" if m.get("success") else "❌"
        rate    = m.get("matchRate", "?")
        doc     = r["document"][:200]
        pattern_text += f"[{ts}] {success} 吻合率{rate}% {doc}\n\n"

    if not history_text:
        history_text = "（无记录）"
    if not pattern_text:
        pattern_text = "（无记录）"

    prompt = DISTILL_PROMPT.format(
        existing_learnings=existing_text.strip(),
        days=LOOKBACK_DAYS,
        history_count=len(code_history),
        pattern_count=len(codebase_patterns),
        code_history=history_text.strip(),
        codebase_patterns=pattern_text.strip(),
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

def write_impl_learnings(learnings: list[dict]) -> int:
    now_iso = datetime.datetime.now().isoformat()
    today   = datetime.date.today().isoformat()
    written = 0

    for idx, l in enumerate(learnings):
        module   = l.get("module", "").strip()[:30]
        pattern  = l.get("pattern", "").strip()[:60]
        pitfall  = l.get("pitfall") or ""
        advice   = l.get("advice", "").strip()[:50]
        conf     = float(l.get("confidence", 0.75))
        if not module:
            continue

        document = f"模块：{module}；规律：{pattern}"
        if pitfall:
            document += f"；陷阱：{pitfall}"
        if advice:
            document += f"；建议：{advice}"

        doc_id = f"impl-learning-lisa-{idx}"
        try:
            embedding = embed_text(document[:300])
            chroma_upsert("decisions", doc_id, document, {
                "agent":     "lisa",
                "type":      "impl_learning",
                "timestamp": now_iso,
                "date":      today,
                "confidence": conf,
                "module":    module,
            }, embedding)
            written += 1
        except Exception as e:
            print(f"  WARN: 写入认知 [{module}] 失败：{e}", file=sys.stderr)

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
    parser = argparse.ArgumentParser(description="Lisa 代码库认知蒸馏（Track A）")
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

    print(f"Lisa 代码库认知蒸馏 @ {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')}")

    code_history     = get_lisa_code_history(LOOKBACK_DAYS)
    codebase_patterns = get_codebase_patterns(LOOKBACK_DAYS)
    total = len(code_history) + len(codebase_patterns)
    print(f"读取 code_history：{len(code_history)} 条，codebase_patterns：{len(codebase_patterns)} 条")

    if total < MIN_RECORDS and not args.force:
        print(f"总记录不足 {MIN_RECORDS} 条，跳过。使用 --force 强制执行。")
        sys.stdout.flush()
        os._exit(0)

    existing = get_existing_impl_learnings()
    print(f"现有 impl_learning 条目：{len(existing)} 条")

    learnings = extract_learnings(code_history, codebase_patterns, existing)
    print(f"LLM 提炼代码库认知：{len(learnings)} 条")

    if not learnings:
        print("LLM 未产出认知，跳过写入")
        sys.stdout.flush()
        os._exit(0)

    written = write_impl_learnings(learnings)
    print(f"写入 decisions（impl_learning）：{written} 条")

    state = load_state()
    state["last_run"] = datetime.datetime.now().isoformat()
    state["last_count"] = written
    save_state(state)

    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
