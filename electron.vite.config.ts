import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

/** file:// loads fail for module scripts with crossorigin in packaged Electron */
function stripCrossoriginFromHtml(): Plugin {
  return {
    name: 'strip-crossorigin-html',
    transformIndexHtml(html) {
      return html.replace(/\s+crossorigin(?:="[^"]*"|="anonymous"|="use-credentials"|)/g, '')
    }
  }
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    base: './',
    build: {
      // Avoid crossorigin/modulepreload on file:// — otherwise packaged builds can show a blank window
      modulePreload: false,
      rollupOptions: {
        input: {
          control: resolve(__dirname, 'src/renderer/control/index.html')
        }
      }
    },
    plugins: [react(), stripCrossoriginFromHtml()]
  }
})
