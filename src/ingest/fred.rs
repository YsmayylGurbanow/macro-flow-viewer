use std::collections::BTreeMap;

use serde::Deserialize;
use sqlx::SqlitePool;

use super::IngestError;

const FRED_BASE_URL: &str = "https://api.stlouisfed.org/fred/series/observations";
const MAX_MONTHLY_OBSERVATIONS: usize = 120;

/// JSON response payload from the FRED `series/observations` endpoint.
#[derive(Debug, Deserialize)]
pub struct FredResponse {
    /// Chronological list of series observations.
    pub observations: Vec<FredObservation>,
}

/// Single date/value observation returned by FRED.
#[derive(Debug, Deserialize)]
pub struct FredObservation {
    /// ISO date string (`YYYY-MM-DD`).
    pub date: String,
    /// Numeric value as a string, or `"."` for missing data.
    pub value: String,
}

/// Normalized monthly macro rate row ready for SQLite persistence.
#[derive(Debug, Clone, PartialEq)]
pub struct MacroRateRecord {
    /// Observation date (`YYYY-MM-DD`).
    pub date: String,
    /// Effective Federal Funds Rate (`FEDFUNDS`).
    pub fed_funds: f64,
    /// 10-Year Treasury Constant Maturity Rate (`DGS10`).
    pub dgs10: f64,
    /// Yield curve spread (`dgs10 - fed_funds`).
    pub yield_spread: f64,
    /// Deterministic monetary regime label.
    pub regime_label: String,
}

/// Parses FRED observations into a sorted date map, safely skipping `"."` and invalid values.
pub fn parse_observations(resp: &FredResponse) -> BTreeMap<String, f64> {
    let mut map = BTreeMap::new();
    for obs in &resp.observations {
        let trimmed = obs.value.trim();
        if trimmed == "." {
            continue;
        }
        if let Ok(val) = trimmed.parse::<f64>() {
            if val.is_finite() {
                map.insert(obs.date.clone(), val);
            }
        }
    }
    map
}

/// Deterministically classifies the Federal Reserve rate regime from the 6-month change and rate level.
pub fn classify_rate_regime(current_fed_funds: f64, six_month_ago_fed_funds: f64) -> &'static str {
    let delta_6m = current_fed_funds - six_month_ago_fed_funds;
    if delta_6m >= 0.25 {
        "Hiking"
    } else if delta_6m <= -0.25 {
        "Cutting"
    } else if current_fed_funds >= 2.5 {
        "High-Pause"
    } else {
        "Low-Pause"
    }
}

/// Aligns `FEDFUNDS` and `DGS10` observations, computes spread & regime labels, and keeps the last 10 years.
pub fn build_macro_rate_records(
    fed_funds_map: &BTreeMap<String, f64>,
    dgs10_map: &BTreeMap<String, f64>,
) -> Vec<MacroRateRecord> {
    let aligned: Vec<(&String, f64, f64)> = fed_funds_map
        .iter()
        .filter_map(|(date, &ff)| dgs10_map.get(date).map(|&dgs10| (date, ff, dgs10)))
        .collect();

    let mut records: Vec<MacroRateRecord> = aligned
        .iter()
        .enumerate()
        .map(|(i, &(date, fed_funds, dgs10))| {
            let six_month_ago_ff = aligned[i.saturating_sub(6)].1;
            let yield_spread = dgs10 - fed_funds;
            let regime_label = classify_rate_regime(fed_funds, six_month_ago_ff).to_string();
            MacroRateRecord {
                date: date.clone(),
                fed_funds,
                dgs10,
                yield_spread,
                regime_label,
            }
        })
        .collect();

    if records.len() > MAX_MONTHLY_OBSERVATIONS {
        let excess = records.len() - MAX_MONTHLY_OBSERVATIONS;
        records.drain(..excess);
    }

    records
}

