// #609：Liquid Glass 指针跟随高光。
//
// #606 的玻璃层次是静态的——顶部 1px inset 高光不随视角移动，看上去像贴膜。
// 本模块在浮层上跟踪指针，把位置写成 CSS 自定义属性 --glass-mx / --glass-my，
// 由 styles.css 的 radial-gradient 高光层消费。零新依赖、不碰 DOM 结构、
// 不遮挡点击与焦点环（高光画在 background 层，不是覆盖伪元素）。
//
// 设计要点：
// - **事件委托**：浮层是动态挂载/卸载的（modal / detail），逐个绑定会漏且泄漏。
// - **rAF 节流**：pointermove 高频触发，但每帧只读一次 getBoundingClientRect
//   （强制布局），并只写一次内联样式。
// - **零自动启动**：入口 main.tsx 显式调用 initGlassPointer()，保持模块副作用
//   可见、可测（与 glassPrefs 的「加载即应用」区分：这里依赖 DOM 已存在）。

/** 浮层选择器：与 styles.css 的玻璃门禁保持一致（排除独立详情窗）。 */
export const GLASS_FLOAT_SELECTOR = '.modal, .detail:not(.detail-window)';

const MX = '--glass-mx';
const MY = '--glass-my';

export type GlassRect = { left: number; top: number; width: number; height: number };

/**
 * 纯函数：指针客户端坐标 → 浮层内高光中心（百分比，夹紧到 0~100%）。
 *
 * 抽成纯函数是为了让坐标换算可被真实数据断言（vitest 无布局引擎）；
 * 零尺寸（元素尚未布局）回退到中心 50%，避免除零得到 NaN/Infinity。
 */
export function glassHighlightAt(
  clientX: number,
  clientY: number,
  rect: GlassRect,
): { mx: string; my: string } {
  const pct = (value: number, origin: number, size: number): number => {
    const raw = size > 0 ? ((value - origin) / size) * 100 : 50;
    return Math.min(100, Math.max(0, raw));
  };
  return {
    mx: `${pct(clientX, rect.left, rect.width).toFixed(1)}%`,
    my: `${pct(clientY, rect.top, rect.height).toFixed(1)}%`,
  };
}

type Pending = { x: number; y: number; host: HTMLElement };

let pending: Pending | null = null;
let frame = 0;

function flush(): void {
  frame = 0;
  if (!pending) return;
  const { x, y, host } = pending;
  pending = null;
  const box = host.getBoundingClientRect();
  const { mx, my } = glassHighlightAt(x, y, {
    left: box.left,
    top: box.top,
    width: box.width,
    height: box.height,
  });
  host.style.setProperty(MX, mx);
  host.style.setProperty(MY, my);
}

function onPointerMove(event: PointerEvent): void {
  const target = event.target;
  // 测试 / 非浏览器环境里没有 Element 构造器；用可选链安全跳过。
  if (typeof Element === 'undefined' || !(target instanceof Element)) return;
  const host = target.closest(GLASS_FLOAT_SELECTOR);
  if (!(host instanceof HTMLElement)) return;
  pending = { x: event.clientX, y: event.clientY, host };
  if (frame === 0) frame = requestAnimationFrame(flush);
}

let started = false;

/** 幂等注册；非浏览器环境静默跳过（node 测试 / SSR 不崩）。 */
export function initGlassPointer(): void {
  if (started) return;
  try {
    document.addEventListener('pointermove', onPointerMove, { passive: true });
    started = true;
  } catch {
    // document 不可用：本次会话无指针高光，其余功能不受影响。
  }
}
