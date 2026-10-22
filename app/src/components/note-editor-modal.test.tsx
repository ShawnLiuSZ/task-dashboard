import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import NoteEditorModal from './NoteEditorModal';
import { I18nProvider } from '../i18n';
import type { Note } from '../types';

/**
 * 「编辑备忘录」弹窗的渲染回归（#470）。
 *
 * 覆盖点：
 * ① 编辑框承载**完整正文**（不折叠）—— 折叠只发生在卡片上，弹窗内若也折叠
 *    就没法编辑全文；
 * ② 三个操作齐备：多行编辑框 / 保存 / 取消；
 * ③ ⌘/Ctrl + Enter 绑在编辑框上，Esc 走 window 级分层（#344）；
 * ④ 可访问性属性（role=dialog / aria-modal）与关闭按钮；
 * ⑤ 弹窗挂在面板内部（遮罩宿主是 `.notes-panel`）。
 *
 * ⚠️ node 环境无 DOM ⇒ 用 `renderToStaticMarkup` 做服务端渲染断言，
 *    与 `note-viewer-modal.test.tsx` / `confirm-dialog.test.tsx` 同一思路。
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

function render(note: Note = NOTE, onSave: (c: string) => Promise<void> = async () => {}) {
  return renderToStaticMarkup(
    <I18nProvider>
      <NoteEditorModal note={note} onSave={onSave} onClose={noop} />
    </I18nProvider>,
  );
}

describe('NoteEditorModal（#470）', () => {
  it('编辑框承载完整正文（不折叠、可编辑）', () => {
    const html = render();
    // 全文每一行都要在
    expect(html).toContain('第 1 项');
    expect(html).toContain('第二行内容');
    expect(html).toContain('第三行内容');
    // 是 textarea（可编辑），不是只读的 div
    expect(html).toContain('<textarea');
    expect(html).toContain('note-editor-textarea');
  });

  it('编辑框不被折叠（折叠只在卡片上做）', () => {
    const html = render();
    const m = html.match(/class="note-textarea note-editor-textarea"[^>]*>/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toContain('clamp');
    expect(m![0]).not.toContain('line-clamp');
    expect(m![0]).not.toContain('readonly');
  });

  it('三个操作齐备：编辑框 / 取消 / 保存', () => {
    const html = render();
    expect(html).toContain('<textarea');
    expect(html).toContain('取消');
    expect(html).toContain('保存');
  });

  it('⌘/Ctrl + Enter 绑在编辑框上', () => {
    const html = render();
    // 事件处理器不会出现在 SSR 产物里 → 断言按钮与提示文案。
    // （键盘绑定的静态断言在 notes-layout.test.ts 里做。）
    expect(html).toContain('note-hint');
    expect(html).toContain('Enter');
  });

  it('保留优先级色点与优先级名', () => {
    const html = render();
    expect(html).toContain('note-dot');
    // high 优先级在中文下显示「高」
    expect(html).toContain('高');
  });

  it('可访问性：role=dialog + aria-modal + 关闭按钮', () => {
    const html = render();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="关闭"');
  });

  it('遮罩点击区域存在（modal-mask 宿主）', () => {
    const html = render();
    expect(html).toContain('note-editor-mask');
    expect(html).toContain('note-editor-modal');
  });

  it('弹窗标题是「编辑备忘录」（与查看弹窗区分）', () => {
    const html = render();
    expect(html).toContain('编辑备忘录');
    // 不得复用查看弹窗的标题
    expect(html).not.toContain('备忘录详情');
  });
});
