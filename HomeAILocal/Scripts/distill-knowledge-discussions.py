#!/usr/bin/env python3
"""
distill-knowledge-discussions.py — Track D：家人/工程师对话中的知识讨论蒸馏

扫描最近家庭成员与 Lucas 的对话，识别其中包含设计洞察、领域知识、
系统能力讨论的对话，提取结论写入 Andy 的 decisions（type=knowledge_injection）。

用法：
  python3 scripts/distill-knowledge-discussions.py          # 全量，12h 冷却
  python3 scripts/distill-knowledge-discussions.py --force  # 忽略冷却
"""

import os, sys, json, argparse, datetime, time, requests
from pathlib import Path

# ── 配置 ──────────────────────────────────────────────────────────────────────
HOMEAI_ROOT  = Path(__file__).parent.parent
CHROMA_URL   = os.environ.get("CHROMA_URL", "http://localhost:8001")
CHROMA_BASE  = f"{CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections"
OLLAMA_URL   = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
STATE_FILE   = HOMEAI_ROOT / "data" / "learning" / "knowledge-discussions-state.json"

LOOKBACK_DAYS    = 30
MIN_TURNS        = 3
MAX_GROUPS       = 20
COOLDOWN_SECONDS = 12 * 3600

USER_DISPLAY = {
    "zengxiaolong":         "爸爸曾小龙",
    "xiamoqiufengliang":   "妈妈张璐",
    "zifeiyu":              "小姨肖山",
    "zengyueyutong":        "姐姐黟黟",
}

# ── ChromaDB 工具 ──────────────────────────────────────────────────────────────

def get_collection_id(name):
    r = requests.get(f"{CHROMA_BASE}/{name}", timeout=10)
    return r.json().get("id") if r.status_code == 200 else None

def ensure_collection(name):
    r = requests.post(CHROMA_BASE, json={"name": name, "metadata": {"hnsw:space": "cosine"}}, timeout=10)
    if r.status_code in (200, 409):
        cid = get_collection_id(name)
        if cid:
            return cid
    raise RuntimeError(f"无法确保集合 {name} 存在")

def chroma_get_all(collection, where=None, limit=500):
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
    return [{"id": ids[i], "document": docs[i] if i < len(docs) else "",
             "metadata": metas[i] if i < len(metas) else {}} for i in range(len(ids))]

def embed_text(text):
    r = requests.post(f"{OLLAMA_URL}/api/embed",
                      json={"model": "nomic-embed-text", "input": text}, timeout=30)
    r.raise_for_status()
    return r.json()["embeddings"][0]

def chroma_upsert(collection, doc_id, document, metadata, embedding):
    cid = ensure_collection(collection)
    payload = {"ids": [doc_id], "documents": [document],
               "metadatas": [metadata], "embeddings": [embedding]}
    r = requests.post(f"{CHROMA_BASE}/{cid}/upsert", json=payload, timeout=30)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"ChromaDB upsert 失败 {r.status_code}: {r.text[:200]}")

# ── 对话读取与分组 ─────────────────────────────────────────────────────────────

def get_recent_conversations(lookback_days=LOOKBACK_DAYS):
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=lookback_days)).isoformat()
    all_records = chroma_get_all("conversations", limit=500)
    filtered = []
    for rec in all_records:
        m   = rec["metadata"]
        ts  = str(m.get("timestamp", ""))
        uid = str(m.get("userId", "")).lower()
        if ts >= cutoff and uid in USER_DISPLAY:
            filtered.append(rec)
    filtered.sort(key=lambda x: str(x["metadata"].get("timestamp", "")))
    return filtered

def group_by_user_day(records):
    groups = {}
    for rec in records:
        m   = rec["metadata"]
        uid = str(m.get("userId", "")).lower()
        day = str(m.get("timestamp", ""))[:10]
        key = (uid, day)
        groups.setdefault(key, []).append(rec)
    return groups

# ── LLM 调用 ──────────────────────────────────────────────────────────────────

