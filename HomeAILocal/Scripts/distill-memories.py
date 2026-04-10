#!/usr/bin/env python3
"""
记忆蒸馏脚本：ChromaDB conversations → Kuzu 结构化三元组 + 人可读档案

流程：
  ChromaDB conversations → LLM 提炼 → Kuzu Entity/Fact（结构化知识图）
                                     → data/member-profiles/{userId}.md（人可读）
  蒸馏结束 → 触发 render-knowledge.py → 刷新 .inject.md

用法：
  python3 scripts/distill-memories.py              # 全量蒸馏
  python3 scripts/distill-memories.py --user ZengXiaoLong  # 单人
  python3 scripts/distill-memories.py --force      # 忽略增量门槛强制重跑
"""

import os, sys, json, argparse, datetime, hashlib, requests, re
from pathlib import Path


def _slugify(text: str) -> str:
    """规范化文本为稳定 slug，用于 topic 节点共享 id（相同含义聚合为同一节点）。"""
    s = text.lower().strip()
    s = re.sub(r'\s+', '_', s)
    s = re.sub(r'[^\w\u4e00-\u9fff]', '', s)
    return s[:40]

# ── 配置 ─────────────────────────────────────────────────────────────────────
_SCRIPTS_DIR  = Path(__file__).resolve().parent     # .../HomeAILocal/Scripts
HOMEAI_ROOT   = _SCRIPTS_DIR.parent.parent.parent  # ~/HomeAI
_DATA_ROOT    = Path(os.environ.get("HOMEAI_DATA_ROOT", str(HOMEAI_ROOT / "Data")))
CHROMA_URL    = os.environ.get("CHROMA_URL", "http://localhost:8001")
CHROMA_BASE   = f"{CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections"
OLLAMA_URL    = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEEPSEEK_KEY  = os.environ.get("DEEPSEEK_API_KEY", "")
ZAI_KEY       = os.environ.get("ZAI_API_KEY", "")
KUZU_DB_PATH  = _DATA_ROOT / "kuzu"

PROFILES_DIR  = _DATA_ROOT / "member-profiles"
PROFILES_DIR.mkdir(parents=True, exist_ok=True)

MEMORY_MD_PATH         = Path.home() / ".openclaw" / "workspace-lucas" / "MEMORY.md"
HALLUCINATION_DPO_FILE = HOMEAI_ROOT / "data" / "learning" / "hallucination-filtered.jsonl"

MIN_RECORDS   = 10   # 至少 N 条对话才蒸馏
DELTA_TRIGGER = 20   # 自上次蒸馏后新增 N 条才重跑（--force 可跳过）
MAX_RECORDS   = 60   # 每次最多取最近 N 条送给 LLM（防 token 爆炸）
MAX_CONV_CHARS = 300 # 每条对话最多保留字符数

MEMBER_NAMES = {
    "ZengXiaoLong":       "爸爸曾小龙（系统工程师）",
    "zengxiaolong":       "爸爸曾小龙（系统工程师）",
    "XiaMoQiuFengLiang":  "妈妈张璐",
    "xiamogqiufengliang": "妈妈张璐",
    "ZiFeiYu":            "小姨肖山",
    "zifeiyu":            "小姨肖山",
}

# ChromaDB userId（小写）→ Kuzu Entity ID（大驼峰，与 init-family-relations.py 保持一致）
CHROMA_TO_KUZU_ID = {
    "zengxiaolong":       "ZengXiaoLong",
    "xiamogqiufengliang": "XiaMoQiuFengLiang",
    "zifeiyu":            "ZiFeiYu",
    "zengyueyutong":      "ZengYueYuTong",
}

# 家庭成员名称 → userId 映射（用于 relationship_with person→person 边解析）
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
    "曾璿岐霖": "lucas",
    "启灵":     "lucas",
}

# 家庭成员列表（注入 LLM prompt，帮助提取关系事实）
FAMILY_MEMBERS_DESC = "爸爸曾小龙、妈妈张璐、小姨肖山、姐姐黟黟（曾玥语桐）、Lucas曾璿岐霖（小名启灵）"

# ── 幻觉污染过滤 ──────────────────────────────────────────────────────────────

def load_hallucination_patterns() -> list[str]:
    """
    从 Lucas MEMORY.md 的【幻觉污染识别】节提取已知幻觉类型描述，
    注入蒸馏 prompt，防止 LLM 将幻觉行为提炼为正确规律。
    """
    if not MEMORY_MD_PATH.exists():
        return []
    text = MEMORY_MD_PATH.read_text(encoding="utf-8")
    m = re.search(r'【幻觉污染识别】(.*?)(?=^###|\Z)', text, re.DOTALL | re.MULTILINE)
    if not m:
        return []
    section = m.group(1)
    patterns = []
    for line in section.splitlines():
        line = line.strip()
        if not line.startswith("- "):
            continue
        tag = re.search(r'【幻觉：([^】]+)】', line)
        if not tag:
            continue
        tag_text = tag.group(1)
        # 去掉 bullet、日期、【幻觉标签】，保留核心描述
        desc = re.sub(r'（\d{4}-\d{2}-\d{2}）', '', line[2:])
        desc = re.sub(r'【[^】]+】', '', desc).strip()
        desc = desc[:80]
        patterns.append(f"【{tag_text}】{desc}")
    return patterns


def collect_dpo_flagged_records(records: list[dict]) -> tuple[list[dict], list[dict]]:
    """
    分离 dpoFlagged=true 的记录：
    - clean_records   → 正常送 LLM 蒸馏
    - flagged_records → 写入 hallucination-filtered.jsonl 作为 DPO 原料
    返回 (clean_records, flagged_records)
    """
    clean, flagged = [], []
    for r in records:
        if str(r["metadata"].get("dpoFlagged", "false")).lower() == "true":
            flagged.append(r)
        else:
            clean.append(r)

    if flagged:
        HALLUCINATION_DPO_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(HALLUCINATION_DPO_FILE, "a", encoding="utf-8") as f:
            for r in flagged:
                f.write(json.dumps({
                    "t":            datetime.datetime.now().isoformat(),
                    "source":       "distill-filter",
                    "type":         "hallucination_flagged",
                    "document":     r["document"][:500],
                    "metadata":     r["metadata"],
                    "bad_response": "",   # 系统工程师人工填写后进训练集
                    "good_response": "",
                    "confirmed":    False,
                }, ensure_ascii=False) + "\n")
        print(f"  [幻觉过滤] {len(flagged)} 条 dpoFlagged 记录写入 hallucination-filtered.jsonl")

    return clean, flagged


# ── ChromaDB 工具 ─────────────────────────────────────────────────────────────

def get_collection_id(name: str) -> str | None:
    r = requests.get(f"{CHROMA_BASE}/{name}", timeout=10)
    if r.status_code == 200:
        return r.json().get("id")
    return None

def ensure_collection(name: str) -> str:
    r = requests.post(CHROMA_BASE, json={"name": name, "metadata": {"hnsw:space": "cosine"}}, timeout=10)
    if r.status_code in (200, 409):
        cid = get_collection_id(name)
        if cid:
            return cid
    raise RuntimeError(f"无法创建/获取集合 {name}: {r.status_code}")

