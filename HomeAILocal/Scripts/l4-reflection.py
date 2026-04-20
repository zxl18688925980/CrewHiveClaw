#!/usr/bin/env python3
"""
L4 后置效果验证：记录 / 回查 / 复盘 L4 改进动作

用法：
  # 记录一次 L4 改进动作（完成后立即写）
  python3 l4-reflection.py --record \
      --action "结晶了 wecom-retry-skill" \
      --expected "同类任务 Lisa 重试次数从 3 降至 1" \
      --measurement "30天后查 spec_reflection 中 wecom 相关失败率"

  # 查看到期待回查的条目
  python3 l4-reflection.py --check

  # 完成复盘（HEARTBEAT 检查 13 到期后调用）
  python3 l4-reflection.py --complete \
      --id "l4_action_20260421_143022_abc123" \
      --outcome effective \
      --reason "wecom 相关 spec_reflection 失败率从 40% 降至 12%"
"""
import chromadb, json, sys, argparse, uuid, requests
from datetime import datetime, timedelta

CHROMA_BASE = 'http://localhost:8001/api/v2/tenants/default_tenant/databases/default_database/collections'
EMBED_URL   = 'http://localhost:11434/api/embed'
DAYS_UNTIL_CHECKPOINT = 30


def get_embedding(text: str) -> list:
    try:
        r = requests.post(EMBED_URL,
                          json={"model": "nomic-embed-text", "input": text},
                          timeout=15)
        r.raise_for_status()
        return r.json()["embeddings"][0]
    except Exception:
        return [0.0] * 768


def get_collection_id(name: str) -> str:
    r = requests.get(f"{CHROMA_BASE}/{name}", timeout=10)
    if r.status_code != 200:
        raise RuntimeError(f"集合 {name} 不存在: {r.status_code}")
    return r.json()['id']


def chroma_upsert(doc_id: str, document: str, metadata: dict):
    cid = get_collection_id('decisions')
    embedding = get_embedding(document)
    r = requests.post(f"{CHROMA_BASE}/{cid}/upsert", json={
        'ids':        [doc_id],
        'documents':  [document],
        'metadatas':  [metadata],
        'embeddings': [embedding],
    }, timeout=15)
    if r.status_code not in (200, 201):
        raise RuntimeError(f"ChromaDB upsert 失败 {r.status_code}: {r.text[:200]}")


def cmd_record(args):
    if not args.action or not args.expected:
        print(json.dumps({'error': '--action 和 --expected 为必填项'}))
        sys.exit(1)

    now = datetime.now()
    doc_id = f"l4_action_{now.strftime('%Y%m%d_%H%M%S')}_{uuid.uuid4().hex[:6]}"
    checkpoint = (now + timedelta(days=DAYS_UNTIL_CHECKPOINT)).isoformat()

    document = (
        f"[L4改进动作] {args.action}\n"
        f"预期效果: {args.expected}\n"
        f"验证方式: {args.measurement or '待定'}"
    )
    metadata = {
        'type':             'l4_improvement_action',
        'agent':            'andy',
        'action':           args.action[:500],
        'expected_outcome': args.expected[:500],
        'measurement':      (args.measurement or '')[:300],
        'checkpoint_date':  checkpoint,
        'status':           'pending',
        'timestamp':        now.isoformat(),
    }

    chroma_upsert(doc_id, document, metadata)
    print(json.dumps({
        'status':          'recorded',
        'id':              doc_id,
        'checkpoint_date': checkpoint,
        'message':         f'已记录 L4 改进动作，{DAYS_UNTIL_CHECKPOINT} 天后需回查效果'
    }, ensure_ascii=False, indent=2))


def cmd_check():
    c = chromadb.HttpClient(host='localhost', port=8001)
    col = c.get_collection('decisions')
    now = datetime.now()

    r = col.get(
        where={'$and': [
            {'type':   {'$eq': 'l4_improvement_action'}},
            {'status': {'$eq': 'pending'}},
        ]},
        include=['metadatas', 'documents'],
        limit=100
    )

    expired, pending = [], []
    for doc_id, doc, meta in zip(
        r.get('ids', []), r.get('documents', []), r.get('metadatas', [])
    ):
        cp = meta.get('checkpoint_date', '')
        item = {
            'id':              doc_id,
            'action':          meta.get('action', ''),
            'expected':        meta.get('expected_outcome', ''),
            'measurement':     meta.get('measurement', ''),
            'checkpoint_date': cp,
            'recorded_at':     meta.get('timestamp', ''),
        }
        try:
            if cp and datetime.fromisoformat(cp) <= now:
                expired.append(item)
            else:
                pending.append(item)
        except ValueError:
            pending.append(item)

    print(json.dumps({
        'expired_count': len(expired),
        'pending_count': len(pending),
        'expired':  expired,
        'pending':  pending[:5],
        'message': (
            f'有 {len(expired)} 条到期待复盘，用 --complete --id <id> --outcome effective/ineffective --reason <原因> 完成复盘'
            if expired else '暂无到期条目'
        )
    }, ensure_ascii=False, indent=2))


def cmd_complete(args):
    if not args.id or not args.outcome:
        print(json.dumps({'error': '--id 和 --outcome 为必填项'}))
        sys.exit(1)

    c = chromadb.HttpClient(host='localhost', port=8001)
    col = c.get_collection('decisions')
    r = col.get(ids=[args.id], include=['metadatas', 'documents'])

    if not r.get('ids'):
        print(json.dumps({'error': f'找不到 id={args.id}'}))
        sys.exit(1)

    old_meta = r['metadatas'][0]
    old_doc  = r['documents'][0]
    new_meta = {
        **old_meta,
        'status':       'completed',
        'outcome':      args.outcome,
        'review_reason': (args.reason or '')[:500],
        'completed_at': datetime.now().isoformat(),
    }
    new_doc = old_doc + f"\n\n复盘结论: {args.outcome} — {args.reason or '无说明'}"

    chroma_upsert(args.id, new_doc, new_meta)
    print(json.dumps({
        'status':  'completed',
        'outcome': args.outcome,
        'message': '复盘已写入，L4 动作闭环完成'
    }, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description='L4 后置效果验证')
    sub = parser.add_subparsers(dest='cmd')

    # --record
    p_rec = sub.add_parser('--record', help='记录改进动作（也可直接传同名参数）')

    parser.add_argument('--record',      action='store_true')
    parser.add_argument('--check',       action='store_true')
    parser.add_argument('--complete',    action='store_true')
    parser.add_argument('--action',      type=str, default='')
    parser.add_argument('--expected',    type=str, default='')
    parser.add_argument('--measurement', type=str, default='')
    parser.add_argument('--id',          type=str, default='')
    parser.add_argument('--outcome',     type=str, default='',
                        choices=['effective', 'ineffective', ''])
    parser.add_argument('--reason',      type=str, default='')

    args = parser.parse_args()

    if args.record:
        cmd_record(args)
    elif args.check:
        cmd_check()
    elif args.complete:
        cmd_complete(args)
    else:
        parser.print_help()
        sys.exit(1)

    sys.stdout.flush()


if __name__ == '__main__':
    main()
