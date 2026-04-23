#!/usr/bin/env python3
"""
distill-agent-memories.py — Andy/Lisa MEMORY.md 蒸馏管道

从 ChromaDB 各角色积累数据中提炼结构化模式，更新对应 workspace 的 MEMORY.md。

数据来源：
  Andy  → decisions 集合（agentFilter=andy）
          + 07-设计与技术外部参考/ 目录（Obsidian 外部文章存档）
          + docs/09-evolution-version.md（系统进化历史）
  Lisa  → decisions 集合（agentFilter=lisa）+ code_history 集合
          + agent_interactions 集合（agentFilter=lisa）
          + docs/10-engineering-notes.md（系统工程师维护的实现陷阱积累）

用法：
  python3 scripts/distill-agent-memories.py            # 全量蒸馏（Andy + Lisa）
  python3 scripts/distill-agent-memories.py --agent andy  # 单角色
  python3 scripts/distill-agent-memories.py --force   # 忽略增量门槛强制重跑
"""

import os, sys, json, argparse, datetime, re, requests
import subprocess as _subprocess
from pathlib import Path

# ── Kuzu 工具 ─────────────────────────────────────────────────────────────────

def get_kuzu_conn():
    """连接 Kuzu 数据库，失败时返回 None（不影响蒸馏主流程）。"""
    try:
        import kuzu as _kuzu
        db = _kuzu.Database(str(_DATA_ROOT / "kuzu"))
        return _kuzu.Connection(db)
    except ImportError:
        print("  WARN: kuzu 未安装，跳过 Kuzu 写入", file=sys.stderr)
        return None
    except Exception as e:
        print(f"  WARN: Kuzu 连接失败：{e}", file=sys.stderr)
        return None


def _title_to_slug(title: str) -> str:
    """模式标题 → 稳定 slug，用于 Kuzu pattern Entity id。
    同一标题每次产出相同 slug，使 MERGE 能找到并更新已有节点。"""
    s = title.lower()
    s = re.sub(r'[^\w\u4e00-\u9fff]+', '_', s)  # 保留中文、字母、数字
    s = re.sub(r'_+', '_', s).strip('_')
    return s[:40]


def parse_distill_sections(distilled: str) -> list[dict]:
    """从 LLM 蒸馏输出中提取 (title, description) 对。
    匹配 ### 标题 + 后续段落内容，忽略 ## 一级节（目录/摘要）。"""
    sections = []
    h3_pattern = re.compile(r'^### (.+?)$', re.MULTILINE)
    matches = list(h3_pattern.finditer(distilled))
    for i, m in enumerate(matches):
        title = m.group(1).strip()
        start = m.end()
        # 内容截到下一个 ### 或下一个 ## 或文件末尾
        if i + 1 < len(matches):
            end = matches[i + 1].start()
        else:
            next_h2 = distilled.find('\n## ', start)
            end = next_h2 if next_h2 != -1 else len(distilled)
        content = distilled[start:end].strip()
        if title and content:
            sections.append({"title": title, "description": content})
    return sections


def write_kuzu_patterns(conn, agent_id: str, sections: list[dict], run_id: str) -> int:
    """
    将蒸馏提炼的模式写入 Kuzu。
    策略：先把此 agent 所有 has_pattern Fact 过期（full refresh），再写新条目。
    数据结构：
      agent Entity {id=agent_id, type='agent'}
        -[Fact {relation='has_pattern', context=描述, source_type='distill'}]->
      pattern Entity {id='pattern_{agent}_{slug}', type='pattern', name=标题}
    返回写入的新 pattern 数量。
    """
    if conn is None or not sections:
        return 0

    now_iso = datetime.datetime.now().isoformat()

    # 过期旧 has_pattern Facts（full refresh）
    try:
        conn.execute(
            "MATCH (a:Entity {id: $aid, type: 'agent'})"
            "-[f:Fact {relation: 'has_pattern'}]->()"
            " WHERE f.valid_until IS NULL SET f.valid_until = $now",
            {"aid": agent_id, "now": now_iso},
        )
    except Exception as e:
        print(f"  WARN: 过期旧 pattern Facts 失败：{e}", file=sys.stderr)

    written = 0
    for sec in sections:
        title  = sec["title"][:80]
        desc   = sec["description"][:600]
        slug   = _title_to_slug(title)
        pat_id = f"pattern_{agent_id}_{slug}"

        try:
            conn.execute(
                "MERGE (e:Entity {id: $id}) SET e.type = 'pattern', e.name = $name",
                {"id": pat_id, "name": title},
            )
            conn.execute(
                "MATCH (a:Entity {id: $aid}), (p:Entity {id: $pid}) "
                "CREATE (a)-[:Fact {relation: 'has_pattern', context: $ctx, "
                "valid_from: $from, confidence: 0.8, "
                "source_type: 'distill', source_id: $sid}]->(p)",
                {"aid": agent_id, "pid": pat_id,
                 "ctx": desc, "from": now_iso, "sid": run_id},
            )
            written += 1
        except Exception as e:
            print(f"  WARN: pattern 写入失败 ({title[:30]}): {e}", file=sys.stderr)

    return written


