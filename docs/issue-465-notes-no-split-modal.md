# #465 备忘录不跨列切断 + 看板限高滚动 + 查看全文弹窗

> 关联 issue：[#465](https://github.com/ShawnLiuSZ/task-dashboard/issues/465)
> 分支：`feature/issue-465-notes-no-split-modal`

## 一、背景 / 动机

用户截图反馈三条：

1. **同一个备忘录不能拆成俩列** —— 一条 30+ 行的记录被劈成左列前半 + 右列后半，
   读起来像两条不同的记录。
2. **备忘录看板固定最大高度，加滚动条** —— 面板不该随内容无限撑高。
3. **每一个卡片右上角加查看按钮，弹 Modal 看全文**。

三条互相牵连，根因是同一个（见第二节）。

## 二、根因：多列流的列高 = 容器高度

#462 用 CSS multi-column 实现瀑布流。其核心机制是：

> **多列容器的高度 = 每列的高度。**

`break-inside: avoid`（保证卡片不被切成两半）**只在「卡片高度 < 列高」时才生效** ——
卡片比列高还高时，浏览器**只能**把它跨列断开（现象①）。

而 #462 把 `.notes-list` 同时设成了「多列容器」+「限高 520px」+「`overflow-y: auto` 滚动区」。
在**确定高度**的多列容器里，浏览器不产生纵向滚动，而是把内容**横向**铺开
（实测 1440px 视口：横向溢出 **3338px**、纵向 `scrollable=false`、实际摊成 **10 列**）
⇒ 现象②「没有纵向滚动条」。

实测数据（Blink，20 张卡含 1 张 32 行超长卡）：

| 方案 | overflowX | 纵向可滚 | 实测列数 | 跨列切断 |
|---|---|---|---|---|
| A：multi-column + `max-height`（#462 原样） | **3338** | **false** | 10 | **20** |
| B：`column-fill: auto` + 固定高 | 3338 | false | 10 | — |
| C：flex 独立列容器 + JS 最短列优先 | -8 | true | 3 | 0 |
| D：grid + `align-items: start` | -8 | true | 4 | 0 |

## 三、方案选型：滚动宿主与列容器**分离**

关键洞察：**限高与滚动必须由「祖先容器」承担，多列容器自身高度自适应内容。**

```
.notes-panel            (flex column, 遮罩宿主)
  .notes-toolbar
  .notes-scroll         ← 滚动宿主：flex:1 1 auto + min-height:0 + max-height:520px + overflow-y:auto
    .notes-list         ← 多列容器：height:auto（列高由内容自然决定）
      .note-card × N
```

这样：

- 列高由**内容**自然决定 ⇒ `break-inside: avoid` **恒生效**（实测断裂数恒为 0）
- 祖先承担限高 + 纵向滚动 ⇒ 现象②解决
- **零 JS**，保留 #462 的多列流与「列式填充」阅读顺序

### 与方案 C / D 的对比

| | 方案 E（本方案） | 方案 C（flex 独立列 + JS 分配） | 方案 D（grid + align-items:start） |
|---|---|---|---|
| 零 JS | ✅ | ❌ 需 JS 最短列优先分配 | ✅ |
| 卡片不跨列 | ✅ 结构性保证 | ✅ 结构性保证 | ✅ |
| 纵向滚动 | ✅ | ✅ | ✅ |
| 横向零溢出 | ✅ | ✅ | ✅ |
| **紧凑瀑布流**（列底参差） | ✅ | ✅ | ❌ **行对齐** |
| 保留 #462 阅读顺序 | ✅ | ❌ | ❌ |

方案 D 零 JS 但**行对齐**（非紧凑瀑布流），与用户 #462 明确选的「自适应高度（真瀑布流）」冲突 ⇒ 排除。
方案 C 效果达标但需引入 JS 分配逻辑 ⇒ 在有零 JS 方案时无必要。

## 四、实测数据

**夹具**：真实构建产物 CSS + 复刻 DOM 结构，20 张卡（1 张 32 行超长卡 + 6 张中长 + 13 张短）。
**引擎**：Blink（Chrome）与 **WebKit（≈ macOS WKWebView）双引擎**，1440×900 视口。

| 指标 | WebKit | Blink | 判定 |
|---|---|---|---|
| `overflowX`（横向溢出） | **-8** | -8 | ✅ 无横向溢出 |
| 纵向可滚 | **true**（`scrollClientH=520`） | true | ✅ 有滚动条 |
| 实测列数 | **3** | 3 | ✅ |
| **跨列切断数** | **0** | **0** | ✅ 核心指标 |
| 按钮压住正文 | **0 张卡** | 0 | ✅ |
| 正文折叠生效 | 8 张卡 | 8 | ✅ |

场景矩阵（1 / 2 / 3 / 4 / 7 / 20 张卡，含 32 行与 100 行超长卡）断裂数**恒为 0**。

## 五、正文折叠：为什么用 `line-clamp` 而不是 `max-height`

卡片正文**必须折叠**（完整内容交给 Modal），理由有二：

1. **视觉**：多列流里卡片越高该列越长，高度差过大时三列底部严重参差，
   瀑布流看起来像「一列很长、两列很短」。
2. **可达性**：折叠让卡片高度收敛，列高均衡。

折叠方式对比：

| 方式 | 效果 | 判定 |
|---|---|---|
| `max-height` + `overflow: hidden` | **硬切** —— 第 N 行被切成半行、无任何提示，用户以为内容就这么长 | ❌ |
| `-webkit-line-clamp: 9` | 前 9 行 + **省略号**，明确告知「还有更多」 | ✅ |

⚠️ `line-clamp` 必须三件套齐全：`display: -webkit-box` + `-webkit-box-orient: vertical`
+ `-webkit-line-clamp: N`，缺一个就不生效。

⚠️ **`-webkit-box` 会让 float 失效** —— 按钮不能用 float 绕排，只能绝对定位。

## 六、「查看」按钮的位置：4 个变体实测

正文右上角放按钮 ⇒ 按钮可能压住首行文字。4 个变体实测（WebKit）：

| 变体 | 按钮压字 | 省略号 | 卡片最高 | 判定 |
|---|---|---|---|---|
| A：按钮 float 在正文内 + 硬切 | 0 | ❌ | 271px | 位置对、无提示 |
| B：A + `line-clamp` | 0 | ✅ | 259px | ❌ **`-webkit-box` 使 float 失效**，按钮跑到左上角独占一行 |
| C：绝对定位 + `line-clamp` | **1 张卡压字** | ✅ | 231px | ❌ 首行被压 |
| **D：绝对定位 + `line-clamp` + 正文 `padding-right: 30px`** | **0** | ✅ | **231px** | ✅ **采纳** |

采纳 D：正文整体右侧留白 30px（按钮 22px + 右边距 8px），按钮落在留白里 ⇒ 恒不压字。

### 测量口径修正

第一版用 `range.selectNodeContents(p)` 取行矩形，把**按钮自身**也算进 Range
⇒ 误报「20 张卡压字」。改用 **TreeWalker 只取文本节点**后得到正确读数
（A/D = 0，C = 1）。

## 七、测试

`components/notes-layout.test.ts` 新增 **7 条**（#465 组）+ 更新 1 条（滚动宿主迁移）：

| 用例 | 作用 |
|---|---|
| 滚动宿主是受约束的纵向滚动区 | 断言移到 `.notes-scroll`（flex / min-height:0 / overflow-y / overscroll-behavior / max-height:520px） |
| **多列容器不得限高、不得自带滚动** | #465 核心约束（挡住「限高+滚动合一」回归） |
| 多列容器 `height: auto` | 列高由内容自然决定 ⇒ 卡片恒不跨列 |
| 滚动宿主与列容器是两层 | 组件结构断言（`.notes-scroll` 包住 `.notes-list`） |
| 正文折叠是 line-clamp 不是硬切 | 三件套齐全 + `overflow: hidden` |
| 正文右侧预留 30px | 挡「按钮压字」回归 |
| 查看按钮绝对定位在右上角 | 位置 + 卡片是定位祖先 |
| 组件渲染了按钮并绑定查看态 | `note-view-btn` / `setViewingId` / `viewingNote` 派生 / Modal 挂载 |
| Modal 展示完整正文（不折叠） | 折叠只在卡片里做 |

`components/note-viewer-modal.test.tsx` **新建**（6 条）：全文呈现、不含折叠类、
优先级色点、绝对时间戳、可访问性属性、遮罩宿主。

### 反向验证：5 处变异，全部精准捕获

| 变异 | 结果 |
|---|---|
| 去掉 `.notes-list` 的 `height: auto` | ✅ 1 条失败（多列容器不得限高） |
| 给 `.notes-list` 加回 `max-height` + `overflow-y` | ✅ 1 条失败（核心约束） |
| 去掉正文的 `padding-right: 30px` | ✅ 1 条失败（预留位） |
| `line-clamp` 退回 `max-height` 硬切 | ✅ 1 条失败（折叠方式） |
| 组件去掉 `.notes-scroll` 包裹层 | ✅ 1 条失败（两层结构） |

## 八、踩过的坑（记录以免重犯）

### 8.1 先怀疑结论、再怀疑测量（第三次了）

Range 测「按钮压字」时误报 20 张卡。**第一反应是以为方案有问题**，
实际是测量把按钮自身算进了 Range。

⇒ 判定「元素重叠」必须用 **TreeWalker 只取文本节点**，
或用 `getClientRects()` 区分 fragment（多列流里被切断的元素返回**多个** rect，
这是判定「跨列切断」最可靠的判据）。

### 8.2 `--dump-dom` 模式下 `--window-size` 不生效（#462 已踩）

读数类验证走 `--screenshot` 或 CDP。本轮改用 **Playwright** 一并解决：
可指定视口、可换引擎（WebKit ≈ macOS WKWebView）、可 `page.evaluate` 取读数。

### 8.3 HTTP 后台服务被回收

`nohup python3 -m http.server &` 起的服务在会话结束后消失 ⇒
改用受管后台任务（`run_in_background`）保持存活。

### 8.4 Playwright 的 `npm install` 在 workspace 里不落盘

`cd workspace && npm i playwright` 后 `node_modules` 为空 ⇒ 需显式
`--prefix /Users/liushizhao/.workbuddy/binaries/node/workspace`。

## 九、校验

```
npx tsc --noEmit              ✅
npm run lint                  ✅（--max-warnings 0）
npm run i18n:check            ✅（zh-CN 417 key，en-US 一致）
npx prettier --check          ✅
npm run build                 ✅
npx vitest run                ✅
```

**后端 / DB schema / MCP 工具集零改动。**（纯前端 CSS + TSX + 测试 + i18n）

## 十、相关链接

- Issue：[#465](https://github.com/ShawnLiuSZ/task-dashboard/issues/465)
- CHANGELOG：[`docs/CHANGELOG.md`](./CHANGELOG.md)
- 相关：[#462](https://github.com/ShawnLiuSZ/task-dashboard/issues/462)（瀑布流，本次是其布局机制的修正）、[#460](https://github.com/ShawnLiuSZ/task-dashboard/issues/460)（页脚沉底）、[#456](https://github.com/ShawnLiuSZ/task-dashboard/issues/456)（改列表布局）
