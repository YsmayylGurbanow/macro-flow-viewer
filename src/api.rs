use std::path::Path as FsPath;

use axum::body::Body;
use axum::extract::{Path, State};
use axum::http::{header, HeaderValue, Method, Request, StatusCode};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::Serialize;
use sqlx::SqlitePool;
use tower_http::services::ServeDir;

use crate::agent::analyst::{
    analyze_rotation, analyze_sector, get_or_create_brief, get_or_synthesize_rotation_brief,
    AnalystBrief,
};
use crate::agent::tools::{
    compute_regime_analogs, find_sector_mapping, get_fiscal_flows, get_rate_regime_history,
    get_sector_valuation, FiscalFlowRow, MacroRateRow, RegimeAnalogsReport, RegimeDateRange,
    SectorValuationRow, SECTOR_MAPPINGS,
};
use crate::agent::AgentError;
use crate::decision::{
    compute_sector_rankings, load_recent_signal_snapshots, RotationBrief, SectorDecision,
    SignalSnapshotRow,
};
use crate::ingest::secular_gold::{load_secular_gold_assets, SecularGoldAssetResponse};

const ALLOWED_ORIGIN: &str = "http://localhost:3000";

/// Summary card for a single sector returned by `GET /api/sectors`.
#[derive(Debug, Serialize, serde::Deserialize)]
pub struct SectorSummaryCard {
    /// Sector ETF ticker symbol.
    pub ticker: String,
    /// Sector display name.
    pub sector_name: String,
    /// Mapped federal agency code.
    pub agency_code: String,
    /// Mapped federal agency name.
    pub agency_name: String,
    /// Latest fiscal year available for the agency.
    pub latest_fiscal_year: Option<i64>,
    /// Latest agency budgetary resources in USD.
    pub latest_budgetary_resources: Option<f64>,
    /// Latest deterministic YoY spending growth %.
    pub latest_yoy_growth_pct: Option<f64>,
    /// Trailing 5-year fiscal impulse Z-score.
    pub fiscal_impulse_zscore: Option<f64>,
    /// Deterministic Z-score impulse label (`Accelerating`, `Neutral`, or `Contracting`).
    pub fiscal_impulse_label: String,
    /// Deterministic spending impulse label.
    pub spending_impulse: String,
    /// Latest monetary rate regime label.
    pub current_regime_label: Option<String>,
    /// Latest ETF close price.
    pub latest_close_price: Option<f64>,
    /// Latest 10-year historical valuation percentile (0.0–100.0).
    pub valuation_percentile: Option<f64>,
    /// Latest 10-year valuation percentile of `ETF / GLD` alone (0.0–100.0).
    pub gold_valuation_percentile: Option<f64>,
    /// Deterministic valuation zone (`Cheap`, `Fair`, `Expensive`, or `Unknown`).
    pub valuation_zone: String,
}

/// Top-level response payload for `GET /api/sectors`.
#[derive(Debug, Serialize, serde::Deserialize)]
pub struct SectorsOverviewResponse {
    /// Latest macro rate observation.
    pub current_rate_regime: Option<MacroRateRow>,
    /// Summary cards for all supported sector ETFs.
    pub sectors: Vec<SectorSummaryCard>,
}

