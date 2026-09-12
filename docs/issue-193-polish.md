# Issue #193：启动自动注册 dev 路径 + workBranch 可见性

## 背景 / 动机

2026-09-11 review 的两个 Low 发现，owner 建议两个都做。对应 issue：[#193](https://github.com/ShawnLiuSZ/task-dashboard/issues/193)。

## 设计 / 方案

### 1. 开发版跳过启动自动注册

`hooks.rs::ensure_global_defaults` 在 `mcp_bin()` 命中 `is_dev_binary`（路径含 `/target/` 或 `\target\`）时直接返回空（不碰用户全局配置）。dev 路径重编即失效，此前会留下一条无效 MCP/hook 命令（虽有陈旧路径自愈，但多余一次无效写入）。手动指引 `global_opencode_mcp_notice` 的"开发版"警告文案保持不变。

### 2. `work_branch` 贯通到 UI

`record_session(..., branch)` 写进 `work_branch`（#171 起与 PR `branch` 分离），但 Tauri 通道从未暴露。贯通链路：`commands.rs::Task` + 两处 `rows_to_tasks` SELECT（末尾追加 `work_branch`，mapper `r.get(23)`）→ `types.ts::Task.workBranch` → 详情页新增一行（与 PR 分支相同时不重复展示）→ 中英 `detail.workBranch` key。`taskListSignature` 同步纳入 `workBranch`（本地写入维度），`taskSig.test.ts` 追加断言；4 个测试 fixture 补字段。

## 接口 / 行为变更

- `list_tasks` 返回新增 `workBranch` 字段（ additive，前端旧版本忽略即可；本仓库前后端同发版）。
- 详情页：有工作分支且与 PR 分支不同时多一行展示 + 复制按钮。
- 启动行为：dev 版启动不再写全局 agent 配置（正式版不变）。

## 数据 / Schema 变更

无（`work_branch` 列 #171 已存在；MCP `SELECT_COLS` 24 列不变，`check-mcp-columns.py` 通过）。

## 测试 / 验收

- `hooks::tests::dev_binary_detection`：posix/win dev 路径 + 正式版路径 + 空串
- `taskSig` 指纹：workBranch 变化 → 指纹变化
- `cargo test` 66 + 19 passed；`tsc`、`vitest` 36 passed、`i18n:check` 274 key 双语一致

## 相关链接

- Issue：[#193](https://github.com/ShawnLiuSZ/task-dashboard/issues/193)
- 分支：`fix/issue-192-193-label-priority-polish`（与 #192 同分支，文件有重叠：`hooks.rs`，commit 内分开说明）
- `CHANGELOG.md`：待发版时追加
