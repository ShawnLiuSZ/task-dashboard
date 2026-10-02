#!/usr/bin/env python3
"""TaskBoard MCP server — stdio transport, JSON-RPC 2.0, standard-library only.

Lets an AI agent (claude-code / codex / WorkBuddy / Cursor / doubao …) read and
update the **local TaskBoard SQLite** database that the Tauri macOS app maintains.

Why this exists (PRD §6 adaptation)
-----------------------------------
The PRD's original MCP design (§6) assumed writing session/status into GitHub
Project v2 custom fields. The shipped app pivoted to a **fully local** model:
everything lives in local SQLite and **never writes back to GitHub**. So this
server targets the SQLite file directly (zero GitHub calls). It is the local
equivalent of the PRD's `record_session` / `update_task_status` / `list_my_tasks`
/ `get_task_status` / `clear_session` tools.

Tools
-----
- list_my_tasks(status?, ownership?)      -> 任务列表（可按状态/归属过滤）
- get_task_status(issue)                 -> 单个任务当前状态 + 已记录的 session/handoff
- update_task_status(issue, status)      -> 改本地看板状态（不碰 GitHub）
- record_session(issue, session_id, agent?) -> 记录中断会话 id（不碰 GitHub）
- record_handoff(issue, text)            -> 记录交接任务详情（不碰 GitHub）
- clear_session(issue)                   -> 任务完成后清空 session 字段
- set_work_branch(issue, branch)         -> #279：创建 / 切换分支后纠正 work_branch

`issue` 接受多种格式：
- `repo#number`            e.g. `fad-backend#1234`
- `owner/repo#number`      e.g. `FoodsUp-Inc/fad-backend#1234`
- GitHub URL               e.g. `https://github.com/FoodsUp-Inc/fad-backend/issues/1234`

数据库路径：默认 `~/Library/Application Support/com.shawnliu.taskboard/taskboard.db`，
可用环境变量 `TASKBOARD_DB` 覆盖。
"""

import calendar
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request

DB_PATH = os.environ.get(
    "TASKBOARD_DB",
    os.path.expanduser(
        "~/Library/Application Support/com.shawnliu.taskboard/taskboard.db"
    ),
)

STATUS_KEYS = {"todo", "doing", "processed", "done"}
STATUS_CN = {
    "待处理": "todo",
    "处理中": "doing",
    "已处理": "processed",
    "已完成": "done",
}

# 列名（与 Tauri 后端 db.rs::SCHEMA 的 tasks 表保持一致）
#
# v0.3.53 (#169)：#155 把 tasks.key 改名为 issue_key 后这里没跟上，Python MCP 的
# 读路径（`list_my_tasks` / `get_task_status`）直接报 "no such column: key" 而整体
# 失效。此清单现由 CI 兜底：`scripts/check-mcp-columns.py` 会拿它与 db.rs 的真实
# schema 比对，列名写错在 PR 阶段就失败。
#
# 同一份列清单必须与 Rust 侧 `app/src-tauri/src/mcp.rs::SELECT_COLS` 完全一致，
# 否则两个 MCP 实现返回给 agent 的字段会不一样。
# v0.3.53 (#169)：完整列出 db.rs::SCHEMA 真实列；#171：work_branch 为 agent 工作分支。
# #278：parent_issue / sub_issues 为 GitHub 父子关系（存 JSON 串，空串表示无关联）。
# MCP 不做二次解析——agent 直接读 JSON，两个 MCP 实现语义一致。
SELECT_COLS = (
    "issue_key, owner, repo, number, title, url, issue_state, ownership, "
    "status, project_status, assignees, mentioned, latest_comment_url, "
    "pr_number, pr_url, branch, work_branch, work_dir, session_id, session_agent, "
    "session_at, handoff, candidate_done, account_id, updated_at, "
    "parent_issue, sub_issues, created_at"
)


# --------------------------------------------------------------------------- #
# 参数解析与状态映射
# --------------------------------------------------------------------------- #
def resolve_status(s):
    if s is None:
        return None
    s = str(s).strip()
    if s in STATUS_KEYS:
        return s
    return STATUS_CN.get(s)


def parse_issue_ref_parts(ref):
    """解析 issue 引用，**保留 owner**（v0.4.1 / #250）。

    与 Rust `on_demand::parse_issue_ref_parts` 同义：按需拉取单个 issue 需要
    `owner` + `repo` 才能定位资源，而主键只有 `repo#number`。

    返回 `{"owner": str|None, "repo": str, "number": int, "key": str}`。
    """
    ref = (ref or "").strip()
    if not ref:
        raise ValueError("issue 引用为空")
    # URL 形式：https://github.com/{owner}/{repo}/issues/{n}（也接受 /pull/{n}）
    m = re.search(r"github\.com/([^/]+)/([^/#?]+)/(?:issues|pull)/(\d+)", ref)
    if m:
        owner, repo, num = m.group(1), m.group(2), int(m.group(3))
        return {
            "owner": owner or None,
            "repo": repo,
            "number": num,
            "key": f"{repo}#{num}",
        }
    # repo#number 或 owner/repo#number
    if "#" in ref:
        left, _, right = ref.rpartition("#")
        try:
            num = int(right)
        except ValueError:
            raise ValueError(f"issue 编号非法: {right!r}")
        if num <= 0:
            raise ValueError("issue 编号必须 > 0")
        repo = left.rstrip("/").split("/")[-1]
        if not repo:
            raise ValueError(f"无法从引用解析仓库名: {ref!r}")
        # owner 只在写全了 `owner/repo#N` 时才采信；否则留给账号的 org 兜底。
        owner = left.rstrip("/").rsplit("/", 1)[0].strip() if "/" in left.rstrip("/") else None
        return {"owner": owner or None, "repo": repo, "number": num, "key": f"{repo}#{num}"}
    raise ValueError(f"无法解析 issue 引用: {ref!r}")


def parse_issue_ref(ref):
    """把多种 issue 引用归一化为本库的任务业务引用 `issue_key`（`repo#number`）。"""
    return parse_issue_ref_parts(ref)["key"]


# --------------------------------------------------------------------------- #
# SQLite 访问（单连接，顺序处理；设置 busy_timeout 以兼容 Tauri 进程并发占用）
# --------------------------------------------------------------------------- #
_conn = None


def table_columns(c, name):
    """返回 `name` 表的列名集合；表不存在（或 PRAGMA 不可用）返回 `None`。"""
    try:
        rows = c.execute(f"PRAGMA table_info({name})").fetchall()
    except sqlite3.OperationalError:
        return None
    if not rows:
        return None
    # row_factory 可能是 sqlite3.Row，索引访问仍可用。
    return {r[1] for r in rows}


