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
