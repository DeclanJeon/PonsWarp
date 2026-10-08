# Unreleased

### UI/UX

* Send by link 완료 화면에서 다운로드 링크를 직접 선택하거나 명시적인 Copy link 버튼으로 복사할 수 있도록 개선.
* 링크와 Drop Code의 복사 성공 안내를 분리하고, 클립보드 접근 실패 시 수동 복사할 텍스트 선택과 안내 제공.
* 모바일에서는 링크와 QR을 세로 배치하고 태블릿·데스크톱에서는 나란히 배치. 낮은 화면 높이에 맞춘 헤더와 스크롤 영역 조정으로 공유 카드 전체에 접근 가능.
* 실시간 공유에도 공통 링크/룸코드 복사 UI 적용. 잘못된 수신 URL이나 긴 Room Code를 임의로 잘라 연결하지 않도록 입력 계약 개선.
* 보호된 Cloud Drop의 비밀번호 입력·HTTP 오류별 복구·미완료 공유 새로고침 개선. 저장소 접근이 거부되어도 메모리 인증 토큰으로 다운로드 접근 유지.
* 전체 다운로드 중 일부 파일이 실패하면 불완전 ZIP을 저장하지 않고 실패 파일과 재시도 안내 제공.
* 방 점유·응답 지연·완료 후 다음 수신 흐름 보완. 단계 안내, 진행률 접근성, 화면 전환 초점, 긴 파일명, 읽기 쉬운 글자 크기 및 토스트 수명 개선.
* 모션 감소 설정 변경을 새로고침 없이 반영하여 배경 canvas와 장식 모션 중단. P2P E2EE와 Cloud HTTPS 보안 안내 분리.
* 활성 전송의 history guard를 세션당 하나로 유지하고, 딥링크 이탈 중 수신 화면이 다시 열리는 경로 복원 오류 수정.
* 운영 배포 시 공개 Vite endpoint를 production env 예제로 채우고, 실제 UI의 현재 송수신 단계에 맞춰 운영 전송 smoke selector를 갱신.

### Deployment

* 운영 배포·롤백 후 Cloudflare HTML 캐시를 대상 purge하고 활성 entry bundle 및 cache 상태를 검증.

# [0.7.3](https://github.com/DeclanJeon/PonsWarp/compare/v0.7.2...v0.7.3) (2026-05-17)


### Bug Fixes

* 모바일 수신 브라우저 백그라운드/foreground 복귀 시 P2P 전송 재개 처리 추가
* receiver lifecycle 복귀 시 RESUME/PARTITION_ACK 재전송 및 sender offset 기반 재전송 보강


# [0.7.0](https://github.com/DeclanJeon/PonsWarp/compare/v0.6.0...v0.7.0) (2025-12-04)


### Bug Fixes