def chroma_get_all(collection: str, where: dict = None, limit: int = 5000) -> list[dict]:
    """分页拉取 ChromaDB 集合，默认 limit=5000，支持超大集合。"""
    cid = get_collection_id(collection)
    if not cid:
        return []
    all_items: list[dict] = []
    offset = 0
    page_size = 500          # 每页 500，避免单次请求过大
    while len(all_items) < limit:
        payload = {"limit": page_size, "offset": offset, "include": ["documents", "metadatas"]}
        if where:
            payload["where"] = where
        r = requests.post(f"{CHROMA_BASE}/{cid}/get", json=payload, timeout=30)
        if r.status_code != 200:
            break
        data  = r.json()
        ids   = data.get("ids", [])
        docs  = data.get("documents", [])
        metas = data.get("metadatas", [])
        if not ids:
            break
        all_items.extend({"id": ids[i], "document": docs[i], "metadata": metas[i]} for i in range(len(ids)))
        offset += len(ids)
        if len(ids) < page_size:          # 最后一页
            break
    return all_items

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
    r.raise_for_status()


def _sync_topic_to_chroma(chroma_user_id: str, topic_id: str, topic_name: str,
                           relation: str, context: str, kuzu_conn=None):
    """同步 topic Fact 到 ChromaDB topics 集合，供 Topic-first 语义检索。
    ID = {chroma_user_id}::{topic_id}（每人每 topic 一条，upsert 覆盖同 relation 的旧数据）。
    P3：如果 kuzu_conn 可用，检查其他家人是否也关注此话题，在 document 中标注。
    """
    doc_id = f"{chroma_user_id}::{topic_id}"

    # P3：多人话题标注
    family_note = ""
    if kuzu_conn is not None:
        try:
            kuzu_user_id = CHROMA_TO_KUZU_ID.get(chroma_user_id, chroma_user_id)
            res = kuzu_conn.execute(
                """MATCH (p:Entity)-[f:Fact]->(t:Entity {id: $tid})
                WHERE p.id <> $uid AND f.valid_until IS NULL
                RETURN p.name LIMIT 3""",
                {"tid": topic_id, "uid": kuzu_user_id},
            )
            others = []
            while res.has_next():
                row = res.get_next()
                if row[0]:
                    others.append(row[0])
            if others:
                family_note = f"（{', '.join(others)}也关注）"
        except Exception:
            pass

    document = f"{topic_name}：{context}{family_note}" if context else f"{topic_name}{family_note}"
    try:
        embedding = embed_text(document[:200])
        chroma_upsert("topics", doc_id, document, {
            "topicId":   topic_id,
            "topicName": topic_name,
            "userId":    chroma_user_id,
            "relation":  relation,
            "context":   context[:200] if context else "",
            "updatedAt": datetime.date.today().isoformat(),
        }, embedding)
    except Exception as e:
        print(f"  WARN: ChromaDB topics 同步失败 ({topic_id}): {e}", file=sys.stderr)

# ── 语义去重（P2）────────────────────────────────────────────────────────────

def find_canonical_topic(candidate_name: str, chroma_user_id: str,
                          threshold: float = 0.92) -> tuple[str | None, str | None]:
    """
    在 ChromaDB topics 集合中查找语义相似的已有 topic（同一用户范围）。
    相似度 > threshold 时复用已有 topic_id/name，防止 LLM 命名漂移导致碎片化。
    例：「运营抖音」→ 找到「一起运营抖音」（similarity=0.94）→ 复用后者 ID/名称。
    返回 (canonical_topic_id, canonical_topic_name) 或 (None, None)。
    """
    try:
        cid = get_collection_id("topics")
        if not cid:
            return None, None
        embedding = embed_text(candidate_name[:100])
        r = requests.post(f"{CHROMA_BASE}/{cid}/query", json={
            "query_embeddings": [embedding],
            "n_results": 3,
            "include": ["metadatas", "distances"],
            "where": {"userId": {"$eq": chroma_user_id}},
        }, timeout=15)
        if r.status_code != 200:
            return None, None
        data = r.json()
        distances = data.get("distances", [[]])[0]
        metadatas = data.get("metadatas", [[]])[0]
        if not distances:
            return None, None
        # ChromaDB hnsw:space=cosine: distance in [0,2], 0=identical, 2=opposite
        # similarity ≈ 1 - distance/2
        best_dist = distances[0]
        best_meta = metadatas[0]
        similarity = 1.0 - best_dist / 2.0
        if similarity >= threshold:
            return best_meta.get("topicId"), best_meta.get("topicName")
    except Exception as e:
        print(f"  WARN: find_canonical_topic 查询失败：{e}", file=sys.stderr)
    return None, None


# ── Kuzu 工具 ─────────────────────────────────────────────────────────────────

def get_kuzu_conn():
    try:
        import kuzu
        db = kuzu.Connection.__self__.__class__ if False else None  # noqa
        import kuzu as _kuzu
        db = _kuzu.Database(str(KUZU_DB_PATH))
        return _kuzu.Connection(db)
    except ImportError:
        print("  WARN: kuzu 未安装，跳过 Kuzu 写入", file=sys.stderr)
        return None


