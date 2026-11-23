"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  RefreshCw,
} from "lucide-react";
import {
  folioStaggerContainer,
  folioStaggerItem,
} from "@/components/FolioTransitionProvider";
import { InfoSeal } from "@/components/InfoSeal";
import { LedgerCounter } from "@/components/LedgerCounter";
import { MarkdownBrief } from "@/components/MarkdownBrief";
import { MotionPlate } from "@/components/MotionPlate";
import { ReactiveAtlasCanvas } from "@/components/ReactiveAtlasCanvas";
import { API_BASE_URL } from "@/lib/api";
import { playBrassTick, playInkStamp } from "@/lib/archivalAudio";

interface MacroRateRow {
  date: string;
  fed_funds: number;
  dgs10: number;
  yield_spread: number;
  regime_label: string;
}

interface SectorDecision {
  rank: number;
  ticker: string;
  sector_name: string;
  agency_code: string;
  agency_name: string;
  conviction_score: number;
  decision_tier: string;
  fiscal_score: number;
  regime_edge_score: number;
  valuation_score: number;
  fiscal_impulse_zscore: number | null;
  fiscal_impulse_label: string;
  latest_yoy_growth_pct: number | null;
  regime_label: string;
  win_rate_pct: number | null;
  avg_12m_vs_spy_pct: number | null;
  avg_12m_vs_gld_pct: number | null;
  gold_valuation_percentile: number | null;
  valuation_zone: string;
  etf_close: number | null;
}

interface RotationBrief {
  id: number;
  snapshot_date: string;
  top_sector: string;
  avoid_sector: string;
  summary_markdown: string;
  updated_at: string;
}

interface SignalSnapshotRow {
  id: number;
  snapshot_date: string;
  ticker: string;
  conviction_score: number;
  decision_tier: string;
  fiscal_impulse_zscore: number | null;
  regime_label: string;
  gold_valuation_percentile: number | null;
  etf_close: number | null;
}

interface DecisionsResponse {
  current_rate_regime: MacroRateRow | null;
  rankings: SectorDecision[];
  rotation_brief: RotationBrief;
  signal_snapshots: SignalSnapshotRow[];
}

interface SecularGoldPreview {
  asset_key: string;
  asset_name: string;
  latest_ratio: number;
  secular_percentile: number;
  valuation_zone: string;
}

function getTierBadgeStyle(tier: string): string {
  if (tier === "High Conviction") {
    return "border-[#4F6D5A] bg-[#4F6D5A]/15 text-[#2F4E3C]";
  }
  if (tier === "Crowded Momentum") {
    return "border-[#B5892E] bg-[#B5892E]/15 text-[#7D5C19]";
  }
  if (tier === "Value Trap") {
    return "border-[#2B5B6C] bg-[#2B5B6C]/15 text-[#1F4452]";
  }
  return "border-[#9E2A2B] bg-[#9E2A2B]/12 text-[#9E2A2B]";
}

function getImpulseBadgeStyle(label: string): string {
  if (label === "Accelerating") {
    return "border-[#4F6D5A] bg-[#4F6D5A]/15 text-[#2F4E3C]";
  }
  if (label === "Contracting") {
    return "border-[#9E2A2B] bg-[#9E2A2B]/12 text-[#9E2A2B]";
  }
  return "border-[#B5892E] bg-[#B5892E]/15 text-[#7D5C19]";
}

function getRegimeBadgeStyle(regime: string | null | undefined): string {
  if (regime === "Hiking") {
    return "border-[#9E2A2B] bg-[#9E2A2B]/12 text-[#9E2A2B]";
  }
  if (regime === "Cutting") {
    return "border-[#4F6D5A] bg-[#4F6D5A]/15 text-[#2F4E3C]";
  }
  if (regime === "High-Pause") {
    return "border-[#B5892E] bg-[#B5892E]/15 text-[#7D5C19]";
  }
  if (regime === "Low-Pause") {
    return "border-[#2B5B6C] bg-[#2B5B6C]/15 text-[#1F4452]";
  }
  return "border-[#A8967A] bg-[#FAF4E6] text-[#594A3C]";
}

function getScoreBarColor(score: number): string {
  if (score >= 65) return "bg-[#4F6D5A]";
  if (score >= 45) return "bg-[#2B5B6C]";
  if (score >= 30) return "bg-[#B5892E]";
  return "bg-[#9E2A2B]";
}