def refine_capabilities(agent_id: str, kuzu_conn) -> int:
    """
    从 capability-events.jsonl 精炼能力使用模式，写入 Kuzu。
    策略：≥5 次调用样本 → 计算成功率 → 更新 Kuzu has_capability Fact（source_type='distilled'）。
    返回写入条数。
    """
    if kuzu_conn is None:
        return 0

    events_file = _DATA_ROOT / "learning" / f"{agent_id}-capability-events.jsonl"
    if not events_file.exists():
        return 0

    events = []
    with open(events_file) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    if not events:
        return 0

    # 按工具名聚合：{toolName: [success, ...]}
    tool_sessions: dict = {}
    for evt in events:
        success = bool(evt.get("success", False))
        for tool_name in (evt.get("toolCalls") or {}).keys():
            tool_sessions.setdefault(tool_name, []).append(success)

    now_iso = datetime.datetime.now().isoformat()
    run_id  = f"refine-{agent_id}-{datetime.date.today().isoformat()}"
    written = 0

    for tool_name, samples in tool_sessions.items():
        if len(samples) < 5:
            continue  # 样本不足，跳过

        success_rate = sum(samples) / len(samples)
        cap_id  = f"capability_{tool_name}"
        context = f"精炼自 {len(samples)} 次调用记录，成功率 {success_rate:.0%}"

        try:
            # 检查 capability 节点是否存在
            result = kuzu_conn.execute(
                "MATCH (e:Entity {id: $id}) RETURN e.id",
                {"id": cap_id},
            )
            if not result.has_next():
                continue  # capability 节点不存在，跳过

            # 过期旧的 distilled has_capability Fact
            kuzu_conn.execute(
                "MATCH (a:Entity {id: $aid})-[f:Fact {relation: 'has_capability', source_type: 'distilled'}]->(c:Entity {id: $cid}) "
                "WHERE f.valid_until IS NULL SET f.valid_until = $now",
                {"aid": agent_id, "cid": cap_id, "now": now_iso},
            )
            # 去重：删除所有已过期的旧 distilled Fact，只保留最新一条
            kuzu_conn.execute(
                "MATCH (a:Entity {id: $aid})-[f:Fact {relation: 'has_capability', source_type: 'distilled'}]->(c:Entity {id: $cid}) "
                "DELETE f",
                {"aid": agent_id, "cid": cap_id},
            )
            # 写新精炼 Fact
            kuzu_conn.execute(
                "MATCH (a:Entity {id: $aid}), (c:Entity {id: $cid}) "
                "CREATE (a)-[:Fact {relation: 'has_capability', context: $ctx, "
                "valid_from: $from, confidence: $conf, "
                "source_type: 'distilled', source_id: $sid}]->(c)",
                {"aid": agent_id, "cid": cap_id, "ctx": context,
                 "from": now_iso, "conf": round(success_rate, 4), "sid": run_id},
            )
            written += 1
        except Exception as e:
            print(f"  WARN: capability 精炼写入失败 ({tool_name}): {e}", file=sys.stderr)

    return written


