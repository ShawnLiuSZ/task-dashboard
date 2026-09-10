# MCP stdio 分帧格式错误 —— `Content-Length` 头 vs 换行分隔 JSON

> 通用知识条目。适用于「TaskBoard 内置 MCP server 接入 Claude Code 后 `connection timed out after 30000ms`，但服务端自测握手正常」的问题。
> **本文推翻了 [troubleshoot-mcp-timeout.md](./troubleshoot-mcp-timeout.md) 的结论**（该文把超时归因于 macOS Gatekeeper / quarantine）。真因是传输层分帧格式不符合 MCP 规范。

## 背景 / 动机

### 现象

Claude Code 连接内置 MCP server 时报：

```
Failed to reconnect to taskboard: MCP server taskboard connection timed out after 30000ms
```

配置无误：

```json
"taskboard": { "type": "stdio", "command": "/Applications/TaskBoard.app/Contents/MacOS/taskboard", "args": ["mcp"] }
```

### 定位过程

对 `/Applications/TaskBoard.app/Contents/MacOS/taskboard mcp`（v0.3.45）做两种格式的对照实验：

| 客户端发送格式 | 结果 |
|---|---|
| `{"jsonrpc":...}\n` 换行分隔（**MCP stdio 规范**，Claude Code 用这个） | **stdout 零字节，exit 0，进程立即退出** |
| `Content-Length: N\r\n\r\n{...}` LSP 风格 | 正常返回 `serverInfo: taskboard 0.3.45` + 11 个工具 |

### 根因

MCP 规范的 stdio 传输是**换行分隔 JSON（NDJSON）**：一条消息一行，消息体内禁止内嵌换行，**没有** header。而两份实现都用了 LSP 的 `Content-Length` 头分帧：

- `app/src-tauri/src/mcp.rs:624` `read_message()`：逐字节找 `\r\n\r\n` / `\n\n`，解析出 `Content-Length` 才继续
- `app/src-tauri/src/mcp.rs:657` `write_message()`：输出固定带 `Content-Length` 头
- `mcp_server/server.py:458`：同样的 LSP 分帧（注释即写明「LSP 风格 Content-Length 分帧」）——Rust 版是照 Python 版平移的，**错误自设计之初就存在，不是移植引入**

失败链条：

```
Claude Code 发 {"jsonrpc":...}\n
  → read_message 逐字节读，永远等不到 \r\n\r\n
  → 读到 EOF，返回 None
  → run() 的 `None => break`（mcp.rs:694）跳出循环
  → 进程静默 exit 0，stdout / stderr 均无输出
  → 客户端等不到 initialize 响应 → 30s 超时
```

### 为什么被误判成 Gatekeeper 长达两个 issue

`troubleshoot-mcp-timeout.md` 第 1 步「实测 server 握手耗时（排除 server 内因）」给的探针脚本**自身就用 Content-Length 分帧**，所以它每次都能拿到 `RTT=15ms` 的漂亮结果，从而"证明"服务端没问题、把矛头引向 quarantine。**探针与被测实现共享同一个错误假设，等于没测。**

补充排除项（本次已实测）：

- 可执行文件上的 `com.apple.quarantine` 已被 issue #101 的自动清除逻辑成功移除（`xattr -l` 只剩 `com.apple.provenance`），bundle 目录上残留的 quarantine 不影响直接 spawn 内层二进制。
- 进程 **exit 0** 而非被信号 kill，Gatekeeper 拦截可彻底排除。

## 设计 / 方案

### 决策：双格式自动识别，而非直接换成 NDJSON

单纯改成 NDJSON 会打断可能已在用 Content-Length 的调用方（WorkBuddy / Codex 等历史配置）。用**首个有效字节判定**即可零成本兼容：

- 首字节 `{` → NDJSON
- 否则 → 按 Content-Length 头解析

**响应必须回以与请求相同的分帧格式**，否则混用会再次错位。

### 改动 1：`app/src-tauri/src/mcp.rs`

新增分帧枚举，`read_message` 返回格式标记，`write_message` 接收格式参数：

