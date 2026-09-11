import { defineConfig } from 'vite'

// GitHub Pages serves this repo at /Q-A/. Local dev stays at /.
export default defineConfig(({ command }) => ({
  base: command === 'build' ? '/Q-A/' : '/',
  build: { target: 'es2022' },
}))
