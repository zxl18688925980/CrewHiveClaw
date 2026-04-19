/**
 * JWT 认证中间件
 *
 * api_key 基于 JWT，payload 含 instance_id 字段。
 * 上传语料时验证 token，权限范围：
 *   - 推理请求：读大师（由 OpenClaw Gateway 处理，不经过此服务）
 *   - 语料上传：写自己实例的容器（instance_id 必须匹配 token payload）
 *   - 管理接口：仅 HiveClaw SE 账号（HIVECLAW_SE_TOKEN 环境变量）
 */

import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.HIVECLAW_JWT_SECRET || "dev-secret-change-in-production";
const SE_TOKEN   = process.env.HIVECLAW_SE_TOKEN   || "";

export interface AuthPayload {
  instance_id: string;
  issued_at: number;
  role: "instance" | "admin";
}

declare global {
  namespace Express {
    interface Request {
      auth?: AuthPayload;
    }
  }
}

/**
 * 验证实例 api_key，注入 req.auth。
 */
export function requireInstanceAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as AuthPayload;
    req.auth = payload;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired api_key" });
  }
}

/**
 * 验证 SE 管理员 token（用于 add_readme_sample 等管理接口）。
 */
export function requireAdminAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers["authorization"];
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }
  const token = authHeader.slice(7);
  if (!SE_TOKEN || token !== SE_TOKEN) {
    res.status(403).json({ error: "Admin access denied" });
    return;
  }
  next();
}

/**
 * 生成实例 api_key（注册时调用）。
 * 📋 Dry Run：实际注册接口待云端部署后实现。
 */
export function issueApiKey(instance_id: string): string {
  const payload: AuthPayload = {
    instance_id,
    issued_at: Date.now(),
    role: "instance",
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: "90d" });
}
