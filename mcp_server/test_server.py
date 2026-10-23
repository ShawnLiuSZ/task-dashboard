"""server.py 的单测（标准库 unittest，零依赖）。

覆盖 v0.4.1 (#250)「本地未命中时按需拉取单个 issue」的纯逻辑部分：
引用解析（保留 owner）、账号选择（无账号 / org 不匹配 / 默认账号 / 无 PAT）、
字段映射（ownership / label 映射 / ISO→Unix 秒）、以及两条**不发网络请求**的契约。

网络层（`_fetch_issue`）在这些用例里一律被替换 —— 真实 HTTP 不在单测范围，
与 Rust 侧一致（那边同样只测纯逻辑与「不发请求」契约）。

运行：
    python3 -m unittest discover -s mcp_server -p 'test_*.py' -v
"""

import io
import json
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
  work_dir TEXT DEFAULT '',
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
        # #467：补建 `task_prs` 等表（Python MCP 走自己的 `ensure_schema`，
        # 不走 Rust 的 `open_db`）⇒ setUp 里才能安全地 `DELETE FROM task_prs`。
        # 放在 `executescript(SCHEMA)` **之后**：SCHEMA 里的建表语句没有
        # IF NOT EXISTS，先建再 ensure_schema 会撞「table accounts already exists」。
        S.ensure_schema(c)
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
            # #467：多 PR 关系表也要一起清 —— 否则残留行会被后续用例的
            # `tool_list_my_tasks` 读到，表现为「凭空多出 PR 关联」。
            "DELETE FROM task_prs;"
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

    # ── 引用解析：形态覆盖（#385）────────────────────────────────────────
    def test_parse_url_forms_guarded(self):
        """URL 分支的四种形态逐条锁定。

        审计实测：`(?:issues|pull)` 退化为 `(?:issues)` 时，**整个测试套件无任何
        报错**——`/pull/{n}` 链接会突然抛「无法解析 issue 引用」，而这看起来像
        「用户填错了引用」，不会有任何告警。

        Rust 侧 `on_demand.rs:459,485` 已有 `/pull/` 断言，Python 侧此前没有，
        两侧实现要求等价（AGENTS.md §8.6）却测试覆盖不对称——本例补齐。

        注：repo 名分隔符 `[^/#?]+` 放宽为 `[^/]+` 在**合法 URL 上是等价变异**
        （路径段本就不含 `?`/`#`），只有畸形 URL 才分歧，故不作为缺口计入。
        """
        # 1. PR 链接：GitHub 的 `/pull/{n}` 与 `/issues/{n}` 都必须接受
        p = S.parse_issue_ref_parts("https://github.com/acme/web/pull/42")
        self.assertEqual(
            (p["owner"], p["repo"], p["number"], p["key"]),
            ("acme", "web", 42, "web#42"),
        )
        # 2. repo 名不得吞掉 `?` / `#`（URL 常带查询串与锚点）
        for raw, num in [
            ("https://github.com/acme/web/issues/7?x=1", 7),
            ("https://github.com/acme/web/issues/7#issue-1", 7),
            ("https://github.com/acme/web/pull/8#issue-2", 8),
        ]:
            p = S.parse_issue_ref_parts(raw)
            self.assertEqual((p["repo"], p["number"]), ("web", num), raw)
        # 3. 省略 `issues|pull` 段的畸形 URL 应走 `#` 分支而不是误解析
        with self.assertRaises(ValueError):
            S.parse_issue_ref_parts("https://github.com/acme/web/7")

    def test_parse_repo_ref_edge_forms_guarded(self):
        """`repo#N` 形态的边界：尾斜杠、多 `#`、多余路径段。

        审计实测：`left.rstrip("/")` 写成 `left`（漏尾斜杠裁剪）、
        `rpartition` 写成 `split`（多 `#` 处理不同），**均无任何测试失败**。
        """
        # 尾斜杠：`owner/repo/#N` 必须与 `owner/repo#N` 等价
        a = S.parse_issue_ref_parts("acme/web/#123")
        b = S.parse_issue_ref_parts("acme/web#123")
        self.assertEqual(
            (a["owner"], a["repo"], a["number"], a["key"]),
            (b["owner"], b["repo"], b["number"], b["key"]),
            "尾斜杠不应改变解析结果",
        )
        # 多余路径段：只取最后一段作 repo
        p = S.parse_issue_ref_parts("a/b/c/web#7")
        self.assertEqual((p["repo"], p["key"]), ("web", "web#7"))
        # 多个 `#`：`rpartition` 取**最后一个** `#` 之后作编号。
        # 必须断言**具体错误消息**——只断言「抛 ValueError」判别力不足：
        # 把 `rpartition` 换成 `split`（`left, right = ref.split("#")`）同样抛
        # ValueError（unpack 时长不匹配），两种写法在测试眼里完全一样。
        with self.assertRaises(ValueError) as cm:
            S.parse_issue_ref_parts("a#b#c")
        self.assertIn("编号非法", str(cm.exception))
        # `owner/repo#abc` 同理：编号段非法而非「无法解析引用」
        with self.assertRaises(ValueError) as cm:
            S.parse_issue_ref_parts("acme/web#abc")
        self.assertIn("编号非法", str(cm.exception))

        # 空引用：必须断言**专属消息**。
        # 同样原因——删掉 `if not ref` 守卫后，空串会落到末尾的「无法解析 issue 引用」
        # 分支，仍抛 ValueError，只断言异常类型则测不出差异。
        for bad in ["", "   ", None]:
            with self.assertRaises(ValueError) as cm:
                S.parse_issue_ref_parts(bad)
            self.assertIn("引用为空", str(cm.exception), f"{bad!r} 应报「issue 引用为空」")

    # ── 纯函数 ───────────────────────────────────────────────────────────
    def test_iso_to_secs(self):
        self.assertEqual(S._iso_to_secs("2026-09-15T02:26:31Z"), 1789439191)
        self.assertEqual(S._iso_to_secs(""), 0)
        self.assertEqual(S._iso_to_secs("not-a-date"), 0)

    # ── 双实现对照（#387）────────────────────────────────────────────────
    def test_iso_to_secs_matches_rust_on_agreed_domain(self):
        """读**共享 fixture**，与 Rust 侧读同一份表（`fixtures/iso_parity.json`）。

        #387：`server.py::_iso_to_secs` 的 docstring 声称「对齐 Rust
        `iso8601_to_secs`」，但实测 4 处不一致 —— 其中 `1969-01-01` 曾让 Python
        返回**负数** `-31536000` 而 Rust 返回 `0`（已修）。

        为什么不各写一份表：#155（`tasks.key` → `issue_key` 改名只改一侧）说明
        两侧副本必然漂移，且 CI 兜不住（`server.py` 不参与 Tauri 构建）。
        共享 fixture 让漂移在**任一侧测试**里立刻暴露。
        """
        with open(os.path.join(os.path.dirname(__file__), "fixtures", "iso_parity.json"),
                  encoding="utf-8") as f:
            data = json.load(f)
        self.assertGreaterEqual(len(data["must_agree"]), 20, "对照表过小，可能被误删")
        for row in data["must_agree"]:
            self.assertEqual(
                S._iso_to_secs(row["input"]), row["secs"],
                f"{row['input']!r}：两侧应一致",
            )

    def test_iso_to_secs_known_divergence_locked(self):
        """锁定 3 处**已知分歧**，避免有人只改一侧而不自知。

        三处都是 Python 侧更严格、且严格方向都是「无时间 = 0」（失败关闭），
        故保持现状；若将来两侧对齐，这三条必须同步更新。
        """
        with open(os.path.join(os.path.dirname(__file__), "fixtures", "iso_parity.json"),
                  encoding="utf-8") as f:
            data = json.load(f)
        self.assertGreaterEqual(len(data["known_divergence"]), 1)
        for row in data["known_divergence"]:
            self.assertEqual(
                S._iso_to_secs(row["input"]), row["python"],
                f"{row['input']!r}：Python 侧行为已变更，须确认是有意为之"
                      f"（原分歧原因：{row['note']}）",
            )

    def test_iso_to_secs_never_returns_negative(self):
        """1970 前必须折成 0（#387 的真实缺陷）。

        原实现直接返回 `calendar.timegm(...)`，`1969-01-01` 得到 `-31536000`，
        会作为 `created_at` / `updated_at` 落库 —— 同一 issue 被两条路径先后写入
        时值取决于谁最后动手，且下游「相对时间」展示遇到负值会显示荒谬文案。
        """
        for raw in ["1969-01-01T00:00:00Z", "1900-06-15T12:00:00Z", "0001-01-01T00:00:00Z"]:
            self.assertEqual(S._iso_to_secs(raw), 0, f"{raw!r} 应折成 0")
        # 更广的不变式：任何输入都不得产出负数
        for raw in ["1969-01-01T00:00:00Z", "1960-02-29T00:00:00Z", "1-01-01T00:00:00Z"]:
            self.assertGreaterEqual(S._iso_to_secs(raw), 0)

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


