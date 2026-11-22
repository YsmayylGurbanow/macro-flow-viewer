use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;

use crate::ingest::market::percentile_ranks;
use crate::ingest::usaspending::{classify_fiscal_impulse_zscore, compute_trailing_5y_zscores};

use super::AgentError;

/// Static mapping between a sector ETF ticker and its corresponding federal agency.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SectorMapping {
    /// Sector ETF ticker symbol.
    pub ticker: &'static str,
    /// Human-readable sector name.
    pub sector_name: &'static str,
    /// USAspending agency code.
    pub agency_code: &'static str,
    /// Agency display name matching `fiscal_spending.agency_name`.
    pub agency_name: &'static str,
}

/// Supported MVP sector-to-agency mappings.
pub const SECTOR_MAPPINGS: &[SectorMapping] = &[
    SectorMapping {
        ticker: "ITA",
        sector_name: "Defense",
        agency_code: "097",
        agency_name: "Defense",
    },
    SectorMapping {
        ticker: "XLE",
        sector_name: "Energy",
        agency_code: "089",
        agency_name: "Energy",
    },
    SectorMapping {
        ticker: "XLV",
        sector_name: "Healthcare",
        agency_code: "075",
        agency_name: "HHS",
    },
    SectorMapping {
        ticker: "IYT",
        sector_name: "Transportation",
        agency_code: "069",
        agency_name: "Transportation",
    },
    SectorMapping {
        ticker: "XLK",
        sector_name: "Technology",
        agency_code: "013",
        agency_name: "Commerce",
    },
    SectorMapping {
        ticker: "PAVE",
        sector_name: "Infrastructure",
        agency_code: "069",
        agency_name: "Transportation",
    },
];

/// Looks up a supported sector mapping by ticker symbol (case-insensitive).
pub fn find_sector_mapping(ticker: &str) -> Option<&'static SectorMapping> {
    let trimmed = ticker.trim();
    SECTOR_MAPPINGS
        .iter()
        .find(|mapping| mapping.ticker.eq_ignore_ascii_case(trimmed))
}

/// Single annual fiscal spending observation.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FiscalFlowRow {
    /// Federal fiscal year.
    pub fiscal_year: i64,
    /// Total budgetary resources in USD.
    pub budgetary_resources: f64,
    /// Total obligations in USD.
    pub obligations: f64,
    /// Deterministic YoY % change in budgetary resources.
    pub yoy_growth_pct: Option<f64>,
    /// Trailing 5-year Z-score of YoY spending growth.
    pub fiscal_impulse_zscore: Option<f64>,
    /// Deterministic impulse label (`Accelerating`, `Neutral`, or `Contracting`).
    pub fiscal_impulse_label: String,
}

/// Deterministic summary and 10-year history of federal spending for an agency.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FiscalFlowsReport {
    /// Agency code (e.g. `"097"`).
    pub agency_code: String,
    /// Agency display name.
    pub agency_name: String,
    /// Most recent fiscal year in SQLite.
    pub latest_fiscal_year: Option<i64>,
    /// Most recent budgetary resources in USD.
    pub latest_budgetary_resources: Option<f64>,
    /// Most recent YoY percentage change.
    pub latest_yoy_growth_pct: Option<f64>,
    /// Most recent trailing 5-year fiscal impulse Z-score.
    pub fiscal_impulse_zscore: Option<f64>,
    /// Deterministic Z-score impulse label (`Accelerating`, `Neutral`, or `Contracting`).
    pub fiscal_impulse_label: String,
    /// Alias matching `fiscal_impulse_label` for downstream consumers.
    pub spending_impulse: String,
    /// Chronological (ascending) history of up to 10 fiscal years.
    pub history: Vec<FiscalFlowRow>,
}

/// Single monthly macro rate observation.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, PartialEq)]
pub struct MacroRateRow {
    /// Observation date (`YYYY-MM-DD`).
    pub date: String,
    /// Effective Federal Funds Rate (%).
    pub fed_funds: f64,
    /// 10-Year Treasury Yield (%).
    pub dgs10: f64,
    /// Yield spread (`dgs10 - fed_funds`).
    pub yield_spread: f64,
    /// Monetary regime classification.
    pub regime_label: String,
}

/// Contiguous historical date window sharing the current rate regime label.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RegimeDateRange {
    /// Rate regime label.
    pub regime_label: String,
    /// First date of the contiguous regime window.
    pub start_date: String,
    /// Last date of the contiguous regime window.
    pub end_date: String,
    /// Number of monthly observations in this window.
    pub months: usize,
    /// Mean `fed_funds` across the window.
    pub avg_fed_funds: f64,
    /// Mean `yield_spread` across the window.
    pub avg_yield_spread: f64,
}

/// Current monetary rate regime and matching historical regime periods.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RateRegimeReport {
    /// Most recent macro rate observation.
    pub current: Option<MacroRateRow>,
    /// Historical contiguous windows sharing the current `regime_label`.
    pub matching_regime_periods: Vec<RegimeDateRange>,
    /// Chronological monthly history.
    pub history: Vec<MacroRateRow>,
}

/// Single monthly sector ETF valuation observation.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, PartialEq)]
pub struct SectorValuationRow {
    /// Observation date (`YYYY-MM-DD`).
    pub date: String,
    /// Monthly close price of the ETF.
    pub close_price: f64,
    /// Ratio against `GLD`.
    pub gold_ratio: f64,
    /// Ratio against `SPY`.
    pub spy_ratio: f64,
    /// Historical 10-year percentile rank (0.0–100.0).
    pub valuation_percentile: f64,
}

