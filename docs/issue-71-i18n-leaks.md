# i18n 文本泄漏修复（#71）

> 关联：[Issue #71](https://github.com/ShawnLiuSZ/task-dashboard/issues/71)、[docs/CHANGELOG.md](./CHANGELOG.md)

## 背景 / 动机

审计发现两处可见文案未接入 i18n，英文界面（en-US）下仍显示中文，属 issue #62 已识别范围外的「新遗漏」：

1. **SettingsPanel「诊断 & 项目列表」**：`diagnoseProject` 用模板字符串拼接中文文本（`组织 X / 用户 Y`、`发现 N 个 Project`、`已拉取 Status N 条`、`示例: …`）。
2. **DetailPanel「记录会话」agent 下拉**：`AGENTS` 常量中 `doubao`→`豆包 (Doubao)`、`glm`→`智谱 GLM`、`tongyi`→`通义灵码` 为硬编码中文 label，英文界面不翻译。

## 设计 / 方案

### DetailPanel agent 下拉

- `AgentOption` 增加可选 `i18nKey`，仅对三个中文项 `doubao/glm/tongyi` 设置。
- 新增 `agentLabel(value, t)` helper：命中 `i18nKey` 走 `t()`，否则用默认 `label`，未知 slug 原样返回。存储仍只认 `value`（`i18n.t` 仅展示层）。
- 下拉 option 与「本次记录于 {agent}」回显统一经 `agentLabel` 渲染，回显不再裸显 slug。

### SettingsPanel 诊断文本

- `diagnoseProject` 组装文本改为 `t()` 插值（项目 i18n 已用 `{var}` 占位符约定）。

## 接口 / 行为变更

- 无 RPC / Command / Schema 变更，纯展示层文本。
- 新增 i18n key（双语一致）：
  - `agents.doubao` / `agents.glm` / `agents.tongyi`
  - `settings.diagOrgUser` / `settings.diagProjects` / `settings.diagNone` / `settings.diagStatuses` / `settings.diagExample`

## 数据 / Schema 变更

无。

## 测试 / 验收

- `npm run i18n:check` 通过：zh-CN / en-US 各 192 个 key，占位符一致，无空翻译。
- `npx tsc --noEmit` 通过（`agentLabel` 的 `t` 签名与 `useI18n` 返回类型兼容）。
- 手工验收：英文界面下 SettingsPanel 诊断结果、DetailPanel agent 下拉均显示英文（Doubao / Zhipu GLM / Tongyi Lingma）。

## 相关链接

- [Issue #71](https://github.com/ShawnLiuSZ/task-dashboard/issues/71)
- [docs/CHANGELOG.md](./CHANGELOG.md) v0.3.36