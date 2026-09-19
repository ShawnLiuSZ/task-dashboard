# Issue #286：切换账号后搜索状态未重置

## 背景 / 动机

在账号 A 的搜索框输入 issue 编号后切换到账号 B，搜索框仍保留上次内容，导致新账号看板被过滤为空。
用户误以为数据丢失，需手动清空搜索框才能恢复。[Issue #286](https://github.com/ShawnLiuSZ/task-dashboard/issues/286)。

## 设计 / 方案

在 `handleSwitchAccount` 中重置 `query` 和 `repo` 为 `""`，与 `clearAllFilters` 行为一致。
切换账号意味着上下文完全变化，所有前端筛选条件都应归零。

## 接口 / 行为变更

无 API 变更。仅修改 `handleSwitchAccount` 内部逻辑：

```
setError(null);
setNav('board');
setQuery('');      // ← 新增
setRepo('');       // ← 新增
setHiddenAfterSync(0);  // ← 新增
```

## 测试 / 验收

- `npx tsc --noEmit` ✓
- `npm test` ✓（136/136 通过）

## 相关链接

- [Issue #286](https://github.com/ShawnLiuSZ/task-dashboard/issues/286)
