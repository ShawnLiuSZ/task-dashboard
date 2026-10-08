# #388：日期转换双实现不一致

> 断言强度审计（mutation testing）第三轮 —— Python 侧第二批。
> 所属版本：v0.3.22（待发版）· 关联 issue [#388](https://github.com/ShawnLiuSZ/task-dashboard/issues/388)

## 背景 / 动机

审 `mcp_server/server.py::_iso_to_secs`。

它是 #378 刚补测试的 Rust `common::iso8601_to_secs` 的**对偶**：

- 两份**完全独立**的实现（一个手写闭式公式，一个调 `strptime`）
- Python 侧 docstring 明确声称「**对齐 Rust `iso8601_to_secs`**」
- AGENTS.md §8.6 要求跨文件一致性

选它的理由：这是本系列里**唯一一对「自称对齐、实际不一致」的孪生实现**。

## 发现一：真实缺陷 —— Python 会写入负时间戳

```python
return calendar.timegm(time.strptime(s[:19], "%Y-%m-%dT%H:%M:%S"))
```

`1969-01-01T00:00:00Z` → **`-31536000`**（一个合法的负数）。

Rust 侧有显式的 `y < 1970` 守卫返回 `0`。

后果：

1. 同一 issue 被两条路径先后写入时，`created_at` / `updated_at` **取决于谁最后动手**
2. 下游「相对时间」展示（`formatCountdownSeconds` 之外的各类 ago 文案）遇到负值会显示荒谬内容

修复：`return secs if secs >= 0 else 0`

## 发现二：5 处两侧分歧

**实测两侧真实值，非推理**（Rust 侧用临时测试打印，Python 侧直接调用）：

| 输入 | Python | Rust | 方向 |
|---|---|---|---|
| `1969-01-01T00:00:00Z` | **-31536000** | **0** | Python 漏守卫 ← **已修** |
| `2024-02-30T00:00:00Z` | 0 | 1709251200 | Python 更严格 |
| `2024-1-01T00:00:00Z` | 0 | 1704067200 | Python 更严格 |
| `2024-01-01T0:00:00Z` | 0 | 1704067200 | Python 更严格 |
| `2024-01-01T00:00:60Z` | **1704067260** | 0 | Python 更宽松 |

除第一处外，其余都是「严格方向都是返回 `0`（即无时间）」= **失败关闭**，故**保持现状并显式记录**，不为对齐而改行为。

原因：

- `2024-02-30`：`strptime` 校验逐月天数 ⇒ 0；Rust 只查 `1..=31` ⇒ 滚到 03-01
- `2024-1-01`：`strptime` 要求零填充；Rust 的 `parse::<u32>()` 宽松

## 发现三：`sec=60` 带**跨平台**性质（本项最值得记录的一点）

`time.strptime` 走底层 C 库。实测环境：**macOS arm64 / glibc / Python 3.14.8**

| 秒值 | `strptime` 行为 |
|---|---|
| 59 | 接受 |
| **60** | **接受**（闰秒），`timegm` 进位到下一分钟 → 1704067260 |
| **61** | **接受**（闰秒） |
| 62 / 99 | 拒绝 |

> **musl（Alpine Linux）与 Windows 的 C 库未必接受 60。**
> 同一份 `server.py` 在 Linux / macOS 与 Windows 上结果**可能不同**。

TaskBoard 是跨平台桌面应用，而 `mcp_server/server.py` 正是 Windows / Linux 环境下的**兜底实现**（`AGENT_INSTRUCTIONS.md` 指定）。因此这条**不能当作稳定契约**。

GitHub 从不发闰秒，故当前不可达。但若将来要支持闰秒语义：**必须两侧同时改，且不能依赖 `strptime` 的平台行为**（需要自己解析字段）。

## 设计 / 方案：共享 fixture

新增 `mcp_server/fixtures/iso_parity.json`：

| 字段 | 内容 |
|---|---|
| `must_agree`（27 条） | 两侧**必须**返回同一值 |
| `known_divergence`（4 条） | 各自锁定已知分歧，附 `note` 说明原因 |

两侧测试**各读同一个文件**：

```
mcp_server/test_server.py
  ├─ test_iso_to_secs_matches_rust_on_agreed_domain
  ├─ test_iso_to_secs_known_divergence_locked
  └─ test_iso_to_secs_never_returns_negative

app/src-tauri/src/common.rs
  ├─ iso8601_to_secs_matches_python_on_agreed_domain
  └─ iso8601_to_secs_known_divergence_locked
```

Rust 侧路径用 `concat!(env!("CARGO_MANIFEST_DIR"), "/../../mcp_server/fixtures/iso_parity.json")`。

### 为什么不各写一份表

**#155 已证明双实现副本必然漂移** —— 那次 `tasks.key` → `issue_key` 改名只改了 Rust 侧，Python 侧读路径静默失效几个版本无人发现。

而这里比 #155 更危险：**`server.py` 不参与 Tauri 构建**，Rust 的 CI 完全跑不到 Python 侧测试；Python 侧也没有独立 CI job 兜住 `SELECT_COLS` 之外的逻辑。

共享 fixture 让任一侧的漂移在**两侧测试**里都立刻暴露。

### `known_divergence` 必须锁定而非忽略

只测「一致的部分」不够：若有人只改一侧，那一侧的行为变化**没有测试会发现**（因为它仍满足「自己那列的期望值」以外的一切）。

所以两侧各自锁定自己那一侧的期望值，并在断言消息里带上 `note` —— 行为一旦变更，测试会提示「须确认是有意为之」并打印当初分歧的原因。

## 反向验证

| 注入 | Python | Rust |
|---|---|---|
| Python 退回 `return secs`（恢复负时间戳） | **failures=2** ✅ | — |
| 把 fixture 里 `2100-03-01` 期望值改错 | **failures=1** ✅ | **1 failed** ✅ |
| 恢复 | OK | 5 passed ✅ |

第 2 行是关键：**共享表让两侧同时报警**，这正是「各自维护副本」做不到的。

## 接口 / 行为变更

**有**：`server.py::_iso_to_secs` 对 1970 前输入由「返回负数」改为「返回 `0`」，与 Rust 一致。修复前该行为违反自身 docstring 声明的「对齐 Rust」。

## 数据 / Schema 变更

无。

## 测试 / 验收

- [x] Rust lib 172 → **174**
- [x] Python MCP 55 → **58**
- [x] 负时间戳缺陷已修
- [x] 共享 fixture 双向生效
- [x] `cargo clippy --all-targets -D warnings` 干净、`cargo fmt --check` 干净
- [x] `scripts/check-mcp-columns.py` 通过

## 本轮一次「自造 fixture 被自己抓」的插曲

我写第一版 fixture 时把 `2024-01-01T00:00:60Z` 放进了 `must_agree`，期望值 `0`（照 Rust 抄）。测试立刻失败，报 `1704067260 != 0`。

这正是共享表的**第一道价值生效**：fixture 里的错误期望值当场被抓，而不是静默通过 —— 因为 Rust 的 `sec > 59` 守卫和 Python 的 `strptime` 行为根本不同，而我当时**没有实测就填了值**。

与 #378「期望值手算 `2024-02-30` 出错」是同一条纪律的第三次生效：**期望值必须外部来源，必须实测**。

## 相关链接

- issue [#388](https://github.com/ShawnLiuSZ/task-dashboard/issues/388)
- PR #389
- 前置：#378（Rust 侧同名函数）、#386（Python 侧引用解析）
- 跨侧漂移先例：#155（`tasks.key` → `issue_key` 只改一侧）
- 源文件：`mcp_server/server.py::_iso_to_secs`、`app/src-tauri/src/common.rs::iso8601_to_secs`
- 共享表：`mcp_server/fixtures/iso_parity.json`