# #329：`ensure_schema` 必须能补齐**每一个**被读写的列。
#
# 历史教训（#169 -> #262 -> #278）：给 `SELECT_COLS` 加了列却忘了在这里补 ALTER，
# 症状只出现在「Python MCP 首次打开一个尚未被 App 迁移过的旧库」这一条路径上
# （`no such column: xxx`），App 本身完全正常、`pytest`/`cargo test` 也测不到。
# 本清单现在由 `scripts/check-mcp-columns.py` 断言「⊇ SELECT_COLS 的全部列」，
# 以后再往 SELECT_COLS 加列而漏改这里，PR 阶段就会红。
#
# 包含 SELECT_COLS 生成前就存在的核心列（issue_key/owner/repo/...）并无实际作用
# ——它们在任何真实库里都存在，ALTER 会以「duplicate column」被忽略。列在这里是为了
# 让「清单完备性」变成一条可机械校验的约束，而不是靠人记。
#
# 注意：**不能**靠这里完成 v0.3.50 的物理重建（key→issue_key、gh_state→issue_state）。
# 那种历史布局由 `ensure_schema` 开头的探测直接拒绝，要求先启动一次 App。
ENSURE_COLUMNS = (
    ("issue_key", "TEXT NOT NULL DEFAULT ''"),
    ("owner", "TEXT NOT NULL DEFAULT ''"),
    ("repo", "TEXT NOT NULL DEFAULT ''"),
    ("number", "INTEGER NOT NULL DEFAULT 0"),
    ("title", "TEXT NOT NULL DEFAULT ''"),
    ("url", "TEXT NOT NULL DEFAULT ''"),
    ("issue_state", "TEXT NOT NULL DEFAULT ''"),
    ("ownership", "TEXT NOT NULL DEFAULT ''"),
    ("status", "TEXT NOT NULL DEFAULT 'todo'"),
    ("project_status", "TEXT NOT NULL DEFAULT ''"),
    ("assignees", "TEXT NOT NULL DEFAULT ''"),
    ("mentioned", "INTEGER NOT NULL DEFAULT 0"),
    ("latest_comment_url", "TEXT NOT NULL DEFAULT ''"),
    ("pr_number", "INTEGER NOT NULL DEFAULT 0"),
    ("pr_url", "TEXT NOT NULL DEFAULT ''"),
    ("branch", "TEXT NOT NULL DEFAULT ''"),
    ("work_branch", "TEXT NOT NULL DEFAULT ''"),
    ("work_dir", "TEXT NOT NULL DEFAULT ''"),
    ("session_id", "TEXT"),
    ("session_agent", "TEXT"),
    ("session_at", "INTEGER"),
    ("handoff", "TEXT NOT NULL DEFAULT ''"),
    ("candidate_done", "INTEGER NOT NULL DEFAULT 0"),
    ("account_id", "INTEGER NOT NULL DEFAULT 0"),
    ("updated_at", "INTEGER"),
    ("parent_issue", "TEXT NOT NULL DEFAULT ''"),
    ("sub_issues", "TEXT NOT NULL DEFAULT ''"),
    ("created_at", "INTEGER NOT NULL DEFAULT 0"),
    # 不在 SELECT_COLS 里、但按需拉取/写入路径会碰的列（见 TASK_INSERT_COLS 与
    # Rust `db.rs::TASK_INSERT_HEAD`）。
    ("author", "TEXT NOT NULL DEFAULT ''"),
    ("labels", "TEXT NOT NULL DEFAULT ''"),
    ("done_at", "INTEGER NOT NULL DEFAULT 0"),
    ("comments_count", "INTEGER NOT NULL DEFAULT 0"),
    ("stale", "INTEGER NOT NULL DEFAULT 0"),
    # #359：补齐 TASK_INSERT_COLS 的最后一列，使「写列 ⊆ 建列」成为可校验不变量。
    #
    # 背景：#346 曾把这处差集判为**误报**并据实关闭 —— 因为 `_write_task_if_absent`
    # 的 INSERT 列清单按实际表结构过滤（列存在必被插入、列不存在则表上也无该列、
    # 无约束可违），且 `synced_at` 自 Initial commit 起就在 `SCHEMA` 内，真正
    # 「老到缺列」的库会先被 LEGACY_TASKS_COLUMNS 判定拒绝服务。
    # 本条因此是**防御性冗余**：补它不修复任何可达故障，只是让
    # `check-mcp-columns.py` 的新断言能常绿、并杜绝将来新增写列时的静默漂移。
    # DEFAULT 0 与 db.rs 其余整数时间列的口径一致。
    ("synced_at", "INTEGER NOT NULL DEFAULT 0"),
)

# v0.3.50 物理重建（#155）之前的列名。Python MCP 不做表重建，遇到这些列直接拒绝服务。
LEGACY_TASKS_COLUMNS = ("key", "gh_state", "gh_status")


def ensure_schema(c):
    """幂等补齐 Python MCP 读写路径需要的列（与 Tauri 后端 db.rs 的迁移对齐）。

    #329 修正了两个问题：

    1. **清单不全**：原实现只 ALTER 了 10 列，而 `SELECT_COLS` 要读 28 列 ——
       `assignees` / `mentioned` / `latest_comment_url` / `pr_number` / `pr_url` /
       `work_dir` / `created_at` 等 7 列在从未启动过 App 的旧库上直接
       `no such column`，与下面这句「App 尚未启动过也能直接读写」的承诺不符。
       现改为由 `ENSURE_COLUMNS` 覆盖全部列，并由 CI 断言清单完备。

    2. **旧布局静默失败**：遇到 v0.3.50 之前的库（含 `key` / `gh_state`）时，
       原来会「补一堆列再以 `no such column: issue_key` 报错」，把「schema 太旧」
       误报成「列名不存在」。现在显式探测并给出可操作提示。
    """
    cols = table_columns(c, "tasks")
    if cols is None:
        raise RuntimeError(
            "数据库里没有 `tasks` 表 —— 请先运行一次 TaskBoard App 初始化数据库。"
        )

    legacy = sorted(cols.intersection(LEGACY_TASKS_COLUMNS))
    if legacy:
        raise RuntimeError(
            "数据库仍是 v0.3.50 之前的旧布局（含 "
            + " / ".join(legacy)
            + " 列），Python MCP 不做表重建 —— "
            "请先启动一次 TaskBoard App 完成迁移，再使用 MCP。"
        )

    for name, ddl in ENSURE_COLUMNS:
        try:
            c.execute(f"ALTER TABLE tasks ADD COLUMN {name} {ddl}")
        except sqlite3.OperationalError:
            pass  # 列已存在则忽略


