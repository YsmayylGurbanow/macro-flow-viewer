use std::collections::BTreeMap;

use serde::Deserialize;
use sqlx::SqlitePool;

use super::IngestError;

/// Target federal agencies mapped as `(agency_code, sector_name)`.
pub const AGENCIES: &[(&str, &str)] = &[
    ("097", "Defense"),
    ("089", "Energy"),
    ("075", "HHS"),
    ("069", "Transportation"),
    ("013", "Commerce"),
];

const USASPENDING_BASE_URL: &str = "https://api.usaspending.gov/api/v2/agency";

/// Top-level JSON response from USAspending `/agency/{code}/budgetary_resources/`.
#[derive(Debug, Deserialize)]
pub struct UsaSpendingResponse {
    /// Annual agency budgetary resources and obligations records.
    pub agency_data_by_year: Vec<RawAgencyYear>,
}

/// Single fiscal year entry inside `agency_data_by_year`.
#[derive(Debug, Deserialize)]
pub struct RawAgencyYear {
    /// Federal fiscal year (e.g. `2024`).
    pub fiscal_year: i64,
    /// Total budgetary resources in USD.
    #[serde(alias = "budgetary_resources")]
    pub agency_budgetary_resources: Option<f64>,
    /// Total obligations in USD.
    #[serde(default, alias = "obligations", alias = "total_obligated")]
    pub agency_total_obligated: Option<f64>,
}

/// Normalized fiscal spending row ready for SQLite persistence.
#[derive(Debug, Clone, PartialEq)]
pub struct FiscalSpendingRecord {
    /// Agency code (e.g. `"097"`).
    pub agency_code: String,
    /// Sector/agency display name (e.g. `"Defense"`).
    pub agency_name: String,
    /// Federal fiscal year.
    pub fiscal_year: i64,
    /// Budgetary resources in USD.
    pub budgetary_resources: f64,
    /// Obligations in USD.
    pub obligations: f64,
    /// Year-over-year percentage change in budgetary resources.
    pub yoy_growth_pct: Option<f64>,
    /// Trailing 5-year Z-score of YoY spending growth.
    pub fiscal_impulse_zscore: Option<f64>,
    /// Deterministic impulse label (`Accelerating`, `Neutral`, or `Contracting`).
    pub fiscal_impulse_label: String,
}

/// Classifies a fiscal impulse Z-score into `Accelerating` (`> 0.5`), `Contracting` (`< -0.5`), or `Neutral`.
pub fn classify_fiscal_impulse_zscore(zscore: Option<f64>) -> &'static str {
    match zscore {
        Some(z) if z > 0.5 => "Accelerating",
        Some(z) if z < -0.5 => "Contracting",
        _ => "Neutral",
    }
}

/// Computes trailing 5-year Z-scores for a chronological series of YoY growth percentages.
///
/// For each index `i`, considers up to the last 5 finite YoY values in `yoy_series[..=i]`.
/// When fewer than 2 finite values exist in the trailing window, returns `None`.
/// When standard deviation is effectively zero, returns `Some(0.0)` so steady inflation stays `Neutral`.
pub fn compute_trailing_5y_zscores(yoy_series: &[Option<f64>]) -> Vec<Option<f64>> {
    let mut zscores = Vec::with_capacity(yoy_series.len());

    for (i, &current_opt) in yoy_series.iter().enumerate() {
        let Some(curr) = current_opt.filter(|v| v.is_finite()) else {
            zscores.push(None);
            continue;
        };

        let mut window: Vec<f64> = yoy_series[..=i]
            .iter()
            .rev()
            .filter_map(|opt| opt.filter(|v| v.is_finite()))
            .take(5)
            .collect();
        window.reverse();

        if window.len() < 2 {
            zscores.push(None);
            continue;
        }

        let n = window.len() as f64;
        let mean = window.iter().sum::<f64>() / n;
        let variance = window.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n;
        let std_dev = variance.sqrt();

        if std_dev <= 1e-9 {
            zscores.push(Some(0.0));
        } else {
            zscores.push(Some((curr - mean) / std_dev));
        }
    }

    zscores
}