```rust
/// stdio 分帧格式。MCP 规范为换行分隔 JSON；LSP 风格的 Content-Length 头作为历史兼容保留。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Framing {
    Ndjson,
    ContentLength,
}

/// 读取一条 JSON-RPC 消息，并返回它使用的分帧格式。EOF 返回 None。
/// 逐字节读取以避免 BufRead 缓冲与 read_exact 混用导致的数据错位。
fn read_message(r: &mut impl Read) -> Option<(Value, Framing)> {
    // 跳过消息之间的空白（换行 / 空行），首个有效字节用于判定分帧格式
    let mut first = [0u8; 1];
    loop {
        if r.read(&mut first).ok()? == 0 {
            return None; // EOF
        }
        if !first[0].is_ascii_whitespace() {
            break;
        }
    }

    // NDJSON：本行剩余部分即完整 JSON（规范禁止消息内嵌换行）
    if first[0] == b'{' {
        let mut line = vec![first[0]];
        let mut byte = [0u8; 1];
        loop {
            if r.read(&mut byte).ok()? == 0 {
                break; // 末行可能无换行结尾
            }
            if byte[0] == b'\n' {
                break;
            }
            line.push(byte[0]);
        }
        return match serde_json::from_slice(&line) {
            Ok(v) => Some((v, Framing::Ndjson)),
            Err(e) => {
                eprintln!("[taskboard-mcp] NDJSON 解析失败，跳过该行: {e}");
                None
            }
        };
    }

    // Content-Length 头：首字节已消费，需回填进头部缓冲
    let mut header_bytes: Vec<u8> = vec![first[0]];
    let mut content_length: Option<usize> = None;
    loop {
        let mut byte = [0u8; 1];
        if r.read(&mut byte).ok()? == 0 {
            return None; // EOF
        }
        header_bytes.push(byte[0]);
        if header_bytes.ends_with(b"\r\n\r\n") || header_bytes.ends_with(b"\n\n") {
            let header_str = String::from_utf8_lossy(&header_bytes);
            for line in header_str.split('\n') {
                if let Some((k, v)) = line.trim_end().split_once(':') {
                    if k.trim().eq_ignore_ascii_case("content-length") {
                        content_length = v.trim().parse().ok();
                    }
                }
            }
            break;
        }
    }
    let len = content_length?;
    if len == 0 {
        return None;
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).ok()?;
    serde_json::from_slice(&body)
        .ok()
        .map(|v| (v, Framing::ContentLength))
}

fn write_message(w: &mut impl Write, msg: &Value, framing: Framing) {
    let data = serde_json::to_vec(msg).unwrap_or_default();
    match framing {
        Framing::Ndjson => {
            let _ = w.write_all(&data);
            let _ = w.write_all(b"\n");
        }
        Framing::ContentLength => {
            let _ = w.write_all(format!("Content-Length: {}\r\n\r\n", data.len()).as_bytes());
            let _ = w.write_all(&data);
        }
    }
    let _ = w.flush();
}
```

`run()` 主循环（`mcp.rs:691`）随之改为：

```rust
    loop {
        let (msg, framing) = match read_message(&mut stdin) {
            Some(m) => m,
            None => break, // EOF：客户端断开
        };
        if let Some(resp) = handle(&conn, &msg) {
            write_message(&mut stdout, &resp, framing);
        }
    }
```

### 改动 2：`mcp_server/server.py`

同样逻辑。Python 版当前用 `stream.readline()` 读头，遇到裸 JSON 行时因为 JSON 里也有 `:` 会被当成 header 解析，最终同样落到 `return None`：

```python
NDJSON = "ndjson"
CONTENT_LENGTH = "content-length"


def read_message(stream):
    """读取一条 JSON-RPC 消息，返回 (msg, framing)。EOF 返回 (None, None)。

    MCP stdio 规范为换行分隔 JSON；LSP 风格 Content-Length 头作为历史兼容保留。
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
```

> 注意 `main()` 里的调用点要跟着改成解包 `(msg, framing)`，并把 `framing` 传给 `write_message`。

### 改动 3（关键）：静默退出改为带诊断退出

这个 bug 难查的直接原因是**失败路径完全无输出**：`read_message` 用 `Option` 把「EOF」和「解析失败」压成同一个 `None`，`run()` 一律 `break` 后 exit 0。

约束：**stdout 只能承载协议消息**，任何诊断信息必须走 stderr（MCP 客户端通常会把子进程 stderr 收进日志）。上面两份代码里的 `eprintln!` / `print(..., file=sys.stderr)` 就是为此。

建议再加一条：`run()` 循环退出前，若一条消息都没成功处理过，往 stderr 打一行提示，例如
`[taskboard-mcp] 未收到任何有效 JSON-RPC 消息即断开——请检查客户端分帧格式`。

## 接口 / 行为变更

