# #367 静态守卫补「失去意义」自诊断（#355 修复引入的新脆弱点）

> 对应 issue：[#367](https://github.com/ShawnLiuSZ/task-dashboard/issues/367)
>
> 分支：`fix/issue-367-static-guard-fragile`
>
> 类别：Rust 后端 / 防回归测试自身的可靠性

## 背景 / 动机

`#355` 修掉了一个**本来就失效**的防回归测试，并留下一处新的脆弱点。本次是对它的收尾加固。

## 设计 / 方案

### #355 修掉了什么

`write_commands_check_affected_rows` 原先用 `src.matches(needle)` 对**整份源码**计数，而 `mod tests` 里该文件自己的用例也含同样的 `require_affected(` 调用 —— 计数被断言自身抬高，加上旧断言用 `>=` 且阈值恰好等于当时的实数，「又漏掉一条」时计数不降。反向验证时真的被骗过（删掉守卫后用例仍通过）。

修复为「过滤注释 + 截断到测试代码之前 + `assert_eq!(…, 5)`」。

### 遗留的脆弱点

`take_while(|l| !l.trim_start().starts_with("mod tests {"))` 依赖「**`mod tests` 是本文件唯一的测试模块**」这一未被断言的前提。测试模块被改名或拆分后，截断点消失 ⇒ 计数重新把测试代码算进去 ⇒ **静默退化成 #355 修复前的失效状态**，且不会有任何报错。

### 修法

1. 截断点改用 `#[cfg(test)]`（语义更准：它标注的就是「测试代码从这里开始」），找不到时**显式 panic**。
2. 补「截断点之前确实读到了生产代码」的守卫 —— 范式照搬 `app/src/lint-config.test.ts` 已有的「本条测试失去意义」用例。

## ⚠️ 实测修正了我最初的问题判断

我原以为旧实现在「新增更靠前的测试模块」时会因计数被截掉而报「实测 0 处」（误导性报错）。**构造场景逐一验证后并非如此**：

| 场景 | 旧实现（`take_while "mod tests {"`） | 新实现（`#[cfg(test)]` + 守卫） |
|---|---|---|
| 删掉任一真实守卫 | FAILED（实测 4 处）✓ | FAILED（实测 4 处）✓ |
| **在文件顶部插入一个测试模块** | **通过（静默报「实测 5 处」）** | **FAILED，报「截断点之前没找到任何 require_affected 调用，静态断言已失去意义」** |
| 测试模块改名 `mod tests` → `mod renamed_tests` | 通过 | 通过（截断点仍由 `#[cfg(test)]` 命中，行为不变） |

原因是：`mod tests {` 在这些场景下**仍能正确命中**（本文件目前确实只有一个测试模块），计数仍是 5。

**因此新守卫的真实价值不在「能否失败」，而在「计数失去意义时报错是否自诊断」**：旧写法静默通过，新写法明确告诉排查者「这个断言的前提已经不成立了」。

这也再次印证 #355 / #358 的教训：**静默通过的失效断言比直接失败的更危险**。

## 接口 / 行为变更

无（仅测试代码强化）。

## 数据 / Schema 变更

无。

## 测试 / 验收

改动限于 `app/src-tauri/src/commands.rs` 的 `write_commands_check_affected_rows`：

- 截断点 `mod tests {` → `#[cfg(test)]`，缺失时显式 panic
- 新增守卫：截断点之前必须确实读到 `require_affected` 调用，否则报「静态断言已失去意义」
- 同步更新该用例的文档注释，**按实测结论更正**（原注释把「新增更靠前的测试模块会报 0 处」当作事实，实测不成立）

已跑：`cargo test --lib` 160 passed、`cargo test --test db_test` 26 passed、`cargo fmt --check`、`cargo clippy --all-targets -p taskboard -- -D warnings`（0 error）。

## 附：全仓静态断言审计（本次顺带完成）

借 #355 暴露的模式（**断言声称的覆盖范围与实际不符 / 静态断言被自身污染**）审计了全仓 6 处静态断言，逐个做反向验证：

| 断言文件 | 反向验证手法 | 结果 |
|---|---|---|
| `panel-wiring.test.ts` | `TaskCard` 改回裸 `issueKey`（#339 缺陷形态） | FAILED ✓ |
| `panel-wiring.test.ts` | `SyncLogsPanel` 改回 `[onClose]` 依赖（#344 缺陷形态） | FAILED ✓ |
| `styles.test.ts` | 把 `overflow: auto` 改成 `hidden` | FAILED ✓ |
| `lint-config.test.ts` | 从 `allowExportNames` 删一条 | FAILED（2 例）✓ |
| `about-window.test.ts` | 从 `about.json` 删 `allow-close`（#327 缺陷形态） | FAILED ✓ |
| `notes-layout.test.ts` | 给面板加回行内 `style={{flex:'0 0 25%'}}`（#202 缺陷形态） | FAILED ✓ |

**结论：6 处均为承重的断言**；审计过程中额外发现其中一条（#344 我自己写的）守卫失效并已修复。 它们普遍具备三个良好特征，可作为后续新增静态断言的范式：

1. **剥离注释**后再匹配（`notes-layout.test.ts` / `styles.test.ts` / `about-window.test.ts`）—— 避免注释里提到的写法被命中；
2. **「失去意义」守卫**（`lint-config.test.ts`）—— 先断言「确实读到了东西」，再断言内容；
3. **双向相等**而非单向包含（`lint-config.test.ts` 比对真实导出集合与配置名单）。

> 审计中曾出现一次误判：首次注入行内样式时正则未匹配到 `<aside className="notes-panel">`（我误按 `<div>` 匹配），导致「反向验证没失败」的假警报。修正选择器后如期失败。**这本身印证了此类验证必须确认注入真的生效** —— 否则会把「注入失败」误读成「断言失效」。

### 审计发现 #367 的一处失效守卫（已修）

审计 `panel-wiring.test.ts` 时发现，**#344 我自己写的那条守卫其实是失效的**：

```ts
const effect = escHookRaw.match(/.../)?.[0];
expect(effect, '应能取到 useWindowEscLayer 里注册层的 effect').not.toBe('');
```

`?.[0]` 无匹配时是 **`undefined`**，而 `expect(undefined).not.toBe('')` **会通过**（`undefined !== ''`）⇒ 守卫恒真。

实测确认：破坏 `useEscLayer` 里的注册层片段后，该用例**仍然 25 passed 全绿**。加 `?? ''` 兜底后，同一注入如实失败：

```
AssertionError: 应能取到 useWindowEscLayer 里注册层的 effect: expected '' not to be ''
Tests  1 failed | 24 passed (25)
```

**同一文件里另外三处同类守卫都写对了**（`?? ''` 后接 `not.toBe('')`），只有这一处漏了。已全仓复查 `not.toBe('')` 守卫 —— 仅此一处是 `?.[0]` 无兜底，其余均为 `?? ''`。

Rust 侧无同类问题：`String` 没有 `undefined` 语义，`Option<String>::unwrap_or_default()` 得到的就是空串，`assert!(!x.is_empty())` 行为确定。#367 的 `production.contains(&needle)` 守卫同样不存在静默通过。

## 相关链接

- Issue：[#367](https://github.com/ShawnLiuSZ/task-dashboard/issues/367)
- 前序：[`docs/issue-355-require-affected-remaining-writes.md`](./issue-355-require-affected-remaining-writes.md)（本次加固其修法）
- 同类问题：[`docs/issue-358-issue-url-anchor.md`](./issue-358-issue-url-anchor.md)（注释声称的覆盖范围与实际不符）
- 正确范式参考：[`app/src/lint-config.test.ts`](../app/src/lint-config.test.ts)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)