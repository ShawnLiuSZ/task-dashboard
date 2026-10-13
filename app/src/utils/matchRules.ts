/**
 * 自定义列匹配规则（`AccountColumn.matchRules` 列）的解析。
 *
 * `matchRules` 是 JSON 数组字符串，如 `["待开发","需求","规划"]`，元素为 GitHub
 * Project Status 原文。解析为去重后的值集合，供看板自定义列分组使用。
 *
 * 兼容旧数据：非合法 JSON 或非数组时，按逗号分隔（中英文逗号）降级解析。
 *
 * 抽为共享模块（而非在组件内各写一份）——`SettingsPanel` 与 `Board` 的
 * `groupTasksByCustomColumns` 都要用，避免两侧漂移（#438）。
 */
export function parseMatchRules(matchRules: string): string[] {
  try {
    const arr = JSON.parse(matchRules);
    if (Array.isArray(arr)) {
      return [
        ...new Set(
          arr
            .filter((s): s is string => typeof s === 'string')
            .map((s) => s.trim())
            .filter((s) => s.length > 0),
        ),
      ];
    }
  } catch {
    // 兼容旧数据：逗号分隔
  }
  return [
    ...new Set(
      matchRules
        .split(/[,，]/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ];
}
