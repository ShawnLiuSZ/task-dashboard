# issue-593：map_project_status_en 陈旧注释「中文按 contains」改整值全等口径

> 关联：[#593](https://github.com/ShawnLiuSZ/task-dashboard/issues/593) ｜ 2026-11-17 全量核查报告 低危-10

## 背景 / 动机

`app/src-tauri/src/sync.rs::map_project_status_en` 的注释（:117）写：

> `is_alphanumeric()` 对汉字为真，但中文已在上面按 `contains` 处理，不会落到这里。

但 #450 已把中文分支（`map_project_status_zh`）从 `contains` 子串匹配改为**归一化整值
全等**（见 `sync.rs:44-66` 文档注释）。注释的「中文按 `contains` 处理」是旧口径，误导
后来者以为仍用子串匹配。

## 设计 / 方案

**纯文档修正（无行为变更）**：注释改为「中文已由 `map_project_status_zh`（#450 起改
整值全等，非 `contains`）处理；未收录的自定义中文状态会落到这里，`is_alphanumeric()`
保留汉字后不匹配任何英文选项 ⇒ 返回 None（保持本地手动态，绝不臆造）」。

## 接口 / 行为变更

- 无（仅注释文本，不改映射逻辑）。

## 测试 / 验收

- `cargo check --manifest-path app/src-tauri/Cargo.toml` 通过（注释变更编译正常）。
- 注释现与 `map_project_status_zh`（#450 整值全等）文档一致，不再互相矛盾。

## 相关链接

- Issue：[#593](https://github.com/ShawnLiuSZ/task-dashboard/issues/593)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（低危-10）
- 既有：#450（中文分支改整值全等）、#335（英文分支引入）