* 🛡️ 파일 깨짐 문제 완전 해결 및 대용량 전송 성능 대폭 개선 ([4650d02](https://github.com/DeclanJeon/PonsWarp/commit/4650d021b7e7c391497688e6bed96e8fbaad37ce))
* CI pnpm 버전을 10으로 업데이트 ([b7647da](https://github.com/DeclanJeon/PonsWarp/commit/b7647da1136ca0fb1c64cd5fe361c576d19d09ac))
* CI 테스트 실패 문제 해결 및 더미 테스트 추가 ([cef3e81](https://github.com/DeclanJeon/PonsWarp/commit/cef3e817e5a6c683b6044192932dd32e67700311))
* CI/CD 워크플로우 수정 및 semantic-release 권한 문제 해결 ([584efbc](https://github.com/DeclanJeon/PonsWarp/commit/584efbc8f6f69583ed87996308b8c6d9a50923ce))
* semantic-release 설정 수정 및 버전 동기화 ([189c329](https://github.com/DeclanJeon/PonsWarp/commit/189c329f6632792009c92ade560a2dbde89044e1))
* ZIP 파일 전송 시 메모리 관리 및 버퍼 오버플로우 개선 ([3a2a27a](https://github.com/DeclanJeon/PonsWarp/commit/3a2a27a865875bd9b6c27b039af53e1be448b6b4))
* 워커 환경에서의 WASM ZipEngine import 문제 해결 ([188e95c](https://github.com/DeclanJeon/PonsWarp/commit/188e95c80018abdf3514b33bb2dcbfd24fe4f30d))


### Features

* [3/20단계] 고성능 ZIP 압축 WASM 모듈 구현 ([3d89cdf](https://github.com/DeclanJeon/PonsWarp/commit/3d89cdf48d75f09da6fccc7d0a0fb4d5553aff38))
* [5/20단계] SpaceField.tsx 동적 성능 제어기 구현 ([059552a](https://github.com/DeclanJeon/PonsWarp/commit/059552a78a19e371818481131f300a3a551c2631))
* E2E 암호화 기능 통합 ([58e0836](https://github.com/DeclanJeon/PonsWarp/commit/58e08363a0fbb3c24e77a11f36ecf76b45f06971))
* RTT 기반 동적 혼잡 제어 알고리즘을 구현하여 네트워크 적응형 전송 성능 개선 ([09161ce](https://github.com/DeclanJeon/PonsWarp/commit/09161ce0d2c685d06f6787cc4da2c314da8c1393))
* UI/UX 디자인 시스템 개선 및 반응형 레이아웃 구현 ([a19a244](https://github.com/DeclanJeon/PonsWarp/commit/a19a244abefa43fb48864850fae59178a03a1975))
* 수신 측 역압(Backpressure) 제어 구현 ([54cf5f4](https://github.com/DeclanJeon/PonsWarp/commit/54cf5f415398cc9e90c588b2f4030d6f98975e28))
* 완전 자동화된 CI/CD 파이프라인 및 버전 관리 시스템 구축 ([0e767b4](https://github.com/DeclanJeon/PonsWarp/commit/0e767b4a88e915add439352e877408764c7ccd79)), closes [#1](https://github.com/DeclanJeon/PonsWarp/issues/1)


### Performance Improvements

* ⚡ LAN 환경 최적화 및 대용량 전송 성능 극대화 ([778f71a](https://github.com/DeclanJeon/PonsWarp/commit/778f71af2b5d4a333046662a0d6a831373a13c0c))

# [0.7.0](https://github.com/DeclanJeon/PonsWarp/compare/v0.6.0...v0.7.0) (2025-12-04)


### Bug Fixes

* 🛡️ 파일 깨짐 문제 완전 해결 및 대용량 전송 성능 대폭 개선 ([4650d02](https://github.com/DeclanJeon/PonsWarp/commit/4650d021b7e7c391497688e6bed96e8fbaad37ce))
* CI pnpm 버전을 10으로 업데이트 ([b7647da](https://github.com/DeclanJeon/PonsWarp/commit/b7647da1136ca0fb1c64cd5fe361c576d19d09ac))
* CI 테스트 실패 문제 해결 및 더미 테스트 추가 ([cef3e81](https://github.com/DeclanJeon/PonsWarp/commit/cef3e817e5a6c683b6044192932dd32e67700311))
* CI/CD 워크플로우 수정 및 semantic-release 권한 문제 해결 ([584efbc](https://github.com/DeclanJeon/PonsWarp/commit/584efbc8f6f69583ed87996308b8c6d9a50923ce))
* semantic-release 설정 수정 및 버전 동기화 ([189c329](https://github.com/DeclanJeon/PonsWarp/commit/189c329f6632792009c92ade560a2dbde89044e1))
* ZIP 파일 전송 시 메모리 관리 및 버퍼 오버플로우 개선 ([3a2a27a](https://github.com/DeclanJeon/PonsWarp/commit/3a2a27a865875bd9b6c27b039af53e1be448b6b4))
* 워커 환경에서의 WASM ZipEngine import 문제 해결 ([188e95c](https://github.com/DeclanJeon/PonsWarp/commit/188e95c80018abdf3514b33bb2dcbfd24fe4f30d))


### Features

* [3/20단계] 고성능 ZIP 압축 WASM 모듈 구현 ([3d89cdf](https://github.com/DeclanJeon/PonsWarp/commit/3d89cdf48d75f09da6fccc7d0a0fb4d5553aff38))
* [5/20단계] SpaceField.tsx 동적 성능 제어기 구현 ([059552a](https://github.com/DeclanJeon/PonsWarp/commit/059552a78a19e371818481131f300a3a551c2631))
* E2E 암호화 기능 통합 ([58e0836](https://github.com/DeclanJeon/PonsWarp/commit/58e08363a0fbb3c24e77a11f36ecf76b45f06971))
* RTT 기반 동적 혼잡 제어 알고리즘을 구현하여 네트워크 적응형 전송 성능 개선 ([09161ce](https://github.com/DeclanJeon/PonsWarp/commit/09161ce0d2c685d06f6787cc4da2c314da8c1393))
* UI/UX 디자인 시스템 개선 및 반응형 레이아웃 구현 ([a19a244](https://github.com/DeclanJeon/PonsWarp/commit/a19a244abefa43fb48864850fae59178a03a1975))
* 수신 측 역압(Backpressure) 제어 구현 ([54cf5f4](https://github.com/DeclanJeon/PonsWarp/commit/54cf5f415398cc9e90c588b2f4030d6f98975e28))
* 완전 자동화된 CI/CD 파이프라인 및 버전 관리 시스템 구축 ([0e767b4](https://github.com/DeclanJeon/PonsWarp/commit/0e767b4a88e915add439352e877408764c7ccd79)), closes [#1](https://github.com/DeclanJeon/PonsWarp/issues/1)


### Performance Improvements

* ⚡ LAN 환경 최적화 및 대용량 전송 성능 극대화 ([778f71a](https://github.com/DeclanJeon/PonsWarp/commit/778f71af2b5d4a333046662a0d6a831373a13c0c))

# [0.7.0](https://github.com/DeclanJeon/PonsWarp/compare/v0.6.0...v0.7.0) (2025-12-04)


### Bug Fixes

* 🛡️ 파일 깨짐 문제 완전 해결 및 대용량 전송 성능 대폭 개선 ([4650d02](https://github.com/DeclanJeon/PonsWarp/commit/4650d021b7e7c391497688e6bed96e8fbaad37ce))
* CI pnpm 버전을 10으로 업데이트 ([b7647da](https://github.com/DeclanJeon/PonsWarp/commit/b7647da1136ca0fb1c64cd5fe361c576d19d09ac))
* CI 테스트 실패 문제 해결 및 더미 테스트 추가 ([cef3e81](https://github.com/DeclanJeon/PonsWarp/commit/cef3e817e5a6c683b6044192932dd32e67700311))
* CI/CD 워크플로우 수정 및 semantic-release 권한 문제 해결 ([584efbc](https://github.com/DeclanJeon/PonsWarp/commit/584efbc8f6f69583ed87996308b8c6d9a50923ce))
* semantic-release 설정 수정 및 버전 동기화 ([189c329](https://github.com/DeclanJeon/PonsWarp/commit/189c329f6632792009c92ade560a2dbde89044e1))
* ZIP 파일 전송 시 메모리 관리 및 버퍼 오버플로우 개선 ([3a2a27a](https://github.com/DeclanJeon/PonsWarp/commit/3a2a27a865875bd9b6c27b039af53e1be448b6b4))
* 워커 환경에서의 WASM ZipEngine import 문제 해결 ([188e95c](https://github.com/DeclanJeon/PonsWarp/commit/188e95c80018abdf3514b33bb2dcbfd24fe4f30d))


### Features

* [3/20단계] 고성능 ZIP 압축 WASM 모듈 구현 ([3d89cdf](https://github.com/DeclanJeon/PonsWarp/commit/3d89cdf48d75f09da6fccc7d0a0fb4d5553aff38))
* [5/20단계] SpaceField.tsx 동적 성능 제어기 구현 ([059552a](https://github.com/DeclanJeon/PonsWarp/commit/059552a78a19e371818481131f300a3a551c2631))
* E2E 암호화 기능 통합 ([58e0836](https://github.com/DeclanJeon/PonsWarp/commit/58e08363a0fbb3c24e77a11f36ecf76b45f06971))
* RTT 기반 동적 혼잡 제어 알고리즘을 구현하여 네트워크 적응형 전송 성능 개선 ([09161ce](https://github.com/DeclanJeon/PonsWarp/commit/09161ce0d2c685d06f6787cc4da2c314da8c1393))
* UI/UX 디자인 시스템 개선 및 반응형 레이아웃 구현 ([a19a244](https://github.com/DeclanJeon/PonsWarp/commit/a19a244abefa43fb48864850fae59178a03a1975))
* 수신 측 역압(Backpressure) 제어 구현 ([54cf5f4](https://github.com/DeclanJeon/PonsWarp/commit/54cf5f415398cc9e90c588b2f4030d6f98975e28))
* 완전 자동화된 CI/CD 파이프라인 및 버전 관리 시스템 구축 ([0e767b4](https://github.com/DeclanJeon/PonsWarp/commit/0e767b4a88e915add439352e877408764c7ccd79)), closes [#1](https://github.com/DeclanJeon/PonsWarp/issues/1)


### Performance Improvements

* ⚡ LAN 환경 최적화 및 대용량 전송 성능 극대화 ([778f71a](https://github.com/DeclanJeon/PonsWarp/commit/778f71af2b5d4a333046662a0d6a831373a13c0c))

# [0.7.0](https://github.com/DeclanJeon/PonsWarp/compare/v0.6.0...v0.7.0) (2025-12-03)


### Bug Fixes

* 🛡️ 파일 깨짐 문제 완전 해결 및 대용량 전송 성능 대폭 개선 ([4650d02](https://github.com/DeclanJeon/PonsWarp/commit/4650d021b7e7c391497688e6bed96e8fbaad37ce))
* CI pnpm 버전을 10으로 업데이트 ([b7647da](https://github.com/DeclanJeon/PonsWarp/commit/b7647da1136ca0fb1c64cd5fe361c576d19d09ac))
* CI 테스트 실패 문제 해결 및 더미 테스트 추가 ([cef3e81](https://github.com/DeclanJeon/PonsWarp/commit/cef3e817e5a6c683b6044192932dd32e67700311))
* CI/CD 워크플로우 수정 및 semantic-release 권한 문제 해결 ([584efbc](https://github.com/DeclanJeon/PonsWarp/commit/584efbc8f6f69583ed87996308b8c6d9a50923ce))
* semantic-release 설정 수정 및 버전 동기화 ([189c329](https://github.com/DeclanJeon/PonsWarp/commit/189c329f6632792009c92ade560a2dbde89044e1))
* ZIP 파일 전송 시 메모리 관리 및 버퍼 오버플로우 개선 ([3a2a27a](https://github.com/DeclanJeon/PonsWarp/commit/3a2a27a865875bd9b6c27b039af53e1be448b6b4))
* 워커 환경에서의 WASM ZipEngine import 문제 해결 ([188e95c](https://github.com/DeclanJeon/PonsWarp/commit/188e95c80018abdf3514b33bb2dcbfd24fe4f30d))


### Features

* [3/20단계] 고성능 ZIP 압축 WASM 모듈 구현 ([3d89cdf](https://github.com/DeclanJeon/PonsWarp/commit/3d89cdf48d75f09da6fccc7d0a0fb4d5553aff38))
* [5/20단계] SpaceField.tsx 동적 성능 제어기 구현 ([059552a](https://github.com/DeclanJeon/PonsWarp/commit/059552a78a19e371818481131f300a3a551c2631))
* RTT 기반 동적 혼잡 제어 알고리즘을 구현하여 네트워크 적응형 전송 성능 개선 ([09161ce](https://github.com/DeclanJeon/PonsWarp/commit/09161ce0d2c685d06f6787cc4da2c314da8c1393))
* UI/UX 디자인 시스템 개선 및 반응형 레이아웃 구현 ([a19a244](https://github.com/DeclanJeon/PonsWarp/commit/a19a244abefa43fb48864850fae59178a03a1975))
* 수신 측 역압(Backpressure) 제어 구현 ([54cf5f4](https://github.com/DeclanJeon/PonsWarp/commit/54cf5f415398cc9e90c588b2f4030d6f98975e28))
* 완전 자동화된 CI/CD 파이프라인 및 버전 관리 시스템 구축 ([0e767b4](https://github.com/DeclanJeon/PonsWarp/commit/0e767b4a88e915add439352e877408764c7ccd79)), closes [#1](https://github.com/DeclanJeon/PonsWarp/issues/1)


### Performance Improvements

* ⚡ LAN 환경 최적화 및 대용량 전송 성능 극대화 ([778f71a](https://github.com/DeclanJeon/PonsWarp/commit/778f71af2b5d4a333046662a0d6a831373a13c0c))

# [0.7.0](https://github.com/DeclanJeon/PonsWarp/compare/v0.6.0...v0.7.0) (2025-12-03)


### Bug Fixes

* 🛡️ 파일 깨짐 문제 완전 해결 및 대용량 전송 성능 대폭 개선 ([4650d02](https://github.com/DeclanJeon/PonsWarp/commit/4650d021b7e7c391497688e6bed96e8fbaad37ce))
* CI pnpm 버전을 10으로 업데이트 ([b7647da](https://github.com/DeclanJeon/PonsWarp/commit/b7647da1136ca0fb1c64cd5fe361c576d19d09ac))
* CI 테스트 실패 문제 해결 및 더미 테스트 추가 ([cef3e81](https://github.com/DeclanJeon/PonsWarp/commit/cef3e817e5a6c683b6044192932dd32e67700311))
* CI/CD 워크플로우 수정 및 semantic-release 권한 문제 해결 ([584efbc](https://github.com/DeclanJeon/PonsWarp/commit/584efbc8f6f69583ed87996308b8c6d9a50923ce))
* semantic-release 설정 수정 및 버전 동기화 ([189c329](https://github.com/DeclanJeon/PonsWarp/commit/189c329f6632792009c92ade560a2dbde89044e1))
* ZIP 파일 전송 시 메모리 관리 및 버퍼 오버플로우 개선 ([3a2a27a](https://github.com/DeclanJeon/PonsWarp/commit/3a2a27a865875bd9b6c27b039af53e1be448b6b4))
* 워커 환경에서의 WASM ZipEngine import 문제 해결 ([188e95c](https://github.com/DeclanJeon/PonsWarp/commit/188e95c80018abdf3514b33bb2dcbfd24fe4f30d))


### Features

* [3/20단계] 고성능 ZIP 압축 WASM 모듈 구현 ([3d89cdf](https://github.com/DeclanJeon/PonsWarp/commit/3d89cdf48d75f09da6fccc7d0a0fb4d5553aff38))
* [5/20단계] SpaceField.tsx 동적 성능 제어기 구현 ([059552a](https://github.com/DeclanJeon/PonsWarp/commit/059552a78a19e371818481131f300a3a551c2631))
* RTT 기반 동적 혼잡 제어 알고리즘을 구현하여 네트워크 적응형 전송 성능 개선 ([09161ce](https://github.com/DeclanJeon/PonsWarp/commit/09161ce0d2c685d06f6787cc4da2c314da8c1393))
* 수신 측 역압(Backpressure) 제어 구현 ([54cf5f4](https://github.com/DeclanJeon/PonsWarp/commit/54cf5f415398cc9e90c588b2f4030d6f98975e28))
* 완전 자동화된 CI/CD 파이프라인 및 버전 관리 시스템 구축 ([0e767b4](https://github.com/DeclanJeon/PonsWarp/commit/0e767b4a88e915add439352e877408764c7ccd79)), closes [#1](https://github.com/DeclanJeon/PonsWarp/issues/1)


### Performance Improvements

* ⚡ LAN 환경 최적화 및 대용량 전송 성능 극대화 ([778f71a](https://github.com/DeclanJeon/PonsWarp/commit/778f71af2b5d4a333046662a0d6a831373a13c0c))
