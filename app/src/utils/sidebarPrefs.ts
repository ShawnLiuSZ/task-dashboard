/**
 * #517：侧边栏收起偏好的**持久化**（三态）。
 *
 * ## 为什么是三态而不是布尔
 *
 * 侧边栏的显示有两个来源，**优先级不同**：
 *
 * 1. **环境约束**（#265）：窗口 < 900px 时 200px 的侧栏 + 看板**放不下**
 *    ⇒ 强制收起为纯图标模式。这是**物理限制**，不是偏好。
 * 2. **用户偏好**：手动收起 / 手动展开。这是**明确的选择**。
 *
 * 若只存一个布尔（`collapsed: boolean`），就会出现「点了没反应」：
 * 窄窗口下 `collapsed = narrow || manual` 恒为 `true` ⇒ 点「展开」把 `manual`
 * 改成 `false` 也没用（`narrow` 仍然强制）⇒ 用户以为按钮坏了。
 *
 * ⇒ 用三态表达「**用户是否明确表过态**」：
 *
 * | 值 | 含义 | 生效规则 |
 * |---|---|---|
 * | `'auto'` | 用户**从未**明确选择过 | 跟随窗口宽度（保持 #265 的响应式行为） |
 * | `'collapsed'` | 用户明确要收起 | 任何窗口宽度下都收起 |
 * | `'expanded'` | 用户明确要展开 | 任何窗口宽度下都展开（**覆盖**窄窗强制） |
 *
 * 优先级：**用户显式选择 > 环境默认**。
 *
 * ## 持久化
 *
 * 用 `localStorage`（与 `theme.ts` / `fontPrefs.ts` 同一范式）：
 * 写不进去（隐私模式 / 非浏览器环境）时**静默忽略** —— 本次会话内仍能生效（内存态）。
 */

const KEY = 'taskboard.sidebarCollapsed';

/**
 * 侧边栏收起偏好。
 *
 * - `'auto'`：未明确选择 ⇒ 跟随窗口宽度（默认）。
 * - `'collapsed'`：用户明确要收起。
 * - `'expanded'`：用户明确要展开（覆盖窄窗强制）。
 */
export type SidebarCollapsedPref = 'auto' | 'collapsed' | 'expanded';

/** 默认值：未明确选择 ⇒ 跟随窗口宽度。 */
export const DEFAULT_SIDEBAR_PREF: SidebarCollapsedPref = 'auto';

const VALID: readonly SidebarCollapsedPref[] = ['auto', 'collapsed', 'expanded'];

function readRaw(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    // localStorage 不可用（隐私模式 / 非浏览器环境）
    return null;
  }
}

function writeRaw(value: string): void {
  try {
    localStorage.setItem(KEY, value);
  } catch {
    // 忽略：写不进去时本次会话内仍能生效（内存态）
  }
}

/**
 * 读取收起偏好。
 *
 * ⚠️ 非法值（手改 localStorage / 旧版本残留）一律回落到 `'auto'`
 * —— 宁可跟随窗口，也不要落到一个看不懂的状态。
 */
export function getSidebarPref(): SidebarCollapsedPref {
  const raw = readRaw();
  if (raw !== null && (VALID as readonly string[]).includes(raw)) {
    return raw as SidebarCollapsedPref;
  }
  return DEFAULT_SIDEBAR_PREF;
}

/** 写入收起偏好（`'auto'` 也写入 ⇒ 显式「跟随窗口」也是一个可持久化的选择）。 */
export function setSidebarPref(pref: SidebarCollapsedPref): void {
  writeRaw(pref);
}

/**
 * 由「偏好 + 是否窄窗」算出**实际**是否收起。
 *
 * @param pref 用户偏好（三态）
 * @param narrowWindow 窗口宽度是否 < 900px（#265 的阈值）
 */
export function resolveSidebarCollapsed(
  pref: SidebarCollapsedPref,
  narrowWindow: boolean,
): boolean {
  if (pref === 'collapsed') return true;
  if (pref === 'expanded') return false;
  return narrowWindow;
}

/**
 * 点「收起 / 展开」后的**新偏好**。
 *
 * ⚠️ 折叠态点 ⇒ 展开；展开态点 ⇒ 收起。
 * ⚠️ 窄窗 + `'auto'`（当前被强制收起）⇒ 点「展开」得到 `'expanded'`
 * ⇒ **显式覆盖**窄窗强制（否则点了没反应）。
 */
export function nextSidebarPref(
  pref: SidebarCollapsedPref,
  narrowWindow: boolean,
): SidebarCollapsedPref {
  const collapsed = resolveSidebarCollapsed(pref, narrowWindow);
  return collapsed ? 'expanded' : 'collapsed';
}