/// Latest valuation zone and historical regime-conditional return metrics for a sector ETF.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SectorValuationReport {
    /// Sector ETF ticker symbol.
    pub ticker: String,
    /// Sector display name.
    pub sector_name: String,
    /// Latest monthly valuation observation.
    pub latest: Option<SectorValuationRow>,
    /// Latest 10-year valuation percentile of `ETF / GLD` alone (0.0–100.0).
    pub gold_valuation_percentile: Option<f64>,
    /// Deterministic valuation zone (`Cheap`, `Fair`, `Expensive`, or `Unknown`).
    pub valuation_zone: String,
    /// Current rate regime label used for conditional return calculation.
    pub current_regime: Option<String>,
    /// Average historical 12-month forward return (%) during periods matching `current_regime`.
    pub avg_12m_return_in_regime_pct: Option<f64>,
    /// Number of historical observations used to compute `avg_12m_return_in_regime_pct`.
    pub matching_regime_sample_count: usize,
    /// Chronological monthly valuation history.
    pub history: Vec<SectorValuationRow>,
}

/// Historical regime analog window with exact 6M and 12M forward performance.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RegimeAnalogWindow {
    /// Human-readable window label (`YYYY-MM → YYYY-MM`).
    pub period: String,
    /// First date of the contiguous regime window (`YYYY-MM-DD`).
    pub start_date: String,
    /// Last date of the contiguous regime window (`YYYY-MM-DD`).
    pub end_date: String,
    /// Duration of the window in months.
    pub months: usize,
    /// Matched rate regime label.
    pub regime_label: String,
    /// Mean Federal Funds rate (%) over the window.
    pub avg_fed_funds: f64,
    /// Federal fiscal year mapped to the start of the window.
    pub fiscal_year: Option<i64>,
    /// Agency YoY budgetary spending growth (%) for that fiscal year.
    pub fiscal_yoy_pct: Option<f64>,
    /// Agency trailing 5-year fiscal impulse Z-score for that fiscal year.
    pub fiscal_impulse_zscore: Option<f64>,
    /// Fiscal impulse label (`Accelerating`, `Neutral`, or `Contracting`) at window start.
    pub fiscal_impulse_label: String,
    /// Whether the window's fiscal impulse direction matches the latest fiscal impulse label.
    pub matches_fiscal_direction: bool,
    /// Exact 6-month forward ETF price return (%) from window start.
    pub forward_6m_etf_return_pct: Option<f64>,
    /// Exact 6-month forward ETF return minus SPY return (%).
    pub forward_6m_vs_spy_pct: Option<f64>,
    /// Exact 6-month forward ETF return minus GLD return (%).
    pub forward_6m_vs_gld_pct: Option<f64>,
    /// Exact 12-month forward ETF price return (%) from window start.
    pub forward_12m_etf_return_pct: Option<f64>,
    /// Exact 12-month forward ETF return minus SPY return (%).
    pub forward_12m_vs_spy_pct: Option<f64>,
    /// Exact 12-month forward ETF return minus GLD return (%).
    pub forward_12m_vs_gld_pct: Option<f64>,
}

/// Deterministic historical regime backtest summary and window rows for a sector ETF.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RegimeAnalogsReport {
    /// Sector ETF ticker symbol.
    pub ticker: String,
    /// Current rate regime label matched against historical windows.
    pub current_regime: Option<String>,
    /// Latest fiscal impulse label (`Accelerating`, `Neutral`, or `Contracting`).
    pub current_fiscal_impulse: String,
    /// Chronological list of historical windows matching `current_regime`.
    pub analogs: Vec<RegimeAnalogWindow>,
    /// Historical win rate (% of completed analog windows with positive forward ETF return).
    pub win_rate_pct: Option<f64>,
    /// Count of winning completed analog windows.
    pub win_count: usize,
    /// Total completed analog windows used in the win-rate denominator.
    pub completed_sample_count: usize,
    /// Mean 6-month forward ETF return (%) across completed windows.
    pub avg_6m_etf_return_pct: Option<f64>,
    /// Mean 12-month forward ETF return (%) across completed windows.
    pub avg_12m_etf_return_pct: Option<f64>,
    /// Mean 12-month forward ETF vs SPY excess return (%) across completed windows.
    pub avg_12m_vs_spy_pct: Option<f64>,
    /// Mean 12-month forward ETF vs GLD excess return (%) across completed windows.
    pub avg_12m_vs_gld_pct: Option<f64>,
}

/// Classifies a percentile rank (`0.0..=100.0`) into `Cheap`, `Expensive`, or `Fair`.
pub fn classify_valuation_zone(percentile: f64) -> &'static str {
    if percentile < 25.0 {
        "Cheap"
    } else if percentile > 75.0 {
        "Expensive"
    } else {
        "Fair"
    }
}

