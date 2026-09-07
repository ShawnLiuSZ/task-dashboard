# Issue #54 — 授权登录后账号 modal 不自动刷新

## 背景 / 动机

对应 Issue：[#54](https://github.com/ShawnLiuSZ/task-dashborad/issues/54)

在「账号」modal 中完成 GitHub 设备授权登录后，账号列表不会自动刷新，新授权的账号不显示；必须手动关闭再重开 modal 才会出现。

## 设计 / 方案

根因定位：`AccountsPanel` 把父级 props 快照进本地 state（`useState<Account[]>(settings.accounts)`），此后**没有任何机制把 props 变化同步回本地 state**。

授权成功时只调用 `onAccountsChanged()`，由父级 `loadSettings()` 刷新 `settings`，但本地 `accounts` 始终是快照时的旧值，只能靠组件重新挂载（关闭重开 modal）才刷新。

修复：`AccountsPanel.tsx` 增加一个 `useEffect`，把 `settings.accounts` 同步回本地 state：

```tsx
useEffect(() => {
  setAccounts(settings.accounts);
}, [settings.accounts]);
```

- **全量替换而非追加**，天然避免重复账号
- 依赖数组 `[settings.accounts]`：仅当账号列表真正变化时才触发
- 顺带修复同根因问题——「设为默认」后账号的默认标签不立即更新

## 接口 / 行为变更

- UI 行为：授权成功回调后，账号 modal 中的账号列表自动刷新，新账号即时显示；无需关闭重开
- UI 行为：「设为默认」后列表内默认标签即时更新
- 无 Tauri 命令、MCP 工具或数据结构变更

## 数据 / Schema 变更

无。纯前端 state 同步逻辑调整。

## 测试 / 验收

- [x] 授权成功回调后账号列表自动刷新、新账号即时显示
- [x] 无需手动关闭/重开 modal 即可看到新账号
- [x] 不出现重复账号或数据错乱
- [x] 「设为默认」后默认标签即时更新
- [x] `npx tsc --noEmit` 通过

## 相关链接

- Issue：[#54](https://github.com/ShawnLiuSZ/task-dashborad/issues/54)
- 分支：`feature/issue-54-auth-account-refresh`
- Commit：`4d94473`
- 版本：v0.3.26（[`docs/CHANGELOG.md`](./CHANGELOG.md)）