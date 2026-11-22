CREATE TABLE IF NOT EXISTS fiscal_spending (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agency_code TEXT NOT NULL,
    agency_name TEXT NOT NULL,
    fiscal_year INTEGER NOT NULL,
    budgetary_resources REAL NOT NULL,
    obligations REAL NOT NULL,
    yoy_growth_pct REAL,
    UNIQUE(agency_code, fiscal_year)
);

CREATE TABLE IF NOT EXISTS macro_rates (
    date TEXT PRIMARY KEY NOT NULL,
    fed_funds REAL NOT NULL,
    dgs10 REAL NOT NULL,
    yield_spread REAL NOT NULL,
    regime_label TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sector_valuations (
    ticker TEXT NOT NULL,
    sector_name TEXT NOT NULL,
    date TEXT NOT NULL,
    close_price REAL NOT NULL,
    gold_ratio REAL NOT NULL,
    spy_ratio REAL NOT NULL,
    valuation_percentile REAL NOT NULL,
    PRIMARY KEY (ticker, date)
);
