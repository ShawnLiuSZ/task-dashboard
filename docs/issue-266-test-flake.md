# #266 Rust 测试共用按 pid 命名的临时库导致随机 disk I/O error（CI flake）

> 关联 issue：[#266](https://github.com/ShawnLiuSZ/task-dashboard/issues/266)
> 修复分支：`fix/issue-266-test-flake` → `develop`

## 背景 / 动机

CI 的 `Rust Tests`（本地也偶发）随机失败，报错始终是 `commands.rs` 的测试辅助 `mem_conn()`：

```
thread 'commands::tests::<某测试>' panicked at src/commands.rs:1742:46:
打开测试库: "初始化表结构失败: disk I/O error"
test result: FAILED. 89 passed; 1 failed; 2 ignored
```

同一份代码重跑即绿，命中哪个测试不固定（已见 `import_note_dedupes_by_content`、
`validate_status_accepts_four_states_and_account_columns`）。近期已两次把 PR / develop 的 CI 打红
（PR #264 首跑、develop 合并后 push）。属于典型的**非确定性测试 flake**。

## 设计 / 方案

### 根因
Rust 测试在**同一进程内并行执行**。`mem_conn()` 把临时库路径只按 `process::id()` 命名，于是所有
用到 `mem_conn()` 的测试共用同一个文件；而每次调用还会 `remove_file` 两次（打开前删、打开后又删）。
并行时 A 测试把 B 测试正在使用的库 `unlink` / 重建，B 打开或初始化 schema 时撞上 `disk I/O error`。

同类隐患：`sync.rs:843` 用完全不带 pid 的固定名 `taskboard_headless_test.db`（该测试目前 `#[ignore]`，
尚未暴露，但属于同一类「临时库未与并发隔离」问题）。

正确示范在 `hooks.rs`：`tb_hooks2_{pid}_{name}` —— 带**每个测试独有**的标识。

### 修法
1. `mem_conn()` 的临时库路径加**每调用递增的 `AtomicUsize` 序号**，`{pid}_{SEQ}`，保证每个连接
   独享一个文件；不再于连接存活期 `remove_file`（去掉第二处删除）。测试进程退出后由 OS 回收临时文件。
2. `sync.rs:843` 固定名改为带 pid 的 `taskboard_headless_test_{pid}.db`（即便测试被 ignore，也按同一
   约定整改，消除遗留隐患）。
3. 加**防回归断言** `mem_conn_returns_unique_paths_per_call`：两次 `mem_conn()` 返回的路径必须不同，
   从契约上锁死「每个连接独享文件」。

## 接口 / 行为变更

- 仅改动测试辅助与 `#[ignore]` 测试，**不涉及任何产品代码 / 公共 API / DB schema**。
- `mem_conn()` 行为变化：① 路径由 `taskboard_cmds_test_{pid}.db` 变为
  `taskboard_cmds_test_{pid}_{n}.db`；② 不再在连接存活期删除该文件。

## 数据 / Schema 变更

无。临时测试库属测试隔离范畴，不进版本库、不影响用户数据。

## 测试 / 验收

- 新增 `mem_conn_returns_unique_paths_per_call`：断言两次 `mem_conn()` 路径不同（`rusqlite::Connection::path()`
  返回 `Option<&str>`）。
- 验收（issue 要求）：以 `--test-threads=16` 反复跑 10 次无 `disk I/O error`；CI `Rust Tests` 连续
  多次（含重跑）全绿。
- 实跑结果：`cargo test --lib -- --test-threads=16` → **102 passed, 0 failed, 3 ignored**；
  连续 4 次 `cargo test --lib` 全绿（0 failed），含新增断言 `mem_conn_returns_unique_paths_per_call ... ok`。

## 相关链接

- issue：[#266](https://github.com/ShawnLiuSZ/task-dashboard/issues/266)
- 涉及文件：`app/src-tauri/src/commands.rs`（`mem_conn`、`mem_conn_returns_unique_paths_per_call`）、
  `app/src-tauri/src/sync.rs`（`:843` 临时库改名）
- 参考写法：`app/src-tauri/src/hooks.rs` 的 `tb_hooks2_{pid}_{name}` 唯一路径约定
- CHANGELOG：`docs/CHANGELOG.md`（Unreleased）、`docs/CHANGELOG.en.md`
