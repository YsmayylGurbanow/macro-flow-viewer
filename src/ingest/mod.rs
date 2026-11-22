pub mod fred;
pub mod market;
pub mod secular_gold;
pub mod usaspending;

use reqwest::header::{HeaderMap, HeaderValue, USER_AGENT};
use sqlx::SqlitePool;
use thiserror::Error;

const BROWSER_USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// Errors returned by the data ingestion pipelines.
#[derive(Debug, Error)]
pub enum IngestError {
    /// HTTP transport or status error from an upstream data API.
    #[error("HTTP request error: {0}")]
    Http(#[from] reqwest::Error),

    /// SQLite query or transaction error while persisting ingested records.
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    /// JSON deserialization failure for an upstream API payload.
    #[error("JSON parse error: {0}")]
    Json(#[from] serde_json::Error),

    /// Required API key or configuration environment variable is missing.
    #[error("missing required environment variable: {0}")]
    MissingEnvVar(String),

    /// Upstream payload was malformed or contained no usable data.
    #[error("invalid upstream data: {0}")]
    InvalidData(String),
}

/// Builds an HTTP client configured with a standard browser `User-Agent` header.
pub(crate) fn build_http_client() -> Result<reqwest::Client, IngestError> {
    let mut headers = HeaderMap::new();
    headers.insert(USER_AGENT, HeaderValue::from_static(BROWSER_USER_AGENT));
    Ok(reqwest::Client::builder().default_headers(headers).build()?)
}

/// Runs all data ingestion pipelines fault-tolerantly and upserts records into SQLite.
///
/// If one pipeline (such as FRED when an API key is missing/rate-limited) fails, the remaining
/// pipelines continue executing and persisting their data.
pub async fn ingest_all(pool: &SqlitePool) -> Result<(), IngestError> {
    let client = build_http_client()?;
    let mut successes = 0_usize;
    let mut first_err: Option<IngestError> = None;

    if let Err(err) = usaspending::ingest_usaspending(pool, &client).await {
        eprintln!("Warning: USAspending ingestion failed ({err}).");
        first_err.get_or_insert(err);
    } else {
        successes += 1;
    }

    if let Err(err) = fred::ingest_fred(pool, &client).await {
        eprintln!("Warning: FRED ingestion failed ({err}).");
        first_err.get_or_insert(err);
    } else {
        successes += 1;
    }

    if let Err(err) = market::ingest_market(pool, &client).await {
        eprintln!("Warning: market ETF ingestion failed ({err}).");
        first_err.get_or_insert(err);
    } else {
        successes += 1;
    }

    if let Err(err) = secular_gold::ingest_secular_gold(pool, &client).await {
        eprintln!("Warning: secular Gold ingestion failed ({err}).");
        first_err.get_or_insert(err);
    } else {
        successes += 1;
    }

    if successes == 0 {
        if let Some(err) = first_err {
            return Err(err);
        }
    } else if let Err(err) = crate::decision::record_signal_snapshots(pool).await {
        eprintln!("Warning: signal snapshot logging failed ({err}).");
    }

    Ok(())
}
