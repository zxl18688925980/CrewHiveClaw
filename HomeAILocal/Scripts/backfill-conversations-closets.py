#!/usr/bin/env python3
"""
backfill-conversations-closets.py
==================================
为 conversations 集合中的旧记录回填 conversations_closets 索引层。

逻辑：
  1. 分批读取 conversations 所有记录（含 prompt/response/entityTags/source/userId/timestamp）
  2. 跳过已有对应 closet 的 drawer（closet id = closet-{drawerId}）
  3. 按 buildClosetDoc 格式生成 closet 文档
  4. 用 nomic-embed-text (Ollama:11434) 生成 embedding
  5. Upsert 到 conversations_closets（ChromaDB v2 API）

运行：
  python3 backfill-conversations-closets.py
  python3 backfill-conversations-closets.py --dry-run   # 只统计不写入
"""

import argparse
import json
import re
import sys
import time
import urllib.request
import urllib.error

# ── 配置 ─────────────────────────────────────────────────────────────────────

CHROMA_BASE = "http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections"
OLLAMA_EMBED = "http://localhost:11434/api/embeddings"
BATCH_SIZE   = 500   # 每次从 ChromaDB 拉取的记录数
EMBED_DELAY  = 0.05  # 每条 embedding 之间的间隔（秒），避免 Ollama 过载

# ── HTTP 工具 ─────────────────────────────────────────────────────────────────

def http_post(url: str, body: dict) -> dict:
    data = json.dumps(body).encode()
    req  = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def http_get(url: str) -> dict:
    with urllib.request.urlopen(url, timeout=10) as r:
        return json.loads(r.read())

# ── ChromaDB 工具 ─────────────────────────────────────────────────────────────

_col_id_cache: dict[str, str] = {}

def get_col_id(name: str) -> str:
    if name in _col_id_cache:
        return _col_id_cache[name]
    cols = http_get(CHROMA_BASE)
    for c in cols:
        if c["name"] == name:
            _col_id_cache[name] = c["id"]
            return c["id"]
    # 集合不存在则创建
    r = http_post(CHROMA_BASE, {"name": name, "get_or_create": True})
    _col_id_cache[name] = r["id"]
    return r["id"]

def chroma_get_batch(col_id: str, limit: int, offset: int) -> dict:
    url  = f"{CHROMA_BASE}/{col_id}/get"
    body = {"limit": limit, "offset": offset, "include": ["documents", "metadatas"]}
    return http_post(url, body)

def chroma_get_by_ids(col_id: str, ids: list[str]) -> dict:
    if not ids:
        return {"ids": []}
    url  = f"{CHROMA_BASE}/{col_id}/get"
    body = {"ids": ids, "include": ["ids"]}
    try:
        return http_post(url, body)
    except Exception:
        return {"ids": []}

def chroma_upsert(col_id: str, id_: str, document: str, metadata: dict, embedding: list[float]):
    url  = f"{CHROMA_BASE}/{col_id}/upsert"
    body = {
        "ids":        [id_],
        "embeddings": [embedding],
        "documents":  [document],
        "metadatas":  [metadata],
    }
    http_post(url, body)

# ── Embedding ─────────────────────────────────────────────────────────────────

def embed_text(text: str) -> list[float]:
    body = {"model": "nomic-embed-text", "prompt": text}
    r    = http_post(OLLAMA_EMBED, body)
    return r["embedding"]

# ── Closet 文档构建（与 index.ts buildClosetDoc 完全对齐）──────────────────────

HALL_DISCOVERIES_RE = re.compile(r"发现|原来|学到|了解到|知道了|没想到")
HALL_PREFERENCES_RE = re.compile(r"喜欢|不喜欢|习惯|讨厌|偏好|比较喜|最爱|不爱")

def derive_hall_type(prompt: str, response: str, meta: dict) -> str:
    # 若 writeMemory 已写 hall_type 则直接用
    if "hall_type" in meta:
        return meta["hall_type"]
    combined = prompt + " " + response
    if HALL_DISCOVERIES_RE.search(combined):
        return "hall_discoveries"
    if HALL_PREFERENCES_RE.search(combined):
        return "hall_preferences"
    # 无 intent 信息，旧数据不区分 events vs facts，统一归 hall_facts
    return "hall_facts"

def build_closet_doc(prompt: str, response: str, drawer_id: str,
                     hall_type: str, entity_tags: str, user_id: str) -> str:
    entities        = entity_tags or user_id
    prompt_summary  = prompt[:120].replace("\n", " ").strip()
    response_summary = response[:80].replace("\n", " ").strip()
    doc = f"[{hall_type}] {entities}: {prompt_summary}"
    if response_summary:
        doc += f" | {response_summary}"
    doc += f" \u2192{drawer_id}"   # → U+2192
    return doc

# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Backfill conversations_closets")
    parser.add_argument("--dry-run", action="store_true", help="只统计不写入")
    args = parser.parse_args()

    conv_id    = get_col_id("conversations")
    closet_id  = get_col_id("conversations_closets")

    # 统计 conversations 总数
    total = http_get(f"{CHROMA_BASE}/{conv_id}/count")
    print(f"conversations 总记录数: {total}")

    offset   = 0
    written  = 0
    skipped  = 0
    errors   = 0

    while offset < total:
        batch = chroma_get_batch(conv_id, BATCH_SIZE, offset)
        ids   = batch.get("ids", [])
        docs  = batch.get("documents", [])
        metas = batch.get("metadatas", [])

        if not ids:
            break

        # 批量检查哪些 closet 已存在
        closet_ids_to_check = [f"closet-{d}" for d in ids]
        existing = chroma_get_by_ids(closet_id, closet_ids_to_check)
        existing_set = set(existing.get("ids", []))

        for drawer_id, doc, meta in zip(ids, docs, metas):
            closet_key = f"closet-{drawer_id}"
            if closet_key in existing_set:
                skipped += 1
                continue

            # 提取字段
            prompt      = meta.get("prompt", "")
            response    = meta.get("response", "")
            entity_tags = meta.get("entityTags", "")
            user_id     = meta.get("userId", "")
            source      = meta.get("source", "private")
            timestamp   = meta.get("timestamp", "")
            hall_type   = derive_hall_type(prompt, response, meta)

            if not prompt and not response:
                skipped += 1
                continue

            closet_doc = build_closet_doc(prompt, response, drawer_id,
                                          hall_type, entity_tags, user_id)

            if args.dry_run:
                print(f"  [dry] {closet_key}: {closet_doc[:80]}...")
                written += 1
                continue

            try:
                embedding = embed_text(closet_doc)
                closet_meta = {
                    "drawer_id": drawer_id,
                    "userId":    user_id.lower() if user_id else "",
                    "source":    source,
                    "hall_type": hall_type,
                    "timestamp": timestamp,
                    "entityTags": entity_tags,
                }
                chroma_upsert(closet_id, closet_key, closet_doc, closet_meta, embedding)
                written += 1
                if EMBED_DELAY:
                    time.sleep(EMBED_DELAY)
            except Exception as e:
                errors += 1
                print(f"  [error] {drawer_id}: {e}", file=sys.stderr)

        offset += len(ids)
        pct = min(offset, total) * 100 // total
        print(f"  进度: {min(offset, total)}/{total} ({pct}%)  写入={written}  跳过={skipped}  错误={errors}")

    print()
    print(f"完成！写入={written}  跳过={skipped}  错误={errors}")


if __name__ == "__main__":
    main()
