import kuzu, os, json, sys
db = kuzu.Database(os.path.expanduser('~/HomeAI/data/kuzu'))
conn = kuzu.Connection(db)
res = conn.execute(
    "MATCH (a:Entity {id: 'andy'})-[f:Fact {relation: 'has_pattern'}]->(p:Entity {type: 'pattern'}) "
    "WHERE f.valid_until IS NULL AND f.confidence >= 0.8 "
    "RETURN p.name, p.id, f.context, f.confidence ORDER BY f.confidence DESC"
)
rows = []
while res.has_next():
    row = res.get_next()
    rows.append({'name': row[0], 'id': row[1], 'context': row[2], 'confidence': row[3]})
print(json.dumps(rows, ensure_ascii=False))
sys.stdout.flush()  # os._exit(0) bypasses buffer flush; must flush explicitly
os._exit(0)  # bypass kuzu Database::~Database() SIGBUS on macOS ARM64