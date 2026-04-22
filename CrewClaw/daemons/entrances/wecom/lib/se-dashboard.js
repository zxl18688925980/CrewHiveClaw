'use strict';
/**
 * se-dashboard.js — SE 流水线任务看板 + 访客需求提交
 *
 * 包含：verifySEToken / GET pipeline-tasks / POST approve / POST cancel /
 *       POST demo-proxy/submit-requirement（访客提交开发需求 → 触发 Andy 流水线）
 *
 * 工厂函数：module.exports = (logger, deps) => express.Router()
 * deps: { WECOM_OWNER_ID, INSTANCE_ROOT, readTaskRegistry, writeTaskRegistry, loadInvites }
 */
const express = require('express');
const fs      = require('fs');
const path    = require('path');

module.exports = function createSEDashboard(logger, { WECOM_OWNER_ID, INSTANCE_ROOT, readTaskRegistry, writeTaskRegistry, loadInvites }) {
  const router = express.Router();
  const app = router;  // block uses app.get/app.post — aliased to router

// ─── SE 流水线任务看板（Main 专属，全量视图 + 叫停 + 批准）────────────────────
// 认证：X-SE-Token 必须等于 WECOM_OWNER_ID（SE 身份）
function verifySEToken(req, res) {
  const token = (req.headers['x-se-token'] || '').trim();
  if (!token || token !== WECOM_OWNER_ID) {
    res.status(403).json({ success: false, message: 'SE 身份验证失败' });
    return false;
  }
  return true;
}
// readTaskRegistry / writeTaskRegistry / inferTaskAgent → lib/task-registry.js

// GET /api/main/pipeline-tasks — SE 看全量任务（所有 submittedBy，含系统生成的）
app.get('/api/main/pipeline-tasks', (req, res) => {
  if (!verifySEToken(req, res)) return;
  const entries = readTaskRegistry();
  // 按状态排序：pending-review → queued → running → completed/failed（最近的在前）
  const order = { 'pending-review': 0, queued: 1, running: 2, completed: 3, failed: 4, cancelled: 5 };
  entries.sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || new Date(b.submittedAt) - new Date(a.submittedAt));
  res.json({ success: true, total: entries.length, tasks: entries });
});

// POST /api/main/pipeline-tasks/:id/approve — pending-review → queued（SE 批准）
app.post('/api/main/pipeline-tasks/:id/approve', (req, res) => {
  if (!verifySEToken(req, res)) return;
  const { id } = req.params;
  const entries = readTaskRegistry();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: '任务不存在' });
  if (entries[idx].status !== 'pending-review') {
    return res.status(400).json({ success: false, message: `当前状态 ${entries[idx].status}，只有 pending-review 可批准` });
  }
  entries[idx].status = 'queued';
  entries[idx].approvedAt = new Date().toISOString();
  entries[idx].approvedBy = 'se';
  writeTaskRegistry(entries);
  logger.info('SE 批准任务进队列', { taskId: id, title: entries[idx].title });
  res.json({ success: true, task: entries[idx] });
});

// POST /api/main/pipeline-tasks/:id/cancel — SE 叫停任意任务（不受 submittedBy 限制）
app.post('/api/main/pipeline-tasks/:id/cancel', (req, res) => {
  if (!verifySEToken(req, res)) return;
  const { id } = req.params;
  const { reason = 'SE 叫停' } = req.body || {};
  const entries = readTaskRegistry();
  const idx = entries.findIndex(e => e.id === id);
  if (idx === -1) return res.status(404).json({ success: false, message: '任务不存在' });
  if (['completed', 'cancelled'].includes(entries[idx].status)) {
    return res.status(400).json({ success: false, message: `任务已 ${entries[idx].status}，无法叫停` });
  }
  const prevStatus = entries[idx].status;
  entries[idx].status = 'cancelled';
  entries[idx].cancelledAt = new Date().toISOString();
  entries[idx].cancelledBy = 'se';
  entries[idx].cancelReason = reason;
  writeTaskRegistry(entries);
  logger.info('SE 叫停任务', { taskId: id, prevStatus, reason });
  res.json({ success: true, task: entries[idx] });
});

// POST /api/demo-proxy/submit-requirement — 访客提交开发需求
app.post('/api/demo-proxy/submit-requirement', async (req, res) => {
  const { requirement, visitorCode } = req.body || {};
  if (!requirement || !visitorCode) {
    return res.status(400).json({ success: false, message: '缺少 requirement 或 visitorCode' });
  }
  const code = visitorCode.trim().toUpperCase();
  try {
    // 验证邀请码是否有效
    const invites = loadInvites();
    const inviteEntry = Object.entries(invites).find(([token]) => token.toUpperCase() === code);
    if (!inviteEntry) {
      return res.status(401).json({ success: false, message: '邀请码无效' });
    }
    const visitorName = inviteEntry[1].name;
    const wecomUserId = `visitor:${code}`;

    // 生成需求 ID（与 trigger_development_pipeline 保持一致）
    const requirementId = `req_${Date.now()}`;

    // 写入 task-registry.json（模拟 upsertTaskRegistry）
    const TASK_REGISTRY_FILE = path.join(INSTANCE_ROOT, 'data/learning/task-registry.json');
    let entries = [];
    try {
      if (fs.existsSync(TASK_REGISTRY_FILE)) {
        entries = JSON.parse(fs.readFileSync(TASK_REGISTRY_FILE, 'utf8'));
      }
    } catch {}
    const nowCST = new Date(Date.now() + 8 * 3600000).toISOString().replace('Z', '+08:00');
    const idx = entries.findIndex(e => e.id === requirementId);
    const entry = {
      id: requirementId,
      requirement,
      submittedBy: wecomUserId,
      submittedAt: nowCST,
      status: 'running',
      currentPhase: 'andy_designing',
      visitorCode: code,
    };
    if (idx >= 0) entries[idx] = entry; else entries.push(entry);
    fs.writeFileSync(TASK_REGISTRY_FILE, JSON.stringify(entries, null, 2), 'utf8');

    // 异步触发 Andy 流水线（fire-and-forget）
    const GATEWAY_URL = process.env.GATEWAY_URL || 'http://localhost:18789';
    const GATEWAY_TOKEN = process.env.OPENCLAW_GATEWAY_TOKEN || '';
    const andyMessage = [
      `【访客开发需求 · ${requirementId}】`,
      `访客：${visitorName}（${code}）`,
      ``,
      requirement,
      ``,
      `请按顺序完成以下步骤：`,
      `1. 调用 research_task 调研技术背景和可行性`,
      `2. 输出完整 Implementation Spec`,
      `3. 调用 trigger_lisa_implementation，传入 spec、user_id="${wecomUserId}"、requirement_id="${requirementId}"`,
      ``,
      `完成后用一句话总结规划方案。`,
    ].join('\n');

    fetch(`${GATEWAY_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GATEWAY_TOKEN}`,
        'x-openclaw-agent-id': 'andy',
      },
      body: JSON.stringify({
        model: 'openclaw/andy',
        messages: [{ role: 'user', content: andyMessage }],
        stream: false,
      }),
    }).catch(err => logger.error('submit-requirement: Andy trigger failed', { err: err.message }));

    logger.info('访客需求已提交', { visitorCode: code, visitorName, requirementId, requirement: requirement.slice(0, 50) });
    res.json({ success: true, message: '需求已提交，我们会尽快处理' });
  } catch (e) {
    logger.error('submit-requirement error', { error: e.message, visitorCode: code });
    res.status(500).json({ success: false, message: '提交失败，请稍后重试' });
  }
});

  return router;
};
