/**
 * ESLint 门禁的配置一致性（#330）。
 *
 * 背景：#330 把 `--max-warnings` 从 20 降到 0，并把 16 条 `react-refresh/only-export-components`
 * 存量告警从「靠阈值留余量」改为「在 `allowExportNames` 里**逐名登记**」。这样存量归零，
 * 而任何**新增**的非组件导出仍会告警并挡住 CI。
 *
 * 这套机制有一个 lint 自己发现不了的失效模式：**名单与真实导出脱节**。
 *   - 漏登记 → lint 报 warning（CI 能拦，无需本测试）；
 *   - **多登记**（名字已改名 / 已删除，名单还留着）→ 名单静默变成死配置，
 *     下次有人「按名单照抄」时会以为这个名字是合法的。
 *
 * 因此本测试断言**双向相等**：4 个 `.tsx` 里真实存在的「非组件导出」集合
 * === `allowExportNames` 名单集合。反向验证：删掉名单里任意一条 → 测试失败；
 * 故意多写一个不存在的名字 → 测试同样失败。
 *
 * 判定「非组件」的规则与 ESLint 的 `only-export-components` 一致：**首字母小写**的
 * 具名导出（`useI18n` / `resolveLang` / `apiLogKindLabel` …）；首字母大写的（`Board` /
 * `I18nProvider`）按组件处理，规则不告警，故不进名单。
 */
import { describe, expect, it } from 'vitest';

import aboutRaw from './components/AboutPanel.tsx?raw';
import boardRaw from './components/Board.tsx?raw';
import i18nRaw from './i18n/index.tsx?raw';
import syncLogsRaw from './components/SyncLogsPanel.tsx?raw';
import eslintRaw from '../eslint.config.js?raw';
import pkgRaw from '../package.json?raw';

/** 取一个文件里「首字母小写」的具名导出（函数 / 变量），即规则会告警的那些。 */
function nonComponentExports(raw: string): string[] {
  const names = [
    ...raw.matchAll(/export\s+(?:default\s+)?(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/g),
  ].map((m) => m[1]);
  return names.filter((n) => !/^[A-Z]/.test(n));
}

/** 从 eslint.config.js 里解析 `allowExportNames: [...]` 的条目。 */
function allowExportNames(raw: string): string[] {
  const block = raw.match(/allowExportNames:\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error('eslint.config.js 里找不到 allowExportNames 数组');
  return [...block[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

const sources: [string, string][] = [
  ['AboutPanel.tsx', aboutRaw],
  ['Board.tsx', boardRaw],
  ['SyncLogsPanel.tsx', syncLogsRaw],
  ['i18n/index.tsx', i18nRaw],
];

describe('ESLint allowExportNames 与真实导出一致（#330）', () => {
  const actual = sources.flatMap(([, raw]) => nonComponentExports(raw));
  const listed = allowExportNames(eslintRaw);

  it('四个文件里确实存在非组件导出（否则本条测试失去意义）', () => {
    expect(actual.length).toBeGreaterThan(0);
  });

  it('名单漏登记 → 会被 lint 拦下，这里先确认无遗漏', () => {
    const missing = actual.filter((n) => !listed.includes(n));
    expect(missing, `以下非组件导出未登记进 allowExportNames: ${missing.join(', ')}`).toEqual([]);
  });

  it('名单里没有多余 / 失效的名字（防死配置）', () => {
    const stale = listed.filter((n) => !actual.includes(n));
    expect(
      stale,
      `allowExportNames 中以下名字已不存在（改名或删除后未清理）: ${stale.join(', ')}`,
    ).toEqual([]);
  });

  it('名单为 16 条（与 #330 收敛的存量告警数一致）', () => {
    expect(listed.length).toBe(16);
  });
});

describe('ESLint 告警阈值（#330）', () => {
  it('lint 脚本使用 --max-warnings 0（不再靠接近饱和的余量当门禁）', () => {
    const pkg = JSON.parse(pkgRaw) as { scripts: Record<string, string> };
    expect(pkg.scripts.lint).toContain('--max-warnings 0');
    expect(pkg.scripts.lint).not.toContain('--max-warnings 20');
  });
});
