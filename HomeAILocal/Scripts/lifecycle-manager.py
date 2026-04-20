#!/usr/bin/env python3
"""
能力生命周期管理工具 (Capability Lifecycle Manager)
按照 载体对象(Skill/Tool/App) × Lx层次(L1-L4) 组合管理系统能力

生命周期六阶段：产生 → 度量 → 评估 → 优化 → 封存 → 裁汰

用法:
  python3 lifecycle-manager.py --audit          # 审计所有能力，显示健康状态
  python3 lifecycle-manager.py --migrate        # 给现有 Skill 补充生命周期元数据
  python3 lifecycle-manager.py --gc             # 标记退休候选，列出裁汰建议
  python3 lifecycle-manager.py --report         # 生成 HEARTBEAT 可读的治理报告
  python3 lifecycle-manager.py --archive-andy   # 归档 Andy 目录中的 auto-*/spec-* 噪声文件
"""

import argparse
import json
import re
import shutil
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path

# ── 路径配置 ──────────────────────────────────────────────────────────────────
LUCAS_SKILLS_DIR = Path("~/.openclaw/workspace-lucas/skills/").expanduser()
ANDY_SKILLS_DIR  = Path("~/.openclaw/workspace-andy/skills/").expanduser()
ANDY_ARCHIVE_DIR = Path("~/.openclaw/workspace-andy/skills-archive/").expanduser()
REPORT_PATH      = Path("~/.openclaw/workspace-andy/lifecycle-report.md").expanduser()
CHROMA_HOST      = "localhost"
CHROMA_PORT      = 8001

# ── Object × Lx 分类表 ────────────────────────────────────────────────────────
# 每个 Skill 在哪个 Lx 层产生能力
SKILL_LX_MAP: dict[str, str] = {
    # Lucas — L1 (Agent 行为质量：Lucas 怎么行动)
    "bug-diagnosis-workflow":        "L1",
    "bug-fix-workflow":              "L1",
    "family-info-relay":             "L1",
    "lucas-audience-pattern":        "L1",
    "lucas-capability-gap":          "L1",
    "lucas-memory-worth":            "L1",
    "tool-calling-sop":              "L1",
    "web-apps":                      "L1",
    "web-search-strategy":           "L1",
    # Lucas — L2 (工程交付：驱动 Andy→Lisa 协作链)
    "akshare-stock":                 "L2",
    "demand-exploration-pipeline":   "L2",
    "duplicate-requirement-detection": "L2",
    "how-to-require-dev":            "L2",
    "market-analysis-cn":            "L2",
    "project-management":            "L2",
    "task-delivery-notifier":        "L2",
    "task-outcome-notification":     "L2",
    # Lucas — L3 (组织协作进化：跨成员理解)
    "family-understanding":          "L3",
    # Andy — L1 (Andy 设计行为质量)
    "andy-complexity-calibration":   "L1",
    "andy-family-tech-stack":        "L1",
    "best-practice-evaluation":      "L1",
}

# 按 Lx 层级的陈旧阈值（天）
STALE_DAYS: dict[str, int] = {
    "L1": 14,
    "L2": 30,
    "L3": 45,
    "L4": 90,
}

# proven 阈值（成功调用次数）
PROVEN_THRESHOLD = 3

# ── Lifecycle stage 定义 ───────────────────────────────────────────────────────
# draft   : 刚创建，尚无验证
# active  : 正在使用
# proven  : 已验证稳定（success_count >= PROVEN_THRESHOLD）
# retiring: 陈旧或失败率高，候选裁汰
# archived: 已封存，保留备查

TODAY = datetime.now(tz=timezone.utc).date()

# ── YAML frontmatter 解析/写入 ─────────────────────────────────────────────────

def parse_frontmatter(text: str) -> tuple[dict, str]:
    """返回 (meta_dict, body_without_frontmatter)"""
    if not text.startswith("---"):
        return {}, text
    end = text.find("\n---", 3)
    if end == -1:
        return {}, text
    yaml_block = text[3:end].strip()
    body = text[end + 4:].lstrip("\n")
    meta: dict = {}
    for line in yaml_block.splitlines():
        if ":" in line:
            k, _, v = line.partition(":")
            v = v.strip().strip('"').strip("'")
            meta[k.strip()] = v
    return meta, body


