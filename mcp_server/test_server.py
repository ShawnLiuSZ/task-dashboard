"""server.py 的单测（标准库 unittest，零依赖）。

覆盖 v0.4.1 (#250)「本地未命中时按需拉取单个 issue」的纯逻辑部分：
引用解析（保留 owner）、账号选择（无账号 / org 不匹配 / 默认账号 / 无 PAT）、
字段映射（ownership / label 映射 / ISO→Unix 秒）、以及两条**不发网络请求**的契约。

网络层（`_fetch_issue`）在这些用例里一律被替换 —— 真实 HTTP 不在单测范围，
与 Rust 侧一致（那边同样只测纯逻辑与「不发请求」契约）。

运行：
    python3 -m unittest discover -s mcp_server -p 'test_*.py' -v
"""

import os
import sqlite3
import sys
import tempfile
import unittest

# server.py 在 import 时就用 TASKBOARD_DB 定下数据库路径，必须先设环境变量。
_TMP = tempfile.mkdtemp(prefix="tb-mcp-test-")
_DB = os.path.join(_TMP, "taskboard.db")
os.environ["TASKBOARD_DB"] = _DB
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import server as S  # noqa: E402  （必须在设置环境变量之后导入）

SCHEMA = """
CREATE TABLE accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, label TEXT NOT NULL, login TEXT NOT NULL,
  org TEXT NOT NULL, pat_token TEXT NOT NULL, is_default INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL);
CREATE TABLE tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, issue_key TEXT, owner TEXT, repo TEXT, number INTEGER,
  title TEXT, url TEXT, issue_state TEXT, ownership TEXT, status TEXT, project_status TEXT,
  assignees TEXT, labels TEXT, done_at INTEGER DEFAULT 0, mentioned INTEGER DEFAULT 0,
  comments_count INTEGER DEFAULT 0, latest_comment_url TEXT, pr_number INTEGER DEFAULT 0,
  pr_url TEXT, branch TEXT DEFAULT '', author TEXT, session_id TEXT, session_agent TEXT,
  session_at INTEGER, handoff TEXT DEFAULT '', candidate_done INTEGER DEFAULT 0,
  stale INTEGER DEFAULT 0, updated_at INTEGER, synced_at INTEGER, work_branch TEXT DEFAULT '',
  parent_issue TEXT DEFAULT '', sub_issues TEXT DEFAULT '',
  account_id INTEGER, created_at INTEGER DEFAULT 0, UNIQUE(repo, number, account_id));
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE label_mappings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, org TEXT, repo TEXT, label TEXT, status TEXT);
CREATE TABLE account_columns (
  id INTEGER PRIMARY KEY AUTOINCREMENT, account_id INTEGER, col_key TEXT, match_rules TEXT);
"""

ISSUE_PAYLOAD = {
    "number": 248,
    "title": "feat(mcp): 按需拉取",
    "html_url": "https://github.com/ShawnLiuSZ/task-dashboard/issues/248",
    "state": "open",
    "updated_at": "2026-09-15T02:26:31Z",
    "assignees": [{"login": "ShawnLiuSZ"}],
    "labels": [{"name": "enhancement"}],
    "user": {"login": "ShawnLiuSZ"},
    "comments": 3,
}


class OnDemandTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        c = sqlite3.connect(_DB)
        c.executescript(SCHEMA)
        c.commit()
        c.close()

    @staticmethod
    def _reset_conn():
        """关掉 server 的全局连接缓存（否则会有 ResourceWarning，且跨用例串状态）。"""
        if S._conn is not None:
            S._conn.close()
        S._conn = None

    def setUp(self):
        # 清空数据并丢掉连接缓存（每个用例从干净状态开始）。
        self._reset_conn()
        c = sqlite3.connect(_DB)
        c.executescript(
            "DELETE FROM tasks; DELETE FROM accounts;"
            "DELETE FROM label_mappings; DELETE FROM account_columns;"
        )
        c.commit()
        c.close()
        # 默认打桩：任何调用都视为 bug，用例按需覆盖。
        self._orig_fetch = S._fetch_issue
        S._fetch_issue = self._no_network

    def tearDown(self):
        S._fetch_issue = self._orig_fetch
        self._reset_conn()

    @staticmethod
    def _no_network(*_a, **_k):
        raise AssertionError("本用例不应发起网络请求")

    def _add_account(self, login="ShawnLiuSZ", org="ShawnLiuSZ", pat="ghp_x", is_default=1):
        """插入一个账号并返回其 id（setUp 的 DELETE 不复位 AUTOINCREMENT，不能假定 id=1）。"""
        c = sqlite3.connect(_DB)
        cur = c.execute(
            "INSERT INTO accounts (label, login, org, pat_token, is_default, created_at)"
            " VALUES ('l', ?, ?, ?, ?, 0)",
            (login, org, pat, is_default),
        )
        new_id = cur.lastrowid
        c.commit()
        c.close()
        return new_id

    # ── 引用解析（保留 owner） ────────────────────────────────────────────
    def test_parse_keeps_owner(self):
        p = S.parse_issue_ref_parts("FoodsUp-Inc/fad-backend#1234")
        self.assertEqual(
            (p["owner"], p["repo"], p["number"], p["key"]),
            ("FoodsUp-Inc", "fad-backend", 1234, "fad-backend#1234"),
        )

    def test_parse_without_owner(self):
        p = S.parse_issue_ref_parts("task-dashboard#248")
        self.assertIsNone(p["owner"])
        self.assertEqual(p["key"], "task-dashboard#248")

    def test_parse_from_url_keeps_owner(self):
        p = S.parse_issue_ref_parts(
            "https://github.com/ShawnLiuSZ/task-dashboard/issues/248"
        )
        self.assertEqual(p["owner"], "ShawnLiuSZ")
        self.assertEqual(p["key"], "task-dashboard#248")

    def test_parse_rejects_invalid(self):
        with self.assertRaises(ValueError):
            S.parse_issue_ref_parts("")
        with self.assertRaises(ValueError):
            S.parse_issue_ref_parts("plain text")
        with self.assertRaises(ValueError):
            S.parse_issue_ref_parts("repo#abc")
        with self.assertRaises(ValueError):
            S.parse_issue_ref_parts("repo#0")

    # ── 纯函数 ───────────────────────────────────────────────────────────
    def test_iso_to_secs(self):
        self.assertEqual(S._iso_to_secs("2026-09-15T02:26:31Z"), 1789439191)
        self.assertEqual(S._iso_to_secs(""), 0)
        self.assertEqual(S._iso_to_secs("not-a-date"), 0)

    def test_classify(self):
        self.assertEqual(S._classify([], "alice"), "notassignee")
        self.assertEqual(S._classify(["alice", "bob"], "alice"), "assigned")
        self.assertEqual(S._classify(["bob"], "alice"), "assigned-others")

    def test_label_status_repo_level_before_org_level(self):
        c = sqlite3.connect(_DB)
        c.execute(
            "INSERT INTO label_mappings (org, repo, label, status)"
            " VALUES ('acme','', 'bug','processed')"
        )
        c.execute(
            "INSERT INTO label_mappings (org, repo, label, status)"
            " VALUES ('acme','web', 'bug','doing')"
        )
        c.commit()
        c.close()
        self.assertEqual(S._resolve_label_status("acme", "web", "bug"), "doing")
        self.assertEqual(S._resolve_label_status("acme", "other", "bug"), "processed")
        self.assertIsNone(S._resolve_label_status("acme", "web", "nope"))

    # ── 账号选择 ─────────────────────────────────────────────────────────
    def test_pick_account_matches_owner_case_insensitively(self):
        self._add_account(login="alice", org="Acme", is_default=0)
        self._add_account(login="bob", org="FoodsUp-Inc", is_default=1)
        account, reason = S._pick_account("foodsup-inc")
        self.assertIsNone(reason)
        self.assertEqual(account["login"], "bob")

    def test_pick_account_unknown_owner_lists_orgs(self):
        self._add_account(login="alice", org="Acme")
        account, reason = S._pick_account("nope")
        self.assertIsNone(account)
        self.assertIn("nope", reason)
        self.assertIn("Acme", reason)

    def test_pick_account_defaults_without_owner(self):
        self._add_account(login="alice", org="Acme", is_default=0)
        self._add_account(login="bob", org="Other", is_default=1)
        account, _ = S._pick_account(None)
        self.assertEqual(account["login"], "bob")

    def test_pick_account_empty_pat_is_unavailable(self):
        self._add_account(pat="   ")
        account, reason = S._pick_account(None)
        self.assertIsNone(account)
        self.assertIn("未配置 PAT", reason)

    def test_pick_account_matches_login_when_org_is_empty(self):
        # 真实场景（实测本地库）：task-dashboard 所属账号 org 为空串（个人命名空间），
        # 只按 org 匹配会让 owner/repo#N 找不到账号。
        self._add_account(login="ShawnLiuSZ", org="", is_default=0)
        self._add_account(login="liushizhao2025", org="FoodsUp-Inc", is_default=1)
        account, _ = S._pick_account("shawnliusz")
        self.assertEqual(account["login"], "ShawnLiuSZ")
        # org 仍照旧可命中
        account, _ = S._pick_account("foodsup-inc")
        self.assertEqual(account["login"], "liushizhao2025")

    def test_default_owner_falls_back_to_login(self):
        self.assertEqual(S._default_owner({"org": "", "login": "ShawnLiuSZ"}), "ShawnLiuSZ")
        self.assertEqual(
            S._default_owner({"org": "FoodsUp-Inc", "login": "x"}), "FoodsUp-Inc"
        )

    def test_pick_account_no_accounts(self):
        account, reason = S._pick_account(None)
        self.assertIsNone(account)
        self.assertIn("没有任何 GitHub 账号", reason)

    # ── 不发网络请求的契约 ───────────────────────────────────────────────
    def test_write_without_account_fails_with_reason_not_network(self):
        with self.assertRaises(ValueError) as ctx:
            S.tool_update_task_status("task-dashboard#248", "处理中")
        msg = str(ctx.exception)
        self.assertIn("无法从 GitHub 拉取", msg)
        self.assertIn("没有任何 GitHub 账号", msg)

    def test_get_status_degrades_without_account(self):
        result = S.tool_get_task_status("task-dashboard#248")
        self.assertFalse(result["found"])
        self.assertIn("无法从 GitHub 拉取", result["reason"])

    # ── 拉取 + 落库 ──────────────────────────────────────────────────────
    def _stub_issue(self, payload=None):
        S._fetch_issue = lambda pat, owner, repo, num: (payload or ISSUE_PAYLOAD, None)

    def test_pull_inserts_row_with_mapping(self):
        self._add_account()
        c = sqlite3.connect(_DB)
        c.execute(
            "INSERT INTO label_mappings (org, repo, label, status)"
            " VALUES ('ShawnLiuSZ','task-dashboard','enhancement','doing')"
        )
        c.commit()
        c.close()
        self._stub_issue()
        self.assertEqual(
            S.ensure_task_available("ShawnLiuSZ/task-dashboard#248"), ("pulled", None)
        )
        row = dict(
            S.conn()
            .execute("SELECT * FROM tasks WHERE issue_key='task-dashboard#248'")
            .fetchone()
        )
        self.assertEqual(row["owner"], "ShawnLiuSZ")
        self.assertEqual(row["title"], ISSUE_PAYLOAD["title"])
        self.assertEqual(row["ownership"], "assigned")
        # label 映射 enhancement → doing（而非兜底的 todo）
        self.assertEqual(row["status"], "doing")
        self.assertEqual(row["labels"], "enhancement")
        self.assertEqual(row["author"], "ShawnLiuSZ")
        self.assertEqual(row["comments_count"], 3)
        # 单 issue REST 给不了的字段留空，等下次全量同步补
        self.assertEqual(row["project_status"], "")
        self.assertEqual(row["mentioned"], 0)
        self.assertEqual(row["pr_number"], 0)
        self.assertEqual(row["updated_at"], 1789439191)

    def test_api_owner_falls_back_to_login_but_row_owner_is_org(self):
        # 实测场景：org 为空串的账号（个人命名空间）。API 请求必须用 login 拼 URL，
        # 而 tasks.owner 列与同步保持一致（写 account.org，即便为空）。
        self._add_account(login="ShawnLiuSZ", org="")
        seen = {}

        def fake_fetch(pat, owner, repo, num):
            seen["owner"] = owner
            return ({**ISSUE_PAYLOAD, "number": 250}, None)

        S._fetch_issue = fake_fetch
        self.assertEqual(
            S.ensure_task_available("ShawnLiuSZ/task-dashboard#250"), ("pulled", None)
        )
        self.assertEqual(seen["owner"], "ShawnLiuSZ")
        row = dict(
            S.conn()
            .execute("SELECT owner FROM tasks WHERE issue_key='task-dashboard#250'")
            .fetchone()
        )
        self.assertEqual(row["owner"], "")

    def test_existing_row_skips_network(self):
        self._add_account()
        self._stub_issue()
        S.ensure_task_available("ShawnLiuSZ/task-dashboard#248")
        # 第二次：行已存在，绝不能再发请求（setUp 里已把 _fetch_issue 换成抛错实现）
        S._fetch_issue = lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("行已存在时不应发起网络请求")
        )
        self.assertEqual(
            S.ensure_task_available("ShawnLiuSZ/task-dashboard#248"), ("already", None)
        )
        result = S.tool_update_task_status("ShawnLiuSZ/task-dashboard#248", "已完成")
        self.assertTrue(result["ok"])
        self.assertFalse(result["pulled"])

    def test_custom_column_writable_after_pull(self):
        # 自定义列校验要读该行的 account_id → 必须在写入前完成拉取
        account_id = self._add_account()
        c = sqlite3.connect(_DB)
        c.execute(
            "INSERT INTO account_columns (account_id, col_key, match_rules)"
            " VALUES (?, 'col_1', '[]')",
            (account_id,),
        )
        c.commit()
        c.close()
        self._stub_issue()
        result = S.tool_update_task_status("ShawnLiuSZ/task-dashboard#248", "col_1")
        self.assertEqual(result["status"], "col_1")

    def test_insert_if_absent_does_not_overwrite(self):
        self._add_account()
        self._stub_issue()
        S.ensure_task_available("ShawnLiuSZ/task-dashboard#248")
        # 模拟同步写入的权威字段，再走一次 DO NOTHING 落库：不得被覆盖
        S.conn().execute(
            "UPDATE tasks SET project_status='✨开发中' WHERE issue_key='task-dashboard#248'"
        )
        row = dict(
            S.conn()
            .execute("SELECT * FROM tasks WHERE issue_key='task-dashboard#248'")
            .fetchone()
        )
        row.pop("id")
        self.assertIsNone(S._write_task_if_absent(row))  # 不报错
        got = S.conn().execute(
            "SELECT project_status FROM tasks WHERE issue_key='task-dashboard#248'"
        ).fetchone()[0]
        self.assertEqual(got, "✨开发中")

    def test_pull_request_number_is_remote_missing(self):
        self._add_account()
        self._stub_issue({**ISSUE_PAYLOAD, "number": 249, "pull_request": {"url": "x"}})
        outcome, detail = S.ensure_task_available("ShawnLiuSZ/task-dashboard#249")
        self.assertEqual(outcome, "remote_missing")
        self.assertIn("ShawnLiuSZ/task-dashboard#249", detail)
        self.assertIn("是 PR", detail)

    def test_remote_404_is_remote_missing(self):
        self._add_account()
        S._fetch_issue = lambda pat, owner, repo, num: (None, None)
        outcome, detail = S.ensure_task_available("ShawnLiuSZ/task-dashboard#999")
        self.assertEqual(outcome, "remote_missing")
        self.assertIn("ShawnLiuSZ/task-dashboard#999", detail)
        # 显式给了 owner → 不该出现「owner 是推断的」提示
        self.assertNotIn("推断", detail)

    def test_remote_missing_hints_when_owner_was_inferred(self):
        # ref 不带 owner（AGENTS.md §7 允许 repo#N）：owner 由账号推断，
        # 此时 404 可能是命名空间不对，必须提示改写引用形式。
        self._add_account(login="liushizhao2025", org="FoodsUp-Inc")
        S._fetch_issue = lambda pat, owner, repo, num: (None, None)
        outcome, detail = S.ensure_task_available("task-dashboard#250")
        self.assertEqual(outcome, "remote_missing")
        self.assertIn("FoodsUp-Inc/task-dashboard#250", detail)   # 实际查询目标
        self.assertIn("由账号推断", detail)                        # 推断提示
        self.assertIn("owner/repo#N", detail)                     # 怎么改

    def test_get_status_reason_includes_queried_target(self):
        self._add_account()
        S._fetch_issue = lambda pat, owner, repo, num: (None, None)
        result = S.tool_get_task_status("ShawnLiuSZ/task-dashboard#999")
        self.assertFalse(result["found"])
        self.assertIn("ShawnLiuSZ/task-dashboard#999", result["reason"])

    def test_fetch_failure_is_unavailable_with_reason(self):
        self._add_account()
        S._fetch_issue = lambda pat, owner, repo, num: (None, "网络请求失败: boom")
        outcome, reason = S.ensure_task_available("ShawnLiuSZ/task-dashboard#248")
        self.assertEqual(outcome, "unavailable")
        self.assertIn("boom", reason)

    # ── #279：set_work_branch 只更新 work_branch，不碰 PR branch ───────────
    def test_set_work_branch_updates_only_work_branch(self):
        # 插入一条已有 PR branch=main 的任务，验证 set_work_branch 只改 work_branch。
        account_id = self._add_account()
        c = sqlite3.connect(_DB)
        c.execute(
            "INSERT INTO tasks (issue_key, owner, repo, number, title, url, issue_state,"
            " ownership, status, account_id, branch, work_branch)"
            " VALUES ('fad-backend#1247','ShawnLiuSZ','fad-backend',1247,'t','u','open',"
            " 'assigned','todo',?, 'main', '')",
            (account_id,),
        )
        c.commit()
        c.close()
        result = S.tool_set_work_branch("fad-backend#1247", "feature/issue-279-fix")
        self.assertTrue(result["ok"])
        self.assertEqual(result["work_branch"], "feature/issue-279-fix")
        self.assertFalse(result["pulled"])
        row = dict(
            S.conn()
            .execute(
                "SELECT branch, work_branch FROM tasks WHERE issue_key='fad-backend#1247'"
            )
            .fetchone()
        )
        # PR 自动拉的 branch 不被触碰
        self.assertEqual(row["branch"], "main")
        self.assertEqual(row["work_branch"], "feature/issue-279-fix")

    def test_set_work_branch_errors_on_missing_issue(self):
        # 无账号 → 直接 unavailable，不发网络请求；错误文案带「无法从 GitHub 拉取」。
        with self.assertRaises(ValueError) as ctx:
            S.tool_set_work_branch("nope#999", "feature/x")
        self.assertIn("无法从 GitHub 拉取", str(ctx.exception))

    def test_set_work_branch_rejects_empty_branch(self):
        account_id = self._add_account()
        c = sqlite3.connect(_DB)
        c.execute(
            "INSERT INTO tasks (issue_key, owner, repo, number, title, url, issue_state,"
            " ownership, status, account_id, work_branch)"
            " VALUES ('fad-backend#1247','ShawnLiuSZ','fad-backend',1247,'t','u','open',"
            " 'assigned','todo',?, '')",
            (account_id,),
        )
        c.commit()
        c.close()
        with self.assertRaises(ValueError) as ctx:
            S.tool_set_work_branch("fad-backend#1247", "   ")
        self.assertIn("branch 不能为空", str(ctx.exception))


if __name__ == "__main__":
    unittest.main()
