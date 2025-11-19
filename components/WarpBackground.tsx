import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import * as THREE from 'three';

const StarField = ({ count = 4000, warpActive = false }) => {
  const mesh = useRef<THREE.Points>(null);
  
  const particles = useMemo(() => {
    const temp = [];
    for (let i = 0; i < count; i++) {
      const x = (Math.random() - 0.5) * 2000;
      const y = (Math.random() - 0.5) * 2000;
      const z = (Math.random() - 0.5) * 2000;
      temp.push(x, y, z);
    }
    return new Float32Array(temp);
  }, [count]);

  useFrame((state, delta) => {
    if (mesh.current) {
      // Rotation
      mesh.current.rotation.z += delta * (warpActive ? 0.5 : 0.05);
      
      // Warp effect: Move particles towards camera
      const positions = mesh.current.geometry.attributes.position.array as Float32Array;
      const speed = warpActive ? 400 : 10;
      
      for (let i = 2; i < positions.length; i += 3) {
        positions[i] += speed * delta; // Move along Z
        
        // Reset if too close
        if (positions[i] > 500) {
          positions[i] = -1500;
          // Randomize X/Y slightly on reset for variety
          positions[i-2] = (Math.random() - 0.5) * 2000;
          positions[i-1] = (Math.random() - 0.5) * 2000;
        }
      }
      mesh.current.geometry.attributes.position.needsUpdate = true;
    }
  });

  return (
    <points ref={mesh}>
      <bufferGeometry>
        <bufferAttribute
          attach="attributes-position"
          count={particles.length / 3}
          array={particles}
          itemSize={3}
        />
      </bufferGeometry>
      <pointsMaterial
        size={warpActive ? 4 : 1.5}
        color={warpActive ? "#00ffff" : "#ffffff"}
        transparent
        opacity={0.8}
        sizeAttenuation
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

const WarpBackground: React.FC<WarpBackgroundProps> = ({ intensity = 'low' }) => {
  const warpActive = intensity === 'hyper' || intensity === 'high';

  return (
    <div className="fixed inset-0 z-[-1] bg-black">
      <Canvas camera={{ position: [0, 0, 50], fov: 75 }}>
        <color attach="background" args={['#000000']} />
        <fog attach="fog" args={['#000000', 100, 1000]} />
        <StarField count={6000} warpActive={warpActive} />
        <WarpTunnel warpActive={warpActive} />
        
        {/* Radial Burst Core for Warp Effect */}
        {warpActive && (
            <mesh position={[0, 0, -800]}>
                <sphereGeometry args={[50, 32, 32]} />
                <meshBasicMaterial color="#00ffff" transparent opacity={0.5} />
            </mesh>
        )}
      </Canvas>
      {/* Vignette and Color Grade */}
      <div className={`absolute inset-0 pointer-events-none transition-colors duration-1000 ${warpActive ? 'bg-cyan-900/20' : 'bg-transparent'}`} />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_center,transparent_0%,black_100%)] pointer-events-none" />
    </div>
  );
};

export default WarpBackground;