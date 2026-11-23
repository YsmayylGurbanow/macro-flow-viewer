"use client";

import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AnimatePresence, motion } from "framer-motion";
import { AlertCircle, Check, Copy, RefreshCw } from "lucide-react";
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
import {
  folioStaggerContainer,
  folioStaggerItem,
} from "@/components/FolioTransitionProvider";
import { InfoSeal } from "@/components/InfoSeal";
import { LedgerCounter } from "@/components/LedgerCounter";
import { MarkdownBrief } from "@/components/MarkdownBrief";
import { API_BASE_URL } from "@/lib/api";
import { playBrassTick, playInkStamp } from "@/lib/archivalAudio";

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

const REGIME_INKS: Record<
  string,
  { badge: string; band: string; dot: string }
> = {
  Hiking: {
    badge: "border-[#9E2A2B] bg-[#9E2A2B]/12 text-[#9E2A2B]",
    band: "#9E2A2B",
    dot: "bg-[#9E2A2B]",
  },
  Cutting: {
    badge: "border-[#4F6D5A] bg-[#4F6D5A]/15 text-[#2F4E3C]",
    band: "#4F6D5A",
    dot: "bg-[#4F6D5A]",
  },
  "High-Pause": {
    badge: "border-[#B5892E] bg-[#B5892E]/15 text-[#7D5C19]",
    band: "#B5892E",
    dot: "bg-[#B5892E]",
  },
  "Low-Pause": {
    badge: "border-[#2B5B6C] bg-[#2B5B6C]/15 text-[#1F4452]",
    band: "#2B5B6C",
    dot: "bg-[#2B5B6C]",
  },
};

function getRegimeStyle(regime: string | null | undefined) {
  if (!regime || !(regime in REGIME_INKS)) {
    return {
      badge: "border-[#A8967A] bg-[#FAF4E6] text-[#594A3C]",
      band: "#594A3C",
      dot: "bg-[#594A3C]",
    };
  }
  return REGIME_INKS[regime];
}

