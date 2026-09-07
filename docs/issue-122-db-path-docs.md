# Issue #122: 数据库路径全平台标注

## 背景 / 动机

TaskBoard 定位为跨平台桌面应用，但 README 与 Rust 源码注释中凡提到数据库路径默认位置，全都只写了 macOS 独有的路径。Windows/Linux 用户看到后会困惑「我去哪里找」。

## 设计 / 方案

### 各平台真实默认路径

| 平台 | 默认路径 | 说明 |
|---|---|---|
| macOS | `~/Library/Application Support/com.shawnliu.taskboard/taskboard.db` | 当前已写 |
| Windows | `%APPDATA%\com.shawnliu.taskboard\taskboard.db` | 走 Known Folders，尊重用户重定向 |
| Linux | `$XDG_CONFIG_HOME/com.shawnliu.taskboard/taskboard.db` | 缺省 `~/.config` |

### 改动内容

1. README.md: 更新本地数据路径为三平台说明
2. README.en.md: 同步更新英文版本
3. app/src-tauri/src/db.rs: 更新 data_dir() 文档注释

## 接口 / 行为变更

- 纯文档改动，不涉及代码逻辑变更
- README 中数据库路径覆盖 Windows/macOS/Linux 三平台
- `TASKBOARD_DB` 环境变量覆盖方式保留

## 测试 / 验证

1. README 中三处数据库路径全部覆盖三平台
2. `TASKBOARD_DB` 环境变量覆盖方式可见
3. `cargo doc` 生成的文档中 data_dir() 说明对 Linux/Windows 用户不再误导

## 相关链接

- Issue: https://github.com/ShawnLiuSZ/task-dashboard/issues/122
- 关联 Issue #103: 记事导出默认下载目录
- 关联 Issue #109: 关于页按平台展示
