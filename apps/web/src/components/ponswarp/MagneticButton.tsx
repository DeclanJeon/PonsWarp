"use client";

import { useRef, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";

type Props = {
  children: React.ReactNode;
  onClick?: () => void;
  className?: string;
  type?: "button" | "submit";
  disabled?: boolean;
};

export function MagneticButton({ children, onClick, className = "", type = "button", disabled }: Props) {
  const ref = useRef<HTMLButtonElement>(null);
  const reduce = useReducedMotion();
  const [position, setPosition] = useState({ x: 0, y: 0 });

  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={disabled}
      onClick={onClick}
      onMouseMove={(e) => {
        if (!ref.current || disabled || reduce) return;
        const { clientX, clientY } = e;
        const { left, top, width, height } = ref.current.getBoundingClientRect();
        setPosition({ x: (clientX - (left + width / 2)) * 0.22, y: (clientY - (top + height / 2)) * 0.22 });
      }}
      onMouseLeave={() => setPosition({ x: 0, y: 0 })}
      animate={reduce ? undefined : { x: position.x, y: position.y }}
      transition={{ type: "spring", stiffness: 160, damping: 16, mass: 0.12 }}
      className={`group relative overflow-hidden ${className}`}
    >
      <div className="absolute inset-0 bg-gradient-to-r from-cyan-500 to-purple-600 opacity-0 transition-opacity duration-300 group-hover:opacity-20" />
      <span className="relative z-10 flex items-center justify-center gap-2">{children}</span>
      {!reduce ? (
        <div className="absolute top-0 -inset-full z-[5] block h-full w-1/2 -skew-x-12 bg-gradient-to-r from-transparent to-white opacity-40 group-hover:animate-shine" />
      ) : null}
    </motion.button>
  );
}
