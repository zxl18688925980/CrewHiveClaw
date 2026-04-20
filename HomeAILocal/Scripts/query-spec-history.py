#!/usr/bin/env python3
"""
L1 前置质控：查询同域历史 spec_reflection 失败记录

Andy 在步骤 1.8 调用，写 spec 前了解同域历史失败模式。

用法：
  python3 query-spec-history.py --domain <关键词>
  python3 query-spec-history.py --file <文件路径关键词>
  python3 query-spec-history.py --domain wecom --file index.ts
"""
import chromadb, json, sys, argparse

FAILURE_KEYWORDS = ['失败', '拒绝', '回退', '阻塞', 'failed', 'rejected', 'reverted', 'blocked', '错误', 'error']


def main():
    parser = argparse.ArgumentParser(description='查询 spec_reflection 历史失败记录')
    parser.add_argument('--domain', type=str, default='', help='域关键词（模块名/功能域）')
    parser.add_argument('--file', type=str, default='', help='集成文件路径关键词')
    parser.add_argument('--limit', type=int, default=5, help='返回条数上限（默认5）')
    parser.add_argument('--all', action='store_true', help='包含成功记录（默认只返回失败）')
    args = parser.parse_args()

    try:
        c = chromadb.HttpClient(host='localhost', port=8001)
        col = c.get_collection('decisions')

        r = col.get(
            where={'type': {'$eq': 'spec_reflection'}},
            include=['metadatas', 'documents'],
            limit=200
        )

        keywords = [k.lower() for k in [args.domain, args.file] if k.strip()]
        entries = []
        for doc_id, doc, meta in zip(
            r.get('ids', []), r.get('documents', []), r.get('metadatas', [])
        ):
            combined = (doc + ' ' + json.dumps(meta, ensure_ascii=False)).lower()
            # 域/文件过滤
            if keywords and not any(kw in combined for kw in keywords):
                continue
            is_failure = any(kw in combined for kw in FAILURE_KEYWORDS)
            entries.append({'id': doc_id, 'doc': doc[:400], 'meta': meta, 'is_failure': is_failure})

        failures = [e for e in entries if e['is_failure']]
        successes = [e for e in entries if not e['is_failure']]

        result = {
            'total_matched': len(entries),
            'failure_count': len(failures),
            'success_count': len(successes),
            'failures': [{'id': e['id'], 'doc': e['doc'], 'meta': e['meta']}
                         for e in failures[-args.limit:]],
        }
        if args.all:
            result['successes'] = [{'id': e['id'], 'doc': e['doc'][:200]}
                                    for e in successes[-3:]]

        if not failures:
            result['message'] = '无历史失败记录，可直接进行 spec 设计'
        else:
            result['message'] = (
                f'发现 {len(failures)} 条失败记录——请在 spec 中列出「已知风险约束」，'
                '避免同一模块重复踩坑'
            )

        print(json.dumps(result, ensure_ascii=False, indent=2))

    except Exception as e:
        print(json.dumps({
            'error': str(e),
            'failure_count': 0,
            'message': 'ChromaDB 查询失败，跳过前置质控'
        }, ensure_ascii=False))

    sys.stdout.flush()


if __name__ == '__main__':
    main()
