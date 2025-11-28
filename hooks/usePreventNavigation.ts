import { useEffect } from 'react';
import { AppMode } from '../types';

export const usePreventNavigation = (mode: AppMode) => {
  useEffect(() => {
    // 페이지 이탈 방지 기능을 비활성화하여 "사이트에서 나가시겠습니까?" 알림이 나타나지 않도록 함
    // 필요 시 아래 주석을 해제하여 기능을 다시 활성화할 수 있음
    
    /*
    // 보호가 필요한 상태 정의: 전송 중, 수신 대기 중, 송신 대기 중
    const shouldPrevent =
      mode === AppMode.TRANSFERRING ||
      mode === AppMode.RECEIVER ||
      mode === AppMode.SENDER;

    if (!shouldPrevent) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      // 표준 경고 메시지 트리거 (브라우저 정책상 메시지 커스텀은 불가능할 수 있음)
      e.preventDefault();
      e.returnValue = ''; // Chrome/Edge 필수 설정
      return '';
    };

    window.addEventListener('beforeunload', handleBeforeUnload);

    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
    */
  }, [mode]);
};
