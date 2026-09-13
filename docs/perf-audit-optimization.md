# 性能 / 安全优化批次索引（P0-1 … P2-2）

> **本文档性质**：批次**索引**，不是审计报告原文。2026-09 的性能 / 安全优化批次（issue `#143`–`#150`）在实施时**未把审计报告落库**，导致 [docs/issue-143-147-sync-concurrency.md](./issue-143-147-sync-concurrency.md) 等 4 篇文档的「前置 KB」链接长期悬空。本文依据 **GitHub issue 的真实标题**把 `P0-1`…`P2-2` 编号映射到 issue 与落地文档，**不重新陈述未经落库的审计发现**。补写原因见 [#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)。

## 批次概览

| 优先级 | 编号 | Issue | 主题 | 落地文档 |
|---|---|---|---|---|
| P0 | **P0-1** | [#143](https://github.com/ShawnLiuSZ/task-dashboard/issues/143) | 同步链路并发化：5 个 Search 源 + Project 拉取并行，去掉固定 `sleep` | [issue-143-147-sync-concurrency.md](./issue-143-147-sync-concurrency.md) |
| P0 | **P0-2** | [#144](https://github.com/ShawnLiuSZ/task-dashboard/issues/144) | 同步链路 N+1 消除 + 整段事务化写入 | [issue-144-146-sync-db.md](./issue-144-146-sync-db.md) |
| P0 | **P0-3** | [#145](https://github.com/ShawnLiuSZ/task-dashboard/issues/145) | 前端 `Promise.all` 并行加载 + Board/TaskCard `memo` + 搜索防抖 | [issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md) |
| P1 | **P1-1** | [#146](https://github.com/ShawnLiuSZ/task-dashboard/issues/146) | DB 索引补齐：`label_mappings` 复合索引 + `tasks` board 索引 + `notes` 唯一索引 + prune 索引 | [issue-144-146-sync-db.md](./issue-144-146-sync-db.md) |
| P1 | **P1-2** | [#147](https://github.com/ShawnLiuSZ/task-dashboard/issues/147) | DB 建连 `user_version` 版本化迁移 + `common.rs` 抽取 + `import_notes` 事务化 | [issue-143-147-sync-concurrency.md](./issue-143-147-sync-concurrency.md) |
| P1 | **P1-3** | [#148](https://github.com/ShawnLiuSZ/task-dashboard/issues/148) | 类型 / 拼写 bug 修复：清零 i18n `any` + SyncLogsPanel/NotesPanel 补 i18n + `check_update` URL 修正 | [issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md) |
| P2 | **P2-1** | [#149](https://github.com/ShawnLiuSZ/task-dashboard/issues/149) | 安全加固：PAT Keychain / CSP / 跨平台 `open_in_browser` / DB 文件权限 / 日志门控 | [issue-149-security-hardening.md](./issue-149-security-hardening.md) |
| P2 | **P2-2** | [#150](https://github.com/ShawnLiuSZ/task-dashboard/issues/150) | 可访问性 a11y + CSS 收敛：TaskCard 键盘可达 + modal `role`/焦点陷阱 + 对比度提升 | [issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md) |

### 落地 PR（合并提交）

| PR | 内容 | 覆盖编号 |
|---|---|---|
| #151 | `perf(sync+db)`: 预加载消除 N+1 并单事务写入，补齐热查询索引 | #144、#146 |
| #152 | `perf(sync)`: 五源与项目并行拉取 + Search 限流门，`user_version` 迁移，抽 `common` 公共模块 | #143、#147 |

## 「前置 KB」编号对照（供 4 篇落地文档溯源）

原文档中的引用组合，与上表的映射关系：

| 引用出处 | 引用编号 | 对应 issue |
|---|---|---|
| [issue-143-147-sync-concurrency.md](./issue-143-147-sync-concurrency.md) | P0-1 / P1-2 | #143 / #147 |
| [issue-144-146-sync-db.md](./issue-144-146-sync-db.md) | P0-2 / P1-1 | #144 / #146 |
| [issue-145-148-150-frontend.md](./issue-145-148-150-frontend.md) | P0-3 / P1-3 / P2 | #145 / #148 / #149+#150 |
| [issue-149-security-hardening.md](./issue-149-security-hardening.md) | P2 | #149 |

## 数据 / Schema 变更

本索引本身不含 schema 变更。批次内的 schema 变更由成员 issue 负责，其中影响面最大的是 **P1-2（#147）**：`open_db()` 引入 `PRAGMA user_version` 版本化迁移。这一机制是后续所有列迁移（如 [#175 的 `work_branch`](./issue-175-work-branch-migration-gap.md)、[#237 的 `author`](./issue-237-card-creator-row.md)）的前置条件——**新增列必须放在 `migrate_tasks_v2_rebuild` 之后的热路径**，原因见 [issue-237-card-creator-row.md](./issue-237-card-creator-row.md)「决策 5」。

## 测试 / 验收

本索引无独立测试。批次验收以各成员 issue 的落地文档为准。

## 相关链接

- 批次 issue：[#143](https://github.com/ShawnLiuSZ/task-dashboard/issues/143)、[#144](https://github.com/ShawnLiuSZ/task-dashboard/issues/144)、[#145](https://github.com/ShawnLiuSZ/task-dashboard/issues/145)、[#146](https://github.com/ShawnLiuSZ/task-dashboard/issues/146)、[#147](https://github.com/ShawnLiuSZ/task-dashboard/issues/147)、[#148](https://github.com/ShawnLiuSZ/task-dashboard/issues/148)、[#149](https://github.com/ShawnLiuSZ/task-dashboard/issues/149)、[#150](https://github.com/ShawnLiuSZ/task-dashboard/issues/150)
- 落地 PR：[#151](https://github.com/ShawnLiuSZ/task-dashboard/pull/151)、[#152](https://github.com/ShawnLiuSZ/task-dashboard/pull/152)
- 补写原因：[#239](https://github.com/ShawnLiuSZ/task-dashboard/issues/239)
- CHANGELOG：[docs/CHANGELOG.md](./CHANGELOG.md) **v0.3.50** 条目（本批次实际随 v0.3.50 发布）
- ⚠️ **版本号提醒**：源码中本批次相关注释标注为 `v0.3.49`，但 **`v0.3.49` 从未打 tag、从未发布**（tag 序列 `v0.3.48` → `v0.3.50`，该版本号被跳过）。`git tag --contains` 已验证本批次全部提交均在 `v0.3.50` 内。代码注释未作订正。