def conn():
    global _conn
    if _conn is None:
        if not os.path.exists(DB_PATH):
            raise RuntimeError(
                f"TaskBoard 数据库未找到: {DB_PATH}（请先运行一次 TaskBoard App 生成）"
            )
        # v0.3.53 (#169)：isolation_level=None → 自动提交。
        # 原来用 python 默认事务模式，而 4 个写任务工具都没调 commit()，
        # 长连接期间看着成功、进程一退出就回滚，写入全丢。
        # 自动提交比在 11 个工具出口各写一次 commit() 更难漏。
        c = sqlite3.connect(
            DB_PATH, timeout=10, check_same_thread=False, isolation_level=None
        )
        c.execute("PRAGMA busy_timeout=5000")
        c.row_factory = sqlite3.Row
        ensure_schema(c)
        _conn = c
    return _conn


def rows_to_dicts(rows):
    return [dict(r) for r in rows]


def _is_custom_column(key, status):
    """该任务所属账号是否有名为 status 的自定义列（对标 Rust 侧校验）。

    老库可能没有 account_columns 表 → 视为无自定义列，不抛错。"""
    try:
        row = conn().execute(
            "SELECT account_id FROM tasks WHERE issue_key=?", (key,)
        ).fetchone()
        if not row or row[0] is None:
            return False
        cols = conn().execute(
            "SELECT col_key FROM account_columns WHERE account_id=?", (row[0],)
        ).fetchall()
        return any(r[0] == status for r in cols)
    except sqlite3.OperationalError:
        return False


# --------------------------------------------------------------------------- #
# v0.4.1 (#250)：本地未命中时按需拉取单个 issue
#
# 背景：tasks 表只由 App 的同步（sync.rs）从 GitHub 单向填充，而本 MCP 是纯本地 SQL。
# 刚创建、尚未同步到的 issue 会让所有写路径报「任务不存在」，把 agent 工作流卡在第一步。
# 这里补上「未命中 → 拉取该单个 issue → 落库」的通道：只读 GitHub（单次 GET），
# 不写回、不触发全量同步，且只在未命中时才发请求。
#
# 与 Rust 侧 `app/src-tauri/src/on_demand.rs` 同语义（AGENTS.md §8.6 要求两侧一致）：
#   * 账号选择：ref 带 owner → 与 accounts.org 大小写不敏感匹配；否则用默认账号
#   * 状态判定：closed → done；显式 label 映射；否则 todo（Project Status 需 GraphQL，REST 给不了）
#   * 落库用 ON CONFLICT DO NOTHING，绝不覆盖同步写入的 project_status / mentioned 等字段
# --------------------------------------------------------------------------- #
def _app_version():
    """#359：应用版本的**单一来源** = ``app/src-tauri/Cargo.toml`` 的 ``[package] version``。

    #359 之前这里硬编码 ``"0.6.1"``，而实际版本是 ``0.6.5``（Rust 侧用
    ``env!("CARGO_PKG_VERSION")`` 自动取值），且 ``scripts/check-versions.py``
    不覆盖本文件 ⇒ 漂移无门禁、agent 通过 ``initialize`` 拿到的是过期版本。

    解析失败（源码树不完整 / 打包分发时缺 Cargo.toml）时回落 ``"0.0.0"``：
    MCP server 是便携兜底路径，不应因为读不到版本号就拒绝启动。
    """
    here = os.path.dirname(os.path.abspath(__file__))
    cargo = os.path.join(here, "..", "app", "src-tauri", "Cargo.toml")
    try:
        with open(cargo, encoding="utf-8") as f:
            for line in f:
                m = re.match(r'^version\s*=\s*"([^"]+)"', line.strip())
                if m:
                    return m.group(1)
    except OSError:
        pass
    return "0.0.0"


GITHUB_API = "https://api.github.com"

# 与 Rust `db.rs::TASK_INSERT_HEAD` 的列清单一致。
# 实际写入时会与当前库真实存在的列取交集，兼容尚未迁移的老库。
TASK_INSERT_COLS = (
    "issue_key", "owner", "repo", "number", "title", "url", "issue_state", "ownership",
    "status", "project_status", "assignees", "labels", "done_at", "mentioned",
    "comments_count", "latest_comment_url", "pr_number", "pr_url", "branch",
    "candidate_done", "stale", "updated_at", "synced_at", "account_id", "author",
)
# `ON CONFLICT` 目标列（tasks 的唯一键）；缺失即说明本地库过旧。
TASK_CONFLICT_COLS = ("repo", "number", "account_id")


def normalize_issue_state(raw):
    """issue state 落库前的归一化（#335）。

    `tasks.issue_state` 有两个来源、两套大小写：REST 给小写 `open`/`closed`，
    GraphQL（ProjectV2 条目）给大写 `OPEN`/`CLOSED`。统一折成小写后再落库，
    保证该列口径单一。与 Rust `common::normalize_issue_state` 同语义。
    """
    return (raw or "").strip().lower()


def is_closed_state(raw):
    """该 state 是否表示「已关闭」（#335）。大小写不敏感，**不得**写死 `== "closed"`。

    与 Rust `common::is_closed_state` 同语义（AGENTS.md §8.6 要求两侧一致）。
    """
    return (raw or "").strip().lower() == "closed"


def _table_columns(table):
    return {r[1] for r in conn().execute(f"PRAGMA table_info({table})").fetchall()}


