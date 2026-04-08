#!/usr/bin/env python3
"""
backfill-shadow-memories.py  —  历史对话回填到影子记忆命名空间

用途：访客影子记忆激活时（首次达到 15 轮），将该 personId 对应的所有历史对话
       从 ChromaDB conversations 集合迁移到 visitor_shadow_{personId} 独立命名空间。

调用方式：
  python3 backfill-shadow-memories.py <personId>

设计：
  1. 读 visitor-registry.json，找到所有 personId == <personId> 的条目（可能有多个历史 token）
  2. 从 ChromaDB conversations 集合按 sessionId 过滤，拿到该访客所有历史对话
  3. 写入 visitor_shadow_{personId} 集合（已存在的文档跳过，避免重复）
  4. os._exit(0) 防 Kuzu SIGBUS（本脚本不用 Kuzu，但统一收尾规范）
"""

import sys
import os
import json
import re
import requests
import time

HOMEAI_ROOT = os.path.expanduser("~/HomeAI")
REGISTRY_PATH = os.path.join(HOMEAI_ROOT, "data", "visitor-registry.json")
CHROMA_URL = os.environ.get("CHROMA_URL", "http://localhost:8001")
LOG_FILE = os.path.join(HOMEAI_ROOT, "logs", "backfill-shadow-memories.log")

# ChromaDB v2 路径前缀
CHROMA_V2 = f"{CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database"


def log(msg: str):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{ts}] {msg}"
    print(line, flush=True)
    try:
        os.makedirs(os.path.dirname(LOG_FILE), exist_ok=True)
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")
    except Exception:
        pass


def get_or_create_collection(name: str) -> str:
    """返回集合 ID（已存在则 get，不存在则 create）"""
    r = requests.get(f"{CHROMA_V2}/collections/{name}", timeout=10)
    if r.status_code == 200:
        return r.json()["id"]
    body = {"name": name, "metadata": {"hnsw:space": "cosine"}}
    r = requests.post(f"{CHROMA_V2}/collections", json=body, timeout=10)
    r.raise_for_status()
    return r.json()["id"]


def get_existing_ids(col_id: str) -> set:
    """拿到目标集合已有的所有 document ID"""
    try:
        r = requests.post(
            f"{CHROMA_V2}/collections/{col_id}/get",
            json={"limit": 5000, "include": []},
            timeout=30,
        )
        if r.ok:
            return set(r.json().get("ids", []))
    except Exception:
        pass
    return set()


def get_conversations_col_id() -> str | None:
    """取 conversations 集合 ID"""
    r = requests.get(f"{CHROMA_V2}/collections/conversations", timeout=10)
    if r.ok:
        return r.json()["id"]
    return None


def get_conversations_for_tokens(tokens: list, visitor_name: str = "") -> list:
    """
    从 conversations 集合拉取与这批 token 相关的所有文档。
    两路匹配：
      1. sessionId 含 visitor:<token>（含历史邀请码）
      2. fromId == visitorName（UUID session 手动关联到真实姓名的记录）
    """
    col_id = get_conversations_col_id()
    if not col_id:
        log("[WARN] 找不到 conversations 集合")
        return []

    r = requests.post(
        f"{CHROMA_V2}/collections/{col_id}/get",
        json={"limit": 5000, "include": ["documents", "metadatas", "embeddings"]},
        timeout=60,
    )
    if not r.ok:
        log(f"[WARN] 拉取 conversations 失败: {r.status_code} {r.text[:200]}")
        return []

    data = r.json()
    ids        = data.get("ids", [])
    docs       = data.get("documents", [])
    metas      = data.get("metadatas", [])
    embeddings = data.get("embeddings") or []

    token_set = {t.lower() for t in tokens}

    results = []
    seen_ids = set()
    for i, (doc_id, doc, meta) in enumerate(zip(ids, docs, metas)):
        if doc_id in seen_ids:
            continue
        session_id = (meta or {}).get("sessionId", "") or ""
        from_id    = (meta or {}).get("fromId", "") or ""

        matched = False
        # 路径1：sessionId 含 visitor:<token>
        m = re.search(r"visitor:([a-zA-Z0-9\-]+)", session_id)
        if m and m.group(1).lower() in token_set:
            matched = True
        # 路径2：fromId == visitorName（UUID session 已手动关联）
        if visitor_name and from_id == visitor_name:
            matched = True

        if matched:
            emb = embeddings[i] if i < len(embeddings) else None
            results.append({
                "id":        doc_id,
                "document":  doc,
                "metadata":  meta,
                "embedding": emb,
            })
            seen_ids.add(doc_id)
    return results