/// Read-only tool: fetches up to 10 fiscal years of `fiscal_spending` for `agency_code`.
pub async fn get_fiscal_flows(
    pool: &SqlitePool,
    agency_code: &str,
) -> Result<FiscalFlowsReport, AgentError> {
    let default_name = SECTOR_MAPPINGS
        .iter()
        .find(|m| m.agency_code == agency_code)
        .map(|m| m.agency_name)
        .unwrap_or("Unknown");

    type FiscalSqlRow = (
        String,
        i64,
        f64,
        f64,
        Option<f64>,
        Option<f64>,
        Option<String>,
    );

    let mut rows: Vec<FiscalSqlRow> = sqlx::query_as(
        "SELECT agency_name, fiscal_year, budgetary_resources, obligations, yoy_growth_pct, fiscal_impulse_zscore, fiscal_impulse_label
         FROM fiscal_spending
         WHERE agency_code = ?
         ORDER BY fiscal_year DESC
         LIMIT 10",
    )
    .bind(agency_code)
    .fetch_all(pool)
    .await?;

    rows.reverse();

    let agency_name = rows
        .last()
        .map(|r| r.0.clone())
        .unwrap_or_else(|| default_name.to_string());

    let yoy_series: Vec<Option<f64>> = rows.iter().map(|r| r.4).collect();
    let fallback_zscores = compute_trailing_5y_zscores(&yoy_series);

    let history: Vec<FiscalFlowRow> = rows
        .into_iter()
        .zip(fallback_zscores)
        .map(
            |(
                (_, fiscal_year, budgetary_resources, obligations, yoy_growth_pct, stored_z, stored_label),
                fallback_z,
            )| {
                let zscore = stored_z.or(fallback_z);
                let label = stored_label
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or_else(|| classify_fiscal_impulse_zscore(zscore).to_string());
                FiscalFlowRow {
                    fiscal_year,
                    budgetary_resources,
                    obligations,
                    yoy_growth_pct,
                    fiscal_impulse_zscore: zscore,
                    fiscal_impulse_label: label,
                }
            },
        )
        .collect();

    let latest = history.last();
    let latest_fiscal_year = latest.map(|r| r.fiscal_year);
    let latest_budgetary_resources = latest.map(|r| r.budgetary_resources);
    let latest_yoy_growth_pct = latest.and_then(|r| r.yoy_growth_pct);
    let fiscal_impulse_zscore = latest.and_then(|r| r.fiscal_impulse_zscore);
    let fiscal_impulse_label = latest
        .map(|r| r.fiscal_impulse_label.clone())
        .unwrap_or_else(|| classify_fiscal_impulse_zscore(fiscal_impulse_zscore).to_string());
    let spending_impulse = fiscal_impulse_label.clone();

    Ok(FiscalFlowsReport {
        agency_code: agency_code.to_string(),
        agency_name,
        latest_fiscal_year,
        latest_budgetary_resources,
        latest_yoy_growth_pct,
        fiscal_impulse_zscore,
        fiscal_impulse_label,
        spending_impulse,
        history,
    })
}

/// Read-only tool: fetches `macro_rates` history and identifies historical periods matching the current regime.
pub async fn get_rate_regime_history(pool: &SqlitePool) -> Result<RateRegimeReport, AgentError> {
    let history: Vec<MacroRateRow> = sqlx::query_as(
        "SELECT date, fed_funds, dgs10, yield_spread, regime_label
         FROM macro_rates
         ORDER BY date ASC",
    )
    .fetch_all(pool)
    .await?;

    let current = history.last().cloned();
    let matching_regime_periods = match current.as_ref() {
        Some(curr) => collect_matching_regime_periods(&history, &curr.regime_label),
        None => Vec::new(),
    };

    Ok(RateRegimeReport {
        current,
        matching_regime_periods,
        history,
    })
}

fn collect_matching_regime_periods(
    history: &[MacroRateRow],
    target_regime: &str,
) -> Vec<RegimeDateRange> {
    let mut ranges = Vec::new();
    let mut active: Option<(String, String, usize, f64, f64)> = None;

    for row in history {
        if row.regime_label == target_regime {
            match active.as_mut() {
                Some((_, end_date, count, ff_sum, spread_sum)) => {
                    *end_date = row.date.clone();
                    *count += 1;
                    *ff_sum += row.fed_funds;
                    *spread_sum += row.yield_spread;
                }
                None => {
                    active = Some((
                        row.date.clone(),
                        row.date.clone(),
                        1,
                        row.fed_funds,
                        row.yield_spread,
                    ));
                }
            }
        } else if let Some((start_date, end_date, months, ff_sum, spread_sum)) = active.take() {
            ranges.push(RegimeDateRange {
                regime_label: target_regime.to_string(),
                start_date,
                end_date,
                months,
                avg_fed_funds: ff_sum / (months as f64),
                avg_yield_spread: spread_sum / (months as f64),
            });
        }
    }

    if let Some((start_date, end_date, months, ff_sum, spread_sum)) = active {
        ranges.push(RegimeDateRange {
            regime_label: target_regime.to_string(),
            start_date,
            end_date,
            months,
            avg_fed_funds: ff_sum / (months as f64),
            avg_yield_spread: spread_sum / (months as f64),
        });
    }

    ranges
}

/// Read-only tool: fetches `sector_valuations` for `ticker`, classifies valuation zone, and calculates historical regime returns.
pub async fn get_sector_valuation(
    pool: &SqlitePool,
    ticker: &str,
) -> Result<SectorValuationReport, AgentError> {
    let mapping = find_sector_mapping(ticker)
        .ok_or_else(|| AgentError::UnknownTicker(ticker.to_string()))?;

    let history: Vec<SectorValuationRow> = sqlx::query_as(
        "SELECT date, close_price, gold_ratio, spy_ratio, valuation_percentile
         FROM sector_valuations
         WHERE ticker = ?
         ORDER BY date ASC",
    )
    .bind(mapping.ticker)
    .fetch_all(pool)
    .await?;

    let rate_rows: Vec<(String, String)> =
        sqlx::query_as("SELECT date, regime_label FROM macro_rates ORDER BY date ASC")
            .fetch_all(pool)
            .await?;

    let current_regime = rate_rows.last().map(|r| r.1.clone());
    let regime_by_date: HashMap<String, String> = rate_rows.into_iter().collect();

    let latest = history.last().cloned();
    let gold_ratios: Vec<f64> = history.iter().map(|r| r.gold_ratio).collect();
    let gold_valuation_percentile = percentile_ranks(&gold_ratios).last().copied();
    let valuation_zone = latest
        .as_ref()
        .map(|row| classify_valuation_zone(row.valuation_percentile))
        .unwrap_or("Unknown")
        .to_string();

    let (avg_12m_return_in_regime_pct, matching_regime_sample_count) = match current_regime.as_ref()
    {
        Some(target_regime) => compute_regime_returns(&history, &regime_by_date, target_regime),
        None => (None, 0),
    };

    Ok(SectorValuationReport {
        ticker: mapping.ticker.to_string(),
        sector_name: mapping.sector_name.to_string(),
        latest,
        gold_valuation_percentile,
        valuation_zone,
        current_regime,
        avg_12m_return_in_regime_pct,
        matching_regime_sample_count,
        history,
    })
}