def _iso_to_secs(s):
    """RFC3339 'YYYY-MM-DDTHH:MM:SSZ' → Unix 秒；失败返回 0（对齐 Rust `iso8601_to_secs`）。"""
    s = (s or "").strip()
    if len(s) < 19:
        return 0
    try:
        return calendar.timegm(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S"))
    except ValueError:
        return 0


def _classify(assignees, login):
    """归属判定，与 Rust `sync::classify` 一致。"""
    if not assignees:
        return "notassignee"
    return "assigned" if login in assignees else "assigned-others"


def _resolve_label_status(org, repo, labels_csv):
    """显式 label → 状态映射，仅命中时返回状态（对齐 Rust `resolve_status_from_rules_explicit`）。

    优先级：先按 labels 出现顺序查 repo 级（org+repo+label），再按同样顺序查 org 级（repo=''）。
    """
    labels = [l.strip() for l in (labels_csv or "").split(",") if l.strip()]
    if not labels:
        return None
    try:
        rules = conn().execute(
            "SELECT org, repo, label, status FROM label_mappings"
        ).fetchall()
    except sqlite3.OperationalError:
        return None  # 老库没有 label_mappings 表
    for label in labels:
        for r in rules:
            if r[0] == org and r[1] == repo and r[2] == label:
                return r[3]
    for label in labels:
        for r in rules:
            if r[0] == org and r[1] == "" and r[2] == label:
                return r[3]
    return None


def _account_owners(row):
    """账号可认领的 owner 集合（小写）。

    **`org` 与 `login` 都算认领者**：实测本地库里 task-dashboard 所属账号的 `org` 是空串
    （个人命名空间仓库），只按 org 匹配会让 `owner/repo#N` 找不到账号 —— 恰好是本功能
    最需要可用的场景。个人命名空间下仓库 owner 就是登录名。
    """
    return {
        v.lower()
        for v in ((row["org"] or "").strip(), (row["login"] or "").strip())
        if v
    }


def _default_owner(account):
    """账号的默认 owner：`org` 优先，为空则退回 `login`（否则 URL 会拼成 `/repos//repo/...`）。"""
    org = (account["org"] or "").strip()
    return org or (account["login"] or "").strip()


def _pick_account(owner):
    """选账号。返回 `(account_row, reason)`；`reason` 非空表示不可用（不发网络请求）。"""
    try:
        rows = conn().execute(
            "SELECT id, login, org, pat_token, is_default FROM accounts ORDER BY id ASC"
        ).fetchall()
    except sqlite3.OperationalError as e:
        return None, f"读取账号失败: {e}"
    if not rows:
        return None, "本地没有任何 GitHub 账号，请先在 TaskBoard 中添加账号与 PAT"
    if owner:
        lower = owner.lower()
        matched = [r for r in rows if lower in _account_owners(r)]
        if not matched:
            known, seen = [], set()
            for r in rows:
                for v in ((r["org"] or "").strip(), (r["login"] or "").strip()):
                    if v and v.lower() not in seen:
                        seen.add(v.lower())
                        known.append(v)
            return None, (
                f"ref 里的 owner `{owner}` 没有对应账号（已知 owner/org: {', '.join(known)}）"
            )
        chosen = next((r for r in matched if r["is_default"]), matched[0])
    else:
        chosen = next((r for r in rows if r["is_default"]), rows[0])
    if not (chosen["pat_token"] or "").strip():
        return None, f"账号 @{chosen['login']} 未配置 PAT"
    return chosen, None


def _fetch_issue(pat, owner, repo, number):
    """`GET /repos/{owner}/{repo}/issues/{n}`（只读）。

    返回 `(payload, reason)`：404 → `(None, None)`（远端确实没有）；
    其它失败 → `(None, reason)`。
    """
    url = f"{GITHUB_API}/repos/{owner}/{repo}/issues/{number}"
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {pat}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return json.loads(resp.read().decode("utf-8")), None
    except urllib.error.HTTPError as e:
        if e.code == 404:
            return None, None
        if e.code in (401, 403):
            return None, f"GitHub 鉴权 / 限流失败 (HTTP {e.code})，请检查 PAT 与配额"
        return None, f"GitHub API 错误 (HTTP {e.code})"
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        return None, f"网络请求失败: {e}"


def _missing_detail(owner, parts, owner_inferred):
    """「远端没有」的说明：带上实际查询目标；owner 系推断时提示改写引用形式。

    `AGENTS.md §7` 允许 `repo#N`（不带 owner）写法，此时 owner 由账号推断；
    若仓库属于其他命名空间，404 并不代表 issue 不存在，必须让 agent 看出来。
    """
    detail = (
        f"已按 `{owner}/{parts['repo']}#{parts['number']}` 查询，远端没有该 issue"
        "（或该编号是 PR）"
    )
    if owner_inferred:
        detail += "；该 owner 是由账号推断的，若仓库属于其他命名空间，请用 `owner/repo#N` 形式指定"
    return detail


def _task_exists(key):
    return (
        conn().execute("SELECT 1 FROM tasks WHERE issue_key=?", (key,)).fetchone()
        is not None
    )


def _row_from_issue(payload, repo, key, account, now):
    """把单 issue REST 响应组装成待写入行（对齐 Rust `on_demand::build_task_row`）。"""
    assignees = [
        a.get("login") for a in (payload.get("assignees") or []) if a.get("login")
    ]
    labels = [l.get("name") for l in (payload.get("labels") or []) if l.get("name")]
    labels_csv = ",".join(labels)
    state = payload.get("state") or ""
    # #335：判据大小写不敏感（原实现 `== "closed"` 认不出 GraphQL 的大写 `CLOSED`）。
    if is_closed_state(state):
        status = "done"
    else:
        status = _resolve_label_status(account["org"], repo, labels_csv) or "todo"
    return {
        "issue_key": key,
        # 归属列与同步一致：写账号的 org（可能为空串）；API 请求用的 owner 是另一回事。
        "owner": account["org"],
        "repo": repo,
        "number": int(payload.get("number") or 0),
        "title": payload.get("title") or "",
        "url": payload.get("html_url") or "",
        # #335：与同步路径同一口径落库（归一化为小写）。
        "issue_state": normalize_issue_state(state),
        "ownership": _classify(assignees, account["login"]),
        "status": status,
        # Project Status 需 GraphQL；mentioned / PR 关联 / 分支来自多源聚合 —— 都留待下次全量同步补。
        "project_status": "",
        "assignees": ",".join(assignees),
        "labels": labels_csv,
        "author": (payload.get("user") or {}).get("login") or "",
        "done_at": now if status == "done" else 0,
        "mentioned": 0,
        "comments_count": int(payload.get("comments") or 0),
        "latest_comment_url": "",
        "pr_number": 0,
        "pr_url": "",
        "branch": "",
        "candidate_done": 0,
        "stale": 0,
        "updated_at": _iso_to_secs(payload.get("updated_at")),
        "synced_at": now,
        "account_id": account["id"],
    }


def _write_task_if_absent(row):
    """`ON CONFLICT DO NOTHING` 落库。返回 `reason`（非空表示失败）。"""
    existing = _table_columns("tasks")
    missing = [c for c in TASK_CONFLICT_COLS if c not in existing]
    if missing:
        return (
            f"本地库结构过旧（tasks 缺列: {', '.join(missing)}），"
            "请先启动一次 TaskBoard 完成迁移"
        )
    cols = [c for c in TASK_INSERT_COLS if c in existing]
    sql = (
        f"INSERT INTO tasks ({', '.join(cols)}) "
        f"VALUES ({', '.join('?' for _ in cols)}) "
        "ON CONFLICT(repo, number, account_id) DO NOTHING"
    )
    try:
        conn().execute(sql, [row[c] for c in cols])
    except sqlite3.Error as e:
        return f"写入任务失败: {e}"
    return None


def ensure_task_available(issue):
    """本地未命中时按需拉取该 issue 并落库。

    返回 `(outcome, reason)`，`outcome` ∈
    `{"already", "pulled", "remote_missing", "unavailable"}`。
    """
    parts = parse_issue_ref_parts(issue)
    key = parts["key"]
    if _task_exists(key):
        return "already", None
    account, reason = _pick_account(parts["owner"])
    if reason:
        return "unavailable", reason
    # API 请求用的 owner：ref 显式给的优先；否则用账号的 org，org 为空则退回 login
    # （个人命名空间仓库，实测 task-dashboard 所属账号 org 就是空串）。
    api_owner = parts["owner"] or _default_owner(account)
    payload, reason = _fetch_issue(
        account["pat_token"].strip(), api_owner, parts["repo"], parts["number"]
    )
    if reason:
        return "unavailable", reason
    owner_inferred = parts["owner"] is None
    if payload is None:
        return "remote_missing", _missing_detail(api_owner, parts, owner_inferred)
    # `GET /issues/{n}` 对 PR 也返回 200（响应带 pull_request）；看板任务只认 issue。
    if payload.get("pull_request") is not None:
        return "remote_missing", _missing_detail(api_owner, parts, owner_inferred)
    now = int(time.time())
    row = _row_from_issue(payload, parts["repo"], key, account, now)
    reason = _write_task_if_absent(row)
    if reason:
        return "unavailable", reason
    return "pulled", None


def _ensure_before_write(key, issue):
    """写路径前置：本地未命中则按需拉取（必须在写入**之前**调用）。

    为什么不能写在 UPDATE 失败之后：自定义列的合法性校验要读该行的 `account_id`，
    行还不存在时会误报「非法状态」。

    返回本次是否真的拉取过；不可用时 raise ValueError（文案带原因）。
    """
    if _task_exists(key):
        return False
    outcome, reason = ensure_task_available(issue)
    if outcome == "pulled":
        return True
    if outcome == "already":
        return False
    if outcome == "remote_missing":
        raise ValueError(f"任务不存在且无法从 GitHub 拉取: {key}（{reason}）")
    raise ValueError(f"任务不存在且无法从 GitHub 拉取: {key}（{reason}）")


# --------------------------------------------------------------------------- #
# 工具实现
# --------------------------------------------------------------------------- #
def tool_list_my_tasks(status=None, ownership=None):
    sql = f"SELECT {SELECT_COLS} FROM tasks"
    wheres, params = [], []
    if status:
        sk = resolve_status(status)
        if not sk:
            raise ValueError(f"非法状态: {status}")
        wheres.append("status=?")
        params.append(sk)
    if ownership:
        wheres.append("ownership=?")
        params.append(ownership)
    if wheres:
        sql += " WHERE " + " AND ".join(wheres)
    sql += " ORDER BY candidate_done ASC, status ASC, updated_at DESC"
    return rows_to_dicts(conn().execute(sql, params).fetchall())


def tool_get_task_status(issue):
    key = parse_issue_ref(issue)
    row = conn().execute(
        f"SELECT {SELECT_COLS} FROM tasks WHERE issue_key=?", (key,)
    ).fetchone()
    if row:
        return {"found": True, "issue_key": key, **dict(row)}
    # v0.4.1 (#250)：本地未命中 → 按需拉取后再查一次。
    # 读路径保持「永远能回答」的旧契约：账号缺失 / 网络失败 / DB 异常都降级为
    # found=False + reason，不把读操作变成异常。
    try:
        outcome, reason = ensure_task_available(issue)
    except (ValueError, sqlite3.Error) as e:
        outcome, reason = "unavailable", f"按需拉取失败: {e}"
    if outcome in ("pulled", "already"):
        row = conn().execute(
            f"SELECT {SELECT_COLS} FROM tasks WHERE issue_key=?", (key,)
        ).fetchone()
        if row:
            return {
                "found": True,
                "issue_key": key,
                "pulled": outcome == "pulled",
                **dict(row),
            }
    if outcome == "remote_missing":
        reason_text = f"本地无此任务，且{reason}"
    else:
        reason_text = f"本地无此任务，且无法从 GitHub 拉取：{reason}"
    # v0.3.53 (#169)：返回字段为 `issue_key`，与 Rust MCP 一致。
    return {"found": False, "issue_key": key, "reason": reason_text}


def tool_update_task_status(issue, status):
    key = parse_issue_ref(issue)
    # v0.4.1 (#250)：先确保任务存在（必要时按需拉取）——自定义列的校验要读该行
    # 的 account_id，行不存在时会误报「非法状态」。
    pulled = _ensure_before_write(key, issue)
    sk = resolve_status(status)
    if sk is None:
        # v0.3.53 (#169)：与 Rust `common.rs::validate_task_status` 对齐——四态之外，
        # 该任务所属账号的自定义列 col_key 也合法（custom 看板模式）。此前 Python 侧
        # 直接报错，导致同一参数 Rust 能写、Python 写不了。
        s = (status or "").strip()
        if s and _is_custom_column(key, s):
            sk = s
        else:
            raise ValueError(
                f"非法状态: {status}（应为 todo/doing/processed/done、中文四态"
                f"或该任务账号的自定义列）"
            )
    cur = conn().execute("UPDATE tasks SET status=? WHERE issue_key=?", (sk, key))
    if cur.rowcount == 0:
        raise ValueError(f"任务不存在: {key}")
    return {"ok": True, "issue_key": key, "status": sk, "pulled": pulled}


def tool_record_session(issue, session_id, agent=None, branch=None, work_dir=None):
    key = parse_issue_ref(issue)
    sid = (session_id or "").strip()
    if not sid:
        raise ValueError("session_id 不能为空")
    # v0.4.1 (#250)：本地未命中时按需拉取。
    pulled = _ensure_before_write(key, issue)
    br = (branch or "").strip()
    wd = (work_dir or "").strip()
    if br and wd:
        cur = conn().execute(
            "UPDATE tasks SET session_id=?, session_agent=?, session_at=?, work_branch=?, work_dir=? WHERE issue_key=?",
            (sid, (agent or "").strip(), int(time.time()), br, wd, key),
        )
    elif br:
        cur = conn().execute(
            "UPDATE tasks SET session_id=?, session_agent=?, session_at=?, work_branch=? WHERE issue_key=?",
            (sid, (agent or "").strip(), int(time.time()), br, key),
        )
    elif wd:
        cur = conn().execute(
            "UPDATE tasks SET session_id=?, session_agent=?, session_at=?, work_dir=? WHERE issue_key=?",
            (sid, (agent or "").strip(), int(time.time()), wd, key),
        )
    else:
        cur = conn().execute(
            "UPDATE tasks SET session_id=?, session_agent=?, session_at=? WHERE issue_key=?",
            (sid, (agent or "").strip(), int(time.time()), key),
        )
    if cur.rowcount == 0:
        raise ValueError(f"任务不存在: {key}")
    return {"ok": True, "issue_key": key, "pulled": pulled}


def tool_record_handoff(issue, text):
    key = parse_issue_ref(issue)
    text = text or ""
    # v0.4.1 (#250)：本地未命中时按需拉取。
    pulled = _ensure_before_write(key, issue)
    # v0.3.53 (#169)：原为 `WHERE key=?`，#155 改名后必然报 "no such column: key"。
    cur = conn().execute("UPDATE tasks SET handoff=? WHERE issue_key=?", (text, key))
    if cur.rowcount == 0:
        raise ValueError(f"任务不存在: {key}")
    # 返回字段同 Rust MCP 用 issue_key。
    return {"ok": True, "issue_key": key, "handoff_len": len(text), "pulled": pulled}


def tool_clear_session(issue):
    key = parse_issue_ref(issue)
    # v0.4.1 (#250)：本地未命中时按需拉取。
    pulled = _ensure_before_write(key, issue)
    cur = conn().execute(
        "UPDATE tasks SET session_id=NULL, session_agent=NULL WHERE issue_key=?", (key,)
    )
    if cur.rowcount == 0:
        raise ValueError(f"任务不存在: {key}")
    return {"ok": True, "issue_key": key, "pulled": pulled}


def tool_set_work_branch(issue, branch):
    """#279：单独设置任务的工作分支 `work_branch`。

    agent 在**创建 / 切换 issue 分支之后**调用，纠正 `record_session` 在「开始任务」
    时录到的基线分支 main。与同步自动拉的 PR `branch` 列分离，同步不碰
    work_branch。`branch` 为空串报错（清空该列请使用 clear_work_branch）。
    若该 issue 尚未同步到本地，会按需从 GitHub 拉取这一个 issue 再写入。
    """
    key = parse_issue_ref(issue)
    br = (branch or "").strip()
    if not br:
        raise ValueError("branch 不能为空（清空请使用 clear_work_branch）")
    # v0.4.1 (#250)：本地未命中时按需拉取。
    pulled = _ensure_before_write(key, issue)
    cur = conn().execute(
        "UPDATE tasks SET work_branch=? WHERE issue_key=?", (br, key)
    )
    if cur.rowcount == 0:
        raise ValueError(f"任务不存在: {key}")
    return {"ok": True, "issue_key": key, "work_branch": br, "pulled": pulled}


# --------------------------------------------------------------------------- #
# v0.3.24+：记事本工具
# --------------------------------------------------------------------------- #
VALID_NOTE_LABELS = {"low", "medium", "high", "urgent"}


def tool_list_notes():
    """列出所有记事，按 created_at 降序。"""
    rows = conn().execute(
        "SELECT id, content, label, created_at, updated_at FROM notes ORDER BY created_at DESC"
    ).fetchall()
    return [dict(r) for r in rows]


def tool_add_note(content, label="low"):
    """新增记事，返回新记录。"""
    content = (content or "").strip()
    if not content:
        raise ValueError("记事内容不能为空")
    label = (label or "low").strip().lower()
    if label not in VALID_NOTE_LABELS:
        raise ValueError(f"无效标签: {label}（可选: low/medium/high/urgent）")
    now = int(time.time())
    conn().execute(
        "INSERT INTO notes (content, label, created_at, updated_at) VALUES (?, ?, ?, ?)",
        (content, label, now, now),
    )
    conn().commit()
    row_id = conn().execute("SELECT last_insert_rowid()").fetchone()[0]
    row = conn().execute(
        "SELECT id, content, label, created_at, updated_at FROM notes WHERE id=?", (row_id,)
    ).fetchone()
    return dict(row)


def tool_update_note(note_id, content):
    """更新记事内容，返回更新后的记录。"""
    content = (content or "").strip()
    if not content:
        raise ValueError("记事内容不能为空")
    now = int(time.time())
    cur = conn().execute(
        "UPDATE notes SET content=?, updated_at=? WHERE id=?", (content, now, note_id)
    )
    if cur.rowcount == 0:
        raise ValueError(f"记事 #{note_id} 不存在")
    conn().commit()
    row = conn().execute(
        "SELECT id, content, label, created_at, updated_at FROM notes WHERE id=?", (note_id,)
    ).fetchone()
    return dict(row)


def tool_update_note_label(note_id, label):
    """更新记事标签，返回更新后的记录。"""
    # 与 Rust 端 normalize_note_label 对齐：空标签回落 low，而非报错。
    label = (label or "low").strip().lower()
    if label not in VALID_NOTE_LABELS:
        raise ValueError(f"无效标签: {label}（可选: low/medium/high/urgent）")
    cur = conn().execute(
        "UPDATE notes SET label=? WHERE id=?", (label, note_id)
    )
    if cur.rowcount == 0:
        raise ValueError(f"记事 #{note_id} 不存在")
    conn().commit()
    row = conn().execute(
        "SELECT id, content, label, created_at, updated_at FROM notes WHERE id=?", (note_id,)
    ).fetchone()
    return dict(row)


def tool_delete_note(note_id):
    """删除记事。"""
    cur = conn().execute("DELETE FROM notes WHERE id=?", (note_id,))
    if cur.rowcount == 0:
        raise ValueError(f"记事 #{note_id} 不存在")
    conn().commit()
    return {"ok": True, "note_id": note_id}


# --------------------------------------------------------------------------- #
# 工具注册表（名称 + 入参 JSON Schema + 处理函数）
# --------------------------------------------------------------------------- #
TOOLS = [
    {
        "name": "list_my_tasks",
        "description": "列出看板任务；可按 status(todo/doing/processed/done 或中文四态) 与 "
        "ownership(assigned/notassignee/assigned-others) 过滤。返回任务数组。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "status": {"type": "string", "description": "可选，按看板状态过滤"},
                "ownership": {"type": "string", "description": "可选，按归属过滤"},
            },
        },
        "handler": tool_list_my_tasks,
    },
    {
        "name": "get_task_status",
        "description": "查询单个任务的当前看板状态，以及已记录的 session_id / session_agent / handoff。若该 issue 尚未同步到本地，会按需从 GitHub 拉取这一个 issue（返回体 pulled=true 表示本次拉取过）；拉取不到时返回 found=false 并在 reason 里说明原因。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "issue": {
                    "type": "string",
                    "description": "issue 引用：repo#number / owner/repo#number / GitHub URL",
                }
            },
            "required": ["issue"],
        },
        "handler": tool_get_task_status,
    },
    {
        "name": "update_task_status",
        "description": "将任务在看板上的状态更新为 待处理/处理中/已处理/已完成（只写本地 SQLite，不碰 GitHub）。若该 issue 还没同步到本地，会自动按需从 GitHub 拉取这一个 issue 再写入（返回体 pulled=true 表示本次拉取过，无需再手动触发同步）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "issue": {"type": "string", "description": "issue 引用"},
                "status": {
                    "type": "string",
                    "description": "目标状态：todo/doing/processed/done 或 待处理/处理中/已处理/已完成",
                },
            },
            "required": ["issue", "status"],
        },
        "handler": tool_update_task_status,
    },
    {
        "name": "record_session",
        "description": "记录中断会话的 session id 到该任务卡片（session_id / session_agent / session_at；branch 非空则一并记录工作分支到 work_branch，work_dir 非空则一并记录工作目录）。若该 issue 尚未同步到本地，会按需从 GitHub 拉取这一个 issue 再写入。"
        "只写本地 SQLite，不碰 GitHub。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "issue": {"type": "string", "description": "issue 引用"},
                "session_id": {"type": "string", "description": "会话 id（如 claude-code / codex 的会话标识）"},
                "agent": {
                    "type": "string",
                    "description": "可选，来源 agent：claude-code / codex / opencode / zcode / workbuddy …",
                },
                "branch": {
                    "type": "string",
                    "description": "可选，当前工作分支（如 git branch --show-current），非空才写入 work_branch 列",
                },
                "work_dir": {
                    "type": "string",
                    "description": "可选，当前工作目录（项目路径），非空才写入 work_dir 列",
                },
            },
            "required": ["issue", "session_id"],
        },
        "handler": tool_record_session,
    },
    {
        "name": "record_handoff",
        "description": "记录「交接任务」详情到该任务（handoff 字段）。只写本地 SQLite，不碰 GitHub。若该 issue 尚未同步到本地，会按需从 GitHub 拉取这一个 issue 再写入。"
        "用于 agent 识别到用户「生成交接任务」类意图时调用。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "issue": {"type": "string", "description": "issue 引用"},
                "text": {"type": "string", "description": "交接详情文本"},
            },
            "required": ["issue", "text"],
        },
        "handler": tool_record_handoff,
    },
    {
        "name": "clear_session",
        "description": "任务完成后清空 session_id / session_agent 字段（保留 session_at 审计）。只写本地 SQLite。若该 issue 尚未同步到本地，会按需从 GitHub 拉取这一个 issue 再写入。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "issue": {"type": "string", "description": "issue 引用"},
            },
            "required": ["issue"],
        },
        "handler": tool_clear_session,
    },
    {
        "name": "set_work_branch",
        "description": "单独设置任务的工作分支 work_branch（#279）。agent 在创建 / 切换 issue 分支之后调用，纠正 record_session 在「开始任务」时录到的基线分支 main。与同步自动拉的 PR branch 列分离，同步不碰 work_branch。branch 为空会报错（清空该列请使用 clear_work_branch）。若该 issue 尚未同步到本地，会按需从 GitHub 拉取这一个 issue 再写入。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "issue": {"type": "string", "description": "issue 引用"},
                "branch": {
                    "type": "string",
                    "description": "目标工作分支名，如 feature/issue-279-fix",
                },
            },
            "required": ["issue", "branch"],
        },
        "handler": tool_set_work_branch,
    },
    # v0.3.24+：记事本工具
    {
        "name": "list_notes",
        "description": "列出所有记事，按创建时间降序（最新的在前）。",
        "inputSchema": {"type": "object", "properties": {}},
        "handler": tool_list_notes,
    },
    {
        "name": "add_note",
        "description": "新增一条记事，返回新记录（含 id、创建时间）。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "content": {"type": "string", "description": "记事内容"},
                "label": {
                    "type": "string",
                    "description": "标签：low/medium/high/urgent（默认 low）",
                    "enum": ["low", "medium", "high", "urgent"],
                },
            },
            "required": ["content"],
        },
        "handler": tool_add_note,
    },
    {
        "name": "update_note",
        "description": "更新记事内容，返回更新后的记录。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "note_id": {"type": "integer", "description": "记事 id"},
                "content": {"type": "string", "description": "新的记事内容"},
            },
            "required": ["note_id", "content"],
        },
        "handler": tool_update_note,
    },
    {
        "name": "update_note_label",
        "description": "更新记事标签（low/medium/high/urgent），返回更新后的记录。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "note_id": {"type": "integer", "description": "记事 id"},
                "label": {
                    "type": "string",
                    "description": "标签：low/medium/high/urgent",
                    "enum": ["low", "medium", "high", "urgent"],
                },
            },
            "required": ["note_id", "label"],
        },
        "handler": tool_update_note_label,
    },
    {
        "name": "delete_note",
        "description": "删除一条记事。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "note_id": {"type": "integer", "description": "记事 id"},
            },
            "required": ["note_id"],
        },
        "handler": tool_delete_note,
    },
]

