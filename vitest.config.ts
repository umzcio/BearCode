import { defineConfig } from 'vitest/config'
import { resolve } from 'path'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@renderer': resolve('src/renderer/src'),
      '@shared': resolve('src/shared')
    }
  },
  test: {
    // .test.tsx opts into jsdom per-file via a `// @vitest-environment jsdom`
    // docblock; everything else stays on node (below).
    include: ['src/**/*.test.{ts,tsx}'],
    environment: 'node'
  }
})
