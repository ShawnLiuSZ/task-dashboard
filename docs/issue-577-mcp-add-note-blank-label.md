# issue-577：add_note / update_note_label 空白标签与 Rust 分歧

> 关联：[#577](https://github.com/ShawnLiuSZ/task-dashboard/issues/577) ｜ 2026-11-17 全量核查报告 低危-1

## 背景 / 动机

`mcp_server/server.py` 的 `tool_add_note`（:1140-1147）与 `tool_update_note_label`（:1179-1184）
的 label 归一化：

```python
label = (label or "low").strip().lower()
if label not in VALID_NOTE_LABELS:
    raise ValueError(f"无效标签: ...")
```

纯空白标签（如 `label="  "`）→ `.strip()` → `""` → `"" not in VALID_NOTE_LABELS`
⇒ 抛「无效标签」。

Rust 侧 `common.rs::normalize_note_label`（:529-533）：

```rust
let l = label.unwrap_or("low").trim().to_lowercase();
if l.is_empty() {
    return Ok("low".to_string());
}
```

空白标签**回退 low**，不报错。两实现注释互相声称「对齐」，行为却分歧。

## 设计 / 方案

在两处 `tool_add_note` / `tool_update_note_label` 的 `.strip().lower()` 后补：

```python
if not label:
    label = "low"
```

对齐 Rust `l.is_empty() => Ok("low")`。

## 接口 / 行为变更

- `add_note` / `update_note_label` 传空白标签（`""` / `"  "`）从「抛 ValueError」改为
  「回退 low」（与 Rust 一致）。
- 非法标签（如 `bogus`）仍必报，行为不变。

## 测试 / 验收

- `test_server.py::OnDemandTest::test_blank_note_label_falls_back_to_low`：
  add_note 空串/纯空白→low；update_note_label 空串/纯空白→low；bogus 仍 ValueError。
- **测试隔离修正**：setUp 的 DELETE 清单补 `DELETE FROM notes` —— 原清单漏清 notes，
  新增用例残留 2 条污染 `test_notes_crud_smoke` 的计数断言（依赖「唯一 content 不撞」
  不再成立）。同时更新该用例注释。
- 全量 `python3 -m unittest discover -s mcp_server -p 'test_server.py'` 80 例全绿。
- **反向验证**（§5.6）：移除 `if not label: label = "low"` ⇒
  `test_blank_note_label_falls_back_to_low` 变红；还原全绿。

## 相关链接

- Issue：[#577](https://github.com/ShawnLiuSZ/task-dashboard/issues/577)
- 核查报告：`CODE-REVIEW-2026-11-17.md`（低危-1）
- Rust 对照：`app/src-tauri/src/common.rs::normalize_note_label`
