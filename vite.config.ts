import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Vite 配置。
 * 说明：
 * - 路由使用 HashRouter（见架构 Q-A 的降级结论），因此构建产物可直接静态托管，刷新不会 404。
 * - vitest 配置并入此处：默认 node 环境（core 纯逻辑），需要 DOM 的用例用
 *   `// @vitest-environment jsdom` 文件头单独声明（例如 io 的 MusicXML 解析）。
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    reporters: 'default',
  },
});
