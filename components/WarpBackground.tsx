import React, { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const StarField = ({ count = 8000, warpActive = false }) => {
  const mesh = useRef<THREE.Points>(null);
  
  // 🚀 [최적화] 별의 위치와 크기 초기화 (직접 계산)
  const pos = new Float32Array(count * 3);
  const sz = new Float32Array(count);
  
  for (let i = 0; i < count; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 2000;     // x
    pos[i * 3 + 1] = (Math.random() - 0.5) * 2000; // y
    pos[i * 3 + 2] = (Math.random() - 0.5) * 2000; // z
    sz[i] = Math.random() * 1.5 + 0.5;
  }
  
  const particles = pos;
  const sizes = sz;

  useFrame((state, delta) => {
    if (!mesh.current) return;
    
    // 🚀 [Magician Archetype] 워프 모드일 때 속도 증가 (변형)
    const currentSpeed = warpActive ? 400 : 10;
    
    // Z축으로 이동하며 워프 효과 구현
    const positions = mesh.current.geometry.attributes.position.array as Float32Array;
    for (let i = 2; i < positions.length; i += 3) {
      positions[i] += currentSpeed * delta;
      
      // 카메라 뒤로 넘어가면 다시 앞으로 이동 (무한 루프)
      if (positions[i] > 500) {
        positions[i] = -1500;
        // 다양성을 위해 X/Y 위치 재설정
        positions[i - 2] = (Math.random() - 0.5) * 2000;
        positions[i - 1] = (Math.random() - 0.5) * 2000;
      }
    }
    mesh.current.geometry.attributes.position.needsUpdate = true;
    
    // 🚀 [마우스 반응성] 전체 별무리의 미세한 회전으로 공간감 부여 (Parallax)
    const { mouse } = state;
    mesh.current.rotation.x += (mouse.y * 0.05 - mesh.current.rotation.x) * 0.05;
    mesh.current.rotation.y += (mouse.x * 0.05 - mesh.current.rotation.y) * 0.05;
  });

  return (
    <points ref={mesh}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={particles.length / 3}
          array={pos}
          itemSize={3}
        />
        <bufferAttribute
          attach="attributes-size"
          count={sizes.length}
          array={sz}
          itemSize={1}
        />
      </bufferGeometry>
      <pointsMaterial
        size={warpActive ? 3 : 2}
        color={warpActive ? "#00ffff" : "#ffffff"}
        transparent
        opacity={0.8}
        sizeAttenuation
        blending={THREE.AdditiveBlending}
        depthWrite={false}
      />
    </points>
  );
};

const WarpTunnel = ({ warpActive = false }) => {
  const mesh = useRef<THREE.Mesh>(null);

  useFrame((state, delta) => {
    if (mesh.current) {
        mesh.current.rotation.z -= delta * (warpActive ? 2 : 0.2);
    }
  });

  return (
      <mesh ref={mesh} rotation={[Math.PI / 2, 0, 0]} position={[0, 0, -500]}>
          <cylinderGeometry args={[20, 200, 2000, 32, 10, true]} />
          <meshBasicMaterial 
            color="#001133" 
            wireframe 
            transparent 
            opacity={warpActive ? 0.3 : 0.05} 
            side={THREE.BackSide} 
          />
      </mesh>
  )
}

interface WarpBackgroundProps {
  intensity?: 'low' | 'high' | 'hyper';
}

/**
 * WarpBackground - 몰입형 3D 배경 컴포넌트
 * 
 * 🚀 [브랜드 심리학] Magician & Explorer 아키타입 적용
 * - 마법사: 변형과 경이로움 (워프 효과)
 * - 탐험가: 자유와 발견 (우주 공간)
 */
const WarpBackground: React.FC<WarpBackgroundProps> = ({ intensity = 'low' }) => {
  const warpActive = intensity === 'hyper' || intensity === 'high';

  return (
    <div className="fixed inset-0 z-[-1] bg-black">
      <Canvas camera={{ position: [0, 0, 50], fov: 75 }}>
        <color attach="background" args={['#000000']} />
        <fog attach="fog" args={['#000000', 100, 1000]} />
        
        {/* 🌌 Interactive Star Field with Mouse Parallax */}
        <StarField count={8000} warpActive={warpActive} />
        
        {/* 🌀 Warp Tunnel Effect */}
        <WarpTunnel warpActive={warpActive} />
        
        {/* ✨ Radial Burst Core for Hyper Warp */}
        {warpActive && (
          <mesh position={[0, 0, -800]}>
            <sphereGeometry args={[50, 32, 32]} />
            <meshBasicMaterial 
              color="#00ffff" 
              transparent 
              opacity={0.5}
              blending={THREE.AdditiveBlending}
            />
          </mesh>
        )}
      </Canvas>
      
      {/* 🎨 Post-Processing Overlays */}
      <div className={`absolute inset-0 pointer-events-none transition-colors duration-1000 ${warpActive ? 'bg-cyan-900/20' : 'bg-transparent'}`} />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,black_100%)] pointer-events-none" />
    </div>
  );
};

export default WarpBackground;