fn short_month(date: &str) -> &str {
    if date.len() >= 7 {
        &date[..7]
    } else {
        date
    }
}

fn date_to_fiscal_year(date: &str) -> Option<(i64, i64)> {
    if date.len() < 7 {
        return None;
    }
    let year = date[..4].parse::<i64>().ok()?;
    let month = date[5..7].parse::<i64>().ok()?;
    let fy = if month >= 10 { year + 1 } else { year };
    Some((fy, year))
}

fn compute_forward_horizon(
    history: &[SectorValuationRow],
    start_idx: usize,
    offset: usize,
) -> (Option<f64>, Option<f64>, Option<f64>) {
    let Some(end) = history.get(start_idx + offset) else {
        return (None, None, None);
    };
    let start = &history[start_idx];
    if !(start.close_price > 0.0 && end.close_price.is_finite() && end.close_price > 0.0) {
        return (None, None, None);
    }

    let etf_ret = ((end.close_price - start.close_price) / start.close_price) * 100.0;

    let vs_spy = if start.spy_ratio > 0.0
        && end.spy_ratio > 0.0
        && start.spy_ratio.is_finite()
        && end.spy_ratio.is_finite()
    {
        let spy_start = start.close_price / start.spy_ratio;
        let spy_end = end.close_price / end.spy_ratio;
        let spy_ret = ((spy_end - spy_start) / spy_start) * 100.0;
        Some(etf_ret - spy_ret)
    } else {
        None
    };

    let vs_gld = if start.gold_ratio > 0.0
        && end.gold_ratio > 0.0
        && start.gold_ratio.is_finite()
        && end.gold_ratio.is_finite()
    {
        let gld_start = start.close_price / start.gold_ratio;
        let gld_end = end.close_price / end.gold_ratio;
        let gld_ret = ((gld_end - gld_start) / gld_start) * 100.0;
        Some(etf_ret - gld_ret)
    } else {
        None
    };

    (Some(etf_ret), vs_spy, vs_gld)
}

fn mean_of_options(values: impl Iterator<Item = Option<f64>>) -> Option<f64> {
    let collected: Vec<f64> = values.flatten().collect();
    if collected.is_empty() {
        None
    } else {
        Some(collected.iter().sum::<f64>() / (collected.len() as f64))
    }
}

/// Deterministically finds all historical windows sharing the current Rate Regime and computes
/// exact 6-month and 12-month forward returns for the ETF, ETF vs. SPY, and ETF vs. GLD.
pub async fn compute_regime_analogs(
    pool: &SqlitePool,
    ticker: &str,
) -> Result<RegimeAnalogsReport, AgentError> {
    let mapping = find_sector_mapping(ticker)
        .ok_or_else(|| AgentError::UnknownTicker(ticker.to_string()))?;

    let fiscal = get_fiscal_flows(pool, mapping.agency_code).await?;
    let rates = get_rate_regime_history(pool).await?;
    let valuation = get_sector_valuation(pool, mapping.ticker).await?;

    let current_regime = rates.current.as_ref().map(|r| r.regime_label.clone());
    let current_fiscal_impulse = fiscal.fiscal_impulse_label.clone();

    let fiscal_by_year: HashMap<i64, &FiscalFlowRow> = fiscal
        .history
        .iter()
        .map(|row| (row.fiscal_year, row))
        .collect();

    let mut analogs = Vec::with_capacity(rates.matching_regime_periods.len());

    for period in &rates.matching_regime_periods {
        let start_idx = valuation
            .history
            .iter()
            .position(|row| row.date >= period.start_date && row.date <= period.end_date);

        let (forward_6m_etf_return_pct, forward_6m_vs_spy_pct, forward_6m_vs_gld_pct) =
            match start_idx {
                Some(idx) => compute_forward_horizon(&valuation.history, idx, 6),
                None => (None, None, None),
            };

        let (forward_12m_etf_return_pct, forward_12m_vs_spy_pct, forward_12m_vs_gld_pct) =
            match start_idx {
                Some(idx) => compute_forward_horizon(&valuation.history, idx, 12),
                None => (None, None, None),
            };

        let fiscal_row = date_to_fiscal_year(&period.start_date).and_then(|(fy, cal_year)| {
            fiscal_by_year
                .get(&fy)
                .or_else(|| fiscal_by_year.get(&cal_year))
                .copied()
        });

        let fiscal_impulse_label = fiscal_row
            .map(|r| r.fiscal_impulse_label.clone())
            .unwrap_or_else(|| "Neutral".to_string());
        let matches_fiscal_direction = fiscal_impulse_label == current_fiscal_impulse;

        analogs.push(RegimeAnalogWindow {
            period: format!(
                "{} → {}",
                short_month(&period.start_date),
                short_month(&period.end_date)
            ),
            start_date: period.start_date.clone(),
            end_date: period.end_date.clone(),
            months: period.months,
            regime_label: period.regime_label.clone(),
            avg_fed_funds: period.avg_fed_funds,
            fiscal_year: fiscal_row.map(|r| r.fiscal_year),
            fiscal_yoy_pct: fiscal_row.and_then(|r| r.yoy_growth_pct),
            fiscal_impulse_zscore: fiscal_row.and_then(|r| r.fiscal_impulse_zscore),
            fiscal_impulse_label,
            matches_fiscal_direction,
            forward_6m_etf_return_pct,
            forward_6m_vs_spy_pct,
            forward_6m_vs_gld_pct,
            forward_12m_etf_return_pct,
            forward_12m_vs_spy_pct,
            forward_12m_vs_gld_pct,
        });
    }

    let twelve_m_returns: Vec<f64> = analogs
        .iter()
        .filter_map(|a| a.forward_12m_etf_return_pct)
        .collect();
    let eval_returns: Vec<f64> = if !twelve_m_returns.is_empty() {
        twelve_m_returns
    } else {
        analogs
            .iter()
            .filter_map(|a| a.forward_6m_etf_return_pct)
            .collect()
    };

    let completed_sample_count = eval_returns.len();
    let win_count = eval_returns.iter().filter(|&&r| r > 0.0).count();
    let win_rate_pct = if completed_sample_count > 0 {
        Some((win_count as f64 / completed_sample_count as f64) * 100.0)
    } else {
        None
    };

    let avg_6m_etf_return_pct =
        mean_of_options(analogs.iter().map(|a| a.forward_6m_etf_return_pct));
    let avg_12m_etf_return_pct =
        mean_of_options(analogs.iter().map(|a| a.forward_12m_etf_return_pct));
    let avg_12m_vs_spy_pct = mean_of_options(analogs.iter().map(|a| a.forward_12m_vs_spy_pct));
    let avg_12m_vs_gld_pct = mean_of_options(analogs.iter().map(|a| a.forward_12m_vs_gld_pct));

    Ok(RegimeAnalogsReport {
        ticker: mapping.ticker.to_string(),
        current_regime,
        current_fiscal_impulse,
        analogs,
        win_rate_pct,
        win_count,
        completed_sample_count,
        avg_6m_etf_return_pct,
        avg_12m_etf_return_pct,
        avg_12m_vs_spy_pct,
        avg_12m_vs_gld_pct,
    })
}

