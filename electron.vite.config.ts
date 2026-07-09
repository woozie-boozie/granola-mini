import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: {
    // Keep node deps (e.g. @deepgram/sdk → ws → bufferutil) out of the bundle so
    // their runtime require() of optional native modules resolves from node_modules.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } },
      outDir: 'out/main'
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/preload/index.ts') } },
      outDir: 'out/preload'
    }
  },
  renderer: {
    root: 'src/renderer',
    build: {
      rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } },
      outDir: 'out/renderer'
    },
    plugins: [react()]
  }
})
