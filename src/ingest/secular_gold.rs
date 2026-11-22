use std::collections::{BTreeMap, HashMap};

use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use super::fred::{parse_observations, FredResponse};
use super::market::{parse_yahoo_monthly_closes, percentile_ranks, YahooChartResponse};
use super::IngestError;

const STOOQ_XAUUSD_MONTHLY_URL: &str = "https://stooq.com/q/d/l/?s=xauusd&i=m";
const YAHOO_CHART_BASE_URL: &str = "https://query1.finance.yahoo.com/v8/finance/chart";
const FRED_BASE_URL: &str = "https://api.stlouisfed.org/fred/series/observations";
const YAHOO_GCF_PERIOD1_2004: i64 = 1_072_915_200;

/// Static metadata describing a secular "Asset vs. Gold" ratio series.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SecularAssetMeta {
    /// Canonical asset identifier (e.g. `"USD_GOLD"`).
    pub asset_key: &'static str,
    /// Human-readable display name.
    pub asset_name: &'static str,
    /// Unit description for the Gold-denominated ratio.
    pub unit_label: &'static str,
}

/// Canonical list of the 6 secular macro assets priced in Gold.
pub const SECULAR_ASSETS: &[SecularAssetMeta] = &[
    SecularAssetMeta {
        asset_key: "USD_GOLD",
        asset_name: "US Dollar ($1,000)",
        unit_label: "oz Gold per $1,000",
    },
    SecularAssetMeta {
        asset_key: "GBP_GOLD",
        asset_name: "British Pound (£1,000)",
        unit_label: "oz Gold per £1,000",
    },
    SecularAssetMeta {
        asset_key: "CASH_FUND_GOLD",
        asset_name: "US Cash / Fed Funds ($1,000 Compounded)",
        unit_label: "oz Gold per $1,000 compounded",
    },
    SecularAssetMeta {
        asset_key: "SP500_GOLD",
        asset_name: "S&P 500",
        unit_label: "oz Gold per S&P 500",
    },
    SecularAssetMeta {
        asset_key: "NASDAQ_GOLD",
        asset_name: "Nasdaq (NDX / Composite)",
        unit_label: "oz Gold per Nasdaq",
    },
    SecularAssetMeta {
        asset_key: "HOUSING_GOLD",
        asset_name: "US Median House",
        unit_label: "oz Gold per Median US House",
    },
];

/// Verified annual London Gold PM Fix / World Gold Council anchor prices (USD/oz) for 1970–2005.
const EMBEDDED_GOLD_ANNUAL_USD: &[(i32, f64)] = &[
    (1970, 35.17),
    (1971, 37.88),
    (1972, 45.75),
    (1973, 65.14),
    (1974, 129.19),
    (1975, 176.27),
    (1976, 131.49),
    (1977, 132.26),
    (1978, 173.18),
    (1979, 227.27),
    (1980, 675.31),
    (1981, 557.39),
    (1982, 384.13),
    (1983, 481.29),
    (1984, 370.89),
    (1985, 302.79),
    (1986, 345.38),
    (1987, 408.26),
    (1988, 476.58),
    (1989, 404.01),
    (1990, 410.11),
    (1991, 383.64),
    (1992, 354.45),
    (1993, 329.01),
    (1994, 386.88),
    (1995, 378.55),
    (1996, 399.45),
    (1997, 355.10),
    (1998, 289.15),
    (1999, 287.08),
    (2000, 284.32),
    (2001, 265.49),
    (2002, 281.51),
    (2003, 356.86),
    (2004, 413.79),
    (2005, 424.15),
];

/// Normalized secular gold ratio observation ready for SQLite persistence.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, PartialEq)]
pub struct SecularGoldRecord {
    /// Canonical asset identifier (e.g. `"USD_GOLD"`).
    pub asset_key: String,
    /// Display name of the asset.
    pub asset_name: String,
    /// Unit label for `ratio_in_gold`.
    pub unit_label: String,
    /// Normalized monthly observation date (`YYYY-MM-01`).
    pub date: String,
    /// Asset value in nominal USD.
    pub asset_value_usd: f64,
    /// Spot/benchmark Gold price in USD per troy ounce.
    pub gold_price_usd: f64,
    /// Asset priced in ounces of Gold (`asset_value_usd / gold_price_usd`).
    pub ratio_in_gold: f64,
    /// Secular percentile rank (0.0–100.0) across the full series history.
    pub secular_percentile: f64,
}

/// Extreme (minimum or maximum) historical ratio and its observation date.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SecularExtreme {
    /// Ratio denominated in Gold.
    pub ratio: f64,
    /// Observation date (`YYYY-MM-01`).
    pub date: String,
}

