// TaskBoard 看板插件（issue #177）—— opencode 原生 hook，仅用运行自带能力
// （Bun/Node 内建，不引任何 npm 包）。
//
// 职责（只补“调用方才知道”的参数，不写 DB —— 自动执行除外）：
// 1. `session.created`：记住本次会话 id（多路径兼容提取，payload 形状不同版本有差异）。
// 2. `tool.execute.before`：taskboard 的 record_session 缺 session_id/agent/branch 时自动填
//    （session_id 用真实会话 id 覆盖模型编造值；branch 用 git 取，取不到不写）。
// 3. `shell.env`：向 shell 执行注入 TASKBOARD_SESSION_ID。
// 4. 自动执行（clawd-on-desk agents 式事件驱动：事件 hook → 直接调本地后端，
//    只是我们不经过 HTTP，用 `taskboard mcp` 子命令一-shot 直写同一 SQLite）：
//    当前用户消息中出现**唯一未触发** issue 引用（repo#num / owner/repo#num / GitHub issue URL）
//    时，自动完成 update_task_status(处理中) + record_session，无需手动 /task-start。
//    （#204：按当前消息判定，历史引用不再抑制——单窗口多任务可依次自动执行。）
//    零条或多条引用 → 不动作（回退手动）；不在看板 → get_task_status 不存在则跳过；
//    done/processed → 不回退；doing 且已有 session → 视为已接管。同 (session, issue)
//    只自动执行一次（成功后才标记，失败可重试）。
//
// 写库仍走 MCP 工具（与 Claude 侧 `.claude/` 设计同构：hooks 只注上下文/补参，不写库）
// —— 自动执行是唯一的例外，且走的仍是同一 MCP 后端（`taskboard mcp` 子进程）。
// MCP 工具在 opencode 里以 `<server>_<tool>` 注册（如 taskboard_record_session），
// 为兼容用户改 server 名，这里按后缀匹配。