/// Full 10-year time-series and cached analyst brief returned by `GET /api/sectors/:ticker`.
#[derive(Debug, Serialize, serde::Deserialize)]
pub struct SectorDetailResponse {
    /// Sector ETF ticker symbol.
    pub ticker: String,
    /// Sector display name.
    pub sector_name: String,
    /// Mapped federal agency code.
    pub agency_code: String,
    /// Mapped federal agency name.
    pub agency_name: String,
    /// Latest deterministic YoY spending growth %.
    pub latest_yoy_growth_pct: Option<f64>,
    /// Trailing 5-year fiscal impulse Z-score.
    pub fiscal_impulse_zscore: Option<f64>,
    /// Deterministic Z-score impulse label (`Accelerating`, `Neutral`, or `Contracting`).
    pub fiscal_impulse_label: String,
    /// Deterministic spending impulse label.
    pub spending_impulse: String,
    /// 10-year agency fiscal spending history.
    pub fiscal_spending: Vec<FiscalFlowRow>,
    /// Current macro rate observation.
    pub current_rate: Option<MacroRateRow>,
    /// Contiguous historical date windows matching the current rate regime.
    pub matching_regime_periods: Vec<RegimeDateRange>,
    /// Monthly macro interest rate history.
    pub macro_rates: Vec<MacroRateRow>,
    /// Latest monthly valuation observation.
    pub latest_valuation: Option<SectorValuationRow>,
    /// Latest 10-year valuation percentile of `ETF / GLD` alone (0.0–100.0).
    pub gold_valuation_percentile: Option<f64>,
    /// Deterministic valuation zone (`Cheap`, `Fair`, `Expensive`, or `Unknown`).
    pub valuation_zone: String,
    /// Average historical 12-month forward return (%) in the current regime.
    pub avg_12m_return_in_regime_pct: Option<f64>,
    /// Historical sample size for `avg_12m_return_in_regime_pct`.
    pub matching_regime_sample_count: usize,
    /// Monthly sector ETF valuation history.
    pub sector_valuations: Vec<SectorValuationRow>,
    /// Deterministic historical regime backtest matrix and win-rate summary.
    pub regime_analogs: RegimeAnalogsReport,
    /// Cached or newly generated macro analyst brief.
    pub analyst_brief: AnalystBrief,
}

/// Cross-sector Decision Engine leaderboard, rotation brief, and signal history returned by `GET /api/decisions`.
#[derive(Debug, Serialize, serde::Deserialize)]
pub struct DecisionsResponse {
    /// Latest macro rate observation.
    pub current_rate_regime: Option<MacroRateRow>,
    /// All 6 sector ETFs ranked `#1` through `#6` by deterministic Conviction Score.
    pub rankings: Vec<SectorDecision>,
    /// Cached or deterministically synthesized cross-sector rotation brief.
    pub rotation_brief: RotationBrief,
    /// Recent snapshot history logged in `signal_snapshots`.
    pub signal_snapshots: Vec<SignalSnapshotRow>,
}

/// Health and data freshness telemetry returned by `GET /api/health`.
#[derive(Debug, Serialize, serde::Deserialize, PartialEq)]
pub struct HealthResponse {
    /// Service status (`"ok"`).
    pub status: String,
    /// Most recent monthly observation date in `sector_valuations`.
    pub last_market_date: Option<String>,
    /// Most recent federal fiscal year in `fiscal_spending`.
    pub last_fiscal_year: Option<i64>,
    /// Total configured US sector ETFs (`6`).
    pub sectors_count: usize,
    /// Distinct macro assets persisted in `gold_secular_ratios`.
    pub secular_gold_assets_count: i64,
}

#[derive(Debug, Serialize)]
struct ErrorBody {
    error: String,
}

/// HTTP error wrapper for Axum route handlers.
#[derive(Debug)]
pub struct ApiError(AgentError);

