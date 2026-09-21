# Issue #299：PR 正文裸提 #N 被误关联

## 背景 / 动机

`sync.rs` 的 `parse_issue_refs` 函数在解析 PR 正文提取 issue 关联时，把所有裸 `#N` 都当作关联目标，导致 PR 正文里顺带提一下某个 issue 编号就会被错误关联。

例如 fad-backend issue #1340 和 PR #1342 根本不是同一个任务，但 PR #1342 正文里提了 `#1340` 就被关联上去，造成看板数据混乱。

**根因**：旧实现按字节扫描 `#N` 模式，不做任何上下文校验，与 `scripts/merge-cleanup.py` 的保守策略不一致（merge-cleanup 要求关闭关键词才关 issue）。

## 设计 / 方案

### 核心改动

`parse_issue_refs` 改为**只匹配有关闭关键词的引用**，与 `scripts/merge-cleanup.py` 的 `CLOSE_RE` 保持一致。

### 关闭关键词列表

与 merge-cleanup 保持一致，支持英文（大小写不敏感）和中文：

| 英文（? 表示可选后缀） | 中文 |
|---|---|
| close / closes / closed | 关闭 |
| fix / fixes / fixed | 解决 |
| resolve / resolves / resolved | 修复 |
| ref / refs / references | — |

### 匹配规则

1. **词边界检查**：关键词前面不能是字母数字或下划线（避免 `prefixfixed` 误匹配），但允许前面是中文（`已关闭 #284` 应匹配）
2. **关键词后允许**：空白、可选冒号（半角 `:` 或全角 `：`）、repo 前缀（如 `Fixes owner/repo#123`）
3. **连续引用**：`Closes #1 #2 #3` 一次匹配三个（与 Python 正则的 `(?:\s*#\s*N)*` 一致）
4. **后续 #N 限制**：第一个 #N 后，后续 #N 之间只允许空白（不允许 repo 前缀或冒号），避免 `refs #1 again #2` 误匹配第二个

### 实现细节

- 新增 `CLOSE_KEYWORDS` 常量数组
- 新增 `is_whitespace` / `is_repo_prefix_char` 辅助函数
- 新增 `match_close_keyword` 函数：检查 pos 是否在 char boundary、前面词边界、关键词匹配、后面词边界
- 修改 `parse_issue_refs` 主循环：先匹配关键词，再提取后续 #N

### 与旧实现的行为差异

| 场景 | 旧实现 | 新实现 |
|---|---|---|
| `Closes #123` | ✅ 匹配 | ✅ 匹配 |
| `#123`（裸提） | ✅ 匹配 | ❌ 不匹配 |
| `See foo/bar#456` | ✅ 匹配 | ❌ 不匹配（"See" 不是关键词） |
| `refs #1 again #2` | ✅ 匹配两个 | ✅ 只匹配第一个（"again" 不是关键词） |
| `修复 #999` | ✅ 匹配 | ✅ 匹配（中文关键词） |
| `prefixfixed #5` | ✅ 匹配 | ❌ 不匹配（前面有字母数字） |
| `see https://x.com/p#42` | ✅ 匹配 | ❌ 不匹配（"see" 不是关键词） |

## 接口 / 行为变更

### Rust 函数

```rust
fn parse_issue_refs(text: &str, default_repo: &str) -> Vec<String>
```

函数签名不变，返回值格式不变（`repo#number`），但**过滤规则变严格**：只返回有关闭关键词的引用。

### 新增辅助函数

```rust
fn is_whitespace(b: u8) -> bool
fn is_repo_prefix_char(b: u8) -> bool
fn match_close_keyword(text: &str, pos: usize) -> Option<usize>
```

均为私有函数，不影响外部 API。

### 影响范围

- `sync.rs` 的 PR 关联逻辑：PR 正文裸提 `#N` 不再关联，只有带关闭关键词的才关联
- 看板数据：已关联的错误 PR 在下次同步时会被清除（因为 `pr_map` 查不到）
- 不影响 MCP 的 `record_session` / `set_work_branch`（它们按 `issue_key` 查，不走 PR 关联）

## 数据 / Schema 变更

无 schema 变更。

## 测试 / 验收

### 测试用例（9 个）

| 测试 | 场景 |
|---|---|
| `parse_issue_refs_handles_basic_patterns` | 基本模式：Closes、Fixes、连续引用、冒号 |
| `parse_issue_refs_handles_dash_underscore_in_repo_name` | repo 名含 `-._` |
| `parse_issue_refs_ignores_invalid` | 无效输入：无 #、#0、空 |
| `parse_issue_refs_requires_keyword` | 裸 #N 不匹配、非关键词不匹配 |
| `parse_issue_refs_handles_unicode_context` | 中文关键词、多行、已关闭 |
| `parse_issue_refs_only_repo_segment_without_slash_uses_default` | 无 repo 前缀用默认 |
| `parse_issue_refs_ignores_url_anchor` | URL 锚不匹配（无关键词） |
| `parse_issue_refs_handles_multi_segment_owner_path` | 多段 owner 路径 |
| `parse_issue_refs_rejects_prefix_substrings` | 前缀子串不匹配 |

### 验收结果

- `cargo test --lib parse_issue_refs`：9/9 通过
- `cargo test --lib`：116/116 通过
- `cargo clippy --lib -- -D warnings`：无警告

## 相关链接

- Issue: https://github.com/ShawnLiuSZ/task-dashboard/issues/299
- 参考实现: `scripts/merge-cleanup.py` 的 `CLOSE_RE`（行 46-53）
- CHANGELOG: `docs/CHANGELOG.md` v0.6.2 条目