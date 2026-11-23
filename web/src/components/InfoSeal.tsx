"use client";

import React, { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import { playInkStamp } from "@/lib/archivalAudio";

export interface InfoSealProps {
  title: string;
  summary: string;
  howToRead?: string;
  align?: "right" | "left";
  className?: string;
}

export function InfoSeal({
  title,
  summary,
  howToRead,
  align = "right",
  className = "",
}: InfoSealProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  return (
    <div
      ref={containerRef}
      className={`relative inline-flex ${className}`}
      onClick={(e) => e.stopPropagation()}
    >
      <motion.button
        type="button"
        aria-label={`Explain ${title}`}
        aria-expanded={open}
        whileTap={{ scale: 0.9 }}
        onClick={() => {
          playInkStamp();
          setOpen((prev) => !prev);
        }}
        className={`flex h-6 w-6 items-center justify-center rounded-full border font-display text-[13px] font-semibold italic leading-none transition ${
          open
            ? "border-[#9E2A2B] bg-[#9E2A2B] text-[#FAF4E6] shadow-sm"
            : "border-[#2A2118] bg-[#FAF4E6] text-[#1C1610] ring-1 ring-inset ring-[#A8967A] hover:border-[#B5892E] hover:text-[#9E2A2B]"
        }`}
      >
        i
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="dialog"
            aria-label={title}
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
            className={`absolute top-8 z-50 w-72 border border-[#2A2118] bg-[#FAF4E6] p-3.5 text-left text-[#1C1610] shadow-[inset_0_0_0_2px_#FAF4E6,inset_0_0_0_3px_#A8967A,0_16px_32px_-12px_rgba(28,22,16,0.38)] sm:w-80 ${
              align === "right" ? "right-0" : "left-0"
            }`}
          >
            <div className="mb-1.5 flex items-start justify-between gap-2 border-b border-[#C8B9A0] pb-1.5">
              <h4 className="font-display text-sm font-bold tracking-wide text-[#1C1610]">
                {title}
              </h4>
              <button
                type="button"
                aria-label="Close explanation"
                onClick={() => setOpen(false)}
                className="rounded-sm p-0.5 text-[#594A3C] transition hover:text-[#9E2A2B]"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
            <p className="font-serif text-[13px] leading-relaxed text-[#1C1610]">
              {summary}
            </p>
            {howToRead && (
              <p className="mt-2 border-t border-dashed border-[#C8B9A0] pt-2 font-serif text-[12px] italic leading-relaxed text-[#594A3C]">
                {howToRead}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
