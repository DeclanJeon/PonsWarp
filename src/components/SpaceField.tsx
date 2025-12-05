import { useRef, useMemo, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { useTransferStore } from '../store/transferStore';
import { AppMode } from '../types/types';

// 설정 상수
const STAR_COUNT = 800;
const STAR_SIZE = 0.05;
const Z_BOUND = 40;
const WARP_SPEED = 2.5;
const IDLE_SPEED = 0.05;
const ACCELERATION = 0.02;
const STRETCH_FACTOR = 15;

// 🚀 [최적화] 성능 모드 설정
const FPS_LIMIT_HIGH = 1 / 30; // 60 FPS (평소)
const FPS_LIMIT_LOW = 1 / 15; // 20 FPS (전송 중 - CPU 절약)

/**
 * 🌟 WarpStars: InstancedMesh를 사용한 고성능 워프 효과
 * 🚀 [최적화] Frame Throttling 적용
 */
const WarpStars = () => {
  const meshRef = useRef<THREE.InstancedMesh>(null);

  // 상태 구독
  const status = useTransferStore(state => state.status);
  const mode = useTransferStore(state => state.mode);

  // 더미 Object3D (매트릭스 계산용)
  const dummy = useMemo(() => new THREE.Object3D(), []);

  // 별들의 초기 위치 및 속도 데이터
  const initialData = useMemo(() => {
    const data = new Float32Array(STAR_COUNT * 4);
    for (let i = 0; i < STAR_COUNT; i++) {
      const i4 = i * 4;
      // 도넛 형태로 분포 (중앙 비움)
      const r = 2 + Math.random() * 20;
      const theta = 2 * Math.PI * Math.random();
      data[i4] = r * Math.cos(theta); // x
      data[i4 + 1] = r * Math.sin(theta); // y
      data[i4 + 2] = (Math.random() - 0.5) * Z_BOUND * 2; // z
      data[i4 + 3] = 0.5 + Math.random() * 0.5; // random scale
    }
    return data;
  }, []);

  // 현재 속도 상태
  const currentSpeed = useRef(IDLE_SPEED);

  // 🚀 [최적화] 프레임 델타 누적 변수
  const timeAccumulator = useRef(0);

  useFrame((state, delta) => {
    if (!meshRef.current) return;

    // 🚀 [최적화] 상태에 따른 프레임 제한 로직
    const isHeavyLoad =
      status === 'TRANSFERRING' ||
      status === 'PREPARING' ||
      status === 'RECEIVING';
    const frameLimit = isHeavyLoad ? FPS_LIMIT_LOW : FPS_LIMIT_HIGH;

    timeAccumulator.current += delta;

    // 목표 프레임 간격보다 시간이 덜 지났으면 업데이트 건너뜀 (CPU 절약)
    if (timeAccumulator.current < frameLimit) {
      return;
    }

    // 누적된 시간(실제 경과 시간)을 사용하여 물리 계산 (부드러운 움직임 보정)
    const updateDelta = timeAccumulator.current;
    timeAccumulator.current = 0; // 리셋

    // 목표 속도 및 방향 결정
    let targetSpeed = IDLE_SPEED;

    if (
      status === 'TRANSFERRING' ||
      status === 'CONNECTING' ||
      status === 'RECEIVING'
    ) {
      // Receiver: 음수 속도 (뿜어져 나옴), Sender: 양수 속도 (빨려 들어감)
      const direction = mode === AppMode.RECEIVER ? -1 : 1;
      targetSpeed = WARP_SPEED * direction;
    } else if (status === 'DRAGGING_FILES') {
      targetSpeed = 0.5;
    }

    // 속도 Lerp (updateDelta 사용)
    const lerpFactor = ACCELERATION * (updateDelta * 60);
    currentSpeed.current = THREE.MathUtils.lerp(
      currentSpeed.current,
      targetSpeed,
      lerpFactor
    );

    // 인스턴스 업데이트
    const speed = currentSpeed.current;
    const absSpeed = Math.abs(speed);

    // 🚀 [최적화] 매트릭스 연산 루프
    // Heavy Load일 때는 루프를 조금 더 단순화할 수도 있지만, Frame Throttling으로 충분함
    for (let i = 0; i < STAR_COUNT; i++) {
      const i4 = i * 4;
      const x = initialData[i4];
      const y = initialData[i4 + 1];
      let z = initialData[i4 + 2];
      const scaleBase = initialData[i4 + 3];

      // Z축 이동 (updateDelta 사용)
      z += speed * 20 * updateDelta;

      // 경계 처리
      if (z > Z_BOUND) {
        z -= Z_BOUND * 2;
      } else if (z < -Z_BOUND) {
        z += Z_BOUND * 2;
      }

      // 상태 저장 (다음 프레임을 위해)
      initialData[i4 + 2] = z;

      // 변환 적용
      dummy.position.set(x, y, z);

      // 스케일링 (Streaking Effect)
      const zScale = 1 + absSpeed * STRETCH_FACTOR;
      dummy.scale.set(scaleBase, scaleBase, scaleBase * zScale);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);

      // 색상 페이딩
      const dist = Math.abs(z);
      const intensity = 1 - dist / Z_BOUND;
      const colorIntensity = Math.max(0, intensity) * 1.5;

      meshRef.current.setColorAt(
        i,
        new THREE.Color(
          colorIntensity * 0.8,
          colorIntensity * 1.0,
          colorIntensity * 1.5
        )
      );
    }

    meshRef.current.instanceMatrix.needsUpdate = true;
    if (meshRef.current.instanceColor)
      meshRef.current.instanceColor.needsUpdate = true;
  });

  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, STAR_COUNT]}
      frustumCulled={false}
    >
      <sphereGeometry args={[STAR_SIZE, 8, 8]} />
      {/* depthWrite와 depthTest를 false로 설정 */}
      <meshBasicMaterial
        color={[1.5, 2, 3]}
        toneMapped={false}
        depthWrite={false}
        depthTest={false}
      />
    </instancedMesh>
  );
};

