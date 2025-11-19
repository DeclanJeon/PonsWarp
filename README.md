# 🌌 PonsWarp

> **File Transfer at Warp Speed.**
> High-performance, serverless P2P file sharing directly in your browser.

![License](https://img.shields.io/badge/license-MIT-blue.svg)![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)![React](https://img.shields.io/badge/React-18-blue)![WebRTC](https://img.shields.io/badge/WebRTC-P2P-green)

**PonsWarp** is a next-generation file transfer tool designed to overcome the limitations of traditional web-based sharing. By leveraging **WebRTC** for peer-to-peer connections and the **Origin Private File System (OPFS)** for disk storage, PonsWarp allows you to transfer files of **unlimited size** (10GB, 100GB, 1TB+) without crashing your browser's memory.

## 🚀 Key Features

*   **⚡ Hyper-Fast P2P Transfer:** Direct browser-to-browser connection using WebRTC (UDP/SCTP). No intermediate servers store your data.
*   **🧠 Smart Congestion Control:** Implements a custom **Backpressure** algorithm to manage buffer levels dynamically, ensuring maximum speed without packet loss or browser freezing.
*   **💾 10TB+ File Support:** Uses **OPFS (Origin Private File System)** and **Web Workers** to stream data directly to the disk, bypassing RAM limitations.
*   **📂 Folder & Multi-File Support:** Drag and drop entire folder structures. Receivers can download them as a single ZIP stream or individual files.
*   **🛡️ Reliable Delivery:** Custom binary signaling for EOF (End of File) ensures 100% data integrity with zero missing bytes.
*   **🎨 Sci-Fi UI:** A fully immersive, hardware-accelerated 3D background and futuristic interface.

## 🛠️ Tech Stack

*   **Frontend:** React 18, TypeScript, Vite, Tailwind CSS
*   **Core Networking:** WebRTC (`simple-peer`), Socket.io (Signaling only)
*   **Storage & Stream:** OPFS (FileSystem API), `streamsaver`, `fflate` (High-performance compression)
*   **Concurrency:** Dedicated Web Workers for Sender and Receiver threads to keep the UI smooth.
*   **Visuals:** Three.js / React Three Fiber

## 📦 Installation & Setup

### Prerequisites
*   Node.js (v16 or higher)
*   npm or yarn

### 1. Clone the repository
```bash
git clone https://github.com/your-username/ponswarp.git
cd ponswarp