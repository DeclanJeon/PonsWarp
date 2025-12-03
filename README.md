# 🌌 PonsWarp

> **File Transfer at Warp Speed.**  
> High-performance, serverless P2P file sharing directly in your browser.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue)
![React](https://img.shields.io/badge/React-19-blue)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P-green)

**PonsWarp** is a next-generation file transfer tool designed to overcome the limitations of traditional web-based sharing. By leveraging **WebRTC** for peer-to-peer connections and **Origin Private File System (OPFS)** for disk storage, PonsWarp allows you to transfer files of **unlimited size** (10GB, 100GB, 1TB+) without crashing your browser's memory.

## 🚀 Key Features

- **⚡ Hyper-Fast P2P Transfer:** Direct browser-to-browser connection using WebRTC (UDP/SCTP). No intermediate servers store your data.
- **🧠 Smart Congestion Control:** Custom **Backpressure** algorithm with RTT-based AIMD congestion control for maximum speed without packet loss.
- **💾 Unlimited File Size:** Uses **OPFS** and **Web Workers** to stream data directly to disk, bypassing RAM limitations.
- **📂 Folder & Multi-File Support:** Drag and drop entire folder structures. Receivers can download as a single ZIP stream or individual files.
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
│  │  │ (File Read)   │  │         │  │ (Disk Write)  │  │               │
│  │  └───────────────┘  │         │  └───────────────┘  │               │
│  └─────────────────────┘         └─────────────────────┘               │
│              │                              │                           │
│              │    ┌─────────────────────┐   │                           │
│              └───►│  Signaling Server   │◄──┘                           │
│                   │  (Socket.io)        │                               │
│                   │  - Room Management  │                               │
│                   │  - SDP/ICE Relay    │                               │
│                   │  - TURN Credentials │                               │
│                   └─────────────────────┘                               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Core Components

| Component | Description |
|-----------|-------------|
| **SwarmManager** | Orchestrates 1:N peer connections with slot management (max 3 direct peers) |
| **SinglePeerConnection** | Unified WebRTC wrapper with backpressure control and drain events |
| **NetworkAdaptiveController** | RTT-based AIMD congestion control for optimal throughput |
| **Sender Worker** | Reads files, creates ZIP streams (fflate), manages double-buffering |
| **Receiver Worker** | Validates CRC32 checksums, streams data to DirectFileWriter |
| **DirectFileWriter** | Streams downloads via StreamSaver.js, bypassing browser memory |

### Data Flow

1. **Connection Setup:** Sender creates room → Receiver joins via room code/QR
2. **WebRTC Handshake:** Signaling server relays SDP offers/answers and ICE candidates
3. **Manifest Exchange:** Sender sends file metadata (names, sizes, checksums)
4. **P2P Transfer:** Binary chunks flow directly between browsers via DataChannel
5. **Integrity Check:** Each chunk verified with CRC32 checksum
6. **Completion:** Transfer manifest validated, files saved to disk

## 🛠️ Tech Stack

### Frontend (ponswarp)

| Category | Technology |
|----------|------------|
| **Framework** | React 19, TypeScript 5.9, Vite 7 |
| **WebRTC** | simple-peer (WebRTC wrapper) |
| **Signaling** | Socket.io-client |
| **Compression** | fflate (streaming ZIP) |
| **Storage** | OPFS, StreamSaver.js |
| **State** | Zustand |
| **3D Graphics** | Three.js, React Three Fiber |
| **Animation** | Framer Motion |
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
git clone https://github.com/pons-dev/ponswarp.git
cd ponswarp

# Install dependencies
pnpm install

# Start development server
pnpm dev
```

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
│   │   ├── singlePeerConnection.ts  # WebRTC wrapper
│   │   ├── networkAdaptiveController.ts  # Congestion control
│   │   ├── signaling.ts         # Socket.io client
│   │   ├── directFileWriter.ts  # StreamSaver integration
│   │   └── webRTCService.ts     # Receiver-side WebRTC
│   ├── workers/             # Web Worker threads
│   │   ├── file-sender.worker.v2.ts   # File reading & ZIP streaming
│   │   └── file-receiver.worker.v2.ts # Chunk validation & progress
│   ├── store/               # Zustand state management
│   ├── types/               # TypeScript definitions
│   └── utils/               # Utility functions & constants
├── public/                  # Static assets
└── docs/                    # Technical documentation
```

## 🔧 Technical Deep Dive

### Binary Protocol

Each chunk is transmitted with a 22-byte header:

```
┌──────────────────────────────────────────────────────────────┐
│  Offset  │  Size  │  Field       │  Description              │
├──────────┼────────┼──────────────┼───────────────────────────┤
│  0       │  2     │  FileIndex   │  File ID (0xFFFF = EOS)   │
│  2       │  4     │  ChunkIndex  │  Sequence number          │
│  6       │  8     │  Offset      │  Byte offset in file      │
│  14      │  4     │  DataLength  │  Payload size             │
│  18      │  4     │  CRC32       │  Checksum for integrity   │
│  22      │  N     │  Data        │  Actual file data         │
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

### Buffer Management

| Constant | Value | Purpose |
|----------|-------|---------|
| `MAX_BUFFERED_AMOUNT` | 16 MB | WebRTC channel buffer limit |
| `HIGH_WATER_MARK` | 12 MB | Stop requesting new chunks |
| `LOW_WATER_MARK` | 4 MB | Resume chunk requests |
| `CHUNK_SIZE_MAX` | 128 KB | Maximum chunk size |
| `BATCH_SIZE_MAX` | 128 | Max chunks per worker request |

### Multi-Receiver Queue System

```
1:1 Scenario: Immediate transfer start when receiver is ready
1:N Scenario: 10-second countdown after first receiver ready
              → All ready receivers start simultaneously
              → Late joiners queued for next transfer batch
```

## 📈 Version History

### v0.x (Current Development)

#### Architecture Improvements
- **Unified Peer Connection:** Consolidated sender/receiver logic into `SinglePeerConnection`
- **SwarmManager:** Dedicated 1:N orchestrator with slot management (max 3 peers)
- **Native Browser APIs:** Migrated from WASM to native SubtleCrypto and fflate

#### Performance Optimizations
- **RTT-based Congestion Control:** Delay-based AIMD algorithm
- **Double Buffering:** Prefetch chunks while sending for zero-wait transfers
- **Aggressive Pipelining:** 16MB buffer with 64-chunk batches

#### Reliability Fixes
- **Send Queue Overflow:** Backpressure handling prevents `RTCDataChannel` overflow
- **CRC32 Checksums:** Per-chunk integrity verification
- **Drain Event Retry:** Automatic retry of failed chunks on buffer drain

#### Developer Experience
- **Semantic Release:** Automated versioning with conventional commits
- **CI/CD Pipeline:** GitHub Actions for test, build, and deploy
- **Husky + Commitlint:** Enforced commit message standards

## 🧪 Development

### Commands

```bash
# Development
pnpm dev              # Start Vite dev server (port 3500)
pnpm build            # Production build
pnpm preview          # Preview production build

# Quality
pnpm lint             # ESLint check & fix
pnpm type-check       # TypeScript validation
pnpm test             # Run tests (Vitest)
pnpm test:coverage    # Test coverage report

# Release
pnpm commit           # Interactive commit (Commitizen)
pnpm release:dry-run  # Preview version bump
```

### Commit Convention

```bash
feat: Add new feature          # → Minor version bump
fix: Bug fix                   # → Patch version bump
perf: Performance improvement  # → Patch version bump
docs: Documentation only       # → No version bump
chore: Build/tooling changes   # → No version bump

# Breaking change
feat!: Breaking API change     # → Major version bump
```

### Branch Strategy

```
master     ← Production releases (auto-deploy)
├── develop ← Integration branch (beta releases)
├── feature/* ← New features
├── hotfix/*  ← Emergency fixes
└── release/* ← Release preparation
```

## 🌐 Browser Compatibility

| Browser | Min Version | WebRTC | OPFS | Web Workers |
|---------|-------------|--------|------|-------------|
| Chrome | 86+ | ✅ | ✅ | ✅ |
| Edge | 86+ | ✅ | ✅ | ✅ |
| Firefox | 113+ | ✅ | ⚠️ | ✅ |
| Safari | 16.4+ | ✅ | ⚠️ | ✅ |

> ⚠️ OPFS support varies. Falls back to StreamSaver.js for broader compatibility.

## 🐛 Troubleshooting

### Connection Issues
- **Firewall:** Ensure WebRTC ports are not blocked
- **NAT Traversal:** TURN server credentials are automatically fetched
- **Browser:** Update to latest version for best WebRTC support

### Transfer Speed
- **Network:** Check both sender and receiver bandwidth
- **Buffer:** Monitor `bufferedAmount` in DevTools console
- **Chunk Size:** Automatically adapts based on RTT

### Memory Issues
- **Large Files:** OPFS streams to disk, not RAM
- **Browser Limits:** Chrome handles 10GB+ files reliably
- **Worker Threads:** Offloads processing from main thread

## 🤝 Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature/amazing-feature`
3. Commit changes: `git commit -m 'feat: add amazing feature'`
4. Push branch: `git push origin feature/amazing-feature`
5. Open Pull Request

## 📄 License

MIT License - see [LICENSE](LICENSE) for details.

## 🙏 Acknowledgments

- [WebRTC](https://webrtc.org/) - P2P communication
- [simple-peer](https://github.com/feross/simple-peer) - WebRTC wrapper
- [fflate](https://github.com/101arrowz/fflate) - High-performance compression
- [StreamSaver.js](https://github.com/nicbarker/StreamSaver.js) - Disk streaming
- [React Three Fiber](https://github.com/pmndrs/react-three-fiber) - 3D graphics
- [Vite](https://vitejs.dev/) - Build tooling

---

**⭐ If you find PonsWarp useful, please star the repository!**
