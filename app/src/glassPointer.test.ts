import { afterEach, describe, expect, it, vi } from 'vitest';

describe('#609 glassHighlightAt 纯函数（真实坐标数据流）', () => {
  it('浮层中心 → 50% / 50%', async () => {
    const { glassHighlightAt } = await import('./glassPointer');
    expect(glassHighlightAt(300, 350, { left: 100, top: 200, width: 400, height: 300 })).toEqual({
      mx: '50.0%',
      my: '50.0%',
    });
  });

  it('相对浮层左上角换算，并夹紧到 0~100%（指针移到浮层外不产生越界渐变）', async () => {
    const { glassHighlightAt } = await import('./glassPointer');
    const rect = { left: 100, top: 200, width: 400, height: 300 };
    expect(glassHighlightAt(200, 260, rect)).toEqual({ mx: '25.0%', my: '20.0%' });
    expect(glassHighlightAt(-500, 9999, rect)).toEqual({ mx: '0.0%', my: '100.0%' });
  });

  it('零尺寸回退中心，绝不产生 NaN / Infinity（元素尚未布局时）', async () => {
    const { glassHighlightAt } = await import('./glassPointer');
    expect(glassHighlightAt(123, 456, { left: 0, top: 0, width: 0, height: 0 })).toEqual({
      mx: '50.0%',
      my: '50.0%',
    });
  });
});

describe('#609 initGlassPointer 接线（事件委托 + rAF 节流）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('pointermove 只写 --glass-mx/--glass-my，且每帧最多一次 getBoundingClientRect', async () => {
    class FakeElement {
      constructor(private readonly host: FakeElement | null = null) {}
      closest(_selector: string): FakeElement | null {
        return this.host;
      }
    }
    class FakeHTMLElement extends FakeElement {
      style = { setProperty: vi.fn() };
      getBoundingClientRect = vi.fn(() => ({
        left: 100,
        top: 200,
        width: 400,
        height: 300,
        right: 500,
        bottom: 500,
        x: 100,
        y: 200,
      }));
    }

    const handlers = new Map<string, (event: unknown) => void>();
    const addEventListener = vi.fn((type: string, fn: (event: unknown) => void) => {
      handlers.set(type, fn);
    });
    vi.stubGlobal('document', { addEventListener });
    vi.stubGlobal('Element', FakeElement);
    vi.stubGlobal('HTMLElement', FakeHTMLElement);
    let flush: (() => void) | null = null;
    const raf = vi.fn((cb: () => void) => {
      flush = cb;
      return 1;
    });
    vi.stubGlobal('requestAnimationFrame', raf);

    vi.resetModules();
    const { initGlassPointer } = await import('./glassPointer');
    initGlassPointer();
    initGlassPointer(); // 幂等：重复调用不得重复绑定
    expect(addEventListener).toHaveBeenCalledTimes(1);
    expect(addEventListener.mock.calls[0][0]).toBe('pointermove');

    const host = new FakeHTMLElement();
    const child = new FakeHTMLElement(host);
    const move = handlers.get('pointermove');
    expect(move).toBeTruthy();
    move!({ target: child, clientX: 300, clientY: 350 });
    expect(raf).toHaveBeenCalledTimes(1);
    expect(host.getBoundingClientRect).not.toHaveBeenCalled(); // 读 rect 发生在 flush

    flush!();
    expect(host.getBoundingClientRect).toHaveBeenCalledTimes(1);
    expect(host.style.setProperty).toHaveBeenCalledWith('--glass-mx', '50.0%');
    expect(host.style.setProperty).toHaveBeenCalledWith('--glass-my', '50.0%');

    // 非玻璃区域（closest 返回 null）不写样式，也不排帧。
    move!({ target: new FakeHTMLElement(null), clientX: 1, clientY: 2 });
    expect(raf).toHaveBeenCalledTimes(1);
  });
});