/// Single chronological point returned inside `SecularGoldAssetResponse.series`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SecularGoldPoint {
    /// Observation date (`YYYY-MM-01`).
    pub date: String,
    /// Asset value priced in ounces of Gold.
    pub ratio_in_gold: f64,
    /// Asset value in nominal USD.
    pub asset_value_usd: f64,
    /// Gold price in USD per ounce.
    pub gold_price_usd: f64,
}

/// Aggregated 55-year asset summary and chronological series returned by `GET /api/vs-gold`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SecularGoldAssetResponse {
    /// Canonical asset identifier.
    pub asset_key: String,
    /// Asset display name.
    pub asset_name: String,
    /// Unit label for `ratio_in_gold`.
    pub unit_label: String,
    /// Most recent ratio in Gold.
    pub latest_ratio: f64,
    /// Most recent observation date (`YYYY-MM-01`).
    pub latest_date: String,
    /// Most recent secular percentile rank (0.0–100.0).
    pub secular_percentile: f64,
    /// Secular all-time low ratio in Gold and date.
    pub min_ratio: SecularExtreme,
    /// Secular all-time high ratio in Gold and date.
    pub max_ratio: SecularExtreme,
    /// Arithmetic mean of `ratio_in_gold` across the full series.
    pub mean_ratio: f64,
    /// Valuation classification (`Cheap`, `Normal`, or `Expensive`).
    pub valuation_zone: String,
    /// Chronological time series from earliest available date to present.
    pub series: Vec<SecularGoldPoint>,
}

/// Classifies a secular percentile rank (`0.0..=100.0`) into `Cheap`, `Expensive`, or `Normal`.
pub fn classify_secular_valuation_zone(percentile: f64) -> &'static str {
    if percentile < 25.0 {
        "Cheap"
    } else if percentile > 75.0 {
        "Expensive"
    } else {
        "Normal"
    }
}

/// Generates an interpolated 1970–2004 monthly Gold USD baseline (420 observations).
pub fn embedded_gold_baseline_1970_2004() -> BTreeMap<String, f64> {
    let mut series = BTreeMap::new();
    for pair in EMBEDDED_GOLD_ANNUAL_USD.windows(2) {
        let (year, start_price) = pair[0];
        let (_, end_price) = pair[1];
        for month_idx in 0..12_u32 {
            let weight = (month_idx as f64) / 12.0;
            let price = start_price + (end_price - start_price) * weight;
            let date = format!("{year:04}-{:02}-01", month_idx + 1);
            series.insert(date, price);
        }
    }
    series
}

/// Parses Stooq monthly CSV (`Date,Open,High,Low,Close[,Volume]`) into `"YYYY-MM-01"` closes from 1970+.
pub fn parse_stooq_monthly_csv(csv_body: &str) -> BTreeMap<String, f64> {
    let mut closes = BTreeMap::new();
    for line in csv_body.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with("Date") {
            continue;
        }
        let cols: Vec<&str> = trimmed.split(',').collect();
        if cols.len() < 5 {
            continue;
        }
        let raw_date = cols[0].trim();
        if raw_date.len() < 7 {
            continue;
        }
        let Ok(year) = raw_date[..4].parse::<i32>() else {
            continue;
        };
        let Ok(month) = raw_date[5..7].parse::<u32>() else {
            continue;
        };
        if !(1970..=2100).contains(&year) || !(1..=12).contains(&month) {
            continue;
        }
        let Ok(close) = cols[4].trim().parse::<f64>() else {
            continue;
        };
        if close.is_finite() && close > 0.0 {
            let month_key = format!("{year:04}-{month:02}-01");
            closes.insert(month_key, close);
        }
    }
    closes
}

/// Splices embedded 1970–2004 Gold baseline with Stooq `xauusd` and/or Yahoo Finance `GC=F`.
pub fn splice_gold_series(
    stooq: Option<&BTreeMap<String, f64>>,
    yahoo_gc: Option<&BTreeMap<String, f64>>,
) -> BTreeMap<String, f64> {
    let mut series = embedded_gold_baseline_1970_2004();

    let stooq_has_modern = stooq
        .map(|m| m.keys().any(|d| d.as_str() >= "2010-01-01"))
        .unwrap_or(false);

    if let Some(stooq_map) = stooq {
        for (date, &price) in stooq_map {
            if date.as_str() >= "1970-01-01" && price.is_finite() && price > 0.0 {
                series.insert(date.clone(), price);
            }
        }
    }

    if let Some(gc_map) = yahoo_gc {
        for (date, &price) in gc_map {
            if date.as_str() >= "2004-01-01"
                && price.is_finite()
                && price > 0.0
                && (!stooq_has_modern || !series.contains_key(date))
            {
                series.insert(date.clone(), price);
            }
        }
    }

    series
}

fn find_asset_meta(asset_key: &str) -> SecularAssetMeta {
    SECULAR_ASSETS
        .iter()
        .copied()
        .find(|meta| meta.asset_key == asset_key)
        .expect("asset_key must exist in SECULAR_ASSETS")
}