def build_frontmatter(meta: dict, body: str) -> str:
    """把 meta dict 重新写成 YAML frontmatter + body"""
    lines = ["---"]
    for k, v in meta.items():
        if isinstance(v, bool):
            lines.append(f"{k}: {'true' if v else 'false'}")
        elif v is None or v == "null":
            lines.append(f"{k}: null")
        else:
            lines.append(f"{k}: {v}")
    lines.append("---")
    if body:
        lines.append("")
        lines.append(body)
    return "\n".join(lines) + "\n"


def read_skill(skill_dir: Path) -> dict | None:
    """读取 Skill 目录，返回元信息 + 路径"""
    md = skill_dir / "SKILL.md"
    if not md.exists():
        return None
    text = md.read_text(encoding="utf-8")
    meta, body = parse_frontmatter(text)
    meta["_path"] = md
    meta["_body"] = body
    meta["_dir"]  = skill_dir
    meta["_slug"] = skill_dir.name
    return meta


def write_skill(skill: dict) -> None:
    """把修改后的元信息写回 SKILL.md"""
    clean = {k: v for k, v in skill.items() if not k.startswith("_")}
    body = skill.get("_body", "")
    skill["_path"].write_text(build_frontmatter(clean, body), encoding="utf-8")


# ── ChromaDB 工具使用度量 ─────────────────────────────────────────────────────

def fetch_tool_usage() -> dict[str, dict]:
    """
    从 ChromaDB capabilities 集合汇总工具使用情况。
    返回 { toolName: { total_calls, success_calls, fail_calls, last_used, agents } }
    """
    try:
        import chromadb
        client = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
        col = client.get_collection("capabilities")
        total = col.count()
        if total == 0:
            return {}
        # 分批拉取（ChromaDB 单次最多 10000）
        batch = 5000
        all_metas = []
        offset = 0
        while offset < total:
            r = col.get(limit=batch, offset=offset, include=["metadatas"])
            all_metas.extend(r["metadatas"])
            offset += batch
    except Exception as e:
        print(f"[警告] ChromaDB 读取失败: {e}")
        return {}

    usage: dict[str, dict] = {}
    for m in all_metas:
        name = m.get("toolName", "")
        if not name:
            continue
        entry = usage.setdefault(name, {
            "total_calls": 0, "success_calls": 0, "fail_calls": 0,
            "last_used": None, "agents": set()
        })
        calls = int(m.get("callCount", 1))
        success = str(m.get("success", "true")).lower() == "true"
        entry["total_calls"]   += calls
        entry["success_calls"] += calls if success else 0
        entry["fail_calls"]    += 0 if success else calls
        entry["agents"].add(m.get("agentId", "unknown"))
        ts = m.get("timestamp", "")
        if ts:
            try:
                dt = datetime.fromisoformat(ts.replace("Z", "+00:00")).date()
                if entry["last_used"] is None or dt > entry["last_used"]:
                    entry["last_used"] = dt
            except ValueError:
                pass

    # set → list for serialisation
    for e in usage.values():
        e["agents"] = sorted(e["agents"])
    return usage


# ── Skill 生命周期评估 ────────────────────────────────────────────────────────

def assess_stage(skill: dict) -> str:
    """根据当前元数据推断应处的生命周期阶段"""
    existing = skill.get("lifecycle_stage", "draft")
    if existing in ("archived", "proven"):
        return existing  # 已封存或已验证，保持不变

    success_count = int(skill.get("success_count", 0))
    fail_count    = int(skill.get("fail_count", 0))
    lx            = skill.get("lx_level", "L2")
    threshold     = STALE_DAYS.get(lx, 30)

    last_used_raw = skill.get("last_used", None)
    if last_used_raw and last_used_raw != "null":
        try:
            last_used = datetime.strptime(str(last_used_raw), "%Y-%m-%d").date()
            days_since = (TODAY - last_used).days
        except ValueError:
            days_since = 9999
    else:
        days_since = 9999  # 从未使用

    total = success_count + fail_count
    if total == 0:
        return "draft"

    if success_count >= PROVEN_THRESHOLD:
        fail_rate = fail_count / total if total > 0 else 0
        if fail_rate < 0.3:
            return "proven"

    if days_since > threshold:
        return "retiring"

    return "active"


