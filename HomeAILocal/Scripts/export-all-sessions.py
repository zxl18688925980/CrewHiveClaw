#!/usr/bin/env python3
"""
批量导出所有历史 Claude Code 会话到 Obsidian

用法：
  python3 export-all-sessions.py           # 导出全部（写 Obsidian 分散 md 文件）
  python3 export-all-sessions.py --dry-run # 只预览，不写文件
  python3 export-all-sessions.py --send    # 压缩为 zip，通过 Lucas 发送给业主
  python3 export-all-sessions.py --send --target ZengXiaoLong  # 指定发送目标
"""

import json
import os
import sys
import argparse
import zipfile
import tempfile
import urllib.request
from datetime import datetime, timedelta

CLAUDE_PROJECTS_DIR = os.path.expanduser("~/.claude/projects/-Users-xinbinanshan")
OBSIDIAN_DIR = os.path.expanduser("~/Documents/Obsidian Vault/HomeAI/03-系统工程师工作日志")
WECOM_SEND_FILE_URL = "http://localhost:3003/api/wecom/send-file"

# 已导出的 session（跳过）
SKIP_SESSIONS = {
    "f02cd916-fca3-44d8-a7a4-12b93c1b5831",  # 本次会话，已手动导出
}


def parse_entries(jsonl_path):
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
    return entries


def extract_turns(entries):
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

            if not text or text.strip() in ("Tool loaded.", " Tool loaded."):
                continue
            if text.lstrip().startswith("<system-reminder>"):
                continue

            turns.append((ts, "我", text))

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
            turns.append((ts, "启灵", text))

    return turns


OPENER_PATTERNS = [
    "恢复homeai", "恢复 homeai", "继续homeai", "恢复项目", "恢复系统",
    "本窗口", "帮我看看", "帮我确认", "帮我检查", "看看homeai",
]

def infer_topic(turns):
    """
    跳过「恢复HomeAI项目」类开场，从会话主体找最实质的用户消息作为主题。
    策略：
      1. 跳过前几条开场语（匹配 OPENER_PATTERNS 或长度 < 15）
      2. 取第一条实质消息（长度 > 15 且不是开场语）的前 30 字
      3. 若全是开场语，取最长的那条用户消息
    """
    candidates = []
    for ts, role, text in turns:
        if role != "我":
            continue
        cleaned = text.replace("\n", " ").strip()
        is_opener = any(p in cleaned.lower() for p in OPENER_PATTERNS)
        if not is_opener and len(cleaned) > 15:
            return cleaned[:30]
        candidates.append(cleaned)

    # 没找到实质消息，取最长的
    if candidates:
        best = max(candidates, key=len)
        return best[:30]
    return "未知主题"


def format_ts(iso_ts):
    if not iso_ts:
        return ""
    try:
        dt = datetime.fromisoformat(iso_ts.replace("Z", "+00:00"))
        dt_bj = dt + timedelta(hours=8)
        return dt_bj.strftime("%H:%M")
    except Exception:
        return iso_ts[:16]


def get_date(turns):
    for ts, _, _ in turns:
        if ts:
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
                dt_bj = dt + timedelta(hours=8)
                return dt_bj.strftime("%Y-%m-%d"), dt_bj.strftime("%Y-%m")
            except Exception:
                pass
    now = datetime.now()
    return now.strftime("%Y-%m-%d"), now.strftime("%Y-%m")


def build_markdown(turns, topic, session_id):
    date_str, _ = get_date(turns)
    lines = [
        f"# ClaudeCode · {topic} · {date_str}",
        "",
        "## 元信息",
        f"- 日期：{date_str}",
        f"- Session ID：{session_id}",
        f"- 主题：{topic}",
        "",
        "## 对话原文",
        "",
    ]

    prev_time = None
    for ts, role, text in turns:
        time_str = format_ts(ts)
        if time_str and time_str != prev_time:
            lines.append(f"### {time_str}")
            prev_time = time_str
        lines.append(f"**{role}**：")
        lines.append(text)
        lines.append("")

    return "\n".join(lines)


def safe_filename(s):
    return s.replace("/", "-").replace("\\", "-").replace(":", "-").replace(" ", "-")


