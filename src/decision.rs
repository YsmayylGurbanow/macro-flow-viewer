use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::SqlitePool;

use crate::agent::tools::{
    compute_regime_analogs, get_fiscal_flows, get_rate_regime_history, get_sector_valuation,
    SECTOR_MAPPINGS,
};
use crate::agent::AgentError;

/// Inputs used to compute a deterministic 3-pillar Conviction Score (0–100) for a sector ETF.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SectorSignalInputs {
    /// Trailing 5-year fiscal spending impulse Z-score.
    pub fiscal_impulse_zscore: Option<f64>,
    /// Historical win rate (%) during matching rate regime windows.
    pub win_rate_pct: Option<f64>,
    /// Mean 12-month forward excess return (%) vs. SPY in matching regime windows.
    pub avg_12m_vs_spy_pct: Option<f64>,
    /// Mean 12-month forward excess return (%) vs. GLD in matching regime windows.
    pub avg_12m_vs_gld_pct: Option<f64>,
    /// 10-year historical valuation percentile of `ETF / GLD` (0.0–100.0).
    pub gold_valuation_percentile: Option<f64>,
}

/// Deterministic pillar breakdown and tier classification returned by `score_sector`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SectorScoreBreakdown {
    /// Fiscal impulse pillar score (0.0–40.0 pts).
    pub fiscal_score: f64,
    /// Historical regime edge pillar score (0.0–35.0 pts).
    pub regime_edge_score: f64,
    /// Valuation margin of safety pillar score (0.0–25.0 pts).
    pub valuation_score: f64,
    /// Total Conviction Score (0.0–100.0 pts).
    pub conviction_score: f64,
    /// Quadrant tier (`High Conviction`, `Crowded Momentum`, `Value Trap`, or `Avoid`).
    pub decision_tier: &'static str,
}

/// Ranked sector decision record exposed by `GET /api/decisions` and agent tools.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SectorDecision {
    /// Leaderboard rank (1 = highest conviction, 6 = lowest).
    pub rank: usize,
    /// Sector ETF ticker symbol.
    pub ticker: String,
    /// Human-readable sector name.
    pub sector_name: String,
    /// Mapped federal agency code.
    pub agency_code: String,
    /// Mapped federal agency display name.
    pub agency_name: String,
    /// Total Conviction Score (0.0–100.0).
    pub conviction_score: f64,
    /// Deterministic decision tier (`High Conviction`, `Crowded Momentum`, `Value Trap`, `Avoid`).
    pub decision_tier: String,
    /// Fiscal Impulse pillar contribution (0.0–40.0).
    pub fiscal_score: f64,
    /// Historical Regime Edge pillar contribution (0.0–35.0).
    pub regime_edge_score: f64,
    /// Valuation Margin of Safety pillar contribution (0.0–25.0).
    pub valuation_score: f64,
    /// Latest trailing 5-year fiscal impulse Z-score.
    pub fiscal_impulse_zscore: Option<f64>,
    /// Fiscal impulse classification (`Accelerating`, `Neutral`, or `Contracting`).
    pub fiscal_impulse_label: String,
    /// Latest agency budgetary resources YoY growth (%).
    pub latest_yoy_growth_pct: Option<f64>,
    /// Current monetary rate regime label.
    pub regime_label: String,
    /// Historical win rate (%) in matching rate regime windows.
    pub win_rate_pct: Option<f64>,
    /// Mean 12-month forward excess return (%) vs. SPY in matching regime windows.
    pub avg_12m_vs_spy_pct: Option<f64>,
    /// Mean 12-month forward excess return (%) vs. GLD in matching regime windows.
    pub avg_12m_vs_gld_pct: Option<f64>,
    /// 10-year `ETF / GLD` valuation percentile (0.0–100.0).
    pub gold_valuation_percentile: Option<f64>,
    /// Valuation zone (`Cheap`, `Fair`, `Expensive`, or `Unknown`).
    pub valuation_zone: String,
    /// Latest monthly close price of the sector ETF.
    pub etf_close: Option<f64>,
}

/// Persisted snapshot row from `signal_snapshots`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, PartialEq)]
pub struct SignalSnapshotRow {
    /// Auto-increment row ID.
    pub id: i64,
    /// Snapshot date (`YYYY-MM-DD`).
    pub snapshot_date: String,
    /// Sector ETF ticker symbol.
    pub ticker: String,
    /// Conviction Score (0.0–100.0) recorded on `snapshot_date`.
    pub conviction_score: f64,
    /// Decision tier recorded on `snapshot_date`.
    pub decision_tier: String,
    /// Fiscal impulse Z-score recorded on `snapshot_date`.
    pub fiscal_impulse_zscore: Option<f64>,
    /// Rate regime label recorded on `snapshot_date`.
    pub regime_label: String,
    /// Gold-relative valuation percentile recorded on `snapshot_date`.
    pub gold_valuation_percentile: Option<f64>,
    /// Sector ETF close price recorded on `snapshot_date`.
    pub etf_close: Option<f64>,
}

