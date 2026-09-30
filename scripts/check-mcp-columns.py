#!/usr/bin/env python3
"""MCP 列名一致性校验（Issue #169）。

背景
----
TaskBoard 有两套 MCP 实现，必须统一读写同一张 SQLite 表：

- `app/src-tauri/src/mcp.rs`      —— 主实现，随 App 二进制打包
- `mcp_server/server.py`          —— 便携 / 开发兜底实现

#155 把 `tasks.key` 改名为 `tasks.issue_key` 后，Python 侧的 `SELECT_COLS` 没跟上，
一直报 "no such column: key"，直到 #169 才被发现——中间隔了若干个版本无人察觉，
因为**没有任何检查会碰到它**（CI 只跑 i18n，Python MCP 不参与构建）。

本脚本就是补上那层检查，零依赖（只用标准库），失败即非零退出：

1. 从 `db.rs::SCHEMA` 解析 `tasks` 表的真实列名，作为唯一事实来源；
2. 校验 Python 与 Rust 两侧 `SELECT_COLS` 的每一列都真实存在；
3. 校验两侧列集合**逐列相同**（含顺序），否则同一工具在两个实现里返回不同字段；
4. 兜底扫描 Python 侧残留的旧列名写法（`WHERE key=?` / `FROM tasks WHERE key`）。
5. (#329) 校验 Python 侧 `ensure_schema::ENSURE_COLUMNS` 覆盖 `SELECT_COLS` 的**每一列**。

第 5 条补的是一个反复踩的坑（#169 / #262 / #278 同源）：给 `SELECT_COLS` 加了列却忘了
在 `ensure_schema` 里补 ALTER，症状只在「Python MCP 首次打开尚未被 App 迁移过的旧库」
这一条路径上出现（`no such column: xxx`），App 自身完全正常、两侧测试也都测不到。
原检查只比对 `SELECT_COLS` 字符串，管不到 ALTER 清单。

用法：`python3 scripts/check-mcp-columns.py`（CI 里同一条命令）
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DB_RS = ROOT / "app" / "src-tauri" / "src" / "db.rs"
MCP_RS = ROOT / "app" / "src-tauri" / "src" / "mcp.rs"
SERVER_PY = ROOT / "mcp_server" / "server.py"

# 表级约束行不是列定义，解析时要跳过。
_CONSTRAINT_PREFIXES = ("unique", "primary key", "constraint", "check", "foreign key")


def die(msg: str) -> None:
    print(f"✗ {msg}")
    sys.exit(1)


def read(path: Path) -> str:
    if not path.exists():
        die(f"文件不存在: {path}")
    return path.read_text(encoding="utf-8")


def tasks_columns(db_src: str) -> list[str]:
    """从 `CREATE TABLE IF NOT EXISTS tasks (...)` 块里取列名（跳过注释与约束）。"""
    start = db_src.find("CREATE TABLE IF NOT EXISTS tasks (")
    if start == -1:
        die("db.rs 里找不到 tasks 表定义，无法确定列名基准")
    body = db_src[start:]
    end = body.find("\n);")
    if end == -1:
        die("tasks 表定义未正常闭合，解析失败")
    lines = body[:end].splitlines()[1:]  # 去掉 CREATE 行本身

    cols: list[str] = []
    for raw in lines:
        line = raw.strip()
        if not line or line.startswith("--"):
            continue
        low = line.lower()
        if low.startswith(_CONSTRAINT_PREFIXES):
            continue
        name = line.split()[0]
        if name.endswith(","):
            name = name[:-1]
        cols.append(name)
    if not cols:
        die("tasks 表解析出 0 列，检查 db.rs schema 是否改动过格式")
    return cols


def py_select_cols(py_src: str) -> list[str]:
    m = re.search(r"SELECT_COLS\s*=\s*\((.*?)\)", py_src, re.DOTALL)
    if not m:
        die("server.py 里找不到 SELECT_COLS 定义")
    return split_cols(m.group(1))


def rust_select_cols(rs_src: str) -> list[str]:
    # 形如：const SELECT_COLS: &str = "a, b, c";（保持单行，便于此处简单匹配）
    m = re.search(r'const\s+SELECT_COLS\s*:\s*&str\s*=\s*"([^"]*)"\s*;', rs_src)
    if not m:
        die("mcp.rs 里找不到 SELECT_COLS 常量")
    return split_cols(m.group(1))


def py_ensure_columns(py_src: str) -> list[str]:
    """从 `ENSURE_COLUMNS = (("name", "DDL"), ...)` 里取列名 (#329)。"""
    m = re.search(r"ENSURE_COLUMNS\s*=\s*\((.*?)\n\)", py_src, re.DOTALL)
    if not m:
        die("server.py 里找不到 ENSURE_COLUMNS 定义")
    names = re.findall(r'\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*,\s*"', m.group(1))
    if not names:
        die("ENSURE_COLUMNS 解析出 0 列，检查 server.py 里的格式是否改动过")
    return names


def split_cols(blob: str) -> list[str]:
    # Python 侧是多行字符串隐式拼接（每段都带引号），Rust 侧是单个裸字符串。
    # 必须先全局剥掉引号再按逗号切：否则跨行片段会同时含有上一行的收尾引号和
    # 下一行的起始引号，strip('"') 只吃掉两端各一个，中间那个会粘在列名上。
    cleaned = blob.replace('"', "").replace("'", "")
    cols = [p.strip().strip(",").strip() for p in cleaned.split(",")]
    cols = [c for c in cols if c]
    if not cols:
        die(f"SELECT_COLS 解析出 0 列: {blob!r}")
    return cols


def main() -> int:
    db_cols = tasks_columns(read(DB_RS))
    server_src = read(SERVER_PY)
    py_cols = py_select_cols(server_src)
    rs_cols = rust_select_cols(read(MCP_RS))
    ensure_cols = py_ensure_columns(server_src)

    db_set = set(db_cols)
    problems: list[str] = []

    for label, cols in (("server.py", py_cols), ("mcp.rs", rs_cols)):
        unknown = [c for c in cols if c not in db_set]
        if unknown:
            problems.append(
                f"{label} 的 SELECT_COLS 含 tasks 表里不存在的列: {', '.join(unknown)}"
            )

    if py_cols != rs_cols:
        only_py = [c for c in py_cols if c not in rs_cols]
        only_rs = [c for c in rs_cols if c not in py_cols]
        problems.append(
            "两侧 SELECT_COLS 不一致（仅 server.py: "
            f"{only_py or '无'}；仅 mcp.rs: {only_rs or '无'}）"
        )

    # (#329) `ensure_schema` 必须能补齐 SELECT_COLS 的每一列，否则「Python MCP 打开
    # 尚未被 App 迁移过的旧库」会 `no such column`（#169/#262/#278 同源缺陷）。
    ensure_set = set(ensure_cols)
    not_ensured = [c for c in py_cols if c not in ensure_set]
    if not_ensured:
        problems.append(
            "server.py::ENSURE_COLUMNS 未覆盖 SELECT_COLS 的列: "
            f"{', '.join(not_ensured)}（往 SELECT_COLS 加列时必须同步补 ALTER）"
        )

    # 兜底：旧列名写法（tasks.key 已于 #155 改名 issue_key）。
    # 跳过注释行——说明性注释里会故意写出 `WHERE key=?` 这个反例。
    legacy = [
        line.strip()
        for line in server_src.splitlines()
        if not line.strip().startswith("#")
        and re.search(r"\bwhere\s+key\s*=", line, re.IGNORECASE)
    ]
    if legacy:
        problems.append(f"server.py 仍残留旧列名 tasks.key 的用法: {legacy}")

    if problems:
        print("✗ MCP 列名校验失败：")
        for p in problems:
            print(f"  - {p}")
        print(f"\n  tasks 表实际列（db.rs）: {', '.join(db_cols)}")
        return 1

    print(
        f"✓ MCP 列名校验通过：{len(py_cols)} 列，server.py 与 mcp.rs 一致，"
        f"均存在于 tasks 表，且 ensure_schema 覆盖全部 {len(ensure_cols)} 列清单"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
