# #386：Python MCP 引用解析形态覆盖缺口

> 断言强度审计（mutation testing）第三轮 —— Python 侧第一批。
> 所属版本：v0.3.22（待发版）· 关联 issue [#386](https://github.com/ShawnLiuSZ/task-dashboard/issues/386)

## 背景 / 动机

审 `mcp_server/server.py::parse_issue_ref_parts`。

选它的理由：

1. 它是 `mcp_server/AGENT_INSTRUCTIONS.md` 里 **agent 每次调用 MCP 工具的入口** —— `update_task_status(issue, ...)` / `record_session(issue, ...)` 等全部走它
2. AGENTS.md **§8.6** 要求 Python 侧与 Rust 侧 `on_demand.rs` 行为等价，两份实现必须同步审计

Rust 侧此前已审过 4 项（#378 / #380 / #382 / #384），Python 侧此前**零 mutation 审计**。

## 实测：4 个变异存活

| 变异 | 后果 | 修复前 | 修复后 |
|---|---|---|---|
| `(?:issues\|pull)` → `(?:issues)` | **`/pull/{n}` 链接全部解析失败** | **存活** | 捕获 ✅ |
| `left.rstrip("/")` → `left` | `owner/repo/#N` 尾斜杠形式解析出错误 repo | **存活** | 捕获 ✅ |
| `rpartition("#")` → `split("#")` | 多 `#` 引用的错误消息改变 | **存活** | 捕获 ✅ |
| `if not ref` 守卫删除 | 空引用的错误消息改变 | **存活** | 捕获 ✅ |

修复后重跑全部 6 个变异（含 `url-no-owner` / `num-no-pos`）：**6/6 全捕获**。

## 设计 / 方案

### 跨侧覆盖不对称（本项的额外发现）

`on_demand.rs:459,485` **已有** `/pull/` 断言，Python 侧完全没有。

两份实现按 §8.6 要求等价，但**测试覆盖不对齐** —— Rust 侧改了正则而 Python 侧无人发现。这与 #155（`tasks.key` → `issue_key` 改名漏改 Python 侧，读路径静默失效几个版本）是**同类风险面**，只是那次靠人工比对列名发现、这次靠断言审计发现。

### 补的两个测试

| 测试 | 覆盖 |
|---|---|
| `test_parse_url_forms_guarded` | `/pull/{n}`、带 `?`/`#` 的 URL、省略 `issues\|pull` 段的畸形 URL |
| `test_parse_repo_ref_edge_forms_guarded` | 尾斜杠、多余路径段、多 `#`、空/空白/None |

## 关键决策：断言必须断言**错误消息**，不能只断言异常类型

这是本项最重要的技术点，也是**我第一版测试犯的错**。

第一版只写：

```python
with self.assertRaises(ValueError):
    S.parse_issue_ref_parts("a#b#c")
```

结果 `rpartition` → `split` 这个变异**依旧存活**。原因：换成 `split` 后 `left, right = ref.split("#")` 会因长度不匹配抛 `ValueError: too many values to unpack` —— **仍然是 ValueError**，只断言异常类型则两种写法在测试眼里完全一样。

`empty-no-check` 同理：删掉守卫后空串落到末尾的「无法解析 issue 引用」分支，**仍抛 ValueError**。

修正为断言具体消息：

```python
with self.assertRaises(ValueError) as cm:
    S.parse_issue_ref_parts("a#b#c")
self.assertIn("编号非法", str(cm.exception))
```

> **这正是 #376 的教训落在自己身上：断言「看起来合理」不等于有判别力。**
> `taskSig` 那条表驱动用例读起来完全合理，只有 mutation 才暴露它漏守 8 个字段。

## 两个存活经确认**不是**缺陷（记录避免重复排查）

### 1. repo 名分隔符 `[^/#?]+` 放宽为 `[^/]+` —— 等价变异

对**合法 URL** 完全等价：URL 路径段本就不含 `?` / `#`。

只有畸形输入才分歧，如 `https://github.com/acme/we#b/issues/7`：

- `[^/#?]+` → 在 `#` 处停下，后续 `#b/…` 不匹配 `/issues/` ⇒ 整体不匹配
- `[^/]+` → repo 取到 `we#b` ⇒ 匹配成功

**不计入缺口**，且已在测试 docstring 里显式注明，避免后人把它当成待修项。

### 2. `empty-no-check` 的早期存活 —— 是我的测试没判别力，不是测试目标错

见上一节。守卫本身是必要的（错误消息不同），只是需要更强的断言才能看见。

## 过程中的一次测量脚本错误（第五次）

第一次验证时 grep 只匹配 `FAILED (failures=N`，而 `url-pull` 这个变异产生的是 `FAILED (errors=1)`（异常 vs 断言失败）⇒ 被我的脚本报成 `??`。

修正为 `failures=\|errors=` 后全部正常。

这是本轮系列**第五次**「测量手段本身出错」：

| # | 错误 | 场合 |
|---|---|---|
| 1 | shell 吞 `${}`，注入失败被当成断言失效 | #367、#382 |
| 2 | 变异方向反了（无限循环 / `@` 后段） | #380、#382 |
| 3 | 期望值手算错误 | #378 |
| 4 | 过滤条件不含被测用例 | #384 |
| **5** | **grep 只匹配 `failures=` 漏掉 `errors=`** | **本项** |

共同点：**先验证测量手段本身，再采信结论**。

## 接口 / 行为变更

无。纯测试补充。

## 数据 / Schema 变更

无。

## 测试 / 验收

- [x] 2 个新用例全绿
- [x] 4 个存活变异全部捕获；全量 6 变异 **6/6**
- [x] Python MCP 测试 53 → **55**
- [x] `scripts/check-mcp-columns.py` 通过（28 列两侧一致）
- [x] `scripts/check-doc-links.py` 通过

## 相关链接

- issue [#386](https://github.com/ShawnLiuSZ/task-dashboard/issues/386)
- PR #387
- 前置：#378 / #380 / #382 / #384（本系列 Rust 侧四批）、#376（前端，判别力教训来源）
- 跨侧一致性风险先例：#155（`tasks.key` → `issue_key` 改名漏改 Python 侧）
- 源文件：`mcp_server/server.py::parse_issue_ref_parts`
- 对照实现：`app/src-tauri/src/on_demand.rs::parse_issue_ref_parts`