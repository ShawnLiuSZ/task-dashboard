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

`issue` 接受多种格式：
- `repo#number`            e.g. `fad-backend#1234`
- `owner/repo#number`      e.g. `FoodsUp-Inc/fad-backend#1234`
- GitHub URL               e.g. `https://github.com/FoodsUp-Inc/fad-backend/issues/1234`

数据库路径：默认 `~/Library/Application Support/com.shawnliu.taskboard/taskboard.db`，
可用环境变量 `TASKBOARD_DB` 覆盖。
"""

import json
import os
import re
import sqlite3
import sys
import time

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
SELECT_COLS = (
    "issue_key, owner, repo, number, title, url, issue_state, ownership, "
    "status, project_status, assignees, mentioned, latest_comment_url, "
    "pr_number, pr_url, branch, session_id, session_agent, session_at, "
    "handoff, candidate_done, account_id, updated_at"
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


def parse_issue_ref(ref):
    """把多种 issue 引用归一化为本库的任务业务引用 `issue_key`（`repo#number`）。"""
    ref = (ref or "").strip()
    if not ref:
        raise ValueError("issue 引用为空")
    # URL 形式：https://github.com/{owner}/{repo}/issues/{n}
    m = re.search(r"github\.com/[^/]+/([^/#?]+)/(?:issues|pull)/(\d+)", ref)
    if m:
        return f"{m.group(1)}#{m.group(2)}"
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
        return f"{repo}#{num}"
    raise ValueError(f"无法解析 issue 引用: {ref!r}")


# --------------------------------------------------------------------------- #
# SQLite 访问（单连接，顺序处理；设置 busy_timeout 以兼容 Tauri 进程并发占用）
# --------------------------------------------------------------------------- #
_conn = None


def ensure_schema(c):
    """幂等补齐应用新增列（与 Tauri 后端 db.rs::init 的迁移一致）。
    即使 TaskBoard App 尚未启动过，MCP Server 也能直接读写既有数据库。"""
    for col_sql in (
        "ALTER TABLE tasks ADD COLUMN branch TEXT NOT NULL DEFAULT ''",
        "ALTER TABLE tasks ADD COLUMN handoff TEXT NOT NULL DEFAULT ''",
    ):
        try:
            c.execute(col_sql)
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
    if not row:
        # v0.3.53 (#169)：返回字段由 `key` 改为 `issue_key`，与 Rust MCP 一致。
        return {"found": False, "issue_key": key}
    return {"found": True, "issue_key": key, **dict(row)}


def tool_update_task_status(issue, status):
    key = parse_issue_ref(issue)
    sk = resolve_status(status)
    if not sk:
        raise ValueError(f"非法状态: {status}（应为 todo/doing/processed/done 或中文四态）")
    cur = conn().execute("UPDATE tasks SET status=? WHERE issue_key=?", (sk, key))
    if cur.rowcount == 0:
        raise ValueError(f"任务不存在: {key}")
    return {"ok": True, "issue_key": key, "status": sk}


def tool_record_session(issue, session_id, agent=None):
    key = parse_issue_ref(issue)
    sid = (session_id or "").strip()
    if not sid:
        raise ValueError("session_id 不能为空")
    cur = conn().execute(
        "UPDATE tasks SET session_id=?, session_agent=?, session_at=? WHERE issue_key=?",
        (sid, (agent or "").strip(), int(time.time()), key),
    )
    if cur.rowcount == 0:
        raise ValueError(f"任务不存在: {key}")
    return {"ok": True, "issue_key": key}


def tool_record_handoff(issue, text):
    key = parse_issue_ref(issue)
    text = text or ""
    # v0.3.53 (#169)：原为 `WHERE key=?`，#155 改名后必然报 "no such column: key"。
    cur = conn().execute("UPDATE tasks SET handoff=? WHERE issue_key=?", (text, key))
    if cur.rowcount == 0:
        raise ValueError(f"任务不存在: {key}")
    # 返回字段同 Rust MCP 用 issue_key。
    return {"ok": True, "issue_key": key, "handoff_len": len(text)}


def tool_clear_session(issue):
    key = parse_issue_ref(issue)
    cur = conn().execute(
        "UPDATE tasks SET session_id=NULL, session_agent=NULL WHERE issue_key=?", (key,)
    )
    if cur.rowcount == 0:
        raise ValueError(f"任务不存在: {key}")
    return {"ok": True, "issue_key": key}


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
        "description": "查询单个任务的当前看板状态，以及已记录的 session_id / session_agent / handoff。",
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
        "description": "将任务在看板上的状态更新为 待处理/处理中/已处理/已完成（只写本地 SQLite，不碰 GitHub）。",
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
        "description": "记录中断会话的 session id 到该任务卡片（session_id / session_agent / session_at）。"
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
            },
            "required": ["issue", "session_id"],
        },
        "handler": tool_record_session,
    },
    {
        "name": "record_handoff",
        "description": "记录「交接任务」详情到该任务（handoff 字段）。只写本地 SQLite，不碰 GitHub。"
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
        "description": "任务完成后清空 session_id / session_agent 字段（保留 session_at 审计）。只写本地 SQLite。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "issue": {"type": "string", "description": "issue 引用"},
            },
            "required": ["issue"],
        },
        "handler": tool_clear_session,
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


def read_message(stream):
    """读取一条 JSON-RPC 消息，返回 (msg, framing)。EOF 返回 (None, None)。

    MCP stdio 规范为换行分隔 JSON；LSP 风格 Content-Length 头作为历史兼容保留。
    首个有效字符判定分帧格式：`{` → NDJSON，否则 → Content-Length。
    """
    # 跳过消息间空行，用首行首字符判定分帧格式
    while True:
        line = stream.readline()
        if not line:
            return None, None
        if isinstance(line, bytes):
            line = line.decode("utf-8", "replace")
        if line.strip():
            break

    if line.lstrip().startswith("{"):
        try:
            return json.loads(line), NDJSON
        except ValueError as e:
            print("[taskboard-mcp] NDJSON 解析失败，跳过该行: %s" % e, file=sys.stderr)
            return None, None

    headers = {}
    while True:
        stripped = line.rstrip("\r\n")
        if stripped == "":
            break
        if ":" in stripped:
            k, v = stripped.split(":", 1)
            headers[k.strip().lower()] = v.strip()
        line = stream.readline()
        if not line:
            return None, None
        if isinstance(line, bytes):
            line = line.decode("utf-8", "replace")

    try:
        length = int(headers.get("content-length", "0"))
    except ValueError:
        length = 0
    if length <= 0:
        return None, None
    body = stream.read(length)
    if isinstance(body, bytes):
        body = body.decode("utf-8", "replace")
    return json.loads(body), CONTENT_LENGTH


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
                "serverInfo": {"name": "taskboard", "version": "0.3.47"},
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
        try:
            msg, framing = read_message(istream)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"[taskboard-mcp] 读取消息失败: {e}\n")
            break
        if msg is None:
            break
        try:
            resp = handle(msg)
        except Exception as e:  # noqa: BLE001
            sys.stderr.write(f"[taskboard-mcp] 处理异常: {e}\n")
            resp = None
        if resp is not None:
            write_message(ostream, resp, framing)
        handled += 1
    if handled == 0:
        sys.stderr.write(
            "[taskboard-mcp] 未收到任何有效 JSON-RPC 消息即断开——请检查客户端分帧格式\n"
        )


if __name__ == "__main__":
    main()
