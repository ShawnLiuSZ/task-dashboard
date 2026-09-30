/**
 * #329：Esc 分层仲裁。
 *
 * 应用里有多层组件都监听 Esc 关闭自己：弹窗（`ConfirmDialog`）与它所属的
 * 面板（`DetailPanel` / `SyncLogsPanel` / `SettingsPanel` / `AccountsPanel` /
 * `AboutPanel` / 更新提示弹框）。浏览器会把同一个 keydown 依次投递给**全部**
 * 监听器（window 上的多个监听器彼此不会 stopPropagation），于是「确认框叠加在
 * 面板之上」时一次 Esc 会把两层一起关掉——用户以为点了取消，面板却没了。
 *
 * 规则：**只有最上层的注册者响应 Esc**。
 *
 * 实现：注册（挂载）时入栈、注销（卸载）时出栈；回调里问 `isTop()`。
 * 未注册时的缺省行为由调用方决定（`useEscLayer` 在 effect 未跑时按「可响应」处理），
 * 已注册的层则严格按栈顶判定——单层场景下它自己就是栈顶，照常响应。
 * React 18 StrictMode 的双调用（mount→unmount→mount）由「按 token 精确出栈」
 * 保证不会残留。
 */
export interface EscLayer {
  /** 是否轮到本层处理 Esc。 */
  isTop(): boolean;
  /** 注销本层（在 `useEffect` 的 cleanup 里调用）。 */
  release(): void;
}

const stack: symbol[] = [];

export function registerEscLayer(): EscLayer {
  const token = Symbol('esc-layer');
  stack.push(token);
  return {
    isTop: () => stack[stack.length - 1] === token,
    release: () => {
      const i = stack.lastIndexOf(token);
      if (i !== -1) stack.splice(i, 1);
    },
  };
}

/** 仅供测试：当前层数。 */
export function escLayerDepth(): number {
  return stack.length;
}