# ── 配置 ─────────────────────────────────────────────────────────────────────
_SCRIPTS_DIR = Path(__file__).resolve().parent     # .../HomeAILocal/Scripts
HOMEAI_ROOT  = _SCRIPTS_DIR.parent.parent.parent  # ~/HomeAI
CREWCLAW_DIR = _SCRIPTS_DIR.parent.parent         # ~/HomeAI/CrewHiveClaw
DOCS_DIR     = CREWCLAW_DIR / "Docs"              # ~/HomeAI/CrewHiveClaw/Docs
_DATA_ROOT   = Path(os.environ.get("HOMEAI_DATA_ROOT", str(HOMEAI_ROOT / "Data")))
CHROMA_URL   = os.environ.get("CHROMA_URL", "http://localhost:8001")
CHROMA_BASE  = f"{CHROMA_URL}/api/v2/tenants/default_tenant/databases/default_database/collections"
OPENCLAW_DIR = Path.home() / ".openclaw"
OBSIDIAN_DIR = Path.home() / "Documents" / "Obsidian Vault" / "HomeAI"

AGENT_CONFIGS = {
    "andy": {
        "workspace":   OPENCLAW_DIR / "workspace-andy",
        "collections": [
            {"name": "decisions",    "filter": {"agent": {"$eq": "andy"}}},
        ],
        # 文件来源：读取后拼成文本记录，与 ChromaDB 记录合并参与蒸馏
        "extra_files": [
            {
                "type":  "dir",
                "path":  OBSIDIAN_DIR / "07-设计与技术外部参考",
                "glob":  "*.md",
                "label": "外部参考",
                "max_files": 20,   # 最多取最新 N 个文件
            },
            {
                "type":  "file",
                "path":  DOCS_DIR / "09-evolution-version.md",
                "label": "系统进化历史",
            },
        ],
        "role_desc":   "技术设计师，负责需求分析、技术选型、Implementation Spec 输出",
        "distill_focus": (
            "Andy 作为角色的高层判断倾向（什么情况下推回、什么情况下直接出方案）、"
            "反复出现的设计模式（不是一次性决策，是多次验证的规律）、"
            "高层反思（哪些假设被推翻、哪类设计被证明持久有效）。\n\n"
            "【重要】扫描 decisions 中出现的 【认知更新】 标记——这是 Andy 在调研或出方案过程中，"
            "发现现有判断与新认知存在矛盾时主动写出的修正结论。"
            "处理规则：\n"
            "- 标记指向「旧判断已不成立」→ 在蒸馏输出中淘汰该模式，输出新判断替代；\n"
            "- 标记指向「旧判断部分仍成立」→ 更新该模式的表述，注明适用边界和例外场景；\n"
            "- 被淘汰或修正的旧模式不应出现在 MEMORY.md DISTILLED 中。\n\n"
            "同时主动比对：新的调研结果（type=research）与现有 DISTILLED 模式是否有明显冲突——"
            "即使没有 【认知更新】 标记，若调研结论与某条已有原则反复矛盾，也应输出修正。\n\n"
            "MEMORY.md DISTILLED 区块是保底层——写入最关键的 3-5 条经多次验证的设计原则，"
            "已被认知更新淘汰的不应出现。\n\n"
            "【输出格式要求】DISTILLED 区块的每条原则必须用指令式表达，供弱模型直接遵守：\n"
            "- 用「禁止 X，用 Y 替代」「必须在 Z 时执行 W」格式，不用「建议考虑……」\n"
            "- 最重要的原则放最前（上下文衰减时弱模型优先读到最关键的）\n"
            "- 每条不超过 2 句，去掉解释性叙述，只留规则本身\n"
            "设计知识的主要传递通道是 ChromaDB decisions 实时语义召回。"
            "不要堆积具体决策细节，那些由 ChromaDB 实时召回覆盖。"
        ),
    },
    "lisa": {
        "workspace":   OPENCLAW_DIR / "workspace-lisa",
        "collections": [
            {"name": "decisions",          "filter": {"agent": {"$eq": "lisa"}}},
            {"name": "code_history",       "filter": None},  # 全量（按内容过滤）
            {"name": "agent_interactions", "filter": {"agentId": {"$eq": "lisa"}}},
        ],
        "extra_files": [
            {
                "type":  "file",
                "path":  DOCS_DIR / "10-engineering-notes.md",
                "label": "系统工程师实现陷阱积累",
            },
        ],
        "role_desc":   "工程师，负责按 Andy 的 Spec 实现可运行代码",
        "distill_focus": (
            "Lisa 作为工程师的高层工程判断（什么时候自己写、什么时候用 run_opencode、什么时候推回 Andy）、"
            "反复出现的实现模式（不是一次性做法，是多次验证的规律）、"
            "技术陷阱类型（不是具体报错，是触发陷阱的场景模式）。\n\n"
            "蒸馏 10-engineering-notes.md 中的平台约束和工程陷阱时，必须按以下双重优先级排序：\n"
            "① 时间权重：越新发现的陷阱越靠前（文件中后追加的条目比早期条目更重要）；\n"
            "② 影响面权重：可能导致进程崩溃 / 数据静默丢失 / 全系统不可用的陷阱最优先（如 SIGSEGV/SIGBUS/静默写入虚报）；\n"
            "③ 普通编程约束靠后。\n\n"
            "【重要】扫描 code_history 中出现的 【约束验证】 标记——这是 Lisa 在实现过程中对已知约束做实验验证后写出的结论。"
            "处理规则：\n"
            "- 验证结论为「已修复/不再适用」→ 在蒸馏输出中明确标注该约束已失效，并注明验证日期和版本；\n"
            "- 验证结论为「仍然成立」→ 更新该约束的「最后验证日期」，提高其可信度（confidence）；\n"
            "- 约束失效信息应优先输出，让后续渲染能将其从 CODEBASE.md DISTILLED 中移除。\n\n"
            "CODEBASE.md DISTILLED 区块是最后的保底层——写入最关键的 3-5 条活跃约束，已失效的不应出现。\n\n"
            "【输出格式要求】DISTILLED 区块的每条约束必须用指令式表达，供弱模型直接遵守：\n"
            "- 用「禁止 X，用 Y 替代」「必须在 Z 时执行 W」格式，不用「注意……可能……」\n"
            "- 最关键的约束放最前（崩溃级 > 数据丢失级 > 普通约束）\n"
            "- 每条不超过 2 句，去掉根因解释，只留规则和正确做法\n"
            "工程知识的主要传递通道是 ChromaDB decisions（type=constraint）实时语义召回。"
            "不要堆积具体实现细节，那些由 ChromaDB 实时召回覆盖。"
        ),
    },
    "lucas": {
        "workspace":   OPENCLAW_DIR / "workspace-lucas",
        "collections": [
            {"name": "decisions",         "filter": {"agent": {"$eq": "lucas"}}},
            {"name": "behavior_patterns", "filter": None},  # 全量
        ],
        "extra_files": [],
        "role_desc":   "家庭成员 / 需求官，负责理解家人需求、分发任务、验收交付、陪伴家人",
        "distill_focus": "Lucas 作为 Agent 的判断倾向（什么时候自己回答、什么时候发链接、什么时候触发流水线）、反复出现的有效陪伴策略、反复犯的错误模式（工具调用幻觉、回复格式违规等）。特别提炼：①每位家人的有效 Co-Pilot 模式——对谁发工具链接有效、谁更需要对话引导、谁喜欢语音、谁需要额外说明；②跨成员信息桥接的有效时机——哪类话题值得主动同步、哪类不要主动介入；③家庭信息中继的场景模式——谁常常问别人的状态/想法、Lucas 怎么回答效果好。提炼行为规律，不要堆积对话细节",
    },
}