def send_zip_via_lucas(zip_path, target, count):
    payload = json.dumps({
        "target": target,
        "filePath": zip_path,
        "text": f"ClaudeCode 会话导出 {datetime.now().strftime('%Y-%m-%d')}，共 {count} 个会话",
    }).encode("utf-8")
    req = urllib.request.Request(
        WECOM_SEND_FILE_URL,
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.read().decode("utf-8")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true", help="只预览，不写文件")
    parser.add_argument("--send", action="store_true", help="压缩为 zip 并通过 Lucas 发送给业主（不写 Obsidian）")
    parser.add_argument(
        "--target",
        default=os.environ.get("WECOM_OWNER_ID", "ZengXiaoLong"),
        help="--send 时的接收方 userId（默认读 WECOM_OWNER_ID 环境变量，fallback: ZengXiaoLong）",
    )
    args = parser.parse_args()

    files = sorted(
        [f for f in os.listdir(CLAUDE_PROJECTS_DIR) if f.endswith(".jsonl")],
        key=lambda f: os.path.getmtime(os.path.join(CLAUDE_PROJECTS_DIR, f))
    )

    exported = 0
    skipped = 0
    exported_files = []  # 仅 --send 模式使用

    # --send 模式用临时目录，否则用 Obsidian
    if args.send:
        send_tmp_dir = tempfile.mkdtemp(prefix="homeai-export-")

    for fname in files:
        session_id = fname.replace(".jsonl", "")

        if session_id in SKIP_SESSIONS:
            print(f"[跳过] {session_id}（已导出）")
            skipped += 1
            continue

        fpath = os.path.join(CLAUDE_PROJECTS_DIR, fname)
        try:
            entries = parse_entries(fpath)
        except Exception as e:
            print(f"[错误] 读取 {fname}：{e}")
            continue

        turns = extract_turns(entries)

        # 过滤：对话轮数太少的跳过（纯工具操作或空会话）
        real_turns = [(ts, r, t) for ts, r, t in turns if r == "我"]
        if len(real_turns) < 2:
            print(f"[跳过] {session_id}（仅 {len(real_turns)} 条用户消息，内容过少）")
            skipped += 1
            continue

        topic = infer_topic(turns)
        date_str, month_str = get_date(turns)
        safe_topic = safe_filename(topic)
        filename = f"{date_str}-ClaudeCode-{safe_topic}.md"

        if args.send:
            out_dir = send_tmp_dir
            out_path = os.path.join(out_dir, filename)
            # 文件名冲突时加序号
            if os.path.exists(out_path):
                idx = 2
                while True:
                    filename = f"{date_str}-ClaudeCode-{safe_topic}-{idx:02d}.md"
                    out_path = os.path.join(out_dir, filename)
                    if not os.path.exists(out_path):
                        break
                    idx += 1
        else:
            out_dir = os.path.join(OBSIDIAN_DIR, month_str)
            out_path = os.path.join(out_dir, filename)
            # 文件名冲突时加序号
            if os.path.exists(out_path):
                idx = 2
                while True:
                    filename = f"{date_str}-ClaudeCode-{safe_topic}-{idx:02d}.md"
                    out_path = os.path.join(out_dir, filename)
                    if not os.path.exists(out_path):
                        break
                    idx += 1

        print(f"[导出] {date_str} | {topic[:40]} | {len(turns)} 条 → {filename}")

        if not args.dry_run:
            md = build_markdown(turns, topic, session_id)
            os.makedirs(out_dir, exist_ok=True)
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(md)
            if args.send:
                exported_files.append(out_path)
        exported += 1

    print(f"\n完成：导出 {exported} 个，跳过 {skipped} 个")

    if args.dry_run:
        print("（dry-run 模式，未实际写入文件）")
        return

    if args.send and exported_files:
        today = datetime.now().strftime("%Y%m%d")
        zip_path = f"/tmp/homeai-sessions-{today}.zip"
        with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
            for fp in exported_files:
                zf.write(fp, os.path.basename(fp))
        print(f"[打包] {len(exported_files)} 个文件 → {zip_path}")
        try:
            result = send_zip_via_lucas(zip_path, args.target, len(exported_files))
            print(f"[发送] 已发送给 {args.target}：{result}")
        except Exception as e:
            print(f"[错误] 发送失败：{e}")
            print(f"zip 文件保留在：{zip_path}")


if __name__ == "__main__":
    main()
