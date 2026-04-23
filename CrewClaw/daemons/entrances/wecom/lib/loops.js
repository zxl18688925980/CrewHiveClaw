'use strict';
/**
 * loops.js — 主动循环
 *
 * 包含：runLucasProactiveLoop / runMainMonitorLoop /
 *       runMainWeeklyEvaluation / runAndyHeartbeatLoop
 *
 * 工厂函数：module.exports = (logger, deps) => ({ ... })
 * 调用方：
 *   const _loopsFactory = require('./lib/loops');
 *   const loops = _loopsFactory(logger, { callGatewayAgent, callMainModel,
 *     executeMainTool, sendWeComMessage, sendLongWeComMessage,
 *     nowCST, INSTANCE_ROOT, PORT, WECOM_OWNER_ID });
 */

const fs      = require('fs');
const path    = require('path');
const { execSync } = require('child_process');
const axios   = require('axios');

// 剥离 reasoning 模型 <think>...</think> 块（loops 内部本地函数，agent-client.js 同名函数的副本）
function stripThink(text) {
  return (text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

module.exports = function createLoops(logger, deps) {
  const {
    callGatewayAgent, callMainModel, executeMainTool,
    sendWeComMessage, sendLongWeComMessage,
    nowCST, INSTANCE_ROOT, PORT, WECOM_OWNER_ID,
    getOrgMembers,
    MAIN_SYSTEM_PROMPT,
    readTaskRegistryRaw,
    markTaskLucasAcked,
  } = deps;

// ─── Lucas 主动循环（Proactive Loop）────────────────────────────────────────
//
// 每隔 LUCAS_PROACTIVE_INTERVAL_MS 触发一次。
//
// 设计意图：Lucas 作为协调者，主动跟进待办承诺。
// 实现方式：从 ChromaDB decisions 集合查出未交付承诺，逐条以原始家人 userId
//   重新发给 Lucas——让 Lucas 以正常请求处理路径响应，而不是抽象的"检查清单"。
//   每条承诺独立一次 session，Lucas 在正确的家人上下文里决策并调工具。

const LUCAS_PROACTIVE_INTERVAL_MS = 60 * 60 * 1000; // 每小时一次
const CHROMA_URL_WECOM = process.env.CHROMA_URL || 'http://localhost:8001';
const CHROMA_API_BASE  = `${CHROMA_URL_WECOM}/api/v2/tenants/default_tenant/databases/default_database/collections`;

// 从 ChromaDB 直接查 lucas 的未交付承诺
async function fetchPendingCommitments() {
  try {
    // Step 1: 获取 decisions 集合 UUID
    const colResp = await fetch(`${CHROMA_API_BASE}/decisions`);
    if (!colResp.ok) return [];
    const col = await colResp.json();
    const colId = col.id;

    // Step 2: 查 outcome="" 的 lucas 承诺
    const getResp = await fetch(`${CHROMA_API_BASE}/${colId}/get`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        where:   { '$and': [{ agent: { '$eq': 'lucas' } }, { outcome: { '$eq': '' } }] },
        include: ['metadatas'],
        limit:   20,
      }),
    });
    if (!getResp.ok) return [];
    const data = await getResp.json();
    return (data.ids || []).map((id, i) => ({ id, ...data.metadatas[i] }));
  } catch (e) {
    logger.error('fetchPendingCommitments 失败', { error: e.message });
    return [];
  }
}

