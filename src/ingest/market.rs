use std::collections::BTreeMap;

use chrono::DateTime;
use serde::Deserialize;
use sqlx::SqlitePool;

use super::IngestError;

/// Target sector ETFs mapped as `(ticker, sector_name)`.
pub const SECTOR_ETFS: &[(&str, &str)] = &[
    ("ITA", "Defense"),
    ("XLE", "Energy"),
    ("XLV", "Healthcare"),
    ("IYT", "Transportation"),
    ("XLK", "Technology"),
    ("PAVE", "Infrastructure"),
];

const YAHOO_CHART_BASE_URL: &str = "https://query1.finance.yahoo.com/v8/finance/chart";
const MAX_MONTHLY_OBSERVATIONS: usize = 120;

/// Top-level JSON response from Yahoo Finance v8 chart API.
#[derive(Debug, Deserialize)]
pub struct YahooChartResponse {
    /// Chart envelope.
    pub chart: YahooChart,
}

/// Inner chart container holding optional results.
#[derive(Debug, Deserialize)]
pub struct YahooChart {
    /// Array of chart series results.
    pub result: Option<Vec<YahooChartResult>>,
}

/// Single ticker result containing timestamps and OHLC quote arrays.
#[derive(Debug, Deserialize)]
pub struct YahooChartResult {
    /// Unix epoch timestamps (seconds).
    pub timestamp: Option<Vec<i64>>,
    /// Quote indicator collections.
    pub indicators: YahooIndicators,
}

/// Indicator groups returned by Yahoo Finance.
#[derive(Debug, Deserialize)]
pub struct YahooIndicators {
    /// OHLCV quote series.
    pub quote: Vec<YahooQuote>,
}

/// Quote vectors for a chart series.
#[derive(Debug, Deserialize)]
pub struct YahooQuote {
    /// Closing prices corresponding element-by-element to `timestamp`.
    pub close: Option<Vec<Option<f64>>>,
}

/// Normalized sector valuation row ready for SQLite persistence.
#[derive(Debug, Clone, PartialEq)]
pub struct SectorValuationRecord {
    /// ETF ticker symbol (e.g. `"ITA"`).
    pub ticker: String,
    /// Sector label (e.g. `"Defense"`).
    pub sector_name: String,
    /// Normalized monthly date (`YYYY-MM-01`).
    pub date: String,
    /// Monthly close price of the sector ETF.
    pub close_price: f64,
    /// Relative price ratio against `GLD` (`close_price / gld_close`).
    pub gold_ratio: f64,
    /// Relative price ratio against `SPY` (`close_price / spy_close`).
    pub spy_ratio: f64,
    /// Average 10-year historical percentile rank (0.0–100.0) across gold and SPY ratios.
    pub valuation_percentile: f64,
}

/// Parses Yahoo Finance v8 monthly closes into a sorted map keyed by `"YYYY-MM-01"`.
pub fn parse_yahoo_monthly_closes(resp: &YahooChartResponse) -> BTreeMap<String, f64> {
    let mut closes = BTreeMap::new();
    let Some(results) = resp.chart.result.as_ref() else {
        return closes;
    };
    let Some(first) = results.first() else {
        return closes;
    };
    let Some(timestamps) = first.timestamp.as_ref() else {
        return closes;
    };
    let Some(quote_closes) = first
        .indicators
        .quote
        .first()
        .and_then(|q| q.close.as_ref())
    else {
        return closes;
    };

    for (&ts, &maybe_close) in timestamps.iter().zip(quote_closes.iter()) {
        if let Some(close) = maybe_close {
            if close.is_finite() && close > 0.0 {
                if let Some(dt) = DateTime::from_timestamp(ts, 0) {
                    let month_key = dt.format("%Y-%m-01").to_string();
                    closes.insert(month_key, close);
                }
            }
        }
    }

    closes
}

/// Computes deterministic percentile ranks in `[0.0, 100.0]` for each element in `values`.
pub fn percentile_ranks(values: &[f64]) -> Vec<f64> {
    if values.is_empty() {
        return Vec::new();
    }
    if values.len() == 1 {
        return vec![50.0];
    }

    let denom = (values.len() - 1) as f64;
    values
        .iter()
        .map(|&v| {
            let less = values.iter().filter(|&&x| x < v).count();
            let equal_other = values
                .iter()
                .filter(|&&x| (x - v).abs() <= f64::EPSILON)
                .count()
                .saturating_sub(1);
            (((less as f64) + 0.5 * (equal_other as f64)) / denom * 100.0).clamp(0.0, 100.0)
        })
        .collect()
}