function formatZScore(z: number | null | undefined): string {
  if (z === null || z === undefined || Number.isNaN(z)) return "—";
  return `${z > 0 ? "+" : ""}${z.toFixed(2)}`;
}

function formatPct(val: number | null | undefined, signed = true): string {
  if (val === null || val === undefined || Number.isNaN(val)) return "—";
  const prefix = signed && val > 0 ? "+" : "";
  return `${prefix}${val.toFixed(1)}%`;
}

export default function DecisionEnginePage() {
  const router = useRouter();
  const portalTimerRef = useRef<number | null>(null);
  const [data, setData] = useState<DecisionsResponse | null>(null);
  const [goldPreview, setGoldPreview] = useState<SecularGoldPreview[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshingBrief, setRefreshingBrief] = useState<boolean>(false);
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadDecisions = useCallback(async () => {
    setLoading(true);
    try {
      const [decRes, goldRes] = await Promise.all([
        fetch(`${API_BASE_URL}/api/decisions`, { cache: "no-store" }),
        fetch(`${API_BASE_URL}/api/vs-gold`, { cache: "no-store" }).catch(
          () => null
        ),
      ]);

      if (!decRes.ok) {
        throw new Error(`GET /api/decisions returned HTTP ${decRes.status}`);
      }
      const decisions: DecisionsResponse = await decRes.json();
      setData(decisions);

      if (goldRes && goldRes.ok) {
        const assets: SecularGoldPreview[] = await goldRes.json();
        setGoldPreview(assets);
      }

      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `Unable to reach Rust API at ${API_BASE_URL}: ${err.message}`
          : `Unable to reach Rust API at ${API_BASE_URL}`
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDecisions();
  }, [loadDecisions]);

  const handleRefreshRotationBrief = async () => {
    if (refreshingBrief) return;
    playInkStamp();
    setRefreshingBrief(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/decisions/analyze`, {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error(
          `POST /api/decisions/analyze returned HTTP ${res.status}`
        );
      }
      const brief: RotationBrief = await res.json();
      setData((prev) => (prev ? { ...prev, rotation_brief: brief } : prev));
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `Failed refreshing rotation brief: ${err.message}`
          : "Failed refreshing rotation brief"
      );
    } finally {
      setRefreshingBrief(false);
    }
  };

  const scrollToLedger = () => {
    const target = document.getElementById("conviction-ledger");
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  };

  useEffect(() => {
    return () => {
      if (portalTimerRef.current !== null) {
        window.clearTimeout(portalTimerRef.current);
      }
    };
  }, []);

  const handlePortalRouteDive = (href: string) => {
    playInkStamp();
    if (portalTimerRef.current !== null) {
      window.clearTimeout(portalTimerRef.current);
    }
    portalTimerRef.current = window.setTimeout(() => {
      router.push(href);
    }, 145);
  };

  const handlePortalScrollDive = () => {
    playInkStamp();
    if (portalTimerRef.current !== null) {
      window.clearTimeout(portalTimerRef.current);
    }
    portalTimerRef.current = window.setTimeout(() => {
      scrollToLedger();
    }, 145);
  };

  const currentRegime = data?.current_rate_regime;
  const topConviction = data?.rankings[0] ?? null;

  const topFiscalSector = useMemo(() => {
    if (!data || data.rankings.length === 0) return null;
    return [...data.rankings].sort(
      (a, b) =>
        (b.fiscal_impulse_zscore ?? -99) - (a.fiscal_impulse_zscore ?? -99)
    )[0];
  }, [data]);

  const sp500Gold = useMemo(
    () =>
      goldPreview.find((item) => item.asset_key === "SP500_GOLD") ??
      goldPreview[0] ??
      null,
    [goldPreview]
  );

  return (
    <main className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-8 px-4 pb-14 pt-4 sm:px-6 lg:px-8">
      {/* Full-Viewport Cursor-Reactive Entry Stage */}
      <section
        aria-label="PlayFair Capital Atlas Entry"
        className="relative flex min-h-[calc(100vh-84px)] flex-col justify-between overflow-hidden border border-[#2A2118] bg-[#FAF4E6]/70 p-6 shadow-[inset_0_0_0_3px_#FAF4E6,inset_0_0_0_4px_#A8967A] sm:p-10"
      >
        <ReactiveAtlasCanvas />

        {/* Top Archival Plate Index & Monetary Regime Stamp */}
        <div className="relative z-10 flex flex-wrap items-center justify-between gap-3 border-b border-[#C8B9A0] pb-3">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-[#594A3C]">
            Folio I &middot; Macro Capital Atlas
          </span>

          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`border px-2.5 py-0.5 font-display text-xs font-semibold tracking-wide ${getRegimeBadgeStyle(
                currentRegime?.regime_label
              )}`}
            >
              {currentRegime?.regime_label ?? "Awaiting Telemetry"}
            </span>
            {currentRegime && (
              <span className="border border-[#A8967A] bg-[#FAF4E6]/90 px-2.5 py-0.5 font-mono text-[11px] tabular-nums text-[#1C1610]">
                FF {currentRegime.fed_funds.toFixed(2)}% &middot; 10Y{" "}
                {currentRegime.dgs10.toFixed(2)}%
              </span>
            )}
          </div>
        </div>

        {/* Centerpiece Title + Self-Drawing Calligraphic SVG Flourish */}
        <div className="relative z-10 my-auto flex flex-col items-center py-6 text-center">
          <span className="font-script text-3xl text-[#9E2A2B] sm:text-4xl">
            Annals of American Capital
          </span>

          <h1 className="mt-1 font-display text-4xl font-bold tracking-[0.04em] text-[#1C1610] sm:text-6xl">
            The Playfair Capital Atlas
          </h1>

          {/* Animated SVG Ink Calligraphic Flourish */}
          <svg
            viewBox="0 0 360 36"
            className="mt-3 h-7 w-72 overflow-visible sm:w-96"
            fill="none"
            aria-hidden="true"
          >
            <motion.path
              d="M 10 18 C 75 4, 125 32, 180 18 C 235 4, 285 32, 350 18"
              stroke="#2A2118"
              strokeWidth="1.25"
              strokeLinecap="round"
              initial={{ pathLength: 0, opacity: 0.2 }}
              animate={{ pathLength: 1, opacity: 0.9 }}
              transition={{ duration: 1.4, ease: "easeInOut" }}
            />
            <motion.path
              d="M 105 18 C 140 8, 160 28, 180 18 C 200 8, 220 28, 255 18"
              stroke="#B5892E"
              strokeWidth="1.15"
              strokeLinecap="round"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 0.95 }}
              transition={{ duration: 1.6, delay: 0.25, ease: "easeInOut" }}
            />
            <motion.circle
              cx="180"
              cy="18"
              r="3"
              fill="#9E2A2B"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ duration: 0.4, delay: 1.1 }}
            />
          </svg>

          {/* 3 Interactive MotionPlate Portal Cards */}
          <motion.div
            variants={folioStaggerContainer}
            initial="hidden"
            animate="visible"
            className="mt-8 grid w-full max-w-5xl grid-cols-1 gap-5 text-left md:grid-cols-3"
          >
            {/* Portal I: Assets vs. Gold Atlas */}
            <motion.div variants={folioStaggerItem} className="h-full">
              <MotionPlate
                interactive
                onClick={() => handlePortalRouteDive("/vs-gold")}
                className="h-full cursor-pointer p-5 transition-shadow hover:shadow-lg"
              >
                <div className="flex items-center justify-between border-b border-[#C8B9A0] pb-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#594A3C]">
                    Plate I &middot; 1970–Present
                  </span>
                  <ArrowRight className="h-4 w-4 text-[#9E2A2B]" />
                </div>
                <h2 className="mt-3 font-display text-xl font-bold text-[#1C1610]">
                  Assets vs. Gold Atlas
                </h2>
                <div className="mt-4 flex items-baseline justify-between border-t border-dashed border-[#C8B9A0] pt-3 font-mono tabular-nums">
                  <span className="text-xs uppercase tracking-wider text-[#594A3C]">
                    {sp500Gold
                      ? sp500Gold.asset_key.replace("_GOLD", "")
                      : "SP500"}{" "}
                    / Gold
                  </span>
                  <span className="text-lg font-semibold text-[#7D5C19]">
                    {sp500Gold ? (
                      <LedgerCounter
                        value={sp500Gold.secular_percentile}
                        decimals={0}
                        suffix="th %ile"
                      />
                    ) : (
                      "—"
                    )}
                  </span>
                </div>
              </MotionPlate>
            </motion.div>

            {/* Portal II: Fiscal & Sector Flows */}
            <motion.div variants={folioStaggerItem} className="h-full">
              <MotionPlate
                interactive
                onClick={() =>
                  handlePortalRouteDive(
                    topFiscalSector
                      ? `/sectors?ticker=${topFiscalSector.ticker}`
                      : "/sectors"
                  )
                }
                className="h-full cursor-pointer p-5 transition-shadow hover:shadow-lg"
              >
                <div className="flex items-center justify-between border-b border-[#C8B9A0] pb-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#594A3C]">
                    Plate II &middot; Federal Outlays
                  </span>
                  <ArrowRight className="h-4 w-4 text-[#2B5B6C]" />
                </div>
                <h2 className="mt-3 font-display text-xl font-bold text-[#1C1610]">
                  Fiscal &amp; Sector Flows
                </h2>
                <div className="mt-4 flex items-baseline justify-between border-t border-dashed border-[#C8B9A0] pt-3 font-mono tabular-nums">
                  <span className="text-xs uppercase tracking-wider text-[#594A3C]">
                    #1 Tailwind
                  </span>
                  <span className="text-lg font-semibold text-[#2B5B6C]">
                    {topFiscalSector ? (
                      <>
                        {topFiscalSector.ticker} (
                        <LedgerCounter
                          value={topFiscalSector.fiscal_impulse_zscore}
                          decimals={2}
                          signed
                          suffix=" Z"
                        />
                        )
                      </>
                    ) : (
                      "—"
                    )}
                  </span>
                </div>
              </MotionPlate>
            </motion.div>

            {/* Portal III: Conviction Ledger (Smooth-scroll) */}
            <motion.div variants={folioStaggerItem} className="h-full">
              <MotionPlate
                interactive
                onClick={handlePortalScrollDive}
                className="h-full cursor-pointer p-5 transition-shadow hover:shadow-lg"
              >
                <div className="flex items-center justify-between border-b border-[#C8B9A0] pb-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-[#594A3C]">
                    Plate III &middot; Rankings
                  </span>
                  <ArrowDown className="h-4 w-4 text-[#4F6D5A]" />
                </div>
                <h2 className="mt-3 font-display text-xl font-bold text-[#1C1610]">
                  Conviction Ledger
                </h2>
                <div className="mt-4 flex items-baseline justify-between border-t border-dashed border-[#C8B9A0] pt-3 font-mono tabular-nums">
                  <span className="text-xs uppercase tracking-wider text-[#594A3C]">
                    {topConviction ? `#1 ${topConviction.ticker}` : "Top Rank"}
                  </span>
                  <span className="text-lg font-semibold text-[#2F4E3C]">
                    {topConviction ? (
                      <LedgerCounter
                        value={topConviction.conviction_score}
                        decimals={1}
                        suffix=" / 100"
                      />
                    ) : (
                      "—"
                    )}
                  </span>
                </div>
              </MotionPlate>
            </motion.div>
          </motion.div>
        </div>

        {/* Bottom Scroll Cue */}
        <div className="relative z-10 flex justify-center pt-2">
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            onClick={() => {
              playBrassTick();
              scrollToLedger();
            }}
            className="inline-flex items-center gap-2 border border-[#2A2118] bg-[#FAF4E6] px-4 py-1.5 font-display text-xs font-semibold uppercase tracking-[0.16em] text-[#1C1610] transition hover:border-[#9E2A2B] hover:text-[#9E2A2B]"
          >
            <span>Open Decision Ledger</span>
            <ArrowDown className="h-3.5 w-3.5" />
          </motion.button>
        </div>
      </section>

      {errorMsg && (
        <div className="flex items-start gap-3 border border-[#9E2A2B] bg-[#FAF4E6] p-4 text-sm text-[#9E2A2B]">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="font-serif">{errorMsg}</p>
        </div>
      )}

      {/* Conviction Leaderboard + AI Rotation Brief */}
      <section
        id="conviction-ledger"
        className="grid scroll-mt-16 grid-cols-1 gap-6 xl:grid-cols-12"
      >
        {/* Leaderboard (7 cols) */}
        <div className="ledger-plate p-5 sm:p-6 xl:col-span-7">
          <div className="relative mb-5 flex items-center justify-center">
            <div className="ledger-title-plate px-5 py-1.5 text-center">
              <h2 className="font-display text-lg font-bold uppercase tracking-[0.12em] text-[#1C1610]">
                Sector Conviction Leaderboard
              </h2>
            </div>
            <InfoSeal
              className="absolute right-0 top-0"
              title="Sector Conviction Scoring"
              summary="Ranks all 6 US sector ETFs deterministically from 0 to 100 across three weighted pillars: Fiscal Impulse (0–40 pts from 5Y spending Z-score), Historical Regime Edge (0–35 pts from win rate & 12M excess returns vs. SPY/GLD), and Valuation Margin of Safety (0–25 pts inverted from Gold-relative percentile)."
              howToRead="High Conviction = Tailwind + Cheap/Fair; Crowded Momentum = Tailwind + Expensive (>75th); Value Trap = Headwind + Cheap (<25th); Avoid = Headwind + Fair/Expensive. Click any row to inspect its sector folio."
            />
          </div>

          <div className="overflow-x-auto border border-[#A8967A] bg-[#FAF4E6]">
            {loading ? (
              <div className="p-8 text-center font-serif italic text-[#594A3C]">
                Tabulating sector conviction scores...
              </div>
            ) : !data || data.rankings.length === 0 ? (
              <div className="p-8 text-center font-serif italic text-[#594A3C]">
                No sector rankings recorded yet.
              </div>
            ) : (
              <table className="w-full min-w-[660px] border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-[#2A2118] bg-[#EBE0C9] font-display text-[11px] font-bold uppercase tracking-wider text-[#1C1610]">
                    <th className="px-3.5 py-2.5">Rank</th>
                    <th className="px-3.5 py-2.5">Sector</th>
                    <th className="px-3.5 py-2.5">Score (F/R/V)</th>
                    <th className="px-3.5 py-2.5">Quadrant</th>
                    <th className="px-3.5 py-2.5 text-right">Fiscal Z</th>
                    <th className="px-3.5 py-2.5 text-right">Gold %ile</th>
                    <th className="px-3.5 py-2.5 text-right">Win Rate</th>
                  </tr>
                </thead>
                <motion.tbody
                  variants={folioStaggerContainer}
                  initial="hidden"
                  animate="visible"
                  className="divide-y divide-[#D7C9B2]"
                >
                  {data.rankings.map((item) => (
                    <motion.tr
                      key={item.ticker}
                      variants={folioStaggerItem}
                      onClick={() => {
                        playBrassTick();
                        router.push(`/sectors?ticker=${item.ticker}`);
                      }}
                      className="cursor-pointer transition hover:bg-[#EFE4CC]/75"
                    >
                      <td className="px-3.5 py-3 font-mono font-semibold text-[#594A3C]">
                        #{item.rank}
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-semibold text-[#1C1610]">
                            {item.ticker}
                          </span>
                          <span className="border border-[#C8B9A0] bg-[#F2E8D5] px-1.5 py-0.5 font-mono text-[10px] text-[#594A3C]">
                            AG-{item.agency_code}
                          </span>
                        </div>
                        <span className="block font-serif text-xs italic text-[#594A3C]">
                          {item.sector_name}
                        </span>
                      </td>
                      <td className="px-3.5 py-3 font-mono tabular-nums">
                        <div className="flex items-center gap-2">
                          <span className="w-10 font-semibold text-[#1C1610]">
                            <LedgerCounter value={item.conviction_score} decimals={1} />
                          </span>
                          <div className="h-2 w-24 overflow-hidden border border-[#A8967A] bg-[#F2E8D5]">
                            <motion.div
                              className={`h-full ${getScoreBarColor(
                                item.conviction_score
                              )}`}
                              initial={{ width: 0 }}
                              animate={{
                                width: `${Math.max(
                                  0,
                                  Math.min(100, item.conviction_score)
                                )}%`,
                              }}
                              transition={{
                                type: "spring",
                                stiffness: 120,
                                damping: 20,
                                delay: 0.1,
                              }}
                            />
                          </div>
                        </div>
                        <span className="mt-1 block text-[10px] text-[#594A3C]">
                          {item.fiscal_score.toFixed(0)}/40 &middot;{" "}
                          {item.regime_edge_score.toFixed(0)}/35 &middot;{" "}
                          {item.valuation_score.toFixed(0)}/25
                        </span>
                      </td>
                      <td className="px-3.5 py-3">
                        <span
                          className={`inline-block border px-2 py-0.5 font-display text-[11px] font-semibold ${getTierBadgeStyle(
                            item.decision_tier
                          )}`}
                        >
                          {item.decision_tier}
                        </span>
                      </td>
                      <td className="px-3.5 py-3 text-right font-mono tabular-nums">
                        <span
                          className={`inline-block border px-1.5 py-0.5 text-[11px] font-medium ${getImpulseBadgeStyle(
                            item.fiscal_impulse_label
                          )}`}
                        >
                          <LedgerCounter
                            value={item.fiscal_impulse_zscore}
                            decimals={2}
                            signed
                          />
                        </span>
                      </td>
                      <td className="px-3.5 py-3 text-right font-mono font-semibold tabular-nums text-[#7D5C19]">
                        <LedgerCounter
                          value={item.gold_valuation_percentile}
                          decimals={1}
                          suffix="%"
                        />
                      </td>
                      <td className="px-3.5 py-3 text-right font-mono font-semibold tabular-nums text-[#1C1610]">
                        <LedgerCounter
                          value={item.win_rate_pct}
                          decimals={1}
                          suffix="%"
                        />
                      </td>
                    </motion.tr>
                  ))}
                </motion.tbody>
              </table>
            )}
          </div>
        </div>

        {/* AI Capital Rotation Brief (5 cols) */}
        <aside className="ledger-plate flex flex-col p-5 sm:p-6 xl:col-span-5">
          <div className="relative mb-4 flex items-center justify-center">
            <div className="ledger-title-plate px-5 py-1.5 text-center">
              <h2 className="font-display text-lg font-bold uppercase tracking-[0.12em] text-[#1C1610]">
                Capital Rotation Brief
              </h2>
            </div>
            <InfoSeal
              className="absolute right-0 top-0"
              title="AI Capital Rotation Brief"
              summary="Synthesizes cross-sector rotation positioning grounded exclusively in the deterministic Conviction Rankings and Rate Regime tools stored in SQLite."
              howToRead="Use 'Refresh Brief' to force a fresh synthesis via the analyst loop (with automatic deterministic offline fallback)."
            />
          </div>

          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-[#C8B9A0] pb-3">
            <div className="flex flex-wrap items-center gap-2 font-mono text-[11px]">
              {data?.rotation_brief && (
                <>
                  <span className="border border-[#4F6D5A] bg-[#4F6D5A]/15 px-2 py-0.5 font-semibold text-[#2F4E3C]">
                    TOP: {data.rotation_brief.top_sector}
                  </span>
                  <span className="border border-[#9E2A2B] bg-[#9E2A2B]/12 px-2 py-0.5 font-semibold text-[#9E2A2B]">
                    AVOID: {data.rotation_brief.avoid_sector}
                  </span>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={() => void handleRefreshRotationBrief()}
              disabled={refreshingBrief || loading}
              className="inline-flex items-center gap-1.5 border border-[#2A2118] bg-[#FAF4E6] px-3 py-1 font-display text-xs font-semibold uppercase tracking-wider text-[#1C1610] transition hover:border-[#9E2A2B] hover:text-[#9E2A2B] disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3 w-3 ${refreshingBrief ? "animate-spin" : ""}`}
              />
              {refreshingBrief ? "Inscribing..." : "Refresh Brief"}
            </button>
          </div>

          <div className="flex-1 overflow-y-auto border border-[#C8B9A0] bg-[#F7F0DF] p-4">
            {loading ? (
              <div className="flex h-36 items-center justify-center font-serif italic text-[#594A3C]">
                Preparing rotation memorandum...
              </div>
            ) : data?.rotation_brief?.summary_markdown ? (
              <MarkdownBrief markdown={data.rotation_brief.summary_markdown} />
            ) : (
              <p className="font-serif italic text-[#594A3C]">
                No rotation brief available yet.
              </p>
            )}
          </div>
        </aside>
      </section>

      {/* Collapsible Signal History Log */}
      <section aria-label="Signal History Log" className="ledger-plate p-5">
        <div className="flex items-center justify-between gap-3">
          <button
            type="button"
            onClick={() => {
              playBrassTick();
              setHistoryOpen((prev) => !prev);
            }}
            className="flex flex-1 items-center justify-between text-left"
          >
            <div className="flex items-center gap-3">
              <span className="font-display text-base font-bold uppercase tracking-[0.12em] text-[#1C1610]">
                Signal History Archive
              </span>
              <span className="border border-[#C8B9A0] bg-[#F2E8D5] px-2 py-0.5 font-mono text-[11px] tabular-nums text-[#594A3C]">
                {data?.signal_snapshots.length ?? 0} entries
              </span>
            </div>
            {historyOpen ? (
              <ChevronUp className="h-4 w-4 text-[#594A3C]" />
            ) : (
              <ChevronDown className="h-4 w-4 text-[#594A3C]" />
            )}
          </button>

          <InfoSeal
            className="ml-3"
            title="Signal History Archive"
            summary="Immutable daily audit trail of deterministic Conviction Scores, quadrants, fiscal Z-scores, and ETF prices recorded during each data ingestion cycle."
          />
        </div>

        <AnimatePresence initial={false}>
          {historyOpen && (
            <motion.div
              key="signal-history-panel"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.28, ease: [0.22, 1, 0.36, 1] }}
              className="overflow-hidden"
            >
              <div className="mt-4 overflow-x-auto border border-[#A8967A] bg-[#FAF4E6]">
                {!data || data.signal_snapshots.length === 0 ? (
                  <p className="p-4 font-serif text-sm italic text-[#594A3C]">
                    No signal snapshots recorded yet.
                  </p>
                ) : (
                  <table className="w-full min-w-[640px] border-collapse text-left text-xs font-mono tabular-nums">
                    <thead>
                      <tr className="border-b border-[#2A2118] bg-[#EBE0C9] font-display text-[11px] font-bold uppercase tracking-wider text-[#1C1610]">
                        <th className="px-3.5 py-2.5">Date</th>
                        <th className="px-3.5 py-2.5">Ticker</th>
                        <th className="px-3.5 py-2.5 text-right">Score</th>
                        <th className="px-3.5 py-2.5">Tier</th>
                        <th className="px-3.5 py-2.5 text-right">Fiscal Z</th>
                        <th className="px-3.5 py-2.5">Regime</th>
                        <th className="px-3.5 py-2.5 text-right">Gold %ile</th>
                        <th className="px-3.5 py-2.5 text-right">ETF Close</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#D7C9B2]">
                      {data.signal_snapshots.map((snap) => (
                        <tr key={snap.id} className="hover:bg-[#EFE4CC]/60">
                          <td className="px-3.5 py-2 text-[#594A3C]">
                            {snap.snapshot_date}
                          </td>
                          <td className="px-3.5 py-2 font-semibold text-[#1C1610]">
                            {snap.ticker}
                          </td>
                          <td className="px-3.5 py-2 text-right font-semibold text-[#1C1610]">
                            {snap.conviction_score.toFixed(1)}
                          </td>
                          <td className="px-3.5 py-2">
                            <span
                              className={`inline-block border px-2 py-0.5 font-display text-[10px] font-semibold ${getTierBadgeStyle(
                                snap.decision_tier
                              )}`}
                            >
                              {snap.decision_tier}
                            </span>
                          </td>
                          <td className="px-3.5 py-2 text-right text-[#1C1610]">
                            {formatZScore(snap.fiscal_impulse_zscore)}
                          </td>
                          <td className="px-3.5 py-2 font-serif text-xs text-[#594A3C]">
                            {snap.regime_label}
                          </td>
                          <td className="px-3.5 py-2 text-right text-[#7D5C19]">
                            {formatPct(snap.gold_valuation_percentile, false)}
                          </td>
                          <td className="px-3.5 py-2 text-right text-[#1C1610]">
                            {snap.etf_close !== null
                              ? `$${snap.etf_close.toFixed(2)}`
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>
    </main>
  );
}
