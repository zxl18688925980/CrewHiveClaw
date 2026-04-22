import kuzu, os, json, sys
sym = "wecom"
db = kuzu.Database(os.path.expanduser('~/HomeAI/Data/kuzu'))
conn = kuzu.Connection(db)
# 定义位置
res1 = conn.execute(f"MATCH (n:CodeNode) WHERE n.name = '{sym}' RETURN n.name, n.file, n.line, n.kind LIMIT 5")
defs = []
for row in res1:
    defs.append({'name': row[0], 'file': row[1], 'line': row[2], 'kind': row[3]})
# 被谁调用
res2 = conn.execute(f"MATCH (c:CodeNode)-[:CODE_CALLS]->(n:CodeNode) WHERE n.name = '{sym}' RETURN c.name, c.file LIMIT 8")
callers = []
for row in res2:
    callers.append({'name': row[0], 'file': row[1]})
# 调用了谁
res3 = conn.execute(f"MATCH (n:CodeNode)-[:CODE_CALLS]->(c:CodeNode) WHERE n.name = '{sym}' RETURN c.name, c.file LIMIT 8")
callees = []
for row in res3:
    callees.append({'name': row[0], 'file': row[1]})
sys.stdout.write(json.dumps({'defs': defs, 'callers': callers, 'callees': callees}, ensure_ascii=False) + '\n')
sys.stdout.flush()
os._exit(0)  # bypass kuzu Database::~Database() SIGBUS on macOS ARM64