/// Aligns a sector ETF against `GLD` and `SPY`, computes ratios & 10-year valuation percentiles.
pub fn build_sector_valuations(
    ticker: &str,
    sector_name: &str,
    sector_closes: &BTreeMap<String, f64>,
    gld_closes: &BTreeMap<String, f64>,
    spy_closes: &BTreeMap<String, f64>,
) -> Vec<SectorValuationRecord> {
    let mut aligned: Vec<(&String, f64, f64, f64)> = sector_closes
        .iter()
        .filter_map(|(date, &close_price)| {
            let &gld_close = gld_closes.get(date)?;
            let &spy_close = spy_closes.get(date)?;
            if gld_close > 0.0 && spy_close > 0.0 {
                Some((date, close_price, close_price / gld_close, close_price / spy_close))
            } else {
                None
            }
        })
        .collect();

    if aligned.len() > MAX_MONTHLY_OBSERVATIONS {
        let excess = aligned.len() - MAX_MONTHLY_OBSERVATIONS;
        aligned.drain(..excess);
    }

    let gold_ratios: Vec<f64> = aligned.iter().map(|entry| entry.2).collect();
    let spy_ratios: Vec<f64> = aligned.iter().map(|entry| entry.3).collect();
    let gold_pcts = percentile_ranks(&gold_ratios);
    let spy_pcts = percentile_ranks(&spy_ratios);

    aligned
        .into_iter()
        .zip(gold_pcts.into_iter().zip(spy_pcts))
        .map(
            |((date, close_price, gold_ratio, spy_ratio), (gold_pct, spy_pct))| {
                SectorValuationRecord {
                    ticker: ticker.to_string(),
                    sector_name: sector_name.to_string(),
                    date: date.clone(),
                    close_price,
                    gold_ratio,
                    spy_ratio,
                    valuation_percentile: (gold_pct + spy_pct) / 2.0,
                }
            },
        )
        .collect()
}

/// Upserts sector valuation rows into the `sector_valuations` table.
pub async fn upsert_sector_valuations(
    pool: &SqlitePool,
    records: &[SectorValuationRecord],
) -> Result<(), IngestError> {
    let mut tx = pool.begin().await?;
    for record in records {
        sqlx::query(
            "INSERT INTO sector_valuations (
                ticker,
                sector_name,
                date,
                close_price,
                gold_ratio,
                spy_ratio,
                valuation_percentile
            )
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticker, date) DO UPDATE SET
                sector_name = excluded.sector_name,
                close_price = excluded.close_price,
                gold_ratio = excluded.gold_ratio,
                spy_ratio = excluded.spy_ratio,
                valuation_percentile = excluded.valuation_percentile",
        )
        .bind(&record.ticker)
        .bind(&record.sector_name)
        .bind(&record.date)
        .bind(record.close_price)
        .bind(record.gold_ratio)
        .bind(record.spy_ratio)
        .bind(record.valuation_percentile)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn fetch_yahoo_closes(
    client: &reqwest::Client,
    ticker: &str,
) -> Result<BTreeMap<String, f64>, IngestError> {
    let url = format!("{YAHOO_CHART_BASE_URL}/{ticker}?range=10y&interval=1mo");
    let response = client.get(&url).send().await?.error_for_status()?;
    let body = response.text().await?;
    let parsed: YahooChartResponse = serde_json::from_str(&body)?;
    Ok(parse_yahoo_monthly_closes(&parsed))
}

