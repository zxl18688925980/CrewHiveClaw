#!/usr/bin/env python3
"""
topic 节点去重 + ChromaDB topics 集合重建

功能：
  1. 从 Kuzu 读取所有 topic 节点
  2. embedding 聚类，合并高相似度重复节点（cosine > 阈值）
  3. Kuzu：过期重复节点的 Fact 边，重写为指向 canonical 节点
  4. 重建 ChromaDB topics 集合（从 Kuzu 全量读取 person→topic Fact）

用法：
  python3 scripts/dedup-topics.py --dry-run    # 只报告重复，不写入
  python3 scripts/dedup-topics.py              # 去重 + 重建（推荐首次执行）
  python3 scripts/dedup-topics.py --rebuild    # 只重建 ChromaDB，跳过去重

依赖：kuzu（python3.11）、requests
"""

import os, sys, json, math, datetime, argparse, re
from pathlib import Path

# ── 配置 ──────────────────────────────────────────────────────────────────────
HOMEAI_ROOT      = Path(__file__).parent.parent
CHROMA_URL       = os.environ.get("CHROMA_URL", "http://localhost:8001")
CHROMA_BASE      = f"{CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections"
OLLAMA_URL       = os.environ.get("OLLAMA_URL", "http://localhost:11434")
KUZU_DB_PATH     = HOMEAI_ROOT / "data" / "kuzu"
DEDUP_THRESHOLD  = 0.95   # cosine 相似度阈值：超过此值视为重复节点
# 注：nomic-embed-text 对短中文短语的通用域相似度偏高，需用较高阈值避免误合并
# 经验值：0.93 仍会误合并语义不同的短语，0.95 更保守，适合当前数据量

# Kuzu 大驼峰 userId → ChromaDB 小写 userId
KUZU_TO_CHROMA_ID = {
    "ZengXiaoLong":       "zengxiaolong",
    "XiaMoQiuFengLiang":  "xiamogqiufengliang",
    "ZiFeiYu":            "zifeiyu",
    "ZengYueYuTong":      "zengyueyutong",
    "lucas":              "lucas",
}

# ── ChromaDB 工具 ─────────────────────────────────────────────────────────────

import requests

def embed_text(text: str) -> list[float]:
    r = requests.post(f"{OLLAMA_URL}/api/embed",
                      json={"model": "nomic-embed-text", "input": text}, timeout=30)
    r.raise_for_status()
    return r.json()["embeddings"][0]

def get_collection_id(name: str) -> str | None:
    r = requests.get(f"{CHROMA_BASE}/{name}", timeout=10)
    return r.json().get("id") if r.status_code == 200 else None

def ensure_collection(name: str) -> str:
    r = requests.post(CHROMA_BASE,
                      json={"name": name, "metadata": {"hnsw:space": "cosine"}}, timeout=10)
    if r.status_code in (200, 409):
        cid = get_collection_id(name)
        if cid:
            return cid
    raise RuntimeError(f"无法创建/获取集合 {name}: {r.status_code}")

def chroma_delete_collection(name: str):
    cid = get_collection_id(name)
    if cid:
        r = requests.delete(f"{CHROMA_BASE}/{cid}", timeout=10)
        print(f"  删除旧 topics 集合：HTTP {r.status_code}")
    else:
        print("  topics 集合不存在，跳过删除")

def chroma_upsert_batch(name: str, ids: list, documents: list,
                         metadatas: list, embeddings: list):
    cid = ensure_collection(name)
    payload = {
        "ids":        ids,
        "documents":  documents,
        "metadatas":  metadatas,
        "embeddings": embeddings,
    }
    r = requests.post(f"{CHROMA_BASE}/{cid}/upsert", json=payload, timeout=60)
    r.raise_for_status()

# ── 余弦相似度（不依赖 numpy）────────────────────────────────────────────────

def cosine_similarity(a: list[float], b: list[float]) -> float:
    dot = sum(x * y for x, y in zip(a, b))
    na  = math.sqrt(sum(x * x for x in a))
    nb  = math.sqrt(sum(x * x for x in b))
    return dot / (na * nb) if na and nb else 0.0

# ── Kuzu 查询 ─────────────────────────────────────────────────────────────────

def kuzu_query(conn, cypher: str, params: dict = None) -> list[list]:
    res = conn.execute(cypher, params or {})
    rows = []
    for row in res:
        rows.append(list(row))
    return rows

def load_all_topic_nodes(conn) -> list[dict]:
    """返回有活跃 Fact 边的 topic 节点（valid_until IS NULL），跳过历史过期孤立节点。
    只对有活跃边的节点去重，避免对已废弃数据做无意义操作。"""
    rows = kuzu_query(conn,
        "MATCH (p:Entity)-[f:Fact]->(t:Entity) "
        "WHERE t.type = 'topic' AND f.valid_until IS NULL "
        "RETURN DISTINCT t.id, t.name")
    return [{"id": r[0], "name": r[1] or ""} for r in rows if r[0]]