/// Cached cross-sector capital rotation brief stored in `rotation_briefs`.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, PartialEq)]
pub struct RotationBrief {
    /// Auto-increment row ID.
    pub id: i64,
    /// Snapshot date (`YYYY-MM-DD`).
    pub snapshot_date: String,
    /// Top-ranked sector ticker.
    pub top_sector: String,
    /// Lowest-ranked / avoid sector ticker.
    pub avoid_sector: String,
    /// Concise Markdown capital rotation synthesis.
    pub summary_markdown: String,
    /// UTC RFC3339 generation timestamp.
    pub updated_at: String,
}

/// Deterministically scores a sector across Fiscal Impulse (0–40), Regime Edge (0–35),
/// and Valuation Margin of Safety (0–25), classifying it into one of 4 decision quadrants.
pub fn score_sector(inputs: &SectorSignalInputs) -> SectorScoreBreakdown {
    let fiscal_score = match inputs.fiscal_impulse_zscore.filter(|z| z.is_finite()) {
        Some(z) => ((z.clamp(-2.0, 2.0) + 2.0) / 4.0) * 40.0,
        None => 20.0,
    };

    let win_pts = match inputs.win_rate_pct.filter(|w| w.is_finite()) {
        Some(w) => (w.clamp(0.0, 100.0) / 100.0) * 20.0,
        None => 10.0,
    };

    let mut excess_sum = 0.0_f64;
    let mut excess_count = 0_usize;
    if let Some(spy) = inputs.avg_12m_vs_spy_pct.filter(|v| v.is_finite()) {
        excess_sum += spy;
        excess_count += 1;
    }
    if let Some(gld) = inputs.avg_12m_vs_gld_pct.filter(|v| v.is_finite()) {
        excess_sum += gld;
        excess_count += 1;
    }
    let excess_pts = if excess_count > 0 {
        let mean_excess = excess_sum / (excess_count as f64);
        ((mean_excess.clamp(-20.0, 20.0) + 20.0) / 40.0) * 15.0
    } else {
        7.5
    };
    let regime_edge_score = (win_pts + excess_pts).clamp(0.0, 35.0);

    let valuation_score = match inputs.gold_valuation_percentile.filter(|p| p.is_finite()) {
        Some(p) if p <= 25.0 => 25.0,
        Some(p) if p >= 75.0 => 0.0,
        Some(p) => ((75.0 - p) / 50.0) * 25.0,
        None => 12.5,
    };

    let conviction_score = (fiscal_score + regime_edge_score + valuation_score).clamp(0.0, 100.0);

    // Tailwind requires combined Fiscal + Regime Edge at or above neutral midpoint (37.5 / 75).
    let is_tailwind = (fiscal_score + regime_edge_score) >= 37.5;
    let effective_pct = inputs
        .gold_valuation_percentile
        .filter(|p| p.is_finite())
        .unwrap_or(50.0);

    let decision_tier = match (is_tailwind, effective_pct) {
        (true, p) if p > 75.0 => "Crowded Momentum",
        (true, _) => "High Conviction",
        (false, p) if p < 25.0 => "Value Trap",
        (false, _) => "Avoid",
    };

    SectorScoreBreakdown {
        fiscal_score,
        regime_edge_score,
        valuation_score,
        conviction_score,
        decision_tier,
    }
}

