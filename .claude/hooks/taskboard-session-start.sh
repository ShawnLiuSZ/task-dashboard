#!/bin/bash
# TaskBoard SessionStart hook — issue #177
#
# 职责（只做两件事，不写 DB）：
# 1. 把 hook input 的 session_id 持久化到 $CLAUDE_ENV_FILE，供后续 Bash 取用
#    （$TASKBOARD_SESSION_ID；slash command 里也可用 ${CLAUDE_SESSION_ID}）。
# 2. 向 Claude 注入 additionalContext：本次会话 id + 看板触发规则摘要。
#
# 设计说明：
# - SessionStart 通常在 MCP 服务器连上之前触发，所以这里不调 MCP 工具，
#   只注入上下文，真正的 update_task_status / record_session 由 agent
#   通过 MCP 工具（或 /task-start）完成。
# - 零第三方依赖：只用 bash + python3（stdlib），不用 jq。

set -u

INPUT=$(cat)
SESSION_ID=$(printf '%s' "$INPUT" | python3 -c 'import json,sys
try:
  print(json.load(sys.stdin).get("session_id",""))
except Exception:
  print("")')

# 1) 持久化到 CLAUDE_ENV_FILE（后续 Bash 可直接 $TASKBOARD_SESSION_ID）
if [ -n "${CLAUDE_ENV_FILE:-}" ] && [ -n "$SESSION_ID" ]; then
  printf 'TASKBOARD_SESSION_ID=%s\n' "$SESSION_ID" >> "$CLAUDE_ENV_FILE" 2>/dev/null || true
fi

# 2) 注入上下文（stdout 的 JSON 由 Claude Code 解析；纯文本也会被加入上下文）
python3 - "$SESSION_ID" <<'EOF'
import json, sys
sid = sys.argv[1] if len(sys.argv) > 1 else ""
ctx = (
    "[TaskBoard 看板] 本次 Claude Code 会话 id: %s\n"
    "（slash command 里可用 ${CLAUDE_SESSION_ID}；Bash 里可用 $TASKBOARD_SESSION_ID，二者同值。）\n"
    "开始处理某 GitHub issue 时必须先调 MCP：\n"
    "1) 用 Bash 工具执行 git branch --show-current 拿到当前工作分支（先执行、再传值，"
    "禁止把 $(...) 原样塞进 MCP 参数，MCP 不执行 shell）；\n"
    "2) update_task_status(issue, \"处理中\")；\n"
    "3) record_session(issue, session_id=\"%s\", agent=\"claude-code\", branch=\"<上一步的分支，可空>\")。\n"
    "快捷方式：直接执行 /task-start <repo#num>。完成时 /task-done，交接时 /task-handoff。"
    % (sid or "(未知)", sid or "(未知)")
)
print(json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}}, ensure_ascii=False))
EOF