TOOL_BY_NAME = {t["name"]: t for t in TOOLS}


# --------------------------------------------------------------------------- #
# JSON-RPC 2.0 over stdio（双格式自动识别：NDJSON + Content-Length 兼容）
# --------------------------------------------------------------------------- #

NDJSON = "ndjson"
CONTENT_LENGTH = "content-length"

# #345：与 Rust 侧 mcp.rs 对齐的分帧上限。MCP 消息远小于此值，上限只用于挡住畸形声明。
MAX_FRAME_BODY = 8 * 1024 * 1024
MAX_FRAME_HEADER = 8 * 1024


class ReadOutcome:
    """#345：``read_message`` 的四态结果。

    区分「输入流结束」与「这一帧畸形」是关键：原实现用 ``(None, None)`` 同时表示两者，
    于是**一行坏 JSON 就让主循环跳出、stdio 断开**——agent 侧表现为随机
    ``connection closed``（与 Rust 侧 #328 修掉的症状完全一致，只是当时只修了 Rust 侧）。

    状态与 Rust 侧 ``mcp::ReadOutcome`` 一一对应：
    ``MSG``（有效消息）/ ``EOF``（流结束）/ ``MALFORMED``（本帧已完整消费，丢弃后继续读）
    / ``FATAL``（帧边界已丢失，只能终止）。
    """

    MSG = "msg"
    EOF = "eof"
    MALFORMED = "malformed"
    FATAL = "fatal"

    def __init__(self, kind, msg=None, framing=None, why=""):
        self.kind = kind
        self.msg = msg
        self.framing = framing
        self.why = why

    @classmethod
    def msg(cls, value, framing):
        return cls(cls.MSG, msg=value, framing=framing)

    @classmethod
    def eof(cls):
        return cls(cls.EOF)

    @classmethod
    def malformed(cls, why):
        return cls(cls.MALFORMED, why=why)

    @classmethod
    def fatal(cls, why):
        return cls(cls.FATAL, why=why)


