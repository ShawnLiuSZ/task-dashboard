#!/usr/bin/env node
/**
 * i18n 一致性校验（Issue #7；#330 起支持任意语种数量）：
 * 1. 动态发现 `src/i18n/locales/*.json`（不再硬编码 zh-CN / en-US 两份）；
 * 2. 其余语种的 key 集合必须与基准语种（zh-CN）完全一致（多出/缺失都报错）；
 * 3. 每条翻译的 {placeholder} 占位符必须一一对应；
 * 4. 不得出现空翻译。
 *
 * 用法：`node app/scripts/check-i18n.mjs` 或 `npm run i18n:check`（在前端目录或仓库根均可）
 *
 * 对比逻辑抽在 `./i18n-lib.mjs`（纯函数，有单测），本文件只负责读盘与退出码。
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BASE_LOCALE, compareLocales, localeIds } from "./i18n-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = resolve(here, "../src/i18n/locales");

const ids = localeIds(readdirSync(localesDir));
if (ids.length === 0) {
  console.error(`✗ ${localesDir} 下没有任何 locale JSON 文件`);
  process.exit(1);
}
if (!ids.includes(BASE_LOCALE)) {
  console.error(`✗ 找不到基准语种 ${BASE_LOCALE}（locales 目录下现有：${ids.join(", ")}）`);
  process.exit(1);
}

/** @type {Record<string, Record<string, string>>} */
const dicts = {};
for (const id of ids) {
  const path = resolve(localesDir, `${id}.json`);
  try {
    dicts[id] = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    console.error(`✗ ${id} 解析失败: ${path}\n  ${e.message}`);
    process.exit(1);
  }
}

const errors = compareLocales(dicts, BASE_LOCALE);

if (errors.length) {
  console.error(`✗ i18n 校验失败（${errors.length} 项）：`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

const keyCount = Object.keys(dicts[BASE_LOCALE]).length;
const compared = ids.filter((id) => id !== BASE_LOCALE);
console.log(
  `✓ i18n 校验通过：基准 ${BASE_LOCALE} ${keyCount} 个 key，` +
    `${compared.join(" / ")} 与之一致（占位符一致，无空翻译）。`,
);
