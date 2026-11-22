"use client";

import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { MarkdownBrief } from "@/components/MarkdownBrief";
import {
  Activity,
  AlertCircle,
  BarChart3,
  Building2,
  Check,
  Copy,
  Gauge,
  History,
  RefreshCw,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  Bar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { API_BASE_URL } from "@/lib/api";

interface FiscalFlowRow {
  fiscal_year: number;
  budgetary_resources: number;
  obligations: number;
  yoy_growth_pct: number | null;
  fiscal_impulse_zscore: number | null;
  fiscal_impulse_label: string;
}

interface MacroRateRow {
  date: string;
  fed_funds: number;
  dgs10: number;
  yield_spread: number;
  regime_label: string;
}

interface RegimeDateRange {
  regime_label: string;
  start_date: string;
  end_date: string;
  months: number;
  avg_fed_funds: number;
  avg_yield_spread: number;
}

interface SectorValuationRow {
  date: string;
  close_price: number;
  gold_ratio: number;
  spy_ratio: number;
  valuation_percentile: number;
}

interface AnalystBrief {
  ticker: string;
  agency_code: string;
  regime_label: string;
  valuation_zone: string;
  summary_markdown: string;
  updated_at: string;
  regime_match_table?: string | null;
}

interface RegimeAnalogWindow {
  period: string;
  start_date: string;
  end_date: string;
  months: number;
  regime_label: string;
  avg_fed_funds: number;
  fiscal_year: number | null;
  fiscal_yoy_pct: number | null;
  fiscal_impulse_zscore: number | null;
  fiscal_impulse_label: string;
  matches_fiscal_direction: boolean;
  forward_6m_etf_return_pct: number | null;
  forward_6m_vs_spy_pct: number | null;
  forward_6m_vs_gld_pct: number | null;
  forward_12m_etf_return_pct: number | null;
  forward_12m_vs_spy_pct: number | null;
  forward_12m_vs_gld_pct: number | null;
}

interface RegimeAnalogsReport {
  ticker: string;
  current_regime: string | null;
  current_fiscal_impulse: string;
  analogs: RegimeAnalogWindow[];
  win_rate_pct: number | null;
  win_count: number;
  completed_sample_count: number;
  avg_6m_etf_return_pct: number | null;
  avg_12m_etf_return_pct: number | null;
  avg_12m_vs_spy_pct: number | null;
  avg_12m_vs_gld_pct: number | null;
}

interface SectorSummaryCard {
  ticker: string;
  sector_name: string;
  agency_code: string;
  agency_name: string;
  latest_fiscal_year: number | null;
  latest_budgetary_resources: number | null;
  latest_yoy_growth_pct: number | null;
  fiscal_impulse_zscore: number | null;
  fiscal_impulse_label: string;
  spending_impulse: string;
  current_regime_label: string | null;
  latest_close_price: number | null;
  valuation_percentile: number | null;
  gold_valuation_percentile: number | null;
  valuation_zone: string;
}

interface SectorsOverviewResponse {
  current_rate_regime: MacroRateRow | null;
  sectors: SectorSummaryCard[];
}

interface SectorDetailResponse {
  ticker: string;
  sector_name: string;
  agency_code: string;
  agency_name: string;
  latest_yoy_growth_pct: number | null;
  fiscal_impulse_zscore: number | null;
  fiscal_impulse_label: string;
  spending_impulse: string;
  fiscal_spending: FiscalFlowRow[];
  current_rate: MacroRateRow | null;
  matching_regime_periods: RegimeDateRange[];
  macro_rates: MacroRateRow[];
  latest_valuation: SectorValuationRow | null;
  gold_valuation_percentile: number | null;
  valuation_zone: string;
  avg_12m_return_in_regime_pct: number | null;
  matching_regime_sample_count: number;
  sector_valuations: SectorValuationRow[];
  regime_analogs: RegimeAnalogsReport;
  analyst_brief: AnalystBrief;
}

interface CombinedFiscalValuationPoint {
  date: string;
  fiscal_year: number;
  obligations_b: number | null;
  obligations_raw: number | null;
  yoy_growth_pct: number | null;
  close_price: number | null;
  gold_ratio: number | null;
  spy_ratio: number | null;
}

interface RegimeBand {
  x1: string;
  x2: string;
  regime: string;
}

interface TooltipPayloadEntry {
  name?: string;
  value?: number | string | null;
  color?: string;
  dataKey?: string;
  payload?: CombinedFiscalValuationPoint | MacroRateRow;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
  label?: string;
}

const REGIME_COLORS: Record<
  string,
  { badge: string; band: string; dot: string }
> = {
  Hiking: {
    badge: "border-rose-500/40 bg-rose-500/15 text-rose-300",
    band: "#f43f5e",
    dot: "bg-rose-400",
  },
  Cutting: {
    badge: "border-emerald-500/40 bg-emerald-500/15 text-emerald-300",
    band: "#10b981",
    dot: "bg-emerald-400",
  },
  "High-Pause": {
    badge: "border-amber-500/40 bg-amber-500/15 text-amber-300",
    band: "#f59e0b",
    dot: "bg-amber-400",
  },
  "Low-Pause": {
    badge: "border-sky-500/40 bg-sky-500/15 text-sky-300",
    band: "#38bdf8",
    dot: "bg-sky-400",
  },
};

function getRegimeStyle(regime: string | null | undefined) {
  if (!regime || !(regime in REGIME_COLORS)) {
    return {
      badge: "border-slate-700 bg-slate-800/80 text-slate-300",
      band: "#64748b",
      dot: "bg-slate-400",
    };
  }
  return REGIME_COLORS[regime];
}

function getValuationBadgeStyle(zone: string): string {
  if (zone === "Cheap") {
    return "border-emerald-500/40 bg-emerald-500/15 text-emerald-300";
  }
  if (zone === "Expensive") {
    return "border-rose-500/40 bg-rose-500/15 text-rose-300";
  }
  if (zone === "Fair" || zone === "Normal") {
    return "border-amber-500/40 bg-amber-500/15 text-amber-200";
  }
  return "border-slate-700 bg-slate-800 text-slate-300";
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

function formatZScore(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}`;
}

function formatReturnTextColor(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "text-slate-500";
  }
  return value >= 0
    ? "font-semibold text-emerald-400"
    : "font-semibold text-rose-400";
}

function formatPct(value: number | null | undefined, signed = true): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  const prefix = signed && value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}%`;
}

function buildSocialExportText(detail: SectorDetailResponse): string {
  const zStr = formatZScore(detail.fiscal_impulse_zscore);
  const yoyStr = formatPct(detail.latest_yoy_growth_pct);
  const regime = detail.current_rate?.regime_label ?? "Unknown";
  const ffStr = detail.current_rate
    ? `${detail.current_rate.fed_funds.toFixed(2)}%`
    : "—";
  const dgs10Str = detail.current_rate
    ? `${detail.current_rate.dgs10.toFixed(2)}%`
    : "—";
  const goldPctStr =
    detail.gold_valuation_percentile !== null &&
    detail.gold_valuation_percentile !== undefined
      ? `${detail.gold_valuation_percentile.toFixed(1)}%`
      : "—";
  const goldRatioStr = detail.latest_valuation
    ? detail.latest_valuation.gold_ratio.toFixed(4)
    : "—";
  const analogs = detail.regime_analogs;
  const winRateStr =
    analogs?.win_rate_pct !== null && analogs?.win_rate_pct !== undefined
      ? `${analogs.win_rate_pct.toFixed(0)}% (${analogs.win_count}/${analogs.completed_sample_count})`
      : "—";
  const avg12mStr = formatPct(analogs?.avg_12m_etf_return_pct);
  const avgSpyStr = formatPct(analogs?.avg_12m_vs_spy_pct);
  const avgGldStr = formatPct(analogs?.avg_12m_vs_gld_pct);

  return [
    `Sector: ${detail.sector_name} ($${detail.ticker}) | Agency ${detail.agency_code} (${detail.agency_name})`,
    `Fiscal Impulse: ${detail.fiscal_impulse_label} (Z: ${zStr} | YoY: ${yoyStr})`,
    `Rate Regime: ${regime} (Fed Funds: ${ffStr} | 10Y: ${dgs10Str})`,
    `Valuation Percentile vs Gold: ${goldPctStr} (${detail.valuation_zone} | ETF/GLD: ${goldRatioStr})`,
    `Historical Win Rate: ${winRateStr} | Avg 12M: ${avg12mStr} | vs SPY: ${avgSpyStr} | vs GLD: ${avgGldStr}`,
  ].join("\n");
}

function formatUsdCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  if (Math.abs(value) >= 1e12) {
    return `$${(value / 1e12).toFixed(2)}T`;
  }
  if (Math.abs(value) >= 1e9) {
    return `$${(value / 1e9).toFixed(1)}B`;
  }
  if (Math.abs(value) >= 1e6) {
    return `$${(value / 1e6).toFixed(1)}M`;
  }
  return `$${value.toFixed(2)}`;
}