def write_kuzu_facts(conn, user_id: str, facts: list[dict],
                     privacy_level: str = "private", chroma_user_id: str = "",
                     skip_expire: bool = False) -> int:
    """
    将蒸馏三元组写入 Kuzu。
    策略：Upsert 语义——对每条 Fact 查 (user, topic, relation) 是否已有活跃记录：
      - 有 → SET context/valid_from 更新（增量保留历史积累）
      - 无 → CREATE 新 Fact
    写完后将本轮未触碰的旧 distill Fact expire（自然淘汰已消失的事实）。
    pending_event / relationship_with 单独处理，逻辑不变。

    skip_expire: True 时跳过本轮未触碰 Fact 的 expire 步骤（全量历史分批模式）
    privacy_level: 'public'（来自群聊）| 'private'（来自私聊，默认保守值）
    返回写入/更新的 Fact 数量。
    """
    if conn is None:
        return 0

    now_iso = datetime.datetime.now().isoformat()
    sid     = f"distill-{datetime.date.today().isoformat()}"

    # 本轮触碰过的 (topic_id, relation) 集合，用于最后 expire 未触碰的旧 Fact
    touched: set[tuple[str, str]] = set()

    written = 0
    for fact in facts:
        relation = fact.get("relation", "").strip()
        value    = fact.get("value", "").strip()
        context  = fact.get("context", "").strip()
        if not relation or not value:
            continue

        # ── relationship_with：person→person 边 ─────────────────────────────
        if relation == "relationship_with":
            written += _write_relationship_fact(
                conn, user_id, value, context, now_iso, privacy_level
            )
            continue

        # ── has_pending_event：带 valid_until 的时间节点事实 ────────────────
        if relation == "has_pending_event":
            written += _write_pending_event(
                conn, user_id, value, context, now_iso, sid, privacy_level
            )
            continue

        # ── 普通 person→topic 边（共享 topic 节点）─────────────────────────
        ctx = context if context else (value[120:200] if len(value) > 120 else "")

        # P2: 语义去重 - 检查是否已有语义相近的 topic，复用现有 ID/名称防止命名漂移碎片化
        canonical_id, canonical_name = None, None
        if chroma_user_id:
            canonical_id, canonical_name = find_canonical_topic(value, chroma_user_id)
            default_id = f"topic_{_slugify(value)}"
            if canonical_id and canonical_id != default_id:
                print(f"  [P2] 语义去重：'{value}' → 复用 '{canonical_name}' ({canonical_id})")
        topic_id   = canonical_id or f"topic_{_slugify(value)}"
        topic_name = canonical_name or value[:120]

        try:
            # 确保 topic 节点存在
            conn.execute(
                "MERGE (e:Entity {id: $id}) SET e.type = 'topic', e.name = $name",
                {"id": topic_id, "name": topic_name},
            )

            # ── Upsert：查是否已有活跃 Fact ────────────────────────────────
            existing = conn.execute(
                "MATCH (p:Entity {id: $pid})-[f:Fact]->(o:Entity {id: $oid}) "
                "WHERE f.relation = $rel AND f.source_type = 'distill' "
                "AND f.valid_until IS NULL "
                "RETURN f",
                {"pid": user_id, "oid": topic_id, "rel": relation},
            )
            if existing.has_next():
                # UPDATE：追加/覆盖 context，刷新 valid_from
                conn.execute(
                    "MATCH (p:Entity {id: $pid})-[f:Fact]->(o:Entity {id: $oid}) "
                    "WHERE f.relation = $rel AND f.source_type = 'distill' "
                    "AND f.valid_until IS NULL "
                    "SET f.context = $ctx, f.valid_from = $from, f.source_id = $sid",
                    {"pid": user_id, "oid": topic_id, "rel": relation,
                     "ctx": ctx, "from": now_iso, "sid": sid},
                )
                print(f"  [upsert-update] {relation} → {topic_id[:30]}")
            else:
                # CREATE：全新 Fact
                conn.execute(
                    "MATCH (p:Entity {id: $pid}), (o:Entity {id: $oid}) "
                    "CREATE (p)-[:Fact {relation: $rel, context: $ctx, "
                    "valid_from: $from, confidence: 0.85, "
                    "privacy_level: $pl, "
                    "source_type: 'distill', source_id: $sid}]->(o)",
                    {"pid": user_id, "oid": topic_id,
                     "rel": relation, "ctx": ctx, "from": now_iso,
                     "pl": privacy_level, "sid": sid},
                )
                print(f"  [upsert-create] {relation} → {topic_id[:30]}")

            touched.add((topic_id, relation))
            written += 1

            # P3: 同步到 ChromaDB topics
            if chroma_user_id:
                _sync_topic_to_chroma(chroma_user_id, topic_id, topic_name, relation, ctx, kuzu_conn=conn)
        except Exception as e:
            print(f"  WARN: Fact upsert 失败 ({relation}): {e}", file=sys.stderr)

    # ── 本轮未触碰的旧 distill Fact → expire（自然淘汰）──────────────────
    if not skip_expire and touched:
        try:
            # 先取出所有活跃 distill Fact 的 (topic_id, relation)
            old_r = conn.execute(
                "MATCH (p:Entity {id: $uid})-[f:Fact]->(o:Entity) "
                "WHERE f.source_type = 'distill' AND f.valid_until IS NULL "
                "AND f.relation <> 'has_pending_event' AND f.relation <> 'relationship_with' "
                "RETURN o.id, f.relation",
                {"uid": user_id},
            )
            to_expire: list[tuple[str, str]] = []
            while old_r.has_next():
                row = old_r.get_next()
                pair = (row[0], row[1])
                if pair not in touched:
                    to_expire.append(pair)

            for topic_id_exp, rel_exp in to_expire:
                conn.execute(
                    "MATCH (p:Entity {id: $uid})-[f:Fact]->(o:Entity {id: $oid}) "
                    "WHERE f.relation = $rel AND f.source_type = 'distill' "
                    "AND f.valid_until IS NULL "
                    "SET f.valid_until = $now",
                    {"uid": user_id, "oid": topic_id_exp, "rel": rel_exp, "now": now_iso},
                )
            if to_expire:
                print(f"  [expire] 淘汰本轮未提及的旧 Fact：{len(to_expire)} 条")
        except Exception as e:
            print(f"  WARN: 旧 Fact expire 失败：{e}", file=sys.stderr)

    return written


def _write_pending_event(conn, user_id: str, value: str, context: str,
                         now_iso: str, sid: str, privacy_level: str) -> int:
    """写入 pending_event 节点，valid_until 从 context 解析日期，解析失败默认 7 天后。"""
    # 解析日期：优先 YYYY-MM-DD 格式
    valid_until = None
    date_match = re.search(r'(\d{4}-\d{2}-\d{2})', context or "")
    if date_match:
        valid_until = date_match.group(1)
    else:
        valid_until = (datetime.date.today() + datetime.timedelta(days=7)).isoformat()

    event_id = f"pending_{user_id}_{_slugify(value)}"
    try:
        conn.execute(
            "MERGE (e:Entity {id: $id}) SET e.type = 'pending_event', e.name = $name",
            {"id": event_id, "name": value[:120]},
        )
        conn.execute(
            "MATCH (p:Entity {id: $pid}), (e:Entity {id: $eid}) "
            "CREATE (p)-[:Fact {relation: 'has_pending_event', context: $ctx, "
            "valid_from: $from, valid_until: $until, confidence: 0.8, "
            "privacy_level: $pl, "
            "source_type: 'distill', source_id: $sid}]->(e)",
            {
                "pid": user_id, "eid": event_id,
                "ctx": context or value, "from": now_iso,
                "until": valid_until, "pl": privacy_level, "sid": sid,
            },
        )
        print(f"  pending_event：{user_id} → {value[:30]}（until {valid_until}）")
        return 1
    except Exception as e:
        print(f"  WARN: pending_event 写入失败: {e}", file=sys.stderr)
        return 0


