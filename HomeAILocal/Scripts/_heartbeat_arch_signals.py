import chromadb, json, sys
c = chromadb.HttpClient(host='localhost', port=8001)
col = c.get_collection('decisions')
signal_types = ['spec_reflection', 'capability_gap_proposal', 'architecture_drift', 'spec_retrospective']
signals = []
for t in signal_types:
  try:
    r = col.get(where={'$and': [{'type': {'$eq': t}}, {'agent': {'$eq': 'andy'}}]}, limit=10, include=['metadatas','documents'])
    for rid, doc, meta in zip(r.get('ids',[]), r.get('documents',[]), r.get('metadatas',[])):
      signals.append({'type': t, 'id': rid, 'doc': doc[:200], 'ts': meta.get('timestamp','')})
  except:
    pass
print(json.dumps({'total': len(signals), 'signals': signals[-10:]}, ensure_ascii=False))
sys.stdout.flush()