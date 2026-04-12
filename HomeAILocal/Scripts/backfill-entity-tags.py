#!/usr/bin/env python3
"""
为现有 ChromaDB conversations 记录补充 entityTags 元数据。
从 Kuzu 加载实体名 → 在对话内容中匹配 → 更新 metadata.entityTags。
幂等：已有 entityTags 的记录跳过。
一次性脚本，运行后可删除。
"""
import json, sys, os, time
import requests as _req

# Kuzu + ChromaDB 配置
KUZU_DB = "/Users/xinbinanshan/HomeAI/Data/kuzu"
CHROMA_BASE = os.environ.get("CHROMA_URL", "http://localhost:8001") + "/api/v2/tenants/default_tenant/databases/default_database/collections"

# 家庭成员别名（与 index.ts ENTITY_ALIAS_MAP 同步）
ENTITY_ALIAS_MAP = {
    "爸爸": "zengxiaolong", "曾小龙": "zengxiaolong",
    "妈妈": "XiaMoQiuFengLiang", "张璐": "XiaMoQiuFengLiang",
    "小姨": "ZiFeiYu", "肖山": "ZiFeiYu",
    "姐姐": "ZengYueYuTong", "黟黟": "ZengYueYuTong", "玥玥": "ZengYueYuTong",
}

def post(url, data):
    r = _req.post(url, json=data, timeout=30)
    r.raise_for_status()
    return r.json()

def get(url):
    r = _req.get(url, timeout=15)
    r.raise_for_status()
    return r.json()

def get_collection_id(name):
    url = f"{CHROMA_BASE}/{name}"
    return get(url)["id"]

def load_kuzu_entities():
    """从 Kuzu 加载所有 Entity 节点的 name→id 映射"""
    import kuzu
    db = kuzu.Database(KUZU_DB, read_only=True)
    conn = kuzu.Connection(db)
    result = conn.execute("MATCH (e:Entity) RETURN e.id, e.name, e.type")
    entities = {}
    while True:
        try:
            row = result.get_next()
            eid, name, etype = row[0], row[1], row[2]
            if name and len(name) >= 2:
                entities[name] = eid
        except:
            break
    print(f"Kuzu 实体加载完成: {len(entities)} 个名字")
    return entities

def extract_entity_tags(text, kuzu_entities):
    """从文本中提取匹配的实体 ID 列表"""
    tags = set()
    lower = text.lower()
    # 别名匹配
    for alias, eid in ENTITY_ALIAS_MAP.items():
        if alias in text:
            tags.add(eid)
    # Kuzu Entity name 匹配（按名称长度降序，优先匹配长名）
    sorted_names = sorted(kuzu_entities.keys(), key=len, reverse=True)
    for name in sorted_names:
        if len(name) >= 3 and name in text:
            tags.add(kuzu_entities[name])
    return list(tags)

def main():
    # 1. 加载 Kuzu 实体
    try:
        kuzu_entities = load_kuzu_entities()
    except Exception as e:
        print(f"❌ Kuzu 加载失败: {e}")
        sys.exit(1)

    # 2. 获取 conversations 集合
    try:
        col_id = get_collection_id("conversations")
        print(f"ChromaDB conversations 集合: {col_id}")
    except Exception as e:
        print(f"❌ ChromaDB 连接失败: {e}")
        sys.exit(1)

    # 3. 分页拉取所有记录
    all_records = []
    limit = 500
    offset = 0
    while True:
        url = f"{CHROMA_BASE}/{col_id}/get"
        try:
            data = post(url, {
                "limit": limit,
                "offset": offset,
                "include": ["metadatas", "documents"],
            })
        except Exception as e:
            print(f"❌ 拉取记录失败 (offset={offset}): {e}")
            break

        ids = data.get("ids", [])
        if not ids:
            break
        all_records.extend(zip(ids, data.get("metadatas", []), data.get("documents", [""] * len(ids))))
        offset += len(ids)
        if len(ids) < limit:
            break

    print(f"总记录数: {len(all_records)}")

    # 4. 逐条处理
    tagged, skipped, updated, failed = 0, 0, 0, 0
    for doc_id, metadata, document in all_records:
        # 已有 entityTags 且非空 → 跳过
        existing = metadata.get("entityTags", "")
        if existing:
            skipped += 1
            continue

        # 用 prompt + response 做实体匹配
        prompt_text = metadata.get("prompt", "")
        response_text = metadata.get("response", "")
        combined = f"{prompt_text} {response_text}"
        if not combined.strip():
            combined = document or ""

        tags = extract_entity_tags(combined, kuzu_entities)
        if not tags:
            tagged += 1  # 无匹配实体，标记为空字符串
            continue

        # 更新 metadata
        try:
            url = f"{CHROMA_BASE}/{col_id}/update"
            post(url, {
                "ids": [doc_id],
                "metadatas": [{"entityTags": ",".join(tags)}],
            })
            updated += 1
            if updated % 50 == 0:
                print(f"  已处理 {updated} 条...")
            time.sleep(0.02)  # 避免 ChromaDB 过载
        except Exception as e:
            failed += 1
            print(f"  ❌ 更新失败 {doc_id}: {e}")

    print(f"\n完成：总 {len(all_records)} 条")
    print(f"  已有 entityTags 跳过: {skipped}")
    print(f"  无匹配实体: {tagged}")
    print(f"  新增 entityTags: {updated}")
    print(f"  失败: {failed}")

if __name__ == "__main__":
    main()
    os._exit(0)  # Kuzu SIGBUS 规避
