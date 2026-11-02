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

  // #506 复查：结束标记必须**精确等于** ``` ，内容里「以 ``` 开头但带其它文字」的行
  // 不得误判为结束标记（否则其后的内容会被当成普通段落、输出错乱）。
  it('内容行以 ``` 开头但带文字，不提前闭合围栏', () => {
    const md = '```\n这里是说明：用 ```bash 写围栏\n真实代码 const a = 1;\n```';
    const html = renderMarkdown(md);
    // 围栏内整段都是代码，故不应出现被「提前终止」后误生成的段落 <p>。
    expect(html).toContain('<pre><code>这里是说明：用 ```bash 写围栏\n真实代码 const a = 1;');
    expect(html).not.toContain('<p>');
  });

  it('真正的结束标记（单独一行 ```）仍正常闭合', () => {
    const html = renderMarkdown('```\ncode\n```');
    // 闭合后不会有残留的 ``` 出现在代码内容之外。
    expect(html).toBe('<pre><code>code</code></pre>');
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

/**
 * CRLF 行尾下的死循环回归（#502）。
 *
 * ## 故障
 *
 * GitHub issue 正文**普遍是 CRLF 行尾**（Windows 编辑器粘贴的常见形态），
 * 而 **JavaScript 的 `.` 不匹配 `\r`**（`.` 排除 `\n` `\r` `\u2028` `\u2029`）。
 *
 * ⇒ 块级正则里**带 `$` 锚点**的那些（标题 / 无序列表 / 有序列表 / 代码围栏）
 *   在 CRLF 行上**整行失配**；
 * ⇒ 该行却会被**段落分支的终止条件**（`!/^(#{1,6})\s+/` 等，**没有** `$` 锚点）
 *   判成「块级行」⇒ 段落分支的 `while` 一次都不执行
 * ⇒ `buf` 为空且 **`i` 不前进** ⇒ 外层 `while` 原地打转
 * ⇒ `out` 无限增长 ⇒ `RangeError: Invalid array length`（或被 OOM kill）
 * ⇒ **渲染期抛错 ⇒ React 卸载整棵树 ⇒ 详情面板整块消失**（最坏整窗空白）。
 *
 * 实测：真实 issue `FoodsUp-Inc/fad-backend#1630` 的正文（首行 `## 现状\r\n`）
 * 在修复前跑 **111 秒**后抛 `RangeError`。
 *
 * ⚠️ 这批用例的价值在于**输入形状**：修复前的 27 条用例**全部用 `\n`**，
 *    所以「测试数据与真实数据形状不一致」把这个 bug 整整放过了一轮。
 */
describe('renderMarkdown — CRLF 行尾不得死循环（#502）', () => {
  it('CRLF + 标题：能渲染出 <h2>，且立即返回', () => {
    const html = renderMarkdown('## 现状\r\n\r\n正文一行\r\n');
    expect(html).toContain('<h2>现状</h2>');
    expect(html).toContain('<p>正文一行</p>');
    // ⚠️ 若再次死循环，本用例会因 vitest 超时（默认 5s）而失败 ⇒ 本身就是防线。
  });

  it('CRLF + 列表：能渲染出 <ul>/<li>', () => {
    const html = renderMarkdown('- 一条\r\n- 两条\r\n');
    expect(html).toContain('<ul><li>一条</li><li>两条</li></ul>');
  });

  it('CRLF + 有序列表：能渲染出 <ol>/<li>', () => {
    const html = renderMarkdown('1. 第一\r\n2. 第二\r\n');
    expect(html).toContain('<ol><li>第一</li><li>第二</li></ol>');
  });

  it('CRLF + 代码围栏：能渲染出 <pre><code>', () => {
    const html = renderMarkdown('```ts\r\nconst a = 1;\r\n```\r\n');
    expect(html).toContain('<pre><code>const a = 1;</code></pre>');
  });

  it('CRLF + 水平线：能渲染出 <hr />', () => {
    const html = renderMarkdown('---\r\n正文\r\n');
    expect(html).toContain('<hr />');
  });

  it('裸 CR（老 Mac 行尾）同样归一化', () => {
    const html = renderMarkdown('## 标题\r正文\r');
    expect(html).toContain('<h2>标题</h2>');
    expect(html).not.toContain('\r');
  });

  it('CRLF 与 LF 的渲染结果完全一致', () => {
    const lf = '## 现状\n\n正文\n\n## 方案\n\n- 一条\n- 两条\n';
    const crlf = lf.replace(/\n/g, '\r\n');
    expect(renderMarkdown(crlf)).toBe(renderMarkdown(lf));
  });

  it('真实 issue 正文（CRLF + 标题 + 列表 + 中文）可完整渲染', () => {
    // 形状取自 FoodsUp-Inc/fad-backend#1630 的真实正文（首行即 CRLF 标题）。
    const body = [
      '## 现状',
      '',
      '牛奶供应商 CGR 称上线约 10 个月我们欠筐 3 万多个，按 $3 / 个约 $9–10 万。',
      '',
      '## 方案',
      '',
      '10-22 仓库会议定：',
      '',
      '- 责任在司机：两周结一次，少还扣 $3 / 个',
      '- 多还奖 $0.5 / 个',
      '',
      '## 待定',
      '',
      '司机端可查：待确认。',
    ].join('\r\n');
    const html = renderMarkdown(body);
    expect(html).toContain('<h2>现状</h2>');
    expect(html).toContain('<h2>方案</h2>');
    expect(html).toContain('<h2>待定</h2>');
    expect(html).toContain('<ul><li>责任在司机：两周结一次，少还扣 $3 / 个</li>');
    expect(html).not.toContain('\r');
  });

  it('大量 CRLF 行不会拖垮渲染（终止性 + 规模）', () => {
    const body = Array.from({ length: 2000 }, (_, i) => `## 标题 ${i}\r\n\r\n正文 ${i}\r\n`).join(
      '',
    );
    const t0 = Date.now();
    const html = renderMarkdown(body);
    expect(Date.now() - t0, 'CRLF 渲染必须是毫秒级，不允许出现秒级空转').toBeLessThan(2000);
    expect(html).toContain('<h2>标题 0</h2>');
    expect(html).toContain('<h2>标题 1999</h2>');
  });
});

/**
 * 图片（#506）—— 对齐 orca：描述 / 评论里的图片要能看见。
 *
 * ⚠️ 安全边界与链接**同一套**：协议只放行 http/https；`alt` 已在转义阶段处理过。
 */
describe('renderMarkdown — 图片（#506）', () => {
  it('http/https 的图片生成 <img>（含 alt）', () => {
    const html = renderMarkdown('![截图](https://user-images.githubusercontent.com/abc.png)');
    expect(html).toContain('<img src="https://user-images.githubusercontent.com/abc.png"');
    expect(html).toContain('alt="截图"');
  });

  it('javascript: 协议不生成 <img>（只留 alt 文本）', () => {
    const html = renderMarkdown('![x](javascript:alert(1))');
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain('x');
  });

  it('data: 协议不生成 <img>', () => {
    const html = renderMarkdown('![x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(html).not.toMatch(/<img/i);
  });

  it('图片语法不会留下裸叹号（必须先于链接处理）', () => {
    const html = renderMarkdown('![alt](https://e.com/a.png)');
    expect(html).not.toContain('![');
  });

  it('alt 里的引号被转义（属性不会被闭合）', () => {
    const html = renderMarkdown('![a" onerror="alert(1)](https://e.com/a.png)');
    expect(html).not.toMatch(/onerror="alert/);
    expect(html).toContain('&quot;');
  });

  it('普通链接仍正常生成 <a>（图片改动没影响链接）', () => {
    const html = renderMarkdown('[文字](https://example.com)');
    expect(html).toContain('<a href="https://example.com"');
  });
});

/**
 * #512：任务列表 / 嵌套层级 / GFM 表格。
 *
 * ## 为什么补这三样（数据驱动，不是猜）
 *
 * 扫了用户实际在看的仓库 **121 个真实 issue body**，统计本渲染器**不支持**的构造：
 *
 * | 构造 | 出现率 | 修复前的样子 |
 * |---|---|---|
 * | 任务列表 `- [ ]` / `- [x]` | **104 / 121（86%）** | `<li>[ ] 待办 A</li>`（复选框丢失） |
 * | 嵌套列表（缩进子项） | **53 / 121（44%）** | 子项变成与父项**平级**（缩进层级丢失） |
 * | GFM 表格 | **46 / 121（38%）** | 整段变成 `\| 字段 \| 说明 \|` 的原始文本 |
 *
 * ⇒ 用户报的「内容没有按原有样式显示」就是这三项。
 *
 * ⚠️ 用例的**输入形状取自真实 body**（`FoodsUp-Inc/fad-backend` 的任务列表 /
 * 嵌套列表 / 表格），不是自己编的最小例子 —— #502 的教训。
 */
describe('renderMarkdown — 任务列表（#512）', () => {
  it('未勾选 `- [ ]` ⇒ 只读复选框', () => {
    const html = renderMarkdown('- [ ] 待办 A');
    expect(html).toContain('<input type="checkbox" class="task-list-item-checkbox" disabled />');
    expect(html).toContain('待办 A');
    // ⚠️ 标记本身不得残留在文本里。
    expect(html).not.toContain('[ ]');
  });

  it('已勾选 `- [x]` ⇒ 带 checked', () => {
    const html = renderMarkdown('- [x] 已完成 B');
    expect(html).toContain('checked disabled');
    expect(html).not.toContain('[x]');
  });

  it('复选框是**只读**的（disabled，无 name / value ⇒ 不可提交、不可交互）', () => {
    const html = renderMarkdown('- [ ] 待办');
    expect(html).toContain('disabled');
    expect(html).not.toMatch(/<input[^>]*\sname=/);
    expect(html).not.toMatch(/<input[^>]*\svalue=/);
    expect(html).not.toMatch(/<input[^>]*on[a-z]+=/i);
  });

  it('普通列表项**不受影响**（没有复选框）', () => {
    const html = renderMarkdown('- 普通项');
    expect(html).toBe('<ul><li>普通项</li></ul>');
  });

  it('`[x]` 后面必须跟空格（否则不是任务标记）', () => {
    const html = renderMarkdown('- [x]紧跟文字');
    expect(html).not.toContain('checkbox');
    expect(html).toContain('[x]紧跟文字');
  });
});

describe('renderMarkdown — 嵌套层级（#512）', () => {
  it('缩进子项挂在上一个条目**内部**（不再是平级）', () => {
    const html = renderMarkdown(['- 父项', '  - 子项 1', '  - 子项 2'].join('\n'));
    expect(html).toBe('<ul><li>父项<ul><li>子项 1</li><li>子项 2</li></ul></li></ul>');
  });

  it('两级嵌套逐层收进', () => {
    const html = renderMarkdown(['- A', '  - B', '    - C'].join('\n'));
    expect(html).toBe('<ul><li>A<ul><li>B<ul><li>C</li></ul></li></ul></li></ul>');
  });

  it('不同父项各自持有自己的子列表', () => {
    const html = renderMarkdown(['- A', '  - A1', '- B', '    - B1'].join('\n'));
    expect(html).toBe('<ul><li>A<ul><li>A1</li></ul></li><li>B<ul><li>B1</li></ul></li></ul>');
  });

  it('有序列表的嵌套子项也保序', () => {
    const html = renderMarkdown(['1. 一', '   1. 一一'].join('\n'));
    expect(html).toBe('<ol><li>一<ol><li>一一</li></ol></li></ol>');
  });

  it('类型变化（`-` → `1.`）另起一个列表（与 GitHub 一致）', () => {
    const html = renderMarkdown(['- a', '1. b'].join('\n'));
    expect(html).toBe('<ul><li>a</li></ul><ol><li>b</li></ol>');
  });

  it('tab 缩进按 4 空格计（GitHub 口径）', () => {
    const html = renderMarkdown('- 父项\n\t- 子项');
    expect(html).toBe('<ul><li>父项<ul><li>子项</li></ul></li></ul>');
  });
});

describe('renderMarkdown — GFM 表格（#512）', () => {
  it('表头 + 分隔行 + 数据行 ⇒ <table>', () => {
    const html = renderMarkdown(['| 字段 | 说明 |', '| --- | --- |', '| a | 1 |'].join('\n'));
    expect(html).toContain('<table>');
    expect(html).toContain('<thead><tr><th>字段</th><th>说明</th></tr></thead>');
    expect(html).toContain('<tbody><tr><td>a</td><td>1</td></tr></tbody>');
  });

  it('单元格首尾空白被 trim（GFM 口径）', () => {
    const html = renderMarkdown(['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n'));
    expect(html).toContain('<th>a</th>');
    expect(html).not.toContain('<th> a </th>');
  });

  it('分隔行决定对齐方式', () => {
    const html = renderMarkdown(
      ['| l | c | r |', '| :-- | :-: | --: |', '| 1 | 2 | 3 |'].join('\n'),
    );
    expect(html).toContain('<th align="left">l</th>');
    expect(html).toContain('<th align="center">c</th>');
    expect(html).toContain('<th align="right">r</th>');
  });

  it('单元格内容走行内解析（粗体 / 链接）', () => {
    const html = renderMarkdown(
      ['| a | b |', '| --- | --- |', '| **粗** | [链](https://e.com) |'].join('\n'),
    );
    expect(html).toContain('<strong>粗</strong>');
    expect(html).toContain('<a href="https://e.com"');
  });

  it('列数不足补空、过多截断（GFM 口径）', () => {
    const html = renderMarkdown(['| a | b |', '| --- | --- |', '| 1 |'].join('\n'));
    expect(html).toContain('<td>1</td><td></td>');
    const html2 = renderMarkdown(['| a |', '| --- |', '| 1 | 2 |'].join('\n'));
    expect(html2).toContain('<td>1</td></tr>');
    expect(html2).not.toContain('<td>2</td>');
  });

  it('只有表头没有数据行 ⇒ 没有 <tbody>', () => {
    const html = renderMarkdown(['| a | b |', '| --- | --- |'].join('\n'));
    expect(html).toContain('</thead>');
    expect(html).not.toContain('<tbody>');
  });

  it('**不是**分隔行的下一行 ⇒ 仍是普通段落（不误判成表格）', () => {
    const html = renderMarkdown(['| a | b |', '普通文字'].join('\n'));
    expect(html).not.toContain('<table>');
  });

  it('单元格里的 HTML 被转义（不产生真实节点）', () => {
    const html = renderMarkdown(['| a |', '| --- |', '| <script>x</script> |'].join('\n'));
    expect(html).not.toMatch(/<script/i);
    expect(html).toContain('&lt;script&gt;');
  });
});
