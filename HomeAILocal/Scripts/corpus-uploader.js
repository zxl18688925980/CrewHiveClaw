#!/usr/bin/env node
/**
 * 语料上传管道
 * cron: 每天凌晨 3 点
 * 流程：去标识化 → 分包上传到三位大师 → 归档
 */

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');

const DATA_DIR = path.join(__dirname, '../data/corpus');
const CORPUS_FILES = {
  lucas: path.join(DATA_DIR, 'lucas-corpus.jsonl'),
  andy:  path.join(DATA_DIR, 'andy-corpus.jsonl'),
  lisa:  path.join(DATA_DIR, 'lisa-corpus.jsonl')
};
const HISTORY_FILE = path.join(DATA_DIR, 'upload-history.jsonl');
const ARCHIVE_DIR  = path.join(DATA_DIR, 'archived');

const ENDPOINTS = {
  lucas: process.env.CORPUS_ENDPOINT_LUCAS,
  andy:  process.env.CORPUS_ENDPOINT_ANDY,
  lisa:  process.env.CORPUS_ENDPOINT_LISA
};

// ── 去标识化规则 ──────────────────────────────────────────────
const ANONYMIZE_RULES = [
  [/[\u4e00-\u9fa5]{2,4}(先生|女士|老师|主任|经理|总)/g, '[成员]'],
  [/1[3-9]\d{9}/g, '[联系方式]'],
  [/\d{4}-\d{4}-\d{4}-\d{4}/g, '[数值]'],
  [/¥[\d,.]+/g, '[数值]'],
  [/(sk-|key-)[a-zA-Z0-9_-]{10,}/gi, '[REDACTED]'],
  [/Bearer\s+[a-zA-Z0-9._-]+/gi, 'Bearer [REDACTED]'],
];

function anonymize(text) {
  let result = String(text);
  let count = 0;
  for (const [pattern, replacement] of ANONYMIZE_RULES) {
    const before = result;
    result = result.replace(pattern, replacement);
    if (result !== before) count++;
  }
  return { text: result, anonymized: count > 0 };
}

function anonymizeRecord(record) {
  const out = {};
  let totalAnonymized = 0;
  for (const [k, v] of Object.entries(record)) {
    if (typeof v === 'string') {
      const { text, anonymized } = anonymize(v);
      out[k] = text;
      if (anonymized) totalAnonymized++;
    } else {
      out[k] = v;
    }
  }
  return { record: out, anonymized: totalAnonymized };
}

// ── 上传单个语料文件 ──────────────────────────────────────────
async function uploadCorpus(role) {
  const filePath = CORPUS_FILES[role];
  const endpoint = ENDPOINTS[role];
  const date = new Date().toISOString().substring(0, 10);

  let content;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    console.log(`[corpus] ${role}: 文件不存在，跳过`);
    return { role, status: 'skipped', reason: 'file_not_found' };
  }

  const lines = content.trim().split('\n').filter(Boolean);
  if (lines.length === 0) {
    return { role, status: 'skipped', reason: 'empty_file' };
  }

  // 去标识化
  let anonymizedCount = 0;
  const cleanedLines = lines.map(line => {
    try {
      const record = JSON.parse(line);
      const { record: clean, anonymized } = anonymizeRecord(record);
      if (anonymized) anonymizedCount++;
      return JSON.stringify(clean);
    } catch (e) {
      return line;
    }
  });

  // 上传（端点未配置时跳过）
  let uploadStatus = 'skipped';
  if (endpoint) {
    try {
      await axios.post(endpoint, {
        role,
        date,
        lines: cleanedLines.length,
        data: cleanedLines.join('\n')
      }, { timeout: 30000 });
      uploadStatus = 'uploaded';
    } catch (e) {
      console.warn(`[corpus] ${role} 上传失败:`, e.message);
      uploadStatus = 'upload_failed';
    }
  } else {
    console.log(`[corpus] ${role}: CORPUS_ENDPOINT_${role.toUpperCase()} 未配置，跳过上传，仅归档`);
  }

  // 归档
  await archiveCorpus(role, filePath, date, cleanedLines);

  const result = {
    role,
    date,
    lines_uploaded: lines.length,
    anonymized_count: anonymizedCount,
    status: uploadStatus
  };

  await fs.appendFile(HISTORY_FILE, JSON.stringify(result) + '\n', 'utf8');
  return result;
}

async function archiveCorpus(role, filePath, date, lines) {
  await fs.mkdir(ARCHIVE_DIR, { recursive: true });
  const archivePath = path.join(ARCHIVE_DIR, `${role}-corpus-${date}.jsonl`);
  await fs.writeFile(archivePath, lines.join('\n') + '\n', 'utf8');
  // 清空原文件，开始新一轮采集
  await fs.writeFile(filePath, '', 'utf8');
  console.log(`[corpus] ${role} 已归档到 ${archivePath}`);
}

async function main() {
  console.log(`[corpus] === 语料上传开始 ${new Date().toISOString()} ===`);

  const results = await Promise.all(
    Object.keys(CORPUS_FILES).map(role => uploadCorpus(role))
  );

  for (const r of results) {
    console.log(`[corpus] ${r.role}: ${r.status}, ${r.lines_uploaded || 0} 行, 去标识化 ${r.anonymized_count || 0} 处`);
  }

  console.log('[corpus] === 完成 ===');
}

main().catch(e => {
  console.error('[corpus] 致命错误:', e.message);
  process.exit(1);
});