MIN_RECORDS   = 5    # 至少 N 条才蒸馏
DELTA_TRIGGER = 10   # 自上次蒸馏后新增 N 条才重跑
MAX_RECORDS   = 50   # 每次最多取最近 N 条

# ── ChromaDB 工具 ─────────────────────────────────────────────────────────────

def get_collection_id(name: str) -> str | None:
    r = requests.get(f"{CHROMA_BASE}/{name}", timeout=10)
    return r.json().get("id") if r.status_code == 200 else None


def chroma_get_all(collection: str, where: dict = None, limit: int = 200) -> list[dict]:
    cid = get_collection_id(collection)
    if not cid:
        return []
    payload = {"limit": limit, "include": ["documents", "metadatas"]}
    if where:
        payload["where"] = where
    r = requests.post(f"{CHROMA_BASE}/{cid}/get", json=payload, timeout=30)
    if r.status_code != 200:
        return []
    data  = r.json()
    ids   = data.get("ids", [])
    docs  = data.get("documents", [])
    metas = data.get("metadatas", [])
    return [{"id": ids[i], "document": docs[i], "metadata": metas[i]} for i in range(len(ids))]

# ── 文件来源读取 ──────────────────────────────────────────────────────────────

def read_extra_files(extra_files: list[dict]) -> list[str]:
    """从文件来源读取文本，返回字符串列表（每条对应一个文件或文件片段）。"""
    results = []
    for src in extra_files:
        label = src.get("label", "文件")
        if src["type"] == "file":
            p = Path(src["path"])
            if not p.exists():
                print(f"  WARN: 文件不存在，跳过：{p}", file=sys.stderr)
                continue
            text = p.read_text(encoding="utf-8")
            results.append(f"【{label}】\n{text}")
            print(f"  {label}：读取 {p.name}（{len(text)} 字）")
        elif src["type"] == "dir":
            d = Path(src["path"])
            if not d.exists():
                print(f"  WARN: 目录不存在，跳过：{d}", file=sys.stderr)
                continue
            pattern = src.get("glob", "*.md")
            try:
                files = sorted(d.glob(pattern), key=lambda f: f.stat().st_mtime, reverse=True)
            except PermissionError:
                print(f"  WARN: 目录无读权限（macOS TCC），跳过：{d}", file=sys.stderr)
                continue
            max_files = src.get("max_files", 20)
            files = files[:max_files]
            print(f"  {label}：读取 {len(files)} 个文件（{d}）")
            for f in files:
                try:
                    text = f.read_text(encoding="utf-8")
                except PermissionError:
                    print(f"  WARN: 无权读取 {f.name}，跳过", file=sys.stderr)
                    continue
                results.append(f"【{label} · {f.stem}】\n{text}")
    return results


