use chrono::Utc;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sqlx::SqlitePool;

use crate::decision::{compute_sector_rankings, RotationBrief, SectorDecision};

use super::tools::{
    compute_regime_analogs, execute_tool_call, find_sector_mapping, gemini_tool_declarations,
    get_fiscal_flows, get_rate_regime_history, get_sector_valuation, FiscalFlowsReport,
    RateRegimeReport, SectorMapping, SectorValuationReport,
};
use super::AgentError;

const GEMINI_GENERATE_ENDPOINT: &str =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent";
const MAX_AGENT_TURNS: usize = 6;

/// Cached structured macro analyst brief stored in SQLite `analyst_briefs`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, PartialEq)]
pub struct AnalystBrief {
    /// Sector ETF ticker symbol.
    pub ticker: String,
    /// Federal agency code mapped to the sector.
    pub agency_code: String,
    /// Current monetary rate regime label.
    pub regime_label: String,
    /// Valuation percentile zone (`Cheap`, `Fair`, `Expensive`, or `Unknown`).
    pub valuation_zone: String,
    /// Markdown brief cross-referencing spending, rate regime, and valuation.
    pub summary_markdown: String,
    /// UTC RFC3339 timestamp when this brief was generated.
    pub updated_at: String,
    /// Serialized JSON of deterministic `RegimeAnalogsReport` table.
    pub regime_match_table: Option<String>,
}

/// Deterministic offline synthesis used when `GEMINI_API_KEY` is missing/placeholder or unavailable.
pub fn synthesize_deterministic_brief(
    mapping: &SectorMapping,
    fiscal: &FiscalFlowsReport,
    rates: &RateRegimeReport,
    valuation: &SectorValuationReport,
) -> String {
    let zscore_str = fiscal
        .fiscal_impulse_zscore
        .map(|z| format!("Z = {z:+.2}"))
        .unwrap_or_else(|| "Z = N/A".to_string());

    let fiscal_line = match (
        fiscal.latest_fiscal_year,
        fiscal.latest_budgetary_resources,
        fiscal.latest_yoy_growth_pct,
    ) {
        (Some(year), Some(resources), Some(yoy)) => format!(
            "FY{year} budgetary resources stand at {resources:.2} ({yoy:+.2}% YoY, {zscore_str}, impulse: **{}**).",
            fiscal.fiscal_impulse_label
        ),
        (Some(year), Some(resources), None) => format!(
            "FY{year} budgetary resources stand at {resources:.2} (no prior-year YoY comparison available; {zscore_str}, impulse: **{}**).",
            fiscal.fiscal_impulse_label
        ),
        _ => "No federal fiscal spending rows ingested yet for this agency.".to_string(),
    };

    let rate_line = match rates.current.as_ref() {
        Some(curr) => format!(
            "As of {}, FEDFUNDS is {:.2}% and DGS10 is {:.2}% (yield spread {:+.2}%), placing the macro environment in a **{}** regime across {} historical window(s).",
            curr.date,
            curr.fed_funds,
            curr.dgs10,
            curr.yield_spread,
            curr.regime_label,
            rates.matching_regime_periods.len()
        ),
        None => "No macro rate observations ingested yet.".to_string(),
    };

    let gold_pct_suffix = valuation
        .gold_valuation_percentile
        .map(|g| format!(", Gold-relative percentile: **{g:.1}th**"))
        .unwrap_or_default();

    let valuation_line = match valuation.latest.as_ref() {
        Some(latest) => format!(
            "As of {}, {} closed at {:.2} with ETF/GLD = {:.4} and ETF/SPY = {:.4}, ranking at the **{:.1}th percentile** (**{}** zone{}).",
            latest.date,
            mapping.ticker,
            latest.close_price,
            latest.gold_ratio,
            latest.spy_ratio,
            latest.valuation_percentile,
            valuation.valuation_zone,
            gold_pct_suffix
        ),
        None => format!("No valuation history ingested yet for {}.", mapping.ticker),
    };

    let regime_return_line = match (
        valuation.current_regime.as_deref(),
        valuation.avg_12m_return_in_regime_pct,
    ) {
        (Some(regime), Some(avg_ret)) => format!(
            "Historical forward 12-month return during **{regime}** periods averaged **{avg_ret:+.2}%** (n = {}).",
            valuation.matching_regime_sample_count
        ),
        (Some(regime), None) => format!(
            "Insufficient overlapping forward return observations during **{regime}** periods."
        ),
        (None, _) => "No rate regime history available for conditional return analysis.".to_string(),
    };

    let verdict = match (
        fiscal.fiscal_impulse_label.as_str(),
        valuation.valuation_zone.as_str(),
    ) {
        ("Accelerating", "Cheap") => {
            "Constructive capital-flow alignment: accelerating federal spending meets a historically cheap relative valuation."
        }
        ("Accelerating", "Fair") => {
            "Moderately supportive backdrop: federal spending is accelerating while relative valuation sits near historical norms."
        }
        ("Accelerating", "Expensive") => {
            "Mixed setup: federal spending tailwinds are accelerating, but relative valuation is extended (>75th percentile)."
        }
        ("Contracting", "Cheap") => {
            "Value vs. fiscal headwind: valuation is historically cheap (<25th percentile), though agency budgetary resources are contracting."
        }
        ("Contracting", _) => {
            "Cautious posture: federal budgetary flows are contracting without a cheap relative valuation cushion."
        }
        (_, "Cheap") => {
            "Valuation-led opportunity: relative pricing is in the cheap quartile with neutral federal spending impulse."
        }
        (_, "Expensive") => {
            "Neutral-to-cautious posture: relative valuation is expensive without an accelerating spending impulse."
        }
        _ => "Balanced macro posture: await a clearer inflection in either fiscal impulse or relative valuation.",
    };

    format!(
        "## {} ({}) Macro Capital-Flow Brief\n\n\
         ### 1. Fiscal Spending Impulse ({} / Agency {})\n\
         - {fiscal_line}\n\n\
         ### 2. Monetary & Rate Regime\n\
         - {rate_line}\n\n\
         ### 3. Relative Valuation & Historical Regime Performance\n\
         - {valuation_line}\n\
         - {regime_return_line}\n\n\
         ### 4. Synthesis & Watchpoints\n\
         - {verdict}",
        mapping.sector_name, mapping.ticker, mapping.agency_name, mapping.agency_code
    )
}

