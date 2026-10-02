import { useEffect, useRef } from 'react';
import { registerEscLayer, type EscLayer } from './escLayer';

/**
 * #329：把当前组件注册为一层 Esc 处理器，返回「本层是否为最上层」判定函数。
 *
 * 用法（元素级监听）：
 * ```tsx
 * const isEscTop = useEscLayer();
 * <div onKeyDown={(e) => { if (e.key === 'Escape' && isEscTop()) onClose(); }} />
 * ```
 *
 * 注册顺序即层级顺序：面板先挂载（入栈在前），其子级确认框后挂载（入栈在后）
 * ⇒ 确认框为最上层，面板在确认框打开期间不响应 Esc。
 * 判定函数在事件回调里读 ref，故每次渲染返回新函数不影响正确性。
 */
export function useEscLayer(): () => boolean {
  const layer = useRef<EscLayer | null>(null);
  useEffect(() => {
    const l = registerEscLayer();
    layer.current = l;
    return () => {
      l.release();
      layer.current = null;
    };
  }, []);
  // 尚未注册（首帧渲染即收到 Esc，实际不可能）时按「可响应」处理，行为与旧实现一致。
  return () => layer.current?.isTop() ?? true;
}

/**
 * #344：window 级 Esc 监听 + Esc 分层，且**层级注册只发生一次**。
 *
 * 适用于无法把 `onKeyDown` 挂在自身元素上的场景（面板遮罩、子对话框等需要
 * window 级监听的组件）。
 *
 * ## 为什么不能把 `registerEscLayer()` 放进带 `onClose` / `onCancel` 的 effect
 *
 * 那类回调（`() => setNav('board')`、`() => setConfirming(false)`）**每次父组件
 * 渲染都是新函数引用**，于是 effect 每次重渲染都重跑。React 的 passive effect
 * 顺序是「destroy 自底向上 → create 自底向上」，父子两层一起重跑时：
 *
 * ```text
 * 1. destroy：对话框 release() → 面板 release() → 栈空
 * 2. create：对话框注册 → [对话框]
 * 3. create：面板注册   → [对话框, 面板]   ← 面板压过了自己的子层！
 * ```
 *
 * `isTop()` 于是对对话框为 `false`、对面板为 `true` —— **层级颠倒**，一次 Esc
 * 直接关掉整个同步日志面板，跳过了用户的「取消」确认。触发只需一次父重渲染
 * （自动同步完成、4 秒横幅消失计时器、20 秒轮询……）。
 *
 * ## 本 hook 的做法
 *
 * - **层注册**放在 `[]` 依赖的 effect 里，整个生命周期只注册一次；
 * - **业务回调**放进 ref，回调引用变化时 ref 自动更新，**不影响监听器与层级**；
 * - `window.addEventListener` 仍只挂一次，故不存在重复监听。
 *
 * 用法：
 * ```tsx
 * useWindowEscLayer(onClose);
 * ```
 */
export function useWindowEscLayer(onEsc: () => void): void {
  // 始终指向最新的回调，但只在挂载时注册层级与监听器。
  const handler = useRef(onEsc);
  useEffect(() => {
    handler.current = onEsc;
  });

  useEffect(() => {
    const layer = registerEscLayer();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && layer.isTop()) handler.current();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      layer.release();
    };
  }, []);
}