def _write_relationship_fact(conn, user_id: str, value: str, context: str,
                             now_iso: str, privacy_level: str = "private") -> int:
    """
    解析 relationship_with 事实，写 person→person Fact 边。
    value 格式：「称呼：关系描述」，如 "妈妈：感情稳定，偶有教育分歧"
    返回写入数量（0 或 1）。
    """
    # 解析 "称呼：描述" 格式
    if "：" in value:
        name_part, desc_part = value.split("：", 1)
    elif ":" in value:
        name_part, desc_part = value.split(":", 1)
    else:
        name_part, desc_part = value, ""

    name_part = name_part.strip()
    desc_part = desc_part.strip()

    # 在 PERSON_NAME_TO_ID 中查找目标成员
    target_id = None
    for key, pid in PERSON_NAME_TO_ID.items():
        if key in name_part:
            target_id = pid
            break

    if not target_id:
        # 未知名字 → 创建周边人节点（type='person'），id 用 slugify 稳定化
        # 这使周边人能参与话题共鸣查询，而非被静默丢弃
        target_id = f"person_{_slugify(name_part)}"
        try:
            conn.execute(
                "MERGE (e:Entity {id: $id}) SET e.type = 'person', e.name = $name",
                {"id": target_id, "name": name_part[:60]},
            )
        except Exception as e:
            print(f"  WARN: 周边人节点创建失败「{name_part}」: {e}", file=sys.stderr)
            return 0
        print(f"  周边人节点：{target_id}（{name_part}）")

    if target_id == user_id:
        print(f"  WARN: relationship_with 目标与来源相同（{user_id}），跳过", file=sys.stderr)
        return 0

    # 关系描述：desc_part 为主，context 为补充
    rel_context = desc_part if desc_part else value
    if context:
        rel_context = f"{rel_context}；{context}" if rel_context else context
    rel_context = rel_context[:200]

    sid = f"distill-{datetime.date.today().isoformat()}"
    try:
        existing = conn.execute(
            "MATCH (a:Entity {id: $aid})-[f:Fact]->(b:Entity {id: $bid}) "
            "WHERE f.relation = 'relationship_with' AND f.source_type = 'distill' "
            "AND f.valid_until IS NULL RETURN f",
            {"aid": user_id, "bid": target_id},
        )
        if existing.has_next():
            conn.execute(
                "MATCH (a:Entity {id: $aid})-[f:Fact]->(b:Entity {id: $bid}) "
                "WHERE f.relation = 'relationship_with' AND f.source_type = 'distill' "
                "AND f.valid_until IS NULL "
                "SET f.context = $ctx, f.valid_from = $now, f.source_id = $sid",
                {"aid": user_id, "bid": target_id, "ctx": rel_context,
                 "now": now_iso, "sid": sid},
            )
            print(f"  [upsert-update] relationship_with → {target_id}（{rel_context[:40]}…）")
        else:
            conn.execute(
                "MATCH (a:Entity {id: $aid}), (b:Entity {id: $bid}) "
                "CREATE (a)-[:Fact {relation: 'relationship_with', context: $ctx, "
                "valid_from: $now, confidence: 0.75, "
                "privacy_level: $pl, "
                "source_type: 'distill', source_id: $sid}]->(b)",
                {"aid": user_id, "bid": target_id, "ctx": rel_context,
                 "now": now_iso, "pl": privacy_level, "sid": sid},
            )
            print(f"  [upsert-create] relationship_with → {target_id}（{rel_context[:40]}…）")
        return 1
    except Exception as e:
        print(f"  WARN: relationship_with 边写入失败 {user_id}->{target_id}: {e}", file=sys.stderr)
        return 0


# ── 现有 Fact 读取（增量更新基础）────────────────────────────────────────────

def load_existing_facts(conn, user_id: str) -> list[dict]:
    """读取 Kuzu 中该用户当前所有活跃 Fact，供蒸馏 prompt 注入，实现增量更新。
    只取 valid_until IS NULL 的条目（活跃），跳过 pending_event（有独立过期逻辑）。
    """
    if conn is None:
        return []
    try:
        res = conn.execute(
            """MATCH (p:Entity {id: $uid})-[f:Fact]->(t:Entity)
            WHERE f.valid_until IS NULL AND f.relation <> 'has_pending_event'
            RETURN f.relation, t.name, f.context""",
            {"uid": user_id},
        )
        facts = []
        while res.has_next():
            row = res.get_next()
            facts.append({
                "relation": row[0] or "",
                "value":    row[1] or "",
                "context":  row[2] or "",
            })
        return facts
    except Exception as e:
        print(f"  WARN: 读取现有 Fact 失败：{e}", file=sys.stderr)
        return []


# ── LLM 调用 ──────────────────────────────────────────────────────────────────

# 允许的 relation 类型（与 render-knowledge.py RELATION_LABELS 保持同步）
ALLOWED_RELATIONS = {
    "communication_style",   # 说话方式 / 风格
    "cares_most_about",      # 最在意的事
    "current_status",        # 当前状态 / 近期在做什么
    "recent_concern",        # 近期新出现的关注点
    "key_event",             # 重要事件（考试、工作变动、决定等）
    "role_in_family",        # 家庭角色
    "relationship_tip",      # 与 Lucas 相处要点
    "works_at",              # 工作/学习所在
    "relationship_with",     # 与某位家人的动态关系（person→person 边）
                             # value 格式：「家人称呼：关系描述」，如「妈妈：感情稳定，偶有教育分歧」
    "interaction_style",     # 与 Lucas 的互动方式（动态从对话中提炼，非静态描述）
                             # 涵盖：主动/被动偏好、希望 Lucas 什么时候主动找 TA、
                             # 信息密度偏好（简练/详细）、工具接受度、有效陪伴模式等
    "interaction_preference", # 与 Lucas 的任务协作节奏偏好（手工初始化，蒸馏只在有明确指令时更新）
                              # 侧重：对开发需求是否需要中途确认、是否需要进度播报、何时先对齐再动
    "has_pending_event",     # 家人提到的「即将发生的事」（考试、等结果、决定、会议等）
                             # value = 事件简短描述；context = 预期日期（YYYY-MM-DD）或描述性时间
                             # 写入 Kuzu 时设 valid_until = 预期日期（可被时间查询精确过滤）
    "shared_activity",       # 与 Lucas 一起做过的事（共同策划/制作/运营/参与的项目或活动）
                             # value = 活动名称（简短，如「一起运营抖音·启灵成长故事」）
                             # context = 背景说明（时间、各自分工、意义）
    "causal_relation",       # 因果关系：此人某行为/关注点背后的驱动原因，或某事件的导火索
                             # value = 效果端简述（≤20字，如「探索抖音副业」「关注AI记忆技术」）
                             # context = 原因说明（「因为X，所以/导致Y」格式，≤60字）
                             # 只在对话中有明确因果线索（因为/所以/因此/导致/由于/促使）时提取，不推断
}

