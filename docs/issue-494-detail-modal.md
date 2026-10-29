# 任务详情由右侧抽屉改为居中 Modal 查看 — #494

> 关联 issue：[#494](https://github.com/ShawnLiuSZ/task-dashboard/issues/494)

## 背景 / 动机

任务详情原先是**右侧 50% 宽抽屉**：`.detail` 绝对定位贴右边缘（`top:46px; right:0; bottom:0; width:50%`），把看板右半屏整个盖住。用户诉求是改为**居中 Modal 框**查看。

两类面板在本仓并存、形态本就不同：

- **侧栏型面板**（设置 / 账号 / 同步日志 / 关于）：本身就是整页，覆盖主区域合理；
- **任务详情**：从卡片点开、内容是「一条任务的补充信息」，属于**临时查看**而非切换工作区 ⇒ 居中弹窗更贴切，且不遮挡看板上下文（弹窗外的卡片仍可见）。

## 设计 / 方案

**保持 DOM 结构与交互契约不变**（Esc 关闭 / 点击遮罩关闭 / 关闭按钮 / Esc 分层 `utils/escLayer.ts` 全部照旧），只改几何：

### `.detail`（详情卡片）

| 属性 | 值 | 理由 |
|---|---|---|
| 定位 | `top/left: 50%` + `transform: translate(-50%, -50%)` | 包含块是**视口**（`body` 与 `.app` 均无 `position`）⇒ 居中基准是窗口中心，不受 `.app` 横向滚动（`overflow-x:auto`）影响 |
| 宽度 | `width: 720px` + `max-width: calc(100% - 48px)` | 720px 容纳详情内容；窄窗口左右各留 24px 边距不溢出 |
| 高度 | `max-height: calc(100% - 96px)` + `overflow-y: auto` | 内容过长时**弹窗内部滚动**，标题栏与底部不跑出视口 |
| 外观 | 圆角 12px + `box-shadow` + `border` | 与仓库既有 `.modal` / `.note-viewer-modal` 同款卡片语言 |

### `.detail-backdrop`（遮罩）

`inset: 0` 不变（本就覆盖整个窗口，含顶栏），遮罩色由 `--shadow-strong` 改为 `--overlay`，与仓库既有 `.modal-mask` 对齐（弹窗化后遮罩应当更沉）。

### `.detail-head`（头部 sticky）

详情内容很长（会话 / 交接 / GitHub / 评论 / PR 提交历史），关闭按钮不能随内容滚走 ⇒ 头部 `position: sticky; top: 0`，并用负 margin 抵消 `.detail` 的 padding 让头部满宽、`padding` 再补回视觉间距、不透明背景防止内容从下方透出。

## 渲染验证（Chrome 无头 + 注入读数）

纯 CSS 布局在 node 环境测不到（无布局引擎），故用本机 Chrome 无头渲染**隔离复现页**（直接 `<link>` 真实 `styles.css`，按 JSX 复刻 DOM），并把读数注入页面而非靠肉眼量：

| 视口 | 卡片尺寸 | 居中偏差 | 内部滚动 | 横向溢出 |
|---|---|---|---|---|
| 1280×657 | 720×561（bottom=609 < 657） | dx=0 dy=0 | `scrollHeight 925 > clientHeight 559` | 0 |
| 560×657 | 512（= 560−48），left=24 / right=536 | dx=0 dy=0 | 同上 | 0 |

- `offsetParent=BODY` ⇒ 包含块确为视口，`max-height` 百分比基准正确；
- 滚动 200px 后 `head.top=65`（钉在卡片顶部 `detail.top=48` 附近）⇒ sticky 生效，关闭按钮始终可见；
- `horizontal overflow elements(0)` ⇒ 两档宽度下均无溢出。

## 接口 / 行为变更

- **无 TSX / 后端 / DB 改动**：仅 `app/src/styles.css` 的三条规则（`.detail` / `.detail-backdrop` / `.detail-head`）。
- 交互语义不变：Esc 关闭、点击遮罩关闭、关闭按钮关闭；`role="dialog" aria-modal="true"` 保持。

## 数据 / Schema 变更

无。

## 测试 / 验收

- `app/src/styles.test.ts` 新增 4 条静态断言（居中且不得回退抽屉 / `max-width`+`max-height`+内部滚动 / 头部 sticky+不透明背景 / 遮罩 `inset:0` + `--overlay`）。
  - ⚠️ 断言 `width: 50%` 缺席时用了负向前查 `(?<!max-)width\s*:\s*50%`，否则 `max-width` 会造成误判。
- 渲染验证读数见上表（Chrome 无头，1280 / 560 两档）。
- `tsc --noEmit` / `vitest` / `lint` / `prettier` / `i18n:check` / `check-doc-links` 全绿。

## 相关链接

- issue：[#494](https://github.com/ShawnLiuSZ/task-dashboard/issues/494)
- 代码：`app/src/styles.css`（`.detail` / `.detail-backdrop` / `.detail-head`）、`app/src/styles.test.ts`
- 更新记录：[`docs/CHANGELOG.md`](./CHANGELOG.md)
