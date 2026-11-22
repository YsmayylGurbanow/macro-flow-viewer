CREATE TABLE IF NOT EXISTS signal_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL,
    ticker TEXT NOT NULL,
    conviction_score REAL NOT NULL,
    decision_tier TEXT NOT NULL,
    fiscal_impulse_zscore REAL,
    regime_label TEXT NOT NULL,
    gold_valuation_percentile REAL,
    etf_close REAL,
    UNIQUE(snapshot_date, ticker)
);

CREATE TABLE IF NOT EXISTS rotation_briefs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    snapshot_date TEXT NOT NULL UNIQUE,
    top_sector TEXT NOT NULL,
    avoid_sector TEXT NOT NULL,
    summary_markdown TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
