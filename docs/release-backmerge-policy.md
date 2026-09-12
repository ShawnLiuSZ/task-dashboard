# Release 回合策略：`develop` ← `main`

## 背景 / 动机

2026-09-12 排查发现 **`develop` 结构性落后 `main` 一个发布周期**：release 分支只合入 `main`，**从不回合 `develop`**。

当次实测快照：

| 分支 | HEAD | 三处版本号 | CHANGELOG 首条 |
|---|---|---|---|
| `main` | `851d826` | `0.4.0` | `v0.4.0（2026-09-12）— GitHub 写回反转（#214 + #215）+ 记事本宽度 + 详情重做` |
| `develop` | `766f8f7` | **`0.3.55`** | `v0.3.55（2026-09-11）— 跨 agent 看板 hooks（#177）…` |

`git log origin/develop..origin/main` 列出 main 独有 4 个提交，其中 `79ff2f3 chore(release): bump 版本到 v0.4.0 并补 CHANGELOG` 是 v0.4.0 版本号与 CHANGELOG 条目的**唯一来源**。历史同样：`c845505`（v0.3.55 回合）、`8e6cebb`（v0.3.54 回合）也只在 `main` 上。

**风险**：下次从 `develop` 切 release 分支时，工作树中没有 v0.4.0 的版本号与 CHANGELOG 条目。若在该基线上直接 bump 并发布，会**丢失 v0.4.0 的发布记录**，CHANGELOG 出现断档。

## 设计 / 方案

约定：**每次 release 合入 `main` 后，尽快把 `main` 回合 `develop`**，使 `develop` 的版本元数据始终等于「最近一次已发布版本」。

```bash
git checkout develop && git pull --ff-only origin develop
git checkout -b chore/lsz/sync-v<X.Y.Z>-to-develop
git merge origin/main --no-ff \
  -m "chore(release): 回合 v<X.Y.Z> 发布状态到 develop（版本号 bump + CHANGELOG）"
# 校验 → push → PR(→ develop) → merge
```

要点：

1. **必须走分支 + PR**（AGENTS.md §2.3 禁止在 `develop` 上直接提交）。
2. 分支前缀用 `chore/`（仓库维护操作，非功能开发）。**无需 issue**（AGENTS.md §6.2.3 允许，PR 描述需写明无 issue 原因）。
3. **回合后必须校验 diff 范围**：`git diff --stat <develop-old> HEAD` 应**仅**包含版本号 4 处 + CHANGELOG 中英 2 份。若出现其它文件，说明合并把 `develop` 上未发布的改动冲掉了，必须停下排查。
4. 版本号语义：回合完成后 `develop` 的版本 = **最近一次已发布版本**，未发布的开发内容叠加在其上；下个 release 分支再 bump。
5. 本仓 `main` 为默认分支，release PR 的 `Closes #N` 不会自动关闭 issue，回合不影响该行为。

## 接口 / 行为变更

无。纯版本元数据与文档变更，零运行时行为变更。

## 数据 / Schema 变更

无。

## 测试 / 验收

本次回合（`766f8f7` → `db609dc`）验收结果：

| 检查 | 结果 |
|---|---|
| 合并提交带入的改动（`git diff --stat 766f8f7 db609dc`） | ✅ 恰好 6 个文件：`app/package.json`、`app/src-tauri/Cargo.toml`、`app/src-tauri/Cargo.lock`、`app/src-tauri/tauri.conf.json`、`docs/CHANGELOG.md`、`docs/CHANGELOG.en.md` |
| 四处版本号 | ✅ 均为 `0.4.0`（含易漏的 `Cargo.lock`） |
| CHANGELOG 首条 | ✅ `v0.4.0（2026-09-12）…` 已带回 |
| #232 修复未丢失 | ✅ 抽查 `bundle_root_from_exe` 仍在 `app/src-tauri/src/lib.rs` |
| `npx tsc --noEmit` | ✅ EXIT=0 |
| `npm run build` | ✅ EXIT=0 |
| `npm test` | ✅ 10 suites / 54 tests passed |
| `npm run i18n:check` | ✅ zh-CN / en-US 各 284 key |
| `cargo metadata --locked` | ✅ EXIT=0（`Cargo.lock` 与 `Cargo.toml` 版本一致） |
| `cargo test --lib` | ✅ 75 passed / 0 failed / 2 ignored |

边界场景：若 `main` 回合时与 `develop` 在同一文件产生冲突（例如 `develop` 也改了 CHANGELOG 顶部），**不要**用 `-X ours`/`-X theirs` 粗暴解决，应人工把两侧条目按版本倒序合并。

## 相关链接

- 触发场景：PR #233（#231 / #232）合入 `develop` 后，与 `main` 的 v0.4.0 发布状态对齐
- CHANGELOG：[./CHANGELOG.md](./CHANGELOG.md)
- 发版流程：[AGENTS.md](../AGENTS.md) §4.3、§6.3
