/**
 * HiveClaw corpus-server 入口
 *
 * 语料上传服务端 + 实例注册 API
 * 端口：18790（与 OpenClaw Gateway 18789 区分）
 */

import express from "express";
import { router } from "./routes.js";

const PORT = parseInt(process.env.CORPUS_SERVER_PORT ?? "18790", 10);

const app = express();

// JSONL body parser
app.use((req, _res, next) => {
  const ct = req.headers["content-type"] ?? "";
  if (ct.includes("application/x-ndjson") || ct.includes("application/jsonl")) {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
      (req as express.Request & { body: string }).body = body;
      next();
    });
  } else {
    express.json({ limit: "10mb" })(req, _res, next);
  }
});

app.use(router);

// 404 fallback
app.use((_req, res) => {
  res.status(404).json({ error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`[hiveclaw-corpus-server] Listening on port ${PORT} (Dry Run mode)`);
});

export default app;
