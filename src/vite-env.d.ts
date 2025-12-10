/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SIGNALING_SERVER_URL: string;
  readonly VITE_USE_RUST_SIGNALING: string;
  readonly VITE_RUST_SIGNALING_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
