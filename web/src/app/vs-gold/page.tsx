"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { AlertCircle, RefreshCw } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  folioStaggerContainer,
  folioStaggerItem,
} from "@/components/FolioTransitionProvider";
import { InfoSeal } from "@/components/InfoSeal";
import { LedgerCounter } from "@/components/LedgerCounter";
import { MotionPlate } from "@/components/MotionPlate";
import { API_BASE_URL } from "@/lib/api";
import { playBrassTick } from "@/lib/archivalAudio";

interface SecularExtreme {
  ratio: number;
  date: string;
}

interface SecularGoldPoint {
  date: string;
  ratio_in_gold: number;
  asset_value_usd: number;
  gold_price_usd: number;
}

interface SecularGoldAssetResponse {
  asset_key: string;
  asset_name: string;
  unit_label: string;
  latest_ratio: number;
  latest_date: string;
  secular_percentile: number;
  min_ratio: SecularExtreme;
  max_ratio: SecularExtreme;
  mean_ratio: number;
  valuation_zone: string;
  series: SecularGoldPoint[];
}

type TimeframeKey = "10Y" | "25Y" | "55Y";

const TIMEFRAME_YEARS: Record<TimeframeKey, number> = {
  "10Y": 10,
  "25Y": 25,
  "55Y": 55,
};

const ASSET_INKS: Record<string, { stroke: string; wash: string }> = {
  USD_GOLD: { stroke: "#1C1610", wash: "#594A3C" },
  GBP_GOLD: { stroke: "#2B5B6C", wash: "#2B5B6C" },
  CASH_FUND_GOLD: { stroke: "#4F6D5A", wash: "#4F6D5A" },
  SP500_GOLD: { stroke: "#9E2A2B", wash: "#9E2A2B" },
  NASDAQ_GOLD: { stroke: "#B5892E", wash: "#B5892E" },
  HOUSING_GOLD: { stroke: "#594A3C", wash: "#B5892E" },
};

const ASSET_INFO: Record<string, { summary: string; howToRead: string }> = {
  USD_GOLD: {
    summary:
      "Tracks the purchasing power of $1,000 USD denominated in troy ounces of physical Gold from 1970 to present.",
    howToRead:
      "Lower readings indicate fiat purchasing-power erosion relative to Gold; <25th percentile marks secular Gold-cheap USD.",
  },
  GBP_GOLD: {
    summary:
      "Converts £1,000 GBP into USD via FRED DEXUSUK (1971–present) and prices that sum in troy ounces of Gold.",
    howToRead:
      "Measures Sterling's hard-money purchasing power across five decades of monetary regimes.",
  },
  CASH_FUND_GOLD: {
    summary:
      "Compounds $1,000 monthly at the Federal Funds rate (FRED FEDFUNDS) since Jan 1970, then divides by Gold USD.",
    howToRead:
      "Shows whether short-term interest income outpaced or trailed Gold debasement across tightening and easing cycles.",
  },
  SP500_GOLD: {
    summary:
      "Prices the S&P 500 index (^GSPC, 1970–present) in troy ounces of Gold rather than nominal Dollars.",
    howToRead:
      "Peaks mark secular equity euphoria vs. hard assets; troughs (<25th percentile) historically preceded equity outperformance.",
  },
  NASDAQ_GOLD: {
    summary:
      "Splices Nasdaq Composite (^IXIC, 1971–1985) smoothly onto Nasdaq-100 (^NDX, 1985–present) divided by Gold USD.",
    howToRead:
      "Highlights long-duration growth multiples deflated by Gold across 2000, 2008, and modern cycles.",
  },
  HOUSING_GOLD: {
    summary:
      "Divides FRED quarterly Median Sales Price of US Houses Sold (MSPUS, 1970–present) by the matching month's Gold price.",
    howToRead:
      "Directly reads how many troy ounces of Gold are required to purchase one median US home.",
  },
};

function getGoldValuationBadge(zone: string): { label: string; cls: string } {
  if (zone === "Cheap") {
    return {
      label: "Cheap in Gold",
      cls: "border-[#4F6D5A] bg-[#4F6D5A]/15 text-[#2F4E3C]",
    };
  }
  if (zone === "Expensive") {
    return {
      label: "Expensive in Gold",
      cls: "border-[#9E2A2B] bg-[#9E2A2B]/12 text-[#9E2A2B]",
    };
  }
  return {
    label: "Normal in Gold",
    cls: "border-[#B5892E] bg-[#B5892E]/15 text-[#7D5C19]",
  };
}