/// Upserts monthly macro rate rows into the `macro_rates` table.
pub async fn upsert_macro_rates(
    pool: &SqlitePool,
    records: &[MacroRateRecord],
) -> Result<(), IngestError> {
    let mut tx = pool.begin().await?;
    for record in records {
        sqlx::query(
            "INSERT INTO macro_rates (date, fed_funds, dgs10, yield_spread, regime_label)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(date) DO UPDATE SET
                fed_funds = excluded.fed_funds,
                dgs10 = excluded.dgs10,
                yield_spread = excluded.yield_spread,
                regime_label = excluded.regime_label",
        )
        .bind(&record.date)
        .bind(record.fed_funds)
        .bind(record.dgs10)
        .bind(record.yield_spread)
        .bind(&record.regime_label)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn fetch_fred_series(
    client: &reqwest::Client,
    series_id: &str,
    api_key: &str,
) -> Result<BTreeMap<String, f64>, IngestError> {
    let url =
        format!("{FRED_BASE_URL}?series_id={series_id}&api_key={api_key}&file_type=json&frequency=m");
    let response = client.get(&url).send().await?.error_for_status()?;
    let body = response.text().await?;
    let parsed: FredResponse = serde_json::from_str(&body)?;
    Ok(parse_observations(&parsed))
}

/// Fetches `FEDFUNDS` and `DGS10` from FRED and persists aligned rate regimes into SQLite.
pub async fn ingest_fred(pool: &SqlitePool, client: &reqwest::Client) -> Result<(), IngestError> {
    let api_key = std::env::var("FRED_API_KEY")
        .map_err(|_| IngestError::MissingEnvVar("FRED_API_KEY".to_string()))?;
    if api_key.trim().is_empty() {
        return Err(IngestError::MissingEnvVar("FRED_API_KEY".to_string()));
    }

    let fed_funds_map = fetch_fred_series(client, "FEDFUNDS", &api_key).await?;
    let dgs10_map = fetch_fred_series(client, "DGS10", &api_key).await?;
    let records = build_macro_rate_records(&fed_funds_map, &dgs10_map);

    if records.is_empty() {
        return Err(IngestError::InvalidData(
            "no overlapping FEDFUNDS and DGS10 observations returned by FRED".to_string(),
        ));
    }

    upsert_macro_rates(pool, &records).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    #[test]
    fn test_fred_deserialization_and_dot_filtering() {
        let payload = r#"{
            "observations": [
                {"date": "2024-01-01", "value": "5.33"},
                {"date": "2024-02-01", "value": "."},
                {"date": "2024-03-01", "value": "5.33"},
                {"date": "2024-04-01", "value": " . "}
            ]
        }"#;

        let parsed: FredResponse = serde_json::from_str(payload).expect("valid fred json");
        let obs = parse_observations(&parsed);

        assert_eq!(obs.len(), 2);
        assert!(!obs.contains_key("2024-02-01"));
        assert!(!obs.contains_key("2024-04-01"));
        assert!((obs["2024-01-01"] - 5.33).abs() < f64::EPSILON);
    }

    #[test]
    fn test_classify_rate_regimes_and_yield_spread() {
        assert_eq!(classify_rate_regime(3.0, 2.5), "Hiking");
        assert_eq!(classify_rate_regime(4.5, 5.0), "Cutting");
        assert_eq!(classify_rate_regime(5.25, 5.25), "High-Pause");
        assert_eq!(classify_rate_regime(0.25, 0.25), "Low-Pause");

        // Build 10 months covering Low-Pause -> Hiking -> High-Pause -> Cutting.
        let ff_points = [
            ("2022-01-01", 0.25),
            ("2022-02-01", 0.25),
            ("2022-03-01", 0.30),
            ("2022-04-01", 0.35),
            ("2022-05-01", 0.40),
            ("2022-06-01", 0.45),
            ("2022-07-01", 1.50), // delta_6m vs Jan = +1.25 -> Hiking
            ("2023-07-01", 5.25),
            ("2023-08-01", 5.25),
            ("2023-09-01", 5.25),
            ("2023-10-01", 5.25),
            ("2023-11-01", 5.25),
            ("2023-12-01", 5.25),
            ("2024-01-01", 5.25), // delta_6m = 0.0, level >= 2.5 -> High-Pause
            ("2024-02-01", 4.75), // delta_6m = -0.50 -> Cutting
        ];
        let mut ff_map = BTreeMap::new();
        let mut dgs10_map = BTreeMap::new();
        for (date, ff) in ff_points {
            ff_map.insert(date.to_string(), ff);
            dgs10_map.insert(date.to_string(), 4.00);
        }

        let records = build_macro_rate_records(&ff_map, &dgs10_map);
        assert_eq!(records[0].regime_label, "Low-Pause");
        assert!((records[0].yield_spread - 3.75).abs() < 1e-9);
        assert_eq!(records[6].regime_label, "Hiking");
        assert_eq!(records[13].regime_label, "High-Pause");
        assert!((records[13].yield_spread - (-1.25)).abs() < 1e-9);
        assert_eq!(records[14].regime_label, "Cutting");
    }

    #[tokio::test]
    async fn test_fred_sqlite_upsert() {
        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");

        let rows = vec![MacroRateRecord {
            date: "2024-01-01".to_string(),
            fed_funds: 5.33,
            dgs10: 4.06,
            yield_spread: -1.27,
            regime_label: "High-Pause".to_string(),
        }];
        upsert_macro_rates(&pool, &rows)
            .await
            .expect("upsert failed");

        let updated = vec![MacroRateRecord {
            date: "2024-01-01".to_string(),
            fed_funds: 5.33,
            dgs10: 4.10,
            yield_spread: -1.23,
            regime_label: "High-Pause".to_string(),
        }];
        upsert_macro_rates(&pool, &updated)
            .await
            .expect("second upsert failed");

        let (spread, label): (f64, String) =
            sqlx::query_as("SELECT yield_spread, regime_label FROM macro_rates WHERE date = ?")
                .bind("2024-01-01")
                .fetch_one(&pool)
                .await
                .expect("select failed");

        assert!((spread - (-1.23)).abs() < 1e-9);
        assert_eq!(label, "High-Pause");
    }
}
