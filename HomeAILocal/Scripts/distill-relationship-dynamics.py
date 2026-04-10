#!/usr/bin/env python3
"""
协作关系蒸馏脚本：ChromaDB conversations → Kuzu 动态协作边（person→person）

流程：
  每个家庭成员的对话 → LLM 提取「在对话中提及他人协作」的信号
  → Kuzu person→person Fact（relation: co_discusses / requests_from / supports / role_in_context）
  蒸馏结束 → 触发 render-knowledge.py → 刷新 inject.md（新增「协作关系」节）

用法：
  python3 scripts/distill-relationship-dynamics.py              # 全量
  python3 scripts/distill-relationship-dynamics.py --user ZengXiaoLong  # 单人
  python3 scripts/distill-relationship-dynamics.py --force      # 忽略冷却期

调度：gateway-watchdog.js 每周日凌晨 4am（错开 distill-memories.py 的 2am）
"""

import os, sys, json, argparse, datetime, requests, re, subprocess
from pathlib import Path

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")

# ── 配置 ─────────────────────────────────────────────────────────────────────
_SCRIPTS_DIR  = Path(__file__).resolve().parent     # .../HomeAILocal/Scripts
HOMEAI_ROOT   = _SCRIPTS_DIR.parent.parent.parent  # ~/HomeAI（Scripts → HomeAILocal → CrewHiveClaw → HomeAI）
# 数据目录独立于代码仓，支持 env var 覆盖（生产环境/多实例部署时有用）
DATA_ROOT     = Path(os.environ.get("HOMEAI_DATA_ROOT", str(HOMEAI_ROOT / "Data")))
CHROMA_URL    = os.environ.get("CHROMA_URL", "http://localhost:8001")
CHROMA_BASE   = f"{CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections"
DEEPSEEK_KEY  = os.environ.get("DEEPSEEK_API_KEY", "")
ZAI_KEY       = os.environ.get("ZAI_API_KEY", "")
KUZU_DB_PATH  = DATA_ROOT / "kuzu"
PYTHON3       = "/opt/homebrew/opt/python@3.11/bin/python3.11"
RENDER_SCRIPT = _SCRIPTS_DIR / "render-knowledge.py"

COLLAB_VALID_DAYS = 90   # 协作边有效期（天），蒸馏时 upsert 延续
COOLDOWN_DAYS     = 7    # 同一用户 7 天内不重复蒸馏（--force 可跳过）
MIN_RECORDS       = 5    # 至少 N 条对话才蒸馏
MAX_RECORDS       = 60   # 每次最多取最近 N 条送 LLM
MAX_CONV_CHARS    = 300  # 每条对话最多保留字符数

# ChromaDB userId（小写）→ Kuzu Entity ID（大驼峰）
CHROMA_TO_KUZU_ID = {
    "zengxiaolong":       "ZengXiaoLong",
    "xiamoqiufengliang":  "XiaMoQiuFengLiang",
    "zifeiyu":            "ZiFeiYu",
    "zengyueyutong":      "ZengYueYuTong",
}

MEMBER_NAMES = {
    "ZengXiaoLong":      "爸爸曾小龙",
    "XiaMoQiuFengLiang": "妈妈张璐",
    "ZiFeiYu":           "小姨肖山",
    "ZengYueYuTong":     "姐姐黟黟",
}

# 家庭成员名称/称呼 → Kuzu userId（LLM 返回称呼后解析目标 ID）
PERSON_NAME_TO_ID = {
    "爸爸":     "ZengXiaoLong",
    "曾小龙":   "ZengXiaoLong",
    "妈妈":     "XiaMoQiuFengLiang",
    "张璐":     "XiaMoQiuFengLiang",
    "小姨":     "ZiFeiYu",
    "肖山":     "ZiFeiYu",
    "姐姐":     "ZengYueYuTong",
    "黟黟":     "ZengYueYuTong",
    "曾玥语桐": "ZengYueYuTong",
    "Lucas":    "lucas",
    "lucas":    "lucas",
    "启灵":     "lucas",
}

FAMILY_MEMBERS_DESC = "爸爸曾小龙、妈妈张璐、小姨肖山、姐姐黟黟（曾玥语桐）、Lucas曾璿岐霖（小名启灵）"