class EnsureSchemaTest(unittest.TestCase):
    """#329：`ensure_schema` 必须补齐 `SELECT_COLS` 的每一列，并对旧布局明确报错。

    这条路径只在「Python MCP 首次打开一个尚未被 App 迁移过的库」时才走到，App 自身
    与既有 fixture 都覆盖不到 —— 所以用临时库单独构造。
    """

    @staticmethod
    def _select_cols():
        return [c.strip() for c in S.SELECT_COLS.replace(" ", "").split(",") if c.strip()]

    @staticmethod
    def _tmp_conn():
        path = os.path.join(tempfile.mkdtemp(prefix="tb-mcp-es-"), "t.db")
        return sqlite3.connect(path)

    def test_completes_every_select_col(self):
        # 模拟「App 只迁移到 v0.3.16」的库：已有 issue_key，但缺 assignees /
        # mentioned / latest_comment_url / pr_number / pr_url / work_dir / created_at
        # 这些后加的列。原实现只 ALTER 10 列，这些列会以 no such column 炸掉读路径。
        c = self._tmp_conn()
        c.execute(
            "CREATE TABLE tasks ("
            "issue_key TEXT, owner TEXT, repo TEXT, number INTEGER,"
            "title TEXT, url TEXT, issue_state TEXT, ownership TEXT, status TEXT,"
            "project_status TEXT, branch TEXT, session_id TEXT, session_agent TEXT,"
            "session_at INTEGER, handoff TEXT, candidate_done INTEGER,"
            "account_id INTEGER, updated_at INTEGER, synced_at INTEGER)"
        )
        before = S.table_columns(c, "tasks")
        missing_before = [x for x in self._select_cols() if x not in before]
        self.assertTrue(missing_before, "用例前提：起始库应确实缺列")
        S.ensure_schema(c)
        after = S.table_columns(c, "tasks")
        missing = [x for x in self._select_cols() if x not in after]
        self.assertEqual(missing, [], f"ensure_schema 后仍缺 SELECT_COLS 的列: {missing}")
        # 幂等：再跑一次不应报错、也不改变列集合。
        S.ensure_schema(c)
        self.assertEqual(S.table_columns(c, "tasks"), after)
        c.close()

    def test_ensure_columns_covers_enough_for_ci_check(self):
        # 与 scripts/check-mcp-columns.py 的第 5 条断言同源：清单必须 ⊇ SELECT_COLS。
        ensured = {name for name, _ in S.ENSURE_COLUMNS}
        self.assertEqual([x for x in self._select_cols() if x not in ensured], [])

    def test_legacy_layout_is_rejected_with_actionable_message(self):
        c = self._tmp_conn()
        c.execute("CREATE TABLE tasks (key TEXT PRIMARY KEY, gh_state TEXT, issue_key TEXT)")
        with self.assertRaises(RuntimeError) as ctx:
            S.ensure_schema(c)
        msg = str(ctx.exception)
        self.assertIn("v0.3.50", msg)
        self.assertIn("请先启动一次 TaskBoard App", msg)
        c.close()

    def test_missing_tasks_table_is_rejected(self):
        c = sqlite3.connect(":memory:")
        with self.assertRaises(RuntimeError) as ctx:
            S.ensure_schema(c)
        self.assertIn("`tasks` 表", str(ctx.exception))
        c.close()


