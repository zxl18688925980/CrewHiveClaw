#!/usr/bin/env python3
"""
为现有 ChromaDB conversations 记录补充 entityTags 元数据。
从 Kuzu 加载实体名 → 在对话内容中匹配（精确 + 反向话题匹配） → 更新 metadata.entityTags。
--force: 强制重新处理所有记录（覆盖已有 entityTags）
一次性脚本，运行后可删除。
"""
import json, sys, os, time, argparse
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
    """从 Kuzu 加载所有 Entity 节点的 name→(id, type) 映射"""
    import kuzu
    db = kuzu.Database(KUZU_DB, read_only=True)
    conn = kuzu.Connection(db)
    result = conn.execute("MATCH (e:Entity) RETURN e.id, e.name, e.type")
    entities = {}  # name → (id, type)
    while True:
        try:
            row = result.get_next()
            eid, name, etype = row[0], row[1], row[2]
            if name and len(name) >= 2:
                entities[name] = (eid, etype)
        except:
            break
    print(f"Kuzu 实体加载完成: {len(entities)} 个名字")
    return entities

def extract_entity_tags(text, kuzu_entities):
    """从文本中提取匹配的实体 ID 列表（精确匹配 + 反向话题匹配）"""
    tags = set()
    lower = text.lower()[:800]  # 限制扫描长度

    # 1. 别名匹配
    for alias, eid in ENTITY_ALIAS_MAP.items():
        if alias in text:
            tags.add(eid)

    # 2. Kuzu Entity name 精确匹配（实体名 ⊂ 文本）
    sorted_names = sorted(kuzu_entities.keys(), key=len, reverse=True)
    for name in sorted_names:
        eid, etype = kuzu_entities[name]
        if len(name) >= 3 and name in text:
            tags.add(eid)

    # 3. 反向话题匹配（文本关键词 ⊂ 实体名）
    # 对 topic 类型实体，用滑动窗口提取 2-4 字片段，检查文本是否包含
    topic_hits = []
    for name, (eid, etype) in kuzu_entities.items():
        if tags.intersection({eid}):  # 已精确匹配
            continue
        if not eid.startswith("topic_"):
            continue
        if len(name) < 4:
            continue
        name_lower = name.lower()
        # 从最长片段(4字)到最短(2字)
        for seg_len in range(min(4, len(name_lower)), 1, -1):
            matched = False
            for i in range(len(name_lower) - seg_len + 1):
                seg = name_lower[i:i + seg_len]
                if len(seg) >= 2 and seg in lower:
                    topic_hits.append(eid)
                    matched = True
                    break
            if matched:
                break
        if len(topic_hits) >= 10:
            break

    tags.update(topic_hits)
    return list(tags)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--force", action="store_true", help="强制重新处理所有记录")
    args = parser.parse_args()

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
        # 已有 entityTags 且非空 → 跳过（除非 --force）
        existing = metadata.get("entityTags", "")
        if existing and not args.force:
            skipped += 1
            continue

        # 用 prompt + response 做实体匹配
        prompt_text = metadata.get("prompt", "")
        response_text = metadata.get("response", "")
        combined = f"{prompt_text} {response_text}"
        if not combined.strip():
            combined = document or ""

        tags = extract_entity_tags(combined, kuzu_entities)
        new_tags = ",".join(tags)

        # --force 且新 tags 与旧 tags 相同 → 跳过
        if existing and args.force and existing == new_tags:
            skipped += 1
            continue

        if not tags:
            if args.force and existing:
                # --force 模式下清空旧 tags（如果新匹配为空）
                pass
            tagged += 1
            continue

        # 更新 metadata
        try:
            url = f"{CHROMA_BASE}/{col_id}/update"
            post(url, {
                "ids": [doc_id],
                "metadatas": [{"entityTags": new_tags}],
            })
            updated += 1
            if updated % 100 == 0:
                print(f"  已处理 {updated} 条...")
            time.sleep(0.01)  # 避免 ChromaDB 过载
        except Exception as e:
            failed += 1
            print(f"  ❌ 更新失败 {doc_id}: {e}")

    print(f"\n完成：总 {len(all_records)} 条")
    print(f"  跳过（tags 无变化）: {skipped}")
    print(f"  无匹配实体: {tagged}")
    print(f"  新增/更新 entityTags: {updated}")
    print(f"  失败: {failed}")

if __name__ == "__main__":
    main()
    os._exit(0)  # Kuzu SIGBUS 规避