# ── 元数据持久化 ──────────────────────────────────────────────────────────────

META_DIR = HOMEAI_ROOT / "data" / "agent-distill-meta"
META_DIR.mkdir(parents=True, exist_ok=True)

def load_meta(agent_id: str) -> dict:
    f = META_DIR / f"{agent_id}.json"
    if f.exists():
        try:
            return json.loads(f.read_text())
        except Exception:
            pass
    return {"distilled_at": None, "record_count": 0}

def save_meta(agent_id: str, record_count: int):
    f = META_DIR / f"{agent_id}.json"
    f.write_text(json.dumps({
        "distilled_at": datetime.datetime.now().isoformat(),
        "record_count": record_count,
    }, ensure_ascii=False, indent=2))

# ── LLM 调用 ──────────────────────────────────────────────────────────────────

def read_agent_model_config() -> dict:
    """从 openclaw.json 读取蒸馏任务用的 LLM 配置。
    优先选 DashScope（Lisa 配置），因为 DashScope 兼容 OpenAI 格式且直接可达。
    备选：lisa → lucas（按顺序，跳过无法直接调用的路由模型如 gpt-5.4）。
    """
    cfg_path = OPENCLAW_DIR / "openclaw.json"
    cfg = json.loads(cfg_path.read_text())
    # 按优先级尝试：lisa（DashScope）→ andy（Anthropic）→ lucas（可能 gpt-5.4 不可达）
    for agent_id in ["lisa", "andy", "lucas"]:
        agent = next((a for a in cfg["agents"]["list"] if a["id"] == agent_id), None)
        if not agent:
            continue
        provider_key, model_id = agent["model"].split("/", 1)
        provider = cfg.get("models", {}).get("providers", {}).get(provider_key, {})
        if provider.get("baseUrl") and provider.get("apiKey"):
            return {
                "base_url": provider["baseUrl"],
                "api_key":  provider["apiKey"],
                "model":    model_id,
                "_agent":   agent_id,
            }
    raise RuntimeError("openclaw.json 中找不到可用的 LLM 配置")