fn has_configured_gemini_key() -> Option<String> {
    let key = std::env::var("GEMINI_API_KEY").ok()?;
    let trimmed = key.trim();
    if trimmed.is_empty() || trimmed == "your_key_here" {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// Runs a multi-turn Gemini function-calling loop (up to 6 turns), falling back
/// cleanly to deterministic synthesis when offline or unconfigured.
async fn run_gemini_agent_loop(
    pool: &SqlitePool,
    mapping: &SectorMapping,
    fiscal: &FiscalFlowsReport,
    rates: &RateRegimeReport,
    valuation: &SectorValuationReport,
) -> String {
    let Some(api_key) = has_configured_gemini_key() else {
        return synthesize_deterministic_brief(mapping, fiscal, rates, valuation);
    };

    let system_prompt = format!(
        "You are a disciplined US macro capital-flow analyst evaluating sector ETF {} ({}, mapped to agency {} / {}). \
         Call the read-only SQLite tools `get_fiscal_flows`, `get_rate_regime_history`, `get_sector_valuation`, and `get_regime_analogs` to inspect the exact data. \
         Never invent or extrapolate numbers—only cite figures returned by the tools. \
         Respond with a concise Markdown brief covering Fiscal Spending Impulse (including Z-score), Interest Rate Regime, Relative Valuation Zone, Historical Regime Analogs, and Capital-Flow Verdict.",
        mapping.ticker, mapping.sector_name, mapping.agency_code, mapping.agency_name
    );

    match execute_gemini_turns(pool, &api_key, &system_prompt).await {
        Ok(Some(markdown)) if !markdown.trim().is_empty() => markdown,
        _ => synthesize_deterministic_brief(mapping, fiscal, rates, valuation),
    }
}

async fn execute_gemini_turns(
    pool: &SqlitePool,
    api_key: &str,
    system_prompt: &str,
) -> Result<Option<String>, AgentError> {
    let client = reqwest::Client::new();
    let url = format!("{GEMINI_GENERATE_ENDPOINT}?key={api_key}");
    let tool_declarations = gemini_tool_declarations();

    let mut contents: Vec<Value> = vec![json!({
        "role": "user",
        "parts": [{ "text": system_prompt }]
    })];

    for _turn in 0..MAX_AGENT_TURNS {
        let body = json!({
            "contents": contents,
            "tools": [{
                "functionDeclarations": tool_declarations
            }]
        });

        let response = client.post(&url).json(&body).send().await?.error_for_status()?;
        let payload: Value = response.json().await?;

        let Some(model_content) = payload
            .get("candidates")
            .and_then(Value::as_array)
            .and_then(|arr| arr.first())
            .and_then(|cand| cand.get("content"))
            .cloned()
        else {
            return Ok(None);
        };

        let parts = model_content
            .get("parts")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();

        let function_calls: Vec<(String, Value)> = parts
            .iter()
            .filter_map(|part| {
                let fc = part.get("functionCall")?;
                let name = fc.get("name")?.as_str()?.to_string();
                let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                Some((name, args))
            })
            .collect();

        if function_calls.is_empty() {
            let text = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n");
            return Ok(Some(text));
        }

        contents.push(model_content);

        let mut response_parts = Vec::with_capacity(function_calls.len());
        for (name, args) in function_calls {
            let tool_result = match execute_tool_call(pool, &name, &args).await {
                Ok(val) => json!({ "result": val }),
                Err(err) => json!({ "error": err.to_string() }),
            };
            response_parts.push(json!({
                "functionResponse": {
                    "name": name,
                    "response": tool_result
                }
            }));
        }

        contents.push(json!({
            "role": "user",
            "parts": response_parts
        }));
    }

    Ok(None)
}

/// Fetches a cached analyst brief from SQLite `analyst_briefs`.
pub async fn get_cached_brief(
    pool: &SqlitePool,
    ticker: &str,
) -> Result<Option<AnalystBrief>, AgentError> {
    let mapping = find_sector_mapping(ticker)
        .ok_or_else(|| AgentError::UnknownTicker(ticker.to_string()))?;

    let brief = sqlx::query_as::<_, AnalystBrief>(
        "SELECT ticker, agency_code, regime_label, valuation_zone, summary_markdown, updated_at, regime_match_table
         FROM analyst_briefs
         WHERE ticker = ?",
    )
    .bind(mapping.ticker)
    .fetch_optional(pool)
    .await?;

    Ok(brief)
}

/// Upserts an analyst brief into SQLite `analyst_briefs`.
pub async fn upsert_analyst_brief(
    pool: &SqlitePool,
    brief: &AnalystBrief,
) -> Result<(), AgentError> {
    sqlx::query(
        "INSERT INTO analyst_briefs (
            ticker,
            agency_code,
            regime_label,
            valuation_zone,
            summary_markdown,
            updated_at,
            regime_match_table
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(ticker) DO UPDATE SET
            agency_code = excluded.agency_code,
            regime_label = excluded.regime_label,
            valuation_zone = excluded.valuation_zone,
            summary_markdown = excluded.summary_markdown,
            updated_at = excluded.updated_at,
            regime_match_table = excluded.regime_match_table",
    )
    .bind(&brief.ticker)
    .bind(&brief.agency_code)
    .bind(&brief.regime_label)
    .bind(&brief.valuation_zone)
    .bind(&brief.summary_markdown)
    .bind(&brief.updated_at)
    .bind(&brief.regime_match_table)
    .execute(pool)
    .await?;

    Ok(())
}

/// Runs the analyst agent loop (with deterministic fallback) and caches the result in SQLite.
pub async fn analyze_sector(pool: &SqlitePool, ticker: &str) -> Result<AnalystBrief, AgentError> {
    let mapping = find_sector_mapping(ticker)
        .ok_or_else(|| AgentError::UnknownTicker(ticker.to_string()))?;

    let fiscal = get_fiscal_flows(pool, mapping.agency_code).await?;
    let rates = get_rate_regime_history(pool).await?;
    let valuation = get_sector_valuation(pool, mapping.ticker).await?;
    let analogs = compute_regime_analogs(pool, mapping.ticker).await?;
    let regime_match_table = Some(serde_json::to_string(&analogs)?);

    let summary_markdown =
        run_gemini_agent_loop(pool, mapping, &fiscal, &rates, &valuation).await;

    let regime_label = rates
        .current
        .as_ref()
        .map(|r| r.regime_label.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let brief = AnalystBrief {
        ticker: mapping.ticker.to_string(),
        agency_code: mapping.agency_code.to_string(),
        regime_label,
        valuation_zone: valuation.valuation_zone.clone(),
        summary_markdown,
        updated_at: Utc::now().to_rfc3339(),
        regime_match_table,
    };

    upsert_analyst_brief(pool, &brief).await?;
    Ok(brief)
}

/// Returns the cached brief if present, otherwise generates and caches a fresh brief.
pub async fn get_or_create_brief(
    pool: &SqlitePool,
    ticker: &str,
) -> Result<AnalystBrief, AgentError> {
    if let Some(cached) = get_cached_brief(pool, ticker).await? {
        return Ok(cached);
    }
    analyze_sector(pool, ticker).await
}

/// Deterministically synthesizes a cross-sector capital rotation brief from ranked sector decisions.
pub fn synthesize_deterministic_rotation_brief(
    rankings: &[SectorDecision],
) -> (String, String, String) {
    let Some(top) = rankings.first() else {
        return (
            "N/A".to_string(),
            "N/A".to_string(),
            "## Capital Rotation Brief\n\n- No sector ranking data available yet. Run ingestion first.".to_string(),
        );
    };
    let bottom = rankings.last().unwrap_or(top);

    let format_pct = |val: Option<f64>| -> String {
        val.map(|v| format!("{v:+.2}%"))
            .unwrap_or_else(|| "N/A".to_string())
    };
    let format_z = |val: Option<f64>| -> String {
        val.map(|v| format!("{v:+.2}"))
            .unwrap_or_else(|| "N/A".to_string())
    };
    let format_rank_pct = |val: Option<f64>| -> String {
        val.map(|v| format!("{v:.1}%"))
            .unwrap_or_else(|| "N/A".to_string())
    };

    let leader_lines: Vec<String> = rankings
        .iter()
        .take(3)
        .map(|d| {
            format!(
                "- **#{} {} ({})** — Score **{:.1}/100** (**{}**) | Fiscal Z: `{}` ({}) | Gold %ile: `{}` | Win Rate: `{}`",
                d.rank,
                d.ticker,
                d.sector_name,
                d.conviction_score,
                d.decision_tier,
                format_z(d.fiscal_impulse_zscore),
                d.fiscal_impulse_label,
                format_rank_pct(d.gold_valuation_percentile),
                format_rank_pct(d.win_rate_pct),
            )
        })
        .collect();

    let laggard_line = format!(
        "- **#{} {} ({})** — Score **{:.1}/100** (**{}**) | Fiscal Z: `{}` ({}) | 12M vs SPY: `{}` | Gold %ile: `{}`",
        bottom.rank,
        bottom.ticker,
        bottom.sector_name,
        bottom.conviction_score,
        bottom.decision_tier,
        format_z(bottom.fiscal_impulse_zscore),
        bottom.fiscal_impulse_label,
        format_pct(bottom.avg_12m_vs_spy_pct),
        format_rank_pct(bottom.gold_valuation_percentile),
    );

    let markdown = format!(
        "## Cross-Sector Capital Rotation Brief ({} Regime)\n\n\
         ### 1. Top Allocation Candidates\n\
         {}\n\n\
         ### 2. Primary Underweight / Avoid\n\
         {laggard_line}\n\n\
         ### 3. Capital-Flow Rotation Action\n\
         - Overweight **{} ({})** ({:.1}/100, {}) while underweighting **{} ({})** ({:.1}/100, {}).\n\
         - Top setup combines Fiscal ({:.1}/40), Regime Edge ({:.1}/35), and Gold-Relative Safety ({:.1}/25).",
        top.regime_label,
        leader_lines.join("\n"),
        top.ticker,
        top.sector_name,
        top.conviction_score,
        top.decision_tier,
        bottom.ticker,
        bottom.sector_name,
        bottom.conviction_score,
        bottom.decision_tier,
        top.fiscal_score,
        top.regime_edge_score,
        top.valuation_score,
    );

    (top.ticker.clone(), bottom.ticker.clone(), markdown)
}

/// Fetches the most recent cached rotation brief from `rotation_briefs`.
pub async fn get_cached_rotation_brief(
    pool: &SqlitePool,
) -> Result<Option<RotationBrief>, AgentError> {
    let brief = sqlx::query_as::<_, RotationBrief>(
        "SELECT id, snapshot_date, top_sector, avoid_sector, summary_markdown, updated_at
         FROM rotation_briefs
         ORDER BY snapshot_date DESC, id DESC
         LIMIT 1",
    )
    .fetch_optional(pool)
    .await?;

    Ok(brief)
}

/// Upserts a cross-sector rotation brief into `rotation_briefs` for `snapshot_date`.
pub async fn upsert_rotation_brief(
    pool: &SqlitePool,
    snapshot_date: &str,
    top_sector: &str,
    avoid_sector: &str,
    summary_markdown: &str,
) -> Result<RotationBrief, AgentError> {
    let updated_at = Utc::now().to_rfc3339();
    sqlx::query(
        "INSERT INTO rotation_briefs (
            snapshot_date,
            top_sector,
            avoid_sector,
            summary_markdown,
            updated_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(snapshot_date) DO UPDATE SET
            top_sector = excluded.top_sector,
            avoid_sector = excluded.avoid_sector,
            summary_markdown = excluded.summary_markdown,
            updated_at = excluded.updated_at",
    )
    .bind(snapshot_date)
    .bind(top_sector)
    .bind(avoid_sector)
    .bind(summary_markdown)
    .bind(&updated_at)
    .execute(pool)
    .await?;

    let saved = sqlx::query_as::<_, RotationBrief>(
        "SELECT id, snapshot_date, top_sector, avoid_sector, summary_markdown, updated_at
         FROM rotation_briefs
         WHERE snapshot_date = ?",
    )
    .bind(snapshot_date)
    .fetch_one(pool)
    .await?;

    Ok(saved)
}

/// Returns a cached rotation brief immediately, or generates and persists a deterministic one
/// without blocking on Gemini.
pub async fn get_or_synthesize_rotation_brief(
    pool: &SqlitePool,
    rankings: &[SectorDecision],
) -> Result<RotationBrief, AgentError> {
    if let Some(cached) = get_cached_rotation_brief(pool).await? {
        return Ok(cached);
    }

    let snapshot_date = Utc::now().format("%Y-%m-%d").to_string();
    let (top_sector, avoid_sector, summary_markdown) =
        synthesize_deterministic_rotation_brief(rankings);

    upsert_rotation_brief(
        pool,
        &snapshot_date,
        &top_sector,
        &avoid_sector,
        &summary_markdown,
    )
    .await
}

/// Runs a multi-turn Gemini rotation analysis loop (with immediate deterministic fallback)
/// and caches the resulting brief in `rotation_briefs`.
pub async fn analyze_rotation(pool: &SqlitePool) -> Result<RotationBrief, AgentError> {
    let rankings = compute_sector_rankings(pool).await?;
    let snapshot_date = Utc::now().format("%Y-%m-%d").to_string();
    let (top_sector, avoid_sector, deterministic_markdown) =
        synthesize_deterministic_rotation_brief(&rankings);

    let summary_markdown = match has_configured_gemini_key() {
        Some(api_key) => {
            let prompt = "You are a senior US macro capital-flow strategist. \
                Call `get_sector_rankings` and `get_rate_regime_history` to inspect all 6 sectors (#1-#6 conviction scores, decision tiers, fiscal Z-scores, historical regime edge, and Gold-relative valuations). \
                Optionally call `get_regime_analogs` for the #1 and #6 sectors. \
                Never invent or extrapolate numbers—only cite figures returned by the tools. \
                Write a concise Markdown Capital Rotation Brief covering Top Overweight Candidates, Underweight/Avoid Sectors, and Concrete Rotation Positioning.";
            match execute_gemini_turns(pool, &api_key, prompt).await {
                Ok(Some(md)) if !md.trim().is_empty() => md,
                _ => deterministic_markdown,
            }
        }
        None => deterministic_markdown,
    };

    upsert_rotation_brief(
        pool,
        &snapshot_date,
        &top_sector,
        &avoid_sector,
        &summary_markdown,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::super::tools::test_fixtures::seed_sample_macro_data;
    use super::*;
    use crate::db::init_db;

    #[tokio::test]
    async fn test_deterministic_brief_and_sqlite_cache() {
        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");
        seed_sample_macro_data(&pool).await;

        assert!(get_cached_brief(&pool, "ITA")
            .await
            .expect("cache check failed")
            .is_none());

        let created = get_or_create_brief(&pool, "ITA")
            .await
            .expect("get_or_create_brief failed");
        assert_eq!(created.ticker, "ITA");
        assert_eq!(created.agency_code, "097");
        assert_eq!(created.regime_label, "High-Pause");
        assert_eq!(created.valuation_zone, "Cheap");
        assert!(created.summary_markdown.contains("Defense (ITA)"));
        assert!(created.summary_markdown.contains("Accelerating"));
        let stored_table = created
            .regime_match_table
            .as_deref()
            .expect("regime_match_table cached");
        let parsed_analogs: super::super::tools::RegimeAnalogsReport =
            serde_json::from_str(stored_table).expect("valid regime_match_table json");
        assert_eq!(parsed_analogs.ticker, "ITA");
        assert_eq!(parsed_analogs.analogs.len(), 1);

        let cached = get_or_create_brief(&pool, "ITA")
            .await
            .expect("cached retrieval failed");
        assert_eq!(cached.updated_at, created.updated_at);
        assert_eq!(cached.summary_markdown, created.summary_markdown);

        let refreshed = analyze_sector(&pool, "ita")
            .await
            .expect("forced analyze_sector failed");
        assert_eq!(refreshed.ticker, "ITA");
        assert_eq!(refreshed.valuation_zone, "Cheap");

        let rankings = compute_sector_rankings(&pool)
            .await
            .expect("compute_sector_rankings failed");
        let brief = get_or_synthesize_rotation_brief(&pool, &rankings)
            .await
            .expect("get_or_synthesize_rotation_brief failed");
        assert_eq!(brief.top_sector, rankings[0].ticker);
        assert_eq!(brief.avoid_sector, rankings.last().unwrap().ticker);
        assert!(brief.summary_markdown.contains("Capital Rotation Brief"));

        let cached_rot = get_or_synthesize_rotation_brief(&pool, &rankings)
            .await
            .expect("cached rotation brief failed");
        assert_eq!(cached_rot.updated_at, brief.updated_at);

        let analyzed_rot = analyze_rotation(&pool)
            .await
            .expect("analyze_rotation failed");
        assert_eq!(analyzed_rot.top_sector, rankings[0].ticker);
    }
}