- MCP stdio 传输层同时接受**换行分隔 JSON（新增，MCP 规范）** 与 `Content-Length` 头（保留兼容）；响应回以与请求相同的格式。
- Claude Code / Cursor 等标准 MCP 客户端从「必然 30s 超时」变为可正常握手。
- MCP **工具契约无变化**（11 个工具的名称、参数、返回结构均不变），`mcp_server/AGENT_INSTRUCTIONS.md` 无需改动。
- 失败路径新增 stderr 诊断输出，stdout 仍严格只输出协议消息。

## 数据 / Schema 变更

无。不涉及 SQLite schema 与迁移。

## 测试 / 验收

### 单元测试（`app/src-tauri/src/mcp.rs` 当前无 `#[cfg(test)]`，需新建）

| 用例 | 断言 |
|---|---|
| NDJSON 单条消息 | 返回 `(msg, Framing::Ndjson)` |
| NDJSON 连续两条 | 两次调用分别拿到两条，不错位 |
| NDJSON 末条无结尾换行 | 正常解析 |
| 消息间有空行 / `\r\n` | 被跳过，不影响解析 |
| `Content-Length` 消息 | 返回 `(msg, Framing::ContentLength)` |
| 两种格式混合流 | 各自按自身格式解析 |
| 畸形行（非法 JSON） | 不 panic，走 stderr 提示 |
| `write_message` round-trip | Ndjson 输出无 header 且以 `\n` 结尾；ContentLength 输出头部长度与 body 一致 |

### 端到端探针（**必须用 NDJSON，不要再用旧文档里的 Content-Length 脚本**）

```bash
cd app/src-tauri && cargo build --release
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"probe","version":"1"}}}' \
  '{"jsonrpc":"2.0","method":"notifications/initialized"}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | TASKBOARD_DB="$PWD/../../.probe.db" ./target/release/taskboard mcp
```

期望：两行 JSON 响应，第一行含 `"serverInfo":{"name":"taskboard",...}`，第二行含 11 个工具；**进程不再零输出 exit 0**。

反向回归（兼容性）：把 `printf` 换成 `Content-Length` 分帧，仍应正常返回。

### 客户端验收

1. 三处版本对齐后 `npm run tauri build`，替换 `/Applications/TaskBoard.app`。
2. Claude Code 执行 `/mcp`，`taskboard` 应显示 connected 且工具可列出。
3. 实调一次 `get_task_status` / `update_task_status`，确认读写命中与 GUI 同一份 DB。

## 需要同步修订的既有文档

| 文件 | 处理 |
|---|---|
| `docs/troubleshoot-mcp-timeout.md` | 顶部加「结论已更新」指向本文；第 1 步的探针脚本改为 NDJSON（现版本因分帧假设错误而给出误导性结论）；quarantine 降级为「次要候选」而非首要根因 |
| `docs/issue-101-quarantine-autoclear.md` | 自动清除逻辑本身有效、保留；补一句「本改动未能解决 #87 的超时，真因见本文」 |
| `docs/CHANGELOG.md` | 新版本条目：修复 MCP stdio 分帧不符合规范导致标准客户端握手超时 |

## 待清理项

上次排障遗留的探针进程仍在空转（子进程秒退 → `stdout.read(1)` 返回空 → 死循环）：

```
PID 68187  99.8% CPU  已累计 ~2442 分钟 CPU 时间
python3 -c "... subprocess.Popen(['.../dev/dashboard/app/src-tauri/target/release/taskboard','mcp'] ...)"
```

```bash
kill 68187
```

## 相关链接

- [Issue #87](https://github.com/ShawnLiuSZ/task-dashboard/issues/87)（原超时 issue，此前误判为 Gatekeeper）
- [Issue #101](https://github.com/ShawnLiuSZ/task-dashboard/issues/101) / [issue-101-quarantine-autoclear.md](./issue-101-quarantine-autoclear.md)
- [troubleshoot-mcp-timeout.md](./troubleshoot-mcp-timeout.md)（结论被本文修订）
- MCP 规范 stdio 传输：消息以换行分隔，消息体内禁止内嵌换行
- 代码位置：`app/src-tauri/src/mcp.rs:624`（read）/ `:657`（write）/ `:691`（主循环）、`mcp_server/server.py:458`
- MCP 工具契约：[mcp_server/AGENT_INSTRUCTIONS.md](../mcp_server/AGENT_INSTRUCTIONS.md)