let sessionId = "";
let repoDir = "";
// 已自动执行过的 "sessionId|issueKey"，防重复触发（进程级，opencode 重启即清）。
const autoFired = new Set();
// 用户文本 part 的累计缓冲（按 session）：分片兜底时取尾部 40 字重叠再扫。
const partBuf = new Map();

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
  // message 系事件里 session id 藏得更深
  const info = props.info && typeof props.info === "object" ? props.info : {};
  candidates.push(info.sessionID, info.sessionId, props.sessionID);
  if (props.part && typeof props.part === "object") {
    candidates.push(props.part.sessionID, props.part.sessionId);
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

// ---------------- 自动执行 ----------------

// GitHub issue URL：https://github.com/{owner}/{repo}/issues/{n}
const ISSUE_URL_RE = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/issues\/(\d+)/g;
// repo#num（含 owner/repo#num）：左边界为空白/括号/引号/行首，右边界为非数字。
// 注：纯 "#123" 无 repo 无法归一化，直接忽略。
const ISSUE_REF_RE = /(?:^|[\s(（\["'/])((?:[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+)#(\d+)(?!\d)/g;

/// 从文本中提取归一化后的 issueKey（`repo#num`，与 mcp.rs::parse_issue_ref 同规则：
/// owner/repo#num 取最后一段为 repo）。返回去重后的数组。
function extractIssueRefs(text) {
  const out = [];
  const seen = new Set();
  if (typeof text !== "string" || !text) return out;
  let m;
  ISSUE_URL_RE.lastIndex = 0;
  while ((m = ISSUE_URL_RE.exec(text)) !== null) {
    const key = `${m[2]}#${parseInt(m[3], 10)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  ISSUE_REF_RE.lastIndex = 0;
  while ((m = ISSUE_REF_RE.exec(text)) !== null) {
    const repo = m[1].split("/").pop();
    const key = `${repo}#${parseInt(m[2], 10)}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(key);
    }
  }
  return out;
}

/// 从 message 系事件中尽力取出用户文本（多路径防御；非用户消息返回 ""）。
function userTextOf(event) {
  const props = (event && event.properties && typeof event.properties === "object") ? event.properties : {};
  const info = (props.info && typeof props.info === "object") ? props.info : {};
  const role = info.role || props.role || (props.part && props.part.role) || "";
  if (role !== "user") return "";
  const texts = [];
  for (const c of [info.content, props.content, props.text]) {
    if (typeof c === "string" && c.trim()) texts.push(c);
  }
  const parts = props.parts || info.parts || [];
  if (Array.isArray(parts)) {
    for (const part of parts) {
      if (part && typeof part.text === "string" && part.text.trim()) texts.push(part.text);
    }
  }
  if (props.part && typeof props.part.text === "string" && props.part.text.trim()) {
    texts.push(props.part.text);
  }
  return texts.join("\n");
}

/// 定位 taskboard 二进制：TASKBOARD_BIN → 默认安装位 → PATH。找不到返回 ""。
async function resolveBin($) {
  const manual = ((typeof process !== "undefined" && process.env && process.env.TASKBOARD_BIN) || "").trim();
  const cands = [manual, "/Applications/TaskBoard.app/Contents/MacOS/taskboard"];
  for (const c of cands) {
    if (!c) continue;
    try {
      await $`test -x ${c}`;
      return c;
    } catch {
      // 继续下一个候选
    }
  }
  try {
    if (typeof $ !== "function") return "";
    const w = (await $`command -v taskboard`.text() || "").trim().split("\n")[0].trim();
    return w || "";
  } catch {
    return "";
  }
}

/// 同步 spawn `taskboard mcp` 并把 NDJSON 经 stdin 喂入，返回 stdout 文本。
/// 发不出事件才抛错（调用方记 warn 日志后吞掉，不影响 agent 主流程）。
function spawnMcp(bin, input) {
  // 子进程必须继承宿主 env（TASKBOARD_DB 覆盖、代理等）；Bun spawnSync 默认
  // 不继承，必须显式传（实测不传会落到默认库，曾误写生产库）。
  const env = {};
  try {
    if (typeof process !== "undefined" && process && process.env) Object.assign(env, process.env);
  } catch { /* ignore */ }
  try {
    if (typeof Bun !== "undefined" && Bun && Bun.env) Object.assign(env, Bun.env);
  } catch { /* ignore */ }
  // Bun（CLI / TUI）
  try {
    if (typeof Bun !== "undefined" && Bun && typeof Bun.spawnSync === "function") {
      const r = Bun.spawnSync([bin, "mcp"], {
        stdin: Buffer.from(input, "utf8"),
        stdout: "pipe",
        stderr: "pipe",
        env,
      });
      if (r.exitCode !== 0) {
        const err = Buffer.from(r.stderr || []).toString("utf8").trim();
        throw new Error(err || `exit ${r.exitCode}`);
      }
      return Promise.resolve(Buffer.from(r.stdout || []).toString("utf8"));
    }
  } catch (e) {
    return Promise.reject(e);
  }
  // Node（Desktop 等）：动态 import 内建模块，不算 npm 依赖（env 默认继承）
  return import("node:child_process").then((cp) => {
    const r = cp.spawnSync(bin, ["mcp"], { input, encoding: "utf8", env });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error((r.stderr || "").trim() || `exit ${r.status}`);
    return r.stdout || "";
  });
}

/// 一次 spawn 完成多次 tools/call（NDJSON 进，逐行 JSON 出）。
/// opencode 宿主可能是 Bun（CLI/TUI）或 Node（Desktop），两种都走运行自带能力，
/// 不引 npm 包：优先 Bun.spawnSync，退回 node:child_process（动态 import）。
/// 返回按 id 顺序的 [{ data } | { error }]（data 为工具返回 JSON，已 parse）。
async function mcpCall(bin, calls) {
  const lines = calls.map((c, i) =>
    JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "tools/call", params: { name: c.name, arguments: c.args } }),
  );
  const raw = await spawnMcp(bin, lines.join("\n") + "\n");
  const byId = new Map();
  for (const line of (raw || "").split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const msg = JSON.parse(t);
      byId.set(msg.id, msg);
    } catch {
      // 非 JSON 行忽略
    }
  }
  return calls.map((_, i) => {
    const msg = byId.get(i + 1);
    if (!msg) return { error: "无响应" };
    const text = (msg.result && msg.result.content && msg.result.content[0] && msg.result.content[0].text) || "";
    if (msg.result && msg.result.isError) return { error: text.replace(/^错误：/, "") || "未知错误" };
    try {
      return { data: JSON.parse(text) };
    } catch {
      return { data: text };
    }
  });
}

async function applog(client, level, message) {
  try {
    if (client && client.app && typeof client.app.log === "function") {
      await client.app.log({ body: { service: "taskboard", level, message } });
    }
  } catch {
    // 日志失败不影响主流程
  }
}

/// 自动开始：唯一引用 + 看板存在 + todo → 置处理中 + 记 session。
/// #191：成功后才记去重（失败可重试）；两路调用结果都检查；done/processed 不回退。
async function autoStart(ctx, issueKey) {
  const { $, client } = ctx;
  const sid = sessionId;
  if (!sid) return;
  const dedup = `${sid}|${issueKey}`;
  if (autoFired.has(dedup)) return;
  const bin = await resolveBin($);
  if (!bin) {
    await applog(client, "debug", `[taskboard] 自动执行跳过：找不到 taskboard 二进制（${issueKey}），请手动 /task-start`);
    return;
  }
  try {
    const [got] = await mcpCall(bin, [{ name: "get_task_status", args: { issue: issueKey } }]);
    if (got.error || !got.data || got.data.found !== true) return; // 不在看板 → 温和跳过（允许重试）
    if (got.data.status === "done" || got.data.status === "processed") return; // 已完成/已处理不回退
    if (got.data.status === "doing" && got.data.session_id) {
      autoFired.add(dedup); // 已在处理中且有 session：视为已接管，不再重复写
      return;
    }
    const branch = await currentBranch($);
    const [upd, rec] = await mcpCall(bin, [
      { name: "update_task_status", args: { issue: issueKey, status: "doing" } },
      { name: "record_session", args: { issue: issueKey, session_id: sid, agent: "opencode", branch } },
    ]);
    if (upd.error || rec.error) {
      await applog(client, "warn", `[taskboard] 自动执行失败 ${issueKey}：${upd.error || rec.error}（可重试）`);
      return;
    }
    autoFired.add(dedup); // 成功后才标记
    await applog(client, "info", `[taskboard] 已自动开始 ${issueKey}（处理中，分支 ${branch || "未知"}）`);
  } catch (e) {
    await applog(client, "warn", `[taskboard] 自动执行异常 ${issueKey}：${(e && e.message) || e}（可重试）`);
  }
}

export const TaskboardPlugin = async ({ directory, $, client }) => {
  if (typeof directory === "string" && directory) repoDir = directory;
  const ctx = { $, client };

  return {
    // 会话创建即记住 id，供后续补参 + shell env + 自动执行使用。
    event: async ({ event }) => {
      if (!event || typeof event !== "object") return;
      if (event.type === "session.created") {
        const id = pickSessionId(event);
        if (id) sessionId = id;
        return;
      }
      // message 系事件：跟进 session id + 当前消息扫 issue 引用
      // #204：按当前消息判定（历史引用不再抑制新任务，单窗口多任务可依次自动执行）；
      // 当前无引用时用上条尾部 40 字 + 当前文本再扫一次（分片切断 token 兜底）。
      if (event.type === "message.updated" || event.type === "message.part.updated") {
        const sid = pickSessionId(event);
        if (sid) sessionId = sid;
        if (!sessionId) return;
        const text = userTextOf(event);
        if (!text) return;
        const prev = partBuf.get(sessionId) || "";
        partBuf.set(sessionId, (prev + "\n" + text).slice(-4000));
        const unfired = (keys) => keys.filter((k) => !autoFired.has(`${sessionId}|${k}`));
        // 当前消息恰好一个未触发引用 → 自动执行；多条无法消歧（回退手动）
        const cur = unfired(extractIssueRefs(text));
        if (cur.length === 1) {
          await autoStart(ctx, cur[0]);
          return;
        }
        if (cur.length > 1) return;
        // 当前 0 引用：分片可能切断 token，尾部重叠再扫一次
        const tail = unfired(extractIssueRefs((prev.slice(-40) + "\n" + text).slice(-4000)));
        if (tail.length === 1) {
          await autoStart(ctx, tail[0]);
        }
        return;
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