impl From<AgentError> for ApiError {
    fn from(err: AgentError) -> Self {
        Self(err)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let status = match &self.0 {
            AgentError::UnknownTicker(_) => StatusCode::NOT_FOUND,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (
            status,
            Json(ErrorBody {
                error: self.0.to_string(),
            }),
        )
            .into_response()
    }
}

async fn cors_middleware(req: Request<Body>, next: Next) -> Response {
    if req.method() == Method::OPTIONS {
        return (
            StatusCode::NO_CONTENT,
            [
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, ALLOWED_ORIGIN),
                (header::ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS"),
                (
                    header::ACCESS_CONTROL_ALLOW_HEADERS,
                    "Content-Type, Authorization",
                ),
            ],
        )
            .into_response();
    }

    let mut response = next.run(req).await;
    let headers = response.headers_mut();
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_ORIGIN,
        HeaderValue::from_static(ALLOWED_ORIGIN),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        HeaderValue::from_static("GET, POST, OPTIONS"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        HeaderValue::from_static("Content-Type, Authorization"),
    );
    response
}

/// Builds the Axum HTTP router with CORS configured for `http://localhost:3000`
/// and serves static Next.js export assets from `web/out` when present.
pub fn build_router(pool: SqlitePool) -> Router {
    let router = Router::new()
        .route("/api/health", get(get_health))
        .route("/api/sectors", get(list_sectors))
        .route("/api/sectors/:ticker", get(get_sector_detail))
        .route("/api/sectors/:ticker/analyze", post(trigger_sector_analysis))
        .route("/api/vs-gold", get(get_vs_gold))
        .route("/api/decisions", get(get_decisions))
        .route("/api/decisions/analyze", post(trigger_rotation_analysis))
        .layer(middleware::from_fn(cors_middleware))
        .with_state(pool);

    if FsPath::new("web/out").is_dir() {
        router.fallback_service(ServeDir::new("web/out"))
    } else {
        router
    }
}

async fn get_health(State(pool): State<SqlitePool>) -> Result<Json<HealthResponse>, ApiError> {
    let last_market_date: Option<String> = sqlx::query_scalar("SELECT MAX(date) FROM sector_valuations")
        .fetch_one(&pool)
        .await
        .map_err(AgentError::Sqlx)?;
    let last_fiscal_year: Option<i64> =
        sqlx::query_scalar("SELECT MAX(fiscal_year) FROM fiscal_spending")
            .fetch_one(&pool)
            .await
            .map_err(AgentError::Sqlx)?;
    let secular_gold_assets_count: i64 =
        sqlx::query_scalar("SELECT COUNT(DISTINCT asset_key) FROM gold_secular_ratios")
            .fetch_one(&pool)
            .await
            .map_err(AgentError::Sqlx)?;

    Ok(Json(HealthResponse {
        status: "ok".to_string(),
        last_market_date,
        last_fiscal_year,
        sectors_count: SECTOR_MAPPINGS.len(),
        secular_gold_assets_count,
    }))
}

async fn get_decisions(
    State(pool): State<SqlitePool>,
) -> Result<Json<DecisionsResponse>, ApiError> {
    let rates = get_rate_regime_history(&pool).await?;
    let rankings = compute_sector_rankings(&pool).await?;
    let rotation_brief = get_or_synthesize_rotation_brief(&pool, &rankings).await?;
    let signal_snapshots = load_recent_signal_snapshots(&pool, 30)
        .await
        .map_err(AgentError::Sqlx)?;

    Ok(Json(DecisionsResponse {
        current_rate_regime: rates.current,
        rankings,
        rotation_brief,
        signal_snapshots,
    }))
}

async fn trigger_rotation_analysis(
    State(pool): State<SqlitePool>,
) -> Result<Json<RotationBrief>, ApiError> {
    let brief = analyze_rotation(&pool).await?;
    Ok(Json(brief))
}

async fn get_vs_gold(
    State(pool): State<SqlitePool>,
) -> Result<Json<Vec<SecularGoldAssetResponse>>, ApiError> {
    let assets = load_secular_gold_assets(&pool)
        .await
        .map_err(AgentError::Sqlx)?;
    Ok(Json(assets))
}

async fn list_sectors(
    State(pool): State<SqlitePool>,
) -> Result<Json<SectorsOverviewResponse>, ApiError> {
    let rates = get_rate_regime_history(&pool).await?;
    let current_regime_label = rates.current.as_ref().map(|r| r.regime_label.clone());

    let mut sectors = Vec::with_capacity(SECTOR_MAPPINGS.len());
    for mapping in SECTOR_MAPPINGS {
        let fiscal = get_fiscal_flows(&pool, mapping.agency_code).await?;
        let valuation = get_sector_valuation(&pool, mapping.ticker).await?;

        sectors.push(SectorSummaryCard {
            ticker: mapping.ticker.to_string(),
            sector_name: mapping.sector_name.to_string(),
            agency_code: mapping.agency_code.to_string(),
            agency_name: mapping.agency_name.to_string(),
            latest_fiscal_year: fiscal.latest_fiscal_year,
            latest_budgetary_resources: fiscal.latest_budgetary_resources,
            latest_yoy_growth_pct: fiscal.latest_yoy_growth_pct,
            fiscal_impulse_zscore: fiscal.fiscal_impulse_zscore,
            fiscal_impulse_label: fiscal.fiscal_impulse_label,
            spending_impulse: fiscal.spending_impulse,
            current_regime_label: current_regime_label.clone(),
            latest_close_price: valuation.latest.as_ref().map(|v| v.close_price),
            valuation_percentile: valuation.latest.as_ref().map(|v| v.valuation_percentile),
            gold_valuation_percentile: valuation.gold_valuation_percentile,
            valuation_zone: valuation.valuation_zone,
        });
    }

    Ok(Json(SectorsOverviewResponse {
        current_rate_regime: rates.current,
        sectors,
    }))
}

async fn get_sector_detail(
    State(pool): State<SqlitePool>,
    Path(ticker): Path<String>,
) -> Result<Json<SectorDetailResponse>, ApiError> {
    let mapping = find_sector_mapping(&ticker)
        .ok_or_else(|| AgentError::UnknownTicker(ticker.clone()))?;

    let fiscal = get_fiscal_flows(&pool, mapping.agency_code).await?;
    let rates = get_rate_regime_history(&pool).await?;
    let valuation = get_sector_valuation(&pool, mapping.ticker).await?;
    let regime_analogs = compute_regime_analogs(&pool, mapping.ticker).await?;
    let analyst_brief = get_or_create_brief(&pool, mapping.ticker).await?;

    Ok(Json(SectorDetailResponse {
        ticker: mapping.ticker.to_string(),
        sector_name: mapping.sector_name.to_string(),
        agency_code: mapping.agency_code.to_string(),
        agency_name: mapping.agency_name.to_string(),
        latest_yoy_growth_pct: fiscal.latest_yoy_growth_pct,
        fiscal_impulse_zscore: fiscal.fiscal_impulse_zscore,
        fiscal_impulse_label: fiscal.fiscal_impulse_label,
        spending_impulse: fiscal.spending_impulse,
        fiscal_spending: fiscal.history,
        current_rate: rates.current,
        matching_regime_periods: rates.matching_regime_periods,
        macro_rates: rates.history,
        latest_valuation: valuation.latest,
        gold_valuation_percentile: valuation.gold_valuation_percentile,
        valuation_zone: valuation.valuation_zone,
        avg_12m_return_in_regime_pct: valuation.avg_12m_return_in_regime_pct,
        matching_regime_sample_count: valuation.matching_regime_sample_count,
        sector_valuations: valuation.history,
        regime_analogs,
        analyst_brief,
    }))
}

async fn trigger_sector_analysis(
    State(pool): State<SqlitePool>,
    Path(ticker): Path<String>,
) -> Result<Json<AnalystBrief>, ApiError> {
    let mapping = find_sector_mapping(&ticker)
        .ok_or_else(|| AgentError::UnknownTicker(ticker.clone()))?;

    let brief = analyze_sector(&pool, mapping.ticker).await?;
    Ok(Json(brief))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tools::test_fixtures::seed_sample_macro_data;
    use crate::db::init_db;

    async fn spawn_test_server(pool: SqlitePool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind ephemeral port failed");
        let addr = listener.local_addr().expect("local_addr failed");
        tokio::spawn(async move {
            axum::serve(listener, build_router(pool))
                .await
                .expect("test server error");
        });
        format!("http://{addr}")
    }

    #[tokio::test]
    async fn test_api_sectors_endpoints_and_cors() {
        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");
        seed_sample_macro_data(&pool).await;

        let base_url = spawn_test_server(pool).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build test http client failed");

        // 1. GET /api/sectors
        let overview_resp = client
            .get(format!("{base_url}/api/sectors"))
            .send()
            .await
            .expect("GET /api/sectors failed");
        assert_eq!(overview_resp.status(), StatusCode::OK);
        assert_eq!(
            overview_resp
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some("http://localhost:3000")
        );
        let overview: SectorsOverviewResponse = overview_resp
            .json()
            .await
            .expect("deserialize overview failed");
        assert_eq!(overview.sectors.len(), 6);
        let tickers: Vec<&str> = overview
            .sectors
            .iter()
            .map(|s| s.ticker.as_str())
            .collect();
        assert_eq!(tickers, vec!["ITA", "XLE", "XLV", "IYT", "XLK", "PAVE"]);
        assert_eq!(overview.sectors[0].valuation_zone, "Cheap");
        assert_eq!(overview.sectors[0].fiscal_impulse_label, "Accelerating");
        assert!(overview.sectors[0].fiscal_impulse_zscore.is_some());
        assert_eq!(
            overview.sectors[0].current_regime_label.as_deref(),
            Some("High-Pause")
        );

        // 2. GET /api/sectors/ITA (auto-generates & caches analyst_brief)
        let detail_resp = client
            .get(format!("{base_url}/api/sectors/ITA"))
            .send()
            .await
            .expect("GET /api/sectors/ITA failed");
        assert_eq!(detail_resp.status(), StatusCode::OK);
        let detail: SectorDetailResponse =
            detail_resp.json().await.expect("deserialize detail failed");
        assert_eq!(detail.ticker, "ITA");
        assert_eq!(detail.fiscal_spending.len(), 3);
        assert_eq!(detail.macro_rates.len(), 16);
        assert_eq!(detail.sector_valuations.len(), 16);
        assert!(detail.fiscal_impulse_zscore.is_some());
        assert_eq!(detail.fiscal_impulse_label, "Accelerating");
        assert!(detail.gold_valuation_percentile.is_some());
        assert!(!detail.regime_analogs.analogs.is_empty());
        assert_eq!(detail.analyst_brief.ticker, "ITA");
        assert_eq!(detail.analyst_brief.valuation_zone, "Cheap");

        // 2b. GET /api/sectors/XLK (013 Commerce) and GET /api/sectors/PAVE (069 Transportation)
        let xlk_resp = client
            .get(format!("{base_url}/api/sectors/XLK"))
            .send()
            .await
            .expect("GET /api/sectors/XLK failed");
        assert_eq!(xlk_resp.status(), StatusCode::OK);
        let xlk_detail: SectorDetailResponse =
            xlk_resp.json().await.expect("deserialize XLK detail failed");
        assert_eq!(xlk_detail.ticker, "XLK");
        assert_eq!(xlk_detail.agency_code, "013");

        let pave_resp = client
            .get(format!("{base_url}/api/sectors/PAVE"))
            .send()
            .await
            .expect("GET /api/sectors/PAVE failed");
        assert_eq!(pave_resp.status(), StatusCode::OK);
        let pave_detail: SectorDetailResponse = pave_resp
            .json()
            .await
            .expect("deserialize PAVE detail failed");
        assert_eq!(pave_detail.ticker, "PAVE");
        assert_eq!(pave_detail.agency_code, "069");

        // 3. POST /api/sectors/ITA/analyze
        let analyze_resp = client
            .post(format!("{base_url}/api/sectors/ITA/analyze"))
            .send()
            .await
            .expect("POST /api/sectors/ITA/analyze failed");
        assert_eq!(analyze_resp.status(), StatusCode::OK);
        let refreshed: AnalystBrief = analyze_resp
            .json()
            .await
            .expect("deserialize brief failed");
        assert_eq!(refreshed.ticker, "ITA");

        // 4. CORS preflight OPTIONS
        let preflight = client
            .request(Method::OPTIONS, format!("{base_url}/api/sectors/ITA"))
            .send()
            .await
            .expect("OPTIONS request failed");
        assert_eq!(preflight.status(), StatusCode::NO_CONTENT);
        assert_eq!(
            preflight
                .headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some("http://localhost:3000")
        );

        // 5. Unknown ticker returns 404
        let not_found = client
            .get(format!("{base_url}/api/sectors/UNKNOWN"))
            .send()
            .await
            .expect("GET /api/sectors/UNKNOWN failed");
        assert_eq!(not_found.status(), StatusCode::NOT_FOUND);
    }

    #[tokio::test]
    async fn test_api_vs_gold_endpoint() {
        use std::collections::BTreeMap;

        use crate::ingest::secular_gold::{
            build_housing_in_gold, build_sp500_in_gold, build_usd_in_gold,
            upsert_secular_gold_records,
        };

        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");

        let mut gold = BTreeMap::new();
        gold.insert("1970-01-01".to_string(), 35.0);
        gold.insert("1980-01-01".to_string(), 600.0);
        gold.insert("2024-01-01".to_string(), 2000.0);

        let mut gspc = BTreeMap::new();
        gspc.insert("1970-01-01".to_string(), 90.0);
        gspc.insert("1980-01-01".to_string(), 110.0);
        gspc.insert("2024-01-01".to_string(), 4800.0);

        let mut mspus = BTreeMap::new();
        mspus.insert("1970-01-01".to_string(), 23_800.0);
        mspus.insert("1980-01-01".to_string(), 63_700.0);
        mspus.insert("2024-01-01".to_string(), 420_000.0);

        upsert_secular_gold_records(&pool, &build_usd_in_gold(&gold))
            .await
            .expect("seed USD_GOLD failed");
        upsert_secular_gold_records(&pool, &build_sp500_in_gold(&gspc, &gold))
            .await
            .expect("seed SP500_GOLD failed");
        upsert_secular_gold_records(&pool, &build_housing_in_gold(&mspus, &gold))
            .await
            .expect("seed HOUSING_GOLD failed");

        let base_url = spawn_test_server(pool).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build test http client failed");

        let resp = client
            .get(format!("{base_url}/api/vs-gold"))
            .send()
            .await
            .expect("GET /api/vs-gold failed");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some("http://localhost:3000")
        );

        let assets: Vec<SecularGoldAssetResponse> =
            resp.json().await.expect("deserialize /api/vs-gold failed");
        assert_eq!(assets.len(), 3);
        let keys: Vec<&str> = assets.iter().map(|a| a.asset_key.as_str()).collect();
        assert_eq!(keys, vec!["USD_GOLD", "SP500_GOLD", "HOUSING_GOLD"]);

        let usd = &assets[0];
        assert_eq!(usd.unit_label, "oz Gold per $1,000");
        assert_eq!(usd.valuation_zone, "Cheap");
        assert!((usd.latest_ratio - 0.5).abs() < 1e-9);
        assert_eq!(usd.min_ratio.date, "2024-01-01");
        assert_eq!(usd.max_ratio.date, "1970-01-01");
        assert_eq!(usd.series.len(), 3);

        let sp500 = &assets[1];
        assert_eq!(sp500.valuation_zone, "Normal");
        assert!((sp500.latest_ratio - 2.4).abs() < 1e-9);
        assert_eq!(sp500.max_ratio.date, "1970-01-01");

        let housing = &assets[2];
        assert_eq!(housing.unit_label, "oz Gold per Median US House");
        assert!((housing.latest_ratio - 210.0).abs() < 1e-9);
        assert!((housing.secular_percentile - 50.0).abs() < 1e-9);
        assert_eq!(housing.valuation_zone, "Normal");
    }