function formatRatio(val: number): string {
  if (!Number.isFinite(val)) return "—";
  if (Math.abs(val) >= 100) return val.toFixed(1);
  if (Math.abs(val) >= 10) return val.toFixed(2);
  return val.toFixed(3);
}

function getRatioDecimals(val: number | null | undefined): number {
  if (typeof val !== "number" || !Number.isFinite(val)) return 2;
  if (Math.abs(val) >= 100) return 1;
  if (Math.abs(val) >= 10) return 2;
  return 3;
}

function formatUsd(val: number): string {
  if (!Number.isFinite(val)) return "—";
  if (val >= 1000) {
    return `$${val.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  }
  return `$${val.toFixed(2)}`;
}

function formatShortDate(date: string): string {
  return date.length >= 7 ? date.slice(0, 7) : date;
}

function filterSeriesByTimeframe(
  series: SecularGoldPoint[],
  latestDate: string,
  timeframe: TimeframeKey
): SecularGoldPoint[] {
  if (timeframe === "55Y" || series.length === 0) {
    return series;
  }
  const latestYear = Number.parseInt(latestDate.slice(0, 4), 10);
  if (!Number.isFinite(latestYear)) {
    return series;
  }
  const cutoffYear = latestYear - TIMEFRAME_YEARS[timeframe];
  const cutoffDate = `${cutoffYear.toString().padStart(4, "0")}${latestDate.slice(4)}`;
  return series.filter((pt) => pt.date >= cutoffDate);
}

interface TooltipProps {
  active?: boolean;
  payload?: Array<{ payload?: SecularGoldPoint }>;
  unitLabel: string;
}

function SecularGoldTooltip({ active, payload, unitLabel }: TooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const pt = payload[0]?.payload;
  if (!pt) return null;

  return (
    <div className="border border-[#2A2118] bg-[#FAF4E6] p-3 text-xs text-[#1C1610] shadow-[inset_0_0_0_2px_#FAF4E6,inset_0_0_0_3px_#A8967A,0_10px_20px_-8px_rgba(28,22,16,0.3)]">
      <div className="mb-1.5 border-b border-[#C8B9A0] pb-1 font-mono font-semibold text-[#1C1610]">
        {formatShortDate(pt.date)}
      </div>
      <div className="space-y-1 font-mono tabular-nums">
        <div className="flex justify-between gap-4">
          <span className="font-serif italic text-[#594A3C]">Gold Ratio:</span>
          <span className="font-semibold text-[#7D5C19]">
            {formatRatio(pt.ratio_in_gold)} ({unitLabel})
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="font-serif italic text-[#594A3C]">Asset (USD):</span>
          <span className="font-medium text-[#1C1610]">
            {formatUsd(pt.asset_value_usd)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="font-serif italic text-[#594A3C]">Gold Spot:</span>
          <span className="font-medium text-[#1C1610]">
            {formatUsd(pt.gold_price_usd)}
          </span>
        </div>
      </div>
    </div>
  );
}

function SecularAssetCard({
  asset,
  timeframe,
}: {
  asset: SecularGoldAssetResponse;
  timeframe: TimeframeKey;
}) {
  const filteredSeries = useMemo(
    () => filterSeriesByTimeframe(asset.series, asset.latest_date, timeframe),
    [asset.series, asset.latest_date, timeframe]
  );

  const badge = getGoldValuationBadge(asset.valuation_zone);
  const ink = ASSET_INKS[asset.asset_key] ?? {
    stroke: "#2B5B6C",
    wash: "#2B5B6C",
  };
  const info = ASSET_INFO[asset.asset_key] ?? {
    summary: `Monthly secular series of ${asset.asset_name} priced in troy ounces of Gold.`,
    howToRead: `50Y dashed mean sits at ${formatRatio(asset.mean_ratio)} oz.`,
  };
  const gradientId = `playfair-wash-${asset.asset_key}`;

  return (
    <MotionPlate className="flex flex-col p-5">
      {/* Top Plate Header + Centered Title Box + Top-Right InfoSeal */}
      <div className="relative flex flex-col items-center pb-3">
        <div className="flex w-full items-center justify-between">
          <span className="border border-[#C8B9A0] bg-[#F2E8D5] px-1.5 py-0.5 font-mono text-[10px] text-[#594A3C]">
            {asset.asset_key}
          </span>
          <div className="flex items-center gap-2">
            <span
              className={`border px-2 py-0.5 font-display text-[11px] font-semibold ${badge.cls}`}
            >
              {badge.label}
            </span>
            <InfoSeal
              title={asset.asset_name}
              summary={info.summary}
              howToRead={info.howToRead}
            />
          </div>
        </div>

        <div className="ledger-title-plate mt-3 px-4 py-1.5 text-center">
          <h2 className="font-display text-lg font-bold tracking-wide text-[#1C1610]">
            {asset.asset_name}
          </h2>
          <p className="font-serif text-[11px] italic text-[#594A3C]">
            {asset.unit_label} &middot; 50Y Mean{" "}
            <span className="font-mono not-italic text-[#7D5C19]">
              {formatRatio(asset.mean_ratio)} oz
            </span>
          </p>
        </div>
      </div>

      {/* Millimeter Paper Recharts Plot */}
      <div className="millimeter-paper h-[240px] w-full p-2">
        {filteredSeries.length === 0 ? (
          <div className="flex h-full items-center justify-center font-serif text-xs italic text-[#594A3C]">
            No observations inside selected timeframe.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={filteredSeries}
              margin={{ top: 10, right: 12, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={ink.wash} stopOpacity={0.28} />
                  <stop offset="95%" stopColor={ink.wash} stopOpacity={0.03} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#C8B9A0" strokeDasharray="2 3" />
              <XAxis
                dataKey="date"
                tickFormatter={(d: string) => d.slice(0, 4)}
                stroke="#594A3C"
                tick={{
                  fill: "#594A3C",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
                minTickGap={34}
              />
              <YAxis
                stroke="#594A3C"
                tick={{
                  fill: "#594A3C",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                }}
                tickFormatter={(v: number) => formatRatio(v)}
                width={52}
                domain={["auto", "auto"]}
              />
              <Tooltip
                cursor={{ stroke: "#9E2A2B", strokeDasharray: "3 3" }}
                content={<SecularGoldTooltip unitLabel={asset.unit_label} />}
              />
              <ReferenceLine
                y={asset.mean_ratio}
                stroke="#B5892E"
                strokeDasharray="5 4"
                strokeWidth={1.5}
                label={{
                  value: "50Y Mean",
                  position: "insideTopRight",
                  fill: "#7D5C19",
                  fontSize: 10,
                }}
              />
              <Area
                type="monotone"
                dataKey="ratio_in_gold"
                stroke={ink.stroke}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                dot={false}
                isAnimationActive={true}
                animationDuration={620}
                animationEasing="ease-out"
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Clean 4-Cell Tabular Stat Footer */}
      <div className="mt-3.5 grid grid-cols-2 gap-2 border-t border-[#C8B9A0] pt-3 text-xs font-mono tabular-nums sm:grid-cols-4">
        <div className="border border-[#D7C9B2] bg-[#F2E8D5]/70 p-2">
          <span className="block font-serif text-[11px] italic text-[#594A3C]">
            Latest ({formatShortDate(asset.latest_date)})
          </span>
          <span className="text-sm font-semibold text-[#1C1610]">
            <LedgerCounter
              value={asset.latest_ratio}
              decimals={getRatioDecimals(asset.latest_ratio)}
              suffix=" oz"
            />
          </span>
        </div>
        <div className="border border-[#D7C9B2] bg-[#F2E8D5]/70 p-2">
          <span className="block font-serif text-[11px] italic text-[#594A3C]">
            Secular %ile
          </span>
          <span className="text-sm font-semibold text-[#2B5B6C]">
            <LedgerCounter
              value={asset.secular_percentile}
              decimals={1}
              suffix="%"
            />
          </span>
        </div>
        <div className="border border-[#D7C9B2] bg-[#F2E8D5]/70 p-2">
          <span className="block font-serif text-[11px] italic text-[#594A3C]">
            ATH ({formatShortDate(asset.max_ratio.date)})
          </span>
          <span className="text-sm font-semibold text-[#2F4E3C]">
            <LedgerCounter
              value={asset.max_ratio.ratio}
              decimals={getRatioDecimals(asset.max_ratio.ratio)}
              suffix=" oz"
            />
          </span>
        </div>
        <div className="border border-[#D7C9B2] bg-[#F2E8D5]/70 p-2">
          <span className="block font-serif text-[11px] italic text-[#594A3C]">
            ATL ({formatShortDate(asset.min_ratio.date)})
          </span>
          <span className="text-sm font-semibold text-[#9E2A2B]">
            <LedgerCounter
              value={asset.min_ratio.ratio}
              decimals={getRatioDecimals(asset.min_ratio.ratio)}
              suffix=" oz"
            />
          </span>
        </div>
      </div>
    </MotionPlate>
  );
}

export default function AssetsVsGoldPage() {
  const [assets, setAssets] = useState<SecularGoldAssetResponse[]>([]);
  const [timeframe, setTimeframe] = useState<TimeframeKey>("55Y");
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const loadAssets = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/vs-gold`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`GET /api/vs-gold returned HTTP ${res.status}`);
      }
      const data: SecularGoldAssetResponse[] = await res.json();
      setAssets(data);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `Unable to load secular gold data from ${API_BASE_URL}: ${err.message}`
          : `Unable to load secular gold data from ${API_BASE_URL}`
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAssets();
  }, [loadAssets]);

  return (
    <main className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Slim Archival Masthead */}
      <header className="flex flex-col justify-between gap-4 border-b border-[#2A2118] pb-4 sm:flex-row sm:items-end">
        <div>
          <span className="font-script text-2xl text-[#9E2A2B]">
            Folio II &middot; Secular Hard-Money Atlas
          </span>
          <h1 className="font-display text-3xl font-bold tracking-wide text-[#1C1610]">
            Macro Assets Priced in Gold
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <div
            role="group"
            aria-label="Timeframe Selector"
            className="inline-flex border border-[#2A2118] bg-[#FAF4E6] p-0.5 font-mono text-xs"
          >
            {(
              [
                { key: "10Y", label: "10Y" },
                { key: "25Y", label: "25Y" },
                { key: "55Y", label: "55Y (Max)" },
              ] as const
            ).map(({ key, label }) => {
              const active = timeframe === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => {
                    if (timeframe !== key) {
                      playBrassTick();
                      setTimeframe(key);
                    }
                  }}
                  className={`relative px-3 py-1 font-semibold transition-colors ${
                    active
                      ? "text-[#FAF4E6]"
                      : "text-[#594A3C] hover:text-[#1C1610]"
                  }`}
                >
                  {active && (
                    <motion.span
                      layoutId="vs-gold-timeframe-pill"
                      transition={{
                        type: "spring",
                        stiffness: 380,
                        damping: 32,
                      }}
                      className="absolute inset-0 bg-[#1C1610]"
                    />
                  )}
                  <span className="relative z-10">{label}</span>
                </button>
              );
            })}
          </div>

          <button
            type="button"
            onClick={() => {
              playBrassTick();
              void loadAssets();
            }}
            disabled={loading}
            className="inline-flex items-center gap-1.5 border border-[#2A2118] bg-[#FAF4E6] px-3 py-1.5 font-display text-xs font-semibold uppercase tracking-wider text-[#1C1610] transition hover:border-[#9E2A2B] hover:text-[#9E2A2B] disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3 w-3 ${loading ? "animate-spin" : ""}`}
            />
            Reload
          </button>

          <InfoSeal
            title="1970–Present Gold Denominator"
            summary="Constructs a continuous 55-year monthly Gold USD benchmark (Stooq xauusd spliced with embedded 1970–2004 London Fix baseline and Yahoo GC=F) to measure purchasing power independent of fiat debasement."
            howToRead="Each chart displays one asset in isolation against a 50-year dashed mean. Below the 25th percentile is Cheap in Gold; above the 75th percentile is Expensive in Gold."
          />
        </div>
      </header>

      {errorMsg && (
        <div className="flex items-start gap-3 border border-[#9E2A2B] bg-[#FAF4E6] p-4 text-sm text-[#9E2A2B]">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="font-serif">{errorMsg}</p>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          {[1, 2, 3, 4, 5, 6].map((slot) => (
            <div
              key={slot}
              className="ledger-plate flex h-[380px] items-center justify-center font-serif text-sm italic text-[#594A3C]"
            >
              Drawing archival plate...
            </div>
          ))}
        </div>
      ) : assets.length === 0 ? (
        <div className="ledger-plate p-10 text-center font-serif text-sm italic text-[#594A3C]">
          No secular Gold series persisted yet. Run{" "}
          <code className="border border-[#C8B9A0] bg-[#EFE4CC] px-1.5 py-0.5 font-mono text-xs text-[#2B5B6C]">
            cargo run -- --ingest
          </code>{" "}
          to populate <code className="font-mono">gold_secular_ratios</code>.
        </div>
      ) : (
        <motion.section
          variants={folioStaggerContainer}
          initial="hidden"
          animate="visible"
          aria-label="Assets vs Gold Cards"
          className="grid grid-cols-1 gap-6 lg:grid-cols-2"
        >
          {assets.map((asset) => (
            <motion.div key={asset.asset_key} variants={folioStaggerItem}>
              <SecularAssetCard asset={asset} timeframe={timeframe} />
            </motion.div>
          ))}
        </motion.section>
      )}
    </main>
  );
}
