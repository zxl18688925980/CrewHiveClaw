import chromadb, json, sys
c = chromadb.HttpClient(host='localhost', port=8001)
col = c.get_collection('decisions')
res = col.get(where={'$and': [{'type': {'$eq': 'learning_objective'}}, {'agent': {'$eq': 'andy'}}]},
              include=['documents', 'metadatas'])
items = []
for doc, meta in zip(res.get('documents', []), res.get('metadatas', [])):
    items.append({'topic': meta.get('topic', ''), 'document': doc, 'timestamp': meta.get('timestamp', '')})
items.sort(key=lambda x: x['timestamp'])
print(json.dumps(items, ensure_ascii=False))
sys.stdout.flush()