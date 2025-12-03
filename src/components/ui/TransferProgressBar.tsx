import { useEffect, useRef } from 'react';
import { useTransferStore } from '../../store/transferStore';

/**
 * TransferProgressBar - 최적화된 진행률 표시 컴포넌트
 * 
 * 🚀 [최적화] React 리렌더링 사이클을 우회하고 DOM을 직접 조작하여
 * 60fps 애니메이션 성능 확보 및 부모 컴포넌트 리렌더링 방지
 */
export const TransferProgressBar: React.FC = () => {
  const progressRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const speedRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    // Zustand의 subscribe 메서드를 사용하여 React 리렌더링 사이클 우회
    // DOM을 직접 조작하여 60fps 애니메이션 성능 확보
    const unsub = useTransferStore.subscribe(
      (state) => state.progress,
      (progressData) => {
        if (progressRef.current) {
          progressRef.current.style.width = `${progressData.progress}%`;
        }
        if (textRef.current) {
          // 소수점 1자리까지만 표시하여 텍스트 떨림 방지
          textRef.current.innerText = `${progressData.progress.toFixed(1)}%`;
        }
        if (speedRef.current && progressData.speed) {
          // 속도 표시 (MB/s)
          const speedMB = (progressData.speed / (1024 * 1024)).toFixed(2);
          speedRef.current.innerText = `${speedMB} MB/s`;
        }
      }
    );

    return () => unsub();
  }, []);

  return (
    <div className="w-full max-w-md mx-auto">
      <div className="flex justify-between mb-2 text-cyan-400 font-mono text-sm">
        <span className="tracking-wider">TRANSFERRING</span>
        <div className="flex gap-4">
          <span ref={speedRef} className="text-cyan-300">0.00 MB/s</span>
          <span ref={textRef}>0.0%</span>
        </div>
      </div>
      <div className="h-2 bg-gray-800 rounded-full overflow-hidden border border-gray-700">
        <div 
          ref={progressRef}
          className="h-full bg-gradient-to-r from-cyan-500 via-blue-500 to-purple-600 transition-all duration-100 ease-linear shadow-[0_0_10px_rgba(6,182,212,0.8)]"
          style={{ width: '0%' }}
        />
      </div>
    </div>
  );
};
