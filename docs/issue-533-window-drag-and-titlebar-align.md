# 窗口拖不动（Overlay 缺 start-dragging 权限）+ 顶栏与交通灯未对齐 — #533

> 用户报 v0.8.4：① **窗口完全拖不动**；② 顶栏的「TaskBoard + 折叠按钮 + 新建备忘录」
> 那一段与 macOS **交通灯没对齐**。

## ① 拖不动 —— ACL 缺 `allow-start-dragging`

### 因果链

```
titleBarStyle: "Overlay"（#520 引入，为了在标题栏里放按钮）
  ⇒ 原生标题栏变透明覆盖层，**不再提供拖拽区**
  ⇒ 拖动完全依赖前端 data-tauri-drag-region
  ⇒ Tauri 的 drag.js 在 mousedown 时 invoke('plugin:window|start_dragging')
  ⇒ ⚠️ core:window:default **不含** allow-start-dragging ⇒ ACL 拒绝 ⇒ 拖不动
```

实测 `core:window:default` 的 28 条：`activity-name / available-monitors / current-monitor /
cursor-position / get-all-windows / inner-position / inner-size / internal-toggle-maximize /
is-always-on-top / is-closable / is-decorated / is-enabled / is-focused / is-fullscreen /
is-maximizable / is-maximized / is-minimizable / is-minimized / is-resizable / is-visible /
monitor-from-point / outer-position / outer-size / primary-monitor / scale-factor /
scene-identifier / theme / title`

⇒ 有 `internal-toggle-maximize`（双击最大化），**没有 `start-dragging`**。

### ⚠️ 这是 v0.8.2 起就存在的回归

#520 给主窗口加 Overlay + drag-region 时**漏了授权** ⇒ 从那版起窗口就拖不动了。
而**编译通过、单测全绿、CI 全绿** —— 这类缺陷只有用户真去拖窗口才会暴露。

### 修

`app/src-tauri/capabilities/default.json`：

```json
"permissions": ["core:default", "core:window:allow-start-dragging"]
```

**验证**：编译产物的 `gen/schemas/acl-manifests.json` 里 `core:window.permissions` **含**
`allow-start-dragging` ✓ ⇒ 运行时 ACL 放行。

### 顺带加一个门禁（防回归）

新 `scripts/check-capabilities.py`（零依赖，只用标准库）：

1. 凡 `tauri.conf.json` 里有窗口用 `titleBarStyle: "Overlay"` ⇒ 必须有 capability 授予
   `core:window:allow-start-dragging`，且该 capability 的 `windows` **覆盖到那个窗口**
   （支持 glob，如 `task-detail-*`）；
2. capability 里的 `core:<插件>:allow-<名>` 标识必须**真的存在**于编译期生成的
   ACL manifest ⇒ 手写错标识（静默不生效）会被抓住。

⇒ 已挂进 `.github/workflows/quality-check.yml`（新增一步「capability 权限校验」）。

## ② 顶栏与交通灯未对齐

### 实测（用户截图逐像素量测）

⚠️ 量测要点：截图是 **retina 2x**；用户的**红色标注框**会被「深色像素」检测捕获
⇒ 必须排除纯红像素，否则量出来的范围完全错。

| 元素 | 纵向范围 | 中心 |
|---|---|---|
| macOS 交通灯 | y=7..20 | **13** |
| 「TaskBoard」文字 | y=8..25 | 16 |
| 「新建备忘录」按钮 | y=15..26 | 20 |

⇒ 顶栏内容整体比交通灯**低 3~7px**。

### ⚠️ 交通灯**动不了**

交通灯是 **macOS 原生绘制**的（NSWindow 的 `standardWindowButton`），
**Tauri v2 未暴露**交通灯位置 API（`grep -rn "traffic_light\|TrafficLight" tauri-2.11.5/src/`
⇒ 无 `pub fn`）⇒ **CSS / 配置层面都动不了它**。

⇒ 只能反过来把**我们的内容上移**到与它对齐。

### 修

`.topbar` 的 `padding-top`：**10px → 0**。

### 验证（复现页：真实 `styles.css` + 真实 `.topbar` 结构 + **手绘模拟交通灯**（中心 y=13））

| padding-top | 标题 / 折叠 / 新建按钮中心 | 相对交通灯 |
|---|---|---|
| 10px（改前） | 19.5 | **+6.5px** |
| 4px | 17.5 | +4.5px |
| **0px（改后）** | **13.5** | **+0.5px** ✓ |

⇒ 三个元素**组内本来就对齐**（`.topbar-left` 是 `align-items: center` 的 flex）
⇒ 只需**整体平移**，不必逐个微调。

⚠️ 复现页的两个坑：
- HTML 内联 `<script>` 里的 **JSX 不会被 vite 转译** ⇒ 必须拆成独立 `.tsx`；
- 从 JSX 剥掉 `{...}` 表达式后会留下**裸属性**（`onClick=` / `title=` / `aria-label=`）
  ⇒ HTML 解析报错 ⇒ vite 返回 500 ⇒ 页面全白 ⇒ 看起来像「脚本没跑」。

## 影响面

| 文件 | 改动 |
|---|---|
| `app/src-tauri/capabilities/default.json` | 加 `core:window:allow-start-dragging` |
| `app/src/styles.css` | `.topbar` 的 `padding-top` 10px → 0 |
| `scripts/check-capabilities.py` | **新增**（门禁） |
| `scripts/test_check_capabilities.py` | **新增**（8 例，含反向验证） |
| `.github/workflows/quality-check.yml` | 新增一步「capability 权限校验」 |

**零 DB schema** · 零前端逻辑改动 · 零新依赖。

## 已知边界

- 交通灯位置在**不同 macOS 版本 / 显示缩放**下略有差异 ⇒ 顶栏留白是对着
  **标准 macOS 标题栏（28px、交通灯中心 13px）** 调的；若个别机器仍偏，
  调 `.topbar` 的 `padding-top` 一个值即可。
- `padding-top: 0` ⇒ 顶栏内容紧贴窗口上沿，与原生标题栏的行为一致（原生标题栏的
  窗口按钮也是贴着上沿）。