function formatShortDate(dateStr: string): string {
  if (dateStr.length >= 7) {
    return dateStr.slice(0, 7);
  }
  return dateStr;
}

const SUPPORTED_TICKERS = new Set(["ITA", "XLE", "XLV", "IYT", "XLK", "PAVE"]);

function normalizeTicker(raw: string | null): string {
  if (!raw) return "ITA";
  const upper = raw.trim().toUpperCase();
  return SUPPORTED_TICKERS.has(upper) ? upper : "ITA";
}

function FiscalValuationTooltip({
  active,
  payload,
  label,
}: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const row = payload[0]?.payload as
    | CombinedFiscalValuationPoint
    | undefined;
  if (!row) {
    return null;
  }

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/95 p-3 text-xs shadow-xl backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between gap-4 border-b border-slate-800 pb-1 font-semibold text-slate-100">
        <span>{label}</span>
        <span className="text-slate-400">FY{row.fiscal_year}</span>
      </div>
      <div className="space-y-1 tabular-nums">
        <div className="flex justify-between gap-4">
          <span className="text-sky-300">Obligations:</span>
          <span className="font-medium text-slate-100">
            {formatUsdCompact(row.obligations_raw)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-amber-300">Fiscal YoY:</span>
          <span className="font-medium text-slate-100">
            {formatPct(row.yoy_growth_pct)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-emerald-300">ETF Close:</span>
          <span className="font-medium text-slate-100">
            {row.close_price !== null ? `$${row.close_price.toFixed(2)}` : "—"}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-yellow-300">ETF / GLD:</span>
          <span className="font-medium text-slate-100">
            {row.gold_ratio !== null ? row.gold_ratio.toFixed(4) : "—"}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-violet-300">ETF / SPY:</span>
          <span className="font-medium text-slate-100">
            {row.spy_ratio !== null ? row.spy_ratio.toFixed(4) : "—"}
          </span>
        </div>
      </div>
    </div>
  );
}

function RateRegimeTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }
  const row = payload[0]?.payload as MacroRateRow | undefined;
  if (!row) {
    return null;
  }
  const style = getRegimeStyle(row.regime_label);

  return (
    <div className="rounded-lg border border-slate-700 bg-slate-900/95 p-3 text-xs shadow-xl backdrop-blur">
      <div className="mb-1.5 flex items-center justify-between gap-4 border-b border-slate-800 pb-1">
        <span className="font-semibold text-slate-100">{label}</span>
        <span
          className={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${style.badge}`}
        >
          {row.regime_label}
        </span>
      </div>
      <div className="space-y-1 tabular-nums">
        <div className="flex justify-between gap-4">
          <span className="text-sky-300">Fed Funds:</span>
          <span className="font-medium text-slate-100">
            {row.fed_funds.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-amber-300">10Y Treasury (DGS10):</span>
          <span className="font-medium text-slate-100">
            {row.dgs10.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="text-emerald-300">10Y-FF Spread:</span>
          <span className="font-medium text-slate-100">
            {formatPct(row.yield_spread)}
          </span>
        </div>
      </div>
    </div>
  );
}

function SectorsWorkspace() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const queryTicker = normalizeTicker(searchParams.get("ticker"));

  const [overview, setOverview] = useState<SectorsOverviewResponse | null>(
    null
  );
  const [selectedTicker, setSelectedTicker] = useState<string>(queryTicker);
  const [detail, setDetail] = useState<SectorDetailResponse | null>(null);
  const [loadingOverview, setLoadingOverview] = useState<boolean>(true);
  const [loadingDetail, setLoadingDetail] = useState<boolean>(true);
  const [refreshingBrief, setRefreshingBrief] = useState<boolean>(false);
  const [copiedBrief, setCopiedBrief] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    setSelectedTicker(queryTicker);
  }, [queryTicker]);

  const handleSelectSector = (ticker: string) => {
    setSelectedTicker(ticker);
    router.replace(`/sectors?ticker=${ticker}`, { scroll: false });
  };

  const loadOverview = useCallback(async () => {
    setLoadingOverview(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/sectors`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(`GET /api/sectors returned HTTP ${res.status}`);
      }
      const data: SectorsOverviewResponse = await res.json();
      setOverview(data);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `Unable to reach Rust API at ${API_BASE_URL}: ${err.message}`
          : `Unable to reach Rust API at ${API_BASE_URL}`
      );
    } finally {
      setLoadingOverview(false);
    }
  }, []);

  const loadSectorDetail = useCallback(async (ticker: string) => {
    setLoadingDetail(true);
    try {
      const res = await fetch(`${API_BASE_URL}/api/sectors/${ticker}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        throw new Error(
          `GET /api/sectors/${ticker} returned HTTP ${res.status}`
        );
      }
      const data: SectorDetailResponse = await res.json();
      setDetail(data);
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `Failed loading ${ticker} detail: ${err.message}`
          : `Failed loading ${ticker} detail`
      );
    } finally {
      setLoadingDetail(false);
    }
  }, []);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  useEffect(() => {
    void loadSectorDetail(selectedTicker);
  }, [selectedTicker, loadSectorDetail]);

  const handleRefreshAnalysis = async () => {
    if (refreshingBrief) return;
    setRefreshingBrief(true);
    try {
      const res = await fetch(
        `${API_BASE_URL}/api/sectors/${selectedTicker}/analyze`,
        {
          method: "POST",
        }
      );
      if (!res.ok) {
        throw new Error(
          `POST /api/sectors/${selectedTicker}/analyze returned HTTP ${res.status}`
        );
      }
      const brief: AnalystBrief = await res.json();
      setDetail((prev) => (prev ? { ...prev, analyst_brief: brief } : prev));
      setErrorMsg(null);
    } catch (err) {
      setErrorMsg(
        err instanceof Error
          ? `Failed refreshing analysis: ${err.message}`
          : "Failed refreshing analysis"
      );
    } finally {
      setRefreshingBrief(false);
    }
  };

  const handleCopySocialBrief = async () => {
    if (!detail) return;
    const text = buildSocialExportText(detail);
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopiedBrief(true);
      setTimeout(() => setCopiedBrief(false), 2500);
    } catch {
      setErrorMsg("Unable to write macro brief to clipboard.");
    }
  };

  const chart1Data = useMemo<CombinedFiscalValuationPoint[]>(() => {
    if (!detail) return [];

    const fiscalByYear = new Map<number, FiscalFlowRow>();
    for (const row of detail.fiscal_spending) {
      fiscalByYear.set(row.fiscal_year, row);
    }

    if (detail.sector_valuations.length === 0) {
      return detail.fiscal_spending.map((row) => ({
        date: `FY${row.fiscal_year}`,
        fiscal_year: row.fiscal_year,
        obligations_b: Number((row.obligations / 1e9).toFixed(2)),
        obligations_raw: row.obligations,
        yoy_growth_pct: row.yoy_growth_pct,
        close_price: null,
        gold_ratio: null,
        spy_ratio: null,
      }));
    }

    return detail.sector_valuations.map((val) => {
      const year = Number.parseInt(val.date.slice(0, 4), 10);
      const month = Number.parseInt(val.date.slice(5, 7), 10);
      // US federal fiscal year runs Oct (FY-1) through Sep (FY).
      const fy = month >= 10 ? year + 1 : year;
      const fiscal = fiscalByYear.get(fy) ?? fiscalByYear.get(year);

      return {
        date: val.date,
        fiscal_year: fiscal?.fiscal_year ?? fy,
        obligations_b: fiscal
          ? Number((fiscal.obligations / 1e9).toFixed(2))
          : null,
        obligations_raw: fiscal ? fiscal.obligations : null,
        yoy_growth_pct: fiscal ? fiscal.yoy_growth_pct : null,
        close_price: val.close_price,
        gold_ratio: val.gold_ratio,
        spy_ratio: val.spy_ratio,
      };
    });
  }, [detail]);

  const regimeBands = useMemo<RegimeBand[]>(() => {
    if (!detail || detail.macro_rates.length === 0) return [];

    const bands: RegimeBand[] = [];
    let current: RegimeBand = {
      x1: detail.macro_rates[0].date,
      x2: detail.macro_rates[0].date,
      regime: detail.macro_rates[0].regime_label,
    };

    for (let i = 1; i < detail.macro_rates.length; i++) {
      const row = detail.macro_rates[i];
      if (row.regime_label === current.regime) {
        current.x2 = row.date;
      } else {
        bands.push(current);
        current = {
          x1: row.date,
          x2: row.date,
          regime: row.regime_label,
        };
      }
    }
    bands.push(current);
    return bands;
  }, [detail]);

  const currentPercentile = detail?.latest_valuation?.valuation_percentile ?? null;
  const clampedPercentile =
    currentPercentile !== null
      ? Math.max(0, Math.min(100, currentPercentile))
      : null;

  const activeCard =
    overview?.sectors.find((s) => s.ticker === selectedTicker) ?? null;
  const currentRegimeLabel =
    detail?.current_rate?.regime_label ??
    overview?.current_rate_regime?.regime_label ??
    "Unavailable";
  const currentRegimeStyle = getRegimeStyle(currentRegimeLabel);

  return (
    <main className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-5 px-4 py-6 sm:px-6 lg:px-8">
      {/* Header */}
      <header className="flex flex-col justify-between gap-3 border-b border-slate-800/80 pb-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-sky-400">
            <Activity className="h-4 w-4" />
            <span>US Macro Capital-Flow Decision Panel</span>
          </div>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white">
            Fiscal Impulse, Rate Regimes &amp; Sector Relative Value
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <div className="flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-1.5">
            <span className="text-slate-400">Active Rate Regime:</span>
            <span
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-semibold ${currentRegimeStyle.badge}`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${currentRegimeStyle.dot}`}
              />
              {currentRegimeLabel}
            </span>
          </div>
          {overview?.current_rate_regime && (
            <div className="rounded-lg border border-slate-800 bg-slate-900/70 px-3 py-1.5 tabular-nums text-slate-300">
              FF:{" "}
              <span className="font-semibold text-white">
                {overview.current_rate_regime.fed_funds.toFixed(2)}%
              </span>{" "}
              | 10Y:{" "}
              <span className="font-semibold text-white">
                {overview.current_rate_regime.dgs10.toFixed(2)}%
              </span>
            </div>
          )}
          <button
            type="button"
            onClick={handleCopySocialBrief}
            disabled={!detail || loadingDetail}
            title="Copy formatted 5-line macro summary for X / Telegram"
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 font-semibold transition disabled:cursor-not-allowed disabled:opacity-50 ${
              copiedBrief
                ? "border-emerald-500/50 bg-emerald-500/20 text-emerald-300"
                : "border-sky-500/40 bg-sky-500/15 text-sky-300 hover:bg-sky-500/25"
            }`}
          >
            {copiedBrief ? (
              <>
                <Check className="h-3.5 w-3.5" />
                Copied for X/Telegram!
              </>
            ) : (
              <>
                <Copy className="h-3.5 w-3.5" />
                Copy Macro Brief for X/Telegram
              </>
            )}
          </button>
        </div>
      </header>

      {/* Connection / API Error Banner */}
      {errorMsg && (
        <div className="flex items-start gap-3 rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-sm text-rose-200">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" />
          <div>
            <p className="font-semibold">Backend Connection Issue</p>
            <p className="mt-0.5 text-xs text-rose-200/80">{errorMsg}</p>
            <p className="mt-1 text-xs text-slate-300">
              Ensure the Rust API server is running on{" "}
              <code className="rounded bg-slate-900 px-1.5 py-0.5 font-mono text-sky-300">
                {API_BASE_URL}
              </code>{" "}
              via <code className="font-mono text-sky-300">cargo run</code>.
            </p>
          </div>
        </div>
      )}

      {/* Top Sector Selector Bar */}
      <section aria-label="Sector Selector" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {(overview?.sectors ?? [
          { ticker: "ITA", sector_name: "Defense", agency_code: "097", agency_name: "Defense" },
          { ticker: "XLE", sector_name: "Energy", agency_code: "089", agency_name: "Energy" },
          { ticker: "XLV", sector_name: "Healthcare", agency_code: "075", agency_name: "HHS" },
          { ticker: "IYT", sector_name: "Transportation", agency_code: "069", agency_name: "Transportation" },
          { ticker: "XLK", sector_name: "Technology", agency_code: "013", agency_name: "Commerce" },
          { ticker: "PAVE", sector_name: "Infrastructure", agency_code: "069", agency_name: "Transportation" },
        ]).map((sector) => {
          const isSelected = sector.ticker === selectedTicker;
          const card = "valuation_zone" in sector ? sector : null;
          const zone = card?.valuation_zone ?? "Unknown";
          const regime = card?.current_regime_label ?? "—";
          const yoy = card?.latest_yoy_growth_pct ?? null;
          const zscore = card?.fiscal_impulse_zscore ?? null;
          const impulseLabel = card?.fiscal_impulse_label ?? "Neutral";
          const pct = card?.valuation_percentile ?? null;
          const regimeBadge = getRegimeStyle(card?.current_regime_label);

          return (
            <button
              key={sector.ticker}
              type="button"
              onClick={() => handleSelectSector(sector.ticker)}
              className={`group flex flex-col justify-between rounded-xl border p-4 text-left transition-all ${
                isSelected
                  ? "border-sky-500 bg-slate-900 shadow-lg shadow-sky-950/40 ring-1 ring-sky-500/40"
                  : "border-slate-800 bg-slate-900/50 hover:border-slate-700 hover:bg-slate-900/90"
              }`}
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-bold tracking-tight text-white">
                      {sector.ticker}
                    </span>
                    <span className="rounded bg-slate-800 px-1.5 py-0.5 font-mono text-[11px] text-slate-400">
                      AG-{sector.agency_code}
                    </span>
                  </div>
                  <p className="text-xs font-medium text-slate-400">
                    {sector.sector_name} ({sector.agency_name})
                  </p>
                </div>
                <span
                  className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${getValuationBadgeStyle(
                    zone
                  )}`}
                >
                  {zone}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-2 gap-2 border-t border-slate-800/80 pt-3 text-xs tabular-nums">
                <div>
                  <span className="block text-[11px] text-slate-500">
                    Fiscal YoY / Z-Score
                  </span>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <span
                      className={`font-semibold ${
                        yoy === null
                          ? "text-slate-400"
                          : yoy >= 0
                            ? "text-emerald-400"
                            : "text-rose-400"
                      }`}
                    >
                      {loadingOverview ? "..." : formatPct(yoy)}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.2 text-[10px] font-medium ${getImpulseBadgeStyle(
                        impulseLabel
                      )}`}
                    >
                      {loadingOverview
                        ? "..."
                        : `${impulseLabel} (${formatZScore(zscore)})`}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="block text-[11px] text-slate-500">
                    10Y Rank / Regime
                  </span>
                  <div className="mt-0.5 flex items-center justify-end gap-1.5">
                    <span className="font-semibold text-slate-200">
                      {pct !== null ? `${pct.toFixed(0)}%` : "—"}
                    </span>
                    <span
                      className={`rounded border px-1.5 py-0.2 text-[10px] font-medium ${regimeBadge.badge}`}
                    >
                      {regime}
                    </span>
                  </div>
                </div>
              </div>
            </button>
          );
        })}
      </section>

      {/* Main Decision Workspace */}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-12">
        {/* Left Column: Charts (8 cols on XL) */}
        <div className="flex flex-col gap-5 xl:col-span-8">
          {/* Valuation Percentile Gauge + Key Telemetry Strip */}
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
            <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2.5">
                <Gauge className="h-5 w-5 text-sky-400" />
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    10-Year Valuation Percentile Gauge — {selectedTicker}
                  </h2>
                  <p className="text-xs text-slate-400">
                    Blended relative valuation rank vs. Gold (GLD) &amp; S&amp;P
                    500 (SPY)
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3 tabular-nums">
                <div className="text-right">
                  <span className="block text-[11px] text-slate-500">
                    Current Percentile
                  </span>
                  <span className="text-xl font-bold text-white">
                    {currentPercentile !== null
                      ? `${currentPercentile.toFixed(1)}%`
                      : "—"}
                  </span>
                </div>
                <span
                  className={`rounded-full border px-3 py-1 text-xs font-semibold ${getValuationBadgeStyle(
                    detail?.valuation_zone ?? activeCard?.valuation_zone ?? "Unknown"
                  )}`}
                >
                  {detail?.valuation_zone ?? activeCard?.valuation_zone ?? "Unknown"}
                </span>
              </div>
            </div>

            {/* 0-100% Gauge Bar */}
            <div className="mt-4">
              <div className="relative h-4 w-full overflow-hidden rounded-full bg-slate-800 ring-1 ring-slate-700/80">
                {/* <25% Cheap */}
                <div
                  className="absolute inset-y-0 left-0 bg-emerald-500/35"
                  style={{ width: "25%" }}
                />
                {/* 25-75% Normal */}
                <div
                  className="absolute inset-y-0 bg-amber-500/20"
                  style={{ left: "25%", width: "50%" }}
                />
                {/* >75% Expensive */}
                <div
                  className="absolute inset-y-0 right-0 bg-rose-500/35"
                  style={{ width: "25%" }}
                />

                {/* Threshold dividers */}
                <div
                  className="absolute inset-y-0 w-0.5 bg-slate-400/60"
                  style={{ left: "25%" }}
                />
                <div
                  className="absolute inset-y-0 w-0.5 bg-slate-400/60"
                  style={{ left: "75%" }}
                />

                {/* Current Marker */}
                {clampedPercentile !== null && (
                  <div
                    className="absolute top-0 bottom-0 w-1.5 -translate-x-1/2 rounded-full bg-white shadow-[0_0_10px_rgba(255,255,255,0.9)] transition-all duration-300"
                    style={{ left: `${clampedPercentile}%` }}
                  />
                )}
              </div>

              <div className="mt-1.5 flex justify-between text-[11px] font-medium text-slate-400 tabular-nums">
                <span className="text-emerald-400">0% – 25% Cheap</span>
                <span className="text-amber-300">25% – 75% Normal</span>
                <span className="text-rose-400">75% – 100% Expensive</span>
              </div>
            </div>

            {/* Telemetry Cards */}
            <div className="mt-4 grid grid-cols-2 gap-3 border-t border-slate-800/80 pt-4 sm:grid-cols-5">
              <div className="rounded-lg bg-slate-950/60 p-2.5 tabular-nums">
                <span className="block text-[11px] text-slate-500">
                  ETF Close
                </span>
                <span className="text-sm font-semibold text-white">
                  {detail?.latest_valuation
                    ? `$${detail.latest_valuation.close_price.toFixed(2)}`
                    : "—"}
                </span>
              </div>
              <div className="rounded-lg bg-slate-950/60 p-2.5 tabular-nums">
                <span className="block text-[11px] text-slate-500">
                  ETF / GLD (Gold %ile)
                </span>
                <span className="text-sm font-semibold text-yellow-300">
                  {detail?.latest_valuation
                    ? `${detail.latest_valuation.gold_ratio.toFixed(4)}${
                        detail.gold_valuation_percentile !== null &&
                        detail.gold_valuation_percentile !== undefined
                          ? ` (${detail.gold_valuation_percentile.toFixed(0)}%)`
                          : ""
                      }`
                    : "—"}
                </span>
              </div>
              <div className="rounded-lg bg-slate-950/60 p-2.5 tabular-nums">
                <span className="block text-[11px] text-slate-500">
                  ETF / SPY Ratio
                </span>
                <span className="text-sm font-semibold text-violet-300">
                  {detail?.latest_valuation
                    ? detail.latest_valuation.spy_ratio.toFixed(4)
                    : "—"}
                </span>
              </div>
              <div className="rounded-lg bg-slate-950/60 p-2.5 tabular-nums">
                <span className="block text-[11px] text-slate-500">
                  Fiscal Impulse (5Y Z)
                </span>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <span className="text-sm font-semibold text-white">
                    {formatZScore(detail?.fiscal_impulse_zscore)}
                  </span>
                  <span
                    className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${getImpulseBadgeStyle(
                      detail?.fiscal_impulse_label ?? "Neutral"
                    )}`}
                  >
                    {detail?.fiscal_impulse_label ?? "—"}
                  </span>
                </div>
              </div>
              <div className="rounded-lg bg-slate-950/60 p-2.5 tabular-nums">
                <span className="block text-[11px] text-slate-500">
                  Avg 12M Return in Regime
                </span>
                <span
                  className={`text-sm font-semibold ${
                    detail?.avg_12m_return_in_regime_pct === null ||
                    detail?.avg_12m_return_in_regime_pct === undefined
                      ? "text-slate-400"
                      : detail.avg_12m_return_in_regime_pct >= 0
                        ? "text-emerald-400"
                        : "text-rose-400"
                  }`}
                >
                  {formatPct(detail?.avg_12m_return_in_regime_pct)}
                </span>
              </div>
            </div>
          </section>

          {/* Chart 1: Fiscal Flow vs. Sector Valuation */}
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
            <div className="mb-4 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2.5">
                <BarChart3 className="h-5 w-5 text-sky-400" />
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    Chart 1: Fiscal Flow vs. Sector Valuation ({selectedTicker}
                    )
                  </h2>
                  <p className="text-xs text-slate-400">
                    10-year agency obligations ($B) &amp; YoY growth % overlaid
                    with ETF price, GLD ratio &amp; SPY ratio
                  </p>
                </div>
              </div>
              <span
                className={`inline-flex items-center gap-1.5 self-start rounded-lg border px-2.5 py-1 text-xs font-medium ${getImpulseBadgeStyle(
                  detail?.fiscal_impulse_label ?? "Neutral"
                )}`}
              >
                <Building2 className="h-3.5 w-3.5" />
                Impulse:{" "}
                <strong>{detail?.fiscal_impulse_label ?? "—"}</strong>{" "}
                <span className="font-mono">
                  (Z: {formatZScore(detail?.fiscal_impulse_zscore)})
                </span>
              </span>
            </div>

            <div className="h-[310px] w-full">
              {loadingDetail ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">
                  Loading fiscal &amp; valuation time series...
                </div>
              ) : chart1Data.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">
                  No fiscal spending or valuation data available yet. Run
                  ingestion first.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={chart1Data}
                    margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatShortDate}
                      stroke="#64748b"
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      minTickGap={28}
                    />
                    <YAxis
                      yAxisId="fiscal"
                      orientation="left"
                      stroke="#38bdf8"
                      tick={{ fill: "#38bdf8", fontSize: 11 }}
                      tickFormatter={(v: number) => `$${v}B`}
                      width={60}
                    />
                    <YAxis
                      yAxisId="price"
                      orientation="right"
                      stroke="#10b981"
                      tick={{ fill: "#10b981", fontSize: 11 }}
                      tickFormatter={(v: number) => `$${v}`}
                      width={52}
                    />
                    <YAxis yAxisId="ratio" hide domain={["auto", "auto"]} />
                    <YAxis yAxisId="yoy" hide domain={["auto", "auto"]} />
                    <Tooltip content={<FiscalValuationTooltip />} />
                    <Legend
                      wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }}
                    />
                    <Bar
                      yAxisId="fiscal"
                      dataKey="obligations_b"
                      name="Obligations ($B)"
                      fill="#0284c7"
                      fillOpacity={0.35}
                      radius={[2, 2, 0, 0]}
                    />
                    <Line
                      yAxisId="price"
                      type="monotone"
                      dataKey="close_price"
                      name={`${selectedTicker} Close ($)`}
                      stroke="#10b981"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                    />
                    <Line
                      yAxisId="yoy"
                      type="monotone"
                      dataKey="yoy_growth_pct"
                      name="Fiscal YoY %"
                      stroke="#f59e0b"
                      strokeWidth={1.75}
                      strokeDasharray="4 3"
                      dot={false}
                      connectNulls
                    />
                    <Line
                      yAxisId="ratio"
                      type="monotone"
                      dataKey="gold_ratio"
                      name="ETF / GLD"
                      stroke="#eab308"
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls
                    />
                    <Line
                      yAxisId="ratio"
                      type="monotone"
                      dataKey="spy_ratio"
                      name="ETF / SPY"
                      stroke="#a855f7"
                      strokeWidth={1.5}
                      dot={false}
                      connectNulls
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>

          {/* Chart 2: Interest Rate Regime Timeline & Spread */}
          <section className="rounded-xl border border-slate-800 bg-slate-900/60 p-5">
            <div className="mb-4 flex flex-col justify-between gap-2 sm:flex-row sm:items-center">
              <div className="flex items-center gap-2.5">
                <TrendingUp className="h-5 w-5 text-emerald-400" />
                <div>
                  <h2 className="text-sm font-semibold text-white">
                    Chart 2: Interest Rate Regime Timeline &amp; Spread
                  </h2>
                  <p className="text-xs text-slate-400">
                    10-year monthly FEDFUNDS, DGS10, and yield spread shaded by
                    monetary regime
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap gap-1.5 text-[11px]">
                {(["Hiking", "High-Pause", "Cutting", "Low-Pause"] as const).map(
                  (label) => {
                    const st = getRegimeStyle(label);
                    return (
                      <span
                        key={label}
                        className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-medium ${st.badge}`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${st.dot}`} />
                        {label}
                      </span>
                    );
                  }
                )}
              </div>
            </div>

            <div className="h-[290px] w-full">
              {loadingDetail ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-400">
                  Loading macro rate regime timeline...
                </div>
              ) : !detail || detail.macro_rates.length === 0 ? (
                <div className="flex h-full items-center justify-center text-sm text-slate-500">
                  No macro interest rate data available yet. Run ingestion
                  first.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={detail.macro_rates}
                    margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
                    {regimeBands.map((band, idx) => (
                      <ReferenceArea
                        key={`${band.regime}-${idx}`}
                        x1={band.x1}
                        x2={band.x2}
                        fill={getRegimeStyle(band.regime).band}
                        fillOpacity={0.12}
                        ifOverflow="extendDomain"
                      />
                    ))}
                    <ReferenceLine
                      y={0}
                      stroke="#64748b"
                      strokeDasharray="3 3"
                    />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatShortDate}
                      stroke="#64748b"
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      minTickGap={28}
                    />
                    <YAxis
                      stroke="#94a3b8"
                      tick={{ fill: "#94a3b8", fontSize: 11 }}
                      tickFormatter={(v: number) => `${v}%`}
                      width={48}
                    />
                    <Tooltip content={<RateRegimeTooltip />} />
                    <Legend
                      wrapperStyle={{ fontSize: "11px", paddingTop: "8px" }}
                    />
                    <Area
                      type="monotone"
                      dataKey="yield_spread"
                      name="Yield Spread (10Y - FF)"
                      stroke="#10b981"
                      fill="#10b981"
                      fillOpacity={0.14}
                      strokeWidth={1.75}
                    />
                    <Line
                      type="monotone"
                      dataKey="fed_funds"
                      name="Fed Funds (%)"
                      stroke="#38bdf8"
                      strokeWidth={2}
                      dot={false}
                    />
                    <Line
                      type="monotone"
                      dataKey="dgs10"
                      name="10Y Treasury (%)"
                      stroke="#f59e0b"
                      strokeWidth={2}
                      dot={false}
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>

            {detail && detail.matching_regime_periods.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-800/80 pt-3 text-xs">
                <span className="text-slate-400">
                  Matching {currentRegimeLabel} Windows:
                </span>
                {detail.matching_regime_periods.map((period, idx) => (
                  <span
                    key={`${period.start_date}-${idx}`}
                    className="rounded-md border border-slate-800 bg-slate-950/70 px-2 py-0.5 font-mono text-[11px] text-slate-300"
                  >
                    {formatShortDate(period.start_date)} →{" "}
                    {formatShortDate(period.end_date)} ({period.months}m)
                  </span>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right Column: AI Macro Analyst Brief Panel (4 cols on XL) */}
        <aside className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/60 p-5 xl:col-span-4">
          <div className="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
            <div className="flex items-center gap-2.5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/10">
                <Sparkles className="h-4 w-4 text-sky-400" />
              </div>
              <div>
                <h2 className="text-sm font-semibold text-white">
                  AI Macro Analyst Brief
                </h2>
                <p className="text-xs text-slate-400">
                  Tool-grounded synthesis for {selectedTicker}
                </p>
              </div>
            </div>

            <button
              type="button"
              onClick={handleRefreshAnalysis}
              disabled={refreshingBrief || loadingDetail}
              className="inline-flex items-center gap-1.5 rounded-lg border border-sky-500/40 bg-sky-500/15 px-3 py-1.5 text-xs font-semibold text-sky-300 transition hover:bg-sky-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <RefreshCw
                className={`h-3.5 w-3.5 ${refreshingBrief ? "animate-spin" : ""}`}
              />
              {refreshingBrief ? "Analyzing..." : "Refresh AI Analysis"}
            </button>
          </div>

          {detail?.analyst_brief && (
            <div className="mt-3 flex flex-wrap items-center gap-2 text-[11px]">
              <span
                className={`rounded-full border px-2 py-0.5 font-medium ${
                  getRegimeStyle(detail.analyst_brief.regime_label).badge
                }`}
              >
                Regime: {detail.analyst_brief.regime_label}
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 font-medium ${getValuationBadgeStyle(
                  detail.analyst_brief.valuation_zone
                )}`}
              >
                Zone: {detail.analyst_brief.valuation_zone}
              </span>
              <span className="ml-auto font-mono text-slate-500">
                Updated:{" "}
                {new Date(detail.analyst_brief.updated_at).toLocaleString()}
              </span>
            </div>
          )}

          <div className="mt-4 flex-1 overflow-y-auto rounded-lg border border-slate-800/80 bg-slate-950/60 p-4">
            {loadingDetail ? (
              <div className="flex h-40 items-center justify-center text-sm text-slate-400">
                Generating macro analyst brief...
              </div>
            ) : detail?.analyst_brief?.summary_markdown ? (
              <MarkdownBrief markdown={detail.analyst_brief.summary_markdown} />
            ) : (
              <p className="text-sm text-slate-500">
                Select a sector or click &ldquo;Refresh AI Analysis&rdquo; to
                generate a macro capital-flow brief.
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* Historical Regime Analogs Table */}
      <section
        aria-label="Historical Regime Analogs"
        className="rounded-xl border border-slate-700/80 bg-slate-900/80 p-5 shadow-lg"
      >
        <div className="mb-4 flex flex-col justify-between gap-3 border-b border-slate-800 pb-4 lg:flex-row lg:items-center">
          <div className="flex items-center gap-2.5">
            <History className="h-5 w-5 text-sky-400" />
            <div>
              <h2 className="text-base font-semibold text-white">
                Historical Regime Analogs — {selectedTicker}
              </h2>
              <p className="text-xs text-slate-400">
                Deterministic forward 6M &amp; 12M returns across past{" "}
                <span className="font-semibold text-slate-200">
                  {detail?.regime_analogs?.current_regime ?? currentRegimeLabel}
                </span>{" "}
                rate-regime windows vs. SPY &amp; GLD
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs tabular-nums">
            <span className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-slate-300">
              Win Rate:{" "}
              <strong className="text-white">
                {detail?.regime_analogs?.win_rate_pct !== null &&
                detail?.regime_analogs?.win_rate_pct !== undefined
                  ? `${detail.regime_analogs.win_rate_pct.toFixed(0)}% (${detail.regime_analogs.win_count}/${detail.regime_analogs.completed_sample_count})`
                  : "—"}
              </strong>
            </span>
            <span className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-slate-300">
              Avg 6M:{" "}
              <span
                className={formatReturnTextColor(
                  detail?.regime_analogs?.avg_6m_etf_return_pct
                )}
              >
                {formatPct(detail?.regime_analogs?.avg_6m_etf_return_pct)}
              </span>
            </span>
            <span className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-slate-300">
              Avg 12M:{" "}
              <span
                className={formatReturnTextColor(
                  detail?.regime_analogs?.avg_12m_etf_return_pct
                )}
              >
                {formatPct(detail?.regime_analogs?.avg_12m_etf_return_pct)}
              </span>
            </span>
            <span className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-slate-300">
              Avg vs SPY:{" "}
              <span
                className={formatReturnTextColor(
                  detail?.regime_analogs?.avg_12m_vs_spy_pct
                )}
              >
                {formatPct(detail?.regime_analogs?.avg_12m_vs_spy_pct)}
              </span>
            </span>
            <span className="rounded-lg border border-slate-700 bg-slate-950 px-2.5 py-1 text-slate-300">
              Avg vs GLD:{" "}
              <span
                className={formatReturnTextColor(
                  detail?.regime_analogs?.avg_12m_vs_gld_pct
                )}
              >
                {formatPct(detail?.regime_analogs?.avg_12m_vs_gld_pct)}
              </span>
            </span>
          </div>
        </div>

        <div className="overflow-x-auto rounded-lg border border-slate-700/80 bg-slate-950/90">
          {loadingDetail ? (
            <div className="p-8 text-center text-sm text-slate-400">
              Computing historical regime analog returns...
            </div>
          ) : !detail || detail.regime_analogs.analogs.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-400">
              No matching historical rate-regime windows found yet.
            </div>
          ) : (
            <table className="w-full min-w-[820px] border-collapse text-left text-xs tabular-nums">
              <thead>
                <tr className="border-b border-slate-700 bg-slate-900 text-[11px] font-semibold uppercase tracking-wider text-slate-200">
                  <th className="px-4 py-3">Period</th>
                  <th className="px-4 py-3">Fiscal YoY / Impulse</th>
                  <th className="px-4 py-3 text-right">Fed Funds</th>
                  <th className="px-4 py-3 text-right">6M ETF</th>
                  <th className="px-4 py-3 text-right">6M vs SPY</th>
                  <th className="px-4 py-3 text-right">6M vs GLD</th>
                  <th className="px-4 py-3 text-right">12M ETF</th>
                  <th className="px-4 py-3 text-right">12M vs SPY</th>
                  <th className="px-4 py-3 text-right">12M vs GLD</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/90">
                {detail.regime_analogs.analogs.map((analog) => (
                  <tr
                    key={`${analog.start_date}-${analog.end_date}`}
                    className={`transition-colors hover:bg-slate-900/70 ${
                      analog.matches_fiscal_direction
                        ? "bg-sky-950/20"
                        : "bg-slate-950/60"
                    }`}
                  >
                    <td className="px-4 py-3 font-mono text-slate-100">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold">{analog.period}</span>
                        <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-300">
                          {analog.months}m
                        </span>
                        {analog.matches_fiscal_direction && (
                          <span className="rounded border border-sky-500/40 bg-sky-500/15 px-1.5 py-0.5 font-sans text-[10px] font-semibold text-sky-300">
                            Fiscal Match
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-semibold text-slate-100">
                          {formatPct(analog.fiscal_yoy_pct)}
                        </span>
                        <span
                          className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${getImpulseBadgeStyle(
                            analog.fiscal_impulse_label
                          )}`}
                        >
                          {analog.fiscal_impulse_label} (Z:{" "}
                          {formatZScore(analog.fiscal_impulse_zscore)})
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3 text-right font-semibold text-slate-100">
                      {analog.avg_fed_funds.toFixed(2)}%
                    </td>
                    <td
                      className={`px-4 py-3 text-right ${formatReturnTextColor(
                        analog.forward_6m_etf_return_pct
                      )}`}
                    >
                      {formatPct(analog.forward_6m_etf_return_pct)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right ${formatReturnTextColor(
                        analog.forward_6m_vs_spy_pct
                      )}`}
                    >
                      {formatPct(analog.forward_6m_vs_spy_pct)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right ${formatReturnTextColor(
                        analog.forward_6m_vs_gld_pct
                      )}`}
                    >
                      {formatPct(analog.forward_6m_vs_gld_pct)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right ${formatReturnTextColor(
                        analog.forward_12m_etf_return_pct
                      )}`}
                    >
                      {formatPct(analog.forward_12m_etf_return_pct)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right ${formatReturnTextColor(
                        analog.forward_12m_vs_spy_pct
                      )}`}
                    >
                      {formatPct(analog.forward_12m_vs_spy_pct)}
                    </td>
                    <td
                      className={`px-4 py-3 text-right ${formatReturnTextColor(
                        analog.forward_12m_vs_gld_pct
                      )}`}
                    >
                      {formatPct(analog.forward_12m_vs_gld_pct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </main>
  );
}

export default function SectorsPage() {
  return (
    <Suspense
      fallback={
        <main className="mx-auto flex min-h-screen max-w-[1440px] items-center justify-center px-4 py-6 text-sm text-slate-400">
          Loading sector flows workspace...
        </main>
      }
    >
      <SectorsWorkspace />
    </Suspense>
  );
}
