#!/usr/bin/env python3
"""
记忆 probe 集生成器

从 ChromaDB 三个集合采样记录，用本地 LLM 生成自然语言查询，构建 ground truth 评测集。
生成的 probe 存入 ~/HomeAI/Data/learning/memory-probes.jsonl，供 eval-memory-probes.py 评测。

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
from datetime import datetime

import requests

CHROMA_BASE = 'http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections'
OLLAMA_CHAT = 'http://localhost:11434/api/chat'
PROBE_FILE  = os.path.expanduser('~/HomeAI/Data/learning/memory-probes.jsonl')

COLLECTIONS = {
    'conversations': {
        'label':       'Lucas 对话记忆',
        'entity_field': 'entityTags',
        'gen_hint':    '这是家庭成员和AI的对话记录，请生成一个家庭成员可能问的自然语言问题',
    },
    'decisions': {
        'label':       'Andy 决策记忆',
        'entity_field': 'agent',
        'gen_hint':    '这是技术设计决策或系统架构记录，请生成一个工程师可能问的自然语言问题',
    },
    'code_history': {
        'label':       'Lisa 实现历史',
        'entity_field': 'file',
        'gen_hint':    '这是代码实现或功能交付记录，请生成一个开发者可能问的自然语言问题',
    },
}


def get_collection_id(name: str) -> str:
    r = requests.get(f'{CHROMA_BASE}/{name}', timeout=10)
    if r.status_code != 200:
        raise RuntimeError(f'集合 {name} 不存在: {r.status_code}')
    return r.json()['id']


def fetch_records(col_id: str, limit: int = 200) -> list:
    r = requests.post(f'{CHROMA_BASE}/{col_id}/get',
                      json={'limit': limit, 'include': ['documents', 'metadatas']},
                      timeout=15)
    if r.status_code != 200:
        raise RuntimeError(f'读取记录失败: {r.status_code}')
    data = r.json()
    ids   = data.get('ids', [])
    docs  = data.get('documents', [])
    metas = data.get('metadatas', [])
    return [{'id': ids[i], 'doc': docs[i], 'meta': metas[i]} for i in range(len(ids))]


def record_exists(col_id: str, record_id: str) -> bool:
    r = requests.post(f'{CHROMA_BASE}/{col_id}/get',
                      json={'ids': [record_id], 'include': ['documents']},
                      timeout=10)
    if r.status_code != 200:
        return False
    return len(r.json().get('ids', [])) > 0


def generate_query(doc_preview: str, hint: str) -> str:
    """调用本地 Ollama（qwen3.6）生成探测查询问题"""
    # /no_think 禁用 Qwen3 思考模式，避免 token 全被 thinking 耗尽
    prompt = (
        f'/no_think\n'
        f'{hint}，这个问题检索记忆库时应能找到以下内容。\n'
        '要求：①问题要自然，像真实用户会问的 ②不直接引用原文，用自己的话重述 '
        '③长度 10~30 字 ④只输出问题本身，不加任何解释\n\n'
        f'记忆内容：\n{doc_preview[:400]}\n\n问题：'
    )
    try:
        # 用 homeai-assistant（GGUF，无 thinking 模式）避免 qwen3.6 推理 token 吞噬 content
        r = requests.post(OLLAMA_CHAT, json={
            'model':  'homeai-assistant:latest',
            'stream': False,
            'messages': [{'role': 'user', 'content': prompt}],
            'options': {'temperature': 0.3, 'num_predict': 80},
        }, timeout=60)
        r.raise_for_status()
        content = r.json().get('message', {}).get('content', '').strip()
        # 取第一行（模型可能输出多行解释）
        first_line = content.split('\n')[0].strip()
        return first_line.strip('"\'「」').strip()
    except Exception as e:
        print(f'  [warn] LLM 生成失败，跳过：{e}', file=sys.stderr)
        return ''


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
        print(f'  {col}：{len(ps)} 条')
        for p in ps[:3]:
            print(f'    [{p["id"][-8:]}] {p["query"]}')
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
    # 覆写文件
    with open(PROBE_FILE, 'w', encoding='utf-8') as f:
        for p in kept:
            f.write(json.dumps(p, ensure_ascii=False) + '\n')
    print(f'完成：保留 {len(kept)} 条，移除 {len(pruned)} 条')


def cmd_generate(target_collections: list, n: int):
    existing = load_existing_probes()
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

        # 排除已有 probe 的记录，随机采样
        candidates = [r for r in records if r['id'] not in existing_ids]
        if not candidates:
            print(f'  所有记录已有 probe，跳过')
            continue
        sample = random.sample(candidates, min(n, len(candidates)))
        print(f'  从 {len(records)} 条中采样 {len(sample)} 条生成 probe...')

        added = 0
        for rec in sample:
            doc_preview = (rec['doc'] or '')[:400].strip()
            if not doc_preview:
                continue
            query = generate_query(doc_preview, cfg['gen_hint'])
            if not query:
                continue
            probe = {
                'id':              f'probe_{datetime.now().strftime("%Y%m%d_%H%M%S")}_{uuid.uuid4().hex[:6]}',
                'collection':      col_name,
                'query':           query,
                'ground_truth_id': rec['id'],
                'doc_preview':     doc_preview[:200],
                'created_at':      datetime.now().isoformat(),
                'created_by':      'auto_llm',
                'tags':            [],
            }
            # 提取实体 tag
            entity_val = (rec.get('meta') or {}).get(cfg['entity_field'], '')
            if entity_val:
                probe['tags'].append(f'entity:{str(entity_val)[:30]}')

            save_probe(probe)
            existing_ids.add(rec['id'])
            added += 1
            print(f'  [{added}/{len(sample)}] {query[:60]}')

        total_added += added
        print(f'  已生成 {added} 条 probe')

    print(f'\n完成：本次新增 {total_added} 条 probe，总计 {len(existing) + total_added} 条')
    print(f'文件：{PROBE_FILE}')


def main():
    parser = argparse.ArgumentParser(description='记忆 probe 集生成器')
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
