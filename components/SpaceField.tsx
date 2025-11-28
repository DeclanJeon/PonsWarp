// src/components/SpaceField.tsx
import { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Points, PointMaterial } from '@react-three/drei';
import { EffectComposer, Bloom } from '@react-three/postprocessing';
import * as THREE from 'three';
import { useTransferStore } from '../store/transferStore';

/**
 * 🌠 WarpStars: 워프 드라이브 효과를 구현한 커스텀 셰이더 입자 시스템
 */
function WarpStars() {
  const ref = useRef<THREE.Points>(null!);
  // Zustand에서 상태 구독 (전송 중일 때 워프 효과 활성화)
  const status = useTransferStore((state) => state.status);
  
  // 상태에 따른 목표 속도 정의
  const targetSpeed = useMemo(() => {
    switch (status) {
      case 'TRANSFERRING': return 2.0; // 워프 속도 (매우 빠름)
      case 'CONNECTING': return 0.5;   // 준비 속도
      case 'DRAGGING_FILES': return 0.3; // 드래그 속도
      default: return 0.02;            // 대기 속도 (순항)
    }
  }, [status]);

  // 입자 데이터 생성 (위치, 개별 속성)
  const [positions, randoms] = useMemo(() => {
    const count = 10000; // 별의 개수
    const pos = new Float32Array(count * 3);
    const rnd = new Float32Array(count);

    for (let i = 0; i < count; i++) {
      // X, Y는 넓게 분포, Z는 깊이감 있게 배치
      const r = 400; // 반경
      const theta = 2 * Math.PI * Math.random();
      const phi = Math.acos(2 * Math.random() - 1);
      
      const x = r * Math.sin(phi) * Math.cos(theta);
      const y = r * Math.sin(phi) * Math.sin(theta);
      const z = (Math.random() - 0.5) * 2000; // -1000 ~ 1000 깊이

      pos[i * 3] = x;
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = z;

      rnd[i] = Math.random();
    }
    return [pos, rnd];
  }, []);

  // 커스텀 셰이더 정의
  const shaderArgs = useMemo(() => ({
    uniforms: {
      uTime: { value: 0 },
      uSpeed: { value: 0 },     // 현재 속도
      uOpacity: { value: 1.0 }, // 투명도
      uColor: { value: new THREE.Color('#4fbdff') } // 기본 청록색
    },
    vertexShader: `
      uniform float uTime;
      uniform float uSpeed;
      attribute float aRandom;
      
      varying float vAlpha;
      varying vec3 vColor;

      void main() {
        vec3 pos = position;
        
        // 🚀 핵심: 무한 루프 로직 (z축 이동 및 반복)
        // uTime * 100.0 * (uSpeed + 0.1) 만큼 이동
        // mod 연산으로 -1000 ~ 1000 구간 반복
        float zOffset = uTime * 200.0 * (uSpeed * 5.0 + 0.05);
        pos.z = mod(position.z + zOffset, 2000.0) - 1000.0;

        vec4 mvPosition = modelViewMatrix * vec4(pos, 1.0);
        
        // 🌠 워프 효과: 속도가 빠를수록 Z축으로 길어지는 스트레치 효과
        // 카메라와의 거리에 따라 크기 조절
        gl_Position = projectionMatrix * mvPosition;
        
        // 속도에 따라 입자 크기 변화
        gl_PointSize = (4.0 + uSpeed * 10.0) * (300.0 / -mvPosition.z);
        
        // 멀어지거나 너무 가까우면 투명하게
        float dist = length(mvPosition.xyz);
        vAlpha = smoothstep(1000.0, 800.0, dist) * smoothstep(5.0, 100.0, dist);
        
        // 속도가 빠르면 색상을 흰색->파란색->보라색으로 시프트
        vColor = mix(vec3(1.0), vec3(0.3, 0.8, 1.0), uSpeed);
      }
    `,
    fragmentShader: `
      uniform vec3 uColor;
      varying float vAlpha;
      varying vec3 vColor;

      void main() {
        // 원형 입자 그리기
        float r = distance(gl_PointCoord, vec2(0.5));
        if (r > 0.5) discard;
        
        // 중심이 밝고 외곽이 흐린 Glow 효과
        float glow = 1.0 - (r * 2.0);
        glow = pow(glow, 1.5);

        gl_FragColor = vec4(vColor, vAlpha * glow);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending
  }), []);

  useFrame((state, delta) => {
    if (!ref.current) return;
    
    // 셰이더 유니폼 업데이트
    const material = ref.current.material as THREE.ShaderMaterial;
    material.uniforms.uTime.value = state.clock.elapsedTime;
    
    // 속도 부드럽게 보간 (Lerp)
    material.uniforms.uSpeed.value = THREE.MathUtils.lerp(
      material.uniforms.uSpeed.value,
      targetSpeed,
      delta * 2.0 // 반응 속도
    );
  });

  return (
    <Points ref={ref} positions={positions} stride={3} frustumCulled={false}>
      <shaderMaterial attach="material" args={[shaderArgs]} />
    </Points>
  );
}

export default function SpaceField() {
  return (
    <div className="fixed inset-0 w-full h-full bg-black -z-50 pointer-events-none">
      <Canvas 
        camera={{ position: [0, 0, 10], fov: 60 }} 
        gl={{ antialias: false, powerPreference: "high-performance" }}
        dpr={[1, 2]} // 픽셀 비율 최적화
      >
        <color attach="background" args={['#000000']} />
        
        {/* 별 입자 시스템 */}
        <WarpStars />
        
        {/* ✨ Bloom 효과: 밝은 별이 빛나도록 처리 */}
        <EffectComposer enableNormalPass={false}>
          <Bloom
            luminanceThreshold={0.2}
            mipmapBlur
            intensity={1.5}
            radius={0.6}
          />
        </EffectComposer>
      </Canvas>
    </div>
  );
}