def call_llm(prompt):
    if not DEEPSEEK_KEY:
        raise RuntimeError("DEEPSEEK_API_KEY 未设置")
    r = requests.post(
        "https://api.deepseek.com/chat/completions",
        headers={"Authorization": f"Bearer {DEEPSEEK_KEY}", "Content-Type": "application/json"},
        json={"model": "deepseek-chat",
              "messages": [{"role": "user", "content": prompt}],
              "max_tokens": 500, "temperature": 0.3},
        timeout=40,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()

# ── 核心：识别并提取知识讨论 ───────────────────────────────────────────────────

def analyze_group(uid, date, records, display_name):
    turns = []
    for rec in records:
        m = rec["metadata"]
        p = str(m.get("prompt", ""))[:200]
        resp = str(m.get("response", ""))[:200]
        if p:
            turns.append(f"{display_name}：{p}")
        if resp:
            turns.append(f"Lucas：{resp}")

    if len(turns) < MIN_TURNS * 2:
        return None

    convo = "\n".join(turns[:40])

    prompt = f"""以下是家庭成员「{display_name}」与 AI 助手 Lucas 的对话（{date}）：

{convo}

请判断这段对话是否包含以下任一类型的有价值内容：
A. 某个领域的专业知识分享（如行业知识、技能方法）
B. 对 AI 系统能力边界的洞察或讨论
C. 对家庭智慧中枢功能/设计的想法或期待
D. 达成了某个值得系统记住的共识或结论

如果不包含以上任何一类（只是日常帮忙请求或闲聊），只回复：无价值

如果包含，按以下格式输出（每项不超过 100 字）：
类型：A/B/C/D
主题：[一句话描述这是关于什么的讨论]
核心洞察：[这段对话中最有价值的知识点或结论]
对系统的启示：[Andy 应该从中得到什么启发或行动方向]"""

    try:
        result = call_llm(prompt)
    except Exception as e:
        print(f"  LLM 调用失败：{e}")
        return None

    if "无价值" in result:
        return None

    return {"uid": uid, "date": date, "display_name": display_name,
            "turns_count": len(turns) // 2, "extraction": result}

# ── 写入 decisions 集合 ────────────────────────────────────────────────────────

def write_to_andy(items):
    written = 0
    for item in items:
        topic = f"{item['display_name']}的知识分享（{item['date']}）"
        for line in item["extraction"].split("\n"):
            if line.startswith("主题："):
                topic = line.replace("主题：", "").strip()
                break

        document = (f"【{topic}】来源：{item['display_name']} 与 Lucas 对话（{item['date']}）\n\n"
                    f"{item['extraction']}")
        doc_id = f"knowledge_injection_{int(time.time())}_{item['uid'][:8]}_{item['date'].replace('-','')}"

        try:
            embedding = embed_text(document)
            chroma_upsert("decisions", doc_id, document, {
                "agent":     "andy",
                "type":      "knowledge_injection",
                "topic":     topic,
                "source":    f"{item['display_name']} 与 Lucas 对话",
                "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }, embedding)
            print(f"  [write] {topic}")
            written += 1
            time.sleep(0.3)
        except Exception as e:
            print(f"  [err] 写入失败：{e}")
    return written

# ── 冷却状态 ──────────────────────────────────────────────────────────────────

def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {}

def save_state(state):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2))

# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="忽略冷却限制")
    args = parser.parse_args()

    state = load_state()
    if not args.force and "last_run" in state:
        try:
            last_dt = datetime.datetime.fromisoformat(state["last_run"])
            elapsed = (datetime.datetime.now() - last_dt).total_seconds()
            if elapsed < COOLDOWN_SECONDS:
                print(f"冷却中（{elapsed/3600:.1f}h < 12h），跳过。用 --force 覆盖。")
                sys.exit(0)
        except Exception:
            pass

    print("=== distill-knowledge-discussions (Track D) ===")
    sys.stdout.flush()

    records = get_recent_conversations(LOOKBACK_DAYS)
    print(f"最近 {LOOKBACK_DAYS} 天对话：{len(records)} 条")
    sys.stdout.flush()

    if not records:
        print("无对话记录，退出")
        save_state({"last_run": datetime.datetime.now().isoformat()})
        sys.exit(0)

    groups = group_by_user_day(records)
    print(f"对话群组：{len(groups)} 个")
    sys.stdout.flush()

    sorted_groups = sorted(groups.items(), key=lambda x: len(x[1]), reverse=True)[:MAX_GROUPS]

    candidates = []
    for (uid, date), recs in sorted_groups:
        display = USER_DISPLAY.get(uid, uid)
        if len(recs) < MIN_TURNS:
            continue
        print(f"  分析 {display} {date}（{len(recs)} 条）...")
        sys.stdout.flush()
        item = analyze_group(uid, date, recs, display)
        if item:
            candidates.append(item)
            print(f"    -> 发现知识讨论")
            sys.stdout.flush()

    print(f"\n有价值的知识讨论：{len(candidates)} 个")
    if candidates:
        written = write_to_andy(candidates)
        print(f"写入 Andy decisions：{written} 条")
    else:
        print("无需写入")

    save_state({"last_run": datetime.datetime.now().isoformat(),
                "last_written": len(candidates)})
    print("=== 完成 ===")
    sys.stdout.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