/// Filters valid years, sorts chronologically, slices to the last 10 fiscal years, and computes YoY % growth.
pub fn parse_and_compute_spending(
    agency_code: &str,
    agency_name: &str,
    resp: &UsaSpendingResponse,
) -> Vec<FiscalSpendingRecord> {
    let mut deduped: BTreeMap<i64, (f64, f64)> = BTreeMap::new();
    for row in &resp.agency_data_by_year {
        if let Some(budgetary_resources) = row.agency_budgetary_resources {
            if budgetary_resources.is_finite() {
                let obligations = row
                    .agency_total_obligated
                    .filter(|v| v.is_finite())
                    .unwrap_or(0.0);
                deduped.insert(row.fiscal_year, (budgetary_resources, obligations));
            }
        }
    }

    let mut records: Vec<FiscalSpendingRecord> = deduped
        .into_iter()
        .map(
            |(fiscal_year, (budgetary_resources, obligations))| FiscalSpendingRecord {
                agency_code: agency_code.to_string(),
                agency_name: agency_name.to_string(),
                fiscal_year,
                budgetary_resources,
                obligations,
                yoy_growth_pct: None,
                fiscal_impulse_zscore: None,
                fiscal_impulse_label: "Neutral".to_string(),
            },
        )
        .collect();

    if records.len() > 10 {
        let excess = records.len() - 10;
        records.drain(..excess);
    }

    for i in 1..records.len() {
        let prev = records[i - 1].budgetary_resources;
        let curr = records[i].budgetary_resources;
        records[i].yoy_growth_pct = if prev.abs() > f64::EPSILON {
            Some(((curr - prev) / prev) * 100.0)
        } else {
            None
        };
    }

    let yoy_series: Vec<Option<f64>> = records.iter().map(|r| r.yoy_growth_pct).collect();
    let zscores = compute_trailing_5y_zscores(&yoy_series);
    for (record, zscore) in records.iter_mut().zip(zscores) {
        record.fiscal_impulse_zscore = zscore;
        record.fiscal_impulse_label = classify_fiscal_impulse_zscore(zscore).to_string();
    }

    records
}

