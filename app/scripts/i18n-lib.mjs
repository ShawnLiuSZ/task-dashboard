/**
 * i18n 校验的**纯逻辑**（#330）。
 *
 * 抽出来的理由：`check-i18n.mjs` 的主要缺陷（#330）是**硬编码了 zh-CN / en-US 两个语种**
 * —— `README.md` 明确宣传「复制 `en-US.json` 为新语言文件（如 `ja-JP.json`）」，
 * 而 checker 写死两份文件 ⇒ 新增语种漏检，脚本却照样「通过」，给出虚假安全感。
 *
 * 修法是动态发现 `locales/*.json` 并逐一与基准语种比对。为了让这条逻辑能被单测覆盖
 * （而不是只能靠「跑一次 CLI 看输出」），把它与 fs / process 分开放在本模块：
 * `check-i18n.mjs` 只负责读盘与退出码，本模块只做纯计算。
 *
 * 注意：本文件刻意是 `.mjs`，供 Node CLI 与 vitest 同时直接加载（无需编译）。
 * `tsconfig.json` 的 `allowJs` 让 TS 能解析该导入（`checkJs` 关闭，不做类型检查）。
 */

/** 基准语种：其余语种都以它的 key 集合与占位符为准。 */
export const BASE_LOCALE = "zh-CN";

/** 从目录项里筛出 locale id（去掉 `.json`），排序保证输出稳定。 */
export function localeIds(names) {
  return names
    .filter((n) => typeof n === "string" && n.endsWith(".json"))
    .map((n) => n.slice(0, -".json".length))
    .sort();
}

/** 取一条翻译里的 `{placeholder}` 名字，排序后用于比对。 */
export function placeholders(value) {
  return [...String(value).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

/**
 * 把每个语种与基准语种逐一比对，返回错误清单（空数组 = 通过）。
 *
 * @param {Record<string, Record<string, string>>} dicts 语种 id → 翻译表
 * @param {string} base 基准语种 id
 * @returns {string[]}
 */
export function compareLocales(dicts, base = BASE_LOCALE) {
  /** @type {string[]} */
  const errors = [];
  const baseDict = dicts[base];
  if (!baseDict) {
    errors.push(`基准语种 ${base} 缺失`);
    return errors;
  }

  const baseKeys = new Set(Object.keys(baseDict));
  const others = Object.keys(dicts).filter((lang) => lang !== base);
  if (others.length === 0) {
    errors.push(`除基准语种 ${base} 外没有任何其它语种，校验失去意义`);
    return errors;
  }

  for (const lang of others) {
    const dict = dicts[lang];
    const keys = new Set(Object.keys(dict));

    // 1. key 集合一致
    for (const k of baseKeys) if (!keys.has(k)) errors.push(`${lang} 缺失 key: ${k}`);
    for (const k of keys) if (!baseKeys.has(k)) errors.push(`${base} 缺失 key: ${k}`);

    // 2. 占位符一致 + 3. 空翻译
    for (const k of baseKeys) {
      if (!keys.has(k)) continue;
      const a = placeholders(baseDict[k]);
      const b = placeholders(dict[k]);
      if (JSON.stringify(a) !== JSON.stringify(b)) {
        errors.push(`占位符不一致: ${k}  ${base}=[${a}] ${lang}=[${b}]`);
      }
      if (!String(baseDict[k]).trim()) errors.push(`存在空翻译: ${k}（${base}）`);
      if (!String(dict[k]).trim()) errors.push(`存在空翻译: ${k}（${lang}）`);
    }
  }

  return errors;
}