fn build_ratio_records(
    meta: SecularAssetMeta,
    aligned: Vec<(String, f64, f64)>,
) -> Vec<SecularGoldRecord> {
    let valid: Vec<(String, f64, f64, f64)> = aligned
        .into_iter()
        .filter_map(|(date, asset_usd, gold_usd)| {
            if asset_usd.is_finite()
                && asset_usd > 0.0
                && gold_usd.is_finite()
                && gold_usd > 0.0
            {
                Some((date, asset_usd, gold_usd, asset_usd / gold_usd))
            } else {
                None
            }
        })
        .collect();

    let ratios: Vec<f64> = valid.iter().map(|entry| entry.3).collect();
    let percentiles = percentile_ranks(&ratios);

    valid
        .into_iter()
        .zip(percentiles)
        .map(
            |((date, asset_value_usd, gold_price_usd, ratio_in_gold), secular_percentile)| {
                SecularGoldRecord {
                    asset_key: meta.asset_key.to_string(),
                    asset_name: meta.asset_name.to_string(),
                    unit_label: meta.unit_label.to_string(),
                    date,
                    asset_value_usd,
                    gold_price_usd,
                    ratio_in_gold,
                    secular_percentile,
                }
            },
        )
        .collect()
}

/// Computes `USD_GOLD`: purchasing power of $1,000 in ounces of Gold (`1000.0 / gold_usd`).
pub fn build_usd_in_gold(gold_series: &BTreeMap<String, f64>) -> Vec<SecularGoldRecord> {
    let meta = find_asset_meta("USD_GOLD");
    let aligned = gold_series
        .iter()
        .filter(|(date, _)| date.as_str() >= "1970-01-01")
        .map(|(date, &gold_usd)| (date.clone(), 1000.0, gold_usd))
        .collect();
    build_ratio_records(meta, aligned)
}

/// Computes `GBP_GOLD`: purchasing power of £1,000 in ounces of Gold (`(1000.0 * usd_per_gbp) / gold_usd`).
pub fn build_gbp_in_gold(
    dexusuk: &BTreeMap<String, f64>,
    gold_series: &BTreeMap<String, f64>,
) -> Vec<SecularGoldRecord> {
    let meta = find_asset_meta("GBP_GOLD");
    let aligned = dexusuk
        .iter()
        .filter_map(|(date, &usd_per_gbp)| {
            if date.as_str() < "1971-01-01" || !usd_per_gbp.is_finite() || usd_per_gbp <= 0.0 {
                return None;
            }
            let &gold_usd = gold_series.get(date)?;
            Some((date.clone(), 1000.0 * usd_per_gbp, gold_usd))
        })
        .collect();
    build_ratio_records(meta, aligned)
}

/// Computes `CASH_FUND_GOLD`: $1,000 compounded monthly at `FEDFUNDS` from Jan 1970, divided by `gold_usd`.
pub fn build_cash_fund_in_gold(
    fed_funds: &BTreeMap<String, f64>,
    gold_series: &BTreeMap<String, f64>,
) -> Vec<SecularGoldRecord> {
    let meta = find_asset_meta("CASH_FUND_GOLD");
    let monthly_rates: Vec<(&String, f64)> = fed_funds
        .iter()
        .filter(|(date, &rate)| date.as_str() >= "1970-01-01" && rate.is_finite())
        .map(|(date, &rate)| (date, rate))
        .collect();

    let mut balance = 1000.0_f64;
    let mut aligned = Vec::with_capacity(monthly_rates.len());
    for (idx, &(date, _rate)) in monthly_rates.iter().enumerate() {
        if idx > 0 {
            let prev_rate = monthly_rates[idx - 1].1;
            balance *= 1.0 + (prev_rate / 100.0) / 12.0;
        }
        if let Some(&gold_usd) = gold_series.get(date) {
            aligned.push((date.clone(), balance, gold_usd));
        }
    }

    build_ratio_records(meta, aligned)
}

/// Computes `SP500_GOLD`: Yahoo Finance `^GSPC` monthly close divided by `gold_usd`.
pub fn build_sp500_in_gold(
    gspc: &BTreeMap<String, f64>,
    gold_series: &BTreeMap<String, f64>,
) -> Vec<SecularGoldRecord> {
    let meta = find_asset_meta("SP500_GOLD");
    let aligned = gspc
        .iter()
        .filter_map(|(date, &close)| {
            if date.as_str() < "1970-01-01" {
                return None;
            }
            let &gold_usd = gold_series.get(date)?;
            Some((date.clone(), close, gold_usd))
        })
        .collect();
    build_ratio_records(meta, aligned)
}

