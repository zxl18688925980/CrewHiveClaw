#!/usr/bin/env node
/**
 * HomeAI 自我文档维护脚本
 * 功能：整理 MEMORY.md、去重，检查 SKILL.md frontmatter，验证 openclaw.json 语法
 * 支持 --dry-run 参数（只报告，不修改）
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- 配置 ---
const DRY_RUN = process.argv.includes('--dry-run');
const HOMEAI_ROOT = process.env.HOMEAI_ROOT || path.join(process.env.HOME, 'HomeAI');
const LUCAS_SKILLS_DIR = path.join(process.env.HOME || '/Users/xinbinanshan', '.openclaw/workspace-lucas/skills');
const OPENCLAW_JSON = path.join(process.env.HOME || '/Users/xinbinanshan', '.openclaw/openclaw.json');
const MEMORY_MD_LISA = path.join(process.env.HOME || '/Users/xinbinanshan', '.openclaw/workspace-lisa/MEMORY.md');
const TODAY = new Date().toISOString().slice(0, 10);

// --- 工具函数 ---
function hashContent(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (e) {
    return null;
  }
}

function writeFileSafe(filePath, content) {
  if (DRY_RUN) return;
  fs.writeFileSync(filePath, content, 'utf8');
}

function log(msg) {
  console.log(`[${TODAY}] ${msg}`);
}

function report(title, items) {
  if (items.length === 0) {
    log(`${title}：无变化`);
    return;
  }
  log(`${title}：整理了 ${items.length} 个文件`);
  items.forEach(item => console.log(`  - ${item}`));
}

// --- 1. MEMORY.md 去重 + 更新时间戳 ---
function processMemoryMd() {
  const filePath = MEMORY_MD_LISA;
  const content = readFileSafe(filePath);
  if (!content) {
    console.log(`[WARN] MEMORY.md 不存在，跳过`);
    return [];
  }

  const changed = [];
  const lines = content.split('\n');
  const seenHashes = new Map(); // hash -> line index
  const uniqueLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过 DISTILLED 块内的行（会被重新生成）
    if (line.startsWith('> 最后蒸馏：') || line.startsWith('> 最后从 Kuzu')) {
      // 跳过，保留占位让下面重新生成
      continue;
    }
    // 跳过空行
    if (line.trim() === '') {
      uniqueLines.push(line);
      continue;
    }
    // 普通行：去重
    const h = hashContent(line);
    if (!seenHashes.has(h)) {
      seenHashes.set(h, uniqueLines.length);
      uniqueLines.push(line);
    } else {
      changed.push(`MEMORY.md: 移除重复行 "${line.slice(0, 60)}..."`);
    }
  }

  // 重建 DISTILLED 区块（保留原有结构，只更新时间戳）
  const distilledStart = uniqueLines.findIndex(l => l.startsWith('<!-- DISTILLED-START -->'));
  if (distilledStart !== -1) {
    const before = uniqueLines.slice(0, distilledStart);
    const after = uniqueLines.slice(distilledStart + 1);
    // 找到结束标记
    const endIdx = after.findIndex(l => l.startsWith('<!-- DISTILLED-END -->'));
    const cleanAfter = endIdx !== -1 ? after.slice(endIdx + 1) : after;

    const distilledHeader = `> 最后蒸馏：${TODAY}，基于 ${changed.length > 0 ? changed.length + ' 条' : '0 条'}去重记录\n`;
    uniqueLines.length = 0;
    uniqueLines.push(...before);
    uniqueLines.push('<!-- DISTILLED-START -->');
    uniqueLines.push(distilledHeader);
    uniqueLines.push(...cleanAfter);
  }

  if (changed.length > 0 && !DRY_RUN) {
    writeFileSafe(filePath, uniqueLines.join('\n'));
  }

  return changed;
}

// --- 2. SKILL.md frontmatter 检查 ---
function checkSkillFiles() {
  const changed = [];
  if (!fs.existsSync(LUCAS_SKILLS_DIR)) {
    console.log(`[WARN] Skills 目录不存在：${LUCAS_SKILLS_DIR}`);
    return changed;
  }

  const skillDirs = fs.readdirSync(LUCAS_SKILLS_DIR).filter(f => {
    return fs.statSync(path.join(LUCAS_SKILLS_DIR, f)).isDirectory();
  });

  const frontmatterRegex = /^---\n([\s\S]*?)\n---\n/;

  for (const dir of skillDirs) {
    const skillMd = path.join(LUCAS_SKILLS_DIR, dir, 'SKILL.md');
    if (!fs.existsSync(skillMd)) continue;

    const content = readFileSafe(skillMd);
    const match = content.match(frontmatterRegex);

    if (!match) {
      changed.push(`${dir}/SKILL.md: 缺少 YAML frontmatter`);
      if (!DRY_RUN) {
        const newContent = `---\nname: ${dir}\ndescription: (待补充)\n---\n\n${content}`;
        writeFileSafe(skillMd, newContent);
      }
      continue;
    }

    // 检查必需字段
    const fm = match[1];
    const hasName = fm.includes('name:');
    const hasDesc = fm.includes('description:');
    if (!hasName || !hasDesc) {
      const missing = [];
      if (!hasName) missing.push('name');
      if (!hasDesc) missing.push('description');
      changed.push(`${dir}/SKILL.md: frontmatter 缺少 ${missing.join(', ')}`);
    }
  }

  report('SKILL.md 检查', changed);
  return changed;
}

// --- 3. openclaw.json 语法验证 ---
function validateOpenclawJson() {
  const errors = [];
  const content = readFileSafe(OPENCLAW_JSON);
  if (!content) {
    errors.push(`${OPENCLAW_JSON}: 文件不存在`);
    return errors;
  }

  try {
    JSON.parse(content);
    log(`openclaw.json：语法正确`);
  } catch (e) {
    errors.push(`${OPENCLAW_JSON}: JSON 语法错误 - ${e.message}`);
    if (!DRY_RUN) {
      // 尝试备份并修复常见问题
      const backup = content + '.bak';
      fs.writeFileSync(backup, content, 'utf8');
      log(`已备份到 ${backup}`);
    }
  }

  return errors;
}

// --- 主流程 ---
function main() {
  console.log('='.repeat(50));
  log(`HomeAI 自我文档维护开始${DRY_RUN ? '（dry-run 模式，仅报告）' : ''}`);
  console.log('='.repeat(50));

  const allChanged = [];

  // 1. MEMORY.md
  const memoryChanges = processMemoryMd();
  if (memoryChanges.length > 0) {
    report('MEMORY.md 去重', memoryChanges);
    allChanged.push(...memoryChanges);
  } else {
    log('MEMORY.md：无重复内容');
  }

  // 2. SKILL.md
  const skillChanges = checkSkillFiles();
  allChanged.push(...skillChanges);

  // 3. openclaw.json
  const jsonErrors = validateOpenclawJson();
  allChanged.push(...jsonErrors);

  // 汇总
  console.log('='.repeat(50));
  if (allChanged.length === 0) {
    log(`文档维护完成：无变化`);
  } else {
    log(`文档维护完成：共 ${allChanged.length} 处变化`);
    if (DRY_RUN) {
      console.log('（dry-run，未实际修改）');
    }
  }
  console.log('='.repeat(50));
}

main();
