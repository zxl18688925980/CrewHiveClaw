import chromadb, json, sys
c = chromadb.HttpClient(host='localhost', port=8001)
col = c.get_collection('decisions')
types = ['design_learning', 'impl_learning', 'learning_objective', 'knowledge_injection']
counts = {}
for t in types:
    try:
        r = col.get(where={'type': {'$eq': t}}, include=[])
        counts[t] = len(r.get('ids', []))
    except:
        counts[t] = -1
print(json.dumps(counts))
sys.stdout.flush()