DISTILL_PROMPT_JSON = """\
你是 Lucas 的记忆蒸馏器。以下是 Lucas 与「{member}」的对话片段（共 {count} 条，按时间排序）。

家庭成员列表（供提取关系时参考）：{family_members}

【现有知识基础（上次蒸馏结果，必须继承）】
{existing_facts_text}

请从对话中提炼结构化知识事实，规则如下：
1. 已有条目有新信息 → 更新 context（在原有内容基础上追加，不要丢失原来的内容）
2. 已有条目在新对话中无新内容 → **原样保留在输出中**（value 和 context 不变）
3. 对话引入了全新话题/关系 → 作为新条目添加
4. **只提取真实出现的信息，不推断、不编造**

输出 JSON 格式（严格遵守，不要添加额外字段）：
{{
  "facts": [
    {{"relation": "relation_type", "value": "具体内容（简短，30字以内）", "context": "补充说明（可留空）"}},
    ...
  ],
  "summary": "一段人可读的档案摘要（100-200字，自由格式）"
}}

relation_type 只能是以下之一：
{relations}

特别说明：
- relationship_with：提取此人与其他家庭成员的关系动态。value 格式必须为「称呼：关系描述」，
  例如 "妈妈：感情稳定，偶尔在教育问题上意见不同" 或 "小姨：关系亲密，互相支持"。
  只在对话中有明确线索时才提取，不推断。每位家人单独一条。
- interaction_preference：提取此人对 Lucas **任务执行时的协作节奏偏好**（不是日常互动风格，日常在 interaction_style）。
  侧重：① 对开发需求是否需要中途确认 vs. 直接执行上报结果；② 是否需要关键步骤进度播报；③ 什么情况下TA希望先对齐再动。
  **极高门槛**：只在对话中出现了 TA 的**明确指示**（如「你直接做」「先告诉我你打算怎么做」）或对执行节奏的**明确评价/反馈**时才提取。日常默认行为、一次性情况、模糊偏好不算。
  value = 协作模式简述（≤20字，如「高自主·直接执行」）；context = 具体信号及适用场景（≤80字）。
- interaction_style：提取此人与 Lucas 互动的**行为规律**，不是性格描述（性格在 communication_style）。
  侧重：① TA 希望 Lucas 什么时候主动找 TA vs. 等 TA 来（主动/被动偏好）；
        ② TA 对工具链接的接受度（愿意点开 / 需要语音说明 / 倾向直接聊）；
        ③ TA 偏好的信息密度（三句话内 / 需要详细说明）；
        ④ 哪类 Lucas 的行为让 TA 感觉被理解（有效陪伴模式）；
        ⑤ 哪类 Lucas 的行为让 TA 反应冷淡或抵触（无效模式）。
  只提取对话中真实出现的线索，不推断。可多条，每条一个维度。
- has_pending_event：提取家人提到的「即将发生的具体事项」。
  标准：必须是**具体、有时间节点**的事（考试、等结果、开会、决定）；日常闲聊不算。
  value = 事件简短描述（≤20字）；context = 预期日期（优先 YYYY-MM-DD 格式）或「下周三」「这个月底」等。
  只在对话有明确时间节点时提取，不推断。每条一个事项。
- shared_activity：提取 Lucas 与此人**一起做过**的事，即双方共同参与、共同策划、共同执行的项目或活动。
  标准：必须是两人真正协作的事（一起写脚本、一起策划账号、一起研究某事），不是 Lucas 单独做的事，也不是只聊到的话题。
  value = 活动简短名称（≤20字，如「一起运营抖音」「共同策划旅行」）；
  context = 补充说明（时间、各自分工、结果或意义，≤60字）。
  **优先级：这是最重要的 Topic 类型之一**——与家人共同做过的事是关系的核心印记，必须捕捉。
  只提取对话中明确出现的协作行为，不推断。每件事单独一条。
- causal_relation：提取此人某行为/关注点背后的**明确驱动原因**，或某事件的导火索。
  标准：对话中必须出现因果线索词（因为/所以/因此/导致/由于/促使/让我/让他），且原因和结果都有明确表述；纯猜测或隐含推断不算。
  value = 效果端简述（≤20字，描述「发生了什么/关注什么」，如「探索抖音副业」）；
  context = 「因为X，所以/导致Y」格式（≤60字，X是原因，Y是效果）。
  只提取对话中有明确因果表述的内容，不推断。每条一个因果对。

**topic 命名一致性**：提取事实时，value 字段使用**简洁规范的中文短语**（如「黟黟学习」而非「黟黟的学业情况」），
相同概念在不同对话中应保持**完全一致的写法**，这样系统才能识别为同一话题。

⚠️ 已知幻觉类型（Lucas 的已确认错误行为，**不要**将这类行为提炼为正确的行为规律或 interaction_style）：
{hallucination_note}

对话记录：
{conversations}
"""

# ── 行为信号提取 Prompt（第二轮，专门提取家人给 Lucas 的行为指导）─────────────────
BEHAVIOR_SIGNAL_PROMPT = """\
你是 Lucas 的行为信号提取器。以下是 Lucas 与「{member}」的对话片段。

请识别「{member}」给 Lucas 的**行为反馈或指导**（正面强化 + 纠正建议）。

提取标准（必须同时满足）：
1. 是家人在明确指导 Lucas 的**行为方式**——不是功能需求，不是普通聊天
2. 包含以下任意一类：
   - 正面肯定：「这次很合适」「做得好」「就应该这样」
   - 行为指导：「你应该…」「要注意…」「要掌握…」「不要…」「你需要…」
3. 主题是 Lucas 的**性格/行事方式/对家人的互动模式**（不是技术问题）

如果有，输出 JSON（严格格式）：
{{"signals": [
  {{
    "value": "行为原则简述（≤20字，如「主动性要有分寸」）",
    "context": "具体说明（≤80字，指导了什么、背景是什么）",
    "positive_example": "正向示例原文（如有，留空填 null）",
    "dimension": "主动性|情感陪伴|信息密度|承诺可靠性|边界感|其他"
  }}
]}}
如果没有行为反馈，输出：{{"signals": []}}

对话记录：
{conversations}
"""

BEHAVIOR_SIGNALS_FILE = HOMEAI_ROOT / "data" / "lucas-behavior-signals.jsonl"
BEHAVIOR_SIGNALS_FILE.parent.mkdir(parents=True, exist_ok=True)


def extract_behavior_signals(member_label: str, source_user: str, conversations: list[str]) -> int:
    """
    从对话中提取家人给 Lucas 的行为反馈信号，追加写入 lucas-behavior-signals.jsonl。
    返回写入条数。
    """
    if not conversations:
        return 0
    # 只取最近 30 条私聊（行为反馈更多在私聊里）
    sample = conversations[-30:]
    conv_text = "\n---\n".join(sample[-20:])
    prompt = BEHAVIOR_SIGNAL_PROMPT.format(member=member_label, conversations=conv_text)
    try:
        raw = _call_llm_raw(prompt)
        # 提取 JSON
        m = re.search(r'\{[\s\S]*\}', raw)
        if not m:
            return 0
        data = json.loads(m.group())
        signals = data.get("signals", [])
        if not signals:
            return 0
        now_iso = datetime.datetime.utcnow().isoformat() + "Z"
        today   = datetime.date.today().isoformat()
        written = 0
        with open(BEHAVIOR_SIGNALS_FILE, "a", encoding="utf-8") as fp:
            for sig in signals:
                if not sig.get("value"):
                    continue
                record = {
                    "id":           f"bsig_{source_user}_{int(datetime.datetime.utcnow().timestamp())}_{written}",
                    "date":         today,
                    "source_user":  source_user,
                    "source_name":  member_label,
                    "value":        sig.get("value", ""),
                    "context":      sig.get("context", ""),
                    "positive_example": sig.get("positive_example") or "",
                    "dimension":    sig.get("dimension", "其他"),
                    "distilled_at": now_iso,
                }
                fp.write(json.dumps(record, ensure_ascii=False) + "\n")
                written += 1
        return written
    except Exception as e:
        print(f"  [行为信号] 提取失败（静默）：{e}")
        return 0



