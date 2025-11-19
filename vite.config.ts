import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      server: {
        port: 3500,
        host: '127.0.0.1',
      },
      plugins: [
        react()
      ],
      define: {
        'process.env.SIGNALING_SERVER_URL': JSON.stringify(env.SIGNALING_SERVER_URL),
        // ✅ process 및 global 정의
        'process.env': {},
        'global': 'globalThis',
        // ✅ Vite 환경 변수 정의
        'import.meta.env.DEV': mode === 'development',
        'import.meta.env.PROD': mode === 'production',
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
