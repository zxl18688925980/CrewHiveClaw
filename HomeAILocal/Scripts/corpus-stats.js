#!/usr/bin/env node
/**
 * corpus-stats.js
 * 统计 data/corpus/ 下各角色语料行数，输出到 app/generated/corpus-stats.txt
 */

const fs   = require('fs');
const path = require('path');

const ROOT       = path.join(__dirname, '..');
const CORPUS_DIR = path.join(ROOT, 'data', 'corpus');
const OUT_DIR    = path.join(ROOT, 'app', 'generated');
const OUT_FILE   = path.join(OUT_DIR, 'corpus-stats.txt');

function countLines(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split('\n').filter(l => l.trim()).length;
}

function main() {
  const files = fs.readdirSync(CORPUS_DIR)
    .filter(f => f.endsWith('.jsonl'))
    .sort();

  const rows = files.map(f => {
    const fullPath = path.join(CORPUS_DIR, f);
    const lines    = countLines(fullPath);
    const size     = fs.statSync(fullPath).size;
    return { file: f, lines, size };
  });

  const total = rows.reduce((s, r) => s + r.lines, 0);
  const now   = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

  const lines = [
    `HomeAI 语料统计`,
    `生成时间：${now}`,
    `${'─'.repeat(55)}`,
    `${'文件名'.padEnd(35)} ${'行数'.padStart(6)} ${'大小'.padStart(10)}`,
    `${'─'.repeat(55)}`,
    ...rows.map(r =>
      `${r.file.padEnd(35)} ${String(r.lines).padStart(6)} ${(r.size / 1024).toFixed(1).padStart(8)}KB`
    ),
    `${'─'.repeat(55)}`,
    `${'合计'.padEnd(35)} ${String(total).padStart(6)}`,
    '',
  ];

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, lines.join('\n'), 'utf8');

  console.log(lines.join('\n'));
  console.log(`已写入 ${OUT_FILE}`);
}

main();
