# 集成测试临时 SQLite 目录从不清理（#424）

> 关联issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/424>
> 影响面：仅测试代码（`app/src-tauri/tests/db_test.rs`），**无产品代码变更**

---

## 背景 / 动机

用户在做卸载/磁盘清理时发现大量 `taskboard.db` 残留：

```
/var/folders/ys/h836r2hn5qn444gx6g8w3cfh0000gn/T/taskboard_test_<pid>_<nanos>_<seq>/taskboard.db
```

实测本机累积 **958 个目录 / 146 MB**（扫描显示约 423 MB，为不同工具的统计口径）。

## 澄清：与App 更新 / 卸载无关

这一点必须先说清，否则容易误判为「每次更新产生新数据库」：

| | 路径 | 数量 |
|---|---|---|
| **App 真实数据** | `~/Library/Application Support/com.shawnliu.taskboard/taskboard.db` | **1 个**（3.3 MB） |
| **测试残留** | `/var/folders/.../T/taskboard_test_*/` | 958 个 |

- 残留来自**开发期跑 `cargo test`**，与发布、更新、卸载**完全无关**。
- 每次 `cargo test` 产生约 **26 个**目录（27 个集成测试用例，绝大多数各开一份库）。
- macOS 会定期清理 `/var/folders/.../T/`，但期间未清掉就持续堆积。
- 删除这些目录**不影响 App 数据**（已用 `PRAGMA integrity_check` = `ok` 验证生产库完好）。

## 设计 / 方案

### 根因

`db_test.rs::tempdir()` 只创建不清理：

```rust
fn tempdir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("taskboard_test_{}_{}_{}", pid, nanos, n));
    std::fs::create_dir_all(&dir).unwrap();
    dir                                  // ← 返回裸 PathBuf，无任何清理钩子
}
```

### 修复：RAII guard（零调用点改动，不引入新依赖）

```rust
struct TempDir(PathBuf);

impl Deref for TempDir { /* Target = Path */ }   // ⇒ dir.join(..) 调用点零改动
impl AsRef<Path> for TempDir { /* … */ }          // ⇒ 手动 remove_dir_all 处也无需改
impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);  // 清理失败静默忽略
    }
}
```

三条设计决策：

**① RAII guard 而非测试末尾手动删**
测试 panic 时手动清理不会执行 ⇒ 失败路径反而堆积最多。`Drop` 在栈展开时同样会跑，
保证成功/失败两条路径都清理。

**② `Deref` + `AsRef` 而非改 16 处调用点**
`tempdir()` 有 **16 处**调用，模式统一为 `let dir = tempdir(); dir.join("taskboard.db")`。
实现 `Deref<Target = Path>` 后所有调用点**零改动**，也避免未来新增测试时误用。
`AsRef<Path>` 是为了一处手动 `remove_dir_all(&dir)` 的测试（验证重建后不留残file）。

**③ 不引入 `tempfile` crate**
`AGENTS.md §2.5` 明确「不引入新依赖」。`tempfile` 是标准做法，但为这一个用途加依赖不划算 ——
guard 实现仅约 20 行，且 `Drop` 语义完全可控。

### 一个必须处理的生命周期陷阱

第一版直接把 `tempdir()` 改成返回 `TempDir`，**这会引入悬垂连接**：

```rust
fn fresh_db() -> Connection {
    let dir = tempdir();              // ← dir 是局部变量，函数 return 时即被 drop
    let path = dir.join("taskboard.db");
    db::open_db(&path).expect(...)    //← 返回的 Connection 指向已被删的路径
}
```

`fresh_db()` 只返回 `Connection` 而不持有 `dir`，函数返回瞬间 `dir` 就析构 ⇒ 目录被删，
连接变成悬垂文件句柄。**这是「加清理」引入的新缺陷**，必须一并解决。

解法是让返回值同时持有二者，靠 **Rust 字段声明逆序 drop** 保证顺序：

```rust
struct TempDbGuard {
    conn: Connection,   // 先声明 ⇒ 后 drop
    _dir: TempDir,      // 后声明 ⇒ 先 drop
}
```

drop 逆序 ⇒ `conn` 先关闭（`-wal`/`-shm` 落盘）→再删目录。字段顺序在此**有语义意义**，
故注释里明确写出，避免后人调换顺序引入 bug。

## 接口 / 行为变更

无产品代码变更。测试辅助类型签名变化：

- `tempdir() -> PathBuf` ⇒ `tempdir() -> TempDir`
- `fresh_db() -> Connection` ⇒ `fresh_db() -> TempDbGuard`（`Deref<Target = Connection>`）

16 处 `tempdir()` 调用点零改动；`fresh_db()` 的 16 处调用点因 `Deref` 同样零改动。

## 数据 / Schema 变更

**无。** 不涉及 SQLite schema、不涉及 `SELECT_COLS`、不涉及 MCP 双实现。

## 测试 / 验收

| 项 | 结果 |
|---|---|
| `cargo test --test db_test` | 27 passed，跑完残留 **0** 个 |
| `cargo test`（全量） | 178 + 27 passed，跑完残留 **0** 个 |
| `cargo fmt --check` | 干净 |
| `cargo clippy --all-targets -p taskboard -- -D warnings` | **0 警告** |
| `npm test -- --run`（前端未改动） | 276 passed |

### 反向验证

按 `AGENTS.md §5.6` 纪律，把 `Drop` 里的 `remove_dir_all` 换成空操作（还原原缺陷）：

```
变异后：cargo test 跑完残留 26 个   ← 证明清理逻辑确实在起作用
恢复后：残留 0 个
```

**这不是靠 `cargo test` 退出码判定的** —— 变异前后测试都 `exit=0`（清理是卫生措施，
不让它影响被测行为）。判定依据是**跑完后临时目录残留数量**，这才是本修复的真正信号。

⚠️ 另按 §5.6 补跑 `clippy --all-targets`（改过 `tests/` 下的文件）：若插入点替换只锚定
函数体，会把原 `#[test]` 变成 dead code 而 `cargo test` 仍通过，只有 clippy 能暴露。本次干净。

## 相关链接

- Issue：<https://github.com/ShawnLiuSZ/task-dashboard/issues/424>
- 同类隐患：`commands.rs::mem_conn()` 用 `temp_dir()/taskboard_cmds_test_{pid}.db`，
  并行互删在用库会偶发 `disk I/O error`（已知 flake，未在本issue 处理）
- 方法论：[`methodology-assertion-strength-audit.md`](./methodology-assertion-strength-audit.md)
- CHANGELOG：[`CHANGELOG.md`](./CHANGELOG.md) / [`CHANGELOG.en.md`](./CHANGELOG.en.md)