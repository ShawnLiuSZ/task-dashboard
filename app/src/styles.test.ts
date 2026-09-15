import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 同步日志面板的横向滚动回归测试。
 *
 * 背景：表格最小内容宽度会超过弹窗内宽（`.sync-logs-modal` 固定 720px，内容区 680px；
 * 目标列最长 320px，且表头与多数单元格 `white-space: nowrap`）。此前
 * `.sync-logs-table-wrap` 用的是 `overflow: hidden`，溢出部分被**静默裁掉**——
 * 右侧「明细 / 错误」列看不见，也没有任何滚动条，用户无法察觉内容缺失。
 *
 * 该缺陷是纯 CSS 表现问题，vitest 跑在 node 环境（无 DOM、无布局引擎），
 * 无法用渲染断言覆盖，因此改为对源码做静态断言——与仓库既有的
 * `scripts/check-mcp-columns.py` / `scripts/check-doc-links.py` 同一思路。
 */

const here = dirname(fileURLToPath(import.meta.url));
// 剥离注释：断言只针对声明本身，避免注释里提到写法（如「原先用 overflow: hidden」）就被命中。
const styles = readFileSync(resolve(here, "styles.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const panel = readFileSync(resolve(here, "components/SyncLogsPanel.tsx"), "utf8");

/** 取出某选择器的全部声明块（同一选择器可能出现在分组合并规则中，故返回数组）。 */
function decls(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?:^|[},])\\s*${escaped}\\s*\\{([^}]*)\\}`, "gm");
  const hits = [...styles.matchAll(re)].map((m) => m[1]);
  expect(hits.length, `styles.css 中找不到规则 ${selector}`).toBeGreaterThan(0);
  return hits.join("\n");
}

describe("同步日志表格横向滚动", () => {
  it("表格容器不得用 overflow: hidden —— 否则溢出列被裁且不产生滚动条", () => {
    const d = decls(".sync-logs-table-wrap");
    expect(d).not.toMatch(/overflow\s*:\s*hidden/);
    expect(d).toMatch(/overflow\s*:\s*auto/);
  });

  it("容器成为受约束的滚动区：flex 列 + min-height: 0", () => {
    // 两者缺一不可：没有 min-height: 0，flex 项的 auto 最小高度会阻止收缩，
    // 容器被表格撑到完整高度，横向滚动条就会落到可视区之外（需先纵向滚到底）。
    expect(decls(".sync-logs-table-wrap")).toMatch(/min-height\s*:\s*0/);
    const body = decls(".sync-logs-body");
    expect(body).toMatch(/display\s*:\s*flex/);
    expect(body).toMatch(/flex-direction\s*:\s*column/);
  });

  it("筛选行不参与收缩，避免被表格挤扁", () => {
    expect(decls(".sync-logs-filter")).toMatch(/flex-shrink\s*:\s*0/);
  });

  it("「同步记录」与「API 明细」共用同一容器 ⇒ 该修复须同时覆盖两个页签", () => {
    expect(panel.match(/sync-logs-table-wrap/g) ?? []).toHaveLength(2);
  });
});
