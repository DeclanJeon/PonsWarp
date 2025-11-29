/**
 * SDP Utils
 * WebRTC Session Description Protocol 문자열을 조작하여 연결 설정을 최적화합니다.
 */

// 🚀 [최적화] 대역폭 제한 해제 및 불필요한 라인 제거
export const optimizeSDP = (sdp: string): string => {
  // SDP는 \r\n으로 구분되지만, 테스트 환경에서는 \n으로만 구분될 수 있음
  // 두 경우 모두 처리할 수 있도록 개선
  const lineBreak = sdp.includes('\r\n') ? '\r\n' : '\n';
  let lines = sdp.split(lineBreak);

  // 1. 대역폭 제한 해제 (AS: Application Specific Maximum)
  // 기본적으로 브라우저는 대역폭을 제한할 수 있음. 이를 제거하거나 최대로 설정.
  // DataChannel('application') 섹션에 b=AS 라인이 있다면 수정.
  
  // RFC 4566: b=<modifier>:<bandwidth-value>
  // AS is in kilobits per second.
  // 제한을 500Mbps 이상으로 강제 설정 (필요시 추가)
  // 하지만 최신 브라우저에서는 DataChannel에 대해 기본적으로 제한이 없으므로
  // 오히려 잘못된 제한이 걸려있는지 확인하고 제거하는 것이 안전함.
  
  // 먼저 모든 기존 대역폭 라인 제거
  lines = lines.filter(line => {
    // 레거시 코덱이나 불필요한 RTP 설정 제거 (파일 전송 전용이므로)
    // m=video 나 m=audio 섹션이 실수로 포함된 경우 제거 (현재는 DataChannel only라 없을 것임)
    // 기존 대역폭 라인 제거
    return !(line.startsWith('b=AS:') || line.startsWith('b=TIAS:'));
  });

  // 2. TCP Candidate 필터링 (선택 사항)
  // LAN이나 고속망에서는 UDP가 훨씬 빠르므로, TCP 릴레이 후보를 제거하여
  // 브라우저가 느린 경로를 선택하는 것을 방지할 수 있음.
  // 단, 엄격한 방화벽 환경을 위해 남겨두는 것이 호환성엔 좋음.
  // 여기서는 'Warp Speed' 모드이므로 host/srflx(UDP) 우선순위를 높이는 전략 사용.

  // 3. sdp munging: 인위적으로 b=AS 라인 추가 (Application 섹션)
  // 일부 구형 브라우저 호환성을 위해 명시적으로 대역폭 제한을 풂
  const appSectionIndex = lines.findIndex(line => line.startsWith('m=application'));
  if (appSectionIndex >= 0) {
    // 최대 대역폭 명시 - 1Gbps (WebRTC 스펙 호환)
    // b=AS는 kbps 단위, b=TIAS는 bps 단위
    // 너무 큰 값은 브라우저가 거부하므로 1Gbps로 제한
    lines.splice(appSectionIndex + 1, 0, 'b=AS:1000000'); // 1Gbps in kbps
    lines.splice(appSectionIndex + 2, 0, 'b=TIAS:1000000000'); // 1Gbps in bps
  }

  // 항상 \r\n으로 반환 (WebRTC 표준)
  return lines.join('\r\n');
};

/**
 * ICE Candidate 최적화
 * 로컬 네트워크(Host) 우선순위를 높이거나 불필요한 TCP 후보 제거
 */
export const optimizeCandidate = (candidate: RTCIceCandidate): RTCIceCandidate | null => {
  if (!candidate.candidate) return candidate;

  // 🚀 TCP Candidate 제거 (UDP 강제 - 속도 최적화)
  // 파일 전송 속도를 위해 TCP(tcp, ssltcp 등)는 제외할 수 있음.
  // 단, 연결 실패 확률이 0.1%라도 생길 수 있으므로, 
  // 실제 프로덕션에서는 'timeout' 후 재시도 시에만 사용하는 것이 좋음.
  // 현재는 주석 처리 (안전 제일)
  /*
  if (candidate.protocol === 'tcp') {
    return null;
  }
  */

  return candidate;
};