# ── 命令：--migrate ───────────────────────────────────────────────────────────

def cmd_migrate() -> None:
    """给所有现有 Skill 补充生命周期元数据（不覆盖已有值）"""
    skills = _load_all_real_skills()
    print(f"迁移 {len(skills)} 个 Skill ...")
    changed = 0
    for skill in skills:
        dirty = False
        slug = skill["_slug"]
        defaults = {
            "lx_level":        SKILL_LX_MAP.get(slug, "L2"),
            "object_type":     "Skill",
            "lifecycle_stage": "draft",
            "usage_count":     "0",
            "success_count":   "0",
            "fail_count":      "0",
            "last_used":       "null",
            "created_at":      str(TODAY),
            "last_reviewed":   "null",
        }
        for k, v in defaults.items():
            if k not in skill or skill[k] in ("", None):
                skill[k] = v
                dirty = True
        # 自动推断 lifecycle_stage
        stage = assess_stage(skill)
        if skill.get("lifecycle_stage") != stage and skill.get("lifecycle_stage") == "draft":
            skill["lifecycle_stage"] = stage
            dirty = True
        if dirty:
            write_skill(skill)
            changed += 1
            print(f"  ✅ {slug} → lx={skill['lx_level']} stage={skill['lifecycle_stage']}")

    print(f"\n迁移完成：{changed}/{len(skills)} 个文件已更新")


# ── 命令：--archive-andy ──────────────────────────────────────────────────────

def cmd_archive_andy() -> None:
    """把 Andy skills 目录中的 auto-*/spec-* 归档，保留真实 Skill"""
    ANDY_ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    archived = 0
    for d in sorted(ANDY_SKILLS_DIR.iterdir()):
        if not d.is_dir():
            continue
        if d.name.startswith("auto-") or d.name.startswith("spec-"):
            dest = ANDY_ARCHIVE_DIR / d.name
            shutil.move(str(d), str(dest))
            print(f"  📦 归档: {d.name}")
            archived += 1
    print(f"\n归档完成：{archived} 个噪声文件 → {ANDY_ARCHIVE_DIR}")


# ── 命令：--audit ─────────────────────────────────────────────────────────────

def cmd_audit() -> None:
    """审计所有 Skill 能力的健康状态"""
    skills = _load_all_real_skills()
    tool_usage = fetch_tool_usage()

    print("=" * 70)
    print("📋 SKILL 能力审计")
    print("=" * 70)

    by_lx: dict[str, list] = defaultdict(list)
    for s in skills:
        by_lx[s.get("lx_level", "??")].append(s)

    for lx in ["L1", "L2", "L3", "L4", "??"]:
        group = by_lx.get(lx, [])
        if not group:
            continue
        print(f"\n── {lx} ({len(group)} 个) ──")
        for s in group:
            stage = s.get("lifecycle_stage", "draft")
            slug  = s["_slug"]
            sc    = s.get("success_count", "0")
            fc    = s.get("fail_count", "0")
            lu    = s.get("last_used", "null")
            icon  = {"draft": "🌱", "active": "✅", "proven": "⭐",
                     "retiring": "⚠️", "archived": "📦"}.get(stage, "❓")
            print(f"  {icon} {slug:<45} stage={stage:<10} ok={sc} fail={fc} last={lu}")

    print("\n" + "=" * 70)
    print("🔧 TOOL 使用统计（ChromaDB capabilities）")
    print("=" * 70)

    # 按 agent 分组
    by_agent: dict[str, list] = defaultdict(list)
    for name, info in tool_usage.items():
        for agent in info["agents"]:
            by_agent[agent].append((name, info))

    for agent in sorted(by_agent):
        tools = sorted(by_agent[agent], key=lambda x: -x[1]["total_calls"])
        print(f"\n── {agent} ({len(tools)} 个 Tools) ──")
        for name, info in tools[:15]:  # top 15
            total   = info["total_calls"]
            success = info["success_calls"]
            last    = info["last_used"] or "never"
            rate    = f"{success/total*100:.0f}%" if total > 0 else "—"
            stale_flag = ""
            if info["last_used"]:
                days = (TODAY - info["last_used"]).days
                if days > 30:
                    stale_flag = f" ⚠️ 陈旧{days}天"
            print(f"  {name:<45} calls={total:<6} ok={rate:<6} last={last}{stale_flag}")

    print()


