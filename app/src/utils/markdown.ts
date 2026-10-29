/**
 * 轻量 markdown → 安全 HTML（#498）。
 *
 * ## 为什么自己写而不是引依赖
 *
 * 仓库现状：**零前端运行时依赖**（`package.json` 只有 devDependencies）。
 * 为渲染 issue 正文引入 `marked` / `remark` 这类库要付出几百 KB 体积 + 一条
 * 新的供应链面，而实际只需要 GitHub issue body 里那几种常见标记。
 *
 * ## 安全模型（必须先读）
 *
 * 本函数返回的字符串会被 `dangerouslySetInnerHTML` 注入 DOM ⇒ **返回值必须是安全的**。
 * 三条铁律：
 *
 * 1. **先转义、后加工**：所有源文本先做 HTML 转义（`&` `<` `>` `"` `'`），
 *    之后加工出来的标签**只允许白名单里的那几种**，源文本里任何 `<` 都已经是实体。
 * 2. **不注入原始 HTML**：源文本里的 HTML 标签（`<script>`、`<img onerror=…>`）
 *    转义后只会显示为字面文本，不会变成节点。
 * 3. **链接协议白名单**：只放行 `http://` / `https://`；其余（`javascript:`、
 *    `data:`、`vbscript:`…）降级为**纯文本**，不生成 `<a>`。
 *    （#506：图片 `![alt](url)` 走**同一套**协议白名单，只生成 `src` / `alt` 两个属性。）
 *
 * ## 支持的语法
 *
 * 块级：代码块（``` / ~~~）、标题（# ~ ######）、无序列表（`-` `*` `+`）、
 * 有序列表（`1.`）、引用（`>`）、水平线（`---`）、段落。
 *
 * 行内：`` `code` ``、`**粗体**`、`*斜体*` / `_斜体_`、`~~删除线~~`、
 * `[文字](链接)`。
 *
 * 不支持（按纯文本原样显示）：表格、任务列表、HTML、引用式链接、嵌套列表。
 * 表格在 issue body 里不常见，真出现时以原始文本呈现（不丢内容）。
 */

/** HTML 转义：把 5 个危险字符换成实体。 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 链接协议白名单：只放行 http / https。
 *
 * ⚠️ 必须**在转义之后**判断 —— 转义后 `javascript:alert(1)` 里的引号已变实体，
 * 但协议名本身没变，所以这里按「去掉首尾空白 + 小写后取 `:` 之前的部分」判定。
 *
 * `data:` 也不放行（`data:text/html;base64,...` 可执行脚本）。
 */
function safeUrl(raw: string): string | null {
  const u = raw.trim();
  // 相对链接（`/owner/repo/issues/1`）在 Tauri 应用里没有意义 ⇒ 不放行。
  if (!/^https?:\/\//i.test(u)) return null;
  return u;
}

/**
 * 行内代码的占位符（Unicode **私用区** U+E000 / U+E001）。
 *
 * ⚠️ 刻意**不用** `\u0000` 这类控制字符：ESLint 的 `no-control-regex` 会直接报错
 * （控制字符进正则 = 隐形的坑位冲突）。私用区字符既不是控制字符，
 * 又几乎不可能出现在 issue 正文里 ⇒ 当占位符足够安全。
 */
const CODE_SLOT_OPEN = '\uE000';
const CODE_SLOT_CLOSE = '\uE001';

/**
 * 行内标记 → HTML。**入参必须是已转义的文本**。
 *
 * 顺序有讲究：先处理行内代码（`` ` `` 内部不做任何其它解析，与 CommonMark 一致），
 * 再处理链接，最后处理粗体 / 斜体 / 删除线。
 */
function renderInline(escaped: string): string {
  // 行内代码：内容已经转义，直接包 `<code>`。
  const codeSpans: string[] = [];
  let s = escaped.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    codeSpans.push(code);
    return `${CODE_SLOT_OPEN}CODE${codeSpans.length - 1}${CODE_SLOT_CLOSE}`;
  });

  // #506：图片 `![alt](url)` —— **必须先于链接处理**（否则 `!` 会被当成文字前缀，
  // 留下一个裸 `!`）。
  //
  // ⚠️ 安全：`src` 走与链接**同一套**协议白名单（只放行 http/https）；
  // `alt` 已被 escapeHtml 处理过（`"` → `&quot;`）⇒ 放进属性值安全。
  // ⚠️ 隐私：放行意味着**会向外部域名发起请求**（与 GitHub 网页版渲染 issue 图片
  // 的行为一致，orca 也加载 issue 里的图片）；协议不在白名单 ⇒ 只留 alt 文本。
  s = s.replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, alt: string, url: string) => {
    const src = safeUrl(url);
    if (!src) return alt;
    return `<img src="${src}" alt="${alt}" loading="lazy" />`;
  });

  // 链接：[文字](url) —— 文字里不能含 `]`（避免贪婪匹配吞掉后续文本）。
  s = s.replace(/\[([^\]\n]*)\]\(([^)\s]+)\)/g, (_m, text: string, url: string) => {
    const href = safeUrl(url);
    // 协议不在白名单 ⇒ 降级为纯文本（保留可见文字，不生成可点链接）。
    if (!href) return text;
    // href 已被转义（`&` → `&amp;` 等），放进属性值是安全的。
    return `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`;
  });

  // 粗体 / 斜体 / 删除线。`**` 优先于 `*`（顺序不能反，否则 `**x**` 会被当成两次斜体）。
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

  // 还原行内代码。
  const slotRe = new RegExp(`${CODE_SLOT_OPEN}CODE(\\d+)${CODE_SLOT_CLOSE}`, 'g');
  s = s.replace(slotRe, (_m, i: string) => `<code>${codeSpans[Number(i)]}</code>`);
  return s;
}