class IssueStateCaseTest(unittest.TestCase):
    """#335：`issue_state` 大小写归一化与 `closed` 判定口径。

    背景：`tasks.issue_state` 由两个来源写入 —— REST 给小写 `open`/`closed`，
    GraphQL（ProjectV2 条目查询）给大写 `OPEN`/`CLOSED`；而早期判据写死小写，
    导致 Project 来源的已关闭 issue 滞留看板。Rust 与 Python 两侧必须同语义
    （AGENTS.md §8.6），故两侧各有对应用例。
    """

    def test_normalize_folds_graphql_uppercase(self):
        self.assertEqual(S.normalize_issue_state("CLOSED"), "closed")
        self.assertEqual(S.normalize_issue_state("OPEN"), "open")
        # REST 口径原样通过
        self.assertEqual(S.normalize_issue_state("closed"), "closed")
        # 空白容忍
        self.assertEqual(S.normalize_issue_state("  CLOSED  "), "closed")
        # 空 / None 不得抛异常
        self.assertEqual(S.normalize_issue_state(""), "")
        self.assertEqual(S.normalize_issue_state(None), "")

    def test_is_closed_state_is_case_insensitive(self):
        """反向验证：把实现改回 `raw == "closed"` 时前三条必然失败。"""
        self.assertTrue(S.is_closed_state("CLOSED"))
        self.assertTrue(S.is_closed_state("Closed"))
        self.assertTrue(S.is_closed_state("  closed  "))
        # 非关闭态不得误判
        self.assertFalse(S.is_closed_state("OPEN"))
        self.assertFalse(S.is_closed_state("open"))
        self.assertFalse(S.is_closed_state(""))
        self.assertFalse(S.is_closed_state(None))
        # 不得退化成前缀 / 子串匹配
        self.assertFalse(S.is_closed_state("closed_by_bot"))
        self.assertFalse(S.is_closed_state("unclosed"))

    def test_row_from_issue_maps_uppercase_closed_to_done(self):
        """GraphQL 大写 `CLOSED` 的行必须落成 done，且 issue_state 折成小写。

        构造的 payload **不带 labels** ⇒ 不触发 `_resolve_label_status`，
        因而本用例无需数据库、也不发网络请求。
        """
        account = {"id": 1, "login": "alice", "org": "Acme"}
        payload = {
            "number": 7,
            "title": "t",
            "html_url": "https://github.com/Acme/r/issues/7",
            "state": "CLOSED",
            "assignees": [],
            "labels": [],
            "comments": 0,
            "updated_at": "2026-09-01T00:00:00Z",
            "created_at": "2026-08-01T00:00:00Z",
        }
        row = S._row_from_issue(payload, "r", "r#7", account, 1000)
        self.assertEqual(row["status"], "done")
        self.assertEqual(row["issue_state"], "closed")
        self.assertEqual(row["done_at"], 1000)

        # 对照：小写 closed 行为逐字一致（原实现只认这一种）
        payload_open_lower = dict(payload, state="closed")
        row2 = S._row_from_issue(payload_open_lower, "r", "r#7", account, 1000)
        self.assertEqual(row2["status"], row["status"])
        self.assertEqual(row2["issue_state"], row["issue_state"])

        # 非关闭态：无 label 命中 ⇒ todo，且状态不折进 done
        payload_open = dict(payload, state="OPEN")
        row3 = S._row_from_issue(payload_open, "r", "r#7", account, 1000)
        self.assertEqual(row3["status"], "todo")
        self.assertEqual(row3["issue_state"], "open")
        self.assertEqual(row3["done_at"], 0)

    def test_row_from_issue_writes_created_at(self):
        """#438：按需拉取必须写 created_at —— 此前 `TASK_INSERT_COLS` 漏该列，
        经 Python MCP 拉的 issue 落库恒为 0（epoch），与 Rust `build_task_row`
        双实现漂移。漏写时 row 里没有该键 → `row["created_at"]` KeyError；
        即便补了键但值恒 0，也被下面断言抓住。
        """
        account = {"id": 1, "login": "alice", "org": "Acme"}
        base = {
            "number": 7,
            "title": "t",
            "html_url": "https://github.com/Acme/r/issues/7",
            "state": "OPEN",
            "assignees": [],
            "labels": [],
            "comments": 0,
            "updated_at": "2026-09-01T00:00:00Z",
            "created_at": "2026-08-01T00:00:00Z",
        }
        row = S._row_from_issue(base, "r", "r#7", account, 1000)
        # 期望值由 Python 标准库独立算得（非用被测函数自证）。
        self.assertEqual(row["created_at"], 1785542400)
        self.assertNotEqual(row["created_at"], 0, "created_at 不得恒 0")
        # 缺失 created_at 时安全降级为 0（_iso_to_secs 对 None/空安全）。
        row_no = S._row_from_issue(
            {k: v for k, v in base.items() if k != "created_at"}, "r", "r#7", account, 1000
        )
        self.assertEqual(row_no["created_at"], 0)
        # 写列清单必须含 created_at（漏了则整条不落库）。
        self.assertIn("created_at", S.TASK_INSERT_COLS)


