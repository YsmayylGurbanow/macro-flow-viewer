use std::str::FromStr;

use sqlx::sqlite::{SqliteConnectOptions, SqlitePoolOptions};
use sqlx::SqlitePool;
use thiserror::Error;

/// Errors returned while initializing or migrating the SQLite database.
#[derive(Debug, Error)]
pub enum DbError {
    /// Failed to parse connection options or execute a SQLite query.
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    /// Failed to apply embedded SQLx migrations.
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
}

/// Initializes a SQLite connection pool and applies pending database migrations.
pub async fn init_db(database_url: &str) -> Result<SqlitePool, DbError> {
    let options = SqliteConnectOptions::from_str(database_url)?.create_if_missing(true);

    // In-memory SQLite databases are per-connection unless shared, so pin to 1 connection.
    let max_connections = if database_url.contains(":memory:") {
        1
    } else {
        5
    };

    let pool = SqlitePoolOptions::new()
        .max_connections(max_connections)
        .connect_with(options)
        .await?;

    sqlx::migrate!("./migrations").run(&pool).await?;

    Ok(pool)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_db_init() {
        let pool = init_db("sqlite::memory:")
            .await
            .expect("failed to initialize in-memory sqlite database");

        let table_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name IN ('fiscal_spending', 'macro_rates', 'sector_valuations', 'analyst_briefs', 'gold_secular_ratios', 'signal_snapshots', 'rotation_briefs')",
        )
        .fetch_one(&pool)
        .await
        .expect("failed to query sqlite_master");
        assert_eq!(table_count, 7);

        sqlx::query(
            "INSERT INTO fiscal_spending (agency_code, agency_name, fiscal_year, budgetary_resources, obligations, yoy_growth_pct, fiscal_impulse_zscore, fiscal_impulse_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("097")
        .bind("Department of Defense")
        .bind(2024_i64)
        .bind(1_000_000.0_f64)
        .bind(850_000.0_f64)
        .bind(Some(5.25_f64))
        .bind(Some(1.25_f64))
        .bind(Some("Accelerating"))
        .execute(&pool)
        .await
        .expect("failed to insert into fiscal_spending");

        let (zscore, label): (Option<f64>, Option<String>) = sqlx::query_as(
            "SELECT fiscal_impulse_zscore, fiscal_impulse_label FROM fiscal_spending WHERE agency_code = ? AND fiscal_year = ?",
        )
        .bind("097")
        .bind(2024_i64)
        .fetch_one(&pool)
        .await
        .expect("failed to read signal upgrade columns from fiscal_spending");
        assert!((zscore.expect("zscore present") - 1.25).abs() < f64::EPSILON);
        assert_eq!(label.as_deref(), Some("Accelerating"));

        sqlx::query(
            "INSERT INTO analyst_briefs (ticker, agency_code, regime_label, valuation_zone, summary_markdown, updated_at, regime_match_table) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("ITA")
        .bind("097")
        .bind("High-Pause")
        .bind("Cheap")
        .bind("## Brief")
        .bind("2024-04-01T00:00:00Z")
        .bind(Some("[]"))
        .execute(&pool)
        .await
        .expect("failed to insert into analyst_briefs with regime_match_table");

        sqlx::query(
            "INSERT INTO macro_rates (date, fed_funds, dgs10, yield_spread, regime_label) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("2024-01-01")
        .bind(5.33_f64)
        .bind(3.95_f64)
        .bind(-1.38_f64)
        .bind("High-Pause")
        .execute(&pool)
        .await
        .expect("failed to insert into macro_rates");

        sqlx::query(
            "INSERT INTO sector_valuations (ticker, sector_name, date, close_price, gold_ratio, spy_ratio, valuation_percentile) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("ITA")
        .bind("Defense")
        .bind("2024-01-01")
        .bind(125.50_f64)
        .bind(0.65_f64)
        .bind(0.26_f64)
        .bind(42.0_f64)
        .execute(&pool)
        .await
        .expect("failed to insert into sector_valuations");

        sqlx::query(
            "INSERT INTO gold_secular_ratios (asset_key, asset_name, unit_label, date, asset_value_usd, gold_price_usd, ratio_in_gold, secular_percentile) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("USD_GOLD")
        .bind("US Dollar ($1,000)")
        .bind("oz Gold per $1,000")
        .bind("1970-01-01")
        .bind(1000.0_f64)
        .bind(35.17_f64)
        .bind(1000.0_f64 / 35.17_f64)
        .bind(99.5_f64)
        .execute(&pool)
        .await
        .expect("failed to insert into gold_secular_ratios");

        sqlx::query(
            "INSERT INTO signal_snapshots (snapshot_date, ticker, conviction_score, decision_tier, fiscal_impulse_zscore, regime_label, gold_valuation_percentile, etf_close) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("2026-11-21")
        .bind("ITA")
        .bind(82.5_f64)
        .bind("High Conviction")
        .bind(Some(1.4_f64))
        .bind("High-Pause")
        .bind(Some(18.0_f64))
        .bind(Some(125.5_f64))
        .execute(&pool)
        .await
        .expect("failed to insert into signal_snapshots");

        sqlx::query(
            "INSERT INTO rotation_briefs (snapshot_date, top_sector, avoid_sector, summary_markdown, updated_at) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("2026-11-21")
        .bind("ITA")
        .bind("XLE")
        .bind("## Rotation Brief")
        .bind("2026-11-21T00:00:00Z")
        .execute(&pool)
        .await
        .expect("failed to insert into rotation_briefs");
    }
}
