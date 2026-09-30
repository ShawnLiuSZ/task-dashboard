/**
 * `check-i18n.mjs` 的对比逻辑单测（#330）。
 *
 * 缺陷背景：原 checker 把语种**硬编码**成 zh-CN / en-US 两份（`const files = {...}`），
 * 于是 README 宣传的「复制 `en-US.json` 新增 `ja-JP.json`」这条路**不会被校验**，
 * 脚本照样输出「✓ 通过」—— 给出虚假安全感。
 *
 * 修复后有两条防线：
 *   ① `localeIds()` 动态发现 `locales/*.json`（本文件用合成文件名测）；
 *   ② `compareLocales()` 对**任意数量**的语种逐一比对（本文件用合成的 ja-JP 测）。
 *
 * 反向验证：把 `compareLocales` 改回只比 `zh-CN` / `en-US` 两个语种
 * （例如 `const others = ["en-US"].filter(...)`），「第三语种缺失 key」这条用例必失败。
 */
import { describe, expect, it } from 'vitest';

import { BASE_LOCALE, compareLocales, localeIds, placeholders } from '../scripts/i18n-lib.mjs';
import enUS from './i18n/locales/en-US.json';
import zhCN from './i18n/locales/zh-CN.json';

describe('localeIds：动态发现语种（#330）', () => {
  it('只收 .json 并排序，忽略目录里的其它文件', () => {
    expect(localeIds(['zh-CN.json', 'en-US.json', 'README.md', 'ja-JP.json', '.gitkeep'])).toEqual([
      'en-US',
      'ja-JP',
      'zh-CN',
    ]);
  });

  it('新增语种会被自动纳入（这正是原实现硬编码两处时漏掉的）', () => {
    expect(localeIds(['zh-CN.json', 'en-US.json', 'ja-JP.json'])).toContain('ja-JP');
  });

  it('空目录 / 无 json 返回空数组', () => {
    expect(localeIds([])).toEqual([]);
    expect(localeIds(['notes.txt'])).toEqual([]);
  });
});

describe('placeholders', () => {
  it('取出并排序占位符，同名重复保留', () => {
    expect(placeholders('已同步 {count} 项，共 {total} 项')).toEqual(['count', 'total']);
    expect(placeholders('{a}-{a}')).toEqual(['a', 'a']);
    expect(placeholders('无占位符')).toEqual([]);
  });
});

describe('compareLocales：任意语种数量（#330）', () => {
  const base = { 'app.title': '任务看板', 'sync.done': '已同步 {count} 项' };

  it('基准与另一语种一致 → 无错误', () => {
    expect(compareLocales({ 'zh-CN': base, 'en-US': { ...base } })).toEqual([]);
  });

  it('第三语种缺失 key 会被报出（原实现只比两个语种，永远看不到）', () => {
    const errors = compareLocales({
      'zh-CN': base,
      'en-US': { ...base },
      'ja-JP': { 'app.title': 'タスクボード' },
    });
    expect(errors).toContain('ja-JP 缺失 key: sync.done');
    // 只缺 1 个 key，且语种一致，故总错误数应为 1
    expect(errors).toHaveLength(1);
  });

  it('多出 key 也被报出（方向相反）', () => {
    const errors = compareLocales({
      'zh-CN': base,
      'en-US': { ...base, 'extra.key': 'x' },
    });
    expect(errors).toContain('zh-CN 缺失 key: extra.key');
  });

  it('占位符不一致被报出', () => {
    const errors = compareLocales({
      'zh-CN': base,
      'en-US': { 'app.title': 'Board', 'sync.done': 'Synced {total}' },
    });
    expect(errors.some((e) => e.startsWith('占位符不一致: sync.done'))).toBe(true);
  });

  it('任一侧空翻译都被报出（中英两侧分别标注语种）', () => {
    const errors = compareLocales({
      'zh-CN': { a: '  ', b: '有' },
      'en-US': { a: 'x', b: '' },
    });
    expect(errors).toContain('存在空翻译: a（zh-CN）');
    expect(errors).toContain('存在空翻译: b（en-US）');
  });

  it('缺少基准语种直接报错', () => {
    expect(compareLocales({ 'en-US': base })).toContain('基准语种 zh-CN 缺失');
  });

  it('只有基准语种时提示校验失去意义', () => {
    expect(compareLocales({ 'zh-CN': base }).some((e) => e.includes('没有任何其它语种'))).toBe(
      true,
    );
  });
});

describe('真实 locale 文件（仓库断言）', () => {
  it('基准语种常量与实际目录一致', () => {
    expect(BASE_LOCALE).toBe('zh-CN');
  });

  it('zh-CN 与 en-US 通过校验且 key 数一致', () => {
    const dicts = { 'zh-CN': zhCN, 'en-US': enUS };
    expect(compareLocales(dicts, BASE_LOCALE)).toEqual([]);
    expect(Object.keys(zhCN).length).toBe(Object.keys(enUS).length);
    expect(Object.keys(zhCN).length).toBeGreaterThan(300);
  });
});
