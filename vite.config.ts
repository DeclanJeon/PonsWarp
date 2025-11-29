import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    const isProduction = mode === 'production';
    
    return {
      root: path.resolve(__dirname, '.'),
      publicDir: 'public',
      build: {
        rollupOptions: {
          input: path.resolve(__dirname, 'index.html')
        }
      },
      server: {
        port: 3500,
        host: '0.0.0.0',
        headers: {
          // SharedArrayBuffer 사용을 위한 헤더 (WASM 멀티스레딩 대비)
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
        },
        fs: {
          allow: ['..']
        }
      },
      plugins: [
        react({
          jsxImportSource: 'react',
          jsxRuntime: 'automatic'
        }),
        wasm(), // 🚀 WASM 플러그인 추가
        topLevelAwait() // 🚀 WASM 비동기 로딩 지원
      ],

      define: {
        'process.env.SIGNALING_SERVER_URL': JSON.stringify(env.SIGNALING_SERVER_URL),
        'process.env': {},
        'global': 'globalThis',
        'import.meta.env.DEV': mode === 'development',
        'import.meta.env.PROD': isProduction,
      },
      esbuild: {
        drop: isProduction ? ['console', 'debugger'] : [],
      },
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
          'stream': 'stream-browserify',
          'buffer': 'buffer',
          'util': 'util',
          'process': 'process/browser',
          'three': 'three',
        }
      },
      worker: {
        format: 'es',
        plugins: () => [wasm(), topLevelAwait()] // 워커 내부에서도 WASM 사용 가능하도록 설정
      },
      optimizeDeps: {
        exclude: ['ponswarp-wasm'], // 🚀 WASM 패키지는 최적화 제외
        include: ['three', '@react-three/fiber', '@react-three/drei', 'lucide-react'],
        esbuildOptions: {
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
      },
    };
});
