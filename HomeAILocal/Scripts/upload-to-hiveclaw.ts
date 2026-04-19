#!/usr/bin/env tsx
/**
 * HomeAI → HiveClaw 语料上传客户端
 *
 * 职责：
 * 1. 读取本地三角色语料文件
 * 2. 转换为 HiveClaw JSONL 上传格式
 * 3. 运行格式校验 + 触发条件检查
 * 4. 上传到 HiveClaw corpus-server（dry-run 时只打印摘要）
 * 5. 归档已上传语料，清空本地文件等待下轮采集
 *
 * 用法：
 *   tsx upload-to-hiveclaw.ts                  # 检查触发条件，满足时上传
 *   tsx upload-to-hiveclaw.ts --dry-run        # 校验 + 摘要，不实际上传
 *   tsx upload-to-hiveclaw.ts --force          # 跳过触发条件检查，强制上传
 *   tsx upload-to-hiveclaw.ts --role lucas     # 只处理指定角色
 *
 * Dry Run 状态：endpoint 为占位地址，dry_run=true（config/hiveclaw.json）
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { spawnSync } from "node:child_process";

// ─── 配置加载 ────────────────────────────────────────────────────────────────

const CONFIG_PATH = join(
  import.meta.dirname ?? __dirname,
  "../Config/hiveclaw.json",
);

interface HiveClawConfig {
  instance_id: string;
  org_type: string;
  cloud: {
    corpus_upload_endpoint: string;
    health_endpoint: string;
  };
  upload_triggers: {
    min_new_dpo_samples: number;
    min_days_between_uploads: number;
    manual_override: boolean;
  };
  corpus: {
    lucas_file: string;
    andy_file: string;
    lisa_file: string;
    upload_history: string;
    archive_dir: string;
  };
  dry_run: boolean;
}

function loadConfig(): HiveClawConfig {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(`HiveClaw config not found: ${CONFIG_PATH}`);
  }
  const raw = readFileSync(CONFIG_PATH, "utf8");
  return JSON.parse(raw) as HiveClawConfig;
}

function resolvePath(p: string): string {
  return p.replace(/^~/, homedir());
}

// ─── HiveClaw 上传格式 ────────────────────────────────────────────────────────

type MasterRole = "lucas" | "andy" | "lisa";
type CorpusType = "dpo" | "sft" | "pattern";

interface HiveClawUploadItem {
  role: MasterRole;
  type: CorpusType;
  instance_id: string;
  content: {
    prompt: string;
    chosen?: string;
    rejected?: string;
    output?: string;
  };
  tags: string[];
  quality_score: number;
  uploaded_at: string;
}

// ─── 本地语料格式 → HiveClaw 格式转换 ─────────────────────────────────────────

/**
 * HomeAI 本地语料格式（ADR 风格，字段名不同于 HiveClaw 协议）。
 * 转换规则：
 * - dpo: chosen/rejected → HiveClaw content.chosen/rejected
 * - sft: output → HiveClaw content.output
 * - 缺少 type 字段时，有 chosen 判为 dpo，有 output 判为 sft，否则 pattern
 */
interface LocalCorpusEntry {
  role?: string;
  type?: string;
  prompt?: string;
  chosen?: string;
  rejected?: string;
  output?: string;
  input?: string;      // 旧版字段名
  response?: string;   // 旧版字段名
  tags?: string[];
  quality_score?: number;
  quality?: number;    // 旧版字段名
  created_at?: string;
  [key: string]: unknown;
}

function inferType(entry: LocalCorpusEntry): CorpusType {
  if (entry.type && ["dpo", "sft", "pattern"].includes(entry.type)) {
    return entry.type as CorpusType;
  }
  if (entry.chosen && entry.rejected) return "dpo";
  if (entry.output || entry.response) return "sft";
  return "pattern";
}

