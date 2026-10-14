import { describe, expect, it } from 'vitest';
// 仓库约定（见 panel-wiring.test.ts / styles.test.ts）：vitest 跑在 node 环境，
// 不引入 jsdom / testing-library（§2.5 不引入新依赖），组件接线类回归用 `?raw`
// 读源码做静态断言。
import raw from './components/SettingsPanel.tsx?raw';

/**
 * 设置面板接线回归。
 *
 * 设置面板以本地偏好为主：主题、语言、字体等走组件内 state + 各自的持久化
 * 通道，**不经后端 `saveSettings`**。这类「本地接线」最容易被静态类型放过
 * —— 少调一次持久化函数不会有任何编译错误，但用户重启后偏好就丢了。
 * 故此处逐个断言接线完整。
 */

/** 从源码里取出某个 `const xxx = (...) => { ... };` 的函数体。 */
function fnBody(name: string): string {
  return (
    raw.match(new RegExp(`const ${name} = \\([^)]*\\) => \\{[\\s\\S]*?\\n {2}\\};`))?.[0] ?? ''
  );
}

describe('主题与语言切换即时生效（#308）', () => {
  it('handleThemeChange 同时更新 state 与写入 themeManager', () => {
    const fn = fnBody('handleThemeChange');
    expect(fn, '应能取到 handleThemeChange 函数体').not.toBe('');
    expect(fn).toMatch(/setThemeMode\(mode\)/);
    // 只 setState 不写 themeManager ⇒ 刷新后主题回退，type 检查抓不到
    expect(fn).toMatch(/themeManager\.setMode\(mode\)/);
  });

  it('主题下拉三项齐全（跟随系统 / 浅色 / 深色）', () => {
    expect(raw).toMatch(/t\('settings\.themeAuto'\)/);
    expect(raw).toMatch(/t\('settings\.themeLight'\)/);
    expect(raw).toMatch(/t\('settings\.themeDark'\)/);
  });

  it('语言切换直接走 i18n 的 setMode（无需保存）', () => {
    expect(raw).toMatch(/setLangMode\(e\.target\.value as LangMode\)/);
  });
});

describe('同步间隔的本地边界与预设（v0.3.41）', () => {
  it('输入框数值下限被夹到 5 分钟，不接受 0 / 负数 / 非数字', () => {
    // 直接透传会让定时同步变成高频轮询（0 ⇒ 事件循环空转）
    expect(raw).toMatch(/min=\{5\}/);
    expect(raw).toMatch(/Math\.max\(5, Number\(e\.target\.value\) \|\| 5\)/);
  });

  it('PRESETS 预设档位渲染为 chip 并高亮当前值', () => {
    expect(raw).toMatch(/const PRESETS = \[15, 30, 60, 120, 240\]/);
    expect(raw).toMatch(/\{PRESETS\.map\(\(p\) => \(/);
    expect(raw).toMatch(/className=\{`chip\$\{minutes === p \? ' on' : ''\}`\}/);
  });
});

/**
 * 字体设置接线（#444）回归。
 *
 * 三路「即时生效」是本功能的核心 UX：用户改字号/字体时**必须立刻看到效果**，
 * 不能等点「保存」。若某个 onChange 退化成只 setState 而不调 fontPrefs，
 * 偏好永远写不进 localStorage（重启后失效）—— 而这类缺陷类型检查抓不到。
 */
describe('字体设置接线（#444）', () => {
  it('三个处理函数都同时 setState + 写偏好（即时生效，不等保存）', () => {
    for (const [fn, stateSetter, prefCall] of [
      ['handleFontSizeChange', 'setFontSize(px)', 'fontPrefs.setFontSize(px)'],
      ['handleFontFamilyChange', 'setFontFamily(name)', 'fontPrefs.setFontFamily(name)'],
      ['handleMonoFamilyChange', 'setMonoFamily(name)', 'fontPrefs.setMonoFamily(name)'],
    ] as const) {
      const m = fnBody(fn);
      expect(m, `应能取到 ${fn} 函数体`).not.toBe('');
      expect(m, `${fn} 应更新 React state`).toContain(stateSetter);
      expect(m, `${fn} 应写入偏好（否则重启后失效）`).toContain(prefCall);
    }
  });

  it('面板挂载时探测一次可用字体', () => {
    expect(raw).toMatch(
      /useEffect\(\(\) => \{\n {4}setAvailFonts\(detectAvailableFonts\(\)\);\n {2}\}, \[\]\);/,
    );
  });

  it('字体下拉仅渲染探测结果，且含「跟随」首项', () => {
    // 探测未完成时显示提示而非空下拉（避免用户以为没有可选字体）
    expect(raw).toMatch(/availFonts === null \?/);
    expect(raw).toMatch(/t\('settings\.fontDetecting'\)/);
    // 两个下拉都以「跟随」为第一项
    expect(raw).toMatch(
      /<option value=\{DEFAULT_FONT_FAMILY\}>\{t\('settings\.fontSystemDefault'\)\}<\/option>/,
    );
    expect(raw).toMatch(
      /<option value=\{DEFAULT_MONO_FAMILY\}>\{t\('settings\.fontFollowUi'\)\}<\/option>/,
    );
    // 选项来源是探测结果，不是候选全量
    expect(raw).toMatch(/\{availFonts\.map\(\(f\) => \(/);
  });

  it('字号用 chip 档位渲染并带 aria-pressed（可访问性 + 选中态）', () => {
    expect(raw).toMatch(/\{FONT_SIZE_PRESETS\.map\(\(p\) => \(/);
    expect(raw).toMatch(/aria-pressed=\{fontSize === p\}/);
    expect(raw).toMatch(/className=\{`chip\$\{fontSize === p \? ' on' : ''\}`\}/);
  });

  it('预览行用所选字体内联渲染（所见即所得，不依赖全局变量的渲染时序）', () => {
    expect(raw).toMatch(/className="font-preview" style=\{previewStyle\(fontFamily\)\}/);
    const fn =
      raw.match(/function previewStyle\(family: string\): CSSProperties \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(fn, '应能取到 previewStyle 函数体').not.toBe('');
    // 空串（跟随系统）时不内联任何字体
    expect(fn).toMatch(/if \(!family\) return \{\};/);
    expect(fn).toMatch(/fontFamily/);
  });
});
