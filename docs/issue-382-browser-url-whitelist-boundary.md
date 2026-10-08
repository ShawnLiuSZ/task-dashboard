# #382：URL 白名单子域边界无守护

> 断言强度审计（mutation testing）第二轮，Rust 侧第三批。
> 所属版本：v0.3.22（待发版）· 关联 issue [#382](https://github.com/ShawnLiuSZ/task-dashboard/issues/382)

## 背景 / 动机

继 #378（`iso8601_to_secs`）、#380（状态映射表）后审 `common::validate_browser_url`。

选它作为下一目标的理由：**这是 `open_in_browser` 命令的唯一闸门**，而且 URL **不是纯内部输入** —— 它来自 issue 正文、PR 链接、agent session 工作目录等外部数据（#370 已确认 `SessionsPanel` 走这条路，#358 起所有外链入口都必须过它）。

安全边界的断言强度值得优先确认。

## 实测：4 个变异存活，其中 2 个是真实的白名单逃逸

| # | 变异 | 后果 | 修复前 | 修复后 |
|---|---|---|---|---|
| ① | `ends_with(".ghe.com")` → `contains("ghe.com")` | **白名单逃逸** | **存活** | 捕获 ✅ |
| ② | `ends_with(".ghe.com")` → `ends_with("ghe.com")` | **白名单逃逸** | **存活** | 捕获 ✅ |
| ③ | `eq_ignore_ascii_case` → `==` | 合法大写 URL 被拒（失败关闭） | **存活** | 捕获 ✅ |
| ④ | 去掉 `to_lowercase()` | 同上 | **存活** | 捕获 ✅ |

修复前**已捕获**（无需处理）：删掉 ghe 分支、`https://` 前缀放宽、host 提取改 `split('?')`、`split` 改 `unwrap_or("")`。

## 设计 / 方案

### 逃逸的具体 URL

当前实现**正确拒绝**下列全部 URL，但**没有任何用例覆盖**：

| URL | ① `contains("ghe.com")` | ② `ends_with("ghe.com")` |
|---|---|---|
| `https://evilghe.com/o/r` | **放行** | **放行** |
| `https://notghe.com/o/r` | **放行** | **放行** |
| `https://ghe.com.attacker.net/o/r` | **放行** | 拒绝 |
| `https://a.ghe.com.evil.net/o/r` | **放行** | 拒绝 |
| `https://attacker.net/?github.com` | 拒绝 | 拒绝 |
| `https://github.com@attacker.net/o/r` | 拒绝 | 拒绝 |

**当前实现是正确的**（用 `ends_with(".ghe.com")` 带点前缀）。问题纯粹是**无守护**。

### 为什么这是最危险的变异形态

`ends_with(".ghe.com")` → `ends_with("ghe.com")` 看起来只是**「去掉多余的点」的无害简化**：

- Linter 不报（语义仍是「后缀匹配」）
- code review 极易放过（读者会自动脑补「当然是指子域」）
- 但它把边界从「`ghe.com` 的子域」放宽成「任何以 `ghe.com` 结尾的域」—— `evilghe.com` 是任何人可注册的域

这比 #380 的「静默降级为正常行为」更危险：**没有任何观测信号表明白名单已失效**。

### 补的两个测试

**1. `validate_browser_url_rejects_ghe_lookalike_domains`** —— 9 条样本，覆盖三类绕过形态：

| 类别 | 样本 |
|---|---|
| **兄弟域 / 伪子域** | `evilghe.com`、`notghe.com` |
| **前缀/尾部拼接** | `ghe.com.attacker.net`、`a.ghe.com.evil.net`、`ghe.com.evil.net` |
| **userinfo 混淆** | `github.com@attacker.net`、`github.com:8443@attacker.net` |
| **分隔符混用** | `attacker.net/?github.com`、`attacker.net/#github.com` |

**2. `validate_browser_url_is_case_insensitive_and_trims`** —— 大小写混合（`GitHub.com` / `GITHUB.COM` / `gItHuB.cOm` / `ACME.GHE.COM`）+ trim 后返回值。

第 2 例虽属**失败关闭**方向（合法大写 URL 被拒，不会放进危险域），仍要锁定，理由是：

> 若有人为「修大写被拒」而把判据改成 `contains`，会**一并放宽域匹配** —— 从一次功能修复变成安全逃逸。

这类「为了修 A 而改坏 B」的路径只有靠契约测试挡住。

## 额外验证：userinfo 逃逸向量的双向确认

host 提取若改为按 `@` 切分，**两个方向后果相反**：

| 改法 | `github.com@attacker.net` | 是否缺陷 |
|---|---|---|
| `split('@').next()`（取**前段**） | host = `github.com` ⇒ **放行** | **真实逃逸** |
| `split('@').next_back()`（取**后段**） | host = `attacker.net` ⇒ 拒绝 | **不是缺陷** —— 这本就是正确行为 |

- 前者（真实逃逸）：新用例**成功捕获**
- 后者：新用例捕获不到，但**它不该被捕获** —— 那是安全行为

## 一个变异方向的教训

我第一次写 userinfo 变异时取了 `next_back()`（`@` 后段），**存活**了。差点误判成「测试仍弱」。

实际是**变异方向反了**：`@` 后段才是真实 host，取它才是正确实现。这与 #380 轮「把『只跑一次』写成无限循环」是同一类错误 —— **变异必须表达一个真实缺陷方向，否则存活不代表测试弱**。

据此把这条写进 KB，避免后人重复排查。

## 接口 / 行为变更

无。纯测试补充。

## 数据 / Schema 变更

无。

## 测试 / 验收

### 反向验证汇总

| 类别 | 数量 | 修复前 | 修复后 |
|---|---|---|---|
| 白名单逃逸（`contains` / 去点） | 2 | **0/2** | **2/2** ✅ |
| 失败关闭（大小写） | 2 | **0/2** | **2/2** ✅ |
| userinfo 逃逸（前段） | 1 | **0/1** | **1/1** ✅ |
| 原本已捕获 | 4 | 4/4 | 4/4 ✅ |

### 验收标准

- [x] 2 个新用例全绿
- [x] 4 个存活变异全部捕获
- [x] userinfo 逃逸向量被捕获
- [x] lib 测试无回归：166 → **168**
- [x] `cargo clippy --all-targets -D warnings` 干净
- [x] `cargo fmt --check` 干净

## 本项在审计序列中的位置

| # | 模块 | 缺陷形态 | 是否逃逸 |
|---|---|---|---|
| #376 | 前端 `taskSig` | 漏字段 ⇒ UI 不刷新 | — |
| #378 | `iso8601_to_secs` | 静默偏移 86400 | — |
| #380 | 状态映射表 | 静默降级为「正常行为」 | — |
| **#382** | **`validate_browser_url`** | **白名单静默放宽** | **✅ 安全** |

四项共同点：**缺陷都表现为「看起来正常」**。前三项表现为正常功能，第四项表现为正常的安全判定 —— 都不产生任何告警。

这是断言强度审计的核心价值：**能通过测试的代码里，藏着一批「改了也没人发现」的实现**。

## 相关链接

- issue [#382](https://github.com/ShawnLiuSZ/task-dashboard/issues/382)
- PR #383
- 前置：#378、#380（本轮 Rust 侧前两项）、#376（前端）
- 依赖该闸门的修复：#370（`SessionsPanel` 外链）、#358（外链收口）
- 源文件：`app/src-tauri/src/common.rs::validate_browser_url`