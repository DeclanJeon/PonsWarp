# 🌌 PonsWarp

> **File Transfer at Warp Speed. Zero Limits.** > Transfer 100GB+ files directly between browsers. No servers, no storage caps, no RAM limits. Powered by Rust(WASM) & WebRTC.

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![React](https://img.shields.io/badge/React-19-blue)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P-green)
![WASM](https://img.shields.io/badge/WASM-Powered-orange)

![PonsWarp Demo](https://media3.giphy.com/media/v1.Y2lkPTc5MGI3NjExanc5ZDBwMm1tNG1lMHUzanQwM2h4bGd4MTJjZzZoM3YwMmdmYXpuaCZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/8xorKjfKhatiFvjxgS/giphy.gif)

## ❓ Why PonsWarp?

Most web-based file transfer tools have a fatal flaw: **They crash your browser when handling large files.** They try to load the entire file into memory (RAM) before saving, limiting you to a few gigabytes at best.

**PonsWarp is different.**

We bypass the browser's memory limits entirely by leveraging **StreamSaver.js** and **Rust (WASM)**. Data flows like water through a pipe—from the sender's disk, encrypted in transit, directly to the receiver's disk.

| Feature | 🌌 PonsWarp | ☁️ Traditional Cloud (WeTransfer/Google Drive) | 🕸️ Standard P2P Tools |
| :--- | :--- | :--- | :--- |
| **File Size Limit** | **Unlimited** (1TB+ Tested) | 2GB - 15GB Caps | Browser Crash ~2GB |
| **Storage** | **Direct Disk-to-Disk** | Stored on Server | RAM / Blob Storage |
| **Privacy** | **E2E Encrypted (WASM)** | Accessible by Provider | Varies |
| **Speed** | **Local Network / P2P Speed** | Upload + Download Time | P2P Speed |

## 🚀 Key Features

* **⚡ Hyper-Fast P2P Transfer:** Direct connection via WebRTC (UDP/SCTP). If you are on the same network (LAN), it transfers at gigabit speeds.
* **💾 Unlimited File Size:** Streams data directly to the file system. Transfer a 100GB 4K video file without spiking your RAM.
* **🔐 End-to-End Encryption:** Powered by **Rust (WebAssembly)**. AES-256-GCM encryption ensures your data is unreadable to anyone else—even us.
* **📂 Drag & Drop Folders:** Send entire directory structures. Files are streamed and preserved perfectly.
* **🧠 Smart Congestion Control:** Custom backpressure algorithm with RTT-based AIMD congestion control preventing packet loss on unstable networks.
* **🎨 Sci-Fi UI:** An immersive, hardware-accelerated 3D space environment.

## 🏗️ Architecture

PonsWarp uses a sophisticated pipeline to ensure stability and speed.

```mermaid
graph LR
    A[Sender Disk] -->|Read Stream| B(Worker Thread)
    B -->|Encrypt (WASM)| C{WebRTC Channel}
    C -->|P2P Transfer| D{Receiver Browser}
    D -->|Decrypt (WASM)| E(StreamSaver / FSA)
    E -->|Write Stream| F[Receiver Disk]
    
    style A fill:#f9f,stroke:#333,stroke-width:2px
    style F fill:#f9f,stroke:#333,stroke-width:2px
    style B fill:#bbf,stroke:#333
    style E fill:#bbf,stroke:#333
````

### Core Components

1.  **SwarmManager:** Orchestrates 1:N peer connections (Send to multiple people at once).
2.  **WASM Core:** High-performance Rust module handling CRC32 verification and AES-256-GCM encryption.
3.  **DirectFileWriter:** Intelligently switches between `StreamSaver.js` (Serverless MITM) and the `File System Access API` to bypass browser sandbox limitations.

## 🛠️ Tech Stack

  * **Frontend:** React 19, TypeScript 5.9, Vite 7
  * **Core Logic:** **Rust (WebAssembly)**
  * **P2P Networking:** WebRTC (simple-peer), Socket.io (Signaling)
  * **Storage:** StreamSaver.js, File System Access API
  * **Compression:** fflate (Streaming ZIP generation)
  * **Visuals:** Three.js, React Three Fiber, Tailwind CSS 4

## 📦 Installation & Development

### Prerequisites

  * Node.js v20+
  * pnpm v8+
  * Rust (for building WASM core, optional if using pre-built binaries)

### Quick Start

```bash
# 1. Clone repository
git clone [https://github.com/pons-dev/ponswarp.git](https://github.com/pons-dev/ponswarp.git)
cd ponswarp

# 2. Install dependencies
pnpm install

# 3. Start development server
pnpm dev
```

Create a `.env` file in the root directory:

```env
SIGNALING_SERVER_URL=ws://localhost:5501
```

## 🌐 Browser Compatibility

| Browser | Status | Notes |
| :--- | :---: | :--- |
| **Chrome / Edge** | ✅ **Best** | Full support for File System Access API & StreamSaver. |
| **Firefox** | ⚠️ Good | Uses StreamSaver fallback. Large file support is good. |
| **Safari** | ⚠️ Limited | Basic P2P works, but file system APIs are restrictive. |

## 🤝 Contributing

We love open source\! We are looking for beta testers and contributors to help with:

  * Improving NAT traversal (TURN server configurations).
  * Mobile UI responsiveness optimizations.
  * Testing on various network conditions.

<!-- end list -->

1.  Fork the Project
2.  Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3.  Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4.  Push to the Branch (`git push origin feature/AmazingFeature`)
5.  Open a Pull Request

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.

## 🙏 Acknowledgments

  * [WebRTC](https://webrtc.org/) - The backbone of P2P.
  * [StreamSaver.js](https://www.google.com/search?q=https://github.com/jimmywarting/StreamSaver.js) - The magic behind saving large files.
  * [Rust & wasm-bindgen](https://rustwasm.github.io/) - For blazing fast crypto.

-----

\<div align="center"\>
\<p\>Made with ❤️ by the PonsWarp Team\</p\>
\<p\>
\<a href="https://warp.ponslink.online"\>\<strong\>Try Live Demo\</strong\>\</a\>
\</p\>
\</div\>