function toHiveClawFormat(
  entry: LocalCorpusEntry,
  role: MasterRole,
  instanceId: string,
): HiveClawUploadItem | null {
  const prompt = entry.prompt || entry.input;
  if (!prompt) return null;

  const type = inferType(entry);
  const qualityScore =
    typeof entry.quality_score === "number" ? entry.quality_score :
    typeof entry.quality === "number" ? entry.quality :
    0.70;  // 默认质量分

  const item: HiveClawUploadItem = {
    role,
    type,
    instance_id: instanceId,
    content: { prompt },
    tags: Array.isArray(entry.tags) ? entry.tags : [],
    quality_score: qualityScore,
    uploaded_at: new Date().toISOString(),
  };

  if (type === "dpo") {
    item.content.chosen   = entry.chosen;
    item.content.rejected = entry.rejected;
  } else if (type === "sft") {
    item.content.output = entry.output ?? entry.response;
  }

  return item;
}

// ─── 触发条件检查 ────────────────────────────────────────────────────────────

interface UploadHistory {
  role: MasterRole;
  uploaded_at: string;
  lines: number;
  status: string;
}

function checkTrigger(
  role: MasterRole,
  newItems: HiveClawUploadItem[],
  historyPath: string,
  triggers: HiveClawConfig["upload_triggers"],
  force: boolean,
): { should_upload: boolean; reason: string } {
  if (force || triggers.manual_override) {
    return { should_upload: true, reason: "强制触发" };
  }

  const dpoCount = newItems.filter((i) => i.type === "dpo").length;
  if (dpoCount < triggers.min_new_dpo_samples) {
    return {
      should_upload: false,
      reason: `DPO 样本不足（当前 ${dpoCount} 条，需 ≥ ${triggers.min_new_dpo_samples} 条）`,
    };
  }

  // 检查距上次上传时间
  if (existsSync(historyPath)) {
    const lines = readFileSync(historyPath, "utf8").trim().split("\n").filter(Boolean);
    const roleHistory = lines
      .map((l) => { try { return JSON.parse(l) as UploadHistory; } catch { return null; } })
      .filter((h): h is UploadHistory => !!h && h.role === role)
      .sort((a, b) => new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime());

    if (roleHistory.length > 0) {
      const lastUpload = new Date(roleHistory[0]!.uploaded_at);
      const daysSince = (Date.now() - lastUpload.getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < triggers.min_days_between_uploads) {
        return {
          should_upload: false,
          reason: `距上次上传仅 ${daysSince.toFixed(1)} 天（需 ≥ ${triggers.min_days_between_uploads} 天）`,
        };
      }
    }
  }

  return { should_upload: true, reason: `满足触发条件（DPO ${dpoCount} 条）` };
}

// ─── 格式校验（调用 Python 工具）────────────────────────────────────────────

function runValidation(tmpFile: string): boolean {
  const validator = join(
    import.meta.dirname ?? __dirname,
    "../../HiveClaw/local-client/validate-corpus.py",
  );
  if (!existsSync(validator)) {
    console.warn("[hiveclaw] 校验工具不存在，跳过格式校验");
    return true;
  }
  const result = spawnSync("python3", [validator, "--file", tmpFile], {
    encoding: "utf8",
    stdio: "pipe",
  });
  if (result.status !== 0) {
    console.error("[hiveclaw] 格式校验失败：");
    console.error(result.stdout);
    return false;
  }
  return true;
}

// ─── 上传到 HiveClaw ────────────────────────────────────────────────────────