/// Splices Nasdaq Composite (`^IXIC`, 1971+) back-history onto Nasdaq-100 (`^NDX`, 1985+) smoothly.
pub fn splice_nasdaq_series(
    ndx: Option<&BTreeMap<String, f64>>,
    ixic: Option<&BTreeMap<String, f64>>,
) -> BTreeMap<String, f64> {
    match (ndx.filter(|m| !m.is_empty()), ixic.filter(|m| !m.is_empty())) {
        (Some(ndx_map), Some(ixic_map)) => {
            let overlap = ndx_map
                .iter()
                .find_map(|(date, &ndx_val)| {
                    let &ixic_val = ixic_map.get(date)?;
                    if ndx_val > 0.0 && ixic_val > 0.0 {
                        Some((date.clone(), ndx_val / ixic_val))
                    } else {
                        None
                    }
                });

            let mut combined = BTreeMap::new();
            if let Some((overlap_date, scale)) = overlap {
                for (date, &ixic_val) in ixic_map {
                    if date < &overlap_date && ixic_val > 0.0 {
                        combined.insert(date.clone(), ixic_val * scale);
                    }
                }
            }
            for (date, &ndx_val) in ndx_map {
                if ndx_val > 0.0 {
                    combined.insert(date.clone(), ndx_val);
                }
            }
            combined
        }
        (Some(ndx_map), None) => ndx_map.clone(),
        (None, Some(ixic_map)) => ixic_map.clone(),
        (None, None) => BTreeMap::new(),
    }
}

/// Computes `NASDAQ_GOLD`: spliced `^NDX`/`^IXIC` monthly level divided by `gold_usd`.
pub fn build_nasdaq_in_gold(
    ndx: Option<&BTreeMap<String, f64>>,
    ixic: Option<&BTreeMap<String, f64>>,
    gold_series: &BTreeMap<String, f64>,
) -> Vec<SecularGoldRecord> {
    let meta = find_asset_meta("NASDAQ_GOLD");
    let nasdaq = splice_nasdaq_series(ndx, ixic);
    let aligned = nasdaq
        .iter()
        .filter_map(|(date, &close)| {
            if date.as_str() < "1970-01-01" {
                return None;
            }
            let &gold_usd = gold_series.get(date)?;
            Some((date.clone(), close, gold_usd))
        })
        .collect();
    build_ratio_records(meta, aligned)
}

/// Computes `HOUSING_GOLD`: FRED quarterly `MSPUS` median house price divided by matching month's `gold_usd`.
pub fn build_housing_in_gold(
    mspus: &BTreeMap<String, f64>,
    gold_series: &BTreeMap<String, f64>,
) -> Vec<SecularGoldRecord> {
    let meta = find_asset_meta("HOUSING_GOLD");
    let aligned = mspus
        .iter()
        .filter_map(|(date, &median_house_usd)| {
            if date.as_str() < "1970-01-01" {
                return None;
            }
            let &gold_usd = gold_series.get(date)?;
            Some((date.clone(), median_house_usd, gold_usd))
        })
        .collect();
    build_ratio_records(meta, aligned)
}

/// Summarizes a chronological series of `SecularGoldRecord` rows for a single asset.
pub fn summarize_secular_asset(rows: &[SecularGoldRecord]) -> Option<SecularGoldAssetResponse> {
    let latest = rows.last()?;
    let min_row = rows
        .iter()
        .min_by(|a, b| a.ratio_in_gold.total_cmp(&b.ratio_in_gold))?;
    let max_row = rows
        .iter()
        .max_by(|a, b| a.ratio_in_gold.total_cmp(&b.ratio_in_gold))?;

    let mean_ratio = rows.iter().map(|r| r.ratio_in_gold).sum::<f64>() / (rows.len() as f64);
    let valuation_zone = classify_secular_valuation_zone(latest.secular_percentile).to_string();

    let series = rows
        .iter()
        .map(|row| SecularGoldPoint {
            date: row.date.clone(),
            ratio_in_gold: row.ratio_in_gold,
            asset_value_usd: row.asset_value_usd,
            gold_price_usd: row.gold_price_usd,
        })
        .collect();

    Some(SecularGoldAssetResponse {
        asset_key: latest.asset_key.clone(),
        asset_name: latest.asset_name.clone(),
        unit_label: latest.unit_label.clone(),
        latest_ratio: latest.ratio_in_gold,
        latest_date: latest.date.clone(),
        secular_percentile: latest.secular_percentile,
        min_ratio: SecularExtreme {
            ratio: min_row.ratio_in_gold,
            date: min_row.date.clone(),
        },
        max_ratio: SecularExtreme {
            ratio: max_row.ratio_in_gold,
            date: max_row.date.clone(),
        },
        mean_ratio,
        valuation_zone,
        series,
    })
}