/// Computes deterministic Conviction Scores and ranks all 6 sectors `#1` through `#6`.
pub async fn compute_sector_rankings(pool: &SqlitePool) -> Result<Vec<SectorDecision>, AgentError> {
    let rates = get_rate_regime_history(pool).await?;
    let current_regime = rates
        .current
        .as_ref()
        .map(|r| r.regime_label.clone())
        .unwrap_or_else(|| "Unknown".to_string());

    let mut decisions = Vec::with_capacity(SECTOR_MAPPINGS.len());

    for mapping in SECTOR_MAPPINGS {
        let fiscal = get_fiscal_flows(pool, mapping.agency_code).await?;
        let valuation = get_sector_valuation(pool, mapping.ticker).await?;
        let analogs = compute_regime_analogs(pool, mapping.ticker).await?;

        let gold_pct = valuation
            .gold_valuation_percentile
            .or_else(|| valuation.latest.as_ref().map(|v| v.valuation_percentile));

        let breakdown = score_sector(&SectorSignalInputs {
            fiscal_impulse_zscore: fiscal.fiscal_impulse_zscore,
            win_rate_pct: analogs.win_rate_pct,
            avg_12m_vs_spy_pct: analogs.avg_12m_vs_spy_pct,
            avg_12m_vs_gld_pct: analogs.avg_12m_vs_gld_pct,
            gold_valuation_percentile: gold_pct,
        });

        decisions.push(SectorDecision {
            rank: 0,
            ticker: mapping.ticker.to_string(),
            sector_name: mapping.sector_name.to_string(),
            agency_code: mapping.agency_code.to_string(),
            agency_name: mapping.agency_name.to_string(),
            conviction_score: breakdown.conviction_score,
            decision_tier: breakdown.decision_tier.to_string(),
            fiscal_score: breakdown.fiscal_score,
            regime_edge_score: breakdown.regime_edge_score,
            valuation_score: breakdown.valuation_score,
            fiscal_impulse_zscore: fiscal.fiscal_impulse_zscore,
            fiscal_impulse_label: fiscal.fiscal_impulse_label,
            latest_yoy_growth_pct: fiscal.latest_yoy_growth_pct,
            regime_label: current_regime.clone(),
            win_rate_pct: analogs.win_rate_pct,
            avg_12m_vs_spy_pct: analogs.avg_12m_vs_spy_pct,
            avg_12m_vs_gld_pct: analogs.avg_12m_vs_gld_pct,
            gold_valuation_percentile: gold_pct,
            valuation_zone: valuation.valuation_zone,
            etf_close: valuation.latest.as_ref().map(|v| v.close_price),
        });
    }

    decisions.sort_by(|a, b| {
        b.conviction_score
            .total_cmp(&a.conviction_score)
            .then_with(|| a.ticker.cmp(&b.ticker))
    });

    for (idx, item) in decisions.iter_mut().enumerate() {
        item.rank = idx + 1;
    }

    Ok(decisions)
}