/** 判断一行是否是水平线（`---` / `***` / `___`，至少 3 个）。 */
function isHr(line: string): boolean {
  return /^ {0,3}([-*_])\s*(\1\s*){2,}$/.test(line);
}

/**
 * 把 markdown 源文本渲染为安全 HTML。
 *
 * @param src 原始 markdown（GitHub issue body）
 * @returns 可直接 `dangerouslySetInnerHTML` 的 HTML 字符串；空输入返回空串
 */
export function renderMarkdown(src: string): string {
  if (!src || !src.trim()) return '';
  // ⚠️ #502：**先归一化行尾**（CRLF / 裸 CR → LF），再进块级解析。
  //
  // 原因：JavaScript 的 `.` **不匹配 `\r`**（`.` 排除 `\n` `\r` `\u2028` `\u2029`），
  // 而 GitHub issue 正文**普遍是 CRLF 行尾**（Windows 编辑器粘贴的常见形态）。
  // 于是下面这几条**带 `$` 锚点**的块级正则在 CRLF 行上**整行失配**：
  //
  //   /^(#{1,6})\s+(.*)$/        标题     ← (.*) 停在 \r 前，$ 要求到行尾
  //   /^\s*[-*+]\s+(.*)$/       无序列表
  //   /^\s*\d+[.)]\s+(.*)$/     有序列表
  //   /^\s*(```|~~~)(.*)$/      代码围栏
  //
  // ⇒ 该行进不了任何块级分支，却会被**段落分支的终止条件**（`!/^(#{1,6})\s+/` 等，
  //   这些**没有** `$` 锚点）判成「块级行」⇒ 段落分支的 `while` **一次都不执行**
  // ⇒ `buf` 为空且 **`i` 不前进** ⇒ 外层 `while` 原地打转 ⇒ `out` 无限增长
  // ⇒ `RangeError: Invalid array length`（或内存暴涨被 OOM kill）
  // ⇒ **渲染期抛错 ⇒ React 卸载整棵树 ⇒ 详情面板整块消失（最坏整窗空白）**。
  //
  // 真实触发样本：`FoodsUp-Inc/fad-backend#1630` 的正文（首行 `## 现状\r\n`）。
  // ⚠️ 修复前那 27 条 markdown 单测**全部用 `\n`** ⇒ 覆盖不到这条路径
  //    （典型的「测试数据形状与真实数据不一致」）。
  const lines = escapeHtml(src.replace(/\r\n?/g, '\n')).split('\n');
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // ① 代码块：``` 或 ~~~ 开头，直到匹配的结束标记；内容**不做任何行内解析**。
    const fence = line.match(/^\s*(```|~~~)(.*)$/);
    if (fence) {
      const marker = fence[1];
      const buf: string[] = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith(marker)) {
        buf.push(lines[i]);
        i += 1;
      }
      i += 1; // 跳过结束标记（没有结束标记时 i 已越界，while 自然结束）
      out.push(`<pre><code>${buf.join('\n')}</code></pre>`);
      continue;
    }

    // ② 水平线
    if (isHr(line)) {
      out.push('<hr />');
      i += 1;
      continue;
    }

    // ③ 标题：`# ` ~ `###### `
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }

    // ④ 引用：`> `
    if (/^\s*&gt;\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^\s*&gt;\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*&gt;\s?/, ''));
        i += 1;
      }
      out.push(`<blockquote>${renderInline(buf.join('\n'))}</blockquote>`);
      continue;
    }

    // ⑤ 列表：连续的无序 / 有序行合并成一个列表块。
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (bullet || ordered) {
      const isOrdered = Boolean(ordered);
      const items: string[] = [];
      while (i < lines.length) {
        const cur = lines[i];
        const m = isOrdered ? cur.match(/^\s*\d+[.)]\s+(.*)$/) : cur.match(/^\s*[-*+]\s+(.*)$/);
        if (!m) break;
        items.push(`<li>${renderInline(m[1])}</li>`);
        i += 1;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      out.push(`<${tag}>${items.join('')}</${tag}>`);
      continue;
    }

    // ⑥ 空行 ⇒ 段落分隔
    if (!line.trim()) {
      i += 1;
      continue;
    }

    // ⑦ 段落：连续非空行合并。
    const buf: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^\s*(```|~~~)/.test(lines[i]) &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !/^\s*&gt;\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+[.)]\s+/.test(lines[i]) &&
      !isHr(lines[i])
    ) {
      buf.push(lines[i]);
      i += 1;
    }
    // ⚠️ #502：**段落分支必须保证 `i` 前进**。
    // 上面的终止条件与各块级分支的判定是「两套独立写法的同一份语义」，
    // 只要有一处不一致（历史上就是 CRLF 导致标题行两套判定打架），
    // `while` 会一次都不执行 ⇒ `buf` 为空且 `i` 不动 ⇒ 外层循环原地打转。
    // 这里显式兜底：**任何分支都必须消费至少一行**。
    if (buf.length === 0) {
      i += 1;
      continue;
    }
    out.push(`<p>${renderInline(buf.join('\n'))}</p>`);
  }

  return out.join('');
}

/**
 * 是否需要折叠（正文过长时默认收起 + 「展开全文」按钮）。
 *
 * 阈值按「字符数」而非行数：issue body 的段落长度差异很大，
 * 行数容易被单个超长段落骗过。600 字 ≈ 3~4 屏，够读完且不至于把弹窗撑爆。
 */
export const BODY_COLLAPSE_THRESHOLD = 600;

/** 正文是否应默认折叠。 */
export function shouldCollapseBody(src: string): boolean {
  return src.trim().length > BODY_COLLAPSE_THRESHOLD;
}