def _call_llm_raw(prompt: str) -> str:
    """调用 LLM，返回原始文本。优先 DeepSeek，备选 ZAI/GLM。"""
    if DEEPSEEK_KEY:
        r = requests.post(
            "https://api.deepseek.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {DEEPSEEK_KEY}", "Content-Type": "application/json"},
            json={"model": "deepseek-chat", "messages": [{"role": "user", "content": prompt}],
                  "max_tokens": 1500, "temperature": 0.3},
            timeout=120,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()

    if ZAI_KEY:
        r = requests.post(
            "https://api.zaiasktheai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {ZAI_KEY}", "Content-Type": "application/json"},
            json={"model": "glm-4-flash", "messages": [{"role": "user", "content": prompt}],
                  "max_tokens": 1500, "temperature": 0.3},
            timeout=120,
        )
        r.raise_for_status()
        return r.json()["choices"][0]["message"]["content"].strip()

    raise RuntimeError("没有可用的 LLM API Key（DEEPSEEK_API_KEY 或 ZAI_API_KEY）")


def call_llm_distill(member_label: str, conversations: list[str],
                     hallucination_patterns: list[str] | None = None,
                     existing_facts: list[dict] | None = None) -> tuple[list[dict], str]:
    """
    调用 LLM 蒸馏对话 → 返回 (facts_list, summary_text)。
    facts_list: [{"relation": ..., "value": ..., "context": ...}, ...]
    summary_text: 人可读摘要（用于 markdown 文件）
    hallucination_patterns: 从 MEMORY.md 提取的已知幻觉类型，注入 prompt 防止被蒸馏为规律
    existing_facts: 当前 Kuzu 中已有的活跃 Fact，注入 prompt 实现增量更新
    """
    recent = conversations[-MAX_RECORDS:]
    truncated = [c[:MAX_CONV_CHARS] + ("…" if len(c) > MAX_CONV_CHARS else "") for c in recent]
    conv_text = "\n---\n".join(truncated)
    relations_list = "\n".join(f"  - {r}" for r in sorted(ALLOWED_RELATIONS))
    if hallucination_patterns:
        hallucination_note = "\n".join(f"  - {p}" for p in hallucination_patterns)
    else:
        hallucination_note = "  （暂无已知幻觉类型记录）"
    if existing_facts:
        existing_lines = "\n".join(
            f"  - [{f['relation']}] {f['value']}"
            + (f"（{f['context'][:80]}）" if f.get("context") else "")
            for f in existing_facts
        )
        existing_facts_text = f"共 {len(existing_facts)} 条：\n{existing_lines}"
    else:
        existing_facts_text = "（暂无，这是首次蒸馏）"
    prompt = DISTILL_PROMPT_JSON.format(
        member=member_label,
        count=len(recent),
        family_members=FAMILY_MEMBERS_DESC,
        relations=relations_list,
        hallucination_note=hallucination_note,
        existing_facts_text=existing_facts_text,
        conversations=conv_text,
    )

    raw = _call_llm_raw(prompt)

    # 解析 JSON（容忍模型在代码块里包裹 JSON）
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", raw.strip(), flags=re.MULTILINE)
    try:
        parsed = json.loads(cleaned)
    except json.JSONDecodeError:
        # fallback：取第一个 {...} 块
        m = re.search(r"\{.*\}", cleaned, re.DOTALL)
        parsed = json.loads(m.group()) if m else {}

    raw_facts   = parsed.get("facts", [])
    summary     = parsed.get("summary", raw)  # summary 缺失时用原始输出

    # 过滤非法 relation
    facts = [
        f for f in raw_facts
        if isinstance(f, dict)
        and f.get("relation") in ALLOWED_RELATIONS
        and f.get("value", "").strip()
    ]
    return facts, summary

# ── 增量检查 ──────────────────────────────────────────────────────────────────

def load_last_distill_meta(user_id: str) -> dict:
    """读取上次蒸馏元数据（时间 + 已处理记录数）"""
    safe_id   = user_id.replace(":", "_")
    meta_file = PROFILES_DIR / f"{safe_id}.meta.json"
    if meta_file.exists():
        try:
            return json.loads(meta_file.read_text())
        except Exception:
            pass
    return {"distilled_at": None, "record_count": 0}

def save_distill_meta(user_id: str, record_count: int):
    safe_id   = user_id.replace(":", "_")
    meta_file = PROFILES_DIR / f"{safe_id}.meta.json"
    meta_file.write_text(json.dumps({
        "distilled_at": datetime.datetime.now().isoformat(),
        "record_count": record_count,
    }, ensure_ascii=False, indent=2))

# ── 主流程 ────────────────────────────────────────────────────────────────────

def _get_visitor_name(user_id: str) -> str:
    """从 visitor-registry.json 读取访客显示名，读取失败降级为 token 后 4 位。"""
    try:
        registry_path = HOMEAI_ROOT / "data" / "visitor-registry.json"
        with open(registry_path, "r", encoding="utf-8") as f:
            registry = json.load(f)
        token = user_id[len("visitor:"):]  # user_id = "visitor:TOKEN"
        entry = registry.get(token, {})
        return entry.get("name") or f"访客_{token[:4]}"
    except Exception:
        return f"访客"