/// Fetches 10-year monthly prices for sector ETFs, `SPY`, and `GLD`, and persists valuations.
pub async fn ingest_market(
    pool: &SqlitePool,
    client: &reqwest::Client,
) -> Result<(), IngestError> {
    let gld_closes = fetch_yahoo_closes(client, "GLD").await?;
    let spy_closes = fetch_yahoo_closes(client, "SPY").await?;

    if gld_closes.is_empty() || spy_closes.is_empty() {
        return Err(IngestError::InvalidData(
            "benchmark monthly closes missing for GLD or SPY".to_string(),
        ));
    }

    for &(ticker, sector_name) in SECTOR_ETFS {
        let sector_closes = fetch_yahoo_closes(client, ticker).await?;
        let records =
            build_sector_valuations(ticker, sector_name, &sector_closes, &gld_closes, &spy_closes);
        if records.is_empty() {
            return Err(IngestError::InvalidData(format!(
                "no overlapping market valuation data for {ticker}"
            )));
        }
        upsert_sector_valuations(pool, &records).await?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    #[test]
    fn test_yahoo_deserialization_and_null_filtering() {
        // Timestamps: 2024-01-01 14:30:00 UTC (1704119400), 2024-02-01 14:30:00 UTC (1706797800), 2024-03-01 14:30:00 UTC (1709303400)
        let payload = r#"{
            "chart": {
                "result": [
                    {
                        "timestamp": [1704119400, 1706797800, 1709303400],
                        "indicators": {
                            "quote": [
                                {
                                    "close": [100.0, null, 110.5]
                                }
                            ]
                        }
                    }
                ]
            }
        }"#;

        let parsed: YahooChartResponse =
            serde_json::from_str(payload).expect("valid yahoo chart json");
        let closes = parse_yahoo_monthly_closes(&parsed);

        assert_eq!(closes.len(), 2);
        assert!((closes["2024-01-01"] - 100.0).abs() < f64::EPSILON);
        assert!(!closes.contains_key("2024-02-01"));
        assert!((closes["2024-03-01"] - 110.5).abs() < f64::EPSILON);
    }

    #[test]
    fn test_percentile_ranks_and_sector_valuation_math() {
        let ranks = percentile_ranks(&[10.0, 20.0, 30.0, 40.0, 50.0]);
        assert!((ranks[0] - 0.0).abs() < 1e-9);
        assert!((ranks[1] - 25.0).abs() < 1e-9);
        assert!((ranks[2] - 50.0).abs() < 1e-9);
        assert!((ranks[3] - 75.0).abs() < 1e-9);
        assert!((ranks[4] - 100.0).abs() < 1e-9);

        let equal_ranks = percentile_ranks(&[5.0, 5.0, 5.0]);
        assert!(equal_ranks.iter().all(|&r| (r - 50.0).abs() < 1e-9));

        let mut sector = BTreeMap::new();
        sector.insert("2024-01-01".to_string(), 100.0);
        sector.insert("2024-02-01".to_string(), 150.0);
        sector.insert("2024-03-01".to_string(), 200.0);
        sector.insert("2024-04-01".to_string(), 300.0); // Missing in SPY -> skipped

        let mut gld = BTreeMap::new();
        gld.insert("2024-01-01".to_string(), 200.0); // ratio 0.50
        gld.insert("2024-02-01".to_string(), 200.0); // ratio 0.75
        gld.insert("2024-03-01".to_string(), 200.0); // ratio 1.00
        gld.insert("2024-04-01".to_string(), 200.0);

        let mut spy = BTreeMap::new();
        spy.insert("2024-01-01".to_string(), 500.0); // ratio 0.20
        spy.insert("2024-02-01".to_string(), 500.0); // ratio 0.30
        spy.insert("2024-03-01".to_string(), 500.0); // ratio 0.40

        let records = build_sector_valuations("ITA", "Defense", &sector, &gld, &spy);
        assert_eq!(records.len(), 3);
        assert!((records[0].gold_ratio - 0.5).abs() < 1e-9);
        assert!((records[0].spy_ratio - 0.2).abs() < 1e-9);
        assert!((records[0].valuation_percentile - 0.0).abs() < 1e-9);
        assert!((records[1].valuation_percentile - 50.0).abs() < 1e-9);
        assert!((records[2].valuation_percentile - 100.0).abs() < 1e-9);
    }

    #[tokio::test]
    async fn test_market_sqlite_upsert() {
        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");

        let rows = vec![SectorValuationRecord {
            ticker: "XLE".to_string(),
            sector_name: "Energy".to_string(),
            date: "2024-01-01".to_string(),
            close_price: 84.0,
            gold_ratio: 0.42,
            spy_ratio: 0.175,
            valuation_percentile: 22.5,
        }];
        upsert_sector_valuations(&pool, &rows)
            .await
            .expect("initial upsert failed");

        let updated = vec![SectorValuationRecord {
            ticker: "XLE".to_string(),
            sector_name: "Energy".to_string(),
            date: "2024-01-01".to_string(),
            close_price: 86.0,
            gold_ratio: 0.43,
            spy_ratio: 0.18,
            valuation_percentile: 24.0,
        }];
        upsert_sector_valuations(&pool, &updated)
            .await
            .expect("second upsert failed");

        let (close_price, pct): (f64, f64) = sqlx::query_as(
            "SELECT close_price, valuation_percentile FROM sector_valuations WHERE ticker = ? AND date = ?",
        )
        .bind("XLE")
        .bind("2024-01-01")
        .fetch_one(&pool)
        .await
        .expect("select failed");

        assert!((close_price - 86.0).abs() < f64::EPSILON);
        assert!((pct - 24.0).abs() < f64::EPSILON);
    }

    #[test]
    fn test_sector_etfs_expanded_to_six() {
        assert_eq!(SECTOR_ETFS.len(), 6);
        assert!(SECTOR_ETFS.contains(&("ITA", "Defense")));
        assert!(SECTOR_ETFS.contains(&("XLE", "Energy")));
        assert!(SECTOR_ETFS.contains(&("XLV", "Healthcare")));
        assert!(SECTOR_ETFS.contains(&("IYT", "Transportation")));
        assert!(SECTOR_ETFS.contains(&("XLK", "Technology")));
        assert!(SECTOR_ETFS.contains(&("PAVE", "Infrastructure")));
    }
}
