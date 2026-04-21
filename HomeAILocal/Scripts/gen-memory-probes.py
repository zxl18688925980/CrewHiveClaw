#!/usr/bin/env python3
"""
记忆 probe 集生成器（真实数据直接提取版）

从 ChromaDB 三个集合抽取真实历史数据构建 ground truth 评测集，不使用 LLM 生成合成 query。
生成的 probe 存入 ~/HomeAI/Data/learning/memory-probes.jsonl，供 eval-memory-probes.py 评测。

数据提取策略：
  conversations  → 取 90 天前的真实人类消息（fromType=human），消息文本即 query
  decisions      → 取决策记录，文档摘要即 query
  requirements   → 取 outcome='' 且 >30 天的未落地需求，需求文本即 query

用法：
  # 三个集合各采 10 条（默认）
  python3 gen-memory-probes.py --all

  # 只生成 conversations 的 probe
  python3 gen-memory-probes.py --collection conversations --n 15

  # 查看现有 probe 集统计
  python3 gen-memory-probes.py --review

  # 清理失效 probe（ground_truth_id 已不在 ChromaDB 中）
  python3 gen-memory-probes.py --prune
"""

import argparse
import json
import os
import random
import sys
import uuid
from datetime import datetime, timezone, timedelta

import requests

CHROMA_BASE = 'http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections'
PROBE_FILE  = os.path.expanduser('~/HomeAI/Data/learning/memory-probes.jsonl')

# 时间阈值
CONVERSATIONS_DAYS = 90   # conversations 取 N 天前的消息
REQUIREMENTS_DAYS  = 30   # requirements 取 N 天前未落地的需求

COLLECTIONS = {
    'conversations': {
        'label':       'Lucas 对话记忆',
        'entity_field': 'entityTags',
    },
    'decisions': {
        'label':       'Andy 决策记忆',
        'entity_field': 'agent',
    },
    'requirements': {
        'label':       '未落地需求',
        'entity_field': 'owner',
    },
}


def get_collection_id(name: str) -> str:
    r = requests.get(f'{CHROMA_BASE}/{name}', timeout=10)
    if r.status_code != 200:
        raise RuntimeError(f'集合 {name} 不存在: {r.status_code}')
    return r.json()['id']


def fetch_records(col_id: str, limit: int = 500) -> list:
    """分批拉取，处理 ChromaDB limit 限制"""
    all_records = []
    offset = 0
    batch = min(limit, 200)
    while True:
        r = requests.post(f'{CHROMA_BASE}/{col_id}/get',
                          json={'limit': batch, 'offset': offset, 'include': ['documents', 'metadatas']},
                          timeout=20)
        if r.status_code != 200:
            raise RuntimeError(f'读取记录失败: {r.status_code}')
        data  = r.json()
        ids   = data.get('ids', [])
        docs  = data.get('documents', [])
        metas = data.get('metadatas', [])
        if not ids:
            break
        all_records.extend({'id': ids[i], 'doc': docs[i], 'meta': metas[i]} for i in range(len(ids)))
        if len(ids) < batch or len(all_records) >= limit:
            break
        offset += batch
    return all_records


def record_exists(col_id: str, record_id: str) -> bool:
    r = requests.post(f'{CHROMA_BASE}/{col_id}/get',
                      json={'ids': [record_id], 'include': ['documents']},
                      timeout=10)
    if r.status_code != 200:
        return False
    return len(r.json().get('ids', [])) > 0


def parse_ts(ts_raw) -> float:
    """解析时间戳为毫秒（支持 ISO 字符串和整数毫秒两种格式）"""
    if not ts_raw:
        return 0.0
    if isinstance(ts_raw, (int, float)):
        return float(ts_raw)
    try:
        dt = datetime.fromisoformat(str(ts_raw).replace('Z', '+00:00'))
        return dt.timestamp() * 1000
    except Exception:
        return 0.0


def extract_conversations_probes(records: list, n: int, existing_ids: set) -> list:
    """conversations：取 90 天前真实人类消息"""
    cutoff_ms = (datetime.now(timezone.utc) - timedelta(days=CONVERSATIONS_DAYS)).timestamp() * 1000
    candidates = []
    for rec in records:
        if rec['id'] in existing_ids:
            continue
        meta = rec.get('meta') or {}
        if meta.get('fromType') != 'human':
            continue
        ts = parse_ts(meta.get('timestamp'))
        if ts == 0.0 or ts >= cutoff_ms:
            continue
        doc = (rec.get('doc') or '').strip()
        if len(doc) < 10:
            continue
        candidates.append(rec)
    return random.sample(candidates, min(n, len(candidates)))


def extract_decisions_probes(records: list, n: int, existing_ids: set) -> list:
    """decisions：取决策文档（无特殊时间过滤）"""
    candidates = [
        rec for rec in records
        if rec['id'] not in existing_ids and len((rec.get('doc') or '').strip()) >= 20
    ]
    return random.sample(candidates, min(n, len(candidates)))


def extract_requirements_probes(records: list, n: int, existing_ids: set) -> list:
    """requirements：取 outcome='' 且 >30 天的未落地需求"""
    cutoff_ms = (datetime.now(timezone.utc) - timedelta(days=REQUIREMENTS_DAYS)).timestamp() * 1000
    candidates = []
    for rec in records:
        if rec['id'] in existing_ids:
            continue
        meta = rec.get('meta') or {}
        outcome = meta.get('outcome', '')
        if outcome and outcome.strip():
            continue  # 已有结果，跳过
        ts = parse_ts(meta.get('timestamp'))
        # 无时间戳保守纳入（可能是旧数据）；有时间戳则要求超过 30 天
        if ts != 0.0 and ts >= cutoff_ms:
            continue
        doc = (rec.get('doc') or '').strip()
        if len(doc) < 10:
            continue
        candidates.append(rec)
    return random.sample(candidates, min(n, len(candidates)))