def read_message(stream):
    """读取一条 JSON-RPC 消息，返回 ``ReadOutcome``。

    MCP stdio 规范为换行分隔 JSON；LSP 风格 Content-Length 头作为历史兼容保留。
    首个有效字符判定分帧格式：`{` → NDJSON，否则 → Content-Length。
    """
    # 跳过消息间空行，用首行首字符判定分帧格式
    while True:
        line = stream.readline()
        if not line:
            return ReadOutcome.eof()
        if isinstance(line, bytes):
            line = line.decode("utf-8", "replace")
        if line.strip():
            break

    if line.lstrip().startswith("{"):
        if len(line) > MAX_FRAME_BODY:
            # 与 Rust 侧一致：NDJSON 分支此前无长度上限，无终止符的长行会撑爆内存。
            return ReadOutcome.fatal(
                "NDJSON 行超过 %d 字节仍未终止" % MAX_FRAME_BODY
            )
        try:
            return ReadOutcome.msg(json.loads(line), NDJSON)
        except ValueError as e:
            # 该行已完整消费（readline 读到了换行）⇒ 丢弃后能安全地继续读下一条。
            return ReadOutcome.malformed("NDJSON 解析失败: %s" % e)

    headers = {}
    header_bytes = 0
    while True:
        header_bytes += len(line)
        if header_bytes > MAX_FRAME_HEADER:
            return ReadOutcome.fatal(
                "头部超过 %d 字节仍未终止，无法定位帧边界" % MAX_FRAME_HEADER
            )
        stripped = line.rstrip("\r\n")
        if stripped == "":
            break
        if ":" in stripped:
            k, v = stripped.split(":", 1)
            headers[k.strip().lower()] = v.strip()
        line = stream.readline()
        if not line:
            return ReadOutcome.eof()
        if isinstance(line, bytes):
            line = line.decode("utf-8", "replace")

    raw_length = headers.get("content-length")
    try:
        length = int(raw_length)
    except (TypeError, ValueError):
        length = None
    if length is None:
        # 头部已正常收尾（帧边界已知）⇒ 丢弃后继续读下一条是安全的。
        return ReadOutcome.malformed("Content-Length 头缺失或不可解析")
    # #345：越界长度必须判 FATAL——body 尚未消费，继续读会把 body 字节当头部解析。
    if length <= 0 or length > MAX_FRAME_BODY:
        return ReadOutcome.fatal(
            "Content-Length=%d 超出允许范围（1..=%d）" % (length, MAX_FRAME_BODY)
        )
    body = stream.read(length)
    if body is None or len(body) < length:
        # body 被截断 ⇒ 视为流结束
        return ReadOutcome.eof()
    if isinstance(body, bytes):
        body = body.decode("utf-8", "replace")
    try:
        return ReadOutcome.msg(json.loads(body), CONTENT_LENGTH)
    except ValueError as e:
        # body 已完整消费 ⇒ 可以安全地继续读下一条。
        return ReadOutcome.malformed("Content-Length 帧 JSON 解析失败: %s" % e)