/// Computes average 12-month forward returns during `target_regime`, falling back to
/// compounded 12-month annualized monthly returns when fewer than 13 monthly points exist.
fn compute_regime_returns(
    history: &[SectorValuationRow],
    regime_by_date: &HashMap<String, String>,
    target_regime: &str,
) -> (Option<f64>, usize) {
    let mut forward_12m_returns = Vec::new();
    for i in 0..history.len() {
        if i + 12 >= history.len() {
            break;
        }
        if regime_by_date.get(&history[i].date).map(String::as_str) == Some(target_regime) {
            let start_price = history[i].close_price;
            let end_price = history[i + 12].close_price;
            if start_price > 0.0 && end_price.is_finite() {
                forward_12m_returns.push(((end_price - start_price) / start_price) * 100.0);
            }
        }
    }

    if !forward_12m_returns.is_empty() {
        let count = forward_12m_returns.len();
        let avg = forward_12m_returns.iter().sum::<f64>() / (count as f64);
        return (Some(avg), count);
    }

    let mut monthly_returns = Vec::new();
    for i in 0..history.len().saturating_sub(1) {
        if regime_by_date.get(&history[i].date).map(String::as_str) == Some(target_regime) {
            let start_price = history[i].close_price;
            let end_price = history[i + 1].close_price;
            if start_price > 0.0 && end_price.is_finite() {
                monthly_returns.push((end_price - start_price) / start_price);
            }
        }
    }

    if monthly_returns.is_empty() {
        (None, 0)
    } else {
        let count = monthly_returns.len();
        let mean_monthly = monthly_returns.iter().sum::<f64>() / (count as f64);
        let annualized_pct = ((1.0 + mean_monthly).powi(12) - 1.0) * 100.0;
        (Some(annualized_pct), count)
    }
}

/// Returns Gemini API `functionDeclarations` JSON schema for the 5 read-only SQLite tools.
pub fn gemini_tool_declarations() -> Value {
    json!([
        {
            "name": "get_fiscal_flows",
            "description": "Fetch the last 10 fiscal years of federal budgetary resources, obligations, YoY growth %, and trailing 5-year Fiscal Impulse Z-score for a given agency_code (097=Defense, 089=Energy, 075=HHS, 069=Transportation/Infrastructure, 013=Commerce/Technology).",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "agency_code": {
                        "type": "STRING",
                        "description": "Three-digit federal agency code: 097, 089, 075, 069, or 013."
                    }
                },
                "required": ["agency_code"]
            }
        },
        {
            "name": "get_rate_regime_history",
            "description": "Fetch the current US macro interest rate observation (FEDFUNDS, DGS10, yield_spread, regime_label) and historical contiguous date ranges that shared the same regime_label.",
            "parameters": {
                "type": "OBJECT",
                "properties": {},
                "required": []
            }
        },
        {
            "name": "get_sector_valuation",
            "description": "Fetch the latest sector ETF close price, GLD ratio, SPY ratio, 10-year valuation percentile, gold valuation percentile, valuation zone (Cheap/Fair/Expensive), and historical return during matching rate regimes.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "ticker": {
                        "type": "STRING",
                        "description": "Sector ETF ticker: ITA, XLE, XLV, IYT, XLK, or PAVE."
                    }
                },
                "required": ["ticker"]
            }
        },
        {
            "name": "get_regime_analogs",
            "description": "Fetch deterministic historical windows sharing the current Rate Regime, showing exact 6M and 12M forward ETF, vs-SPY, and vs-GLD returns plus win rate and fiscal direction matches.",
            "parameters": {
                "type": "OBJECT",
                "properties": {
                    "ticker": {
                        "type": "STRING",
                        "description": "Sector ETF ticker: ITA, XLE, XLV, IYT, XLK, or PAVE."
                    }
                },
                "required": ["ticker"]
            }
        },
        {
            "name": "get_sector_rankings",
            "description": "Fetch all 6 sector ETFs (ITA, XLE, XLV, IYT, XLK, PAVE) deterministically scored (0-100) and ranked #1-#6 across Fiscal Impulse, Historical Regime Edge, and Valuation Margin of Safety with Decision Tiers.",
            "parameters": {
                "type": "OBJECT",
                "properties": {},
                "required": []
            }
        }
    ])
}

