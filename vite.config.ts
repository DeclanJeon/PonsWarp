import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react()
      ],
      define: {
        'process.env.API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
        // ✅ process 및 global 정의
        'process.env': {},
        'global': 'globalThis',
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
          // ✅ Node.js 모듈 polyfill
          'stream': 'stream-browserify',
          'buffer': 'buffer',
          'util': 'util',
          'process': 'process/browser',
        }
      },
      worker: {
        format: 'es'
      },
      optimizeDeps: {
        esbuildOptions: {
          // ✅ Node.js global polyfill
          define: {
            global: 'globalThis'
          },
          plugins: [
            NodeGlobalsPolyfillPlugin({
              process: true,
              buffer: true
            }),
            NodeModulesPolyfillPlugin()
          ]
        }
      }
    };
});
