// Vite config for the browser host. The 5velte-ps2 package ships raw
// TypeScript source, so it's excluded from dep pre-bundling and Phaser is
// deduped to a single copy (same treatment the framework's own demo uses).

import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'

export default defineConfig(({ mode }) => {
  const isProduction = mode === 'production'

  return {
    // GitHub Pages serves this at /ps2-ryu/, but the build is also
    // vendored into other hosts (the cmg launcher mounts it under
    // /games/ps2-ryu/), so allow the mount point to be overridden.
    base: process.env.BASE_PATH || (isProduction ? '/ps2-ryu/' : '/'),
    // honour an assigned dev port (tooling sets PORT to run parallel servers)
    server: { port: Number(process.env.PORT) || 5173 },
    resolve: { dedupe: ['phaser'] },
    optimizeDeps: { exclude: ['5velte-ps2'] },
    build: {
      rollupOptions: {
        // index.html is the Xbox-green download page; play/ is the game
        input: {
          main: fileURLToPath(new URL('./index.html', import.meta.url)),
          play: fileURLToPath(new URL('./play/index.html', import.meta.url)),
        },
        output: {
          manualChunks: { phaser: ['phaser'] },
        },
      },
    },
  }
})
