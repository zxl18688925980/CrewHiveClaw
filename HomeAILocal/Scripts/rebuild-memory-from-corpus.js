#!/usr/bin/env node
/**
 * rebuild-memory-from-corpus.js
 *
 * 从 lucas-corpus.jsonl 重新导入真实家人对话到 ChromaDB conversations 集合。
 * 用途：ChromaDB 被意外清空后恢复 Lucas 对家人的记忆。
 *
 * 运行：node scripts/rebuild-memory-from-corpus.js
 */

const fs   = require('fs');
const path = require('path');

const CORPUS_PATH  = path.join(__dirname, '../data/corpus/lucas-corpus.jsonl');
const CHROMA_BASE  = 'http://localhost:8000/api/v2/tenants/default_tenant/databases/default_database/collections';
const OLLAMA_EMBED = 'http://localhost:11434/api/embeddings';
const COLLECTION   = 'conversations';

// 已知家人 userId（全小写）
const KNOWN_USERS = new Set(['zengxiaolong', 'xiamoqufengliang', 'xiamoqufenguliang', 'zifeitu', 'zifeiyu']);

// 判断是否为真实家人对话（不是系统测试/watchdog）
function isRealFamilyEntry(entry) {
  const uid = (entry.userId || '').toLowerCase();
  return KNOWN_USERS.has(uid) && entry.response && entry.response.length > 5;
}

async function getCollectionId() {
  // 先尝试获取，不存在则创建
  let resp = await fetch(`${CHROMA_BASE}/${COLLECTION}`);
  if (resp.ok) {
    const data = await resp.json();
    return data.id;
  }
  // 创建集合
  resp = await fetch(`${CHROMA_BASE}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: COLLECTION, metadata: { 'hnsw:space': 'cosine' } }),
  });
  if (!resp.ok) throw new Error(`Create collection failed: ${resp.status}`);
  const data = await resp.json();
  return data.id;
}

async function embedText(text) {
  const resp = await fetch(OLLAMA_EMBED, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
  });
  if (!resp.ok) throw new Error(`Ollama embed failed: ${resp.status}`);
  const data = await resp.json();
  return data.embedding;
}

async function addToChroma(colId, id, document, metadata, embedding) {
  const resp = await fetch(`${CHROMA_BASE}/${colId}/add`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ids: [id],
      embeddings: [embedding],
      documents: [document],
      metadatas: [metadata],
    }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    // ID 已存在（409 / duplicate）时跳过
    if (resp.status === 409 || body.includes('already exists') || body.includes('duplicate')) {
      return 'skip';
    }
    throw new Error(`ChromaDB add failed: ${resp.status} ${body}`);
  }
  return 'ok';
}

async function main() {
  console.log('=== 记忆重建开始 ===');

  // 读 corpus
  const lines = fs.readFileSync(CORPUS_PATH, 'utf8').split('\n').filter(Boolean);
  const entries = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const real = entries.filter(isRealFamilyEntry);
  console.log(`语料总条数: ${entries.length}，真实家人对话: ${real.length}`);

  const colId = await getCollectionId();
  console.log(`ChromaDB collection id: ${colId}`);

  let added = 0, skipped = 0, failed = 0;

  for (let i = 0; i < real.length; i++) {
    const entry = real[i];
    const uid     = entry.userId.toLowerCase();
    const prompt  = (entry.prompt  || '').slice(-400);   // 取末尾（去掉 skill/记忆前缀注入）
    const response = (entry.response || '').slice(0, 500);
    const ts      = entry.timestamp || new Date().toISOString();

    // 去掉 prompt 里的系统注入前缀（【Lucas Skill 库】 / 【记忆片段】等块）
    // 取最后一个 【...】标签之后的内容作为真实用户消息
    const cleanPrompt = prompt.replace(/^[\s\S]*【[^】]*】/, '').trim() || prompt;

    const id = `corpus-${uid}-${new Date(ts).getTime()}-${i}`;
    const document = `User: ${cleanPrompt}\nLucas: ${response}`;

    // source 判断：group 或 private
    const source = /^group:/.test(entry.sessionKey || '') ? 'group' : 'private';

    try {
      const embedDoc = `User: ${cleanPrompt.slice(0, 400)}\nLucas: ${response.slice(0, 400)}`;
      const embedding = await embedText(embedDoc);
      const result = await addToChroma(colId, id, document, {
        timestamp: ts,
        userId: uid,
        source,
        prompt: cleanPrompt.slice(0, 500),
        response: response.slice(0, 500),
      }, embedding);

      if (result === 'skip') {
        skipped++;
      } else {
        added++;
      }

      if ((i + 1) % 20 === 0) {
        console.log(`进度: ${i + 1}/${real.length}  已写入: ${added}  跳过: ${skipped}  失败: ${failed}`);
      }
    } catch (e) {
      failed++;
      console.error(`  [${i}] 失败 uid=${uid}: ${e.message}`);
    }

    // 避免 Ollama 过载，批次间小暂停
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 200));
  }

  console.log('\n=== 重建完成 ===');
  console.log(`写入: ${added}  跳过(已存在): ${skipped}  失败: ${failed}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
