"use client";

import React, { useContext, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { LayoutRouterContext } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { playPaperTurn } from "@/lib/archivalAudio";

export const folioStaggerContainer: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: {
      staggerChildren: 0.06,
      delayChildren: 0.03,
    },
  },
};

export const folioStaggerItem: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.99 },
  visible: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: "spring",
      stiffness: 240,
      damping: 26,
      mass: 0.85,
    },
  },
};

function normalizePath(raw: string | null): string {
  if (!raw || raw === "/") return "/";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}

/**
 * Preserves the App Router subtree snapshot for the exiting view while
 * AnimatePresence plays its exit transition, preventing abrupt content swaps.
 */
function FrozenRouter({ children }: { children: React.ReactNode }) {
  const context = useContext(LayoutRouterContext);
  const frozen = useRef(context).current;

  if (!frozen) {
    return <>{children}</>;
  }

  return (
    <LayoutRouterContext.Provider value={frozen}>
      {children}
    </LayoutRouterContext.Provider>
  );
}

const folioVariants: Variants = {
  initial: {
    opacity: 0,
    y: 12,
    scale: 0.99,
  },
  enter: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: {
      type: "spring",
      stiffness: 240,
      damping: 26,
      mass: 0.82,
    },
  },
  exit: {
    opacity: 0,
    y: -14,
    scale: 0.98,
    transition: {
      duration: 0.22,
      ease: [0.4, 0, 0.2, 1],
    },
  },
};

export function FolioTransitionProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const normalizedPath = normalizePath(pathname);
  const prevPathRef = useRef<string>(normalizedPath);
  const [sweepKey, setSweepKey] = useState(0);

  useEffect(() => {
    if (prevPathRef.current !== normalizedPath) {
      prevPathRef.current = normalizedPath;
      setSweepKey((k) => k + 1);
      playPaperTurn();
    }
  }, [normalizedPath]);

  return (
    <div className="relative min-h-[calc(100vh-56px)]">
      {/* Engraved double-line Burnished Gold & Iron Gall sweep rule on route change */}
      <AnimatePresence>
        {sweepKey > 0 && (
          <motion.div
            key={`folio-rule-${sweepKey}`}
            aria-hidden="true"
            initial={{ opacity: 0.95 }}
            animate={{ opacity: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.65, ease: "easeOut" }}
            className="pointer-events-none fixed inset-x-0 top-[53px] z-40"
          >
            <motion.div
              initial={{ scaleX: 0, originX: 0 }}
              animate={{ scaleX: 1 }}
              transition={{ duration: 0.44, ease: [0.22, 1, 0.36, 1] }}
              className="mx-auto flex max-w-[1440px] flex-col gap-[3px] px-4 sm:px-6 lg:px-8"
            >
              <div className="h-[1.5px] w-full bg-gradient-to-r from-[#B5892E] via-[#9E2A2B] to-[#B5892E]" />
              <div className="h-[1px] w-full bg-[#2A2118]/75" />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence
        mode="wait"
        initial={false}
        onExitComplete={() => {
          if (typeof window !== "undefined") {
            window.scrollTo({ top: 0, behavior: "auto" });
          }
        }}
      >
        <motion.div
          key={normalizedPath}
          variants={folioVariants}
          initial="initial"
          animate="enter"
          exit="exit"
          className="will-change-transform"
        >
          <FrozenRouter>{children}</FrozenRouter>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