META_DIR = DATA_ROOT / "member-profiles"
META_DIR.mkdir(parents=True, exist_ok=True)

# ── ChromaDB 工具 ─────────────────────────────────────────────────────────────

def get_collection_id(name: str) -> str | None:
    r = requests.get(f"{CHROMA_BASE}/{name}", timeout=10)
    if r.status_code == 200:
        return r.json().get("id")
    return None


def chroma_get_recent(chroma_user_id: str, limit: int = MAX_RECORDS) -> list[dict]:
    """获取该用户最近 limit 条对话。
    分页拉取该用户全部记录（where 过滤），返回最后 limit 条（时间最新）。
    不用 /count + offset 估算：/count 不支持 where 过滤，会返回全集合大小导致 offset 偏移错误。
    """
    cid = get_collection_id("conversations")
    if not cid:
        return []
    all_items: list[dict] = []
    offset    = 0
    page_size = 500
    while True:
        payload = {
            "limit":   page_size,
            "offset":  offset,
            "include": ["documents", "metadatas"],
            "where":   {"userId": {"$eq": chroma_user_id}},
        }
        r = requests.post(f"{CHROMA_BASE}/{cid}/get", json=payload, timeout=30)
        if r.status_code != 200:
            break
        data  = r.json()
        ids   = data.get("ids", [])
        docs  = data.get("documents", [])
        metas = data.get("metadatas", [])
        if not ids:
            break
        all_items.extend({"id": ids[i], "document": docs[i], "metadata": metas[i]}
                         for i in range(len(ids)))
        offset += len(ids)
        if len(ids) < page_size:
            break
    # 取最后 limit 条（对话按写入顺序存储，尾部最新）
    return all_items[-limit:] if len(all_items) > limit else all_items


# ── Kuzu 工具 ─────────────────────────────────────────────────────────────────

def get_kuzu_conn():
    try:
        import kuzu as _kuzu
        db = _kuzu.Database(str(KUZU_DB_PATH))
        return _kuzu.Connection(db)
    except ImportError:
        print("  WARN: kuzu 未安装，跳过 Kuzu 写入", file=sys.stderr)
        return None


def write_collab_facts(conn, from_id: str, edges: list[dict]) -> int:
    """
    将协作边写入 Kuzu（person→person Fact，source_type='collab_distill'）。
    Upsert by (from_id, to_id, relation)：有活跃边则更新 context/valid_until，无则 CREATE。
    返回写入/更新数量。
    """
    if conn is None or not edges:
        return 0

    now_iso     = datetime.datetime.now().isoformat()
    today_str   = datetime.date.today().isoformat()
    valid_until = (datetime.date.today() + datetime.timedelta(days=COLLAB_VALID_DAYS)).isoformat()
    sid         = f"collab-{datetime.date.today().isoformat()}"
    written     = 0

    for edge in edges:
        to_id    = edge.get("to_id", "")
        relation = edge.get("relation", "")
        context  = edge.get("context", "")[:200]
        if not to_id or not relation or to_id == from_id:
            continue

        try:
            # 确保目标 Entity 节点存在
            to_name = MEMBER_NAMES.get(to_id, to_id)
            conn.execute(
                "MERGE (e:Entity {id: $id}) SET e.type = 'person', e.name = $name",
                {"id": to_id, "name": to_name},
            )
            # Upsert：查活跃协作边
            existing = conn.execute(
                "MATCH (a:Entity {id: $aid})-[f:Fact]->(b:Entity {id: $bid}) "
                "WHERE f.relation = $rel AND f.source_type = 'collab_distill' "
                "AND f.valid_until >= $today RETURN f",
                {"aid": from_id, "bid": to_id, "rel": relation, "today": today_str},
            )
            if existing.has_next():
                conn.execute(
                    "MATCH (a:Entity {id: $aid})-[f:Fact]->(b:Entity {id: $bid}) "
                    "WHERE f.relation = $rel AND f.source_type = 'collab_distill' "
                    "AND f.valid_until >= $today "
                    "SET f.context = $ctx, f.valid_from = $from, "
                    "f.valid_until = $until, f.source_id = $sid",
                    {"aid": from_id, "bid": to_id, "rel": relation,
                     "ctx": context, "from": now_iso, "until": valid_until, "sid": sid},
                )
                print(f"  [collab-update] {from_id} --{relation}--> {to_id}（{context[:50]}）")
            else:
                conn.execute(
                    "MATCH (a:Entity {id: $aid}), (b:Entity {id: $bid}) "
                    "CREATE (a)-[:Fact {relation: $rel, context: $ctx, "
                    "valid_from: $from, valid_until: $until, confidence: 0.75, "
                    "source_type: 'collab_distill', source_id: $sid}]->(b)",
                    {"aid": from_id, "bid": to_id, "rel": relation,
                     "ctx": context, "from": now_iso, "until": valid_until, "sid": sid},
                )
                print(f"  [collab-create] {from_id} --{relation}--> {to_id}（{context[:50]}）")
            written += 1
        except Exception as e:
            print(f"  WARN: 协作边写入失败 {from_id}->{to_id}({relation}): {e}", file=sys.stderr)

    return written