/// Dispatches an LLM tool call to the corresponding read-only SQLite query tool.
pub async fn execute_tool_call(
    pool: &SqlitePool,
    name: &str,
    args: &Value,
) -> Result<Value, AgentError> {
    match name {
        "get_fiscal_flows" => {
            let agency_code = args
                .get("agency_code")
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    AgentError::ToolError("get_fiscal_flows requires 'agency_code'".to_string())
                })?;
            let report = get_fiscal_flows(pool, agency_code).await?;
            Ok(serde_json::to_value(report)?)
        }
        "get_rate_regime_history" => {
            let report = get_rate_regime_history(pool).await?;
            Ok(serde_json::to_value(report)?)
        }
        "get_sector_valuation" => {
            let ticker = args.get("ticker").and_then(Value::as_str).ok_or_else(|| {
                AgentError::ToolError("get_sector_valuation requires 'ticker'".to_string())
            })?;
            let report = get_sector_valuation(pool, ticker).await?;
            Ok(serde_json::to_value(report)?)
        }
        "get_regime_analogs" => {
            let ticker = args.get("ticker").and_then(Value::as_str).ok_or_else(|| {
                AgentError::ToolError("get_regime_analogs requires 'ticker'".to_string())
            })?;
            let report = compute_regime_analogs(pool, ticker).await?;
            Ok(serde_json::to_value(report)?)
        }
        "get_sector_rankings" => {
            let rankings = crate::decision::compute_sector_rankings(pool).await?;
            Ok(serde_json::to_value(rankings)?)
        }
        _ => Err(AgentError::ToolError(format!("unknown tool: {name}"))),
    }
}

#[cfg(test)]
pub(crate) mod test_fixtures {
    use sqlx::SqlitePool;

