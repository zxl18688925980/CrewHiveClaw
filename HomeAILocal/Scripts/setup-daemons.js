#!/usr/bin/env node
/**
 * setup-daemons.js
 *
 * HomeClaw 守护进程 Setup 脚本。
 * 第二个家庭（或第一次部署）执行此脚本，完成：
 *   1. 初始化三个守护进程的 workspace（~/.homeclaw/workspace-{lucas,andy,lisa}/）
 *   2. 从 workspace-templates/ 复制 SOUL.md 等 bootstrap 文件
 *   3. 在 ~/.homeclaw/homeclaw.json 中注册 lucas/andy/lisa 三个 agent
 *
 * 使用方式：
 *   node scripts/setup-daemons.js
 *
 * 幂等：多次执行安全，已存在的文件不覆盖。
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');

const HOMECLAW_STATE_DIR = path.join(os.homedir(), '.homeclaw');
const HOMECLAW_CONFIG_PATH = path.join(HOMECLAW_STATE_DIR, 'homeclaw.json');
const TEMPLATES_DIR = path.join(__dirname, '..', 'homeclaw', 'daemons', 'workspace-templates');

const DAEMON_ROLES = ['lucas', 'andy', 'lisa'];

// Default HTTP ports for each daemon (matches ecosystem.config.js env vars).
const DAEMON_PORTS = { lucas: 3000, andy: 3001, lisa: 3002 };

// Default chat endpoint for each daemon.
// Lucas supports the standard /api/chat interface.
// Andy and Lisa use their own action endpoints; update these once they gain /api/chat.
const DAEMON_CHAT_PATHS = {
  lucas: '/api/chat',
  andy: '/api/dev/task',
  lisa: '/api/lisa/generate',
};

// ─── 工具函数 ──────────────────────────────────────────────────────────────

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function copyIfMissing(src, dest) {
  try {
    await fs.access(dest);
    return false; // 已存在，跳过
  } catch {
    // 不存在，复制
  }
  try {
    const content = await fs.readFile(src, 'utf8');
    await fs.writeFile(dest, content, 'utf8');
    return true;
  } catch (e) {
    console.warn(`  跳过 ${path.basename(src)}（模板不存在：${e.message}）`);
    return false;
  }
}

// ─── 1. 初始化 workspace ───────────────────────────────────────────────────

async function initWorkspace(role) {
  const workspaceDir = path.join(HOMECLAW_STATE_DIR, `workspace-${role}`);
  await ensureDir(workspaceDir);

  const templateDir = path.join(TEMPLATES_DIR, role);
  let seeded = 0;

  // 复制模板中的所有文件（当前只有 SOUL.md，未来可扩展）
  let templateFiles = [];
  try {
    templateFiles = await fs.readdir(templateDir);
  } catch {
    console.warn(`  ⚠️  ${role} 模板目录不存在：${templateDir}`);
  }

  for (const filename of templateFiles) {
    const src = path.join(templateDir, filename);
    const dest = path.join(workspaceDir, filename);
    const copied = await copyIfMissing(src, dest);
    if (copied) seeded++;
  }

  return { workspaceDir, seeded, total: templateFiles.length };
}

// ─── 2. 注册 agent 到 homeclaw.json ───────────────────────────────────────

async function registerAgents() {
  // 读取现有配置（不存在则从空对象开始）
  let config = {};
  try {
    const raw = await fs.readFile(HOMECLAW_CONFIG_PATH, 'utf8');
    config = JSON.parse(raw);
  } catch {
    // 配置文件不存在或损坏，使用空对象
  }

  // 确保 agents.list 存在
  if (!config.agents) config.agents = {};
  if (!Array.isArray(config.agents.list)) config.agents.list = [];

  const existingIds = new Set(config.agents.list.map(a => a?.id).filter(Boolean));
  let added = 0;

  for (const role of DAEMON_ROLES) {
    if (existingIds.has(role)) {
      continue; // 已注册，跳过
    }
    config.agents.list.push({
      id: role,
      workspace: `~/.homeclaw/workspace-${role}`,
      runtime: {
        type: 'daemon',
        daemon: {
          url: `http://localhost:${DAEMON_PORTS[role]}`,
          path: DAEMON_CHAT_PATHS[role],
        },
      },
    });
    added++;
  }

  // 写回配置文件（格式化输出）
  await ensureDir(HOMECLAW_STATE_DIR);
  await fs.writeFile(HOMECLAW_CONFIG_PATH, JSON.stringify(config, null, 2) + '\n', 'utf8');

  return { added, total: DAEMON_ROLES.length };
}

// ─── 主流程 ────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n=== HomeClaw 守护进程 Setup ===\n');
  console.log(`状态目录：${HOMECLAW_STATE_DIR}`);
  console.log(`配置文件：${HOMECLAW_CONFIG_PATH}\n`);

  // Step 1: 初始化各 workspace
  console.log('── Step 1: 初始化 workspace ──');
  for (const role of DAEMON_ROLES) {
    const { workspaceDir, seeded, total } = await initWorkspace(role);
    const status = seeded > 0 ? `✅ 初始化（${seeded}/${total} 个文件）` : `⏩ 已存在，跳过`;
    console.log(`  ${role.padEnd(6)} ${status}`);
    console.log(`         路径：${workspaceDir}`);
  }

  // Step 2: 注册 agents
  console.log('\n── Step 2: 注册 agent ──');
  const { added, total } = await registerAgents();
  if (added > 0) {
    console.log(`  ✅ 新增 ${added} 个 agent 注册到 homeclaw.json`);
  } else {
    console.log(`  ⏩ ${total} 个 agent 已注册，跳过`);
  }

  console.log('\n── 完成 ──\n');
  console.log('下一步：');
  console.log(`  1. 编辑 ~/.homeclaw/workspace-lucas/SOUL.md，填入这个家庭的具体信息`);
  console.log(`  2. 编辑 ~/.env，填入 API Keys 和企业微信配置`);
  console.log(`  3. cd homeclaw/daemons && pm2 start ecosystem.config.js`);
  console.log('');
}

main().catch(err => {
  console.error('Setup 失败：', err.message);
  process.exit(1);
});
