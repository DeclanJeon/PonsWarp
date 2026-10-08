import { useSyncExternalStore } from 'react';

const motionQuery = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
  ? window.matchMedia('(prefers-reduced-motion: reduce)')
  : null;

const subscribe = (onChange: () => void) => {
  motionQuery?.addEventListener('change', onChange);
  return () => motionQuery?.removeEventListener('change', onChange);
};

const getSnapshot = () => motionQuery?.matches ?? false;
const getServerSnapshot = () => false;

export const useReducedMotionPreference = (): boolean =>
  useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
