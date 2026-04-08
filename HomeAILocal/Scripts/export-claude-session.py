#!/usr/bin/env python3
"""
导出 Claude Code 会话原文到 Obsidian

用法：
  python3 export-claude-session.py --type A --topic "SOUL深化认知风格"
  python3 export-claude-session.py --session <session-id> --type B --topic "蒸馏通道设计"

参数：
  --session   会话 ID（省略则自动取最新会话）
  --type      子计划类型：A（开发）/ B（设计）/ 其他描述
  --topic     本次会话主题（用于文件名）
"""

import json
import os
import sys
import argparse
import time
import requests
from datetime import datetime, timezone

CLAUDE_PROJECTS_DIR = os.path.expanduser("~/.claude/projects/-Users-xinbinanshan")
OBSIDIAN_DIR = os.path.expanduser("~/Documents/Obsidian Vault/HomeAI/03-系统工程师工作日志")
CHROMA_URL  = os.environ.get("CHROMA_URL", "http://localhost:8001")
CHROMA_BASE = f"{CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections"
OLLAMA_URL  = os.environ.get("OLLAMA_URL", "http://localhost:11434")
DEEPSEEK_KEY = os.environ.get("DEEPSEEK_API_KEY", "")


def find_session_file(session_id=None):
    """找到目标会话的 jsonl 文件，省略则取最新"""
    files = [f for f in os.listdir(CLAUDE_PROJECTS_DIR) if f.endswith(".jsonl")]
    if not files:
        print("错误：找不到任何会话文件", file=sys.stderr)
        sys.exit(1)

    if session_id:
        target = f"{session_id}.jsonl"
        if target in files:
            return os.path.join(CLAUDE_PROJECTS_DIR, target)
        # 前缀匹配
        matches = [f for f in files if f.startswith(session_id)]
        if matches:
            return os.path.join(CLAUDE_PROJECTS_DIR, sorted(matches)[-1])
        print(f"错误：找不到会话 {session_id}", file=sys.stderr)
        sys.exit(1)

    # 取最新
    full_paths = [os.path.join(CLAUDE_PROJECTS_DIR, f) for f in files]
    return max(full_paths, key=os.path.getmtime)