def call_llm(prompt: str) -> str:
    cfg = read_agent_model_config()
    base_url = cfg["base_url"]
    # domain-only URL（如 https://api.anthropic.com）需补 /v1，有路径的不重复加
    from urllib.parse import urlparse
    parsed = urlparse(base_url)
    if not parsed.path or parsed.path == "/":
        base_url = base_url.rstrip("/") + "/v1"
    r = requests.post(
        f"{base_url}/chat/completions",
        headers={"Authorization": f"Bearer {cfg['api_key']}", "Content-Type": "application/json"},
        json={
            "model": cfg["model"],
            "messages": [{"role": "user", "content": prompt}],
            "max_tokens": 2000,
            "temperature": 0.3,
        },
        timeout=120,
    )
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"].strip()

# ── 蒸馏提示词 ────────────────────────────────────────────────────────────────

DISTILL_PROMPT = """\
你是 HomeAI 系统的记忆蒸馏器。以下是角色「{agent_id}」（{role_desc}）积累的历史记录（共 {count} 条）。

你的任务：从这些记录中提炼出对该角色**真正有价值的、可复用的模式和判断**。

**只提取真实出现的信息，不推断、不编造。**
**聚焦方向：{distill_focus}**

输出格式（严格遵守，用 Markdown）：
```markdown
## 本次蒸馏新增 / 更新的内容

### [模式/坑/判断名称]
[具体内容，2-4句话，说清楚是什么、为什么重要、怎么用]

### [另一个...]
...

## 蒸馏摘要
[一段 50-100 字的自由格式总结，说这批记录体现了什么模式]
```

历史记录：
{records}
"""

def distill_records(agent_id: str, records: list[str], cfg: dict) -> str:
    recent = records[-MAX_RECORDS:]
    joined = "\n---\n".join(r[:400] + ("…" if len(r) > 400 else "") for r in recent)
    prompt = DISTILL_PROMPT.format(
        agent_id=agent_id,
        role_desc=cfg["role_desc"],
        distill_focus=cfg["distill_focus"],
        count=len(recent),
        records=joined,
    )
    return call_llm(prompt)

# ── MEMORY.md 更新 ────────────────────────────────────────────────────────────

DISTILL_SECTION_START = "<!-- DISTILLED-START -->"
DISTILL_SECTION_END   = "<!-- DISTILLED-END -->"

def update_memory_md(workspace: Path, distilled_content: str, record_count: int):
    """
    将蒸馏结果写入 MEMORY.md 的「蒸馏历史」节。
    MEMORY.md 中用 <!-- DISTILLED-START --> / <!-- DISTILLED-END --> 标记可替换区域。
    标记之外的人工内容永远不碰。
    """
    memory_path = workspace / "MEMORY.md"
    if not memory_path.exists():
        print(f"  WARN: {memory_path} 不存在，跳过写入", file=sys.stderr)
        return

    content = memory_path.read_text(encoding="utf-8")
    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")

    new_section = (
        f"{DISTILL_SECTION_START}\n"
        f"> 最后蒸馏：{now_str}，基于 {record_count} 条记录\n\n"
        f"{distilled_content.strip()}\n"
        f"{DISTILL_SECTION_END}"
    )

    if DISTILL_SECTION_START in content:
        # 替换已有蒸馏节
        pattern = re.compile(
            re.escape(DISTILL_SECTION_START) + r".*?" + re.escape(DISTILL_SECTION_END),
            re.DOTALL,
        )
        updated = pattern.sub(new_section, content)
    else:
        # 第一次：追加到文件末尾
        updated = content.rstrip() + "\n\n---\n\n" + new_section + "\n"

    memory_path.write_text(updated, encoding="utf-8")
    print(f"  MEMORY.md 已更新：{memory_path}")

# ── 主流程 ────────────────────────────────────────────────────────────────────