/// Upserts secular Gold ratio records into `gold_secular_ratios`.
pub async fn upsert_secular_gold_records(
    pool: &SqlitePool,
    records: &[SecularGoldRecord],
) -> Result<(), IngestError> {
    let mut tx = pool.begin().await?;
    for record in records {
        sqlx::query(
            "INSERT INTO gold_secular_ratios (
                asset_key,
                asset_name,
                unit_label,
                date,
                asset_value_usd,
                gold_price_usd,
                ratio_in_gold,
                secular_percentile
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(asset_key, date) DO UPDATE SET
                asset_name = excluded.asset_name,
                unit_label = excluded.unit_label,
                asset_value_usd = excluded.asset_value_usd,
                gold_price_usd = excluded.gold_price_usd,
                ratio_in_gold = excluded.ratio_in_gold,
                secular_percentile = excluded.secular_percentile",
        )
        .bind(&record.asset_key)
        .bind(&record.asset_name)
        .bind(&record.unit_label)
        .bind(&record.date)
        .bind(record.asset_value_usd)
        .bind(record.gold_price_usd)
        .bind(record.ratio_in_gold)
        .bind(record.secular_percentile)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Loads all persisted `gold_secular_ratios` rows and computes deterministic summary metrics per asset.
pub async fn load_secular_gold_assets(
    pool: &SqlitePool,
) -> Result<Vec<SecularGoldAssetResponse>, sqlx::Error> {
    let rows: Vec<SecularGoldRecord> = sqlx::query_as(
        "SELECT asset_key, asset_name, unit_label, date, asset_value_usd, gold_price_usd, ratio_in_gold, secular_percentile
         FROM gold_secular_ratios
         ORDER BY asset_key ASC, date ASC",
    )
    .fetch_all(pool)
    .await?;

    let mut grouped: HashMap<String, Vec<SecularGoldRecord>> = HashMap::new();
    for row in rows {
        grouped.entry(row.asset_key.clone()).or_default().push(row);
    }

    let mut results = Vec::new();
    for meta in SECULAR_ASSETS {
        if let Some(asset_rows) = grouped.remove(meta.asset_key) {
            if let Some(summary) = summarize_secular_asset(&asset_rows) {
                results.push(summary);
            }
        }
    }

    let mut remaining_keys: Vec<String> = grouped.keys().cloned().collect();
    remaining_keys.sort();
    for key in remaining_keys {
        if let Some(asset_rows) = grouped.remove(&key) {
            if let Some(summary) = summarize_secular_asset(&asset_rows) {
                results.push(summary);
            }
        }
    }

    Ok(results)
}

fn encode_yahoo_symbol(symbol: &str) -> String {
    symbol.replace('^', "%5E").replace('=', "%3D")
}

async fn fetch_yahoo_secular_closes(
    client: &reqwest::Client,
    symbol: &str,
    period1: i64,
) -> Result<BTreeMap<String, f64>, IngestError> {
    let now_ts = Utc::now().timestamp();
    let encoded = encode_yahoo_symbol(symbol);
    let url =
        format!("{YAHOO_CHART_BASE_URL}/{encoded}?period1={period1}&period2={now_ts}&interval=1mo");
    let response = client.get(&url).send().await?.error_for_status()?;
    let body = response.text().await?;
    let parsed: YahooChartResponse = serde_json::from_str(&body)?;
    Ok(parse_yahoo_monthly_closes(&parsed))
}

async fn fetch_stooq_xauusd(client: &reqwest::Client) -> Result<BTreeMap<String, f64>, IngestError> {
    let response = client
        .get(STOOQ_XAUUSD_MONTHLY_URL)
        .send()
        .await?
        .error_for_status()?;
    let body = response.text().await?;
    Ok(parse_stooq_monthly_csv(&body))
}

async fn fetch_fred_secular_series(
    client: &reqwest::Client,
    series_id: &str,
    api_key: &str,
    observation_start: &str,
    frequency: Option<&str>,
) -> Result<BTreeMap<String, f64>, IngestError> {
    let mut url = format!(
        "{FRED_BASE_URL}?series_id={series_id}&api_key={api_key}&file_type=json&observation_start={observation_start}"
    );
    if let Some(freq) = frequency {
        url.push_str(&format!("&frequency={freq}"));
    }
    let response = client.get(&url).send().await?.error_for_status()?;
    let body = response.text().await?;
    let parsed: FredResponse = serde_json::from_str(&body)?;
    Ok(parse_observations(&parsed))
}

async fn fetch_gold_monthly_series(client: &reqwest::Client) -> BTreeMap<String, f64> {
    let stooq = match fetch_stooq_xauusd(client).await {
        Ok(map) if !map.is_empty() => Some(map),
        Ok(_) => {
            eprintln!("Warning: Stooq xauusd returned empty data; splicing embedded baseline with Yahoo GC=F.");
            None
        }
        Err(err) => {
            eprintln!("Warning: Stooq xauusd fetch failed ({err}); splicing embedded baseline with Yahoo GC=F.");
            None
        }
    };

    let yahoo_gc = match fetch_yahoo_secular_closes(client, "GC=F", YAHOO_GCF_PERIOD1_2004).await {
        Ok(map) if !map.is_empty() => Some(map),
        Ok(_) => {
            eprintln!("Warning: Yahoo GC=F returned no observations.");
            None
        }
        Err(err) => {
            eprintln!("Warning: Yahoo GC=F fetch failed ({err}).");
            None
        }
    };

    splice_gold_series(stooq.as_ref(), yahoo_gc.as_ref())
}

fn configured_fred_api_key() -> Option<String> {
    let key = std::env::var("FRED_API_KEY").ok()?;
    let trimmed = key.trim();
    if trimmed.is_empty() || trimmed == "your_key_here" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Fault-tolerantly builds the 1970–present Gold series and ingests all 6 secular Assets vs. Gold.
pub async fn ingest_secular_gold(
    pool: &SqlitePool,
    client: &reqwest::Client,
) -> Result<(), IngestError> {
    let gold_series = fetch_gold_monthly_series(client).await;
    if gold_series.is_empty() {
        return Err(IngestError::InvalidData(
            "failed to build 1970-present Gold USD baseline".to_string(),
        ));
    }

    // 1. USD_GOLD (always available from Gold USD baseline)
    let usd_records = build_usd_in_gold(&gold_series);
    if !usd_records.is_empty() {
        upsert_secular_gold_records(pool, &usd_records).await?;
    }

    // 2. SP500_GOLD (^GSPC)
    match fetch_yahoo_secular_closes(client, "^GSPC", 0).await {
        Ok(gspc) => {
            let records = build_sp500_in_gold(&gspc, &gold_series);
            if records.is_empty() {
                eprintln!("Warning: SP500_GOLD produced no overlapping records.");
            } else if let Err(err) = upsert_secular_gold_records(pool, &records).await {
                eprintln!("Warning: failed saving SP500_GOLD ({err}).");
            }
        }
        Err(err) => eprintln!("Warning: Yahoo ^GSPC fetch failed ({err})."),
    }

    // 3. NASDAQ_GOLD (^NDX back to 1985 + ^IXIC back to 1971)
    let ndx = fetch_yahoo_secular_closes(client, "^NDX", 0).await.ok();
    let ixic = fetch_yahoo_secular_closes(client, "^IXIC", 0).await.ok();
    if ndx.is_some() || ixic.is_some() {
        let records = build_nasdaq_in_gold(ndx.as_ref(), ixic.as_ref(), &gold_series);
        if records.is_empty() {
            eprintln!("Warning: NASDAQ_GOLD produced no overlapping records.");
        } else if let Err(err) = upsert_secular_gold_records(pool, &records).await {
            eprintln!("Warning: failed saving NASDAQ_GOLD ({err}).");
        }
    } else {
        eprintln!("Warning: Yahoo ^NDX and ^IXIC fetches both failed.");
    }

    // 4-6. FRED series (GBP_GOLD, CASH_FUND_GOLD, HOUSING_GOLD)
    let Some(fred_key) = configured_fred_api_key() else {
        eprintln!("Warning: FRED_API_KEY missing or placeholder; skipping GBP_GOLD, CASH_FUND_GOLD, and HOUSING_GOLD.");
        return Ok(());
    };

    match fetch_fred_secular_series(client, "DEXUSUK", &fred_key, "1971-01-01", Some("m")).await {
        Ok(dexusuk) => {
            let records = build_gbp_in_gold(&dexusuk, &gold_series);
            if records.is_empty() {
                eprintln!("Warning: GBP_GOLD produced no overlapping records.");
            } else if let Err(err) = upsert_secular_gold_records(pool, &records).await {
                eprintln!("Warning: failed saving GBP_GOLD ({err}).");
            }
        }
        Err(err) => eprintln!("Warning: FRED DEXUSUK fetch failed ({err})."),
    }

    match fetch_fred_secular_series(client, "FEDFUNDS", &fred_key, "1970-01-01", Some("m")).await {
        Ok(fedfunds) => {
            let records = build_cash_fund_in_gold(&fedfunds, &gold_series);
            if records.is_empty() {
                eprintln!("Warning: CASH_FUND_GOLD produced no overlapping records.");
            } else if let Err(err) = upsert_secular_gold_records(pool, &records).await {
                eprintln!("Warning: failed saving CASH_FUND_GOLD ({err}).");
            }
        }
        Err(err) => eprintln!("Warning: FRED FEDFUNDS secular fetch failed ({err})."),
    }

    match fetch_fred_secular_series(client, "MSPUS", &fred_key, "1970-01-01", None).await {
        Ok(mspus) => {
            let records = build_housing_in_gold(&mspus, &gold_series);
            if records.is_empty() {
                eprintln!("Warning: HOUSING_GOLD produced no overlapping records.");
            } else if let Err(err) = upsert_secular_gold_records(pool, &records).await {
                eprintln!("Warning: failed saving HOUSING_GOLD ({err}).");
            }
        }
        Err(err) => eprintln!("Warning: FRED MSPUS fetch failed ({err})."),
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    #[test]
    fn test_stooq_csv_parsing_and_gold_splicing() {
        let csv = "\
Date,Open,High,Low,Close,Volume
1969-12-31,35.0,35.2,34.9,35.1,0
1970-01-31,35.1,35.3,35.0,35.20,0
1980-01-31,559.0,850.0,550.0,653.00,0
bad-row,1,2,3,4
2004-01-31,400.0,415.0,395.0,402.50,0
";
        let stooq = parse_stooq_monthly_csv(csv);
        assert_eq!(stooq.len(), 3);
        assert!(!stooq.contains_key("1969-12-01"));
        assert!((stooq["1970-01-01"] - 35.20).abs() < 1e-9);
        assert!((stooq["1980-01-01"] - 653.00).abs() < 1e-9);

        // Fallback splice: Stooq empty/rate-limited -> embedded 1970-2004 baseline + Yahoo GC=F 2004+
        let mut yahoo_gc = BTreeMap::new();
        yahoo_gc.insert("2004-01-01".to_string(), 405.0);
        yahoo_gc.insert("2025-01-01".to_string(), 2750.0);

        let fallback_spliced = splice_gold_series(None, Some(&yahoo_gc));
        assert!(fallback_spliced.contains_key("1970-01-01"));
        assert!((fallback_spliced["1970-01-01"] - 35.17).abs() < 1e-9);
        assert!(fallback_spliced.contains_key("2003-12-01"));
        // Yahoo GC=F overrides 2004+ when Stooq has no modern observations
        assert!((fallback_spliced["2004-01-01"] - 405.0).abs() < 1e-9);
        assert!((fallback_spliced["2025-01-01"] - 2750.0).abs() < 1e-9);

        // Live Stooq modern + Yahoo tail fill
        let mut live_stooq = BTreeMap::new();
        live_stooq.insert("1970-01-01".to_string(), 35.20);
        live_stooq.insert("2024-12-01".to_string(), 2620.0);
        let live_spliced = splice_gold_series(Some(&live_stooq), Some(&yahoo_gc));
        assert!((live_spliced["1970-01-01"] - 35.20).abs() < 1e-9);
        assert!((live_spliced["2024-12-01"] - 2620.0).abs() < 1e-9);
        assert!((live_spliced["2025-01-01"] - 2750.0).abs() < 1e-9);
    }

    #[test]
    fn test_compounding_fedfunds_cash_fund_in_gold() {
        let mut gold = BTreeMap::new();
        gold.insert("1970-01-01".to_string(), 35.0);
        gold.insert("1970-02-01".to_string(), 35.0);
        gold.insert("1970-03-01".to_string(), 40.0);

        let mut fed_funds = BTreeMap::new();
        fed_funds.insert("1969-12-01".to_string(), 9.0); // ignored (< 1970-01-01)
        fed_funds.insert("1970-01-01".to_string(), 12.0); // 1% monthly step
        fed_funds.insert("1970-02-01".to_string(), 6.0); // 0.5% monthly step
        fed_funds.insert("1970-03-01".to_string(), 6.0);

        let cash_records = build_cash_fund_in_gold(&fed_funds, &gold);
        assert_eq!(cash_records.len(), 3);

        // Jan 1970: $1000 / $35
        assert!((cash_records[0].asset_value_usd - 1000.0).abs() < 1e-9);
        assert!((cash_records[0].ratio_in_gold - (1000.0 / 35.0)).abs() < 1e-9);

        // Feb 1970: $1000 * (1 + 0.12/12) = $1010.0
        let expected_feb = 1000.0 * (1.0 + 0.12 / 12.0);
        assert!((cash_records[1].asset_value_usd - expected_feb).abs() < 1e-9);
        assert!((cash_records[1].ratio_in_gold - (expected_feb / 35.0)).abs() < 1e-9);

        // Mar 1970: $1010 * (1 + 0.06/12) = $1015.05, divided by $40
        let expected_mar = expected_feb * (1.0 + 0.06 / 12.0);
        assert!((cash_records[2].asset_value_usd - expected_mar).abs() < 1e-9);
        assert!((cash_records[2].ratio_in_gold - (expected_mar / 40.0)).abs() < 1e-9);
    }

    #[test]
    fn test_usd_gbp_equities_and_housing_in_gold_math() {
        let mut gold = BTreeMap::new();
        gold.insert("1971-01-01".to_string(), 38.0);
        gold.insert("1985-10-01".to_string(), 325.0);
        gold.insert("2024-01-01".to_string(), 2000.0);

        // USD_GOLD
        let usd = build_usd_in_gold(&gold);
        assert_eq!(usd.len(), 3);
        assert!((usd[0].ratio_in_gold - (1000.0 / 38.0)).abs() < 1e-9);
        assert!((usd[2].ratio_in_gold - 0.5).abs() < 1e-9);

        // GBP_GOLD: £1,000 * 1.25 / $2,000 = 0.625 oz Gold per £1,000
        let mut dexusuk = BTreeMap::new();
        dexusuk.insert("1970-01-01".to_string(), 2.40); // skipped (< 1971-01-01)
        dexusuk.insert("1971-01-01".to_string(), 2.40);
        dexusuk.insert("2024-01-01".to_string(), 1.25);
        let gbp = build_gbp_in_gold(&dexusuk, &gold);
        assert_eq!(gbp.len(), 2);
        assert!((gbp[0].asset_value_usd - 2400.0).abs() < 1e-9);
        assert!((gbp[1].ratio_in_gold - 0.625).abs() < 1e-9);

        // SP500_GOLD
        let mut gspc = BTreeMap::new();
        gspc.insert("1971-01-01".to_string(), 95.0);
        gspc.insert("2024-01-01".to_string(), 5000.0);
        let sp500 = build_sp500_in_gold(&gspc, &gold);
        assert_eq!(sp500.len(), 2);
        assert!((sp500[0].ratio_in_gold - 2.5).abs() < 1e-9);
        assert!((sp500[1].ratio_in_gold - 2.5).abs() < 1e-9);

        // NASDAQ_GOLD: ^IXIC scaled smoothly at 1985-10-01 overlap with ^NDX
        let mut ixic = BTreeMap::new();
        ixic.insert("1971-01-01".to_string(), 100.0);
        ixic.insert("1985-10-01".to_string(), 300.0);
        let mut ndx = BTreeMap::new();
        ndx.insert("1985-10-01".to_string(), 150.0); // scale = 150 / 300 = 0.5
        ndx.insert("2024-01-01".to_string(), 18000.0);
        let nasdaq = build_nasdaq_in_gold(Some(&ndx), Some(&ixic), &gold);
        assert_eq!(nasdaq.len(), 3);
        assert!((nasdaq[0].asset_value_usd - 50.0).abs() < 1e-9); // 100 * 0.5
        assert!((nasdaq[1].asset_value_usd - 150.0).abs() < 1e-9);
        assert!((nasdaq[2].ratio_in_gold - 9.0).abs() < 1e-9);

        // HOUSING_GOLD: FRED MSPUS median house USD / gold USD
        let mut mspus = BTreeMap::new();
        mspus.insert("1971-01-01".to_string(), 24_700.0); // 24700 / 38 = 650 oz
        mspus.insert("2024-01-01".to_string(), 420_000.0); // 420000 / 2000 = 210 oz
        let housing = build_housing_in_gold(&mspus, &gold);
        assert_eq!(housing.len(), 2);
        assert!((housing[0].ratio_in_gold - 650.0).abs() < 1e-9);
        assert!((housing[1].ratio_in_gold - 210.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn test_secular_55_year_percentile_and_stats_sqlite() {
        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");

        // Build a synthetic 55-year (660-month) Gold series starting at $35 and peaking at $2,000,
        // so USD_GOLD latest ratio is the minimum (0th percentile -> Cheap) and 1970-01 is max (100th).
        let mut gold = BTreeMap::new();
        for i in 0..660_usize {
            let year = 1970 + (i / 12);
            let month = (i % 12) + 1;
            let date = format!("{year:04}-{month:02}-01");
            let price = 35.0 + (i as f64) * 3.0;
            gold.insert(date, price);
        }

        let usd_records = build_usd_in_gold(&gold);
        assert_eq!(usd_records.len(), 660);
        assert!((usd_records[0].secular_percentile - 100.0).abs() < 1e-9);
        assert!((usd_records[659].secular_percentile - 0.0).abs() < 1e-9);

        upsert_secular_gold_records(&pool, &usd_records)
            .await
            .expect("upsert_secular_gold_records failed");

        let loaded = load_secular_gold_assets(&pool)
            .await
            .expect("load_secular_gold_assets failed");
        assert_eq!(loaded.len(), 1);
        let usd = &loaded[0];
        assert_eq!(usd.asset_key, "USD_GOLD");
        assert_eq!(usd.unit_label, "oz Gold per $1,000");
        assert_eq!(usd.series.len(), 660);
        assert_eq!(usd.valuation_zone, "Cheap");
        assert!((usd.secular_percentile - 0.0).abs() < 1e-9);
        assert_eq!(usd.max_ratio.date, "1970-01-01");
        assert!((usd.max_ratio.ratio - (1000.0 / 35.0)).abs() < 1e-9);
        assert_eq!(usd.min_ratio.date, "2024-12-01");
        assert!((usd.min_ratio.ratio - usd.latest_ratio).abs() < 1e-9);
        assert!(usd.mean_ratio > usd.min_ratio.ratio && usd.mean_ratio < usd.max_ratio.ratio);
    }
}
