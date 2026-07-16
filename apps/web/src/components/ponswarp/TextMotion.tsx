"use client";

import { motion, useReducedMotion } from "framer-motion";

type LineProps = {
  text: string;
  className?: string;
  delay?: number;
  gradient?: boolean;
};

export function MotionLine({ text, className = "", delay = 0, gradient = false }: LineProps) {
  const reduce = useReducedMotion();
  const words = text.split(" ");

  if (reduce) {
    return <span className={className}>{text}</span>;
  }

  return (
    <span className={`inline-flex flex-wrap justify-center gap-x-[0.28em] ${className}`}>
      {words.map((word, i) => (
        <motion.span
          key={`${word}-${i}`}
          initial={{ opacity: 0, y: 28, filter: "blur(8px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.7, delay: delay + i * 0.08, ease: [0.22, 1, 0.36, 1] }}
          className={
            gradient
              ? "animate-gradient-x bg-gradient-to-r from-cyan-300 via-white to-purple-400 bg-[length:200%_auto] bg-clip-text text-transparent"
              : "inline-block"
          }
        >
          {word}
        </motion.span>
      ))}
    </span>
  );
}

type CharProps = {
  text: string;
  className?: string;
  delay?: number;
};

export function MotionChars({ text, className = "", delay = 0 }: CharProps) {
  const reduce = useReducedMotion();
  if (reduce) return <span className={className}>{text}</span>;

  return (
    <span className={`inline-block ${className}`} aria-label={text}>
      {text.split("").map((ch, i) => (
        <motion.span
          key={`${ch}-${i}`}
          initial={{ opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: delay + i * 0.03, ease: "easeOut" }}
          className="inline-block"
          style={{ whiteSpace: ch === " " ? "pre" : undefined }}
        >
          {ch}
        </motion.span>
      ))}
    </span>
  );
}

export function FadeUp({
  children,
  delay = 0,
  className = "",
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  const reduce = useReducedMotion();
  if (reduce) return <div className={className}>{children}</div>;
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.55, delay, ease: [0.22, 1, 0.36, 1] }}
      className={className}
    >
      {children}
    </motion.div>
  );
}