    #[tokio::test]
    async fn test_api_decisions_endpoints() {
        use crate::decision::record_signal_snapshots;

        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");
        seed_sample_macro_data(&pool).await;

        sqlx::query(
            "UPDATE fiscal_spending SET yoy_growth_pct = -15.0 WHERE agency_code = '089' AND fiscal_year = 2024",
        )
        .execute(&pool)
        .await
        .expect("update 089 failed");

        record_signal_snapshots(&pool)
            .await
            .expect("record_signal_snapshots failed");

        let base_url = spawn_test_server(pool).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build test http client failed");

        let resp = client
            .get(format!("{base_url}/api/decisions"))
            .send()
            .await
            .expect("GET /api/decisions failed");
        assert_eq!(resp.status(), StatusCode::OK);
        assert_eq!(
            resp.headers()
                .get(header::ACCESS_CONTROL_ALLOW_ORIGIN)
                .and_then(|v| v.to_str().ok()),
            Some("http://localhost:3000")
        );

        let payload: DecisionsResponse = resp
            .json()
            .await
            .expect("deserialize /api/decisions failed");
        assert_eq!(payload.rankings.len(), 6);
        assert_eq!(payload.rankings[0].rank, 1);
        assert_eq!(payload.rankings[5].rank, 6);
        assert_eq!(payload.rankings[5].ticker, "XLE");
        assert_eq!(payload.rotation_brief.top_sector, payload.rankings[0].ticker);
        assert_eq!(payload.rotation_brief.avoid_sector, "XLE");
        assert_eq!(payload.signal_snapshots.len(), 6);

        let post_resp = client
            .post(format!("{base_url}/api/decisions/analyze"))
            .send()
            .await
            .expect("POST /api/decisions/analyze failed");
        assert_eq!(post_resp.status(), StatusCode::OK);
        let refreshed: RotationBrief = post_resp
            .json()
            .await
            .expect("deserialize rotation brief failed");
        assert_eq!(refreshed.top_sector, payload.rankings[0].ticker);
        assert_eq!(refreshed.avoid_sector, "XLE");
    }

