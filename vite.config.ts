import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { NodeGlobalsPolyfillPlugin } from '@esbuild-plugins/node-globals-polyfill';
import { NodeModulesPolyfillPlugin } from '@esbuild-plugins/node-modules-polyfill';

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
        fs: {
          allow: ['..']
        }
      },
      plugins: [
        react({
          jsxImportSource: 'react',
          jsxRuntime: 'automatic'
        })
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
        format: 'es'
      },
      optimizeDeps: {
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
