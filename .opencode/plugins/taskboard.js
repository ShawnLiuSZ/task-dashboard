// TaskBoard 看板插件（issue #177）—— opencode 原生 hook，零依赖（不 import 任何包）。
//
// 职责（只补“调用方才知道”的参数，不写 DB）：
// 1. `session.created`：记住本次会话 id（多路径兼容提取，payload 形状不同版本有差异）。
// 2. `tool.execute.before`：taskboard 的 record_session 缺 session_id/agent/branch 时自动填
//    （session_id 用真实会话 id 覆盖模型编造值；branch 用 git 取，取不到不写）。
// 3. `shell.env`：向 shell 执行注入 TASKBOARD_SESSION_ID。
//
// 写库仍走 MCP 工具（与 Claude 侧 `.claude/` 设计同构：hooks 只注上下文/补参，不写库）。
// MCP 工具在 opencode 里以 `<server>_<tool>` 注册（如 taskboard_record_session），
// 为兼容用户改 server 名，这里按后缀匹配。

let sessionId = "";
let repoDir = "";

// session.created 的 payload 形状跨版本不稳定，多路径尽力提取。
function pickSessionId(event) {
  if (!event || typeof event !== "object") return "";
  const props = event.properties && typeof event.properties === "object" ? event.properties : {};
  const candidates = [
    event.sessionID,
    event.sessionId,
    event.session_id,
    props.sessionID,
    props.sessionId,
    props.session_id,
    props.id,
    event.id,
  ];
  if (props.session && typeof props.session === "object") {
    candidates.push(props.session.id, props.session.sessionID);
  }
  if (event.session && typeof event.session === "object") {
    candidates.push(event.session.id, event.session.sessionID);
  }
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  return "";
}

function isRecordSessionTool(name) {
  return typeof name === "string" && /(^|_)record_session$/.test(name);
}

async function currentBranch($) {
  try {
    if (typeof $ !== "function") return "";
    const out = await $`git -C ${repoDir || "."} branch --show-current`.text();
    return (out || "").trim();
  } catch {
    return "";
  }
}

export const TaskboardPlugin = async ({ directory, $ }) => {
  if (typeof directory === "string" && directory) repoDir = directory;

  return {
    // 会话创建即记住 id，供后续补参 + shell env 使用。
    event: async ({ event }) => {
      if (event && event.type === "session.created") {
        const id = pickSessionId(event);
        if (id) sessionId = id;
      }
    },

    // record_session 调用前补参：session_id 用真实会话 id（覆盖编造值）；
    // agent 缺省 opencode；branch 缺省且 git 可取时填入。
    "tool.execute.before": async (input, output) => {
      if (!isRecordSessionTool(input && input.tool)) return;
      const args = (output && output.args) || {};
      if (sessionId) args.session_id = sessionId;
      if (!args.session_id && typeof args.sessionId === "string" && args.sessionId.trim()) {
        args.session_id = args.sessionId.trim();
      }
      if (!args.agent || !String(args.agent).trim()) args.agent = "opencode";
      if ((!args.branch || !String(args.branch).trim()) && $) {
        const br = await currentBranch($);
        if (br) args.branch = br;
      }
    },

    // shell 执行可见本次会话 id（命令/脚本里可用 $TASKBOARD_SESSION_ID）。
    "shell.env": async (_input, output) => {
      if (sessionId && output && output.env) {
        output.env.TASKBOARD_SESSION_ID = sessionId;
      }
    },
  };
};
