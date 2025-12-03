# 🌌 PonsWarp

> **File Transfer at Warp Speed.**
> High-performance, serverless P2P file sharing directly in your browser.

![License](https://img.shields.io/badge/license-MIT-blue.svg)![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)![React](https://img.shields.io/badge/React-18-blue)![WebRTC](https://img.shields.io/badge/WebRTC-P2P-green)

**PonsWarp** is a next-generation file transfer tool designed to overcome the limitations of traditional web-based sharing. By leveraging **WebRTC** for peer-to-peer connections and **Origin Private File System (OPFS)** for disk storage, PonsWarp allows you to transfer files of **unlimited size** (10GB, 100GB, 1TB+) without crashing your browser's memory.

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
*   Node.js (v20 or higher)
*   pnpm (v8 or higher)

### 1. Clone repository
```bash
git clone https://github.com/your-username/ponswarp.git
cd ponswarp
```

### 2. Install dependencies
```bash
pnpm install
```

### 3. Start development server
```bash
pnpm dev
```

## 🔄 CI/CD & Version Management

### 자동화된 파이프라인

PonsWarp는 완전 자동화된 CI/CD 파이프라인을 사용합니다:

- **테스트**: 단위 테스트, 통합 테스트, 코드 커버리지
- **품질 검사**: ESLint, Prettier, TypeScript 타입 검사
- **빌드**: 프로덕션 빌드 및 아티팩트 저장
- **릴리즈**: 시맨틱 버전 관리 및 자동 태깅
- **배포**: GitHub Pages에 자동 배포

### 버전 관리 전략

- **시맨틱 버전 관리**: `MAJOR.MINOR.PATCH` 형식
- **자동 릴리즈**: 커밋 메시지 기반 버전 결정
- **브랜치 전략**: Git Flow 기반 (master/develop/feature)
- **커밋 규칙**: Conventional Commits 표준 준수

### 브랜치 규칙

```
master     ← 프로덕션 배포 (자동)
├── develop ← 개발 통합 (베타 릴리즈)
├── feature/* ← 기능 개발
├── hotfix/*  ← 긴급 수정
└── release/* ← 릴리즈 준비
```

### 커밋 메시지 규칙

```bash
feat: 새로운 기능 추가
fix: 버그 수정
docs: 문서 변경
style: 코드 스타일 변경
refactor: 코드 리팩토링
perf: 성능 개선
test: 테스트 추가/수정
chore: 빌드/프로세스 변경
ci: CI/CD 관련 변경
build: 빌드 시스템 변경
```

## 🧪 개발 가이드

### 코드 품질

```bash
# 코드 스타일 검사 및 수정
pnpm lint

# 타입 검사
pnpm type-check

# 테스트 실행
pnpm test

# 테스트 커버리지
pnpm test:coverage
```

### 커밋 프로세스

1. **Pre-commit Hook**: 자동으로 lint-staged 실행
2. **Commit-msg Hook**: 커밋 메시지 규칙 검사
3. **Interactive Commit**: `pnpm commit`으로 가이드된 커밋

### 릴리즈 프로세스

1. **develop 브랜치**: 자동 베타 버전 릴리즈
2. **master 브랜치**: 자동 정식 버전 릴리즈 및 배포
3. **릴리즈 노트**: semantic-release가 자동 생성

자세한 내용은 [버전 관리 문서](./docs/VERSION_MANAGEMENT.md)를 참조하세요.

## 🚀 사용 방법

### 파일 전송하기

1. **발신자 (Sender)**:
   - 웹사이트 접속
   - 전송할 파일/폴더를 드래그 앤 드롭
   - 생성된 QR 코드 또는 링크 공유

2. **수신자 (Receiver)**:
   - QR 코드 스캔 또는 링크 접속
   - 자동으로 P2P 연결 설정
   - 파일 다운로드 시작

### 주요 기능

- **실시간 전송 속도 모니터링**
- **일시 정지/재개 기능**
- **다중 파일 동시 전송**
- **암호화된 P2P 통신**
- **크로스 플랫폼 호환성**

## 🔧 고급 설정

### 환경 변수

```bash
# 시그널링 서버 주소
VITE_SIGNALING_SERVER_URL=ws://localhost:3001

# TURN 서버 설정 (NAT 통과)
VITE_TURN_SERVER_URL=turn:your-turn-server.com
VITE_TURN_USERNAME=username
VITE_TURN_CREDENTIAL=credential
```

### 성능 튜닝

```typescript
// 청크 크기 설정 (기본: 64KB)
const CHUNK_SIZE = 64 * 1024;

// 동시 연결 수 (기본: 4)
const MAX_CONCURRENT_CONNECTIONS = 4;

// 버퍼 크기 (기본: 1MB)
const BUFFER_SIZE = 1024 * 1024;
```

## 🐛 문제 해결

### 일반적인 문제

1. **연결 실패**:
   - 방화벽 설정 확인
   - TURN 서버 사용
   - 브라우저 호환성 확인

2. **전송 속도 저하**:
   - 네트워크 상태 확인
   - 브라우저 리소스 사용량 확인
   - 청크 크기 조절

3. **메모리 부족**:
   - OPFS 지원 확인
   - 브라우저 버전 업데이트
   - 파일 크기 제한 확인

### 브라우저 호환성

| 브라우저 | 최소 버전 | WebRTC | OPFS | Web Workers |
|---------|---------|--------|------|------------|
| Chrome | 86+ | ✅ | ✅ | ✅ |
| Firefox | 82+ | ✅ | ⚠️ | ✅ |
| Safari | 15+ | ✅ | ⚠️ | ✅ |
| Edge | 86+ | ✅ | ✅ | ✅ |

## 🤝 기여하기

기여를 환영합니다! 다음 단계를 따라주세요:

1. 이슈 생성 또는 기존 이슈 검토
2. 기능 브랜치 생성: `git checkout -b feature/amazing-feature`
3. 변경사항 커밋: `git commit -m 'feat: add amazing feature'`
4. 브랜치 푸시: `git push origin feature/amazing-feature`
5. Pull Request 생성

### 개발 환경 설정

```bash
# 의존성 설치
pnpm install

# 개발 서버 시작
pnpm dev

# 테스트 실행
pnpm test

# 빌드
pnpm build
```

## 📄 라이선스

이 프로젝트는 MIT 라이선스 하에 배포됩니다. [LICENSE](LICENSE) 파일을 참조하세요.

## 🙏 감사

- [WebRTC](https://webrtc.org/) - P2P 통신 기술
- [OPFS](https://developer.mozilla.org/en-US/docs/Web/API/File_System_API) - 파일 시스템 API
- [React Three Fiber](https://github.com/pmndrs/react-three-fiber) - 3D 그래픽
- [Vite](https://vitejs.dev/) - 빠른 빌드 도구

## 📞 연락처

- 프로젝트 홈페이지: [https://github.com/your-username/ponswarp](https://github.com/your-username/ponswarp)
- 이슈 리포트: [Issues](https://github.com/your-username/ponswarp/issues)
- 기능 요청: [Discussions](https://github.com/your-username/ponswarp/discussions)

---

**⭐ 만약 이 프로젝트가 유용하다면 스타를 눌러주세요!**