#!/usr/bin/env python3
"""
seed-constraints.py — 把已验证的平台/环境约束写入 ChromaDB decisions 集合

用法：
  python3 scripts/seed-constraints.py           # 写入全部约束
  python3 scripts/seed-constraints.py --dry-run # 只打印，不写入

约束来源：
  - CLAUDE.md「已知外部平台约束」
  - MEMORY.md「已验证的关键判断」
  - 历史踩坑记录（09-evolution-version.md）

维护规则：
  - 发现新的平台约束时，在 CONSTRAINTS 列表末尾追加新条目，重新运行脚本
  - 已有 id 的条目重新运行会覆盖（upsert），幂等安全
"""

import os, sys, argparse, requests, datetime
from pathlib import Path

CHROMA_URL  = os.environ.get("CHROMA_URL", "http://localhost:8001")
CHROMA_BASE = f"{CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections"

# ── 嵌入 ──────────────────────────────────────────────────────────────────────

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://localhost:11434")

def embed_text(text: str) -> list[float]:
    r = requests.post(
        f"{OLLAMA_URL}/api/embeddings",
        json={"model": "nomic-embed-text", "prompt": text},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["embedding"]

# ── ChromaDB ──────────────────────────────────────────────────────────────────

def get_collection_id(name: str) -> str | None:
    r = requests.get(f"{CHROMA_BASE}/{name}", timeout=10)
    return r.json().get("id") if r.status_code == 200 else None

def upsert(collection_id: str, doc_id: str, document: str, metadata: dict, embedding: list[float]):
    payload = {
        "ids":        [doc_id],
        "documents":  [document],
        "metadatas":  [metadata],
        "embeddings": [embedding],
    }
    r = requests.post(f"{CHROMA_BASE}/{collection_id}/upsert", json=payload, timeout=30)
    r.raise_for_status()

# ── 约束条目 ──────────────────────────────────────────────────────────────────
#
# 字段说明：
#   id       — 唯一标识，重新运行脚本会 upsert 覆盖，不会重复
#   agent    — 主要与哪个角色相关（andy / lisa / both）
#   platform — 约束来源平台/组件
#   title    — 一句话摘要（用于向量检索命中后快速识别）
#   detail   — 完整约束描述，含触发场景和正确做法
#

CONSTRAINTS = [

    # ── 企业微信 aibot ────────────────────────────────────────────────────────

    {
        "id":       "constraint-wecom-aibot-group-at-only",
        "agent":    "andy",
        "platform": "企业微信 aibot",
        "title":    "群消息只能收到 @机器人 的消息，不带@的群消息收不到",
        "detail":   (
            "平台硬限制：企业微信 aibot（@wecom/aibot-node-sdk WSClient）在群里只能收到明确 @机器人 的消息，"
            "无论任何设置，群里不带@的消息永远不会推送到机器人。"
            "设计时不要假设能监听群内所有消息。"
        ),
    },
    {
        "id":       "constraint-wecom-aibot-send-message-not-mcp",
        "agent":    "andy",
        "platform": "企业微信 aibot",
        "title":    "sendMessage 是基础 WebSocket 协议能力，不是 MCP，不触发仅创建者可对话限制",
        "detail":   (
            "曾多次误以为需要开通腾讯「个人/小团队接口能力」MCP 才能主动发群消息。"
            "实际验证：授权该 MCP 后，机器人触发「仅创建者可对话」限制，家庭成员无法使用。"
            "正确做法：sendMessage(chatid, body) 是基础 WebSocket aibot_send_msg 命令，不走 MCP，"
            "家人可正常使用。不要再尝试腾讯 MCP「个人/小团队接口能力」路线。"
        ),
    },
    {
        "id":       "constraint-wecom-app-no-group-callback",
        "agent":    "andy",
        "platform": "企业微信企业自建应用",
        "title":    "企业应用 HTTP callback 只推送用户主动发的单聊，不推送群消息",
        "detail":   (
            "企业自建应用 callback 不支持群消息接收，只推送用户主动给该应用发的单聊消息。"
            "接收群消息需要企业版 + MSGAUDIT（会话内容存档 SDK），当前阶段不支持。"
            "该能力计划在小姨公司版本时实现。"
        ),
    },

    # ── 企业微信内置浏览器 ─────────────────────────────────────────────────────

    {
        "id":       "constraint-wecom-browser-no-indexeddb",
        "agent":    "lisa",
        "platform": "企业微信内置浏览器",
        "title":    "企业微信内置浏览器不支持 IndexedDB 和 ServiceWorker",
        "detail":   (
            "家人通过 Lucas 发的链接在企业微信内置浏览器打开 Web 工具，该浏览器兼容性差："
            "不支持 IndexedDB，不支持 ServiceWorker。"
            "前端实现禁止依赖这两个 API，本地存储用 localStorage / sessionStorage 替代，"
            "离线缓存等 PWA 特性不可用。"
        ),
    },
    {
        "id":       "constraint-wecom-browser-mobile-first",
        "agent":    "lisa",
        "platform": "企业微信内置浏览器",
        "title":    "家人通过手机企业微信内置浏览器访问，必须 mobile-first 实现",
        "detail":   (
            "家人设备是手机，通过企业微信内置浏览器打开工具链接，不是桌面浏览器。"
            "强制要求：① <meta name='viewport' content='width=device-width, initial-scale=1'> 必须加 "
            "② 可点击元素最小 44px 高度防误触 ③ 竖屏单栏布局，避免横向滚动 "
            "④ 工具必须在一次打开内完成核心任务，家人不会回来做第二步。"
        ),
    },

    # ── MiniMax ───────────────────────────────────────────────────────────────

    {
        "id":       "constraint-minimax-tool-count-limit",
        "agent":    "andy",
        "platform": "MiniMax API",
        "title":    "MiniMax 工具数量过多（如 13 个）触发 400 错误",
        "detail":   (
            "曾让 runAndyPipeline 把调研+规划所有工具都传给 Andy，共 13 个，触发 MiniMax 400 错误。"
            "MiniMax 对单次请求的工具数量有限制，工具过多会直接拒绝请求。"
            "正确做法：插件层只传 Andy 真正需要的核心工具，不要把所有工具全量注入。"
            "历史教训：插件要薄，不替 Agent 做决策，不全量传工具。"
        ),
    },

    # ── DeepSeek ──────────────────────────────────────────────────────────────

    {
        "id":       "constraint-deepseek-v3-tool-calling-unstable",
        "agent":    "andy",
        "platform": "DeepSeek V3",
        "title":    "DeepSeek V3 function calling 不稳定，Lucas 工具调用经常失败",
        "detail":   (
            "DeepSeek V3 的 function calling 能力不稳定，Lucas 多次出现「说了要调用工具但实际未调用」的情况。"
            "已切换 Lucas 到 R1（deepseek-reasoner），工具调用稳定性有所改善。"
            "根治方向：积累 DPO 负例 → 增量微调。"
            "设计工具调用流程时，不要假设模型一定会按格式调用，需要有 fallback 和验证机制。"
        ),
    },
    {
        "id":       "constraint-deepseek-r1-tool-calling-verified",
        "agent":    "andy",
        "platform": "DeepSeek R1",
        "title":    "DeepSeek R1（deepseek-reasoner）工具调用已验证可用，是 Lucas 当前模型",
        "detail":   (
            "Lucas 当前使用 DeepSeek R1（deepseek-reasoner），工具调用已通过 send_wecom_message 验证。"
            "R1 相比 V3 工具调用更稳定，是当前 Lucas 的正确模型配置。"
            "宪法约束：无业主明确指令，不得更换三角色云端模型（Lucas→DeepSeek、Andy→MiniMax、Lisa→GLM-5）。"
        ),
    },

    # ── ChromaDB ──────────────────────────────────────────────────────────────

    {
        "id":       "constraint-chromadb-metadata-no-empty-object",
        "agent":    "lisa",
        "platform": "ChromaDB",
        "title":    "ChromaDB metadata 字段不能是空对象 {}，会触发 400 错误",
        "detail":   (
            "ChromaDB upsert 时，metadata 中若有字段值为空对象 {} 会触发 400 错误。"
            "正确做法：metadata 字段值只能是 string / int / float / bool，不能是对象或数组。"
            "写入前必须过滤或序列化嵌套对象。"
        ),
    },
    {
        "id":       "constraint-chromadb-decisions-field-agent",
        "agent":    "both",
        "platform": "ChromaDB decisions 集合",
        "title":    "decisions 集合用 agent 字段标识角色，不是 agentId",
        "detail":   (
            "decisions 集合的 metadata 用 agent 字段（值如 'andy'/'lisa'/'lucas'）标识角色，"
            "不是 agentId。addDecisionMemory 写入和 queryDecisionMemory 过滤都用 agent 字段。"
            "agent_interactions 集合才用 agentId 字段。两个字段名不能混用。"
        ),
    },

    # ── nomic-embed-text ──────────────────────────────────────────────────────

    {
        "id":       "constraint-nomic-embed-context-length",
        "agent":    "lisa",
        "platform": "nomic-embed-text (Ollama)",
        "title":    "nomic-embed-text context length 上限约 500 token，超长文本需截断",
        "detail":   (
            "nomic-embed-text 嵌入模型 context length 约 500 token，超长文本会报 context length 错误。"
            "embedDoc 调用前需截断：prompt.slice(0, 400) + response.slice(0, 400)，"
            "确保拼接后总长度不超限。"
        ),
    },

    # ── OpenClaw Gateway ─────────────────────────────────────────────────────

    {
        "id":       "constraint-openclaw-health-not-reliable",
        "agent":    "andy",
        "platform": "OpenClaw Gateway",
        "title":    "/health 200 不等于 Gateway 健康，MiniMax 并发超时会导致 session pool 腐化",
        "detail":   (
            "Gateway 的 /health 端点只检查进程存活，不检查 LLM 请求能力。"
            "MiniMax 并发超时会导致 session pool 腐化，表现是 /health 200 但真实请求永久挂死。"
            "健康探测必须用真实 LLM 请求（gateway-watchdog 已实现：每 5 分钟发真实请求探测）。"
            "同一 session key 的超时会阻塞后续所有消息，已改为 per-message 独立 session。"
        ),
    },
    {
        "id":       "constraint-openclaw-before-prompt-build-no-system-prompt",
        "agent":    "both",
        "platform": "OpenClaw Plugin Hook",
        "title":    "before_prompt_build 的 event.messages 是对话历史，不含 system prompt",
        "detail":   (
            "OpenClaw before_prompt_build hook 的 event.messages 是对话历史数组，"
            "不包含 system prompt。无法从插件层读取或过滤 <available_skills> 块。"
            "想追加内容用 appendSystemContext；OpenClaw 原生 skills 注入在 before_prompt_build 之前已完成。"
            "曾写死代码试图从 event.messages[0] 读 system prompt 做 skills 过滤——根本读不到，是死代码，已清除。"
        ),
    },
    {
        "id":       "constraint-openclaw-wecom-prompt-prefix-pollution",
        "agent":    "lisa",
        "platform": "OpenClaw / wecom-entrance",
        "title":    "wecom 入口往 event.prompt 注入历史前缀，agent_end 直接存会污染 ChromaDB",
        "detail":   (
            "wecom 入口往 event.prompt 注入了「【近期对话（最近 N 轮）】...---」历史前缀，"
            "agent_end 直接存 event.prompt 会把前缀也存进 ChromaDB，污染语义检索结果。"
            "写入记忆前必须用正则剥离注入内容："
            r"cleanPrompt = actualPrompt.replace(/^【近期对话（最近 \d+ 轮）】[\s\S]*?---\n\n/, '')"
        ),
    },
]

# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="seed 已知平台约束到 ChromaDB decisions 集合")
    parser.add_argument("--dry-run", action="store_true", help="只打印，不写入")
    args = parser.parse_args()

    print(f"共 {len(CONSTRAINTS)} 条约束待写入")

    if args.dry_run:
        for c in CONSTRAINTS:
            print(f"  [{c['agent']:4s}] [{c['platform']}] {c['title']}")
        return

    cid = get_collection_id("decisions")
    if not cid:
        print("ERROR: decisions 集合不存在，请先确认 ChromaDB 运行正常", file=sys.stderr)
        sys.exit(1)

    # 生成写入时间戳（ISO 8601，北京时间，与 TypeScript nowCST() 格式一致）
    seeded_at = (datetime.datetime.utcnow() + datetime.timedelta(hours=8)).strftime("%Y-%m-%dT%H:%M:%S.000+08:00")

    ok = 0
    for c in CONSTRAINTS:
        document = f"【约束】{c['title']}\n\n{c['detail']}"
        metadata = {
            "agent":     c["agent"],
            "platform":  c["platform"],
            "type":      "constraint",
            "title":     c["title"],
            "timestamp": c.get("confirmed_at", seeded_at),  # 优先用条目自带的确认日期
        }
        try:
            embedding = embed_text(document)
            upsert(cid, c["id"], document, metadata, embedding)
            print(f"  ✓ {c['id']}")
            ok += 1
        except Exception as e:
            print(f"  ✗ {c['id']}：{e}", file=sys.stderr)

    print(f"\n完成：{ok}/{len(CONSTRAINTS)} 条写入成功")


if __name__ == "__main__":
    main()