def distill_agent(agent_id: str, kuzu_conn, force: bool = False) -> bool:
    cfg = AGENT_CONFIGS[agent_id]
    print(f"\n{'='*50}")
    print(f"蒸馏角色：{agent_id}")

    # 拉取 ChromaDB 来源
    all_records = []
    for col_cfg in cfg["collections"]:
        records = chroma_get_all(col_cfg["name"], where=col_cfg.get("filter"))
        print(f"  {col_cfg['name']}：{len(records)} 条")
        all_records.extend(records)

    # 读取文件来源（转成同格式的文本列表）
    file_texts = read_extra_files(cfg.get("extra_files", []))

    total = len(all_records) + len(file_texts)
    print(f"  合计：{total} 条")

    if total < MIN_RECORDS:
        print(f"  跳过：记录数不足 {MIN_RECORDS}（当前 {total}）")
        return False

    if not force:
        meta       = load_meta(agent_id)
        last_count = meta.get("record_count", 0)
        delta      = total - last_count
        print(f"  上次蒸馏：{meta.get('distilled_at', '从未')}，记录数 {last_count}，新增 {delta}")
        if delta < DELTA_TRIGGER:
            print(f"  跳过：新增不足 {DELTA_TRIGGER} 条")
            return False

    # ChromaDB 记录按时间排序，文件来源追加到末尾（通常是更稳定的参考资料）
    all_records.sort(key=lambda x: x["metadata"].get("timestamp", "") if x["metadata"] else "")
    texts = [r["document"] for r in all_records if r["document"]] + file_texts

    print(f"  调用 LLM 蒸馏（最近 {min(len(texts), MAX_RECORDS)} 条）...")
    try:
        distilled = distill_records(agent_id, texts, cfg)
    except Exception as e:
        print(f"  LLM 调用失败：{e}")
        return False

    # ── 写 Kuzu pattern 节点（主路径：ChromaDB → 蒸馏 → Kuzu → 之后由 render-knowledge.py 渲染）
    sections   = parse_distill_sections(distilled)
    run_id     = f"distill-{agent_id}-{datetime.date.today().isoformat()}"
    kuzu_written = write_kuzu_patterns(kuzu_conn, agent_id, sections, run_id)
    print(f"  Kuzu pattern 节点：解析 {len(sections)} 个，写入 {kuzu_written} 条")

    # ── L2：能力精炼（capability-events → 成功率 → Kuzu has_capability distilled）
    cap_written = refine_capabilities(agent_id, kuzu_conn)
    print(f"  Kuzu capability 精炼：写入 {cap_written} 条")

    # ── 降级备份：直接写 MEMORY.md（待 render-knowledge.py --agent 模式完成后移除）
    update_memory_md(cfg["workspace"], distilled, total)

    save_meta(agent_id, total)
    print(f"  完成")
    return True


def main():
    parser = argparse.ArgumentParser(description="Andy/Lisa/Lucas MEMORY.md 蒸馏")
    parser.add_argument("--agent", choices=list(AGENT_CONFIGS.keys()), help="只处理指定角色")
    parser.add_argument("--force", action="store_true", help="忽略增量门槛强制重跑")
    args = parser.parse_args()

    print(f"Agent 记忆蒸馏开始 @ {datetime.datetime.now().isoformat()}")
    print(f"CHROMA_URL: {CHROMA_URL}")

    try:
        agents = [args.agent] if args.agent else list(AGENT_CONFIGS.keys())
        kuzu_conn = get_kuzu_conn()
        results = []
        for aid in agents:
            ok = distill_agent(aid, kuzu_conn, force=args.force)
            results.append((aid, ok))

        print(f"\n{'='*50}")
        print(f"蒸馏完成：{sum(1 for _, ok in results if ok)}/{len(results)} 个角色更新")
        for aid, ok in results:
            print(f"  {'✓ 已更新' if ok else '- 跳过'}  {aid}")

        # ── 蒸馏完成后触发 render-knowledge.py --agent（从 Kuzu 渲染 MEMORY.md）
        # 注意：render-knowledge.py 需要独占 Kuzu 锁，必须在本进程 os._exit(0) 释放锁后再运行。
        # 用 Popen fire-and-forget + start_new_session=True，父进程退出后子进程自行获取锁。
        updated_agents = [aid for aid, ok in results if ok]
        if updated_agents:
            render_script = _SCRIPTS_DIR / "render-knowledge.py"
            agent_arg = ",".join(updated_agents)
            print(f"\n触发 render-knowledge.py --agent {agent_arg}（父进程退出后运行）")
            _subprocess.Popen(
                [sys.executable, str(render_script), "--agent", agent_arg],
                start_new_session=True,  # 脱离父进程组，父进程退出不影响子进程
            )
    finally:
        os._exit(0)  # 释放 Kuzu 文件锁；bypass Database::~Database() SIGBUS on macOS ARM64；异常路径同样触发


if __name__ == "__main__":
    main()