# ── 命令：--gc ────────────────────────────────────────────────────────────────

def _clawhub_search(query: str, timeout: int = 5) -> list[dict]:
    """调用 clawhub search，返回 [{slug, name, score}]，超时或失败返回空列表"""
    import subprocess
    try:
        result = subprocess.run(
            ["clawhub", "search", query[:60]],
            capture_output=True, text=True, timeout=timeout
        )
        if result.returncode != 0:
            return []
        entries = []
        for line in result.stdout.strip().split("\n"):
            m = re.match(r"^(\S+)\s+(.+?)\s+\(([0-9.]+)\)", line.strip())
            if m:
                entries.append({"slug": m.group(1), "name": m.group(2), "score": float(m.group(3))})
        return entries[:5]
    except Exception:
        return []


def cmd_gc() -> None:
    """找出所有退休候选（retiring），列出裁汰建议，并对比 Clawhub 生态替代方案"""
    skills = _load_all_real_skills()
    tool_usage = fetch_tool_usage()

    retiring_skills = [s for s in skills if assess_stage(s) == "retiring"]
    draft_skills    = [s for s in skills if s.get("lifecycle_stage") == "draft"
                       and s.get("usage_count", "0") == "0"]

    print("=" * 60)
    print("⚠️  SKILL 裁汰候选")
    print("=" * 60)
    if not retiring_skills and not draft_skills:
        print("  ✅ 无裁汰候选")
    for s in retiring_skills:
        print(f"  retiring: {s['_slug']}  last={s.get('last_used','null')}")
    for s in draft_skills:
        print(f"  never-used: {s['_slug']} (创建于 {s.get('created_at','?')})")

    print("\n" + "=" * 60)
    print("⚠️  TOOL 陈旧候选（30天无调用）")
    print("=" * 60)
    stale_tools = {n: info for n, info in tool_usage.items()
                   if info["last_used"] and (TODAY - info["last_used"]).days > 30}
    if not stale_tools:
        print("  ✅ 无陈旧 Tool")
    for name, info in sorted(stale_tools.items(), key=lambda x: x[1]["last_used"]):
        days = (TODAY - info["last_used"]).days
        print(f"  {name:<45} 最后使用: {info['last_used']} ({days}天前)")

    # ── Clawhub 生态对比（最多查 3 个 retiring/never-used 条目）─────────────────
    candidates = (retiring_skills + [s for s in draft_skills])[:3]
    if candidates:
        print("\n" + "=" * 60)
        print("🔍  Clawhub 生态对比（供参考，需人工判断，非强制替换）")
        print("=" * 60)
        for s in candidates:
            slug = s["_slug"]
            desc = s.get("description", slug)[:50]
            results = _clawhub_search(f"{slug} {desc}")
            high = [r for r in results if r["score"] >= 2.5]
            if high:
                print(f"  {slug}:")
                for r in high:
                    print(f"    → {r['slug']} ({r['name']}, 评分 {r['score']:.1f})")
                    print(f"       clawhub install {r['slug']} --dir ~/.openclaw/workspace-{slug.split('-')[0]}/skills")
            else:
                print(f"  {slug}: 无高相关 Clawhub 替代")
    print()


# ── 命令：--report ────────────────────────────────────────────────────────────