function getValuationBadgeStyle(zone: string): string {
  if (zone === "Cheap") {
    return "border-[#4F6D5A] bg-[#4F6D5A]/15 text-[#2F4E3C]";
  }
  if (zone === "Expensive") {
    return "border-[#9E2A2B] bg-[#9E2A2B]/12 text-[#9E2A2B]";
  }
  if (zone === "Fair" || zone === "Normal") {
    return "border-[#B5892E] bg-[#B5892E]/15 text-[#7D5C19]";
  }
  return "border-[#A8967A] bg-[#F2E8D5] text-[#594A3C]";
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

function formatZScore(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "—";
  }
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value.toFixed(2)}`;
}

function formatReturnTextColor(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "text-[#594A3C]";
  }
  return value >= 0
    ? "font-semibold text-[#2F4E3C]"
    : "font-semibold text-[#9E2A2B]";
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
    <div className="border border-[#2A2118] bg-[#FAF4E6] p-3 text-xs text-[#1C1610] shadow-[inset_0_0_0_2px_#FAF4E6,inset_0_0_0_3px_#A8967A,0_10px_20px_-8px_rgba(28,22,16,0.3)]">
      <div className="mb-1.5 flex items-center justify-between gap-4 border-b border-[#C8B9A0] pb-1 font-mono font-semibold text-[#1C1610]">
        <span>{label}</span>
        <span className="text-[#594A3C]">FY{row.fiscal_year}</span>
      </div>
      <div className="space-y-1 font-mono tabular-nums">
        <div className="flex justify-between gap-4">
          <span className="font-serif italic text-[#2B5B6C]">Obligations:</span>
          <span className="font-semibold text-[#1C1610]">
            {formatUsdCompact(row.obligations_raw)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="font-serif italic text-[#9E2A2B]">Fiscal YoY:</span>
          <span className="font-semibold text-[#1C1610]">
            {formatPct(row.yoy_growth_pct)}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="font-serif italic text-[#4F6D5A]">ETF Close:</span>
          <span className="font-semibold text-[#1C1610]">
            {row.close_price !== null ? `$${row.close_price.toFixed(2)}` : "—"}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="font-serif italic text-[#7D5C19]">ETF / GLD:</span>
          <span className="font-semibold text-[#1C1610]">
            {row.gold_ratio !== null ? row.gold_ratio.toFixed(4) : "—"}
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="font-serif italic text-[#594A3C]">ETF / SPY:</span>
          <span className="font-semibold text-[#1C1610]">
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
    <div className="border border-[#2A2118] bg-[#FAF4E6] p-3 text-xs text-[#1C1610] shadow-[inset_0_0_0_2px_#FAF4E6,inset_0_0_0_3px_#A8967A,0_10px_20px_-8px_rgba(28,22,16,0.3)]">
      <div className="mb-1.5 flex items-center justify-between gap-4 border-b border-[#C8B9A0] pb-1">
        <span className="font-mono font-semibold text-[#1C1610]">{label}</span>
        <span
          className={`border px-2 py-0.5 font-display text-[10px] font-semibold ${style.badge}`}
        >
          {row.regime_label}
        </span>
      </div>
      <div className="space-y-1 font-mono tabular-nums">
        <div className="flex justify-between gap-4">
          <span className="font-serif italic text-[#2B5B6C]">Fed Funds:</span>
          <span className="font-semibold text-[#1C1610]">
            {row.fed_funds.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="font-serif italic text-[#7D5C19]">
            10Y Treasury:
          </span>
          <span className="font-semibold text-[#1C1610]">
            {row.dgs10.toFixed(2)}%
          </span>
        </div>
        <div className="flex justify-between gap-4">
          <span className="font-serif italic text-[#4F6D5A]">
            10Y–FF Spread:
          </span>
          <span className="font-semibold text-[#1C1610]">
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
    if (ticker !== selectedTicker) {
      playBrassTick();
    }
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
    playInkStamp();
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
    playInkStamp();
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
    <main className="mx-auto flex min-h-screen max-w-[1440px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
      {/* Slim Archival Masthead */}
      <header className="flex flex-col justify-between gap-4 border-b border-[#2A2118] pb-4 sm:flex-row sm:items-end">
        <div>
          <span className="font-script text-2xl text-[#9E2A2B]">
            Folio III &middot; Federal Outlays &amp; Rate Regimes
          </span>
          <h1 className="font-display text-3xl font-bold tracking-wide text-[#1C1610]">
            Fiscal &amp; Sector Flows Ledger
          </h1>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 text-xs">
          <div className="flex items-center gap-2 border border-[#2A2118] bg-[#FAF4E6] px-2.5 py-1">
            <span className="font-serif italic text-[#594A3C]">Regime:</span>
            <span
              className={`inline-flex items-center gap-1.5 border px-2 py-0.5 font-display font-semibold ${currentRegimeStyle.badge}`}
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${currentRegimeStyle.dot}`}
              />
              {currentRegimeLabel}
            </span>
          </div>

          {overview?.current_rate_regime && (
            <div className="border border-[#A8967A] bg-[#FAF4E6] px-2.5 py-1.5 font-mono tabular-nums text-[#1C1610]">
              FF {overview.current_rate_regime.fed_funds.toFixed(2)}% &middot;
              10Y {overview.current_rate_regime.dgs10.toFixed(2)}%
            </div>
          )}

          <button
            type="button"
            onClick={handleCopySocialBrief}
            disabled={!detail || loadingDetail}
            title="Copy formatted 5-line macro summary for X / Telegram"
            className={`inline-flex items-center gap-1.5 border px-3 py-1.5 font-display text-xs font-semibold uppercase tracking-wider transition disabled:cursor-not-allowed disabled:opacity-50 ${
              copiedBrief
                ? "border-[#4F6D5A] bg-[#4F6D5A] text-[#FAF4E6]"
                : "border-[#2A2118] bg-[#FAF4E6] text-[#1C1610] hover:border-[#9E2A2B] hover:text-[#9E2A2B]"
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

          <InfoSeal
            title="Fiscal & Sector Flows Ledger"
            summary="Maps federal agency budgetary resources from USAspending.gov against sector ETF prices, FRED interest rate regimes, and Gold/SPY relative valuations."
            howToRead="Select any of the 6 sector cards below to inspect its 10-year fiscal Z-score, valuation percentile gauge, rate regime timeline, and historical regime analogs."
          />
        </div>
      </header>

      {errorMsg && (
        <div className="flex items-start gap-3 border border-[#9E2A2B] bg-[#FAF4E6] p-4 text-sm text-[#9E2A2B]">
          <AlertCircle className="mt-0.5 h-5 w-5 shrink-0" />
          <p className="font-serif">{errorMsg}</p>
        </div>
      )}

      {/* 6-Sector Engraved Selector Plates */}
      <motion.section
        variants={folioStaggerContainer}
        initial="hidden"
        animate="visible"
        aria-label="Sector Selector"
        className="grid grid-cols-1 gap-3.5 sm:grid-cols-2 lg:grid-cols-3"
      >
        {(
          overview?.sectors ?? [
            {
              ticker: "ITA",
              sector_name: "Defense",
              agency_code: "097",
              agency_name: "Defense",
            },
            {
              ticker: "XLE",
              sector_name: "Energy",
              agency_code: "089",
              agency_name: "Energy",
            },
            {
              ticker: "XLV",
              sector_name: "Healthcare",
              agency_code: "075",
              agency_name: "HHS",
            },
            {
              ticker: "IYT",
              sector_name: "Transportation",
              agency_code: "069",
              agency_name: "Transportation",
            },
            {
              ticker: "XLK",
              sector_name: "Technology",
              agency_code: "013",
              agency_name: "Commerce",
            },
            {
              ticker: "PAVE",
              sector_name: "Infrastructure",
              agency_code: "069",
              agency_name: "Transportation",
            },
          ]
        ).map((sector) => {
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
            <motion.button
              key={sector.ticker}
              variants={folioStaggerItem}
              whileTap={{ scale: 0.985 }}
              type="button"
              onClick={() => handleSelectSector(sector.ticker)}
              className={`relative flex flex-col justify-between border border-[#2A2118] p-4 text-left transition-colors ${
                isSelected
                  ? "bg-[#FAF4E6]"
                  : "bg-[#FAF4E6]/85 shadow-[inset_0_0_0_2px_#FAF4E6,inset_0_0_0_3px_#C8B9A0] hover:bg-[#FAF4E6]"
              }`}
            >
              {isSelected && (
                <motion.span
                  layoutId="active-sector-frame"
                  transition={{
                    type: "spring",
                    stiffness: 360,
                    damping: 30,
                  }}
                  className="pointer-events-none absolute inset-0 z-10 border border-[#9E2A2B] shadow-[inset_0_0_0_2px_#FAF4E6,inset_0_0_0_3px_#9E2A2B,0_10px_22px_-14px_rgba(28,22,16,0.35)]"
                />
              )}
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-lg font-semibold text-[#1C1610]">
                      {sector.ticker}
                    </span>
                    <span className="border border-[#C8B9A0] bg-[#F2E8D5] px-1.5 py-0.5 font-mono text-[10px] text-[#594A3C]">
                      AG-{sector.agency_code}
                    </span>
                  </div>
                  <p className="font-serif text-xs italic text-[#594A3C]">
                    {sector.sector_name} ({sector.agency_name})
                  </p>
                </div>
                <span
                  className={`border px-2 py-0.5 font-display text-xs font-semibold ${getValuationBadgeStyle(
                    zone
                  )}`}
                >
                  {zone}
                </span>
              </div>

              <div className="mt-3.5 grid grid-cols-2 gap-2 border-t border-[#C8B9A0] pt-2.5 text-xs font-mono tabular-nums">
                <div>
                  <span className="block font-serif text-[11px] italic text-[#594A3C]">
                    Fiscal YoY / 5Y Z
                  </span>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <span
                      className={`font-semibold ${
                        yoy === null
                          ? "text-[#594A3C]"
                          : yoy >= 0
                            ? "text-[#2F4E3C]"
                            : "text-[#9E2A2B]"
                      }`}
                    >
                      {loadingOverview ? (
                        "..."
                      ) : (
                        <LedgerCounter value={yoy} decimals={1} signed suffix="%" />
                      )}
                    </span>
                    <span
                      className={`border px-1.5 py-0.5 text-[10px] font-medium ${getImpulseBadgeStyle(
                        impulseLabel
                      )}`}
                    >
                      {loadingOverview ? (
                        "..."
                      ) : (
                        <>
                          {impulseLabel} (
                          <LedgerCounter value={zscore} decimals={2} signed />)
                        </>
                      )}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <span className="block font-serif text-[11px] italic text-[#594A3C]">
                    10Y Rank / Regime
                  </span>
                  <div className="mt-0.5 flex items-center justify-end gap-1.5">
                    <span className="font-semibold text-[#1C1610]">
                      <LedgerCounter value={pct} decimals={0} suffix="%" />
                    </span>
                    <span
                      className={`border px-1.5 py-0.5 font-display text-[10px] font-semibold ${regimeBadge.badge}`}
                    >
                      {regime}
                    </span>
                  </div>
                </div>
              </div>
            </motion.button>
          );
        })}
      </motion.section>

      {/* Main Decision Workspace */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* Left Column: Gauge & Charts (8 cols) */}
        <div className="flex flex-col gap-6 xl:col-span-8">
          {/* Valuation Percentile Gauge */}
          <section className="ledger-plate p-5">
            <div className="relative flex flex-col items-center pb-3">
              <div className="flex w-full items-center justify-between">
                <div className="flex items-baseline gap-2 font-mono tabular-nums">
                  <span className="font-serif text-xs italic text-[#594A3C]">
                    Percentile:
                  </span>
                  <span className="text-xl font-semibold text-[#1C1610]">
                    <LedgerCounter value={currentPercentile} decimals={1} suffix="%" />
                  </span>
                  <span
                    className={`border px-2 py-0.5 font-display text-xs font-semibold ${getValuationBadgeStyle(
                      detail?.valuation_zone ??
                        activeCard?.valuation_zone ??
                        "Unknown"
                    )}`}
                  >
                    {detail?.valuation_zone ??
                      activeCard?.valuation_zone ??
                      "Unknown"}
                  </span>
                </div>
                <InfoSeal
                  title="10-Year Valuation Percentile Gauge"
                  summary="Blends the ETF's 10-year historical percentile rank relative to Gold (ETF/GLD) and the S&P 500 (ETF/SPY)."
                  howToRead="Below 25% marks the Cheap quartile (Sage); 25%–75% is Normal; above 75% marks Expensive (Crimson)."
                />
              </div>

              <div className="ledger-title-plate mt-2 px-5 py-1 text-center">
                <h2 className="font-display text-base font-bold uppercase tracking-[0.12em] text-[#1C1610]">
                  10-Year Valuation Gauge &mdash; {selectedTicker}
                </h2>
              </div>
            </div>

            {/* Engraved Watercolor Gauge Bar */}
            <div className="mt-3">
              <div className="relative h-4 w-full overflow-hidden border border-[#2A2118] bg-[#F2E8D5]">
                <div
                  className="absolute inset-y-0 left-0 bg-[#4F6D5A]/30"
                  style={{ width: "25%" }}
                />
                <div
                  className="absolute inset-y-0 bg-[#B5892E]/18"
                  style={{ left: "25%", width: "50%" }}
                />
                <div
                  className="absolute inset-y-0 right-0 bg-[#9E2A2B]/30"
                  style={{ width: "25%" }}
                />
                <div
                  className="absolute inset-y-0 w-[1px] bg-[#2A2118]"
                  style={{ left: "25%" }}
                />
                <div
                  className="absolute inset-y-0 w-[1px] bg-[#2A2118]"
                  style={{ left: "75%" }}
                />
                {clampedPercentile !== null && (
                  <motion.div
                    initial={{ left: "0%" }}
                    animate={{ left: `${clampedPercentile}%` }}
                    transition={{ type: "spring", stiffness: 180, damping: 24 }}
                    className="absolute top-0 bottom-0 w-1.5 -translate-x-1/2 bg-[#1C1610] shadow-[0_0_0_1px_#FAF4E6]"
                  />
                )}
              </div>

              <div className="mt-1.5 flex justify-between font-mono text-[11px] font-medium tabular-nums">
                <span className="text-[#2F4E3C]">0–25% Cheap</span>
                <span className="text-[#7D5C19]">25–75% Normal</span>
                <span className="text-[#9E2A2B]">75–100% Expensive</span>
              </div>
            </div>

            {/* 5 Telemetry Cells */}
            <div className="mt-4 grid grid-cols-2 gap-2.5 border-t border-[#C8B9A0] pt-3.5 text-xs font-mono tabular-nums sm:grid-cols-5">
              <div className="border border-[#D7C9B2] bg-[#F2E8D5]/70 p-2.5">
                <span className="block font-serif text-[11px] italic text-[#594A3C]">
                  ETF Close
                </span>
                <span className="text-sm font-semibold text-[#1C1610]">
                  <LedgerCounter
                    value={detail?.latest_valuation?.close_price}
                    decimals={2}
                    prefix="$"
                  />
                </span>
              </div>
              <div className="border border-[#D7C9B2] bg-[#F2E8D5]/70 p-2.5">
                <span className="block font-serif text-[11px] italic text-[#594A3C]">
                  ETF / GLD (%ile)
                </span>
                <span className="text-sm font-semibold text-[#7D5C19]">
                  {detail?.latest_valuation ? (
                    <>
                      <LedgerCounter
                        value={detail.latest_valuation.gold_ratio}
                        decimals={4}
                      />
                      {detail.gold_valuation_percentile !== null &&
                        detail.gold_valuation_percentile !== undefined && (
                          <LedgerCounter
                            value={detail.gold_valuation_percentile}
                            decimals={0}
                            prefix=" ("
                            suffix="%)"
                          />
                        )}
                    </>
                  ) : (
                    "—"
                  )}
                </span>
              </div>
              <div className="border border-[#D7C9B2] bg-[#F2E8D5]/70 p-2.5">
                <span className="block font-serif text-[11px] italic text-[#594A3C]">
                  ETF / SPY
                </span>
                <span className="text-sm font-semibold text-[#2B5B6C]">
                  <LedgerCounter
                    value={detail?.latest_valuation?.spy_ratio}
                    decimals={4}
                  />
                </span>
              </div>
              <div className="border border-[#D7C9B2] bg-[#F2E8D5]/70 p-2.5">
                <span className="block font-serif text-[11px] italic text-[#594A3C]">
                  Fiscal 5Y Z
                </span>
                <div className="mt-0.5 flex flex-wrap items-center gap-1">
                  <span className="text-sm font-semibold text-[#1C1610]">
                    <LedgerCounter
                      value={detail?.fiscal_impulse_zscore}
                      decimals={2}
                      signed
                    />
                  </span>
                  <span
                    className={`border px-1 py-0.5 text-[10px] font-medium ${getImpulseBadgeStyle(
                      detail?.fiscal_impulse_label ?? "Neutral"
                    )}`}
                  >
                    {detail?.fiscal_impulse_label ?? "—"}
                  </span>
                </div>
              </div>
              <div className="border border-[#D7C9B2] bg-[#F2E8D5]/70 p-2.5">
                <span className="block font-serif text-[11px] italic text-[#594A3C]">
                  Avg 12M Regime
                </span>
                <span
                  className={`text-sm font-semibold ${
                    detail?.avg_12m_return_in_regime_pct === null ||
                    detail?.avg_12m_return_in_regime_pct === undefined
                      ? "text-[#594A3C]"
                      : detail.avg_12m_return_in_regime_pct >= 0
                        ? "text-[#2F4E3C]"
                        : "text-[#9E2A2B]"
                  }`}
                >
                  <LedgerCounter
                    value={detail?.avg_12m_return_in_regime_pct}
                    decimals={1}
                    signed
                    suffix="%"
                  />
                </span>
              </div>
            </div>
          </section>

          {/* Chart 1: Fiscal Flow vs. Sector Valuation */}
          <section className="ledger-plate p-5">
            <div className="relative mb-4 flex flex-col items-center">
              <div className="flex w-full items-center justify-between">
                <span
                  className={`border px-2.5 py-0.5 font-mono text-[11px] font-medium ${getImpulseBadgeStyle(
                    detail?.fiscal_impulse_label ?? "Neutral"
                  )}`}
                >
                  Impulse: {detail?.fiscal_impulse_label ?? "—"} (Z:{" "}
                  {formatZScore(detail?.fiscal_impulse_zscore)})
                </span>
                <InfoSeal
                  title="Chart I: Fiscal Flow vs. Valuation"
                  summary="Overlays 10-year mapped federal agency obligations ($B) and YoY spending growth (%) against the ETF close price, ETF/GLD ratio, and ETF/SPY ratio."
                  howToRead="Look for inflections where surging agency obligations (bars) and positive YoY impulse coincide with depressed valuation ratios."
                />
              </div>

              <div className="ledger-title-plate mt-2 px-5 py-1 text-center">
                <h2 className="font-display text-base font-bold uppercase tracking-[0.12em] text-[#1C1610]">
                  Plate I: Fiscal Flow vs. Valuation ({selectedTicker})
                </h2>
              </div>
            </div>

            <div className="millimeter-paper h-[310px] w-full p-2">
              {loadingDetail ? (
                <div className="flex h-full items-center justify-center font-serif text-sm italic text-[#594A3C]">
                  Drawing fiscal &amp; valuation series...
                </div>
              ) : chart1Data.length === 0 ? (
                <div className="flex h-full items-center justify-center font-serif text-sm italic text-[#594A3C]">
                  No fiscal spending or valuation observations available.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    key={`chart1-${selectedTicker}`}
                    data={chart1Data}
                    margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
                  >
                    <CartesianGrid stroke="#C8B9A0" strokeDasharray="2 3" />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatShortDate}
                      stroke="#594A3C"
                      tick={{
                        fill: "#594A3C",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                      minTickGap={28}
                    />
                    <YAxis
                      yAxisId="fiscal"
                      orientation="left"
                      stroke="#2B5B6C"
                      tick={{
                        fill: "#2B5B6C",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                      tickFormatter={(v: number) => `$${v}B`}
                      width={60}
                    />
                    <YAxis
                      yAxisId="price"
                      orientation="right"
                      stroke="#4F6D5A"
                      tick={{
                        fill: "#2F4E3C",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                      tickFormatter={(v: number) => `$${v}`}
                      width={52}
                    />
                    <YAxis yAxisId="ratio" hide domain={["auto", "auto"]} />
                    <YAxis yAxisId="yoy" hide domain={["auto", "auto"]} />
                    <Tooltip
                      cursor={{ stroke: "#9E2A2B", strokeDasharray: "3 3" }}
                      content={<FiscalValuationTooltip />}
                    />
                    <Legend
                      wrapperStyle={{
                        fontSize: "11px",
                        paddingTop: "8px",
                        fontFamily: "var(--font-serif)",
                      }}
                    />
                    <Bar
                      yAxisId="fiscal"
                      dataKey="obligations_b"
                      name="Obligations ($B)"
                      fill="#2B5B6C"
                      fillOpacity={0.28}
                      stroke="#2B5B6C"
                      strokeOpacity={0.6}
                      radius={[1, 1, 0, 0]}
                      isAnimationActive={true}
                      animationDuration={560}
                      animationEasing="ease-out"
                    />
                    <Line
                      yAxisId="price"
                      type="monotone"
                      dataKey="close_price"
                      name={`${selectedTicker} Close ($)`}
                      stroke="#1C1610"
                      strokeWidth={2}
                      dot={false}
                      connectNulls
                      isAnimationActive={true}
                      animationDuration={640}
                      animationEasing="ease-out"
                    />
                    <Line
                      yAxisId="yoy"
                      type="monotone"
                      dataKey="yoy_growth_pct"
                      name="Fiscal YoY %"
                      stroke="#9E2A2B"
                      strokeWidth={1.75}
                      strokeDasharray="4 3"
                      dot={false}
                      connectNulls
                      isAnimationActive={true}
                      animationDuration={640}
                      animationEasing="ease-out"
                    />
                    <Line
                      yAxisId="ratio"
                      type="monotone"
                      dataKey="gold_ratio"
                      name="ETF / GLD"
                      stroke="#B5892E"
                      strokeWidth={1.65}
                      dot={false}
                      connectNulls
                      isAnimationActive={true}
                      animationDuration={640}
                      animationEasing="ease-out"
                    />
                    <Line
                      yAxisId="ratio"
                      type="monotone"
                      dataKey="spy_ratio"
                      name="ETF / SPY"
                      stroke="#4F6D5A"
                      strokeWidth={1.65}
                      dot={false}
                      connectNulls
                      isAnimationActive={true}
                      animationDuration={640}
                      animationEasing="ease-out"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>
          </section>

          {/* Chart 2: Interest Rate Regime Timeline & Spread */}
          <section className="ledger-plate p-5">
            <div className="relative mb-4 flex flex-col items-center">
              <div className="flex w-full flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-1.5 font-display text-[11px] font-semibold">
                  {(
                    ["Hiking", "High-Pause", "Cutting", "Low-Pause"] as const
                  ).map((label) => {
                    const st = getRegimeStyle(label);
                    return (
                      <span
                        key={label}
                        className={`inline-flex items-center gap-1 border px-2 py-0.5 ${st.badge}`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${st.dot}`}
                        />
                        {label}
                      </span>
                    );
                  })}
                </div>
                <InfoSeal
                  title="Plate II: Rate Regime Timeline"
                  summary="Plots 10-year monthly Federal Funds (FEDFUNDS), 10-Year Treasury (DGS10), and the 10Y–FF yield spread shaded by deterministic monetary regime."
                  howToRead="Shaded bands highlight historical regime shifts; matching windows below feed the Historical Regime Analogs matrix."
                />
              </div>

              <div className="ledger-title-plate mt-2 px-5 py-1 text-center">
                <h2 className="font-display text-base font-bold uppercase tracking-[0.12em] text-[#1C1610]">
                  Plate II: Interest Rate Regime Timeline
                </h2>
              </div>
            </div>

            <div className="millimeter-paper h-[290px] w-full p-2">
              {loadingDetail ? (
                <div className="flex h-full items-center justify-center font-serif text-sm italic text-[#594A3C]">
                  Drawing interest rate regimes...
                </div>
              ) : !detail || detail.macro_rates.length === 0 ? (
                <div className="flex h-full items-center justify-center font-serif text-sm italic text-[#594A3C]">
                  No macro interest rate observations available.
                </div>
              ) : (
                <ResponsiveContainer width="100%" height="100%">
                  <ComposedChart
                    data={detail.macro_rates}
                    margin={{ top: 10, right: 16, left: 0, bottom: 0 }}
                  >
                    <defs>
                      <linearGradient
                        id="playfair-spread-wash"
                        x1="0"
                        y1="0"
                        x2="0"
                        y2="1"
                      >
                        <stop
                          offset="5%"
                          stopColor="#4F6D5A"
                          stopOpacity={0.28}
                        />
                        <stop
                          offset="95%"
                          stopColor="#4F6D5A"
                          stopOpacity={0.04}
                        />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#C8B9A0" strokeDasharray="2 3" />
                    {regimeBands.map((band, idx) => (
                      <ReferenceArea
                        key={`${band.regime}-${idx}`}
                        x1={band.x1}
                        x2={band.x2}
                        fill={getRegimeStyle(band.regime).band}
                        fillOpacity={0.11}
                        ifOverflow="extendDomain"
                      />
                    ))}
                    <ReferenceLine
                      y={0}
                      stroke="#2A2118"
                      strokeDasharray="3 3"
                    />
                    <XAxis
                      dataKey="date"
                      tickFormatter={formatShortDate}
                      stroke="#594A3C"
                      tick={{
                        fill: "#594A3C",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                      minTickGap={28}
                    />
                    <YAxis
                      stroke="#594A3C"
                      tick={{
                        fill: "#594A3C",
                        fontSize: 11,
                        fontFamily: "var(--font-mono)",
                      }}
                      tickFormatter={(v: number) => `${v}%`}
                      width={48}
                    />
                    <Tooltip
                      cursor={{ stroke: "#9E2A2B", strokeDasharray: "3 3" }}
                      content={<RateRegimeTooltip />}
                    />
                    <Legend
                      wrapperStyle={{
                        fontSize: "11px",
                        paddingTop: "8px",
                        fontFamily: "var(--font-serif)",
                      }}
                    />
                    <Area
                      type="monotone"
                      dataKey="yield_spread"
                      name="Yield Spread (10Y - FF)"
                      stroke="#4F6D5A"
                      fill="url(#playfair-spread-wash)"
                      strokeWidth={1.75}
                      isAnimationActive={true}
                      animationDuration={640}
                      animationEasing="ease-out"
                    />
                    <Line
                      type="monotone"
                      dataKey="fed_funds"
                      name="Fed Funds (%)"
                      stroke="#2B5B6C"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={true}
                      animationDuration={640}
                      animationEasing="ease-out"
                    />
                    <Line
                      type="monotone"
                      dataKey="dgs10"
                      name="10Y Treasury (%)"
                      stroke="#9E2A2B"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={true}
                      animationDuration={640}
                      animationEasing="ease-out"
                    />
                  </ComposedChart>
                </ResponsiveContainer>
              )}
            </div>

            {detail && detail.matching_regime_periods.length > 0 && (
              <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-[#C8B9A0] pt-3 text-xs">
                <span className="font-serif italic text-[#594A3C]">
                  {currentRegimeLabel} Windows:
                </span>
                {detail.matching_regime_periods.map((period, idx) => (
                  <span
                    key={`${period.start_date}-${idx}`}
                    className="border border-[#C8B9A0] bg-[#F2E8D5] px-2 py-0.5 font-mono text-[11px] text-[#1C1610]"
                  >
                    {formatShortDate(period.start_date)} &rarr;{" "}
                    {formatShortDate(period.end_date)} ({period.months}m)
                  </span>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right Column: AI Macro Analyst Brief Panel (4 cols) */}
        <aside className="ledger-plate flex flex-col p-5 xl:col-span-4">
          <div className="relative mb-4 flex flex-col items-center">
            <div className="flex w-full items-center justify-between">
              <button
                type="button"
                onClick={handleRefreshAnalysis}
                disabled={refreshingBrief || loadingDetail}
                className="inline-flex items-center gap-1.5 border border-[#2A2118] bg-[#FAF4E6] px-3 py-1 font-display text-xs font-semibold uppercase tracking-wider text-[#1C1610] transition hover:border-[#9E2A2B] hover:text-[#9E2A2B] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3 w-3 ${refreshingBrief ? "animate-spin" : ""}`}
                />
                {refreshingBrief ? "Inscribing..." : "Refresh AI Analysis"}
              </button>
              <InfoSeal
                title="AI Macro Analyst Brief"
                summary="Tool-grounded synthesis referencing get_fiscal_flows, get_rate_regime_history, get_sector_valuation, and get_regime_analogs from SQLite."
                howToRead="Cached per ticker in SQLite; click Refresh AI Analysis to recompute."
              />
            </div>

            <div className="ledger-title-plate mt-3 px-4 py-1 text-center">
              <h2 className="font-display text-base font-bold uppercase tracking-[0.12em] text-[#1C1610]">
                Analyst Brief &mdash; {selectedTicker}
              </h2>
            </div>
          </div>

          {detail?.analyst_brief && (
            <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-[#C8B9A0] pb-2.5 text-[11px]">
              <span
                className={`border px-2 py-0.5 font-display font-semibold ${
                  getRegimeStyle(detail.analyst_brief.regime_label).badge
                }`}
              >
                {detail.analyst_brief.regime_label}
              </span>
              <span
                className={`border px-2 py-0.5 font-display font-semibold ${getValuationBadgeStyle(
                  detail.analyst_brief.valuation_zone
                )}`}
              >
                {detail.analyst_brief.valuation_zone}
              </span>
              <span className="ml-auto font-mono text-[#594A3C]">
                {new Date(detail.analyst_brief.updated_at).toLocaleDateString()}
              </span>
            </div>
          )}

          <div className="flex-1 overflow-y-auto border border-[#C8B9A0] bg-[#F7F0DF] p-4">
            {loadingDetail ? (
              <div className="flex h-40 items-center justify-center font-serif text-sm italic text-[#594A3C]">
                Inscribing analyst brief...
              </div>
            ) : detail?.analyst_brief?.summary_markdown ? (
              <MarkdownBrief markdown={detail.analyst_brief.summary_markdown} />
            ) : (
              <p className="font-serif text-sm italic text-[#594A3C]">
                Select a sector to generate its macro brief.
              </p>
            )}
          </div>
        </aside>
      </div>

      {/* Historical Regime Analogs Table */}
      <section
        aria-label="Historical Regime Analogs"
        className="ledger-plate p-5 sm:p-6"
      >
        <div className="relative mb-4 flex flex-col items-center">
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-2 font-mono text-xs tabular-nums">
              <span className="border border-[#C8B9A0] bg-[#F2E8D5] px-2.5 py-1 text-[#1C1610]">
                Win Rate:{" "}
                <strong>
                  {detail?.regime_analogs?.win_rate_pct !== null &&
                  detail?.regime_analogs?.win_rate_pct !== undefined ? (
                    <>
                      <LedgerCounter
                        value={detail.regime_analogs.win_rate_pct}
                        decimals={0}
                        suffix="%"
                      />{" "}
                      ({detail.regime_analogs.win_count}/
                      {detail.regime_analogs.completed_sample_count})
                    </>
                  ) : (
                    "—"
                  )}
                </strong>
              </span>
              <span className="border border-[#C8B9A0] bg-[#F2E8D5] px-2.5 py-1">
                6M:{" "}
                <span
                  className={formatReturnTextColor(
                    detail?.regime_analogs?.avg_6m_etf_return_pct
                  )}
                >
                  <LedgerCounter
                    value={detail?.regime_analogs?.avg_6m_etf_return_pct}
                    decimals={1}
                    signed
                    suffix="%"
                  />
                </span>
              </span>
              <span className="border border-[#C8B9A0] bg-[#F2E8D5] px-2.5 py-1">
                12M:{" "}
                <span
                  className={formatReturnTextColor(
                    detail?.regime_analogs?.avg_12m_etf_return_pct
                  )}
                >
                  <LedgerCounter
                    value={detail?.regime_analogs?.avg_12m_etf_return_pct}
                    decimals={1}
                    signed
                    suffix="%"
                  />
                </span>
              </span>
              <span className="border border-[#C8B9A0] bg-[#F2E8D5] px-2.5 py-1">
                vs SPY:{" "}
                <span
                  className={formatReturnTextColor(
                    detail?.regime_analogs?.avg_12m_vs_spy_pct
                  )}
                >
                  <LedgerCounter
                    value={detail?.regime_analogs?.avg_12m_vs_spy_pct}
                    decimals={1}
                    signed
                    suffix="%"
                  />
                </span>
              </span>
              <span className="border border-[#C8B9A0] bg-[#F2E8D5] px-2.5 py-1">
                vs GLD:{" "}
                <span
                  className={formatReturnTextColor(
                    detail?.regime_analogs?.avg_12m_vs_gld_pct
                  )}
                >
                  <LedgerCounter
                    value={detail?.regime_analogs?.avg_12m_vs_gld_pct}
                    decimals={1}
                    signed
                    suffix="%"
                  />
                </span>
              </span>
            </div>

            <InfoSeal
              title="Historical Regime Analogs"
              summary="Deterministically isolates every past contiguous window sharing the current monetary rate regime and computes exact 6M and 12M forward returns for the ETF, ETF vs. SPY, and ETF vs. GLD."
              howToRead="Rows highlighted with 'Fiscal Match' also shared the current fiscal impulse direction (Accelerating, Neutral, or Contracting)."
            />
          </div>

          <div className="ledger-title-plate mt-3 px-5 py-1.5 text-center">
            <h2 className="font-display text-base font-bold uppercase tracking-[0.12em] text-[#1C1610]">
              Historical Regime Analogs &mdash; {selectedTicker} (
              {detail?.regime_analogs?.current_regime ?? currentRegimeLabel})
            </h2>
          </div>
        </div>

        <div className="overflow-x-auto border border-[#A8967A] bg-[#FAF4E6]">
          {loadingDetail ? (
            <div className="p-8 text-center font-serif text-sm italic text-[#594A3C]">
              Computing historical regime analog returns...
            </div>
          ) : !detail || detail.regime_analogs.analogs.length === 0 ? (
            <div className="p-8 text-center font-serif text-sm italic text-[#594A3C]">
              No matching historical rate-regime windows found yet.
            </div>
          ) : (
            <table className="w-full min-w-[820px] border-collapse text-left text-xs font-mono tabular-nums">
              <thead>
                <tr className="border-b border-[#2A2118] bg-[#EBE0C9] font-display text-[11px] font-bold uppercase tracking-wider text-[#1C1610]">
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
              <AnimatePresence mode="wait">
                <motion.tbody
                  key={`analogs-${selectedTicker}`}
                  variants={folioStaggerContainer}
                  initial="hidden"
                  animate="visible"
                  exit={{ opacity: 0, transition: { duration: 0.14 } }}
                  className="divide-y divide-[#D7C9B2]"
                >
                  {detail.regime_analogs.analogs.map((analog) => (
                    <motion.tr
                      key={`${analog.start_date}-${analog.end_date}`}
                      variants={folioStaggerItem}
                      className={`transition-colors hover:bg-[#EFE4CC]/75 ${
                        analog.matches_fiscal_direction
                          ? "bg-[#E8F0EB]/60"
                          : "bg-[#FAF4E6]"
                      }`}
                    >
                      <td className="px-4 py-3 text-[#1C1610]">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-semibold">{analog.period}</span>
                          <span className="border border-[#C8B9A0] bg-[#F2E8D5] px-1.5 py-0.5 text-[10px] text-[#594A3C]">
                            {analog.months}m
                          </span>
                          {analog.matches_fiscal_direction && (
                            <span className="border border-[#2B5B6C] bg-[#2B5B6C]/15 px-1.5 py-0.5 font-display text-[10px] font-semibold text-[#1F4452]">
                              Fiscal Match
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-semibold text-[#1C1610]">
                            {formatPct(analog.fiscal_yoy_pct)}
                          </span>
                          <span
                            className={`border px-1.5 py-0.5 text-[10px] font-medium ${getImpulseBadgeStyle(
                              analog.fiscal_impulse_label
                            )}`}
                          >
                            {analog.fiscal_impulse_label} (Z:{" "}
                            {formatZScore(analog.fiscal_impulse_zscore)})
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-[#1C1610]">
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
                    </motion.tr>
                  ))}
                </motion.tbody>
              </AnimatePresence>
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
        <main className="mx-auto flex min-h-screen max-w-[1440px] items-center justify-center px-4 py-6 font-serif text-sm italic text-[#594A3C]">
          Opening sector ledger...
        </main>
      }
    >
      <SectorsWorkspace />
    </Suspense>
  );
}
