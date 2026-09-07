# issue-103：记事导出默认写入设备下载目录

> v0.3.45 · 关联 [Issue #103](https://github.com/ShawnLiuSZ/task-dashboard/issues/103)

## 背景 / 动机

「导出全部记事」后端 `export_notes` 原先把 JSON 写死到应用数据目录
`~/Library/Application Support/com.shawnliu.taskboard/notes-backup/`。用户反馈导出结果难以找到，不符合「导出 = 下载到用户可见位置」的直觉。

需求：让用户自己选择保存位置，**默认设备下载目录**（macOS `~/Downloads`）。

## 设计 / 方案

### 方案评审

- **方案 A（原生保存对话框）**：体验最好、真正「自由选路径」，但需新增官方 `tauri-plugin-dialog` 依赖，与「不引入新依赖」硬约束冲突。
- **方案 B（默认下载目录 + 展示路径，零新依赖）**：`export_notes` 新增可选 `target_dir`；未传则落到 `dirs::download_dir()`（各平台真实下载目录），取不到/不可写时回退应用数据目录。**本仓库已依赖 `dirs 5`，零新增依赖**，符合约束。

经补充说明（[comment 5566296708](https://github.com/ShawnLiuSZ/task-dashboard/issues/103#issuecomment-5566296708)）确认跨平台均可用 `dirs::download_dir()`，选定 **方案 B**。

### 分平台 `dirs::download_dir()` 返回

| 平台 | 返回 |
|---|---|
| macOS | `~/Downloads` |
| Windows | `%USERPROFILE%\Downloads`（Known Folders，尊重重定向） |
| Linux | `$XDG_DOWNLOAD_DIR`（通常 `~/Downloads`） |

### 实现（见 [commands.rs](file:///Users/liushizhao/dev/dashboard/app/src-tauri/src/commands.rs)）

1. `export_notes(state, target_dir: Option<String>)`：`target_dir` 缺省时用下载目录；前端不传即自动获得默认下载行为。
2. 新增私有 `resolve_export_dir(target_dir)`：优先级 **target_dir → 系统下载目录 → 应用数据目录 `notes-backup/`**；对候选目录逐个 `create_dir_all` 校验可写，全失败才走兜底；`download_dir()` 与 `target_dir` 相同项去重。
3. 前端 [NotesPanel.tsx](file:///Users/liushizhao/dev/dashboard/app/src/components/NotesPanel.tsx) 导出成功提示本就展示 `→ {path}` 完整路径，无需改动即可告知用户文件落点。

### 关键权衡

- 保持「不引入新依赖」：`dirs` 已在用，`download_dir()` 免费获得三端真实下载目录。
- 优雅降级：下载目录取不到 / 不可写时回退应用数据目录，保证导出永远有输出、不因目录不可用而失败。
- 不用原生对话框（避免新依赖）；「自由选择任意路径」本次以 `target_dir` 参数形式开放给有能力传入的调用方，前端默认体验已满足「默认下载目录」。

## 接口 / 行为变更

- `export_notes(target_dir?: string, state)`（命令签名新增可空参 `target_dir`）；返回值不变 `{ path, count }`。
- 行为：未传 `target_dir` 时默认写入系统下载目录（原先写入应用数据目录 `notes-backup/`）。前端导出成功提示继续展示 `path`。
- 本地 DB / schema 零变更。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `cargo check`（macOS）通过。
- 新增 `commands::tests::resolve_export_dir_prefers_target_then_download`：空白 `target_dir` 回退下载目录；合法自定义目录优先返回。
- 手动验收：
  1. 点击「导出全部记事」→ 文件生成于 `~/Downloads/notes-backup-YYYYMMDD-HHMMSS.json`，提示展示完整路径与条数。
  2. 模拟下载目录不可用（如临时改权限）→ 自动回退应用数据目录，仍正常导出、有提示。
  3. 可传 `target_dir` 的调用方会写到指定目录。

## 相关链接

- Issue：[#103](https://github.com/ShawnLiuSZ/task-dashboard/issues/103)
- 代码：`app/src-tauri/src/commands.rs::export_notes` / `resolve_export_dir`；`app/src/components/NotesPanel.tsx`、`app/src/api.ts`
- 前序文档：[docs/issue-53-notes-backup.md](./issue-53-notes-backup.md)
- CHANGELOG：`docs/CHANGELOG.md` / `docs/CHANGELOG.en.md` v0.3.45