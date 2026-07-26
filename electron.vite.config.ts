import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      extensions: ['.ts', '.js', '.mjs', '.json']
    },
    build: {
      rollupOptions: {
        external: ['electron', /^electron\/.+/, '@lore-vcs/sdk', /^@lore-vcs\/sdk\/.+/, 'koffi'],
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        },
        output: {
          format: 'es'
        }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      extensions: ['.ts', '.js', '.mjs', '.json']
    },
    build: {
      rollupOptions: {
        external: ['electron', /^electron\/.+/],
        input: {
          preload: resolve(__dirname, 'src/main/preload.ts')
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].js'
        }
      }
    }
  },
  renderer: {
    root: '.',
    publicDir: 'assets',
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'index.html')
        }
      }
    },
    plugins: [react()]
  }
});