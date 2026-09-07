# 记事本导出 / 导入功能（issue #53）

> 涉及版本：v0.3.27
>
> 关联：[GitHub Issue #53](https://github.com/ShawnLiuSZ/task-dashborad/issues/53)、[docs/CHANGELOG.md](./CHANGELOG.md)、PR → develop

## 背景 / 动机

破坏性更新（重新安装、清空数据、版本升级覆盖 SQLite 文件等）可能导致本地记事本数据丢失。此前记事本内容仅存于本地 `taskboard.db`，没有任何备份 / 恢复入口，一旦数据目录被清理即无法找回。

本功能为记事本增加**导出 / 导入**能力，让用户在破坏性更新前先做备份、更新后一键恢复，同时保证导入**不覆盖已有数据、按内容去重**，避免重复条目。

## 设计 / 方案

### 数据形态：JSON 包

导出文件固定写入应用数据目录下 `notes-backup/`（macOS：`~/Library/Application Support/com.shawnliu.taskboard/notes-backup/`），文件名 `notes-backup-YYYYMMDD-HHMMSS.json`，内容含版本号与导出时间：

```json
{
  "version": 1,
  "exportedAt": 1760000000,
  "notes": [{ "content": "...", "label": "low", "createdAt": 0, "updatedAt": 0 }]
}
```

仅含记事业务数据，**不含 token / 账号等敏感信息**。

### 去重策略

以 `content` 唯一判重复：导入时若某条 `content` 已存在则**跳过**（计入 `skipped`），否则插入并**保留导入文件的创建 / 更新时间**。这样重复导两次不会产生重复条目，且不会覆盖本地已编辑的记事。

### 关键取舍

- **导入不依赖文件系统路径**：Tauri 2 移除了 `File.path`，前端无法拿到所选文件绝对路径。改为前端用 `<input type=file>` 读取文本，把 JSON 字符串直接传给后端解析。这不引入文件选择 dialog，且天然跨平台。
- **字段命名**：导出方 `Note` 与导入方 `ImportNoteItem` 均 `#[serde(rename_all = "camelCase")]`，保证 roundtrip 一致。
- **时间格式化零依赖**：文件名时间戳用自实现 `civil_from_days`（Howard Hinnant 算法，兼容 1970 前/后）拼 `YYYYMMDD-HHMMSS`，不引入 chrono。

## 接口 / 行为变更

- 后端新增两个 Tauri command：
  - `export_notes() -> { path, count }`：导出全部记事为 JSON，返回文件路径与条数。
  - `import_notes(json: string) -> { imported, skipped }`：从 JSON 文本导入记事，返回新增数与跳过数。
- 前端 `NotesPanel` header 新增导出（下载）、导入（上传）两个图标按钮 + 隐藏文件 input；操作反馈用绿色 success 提示条，失败用红条。

## 数据 / Schema 变更

无新增列 / 表。复用既有 `notes` 表（`id / content / label / created_at / updated_at`）。

## 测试 / 验收

- 单元测试（Rust）：
  - `time_str_formats_epoch_and_boundaries`：时间格式化在 epoch 与典型边界的正确性。
  - `import_note_dedupes_by_content`：相同 `content` 只插入一次、保留原时间、空内容跳过。
- 前端检查：`tsc --noEmit`、`i18n:check`（新增按钮仅图标，无新增 i18n key）通过。

> 注：`tests/db_test.rs` 中 2 个关于账号校验 / 删除的用例在基线上已失败，与本功能无关。

## 相关链接

- [Issue #53](https://github.com/ShawnLiuSZ/task-dashborad/issues/53)
- 代码：`app/src-tauri/src/commands.rs`（`export_notes` / `import_notes`）、`app/src-tauri/src/db.rs`（`import_note`）、`app/src/components/NotesPanel.tsx`、`app/src/api.ts`
- [docs/CHANGELOG.md](./CHANGELOG.md)