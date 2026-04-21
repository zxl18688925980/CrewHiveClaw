#!/usr/bin/env python3
"""
记忆召回评测（Hit Rate@K + MRR）

读取 memory-probes.jsonl，对每个 probe 做语义检索，计算 Hit Rate@1/3/5 和 MRR。
结果写入 memory-probe-results.jsonl，可集成到 evaluate_l1。

用法：
  # 评测所有 probe
  python3 eval-memory-probes.py

  # 只评测某集合
  python3 eval-memory-probes.py --collection conversations

  # 调整 K 值
  python3 eval-memory-probes.py --k 5

  # 输出 JSON（供 evaluate_l1 调用）
  python3 eval-memory-probes.py --json
"""

import argparse
import json
import os
import sys
from datetime import datetime

import requests

CHROMA_BASE  = 'http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections'
OLLAMA_EMBED = 'http://localhost:11434/api/embed'
PROBE_FILE   = os.path.expanduser('~/HomeAI/Data/learning/memory-probes.jsonl')
RESULT_FILE  = os.path.expanduser('~/HomeAI/Data/learning/memory-probe-results.jsonl')
EMBED_MODEL  = 'nomic-embed-text'


def get_collection_id(name: str) -> str:
    r = requests.get(f'{CHROMA_BASE}/{name}', timeout=10)
    if r.status_code != 200:
        raise RuntimeError(f'集合 {name} 不存在: {r.status_code}')
    return r.json()['id']


def get_embedding(text: str) -> list:
    r = requests.post(OLLAMA_EMBED,
                      json={'model': EMBED_MODEL, 'input': text},
                      timeout=15)
    r.raise_for_status()
    return r.json()['embeddings'][0]


def query_top_k(col_id: str, embedding: list, k: int) -> list:
    """返回 top-K 的 id 列表"""
    r = requests.post(f'{CHROMA_BASE}/{col_id}/query',
                      json={
                          'query_embeddings': [embedding],
                          'n_results':        k,
                          'include':          ['distances'],
                      },
                      timeout=15)
    r.raise_for_status()
    return r.json().get('ids', [[]])[0]


def load_probes(collection_filter: str = None) -> list:
    if not os.path.exists(PROBE_FILE):
        return []
    probes = []
    with open(PROBE_FILE, encoding='utf-8') as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                p = json.loads(line)
                if collection_filter and p.get('collection') != collection_filter:
                    continue
                probes.append(p)
            except json.JSONDecodeError:
                pass
    return probes


def compute_metrics(hits_at_k: dict, reciprocal_ranks: list, total: int) -> dict:
    """计算各指标"""
    result = {'total': total}
    for k, hits in hits_at_k.items():
        result[f'hit_rate_{k}'] = round(hits / total, 4) if total > 0 else 0.0
    result['mrr'] = round(sum(reciprocal_ranks) / total, 4) if total > 0 else 0.0
    return result


