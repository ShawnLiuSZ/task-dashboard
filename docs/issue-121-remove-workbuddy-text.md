# Issue #121: 关于页删除 WorkBuddy/claude-code 专属性 agent 接入话术

## 背景 / 动机

关于页 MCP 接入段有一句针对特定 agent 的非通用话术，需要删除：

> WorkBuddy 已内置注册，在其连接器页「信任」后激活；claude-code 于 ~/.claude.json 添加：

问题：
1. 专属性太强：只提 WorkBuddy / claude-code 两家，其他 agent 用户看完反而不知道自己的 agent 去哪填
2. 与 #109 方向冲突：Issue #109 正在把关于页 MCP 段改为「按安装平台展示 command 路径 + 收敛为单 agent 示例」
3. 文案冗余：紧跟其后的代码块 `MCP_SNIPPET` 已展示通用 `command + args`

## 设计 / 方案

### 改动内容

| 位置 | 改动 |
|---|---|
| `app/src/components/AboutPanel.tsx` | 删除渲染 `<p>{t("about.mcpWorkbuddy")}</p>` 的那行 |
| `app/src/i18n/locales/zh-CN.json` | 删除 `"about.mcpWorkbuddy"` key |
| `app/src/i18n/locales/en-US.json` | 删除对应的英文翻译 key |

### 删除后效果

MCP section 自然收束为：标题 → 通用说明（`about.mcpDesc`）→ 代码块（`MCP_SNIPPET`）→ 兜底（`about.mcpFallback`）。

## 接口 / 行为变更

- 关于页 MCP section 不再显示 WorkBuddy/claude-code 专属话术
- i18n key 数量各减 1（177 → 177，仍一致）

## 测试 / 验证

1. 打开 About → MCP section 不再出现 WorkBuddy/claude-code 专属话术
2. `npm run i18n:check` 通过
3. `npx tsc --noEmit` 通过

## 相关链接

- Issue: https://github.com/ShawnLiuSZ/task-dashboard/issues/121
- 关联 Issue #109: MCP 文档完善 / 关于页按平台展示
