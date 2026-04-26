#!/usr/bin/env python3.11
"""
ChromaDB 集合距离函数迁移：L2 → cosine

目标集合：conversations / conversations_closets / decisions / behavior_patterns

根因：这四个集合在 cosine 迁移代码上线前已存在，使用默认 L2 距离。
问题：
  - conversations：scanCrossMemberContext 阈值 0.4 按 cosine 设计，L2 距离 200+ 导致永不触发
  - conversations_closets：主语义检索路径，L2 排序质量次优
  - decisions / behavior_patterns：排序质量次优

迁移策略：
  1. 按批次 fetch 全量记录（含 embeddings）
  2. 删除旧集合
  3. 用同名 + cosine 重建
  4. 批次写回

运行前提：ChromaDB 服务运行中（localhost:8001）
"""

import sys
import time
import requests
import chromadb
from chromadb.config import Settings

CHROMA_HOST = "localhost"
CHROMA_PORT = 8001
BATCH_SIZE  = 500
CHROMA_BASE = f"http://{CHROMA_HOST}:{CHROMA_PORT}/api/v2/tenants/default_tenant/databases/default_database/collections"

TARGETS = [
    "conversations",
    "conversations_closets",
    "decisions",
    "behavior_patterns",
]

def get_client() -> chromadb.HttpClient:
    return chromadb.HttpClient(
        host=CHROMA_HOST,
        port=CHROMA_PORT,
        settings=Settings(anonymized_telemetry=False),
    )


def fetch_batch_http(col_id: str, offset: int, limit: int) -> dict | None:
    """Fetch 单个批次，失败返回 None"""
    resp = requests.post(
        f"{CHROMA_BASE}/{col_id}/get",
        json={"limit": limit, "offset": offset,
              "include": ["embeddings", "documents", "metadatas"]},
        timeout=60,
    )
    if not resp.ok:
        return None
    return resp.json()


def fetch_all_http(col_id: str, total: int) -> dict:
    """用 HTTP API 直接 fetch（绕过 Python client numpy bool 比较 bug）。
    遇到内部损坏记录时二分递减定位，单条跳过，不中止迁移。"""
    print(f"  fetch {total} records via HTTP API...", flush=True)
    if total == 0:
        return {"ids": [], "embeddings": [], "documents": [], "metadatas": []}

    all_ids, all_emb, all_docs, all_meta = [], [], [], []
    skipped = 0
    offset = 0

    def fetch_range(start: int, length: int):
        """递归二分：失败时分两半，直到 length=1 则跳过该条记录"""
        nonlocal skipped
        if length <= 0:
            return
        data = fetch_batch_http(col_id, start, length)
        if data is not None:
            ids = data.get("ids", [])
            if ids:
                all_ids .extend(ids)
                all_emb .extend(data.get("embeddings") or [None] * len(ids))
                all_docs.extend(data.get("documents")  or [""]   * len(ids))
                all_meta.extend(data.get("metadatas")  or [{}]   * len(ids))
            return
        if length == 1:
            print(f"  SKIP corrupted record at offset={start}", flush=True)
            skipped += 1
            return
        mid = length // 2
        fetch_range(start, mid)
        fetch_range(start + mid, length - mid)

    while offset < total:
        chunk = min(BATCH_SIZE, total - offset)
        prev_len = len(all_ids)
        fetch_range(offset, chunk)
        added = len(all_ids) - prev_len
        offset += chunk
        print(f"  fetched {len(all_ids)}/{total}", flush=True)

    if skipped:
        print(f"  WARNING: skipped {skipped} corrupted record(s)", flush=True)

    return {
        "ids":        all_ids,
        "embeddings": all_emb,
        "documents":  all_docs,
        "metadatas":  all_meta,
    }


def write_back(col, data: dict):
    """分批写回"""
    n = len(data["ids"])
    if n == 0:
        print("  nothing to write back", flush=True)
        return
    for start in range(0, n, BATCH_SIZE):
        end = min(start + BATCH_SIZE, n)
        col.add(
            ids        = data["ids"][start:end],
            embeddings = data["embeddings"][start:end],
            documents  = data["documents"][start:end],
            metadatas  = data["metadatas"][start:end],
        )
        print(f"  written {end}/{n}", flush=True)


def migrate_collection(client, name: str):
    print(f"\n=== Migrating: {name} ===", flush=True)

    # ① 检查集合是否存在
    try:
        col = client.get_collection(name)
    except Exception:
        print(f"  SKIP: collection '{name}' not found", flush=True)
        return

    # ② 检查是否已经是 cosine
    try:
        meta = col.metadata or {}
        cfg  = getattr(col, "configuration_json", None) or {}
        hnsw = cfg.get("hnsw", {}) if isinstance(cfg, dict) else {}
        current_space = hnsw.get("space", meta.get("hnsw:space", "l2"))
    except Exception:
        current_space = "l2"

    if current_space == "cosine":
        print(f"  SKIP: already cosine", flush=True)
        return

    print(f"  current space: {current_space}", flush=True)

    # ③ 获取集合 ID（用于 HTTP API fetch）
    col_resp = requests.get(f"{CHROMA_BASE}/{name}").json()
    col_id = col_resp["id"]

    # ④ fetch 全量（HTTP API，绕过 Python client numpy bug）
    data = fetch_all_http(col_id, col.count())
    n = len(data["ids"])
    if n == 0:
        print(f"  empty collection, just recreate with cosine", flush=True)
        client.delete_collection(name)
        client.create_collection(name, metadata={"hnsw:space": "cosine"})
        print(f"  done (empty → cosine)", flush=True)
        return

    # ⑤ 备份说明（不做物理备份，数据全在内存）
    print(f"  fetched {n} records, proceeding with migration...", flush=True)

    # ⑥ 删除旧集合
    print(f"  deleting old collection...", flush=True)
    client.delete_collection(name)
    time.sleep(0.5)  # 给 ChromaDB 一点时间清理

    # ⑥ 重建 cosine
    print(f"  creating new collection with cosine...", flush=True)
    new_col = client.create_collection(name, metadata={"hnsw:space": "cosine"})

    # ⑦ 写回
    print(f"  writing back {n} records...", flush=True)
    write_back(new_col, data)

    # ⑧ 验证
    final_count = new_col.count()
    if final_count == n:
        print(f"  DONE: {n} records migrated to cosine", flush=True)
    else:
        print(f"  WARNING: expected {n}, got {final_count} after migration!", flush=True)


def main():
    import os
    targets = sys.argv[1:] if len(sys.argv) > 1 else TARGETS

    print(f"ChromaDB cosine migration", flush=True)
    print(f"Targets: {targets}", flush=True)
    print(f"Host: {CHROMA_HOST}:{CHROMA_PORT}", flush=True)

    client = get_client()

    # ping
    try:
        client.heartbeat()
        print("ChromaDB connection OK\n", flush=True)
    except Exception as e:
        print(f"ERROR: ChromaDB not reachable: {e}", file=sys.stderr, flush=True)
        sys.exit(1)

    for name in targets:
        try:
            migrate_collection(client, name)
        except Exception as e:
            print(f"ERROR migrating '{name}': {e}", file=sys.stderr, flush=True)

    print("\nMigration complete.", flush=True)

    try:
        sys.stdout.flush()
        sys.stderr.flush()
    finally:
        import os; os._exit(0)


if __name__ == "__main__":
    main()