def distill_user(user_id: str, kuzu_conn, force: bool = False) -> bool:
    print(f"\n{'='*50}")

    # ── 访客 vs 家庭成员分支 ──────────────────────────────────────────────────
    is_visitor = user_id.startswith("visitor:")
    if is_visitor:
        # 访客：Kuzu entity ID = userId 直接用（visitor:TOKEN），无需大驼峰映射
        kuzu_user_id = user_id
        member_label = _get_visitor_name(user_id)
        min_records  = 5    # 访客对话少，降低门槛
        delta_trig   = 10   # 访客增量触发更低
    else:
        kuzu_user_id = CHROMA_TO_KUZU_ID.get(user_id, user_id)
        member_label = MEMBER_NAMES.get(user_id, user_id)
        min_records  = MIN_RECORDS
        delta_trig   = DELTA_TRIGGER

    print(f"处理：{user_id} ({member_label}){' [访客]' if is_visitor else ''}")
    if not is_visitor and kuzu_user_id != user_id:
        print(f"  Kuzu entity ID 规范化：{user_id} → {kuzu_user_id}")

    # 拉取该用户所有对话
    records = chroma_get_all("conversations", where={"userId": {"$eq": user_id}})
    total   = len(records)
    print(f"  conversations 记录数：{total}")

    if total < min_records:
        print(f"  跳过：记录数不足 {min_records}（当前 {total}）")
        return False

    # 增量检查
    if not force:
        meta       = load_last_distill_meta(user_id)
        last_count = meta.get("record_count", 0)
        delta      = total - last_count
        print(f"  上次蒸馏时：{meta.get('distilled_at', '从未')}，记录数 {last_count}，新增 {delta}")
        if delta < delta_trig:
            print(f"  跳过：新增不足 {delta_trig} 条")
            return False

    # 按时间排序
    records.sort(key=lambda x: x["metadata"].get("timestamp", ""))

    # ── 加载现有 Fact（增量更新基础）────────────────────────────────────────
    existing_facts = load_existing_facts(kuzu_conn, kuzu_user_id)
    print(f"  现有活跃 Fact：{len(existing_facts)} 条（将注入 prompt 继承更新）")

    # ── 幻觉污染预处理 ──────────────────────────────────────────────────────
    # 1. 从 MEMORY.md 加载已知幻觉类型，注入 prompt 防止 LLM 将其蒸馏为正确规律
    hallucination_patterns = load_hallucination_patterns()
    if hallucination_patterns:
        print(f"  [幻觉过滤] 加载 {len(hallucination_patterns)} 条已知幻觉类型")
    # 2. 分离 dpoFlagged 记录，写入 DPO 原料文件，蒸馏只用 clean records
    records, flagged = collect_dpo_flagged_records(records)
    if flagged:
        print(f"  [幻觉过滤] 剩余 clean 记录：{len(records)} 条（过滤 {len(flagged)} 条）")

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    total_written = 0
    all_facts: list[dict] = []
    summary_parts: list[str] = []

    if is_visitor:
        # ── 访客单轮蒸馏：全量 privacy_level="visitor" ────────────────────
        conversations = [r["document"] for r in records]
        print(f"  调用 LLM 蒸馏 [visitor]（{min(len(conversations), MAX_RECORDS)} 条）...")
        try:
            all_facts, visitor_summary = call_llm_distill(member_label, conversations, hallucination_patterns, existing_facts)
            summary_parts = [visitor_summary]
        except Exception as e:
            print(f"  LLM 调用失败：{e}")
            return False
        total_written = write_kuzu_facts(kuzu_conn, kuzu_user_id, all_facts, privacy_level="visitor", chroma_user_id=user_id)
        print(f"  Kuzu 写入：{total_written} 条 Fact（privacy_level=visitor）")
    else:
        # ── 家庭成员两轮蒸馏：群聊(public) + 私聊(private) ──────────────
        channel_passes = [
            ("group",   "public"),
            ("private", "private"),
        ]

        for source_val, privacy_level in channel_passes:
            ch_records = [r for r in records if r["metadata"].get("source", "private") == source_val]
            if len(ch_records) < 5:   # 少于 5 条不蒸馏该渠道
                print(f"  跳过 {source_val} 渠道（{len(ch_records)} 条，不足 5）")
                continue
            conversations = [r["document"] for r in ch_records]
            print(f"  调用 LLM 蒸馏 [{source_val}/{privacy_level}]（{min(len(conversations), MAX_RECORDS)} 条）...")
            try:
                facts, summary = call_llm_distill(member_label, conversations, hallucination_patterns, existing_facts)
            except Exception as e:
                print(f"  LLM 调用失败 [{source_val}]：{e}")
                continue
            print(f"  [{source_val}] 提取 {len(facts)} 条 Fact")
            n = write_kuzu_facts(kuzu_conn, kuzu_user_id, facts, privacy_level=privacy_level, chroma_user_id=user_id)
            print(f"  [{source_val}] Kuzu 写入 {n} 条（privacy_level={privacy_level}）")
            total_written += n
            all_facts.extend(facts)
            summary_parts.append(f"[{source_val}] {summary}")

        # 如果两轮都跳过（数据不足），回退到全量单轮（privacy_level=private）
        if total_written == 0:
            conversations = [r["document"] for r in records]
            print(f"  回退到全量单轮蒸馏（{min(len(conversations), MAX_RECORDS)} 条）...")
            try:
                all_facts, fallback_summary = call_llm_distill(member_label, conversations, hallucination_patterns, existing_facts)
                summary_parts = [fallback_summary]
            except Exception as e:
                print(f"  LLM 调用失败：{e}")
                return False
            total_written = write_kuzu_facts(kuzu_conn, kuzu_user_id, all_facts, privacy_level="private", chroma_user_id=user_id)
            print(f"  Kuzu 写入：{total_written} 条 Fact（privacy_level=private）")

    facts   = all_facts
    summary = "\n\n".join(summary_parts)
    n_written = total_written
    print(f"  共写入 {n_written} 条 Fact")

    # ── 写入 markdown 档案（人可读，供系统工程师查阅）────────────────
    # visitor:TOKEN 含冒号不适合文件名，替换为 visitor_TOKEN
    safe_user_id = user_id.replace(":", "_")
    md_path = PROFILES_DIR / f"{safe_user_id}.md"
    facts_md = "\n".join(
        f"- **{f['relation']}**：{f['value']}" + (f"（{f['context']}）" if f.get("context") else "")
        for f in facts
    )
    md_content = (
        f"# {member_label} 人物档案\n\n"
        f"> 最后蒸馏：{now_str}，基于 {total} 条对话\n\n"
        f"## 结构化事实\n\n{facts_md}\n\n"
        f"## 档案摘要\n\n{summary}\n"
    )
    md_path.write_text(md_content, encoding="utf-8")
    print(f"  写入档案：{md_path}")

    # ── ChromaDB insights（保留为 recall_memory 可检索的备用路径）────
    doc_id   = f"insight-{user_id}"
    document = f"【{member_label}档案，{now_str}】\n{summary}"
    try:
        embedding = embed_text(document[:800])
        chroma_upsert("insights", doc_id, document, {
            "userId":       user_id,
            "distilled_at": datetime.datetime.now().isoformat(),
            "record_count": total,
            "member_name":  member_label,
        }, embedding)
        print(f"  ChromaDB insights 更新：{doc_id}")
    except Exception as e:
        print(f"  ChromaDB 写入失败（Kuzu 已写入，不影响）：{e}")

    # 保存元数据
    save_distill_meta(user_id, total)

    # ── 行为信号提取（第二轮，仅家庭成员私聊）─────────────────────────────────
    # 识别家人给 Lucas 的行为指导/反馈，写入 lucas-behavior-signals.jsonl
    # 供 Heartbeat 注入，驱动 L2 自我改进闭环
    if not is_visitor:
        private_records = [r for r in records if r["metadata"].get("source", "private") == "private"]
        if len(private_records) >= 5:
            private_convs = [r["document"] for r in private_records]
            n_signals = extract_behavior_signals(member_label, user_id, private_convs)
            if n_signals > 0:
                print(f"  [行为信号] 写入 {n_signals} 条 → {BEHAVIOR_SIGNALS_FILE.name}")

    # ── D3 有机再入信号检测（仅访客）────────────────────────────────────────
    # 场景：已归档访客（shadow_status='archived'）重新发起对话 → 触发蒸馏
    # 此处检测到归档状态 → 更新为 'revived' + 写入 pending-revival-signals.json
    if is_visitor and kuzu_conn is not None:
        try:
            r = kuzu_conn.execute(
                "MATCH (e:Entity {id: $id}) RETURN e.shadow_status",
                {"id": kuzu_user_id},
            )
            status_val = None
            for row in r:
                status_val = row[0]
                break
            if status_val == "archived":
                # 更新 Kuzu 为 revived
                kuzu_conn.execute(
                    "MATCH (e:Entity {id: $id}) SET e.shadow_status = 'revived'",
                    {"id": kuzu_user_id},
                )
                print(f"  [D3] 有机再入信号：{user_id} 曾归档，现已 revived")
                # 写入信号文件（供系统工程师查阅 / 未来 D4 使用）
                signals_path = HOMEAI_ROOT / "data" / "pending-revival-signals.json"
                try:
                    signals = json.loads(signals_path.read_text()) if signals_path.exists() else []
                except Exception:
                    signals = []
                signals.append({
                    "userId":      user_id,
                    "visitorName": member_label,
                    "detectedAt":  datetime.datetime.now().isoformat(),
                    "status":      "pending",
                })
                signals_path.write_text(json.dumps(signals, ensure_ascii=False, indent=2))
                print(f"  [D3] revival signal 已写入 pending-revival-signals.json")
        except Exception as e:
            print(f"  [D3] 再入检测失败（不影响主流程）：{e}")

    print(f"  完成")
    return True