async function markCommitmentNotified(id, outcome = 'proactive_notified') {
  try {
    const colResp = await fetch(`${CHROMA_API_BASE}/decisions`);
    if (!colResp.ok) return;
    const { id: colId } = await colResp.json();
    await fetch(`${CHROMA_API_BASE}/${colId}/update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ids: [id],
        metadatas: [{ outcome, notified_at: nowCST() }],
      }),
    });
    logger.info('承诺标记为已触达', { id, outcome });
  } catch (e) {
    logger.warn('markCommitmentNotified 失败', { id, error: e.message });
  }
}

// readTaskRegistryRaw / markTaskLucasAcked → lib/task-registry.js

async function runLucasProactiveLoop() {
  logger.info('Lucas 主动循环触发');
  try {
    // 构建大小写不敏感的成员 userId 反查表（覆盖所有组织成员，不只家人）
    const memberUserIdMap = {};
    for (const realId of Object.keys(getOrgMembers())) {
      memberUserIdMap[realId.toLowerCase()] = realId;
    }

    // ── Part 1：ChromaDB 未交付承诺跟进 ─────────────────────────────────────
    const commitments = await fetchPendingCommitments();
    if (commitments.length > 0) {
      for (const c of commitments) {
        const storedUserId = c.userId || '';
        const strippedId = storedUserId.startsWith('wecom-') ? storedUserId.slice(6) : storedUserId;
        const realUserId = memberUserIdMap[strippedId.toLowerCase()];
        if (!realUserId) continue;

        const requirement = (c.context || '').trim();
        if (!requirement) continue;

        const message = `提醒：以下需求你之前已经提交给开发团队，请**告知用户**当前状态（进行中/已完成/卡住）。不要重新触发流水线，除非你确认从未提交过。\n\n需求内容：${requirement}`;

        logger.info('Lucas 主动跟进承诺（异步触发）', { userId: realUserId, requirement: requirement.slice(0, 60) });
        markCommitmentNotified(c.id).catch(() => {});
        callGatewayAgent('lucas', message, realUserId)
          .then(reply => {
            logger.info('Lucas 主动跟进完成', { userId: realUserId, reply: (reply || '').slice(0, 100) });
            if (WECOM_OWNER_ID) {
              sendLongWeComMessage(WECOM_OWNER_ID, [
                `[Lucas 主动跟进] 对象：${realUserId}`,
                `承诺：${requirement.slice(0, 100)}`,
                `回复摘要：${(reply || '（无回复）').slice(0, 200)}`,
              ].join('\n')).catch(() => {});
            }
          })
          .catch(e => logger.error('Lucas 主动跟进失败', { userId: realUserId, error: e.message }));
      }
    } else {
      logger.info('Lucas 主动循环：无待办承诺');
    }

    // ── Part 2：已完成但未告知的开发任务（ClaudeCode 模式：不留沉默任务）────
    // 覆盖所有组织成员：家人、访客提交、系统工程师提交均检查
    const allTasks = readTaskRegistryRaw();

    // 2a. 已完成但 lucasAcked=false → 主动通知提交者
    const pendingAck = allTasks.filter(e => e.status === 'completed' && e.lucasAcked === false);
    for (const task of pendingAck) {
      const submittedBy = (task.submittedBy || '').trim();
      // 访客任务（visitor:CODE）→ 访客通过 Web 界面查看，静默标记即可
      if (submittedBy.startsWith('visitor:')) {
        markTaskLucasAcked(task.id);
        continue;
      }
      // UUID 格式（系统/工程师提交）→ 通知系统工程师
      const isUUID = /^[0-9a-f-]{36}$/.test(submittedBy);
      const targetUserId = isUUID
        ? WECOM_OWNER_ID
        : (memberUserIdMap[submittedBy.toLowerCase()] || WECOM_OWNER_ID);
      if (!targetUserId) { markTaskLucasAcked(task.id); continue; }

      const brief = task.deliveryBrief || task.requirement?.slice(0, 100) || '开发任务已完成';
      const message = [
        `[系统通知] 一个开发任务已完成，请主动告知提交者。`,
        ``,
        `任务完成情况：${brief}`,
        `任务 ID：${task.id}`,
        ``,
        `告知后请调用 ack_task_delivered 标记 task_id=${task.id}，防止重复通知。`,
      ].join('\n');

      logger.info('Lucas 主动告知任务完成（异步触发）', { userId: targetUserId, taskId: task.id });
      markTaskLucasAcked(task.id);  // 先标记，防止下次循环重复
      callGatewayAgent('lucas', message, targetUserId)
        .then(reply => logger.info('Lucas 任务完成告知完成', { taskId: task.id, reply: (reply || '').slice(0, 100) }))
        .catch(e => logger.error('Lucas 任务完成告知失败', { taskId: task.id, error: e.message }));
    }

    // 2b. 进行中任务超时检查：超过 estimatedHours×1.5 或兜底 6h → 主动上报
    const STALE_FALLBACK_MS = 6 * 60 * 60 * 1000; // 6h 兜底
    const staleTasks = allTasks.filter(e => {
      if (['completed', 'cancelled'].includes(e.status)) return false;
      const estMs = e.estimatedHours ? e.estimatedHours * 1.5 * 60 * 60 * 1000 : STALE_FALLBACK_MS;
      const ageMs = Date.now() - new Date(e.submittedAt).getTime();
      // 避免重复告警：同一任务上次告警距现在 < 2h 则跳过
      if (e.lastStaleAlertAt) {
        const alertAge = Date.now() - new Date(e.lastStaleAlertAt).getTime();
        if (alertAge < 2 * 60 * 60 * 1000) return false;
      }
      return ageMs > estMs;
    });
    // 合并所有超时任务为一次 Lucas 调用，避免 N 个并发 session 互相竞争 Gateway
    if (staleTasks.length > 0) {
      // 记录本次告警时间（先批量写，防止重复触发）
      try {
        const p = path.join(INSTANCE_ROOT, 'Data/learning/task-registry.json');
        const entries = JSON.parse(fs.readFileSync(p, 'utf8'));
        let dirty = false;
        for (const task of staleTasks) {
          const idx = entries.findIndex(e => e.id === task.id);
          if (idx >= 0) { entries[idx].lastStaleAlertAt = nowCST(); dirty = true; }
        }
        if (dirty) fs.writeFileSync(p, JSON.stringify(entries, null, 2), 'utf8');
      } catch {}

      // 找代表性提交者（优先 WECOM_OWNER_ID，其次取第一个有效 userId）
      let targetUserId = null;
      for (const task of staleTasks) {
        const submittedBy = (task.submittedBy || '').trim();
        if (submittedBy.startsWith('visitor:')) continue;
        const isUUID = /^[0-9a-f-]{36}$/.test(submittedBy);
        const uid = isUUID ? WECOM_OWNER_ID : (memberUserIdMap[submittedBy.toLowerCase()] || WECOM_OWNER_ID);
        if (uid) { targetUserId = uid; break; }
      }
      if (!targetUserId) targetUserId = WECOM_OWNER_ID;

      const taskLines = staleTasks.map(task => {
        const ageH = Math.round((Date.now() - new Date(task.submittedAt).getTime()) / 3600000);
        const phase = task.currentPhase || '进行中';
        const progressTool = (phase === 'planning' || phase === 'andy_designing') ? 'ask_andy' : 'ask_lisa';
        return `- ${task.requirement?.slice(0, 60) || task.id}（${ageH}h，阶段：${phase}，查进展：${progressTool}）`;
      }).join('\n');

      const batchMessage = [
        `[任务进度提醒] 以下 ${staleTasks.length} 个开发任务超时未完成，请逐一确认进展并告知提交者：`,
        ``,
        taskLines,
        ``,
        `按每个任务的"查进展"工具分别调用，确认后主动通知提交者。`,
      ].join('\n');

      logger.info('Lucas 主动上报超时任务（批量合并）', { count: staleTasks.length, userId: targetUserId });
      callGatewayAgent('lucas', batchMessage, targetUserId)
        .then(reply => logger.info('Lucas 超时任务批量上报完成', { count: staleTasks.length, reply: (reply || '').slice(0, 100) }))
        .catch(e => logger.error('Lucas 超时任务批量上报失败', { count: staleTasks.length, error: e.message }));
    }

    if (pendingAck.length === 0 && staleTasks.length === 0) {
      logger.info('Lucas 主动循环：无待告知任务、无超时任务');
    }
  } catch (e) {
    logger.error('Lucas 主动循环失败', { error: e.message });
  }
}

// ─── Main 主动监控循环 ─────────────────────────────────────────────────────────
//
// 每隔 MAIN_MONITOR_INTERVAL_MS 触发一次健康检查。
// Main agent 读取 HEARTBEAT.md → 调 scan_pipeline_health / scan_lucas_quality
// → 有异常才推送给业主；正常回复 HEARTBEAT_OK 不推送。

const MAIN_MONITOR_INTERVAL_MS = 4 * 60 * 60 * 1000; // 每 4 小时（紧急故障探测足够；日报在 HEARTBEAT.md 时间控制下每日一次）

async function runMainMonitorLoop() {
  if (!WECOM_OWNER_ID) return;
  logger.info('Main 监控循环触发');
  try {
    // 读取 HEARTBEAT.md 作为状态上下文
    const heartbeatPath = `${process.env.HOME}/.openclaw/workspace-main/HEARTBEAT.md`;
    let heartbeatContent = '';
    try {
      heartbeatContent = fs.readFileSync(heartbeatPath, 'utf8');
    } catch {}

    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const heartbeatPrompt = `[HEARTBEAT ${now}]\n\nHEARTBEAT.md 当前内容：\n${heartbeatContent}\n\n**三层监控协议（严格执行，禁止混层）**：\n\n【告警级别 3 · 紧急故障探测】\n调用 scan_pipeline_health。\n- 任何进程不在线 / Gateway 不可达 → 立即调用 notify_engineer 推送，一句话说清楚问题，然后回复 HEARTBEAT_OK 结束。\n- 一切正常 → 不推送，继续告警级别 2 判断。\n\n【告警级别 2 · 每日巡检日报】\n仅当「上次日报发送」距今超过 20 小时时才执行，否则跳过直接回复 HEARTBEAT_OK。\n执行时：\n1. 依次调用 evaluate_l0 / evaluate_l1 / evaluate_l2 / evaluate_l3 / evaluate_l4 / evaluate_l5\n2. 汇总为一条日报（按 L0~L5 分层），包含：各层状态、DPO 积累进度（审核待办）、待处理改进点\n3. 调用 notify_engineer 发送日报\n4. 更新「上次日报发送」时间\n\n【告警级别 1 · 正常静默】\n以上两层均无需推送时 → 直接回复 HEARTBEAT_OK，不生成任何其他内容。\n\n**铁律：除 notify_engineer 推送和日报发送外，禁止生成面向工程师的文字内容。OK 就是 OK。**`;

    // 使用独立消息历史，不污染业主会话
    const messages = [{ role: 'user', content: heartbeatPrompt }];
    const toolsCalled = [];
    let iterations = 0;
    let reply = '';

    const heartbeatSystem = MAIN_SYSTEM_PROMPT + '\n\n【当前交互来源：HEARTBEAT 自动触发】这是定时监控检查，不是业主主动发消息。只在发现真实异常时才通知业主，正常状态回复 HEARTBEAT_OK。\n\n**汇报格式（强制）**：所有推送给工程师的消息必须按 Lx 分层组织：\n## L0 Agents基础设施\n[各 PM2 进程名称+状态+运行时长+重启次数、Gateway 状态、关键端口]\n## L1 Agent 人格化\n[Lucas 质量、Andy/Lisa 活跃度、蒸馏产出、evaluator 状态]\n## L2 Engineering Anything\n[任务类型覆盖度、端到端交付成功率、交付物多样性、三角色流水线健康]\n## L3 组织协作进化\n[①成员画像/②协作关系图谱/③影子Agent演进/④跨成员感知蒸馏]\n## L4 系统自进化\n[系统层：AGENTS.md规则收敛+路由阈值进化+Andy巡检时效+Skill积累 | 模型层：DPO积累进度/本地路由比例/本地模型就绪]\n规则：某层无问题写 ✅ 无异常，不要省略该层。L0 必须包含具体进程状态和数据。\n\n可用评估工具：evaluate_l0 / evaluate_l1 / evaluate_l2 / evaluate_l3 / evaluate_l4 / evaluate_system（依次调用 L0~L4）。';
    while (iterations++ < 10) {
      const response = await callMainModel(heartbeatSystem, messages);

      const msg          = response.choices?.[0]?.message || {};
      const finishReason = response.choices?.[0]?.finish_reason;
      const toolCalls    = msg.tool_calls || [];

      if (finishReason === 'stop' || toolCalls.length === 0) {
        reply = stripThink(msg.content);
        break;
      }

      messages.push({ role: 'assistant', content: msg.content || null, tool_calls: toolCalls });
      const toolResults = await Promise.all(
        toolCalls.map(async (toolCall) => {
          const name  = toolCall.function.name;
          const input = JSON.parse(toolCall.function.arguments || '{}');
          toolsCalled.push(name);
          logger.info('Main 监控循环调用工具', { tool: name });
          const result = await executeMainTool(name, input);
          return { role: 'tool', tool_call_id: toolCall.id, content: String(result) };
        })
      );
      messages.push(...toolResults);
    }

    logger.info('Main 监控循环完成', { reply: reply.slice(0, 100), toolsCalled });

    // 只在有异常时推送（非 HEARTBEAT_OK）
    if (reply && !reply.toUpperCase().includes('HEARTBEAT_OK')) {
      // 从回复中提取告警等级
      let alertLevel = '🟡';
      if (reply.includes('🔴') || reply.includes('❌')) alertLevel = '🔴';
      else if (reply.includes('🟢') || (!reply.includes('⚠️') && !reply.includes('❌'))) alertLevel = '🟢';
      const alertText = `[Main 监控报告] 告警等级：${alertLevel}\n${reply}`;
      // bot 协议不支持 userId，只走 HTTP API
      try {
        await sendWeComMessage(WECOM_OWNER_ID, alertText);
        logger.info('Main 监控：异常已推送给业主 (app)');
      } catch (e) {
        logger.error('Main 监控推送失败', { error: e.message });
      }
    }

    // 更新 HEARTBEAT.md 的运行记录
    try {
      const nowIso = nowCST();
      let hb = fs.readFileSync(heartbeatPath, 'utf8');
      hb = hb.replace(/- 上次健康检查：.*/,  `- 上次健康检查：${nowIso}`);
      if (toolsCalled.includes('evaluate_l1') || toolsCalled.includes('scan_lucas_quality')) {
        hb = hb.replace(/- 上次质量扫描：.*/, `- 上次质量扫描：${nowIso}`);
        hb = hb.replace(/  - 上次扫描：.*/,   `  - 上次扫描：${nowIso}`);
      }
      if (toolsCalled.includes('evaluate_l2') || toolsCalled.includes('evaluate_l3') || toolsCalled.includes('evaluate_l4') || toolsCalled.includes('evaluate_l5')) {
        hb = hb.replace(/- 上次L2~L5巡检：.*/, `- 上次L2~L5巡检：${nowIso}`);
      }
      fs.writeFileSync(heartbeatPath, hb, 'utf8');
    } catch (e) {
      logger.warn('Main 监控：更新 HEARTBEAT.md 失败', { error: e.message });
    }
  } catch (e) {
    logger.error('Main 监控循环失败', { error: e.message });
  }
}


// ─── Main 周度自动评估（每周日 22:00-22:30 CST）────────────────────────────────
async function runMainWeeklyEvaluation() {
  logger.info('Main 周度自动评估触发');
  try {
    const result = await executeMainTool('evaluate_system', { _trigger: 'weekly_auto' });
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const msg = `【Main 周度自动评估 ${now}】\n\n${result}`;
    fetch(`http://localhost:${PORT}/api/wecom/notify-engineer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'report', fromAgent: 'main', message: msg }),
    }).catch(e => logger.warn('Main 周度评估推送失败', { error: e.message }));
    logger.info('Main 周度自动评估完成');
  } catch (e) {
    logger.error('Main 周度自动评估失败', { error: e.message });
  }
}

