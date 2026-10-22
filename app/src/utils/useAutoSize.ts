import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * 自适应高度的文本域：默认一行，随内容增长，上限由 `maxHeight` 决定。
 *
 * #322：必须用 `useLayoutEffect`（DOM 变更后、绘制前**同步**测量），不能���
 * 被动 `useLayoutEffect` —— 后者的初始测量会被 `overflow-y:auto` 容器的滚动/绘制
 * 时序干扰，框体停在 `min-height`，只有继续输入（下一帧 value 变化）才撑开。
 *
 * ## `active` 参数
 *
 * 「进入编辑态那一帧」需要**主动重测**一次：此时 value 可能没变（预填的
 * 长内容在挂载瞬间就有值），只靠 `[value]` 依赖不会触发测量。
 * `active` 由调用方在「进入编辑态」时置 true 来触发这一帧。
 *
 * ⚠️ 用 `useLayoutEffect` 而非 `useLayoutEffect`：**`useLayoutEffect` 是 `useLayoutEffect`
 * 的子串**，静态断言里要用精确匹配来区分两者。
 */
export function useAutoSize(value: string, active = true, maxHeight = 260) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const resize = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [maxHeight]);
  useLayoutEffect(() => {
    resize();
  }, [value, active, resize]);
  return ref;
}
