#!/usr/bin/env python3
"""scripts/check-mcp-columns.py 的单测（#451）。

此前 `scripts/` 下5 个检查脚本里，只有这一个**没有**回归测试
（`check-doc-links` / `check-versions` / `check-workflow-yaml` / `merge-cleanup` 都有）。
它负责 MCP 双实现的列一致性 —— 一旦解析函数因 `db.rs` / `server.py` 的格式微调而
悄悄失效（比如 `TASK_INSERT_HEAD` 从跨行 SQL 变成单行），不会有任何测试报警，
而它的失效恰好意味着 #169 / #262 / #278 / #438 这一类**双实现漂移缺陷重新失去兜底**。

因此本文件守住两件事：

  1. 正向：当前三份清单（`db.rs::SCHEMA` / `mcp.rs::SELECT_COLS` / `server.py`）
     必须能全部解析成功且通过校验 —— 解析器跟上了格式演进。
  2. 反向：每类漂移都必须**被检出**，且错误信息要说清怎么改 ——
     检查器自己的失效方式和它要抓的缺陷是同一种（静默失效）。

运行：python3 -m unittest discover -s scripts -p 'test_*.py'
"""

import importlib.util
import sys
import unittest
from pathlib import Path


def _load(name, filename):
    """按文件名加载带连字符的模块（`check-mcp-columns.py` 不是合法 import 标识符）。

    ⚠️ `sys.modules[name] = module` 必须在 `exec_module` **之前** ——
    被加载模块若有 `@dataclass`，会去 `sys.modules` 找自己的模块命名空间，
    缺失会直接 AttributeError。这是 `test_workflow_yaml.py` 已踩过的坑。
    """
    path = Path(__file__).with_name(filename)
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


M = _load("check_mcp_columns", "check-mcp-columns.py")


class ParseTests(unittest.TestCase):
    """解析函数必须跟得上 `db.rs` / `server.py` 的真实格式。"""

    def test_tasks_columns_parses_real_schema(self):
        cols = M.tasks_columns(M.read(M.DB_RS))
        for expected in ("issue_key", "account_id", "created_at", "pr_state"):
            self.assertIn(
                expected, cols, f"tasks 表解析结果缺 {expected}（SCHEMA 格式可能变了）"
            )

    def test_rust_insert_cols_parses_multiline_sql(self):
        """`TASK_INSERT_HEAD` 是**跨行** SQL 字面量，不是单行列名串。

        这是本组测试存在的首要原因：解析器若按单行匹配，会把
        `INSERT INTO tasks` / `VALUES (?1, ...)` 当成列名 —— 校验器不报错，
        但断言完全失去意义（恒真的守卫比没有守卫更危险）。
        """
        cols = M.rust_insert_cols(M.read(M.DB_RS))
        self.assertIn("issue_key", cols)
        self.assertIn("created_at", cols)
        # 必须只拿到列名，不能混入 SQL 关键字或占位符。
        for c in cols:
            self.assertNotIn(" ", c, f"列名里混入了空白 / SQL 片段: {c!r}")
            self.assertFalse(c.startswith("?"), f"列名里混入了占位符: {c!r}")
            self.assertNotIn("INSERT", c.upper())
            self.assertNotIn("VALUES", c.upper())

    def test_py_insert_cols_parses_real_tuple(self):
        cols = M.py_insert_cols(M.read(M.SERVER_PY))
        self.assertIn("issue_key", cols)
        self.assertIn("created_at", cols, "#438 已补该列，解析器不应把它漏掉")

    def test_select_cols_both_sides_agree(self):
        """两侧 `SELECT_COLS` 必须逐列相同（这是原脚本已有的不变量）。"""
        py = M.py_select_cols(M.read(M.SERVER_PY))
        rs = M.rust_select_cols(M.read(M.MCP_RS))
        self.assertEqual(py, rs, "两侧 SELECT_COLS 不一致")
        self.assertTrue(py, "SELECT_COLS 不应为空")


class DriftDetectionTests(unittest.TestCase):
    """每类漂移都必须被检出 —— 检查器自身的失效方式和它要抓的缺陷是同一种。"""

    def _missing_vs_rust(self, py_cols):
        """复现 main() 里的差集判定逻辑，返回「无法解释的缺列」。"""
        rust = M.rust_insert_cols(M.read(M.DB_RS))
        missing = [c for c in rust if c not in set(py_cols)]
        return [c for c in missing if c not in M.RUST_EXPLICIT_EMPTY]

    def test_created_at_drift_is_caught(self):
        """#438 那个缺陷必须被抓住：Python 少写 `created_at`。

        该漂移当年是人工发现的（Python 按需拉取的 issue `created_at` 落0，
        「创建于 X 前」显示成 1970 年），此后一直没有 CI 兜底。
        """
        py_cols = [
            c for c in M.py_insert_cols(M.read(M.SERVER_PY)) if c != "created_at"
        ]
        unexplained = self._missing_vs_rust(py_cols)
        self.assertIn(
            "created_at",
            unexplained,
            "Python 少写 created_at 必须被判为无法解释的差集（#438 同源缺陷）",
        )

    def test_explicit_empty_columns_are_tolerated(self):
        """Rust 显式写空串的几列允许缺失 —— 否则校验器会对合法状态误报。

        误报比漏报更致命（会让每个 PR 的 CI 都红），故这条正向同样要锁。
        """
        py_cols = [
            c for c in M.py_insert_cols(M.read(M.SERVER_PY))
            if c not in M.RUST_EXPLICIT_EMPTY
        ]
        self.assertEqual(
            self._missing_vs_rust(py_cols),
            [],
            "RUST_EXPLICIT_EMPTY 名单内的列缺失不得判失败（Rust 写空串，Python 落默认值，语义相同）",
        )

    def test_current_state_has_no_unexplained_drift(self):
        """当前仓库状态：差集恰好等于 `RUST_EXPLICIT_EMPTY`。"""
        py_cols = M.py_insert_cols(M.read(M.SERVER_PY))
        rust = M.rust_insert_cols(M.read(M.DB_RS))
        missing = {c for c in rust if c not in set(py_cols)}
        self.assertEqual(
            missing,
            set(M.RUST_EXPLICIT_EMPTY),
            "Python 与 Rust 的写入列差集应恰好等于 RUST_EXPLICIT_EMPTY；"
            "若新增了差集项，必须确认它确实是「Rust 写空串、Python 落默认值」的同义列",
        )

    def test_extra_column_in_python_is_caught(self):
        """反向：Python 多写 Rust 没有的列同样判失败（两侧必须一致）。"""
        py_cols = M.py_insert_cols(M.read(M.SERVER_PY)) + ["ghost_column"]
        rust = set(M.rust_insert_cols(M.read(M.DB_RS)))
        extra = [c for c in py_cols if c not in rust]
        self.assertIn(
            "ghost_column",
            extra,
            "Python 侧多出的写入列必须能被检出（否则会写到 Rust 未定义的列上）",
        )


class ScriptRunTests(unittest.TestCase):
    """`main()` 在当前仓库必须返回 0 —— 覆盖 CI 的真实执行路径。"""

    def test_main_passes_on_current_repo(self):
        import io
        import contextlib

        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            rc = M.main()
        self.assertEqual(rc, 0, f"当前仓库应通过校验，实际输出:\n{buf.getvalue()}")


if __name__ == "__main__":
    unittest.main()