# ── ChromaDB 写入工具（Phase 3 演进环） ──────────────────────────────────────

def embed_text(text: str) -> list:
    """用 Ollama nomic-embed-text 生成嵌入向量。"""
    try:
        r = requests.post(
            f"{OLLAMA_URL}/api/embed",
            json={"model": "nomic-embed-text", "input": text},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()["embeddings"][0]
    except Exception as e:
        print(f"  WARN: embed_text 失败：{e}，返回空向量", file=sys.stderr)
        return []


def ensure_shadow_collection(name: str) -> str | None:
    """确保 ChromaDB 集合存在，返回 collection id。"""
    # 先尝试获取
    cid = get_collection_id(name)
    if cid:
        return cid
    # 不存在则创建
    try:
        r = requests.post(
            CHROMA_BASE,
            json={"name": name, "metadata": {"hnsw:space": "cosine"}},
            timeout=10,
        )
        if r.status_code in (200, 201, 409):
            return get_collection_id(name)
    except Exception as e:
        print(f"  WARN: 创建集合 {name} 失败：{e}", file=sys.stderr)
    return None


def chroma_upsert_shadow(collection: str, doc_id: str, document: str,
                          metadata: dict, embedding: list | None = None) -> bool:
    """向 ChromaDB 集合写入一条记录，支持可选嵌入向量。"""
    cid = ensure_shadow_collection(collection)
    if not cid:
        return False
    payload: dict = {
        "ids":       [doc_id],
        "documents": [document],
        "metadatas": [metadata],
    }
    if embedding:
        payload["embeddings"] = [embedding]
    try:
        r = requests.post(f"{CHROMA_BASE}/{cid}/upsert", json=payload, timeout=30)
        r.raise_for_status()
        return True
    except Exception as e:
        print(f"  WARN: chroma_upsert_shadow 失败：{e}", file=sys.stderr)
        return False


# ── LLM 调用 ──────────────────────────────────────────────────────────────────

COLLAB_PROMPT = """\
你是组织协作关系分析器。以下是「{member}」与 Lucas 的对话片段（共 {count} 条）。

分析对象：「{member}」在对话中**提到了其他家庭成员**，以及与他们的协作关系。
其他家庭成员（to_person 只能从这里选）：{other_members}
注意：「{member}」自己**不能**出现在 to_person 中。

只提取以下四种 relation，每种只在对话中有**明确线索**时才提取：
- co_discusses：「{member}」与某人共同关注/讨论同一议题
  context 格式：「topic: 议题简述（≤15字）」
- requests_from：「{member}」依赖某人的协作或帮助（需要对方做某事）
  context 格式：「need: 需求简述（≤20字）」
- supports：「{member}」在主动支持/帮助某人
  context 格式：「provides: 支持内容（≤20字）」
- role_in_context：「{member}」在某个协作场景中承担特定角色
  context 格式：「role: 角色描述, scene: 场景（各≤15字）」

提取规则：
1. 只提取对话中**明确出现**的协作信号，不推断
2. 关系必须涉及**具体协作行为或期待**，泛泛的家庭关系描述不算
3. 相同 (to_person, relation) 只输出最新/最代表性的一条
4. 如果没有提及其他成员的协作信号，直接返回空列表

输出严格 JSON（不要 markdown 代码块，不要额外注释）：
{{"edges":[{{"to_person":"称呼","relation":"关系类型","context":"内容"}}]}}
或空：{{"edges":[]}}

对话记录：
{conversations}
"""


def _call_llm_raw(prompt: str) -> str:
    if DEEPSEEK_KEY:
        r = requests.post(
            "https://api.deepseek.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {DEEPSEEK_KEY}", "Content-Type": "application/json"},
            json={"model": "deepseek-chat",
                  "messages": [{"role": "user", "content": prompt}],
                  "max_tokens": 1000, "temperature": 0.2},
            timeout=120,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()
    if ZAI_KEY:
        r = requests.post(
            "https://api.zaiasktheai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {ZAI_KEY}", "Content-Type": "application/json"},
            json={"model": "glm-4-flash",
                  "messages": [{"role": "user", "content": prompt}],
                  "max_tokens": 1000, "temperature": 0.2},
            timeout=120,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()
    raise RuntimeError("没有可用的 LLM API Key（DEEPSEEK_API_KEY 或 ZAI_API_KEY）")


EVOLUTION_PROMPT = """\
你是协作关系演进分析器。以下是「{member}」与 Lucas 的最近对话（{count} 条），
以及系统中已记录的「{member}」→「{target}」的 {relation} 协作边，context 为：「{context}」。

请判断这条协作关系的当前状态：
- resolved：话题/需求在对话中已明确完成、解决或达成结果，{member} 不再提及相关问题
- ongoing：话题仍在推进中，有新的进展或讨论，但尚未完成
- failed：话题反复出现且伴随失望/挫败信号（如「还没有」「又没做到」「说了多少次」等）
- unknown：对话中无足够信息判断

输出严格 JSON（不要 markdown 代码块）：
{{"status": "resolved|ongoing|failed|unknown", "reason": "一句话说明判断依据（≤30字）"}}

对话记录：
{conversations}
"""


def run_evolution_pass(conn, kuzu_id: str, chroma_id: str,
                        conversations: list[str]) -> int:
    """
    Phase 3 演进环：
    1. 查询该用户当前活跃协作边
    2. 对每条边：LLM 推断结果状态（resolved/ongoing/failed/unknown）
    3. 更新 Kuzu confidence（resolved +0.1，failed -0.15，上下限 0.1~1.0）
    4. 写入 ChromaDB shadow_interactions 集合
    返回处理的边数。
    """
    if not conversations or conn is None:
        return 0

    today_str = datetime.date.today().isoformat()
    member_label = MEMBER_NAMES.get(kuzu_id, kuzu_id)

    # 查询活跃协作边
    try:
        res = conn.execute(
            "MATCH (a:Entity {id: $uid})-[f:Fact]->(b:Entity) "
            "WHERE f.source_type = 'collab_distill' AND f.valid_until >= $today "
            "RETURN f.relation, b.id, b.name, f.context, f.confidence "
            "ORDER BY f.relation",
            {"uid": kuzu_id, "today": today_str},
        )
    except Exception as e:
        print(f"  WARN: 查询活跃协作边失败：{e}", file=sys.stderr)
        return 0

    edges = []
    while res.has_next():
        row = res.get_next()
        edges.append({
            "relation":   row[0],
            "to_id":      row[1],
            "to_name":    row[2],
            "context":    row[3],
            "confidence": row[4] if row[4] is not None else 0.75,
        })

    if not edges:
        return 0

    print(f"  [演进环] 评估 {len(edges)} 条活跃协作边…")
    recent_text = "\n---\n".join(
        c[:MAX_CONV_CHARS] + ("…" if len(c) > MAX_CONV_CHARS else "")
        for c in conversations[-30:]
    )
    processed = 0

    for edge in edges:
        relation   = edge["relation"]
        to_id      = edge["to_id"]
        to_name    = edge["to_name"]
        context    = edge["context"]
        confidence = float(edge["confidence"])

        prompt = EVOLUTION_PROMPT.format(
            member=member_label,
            count=min(len(conversations), 30),
            target=to_name,
            relation=relation,
            context=context,
            conversations=recent_text,
        )
        try:
            raw     = _call_llm_raw(prompt)
            cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.MULTILINE)
            m       = re.search(r"\{.*\}", cleaned, re.DOTALL)
            parsed  = json.loads(m.group()) if m else {}
            status  = parsed.get("status", "unknown").strip()
            reason  = parsed.get("reason", "").strip()[:60]
        except Exception as e:
            print(f"    WARN: LLM 演进推断失败 {kuzu_id}→{to_id}({relation}): {e}", file=sys.stderr)
            continue

        if status not in {"resolved", "ongoing", "failed", "unknown"}:
            status = "unknown"

        # 更新 Kuzu confidence
        delta = {"resolved": 0.1, "ongoing": 0.0, "failed": -0.15, "unknown": 0.0}.get(status, 0.0)
        if delta != 0.0:
            new_conf = max(0.1, min(1.0, confidence + delta))
            try:
                conn.execute(
                    "MATCH (a:Entity {id: $aid})-[f:Fact]->(b:Entity {id: $bid}) "
                    "WHERE f.relation = $rel AND f.source_type = 'collab_distill' "
                    "AND f.valid_until >= $today "
                    "SET f.confidence = $conf",
                    {"aid": kuzu_id, "bid": to_id, "rel": relation,
                     "today": today_str, "conf": new_conf},
                )
                print(f"    [evolve] {kuzu_id}→{to_id}({relation}) "
                      f"{status} conf {confidence:.2f}→{new_conf:.2f}")
            except Exception as e:
                print(f"    WARN: Kuzu confidence 更新失败：{e}", file=sys.stderr)

        # 写入 ChromaDB shadow_interactions
        now_ts  = datetime.datetime.now().isoformat()
        doc_id  = f"shadow-evo-{kuzu_id}-{to_id}-{relation}-{today_str}"
        document = (f"协作演进 {member_label}→{to_name} [{relation}] "
                    f"状态={status} {reason}")
        metadata = {
            "from_id":   kuzu_id,
            "to_id":     to_id,
            "relation":  relation,
            "status":    status,
            "reason":    reason,
            "confidence_before": confidence,
            "confidence_after":  max(0.1, min(1.0, confidence + delta)),
            "evaluated_at": now_ts,
            "source":    "collab_evolution",
        }
        embedding = embed_text(document)
        chroma_upsert_shadow("shadow_interactions", doc_id, document, metadata,
                              embedding if embedding else None)
        processed += 1

    return processed