def distill_user_full_history(user_id: str, kuzu_conn) -> bool:
    """
    全量历史蒸馏模式（--full-history）：按时间顺序分批处理所有历史对话，
    通过 existing_facts 在批次间传递，确保跨时间段的话题积累不丢失。

    与普通 distill_user 的区别：
    - 处理 ALL 记录（不只最近 MAX_RECORDS 条），按时间升序分批
    - 首批前统一清空旧活跃 Fact（skip_expire=True 避免每批重复清空）
    - 批次间传递 existing_facts，让 LLM 在每批看到前批的提炼结果后增量更新
    """
    is_visitor = user_id.startswith("visitor:")
    kuzu_user_id = user_id if is_visitor else CHROMA_TO_KUZU_ID.get(user_id, user_id)
    member_label = _get_visitor_name(user_id) if is_visitor else MEMBER_NAMES.get(user_id, user_id)

    print(f"\n{'='*50}")
    print(f"[全量历史] 处理：{user_id} ({member_label})")

    # 拉取所有记录
    records = chroma_get_all("conversations", where={"userId": {"$eq": user_id}}, limit=2000)
    records.sort(key=lambda x: x["metadata"].get("timestamp", ""))
    total = len(records)
    print(f"  总对话记录：{total} 条")

    if total < 5:
        print(f"  跳过：记录不足 5 条")
        return False

    # 幻觉过滤（一次性）
    hallucination_patterns = load_hallucination_patterns()
    records, _ = collect_dpo_flagged_records(records)

    # 首批前：统一清空旧活跃 Fact（让全量历史从头重建，避免保留过时的旧知识）
    if kuzu_conn is not None:
        now_iso = datetime.datetime.now().isoformat()
        try:
            kuzu_conn.execute(
                "MATCH (p:Entity {id: $uid})-[f:Fact]->(o:Entity) "
                "WHERE f.source_type = 'distill' AND f.valid_until IS NULL "
                "AND f.relation <> 'has_pending_event' "
                "SET f.valid_until = $now",
                {"uid": kuzu_user_id, "now": now_iso},
            )
            print(f"  已清空旧活跃 Fact（全量重建前统一过期）")
        except Exception as e:
            print(f"  WARN: 清空旧 Fact 失败：{e}", file=sys.stderr)

    # 分批处理（全部记录按时间顺序）
    batches = [records[i:i+MAX_RECORDS] for i in range(0, len(records), MAX_RECORDS)]
    print(f"  分 {len(batches)} 批处理（每批 ≤{MAX_RECORDS} 条）")

    total_written = 0
    existing_facts: list[dict] = []  # 批次间传递：前批结果注入后批 prompt

    for batch_idx, batch in enumerate(batches):
        print(f"\n  [批次 {batch_idx+1}/{len(batches)}] 处理 {len(batch)} 条记录...")
        conversations = [r["document"] for r in batch]
        try:
            facts, _ = call_llm_distill(member_label, conversations,
                                        hallucination_patterns, existing_facts)
        except Exception as e:
            print(f"  [批次 {batch_idx+1}] LLM 调用失败：{e}")
            continue

        print(f"  [批次 {batch_idx+1}] 提取 {len(facts)} 条 Fact")
        # 首批：已手动清空，跳过过期步骤（skip_expire=True）
        n = write_kuzu_facts(kuzu_conn, kuzu_user_id, facts,
                             privacy_level="private", chroma_user_id=user_id,
                             skip_expire=True)
        print(f"  [批次 {batch_idx+1}] Kuzu 写入 {n} 条")
        total_written += n

        # 读取当前活跃 Fact 作为下批次 existing_facts（含本批新写入）
        existing_facts = load_existing_facts(kuzu_conn, kuzu_user_id)
        print(f"  [批次 {batch_idx+1}] 当前活跃 Fact：{len(existing_facts)} 条")

    print(f"\n  [全量历史] 完成：共写入 {total_written} 条 Fact（{len(batches)} 批）")
    save_distill_meta(user_id, total)
    return total_written > 0


def main():
    parser = argparse.ArgumentParser(description="Lucas 记忆蒸馏")
    parser.add_argument("--user",  help="只处理指定 userId")
    parser.add_argument("--force", action="store_true", help="忽略增量门槛强制重跑")
    parser.add_argument("--full-history", action="store_true",
                        help="全量历史模式：分批处理所有历史记录，批次间传递知识（修复跨时间段话题积累丢失）")
    args = parser.parse_args()

    print(f"记忆蒸馏开始 @ {datetime.datetime.now().isoformat()}")
    print(f"CHROMA_URL: {CHROMA_URL}")

    try:
        # 确定要处理的用户列表
        if args.user:
            user_ids = [args.user]
        else:
            # 从 conversations 集合里自动发现所有 userId
            all_records = chroma_get_all("conversations")
            user_ids = list({r["metadata"].get("userId", "") for r in all_records if r["metadata"].get("userId")})
            print(f"发现 {len(user_ids)} 个用户：{user_ids}")

        kuzu_conn = get_kuzu_conn()
        results = []
        full_history = getattr(args, "full_history", False)
        for uid in user_ids:
            if full_history:
                ok = distill_user_full_history(uid, kuzu_conn)
            else:
                ok = distill_user(uid, kuzu_conn, force=args.force)
            results.append((uid, ok))

        print(f"\n{'='*50}")
        print(f"蒸馏完成：{sum(1 for _, ok in results if ok)}/{len(results)} 个用户更新")
        for uid, ok in results:
            status = "✓ 已更新" if ok else "- 跳过"
            print(f"  {status}  {uid}")

        # ── 静态渲染管道：蒸馏结束后触发 render-knowledge.py ──────────────────
        # 如果蒸馏写入了新的 Kuzu facts，渲染脚本会把最新知识同步到 .inject.md
        updated_users = [uid for uid, ok in results if ok]
        if updated_users:
            print(f"\n── 触发知识渲染管道（父进程退出后运行）──")
            import subprocess
            render_script = HOMEAI_ROOT / "scripts" / "render-knowledge.py"
            if render_script.exists():
                # 全量渲染一次（不传 --user），避免多个实例并发争 Kuzu 锁
                # Popen fire-and-forget：父进程 os._exit 释放锁后子进程再接管
                subprocess.Popen(
                    [sys.executable, str(render_script)],
                    cwd=str(HOMEAI_ROOT),
                    start_new_session=True,
                )
            else:
                print(f"  render-knowledge.py 不存在，跳过渲染")
    finally:
        os._exit(0)  # 释放 Kuzu 文件锁；bypass Database::~Database() SIGBUS on macOS ARM64；异常路径同样触发


if __name__ == "__main__":
    main()
