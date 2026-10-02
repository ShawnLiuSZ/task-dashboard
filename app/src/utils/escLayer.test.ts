import { describe, expect, it } from 'vitest';
import { escLayerDepth, registerEscLayer } from './escLayer';

describe('Esc 分层仲裁（#329）', () => {
  it('单层场景下自己就是栈顶，照常响应 Esc', () => {
    const only = registerEscLayer();
    expect(only.isTop()).toBe(true);
    only.release();
    expect(escLayerDepth()).toBe(0);
  });

  it('注销后不再占据最上层（下方的层重新拿回 Esc）', () => {
    const panel = registerEscLayer();
    const dialog = registerEscLayer();
    dialog.release();
    expect(dialog.isTop()).toBe(false);
    expect(panel.isTop()).toBe(true);
    panel.release();
    expect(escLayerDepth()).toBe(0);
  });

  it('后注册者为最上层，先注册者让出 Esc', () => {
    const panel = registerEscLayer();
    const dialog = registerEscLayer();
    expect(panel.isTop()).toBe(false);
    expect(dialog.isTop()).toBe(true);
    dialog.release();
    // 确认框关掉后，面板重新拿回 Esc
    expect(panel.isTop()).toBe(true);
    panel.release();
    expect(escLayerDepth()).toBe(0);
  });

  it('按 token 精确出栈：乱序释放不会误删他人（React StrictMode 双调用安全）', () => {
    const a = registerEscLayer();
    const b = registerEscLayer();
    // 模拟 StrictMode：a 先卸载（此时 b 在栈顶），再重新挂载 a
    a.release();
    expect(b.isTop()).toBe(true);
    const a2 = registerEscLayer();
    expect(b.isTop()).toBe(false);
    expect(a2.isTop()).toBe(true);
    a.release(); // 重复 release 应为 no-op
    expect(escLayerDepth()).toBe(2);
    a2.release();
    b.release();
    expect(escLayerDepth()).toBe(0);
  });

  it('取消后再次打开确认框：面板不响应 Esc 的不变式成立', () => {
    // 面板常驻；确认框反复开关，期间面板始终让出 Esc
    const panel = registerEscLayer();
    for (let i = 0; i < 3; i++) {
      const dialog = registerEscLayer();
      expect(panel.isTop()).toBe(false);
      expect(dialog.isTop()).toBe(true);
      dialog.release();
      expect(panel.isTop()).toBe(true);
    }
    panel.release();
    expect(escLayerDepth()).toBe(0);
  });
});

/**
 * #344：把「父重渲染导致层级颠倒」这条不变式显式钉住。
 *
 * 场景：`ConfirmDialog`（子）叠在 `SyncLogsPanel`（父）之上时，父组件发生一次
 * 重渲染。若两层的注册都放在带不稳定依赖（`onClose` / `onCancel`）的 effect 里，
 * React 会按「destroy 自底向上 → create 自底向上」把两层整体重排：
 *
 * ```text
 * destroy: 子 release() → 父 release() → 栈空
 * create : 子 register() → [子]
 * create : 父 register() → [子, 父]   ← 父压过了自己的子层
 * ```
 *
 * 此时 `isTop()` 对子为 false、对父为 true ⇒ 一次 Esc 关掉**整个面板**，
 * 而不是取消对话框 —— 用户想取消却丢了面板。
 *
 * 修复后（`useWindowEscLayer` 的层注册只在 `[]` 依赖的 effect 里发生一次），
 * 重渲染不会触发任何注销/注册，层级原样保持。
 */
describe('Esc 层级在父重渲染后不得颠倒（#344）', () => {
  it('模拟 effect 依赖不稳定时的重排：子层会被父层压过（缺陷形态）', () => {
    const panel1 = registerEscLayer();
    const dialog1 = registerEscLayer();
    expect(dialog1.isTop()).toBe(true);

    // —— 一次「父重渲染」：destroy 自底向上，再 create 自底向上（子→父）
    dialog1.release();
    panel1.release();
    const dialog2 = registerEscLayer(); // 子先创建
    const panel2 = registerEscLayer(); // 父后创建
    // ❌ 缺陷形态：父在子之上
    expect(panel2.isTop()).toBe(true);
    expect(dialog2.isTop()).toBe(false);

    dialog2.release();
    panel2.release();
    expect(escLayerDepth()).toBe(0);
  });

  it('层注册只做一次时，父重渲染后层级原样保持（修复形态）', () => {
    // 面板与对话框各注册一次，此后只做重渲染（无注销/注册）
    const panel = registerEscLayer();
    const dialog = registerEscLayer();
    // 若干次「重渲染」：不触碰注册，层级不变
    for (let i = 0; i < 3; i++) {
      expect(dialog.isTop(), `第 ${i + 1} 次重渲染后子层仍应在栈顶`).toBe(true);
      expect(panel.isTop(), `第 ${i + 1} 次重渲染后父层不应在栈顶`).toBe(false);
    }
    // Esc 命中子层 → 只取消对话框
    const handledBy: string[] = [];
    const onEsc = (name: string) => () => {
      if ((name === 'dialog' ? dialog : panel).isTop()) handledBy.push(name);
    };
    onEsc('dialog')();
    expect(handledBy).toEqual(['dialog']);
    expect(panel.isTop()).toBe(false);

    dialog.release();
    expect(panel.isTop()).toBe(true);
    panel.release();
    expect(escLayerDepth()).toBe(0);
  });
});