def extract_conversations(jsonl_path):
    """从 jsonl 提取对话，返回 [(timestamp, role, text), ...]"""
    entries = []
    with open(jsonl_path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                entries.append(json.loads(line))
            except json.JSONDecodeError:
                continue

    turns = []
    for e in entries:
        t = e.get("type")
        ts = e.get("timestamp", "")

        if t == "user":
            content = e["message"].get("content", "")
            if isinstance(content, list):
                text = "\n".join(
                    c.get("text", "") for c in content
                    if isinstance(c, dict) and c.get("type") == "text"
                ).strip()
            else:
                text = str(content).strip()

            # 过滤纯系统消息
            if not text or text in ("Tool loaded.", " Tool loaded."):
                continue
            # 过滤 system-reminder 注入内容（通常很长且含特定标记）
            if text.startswith("<system-reminder>") or text.startswith("\n<system-reminder>"):
                continue

            turns.append((ts, "系统工程师感性脑", text))

        elif t == "assistant":
            content = e["message"].get("content", [])
            if isinstance(content, list):
                text = "\n".join(
                    c.get("text", "") for c in content
                    if isinstance(c, dict) and c.get("type") == "text"
                ).strip()
            else:
                text = str(content).strip()

            if not text:
                continue

            turns.append((ts, "系统工程师理性脑", text))

    return turns


def format_timestamp(iso_ts):
    """ISO 时间戳转北京时间 HH:MM"""
    if not iso_ts:
        return ""
    try:
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
        # 转北京时间 UTC+8
        from datetime import timedelta
        dt_bj = dt + timedelta(hours=8)
        return dt_bj.strftime("%H:%M")
    except Exception:
        return iso_ts[:16]


def get_session_date(turns):
    """从第一条消息推断会话日期"""
    for ts, _, _ in turns:
        if ts:
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                from datetime import timedelta
                dt_bj = dt + timedelta(hours=8)
                return dt_bj.strftime("%Y-%m-%d"), dt_bj.strftime("%Y-%m")
            except Exception:
                pass
    now = datetime.now()
    return now.strftime("%Y-%m-%d"), now.strftime("%Y-%m")


def build_markdown(turns, plan_type, topic, session_id):
    date_str, _ = get_session_date(turns)
    lines = []
    lines.append(f"# ClaudeCode-{plan_type} · {topic} · {date_str}")
    lines.append("")
    lines.append("## 元信息")
    lines.append(f"- 窗口：ClaudeCode-{plan_type}")
    lines.append(f"- 主题：{topic}")
    lines.append(f"- 日期：{date_str}")
    lines.append(f"- Session ID：{session_id}")
    lines.append("")
    lines.append("## 对话原文")
    lines.append("")

    prev_time = None
    for ts, role, text in turns:
        time_str = format_timestamp(ts)
        if time_str and time_str != prev_time:
            lines.append(f"### {time_str}")
            prev_time = time_str

        lines.append(f"**{role}**：")
        lines.append(text)
        lines.append("")

    return "\n".join(lines)


def distill_to_andy(turns, topic, date_str):
    """用 LLM 提取讨论结论，写入 Andy 的 decisions 集合（knowledge_injection）"""
    if not DEEPSEEK_KEY:
        print("⚠️  DEEPSEEK_API_KEY 未设置，跳过 Andy 蒸馏")
        return

    # 拼接对话摘要（取前 6000 字）
    convo = "\n".join(f"{role}：{text[:300]}" for _, role, text in turns)[:6000]

    prompt = f"""以下是系统工程师与 AI 助手关于 HomeAI 系统的设计讨论（主题：{topic}）：

{convo}

请从 Andy（HomeAI 系统架构设计师）的视角，提取这次讨论的核心价值：

输出格式（严格按此结构，每项不超过 150 字）：
核心洞察：[这次讨论中最重要的 1-2 个设计判断或认知突破]
对现有假设的挑战：[这次讨论挑战了 HomeAI 哪些已有的设计假设]
建议 Andy 行动：[Andy 看完后最值得推进的 1-2 个具体方向]

只输出以上三项，不要其他内容。如果这次讨论没有架构/设计价值（纯技术操作、无结论），只输出：无设计价值"""

    try:
        r = requests.post(
            "https://api.deepseek.com/chat/completions",
            headers={"Authorization": f"Bearer {DEEPSEEK_KEY}", "Content-Type": "application/json"},
            json={"model": "deepseek-chat", "messages": [{"role": "user", "content": prompt}],
                  "max_tokens": 400, "temperature": 0.3},
            timeout=30,
        )
        result = r.json()["choices"][0]["message"]["content"].strip()
    except Exception as e:
        print(f"⚠️  LLM 提取失败：{e}")
        return

    if "无设计价值" in result:
        print("ℹ️  本次会话无架构设计价值，跳过 Andy 蒸馏")
        return

    # 获取 embedding
    try:
        er = requests.post(f"{OLLAMA_URL}/api/embeddings",
                           json={"model": "nomic-embed-text", "prompt": result}, timeout=15)
        embedding = er.json()["embedding"]
    except Exception as e:
        print(f"⚠️  Embedding 失败：{e}")
        return

    # 写入 decisions 集合
    doc_id = f"knowledge_injection_{int(time.time())}_claudecode"
    document = f"【{topic}】来源：系统工程师 Claude Code 会话（{date_str}）\n\n{result}"
    try:
        cid_r = requests.get(f"{CHROMA_BASE}/decisions", timeout=10)
        cid = cid_r.json().get("id")
        if not cid:
            print("⚠️  找不到 decisions 集合，跳过写入")
            return
        payload = {
            "ids": [doc_id], "documents": [document], "embeddings": [embedding],
            "metadatas": [{"agent": "andy", "type": "knowledge_injection",
                           "topic": topic, "source": f"Claude Code 会话 {date_str}",
                           "timestamp": datetime.now(timezone.utc).isoformat()}],
        }
        wr = requests.post(f"{CHROMA_BASE}/{cid}/add", json=payload, timeout=15)
        if wr.status_code in (200, 201):
            print(f"✅ 已蒸馏进 Andy 的知识库：{topic}")
        else:
            print(f"⚠️  写入失败：{wr.status_code} {wr.text[:100]}")
    except Exception as e:
        print(f"⚠️  写入 decisions 失败：{e}")


def main():
    parser = argparse.ArgumentParser(description="导出 Claude Code 会话到 Obsidian")
    parser.add_argument("--session", default=None, help="会话 ID（省略则取最新）")
    parser.add_argument("--type", default="A", help="子计划类型：A / B / 其他")
    parser.add_argument("--topic", required=True, help="本次会话主题")
    parser.add_argument("--no-distill", action="store_true", help="跳过 Andy 蒸馏步骤")
    args = parser.parse_args()

    jsonl_path = find_session_file(args.session)
    session_id = os.path.basename(jsonl_path).replace(".jsonl", "")
    print(f"会话文件：{jsonl_path}")

    turns = extract_conversations(jsonl_path)
    print(f"提取对话：{len(turns)} 条")

    if not turns:
        print("错误：未提取到任何对话内容", file=sys.stderr)
        sys.exit(1)

    date_str, month_str = get_session_date(turns)
    md_content = build_markdown(turns, args.type, args.topic, session_id)

    # 写入 Obsidian
    out_dir = os.path.join(OBSIDIAN_DIR, month_str)
    os.makedirs(out_dir, exist_ok=True)

    safe_topic = args.topic.replace("/", "-").replace(" ", "-")
    filename = f"{date_str}-ClaudeCode-{args.type}-{safe_topic}.md"
    out_path = os.path.join(out_dir, filename)

    with open(out_path, "w", encoding="utf-8") as f:
        f.write(md_content)

    print(f"已写入：{out_path}")

    # 蒸馏进 Andy 的知识库
    if not args.no_distill:
        distill_to_andy(turns, args.topic, date_str)


if __name__ == "__main__":
    main()
