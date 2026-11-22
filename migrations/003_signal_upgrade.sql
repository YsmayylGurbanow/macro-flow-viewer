ALTER TABLE fiscal_spending ADD COLUMN fiscal_impulse_zscore REAL;
ALTER TABLE fiscal_spending ADD COLUMN fiscal_impulse_label TEXT;

ALTER TABLE analyst_briefs ADD COLUMN regime_match_table TEXT;
