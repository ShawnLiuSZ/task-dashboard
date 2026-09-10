#!/bin/bash
# TaskBoard UserPromptSubmit 轻提醒 — issue #177
#
# 只有当用户 prompt 疑似指向某个 GitHub issue（repo#num / owner/repo#num /
# github.com/.../issues|pull/N）时，才注入一句提醒；否则静默退出（exit 0
# 且无输出），避免每个 prompt 都骚扰模型。
#
# 零第三方依赖：bash + python3（stdlib）。

set -u

INPUT=$(cat)
MATCH=$(printf '%s' "$INPUT" | python3 -c 'import json,sys,re
try:
  d = json.load(sys.stdin)
except Exception:
  print("")
  sys.exit(0)
p = d.get("prompt","") or ""
pat = r"(github\.com/[^/\s]+/[^/\s#]+/(issues|pull)/\d+)|(\b[A-Za-z0-9_.\-]+#[1-9]\d*\b)|(\b[A-Za-z0-9_.\-]+/[A-Za-z0-9_.\-]+#[1-9]\d*\b)"
print("yes" if re.search(pat, p) else "")')

if [ "$MATCH" != "yes" ]; then
  exit 0
fi

python3 - <<'EOF'
import json
ctx = ("[TaskBoard 看板提醒] 本 prompt 疑似指向某个 GitHub issue："
       "开始前先用 MCP get_task_status 查现状，然后 /task-start <repo#num> "
       "（自动完成 update_task_status→处理中 + record_session 含分支）；"
       "完工 /task-done，中途交接 /task-handoff。只写本地 SQLite，不碰 GitHub。")
print(json.dumps({"hookSpecificOutput": {"hookEventName": "UserPromptSubmit", "additionalContext": ctx}}, ensure_ascii=False))
EOF