class FramingTests(unittest.TestCase):
    """#345：stdio 分帧健壮性——畸形帧不得终止进程。

    #328 只修了 Rust 侧（`mcp::ReadOutcome` 四态），Python 兜底实现当时仍用
    `(None, None)` 同时表示「EOF」与「畸形」，主循环见 `None` 即 `break` ⇒
    一行坏 JSON / 一个坏 Content-Length body / 一个超大声明就整个进程退出，
    agent 侧表现为随机 `connection closed`（与 Rust 侧修掉的症状完全一致）。

    这些用例直接驱动真实的 `read_message`，不 mock。
    """

    def _read_all(self, payload):
        """喂入字节流，返回连续读出的所有 outcome（直到 EOF / FATAL）。"""
        stream = io.BytesIO(payload)
        out = []
        # 上限保护：正常输入下不会触发
        for _ in range(50):
            oc = S.read_message(stream)
            out.append(oc)
            if oc.kind in (S.ReadOutcome.EOF, S.ReadOutcome.FATAL):
                break
        return out

    def test_valid_ndjson_still_reads(self):
        """正常 NDJSON 不得被回归。"""
        body = b'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n'
        outs = self._read_all(body)
        self.assertEqual(outs[0].kind, S.ReadOutcome.MSG)
        self.assertEqual(outs[0].msg["id"], 1)
        self.assertEqual(outs[0].framing, S.NDJSON)
        self.assertEqual(outs[-1].kind, S.ReadOutcome.EOF)

    def test_valid_content_length_still_reads(self):
        """正常 Content-Length 分帧不得被回归。"""
        payload = json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list"}).encode()
        frame = b"Content-Length: " + str(len(payload)).encode() + b"\r\n\r\n" + payload
        outs = self._read_all(frame)
        self.assertEqual(outs[0].kind, S.ReadOutcome.MSG)
        self.assertEqual(outs[0].msg["id"], 2)
        self.assertEqual(outs[0].framing, S.CONTENT_LENGTH)

    def test_malformed_ndjson_then_valid_is_continued(self):
        """核心回归：`{` 开头但 JSON 畸形的行，丢弃后仍必须能读到下一条合法消息。

        典型场景：客户端写入被截断（写到一半的半截 JSON）后紧接着又发了完整消息。
        旧实现把畸形与 EOF 折叠成 (None, None)，主循环直接 break ⇒ 进程退出。
        """
        payload = b'{"jsonrpc":"2.0","id":7\n' + b'{"jsonrpc":"2.0","id":8}\n'
        outs = self._read_all(payload)
        self.assertEqual(outs[0].kind, S.ReadOutcome.MALFORMED)
        self.assertEqual(outs[1].kind, S.ReadOutcome.MSG, "畸形行不应终止后续读取")
        self.assertEqual(outs[1].msg["id"], 8)
        self.assertEqual(outs[-1].kind, S.ReadOutcome.EOF)

    def test_framing_is_decided_by_first_char(self):
        """分帧判定口径（与 Rust 侧一致）：首个有效字符是 `{` 走 NDJSON，否则走头解析。

        非 `{` 开头的行（混入日志、BOM 等）会进入 Content-Length 头路径并最终 EOF ——
        这是**格式判定的既有设计**，两侧一致，本次不改；本用例把它钉住，
        避免后人误以为它属于「畸形帧」。
        """
        self.assertEqual(self._read_all(b"not json\n")[0].kind, S.ReadOutcome.EOF)
        self.assertEqual(
            self._read_all(b"\xef\xbb\xbf" + b'{"id":8}\n')[0].kind,
            S.ReadOutcome.EOF,
        )

    def test_malformed_content_length_body_then_valid_is_continued(self):
        """坏 CL body：body 已完整消费 ⇒ 丢弃后仍能继续。"""
        bad = b"{not json"
        good = json.dumps({"jsonrpc": "2.0", "id": 9}).encode()
        payload = (
            b"Content-Length: " + str(len(bad)).encode() + b"\r\n\r\n" + bad
            + b"Content-Length: " + str(len(good)).encode() + b"\r\n\r\n" + good
        )
        outs = self._read_all(payload)
        self.assertEqual(outs[0].kind, S.ReadOutcome.MALFORMED)
        self.assertEqual(outs[1].kind, S.ReadOutcome.MSG, "坏 body 不应终止后续读取")
        self.assertEqual(outs[1].msg["id"], 9)

    def test_missing_content_length_is_fatal(self):
        """头正常收尾但缺 Content-Length ⇒ **Fatal**（对齐 Rust #357）。

        #451：原断言是 MALFORMED + 继续读下一条，其 docstring 写「边界已知，
        跳过后可继续」—— 该推理是错的：缺 Content-Length 恰恰说明**正文长度未知**，
        流位置并未确定（头部结束处就是正文首字节）。按 Malformed 继续读，后续读取
        会把正文字节当头部解析，产出更多垃圾帧。
        """
        payload = b"X-Other: 1\r\n\r\n" + b'{"jsonrpc":"2.0","id":10}\n'
        outs = self._read_all(payload)
        self.assertEqual(outs[0].kind, S.ReadOutcome.FATAL)
        self.assertEqual(len(outs), 1, "Fatal 后不得再继续读（否则正文字节被当头部解析）")

    def test_unparseable_content_length_is_fatal(self):
        """Content-Length 存在但不可解析 ⇒ 与缺失同口径，同样 Fatal。

        与上一条同源：`int("12 34")` 失败 ⇒ 长度未知 ⇒ 流位置未确定。
        """
        payload = b"Content-Length: 12 34\r\n\r\n" + b"{\"jsonrpc\":\"2.0\",\"id\":11}\n"
        outs = self._read_all(payload)
        self.assertEqual(outs[0].kind, S.ReadOutcome.FATAL)
        self.assertEqual(len(outs), 1, "Fatal 后不得再继续读")

    def test_oversized_content_length_is_fatal(self):
        """超大声明 ⇒ Fatal（body 未消费，继续读只会错位）。"""
        payload = b"Content-Length: 99999999999\r\n\r\n"
        outs = self._read_all(payload)
        self.assertEqual(outs[0].kind, S.ReadOutcome.FATAL)
        self.assertEqual(len(outs), 1, "Fatal 后不得再继续读")

    def test_zero_content_length_is_fatal(self):
        outs = self._read_all(b"Content-Length: 0\r\n\r\n")
        self.assertEqual(outs[0].kind, S.ReadOutcome.FATAL)

    def test_truncated_body_is_eof(self):
        """body 被截断 ⇒ 流结束（而非畸形）。"""
        outs = self._read_all(b"Content-Length: 500\r\n\r\n" + b"{}")
        self.assertEqual(outs[0].kind, S.ReadOutcome.EOF)

    def test_header_at_stream_end_is_eof(self):
        """头写到流末尾就断了 ⇒ 是 EOF（流结束），与 Rust 侧 `Ok(0) → Eof` 一致。"""
        outs = self._read_all(b"Content-Length: 2\r\n")
        self.assertEqual(outs[0].kind, S.ReadOutcome.EOF)

    def test_header_over_limit_is_fatal(self):
        """头超过上限仍不终止 ⇒ 边界未知，Fatal。"""
        outs = self._read_all(b"X-Pad: " + b"a" * (S.MAX_FRAME_HEADER + 16) + b"\r\n")
        self.assertEqual(outs[0].kind, S.ReadOutcome.FATAL)

    def test_oversized_ndjson_line_is_fatal(self):
        """无终止符的超长 NDJSON 行 ⇒ Fatal（与 Rust 侧同一 DoS 类别）。"""
        outs = self._read_all(b"{" + b"a" * (S.MAX_FRAME_BODY + 10))
        self.assertEqual(outs[0].kind, S.ReadOutcome.FATAL)

    def test_ndjson_limit_is_enforced_incrementally(self):
        """#451：NDJSON 上限必须**边累积边判**，不能读完整行才判。

        这是本次修复的核心 —— 原实现先 `readline()` 把整行读进内存、之后才比对
        上限，对一条无终止符的长行等于「先把 GB 级数据吃进内存再报错」，
        上限只挡得住「已读完」的情况，挡不住资源耗尽。

        本用例用一个**按需供给**的流：只有当读取方真的逐字节来取时才给数据。
        若实现退化成 `readline()`（一次 readline 就要走完整个流），计数会显示
        「在超限判定前就把全部数据读完了」⇒ 断言失败。

        反之，若实现是逐字节累积并在超限时**立即返回**，则它绝不该读到超限
        之后的数据 —— `self.served <= S.MAX_FRAME_BODY + 余量` 即为证据。
        """

        class _CountingStream:
            """按 1 字节供给数据，并记录「被读走多少」与「被请求多少次」。"""

            def __init__(self, total):
                self._buf = bytearray(b"{" + b"a" * total)
                self.served = 0
                self.read_calls = 0

            def read(self, n):
                self.read_calls += 1
                if n is None or n < 0:
                    chunk = bytes(self._buf[self.served:])
                    self.served = len(self._buf)
                    return chunk
                chunk = bytes(self._buf[self.served:self.served + n])
                self.served += len(chunk)
                return chunk

            def readline(self, *a, **kw):
                """模拟退化路径：一次性把剩余全部返回（即原实现的readline）。"""
                self.read_calls += 1
                chunk = bytes(self._buf[self.served:])
                self.served = len(self._buf)
                return chunk

        total = S.MAX_FRAME_BODY + 4096
        stream = _CountingStream(total)
        oc = S.read_message(stream)

        self.assertEqual(oc.kind, S.ReadOutcome.FATAL)
        # ⚠️ 核心断言：判定超限时**不该**已读走超过上限的数据量。
        # 退化实现会把整个 total 全部读走（≈ 上限 + 4096）才返回；
        # 增量实现最多读到「上限 + 1 字节」就停。
        self.assertLessEqual(
            stream.served,
            S.MAX_FRAME_BODY + 1,
            "必须在累积过程中就判定超限，不能读完整个长行再判"
            f"（实际已读 {stream.served} 字节）",
        )

    def test_empty_stream_is_eof(self):
        outs = self._read_all(b"")
        self.assertEqual(outs[0].kind, S.ReadOutcome.EOF)

    def test_main_keeps_serving_after_malformed_frame(self):
        """端到端：畸形帧之后 `main()` **必须继续服务**，而不是退出进程。

        #345 的核心症状是「进程退出」，而那由 `main()` 的循环决定、不是
        `read_message` 的分类决定。只测分类会漏掉「分类对了但循环仍然 break」
        这种半修状态，故这里直接驱动 `main()`（桩掉 stdin/stdout，不触网）。
        """
        payload = b'{"jsonrpc":"2.0","id":1\n' + b'{"jsonrpc":"2.0","id":2}\n'
        responses = self._run_main(payload)
        # 第 1 条畸形 → 无响应；第 2 条合法 → 必须有响应
        self.assertEqual(
            len(responses), 1, "畸形帧后仍应处理后续合法消息，实际收到 %d 条响应" % len(responses)
        )
        self.assertEqual(responses[0].get("id"), 2)

    def test_main_survives_repeated_malformed_frames(self):
        """连续多条畸形帧也不得终止（真实客户端偶发脏数据很常见）。"""
        payload = b"{bad1\n{bad2\n" + b'{"jsonrpc":"2.0","id":3}\n'
        responses = self._run_main(payload)
        self.assertEqual(len(responses), 1)
        self.assertEqual(responses[0].get("id"), 3)

    def test_main_malformed_only_still_exits_cleanly(self):
        """全是畸形帧时最终退出，且不产生任何响应（不写垃圾）。"""
        self.assertEqual(self._run_main(b"{bad\n{bad2\n"), [])

    def _run_main(self, payload):
        """用字节流驱动 `main()`，返回它写出的响应消息列表。"""
        out = io.BytesIO()

        class _Stdin:
            buffer = io.BytesIO(payload)

        class _Stdout:
            buffer = out

        real_stdin, real_stdout, real_argv = sys.stdin, sys.stdout, sys.argv
        sys.stdin, sys.stdout = _Stdin(), _Stdout()  # type: ignore[assignment]
        sys.argv = ["server.py"]
        try:
            S.main()
        finally:
            sys.stdin, sys.stdout, sys.argv = real_stdin, real_stdout, real_argv
        chunks = [c for c in out.getvalue().split(b"\n") if c.strip()]
        return [json.loads(c.decode()) for c in chunks]


