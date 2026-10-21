import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NoteViewerModal from './NoteViewerModal';
import { I18nProvider } from '../i18n';
import type { Note } from '../types';

/**
 * 「查看全文」弹窗的渲染回归（#465）。
 *
 * 覆盖点：
 * ① 完整正文呈现（**不折叠**）—— 卡片里用 `-webkit-line-clamp` 折叠，
 *    弹窗是全文的唯一载体，折叠在这里等于功能失效；
 * ② 换行保留（`white-space: pre-wrap` 由 CSS 保证，渲染层验证内容不被转义/合并）；
 * ③ 优先级色点 + 绝对时间（弹窗比卡片多给了完整时间戳）；
 * ④ 可访问性属性（role=dialog / aria-modal）与关闭按钮。
 *
 * ⚠️ node 环境无 DOM ⇒ 用 `renderToStaticMarkup` 做服务端渲染断言，
 *    与 `confirm-dialog.test.tsx` 同一思路。
 */

// 固定中文文案，避免 node 环境下 auto 模式解析不确定。
beforeEach(() => {
  vi.stubGlobal('localStorage', {
    getItem: () => 'zh-CN',
    setItem: () => {},
    removeItem: () => {},
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const noop = () => {};

const NOTE: Note = {
  id: 7,
  content: '## 第 1 项\n第二行内容\n第三行内容',
  label: 'high',
  createdAt: 1760000000,
  updatedAt: 1760000000,
};

function render(note: Note = NOTE) {
  return renderToStaticMarkup(
    <I18nProvider>
      <NoteViewerModal note={note} onClose={noop} />
    </I18nProvider>,
  );
}

describe('NoteViewerModal（#465）', () => {
  it('完整呈现正文（不截断、不折叠）', () => {
    const html = render();
    // 全文每一行都要在
    expect(html).toContain('第 1 项');
    expect(html).toContain('第二行内容');
    expect(html).toContain('第三行内容');
    // 换行以 <br> 或保留空白的形式呈现（pre-wrap 下内容原样保留）
    expect(html).toContain('note-viewer-content');
  });

  it('正文容器不含折叠相关类（折叠只在卡片里做）', () => {
    const html = render();
    // 折叠用的是 -webkit-line-clamp（CSS），渲染层确认正文容器是普通块
    const m = html.match(/class="note-viewer-content"[^>]*>/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain('clamp');
    expect(m![0]).not.toContain('line-clamp');
  });

  it('保留优先级色点与优先级名', () => {
    const html = render();
    expect(html).toContain('note-dot');
    // high 优先级在中文下显示「高」
    expect(html).toContain('高');
  });

  it('展示完整时间戳（卡片只给相对时间）', () => {
    const html = render();
    // 绝对时间戳的年份应出现
    expect(html).toMatch(/20\d\d/);
  });

  it('可访问性：role=dialog + aria-modal + 关闭按钮', () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    // 关闭按钮（aria-label 为「关闭」）
    expect(html).toContain('aria-label="关闭"');
  });

  it('遮罩点击区域存在（modal-mask 宿主）', () => {
    const html = render();
    expect(html).toContain('note-viewer-mask');
    expect(html).toContain('note-viewer-modal');
  });
});