async function uploadToHiveClaw(
  items: HiveClawUploadItem[],
  endpoint: string,
  apiKey: string,
): Promise<{ accepted: number; rejected: number }> {
  const body = items.map((i) => JSON.stringify(i)).join("\n");

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-ndjson",
      "Authorization": `Bearer ${apiKey}`,
    },
    body,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: HTTP ${response.status} ${await response.text()}`);
  }

  const result = await response.json() as { accepted: number; rejected: number };
  return result;
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function processRole(
  role: MasterRole,
  config: HiveClawConfig,
  dryRun: boolean,
  force: boolean,
): Promise<void> {
  const corpusKey = `${role}_file` as keyof typeof config.corpus;
  const corpusPath = resolvePath(config.corpus[corpusKey] as string);
  const historyPath = resolvePath(config.corpus.upload_history);
  const archiveDir  = resolvePath(config.corpus.archive_dir);

  console.log(`\n[${role}] 开始处理...`);

  if (!existsSync(corpusPath)) {
    console.log(`[${role}] 语料文件不存在，跳过`);
    return;
  }

  // 读取本地语料
  const rawLines = readFileSync(corpusPath, "utf8")
    .split("\n")
    .filter(Boolean);

  if (rawLines.length === 0) {
    console.log(`[${role}] 语料文件为空，跳过`);
    return;
  }

  // 转换格式
  const items: HiveClawUploadItem[] = [];
  let conversionErrors = 0;
  for (const line of rawLines) {
    try {
      const entry = JSON.parse(line) as LocalCorpusEntry;
      const converted = toHiveClawFormat(entry, role, config.instance_id);
      if (converted) items.push(converted);
      else conversionErrors++;
    } catch {
      conversionErrors++;
    }
  }

  console.log(`[${role}] 读取 ${rawLines.length} 条，转换 ${items.length} 条，跳过 ${conversionErrors} 条`);

  // 触发条件检查
  const trigger = checkTrigger(role, items, historyPath, config.upload_triggers, force);
  if (!trigger.should_upload) {
    console.log(`[${role}] 跳过上传：${trigger.reason}`);
    return;
  }
  console.log(`[${role}] 触发上传：${trigger.reason}`);

  // 写临时文件，运行格式校验
  const tmpPath = `/tmp/hiveclaw-upload-${role}-${Date.now()}.jsonl`;
  writeFileSync(tmpPath, items.map((i) => JSON.stringify(i)).join("\n") + "\n");

  const valid = runValidation(tmpPath);
  if (!valid) {
    console.error(`[${role}] 格式校验失败，终止上传`);
    return;
  }

  // Dry-run 摘要
  const dpoCount = items.filter((i) => i.type === "dpo").length;
  const sftCount = items.filter((i) => i.type === "sft").length;
  const avgScore = items.reduce((s, i) => s + i.quality_score, 0) / items.length;
  console.log(`[${role}] 摘要：DPO ${dpoCount} 条 | SFT ${sftCount} 条 | 平均质量分 ${avgScore.toFixed(3)}`);

  if (dryRun || config.dry_run) {
    console.log(`[${role}] DRY RUN：以上内容未实际上传`);
    return;
  }

  // 实际上传
  const apiKey = process.env.HIVECLAW_API_KEY ?? "";
  if (!apiKey) {
    console.error(`[${role}] HIVECLAW_API_KEY 未配置，终止上传`);
    return;
  }

  try {
    const result = await uploadToHiveClaw(items, config.cloud.corpus_upload_endpoint, apiKey);
    console.log(`[${role}] 上传完成：accepted ${result.accepted} | rejected ${result.rejected}`);

    // 归档
    mkdirSync(archiveDir, { recursive: true });
    const archivePath = join(archiveDir, `${role}-${new Date().toISOString().slice(0, 10)}.jsonl`);
    writeFileSync(archivePath, items.map((i) => JSON.stringify(i)).join("\n") + "\n");

    // 清空本地文件（开始下一轮采集周期）
    writeFileSync(corpusPath, "");
    console.log(`[${role}] 已归档到 ${archivePath}，本地文件已清空`);

    // 写上传历史
    const history: UploadHistory = {
      role,
      uploaded_at: new Date().toISOString(),
      lines: items.length,
      status: "uploaded",
    };
    appendFileSync(historyPath, JSON.stringify(history) + "\n");
  } catch (err) {
    console.error(`[${role}] 上传失败：${String(err)}`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force  = args.includes("--force");
  const roleArg = args.find((a) => !a.startsWith("--")) as MasterRole | undefined;

  const config = loadConfig();

  console.log(`[hiveclaw] HomeAI → HiveClaw 语料上传 (instance: ${config.instance_id})`);
  if (dryRun || config.dry_run) console.log("[hiveclaw] DRY RUN 模式");
  if (force) console.log("[hiveclaw] 强制触发模式（跳过触发条件检查）");

  const roles: MasterRole[] = roleArg
    ? [roleArg]
    : ["lucas", "andy", "lisa"];

  for (const role of roles) {
    await processRole(role, config, dryRun, force);
  }

  console.log("\n[hiveclaw] === 完成 ===");
}

main().catch((err) => {
  console.error("[hiveclaw] 致命错误：", err);
  process.exit(1);
});