def load_all_topic_facts(conn) -> list[dict]:
    """返回所有有效的 person→topic Fact 边（valid_until IS NULL）"""
    rows = kuzu_query(conn,
        "MATCH (p:Entity)-[f:Fact]->(t:Entity) "
        "WHERE t.type = 'topic' AND f.valid_until IS NULL "
        "RETURN p.id, t.id, t.name, f.relation, f.context, f.privacy_level, f.source_id")
    return [
        {
            "personId":     r[0],
            "topicId":      r[1],
            "topicName":    r[2] or "",
            "relation":     r[3] or "",
            "context":      r[4] or "",
            "privacyLevel": r[5] or "private",
            "sourceId":     r[6] or "",
        }
        for r in rows if r[0] and r[1]
    ]

# ── 聚类：贪心合并 ────────────────────────────────────────────────────────────

def compute_clusters(topics: list[dict], threshold: float) -> list[list[int]]:
    """
    贪心聚类：按遍历顺序，每个尚未分配的节点开始一个新 cluster，
    之后相似度 ≥ threshold 的节点并入该 cluster。
    返回 [[idx0, idx1, ...], ...]，cluster[0] 为 canonical。
    """
    print(f"  计算 {len(topics)} 个 topic 节点的 embedding...")
    embeddings = []
    for i, t in enumerate(topics):
        text = t["name"][:100] if t["name"] else t["id"]
        emb  = embed_text(text)
        embeddings.append(emb)
        if (i + 1) % 20 == 0:
            print(f"    {i + 1}/{len(topics)}...")

    clusters  = []
    assigned  = [False] * len(topics)

    for i in range(len(topics)):
        if assigned[i]:
            continue
        cluster    = [i]
        assigned[i] = True
        for j in range(i + 1, len(topics)):
            if assigned[j]:
                continue
            if cosine_similarity(embeddings[i], embeddings[j]) >= threshold:
                cluster.append(j)
                assigned[j] = True
        clusters.append(cluster)

    return clusters

# ── Kuzu 合并重复节点 ─────────────────────────────────────────────────────────

def merge_duplicates_in_kuzu(conn, topics: list[dict],
                              clusters: list[list[int]], dry_run: bool) -> int:
    """
    对包含 > 1 个节点的 cluster：
      - cluster[0] = canonical（保留）
      - 其余 = duplicate：过期其 Fact 边，在 canonical 上重建相同 Fact 边
    返回合并的 duplicate 数量。
    """
    total_merged = 0
    now_iso      = datetime.datetime.now().isoformat()
    dedup_sid    = f"dedup-{datetime.date.today().isoformat()}"

    for cluster in clusters:
        if len(cluster) == 1:
            continue

        canonical  = topics[cluster[0]]
        duplicates = [topics[i] for i in cluster[1:]]

        print(f"\n  [合并] canonical: '{canonical['name']}' ({canonical['id']})")
        for dup in duplicates:
            print(f"         duplicate: '{dup['name']}' ({dup['id']})")

        if dry_run:
            total_merged += len(duplicates)
            continue

        for dup in duplicates:
            # 取 duplicate 上所有有效 Fact 边
            rows = kuzu_query(conn,
                "MATCH (p:Entity)-[f:Fact]->(t:Entity {id: $tid}) "
                "WHERE f.valid_until IS NULL "
                "RETURN p.id, f.relation, f.context, f.valid_from, "
                "       f.confidence, f.privacy_level, f.source_id",
                {"tid": dup["id"]})

            for row in rows:
                (person_id, relation, context,
                 valid_from, confidence, privacy_level, source_id) = row

                # 1. 过期 person → duplicate_topic 的 Fact 边
                try:
                    conn.execute(
                        "MATCH (p:Entity {id: $pid})-[f:Fact]->(t:Entity {id: $tid}) "
                        "WHERE f.valid_until IS NULL "
                        "SET f.valid_until = $now",
                        {"pid": person_id, "tid": dup["id"], "now": now_iso})
                except Exception as e:
                    print(f"    WARN: 过期 Fact 失败 {person_id}→{dup['id']}: {e}",
                          file=sys.stderr)
                    continue

                # 2. 重建 person → canonical_topic 的 Fact 边
                try:
                    conn.execute(
                        "MATCH (p:Entity {id: $pid}), (t:Entity {id: $tid}) "
                        "CREATE (p)-[:Fact {"
                        "  relation: $rel, context: $ctx, "
                        "  valid_from: $from, confidence: $conf, "
                        "  privacy_level: $pl, "
                        "  source_type: 'dedup', source_id: $sid"
                        "}]->(t)",
                        {
                            "pid":  person_id,
                            "tid":  canonical["id"],
                            "rel":  relation    or "",
                            "ctx":  context     or "",
                            "from": valid_from  or now_iso,
                            "conf": confidence  or 0.85,
                            "pl":   privacy_level or "private",
                            "sid":  dedup_sid,
                        })
                    print(f"    重写：{person_id} → {canonical['id']} ({relation})")
                except Exception as e:
                    print(f"    WARN: 重建 Fact 失败 {person_id}→{canonical['id']}: {e}",
                          file=sys.stderr)

            total_merged += 1

    return total_merged

