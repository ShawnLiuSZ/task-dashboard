# 收起侧边栏按钮移到窗口标题栏位置（仅 icon，无文字） — #522

> 用户截图标注：把「收起侧边栏」按钮移到**窗口标题栏位置**（紧跟窗口标题「TaskBoard」
> 右侧，红框处），且**只用 icon、不要文字**。

## 关键约束：原生标题栏**不在 DOM 里**

用户截图的第一行（三个交通灯 + 窗口标题「TaskBoard」）是 **macOS 原生窗口标题栏**；
第二行才是应用自己的顶栏（粗体「TaskBoard」+ 新建备忘录 + 搜索框）。

⇒ 普通 DOM 按钮**放不进原生标题栏** —— 它由 NSWindow 绘制，webview 碰不到。

⇒ 唯一可行的做法：把窗口改成 **`titleBarStyle: "Overlay"` + `hiddenTitle: true`**
（VS Code / Electron `titleBarStyle: 'hidden'` 的同款做法）：

| 配置 | 效果 |
|---|---|
| `titleBarStyle: "Overlay"` | 原生标题栏变成**透明覆盖层**，内容延伸到窗口顶部，交通灯浮在 webview 左上角 |
| `hiddenTitle: true` | 原生标题**文字**隐藏 ⇒ 让位给应用自己的标题 |

⇒ 应用的 `.app-title`「TaskBoard」上移到第一行，折叠按钮紧跟其后 ⇒
**视觉位置与「原生标题栏里的按钮」完全一致**（实测截图已确认）。

> Tauri schema 对 `Overlay` 明确列了三条注意事项，本 issue 逐条处理（见下）。

## Overlay 带来的三个连带项（**必须都处理**，否则窗口会变得难用）

### ① 拖拽区：顶栏要能拖窗口

Overlay 下内容不再有原生标题栏可拖 ⇒ 顶栏声明 `data-tauri-drag-region="deep"`。

⚠️ Tauri 的规则（`tauri-2.11.5/src/window/scripts/drag.js`）：
- `data-tauri-drag-region`（裸 / `"true"`）⇒ 只有**直接点该元素**才触发拖拽；
- `"deep"` ⇒ 子树任意位置都触发；
- `"false"` ⇒ 禁用（**且对祖先也禁用**）；
- **可点击元素（`button` / `input` / `select` / `a` / `label` / `summary`、
  或带 `tabindex` / 交互性 `role`）默认阻止拖拽** ⇒
  **搜索框、下拉、按钮照常可点，不必逐个排除**。

⚠️ 拖拽脚本由 **window 核心插件**注入（`tauri/src/window/plugin.rs` 的
`js_init_script`）⇒ 该插件已装载（本仓 `main.tsx` 已在用 `getCurrentWindow()`）。

### ② 交通灯让位

macOS 交通灯浮在 webview 左上角 ⇒ 顶栏左侧要留出位置：

```css
padding: 10px 16px 10px var(--titlebar-inset, 78px);
```

⚠️ 变量化便于按实测微调（不同 macOS 版本交通灯位置略有差异）。
⚠️ **只影响主窗口** —— About 小窗用 `.about-window`，不套 `.topbar`。

### ③ 折叠按钮本身要排除拖拽

它在顶栏里 ⇒ 必须 `data-tauri-drag-region="false"`，否则**点击会被当成拖窗口**。

## 改动

| 文件 | 内容 |
|---|---|
| `app/src-tauri/tauri.conf.json` | **仅 main 窗口**加 `titleBarStyle: "Overlay"` + `hiddenTitle: true` |
| `app/src/App.tsx` | 顶栏加 `data-tauri-drag-region="deep"`；`.app-title` 后加**仅图标**的折叠按钮 |
| `app/src/styles.css` | `.topbar` 左侧让出交通灯（`--titlebar-inset`）+ `.topbar-collapse` 样式 |
| `app/src/components/Sidebar.tsx` | **移除**底部折叠开关（是「移动」不是「复制」）+ 清掉随之失效的 `onToggleCollapsed` prop 与 `ICON.collapse` / `ICON.expand` |

折叠按钮的形态：

