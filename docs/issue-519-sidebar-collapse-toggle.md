# 侧边栏收起 / 展开功能（手动开关 + 偏好持久化） — #519

> 侧边栏**已有**折叠态（#265），但它是**纯响应式**的 —— 没有手动开关、也不持久化。
> 本 issue 加一个**手动**的「收起 / 展开」，并把偏好**持久化**。

## 背景

`#265` 的实现（改动前）：

```ts
// App.tsx
const [sidebarCollapsed, setSidebarCollapsed] = useState(
  typeof window !== 'undefined' ? window.innerWidth < 900 : false,
);
useEffect(() => {
  const onResize = () => setSidebarCollapsed(window.innerWidth < 900);
  window.addEventListener('resize', onResize);
  return () => window.removeEventListener('resize', onResize);
}, []);
```

⇒ 侧栏的显示**只由窗口宽度**决定：想把它收起来给看板让路，**只能把窗口拖窄**。

## 关键设计：把「用户显式选择」与「环境约束」分开

侧边栏的显示有两个来源，**优先级不同**：

1. **环境约束**（#265）：窗口 < 900px 时 200px 侧栏 + 看板**放不下**
   ⇒ 强制收起为纯图标模式。这是**物理限制**，不是偏好。
2. **用户偏好**：手动收起 / 手动展开。这是**明确的选择**。

⚠️ 若只存一个布尔（`collapsed: boolean`），就会出现「**点了没反应**」：

```
collapsed = narrow || manualCollapsed
```

窄窗下 `narrow` 恒为 `true` ⇒ 点「展开」把 `manualCollapsed` 改成 `false` 也没用
⇒ 用户以为按钮坏了。

⇒ 用**三态**偏好表达「**用户是否明确表过态**」：

| 值 | 含义 | 生效规则 |
|---|---|---|
| `'auto'` | 用户**从未**明确选择过 | 跟随窗口宽度（保持 #265 的响应式行为） |
| `'collapsed'` | 用户明确要收起 | 任何窗口宽度下都收起 |
| `'expanded'` | 用户明确要展开 | 任何窗口宽度下都展开（**覆盖**窄窗强制） |

**优先级：用户显式选择 > 环境默认。**

## 实现

### 1. 新增 `app/src/utils/sidebarPrefs.ts`（纯函数 + 持久化）

```ts
export type SidebarCollapsedPref = 'auto' | 'collapsed' | 'expanded';

export function getSidebarPref(): SidebarCollapsedPref;
export function setSidebarPref(pref: SidebarCollapsedPref): void;
export function resolveSidebarCollapsed(pref: SidebarCollapsedPref, narrowWindow: boolean): boolean;
export function nextSidebarPref(pref: SidebarCollapsedPref, narrowWindow: boolean): SidebarCollapsedPref;
```

- 存储键：`taskboard.sidebarCollapsed`（与 `taskboard.lang` / `taskboard.fontSize` 同族）；
- **非法值**（手改 localStorage / 旧版本残留）⇒ 回落到 `'auto'`
  —— 宁可跟随窗口，也不要落到一个看不懂的状态；
- `localStorage` **不可用**（隐私模式 / 非浏览器环境）⇒ **静默降级**、不抛错
  （与 `theme.ts` / `fontPrefs.ts` 同一范式）。

⚠️ 判定逻辑抽成**纯函数**（`resolveSidebarCollapsed` / `nextSidebarPref`）而不是内联在
组件里 —— 这是**产品语义**（「显式选择 > 环境默认」），必须有独立单测守着
（与 `countOpenIssues` / `openCount` 同一处理方式）。

### 2. `App.tsx` —— 拆分「环境」与「偏好」

```diff
- const [sidebarCollapsed, setSidebarCollapsed] = useState(window.innerWidth < 900);
+ const [narrowWindow, setNarrowWindow] = useState(window.innerWidth < 900);
+ const [sidebarPref, setSidebarPrefState] = useState(() => getSidebarPref());
+ const sidebarCollapsed = resolveSidebarCollapsed(sidebarPref, narrowWindow);

- const onResize = () => setSidebarCollapsed(window.innerWidth < 900);
+ const onResize = () => setNarrowWindow(window.innerWidth < 900);

+ const toggleSidebarCollapsed = useCallback(() => {
+   setSidebarPrefState((prev) => {
+     const next = nextSidebarPref(prev, narrowWindow);
+     setSidebarPref(next);
+     return next;
+   });
+ }, [narrowWindow]);
```

### 3. `Sidebar.tsx` —— 底部切换项

```tsx
<NavItem
  icon={collapsed ? ICON.expand : ICON.collapse}
  label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
  title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
  active={false}
  onClick={onToggleCollapsed}
/>
```