def write_message(stream, msg, framing):
    data = json.dumps(msg, ensure_ascii=False).encode("utf-8")
    if framing == NDJSON:
        stream.write(data + b"\n")
    else:
        stream.write(b"Content-Length: " + str(len(data)).encode() + b"\r\n\r\n")
        stream.write(data)
    stream.flush()


def call_tool(name, arguments):
    tool = TOOL_BY_NAME.get(name)
    if not tool:
        raise ValueError(f"未知工具: {name}")
    kwargs = {k: v for k, v in (arguments or {}).items()}
    return tool["handler"](**kwargs)


def handle(msg):
    method = msg.get("method")
    msg_id = msg.get("id")

    # 通知（无 id）不需要回复
    if msg_id is None:
        return None

    if method == "initialize":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "protocolVersion": "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "taskboard", "version": _app_version()},
            },
        }

    if method == "ping":
        return {"jsonrpc": "2.0", "id": msg_id, "result": {}}

    if method == "tools/list":
        return {
            "jsonrpc": "2.0",
            "id": msg_id,
            "result": {
                "tools": [
                    {
                        "name": t["name"],
                        "description": t["description"],
                        "inputSchema": t["inputSchema"],
                    }
                    for t in TOOLS
                ]
            },
        }

    if method == "tools/call":
        name = msg.get("params", {}).get("name")
        arguments = msg.get("params", {}).get("arguments", {})
        try:
            result = call_tool(name, arguments)
            text = json.dumps(result, ensure_ascii=False)
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": text}],
                    "isError": False,
                },
            }
        except Exception as e:  # noqa: BLE001 — 任何工具异常都转为 MCP 错误返回
            return {
                "jsonrpc": "2.0",
                "id": msg_id,
                "result": {
                    "content": [{"type": "text", "text": f"错误：{e}"}],
                    "isError": True,
                },
            }

    # 未知方法
    return {
        "jsonrpc": "2.0",
        "id": msg_id,
        "error": {"code": -32601, "message": f"方法未实现: {method}"},
    }


