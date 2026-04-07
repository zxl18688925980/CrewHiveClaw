/**
 * 成员专属 Agent 管理器
 *
 * 职责：管理每个家庭成员的专属 Agent 生命周期
 *   - 创建 / 激活 / 退休
 *   - 消息转发（用成员专属 system prompt 调用模型）
 *   - 创建触发评估
 *   - 对话摘要同步
 *
 * Agent 存储位置：~/.homeclaw/agents/<memberId>/
 *   config.json      —— 机器可读配置（状态、人格、能力、记忆 scope）
 *   SOUL.md          —— system prompt（OpenClaw 标准文件，模型直接使用）
 *   IDENTITY.md      —— 身份元数据（名字、emoji、vibe）
 *   USER.md          —— 关于该成员的档案（偏好、上下文）
 *   AGENTS.md        —— 会话启动顺序和协作规则
 *   memory-log.jsonl —— 对话摘要累积（ChromaDB 集成前的过渡存储）
 *
 * 注：agent.md 作为兼容保留，新创建的 Agent 使用 SOUL.md
 *
 * 与 Lucas 路由的关系：
 *   lucas/index.js 在 member_deep 分支调用本模块
 *   resolveMemberId(userId) → hasActiveAgent(memberId) → forwardToMemberAgent()
 */

const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const AGENTS_DIR = path.join(os.homedir(), '.homeclaw', 'agents');

// 系统内置 Agent，不是成员专属 Agent
const SYSTEM_AGENTS = new Set(['lucas', 'andy', 'lisa', 'main']);

// 创建触发阈值
const DENSITY_THRESHOLD = 5;   // 14 天内同类需求次数
const DEPTH_THRESHOLD   = 10;  // 单次对话轮数
const DAYS_WINDOW       = 14;

class MemberAgentManager {
  // ─── 查询 ─────────────────────────────────────────────────────────────────

  /**
   * 检查某成员是否有激活的专属 Agent
   */
  async hasActiveAgent(memberId) {
    try {
      const config = await this.getAgentConfig(memberId);
      return config !== null && config.status === 'active';
    } catch (e) {
      return false;
    }
  }

