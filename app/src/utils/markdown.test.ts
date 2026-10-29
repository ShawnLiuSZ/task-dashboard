import { describe, expect, it } from 'vitest';
import { BODY_COLLAPSE_THRESHOLD, renderMarkdown, shouldCollapseBody } from './markdown';

/**
 * 轻量 markdown 渲染的回归测试（#498）。
 *
 * ⚠️ 这里的返回值会被 `dangerouslySetInnerHTML` 注入 DOM ⇒
 *    **安全性是第一优先级**：源文本里的一切都必须是转义后的纯文本，
 *    只允许本模块自己生成的白名单标签。
 *
 * 每条 XSS 用例都断言「危险内容没有变成可执行结构」，
 * 而不是断言「输出里出现了某个转义写法」——后者会随实现细节漂移。
 */

/** 断言输出里**没有**真正的 `<script>` 标签（只有转义后的 `&lt;script&gt;`）。 */
function expectNoScriptTag(html: string) {
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/<\/script/i);
}

describe('renderMarkdown — 安全（#498）', () => {
  it('原始 HTML 标签被转义，不产生真实节点', () => {
    const html = renderMarkdown('<script>alert(1)</script>');
    expectNoScriptTag(html);
    expect(html).toContain('&lt;script&gt;');
  });

  it('img 的 onerror 不会成为真实属性', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('&lt;img');
  });

  it('javascript: 链接不生成 <a>，只留可见文字', () => {
    const html = renderMarkdown('[点我](javascript:alert(1))');
    expect(html).not.toMatch(/<a\s/i);
    expect(html).toContain('点我');
  });

  it('data: 链接不放行', () => {
    const html = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toMatch(/<a\s/i);
  });

  it('相对链接不放行（应用内无意义）', () => {
    const html = renderMarkdown('[x](/owner/repo/issues/1)');
    expect(html).not.toMatch(/<a\s/i);
  });

  it('http / https 链接正常生成且带 rel=noopener', () => {
    const html = renderMarkdown('[x](https://github.com/o/r/issues/1)');
    expect(html).toContain('<a href="https://github.com/o/r/issues/1"');
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it('链接文字里的引号不会逃出属性值', () => {
    const html = renderMarkdown('[x](https://a.com/"onmouseover="alert(1))');
    expect(html).not.toMatch(/onmouseover="alert/);
  });
});

describe('renderMarkdown — 结构', () => {
  it('段落：连续非空行合并为一个 <p>', () => {
    const html = renderMarkdown('第一行\n第二行');
    expect(html).toBe('<p>第一行\n第二行</p>');
  });

  it('空行分隔多个段落', () => {
    const html = renderMarkdown('A\n\nB');
    expect(html).toBe('<p>A</p><p>B</p>');
  });

  it('标题：# 到 ###### 映射到对应层级', () => {
    expect(renderMarkdown('# 一级')).toContain('<h1>一级</h1>');
    expect(renderMarkdown('### 三级')).toContain('<h3>三级</h3>');
  });

  it('无序列表：连续 - 行合并成一个 <ul>', () => {
    const html = renderMarkdown('- 一\n- 二');
    expect(html).toBe('<ul><li>一</li><li>二</li></ul>');
  });

  it('有序列表：连续 1. 行合并成一个 <ol>', () => {
    const html = renderMarkdown('1. 甲\n2. 乙');
    expect(html).toBe('<ol><li>甲</li><li>乙</li></ol>');
  });

  it('引用：连续 > 行合并成一个 <blockquote>', () => {
    const html = renderMarkdown('> 引用一\n> 引用二');
    expect(html).toContain('<blockquote>');
    expect(html).toContain('引用一');
  });

  it('水平线：--- 变 <hr />', () => {
    expect(renderMarkdown('---')).toBe('<hr />');
  });

  it('代码块：内容原样保留，**不做**行内解析', () => {
    const html = renderMarkdown('```\nconst a = **b**;\n```');
    expect(html).toContain('<pre><code>');
    expect(html).toContain('const a = **b**;');
    expect(html).not.toContain('<strong>');
  });

  it('代码块内不做链接解析', () => {
    const html = renderMarkdown('```\n[x](https://a.com)\n```');
    expect(html).not.toContain('<a ');
  });

  it('未闭合的代码块不会吞掉后续内容', () => {
    const html = renderMarkdown('```\n未闭合');
    expect(html).toContain('未闭合');
  });
});

describe('renderMarkdown — 行内', () => {
  it('粗体 **x**', () => {
    expect(renderMarkdown('**粗**')).toContain('<strong>粗</strong>');
  });

  it('斜体 *x* 与 _x_', () => {
    expect(renderMarkdown('*斜*')).toContain('<em>斜</em>');
    expect(renderMarkdown('_斜_')).toContain('<em>斜</em>');
  });

  it('删除线 ~~x~~', () => {
    expect(renderMarkdown('~~删~~')).toContain('<del>删</del>');
  });

  it('行内代码 `x` 不解析内部标记', () => {
    const html = renderMarkdown('`**不是粗体**`');
    expect(html).toContain('<code>');
    expect(html).not.toContain('<strong>');
  });

  it('粗体优先于斜体（**x** 不被当成两次斜体）', () => {
    const html = renderMarkdown('**粗**');
    expect(html).toContain('<strong>粗</strong>');
    expect(html).not.toContain('<em>');
  });
});

describe('renderMarkdown — 边界', () => {
  it('空输入返回空串', () => {
    expect(renderMarkdown('')).toBe('');
    expect(renderMarkdown('   \n  ')).toBe('');
  });

  it('纯空白段落不产生 <p>', () => {
    expect(renderMarkdown('\n\n\n')).toBe('');
  });
});

describe('shouldCollapseBody（#498）', () => {
  it('短正文不折叠', () => {
    expect(shouldCollapseBody('很短')).toBe(false);
  });

  it('超过阈值则折叠', () => {
    expect(shouldCollapseBody('x'.repeat(BODY_COLLAPSE_THRESHOLD + 1))).toBe(true);
  });

  it('恰好等于阈值不折叠', () => {
    expect(shouldCollapseBody('x'.repeat(BODY_COLLAPSE_THRESHOLD))).toBe(false);
  });
});
