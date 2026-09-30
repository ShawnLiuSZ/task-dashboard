import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-hooks/set-state-in-effect': 'off',
      // #330：`only-export-components` 是**开发体验**规则（HMR 边界），本仓库有 16 处
      // 刻意违反 —— 那些纯函数与组件同文件导出，方便前端单测直接 import
      // （`Board.extractUnmappedStatuses` / `SyncLogsPanel.apiLogKindLabel` /
      // `i18n.resolveLang` 等，见 `src/*.test.ts`）。
      //
      // 原配置把它们放行成 16 条 warning，而 `--max-warnings 20` 只留 2 条余量：
      // 一个无关的 `any` 就会让 CI 变红，门禁形同「不许再写第 3 条 warning」，
      // 与真实缺陷无关。这里改为**逐名登记**已知导出 —— 存量归零，而任何**新增**的
      // 非组件导出仍会告警（配合 `--max-warnings 0` 直接挡住 CI）。
      //
      // 若确实需要新增，请二选一：① 把该导出挪进独立的 `.ts` 模块（首选，顺带免掉
      // React 依赖）；② 在下方名单里显式登记并说明理由。
      'react-refresh/only-export-components': [
        'warn',
        {
          allowConstantExport: true,
          allowExportNames: [
            // components/AboutPanel.tsx —— MCP 配置片段生成（被 AboutPanel 与测试共用）
            'getMcpCommand',
            'buildMcpSnippet',
            // components/Board.tsx —— 看板分组 / 视图解析（纯函数，Board.test 直接单测）
            'extractUnmappedStatuses',
            'resolveBoardView',
            'groupTasksByCustomColumns',
            // components/SyncLogsPanel.tsx —— 日志字段渲染与筛选（纯函数）
            'syncLogErrorText',
            'toggleExpanded',
            'accountLabelForLog',
            'apiLogKindLabel',
            'filterApiLogs',
            'apiLogParamText',
            'apiLogHasDetail',
            // i18n/index.tsx —— 语言解析与取词 hook（Provider 与 hook 必须同文件）
            'resolveLang',
            'useI18n',
            'useT',
            'fmtTime',
          ],
        },
      ],
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    ignores: ['dist/', 'node_modules/', 'src-tauri/target/', 'scripts/'],
  },
);
