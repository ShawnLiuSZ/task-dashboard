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
