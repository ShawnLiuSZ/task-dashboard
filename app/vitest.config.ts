import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
    // 默认 `css: false` 会把 CSS 模块打桩成空串，`styles.css?raw` 拿不到内容。
    // src/styles.test.ts 的表格布局回归断言需要读取真实 CSS 文本，故开启 CSS 处理。
    css: true,
  },
});