EXTRACT_FN = {
    'conversations': extract_conversations_probes,
    'decisions':     extract_decisions_probes,
    'requirements':  extract_requirements_probes,
}


def build_probe(rec: dict, col_name: str) -> dict:
    """从真实记录直接构建 probe，query = 文档前 120 字"""
    doc = (rec.get('doc') or '').strip()
    query = doc[:120].strip()
    cfg   = COLLECTIONS[col_name]
    probe = {
        'id':              f'probe_{datetime.now().strftime("%Y%m%d_%H%M%S")}_{uuid.uuid4().hex[:6]}',
        'collection':      col_name,
        'query':           query,
        'ground_truth_id': rec['id'],
        'doc_preview':     doc[:200],
        'created_at':      datetime.now().isoformat(),
        'created_by':      'real_data',
        'tags':            [],
    }
    entity_val = (rec.get('meta') or {}).get(cfg['entity_field'], '')
    if entity_val:
        probe['tags'].append(f'entity:{str(entity_val)[:30]}')
    return probe


def load_existing_probes() -> list:
    if not os.path.exists(PROBE_FILE):
        return []
    probes = []
    with open(PROBE_FILE, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    probes.append(json.loads(line))
                except json.JSONDecodeError:
                    pass
    return probes


def save_probe(probe: dict):
    os.makedirs(os.path.dirname(PROBE_FILE), exist_ok=True)
    with open(PROBE_FILE, 'a', encoding='utf-8') as f:
        f.write(json.dumps(probe, ensure_ascii=False) + '\n')


def cmd_review():
    probes = load_existing_probes()
    if not probes:
        print('probe 集为空，请先运行 --all 生成')
        return
    by_col = {}
    for p in probes:
        col = p.get('collection', '未知')
        by_col.setdefault(col, []).append(p)
    print(f'probe 集合计：{len(probes)} 条')
    for col, ps in by_col.items():
        src_counts = {}
        for p in ps:
            src = p.get('created_by', '未知')
            src_counts[src] = src_counts.get(src, 0) + 1
        src_str = '  '.join(f'{k}:{v}' for k, v in src_counts.items())
        print(f'  {col}：{len(ps)} 条（{src_str}）')
        for p in ps[:3]:
            print(f'    [{p["id"][-8:]}] {p["query"][:60]}')
        if len(ps) > 3:
            print(f'    ...（共 {len(ps)} 条）')


def cmd_prune():
    probes = load_existing_probes()
    if not probes:
        print('probe 集为空')
        return
    kept, pruned = [], []
    for p in probes:
        col_name = p.get('collection', '')
        gt_id    = p.get('ground_truth_id', '')
        try:
            col_id = get_collection_id(col_name)
            if record_exists(col_id, gt_id):
                kept.append(p)
            else:
                pruned.append(p)
                print(f'  [prune] {p["id"]}: ground truth 已不存在 → 移除')
        except Exception as e:
            print(f'  [warn] 检查 {p["id"]} 失败：{e}，保留')
            kept.append(p)
    with open(PROBE_FILE, 'w', encoding='utf-8') as f:
        for p in kept:
            f.write(json.dumps(p, ensure_ascii=False) + '\n')
    print(f'完成：保留 {len(kept)} 条，移除 {len(pruned)} 条')


def cmd_generate(target_collections: list, n: int):
    existing     = load_existing_probes()
    existing_ids = {p['ground_truth_id'] for p in existing}

    total_added = 0
    for col_name in target_collections:
        cfg = COLLECTIONS[col_name]
        print(f'\n── {cfg["label"]} ({col_name}) ──')
        try:
            col_id  = get_collection_id(col_name)
            records = fetch_records(col_id)
        except Exception as e:
            print(f'  [error] {e}')
            continue

        extract_fn = EXTRACT_FN.get(col_name)
        if not extract_fn:
            print(f'  [skip] 未配置提取策略')
            continue

        sample = extract_fn(records, n, existing_ids)
        if not sample:
            print(f'  无符合条件的记录（共 {len(records)} 条），跳过')
            continue
        print(f'  从 {len(records)} 条中筛选出 {len(sample)} 条生成 probe...')

        added = 0
        for rec in sample:
            probe = build_probe(rec, col_name)
            if not probe['query']:
                continue
            save_probe(probe)
            existing_ids.add(rec['id'])
            added += 1
            print(f'  [{added}/{len(sample)}] {probe["query"][:60]}')

        total_added += added
        print(f'  已生成 {added} 条 probe')

    print(f'\n完成：本次新增 {total_added} 条 probe，总计 {len(existing) + total_added} 条')
    print(f'文件：{PROBE_FILE}')


def main():
    parser = argparse.ArgumentParser(description='记忆 probe 集生成器（真实数据直接提取）')
    parser.add_argument('--all',        action='store_true', help='三个集合各采样 n 条')
    parser.add_argument('--collection', type=str, choices=list(COLLECTIONS.keys()), help='指定集合')
    parser.add_argument('--n',          type=int, default=10, help='每个集合采样条数（默认10）')
    parser.add_argument('--review',     action='store_true', help='查看现有 probe 统计')
    parser.add_argument('--prune',      action='store_true', help='清理失效 probe')
    args = parser.parse_args()

    if args.review:
        cmd_review()
    elif args.prune:
        cmd_prune()
    elif args.all:
        cmd_generate(list(COLLECTIONS.keys()), args.n)
    elif args.collection:
        cmd_generate([args.collection], args.n)
    else:
        parser.print_help()
        sys.exit(1)

    sys.stdout.flush()


if __name__ == '__main__':
    main()
