import { defineConfig } from 'vitest/config'

// Vitest config kept separate from vite.config.js so the production build is
// unaffected. esbuild is told to use React's AUTOMATIC JSX runtime so .jsx
// files need no `import React` (matching the app's build via
// @vitejs/plugin-react). jsdom gives component tests a DOM; setup wires
// jest-dom matchers.
export default defineConfig({
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'react',
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    include: ['src/**/*.test.{js,jsx}'],
  },
})
