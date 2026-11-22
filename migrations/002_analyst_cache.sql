CREATE TABLE IF NOT EXISTS analyst_briefs (
    ticker TEXT PRIMARY KEY,
    agency_code TEXT NOT NULL,
    regime_label TEXT NOT NULL,
    valuation_zone TEXT NOT NULL,
    summary_markdown TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
