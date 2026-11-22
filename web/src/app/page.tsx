"use client";

import React, { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Coins,
  Compass,
  History,
  Layers,
  RefreshCw,
  Sparkles,
  Trophy,
} from "lucide-react";
import { MarkdownBrief } from "@/components/MarkdownBrief";
import { API_BASE_URL } from "@/lib/api";

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
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  }
  if (tier === "Crowded Momentum") {
    return "border-sky-500/40 bg-sky-500/15 text-sky-300";
  }
  if (tier === "Value Trap") {
    return "border-amber-500/40 bg-amber-500/15 text-amber-200";
  }
  return "border-rose-500/40 bg-rose-500/15 text-rose-300";
}

function getImpulseBadgeStyle(label: string): string {
  if (label === "Accelerating") {
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  }
  if (label === "Contracting") {
    return "border-rose-500/40 bg-rose-500/15 text-rose-300";
  }
  return "border-amber-500/40 bg-amber-500/15 text-amber-200";
}

function getRegimeBadgeStyle(regime: string | null | undefined): string {
  if (regime === "Hiking") {
    return "border-rose-500/40 bg-rose-500/15 text-rose-300";
  }
  if (regime === "Cutting") {
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  }
  if (regime === "High-Pause") {
    return "border-amber-500/40 bg-amber-500/15 text-amber-300";
  }
  if (regime === "Low-Pause") {
    return "border-sky-500/40 bg-sky-500/15 text-sky-300";
  }
  return "border-slate-700 bg-slate-800 text-slate-300";
}