⚠️ **图标方向随状态翻转**（展开态 `‹` = 收起、折叠态 `›` = 展开）：
折叠态下文字标签整体隐藏（`.sidebar.collapsed .sidebar-item-label { display: none }`）
⇒ 只剩一个图标 ⇒ **图标方向本身就是可操作性提示**，`title` 同样给出动作名。

⚠️ `onToggleCollapsed` 为空时**不渲染**该按钮 —— 不渲染一个点了没反应的按钮。

### 4. 词条

| key | zh | en |
|---|---|---|
| `sidebar.collapse` | 收起侧边栏 | Collapse sidebar |
| `sidebar.expand` | 展开侧边栏 | Expand sidebar |

i18n key 数 450 → **452**。

### 5. 无需新 CSS

折叠态的既有规则已覆盖：
`.sidebar.collapsed`（56px 宽）+ `.sidebar.collapsed .sidebar-item { justify-content: center }`
⇒ 切换按钮的图标自动居中；`.sidebar.collapsed .sidebar-item-label { display: none }`
⇒ 文字自动隐藏。

## 验证

### 可视化（Chrome 无头 + 真实 `styles.css`，并排复刻两态）

| 读数 | 值 | 判据 |
|---|---|---|
| `expandedSidebarWidth` | **200** | 展开态宽度不变 |
| `collapsedSidebarWidth` | **56** | 折叠态宽度正确 |
| `expandedMainFills` / `collapsedMainFills` | **true / true** | 主区两态都占满剩余宽度 |
| `collapsedLabelHidden` | **true** | 折叠态文字标签隐藏 |
| `collapsedHeadHidden` | **true** | 折叠态账号标题行隐藏（#516 的规则继续生效） |
| `collapsedToggleIconCentered` | **true** | 折叠态切换图标居中 |
| `collapsedOverflowX` | **0** | 折叠态无横向溢出 |
| `expandedTogglePath` / `collapsedTogglePath` | `M15 5l-7 7 7 7` / `M9 5l7 7-7 7` | 两态**图标方向相反** |

### 单测（+18）

| 位置 | 例数 | 内容 |
|---|---|---|
| `utils/sidebarPrefs.test.ts`（**新**） | 12 | 默认 auto / 三态读写 / **非法值回落** / **localStorage 不可用静默降级** / `resolveSidebarCollapsed` 三态×窄窗 / `nextSidebarPref` 四种组合（含**窄窗 + auto ⇒ expanded**）/ 点一次落到具体态 |
| `components/sidebar.test.tsx` | +6 | 展开态显示「收起侧边栏」/ 折叠态显示「展开侧边栏」/ **未传回调时不渲染** / **图标方向随状态翻转** / 开关在 footer 内 / 点击触发回调 |

### 门禁

| 项 | 结果 |
|---|---|
| `cargo fmt --check` / `clippy --all-targets` / `test` | ✓（本次零 Rust 改动） |
| `npx tsc --noEmit` | ✓ |
| `npm run lint`（`--max-warnings 0`） | ✓ |
| `npx prettier --check "src/**/*.{ts,tsx,css}"` | ✓ |
| `npm run build` | ✓ |
| `npm run i18n:check` | ✓（中英各 **452** key） |
| `npx vitest run` | ✓ 34 文件 / **555** 例 |
| `python3 -m unittest discover -s scripts -p 'test_*.py'` | ✓ 143 例 |
| 四个 `scripts/check-*.py` | ✓ |

## 影响面

| 文件 | 改动 |
|---|---|
| `app/src/utils/sidebarPrefs.ts` | **新增**（三态偏好 + 两个纯函数） |
| `app/src/utils/sidebarPrefs.test.ts` | **新增**（12 例） |
| `app/src/App.tsx` | 拆分 `narrowWindow` / `sidebarPref` + `toggleSidebarCollapsed` |
| `app/src/components/Sidebar.tsx` | `onToggleCollapsed` prop + 底部切换项 |
| `app/src/i18n/locales/{zh-CN,en-US}.json` | 加 `sidebar.collapse` / `sidebar.expand` |

**零后端** · 零 DB schema · 零新依赖 · **零新 CSS**。

## 已知边界

- 偏好只存在**本机** `localStorage`（不跨设备同步）—— 与 `theme` / `fontSize` / `lang` 同款。
- 折叠态（56px）下**不显示**未完成计数（#516 的规则）⇒ 折叠态里看不到那个数字。
- 「显式展开」在极窄窗口（< 400px）会把主区压得很窄 —— 用户自己选的，可再点一次收起。
