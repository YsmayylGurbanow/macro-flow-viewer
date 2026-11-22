CREATE TABLE IF NOT EXISTS gold_secular_ratios (
    asset_key TEXT NOT NULL,
    asset_name TEXT NOT NULL,
    unit_label TEXT NOT NULL,
    date TEXT NOT NULL,
    asset_value_usd REAL NOT NULL,
    gold_price_usd REAL NOT NULL,
    ratio_in_gold REAL NOT NULL,
    secular_percentile REAL NOT NULL,
    PRIMARY KEY (asset_key, date)
);