// ─── Andy HEARTBEAT 巡检循环（L4 系统自我演化）────────────────────────────────────
//
// 每 24 小时触发一次，预计算 Kuzu 结晶候选 + skill-candidates.jsonl pending 条目，
// 拼入 heartbeat prompt 后调 Andy，Andy 决策是否固化、发送提案给系统工程师。

// Andy HEARTBEAT 固定在每天 23:00-23:30 CST 运行（夜间批量，收集全天信号后统一规划）

async function runAndyHeartbeatLoop() {
  logger.info('Andy HEARTBEAT 巡检循环触发');
  try {
    const now = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    const PYTHON311 = '/opt/homebrew/opt/python@3.11/bin/python3.11';
    const kuzuPath  = path.join(INSTANCE_ROOT, 'data', 'kuzu');

    // 预计算1：高置信度结晶候选（has_pattern, confidence >= 0.8）
    let precomputedPatterns = '无高置信度候选（confidence >= 0.8）';
    const kuzuScript = `
import sys, json, os
sys.path.insert(0, '/opt/homebrew/lib/python3.11/site-packages')
try:
    import kuzu
    db   = kuzu.Database('${kuzuPath}')
    conn = kuzu.Connection(db)
    r    = conn.execute("""
        MATCH (a:Entity)-[f:Fact]->(p:Entity)
        WHERE f.relation = 'has_pattern' AND f.confidence >= 0.8
        RETURN a.name, p.name, f.confidence, f.context
        ORDER BY f.confidence DESC LIMIT 20
    """)
    rows = []
    while r.has_next():
        row = r.get_next()
        rows.append({'agent': row[0], 'pattern': row[1], 'confidence': row[2], 'context': row[3]})
    print(json.dumps(rows))
except Exception as e:
    print(json.dumps({'error': str(e)}))
sys.stdout.flush()
os._exit(0)
`.trim();
    try {
      const tmpPy = path.join(INSTANCE_ROOT, 'temp', `andy-hb-kuzu-${Date.now()}.py`);
      fs.mkdirSync(path.join(INSTANCE_ROOT, 'temp'), { recursive: true });
      fs.writeFileSync(tmpPy, kuzuScript);
      const raw = execSync(`${PYTHON311} ${tmpPy}`, { encoding: 'utf8', timeout: 20000 }).trim();
      try { fs.unlinkSync(tmpPy); } catch (_) {}
      const patterns = JSON.parse(raw);
      if (Array.isArray(patterns) && patterns.length > 0) {
        precomputedPatterns = patterns.map(p =>
          `- [${(p.confidence * 100).toFixed(0)}%] ${p.pattern}（${p.agent}）${p.context ? `\n  上下文：${p.context.slice(0, 80)}` : ''}`
        ).join('\n');
      }
    } catch (e) {
      precomputedPatterns = `查询失败：${e.message.slice(0, 80)}`;
    }

    // 预计算2：skill-candidates.jsonl 中的 pending 条目
    let precomputedSkillCandidates = '无 pending 候选';
    const skillCandPath = path.join(INSTANCE_ROOT, 'data/learning/skill-candidates.jsonl');
    try {
      if (fs.existsSync(skillCandPath)) {
        const lines = fs.readFileSync(skillCandPath, 'utf8').split('\n').filter(l => l.trim());
        const pending = lines.map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean)
          .filter(c => !c.status || c.status === 'pending');
        if (pending.length > 0) {
          precomputedSkillCandidates = pending.map(c =>
            `- ${c.pattern_name}：${c.description}（建议形式：${c.suggested_form || '未指定'}，时间：${(c.timestamp || '').slice(0, 10)}）`
          ).join('\n');
        }
      }
    } catch (e) {
      precomputedSkillCandidates = `读取失败：${e.message.slice(0, 60)}`;
    }

    // 预计算3：andy-goals.jsonl 上轮 in_progress 条目（Loop 2 目标闭环）
    let precomputedInProgressGoals = '无上轮进行中目标';
    const goalsPath = path.join(INSTANCE_ROOT, 'Data', 'learning', 'andy-goals.jsonl');
    try {
      if (fs.existsSync(goalsPath)) {
        const lines = fs.readFileSync(goalsPath, 'utf8').split('\n').filter(l => l.trim());
        const inProgress = lines
          .map(l => { try { return JSON.parse(l); } catch { return null; } })
          .filter(Boolean)
          .filter(g => g.status === 'in_progress');
        if (inProgress.length > 0) {
          precomputedInProgressGoals = inProgress.map(g =>
            `- [${g.id}] ${g.description}\n  触发：${g.trigger}，时间：${(g.generatedAt || '').slice(0, 10)}\n  当前行动：${g.actionTaken}`
          ).join('\n');
        }
      }
    } catch (e) {
      precomputedInProgressGoals = `读取失败：${e.message.slice(0, 60)}`;
    }

    // 读 Andy HEARTBEAT.md 作为行为规则上下文
    const andyHbPath = path.join(process.env.HOME, '.openclaw', 'workspace-andy', 'HEARTBEAT.md');
    let andyHeartbeatContent = '';
    try { andyHeartbeatContent = fs.readFileSync(andyHbPath, 'utf8'); } catch {}

    // 预计算4：behavior_patterns（检查 5 需要的 Andy 行为模式）
    let precomputedBehaviorPatterns = '无近期 behavior_patterns 数据';
    try {
      const bpColResp = await fetch(`${CHROMA_API_BASE}/behavior_patterns`);
      if (bpColResp.ok) {
        const { id: bpColId } = await bpColResp.json();
        const bpResp = await fetch(`${CHROMA_API_BASE}/${bpColId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            where: { agent: { '$eq': 'andy' } },
            include: ['documents', 'metadatas'],
            limit: 20,
          }),
        });
        if (bpResp.ok) {
          const bpData = await bpResp.json();
          const bpDocs = bpData.documents || [];
          const bpMetas = bpData.metadatas || [];
          if (bpDocs.length > 0) {
            precomputedBehaviorPatterns = bpDocs.map((doc, i) => {
              const m = bpMetas[i] || {};
              return `- [${m.pattern_type || 'unknown'}] ${(doc || '').slice(0, 120)}（${(m.timestamp || '').slice(0, 10)}）`;
            }).join('\n');
          }
        }
      }
    } catch (e) {
      precomputedBehaviorPatterns = `读取失败：${e.message.slice(0, 60)}`;
    }

    // 预计算5：knowledge_injection（检查 7 需要的近期知识注入）
    let precomputedKnowledgeInjections = '无近期知识注入';
    try {
      const decColResp = await fetch(`${CHROMA_API_BASE}/decisions`);
      if (decColResp.ok) {
        const { id: decColId } = await decColResp.json();
        const kiResp = await fetch(`${CHROMA_API_BASE}/${decColId}/get`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            where: { '$and': [{ agent: { '$eq': 'andy' } }, { type: { '$eq': 'knowledge_injection' } }] },
            include: ['documents', 'metadatas'],
            limit: 10,
          }),
        });
        if (kiResp.ok) {
          const kiData = await kiResp.json();
          const kiDocs = kiData.documents || [];
          const kiMetas = kiData.metadatas || [];
          if (kiDocs.length > 0) {
            precomputedKnowledgeInjections = kiDocs.map((doc, i) => {
              const m = kiMetas[i] || {};
              return `- [${(m.timestamp || '').slice(0, 10)}] ${m.topic || '无主题'}：${(doc || '').slice(0, 150)}`;
            }).join('\n');
          }
        }
      }
    } catch (e) {
      precomputedKnowledgeInjections = `读取失败：${e.message.slice(0, 60)}`;
    }

    // 预计算6：主动学习状态（检查 9 需要的学习进度）
    let precomputedLearningState = '无学习记录（首次学习）';
    try {
      const learningStatePath = path.join(INSTANCE_ROOT,'Data', 'learning', 'andy-learning-state.json');
      if (fs.existsSync(learningStatePath)) {
        const ls = JSON.parse(fs.readFileSync(learningStatePath, 'utf8'));
        const lastStudy = ls.lastStudyAt || '从未';
        const readFiles = ls.readFiles || [];
        const daysSince = ls.lastStudyAt
          ? Math.floor((Date.now() - new Date(ls.lastStudyAt).getTime()) / 86400000)
          : Infinity;
        precomputedLearningState = `上次学习：${lastStudy}（${daysSince === Infinity ? '从未学习' : `${daysSince} 天前`}）\n已读文件（${readFiles.length} 篇）：${readFiles.length > 0 ? readFiles.join('、') : '无'}\n${daysSince >= 7 ? '⚡ 距上次学习已超 7 天，建议本轮触发学习' : '距上次学习不足 7 天，可跳过'}`;
      }
    } catch (e) {
      precomputedLearningState = `读取失败：${e.message.slice(0, 60)}`;
    }

    // ── 预计算7：spec 回溯数据（检查 10，每周一次）──────────────────────────
    let precomputedSpecRetro = '无 spec 数据';
    try {
      const retroStatePath = path.join(INSTANCE_ROOT,'Data', 'learning', 'andy-spec-retro-state.json');
      const retroState = fs.existsSync(retroStatePath) ? JSON.parse(fs.readFileSync(retroStatePath, 'utf8')) : {};
      const lastRetro = retroState.lastRetroAt;
      const daysSinceRetro = lastRetro ? Math.floor((Date.now() - new Date(lastRetro).getTime()) / 86400000) : Infinity;
      if (daysSinceRetro < 7) {
        precomputedSpecRetro = `本周已回溯（${daysSinceRetro} 天前），跳过`;
      } else {
        // 从 opencode-results.jsonl 读最近 7 天的 spec 结果
        const resultsPath = path.join(INSTANCE_ROOT,'CrewHiveClaw', 'data', 'learning', 'opencode-results.jsonl');
        if (fs.existsSync(resultsPath)) {
          const lines = fs.readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean);
          const weekAgo = Date.now() - 7 * 86400000;
          const recentSpecs = lines.slice(-30).map(l => { try { return JSON.parse(l); } catch { return null; } })
            .filter(r => r && new Date(r.timestamp).getTime() > weekAgo);
          if (recentSpecs.length > 0) {
            const successCount = recentSpecs.filter(r => r.success).length;
            const matchRates = recentSpecs.filter(r => r.matchRate !== undefined).map(r => r.matchRate);
            const avgMatch = matchRates.length > 0 ? Math.round(matchRates.reduce((a, b) => a + b, 0) / matchRates.length) : 'N/A';
            precomputedSpecRetro = [
              `近 7 天 opencode 结果：${recentSpecs.length} 次（成功 ${successCount}）`,
              `spec 吻合率：平均 ${avgMatch}%`,
              `⚡ 距上次回溯已 ${daysSinceRetro === Infinity ? '从未' : `${daysSinceRetro} 天`}，建议本轮触发`,
              ...recentSpecs.slice(-5).map(r => `  - ${r.taskSummary?.slice(0, 60) || '未知'}：${r.success ? '✅' : '❌'}（${r.matchRate !== undefined ? `${r.matchRate}%` : 'N/A'}）`),
            ].join('\n');
          } else {
            precomputedSpecRetro = '近 7 天无 opencode 记录，跳过';
          }
        }
      }
    } catch (e) {
      precomputedSpecRetro = `读取失败：${e.message.slice(0, 60)}`;
    }

    // ── 预计算8：技术雷达状态（检查 11，每两周一次）──────────────────────────
    let precomputedTechRadar = '冷却中';
    try {
      const searchStatePath = path.join(INSTANCE_ROOT,'Data', 'learning', 'andy-self-search-state.json');
      const searchState = fs.existsSync(searchStatePath) ? JSON.parse(fs.readFileSync(searchStatePath, 'utf8')) : {};
      const lastSearch = searchState.lastSearchAt;
      const daysSinceSearch = lastSearch ? Math.floor((Date.now() - new Date(lastSearch).getTime()) / 86400000) : Infinity;
      if (daysSinceSearch >= 14) {
        const searchedTopics = searchState.searchedTopics || [];
        precomputedTechRadar = `距上次技术搜索已 ${daysSinceSearch === Infinity ? '∞' : `${daysSinceSearch} 天`}（≥14 天可触发）\n已搜索主题：${searchedTopics.length > 0 ? searchedTopics.slice(-5).join('、') : '无'}\n⚡ 建议本轮触发技术雷达搜索`;
      } else {
        precomputedTechRadar = `距上次搜索 ${daysSinceSearch} 天（<14 天，跳过）`;
      }
    } catch (e) {
      precomputedTechRadar = `读取失败：${e.message.slice(0, 60)}`;
    }

    // ── 预计算9：代码图谱变化摘要（检查 12，每日）──────────────────────────
    let precomputedCodeGraphChanges = '未运行';
    try {
      const graphLogPath = path.join(INSTANCE_ROOT,'Logs', 'build-code-graph.log');
      if (fs.existsSync(graphLogPath)) {
        const logContent = fs.readFileSync(graphLogPath, 'utf8').trim();
        const lastRunLine = logContent.split('\n').filter(l => l.includes('增量重建完成') || l.includes('Done')).slice(-1)[0];
        if (lastRunLine) {
          // 提取最近一次运行的统计
          const recentLines = logContent.split('\n').slice(-20);
          const stats = recentLines.filter(l =>
            l.includes('新增') || l.includes('删除') || l.includes('更新') ||
            l.includes('节点') || l.includes('边') || l.includes('文件')
          ).join('\n');
          if (stats) {
            precomputedCodeGraphChanges = stats.slice(0, 500);
          } else {
            precomputedCodeGraphChanges = '增量重建已完成，无显著变化';
          }
        } else {
          precomputedCodeGraphChanges = '今日尚未运行';
        }
      }
    } catch (e) {
      precomputedCodeGraphChanges = `读取失败：${e.message.slice(0, 60)}`;
    }

    // ── 预计算10：架构提案信号（检查 13，每月一次）────────────────────────
    let precomputedArchProposalSignals = '信号不足';
    try {
      // 查 ChromaDB decisions 中近 30 天的反思类条目
      const chromaUrl = `http://localhost:8001/api/v1/collections`;
      // 先获取 decisions collection ID
      const collectionsResp = await fetch(chromaUrl, { method: 'GET' });
      const collections = await collectionsResp.json();
      const decisionsCol = (collections || []).find(c => c.name === 'decisions');
      if (decisionsCol) {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().replace('Z', '+08:00');
        // 查反思类信号数量
        const signalTypes = ['spec_reflection', 'capability_gap_proposal', 'architecture_drift', 'spec_retrospective'];
        let signalParts = [];
        for (const st of signalTypes) {
          const where = { type: { $eq: st } };
          const getResp = await fetch(`http://localhost:8001/api/v1/collections/${decisionsCol.id}/get`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ where, include: ['documents', 'metadatas'], limit: 10 }),
          });
          if (getResp.ok) {
            const data = await getResp.json();
            const count = (data.ids || []).length;
            if (count > 0) {
              const topics = (data.documents || []).slice(0, 3).map(d => d.slice(0, 80)).join('；');
              signalParts.push(`${st}：${count} 条（${topics}）`);
            }
          }
        }
        if (signalParts.length > 0) {
          // 检查冷却
          const proposalStatePath = path.join(INSTANCE_ROOT,'Data', 'learning', 'andy-arch-proposal-state.json');
          const proposalState = fs.existsSync(proposalStatePath) ? JSON.parse(fs.readFileSync(proposalStatePath, 'utf8')) : {};
          const daysSinceProposal = proposalState.lastProposalAt
            ? Math.floor((Date.now() - new Date(proposalState.lastProposalAt).getTime()) / 86400000) : Infinity;
          precomputedArchProposalSignals = [
            signalParts.join('\n'),
            daysSinceProposal >= 30 ? '⚡ 距上次提案已超 30 天，建议本轮审查并决定是否提案' : `距上次提案 ${daysSinceProposal} 天（<30 天，冷却中）`,
          ].join('\n');
        }
      }
    } catch (e) {
      precomputedArchProposalSignals = `读取失败：${e.message.slice(0, 60)}`;
    }

    // ── 预计算11：技术债信号（检查 14，每两周一次）────────────────────────
    let precomputedTechDebtSignals = '无异常';
    try {
      // 检查冷却
      const debtStatePath = path.join(INSTANCE_ROOT,'Data', 'learning', 'andy-tech-debt-state.json');
      const debtState = fs.existsSync(debtStatePath) ? JSON.parse(fs.readFileSync(debtStatePath, 'utf8')) : {};
      const daysSinceDebt = debtState.lastDebtScanAt
        ? Math.floor((Date.now() - new Date(debtState.lastDebtScanAt).getTime()) / 86400000) : Infinity;
      if (daysSinceDebt >= 14) {
        // 读 opencode-results.jsonl 找高频修改文件
        const resultsPath = path.join(INSTANCE_ROOT,'CrewHiveClaw', 'data', 'learning', 'opencode-results.jsonl');
        if (fs.existsSync(resultsPath)) {
          const lines = fs.readFileSync(resultsPath, 'utf8').trim().split('\n').filter(Boolean);
          const recentResults = lines.slice(-50).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
          // 统计文件变更频率
          const fileChangeCount = {};
          for (const r of recentResults) {
            if (r.filesChanged) {
              for (const f of r.filesChanged.split(',').filter(Boolean)) {
                fileChangeCount[f] = (fileChangeCount[f] || 0) + 1;
              }
            }
          }
          const hotFiles = Object.entries(fileChangeCount)
            .filter(([_, c]) => c >= 3)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
          if (hotFiles.length > 0) {
            precomputedTechDebtSignals = [
              '⚡ 高频修改文件（近 50 次变更中出现 ≥3 次）：',
              ...hotFiles.map(([f, c]) => `  - ${f}：${c} 次`),
              `距上次扫描已 ${daysSinceDebt === Infinity ? '∞' : `${daysSinceDebt} 天`}（≥14 天可触发）`,
            ].join('\n');
          } else {
            precomputedTechDebtSignals = `无高频修改文件（距上次扫描 ${daysSinceDebt === Infinity ? '∞' : `${daysSinceDebt} 天`}）`;
          }
        }
      } else {
        precomputedTechDebtSignals = `冷却中（距上次扫描 ${daysSinceDebt} 天，<14 天）`;
      }
    } catch (e) {
      precomputedTechDebtSignals = `读取失败：${e.message.slice(0, 60)}`;
    }

    const heartbeatPrompt = `[ANDY 夜间自我进化计划 ${now}]

今天已结束。以下是今天积累的所有进化信号，你的任务是**综合分析后输出改进计划**。

---

${andyHeartbeatContent}

---

【今日信号汇总】

上轮进行中目标（需先闭环）：
${precomputedInProgressGoals}

Kuzu 高置信度结晶候选（confidence >= 0.8）：
${precomputedPatterns}

Skill 候选积压（skill-candidates.jsonl pending）：
${precomputedSkillCandidates}

Andy 近期行为模式（behavior_patterns）：
${precomputedBehaviorPatterns}

近期知识注入（knowledge_injection）：
${precomputedKnowledgeInjections}

主动学习状态：
${precomputedLearningState}

Spec 回溯数据（每周一次）：
${precomputedSpecRetro}

技术雷达状态（每两周一次）：
${precomputedTechRadar}

代码图谱变化摘要（每日）：
${precomputedCodeGraphChanges}

架构提案信号（每月一次）：
${precomputedArchProposalSignals}

技术债信号（每两周一次）：
${precomputedTechDebtSignals}

---

## 你的任务

**第一步：综合分析**（整体看完所有信号再判断，不要逐条处理）
- 哪些信号今天最重要？
- 哪些信号相互关联，可以合并为一个改进任务？
- 优先级：修复质量退化 > 改进流水线 > 能力扩展 > 技术探索

**第二步：输出改进计划**（严格按以下 JSON 格式，基础设施会自动提交到流水线，逐条执行）

输出一个 JSON 代码块，格式如下：

\`\`\`json
[
  {
    "title": "任务标题（30字以内）",
    "description": "具体要做什么，包含足够的上下文让实现时直接理解（100字以内）",
    "action_type": "code_fix | agents_md | skill_crystallization | spec_improvement | tech_research | architecture_proposal",
    "priority": "high | medium | low",
    "requires_approval": false
  }
]
\`\`\`

**requires_approval 规则**：
- \`agents_md\` 且涉及核心行为规则变更 → true（SE 在看板批准）
- \`architecture_proposal\` → true
- 其他所有 → false（直接进队列，系统自主执行）

**限制**：
- 最多 5 条任务，按优先级排序
- 只提有明确信号支撑的改进（无信号不造任务）
- 上轮 in_progress 目标必须先在 andy-goals.jsonl 中标记 completed/abandoned，再生成新任务`;

    // 调用 Andy（独立 session，Plan 模式，不影响正常流水线）
    logger.info('Andy HEARTBEAT 夜间规划：发送 prompt', { signalCount: 11 });
    callGatewayAgent('andy', heartbeatPrompt, 'heartbeat-cron', 600000)
      .then(reply => {
        logger.info('Andy HEARTBEAT 规划完成', { reply: (reply || '').slice(0, 200) });

        // ── 解析 Andy 输出的改进计划 JSON，逐条提交到 task-registry.json ──────────
        let submittedCount = 0, pendingReviewCount = 0;
        try {
          const jsonMatch = (reply || '').match(/```json\s*([\s\S]*?)```/);
          if (jsonMatch) {
            const plan = JSON.parse(jsonMatch[1].trim());
            if (Array.isArray(plan) && plan.length > 0) {
              const taskRegPath = path.join(INSTANCE_ROOT, 'Data', 'learning', 'task-registry.json');
              let entries = [];
              try { entries = JSON.parse(fs.readFileSync(taskRegPath, 'utf8')); } catch {}
              const nowIso = new Date().toISOString();
              for (const t of plan.slice(0, 5)) { // 最多 5 条
                if (!t.title || !t.description) continue;
                const requiresApproval = !!(t.requires_approval);
                entries.push({
                  id: `req_hb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                  requirement: t.description,
                  title: t.title,
                  submittedBy: 'andy-heartbeat',
                  submittedAt: nowIso,
                  status: requiresApproval ? 'pending-review' : 'queued',
                  taskType: t.action_type || 'code_fix',
                  priority: t.priority || 'medium',
                  requires_approval: requiresApproval,
                  source: 'andy-heartbeat',
                  lucasAcked: false,
                });
                if (requiresApproval) pendingReviewCount++; else submittedCount++;
              }
              fs.writeFileSync(taskRegPath, JSON.stringify(entries, null, 2), 'utf8');
              logger.info('Andy HEARTBEAT：改进计划已提交流水线', { autoQueued: submittedCount, pendingReview: pendingReviewCount });
            }
          }
        } catch (e) {
          logger.warn('Andy HEARTBEAT：解析计划 JSON 失败', { error: e.message });
        }

        // 通知 SE：推送计划摘要（无论是否有任务都通知，让 SE 知道规划完成了）
        if (WECOM_OWNER_ID) {
          const taskNote = submittedCount + pendingReviewCount > 0
            ? `\n自动进队：${submittedCount} 条 | 待批准：${pendingReviewCount} 条`
            : '\n无改进任务（各项指标正常）';
          sendLongWeComMessage(WECOM_OWNER_ID, `[Andy 夜间规划完成] ${now}${taskNote}\n\n${(reply || '').slice(0, 500)}`)
            .then(() => logger.info('Andy HEARTBEAT：规划报告已推送 SE'))
            .catch(e => logger.warn('Andy HEARTBEAT：推送 SE 失败', { error: e.message }));
        }

        // 更新 Andy HEARTBEAT.md 时间戳
        try {
          const nowIso = nowCST();
          let hb = fs.readFileSync(andyHbPath, 'utf8');
          if (hb.includes('- 上次巡检：')) {
            hb = hb.replace(/- 上次巡检：.*/, `- 上次巡检：${nowIso}`);
          } else {
            hb += `\n\n---\n\n- 上次巡检：${nowIso}\n`;
          }
          fs.writeFileSync(andyHbPath, hb, 'utf8');
        } catch (e) {
          logger.warn('Andy HEARTBEAT：更新时间戳失败', { error: e.message });
        }
      })
      .catch(e => logger.error('Andy HEARTBEAT 调用失败', { error: e.message }));

  } catch (e) {
    logger.error('Andy HEARTBEAT 循环失败', { error: e.message });
  }
}


  return {
    runLucasProactiveLoop,
    runMainMonitorLoop,
    runMainWeeklyEvaluation,
    runAndyHeartbeatLoop,
  };
};
