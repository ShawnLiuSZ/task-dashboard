# #357 `mcp.rs` 分帧与参数解析仍有三处缺口

> 对应 issue：[#357](https://github.com/ShawnLiuSZ/task-dashboard/issues/357)
>
> 分支：`fix/issue-357-mcp-framing-and-args`
>
> 类别：Rust 后端 / 内置 MCP Server（stdio 分帧 / 参数校验）

## 背景 / 动机

#345 修复了 **Python 侧** MCP 的分帧健壮性，并指出「Rust 侧 NDJSON 分支同样没有单帧长度上限，两侧对齐宜作独立议题」。本 issue 就是那个议题，同时补上 Rust 侧另外两处缺口。

## 设计 / 方案

三处独立缺陷，其中第 3 条影响最直接。

### 缺口 1：`Content-Length` 缺失/不可解析误判为 `Malformed`

```rust
// 修复前
// 头部正常收尾但缺 Content-Length：帧边界（头部结束处）已确定，可继续读下一条。
let Some(len) = content_length else {
    return ReadOutcome::Malformed("Content-Length 头缺失或不可解析".to_string());
};
```

**原注释的推理是错的**：「头部结束处」恰恰**就是正文的首字节** —— 缺 `Content-Length` 意味着**正文长度未知、流位置并未确定**。判 `Malformed` 后主循环 `continue`，后续读取会把**正文字节当头部解析**，产出更多垃圾帧。

值得注意：同一个函数里紧接着的 `len == 0` 分支**已经正确判 `Fatal`**（注释：「body 尚未消费，继续读会立刻错位」）。两处口径不一致，本次统一为 `Fatal`。

### 缺口 2：NDJSON 分支无单帧长度上限

`#328` 引入 `MAX_FRAME_BODY`（8 MiB）时只覆盖了 `Content-Length` 分支 —— NDJSON 分支的 `line` 仍是 `line.push(byte[0])` **无界增长**。客户端发一条**无终止符**的长行即可让长驻 MCP 进程的堆无界增长，与 #328 修掉的 `Content-Length: 99999999999` 属**同一类 DoS**。

补上 `line.len() > MAX_FRAME_BODY ⇒ Fatal`（超限时找不到帧边界，无法安全继续）。

### 缺口 3：非字符串参数被静默丢弃（影响最直接）

```rust
// 修复前
let get = |k: &str| -> Option<String> {
    args.get(k).and_then(|v| v.as_str()).map(|s| s.to_string())
};
```

`as_str()` 对 `Value::Number(123)` 返回 `None` ⇒ 过滤器被**静默丢弃**：

```
list_my_tasks({status: 123})  →  返回整块看板，isError: false
```

而 Python 兜底侧同一输入**正确报错**（`非法状态: 123`）。即**同一个 agent 输入，正式路径给错数据、兜底路径给错误** —— 后者至少让 agent 知道出错了。

修法：两个取值器都校验类型（新增 `json_type_name` 生成可读类型名）：

- `get_req(k)` —— 必填：缺失报「缺少 X 参数」，**非字符串报类型错误**（不退化成「缺少参数」）
- `get_opt(k)` —— 可选：**类型错误同样报错**（关键：可选 ≠ 「类型错误等于不传」；这正是 `list_my_tasks` 那条的漏网之处）

## 接口 / 行为变更

- **MCP 行为修复**：非法长度 / 缺 `Content-Length` / 超长 NDJSON 行现在终止并给出明确原因（此前：错位解析或堆无界增长）。
- **MCP 行为修复**：非字符串参数返回 `isError: true` + 可读的类型错误（此前静默接受并返回错误数据）。
- **两侧行为对齐**：参数类型校验与分帧语义现在与 Python 兜底侧一致。
- **无 schema / MCP 工具签名（工具清单与参数不变）/ i18n key 变更**。

## 数据 / Schema 变更

无。

## 测试 / 验收

`app/src-tauri/src/mcp.rs` 新增 5 例（分帧 3 + 参数 2）：

| 用例 | 覆盖 |
|---|---|
| `read_message_missing_content_length_is_fatal` | 三种形态（无 CL 头 / 值不可解析 / 空值）均判 `Fatal` |
| `read_message_caps_ndjson_line_size` | 永不换行的超长 `{` 行判 `Fatal` |
| `read_message_accepts_large_but_legal_ndjson` | **64 KiB 正常消息仍正常解析**（防上限误伤） |
| `non_string_args_are_rejected` | `list_my_tasks({status:123})` 与 `get_task_status({issue:true})` 报类型错误；且断言**必填参数报的是类型错误而非「缺少参数」** |
| `string_args_still_accepted` | 合法字符串参数与缺省参数均不被误伤 |

**反向验证（三处子修复各自独立验证）**：

| 回退 | 结果 |
|---|---|
| `Content-Length` 缺失改回 `Malformed` | `read_message_missing_content_length_is_fatal` FAILED |
| 删掉 NDJSON 长度上限判断 | `read_message_caps_ndjson_line_size` FAILED |
| `get_opt` 改回 `and_then(as_str)` | `non_string_args_are_rejected` FAILED |

恢复后 155 passed。

> 测试过程中曾有一处真实发现：首版修复只给 `get_req` 加了校验、`get_opt` 仍静默丢弃，**`non_string_args_are_rejected` 当场打红** —— 这正是 `list_my_tasks` 的漏网路径。补齐后通过。

已跑：`cargo test --lib` 155 passed（152 → +3）、`cargo fmt --check`、`cargo clippy --lib -- -D warnings`。

## 相关链接

- Issue：[#357](https://github.com/ShawnLiuSZ/task-dashboard/issues/357)
- 前序：[#345](./issue-345-python-mcp-framing.md)（Python 侧同一批问题）、[`docs/issue-328-p1-data-safety.md`](./issue-328-p1-data-safety.md)（Rust 侧四态 + `MAX_FRAME_BODY`）
- 源文件：[`app/src-tauri/src/mcp.rs`](../app/src-tauri/src/mcp.rs)
- 本批其余项见 [`docs/CHANGELOG.md`](./CHANGELOG.md) 的「深度 code review 批次（第二批）」块（#355 / #356 / #358 / #359）
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)