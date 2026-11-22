"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, Coins, RefreshCw } from "lucide-react";
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
import { API_BASE_URL } from "@/lib/api";

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

const ASSET_ACCENTS: Record<string, { stroke: string; fill: string }> = {
  USD_GOLD: { stroke: "#38bdf8", fill: "#38bdf8" },
  GBP_GOLD: { stroke: "#a855f7", fill: "#a855f7" },
  CASH_FUND_GOLD: { stroke: "#10b981", fill: "#10b981" },
  SP500_GOLD: { stroke: "#f59e0b", fill: "#f59e0b" },
  NASDAQ_GOLD: { stroke: "#ec4899", fill: "#ec4899" },
  HOUSING_GOLD: { stroke: "#eab308", fill: "#eab308" },
};

function getGoldValuationBadge(zone: string): { label: string; cls: string } {
  if (zone === "Cheap") {
    return {
      label: "Cheap in Gold",
      cls: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
    };
  }
  if (zone === "Expensive") {
    return {
      label: "Expensive in Gold",
      cls: "border-rose-500/40 bg-rose-500/15 text-rose-300",
    };
  }
  return {
    label: "Normal in Gold",
    cls: "border-amber-500/40 bg-amber-500/15 text-amber-200",
  };
}

function formatRatio(val: number): string {
  if (!Number.isFinite(val)) return "—";
  if (Math.abs(val) >= 100) return val.toFixed(1);
  if (Math.abs(val) >= 10) return val.toFixed(2);
  return val.toFixed(3);
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
    <div className="rounded-lg border border-slate-700 bg-slate-900/95 p-3 text-xs shadow-xl backdrop-blur">
      <div className="mb-1.5 border-b border-slate-800 pb-1 font-semibold text-white">
        {formatShortDate(pt.date)}
      </div>
      <div className="space-y-1 tabular-nums">
        <div className="flex justify-between gap-4">
          <span className="text-amber-300">Gold Ratio:</span>
          <span className="font-semibold text-white">
            {formatRatio(pt.ratio_in_gold)} ({unitLabel})
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-sky-300">Asset (USD):</span>
          <span className="font-medium text-slate-200">
            {formatUsd(pt.asset_value_usd)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-yellow-300">Gold Spot (USD/oz):</span>
          <span className="font-medium text-slate-200">
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
  const accent = ASSET_ACCENTS[asset.asset_key] ?? {
    stroke: "#38bdf8",
    fill: "#38bdf8",
  };
  const gradientId = `gold-grad-${asset.asset_key}`;

  return (
    <article className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-5 shadow-lg">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-base font-semibold text-white">
              {asset.asset_name}
            </h2>
            <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
              {asset.asset_key}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-slate-400">
            Unit: <span className="text-slate-300">{asset.unit_label}</span>{" "}
            &middot; Mean:{" "}
            <span className="font-mono text-amber-300">
              {formatRatio(asset.mean_ratio)} oz
            </span>
          </p>
        </div>

        <span
          className={`shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${badge.cls}`}
        >
          {badge.label}
        </span>
      </div>

      <div className="mt-4 h-[240px] w-full">
        {filteredSeries.length === 0 ? (
          <div className="flex h-full items-center justify-center text-xs text-slate-500">
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
                  <stop
                    offset="5%"
                    stopColor={accent.fill}
                    stopOpacity={0.35}
                  />
                  <stop
                    offset="95%"
                    stopColor={accent.fill}
                    stopOpacity={0.02}
                  />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
              <XAxis
                dataKey="date"
                tickFormatter={(d: string) => d.slice(0, 4)}
                stroke="#64748b"
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                minTickGap={34}
              />
              <YAxis
                stroke="#94a3b8"
                tick={{ fill: "#94a3b8", fontSize: 11 }}
                tickFormatter={(v: number) => formatRatio(v)}
                width={52}
                domain={["auto", "auto"]}
              />
              <Tooltip
                content={<SecularGoldTooltip unitLabel={asset.unit_label} />}
              />
              <ReferenceLine
                y={asset.mean_ratio}
                stroke="#f59e0b"
                strokeDasharray="5 4"
                label={{
                  value: "50Y Mean",
                  position: "insideTopRight",
                  fill: "#fbbf24",
                  fontSize: 10,
                }}
              />
              <Area
                type="monotone"
                dataKey="ratio_in_gold"
                stroke={accent.stroke}
                strokeWidth={2}
                fill={`url(#${gradientId})`}
                dot={false}
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-4 grid grid-cols-2 gap-2.5 border-t border-slate-800/80 pt-3 text-xs tabular-nums sm:grid-cols-4">
        <div className="rounded-lg bg-slate-950/60 p-2.5">
          <span className="block text-[11px] text-slate-500">
            Latest Ratio ({formatShortDate(asset.latest_date)})
          </span>
          <span className="text-sm font-semibold text-white">
            {formatRatio(asset.latest_ratio)} oz
          </span>
        </div>
        <div className="rounded-lg bg-slate-950/60 p-2.5">
          <span className="block text-[11px] text-slate-500">
            Secular Percentile
          </span>
          <span className="text-sm font-semibold text-sky-300">
            {asset.secular_percentile.toFixed(1)}%
          </span>
        </div>
        <div className="rounded-lg bg-slate-950/60 p-2.5">
          <span className="block text-[11px] text-slate-500">
            All-Time High ({formatShortDate(asset.max_ratio.date)})
          </span>
          <span className="text-sm font-semibold text-emerald-400">
            {formatRatio(asset.max_ratio.ratio)} oz
          </span>
        </div>
        <div className="rounded-lg bg-slate-950/60 p-2.5">
          <span className="block text-[11px] text-slate-500">
            All-Time Low ({formatShortDate(asset.min_ratio.date)})
          </span>
          <span className="text-sm font-semibold text-rose-400">
            {formatRatio(asset.min_ratio.ratio)} oz
          </span>
        </div>
      </div>
    </article>
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
    <main className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      <header className="flex flex-col justify-between gap-4 border-b border-slate-800/80 pb-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-amber-400">
            <Coins className="h-4 w-4" />
            <span>55-Year Secular Valuation (1970–Present)</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">
            Macro Assets Priced in Gold
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Each asset renders in its own isolated panel against a 1970–present
            Gold troy ounce denominator with a 50Y secular mean reference line.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div
            role="group"
            aria-label="Timeframe Selector"
            className="inline-flex rounded-lg border border-slate-800 bg-slate-900/80 p-1 text-xs"
          >
            {(
              [
                { key: "10Y", label: "10Y" },
                { key: "25Y", label: "25Y" },
                { key: "55Y", label: "55Y (Max)" },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTimeframe(key)}
                className={`rounded-md px-3 py-1.5 font-semibold transition ${
                  timeframe === key
                    ? "bg-amber-500/20 text-amber-300 ring-1 ring-amber-500/40"
                    : "text-slate-400 hover:text-slate-100"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => void loadAssets()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-slate-800 disabled:opacity-50"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`}
            />
            Reload
          </button>
        </div>
      </header>

      {errorMsg && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
          <div>
            <p className="font-semibold">Backend Connection Issue</p>
            <p className="mt-0.5 text-xs text-rose-200/80">{errorMsg}</p>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
          {[1, 2, 3, 4, 5, 6].map((slot) => (
            <div
              key={slot}
              className="flex h-[360px] items-center justify-center rounded-xl border border-slate-800 bg-slate-900/40 text-sm text-slate-400"
            >
              Loading 55-year secular Gold series...
            </div>
          ))}
        </div>
      ) : assets.length === 0 ? (
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-10 text-center text-sm text-slate-400">
          No secular Gold series persisted yet. Run{" "}
          <code className="rounded bg-slate-950 px-1.5 py-0.5 font-mono text-sky-300">
            cargo run -- --ingest
          </code>{" "}
          to populate <code className="font-mono">gold_secular_ratios</code>.
        </div>
      ) : (
        <section
          aria-label="Assets vs Gold Cards"
          className="grid grid-cols-1 gap-5 lg:grid-cols-2"
        >
          {assets.map((asset) => (
            <SecularAssetCard
              key={asset.asset_key}
              asset={asset}
              timeframe={timeframe}
            />
          ))}
        </section>
      )}
    </main>
  );
}
