import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import electronPlugin from 'vite-plugin-electron';

export default defineConfig({
  base: './',
  plugins: [
    react(),
    electronPlugin([
      {
        entry: 'electron/main.ts',
        onstart: (options: any) => {
          options.startup();
        },
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      {
        entry: 'electron/preload.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
    ]),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@components': path.resolve(__dirname, 'src/components'),
      '@hooks': path.resolve(__dirname, 'src/hooks'),
      '@stores': path.resolve(__dirname, 'src/stores'),
      '@utils': path.resolve(__dirname, 'src/utils'),
      '@styles': path.resolve(__dirname, 'src/styles'),
      '@types': path.resolve(__dirname, 'src/types'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    /*
     * Files that live in the project folder but are never part of the module
     * graph. Vite's watcher reloads every connected page when one changes, and
     * `dev.log` is written continuously by the dev server itself — so leaving it
     * watched means the app full-reloads under anyone who is mid-test, wiping the
     * playing track, the open panel and the scanned library. That has now cost a
     * debugging session twice, once via `.shots/` and once here, and both times it
     * read as "the fix didn't work" rather than as the harness.
     */
    watch: {
      ignored: [
        '**/dev.log',
        '**/*.tsbuildinfo',
        '**/.shots/**',
        '**/.tmp/**',
        '**/.refs/**',
        '**/MusicTree.txt',
        '**/tomakezip*',
        '**/typecheck_out.txt',
        '**/connected-components',
        '**/x.png',
      ],
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  css: {
    postcss: './postcss.config.js',
  },
});