# Issue #120: CI 弃用警告：升级 GitHub Actions

## 背景 / 动机

Release 与 i18n-check 两个 workflow 均触发 GitHub Actions 运行时弃用警告，原因是 Node.js 20 已于 2025-04 结束 EOL，GitHub Actions 运行时已升级为 Node 24 强制执行。

## 设计 / 方案

### 升级内容

| 原 | 新 | 说明 |
|---|---|---|
| `actions/checkout@v4` | `actions/checkout@v5` | v5 目标 Node 24 |
| `actions/setup-node@v4` | `actions/setup-node@v5` | v5 目标 Node 24 |
| `node-version: 20`（release.yml） | `node-version: 22`（当前 LTS） | 比 24 稳，兼容更广 |
| `tauri-apps/tauri-action@v0` | `tauri-apps/tauri-action@v2` | 顺手更新，避免另一条隐式弃用链 |

## 接口 / 行为变更

- 所有 GitHub Actions workflow 不再出现 Node.js 弃用警告
- 构建产物正常产出

## 测试 / 验证

1. 触发一次 release publish → 三个 runner（macOS/Windows/Ubuntu）全部不再出现 Node.js 弃用警告
2. Release 附件正常产出
3. PR 触发 i18n-check → 不再有弃用警告，校验结果与升级前一致

## 相关链接

- Issue: https://github.com/ShawnLiuSZ/task-dashboard/issues/120
- Release workflow: `.github/workflows/release.yml`
- i18n-check workflow: `.github/workflows/i18n-check.yml`
