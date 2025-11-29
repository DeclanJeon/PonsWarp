import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import { useTransferStore } from '../store/transferStore';
import { AppMode } from '../types';

// 설정 상수
const STAR_COUNT = 2000;
const STAR_SIZE = 0.05;
const Z_BOUND = 40;
const WARP_SPEED = 2.5;
const IDLE_SPEED = 0.05;
const ACCELERATION = 0.02;
const STRETCH_FACTOR = 15;
const CHROMATIC_INTENSITY = 0.05;

/**
 * 🌟 WarpStars: InstancedMesh를 사용한 고성능 워프 효과
 */
const WarpStars = () => {
  const meshRef = useRef<THREE.InstancedMesh>(null);
  
  // 상태 구독
  const status = useTransferStore((state) => state.status);
  const mode = useTransferStore((state) => state.mode);
  
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
      data[i4] = r * Math.cos(theta);     // x
      data[i4 + 1] = r * Math.sin(theta); // y
      data[i4 + 2] = (Math.random() - 0.5) * Z_BOUND * 2; // z
      data[i4 + 3] = 0.5 + Math.random() * 0.5; // random scale
    }
    return data;
  }, []);
  
  // 현재 속도 상태
  const currentSpeed = useRef(IDLE_SPEED);
  
  useFrame((state, delta) => {
    if (!meshRef.current) return;
    
    // 목표 속도 및 방향 결정
    let targetSpeed = IDLE_SPEED;
    
    if (status === 'TRANSFERRING' || status === 'CONNECTING') {
      // Receiver: 음수 속도 (뿜어져 나옴)
      // Sender: 양수 속도 (빨려 들어감)
      const direction = mode === AppMode.RECEIVER ? -1 : 1;
      targetSpeed = WARP_SPEED * direction;
    } else if (status === 'DRAGGING_FILES') {
      targetSpeed = 0.5;
    }
    
    // 속도 Lerp
    const lerpFactor = ACCELERATION * (delta * 60);
    currentSpeed.current = THREE.MathUtils.lerp(currentSpeed.current, targetSpeed, lerpFactor);
    
    // 인스턴스 업데이트
    const speed = currentSpeed.current;
    const absSpeed = Math.abs(speed);
    
    for (let i = 0; i < STAR_COUNT; i++) {
      const i4 = i * 4;
      let x = initialData[i4];
      let y = initialData[i4 + 1];
      let z = initialData[i4 + 2];
      const scaleBase = initialData[i4 + 3];
      
      // Z축 이동
      z += speed * 20 * delta;
      
      // 경계 처리
      if (z > Z_BOUND) {
        z -= Z_BOUND * 2;
      } else if (z < -Z_BOUND) {
        z += Z_BOUND * 2;
      }
      
      initialData[i4 + 2] = z;
      
      // 변환 적용
      dummy.position.set(x, y, z);
      
      // 스케일링 (Streaking Effect)
      const zScale = 1 + (absSpeed * STRETCH_FACTOR);
      dummy.scale.set(scaleBase, scaleBase, scaleBase * zScale);
      dummy.updateMatrix();
      meshRef.current.setMatrixAt(i, dummy.matrix);
      
      // 색상 페이딩
      const dist = Math.abs(z);
      const intensity = 1 - (dist / Z_BOUND);
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
    if (meshRef.current.instanceColor) meshRef.current.instanceColor.needsUpdate = true;
  });
  
  return (
    <instancedMesh
      ref={meshRef}
      args={[undefined, undefined, STAR_COUNT]}
      frustumCulled={false}
    >
      <sphereGeometry args={[STAR_SIZE, 8, 8]} />
      <meshBasicMaterial 
        color={[1.5, 2, 3]} 
        toneMapped={false}
      />
    </instancedMesh>
  );
};



export default function SpaceField() {
  return (
    <div className="fixed inset-0 w-full h-full bg-black -z-50 pointer-events-none">
      <Canvas
        camera={{ position: [0, 0, 5], fov: 60, near: 0.1, far: 200 }}
        gl={{ 
          antialias: false, 
          powerPreference: "high-performance",
          alpha: false
        }}
        dpr={[1, 1.5]}
      >
        <color attach="background" args={['#000000']} />
        <WarpStars />
        
        <EffectComposer enableNormalPass={false}>
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