// 🚀 [최적화] 씬 관리자 (DPR 조절용)
const SceneManager = () => {
  const { gl } = useThree();
  const status = useTransferStore(state => state.status);

  useEffect(() => {
    const isHeavy =
      status === 'TRANSFERRING' ||
      status === 'RECEIVING' ||
      status === 'PREPARING';
    // 전송 중에는 픽셀 비율을 1로 고정하여 GPU 부하 감소
    // 평소에는 최대 1.5배까지 (Retina 디스플레이 대응)
    gl.setPixelRatio(isHeavy ? 1 : Math.min(window.devicePixelRatio, 1.5));
  }, [status, gl]);

  return null;
};

export default function SpaceField() {
  // 상태 구독 (블룸 효과 제어용)
  const status = useTransferStore(state => state.status);
  const isHeavyLoad = status === 'TRANSFERRING' || status === 'RECEIVING';

  return (
    <div className="fixed inset-0 w-full h-full bg-black -z-50 pointer-events-none">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 60, near: 0.1, far: 200 }}
        gl={{
          antialias: false,
          powerPreference: 'high-performance',
          alpha: false,
          stencil: false,
          depth: false, // 2D 배경 효과이므로 Depth Buffer 꺼서 성능 향상
        }}
      >
        <SceneManager />
        <color attach="background" args={['#000000']} />
        <WarpStars />

        {/* 🚀 [최적화] 무거운 전송 중에는 Bloom 효과의 강도를 낮추거나 샘플링을 줄임 */}
        <EffectComposer enabled={!isHeavyLoad} enableNormalPass={false}>
          <Bloom
            luminanceThreshold={0.2}
            mipmapBlur
            intensity={1.2}
            radius={0.6}
          />
        </EffectComposer>
      </Canvas>
    </div>
  );
}
