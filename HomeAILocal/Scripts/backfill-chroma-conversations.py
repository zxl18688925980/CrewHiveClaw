#!/usr/bin/env python3
"""
补录失败的 ChromaDB conversations 写入。
从 memory-write-errors.jsonl × finetune-queue.jsonl 找出未入库对话，
补写到 ChromaDB conversations 集合。
幂等：ID 基于 timestamp hash，重复运行不产生重复。
"""
import json, hashlib, sys, time
from datetime import datetime
import urllib.request, urllib.error
import os as _os

CHROMA_BASE = _os.environ.get("CHROMA_URL", "http://localhost:8001") + "/api/v2/tenants/default_tenant/databases/default_database/collections"
OLLAMA_URL  = "http://localhost:11434/api/embeddings"
EMBED_MODEL = "nomic-embed-text"
ERRORS_FILE = "/Users/xinbinanshan/HomeAI/data/learning/memory-write-errors.jsonl"
FINETUNE_FILE = "/Users/xinbinanshan/HomeAI/data/learning/finetune-queue.jsonl"

def post(url, data):
    body = json.dumps(data).encode()
    req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.loads(r.read())

def embed(text):
    res = post(OLLAMA_URL, {"model": EMBED_MODEL, "prompt": text[:700]})
    return res["embedding"]

def get_collection_id(name):
    url = f"{CHROMA_BASE}/{name}"
    req = urllib.request.Request(url)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())["id"]

def chroma_exists(col_id, doc_id):
    url = f"{CHROMA_BASE}/{col_id}/get"
    try:
        res = post(url, {"ids": [doc_id]})
        return len(res.get("ids", [])) > 0
    except:
        return False

def chroma_add(col_id, doc_id, document, metadata, embedding):
    url = f"{CHROMA_BASE}/{col_id}/add"
    post(url, {
        "ids": [doc_id],
        "embeddings": [embedding],
        "documents": [document],
        "metadatas": [metadata],
    })

# 1. 读错误时间点
errors = []
with open(ERRORS_FILE) as f:
    for l in f:
        e = json.loads(l)
        errors.append(datetime.fromisoformat(e["t"].replace("Z", "+00:00")))

# 2. 找对应 finetune-queue 条目（2秒窗口）
matches = []
with open(FINETUNE_FILE) as f:
    for l in f:
        entry = json.loads(l)
        et = datetime.fromisoformat(entry["timestamp"].replace("Z", "+00:00"))
        for err_t in errors:
            if abs((et - err_t).total_seconds()) < 2:
                matches.append(entry)
                break

print(f"待补录条目: {len(matches)}")

# 3. 获取 conversations 集合 ID
try:
    col_id = get_collection_id("conversations")
    print(f"ChromaDB conversations 集合: {col_id}")
except Exception as e:
    print(f"❌ 无法连接 ChromaDB: {e}")
    sys.exit(1)

# 4. 补录
ok, skip, fail = 0, 0, 0
for entry in matches:
    ts   = entry["timestamp"]
    # 幂等 ID：基于 timestamp hash
    doc_id = "backfill-" + hashlib.md5(ts.encode()).hexdigest()[:12]

    if chroma_exists(col_id, doc_id):
        skip += 1
        continue

    prompt   = entry["prompt"]
    response = entry.get("response", "")
    agent_id = entry.get("agentId", "lucas")

    # 剥离 Lucas 的历史前缀（同 writeMemory 逻辑）
    import re
    clean_prompt = re.sub(r'^【与.+?的私聊（最近 \d+ 轮）】[\s\S]*?\n\n', '', prompt)
    clean_prompt = re.sub(r'^【近期对话（最近 \d+ 轮）】[\s\S]*?---\n\n', '', clean_prompt)

    # 推断 fromId / channel
    from_id = "ZengXiaoLong"  # 大部分是爸爸
    channel = "wecom_private"
    if "group" in entry.get("agentId", ""):
        channel = "wecom_group"

    document = f"{from_id}(human): {clean_prompt}\n{agent_id}: {response}"
    embed_doc = f"{from_id}: {clean_prompt[:350]}\n{agent_id}: {response[:350]}"

    try:
        embedding = embed(embed_doc)
        metadata = {
            "fromId": from_id,
            "fromType": "human",
            "toId": agent_id,
            "toType": "agent",
            "channel": channel,
            "modelUsed": "unknown",
            "isCloud": "true",
            "toolsCalled": "[]",
            "sessionId": "",
            "intent": "",
            "qualityScore": entry.get("qualityScore", 0),
            "dpoFlagged": "false",
            "userId": from_id,
            "source": "private",
            "timestamp": ts,
            "prompt": clean_prompt[:500],
            "response": response[:500],
            "backfilled": "true",
        }
        chroma_add(col_id, doc_id, document, metadata, embedding)
        ok += 1
        print(f"  ✅ {ts[:19]} {agent_id} ok")
        time.sleep(0.1)  # 避免 Ollama 过载
    except Exception as e:
        fail += 1
        print(f"  ❌ {ts[:19]} {agent_id} {e}")

print(f"\n完成：补录 {ok} 条，跳过（已有）{skip} 条，失败 {fail} 条")
