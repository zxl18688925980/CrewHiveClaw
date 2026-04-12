#!/usr/bin/env python3
"""
build-code-graph.py - 代码库结构图谱构建工具（框架层）

将 TypeScript/Python 代码库解析为 Kuzu 结构图谱，供 DESIGNER/IMPLEMENTOR Agent 做
确定性结构查询（调用链、定义位置、依赖关系），替代纯文本 grep。

触发方式：
  全量构建：  python3 build-code-graph.py
  增量更新：  python3 build-code-graph.py --incremental
  指定文件：  python3 build-code-graph.py --files path/to/a.ts path/to/b.py

框架层配置（env var）：
  CODE_ROOT       代码根目录，默认 ~/HomeAI/CrewHiveClaw/
  KUZU_DB_PATH    Kuzu DB 路径，默认 ~/HomeAI/Data/kuzu
"""

import os
import sys
import re
import ast
import json
import logging
import argparse
from pathlib import Path
from datetime import datetime
from typing import Optional

# ── 路径配置 ─────────────────────────────────────────────────────────────────
_SCRIPTS_DIR   = Path(__file__).resolve().parent
HOMEAI_ROOT    = _SCRIPTS_DIR.parent.parent.parent        # ~/HomeAI
CODE_ROOT      = Path(os.environ.get("CODE_ROOT", HOMEAI_ROOT))  # ~/HomeAI（覆盖所有代码目录）
KUZU_DB_PATH   = Path(os.environ.get("KUZU_DB_PATH", HOMEAI_ROOT / "Data" / "kuzu"))
LOG_FILE       = HOMEAI_ROOT / "Logs" / "build-code-graph.log"
STATE_FILE     = _SCRIPTS_DIR.parent / "data" / "learning" / "code-graph-state.json"

# 扫描文件类型和排除目录
INCLUDE_EXTS   = {".ts", ".py", ".cpp", ".h", ".c", ".hpp", ".js"}
EXCLUDE_DIRS   = {"node_modules", ".git", "dist", "__pycache__", ".openclaw", "migrations",
                  "build", "cmake-build-*", "third_party", "external", "vendor",
                  ".venv", "venv", "__bundled__"}
# 最大解析文件大小（防止超大生成文件）
MAX_FILE_BYTES = 500_000

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(sys.stdout),
    ]
)
log = logging.getLogger(__name__)

# ── tree-sitter 初始化 ────────────────────────────────────────────────────────
try:
    import tree_sitter_typescript as tsts
    import tree_sitter_python as tspy
    import tree_sitter_cpp as tscpp
    from tree_sitter import Language, Parser as TSParser

    _TS_LANG = Language(tsts.language_typescript())
    _PY_LANG = Language(tspy.language())
    _CPP_LANG = Language(tscpp.language())
    _ts_parser = TSParser(_TS_LANG)
    _py_parser = TSParser(_PY_LANG)
    _cpp_parser = TSParser(_CPP_LANG)
    TREE_SITTER_OK = True
except Exception as e:
    log.warning(f"tree-sitter 不可用，Python 文件将使用 ast 模块：{e}")
    TREE_SITTER_OK = False


# ── TypeScript 解析 ───────────────────────────────────────────────────────────