function getScoreBarColor(score: number): string {
  if (score >= 65) return "bg-emerald-400";
  if (score >= 45) return "bg-sky-400";
  if (score >= 30) return "bg-amber-400";
  return "bg-rose-400";
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

  const currentRegime = data?.current_rate_regime;
  const topSector = data?.rankings[0] ?? null;

  return (
    <main className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <header className="flex flex-col justify-between gap-3 border-b border-slate-800/80 pb-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-400">
            <Compass className="h-4 w-4" />
            <span>Cross-Sector Capital-Flow Decision Engine</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">
            Sector Conviction Leaderboard &amp; Rotation Brief
          </h1>
          <p className="mt-1 text-xs text-slate-400">
            Deterministic 100-point scoring across Fiscal Impulse (40 pts),
            Historical Regime Edge (35 pts), and Gold-Relative Margin of Safety
            (25 pts).
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-1.5">
            <span className="text-slate-400">Rate Regime:</span>
            <span
              className={`rounded-full border px-2.5 py-0.5 font-semibold ${getRegimeBadgeStyle(
                currentRegime?.regime_label
              )}`}
            >
              {currentRegime?.regime_label ?? "Unavailable"}
            </span>
          </div>
          {currentRegime && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-1.5 tabular-nums text-slate-300">
              FF:{" "}
              <span className="font-semibold text-white">
                {currentRegime.fed_funds.toFixed(2)}%
              </span>{" "}
              | 10Y:{" "}
              <span className="font-semibold text-white">
                {currentRegime.dgs10.toFixed(2)}%
              </span>
            </div>
          )}
        </div>
      </header>

      {/* Error Banner */}
      {errorMsg && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
          <div>
            <p className="font-semibold">Backend Connection Issue</p>
            <p className="mt-0.5 text-xs text-rose-200/80">{errorMsg}</p>
          </div>
        </div>
      )}

      {/* Main Split: Conviction Leaderboard + AI Rotation Brief */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {/* Leaderboard (7 cols) */}
        <section
          aria-label="Conviction Leaderboard"
          className="rounded-xl border border-slate-800 bg-slate-900/60 p-5 xl:col-span-7"
        >
          <div className="mb-4 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2.5">
              <Trophy className="h-5 w-5 text-amber-400" />
              <div>
                <h2 className="text-base font-semibold text-white">
                  #1–#6 Sector Conviction Leaderboard
                </h2>
                <p className="text-xs text-slate-400">
                  Click any sector row to open its full fiscal, rate-regime,
                  and analog breakdown.
                </p>
              </div>
            </div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/80">
            {loading ? (
              <div className="p-8 text-center text-sm text-slate-400">
                Scoring all 6 sectors...
              </div>
            ) : !data || data.rankings.length === 0 ? (
              <div className="p-8 text-center text-sm text-slate-400">
                No sector rankings available yet. Run ingestion first.
              </div>
            ) : (
              <table className="w-full min-w-[680px] border-collapse text-left text-xs tabular-nums">
                <thead>
                  <tr className="border-b border-slate-800 bg-slate-900 text-[11px] font-semibold uppercase tracking-wider text-slate-300">
                    <th className="px-3.5 py-3">Rank</th>
                    <th className="px-3.5 py-3">Sector</th>
                    <th className="px-3.5 py-3">Conviction (F/R/V)</th>
                    <th className="px-3.5 py-3">Decision Tier</th>
                    <th className="px-3.5 py-3 text-right">Fiscal Z</th>
                    <th className="px-3.5 py-3 text-right">Gold %ile</th>
                    <th className="px-3.5 py-3 text-right">Win Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/80">
                  {data.rankings.map((item) => (
                    <tr
                      key={item.ticker}
                      onClick={() =>
                        router.push(`/sectors?ticker=${item.ticker}`)
                      }
                      className="cursor-pointer transition hover:bg-slate-900/90"
                    >
                      <td className="px-3.5 py-3 font-mono font-bold text-slate-200">
                        #{item.rank}
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-white">
                            {item.ticker}
                          </span>
                          <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[10px] text-slate-400">
                            AG-{item.agency_code}
                          </span>
                        </div>
                        <span className="block text-[11px] text-slate-400">
                          {item.sector_name}
                        </span>
                      </td>
                      <td className="px-3.5 py-3">
                        <div className="flex items-center gap-2">
                          <span className="w-10 font-bold text-white">
                            {item.conviction_score.toFixed(1)}
                          </span>
                          <div className="h-2 w-24 overflow-hidden rounded-full bg-slate-800">
                            <div
                              className={`h-full rounded-full ${getScoreBarColor(
                                item.conviction_score
                              )}`}
                              style={{
                                width: `${Math.max(
                                  0,
                                  Math.min(100, item.conviction_score)
                                )}%`,
                              }}
                            />
                          </div>
                        </div>
                        <span className="mt-1 block font-mono text-[10px] text-slate-400">
                          {item.fiscal_score.toFixed(0)}/40 &middot;{" "}
                          {item.regime_edge_score.toFixed(0)}/35 &middot;{" "}
                          {item.valuation_score.toFixed(0)}/25
                        </span>
                      </td>
                      <td className="px-3.5 py-3">
                        <span
                          className={`inline-block rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${getTierBadgeStyle(
                            item.decision_tier
                          )}`}
                        >
                          {item.decision_tier}
                        </span>
                      </td>
                      <td className="px-3.5 py-3 text-right">
                        <span
                          className={`inline-block rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold ${getImpulseBadgeStyle(
                            item.fiscal_impulse_label
                          )}`}
                        >
                          {formatZScore(item.fiscal_impulse_zscore)}
                        </span>
                      </td>
                      <td className="px-3.5 py-3 text-right font-semibold text-amber-300">
                        {formatPct(item.gold_valuation_percentile, false)}
                      </td>
                      <td className="px-3.5 py-3 text-right font-semibold text-slate-200">
                        {formatPct(item.win_rate_pct, false)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* AI Capital Rotation Brief (5 cols) */}
        <aside className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-5 xl:col-span-5">
          <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/10">
                <Sparkles className="h-4 w-4 text-sky-400" />
              </div>
              <div>
                <h2 className="text-base font-semibold text-white">
                  AI Capital Rotation Brief
                </h2>
                <p className="text-xs text-slate-400">
                  Cross-sector positioning synthesized from rankings
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={() => void handleRefreshRotationBrief()}
              disabled={refreshingBrief || loading}
              className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshingBrief ? "animate-spin" : ""}`}
              />
              {refreshingBrief ? "Analyzing..." : "Refresh Rotation Brief"}
            </button>
          </div>

          {data?.rotation_brief && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
              <span className="rounded-full border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-0.5 font-semibold text-emerald-300">
                Top: {data.rotation_brief.top_sector}
              </span>
              <span className="rounded-full border border-rose-500/40 bg-rose-500/15 px-2.5 py-0.5 font-semibold text-rose-300">
                Avoid: {data.rotation_brief.avoid_sector}
              </span>
              <span className="ml-auto font-mono text-slate-500">
                Updated:{" "}
                {new Date(data.rotation_brief.updated_at).toLocaleString()}
              </span>
            </div>
          )}

          <div className="mt-4 flex-1 overflow-y-auto rounded-lg border border-slate-800/80 bg-slate-950/60 p-4">
            {loading ? (
              <div className="flex h-40 items-center justify-center text-sm text-slate-400">
                Loading capital rotation brief...
              </div>
            ) : data?.rotation_brief?.summary_markdown ? (
              <MarkdownBrief markdown={data.rotation_brief.summary_markdown} />
            ) : (
              <p className="text-sm text-slate-500">
                Click &ldquo;Refresh Rotation Brief&rdquo; to generate a
                cross-sector capital allocation brief.
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* Compact Quick Preview Cards into /vs-gold and /sectors */}
      <section
        aria-label="Panel Shortcuts"
        className="grid grid-cols-1 gap-4 md:grid-cols-2"
      >
        <Link
          href="/vs-gold"
          className="group flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/50 p-5 transition hover:border-amber-500/50 hover:bg-slate-900/90"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10">
                <Coins className="h-4 w-4 text-amber-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Assets vs. Gold (55-Year Secular Panel)
                </h3>
                <p className="text-xs text-slate-400">
                  USD, GBP, Fed Funds Cash, S&amp;P 500, Nasdaq &amp; US Houses
                  in oz of Gold
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-amber-300" />
          </div>

          <div className="mt-4 flex flex-wrap gap-2 text-[11px] tabular-nums">
            {goldPreview.length > 0 ? (
              goldPreview.slice(0, 4).map((asset) => (
                <span
                  key={asset.asset_key}
                  className="rounded-md border border-slate-800 bg-slate-950/80 px-2.5 py-1 text-slate-300"
                >
                  {asset.asset_key.replace("_GOLD", "")}:{" "}
                  <strong className="text-amber-300">
                    {asset.secular_percentile.toFixed(0)}%
                  </strong>{" "}
                  ({asset.valuation_zone})
                </span>
              ))
            ) : (
              <span className="text-slate-400">
                Inspect 10Y / 25Y / 55Y secular charts and all-time Gold highs
                &amp; lows.
              </span>
            )}
          </div>
        </Link>

        <Link
          href={
            topSector ? `/sectors?ticker=${topSector.ticker}` : "/sectors"
          }
          className="group flex flex-col justify-between rounded-xl border border-slate-800 bg-slate-900/50 p-5 transition hover:border-sky-500/50 hover:bg-slate-900/90"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/10">
                <Layers className="h-4 w-4 text-sky-400" />
              </div>
              <div>
                <h3 className="text-sm font-semibold text-white">
                  Fiscal &amp; Sector Flows Panel
                </h3>
                <p className="text-xs text-slate-400">
                  Deep-dive into agency outlays, Z-scores, rate bands &amp;
                  historical analogs
                </p>
              </div>
            </div>
            <ArrowRight className="h-4 w-4 text-slate-400 transition group-hover:translate-x-0.5 group-hover:text-sky-300" />
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2 text-[11px] tabular-nums">
            {topSector ? (
              <>
                <span className="rounded-md border border-sky-500/30 bg-sky-500/10 px-2.5 py-1 font-semibold text-sky-300">
                  Leader: {topSector.ticker} ({topSector.sector_name})
                </span>
                <span className="rounded-md border border-slate-800 bg-slate-950/80 px-2.5 py-1 text-slate-300">
                  Score:{" "}
                  <strong className="text-white">
                    {topSector.conviction_score.toFixed(1)}/100
                  </strong>
                </span>
                <span className="rounded-md border border-slate-800 bg-slate-950/80 px-2.5 py-1 text-slate-300">
                  12M vs SPY:{" "}
                  <strong className="text-emerald-400">
                    {formatPct(topSector.avg_12m_vs_spy_pct)}
                  </strong>
                </span>
              </>
            ) : (
              <span className="text-slate-400">
                Explore all 6 US sector ETFs and export X/Telegram macro briefs.
              </span>
            )}
          </div>
        </Link>
      </section>

      {/* Collapsible Signal History Log */}
      <section
        aria-label="Signal History Log"
        className="rounded-xl border border-slate-800 bg-slate-900/60"
      >
        <button
          type="button"
          onClick={() => setHistoryOpen((prev) => !prev)}
          className="flex w-full items-center justify-between px-5 py-4 text-left transition hover:bg-slate-900/90"
        >
          <div className="flex items-center gap-2.5">
            <History className="h-4 w-4 text-sky-400" />
            <div>
              <h2 className="text-sm font-semibold text-white">
                Signal History Log ({data?.signal_snapshots.length ?? 0}{" "}
                snapshots)
              </h2>
              <p className="text-xs text-slate-400">
                Historical daily rankings persisted to{" "}
                <code className="font-mono text-sky-300">signal_snapshots</code>{" "}
                on ingestion
              </p>
            </div>
          </div>
          {historyOpen ? (
            <ChevronUp className="h-4 w-4 text-slate-400" />
          ) : (
            <ChevronDown className="h-4 w-4 text-slate-400" />
          )}
        </button>

        {historyOpen && (
          <div className="border-t border-slate-800 p-4">
            {!data || data.signal_snapshots.length === 0 ? (
              <p className="text-xs text-slate-400">
                No signal snapshots recorded yet. Run ingestion to log rankings.
              </p>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-slate-800 bg-slate-950/80">
                <table className="w-full min-w-[640px] border-collapse text-left text-xs tabular-nums">
                  <thead>
                    <tr className="border-b border-slate-800 bg-slate-900 text-[11px] font-semibold uppercase tracking-wider text-slate-300">
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
                  <tbody className="divide-y divide-slate-800/80">
                    {data.signal_snapshots.map((snap) => (
                      <tr key={snap.id} className="hover:bg-slate-900/60">
                        <td className="px-3.5 py-2 font-mono text-slate-300">
                          {snap.snapshot_date}
                        </td>
                        <td className="px-3.5 py-2 font-bold text-white">
                          {snap.ticker}
                        </td>
                        <td className="px-3.5 py-2 text-right font-semibold text-white">
                          {snap.conviction_score.toFixed(1)}
                        </td>
                        <td className="px-3.5 py-2">
                          <span
                            className={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-semibold ${getTierBadgeStyle(
                              snap.decision_tier
                            )}`}
                          >
                            {snap.decision_tier}
                          </span>
                        </td>
                        <td className="px-3.5 py-2 text-right font-mono text-slate-200">
                          {formatZScore(snap.fiscal_impulse_zscore)}
                        </td>
                        <td className="px-3.5 py-2 text-slate-300">
                          {snap.regime_label}
                        </td>
                        <td className="px-3.5 py-2 text-right text-amber-300">
                          {formatPct(snap.gold_valuation_percentile, false)}
                        </td>
                        <td className="px-3.5 py-2 text-right text-slate-200">
                          {snap.etf_close !== null
                            ? `$${snap.etf_close.toFixed(2)}`
                            : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </section>
    </main>
  );
}