```tsx
<button
  type="button"
  className="topbar-collapse"
  data-tauri-drag-region="false"
  title={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
  aria-label={sidebarCollapsed ? t('sidebar.expand') : t('sidebar.collapse')}
  onClick={toggleSidebarCollapsed}
>
  <svg …>
    {/* 图标方向随状态翻转：展开态「‹」= 收起、折叠态「›」= 展开。 */}
    <path d={sidebarCollapsed ? 'M9 5l7 7-7 7' : 'M15 5l-7 7 7 7'} />
  </svg>
</button>
```

⚠️ **图标按钮必须有可访问名** ⇒ `title` + `aria-label` 都给动作名（不能只有图标）。

## 验证

### 真机实测（`npm run tauri dev` + `screencapture`）

⚠️ 这一项**只有真 app 能验**：交通灯位置、标题栏高度、拖拽行为都不是 webview 的事
⇒ headless Chrome 复现不出来（仓库既有范式：#498 / #500 的布局问题也是这么验的）。

实测顶部一行：

```
○○○   TaskBoard   ‹   │ 📝 新建备忘录  …  上次同步 2026-11-03 13:08 | 账号 ▾ | 🔄 立即同步
       └ 交通灯      └ 应用标题 └ 折叠图标（仅 icon，无文字）
```

| 检查项 | 结果 |
|---|---|
| 折叠图标位置 | **紧跟「TaskBoard」右侧** ⇒ 与用户红框位置一致 ✓ |
| 图标形态 | 仅图标、无文字 ✓ |
| 交通灯与「TaskBoard」 | 不重叠、间距正常 ✓ |
| 顶栏整体 | 上移到窗口最顶行，右侧搜索 / 同步 / 设置全部正常 ✓ |
| 侧栏与看板 | 正常渲染，无错位 / 无裁切 ✓ |
| 侧栏账号名 | 仍完整显示 + 自动换行（#516 的效果未被破坏）✓ |

### 单测（+3）

| 位置 | 内容 |
|---|---|
| `panel-wiring.test.ts`（**新增** describe） | 顶栏声明拖拽区 / 折叠按钮紧跟 `.app-title` / **只有图标没有文字**（`title`+`aria-label` 齐备）/ 显式排除拖拽 / 图标方向随状态翻转 / 点击走 `toggleSidebarCollapsed`（写三态偏好）/ 侧栏不再接收回调 |
| `sidebar.test.tsx`（改写） | 侧栏底部**不再**渲染折叠开关（已移到顶栏）+ 底部只剩「关于」 |

### 门禁

| 项 | 结果 |
|---|---|
| `cargo fmt --check` / `clippy --all-targets` / `test` | ✓ |
| `npx tsc --noEmit` | ✓ |
| `npm run lint`（`--max-warnings 0`） | ✓ |
| `npx prettier --check "src/**/*.{ts,tsx,css}"` | ✓ |
| `npm run build` | ✓ |
| `npm run i18n:check` | ✓（中英各 452 key，**零新词条**） |
| `npx vitest run` | ✓ 34 文件 / **558** 例 |
| `python3 -m unittest discover -s scripts -p 'test_*.py'` | ✓ 143 例 |
| 四个 `scripts/check-*.py` | ✓ |

## 影响面

| 文件 | 改动 |
|---|---|
| `app/src-tauri/tauri.conf.json` | main 窗口的标题栏样式（**窗口外观变化**） |
| `app/src/App.tsx` | 顶栏拖拽区 + 仅图标折叠按钮 |
| `app/src/styles.css` | 交通灯让位 + 折叠按钮样式 |
| `app/src/components/Sidebar.tsx` | 移除底部开关 + 清理死代码 |
| `app/src/panel-wiring.test.ts` | +7 条 App 级接线断言 |
| `app/src/components/sidebar.test.tsx` | 断言改写（开关已移出） |

**零后端逻辑** · 零 DB schema · 零新依赖 · 零新 i18n 词条。

## 已知边界 / 风险

- ⚠️ **窗口外观变了**：原生标题栏（独立一行、标题居中）消失，应用顶栏顶到窗口最上面。
  这是达成「按钮放在标题栏位置」的**必要代价**（原生标题栏不可自定义控件）。
- ⚠️ **Overlay 模式的已知限制**（Tauri schema 原文）：
  「标题栏高度随 OS 版本不同」「未聚焦时无法拖动窗口」（tauri#4316）。
- 折叠态（56px）下**不显示**未完成计数（#516 的规则）⇒ 折叠态里看不到那个数字。