def _ts_node_name(node, src: bytes) -> str:
    """从节点中提取 identifier 名称"""
    for child in node.children:
        if child.type == "identifier":
            return src[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
    return ""


def _walk_ts(node, src: bytes, file_str: str, current_fn: Optional[str],
             nodes: list, calls: list):
    """递归遍历 TypeScript AST，提取函数定义和调用关系"""
    ntype = node.type

    # 函数/方法定义
    if ntype in ("function_declaration", "generator_function_declaration"):
        name = _ts_node_name(node, src)
        if name:
            node_id = f"{file_str}::{name}"
            nodes.append({
                "id": node_id, "name": name, "file": file_str,
                "line": node.start_point[0] + 1, "kind": "function", "lang": "typescript"
            })
            # 递归处理函数体，当前函数作为 caller
            for child in node.children:
                _walk_ts(child, src, file_str, node_id, nodes, calls)
            return

    # const/let fn = (...) => ... 或 const fn = function(...)
    if ntype in ("lexical_declaration", "variable_declaration"):
        for child in node.children:
            if child.type == "variable_declarator":
                var_name = ""
                for c in child.children:
                    if c.type == "identifier":
                        var_name = src[c.start_byte:c.end_byte].decode("utf-8", errors="replace")
                    if var_name and c.type in ("arrow_function", "function"):
                        node_id = f"{file_str}::{var_name}"
                        nodes.append({
                            "id": node_id, "name": var_name, "file": file_str,
                            "line": node.start_point[0] + 1, "kind": "function", "lang": "typescript"
                        })
                        for gc in c.children:
                            _walk_ts(gc, src, file_str, node_id, nodes, calls)
                        return

    # 类定义
    if ntype == "class_declaration":
        name = _ts_node_name(node, src)
        if name:
            node_id = f"{file_str}::{name}"
            nodes.append({
                "id": node_id, "name": name, "file": file_str,
                "line": node.start_point[0] + 1, "kind": "class", "lang": "typescript"
            })
        for child in node.children:
            _walk_ts(child, src, file_str, current_fn, nodes, calls)
        return

    # 方法定义
    if ntype == "method_definition":
        name = _ts_node_name(node, src)
        if name and name not in ("constructor",):
            node_id = f"{file_str}::{name}"
            nodes.append({
                "id": node_id, "name": name, "file": file_str,
                "line": node.start_point[0] + 1, "kind": "method", "lang": "typescript"
            })
            for child in node.children:
                _walk_ts(child, src, file_str, node_id, nodes, calls)
            return

    # 函数调用
    if ntype == "call_expression" and current_fn:
        fn_node = node.children[0] if node.children else None
        if fn_node:
            if fn_node.type == "identifier":
                callee = src[fn_node.start_byte:fn_node.end_byte].decode("utf-8", errors="replace")
                if callee and callee[0].islower():   # 过滤掉全大写常量调用
                    calls.append((current_fn, callee, file_str))
            elif fn_node.type == "member_expression":
                # obj.method(...) - 只记 method 名
                for c in fn_node.children:
                    if c.type == "property_identifier":
                        callee = src[c.start_byte:c.end_byte].decode("utf-8", errors="replace")
                        if callee:
                            calls.append((current_fn, callee, file_str))
                        break

    for child in node.children:
        _walk_ts(child, src, file_str, current_fn, nodes, calls)


def parse_typescript(file_path: Path) -> tuple[list, list]:
    """解析 TypeScript 文件，返回 (nodes, calls)"""
    src = file_path.read_bytes()
    if len(src) > MAX_FILE_BYTES:
        log.debug(f"跳过超大文件：{file_path}（{len(src)} bytes）")
        return [], []
    tree = _ts_parser.parse(src)
    file_str = str(file_path.relative_to(CODE_ROOT))
    nodes, calls = [], []
    _walk_ts(tree.root_node, src, file_str, None, nodes, calls)
    return nodes, calls


# ── Python 解析 ───────────────────────────────────────────────────────────────

class _PyVisitor(ast.NodeVisitor):
    def __init__(self, file_str: str):
        self.file_str = file_str
        self.nodes: list = []
        self.calls: list = []
        self._fn_stack: list = []

    def _current_fn(self) -> Optional[str]:
        return self._fn_stack[-1] if self._fn_stack else None

    def visit_FunctionDef(self, node: ast.FunctionDef):
        fn_id = f"{self.file_str}::{node.name}"
        self.nodes.append({
            "id": fn_id, "name": node.name, "file": self.file_str,
            "line": node.lineno, "kind": "function", "lang": "python"
        })
        self._fn_stack.append(fn_id)
        self.generic_visit(node)
        self._fn_stack.pop()

    visit_AsyncFunctionDef = visit_FunctionDef

    def visit_ClassDef(self, node: ast.ClassDef):
        cls_id = f"{self.file_str}::{node.name}"
        self.nodes.append({
            "id": cls_id, "name": node.name, "file": self.file_str,
            "line": node.lineno, "kind": "class", "lang": "python"
        })
        self.generic_visit(node)

    def visit_Call(self, node: ast.Call):
        caller = self._current_fn()
        if caller:
            callee = None
            if isinstance(node.func, ast.Name):
                callee = node.func.id
            elif isinstance(node.func, ast.Attribute):
                callee = node.func.attr
            if callee and callee[0].islower():
                self.calls.append((caller, callee, self.file_str))
        self.generic_visit(node)


def parse_python(file_path: Path) -> tuple[list, list]:
    """解析 Python 文件，返回 (nodes, calls)"""
    src = file_path.read_text(encoding="utf-8", errors="replace")
    if len(src.encode()) > MAX_FILE_BYTES:
        log.debug(f"跳过超大文件：{file_path}")
        return [], []
    file_str = str(file_path.relative_to(CODE_ROOT))
    try:
        tree = ast.parse(src)
    except SyntaxError as e:
        log.warning(f"Python 解析失败 {file_path}：{e}")
        return [], []
    visitor = _PyVisitor(file_str)
    visitor.visit(tree)
    return visitor.nodes, visitor.calls


# ── C++ 解析 ─────────────────────────────────────────────────────────────────

def _cpp_node_name(node, src: bytes) -> str:
    """从 C++ 声明节点中提取标识符名称"""
    for child in node.children:
        if child.type in ("identifier", "field_identifier", "destructor_name"):
            return src[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
        if child.type == "qualified_identifier":
            # std::vector 等，取最后一段
            parts = []
            for c in child.children:
                if c.type in ("identifier", "namespace_identifier"):
                    parts.append(src[c.start_byte:c.end_byte].decode("utf-8", errors="replace"))
            return "::".join(parts) if parts else ""
    return ""


def _walk_cpp(node, src: bytes, file_str: str, current_fn: Optional[str],
              nodes: list, calls: list):
    """递归遍历 C++ AST，提取函数/类/方法定义和调用关系"""
    ntype = node.type

    # 函数定义
    if ntype in ("function_definition", "declaration"):
        # declaration 可能是函数声明（非定义），检查是否有 body
        is_def = ntype == "function_definition"
        if is_def or any(c.type == "function_declarator" for c in node.children):
            name = ""
            for child in node.children:
                if child.type in ("function_declarator", "pointer_declarator"):
                    for c in child.children:
                        if c.type in ("identifier", "qualified_identifier"):
                            name = src[c.start_byte:c.end_byte].decode("utf-8", errors="replace")
                            break
                elif child.type == "identifier":
                    name = src[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
            if name and len(name) < 200:
                node_id = f"{file_str}::{name}"
                kind = "function"
                nodes.append({
                    "id": node_id, "name": name, "file": file_str,
                    "line": node.start_point[0] + 1, "kind": kind, "lang": "cpp"
                })
                if is_def:
                    for child in node.children:
                        _walk_cpp(child, src, file_str, node_id, nodes, calls)
                    return

    # 类/结构体定义
    if ntype in ("class_specifier", "struct_specifier"):
        name = ""
        for child in node.children:
            if child.type == "type_identifier":
                name = src[child.start_byte:child.end_byte].decode("utf-8", errors="replace")
                break
        if name and len(name) < 200:
            node_id = f"{file_str}::{name}"
            nodes.append({
                "id": node_id, "name": name, "file": file_str,
                "line": node.start_point[0] + 1,
                "kind": "class" if ntype == "class_specifier" else "struct",
                "lang": "cpp"
            })
        for child in node.children:
            _walk_cpp(child, src, file_str, current_fn, nodes, calls)
        return

    # 方法定义（在类体内）
    if ntype == "field_declaration":
        # class 内的成员函数声明/定义
        for child in node.children:
            if child.type == "function_declarator":
                name = ""
                for c in child.children:
                    if c.type in ("identifier", "field_identifier"):
                        name = src[c.start_byte:c.end_byte].decode("utf-8", errors="replace")
                        break
                if name and name not in ("operator=", "operator==") and len(name) < 200:
                    node_id = f"{file_str}::{name}"
                    nodes.append({
                        "id": node_id, "name": name, "file": file_str,
                        "line": node.start_point[0] + 1, "kind": "method", "lang": "cpp"
                    })
                break

    # 函数调用
    if ntype == "call_expression" and current_fn:
        fn_node = node.children[0] if node.children else None
        if fn_node:
            callee = None
            if fn_node.type == "identifier":
                callee = src[fn_node.start_byte:fn_node.end_byte].decode("utf-8", errors="replace")
            elif fn_node.type == "field_expression":
                # obj.method() 或 obj->method()
                for c in fn_node.children:
                    if c.type == "field_identifier":
                        callee = src[c.start_byte:c.end_byte].decode("utf-8", errors="replace")
                        break
            elif fn_node.type == "qualified_identifier":
                # ns::func()
                parts = []
                for c in fn_node.children:
                    if c.type in ("identifier", "namespace_identifier"):
                        parts.append(src[c.start_byte:c.end_byte].decode("utf-8", errors="replace"))
                callee = parts[-1] if parts else None
            if callee and callee[0].islower():
                calls.append((current_fn, callee, file_str))

    for child in node.children:
        _walk_cpp(child, src, file_str, current_fn, nodes, calls)


def parse_cpp(file_path: Path) -> tuple[list, list]:
    """解析 C++ 文件，返回 (nodes, calls)"""
    if not TREE_SITTER_OK:
        return [], []
    src = file_path.read_bytes()
    if len(src) > MAX_FILE_BYTES:
        log.debug(f"跳过超大文件：{file_path}（{len(src)} bytes）")
        return [], []
    tree = _cpp_parser.parse(src)
    file_str = str(file_path.relative_to(CODE_ROOT))
    nodes, calls = [], []
    _walk_cpp(tree.root_node, src, file_str, None, nodes, calls)
    return nodes, calls


# ── 文件扫描 ──────────────────────────────────────────────────────────────────

def scan_files(root: Path, only_files: Optional[list[Path]] = None,
               paths: Optional[list[Path]] = None) -> list[Path]:
    """扫描代码根目录，返回需要解析的文件列表
    only_files: 只处理指定文件列表（--files 模式）
    paths:      只扫描指定子目录（--paths 快速模式，默认扫全量）
    """
    if only_files:
        return [f for f in only_files if f.suffix in INCLUDE_EXTS and f.exists()]

    scan_roots = paths if paths else [root]
    result = []
    for scan_root in scan_roots:
        for f in scan_root.rglob("*"):
            if f.suffix not in INCLUDE_EXTS:
                continue
            if any(ex in f.parts for ex in EXCLUDE_DIRS):
                continue
            result.append(f)
    return result


# ── Kuzu 写入 ─────────────────────────────────────────────────────────────────

def init_schema(conn) -> None:
    """创建代码图谱表（已存在则跳过）"""
    tables_existing = set()
    res = conn.execute("CALL show_tables() RETURN *")
    while res.has_next():
        row = res.get_next()
        tables_existing.add(row[1])   # name 字段

    if "CodeNode" not in tables_existing:
        conn.execute("""
            CREATE NODE TABLE CodeNode(
                id     STRING,
                name   STRING,
                file   STRING,
                line   INT64,
                kind   STRING,
                lang   STRING,
                PRIMARY KEY(id)
            )
        """)
        log.info("创建 CodeNode 表")

    if "CODE_CALLS" not in tables_existing:
        conn.execute("CREATE REL TABLE CODE_CALLS(FROM CodeNode TO CodeNode, weight INT64)")
        log.info("创建 CODE_CALLS 表")


def clear_file_nodes(conn, file_str: str) -> None:
    """删除某文件的全部节点和相关边（增量更新时先清除）"""
    conn.execute(
        "MATCH (n:CodeNode) WHERE n.file = $f DETACH DELETE n",
        {"f": file_str}
    )


def write_nodes(conn, nodes: list) -> int:
    """批量写入 CodeNode"""
    count = 0
    for n in nodes:
        try:
            conn.execute(
                "CREATE (:CodeNode {id: $id, name: $name, file: $file, "
                "line: $line, kind: $kind, lang: $lang})",
                n
            )
            count += 1
        except Exception:
            pass   # 主键重复（同名函数在多个文件）时跳过
    return count


def write_calls(conn, calls: list, existing_ids: set) -> int:
    """写入 CODE_CALLS 边（callee 必须已在图谱中）"""
    # 按 (caller_id, callee_name) 聚合 weight
    edge_weights: dict[tuple[str, str], int] = {}
    for caller_id, callee_name, _ in calls:
        if caller_id in existing_ids:
            key = (caller_id, callee_name)
            edge_weights[key] = edge_weights.get(key, 0) + 1

    count = 0
    for (caller_id, callee_name), weight in edge_weights.items():
        try:
            conn.execute(
                "MATCH (a:CodeNode {id: $cid}), (b:CodeNode {name: $cn}) "
                "CREATE (a)-[:CODE_CALLS {weight: $w}]->(b)",
                {"cid": caller_id, "cn": callee_name, "w": weight}
            )
            count += 1
        except Exception:
            pass   # callee 不在图谱中，跳过
    return count


# ── 状态管理 ──────────────────────────────────────────────────────────────────

def load_state() -> dict:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            pass
    return {}


def save_state(state: dict) -> None:
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2))


# ── 主流程 ────────────────────────────────────────────────────────────────────

def build(only_files: Optional[list[Path]] = None, incremental: bool = False,
          paths: Optional[list[Path]] = None) -> None:
    import kuzu

    files = scan_files(CODE_ROOT, only_files, paths)
    log.info(f"解析文件：{len(files)} 个（{'增量' if incremental else '全量'}）")

    db   = kuzu.Database(str(KUZU_DB_PATH))
    conn = kuzu.Connection(db)

    init_schema(conn)

    # 全量模式：清除所有 CodeNode（edges 随 DETACH DELETE 一起清除）
    if not incremental and not only_files:
        try:
            conn.execute("MATCH (n:CodeNode) DETACH DELETE n")
            log.info("清除旧图谱数据")
        except Exception as e:
            log.warning(f"清除旧数据失败：{e}")

    all_nodes: list  = []
    all_calls: list  = []
    node_ids:  set   = set()

    for f in files:
        file_str = str(f.relative_to(CODE_ROOT))

        # 增量模式：先清除该文件的旧节点
        if incremental or only_files:
            clear_file_nodes(conn, file_str)

        try:
            if f.suffix in (".ts", ".js"):
                nodes, calls = parse_typescript(f)
            elif f.suffix in (".cpp", ".h", ".c", ".hpp"):
                nodes, calls = parse_cpp(f)
            else:
                nodes, calls = parse_python(f)
        except Exception as e:
            log.warning(f"解析失败 {f}：{e}")
            continue

        all_nodes.extend(nodes)
        all_calls.extend(calls)
        log.debug(f"  {file_str}：{len(nodes)} 节点，{len(calls)} 调用")

    # 先写所有节点，再建边
    n_written = write_nodes(conn, all_nodes)
    for n in all_nodes:
        node_ids.add(n["id"])
    e_written = write_calls(conn, all_calls, node_ids)

    state = load_state()
    state.update({
        "last_run":   datetime.now().isoformat(),
        "mode":       "incremental" if (incremental or only_files) else "full",
        "files":      len(files),
        "nodes":      n_written,
        "edges":      e_written,
    })
    save_state(state)

    log.info(f"完成：{n_written} 节点，{e_written} 调用边，{len(files)} 文件")


# ── CLI ───────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="代码库结构图谱构建工具")
    parser.add_argument("--incremental", action="store_true", help="增量模式（只清除并重建指定文件的节点）")
    parser.add_argument("--files", nargs="+", help="只重解析指定文件（绝对路径）")
    parser.add_argument("--paths", nargs="+",
                        help="只扫描指定子目录（相对于 CODE_ROOT，如 CrewClaw/crewclaw-routing HomeAILocal/Scripts）")
    args = parser.parse_args()

    only_files = [Path(f).resolve() for f in args.files] if args.files else None
    scan_paths  = [CODE_ROOT / p for p in args.paths] if args.paths else None
    build(only_files=only_files, incremental=args.incremental, paths=scan_paths)
    import os as _os; _os._exit(0)


if __name__ == "__main__":
    main()
