# 菜单栏 TaskBoard 图标旁不再显示「处理中 N」数字 — #524

> 用户在 **macOS 状态菜单栏**看到 TaskBoard 应用图标**旁边有一个裸数字「13」**，
> 要求去掉。

## 现象

用户截图（macOS 菜单栏右段）：

```
[TaskBoard 图标] 13   ⊙   豆包   [场记板]   [TaskBoard 图标]   微信   V …
                        └ 红框
```

⇒ 图标右侧那个**没有任何说明的裸数字**常驻在菜单栏里。

## 根因

`app/src-tauri/src/lib.rs::refresh_tray`（**每次同步后**调用，`lib.rs:366`）：

```rust
let _ = tray.set_title(if count > 0 {
    Some(count.to_string())
} else {
    None
});
```

⇒ 在 macOS 菜单栏里，`set_title` 的文字会**常驻显示在应用图标右侧**。

数字口径 = `SELECT COUNT(*) FROM tasks WHERE status = 'doing' AND candidate_done = 0`
⇒ **「处理中」的任务数**。

⚠️ **与应用内那个「未完成 N 条」是两个不同口径**：
- 菜单栏 = `status = 'doing'`（处理中）
- 应用内（侧栏账号分组，#516）= 排除 `issue_state = 'closed'` 与 `status = 'done'`（未完成）

⇒ 用户最初问的「19 是什么意思」与这个「13」**不是同一个数字**，只是恰好都被问过。

## 修复

菜单栏图标旁**不再**显示数字，数字改由 **tooltip** 承载：

```rust
let _ = tray.set_title::<&str>(None);
let _ = tray.set_tooltip(Some(format!("TaskBoard · 处理中 {}", count)));
```

⚠️ **为什么不是「删掉整个 `refresh_tray`」**：tooltip 里的数字是有用信息
（有多少任务在处理中），只是**不该常驻在菜单栏** ⇒ hover 可见、菜单栏干净。

## 验证

### 真机实测（`npm run tauri dev` + `screencapture`）

⚠️ 这一项**只有真 app 能验**（菜单栏是 OS 绘制的，webview 碰不到）。

实测截图里**同时存在两个 TaskBoard 菜单栏图标**（用户装着的 v0.8.2 + 刚编译的 dev 版）：

| 图标 | 来源 | 右侧 |
|---|---|---|
| 左 | 已安装的 v0.8.2（旧代码） | **「13」** |
| 右 | 本次 dev 构建（新代码） | **无数字** ✓ |

⇒ 修复生效；用户**升级到新版本**后菜单栏即只剩图标。

### 回归测试（+1）

`app/src-tauri/src/lib.rs` 的测试模块（与本模块既有的 tray 回归同一手法）：

```rust
#[test]
fn tray_does_not_set_a_numeric_title() { … }
```

⚠️ 断言走**源码静态检查**（`include_str!("lib.rs")`）：`refresh_tray` 需要真实
`AppHandle`，单测无法构造；而缺陷的本质就是「标题设成了什么」。

### ⚠️ 一个值得记的测试坑

`include_str!("lib.rs")` 嵌的是**本文件自己** ⇒ **断言串与代码注释都会进入被扫文本**
⇒ 直接写字面量会让断言**命中自己** ⇒ **恒真**。

⇒ 断言串必须用 `format!` **拼出来**；且**代码注释里也不能**写出旧实现的完整调用串
（第一版就踩了：注释里写了完整调用 ⇒ 断言恒失败）。

> 同型坑：仓库前端 `?raw` 源码断言也踩过（注释里出现同一字符串 ⇒ 断言恒真）。

### 反向验证

把实现临时改回旧写法 ⇒ 用例 **FAILED**；还原 ⇒ **ok** ⇒ 断言确有判别力。

### 门禁

| 项 | 结果 |
|---|---|
| `cargo fmt --check` / `clippy --all-targets` / `test` | ✓（266 + 27 + **1**） |
| `npx tsc --noEmit` / `lint` / `prettier` / `build` / `i18n:check` | ✓ |
| `npx vitest run` | ✓ 34 文件 / 558 例 |
| `python3 -m unittest discover -s scripts -p 'test_*.py'` | ✓ 143 例 |
| 四个 `scripts/check-*.py` | ✓ |

## 影响面

| 文件 | 改动 |
|---|---|
| `app/src-tauri/src/lib.rs` | `refresh_tray` 不再设数字标题（+1 条回归测试） |

**零前端改动** · 零 DB schema · 零新依赖 · 零新 i18n 词条。

## 已知边界

- tooltip 仍带数字（hover 可见）—— 若连 tooltip 也不要，把 `set_tooltip` 一并去掉即可
  （那样 `refresh_tray` 的 `count` 查询也就没有存在意义了，可一并删）。
- 托盘点击行为（左键切换窗口显示/隐藏）**未变**。