    #[tokio::test]
    async fn test_api_health_endpoint() {
        use std::collections::BTreeMap;

        use crate::ingest::secular_gold::{
            build_sp500_in_gold, build_usd_in_gold, upsert_secular_gold_records,
        };

        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");
        let base_url = spawn_test_server(pool.clone()).await;
        let client = reqwest::Client::builder()
            .no_proxy()
            .build()
            .expect("build test http client failed");

        // 1. Empty database reports ok with None / 0 freshness counts and 6 configured sectors
        let empty_resp = client
            .get(format!("{base_url}/api/health"))
            .send()
            .await
            .expect("GET /api/health (empty) failed");
        assert_eq!(empty_resp.status(), StatusCode::OK);
        let empty_health: HealthResponse = empty_resp
            .json()
            .await
            .expect("deserialize empty health failed");
        assert_eq!(empty_health.status, "ok");
        assert_eq!(empty_health.last_market_date, None);
        assert_eq!(empty_health.last_fiscal_year, None);
        assert_eq!(empty_health.sectors_count, 6);
        assert_eq!(empty_health.secular_gold_assets_count, 0);

        // 2. Seed macro + 2 secular gold assets and verify populated telemetry
        seed_sample_macro_data(&pool).await;
        let mut gold = BTreeMap::new();
        gold.insert("2024-01-01".to_string(), 2000.0);
        let mut gspc = BTreeMap::new();
        gspc.insert("2024-01-01".to_string(), 4800.0);

        upsert_secular_gold_records(&pool, &build_usd_in_gold(&gold))
            .await
            .expect("seed USD_GOLD failed");
        upsert_secular_gold_records(&pool, &build_sp500_in_gold(&gspc, &gold))
            .await
            .expect("seed SP500_GOLD failed");

        let seeded_resp = client
            .get(format!("{base_url}/api/health"))
            .send()
            .await
            .expect("GET /api/health (seeded) failed");
        assert_eq!(seeded_resp.status(), StatusCode::OK);
        let seeded_health: HealthResponse = seeded_resp
            .json()
            .await
            .expect("deserialize seeded health failed");
        assert_eq!(seeded_health.status, "ok");
        assert_eq!(
            seeded_health.last_market_date.as_deref(),
            Some("2024-04-01")
        );
        assert_eq!(seeded_health.last_fiscal_year, Some(2024));
        assert_eq!(seeded_health.sectors_count, 6);
        assert_eq!(seeded_health.secular_gold_assets_count, 2);
    }
}