def run_eval(probes: list, k_values: list, verbose: bool = False) -> dict:
    """运行评测，返回按集合分组的指标"""
    # 缓存 collection_id
    col_id_cache = {}

    # 按集合分组
    by_col = {}
    for p in probes:
        col = p.get('collection', '')
        by_col.setdefault(col, []).append(p)

    all_results = {}
    global_hits   = {k: 0 for k in k_values}
    global_rr     = []
    global_total  = 0
    global_errors = 0

    max_k = max(k_values)

    for col_name, col_probes in by_col.items():
        hits_at_k = {k: 0 for k in k_values}
        rr_list   = []
        errors    = 0

        # 获取 collection ID
        try:
            if col_name not in col_id_cache:
                col_id_cache[col_name] = get_collection_id(col_name)
            col_id = col_id_cache[col_name]
        except Exception as e:
            print(f'  [error] 集合 {col_name} 不可达：{e}', file=sys.stderr)
            all_results[col_name] = {'error': str(e), 'total': len(col_probes)}
            continue

        if verbose:
            print(f'\n── {col_name}（{len(col_probes)} 条 probe）──')

        for i, probe in enumerate(col_probes):
            query   = probe.get('query', '')
            gt_id   = probe.get('ground_truth_id', '')
            probe_id = probe.get('id', f'probe_{i}')

            if not query or not gt_id:
                errors += 1
                continue

            try:
                emb     = get_embedding(query)
                top_ids = query_top_k(col_id, emb, max_k)

                # 计算各 K 的 hit
                hit_pos = None
                for pos, rid in enumerate(top_ids, start=1):
                    if rid == gt_id:
                        hit_pos = pos
                        break

                for k in k_values:
                    if hit_pos is not None and hit_pos <= k:
                        hits_at_k[k] += 1

                rr = (1.0 / hit_pos) if hit_pos else 0.0
                rr_list.append(rr)

                if verbose:
                    status = f'Hit@{hit_pos}' if hit_pos else 'Miss'
                    print(f'  [{i+1}/{len(col_probes)}] {status:8s} | {query[:50]}')

            except Exception as e:
                errors += 1
                rr_list.append(0.0)
                if verbose:
                    print(f'  [{i+1}/{len(col_probes)}] Error    | {query[:40]}... ({e})', file=sys.stderr)

        total = len(col_probes)
        metrics = compute_metrics(hits_at_k, rr_list, total)
        metrics['errors'] = errors
        all_results[col_name] = metrics

        # 累计全局
        for k in k_values:
            global_hits[k] += hits_at_k[k]
        global_rr    += rr_list
        global_total += total
        global_errors += errors

        if verbose:
            print(f'  结果：', end='')
            for k in k_values:
                print(f'Hit@{k}={metrics[f"hit_rate_{k}"]:.3f}  ', end='')
            print(f'MRR={metrics["mrr"]:.3f}  (共{total}条, {errors}失败)')

    # 全局汇总
    all_results['overall'] = compute_metrics(global_hits, global_rr, global_total)
    all_results['overall']['errors'] = global_errors
    all_results['overall']['total']  = global_total

    return all_results


def save_result(results: dict, k_values: list, collection_filter: str):
    record = {
        'evaluated_at':       datetime.now().isoformat(),
        'k_values':           k_values,
        'collection_filter':  collection_filter,
        'results':            results,
    }
    os.makedirs(os.path.dirname(RESULT_FILE), exist_ok=True)
    with open(RESULT_FILE, 'a', encoding='utf-8') as f:
        f.write(json.dumps(record, ensure_ascii=False) + '\n')
    return record


def print_summary(results: dict, k_values: list):
    print('\n' + '=' * 55)
    print('记忆召回评测结果')
    print('=' * 55)
    header = f'{"集合":<20}' + ''.join(f'Hit@{k:<6}' for k in k_values) + 'MRR     Total'
    print(header)
    print('-' * 55)
    for col, m in results.items():
        if 'error' in m:
            print(f'{col:<20} 不可达：{m["error"][:30]}')
            continue
        row = f'{col:<20}'
        for k in k_values:
            row += f'{m.get(f"hit_rate_{k}", 0):.3f}   '
        row += f'{m.get("mrr", 0):.3f}   {m.get("total", 0)}'
        if m.get('errors', 0) > 0:
            row += f'  ({m["errors"]}失败)'
        print(row)
    print('=' * 55)


def main():
    parser = argparse.ArgumentParser(description='记忆召回评测')
    parser.add_argument('--collection', type=str, default=None,
                        choices=['conversations', 'decisions', 'code_history'],
                        help='只评测指定集合')
    parser.add_argument('--k',          type=int, nargs='+', default=[1, 3, 5],
                        help='K 值列表（默认 1 3 5）')
    parser.add_argument('--json',       action='store_true', help='只输出 JSON 结果（供脚本调用）')
    parser.add_argument('--no-save',    action='store_true', help='不写入 result 文件')
    args = parser.parse_args()

    probes = load_probes(args.collection)
    if not probes:
        msg = {'error': 'probe 集为空，请先运行 gen-memory-probes.py --all', 'hit_rate_3': 0, 'mrr': 0}
        if args.json:
            print(json.dumps(msg, ensure_ascii=False))
        else:
            print(msg['error'])
        sys.exit(1)

    if not args.json:
        print(f'加载 {len(probes)} 条 probe，开始评测（K={args.k}）...')

    results = run_eval(probes, args.k, verbose=not args.json)

    if not args.no_save:
        save_result(results, args.k, args.collection)

    if args.json:
        print(json.dumps({
            'evaluated_at': datetime.now().isoformat(),
            'results':      results,
        }, ensure_ascii=False, indent=2))
    else:
        print_summary(results, args.k)
        print(f'\n结果已追加到：{RESULT_FILE}')

    sys.stdout.flush()


if __name__ == '__main__':
    main()