  /**
   * 加载成员 Agent 配置（config.json）
   * 返回 null 若不存在
   */
  async getAgentConfig(memberId) {
    const configPath = path.join(AGENTS_DIR, memberId, 'config.json');
    try {
      const raw = await fs.readFile(configPath, 'utf8');
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  /**
   * 加载成员 Agent 的 system prompt
   * 优先读 SOUL.md（OpenClaw 标准），fallback 到 agent.md（兼容旧格式）
   * 返回 null 若两者均不存在
   */
  async getAgentPrompt(memberId) {
    const agentDir = path.join(AGENTS_DIR, memberId);
    // 优先 SOUL.md
    try {
      const soul = await fs.readFile(path.join(agentDir, 'SOUL.md'), 'utf8');
      if (soul.trim()) return soul;
    } catch (e) {
      // SOUL.md 不存在，继续 fallback
    }
    // fallback: agent.md（向后兼容）
    try {
      return await fs.readFile(path.join(agentDir, 'agent.md'), 'utf8');
    } catch (e) {
      return null;
    }
  }

  /**
   * 列出所有成员专属 Agent（排除系统 Agent）
   */
  async listAgents() {
    try {
      const entries = await fs.readdir(AGENTS_DIR);
      const results = [];
      for (const entry of entries) {
        if (SYSTEM_AGENTS.has(entry)) continue;
        const config = await this.getAgentConfig(entry);
        if (config) results.push(config);
      }
      return results;
    } catch (e) {
      return [];
    }
  }

  /**
   * 通过 WeChat Work userId 或 memberId 直接匹配，找到对应的 memberId
   * 优先检查 config.wecom_user_id 字段；其次看 config.member_id === userId
   */
  async resolveMemberId(userId) {
    try {
      const entries = await fs.readdir(AGENTS_DIR);
      for (const entry of entries) {
        if (SYSTEM_AGENTS.has(entry)) continue;
        const config = await this.getAgentConfig(entry);
        if (!config || config.status !== 'active') continue;
        if (config.wecom_user_id === userId) return entry;
        if (config.member_id === userId) return entry;
      }
    } catch (e) {
      // ignore scan errors
    }
    return null;
  }

  // ─── 消息转发 ─────────────────────────────────────────────────────────────

  /**
   * 将消息转发给成员专属 Agent 处理
   * 用成员 Agent 的 system prompt 调用模型（复用 model-router）
   * 返回格式与 Lucas /api/chat 一致：{ response, agentId, agentName, modelUsed }
   */
  async forwardToMemberAgent(memberId, message, conversationContext = {}) {
    const config = await this.getAgentConfig(memberId);
    if (!config || config.status !== 'active') {
      throw new Error(`成员 ${memberId} 没有激活的专属 Agent`);
    }

    const promptMd = await this.getAgentPrompt(memberId);
    const systemPrompt = promptMd || this._buildSystemPromptFromConfig(config);

    // 将成员 system prompt 拼入查询，调用模型路由器
    const { modelRouter } = require('./model-router');
    const fullPrompt = `${systemPrompt}\n\n---\n用户说：${message}`;

    const result = await modelRouter.route(fullPrompt, 'chat', 'lucas', { timeoutMs: 30000 });

    return {
      response: result.response,
      agentId: memberId,
      agentName: config.agent_name,
      modelUsed: result.modelUsed || null
    };
  }

  /**
   * 从 config.json 生成 system prompt（无 agent.md 时的降级方案）
   */
  _buildSystemPromptFromConfig(config) {
    const avoidList = (config.personality?.avoid || []).join('、') || '无';
    return `你是 ${config.agent_name}，专门服务于 ${config.member_name}。

核心目的：${config.purpose}

沟通风格：${config.personality?.style || '自然、温暖'}
避免：${avoidList}
格式偏好：${config.personality?.preferred_format || '清晰简洁'}

你只服务 ${config.member_name} 一人，专注于她的个人需求，不涉及其他家庭成员的私事。`;
  }

  // ─── 创建触发评估 ─────────────────────────────────────────────────────────

  /**
   * 评估是否应该为某成员创建专属 Agent
   * recentInteractions: [{ timestamp, type, rounds? }, ...]
   * 返回：{ shouldCreate: bool, reason: string, trigger: string|null }
   */
  assessCreationTriggers(memberId, recentInteractions = []) {
    const cutoff = Date.now() - DAYS_WINDOW * 24 * 60 * 60 * 1000;
    const recent = recentInteractions.filter(
      i => new Date(i.timestamp).getTime() > cutoff
    );

    // 触发一：需求密度
    if (recent.length >= DENSITY_THRESHOLD) {
      return {
        shouldCreate: true,
        reason: `需求密度触发：${DAYS_WINDOW} 天内出现 ${recent.length} 次同类需求（阈值 ${DENSITY_THRESHOLD}）`,
        trigger: 'density'
      };
    }

    // 触发二：需求深度（单次对话 >= DEPTH_THRESHOLD 轮）
    const deepConv = recentInteractions.find(i => (i.rounds || 0) >= DEPTH_THRESHOLD);
    if (deepConv) {
      return {
        shouldCreate: true,
        reason: `需求深度触发：单次对话 ${deepConv.rounds} 轮（阈值 ${DEPTH_THRESHOLD}）`,
        trigger: 'depth'
      };
    }

    return { shouldCreate: false, reason: '未达到创建条件', trigger: null };
  }

  // ─── 生命周期 ─────────────────────────────────────────────────────────────

  /**
   * 创建成员专属 Agent
   * 写入 config.json，可选写入 agent.md（system prompt）
   *
   * memberProfile 字段说明：
   *   name         成员中文名
   *   agentName    专属 Agent 名称
   *   wecomUserId  企业微信 userId（用于消息路由）
   *   personality  { style, avoid: [], preferred_format }
   *   capabilities []
   *   promptMd     agent.md 内容（自定义 system prompt）
   */
  async createMemberAgent(memberId, purpose, memberProfile = {}) {
    const agentDir = path.join(AGENTS_DIR, memberId);
    await fs.mkdir(agentDir, { recursive: true });

    const config = {
      member_name:  memberProfile.name     || memberId,
      member_id:    memberId,
      agent_name:   memberProfile.agentName || `${memberProfile.name || memberId}的专属助手`,
      wecom_user_id: memberProfile.wecomUserId || null,
      created_at:   new Date().toISOString().split('T')[0],
      status:       'active',
      purpose,
      personality:  memberProfile.personality || {
        style:            '自然、温暖',
        avoid:            [],
        preferred_format: '清晰简洁'
      },
      capabilities: memberProfile.capabilities || [],
      memory_scope: `${memberId}-memory`,
      lucas_sync: {
        summary_interval_days: 7,
        context_fields: ['近期对话摘要', '偏好变化', '重要事项']
      }
    };

    const configPath = path.join(agentDir, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');

    // 写入 SOUL.md（标准格式），同时写 agent.md 保持向后兼容
    if (memberProfile.promptMd) {
      await fs.writeFile(path.join(agentDir, 'SOUL.md'), memberProfile.promptMd, 'utf8');
      await fs.writeFile(path.join(agentDir, 'agent.md'), memberProfile.promptMd, 'utf8');
    }

    return config;
  }

  /**
   * 同步对话摘要到成员 Agent 的记忆
   * 当前：追加到 memory-log.jsonl（ChromaDB 集成后可迁移）
   */
  async syncConversationSummary(memberId, summary) {
    const config = await this.getAgentConfig(memberId);
    if (!config) throw new Error(`成员 ${memberId} 没有专属 Agent`);

    const logPath = path.join(AGENTS_DIR, memberId, 'memory-log.jsonl');
    const entry = JSON.stringify({
      timestamp:    new Date().toISOString(),
      type:         'conversation_summary',
      summary,
      memory_scope: config.memory_scope
    }) + '\n';

    await fs.appendFile(logPath, entry, 'utf8');
    return { ok: true, scope: config.memory_scope };
  }

  /**
   * 退休成员 Agent（status → archived，数据保留）
   */
  async retireMemberAgent(memberId, reason = '') {
    const config = await this.getAgentConfig(memberId);
    if (!config) throw new Error(`成员 ${memberId} 没有专属 Agent`);

    config.status         = 'archived';
    config.retired_at     = new Date().toISOString().split('T')[0];
    config.retired_reason = reason;

    const configPath = path.join(AGENTS_DIR, memberId, 'config.json');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf8');
    return config;
  }
}

const memberAgentManager = new MemberAgentManager();

module.exports = { memberAgentManager, MemberAgentManager };
