#!/usr/bin/env python3
"""
ChromaDB 迁移脚本：Docker (8000) → 本地 (8001)
用法：python3 scripts/migrate-chroma-docker-to-local.py [--dry-run]
"""

import sys
import chromadb
from chromadb.utils import embedding_functions

DRY_RUN = "--dry-run" in sys.argv
BATCH_SIZE = 100

SOURCE_HOST = "localhost"
SOURCE_PORT = 8000
DEST_HOST = "localhost"
DEST_PORT = 8001

def migrate():
    print(f"{'[DRY RUN] ' if DRY_RUN else ''}连接 Docker ChromaDB ({SOURCE_PORT})...")
    src = chromadb.HttpClient(host=SOURCE_HOST, port=SOURCE_PORT)

    print(f"{'[DRY RUN] ' if DRY_RUN else ''}连接本地 ChromaDB ({DEST_PORT})...")
    dst = chromadb.HttpClient(host=DEST_HOST, port=DEST_PORT)

    collections = src.list_collections()
    print(f"\n发现 {len(collections)} 个集合：")
    for col in collections:
        print(f"  {col.name}: {col.count()} docs")

    print()

    total_migrated = 0
    for col_info in collections:
        name = col_info.name
        src_col = src.get_collection(name)
        count = src_col.count()

        print(f"--- 迁移 {name} ({count} docs) ---")

        if count == 0:
            print(f"  空集合，跳过")
            continue

        # 分批拉取所有文档
        all_ids = []
        all_documents = []
        all_metadatas = []
        all_embeddings = []

        offset = 0
        while offset < count:
            result = src_col.get(
                limit=BATCH_SIZE,
                offset=offset,
                include=["documents", "metadatas", "embeddings"]
            )
            batch_ids = result["ids"]
            if not batch_ids:
                break

            all_ids.extend(batch_ids)
            all_documents.extend(result.get("documents") or [""] * len(batch_ids))
            all_metadatas.extend(result.get("metadatas") or [{}] * len(batch_ids))
            embeds = result.get("embeddings")
            if embeds is not None and len(embeds) > 0:
                all_embeddings.extend(embeds)

            offset += len(batch_ids)
            print(f"  拉取进度: {offset}/{count}")

        print(f"  总计拉取: {len(all_ids)} 条")

        if DRY_RUN:
            print(f"  [DRY RUN] 跳过写入")
            continue

        # 创建目标集合（已存在则获取）
        try:
            dst_col = dst.get_or_create_collection(
                name=name,
                metadata=col_info.metadata or {}
            )
        except Exception as e:
            print(f"  创建集合失败: {e}")
            continue

        # 检查已有数据
        existing_count = dst_col.count()
        if existing_count > 0:
            print(f"  目标已有 {existing_count} 条，将做 upsert（覆盖重复 ID）")

        # 分批写入
        write_count = 0
        for i in range(0, len(all_ids), BATCH_SIZE):
            batch_ids = all_ids[i:i+BATCH_SIZE]
            batch_docs = all_documents[i:i+BATCH_SIZE]
            batch_meta = all_metadatas[i:i+BATCH_SIZE]

            kwargs = {
                "ids": batch_ids,
                "documents": batch_docs,
                "metadatas": batch_meta,
            }
            if all_embeddings and len(all_embeddings) > 0:
                kwargs["embeddings"] = all_embeddings[i:i+BATCH_SIZE]

            try:
                dst_col.upsert(**kwargs)
                write_count += len(batch_ids)
                print(f"  写入进度: {write_count}/{len(all_ids)}")
            except Exception as e:
                print(f"  写入失败 (batch {i}): {e}")

        final_count = dst_col.count()
        print(f"  完成：目标集合现有 {final_count} 条")
        total_migrated += write_count

    print(f"\n{'[DRY RUN] ' if DRY_RUN else ''}迁移完成，共写入 {total_migrated} 条文档")

    # 验证
    if not DRY_RUN:
        print("\n验证对比：")
        src_cols = {c.name: c.count() for c in src.list_collections()}
        dst_cols = {c.name: c.count() for c in dst.list_collections()}

        all_names = sorted(set(src_cols) | set(dst_cols))
        ok = True
        for name in all_names:
            s = src_cols.get(name, 0)
            d = dst_cols.get(name, 0)
            status = "✅" if s == d else ("⚠️ " if d > 0 else "❌")
            if s != d:
                ok = False
            print(f"  {status} {name}: Docker={s}, 本地={d}")

        if ok:
            print("\n✅ 所有集合数量一致，迁移成功")
        else:
            print("\n⚠️ 有差异，请检查上面的不一致项")

if __name__ == "__main__":
    migrate()
