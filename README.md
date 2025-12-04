# 🌌 PonsWarp

> **File Transfer at Warp Speed.** > High-performance, serverless P2P file sharing directly in your browser.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![React](https://img.shields.io/badge/React-19-blue)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P-green)
![WASM](https://img.shields.io/badge/WASM-Powered-orange)

**PonsWarp** is a next-generation file transfer tool designed to overcome the limitations of traditional web-based sharing. By leveraging **WebRTC** for peer-to-peer connections and **StreamSaver.js / File System Access API** for direct disk streaming, PonsWarp allows you to transfer files of **unlimited size** (10GB, 100GB, 1TB+) without crashing your browser's memory.

## 🚀 Key Features

- **⚡ Hyper-Fast P2P Transfer:** Direct browser-to-browser connection using WebRTC (UDP/SCTP). No intermediate servers store your data.
- **🔐 End-to-End Encryption:** Powered by **WASM (Rust)**. All data is encrypted with AES-256-GCM using ECDH key exchange before leaving your device.
- **🧠 Smart Congestion Control:** Custom **Backpressure** algorithm with RTT-based AIMD congestion control for maximum speed without packet loss.
- **💾 Unlimited File Size:** Streams data directly to disk using **StreamSaver.js** or the **File System Access API**, completely bypassing RAM limitations.
- **📂 Folder & Multi-File Support:** Drag and drop entire folder structures. Files are streamed as a ZIP archive or individual files depending on the context.
- **👥 Multi-Receiver (1:N):** Send files to up to 3 receivers simultaneously with intelligent queue management.
- **🛡️ Data Integrity:** CRC32 checksum verification on every chunk ensures 100% data integrity.
- **🎨 Sci-Fi UI:** Fully immersive, hardware-accelerated 3D background with futuristic interface.

## 🏗️ Architecture

```

┌─────────────────────────────────────────────────────────────────────────┐
│                              PonsWarp System                            │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────┐         ┌─────────────────────┐               │
│  │   Sender Browser    │         │  Receiver Browser   │               │
│  │                     │         │                     │               │
│  │  ┌───────────────┐  │         │  ┌───────────────┐  │               │
│  │  │  SenderView   │  │         │  │ ReceiverView  │  │               │
│  │  └───────┬───────┘  │         │  └───────┬───────┘  │               │
│  │          │          │         │          │          │               │
│  │  ┌───────▼───────┐  │         │  ┌───────▼───────┐  │               │
│  │  │ SwarmManager  │  │◄───────►│  │ReceiverService│  │               │
│  │  │  (1:N Peers)  │  │  WebRTC │  │               │  │               │
│  │  └───────┬───────┘  │  P2P    │  └───────┬───────┘  │               │
│  │          │          │         │          │          │               │
│  │  ┌───────▼───────┐  │         │  ┌───────▼───────┐  │               │
│  │  │ Sender Worker │  │         │  │Receiver Worker│  │               │
│  │  │ (Read/Encrypt)│  │         │  │(Decrypt/Verify)│  │               │
│  │  └───────────────┘  │         │  └───────┬───────┘  │               │
│  └─────────────────────┘         │          ▼          │               │
│              │                   │  ┌───────────────┐  │               │
│              │                   │  │DirectFileWriter│  │               │
│              │                   │  │ (Stream/FSA)  │  │               │
│              │                   │  └───────────────┘  │               │
│              │                   └─────────────────────┘               │
│              │                              │                           │
│              └───►│  Signaling Server   │◄──┘                           │
│                   │  (Socket.io)        │                               │
│                   │  - Room Management  │                               │
│                   │  - SDP/ICE Relay    │                               │
│                   │  - TURN Credentials │                               │
│                   └─────────────────────┘                               │
└─────────────────────────────────────────────────────────────────────────┘

````

### Core Components

| Component | Description |
|-----------|-------------|
| **SwarmManager** | Orchestrates 1:N peer connections with slot management (max 3 peers) |
| **SinglePeerConnection** | Unified WebRTC wrapper with backpressure control and drain events |
| **NetworkAdaptiveController** | RTT-based AIMD congestion control for optimal throughput |
| **DirectFileWriter** | Handles disk writing via **StreamSaver.js** (primary) or **File System Access API** (fallback) |
| **WASM Core** | Rust-based module for high-performance CRC32 verification and AES-256-GCM encryption |

### Data Flow

1. **Connection Setup:** Sender creates room → Receiver joins via room code/QR
2. **Key Exchange:** ECDH key exchange to establish a secure shared secret.
3. **Manifest Exchange:** Sender sends file metadata (names, sizes, checksums)
4. **P2P Transfer:** Encrypted binary chunks flow directly between browsers.
5. **Decryption & Verify:** Receiver Worker decrypts and verifies chunks using WASM.
6. **Streaming Save:** Decrypted data is piped to `DirectFileWriter` for immediate disk storage.

## 🛠️ Tech Stack

### Frontend (ponswarp)

| Category | Technology |
|----------|------------|
| **Framework** | React 19, TypeScript 5.9, Vite 7 |
| **WebRTC** | simple-peer (WebRTC wrapper) |
| **Signaling** | Socket.io-client |
| **Core Logic** | **WebAssembly (Rust)** for Crypto & CRC32 |
| **Storage** | **StreamSaver.js**, **File System Access API** |
| **Compression** | fflate (streaming ZIP) |
| **State** | Zustand |
| **3D Graphics** | Three.js, React Three Fiber |
| **Styling** | Tailwind CSS 4 |

### Backend (ponswarp-signaling)

| Category | Technology |
|----------|------------|
| **Runtime** | Node.js 18+ |
| **Framework** | Express.js |
| **WebSocket** | Socket.io 4.x |
| **TURN** | AWS SDK (S3 integration for credentials) |

## 📦 Installation

### Prerequisites
- Node.js v20+
- pnpm v8+

### Quick Start

```bash
# Clone repository
git clone [https://github.com/pons-dev/ponswarp.git](https://github.com/pons-dev/ponswarp.git)
cd ponswarp

# Install dependencies
pnpm install

# Start development server
pnpm dev
````

### Environment Variables

Create `.env` file in `ponswarp/`:

```bash
SIGNALING_SERVER_URL=ws://localhost:5501
```

## 📁 Project Structure

```
ponswarp/
├── src/
│   ├── components/          # React UI components
│   │   ├── SenderView.tsx       # Sender interface with drag-drop
│   │   ├── ReceiverView.tsx     # Receiver interface with progress
│   │   ├── SpaceField.tsx       # 3D background (Three.js)
│   │   └── ui/                  # Reusable UI components
│   ├── services/            # Core business logic
│   │   ├── swarmManager.ts      # 1:N peer orchestration
│   │   ├── directFileWriter.ts  # StreamSaver & FSA integration
│   │   ├── wasmCore.ts          # Rust WASM wrapper (Crypto/CRC)
│   │   ├── webRTCService.ts     # Receiver-side WebRTC
│   │   └── cryptoService.ts     # E2E Key Exchange
│   ├── workers/             # Web Worker threads
│   │   ├── file-sender.worker.ts   # File reading & Encryption
│   │   └── file-receiver.worker.ts # Decryption & Verification
│   ├── store/               # Zustand state management
│   ├── types/               # TypeScript definitions
│   └── utils/               # Utility functions & constants
├── public/                  # Static assets (mitm.html for StreamSaver)
└── docs/                    # Technical documentation
```

## 🔧 Technical Deep Dive

### Binary Protocol

Each chunk is transmitted with a 22-byte header (Plaintext) or Encrypted Header:

```
┌──────────────────────────────────────────────────────────────┐
│  Offset  │  Size  │  Field       │  Description              │
├──────────┼────────┼──────────────┼───────────────────────────┤
│  0       │  2     │  FileIndex   │  File ID (0xFFFF = EOS)   │
│  2       │  4     │  ChunkIndex  │  Sequence number          │
│  6       │  8     │  Offset      │  Byte offset in file      │
│  14      │  4     │  DataLength  │  Payload size             │
│  18      │  4     │  Checksum    │  CRC32 (or Auth Tag)      │
│  22      │  N     │  Payload     │  (Encrypted) File Data    │
└──────────────────────────────────────────────────────────────┘
```

### Congestion Control

PonsWarp implements a delay-based AIMD (Additive Increase Multiplicative Decrease) algorithm:

```typescript
// Congestion detection based on RTT ratio
if (rttRatio > 2.0 || bufferedAmount > cwnd) {
  cwnd = Math.max(MIN_CWND, cwnd * 0.7);  // Multiplicative Decrease
} else if (rttRatio < 1.2 && bufferedAmount < cwnd * 0.8) {
  cwnd = Math.min(MAX_CWND, cwnd + 64KB);  // Additive Increase
}
```

## 🌐 Browser Compatibility

| Browser | Min Version | WebRTC | StreamSaver | File System API |
|---------|-------------|--------|-------------|-----------------|
| Chrome | 86+ | ✅ | ✅ | ✅ |
| Edge | 86+ | ✅ | ✅ | ✅ |
| Firefox | 113+ | ✅ | ✅ | ❌ |
| Safari | 16.4+ | ✅ | ✅ | ❌ |

> **Note:** Ideally requires a secure context (HTTPS) for `StreamSaver` and `Service Workers`.

## 🐛 Troubleshooting

### Connection Issues

  - **Firewall:** Ensure WebRTC ports are not blocked.
  - **NAT Traversal:** TURN server credentials are automatically fetched.

### Storage Issues

  - **StreamSaver:** Requires third-party cookies enabled in some browsers for the MITM service worker.
  - **Large Files:** Ensure you have enough disk space. RAM is not an issue due to streaming.

## 🤝 Contributing

1.  Fork the repository
2.  Create feature branch: `git checkout -b feature/amazing-feature`
3.  Commit changes: `git commit -m 'feat: add amazing feature'`
4.  Push branch: `git push origin feature/amazing-feature`
5.  Open Pull Request

## 📄 License

MIT License - see [LICENSE](https://www.google.com/search?q=LICENSE) for details.

## 🙏 Acknowledgments

  - [WebRTC](https://webrtc.org/) - P2P communication
  - [StreamSaver.js](https://www.google.com/search?q=https://github.com/jimmywarting/StreamSaver.js) - The magic behind serverless saving
  - [fflate](https://github.com/101arrowz/fflate) - High-performance compression
  - [React Three Fiber](https://github.com/pmndrs/react-three-fiber) - 3D graphics
  - [Vite](https://vitejs.dev/) - Build tooling

-----

**⭐ If you find PonsWarp useful, please star the repository\!**