def upsert_to_shadow(col_id: str, records: list, existing_ids: set, visitor_name: str) -> int:
    """批量写入到影子集合，跳过已存在的 ID"""
    to_write = [r for r in records if r["id"] not in existing_ids]
    if not to_write:
        return 0

    batch_size = 50
    written = 0
    for i in range(0, len(to_write), batch_size):
        batch = to_write[i:i + batch_size]
        body = {
            "ids":       [r["id"] for r in batch],
            "documents": [r["document"] for r in batch],
            "metadatas": [
                {**(r["metadata"] or {}), "backfilled": True, "visitorName": visitor_name}
                for r in batch
            ],
        }
        # 若有预计算 embedding，一并传入避免重新计算
        valid_embs = [r["embedding"] for r in batch if r.get("embedding")]
        if len(valid_embs) == len(batch):
            body["embeddings"] = valid_embs

        resp = requests.post(
            f"{CHROMA_V2}/collections/{col_id}/upsert",
            json=body,
            timeout=30,
        )
        if resp.ok:
            written += len(batch)
        else:
            log(f"[WARN] 批次写入失败: {resp.status_code} {resp.text[:200]}")

    return written


def main():
    if len(sys.argv) < 2:
        log("[ERROR] 用法: backfill-shadow-memories.py <personId>")
        os._exit(1)

    person_id = sys.argv[1].strip()
    log(f"[START] backfill personId={person_id}")

    # 读 registry，找所有属于该 personId 的 token
    try:
        with open(REGISTRY_PATH, encoding="utf-8") as f:
            registry = json.load(f)
    except Exception as e:
        log(f"[ERROR] 读 registry 失败: {e}")
        os._exit(1)

    matching = {code: entry for code, entry in registry.items() if entry.get("personId") == person_id}
    if not matching:
        log(f"[WARN] registry 中找不到 personId={person_id} 的条目，退出")
        os._exit(0)

    tokens_current = list(matching.keys())
    # 合并历史 token（历史邀请码已过期/被删，但对话记录仍在）
    historical = []
    for entry in matching.values():
        historical.extend(entry.get("historicalTokens", []))
    tokens = list({t.lower() for t in tokens_current + historical})

    visitor_name = next((e.get("name") for e in matching.values() if e.get("name")), tokens_current[0])
    log(f"  name={visitor_name}, tokens={tokens}")

    # 目标集合
    shadow_col_name = f"visitor_shadow_{person_id}"
    try:
        shadow_col_id = get_or_create_collection(shadow_col_name)
    except Exception as e:
        log(f"[ERROR] 创建/获取集合 {shadow_col_name} 失败: {e}")
        os._exit(1)

    existing_ids = get_existing_ids(shadow_col_id)
    log(f"  目标集合已有 {len(existing_ids)} 条记录")

    # 拉取历史对话（token 匹配 + fromId 匹配两路）
    records = get_conversations_for_tokens(tokens, visitor_name=visitor_name)
    log(f"  从 conversations 找到 {len(records)} 条相关记录（token={tokens}, fromId={visitor_name}）")

    if not records:
        log("  无历史记录可回填，完成")
        os._exit(0)

    written = upsert_to_shadow(shadow_col_id, records, existing_ids, visitor_name)
    log(f"[DONE] 回填完成：新写入 {written} 条（跳过已有 {len(records) - written} 条）")

    os._exit(0)


if __name__ == "__main__":
    main()
