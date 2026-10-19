# #451 MCP 双实现对齐 / workflow 检查误报 / CI 盲区补齐

> 关联 issue：[#451](https://github.com/ShawnLiuSZ/task-dashboard/issues/451)
> 来源：`CODE-REVIEW-2026-10-19.md`（2026-10-19 全量代码 Bug 审查）中危-3、中危-4、低危-5、低危-6、低危-7
> 基线：`main` @ `v0.7.3`
> 分支：`fix/issue-451-mcp-scripts`

## 一、背景 / 动机

全量审查中落在 `mcp_server/` 与 `scripts/` 的 5 项缺陷，性质分两类：

| 类别 | 项 | 共同点 |
|---|---|---|
| **双实现分歧** | 中危-4（Content-Length 语义）、低危-5（NDJSON 上限） | Rust 与 Python 两套 MCP 实现行为不一致，违反 AGENTS.md §8.6 |
| **CI 失守** | 中危-3（workflow 误报）、低危-6（写入列不比对）、低危-7（无单测） | 检查器自身的缺陷或盲区 —— 它们本该拦住别的缺陷，却自己先失效 |

> ⚠️ 第二类是**自我失效**的检查器，比它要抓的缺陷更值得优先处理：失效是静默的
> （不报错、只是不再报警），而误报会让每个 PR 的 CI 都红。

## 二、设计 / 方案

### 2.1 中危-4：缺 Content-Length 应判 FATAL

Python 侧原实现返回 `MALFORMED`（主循环继续读），注释称「头部已正常收尾 ⇒ 帧边界已知，
丢弃后继续读下一条是安全的」。**该推理是错的**：缺 `Content-Length` 恰恰说明
**正文长度未知** —— 头部结束处就是正文的首字节，流位置并未确定。按 `Malformed`
继续读，后续读取会把正文字节当头部解析，产出更多垃圾帧。

Rust 侧在 **#357** 已修正为 `Fatal`，并在 `mcp.rs:889-894` 写清了理由。
Python 侧一直没跟上，且 `test_server.py:803` 用
`test_missing_content_length_is_malformed` **把偏离行为断言为正确**。

**方案**：Python 改为 `ReadOutcome.fatal(...)`，同步改两条测试断言
（`test_missing_content_length_is_malformed` / `test_unparseable_content_length_is_fatal`
同时改名，`malformed` → `fatal`，并断言 `len(outs) == 1` 即「Fatal 后不得再继续读」）。

**注**：越界长度与 `= 0` 两个分支两实现早已一致判 FATAL（#345 / #357），本次只修
「缺失 / 不可解析」这一支。

### 2.2 低危-5：NDJSON 上限必须增量判定

Python 的 NDJSON 分支原为：

```python
line = stream.readline()          # ← 先把整行读进内存
...
if len(line) > MAX_FRAME_BODY:   # ← 之后才判上限
    return ReadOutcome.fatal(...)
```

对一条**无终止符**的长行，`readline()` 会一直读到 EOF —— 也就是先分配 GB 级内存、
再报告「行太长」。**上限只挡得住「已读完」的情况，挡不住资源耗尽**。

Rust 侧（`mcp.rs:830-854`）是逐字节累加、超限立即返回，内存不膨胀。

**方案**：NDJSON 分支改为逐字节增量读取，并抽出 `_read_byte(stream)` 辅助函数。
首字节用于判定分帧格式（`{` → NDJSON），NDJSON 分支边累积边判上限。

#### ⚠️ 一处实现教训：增量只该用在「没有长度信息可依」的路径上

首次实现时我把 **Content-Length 头部也改成了逐字节**，结果 7 个测试红了 ——
`Content-Length: 123` 被拆成单字节，`split(":", 1)` 永远匹配不到，`headers` 恒为空 ⇒
合法帧被判 FATAL。

原因：Content-Length 分支**本来就安全** —— 整行有 `MAX_FRAME_HEADER`（8KB）上限，
且 body 按 `Content-Length` 精确读取，不存在无界增长。那里真正需要的恰恰是
「按行读」，因为要按行解析 `key: value`。

修正：新增 `_read_line(stream)`，头部继续按行读。**增量只用在 NDJSON 一条路径上。**

### 2.3 中危-3：`- run: |` 列表项块标量误报

`- run: |` 是 GitHub Actions 最常用的写法之一。检查器的列表项分支
（`check-workflow-yaml.py:239-252`）在 `:252` 提前 `continue`，永远到不了
`:263` 的块标量判定 ⇒ 其后每一行脚本体都被报「不是合法的 `key: value` 行」。

仓库当前 6 个 workflow 恰好都没用这个写法（`grep` 全空）⇒ **潜伏雷**，
一旦有人写合规的 `- run: |`，CI 立刻误红。

**方案**：列表项分支内，若 `key in ("run", "if")` 且 `rest` 是块指示符，
在 `continue` **之前**置 `in_block / block_indent / block_owner`，
与 `parse_kv` 分支的块标量处理对齐。

补充：块标量起始**不** `flush_step()` —— `- run: |` 本身就是步骤起始行，
`flush` 会把它误判成空步骤。这与现有代码在 `parse_kv` 分支的注释是同一个理由。

### 2.4 低危-6：`check-mcp-columns.py` 补写入列交叉比对

脚本原先只校验：

1. `SELECT_COLS` 两侧逐列一致
2. `ENSURE_COLUMNS ⊇ SELECT_COLS`
3. `ENSURE_COLUMNS ⊇ TASK_INSERT_COLS`

**写入列**（`TASK_INSERT_COLS` vs `db.rs::TASK_INSERT_HEAD`）从不被比对。
#438 修 `created_at` 漂移是**人工发现的**，脚本当时兜不住。

写入列漂移比读列更隐蔽：Python 少写一列时该列落 schema 默认值，表面无异常，
但与 Rust 路径落库的行**语义不同**（`created_at=0` ⇒「创建于 X 前」显示成 1970 年）。

**方案**：新增 `rust_insert_cols()` 解析 Rust 写入列，与 Python 侧交叉比对：

- 差集**仅允许** `RUST_EXPLICIT_EMPTY = ("parent_issue", "sub_issues", "pr_state")`
  —— Rust `on_demand::build_task_row` 对它们显式写 `""`，Python 不写则由 schema
  默认值 `''` 兜底，**语义相同**。
- 超出该名单的差集一律判失败，并提示「若确实是显式写空串，需登记进
  `RUST_EXPLICIT_EMPTY`」—— 让豁免成为**显式登记**而非默认放过。
- Python 多出的列同样判失败。

同时校正 `server.py:384` 的失真注释（原写「与 Rust 的列清单一致」，实际只有 26 列）。

#### 解析器要点：`TASK_INSERT_HEAD` 是跨行 SQL

```rust
const TASK_INSERT_HEAD: &str = "INSERT INTO tasks\n   (issue_key, ...)\n  VALUES (?1, ...)";
```

若按单行正则匹配，会把 `INSERT INTO tasks` 与 `VALUES (?1, ...)` 当成列名。
**校验器不报错，但断言完全失去意义** —— 恒真的守卫比没有守卫更危险。
故先取出整个字面量，再从 `INSERT INTO tasks` 与 `VALUES` 之间截列名段。

### 2.5 低危-7：补 `check-mcp-columns.py` 单测

`scripts/` 下 5 个检查脚本此前只有它没有回归测试。它负责 MCP 双实现列一致性 ——
一旦解析器因格式微调而悄悄失效，#169 / #262 / #278 / #438 这一类漂移缺陷就重新失去兜底。

**方案**：新增 `scripts/test_check_mcp_columns.py`，12 个用例，三组：

| 组 | 内容 |
|---|---|
| `ParseTests` | 真实 schema / 跨行 SQL / 两侧 SELECT_COLS 一致 |
| `DriftDetectionTests` | 每类漂移都能检出 + `RUST_EXPLICIT_EMPTY` 不得误报（**误报比漏报更致命**） |
| `ScriptRunTests` | `main()` 在当前仓库返回 0（覆盖 CI 真实执行路径） |

## 三、接口 / 行为变更

| 对象 | 变更 |
|---|---|
| `server.py::read_message` | Content-Length 缺失 / 不可解析：`Malformed` → **`Fatal`**（对齐 Rust） |
| `server.py::read_message` | NDJSON 分支改为逐字节增量读取，超限立即终止 |
| `check-workflow-yaml.py` | 列表项块标量（`- run: \|`）不再误报 |
| `check-mcp-columns.py` | 新增写入列交叉比对；新增 `RUST_EXPLICIT_EMPTY` 豁免名单 |

**MCP 工具集、`SELECT_COLS`（29 列）、DB schema、i18n、前端全部零改动。**

## 四、数据 / Schema 变更

无。`TASK_INSERT_COLS` 内容未变（仅注释校正），`RUST_EXPLICIT_EMPTY` 只是
校验脚本里的**豁免名单**，不参与运行时。

## 五、测试 / 验收

| 测试 | 作用 |
|---|---|
| `test_server.py::test_missing_content_length_is_fatal` | **改名+改断言**。原断言把偏离 Rust 的行为钉死为正确 |
| `test_server.py::test_unparseable_content_length_is_fatal` | 同上 |
| `test_server.py::test_ndjson_limit_is_enforced_incrementally` | 新增。用按需供给的 `_CountingStream` 断言「超限判定前**不该**已读走超过上限的数据量」 |
| `test_workflow_yaml.py::test_list_item_block_scalar_run_is_not_flagged` | 新增。合法 `- run: \|` 零误报 |
| `test_workflow_yaml.py::test_list_item_block_scalar_after_name_is_not_flagged` | 新增 |
| `test_workflow_yaml.py::test_list_item_block_scalar_body_lines_are_not_parsed_as_keys` | 新增。块内 `- key: value` 形态不得被当成新步骤 |
| `test_check_mcp_columns.py` | **新增文件**，12 个用例 |

### 反向验证（3 处变异，全部被捕获）

| 变异 | 捕获 |
|---|---|
| NDJSON 退化回 `readline()` 整行读取 | `test_ndjson_limit_is_enforced_incrementally` 失败 |
| `TASK_INSERT_COLS` 删掉 `created_at` | `check-mcp-columns.py` 退出码 1 |
| （解析器）按单行匹配 `TASK_INSERT_HEAD` | `test_rust_insert_cols_parses_multiline_sql` 失败 |

### 已跑校验

```
python3 -m unittest discover -s scripts -p 'test_*.py'   ✅（129 passed，原 117）
python3 -m unittest mcp_server.test_server              ✅（60 passed，原 59）
python3 scripts/check-mcp-columns.py                    ✅
python3 scripts/check-workflow-yaml.py                  ✅
python3 scripts/check-doc-links.py                      ✅
python3 scripts/check-versions.py                       ✅
```

## 六、相关链接

- Issue：[#451](https://github.com/ShawnLiuSZ/task-dashboard/issues/451)
- 审查报告：`CODE-REVIEW-2026-10-19.md`
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
- 相关约定：AGENTS.md §8.6（MCP 双实现一致性）
- 相关历史：[#357](https://github.com/ShawnLiuSZ/task-dashboard/issues/357)（Rust 侧 Content-Length 改 FATAL，Python 未跟上）、[#438](https://github.com/ShawnLiuSZ/task-dashboard/issues/438)（`created_at` 漂移，人工发现）