    /// Seeds deterministic sample data across all three ingestion tables for tests.
    pub async fn seed_sample_macro_data(pool: &SqlitePool) {
        let agencies = [
            ("097", "Defense"),
            ("089", "Energy"),
            ("075", "HHS"),
            ("069", "Transportation"),
            ("013", "Commerce"),
        ];
        for (code, name) in agencies {
            for (yr, br, ob, yoy) in [
                (2022_i64, 800.0_f64, 720.0_f64, None),
                (2023_i64, 840.0_f64, 760.0_f64, Some(5.0_f64)),
                (2024_i64, 924.0_f64, 850.0_f64, Some(10.0_f64)),
            ] {
                sqlx::query(
                    "INSERT INTO fiscal_spending (agency_code, agency_name, fiscal_year, budgetary_resources, obligations, yoy_growth_pct)
                     VALUES (?, ?, ?, ?, ?, ?)",
                )
                .bind(code)
                .bind(name)
                .bind(yr)
                .bind(br)
                .bind(ob)
                .bind(yoy)
                .execute(pool)
                .await
                .expect("seed fiscal_spending failed");
            }
        }

        // Seed 14 months so 12-month forward return has 2 samples under High-Pause.
        let months = [
            ("2023-01-01", 4.33, 3.53, -0.80, "Hiking", 100.0),
            ("2023-02-01", 4.57, 3.75, -0.82, "Hiking", 102.0),
            ("2023-03-01", 4.65, 3.66, -0.99, "High-Pause", 100.0),
            ("2023-04-01", 4.83, 3.46, -1.37, "High-Pause", 110.0),
            ("2023-05-01", 5.06, 3.57, -1.49, "High-Pause", 108.0),
            ("2023-06-01", 5.08, 3.75, -1.33, "High-Pause", 112.0),
            ("2023-07-01", 5.12, 3.90, -1.22, "High-Pause", 114.0),
            ("2023-08-01", 5.33, 4.17, -1.16, "High-Pause", 116.0),
            ("2023-09-01", 5.33, 4.38, -0.95, "High-Pause", 118.0),
            ("2023-10-01", 5.33, 4.80, -0.53, "High-Pause", 120.0),
            ("2023-11-01", 5.33, 4.50, -0.83, "High-Pause", 122.0),
            ("2023-12-01", 5.33, 4.02, -1.31, "High-Pause", 124.0),
            ("2024-01-01", 5.33, 4.06, -1.27, "High-Pause", 126.0),
            ("2024-02-01", 5.33, 4.21, -1.12, "High-Pause", 128.0),
            ("2024-03-01", 5.33, 4.21, -1.12, "High-Pause", 120.0), // +20% vs 2023-03-01
            ("2024-04-01", 5.33, 4.54, -0.79, "High-Pause", 121.0), // +10% vs 2023-04-01 -> avg 15%
        ];

        for (i, &(date, ff, dgs10, spread, regime, price)) in months.iter().enumerate() {
            sqlx::query(
                "INSERT INTO macro_rates (date, fed_funds, dgs10, yield_spread, regime_label)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(date)
            .bind(ff)
            .bind(dgs10)
            .bind(spread)
            .bind(regime)
            .execute(pool)
            .await
            .expect("seed macro_rates failed");

            let pct = if i == months.len() - 1 { 18.0 } else { 50.0 };
            for (ticker, sector_name) in [
                ("ITA", "Defense"),
                ("XLE", "Energy"),
                ("XLV", "Healthcare"),
                ("IYT", "Transportation"),
                ("XLK", "Technology"),
                ("PAVE", "Infrastructure"),
            ] {
                sqlx::query(
                    "INSERT INTO sector_valuations (ticker, sector_name, date, close_price, gold_ratio, spy_ratio, valuation_percentile)
                     VALUES (?, ?, ?, ?, ?, ?, ?)",
                )
                .bind(ticker)
                .bind(sector_name)
                .bind(date)
                .bind(price)
                .bind(price / 200.0)
                .bind(price / 500.0)
                .bind(pct)
                .execute(pool)
                .await
                .expect("seed sector_valuations failed");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::test_fixtures::seed_sample_macro_data;
    use super::*;
    use crate::db::init_db;

    #[test]
    fn test_sector_mapping_and_classification() {
        assert_eq!(SECTOR_MAPPINGS.len(), 6);
        assert_eq!(find_sector_mapping("ita").unwrap().agency_code, "097");
        assert_eq!(find_sector_mapping("XLE").unwrap().agency_code, "089");
        assert_eq!(find_sector_mapping("XLV").unwrap().agency_code, "075");
        assert_eq!(find_sector_mapping("IYT").unwrap().agency_code, "069");
        assert_eq!(find_sector_mapping("xlk").unwrap().agency_code, "013");
        assert_eq!(find_sector_mapping("XLK").unwrap().agency_name, "Commerce");
        assert_eq!(find_sector_mapping("PAVE").unwrap().agency_code, "069");
        assert_eq!(
            find_sector_mapping("pave").unwrap().sector_name,
            "Infrastructure"
        );
        assert!(find_sector_mapping("QQQ").is_none());

        assert_eq!(classify_valuation_zone(15.0), "Cheap");
        assert_eq!(classify_valuation_zone(50.0), "Fair");
        assert_eq!(classify_valuation_zone(82.0), "Expensive");
    }

    #[tokio::test]
    async fn test_read_only_sqlite_tools_and_dispatch() {
        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");
        seed_sample_macro_data(&pool).await;

        let fiscal = get_fiscal_flows(&pool, "097")
            .await
            .expect("get_fiscal_flows failed");
        assert_eq!(fiscal.history.len(), 3);
        assert_eq!(fiscal.latest_fiscal_year, Some(2024));
        assert_eq!(fiscal.fiscal_impulse_label, "Accelerating");
        assert_eq!(fiscal.spending_impulse, "Accelerating");
        assert!((fiscal.fiscal_impulse_zscore.unwrap() - 1.0).abs() < 1e-9);
        assert!((fiscal.latest_yoy_growth_pct.unwrap() - 10.0).abs() < 1e-9);

        let rates = get_rate_regime_history(&pool)
            .await
            .expect("get_rate_regime_history failed");
        assert_eq!(rates.current.as_ref().unwrap().regime_label, "High-Pause");
        assert_eq!(rates.matching_regime_periods.len(), 1);
        assert_eq!(rates.matching_regime_periods[0].start_date, "2023-03-01");
        assert_eq!(rates.matching_regime_periods[0].end_date, "2024-04-01");
        assert_eq!(rates.matching_regime_periods[0].months, 14);

        let valuation = get_sector_valuation(&pool, "ITA")
            .await
            .expect("get_sector_valuation failed");
        assert_eq!(valuation.valuation_zone, "Cheap");
        assert!(valuation.gold_valuation_percentile.is_some());
        assert_eq!(valuation.matching_regime_sample_count, 2);
        assert!((valuation.avg_12m_return_in_regime_pct.unwrap() - 15.0).abs() < 1e-9);

        let tool_json = execute_tool_call(&pool, "get_sector_valuation", &json!({"ticker": "ITA"}))
            .await
            .expect("execute_tool_call failed");
        assert_eq!(tool_json["valuation_zone"], "Cheap");

        let analogs_json = execute_tool_call(&pool, "get_regime_analogs", &json!({"ticker": "ITA"}))
            .await
            .expect("execute_tool_call get_regime_analogs failed");
        assert_eq!(analogs_json["ticker"], "ITA");
        assert_eq!(analogs_json["analogs"].as_array().unwrap().len(), 1);

        let rankings_json = execute_tool_call(&pool, "get_sector_rankings", &json!({}))
            .await
            .expect("execute_tool_call get_sector_rankings failed");
        assert_eq!(rankings_json.as_array().unwrap().len(), 6);
        assert_eq!(gemini_tool_declarations().as_array().unwrap().len(), 5);
    }

    #[tokio::test]
    async fn test_compute_regime_analogs_math_and_win_rate() {
        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");

        for (yr, yoy) in [
            (2019_i64, Some(2.0_f64)),
            (2020_i64, Some(2.0_f64)),
            (2021_i64, Some(2.0_f64)),
            (2022_i64, Some(2.0_f64)),
            (2023_i64, Some(-6.0_f64)),
            (2024_i64, Some(12.0_f64)),
        ] {
            sqlx::query(
                "INSERT INTO fiscal_spending (agency_code, agency_name, fiscal_year, budgetary_resources, obligations, yoy_growth_pct)
                 VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind("013")
            .bind("Commerce")
            .bind(yr)
            .bind(100.0_f64)
            .bind(90.0_f64)
            .bind(yoy)
            .execute(&pool)
            .await
            .expect("insert fiscal_spending failed");
        }

        // 28 monthly points from 2022-01 to 2024-04 with 3 High-Pause windows.
        let mut points = Vec::new();
        for i in 0..28_usize {
            let year = 2022 + (i / 12);
            let month = (i % 12) + 1;
            let date = format!("{year:04}-{month:02}-01");
            let (regime, ff) = match i {
                0..=2 => ("High-Pause", 3.00),
                3..=11 => ("Hiking", 4.00),
                12..=14 => ("High-Pause", 4.75),
                15..=25 => ("Cutting", 4.25),
                _ => ("High-Pause", 5.25),
            };
            let (xlk, spy, gld) = match i {
                0 => (100.0, 400.0, 200.0),
                6 => (120.0, 440.0, 200.0),  // 6M from idx 0: ETF +20%, SPY +10%, GLD 0%
                12 => (130.0, 480.0, 220.0), // 12M from idx 0: ETF +30%, SPY +20%, GLD +10%
                18 => (117.0, 528.0, 220.0), // 6M from idx 12: ETF -10%, SPY +10%, GLD 0%
                24 => (104.0, 528.0, 242.0), // 12M from idx 12: ETF -20%, SPY +10%, GLD +10%
                _ => (110.0, 450.0, 210.0),
            };
            points.push((date, regime, ff, xlk, spy, gld));
        }

        for (date, regime, ff, xlk, spy, gld) in points {
            sqlx::query(
                "INSERT INTO macro_rates (date, fed_funds, dgs10, yield_spread, regime_label)
                 VALUES (?, ?, ?, ?, ?)",
            )
            .bind(&date)
            .bind(ff)
            .bind(4.0_f64)
            .bind(4.0 - ff)
            .bind(regime)
            .execute(&pool)
            .await
            .expect("insert macro_rates failed");

            sqlx::query(
                "INSERT INTO sector_valuations (ticker, sector_name, date, close_price, gold_ratio, spy_ratio, valuation_percentile)
                 VALUES (?, ?, ?, ?, ?, ?, ?)",
            )
            .bind("XLK")
            .bind("Technology")
            .bind(&date)
            .bind(xlk)
            .bind(xlk / gld)
            .bind(xlk / spy)
            .bind(50.0_f64)
            .execute(&pool)
            .await
            .expect("insert sector_valuations failed");
        }

        let report = compute_regime_analogs(&pool, "XLK")
            .await
            .expect("compute_regime_analogs failed");

        assert_eq!(report.ticker, "XLK");
        assert_eq!(report.current_regime.as_deref(), Some("High-Pause"));
        assert_eq!(report.current_fiscal_impulse, "Accelerating");
        assert_eq!(report.analogs.len(), 3);

        // Window 1: 2022-01 -> 2022-03
        let w1 = &report.analogs[0];
        assert_eq!(w1.period, "2022-01 → 2022-03");
        assert_eq!(w1.fiscal_impulse_label, "Neutral");
        assert!(!w1.matches_fiscal_direction);
        assert!((w1.forward_6m_etf_return_pct.unwrap() - 20.0).abs() < 1e-9);
        assert!((w1.forward_6m_vs_spy_pct.unwrap() - 10.0).abs() < 1e-9);
        assert!((w1.forward_6m_vs_gld_pct.unwrap() - 20.0).abs() < 1e-9);
        assert!((w1.forward_12m_etf_return_pct.unwrap() - 30.0).abs() < 1e-9);
        assert!((w1.forward_12m_vs_spy_pct.unwrap() - 10.0).abs() < 1e-9);
        assert!((w1.forward_12m_vs_gld_pct.unwrap() - 20.0).abs() < 1e-9);

        // Window 2: 2023-01 -> 2023-03
        let w2 = &report.analogs[1];
        assert_eq!(w2.period, "2023-01 → 2023-03");
        assert_eq!(w2.fiscal_impulse_label, "Contracting");
        assert!(!w2.matches_fiscal_direction);
        assert!((w2.forward_6m_etf_return_pct.unwrap() - (-10.0)).abs() < 1e-9);
        assert!((w2.forward_6m_vs_spy_pct.unwrap() - (-20.0)).abs() < 1e-9);
        assert!((w2.forward_6m_vs_gld_pct.unwrap() - (-10.0)).abs() < 1e-9);
        assert!((w2.forward_12m_etf_return_pct.unwrap() - (-20.0)).abs() < 1e-9);
        assert!((w2.forward_12m_vs_spy_pct.unwrap() - (-30.0)).abs() < 1e-9);
        assert!((w2.forward_12m_vs_gld_pct.unwrap() - (-30.0)).abs() < 1e-9);

        // Window 3: 2024-03 -> 2024-04 (active current window, no forward horizon yet)
        let w3 = &report.analogs[2];
        assert_eq!(w3.period, "2024-03 → 2024-04");
        assert_eq!(w3.fiscal_impulse_label, "Accelerating");
        assert!(w3.matches_fiscal_direction);
        assert!(w3.forward_6m_etf_return_pct.is_none());
        assert!(w3.forward_12m_etf_return_pct.is_none());

        assert_eq!(report.win_count, 1);
        assert_eq!(report.completed_sample_count, 2);
        assert!((report.win_rate_pct.unwrap() - 50.0).abs() < 1e-9);
        assert!((report.avg_6m_etf_return_pct.unwrap() - 5.0).abs() < 1e-9);
        assert!((report.avg_12m_etf_return_pct.unwrap() - 5.0).abs() < 1e-9);
        assert!((report.avg_12m_vs_spy_pct.unwrap() - (-10.0)).abs() < 1e-9);
        assert!((report.avg_12m_vs_gld_pct.unwrap() - (-5.0)).abs() < 1e-9);
    }
}
