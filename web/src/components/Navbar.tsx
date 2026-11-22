"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, Coins, Compass, Layers } from "lucide-react";
import { API_BASE_URL } from "@/lib/api";

interface HealthStatus {
  status: string;
  last_market_date: string | null;
}

const NAV_ITEMS = [
  {
    href: "/",
    label: "Decision Engine",
    icon: Compass,
  },
  {
    href: "/vs-gold",
    label: "Assets vs. Gold",
    icon: Coins,
  },
  {
    href: "/sectors",
    label: "Fiscal & Sector Flows",
    icon: Layers,
  },
] as const;

export function Navbar() {
  const pathname = usePathname();
  const [lastMarketDate, setLastMarketDate] = useState<string | null>(null);

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
        // Ignore transient network errors when backend is starting or offline
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <nav className="sticky top-0 z-40 border-b border-slate-800/90 bg-slate-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-[1440px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-8">
        <Link
          href="/"
          className="flex items-center gap-2.5 text-sm font-bold tracking-tight text-white transition hover:text-sky-300"
        >
          <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-sky-500/40 bg-sky-500/15 text-sky-400">
            <Activity className="h-4 w-4" />
          </span>
          <div className="leading-tight">
            <span className="block">Macro Capital-Flow</span>
            <span className="block text-[10px] font-semibold uppercase tracking-widest text-slate-400">
              Decision Terminal
            </span>
          </div>
        </Link>

        <div className="flex flex-wrap items-center gap-2.5">
          <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-slate-800 bg-slate-900/70 p-1">
            {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
              const isActive =
                href === "/" ? pathname === "/" : pathname.startsWith(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold transition ${
                    isActive
                      ? "bg-sky-500/20 text-sky-300 ring-1 ring-sky-500/40"
                      : "text-slate-400 hover:bg-slate-800/80 hover:text-slate-100"
                  }`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  <span>{label}</span>
                </Link>
              );
            })}
          </div>

          <span
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/70 px-2.5 py-1.5 font-mono text-[11px] text-slate-300"
            title="Latest market observation persisted in SQLite"
          >
            <span
              className={`h-1.5 w-1.5 rounded-full ${
                lastMarketDate ? "bg-emerald-400" : "bg-slate-500"
              }`}
            />
            <span>Synced: {lastMarketDate ?? "—"}</span>
          </span>
        </div>
      </div>
    </nav>
  );
}