# ── ChromaDB topics 集合重建 ──────────────────────────────────────────────────

def rebuild_topics_chroma(conn, dry_run: bool):
    """
    从 Kuzu 全量读取有效的 person→topic Fact，重建 ChromaDB topics 集合。
    删除旧集合再重建，保证数据干净（无历史碎片）。
    """
    facts = load_all_topic_facts(conn)
    print(f"\n  从 Kuzu 读取 {len(facts)} 条 person→topic Fact（valid_until IS NULL）")

    if not facts:
        print("  没有数据，跳过 ChromaDB 重建")
        return

    if dry_run:
        print("  [dry-run] 跳过 ChromaDB 写入")
        return

    chroma_delete_collection("topics")

    batch_size = 50
    total      = 0
    errors     = 0

    for i in range(0, len(facts), batch_size):
        batch = facts[i : i + batch_size]
        ids, documents, metadatas, embeddings = [], [], [], []

        for f in batch:
            chroma_uid = KUZU_TO_CHROMA_ID.get(f["personId"], f["personId"].lower())
            doc_id     = f"{chroma_uid}::{f['topicId']}"
            document   = (f"{f['topicName']}：{f['context']}"
                          if f["context"] else f["topicName"])
            try:
                emb = embed_text(document[:200])
            except Exception as e:
                print(f"  WARN: embedding 失败 ({f['topicId']}): {e}", file=sys.stderr)
                errors += 1
                continue

            ids.append(doc_id)
            documents.append(document)
            metadatas.append({
                "topicId":   f["topicId"],
                "topicName": f["topicName"],
                "userId":    chroma_uid,
                "relation":  f["relation"],
                "context":   f["context"][:200] if f["context"] else "",
                "updatedAt": datetime.date.today().isoformat(),
            })
            embeddings.append(emb)

        if ids:
            try:
                chroma_upsert_batch("topics", ids, documents, metadatas, embeddings)
                total += len(ids)
                print(f"  写入进度：{total}/{len(facts)} 条...")
            except Exception as e:
                print(f"  WARN: ChromaDB 批量写入失败: {e}", file=sys.stderr)
                errors += 1

    print(f"  ChromaDB topics 集合重建完成：{total} 条写入，{errors} 条失败")

# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="topic 节点去重 + ChromaDB topics 重建")
    parser.add_argument("--dry-run",   action="store_true",
                        help="只报告重复情况，不写入任何数据")
    parser.add_argument("--rebuild",   action="store_true",
                        help="跳过 Kuzu 去重，只重建 ChromaDB topics 集合")
    parser.add_argument("--threshold", type=float, default=DEDUP_THRESHOLD,
                        help=f"cosine 相似度阈值（默认 {DEDUP_THRESHOLD}）")
    args = parser.parse_args()

    print(f"topic 去重工具 @ {datetime.datetime.now().isoformat()}")
    print(f"KUZU_DB_PATH:    {KUZU_DB_PATH}")
    print(f"CHROMA_URL:      {CHROMA_URL}")
    print(f"dedup threshold: {args.threshold}")
    if args.dry_run:
        print("模式：dry-run（只报告，不写入）")

    import kuzu
    db   = kuzu.Database(str(KUZU_DB_PATH))
    conn = kuzu.Connection(db)

    try:
        if not args.rebuild:
            # ── 1. 读取所有 topic 节点 ────────────────────────────────────
            topics = load_all_topic_nodes(conn)
            print(f"\n读取到 {len(topics)} 个 topic 节点")

            if not topics:
                print("没有 topic 节点，跳过去重")
            else:
                # ── 2. embedding 聚类 ─────────────────────────────────────
                clusters     = compute_clusters(topics, args.threshold)
                dup_clusters = [c for c in clusters if len(c) > 1]
                total_dups   = sum(len(c) - 1 for c in dup_clusters)

                print(f"\n聚类结果：{len(clusters)} 个集群，"
                      f"发现 {len(dup_clusters)} 个重复组（共 {total_dups} 个重复节点）")

                if dup_clusters:
                    for cluster in dup_clusters:
                        canonical  = topics[cluster[0]]
                        dup_names  = ", ".join(f"'{topics[i]['name']}'" for i in cluster[1:])
                        print(f"  '{canonical['name']}' ← {dup_names}")

                    # ── 3. Kuzu 合并 ──────────────────────────────────────
                    merged = merge_duplicates_in_kuzu(conn, topics, clusters, args.dry_run)
                    suffix = "（dry-run，未写入）" if args.dry_run else ""
                    print(f"\nKuzu 合并完成：{merged} 个重复节点已处理{suffix}")
                else:
                    print("没有发现重复节点，Kuzu 无需变更")

        # ── 4. 重建 ChromaDB topics 集合 ─────────────────────────────────
        print("\n── 重建 ChromaDB topics 集合 ──")
        rebuild_topics_chroma(conn, args.dry_run)

        print(f"\n完成 @ {datetime.datetime.now().isoformat()}")

    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        os._exit(0)  # bypass Kuzu Database::~Database() SIGBUS on macOS ARM64


if __name__ == "__main__":
    main()