/// Upserts fiscal spending rows into the `fiscal_spending` table.
pub async fn upsert_fiscal_spending(
    pool: &SqlitePool,
    records: &[FiscalSpendingRecord],
) -> Result<(), IngestError> {
    let mut tx = pool.begin().await?;
    for record in records {
        sqlx::query(
            "INSERT INTO fiscal_spending (
                agency_code,
                agency_name,
                fiscal_year,
                budgetary_resources,
                obligations,
                yoy_growth_pct,
                fiscal_impulse_zscore,
                fiscal_impulse_label
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(agency_code, fiscal_year) DO UPDATE SET
                agency_name = excluded.agency_name,
                budgetary_resources = excluded.budgetary_resources,
                obligations = excluded.obligations,
                yoy_growth_pct = excluded.yoy_growth_pct,
                fiscal_impulse_zscore = excluded.fiscal_impulse_zscore,
                fiscal_impulse_label = excluded.fiscal_impulse_label",
        )
        .bind(&record.agency_code)
        .bind(&record.agency_name)
        .bind(record.fiscal_year)
        .bind(record.budgetary_resources)
        .bind(record.obligations)
        .bind(record.yoy_growth_pct)
        .bind(record.fiscal_impulse_zscore)
        .bind(&record.fiscal_impulse_label)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

/// Fetches budgetary resources for all configured agencies and persists the last 10 fiscal years.
pub async fn ingest_usaspending(
    pool: &SqlitePool,
    client: &reqwest::Client,
) -> Result<(), IngestError> {
    for &(agency_code, agency_name) in AGENCIES {
        let url = format!("{USASPENDING_BASE_URL}/{agency_code}/budgetary_resources/");
        let response = client.get(&url).send().await?.error_for_status()?;
        let body = response.text().await?;
        let parsed: UsaSpendingResponse = serde_json::from_str(&body)?;
        let records = parse_and_compute_spending(agency_code, agency_name, &parsed);
        if records.is_empty() {
            return Err(IngestError::InvalidData(format!(
                "no budgetary resource records returned for agency {agency_code}"
            )));
        }
        upsert_fiscal_spending(pool, &records).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::init_db;

    #[test]
    fn test_parse_and_compute_yoy_last_10_years() {
        let payload = r#"{
            "agency_data_by_year": [
                {"fiscal_year": 2024, "agency_budgetary_resources": 220.0, "agency_total_obligated": 200.0},
                {"fiscal_year": 2013, "agency_budgetary_resources": 90.0, "agency_total_obligated": 80.0},
                {"fiscal_year": 2015, "agency_budgetary_resources": 100.0, "agency_total_obligated": 90.0},
                {"fiscal_year": 2014, "agency_budgetary_resources": 95.0, "agency_total_obligated": 85.0},
                {"fiscal_year": 2016, "agency_budgetary_resources": 110.0, "agency_total_obligated": null},
                {"fiscal_year": 2017, "agency_budgetary_resources": 121.0},
                {"fiscal_year": 2018, "agency_budgetary_resources": null, "agency_total_obligated": 10.0},
                {"fiscal_year": 2019, "agency_budgetary_resources": 130.0, "agency_total_obligated": 120.0},
                {"fiscal_year": 2020, "agency_budgetary_resources": 140.0, "agency_total_obligated": 130.0},
                {"fiscal_year": 2021, "agency_budgetary_resources": 150.0, "agency_total_obligated": 140.0},
                {"fiscal_year": 2022, "agency_budgetary_resources": 160.0, "agency_total_obligated": 150.0},
                {"fiscal_year": 2023, "agency_budgetary_resources": 200.0, "agency_total_obligated": 180.0}
            ]
        }"#;

        let parsed: UsaSpendingResponse =
            serde_json::from_str(payload).expect("valid usaspending json");
        let records = parse_and_compute_spending("097", "Defense", &parsed);

        // 11 non-null years in payload (2013..=2024 excluding null 2018) -> trimmed to last 10.
        assert_eq!(records.len(), 10);
        assert_eq!(records[0].fiscal_year, 2014);
        assert_eq!(records[9].fiscal_year, 2024);

        assert!(records[0].yoy_growth_pct.is_none());
        let yoy_2015 = records[1].yoy_growth_pct.expect("2015 yoy");
        assert!((yoy_2015 - ((100.0 - 95.0) / 95.0) * 100.0).abs() < 1e-9);

        // Null obligations fallback to 0.0.
        assert!((records[2].obligations - 0.0).abs() < f64::EPSILON);

        let yoy_2024 = records[9].yoy_growth_pct.expect("2024 yoy");
        assert!((yoy_2024 - 10.0).abs() < 1e-9);
        assert!(records[9].fiscal_impulse_zscore.is_some());
    }

    #[test]
    fn test_fiscal_impulse_zscore_and_labels() {
        assert_eq!(AGENCIES.len(), 5);
        assert!(AGENCIES.contains(&("013", "Commerce")));
        assert!(AGENCIES.contains(&("069", "Transportation")));

        // Boundary classification checks
        assert_eq!(classify_fiscal_impulse_zscore(Some(0.51)), "Accelerating");
        assert_eq!(classify_fiscal_impulse_zscore(Some(0.5)), "Neutral");
        assert_eq!(classify_fiscal_impulse_zscore(Some(0.0)), "Neutral");
        assert_eq!(classify_fiscal_impulse_zscore(Some(-0.5)), "Neutral");
        assert_eq!(classify_fiscal_impulse_zscore(Some(-0.51)), "Contracting");
        assert_eq!(classify_fiscal_impulse_zscore(None), "Neutral");

        // Surge scenario: [5, 5, 5, 5, 15] -> mean = 7.0, std = 4.0, z = +2.0 -> Accelerating
        let surge = vec![
            None,
            Some(5.0),
            Some(5.0),
            Some(5.0),
            Some(5.0),
            Some(15.0),
        ];
        let surge_z = compute_trailing_5y_zscores(&surge);
        assert!(surge_z[0].is_none());
        assert!(surge_z[1].is_none()); // only 1 YoY observation so far
        assert!((surge_z[2].unwrap() - 0.0).abs() < 1e-9);
        let last_surge_z = surge_z[5].expect("surge zscore");
        assert!((last_surge_z - 2.0).abs() < 1e-9);
        assert_eq!(
            classify_fiscal_impulse_zscore(Some(last_surge_z)),
            "Accelerating"
        );

        // Normal steady budget inflation: [5, 5, 5, 5, 5] -> z = 0.0 -> Neutral
        let steady = vec![Some(5.0), Some(5.0), Some(5.0), Some(5.0), Some(5.0)];
        let steady_z = compute_trailing_5y_zscores(&steady);
        assert!((steady_z[4].unwrap() - 0.0).abs() < 1e-9);
        assert_eq!(classify_fiscal_impulse_zscore(steady_z[4]), "Neutral");

        // Contraction scenario: [8, 8, 8, 8, -2] -> mean = 6.0, std = 4.0, z = -2.0 -> Contracting
        let contraction = vec![Some(8.0), Some(8.0), Some(8.0), Some(8.0), Some(-2.0)];
        let contraction_z = compute_trailing_5y_zscores(&contraction);
        let last_contraction_z = contraction_z[4].expect("contraction zscore");
        assert!((last_contraction_z - (-2.0)).abs() < 1e-9);
        assert_eq!(
            classify_fiscal_impulse_zscore(Some(last_contraction_z)),
            "Contracting"
        );
    }

    #[tokio::test]
    async fn test_usaspending_sqlite_upsert() {
        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");

        let initial = vec![
            FiscalSpendingRecord {
                agency_code: "089".to_string(),
                agency_name: "Energy".to_string(),
                fiscal_year: 2023,
                budgetary_resources: 500.0,
                obligations: 450.0,
                yoy_growth_pct: None,
                fiscal_impulse_zscore: None,
                fiscal_impulse_label: "Neutral".to_string(),
            },
            FiscalSpendingRecord {
                agency_code: "089".to_string(),
                agency_name: "Energy".to_string(),
                fiscal_year: 2024,
                budgetary_resources: 550.0,
                obligations: 500.0,
                yoy_growth_pct: Some(10.0),
                fiscal_impulse_zscore: Some(0.0),
                fiscal_impulse_label: "Neutral".to_string(),
            },
        ];
        upsert_fiscal_spending(&pool, &initial)
            .await
            .expect("initial upsert failed");

        let updated = vec![FiscalSpendingRecord {
            agency_code: "089".to_string(),
            agency_name: "Energy".to_string(),
            fiscal_year: 2024,
            budgetary_resources: 600.0,
            obligations: 520.0,
            yoy_growth_pct: Some(20.0),
            fiscal_impulse_zscore: Some(1.4),
            fiscal_impulse_label: "Accelerating".to_string(),
        }];
        upsert_fiscal_spending(&pool, &updated)
            .await
            .expect("second upsert failed");

        let count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM fiscal_spending WHERE agency_code = '089'")
                .fetch_one(&pool)
                .await
                .expect("count query failed");
        assert_eq!(count, 2);

        let (br, yoy, zscore, label): (f64, Option<f64>, Option<f64>, Option<String>) =
            sqlx::query_as(
                "SELECT budgetary_resources, yoy_growth_pct, fiscal_impulse_zscore, fiscal_impulse_label FROM fiscal_spending WHERE agency_code = '089' AND fiscal_year = 2024",
            )
            .fetch_one(&pool)
            .await
            .expect("select updated row failed");
        assert!((br - 600.0).abs() < f64::EPSILON);
        assert!((yoy.expect("yoy present") - 20.0).abs() < f64::EPSILON);
        assert!((zscore.expect("zscore present") - 1.4).abs() < f64::EPSILON);
        assert_eq!(label.as_deref(), Some("Accelerating"));
    }
}
