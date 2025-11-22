// Screen Wake Lock API Wrapper
let wakeLock: any = null;

export const requestWakeLock = async () => {
  if ('wakeLock' in navigator) {
    try {
      // @ts-ignore
      wakeLock = await navigator.wakeLock.request('screen');
      console.log('[WakeLock] Screen Wake Lock active 💡');
      
      // 화면이 꺼졌다가 다시 켜지거나, 탭이 다시 활성화될 때 lock이 풀릴 수 있으므로 재요청 리스너 필요할 수 있음
      // 여기서는 단순화하여 lock 객체만 반환
      return true;
    } catch (err) {
      console.warn('[WakeLock] Failed to acquire lock:', err);
      return false;
    }
  }
  return false;
};

export const releaseWakeLock = async () => {
  if (wakeLock) {
    try {
      await wakeLock.release();
      wakeLock = null;
      console.log('[WakeLock] Lock released 🌙');
    } catch (err) {
      console.warn('[WakeLock] Failed to release lock:', err);
    }
  }
};