def cmd_report() -> None:
    """生成 HEARTBEAT 可读的治理报告，写入 Andy workspace"""
    skills    = _load_all_real_skills()
    tool_usage = fetch_tool_usage()
    lines     = [f"# 能力生命周期治理报告", f"", f"生成时间：{TODAY}", f""]

    # Skill 统计
    stage_count: dict[str, int] = defaultdict(int)
    for s in skills:
        stage_count[s.get("lifecycle_stage", "draft")] += 1

    lines += [
        "## Skill 概览",
        f"- 总数：{len(skills)}",
        f"- proven（稳定）：{stage_count['proven']}",
        f"- active（活跃）：{stage_count['active']}",
        f"- draft（未验证）：{stage_count['draft']}",
        f"- retiring（裁汰候选）：{stage_count['retiring']}",
        "",
    ]

    retiring = [s for s in skills if assess_stage(s) == "retiring"]
    if retiring:
        lines += ["### 裁汰候选 Skill"]
        for s in retiring:
            lines.append(f"- `{s['_slug']}` ({s.get('lx_level','?')}) last={s.get('last_used','null')}")
        lines.append("")

    # Tool 统计
    stale_tools = {n: i for n, i in tool_usage.items()
                   if i["last_used"] and (TODAY - i["last_used"]).days > 30}
    never_used  = {n: i for n, i in tool_usage.items() if i["last_used"] is None}

    lines += [
        "## Tool 概览",
        f"- 有调用记录的 Tool 数：{len(tool_usage)}",
        f"- 陈旧（30天无调用）：{len(stale_tools)}",
        f"- 从未调用：{len(never_used)}",
        "",
    ]
    if stale_tools:
        lines += ["### 陈旧 Tool（30天无调用）"]
        for name, info in sorted(stale_tools.items(), key=lambda x: x[1]["last_used"]):
            lines.append(f"- `{name}` 最后使用: {info['last_used']}")
        lines.append("")

    # App 使用统计（读取 app-usage.jsonl）
    app_usage_file = Path("~/HomeAI/Data/learning/app-usage.jsonl").expanduser()
    app_counts: dict[str, int] = defaultdict(int)
    if app_usage_file.exists():
        for raw in app_usage_file.read_text(encoding="utf-8").strip().split("\n"):
            if not raw.strip():
                continue
            try:
                entry = json.loads(raw)
                app_path = entry.get("appPath", "unknown")
                app_counts[app_path] += 1
            except Exception:
                pass

    lines += ["## App 使用统计（L1 追踪）"]
    if app_counts:
        lines.append(f"- 累计发送 App 链接次数：{sum(app_counts.values())}")
        for path, count in sorted(app_counts.items(), key=lambda x: -x[1])[:10]:
            lines.append(f"  - `{path}`: {count} 次")
    else:
        lines.append("- 暂无 App 使用记录（等待 Lucas 发送 App 链接后自动积累）")
    lines.append("")

    lines += [
        "## 治理建议",
        f"- 请 Andy 对 retiring Skill 执行 `skill_manage(action='delete')`",
        f"- 请 Andy 对 draft + 超过30天无使用的 Skill 进行人工判断",
        f"- 陈旧 Tool 建议与对应 Agent 确认是否仍需",
        f"- 运行 `--gc` 可查看 Clawhub 生态对比替代方案",
        "",
    ]

    REPORT_PATH.write_text("\n".join(lines), encoding="utf-8")
    print(f"✅ 报告已写入：{REPORT_PATH}")
    cmd_audit()


# ── 内部：加载所有真实 Skill ──────────────────────────────────────────────────

def _load_all_real_skills() -> list[dict]:
    skills = []
    for base_dir in [LUCAS_SKILLS_DIR, ANDY_SKILLS_DIR]:
        if not base_dir.exists():
            continue
        for d in sorted(base_dir.iterdir()):
            if not d.is_dir():
                continue
            # 跳过 auto-* 和 spec-* 噪声
            if d.name.startswith("auto-") or d.name.startswith("spec-"):
                continue
            s = read_skill(d)
            if s is not None:
                s["_agent"] = "lucas" if base_dir == LUCAS_SKILLS_DIR else "andy"
                skills.append(s)
    return skills


# ── 入口 ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="能力生命周期管理工具")
    parser.add_argument("--migrate",       action="store_true", help="给现有 Skill 补充生命周期元数据")
    parser.add_argument("--audit",         action="store_true", help="审计所有能力的健康状态")
    parser.add_argument("--gc",            action="store_true", help="列出裁汰候选")
    parser.add_argument("--report",        action="store_true", help="生成 HEARTBEAT 治理报告")
    parser.add_argument("--archive-andy",  action="store_true", help="归档 Andy 的 auto-*/spec-* 噪声文件")
    args = parser.parse_args()

    if args.migrate:
        cmd_migrate()
    elif args.audit:
        cmd_audit()
    elif args.gc:
        cmd_gc()
    elif args.report:
        cmd_report()
    elif getattr(args, "archive_andy", False):
        cmd_archive_andy()
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
