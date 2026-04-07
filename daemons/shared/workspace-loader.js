/**
 * workspace-loader.js
 *
 * 守护进程 workspace 加载器。
 * 遵照 OpenClaw workspace 标准：bootstrap 文件（SOUL.md 等）存放于
 *   ~/.homeclaw/workspace-<role>/
 *
 * 加载优先级：
 *   1. ~/.homeclaw/workspace-<role>/SOUL.md  （实例配置，可被家庭定制）
 *   2. daemons/workspace-templates/<role>/SOUL.md  （框架内置模板，兜底）
 *
 * 设计原则：
 *   - 幂等：多次调用无副作用
 *   - 自愈：workspace 不存在时从模板初始化，不需要手动 Setup
 *   - 框架代码不含家庭信息：模板是通用的，家庭信息在实例 workspace 里
 */

const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const os = require('os');

// ~/.homeclaw（与 src/config/paths.ts 中 NEW_STATE_DIRNAME 保持一致）
const HOMECLAW_STATE_DIR = path.join(os.homedir(), '.homeclaw');

// 框架内置模板目录（相对于本文件位置，向上两层到 daemons/，再进 workspace-templates/）
const TEMPLATES_DIR = path.join(__dirname, '..', 'workspace-templates');

/**
 * 返回指定角色的 workspace 路径
 * 与 src/agents/agent-scope.ts resolveAgentWorkspaceDir 逻辑一致：
 *   非默认 agent → stateDir/workspace-<id>
 */
function resolveWorkspaceDir(role) {
  return path.join(HOMECLAW_STATE_DIR, `workspace-${role}`);
}

/**
 * 从模板初始化 workspace（幂等：文件已存在则跳过）
 * @param {string} role - 'lucas' | 'andy' | 'lisa'
 * @returns {Promise<void>}
 */
async function ensureWorkspace(role) {
  const workspaceDir = resolveWorkspaceDir(role);

  // 确保目录存在
  await fs.mkdir(workspaceDir, { recursive: true });

  // 需要从模板初始化的文件列表
  const bootstrapFiles = ['SOUL.md'];

  for (const filename of bootstrapFiles) {
    const destPath = path.join(workspaceDir, filename);
    const templatePath = path.join(TEMPLATES_DIR, role, filename);

    // 已存在则跳过，不覆盖用户的自定义内容
    try {
      await fs.access(destPath);
      continue;
    } catch {
      // 不存在，继续从模板复制
    }

    try {
      const content = await fs.readFile(templatePath, 'utf8');
      await fs.writeFile(destPath, content, 'utf8');
    } catch (e) {
      // 模板不存在时静默跳过，loadSoul 的 fallback 会兜底
    }
  }
}

/**
 * 加载角色的 SOUL.md
 *
 * 优先级：
 *   1. ~/.homeclaw/workspace-<role>/SOUL.md（实例定制）
 *   2. daemons/workspace-templates/<role>/SOUL.md（框架内置）
 *   3. null（调用方自行处理 fallback）
 *
 * @param {string} role
 * @returns {Promise<string|null>}
 */
async function loadSoul(role) {
  const candidates = [
    path.join(resolveWorkspaceDir(role), 'SOUL.md'),
    path.join(TEMPLATES_DIR, role, 'SOUL.md'),
  ];

  for (const filePath of candidates) {
    try {
      const content = await fs.readFile(filePath, 'utf8');
      if (content.trim()) {
        return content;
      }
    } catch {
      // 继续下一个候选
    }
  }

  return null;
}

/**
 * 加载 workspace 中的任意 bootstrap 文件（SOUL.md / MEMORY.md / USER.md 等）
 * @param {string} role
 * @param {string} filename
 * @returns {Promise<string|null>}
 */
async function loadBootstrapFile(role, filename) {
  const filePath = path.join(resolveWorkspaceDir(role), filename);
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content.trim() || null;
  } catch {
    return null;
  }
}

/**
 * 将内容追加写入 workspace 文件（用于 MEMORY.md 等运行时写入场景）
 * @param {string} role
 * @param {string} filename
 * @param {string} content
 * @returns {Promise<void>}
 */
async function appendToWorkspaceFile(role, filename, content) {
  const workspaceDir = resolveWorkspaceDir(role);
  await fs.mkdir(workspaceDir, { recursive: true });
  const filePath = path.join(workspaceDir, filename);
  await fs.appendFile(filePath, content, 'utf8');
}

module.exports = {
  resolveWorkspaceDir,
  ensureWorkspace,
  loadSoul,
  loadBootstrapFile,
  appendToWorkspaceFile,
  HOMECLAW_STATE_DIR,
  TEMPLATES_DIR,
};
