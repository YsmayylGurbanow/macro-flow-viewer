"use client";

import React, { useRef, useState } from "react";
import {
  AnimatePresence,
  motion,
  useMotionValue,
  useSpring,
  useTransform,
} from "framer-motion";

interface InkRipple {
  id: number;
  x: number;
  y: number;
}

export interface MotionPlateProps {
  children: React.ReactNode;
  className?: string;
  onClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
  interactive?: boolean;
}

export function MotionPlate({
  children,
  className = "",
  onClick,
  interactive,
}: MotionPlateProps) {
  const isInteractive = interactive ?? Boolean(onClick);
  const mouseX = useMotionValue(0.5);
  const mouseY = useMotionValue(0.5);
  const [hovered, setHovered] = useState(false);
  const [sheenPos, setSheenPos] = useState({ x: 50, y: 50 });
  const [ripples, setRipples] = useState<InkRipple[]>([]);
  const nextRippleId = useRef(0);

  const springConfig = { stiffness: 220, damping: 24, mass: 0.6 };
  const smoothX = useSpring(mouseX, springConfig);
  const smoothY = useSpring(mouseY, springConfig);

  const rotateX = useTransform(smoothY, [0, 1], [2.6, -2.6]);
  const rotateY = useTransform(smoothX, [0, 1], [-2.6, 2.6]);

  const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const nx = (event.clientX - rect.left) / rect.width;
    const ny = (event.clientY - rect.top) / rect.height;
    mouseX.set(nx);
    mouseY.set(ny);
    setSheenPos({ x: nx * 100, y: ny * 100 });
  };

  const handleMouseLeave = () => {
    setHovered(false);
    mouseX.set(0.5);
    mouseY.set(0.5);
  };

  const handleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (isInteractive) {
      const rect = event.currentTarget.getBoundingClientRect();
      const x =
        event.clientX > 0
          ? event.clientX - rect.left
          : rect.width * 0.5;
      const y =
        event.clientY > 0
          ? event.clientY - rect.top
          : rect.height * 0.5;
      const id = ++nextRippleId.current;
      setRipples((prev) => [...prev.slice(-2), { id, x, y }]);
    }
    onClick?.(event);
  };

  return (
    <motion.div
      onMouseEnter={() => setHovered(true)}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      style={{
        rotateX,
        rotateY,
        transformPerspective: 900,
      }}
      whileHover={{ y: -2 }}
      whileTap={isInteractive ? { scale: 0.97 } : undefined}
      transition={{ duration: 0.18, ease: "easeOut" }}
      className={`ledger-plate relative ${className}`}
    >
      {/* Sheen + concentric ink ripples stay inside an overflow-hidden overlay so InfoSeal popovers are never clipped */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 overflow-hidden"
      >
        <div
          className="absolute inset-0 transition-opacity duration-300"
          style={{
            opacity: hovered ? 1 : 0,
            background: `radial-gradient(280px circle at ${sheenPos.x}% ${sheenPos.y}%, rgba(181, 137, 46, 0.16), rgba(250, 244, 230, 0.04) 55%, transparent 80%)`,
          }}
        />
        <AnimatePresence>
          {ripples.map((ripple) => (
            <React.Fragment key={ripple.id}>
              <motion.span
                initial={{ scale: 0.15, opacity: 0.72 }}
                animate={{ scale: 3.4, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.52, ease: [0.22, 1, 0.36, 1] }}
                onAnimationComplete={() =>
                  setRipples((prev) => prev.filter((item) => item.id !== ripple.id))
                }
                style={{ left: ripple.x - 56, top: ripple.y - 56 }}
                className="absolute h-28 w-28 rounded-full border border-[#9E2A2B]/65 bg-[#B5892E]/10"
              />
              <motion.span
                initial={{ scale: 0.1, opacity: 0.6 }}
                animate={{ scale: 2.35, opacity: 0 }}
                exit={{ opacity: 0 }}
                transition={{
                  duration: 0.46,
                  delay: 0.04,
                  ease: [0.22, 1, 0.36, 1],
                }}
                style={{ left: ripple.x - 40, top: ripple.y - 40 }}
                className="absolute h-20 w-20 rounded-full border border-[#B5892E]/75"
              />
            </React.Fragment>
          ))}
        </AnimatePresence>
      </div>
      <div className="relative z-10 h-full">{children}</div>
    </motion.div>
  );
}