def main():
    istream = sys.stdin.buffer
    ostream = sys.stdout.buffer
    handled = 0
    while True:
        # #345：read_message 自身已把四态都表达清楚（不再抛异常给外层兜底成 break）。
        outcome = read_message(istream)
        # #345：只有真正的流结束 / 帧边界丢失才退出。一条畸形消息不再拖垮整个进程
        # ——丢弃该帧继续服务（原实现把「畸形」与「EOF」都折叠成 None，主循环直接跳出、
        # stdio 断开，agent 侧表现为随机 connection closed，与 Rust 侧 #328 修掉的
        # 症状完全一致，只是当时只修了 Rust 侧）。
        if outcome.kind in (ReadOutcome.EOF, ReadOutcome.FATAL):
            if outcome.why:
                sys.stderr.write(
                    f"[taskboard-mcp] 无法继续读取，退出: {outcome.why}\n"
                )
            break
        if outcome.kind == ReadOutcome.MALFORMED:
            sys.stderr.write(
                f"[taskboard-mcp] 跳过一条无法解析的消息: {outcome.why}\n"
            )
            continue
        try:
            resp = handle(outcome.msg)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"[taskboard-mcp] 处理异常: {e}\n")
            resp = None
        if resp is not None:
            write_message(ostream, resp, outcome.framing)
        handled += 1
    if handled == 0:
        sys.stderr.write(
            "[taskboard-mcp] 未收到任何有效 JSON-RPC 消息即断开——请检查客户端分帧格式\n"
        )


if __name__ == "__main__":
    main()
