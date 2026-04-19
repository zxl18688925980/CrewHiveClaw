/**
 * corpus-server 路由定义
 *
 * POST /api/instances/register   - 实例注册
 * POST /api/corpus/upload        - 语料上传
 * GET  /api/corpus/status        - 查询上传状态和配额
 * GET  /health                   - 健康检查
 */

import { Router } from "express";
import type { Request, Response } from "express";
import { requireInstanceAuth, requireAdminAuth, issueApiKey } from "./auth.js";
import type { InstanceRegistration, CorpusUploadItem, UploadBatchResult } from "../../hiveclaw-routing/src/types.js";

export const router = Router();

// ─── 健康检查 ────────────────────────────────────────────────────────────────

router.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    service: "hiveclaw-corpus-server",
    timestamp: new Date().toISOString(),
    dry_run: true,
  });
});

// ─── 实例注册 ────────────────────────────────────────────────────────────────

/**
 * POST /api/instances/register
 *
 * 请求体：InstanceRegistration
 * 响应：{ api_key, endpoints: { lucas, andy, lisa, readme } }
 *
 * 📋 Dry Run：注册信息写入内存，api_key 正常颁发；
 *             endpoints 指向 Dry Run 占位地址。
 */
router.post("/api/instances/register", (req: Request, res: Response) => {
  const body = req.body as Partial<InstanceRegistration>;

  if (!body.instance_id || !body.org_type || !body.corpus_consent) {
    res.status(400).json({ error: "instance_id, org_type, corpus_consent are required" });
    return;
  }
  if (!body.corpus_consent) {
    res.status(400).json({ error: "corpus_consent must be true to register" });
    return;
  }

  // TODO: 持久化注册信息到 storage
  const api_key = issueApiKey(body.instance_id);

  res.json({
    instance_id: body.instance_id,
    api_key,
    endpoints: {
      lucas:  "https://hive.{domain}/api/agent/lucas-master/chat",
      andy:   "https://hive.{domain}/api/agent/andy-master/chat",
      lisa:   "https://hive.{domain}/api/agent/lisa-master/chat",
      readme: "https://hive.{domain}/api/agent/readme-master/chat",
    },
    note: "Dry Run: endpoints are placeholder URLs, cloud deployment pending",
  });
});

// ─── 语料上传 ────────────────────────────────────────────────────────────────

/**
 * POST /api/corpus/upload
 * Content-Type: application/x-ndjson
 *
 * Body: JSONL，每行一条 CorpusUploadItem
 * Header: Authorization: Bearer {api_key}
 *
 * 速率限制：10 batch/day（由 rate-limiter 中间件控制，此处仅做格式校验）
 */
router.post("/api/corpus/upload", requireInstanceAuth, async (req: Request, res: Response) => {
  const instanceId = req.auth?.instance_id;
  if (!instanceId) {
    res.status(401).json({ error: "instance_id not found in token" });
    return;
  }

  // 解析 JSONL body
  const rawBody = req.body as string;
  const lines = typeof rawBody === "string"
    ? rawBody.split("\n").filter(Boolean)
    : [];

  if (lines.length === 0) {
    res.status(400).json({ error: "Empty batch" });
    return;
  }

  const batch: CorpusUploadItem[] = [];
  const parseErrors: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    try {
      const item = JSON.parse(lines[i]!) as CorpusUploadItem;
      // 强制写入上传来源（防止实例伪造他人 instance_id）
      item.instance_id = instanceId;
      batch.push(item);
    } catch {
      parseErrors.push(`第${i + 1}行：JSON 解析失败`);
    }
  }

  if (parseErrors.length > 0) {
    res.status(400).json({ error: "Parse errors", details: parseErrors });
    return;
  }

  // TODO: 调用 corpusIntake 写入暂存区（待 storage 连接后实现）
  const result: UploadBatchResult = {
    received: batch.length,
    accepted: 0,
    rejected: batch.length,
    reject_reasons: ["Dry Run: storage not yet connected, all items held in memory pending deployment"],
  };

  res.json(result);
});

// ─── 上传状态查询 ────────────────────────────────────────────────────────────

/**
 * GET /api/corpus/status
 *
 * 返回实例的语料配额使用情况。
 */
router.get("/api/corpus/status", requireInstanceAuth, (req: Request, res: Response) => {
  const instanceId = req.auth?.instance_id;
  // TODO: 从 storage 读取实例配额使用情况
  res.json({
    instance_id: instanceId,
    quota_used_pct: 0,
    corpus_counts: { active: 0, archive: 0 },
    note: "Dry Run: storage not yet connected",
  });
});
