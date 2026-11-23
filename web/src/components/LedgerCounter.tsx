"use client";

import React, { useEffect } from "react";
import { motion, useMotionValue, useSpring, useTransform } from "framer-motion";

export interface LedgerCounterProps {
  value: number | null | undefined;
  decimals?: number;
  prefix?: string;
  suffix?: string;
  signed?: boolean;
  fallback?: string;
  className?: string;
}

function formatCounterValue(
  raw: number,
  decimals: number,
  prefix: string,
  suffix: string,
  signed: boolean,
): string {
  const threshold = Math.pow(10, -(decimals + 1));
  const clean = Math.abs(raw) < threshold ? 0 : raw;
  const fixed = clean.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
  const signPrefix = signed && clean > 0 ? "+" : "";
  return `${signPrefix}${prefix}${fixed}${suffix}`;
}

export function LedgerCounter({
  value,
  decimals = 0,
  prefix = "",
  suffix = "",
  signed = false,
  fallback = "—",
  className = "",
}: LedgerCounterProps) {
  const isValid =
    typeof value === "number" && Number.isFinite(value) && !Number.isNaN(value);
  const target = isValid ? value : 0;

  // Start near zero on first mount for a brief mechanical odometer roll-up,
  // then track subsequent target changes smoothly from the current value.
  const motionVal = useMotionValue(0);
  const springVal = useSpring(motionVal, {
    stiffness: 135,
    damping: 22,
    mass: 0.75,
  });

  const display = useTransform(springVal, (latest) =>
    formatCounterValue(latest, decimals, prefix, suffix, signed),
  );

  useEffect(() => {
    if (isValid) {
      motionVal.set(target);
    }
  }, [isValid, target, motionVal]);

  if (!isValid) {
    return (
      <span className={`tabular-nums ${className}`.trim()}>{fallback}</span>
    );
  }

  return (
    <motion.span className={`tabular-nums ${className}`.trim()}>
      {display}
    </motion.span>
  );
}
