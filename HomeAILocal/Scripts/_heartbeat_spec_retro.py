import chromadb, json, sys
c = chromadb.HttpClient(host='localhost', port=8001)
try:
  col = c.get_collection('codebase_patterns')
  r = col.get(where={'$and': [{'type': {'$eq': 'spec_result'}}]}, limit=20, include=['metadatas','documents'])
  entries = [{'id': rid, 'doc': doc[:200], 'meta': meta} for rid, doc, meta in zip(r.get('ids',[]), r.get('documents',[]), r.get('metadatas',[]))]
  print(json.dumps({'count': len(entries), 'entries': entries[-10:]}, ensure_ascii=False))
except Exception as e:
  print(json.dumps({'count': 0, 'error': str(e)}))
sys.stdout.flush()