def extract_collab_edges(member_label: str, conversations: list[str]) -> list[dict]:
    """
    调用 LLM 提取协作边，返回 [{to_id, relation, context}, ...]。
    to_person（称呼）→ to_id（Kuzu userId）解析在此处完成。
    """
    recent    = conversations[-MAX_RECORDS:]
    truncated = [c[:MAX_CONV_CHARS] + ("…" if len(c) > MAX_CONV_CHARS else "") for c in recent]
    conv_text = "\n---\n".join(truncated)
    # 排除 FROM 用户自身，避免 LLM 把 to_person 填成 FROM 用户
    other_members = "、".join(v for k, v in MEMBER_NAMES.items() if v != member_label)

    prompt = COLLAB_PROMPT.format(
        member=member_label,
        count=len(recent),
        other_members=other_members,
        conversations=conv_text,
    )
    try:
        raw     = _call_llm_raw(prompt)
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.MULTILINE)
        m       = re.search(r"\{.*\}", cleaned, re.DOTALL)
        parsed  = json.loads(m.group()) if m else {}
        raw_edges = parsed.get("edges", [])
    except Exception as e:
        print(f"  WARN: LLM 提取失败：{e}", file=sys.stderr)
        return []

    result = []
    for edge in raw_edges:
        to_person = edge.get("to_person", "").strip()
        relation  = edge.get("relation", "").strip()
        context   = edge.get("context", "").strip()
        if not to_person or not relation:
            continue
        if relation not in {"co_discusses", "requests_from", "supports", "role_in_context"}:
            print(f"  WARN: 非法 relation「{relation}」，跳过", file=sys.stderr)
            continue
        # 称呼 → userId
        to_id = None
        for key, pid in PERSON_NAME_TO_ID.items():
            if key in to_person:
                to_id = pid
                break
        if not to_id:
            print(f"  WARN: 未知成员称呼「{to_person}」，跳过", file=sys.stderr)
            continue
        result.append({"to_id": to_id, "relation": relation, "context": context})

    return result


