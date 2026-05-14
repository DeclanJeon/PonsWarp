import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const isProduction = mode === 'production';
  const crossOriginIsolationHeaders = {
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
  };

  return {
    root: path.resolve(__dirname, '.'),
    publicDir: 'public',
    build: {
      rollupOptions: {
        input: path.resolve(__dirname, 'index.html'),
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return undefined;

            if (
              id.includes('/react/') ||
              id.includes('/react-dom/') ||
              id.includes('/zustand/')
            ) {
              return 'react-vendor';
            }

            if (
              id.includes('/three/') ||
              id.includes('/@react-three/') ||
              id.includes('/three-stdlib/') ||
              id.includes('/@monogrid/') ||
              id.includes('/postprocessing/')
            ) {
              return 'three-vendor';
            }

            if (id.includes('/framer-motion/')) {
              return 'motion-vendor';
            }

            if (
              id.includes('/simple-peer/') ||
              id.includes('/socket.io-client/')
            ) {
              return 'transport-vendor';
            }

            if (
              id.includes('/lucide-react/') ||
              id.includes('/qrcode.react/')
            ) {
              return 'ui-vendor';
            }

            return 'vendor';
          },
        },
      },
    },
    server: {
      port: 3500,
      host: '0.0.0.0',
      fs: {
        allow: ['..'],
      },
      headers: crossOriginIsolationHeaders,
    },
    preview: {
      headers: crossOriginIsolationHeaders,
    },
    assetsInclude: ['**/*.wasm'],
    plugins: [
      react({
        jsxImportSource: 'react',
        jsxRuntime: 'automatic',
      }),
      {
        name: 'wasm-content-type',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.endsWith('.wasm')) {
              res.setHeader('Content-Type', 'application/wasm');
            }
            next();
          });
        },
        configurePreviewServer(server) {
          server.middlewares.use((req, res, next) => {
            if (req.url?.endsWith('.wasm')) {
              res.setHeader('Content-Type', 'application/wasm');
            }
            next();
          });
        },
      },
    ],

    define: {
      'process.env.SIGNALING_SERVER_URL': JSON.stringify(
        env.SIGNALING_SERVER_URL
      ),
      'process.env': {},
      global: 'globalThis',
      'import.meta.env.DEV': mode === 'development',
      'import.meta.env.PROD': isProduction,
    },
    esbuild: {
      drop: isProduction ? ['console', 'debugger'] : [],
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
        stream: 'stream-browserify',
        buffer: 'buffer',
        util: 'util',
        process: 'process/browser',
        three: 'three',
      },
    },
    worker: {
      format: 'es',
      plugins: () => [
        {
          name: 'wasm-worker-loader',
          resolveId(id) {
            if (id.endsWith('.wasm')) {
              return { id, external: false };
            }
          },
          load(id) {
            if (id.endsWith('.wasm')) {
              return null;
            }
          },
        },
      ],
    },
    optimizeDeps: {
      include: [
        'three',
        '@react-three/fiber',
        '@react-three/drei',
        'lucide-react',
      ],
      exclude: ['pons-core-wasm'],
      esbuildOptions: {
        define: {
          global: 'globalThis',
        },
        plugins: [
          NodeGlobalsPolyfillPlugin({
            process: true,
            buffer: true,
          }),
          NodeModulesPolyfillPlugin(),
        ],
      },
    },
  };
});
