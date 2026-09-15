#!/bin/bash
set -euo pipefail

 echo "Building pons-core-wasm..."

SIMD_FLAGS=""
FEATURES=""
if [ "${ENABLE_SIMD:-}" = "1" ]; then
    echo "SIMD mode enabled"
    SIMD_FLAGS="-C target-feature=+simd128"
    FEATURES="--features simd"
fi

# Never allow a previous build to satisfy verification after a failed build.
rm -rf pkg
mkdir -p pkg
RUSTFLAGS="$SIMD_FLAGS" wasm-pack build --target web --release --out-dir pkg $FEATURES

if command -v wasm-opt >/dev/null 2>&1; then
    wasm-opt pkg/pons_core_wasm_bg.wasm -O4 --strip-debug --strip-producers --strip-target-features -o pkg/pons_core_wasm_bg.wasm
fi

node scripts/verify-package.mjs

echo "Build complete: pkg/"
if [ "${ENABLE_SIMD:-}" = "1" ]; then
    echo "SIMD optimizations enabled"
fi