# ── 冷却期元数据 ───────────────────────────────────────────────────────────────

def _meta_path(user_id: str) -> Path:
    return META_DIR / f"{user_id}.collab-meta.json"


def load_last_collab_meta(user_id: str) -> dict:
    p = _meta_path(user_id)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except Exception:
            pass
    return {"distilled_at": None}


def save_collab_meta(user_id: str):
    _meta_path(user_id).write_text(json.dumps({
        "distilled_at": datetime.datetime.now().isoformat(),
    }, ensure_ascii=False, indent=2))


# ── 单用户蒸馏 ────────────────────────────────────────────────────────────────

def distill_user(kuzu_id: str, chroma_id: str, conn, force: bool = False) -> bool:
    member_label = MEMBER_NAMES.get(kuzu_id, kuzu_id)
    print(f"\n{'='*50}")
    print(f"协作蒸馏：{member_label}（{kuzu_id}）")

    # 冷却期检查
    if not force:
        meta = load_last_collab_meta(kuzu_id)
        if meta.get("distilled_at"):
            try:
                last     = datetime.datetime.fromisoformat(meta["distilled_at"])
                days_ago = (datetime.datetime.now() - last).days
                if days_ago < COOLDOWN_DAYS:
                    print(f"  冷却中（上次 {days_ago} 天前，冷却期 {COOLDOWN_DAYS} 天），跳过")
                    return False
            except Exception:
                pass

    # 拉取对话
    records = chroma_get_recent(chroma_id)
    if len(records) < MIN_RECORDS:
        print(f"  对话不足（{len(records)} < {MIN_RECORDS}），跳过")
        return False
    print(f"  取到 {len(records)} 条对话")

    conversations = [r["document"] for r in records if r.get("document")]

    # LLM 提取协作边
    edges = extract_collab_edges(member_label, conversations)
    print(f"  LLM 提取协作边：{len(edges)} 条")

    if edges:
        written = write_collab_facts(conn, kuzu_id, edges)
        print(f"  Kuzu 写入：{written} 条")

    # Phase 3 演进环：评估已有协作边的有效性，更新 confidence，写 shadow_interactions
    evolved = run_evolution_pass(conn, kuzu_id, chroma_id, conversations)
    if evolved > 0:
        print(f"  演进环：评估 {evolved} 条边，结果已写入 shadow_interactions")

    save_collab_meta(kuzu_id)
    return True


