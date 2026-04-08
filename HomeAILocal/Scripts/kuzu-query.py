#!/usr/bin/env python3
"""kuzu-query.py — 执行单条 Kuzu Cypher 查询，输出 JSON rows

用法：python3 kuzu-query.py '<cypher>' '<params_json>'
输出：JSON array，每行是字段值的数组
注意：$topK 占位符由调用方在传入前替换为整数字面量（Kuzu 不支持 LIMIT 参数化）
"""
import sys, json, os
import kuzu

cypher = sys.argv[1]
params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}

db   = kuzu.Database(os.path.expanduser("~/HomeAI/data/kuzu"))
conn = kuzu.Connection(db)
try:
    res  = conn.execute(cypher, params)
    rows = []
    while res.has_next():
        rows.append(res.get_next())
    print(json.dumps(rows, ensure_ascii=False))
    sys.stdout.flush()
except Exception as e:
    print(json.dumps({"error": str(e)}), file=sys.stderr)
    sys.stderr.flush()
    print("[]")
    sys.stdout.flush()
finally:
    os._exit(0)  # bypass kuzu Database::~Database() SIGBUS on macOS ARM64