/// Computes current sector rankings and upserts them into `signal_snapshots` for today's date.
pub async fn record_signal_snapshots(pool: &SqlitePool) -> Result<Vec<SectorDecision>, AgentError> {
    let rankings = compute_sector_rankings(pool).await?;
    let snapshot_date = Utc::now().format("%Y-%m-%d").to_string();

    let mut tx = pool.begin().await?;
    for decision in &rankings {
        sqlx::query(
            "INSERT INTO signal_snapshots (
                snapshot_date,
                ticker,
                conviction_score,
                decision_tier,
                fiscal_impulse_zscore,
                regime_label,
                gold_valuation_percentile,
                etf_close
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(snapshot_date, ticker) DO UPDATE SET
                conviction_score = excluded.conviction_score,
                decision_tier = excluded.decision_tier,
                fiscal_impulse_zscore = excluded.fiscal_impulse_zscore,
                regime_label = excluded.regime_label,
                gold_valuation_percentile = excluded.gold_valuation_percentile,
                etf_close = excluded.etf_close",
        )
        .bind(&snapshot_date)
        .bind(&decision.ticker)
        .bind(decision.conviction_score)
        .bind(&decision.decision_tier)
        .bind(decision.fiscal_impulse_zscore)
        .bind(&decision.regime_label)
        .bind(decision.gold_valuation_percentile)
        .bind(decision.etf_close)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;

    Ok(rankings)
}

/// Loads recent historical signal snapshots ordered newest-first, then highest conviction score.
pub async fn load_recent_signal_snapshots(
    pool: &SqlitePool,
    limit: i64,
) -> Result<Vec<SignalSnapshotRow>, sqlx::Error> {
    sqlx::query_as::<_, SignalSnapshotRow>(
        "SELECT id, snapshot_date, ticker, conviction_score, decision_tier, fiscal_impulse_zscore, regime_label, gold_valuation_percentile, etf_close
         FROM signal_snapshots
         ORDER BY snapshot_date DESC, conviction_score DESC, ticker ASC
         LIMIT ?",
    )
    .bind(limit)
    .fetch_all(pool)
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent::tools::test_fixtures::seed_sample_macro_data;
    use crate::db::init_db;

    #[test]
    fn test_decision_scoring_all_four_quadrants() {
        // 1. High Conviction: strong fiscal Z (+2.0 -> 40), strong regime edge (100% win -> 20, +20% excess -> 15 = 35), cheap valuation (10% -> 25) = 100
        let high = score_sector(&SectorSignalInputs {
            fiscal_impulse_zscore: Some(2.0),
            win_rate_pct: Some(100.0),
            avg_12m_vs_spy_pct: Some(20.0),
            avg_12m_vs_gld_pct: Some(20.0),
            gold_valuation_percentile: Some(10.0),
        });
        assert!((high.fiscal_score - 40.0).abs() < 1e-9);
        assert!((high.regime_edge_score - 35.0).abs() < 1e-9);
        assert!((high.valuation_score - 25.0).abs() < 1e-9);
        assert!((high.conviction_score - 100.0).abs() < 1e-9);
        assert_eq!(high.decision_tier, "High Conviction");

        // 2. Crowded Momentum: tailwind + expensive (> 75th percentile -> 0 valuation pts)
        let crowded = score_sector(&SectorSignalInputs {
            fiscal_impulse_zscore: Some(1.5),
            win_rate_pct: Some(80.0),
            avg_12m_vs_spy_pct: Some(10.0),
            avg_12m_vs_gld_pct: Some(5.0),
            gold_valuation_percentile: Some(90.0),
        });
        assert!(crowded.fiscal_score + crowded.regime_edge_score >= 37.5);
        assert!((crowded.valuation_score - 0.0).abs() < 1e-9);
        assert_eq!(crowded.decision_tier, "Crowded Momentum");

        // 3. Value Trap: headwind (-1.5 Z -> 5 pts, 25% win -> 5, -10% excess -> 3.75 => 13.75 < 37.5) + cheap (< 25%)
        let trap = score_sector(&SectorSignalInputs {
            fiscal_impulse_zscore: Some(-1.5),
            win_rate_pct: Some(25.0),
            avg_12m_vs_spy_pct: Some(-10.0),
            avg_12m_vs_gld_pct: Some(-10.0),
            gold_valuation_percentile: Some(15.0),
        });
        assert!(trap.fiscal_score + trap.regime_edge_score < 37.5);
        assert!((trap.valuation_score - 25.0).abs() < 1e-9);
        assert_eq!(trap.decision_tier, "Value Trap");

        // 4. Avoid: headwind + expensive (> 75%) or fair (>= 25%)
        let avoid = score_sector(&SectorSignalInputs {
            fiscal_impulse_zscore: Some(-2.0),
            win_rate_pct: Some(0.0),
            avg_12m_vs_spy_pct: Some(-20.0),
            avg_12m_vs_gld_pct: Some(-20.0),
            gold_valuation_percentile: Some(85.0),
        });
        assert!((avoid.conviction_score - 0.0).abs() < 1e-9);
        assert_eq!(avoid.decision_tier, "Avoid");

        // Fair valuation (50th percentile) gives midpoint 12.5 pts
        let fair_avoid = score_sector(&SectorSignalInputs {
            fiscal_impulse_zscore: Some(-1.0),
            win_rate_pct: Some(20.0),
            avg_12m_vs_spy_pct: Some(-10.0),
            avg_12m_vs_gld_pct: Some(-10.0),
            gold_valuation_percentile: Some(50.0),
        });
        assert!((fair_avoid.valuation_score - 12.5).abs() < 1e-9);
        assert_eq!(fair_avoid.decision_tier, "Avoid");
    }

    #[tokio::test]
    async fn test_compute_sector_rankings_and_snapshot_logging() {
        let pool = init_db("sqlite::memory:")
            .await
            .expect("in-memory db init failed");
        seed_sample_macro_data(&pool).await;

        // Differentiate agency 089 (XLE) into a fiscal contraction so rankings spread across tiers.
        sqlx::query(
            "UPDATE fiscal_spending SET yoy_growth_pct = -15.0 WHERE agency_code = '089' AND fiscal_year = 2024",
        )
        .execute(&pool)
        .await
        .expect("update 089 failed");

        // Record snapshots twice on the same date to verify idempotent upsert.
        let first_run = record_signal_snapshots(&pool)
            .await
            .expect("first record_signal_snapshots failed");
        let second_run = record_signal_snapshots(&pool)
            .await
            .expect("second record_signal_snapshots failed");

        assert_eq!(first_run.len(), 6);
        assert_eq!(second_run.len(), 6);
        for (i, d) in second_run.iter().enumerate() {
            assert_eq!(d.rank, i + 1);
        }
        // XLE with negative fiscal Z-score should rank last beneath accelerating sectors.
        assert_eq!(second_run.last().unwrap().ticker, "XLE");
        assert!(second_run[0].conviction_score > second_run.last().unwrap().conviction_score);

        let snapshots = load_recent_signal_snapshots(&pool, 20)
            .await
            .expect("load_recent_signal_snapshots failed");
        assert_eq!(snapshots.len(), 6);
    }
}