# ── 主入口 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="协作关系蒸馏")
    parser.add_argument("--user",  help="只蒸馏指定 userId（Kuzu 格式，如 ZengXiaoLong）")
    parser.add_argument("--force", action="store_true", help="忽略冷却期强制重跑")
    args = parser.parse_args()

    if args.user:
        # 单人模式：找到对应 chroma_id
        chroma_id = None
        for cid, kid in CHROMA_TO_KUZU_ID.items():
            if kid == args.user:
                chroma_id = cid
                break
        if chroma_id is None:
            print(f"ERROR: 未找到 {args.user} 对应的 ChromaDB userId", file=sys.stderr)
            sys.exit(1)
        users = [(args.user, chroma_id)]
    else:
        users = [(kid, cid) for cid, kid in CHROMA_TO_KUZU_ID.items()]

    conn    = get_kuzu_conn()
    updated = 0
    for kuzu_id, chroma_id in users:
        if distill_user(kuzu_id, chroma_id, conn, force=args.force):
            updated += 1

    print(f"\n{'='*50}")
    print(f"协作蒸馏完成：{updated}/{len(users)} 个用户已处理")

    # 触发 render-knowledge.py 刷新 inject.md
    if updated > 0 and RENDER_SCRIPT.exists():
        print("\n触发 render-knowledge.py 刷新档案…")
        try:
            subprocess.run([PYTHON3, str(RENDER_SCRIPT)], check=True, timeout=120)
            print("  inject.md 已刷新")
        except Exception as e:
            print(f"  WARN: render-knowledge.py 执行失败：{e}", file=sys.stderr)

    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


if __name__ == "__main__":
    main()
