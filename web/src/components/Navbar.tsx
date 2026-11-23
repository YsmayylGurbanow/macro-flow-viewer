"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Volume2, VolumeX } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";
import {
  isAudioMuted,
  playBrassTick,
  subscribeAudioMute,
  toggleAudioMuted,
} from "@/lib/archivalAudio";

interface HealthStatus {
  status: string;
  last_market_date: string | null;
}

const NAV_ITEMS = [
  { href: "/", label: "Decision Engine" },
  { href: "/vs-gold", label: "Assets vs. Gold" },
  { href: "/sectors", label: "Fiscal & Sector Flows" },
] as const;

function normalizePath(raw: string | null): string {
  if (!raw || raw === "/") return "/";
  const trimmed = raw.replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "/";
}

export function Navbar() {
  const pathname = normalizePath(usePathname());
  const [lastMarketDate, setLastMarketDate] = useState<string | null>(null);
  const [muted, setMuted] = useState<boolean>(false);

  useEffect(() => {
    setMuted(isAudioMuted());
    return subscribeAudioMute(() => {
      setMuted(isAudioMuted());
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch(`${API_BASE_URL}/api/health`, { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: HealthStatus | null) => {
        if (!cancelled && data?.last_market_date) {
          setLastMarketDate(data.last_market_date);
        }
      })
      .catch(() => {
        // Ignore transient network errors while backend starts
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleToggleSound = () => {
    const nextMuted = toggleAudioMuted();
    setMuted(nextMuted);
  };

  return (
    <nav className="sticky top-0 z-30 border-b border-[#2A2118] bg-[#F2E8D5]/95 shadow-[0_1px_0_0_#A8967A] backdrop-blur-sm">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-2.5 sm:px-6 lg:px-8">
        <Link
          href="/"
          onClick={() => playBrassTick()}
          className="group flex items-center gap-2.5 text-[#1C1610] transition hover:text-[#9E2A2B]"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-full border border-[#2A2118] bg-[#FAF4E6] ring-1 ring-inset ring-[#A8967A] font-script text-xl leading-none text-[#9E2A2B] transition-transform duration-200 group-hover:scale-105">
            P
          </span>
          <span className="font-display text-base font-semibold uppercase tracking-[0.14em] text-[#1C1610] group-hover:text-[#9E2A2B]">
            Playfair Archival Ledger
          </span>
        </Link>

        <div className="flex flex-wrap items-center gap-4 sm:gap-5">
          <div className="flex flex-wrap items-center gap-4 sm:gap-6">
            {NAV_ITEMS.map(({ href, label }) => {
              const isActive =
                href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => {
                    if (!isActive) playBrassTick();
                  }}
                  className={`relative py-1.5 font-display text-sm font-semibold tracking-wide transition ${
                    isActive
                      ? "text-[#9E2A2B]"
                      : "text-[#594A3C] hover:text-[#1C1610]"
                  }`}
                >
                  <span>{label}</span>
                  {isActive && (
                    <motion.span
                      layoutId="active-ledger-ink"
                      transition={{
                        type: "spring",
                        stiffness: 380,
                        damping: 32,
                      }}
                      className="pointer-events-none absolute inset-x-0 -bottom-0.5 flex flex-col items-center"
                    >
                      <span className="relative h-[2px] w-full bg-[#9E2A2B]">
                        <span className="absolute left-1/2 top-1/2 h-1.5 w-1.5 -translate-x-1/2 -translate-y-1/2 rotate-45 border border-[#9E2A2B] bg-[#B5892E]" />
                      </span>
                    </motion.span>
                  )}
                </Link>
              );
            })}
          </div>

          <div className="flex items-center gap-2">
            <motion.button
              type="button"
              whileTap={{ scale: 0.92 }}
              onClick={handleToggleSound}
              aria-label={
                muted ? "Enable archival acoustics" : "Mute archival acoustics"
              }
              title={
                muted
                  ? "Sound Muted — Click to enable tactile acoustics"
                  : "Sound On — Click to mute tactile acoustics"
              }
              className={`inline-flex items-center gap-1 border px-2 py-1 font-mono text-[10px] uppercase tracking-wider transition ${
                muted
                  ? "border-[#A8967A] bg-[#F2E8D5] text-[#594A3C] hover:border-[#2A2118] hover:text-[#1C1610]"
                  : "border-[#2A2118] bg-[#FAF4E6] text-[#1C1610] shadow-[inset_0_0_0_1px_#FAF4E6,inset_0_0_0_2px_#C8B9A0] hover:border-[#B5892E]"
              }`}
            >
              {muted ? (
                <VolumeX className="h-3.5 w-3.5 text-[#594A3C]" />
              ) : (
                <Volume2 className="h-3.5 w-3.5 text-[#B5892E]" />
              )}
              <span className="hidden sm:inline">{muted ? "Mute" : "Sound"}</span>
            </motion.button>

            <span
              className="inline-flex items-center gap-1.5 border border-[#2A2118] bg-[#FAF4E6] px-2.5 py-1 font-mono text-[11px] text-[#594A3C] shadow-[inset_0_0_0_1px_#FAF4E6,inset_0_0_0_2px_#C8B9A0]"
              title="Latest market observation synced in SQLite"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${
                  lastMarketDate ? "bg-[#4F6D5A]" : "bg-[#A8967A]"
                }`}
              />
              <span>Synced: {lastMarketDate ?? "—"}</span>
            </span>
          </div>
        </div>
      </div>
    </nav>
  );
}
