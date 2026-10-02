# #345 MCP 分帧健壮性只修了 Rust 侧，Python 兜底一行坏数据即终止进程

> 对应 issue：[#345](https://github.com/ShawnLiuSZ/task-dashboard/issues/345)
>
> 分支：`fix/issue-345-python-mcp-framing`
>
> 类别：Python MCP Server（stdio 分帧 / 进程健壮性）

## 背景 / 动机

一次跨模块深度 code review 发现：**Python MCP Server 进程被一行坏数据整个终止**，客户端 agent 侧表现为随机 `connection closed`。

触发条件（任一）：

- 一个 `Content-Length` body 是非法 JSON
- 一个超大 / 缺失的 `Content-Length`
- 客户端写入被截断（落到半截 JSON 行）

这正是 #328 在 Rust 侧声称修好的症状（`mcp.rs:750-753` 明确写着「客户端发 UTF-8 BOM、写入被截断…agent 侧就会随机看到 connection closed」）—— **但当时只修了 Rust 侧**。

TaskBoard 的 MCP 有两份实现：Rust `mcp.rs`（随 app 二进制打包，正式路径）与 Python `mcp_server/server.py`（便携 / 开发兜底）。二者必须行为一致。

## 设计 / 方案

### 根因：畸形与 EOF 被折叠成同一个返回值

Rust 侧 #328 已改为四态 `ReadOutcome`，畸形帧 `continue` 而非退出（`mcp.rs:806/854/912`）。Python 侧未同步：

```python
# 旧：NDJSON 解析失败
except ValueError as e:
    print("...跳过该行: %s" % e, file=sys.stderr)
    return None, None            # ← 与 EOF 同形

# 旧：Content-Length body
body = stream.read(length)
return json.loads(body), CONTENT_LENGTH   # ← 未包 try，异常上抛

# 旧：主循环
msg, framing = read_message(istream)
if msg is None:
    break                      # ← 畸形帧 == 退出进程
```

`main()` 的 `except Exception` 会吞掉 `json.JSONDecodeError` 再 `break`，效果相同。

实测驱动真实模块（旧形态）：

```
1 畸形 NDJSON 后跟合法 NDJSON:  messages_read=0
2 合法 CL + 畸形 CL body:       RAISED JSONDecodeError
5 超大 Content-Length:           RAISED JSONDecodeError
```

### 修法：移植 Rust 侧的四态 `ReadOutcome`

```
MSG       有效消息            → 处理并写响应
EOF       流正常结束          → break
MALFORMED 本帧已完整消费      → 记日志后 continue（丢弃该帧继续服务）
FATAL     帧边界已无法确定    → break（body 未消费，继续读只会错位）
```

关键区分是 **`MALFORMED` vs `FATAL`** —— 二者都「不能处理这条消息」，但只有 `MALFORMED` 能安全继续读：

| 情况 | 帧是否已完整消费 | 判定 |
|---|---|---|
| NDJSON 行 JSON 畸形 | 是（`readline` 读到换行） | `MALFORMED` ⇒ continue |
| Content-Length body JSON 畸形 | 是（已 `read(n)`） | `MALFORMED` ⇒ continue |
| 头正常收尾但缺 / 不可解析 `Content-Length` | 边界已知 | `MALFORMED` ⇒ continue |
| body 被截断 | — | `EOF` |
| `Content-Length` ≤ 0 或 > 8 MiB | **否**（body 未消费） | `FATAL` ⇒ break |
| 头部超 8 KiB 仍不终止 | 边界未知 | `FATAL` ⇒ break |

### 一并补上的两个 DoS 上限

Rust 侧 #328 已有的上限，Python 侧原本**完全没有**：

- `MAX_FRAME_BODY = 8 MiB`：`Content-Length: 99999999999` 原本会让 Python 尝试分配该长度（`stream.read` 行为虽不同于 Rust 的 `vec![0u8; len]` abort，但仍属无效声明）。
- `MAX_FRAME_HEADER = 8 KiB`：只发头、始终不给 `\r\n\r\n` 时头部缓冲无界增长。
- **NDJSON 分支原本连长度上限都没有** —— 客户端发一条无终止符的长行会让长驻进程的堆无界增长。这是与 #328 同类的 DoS，本次补齐（Rust 侧同样缺此项，见「遗留边界」）。

### 刻意不改的行为：分帧仍靠首字符判定

首字符是 `{` → NDJSON，否则 → Content-Length 头路径。因此**非 `{` 开头的行**（混入日志、UTF-8 BOM）会进入头解析路径并最终 EOF。这与 Rust 侧**完全一致**，属格式判定的既有设计，本次不动 —— 并用 `test_framing_is_decided_by_first_char` 把它显式钉住，避免后人误当成「畸形帧」来「修」。

## 接口 / 行为变更

- `read_message` 返回值由 `tuple | (None, None)` 改为 `ReadOutcome` 对象（`server.py` 内部函数，非对外 API）。
- **行为修复**：畸形帧不再终止进程；越界帧长度 / 不终止头部明确终止并给出原因日志。
- **无 schema / MCP 工具签名（工具清单与参数不变）/ i18n key 变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

`mcp_server/test_server.py` 新增 `class FramingTests`（**14 例**，36 → 50 → 53）。此前该文件**没有任何用例触碰 `read_message` / `main`**。

- **11 例驱动真实 `read_message`**（不 mock）：两种分帧的正常路径各 1 例（防回归）、畸形 NDJSON 后继续、BOM/非 `{` 开头的既有行为、坏 CL body 后继续、缺失 / 不可解析 `Content-Length`、超大与零长度 `Content-Length`、截断 body、头不终止、头超上限、超长 NDJSON 行、空流。
- **3 例端到端驱动 `main()`**（桩掉 stdin/stdout，不触网）：`_run_main()` 返回写出的响应列表 ——
  - `test_main_keeps_serving_after_malformed_frame`：畸形帧后**必须仍处理后续合法消息**（断言响应数 == 1 且 id == 2）
  - `test_main_survives_repeated_malformed_frames`：连续多条畸形帧不得终止
  - `test_main_malformed_only_still_exits_cleanly`：全畸形时退出且不写垃圾

**为什么必须有 `main()` 端到端用例**：缺陷的**症状（进程退出）由 `main()` 的循环决定，不是 `read_message` 的分类决定**。只测分类会漏掉「分类改对了但循环仍然 `break`」这种半修状态 —— 这正是首次反向验证时暴露的真实缺口（当时只回退了分类层，用例全绿）。

**反向验证（两层独立回退，各自必失败）**：

| 回退 | 失败用例 |
|---|---|
| `main()` 对 `MALFORMED` 改回 `break` | `main_keeps_serving_after_malformed_frame`、`main_survives_repeated_malformed_frames` |
| `MALFORMED` 分类改回折叠成 `EOF` | 上述 2 例 + `malformed_ndjson_then_valid_is_continued` |

恢复修复后 53 passed（`OK`）。

已跑：`python3 -m unittest discover -s mcp_server` 53 passed、`scripts/check-mcp-columns.py`、`check-versions.py`、`check-doc-links.py`。

## 遗留边界（刻意未改，记录备查）

1. **Rust 侧 NDJSON 分支同样没有单帧长度上限**（`mcp.rs` 只有 `MAX_FRAME_HEADER` 用于头路径）。本次只补了 Python 侧；两侧对齐应作为独立议题。
2. **分帧判定靠首字符**，故 BOM / 混入日志会走错路径并 EOF。属两侧共有的既有设计，改动需同时动两侧并考虑兼容性。
3. `serverInfo.version` 仍硬编码 `"0.6.1"`（Rust 侧用 `env!("CARGO_PKG_VERSION")` = 0.6.5），且 `check-versions.py` 未覆盖该文件。

## 相关链接

- Issue：[#345](https://github.com/ShawnLiuSZ/task-dashboard/issues/345)
- 前序改动（只修 Rust 侧）：#328（见 [`docs/issue-328-p1-data-safety.md`](./issue-328-p1-data-safety.md)）
- 两侧对照：[`app/src-tauri/src/mcp.rs`](../app/src-tauri/src/mcp.rs)（`ReadOutcome`）↔ [`mcp_server/server.py`](../mcp_server/server.py)
- MCP 工具契约：[`mcp_server/AGENT_INSTRUCTIONS.md`](../mcp_server/AGENT_INSTRUCTIONS.md)
- 深度 review 中发现的其余 7 个缺陷：#339 / #340 / #341 / #342 / #343 / #344 / #346
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)