class AttachPrsTest(unittest.TestCase):
    """#467 后续修复：`_attach_prs` 的「主 PR 置首」语义（与 Rust 侧同一口径）。

    ⚠️ 本组用例补的是**此前完全无覆盖**的一段：Python MCP 侧的 `_attach_prs`
    没有任何单测 ⇒ 双实现口径漂移（AGENTS.md §8.6 要求两实现一致）无人守
    —— 与 #169/#262/#278 同源的盲区。

    场景与断言与 Rust 侧 `commands.rs::attach_task_prs` / `mcp.rs::attach_prs`
    的用例**一一对应**（同一组场景、同一组期望值）。
    """

    @classmethod
    def setUpClass(cls):
        # ⚠️ 本组用例**必须用独立的临时库**：`_attach_prs` 走 `conn()`，而
        # `conn()` 会调 `ensure_schema`（建 accounts / task_prs 等表）⇒ 若共用
        # `_DB`，本类先跑（unittest 按类名字母序）就会把 `accounts` 建出来，
        # 随后 `OnDemandTest.setUpClass` 的 `executescript(SCHEMA)`（无
        # IF NOT EXISTS）必然报「table accounts already exists」。
        # ⇒ 改为每个用例一份独立库 + 临时改写 `S.DB_PATH`（`conn()` 运行时
        # 才读模块全局 ⇒ 改写有效）。
        pass

    @staticmethod
    def _reset_conn():
        if S._conn is not None:
            S._conn.close()
        S._conn = None

    def setUp(self):
        self._tmpdir = tempfile.mkdtemp(prefix="tb-mcp-prs-")
        self._db = os.path.join(self._tmpdir, "taskboard.db")
        self._orig_db_path = S.DB_PATH
        S.DB_PATH = self._db
        self._reset_conn()
        c = sqlite3.connect(self._db)
        c.executescript(SCHEMA)
        # 建出 `task_prs`（与生产同款：Python MCP 走自己的 `ensure_schema`，
        # 不走 Rust 的 `open_db` —— 这正是 #467 的关键点）。
        S.ensure_schema(c)
        c.commit()
        c.close()

    def tearDown(self):
        self._reset_conn()
        S.DB_PATH = self._orig_db_path
        import shutil

        shutil.rmtree(self._tmpdir, ignore_errors=True)

    def _insert_task(self, issue_key, number, account_id, pr_number, pr_url):
        c = sqlite3.connect(self._db)
        c.execute(
            "INSERT INTO tasks (issue_key, owner, repo, number, title, url, issue_state,"
            " ownership, status, synced_at, account_id, pr_number, pr_url)"
            " VALUES (?, 'o', 'r', ?, 't', 'u', 'open', 'assigned', 'todo', 1, ?, ?, ?)",
            (issue_key, number, account_id, pr_number, pr_url),
        )
        c.commit()
        c.close()

    def _insert_task_prs(self, account_id, issue_key, rows):
        c = sqlite3.connect(self._db)
        for num, url, state in rows:
            c.execute(
                "INSERT INTO task_prs (account_id, issue_key, pr_number, pr_url, pr_state,"
                " updated_at) VALUES (?, ?, ?, ?, ?, 0)",
                (account_id, issue_key, num, url, state),
            )
        c.commit()
        c.close()

    @staticmethod
    def _row(issue_key, account_id, pr_number, pr_url):
        """模拟 `rows_to_dicts` 产出的行（`_attach_prs` 的输入形态）。"""
        return {
            "issue_key": issue_key,
            "account_id": account_id,
            "pr_number": pr_number,
            "pr_url": pr_url,
            "pr_state": "merged",
        }

    def test_primary_pr_is_promoted_to_head(self):
        """主 PR 必须被提到 `prs[0]`（`task_prs` 按 pr_number ASC 读，主 PR 未必最小）。"""
        self._insert_task("o/r#10", 10, 1, 101, "u101")
        self._insert_task_prs(1, "o/r#10", [(100, "u100", "open"), (101, "u101", "merged")])

        rows = S._attach_prs([self._row("o/r#10", 1, 101, "u101")])
        prs = rows[0]["prs"]
        self.assertEqual(len(prs), 2, "两个关联 PR 都必须在")
        self.assertEqual(prs[0]["number"], 101, "prs[0] 必须是主 PR（修复前是 100）")
        self.assertEqual(prs[0]["url"], "u101", "主 PR 必须按 (number, url) 组合匹配")
        self.assertEqual(prs[1]["number"], 100, "其余元素相对顺序保持 pr_number ASC")

    def test_falls_back_to_primary_when_task_prs_is_empty(self):
        """存量行（`task_prs` 为空）必须回退到主 PR，否则 PR 徽章消失。"""
        self._insert_task("o/r#10", 10, 1, 42, "u42")
        rows = S._attach_prs([self._row("o/r#10", 1, 42, "u42")])
        prs = rows[0]["prs"]
        self.assertEqual(len(prs), 1, "存量行必须回退成主 PR 一条")
        self.assertEqual(prs[0]["number"], 42)
        self.assertEqual(prs[0]["url"], "u42")

    def test_accounts_are_isolated(self):
        """同一 `issue_key` 在两个账号下各有 PR 关联 ⇒ 不得串号。"""
        self._insert_task("o/r#10", 10, 1, 101, "u101")
        self._insert_task("o/r#10", 10, 2, 201, "u201")
        self._insert_task_prs(1, "o/r#10", [(101, "u101", "merged")])
        self._insert_task_prs(2, "o/r#10", [(201, "u201", "merged")])

        rows = S._attach_prs(
            [self._row("o/r#10", 1, 101, "u101"), self._row("o/r#10", 2, 201, "u201")]
        )
        self.assertEqual(len(rows[0]["prs"]), 1)
        self.assertEqual(rows[0]["prs"][0]["number"], 101, "账号 1 不得看到账号 2 的 PR")
        self.assertEqual(rows[1]["prs"][0]["number"], 201, "账号 2 不得看到账号 1 的 PR")

    def test_same_number_different_url_is_not_matched(self):
        """**同号不同 URL**（跨仓库撞号）不得误匹配。"""
        self._insert_task("o/r#10", 10, 1, 101, "u101")
        self._insert_task_prs(
            1,
            "o/r#10",
            [
                (101, "https://github.com/other/repo/pull/101", "open"),
                (101, "u101", "merged"),
            ],
        )
        rows = S._attach_prs([self._row("o/r#10", 1, 101, "u101")])
        self.assertEqual(
            rows[0]["prs"][0]["url"],
            "u101",
            "必须按 (number, url) 组合匹配 —— 只按 number 会取到另一仓库的同号 PR",
        )

    def test_sort_helper_is_noop_when_primary_unknown(self):
        """主 PR 未知 ⇒ 顺序不变、不得凭空插入元素。"""
        prs = [{"number": 100, "url": "u100"}, {"number": 102, "url": "u102"}]
        S._sort_prs_primary_first(prs, 0, "u100")
        S._sort_prs_primary_first(prs, 100, "")
        self.assertEqual(
            [p["number"] for p in prs], [100, 102], "主 PR 未知时必须是空操作"
        )

    def test_sort_helper_preserves_relative_order(self):
        """主 PR 提到首位时，其余元素的相对顺序保持不变。"""
        prs = [
            {"number": 100, "url": "u100"},
            {"number": 102, "url": "u102"},
            {"number": 101, "url": "u101"},
        ]
        S._sort_prs_primary_first(prs, 101, "u101")
        self.assertEqual(
            [p["number"] for p in prs],
            [101, 100, 102],
            "主 PR 提到首位，其余元素相对顺序不变",
        )


if __name__ == "__main__":
    unittest.main()
