# US Macro Capital-Flow MVP - Execution Tasks

## Phase 1: Core Workspace & SQLite Database (Rust)
- [x] Task 1.1: Initialize Cargo binary project (`cargo init`) with dependencies: `tokio`, `axum`, `sqlx` (runtime-tokio, sqlite, chrono), `reqwest` (json), `serde` (derive), `serde_json`, `dotenvy`, `thiserror`, `chrono`.
- [x] Task 1.2: Create `.env.example` with placeholders `FRED_API_KEY=your_key_here` and `GEMINI_API_KEY=your_key_here`, plus `DATABASE_URL=sqlite:macro_data.db`.
- [x] Task 1.3: Create `migrations/001_init.sql` with 3 tables:
  - `fiscal_spending` (id, agency_code, agency_name, fiscal_year, budgetary_resources, obligations, yoy_growth_pct)
  - `macro_rates` (date, fed_funds, dgs10, yield_spread, regime_label)
  - `sector_valuations` (ticker, sector_name, date, close_price, gold_ratio, spy_ratio, valuation_percentile)
- [x] Task 1.4: Create `src/db.rs` to initialize the SQLite pool, auto-run migrations on startup, and pass a unit test (`test_db_init`) using an in-memory SQLite database.

## Phase 2: Data Ingestion Pipelines (Rust)
- [x] Task 2.1: Implement `src/ingest/usaspending.rs` to fetch 10 years of budgetary resources from `api.usaspending.gov` for Defense (`097`), Energy (`089`), HHS (`075`), and Transportation (`069`), calculating YoY % change.
- [x] Task 2.2: Implement `src/ingest/fred.rs` to fetch `FEDFUNDS` and `DGS10` and classify each period into a Rate Regime (`Hiking`, `Cutting`, `High-Pause`, `Low-Pause`).
- [x] Task 2.3: Implement `src/ingest/market.rs` to fetch historical prices for `ITA`, `XLE`, `XLV`, `IYT`, `SPY`, and `GLD`, computing `ETF/GLD` and `ETF/SPY` percentile ranks (`<25%` = Cheap, `>75%` = Expensive).

## Phase 3: Macro Analyst Agent Loop & API (Rust)
- [x] Task 3.1: Add `rig-core` and create `src/agent/tools.rs` exposing read-only SQLite query tools (`get_fiscal_flows`, `get_rate_regime_history`, `get_sector_valuation`).
- [x] Task 3.2: Create `src/agent/analyst.rs` running a multi-turn Gemini agent loop that cross-references spending impulse + rate regime + historical valuation and caches the structured JSON brief in SQLite.
- [x] Task 3.3: Expose `GET /api/sectors/:ticker` in `axum` returning historical time-series data + the cached analyst brief.

## Phase 4: Single-Screen Web Dashboard (TypeScript)
- [x] Task 4.1: Scaffold `/web` with Next.js + TailwindCSS.
- [x] Task 4.2: Build the Decision Panel UI: Sector selector, Spending vs. ETF chart, Rate Regime timeline, and Cheap/Expensive valuation gauge.

## Phase 5: High-Frequency Fiscal Impulse & Signal Math (Rust)
- [x] Task 5.1: Create `migrations/003_signal_upgrade.sql` adding `fiscal_impulse_zscore` (trailing 5-year Z-score of YoY spending growth), `fiscal_impulse_label`, and `regime_match_table` JSON storage.
- [x] Task 5.2: Upgrade `src/ingest/usaspending.rs` and `src/agent/tools.rs` to compute `fiscal_impulse_zscore` (`(Current YoY % - Trailing 5Y Avg YoY %) / StdDev`) and label it `Accelerating` (`> 0.5`), `Neutral` (`-0.5` to `0.5`), or `Contracting` (`< -0.5`).
- [x] Task 5.3: Expand sector mapping in `src/ingest/` and `src/agent/tools.rs` from 4 to 6 sectors by adding `XLK` -> `013` (Department of Commerce) and `PAVE` -> `069` (Transportation/Infrastructure alongside `IYT`) with full unit test coverage.

## Phase 6: Historical Regime Backtest Matrix (Rust + Next.js)
- [x] Task 6.1: Create a deterministic Rust function `compute_regime_analogs(pool, ticker)` in `src/agent/tools.rs` that finds historical windows sharing the current Rate Regime and returns exact 6M and 12M forward returns for the ETF, ETF vs. SPY, and ETF vs. GLD, plus historical win rate and fiscal-direction match indicator.
- [x] Task 6.2: Expose `regime_analogs`, `fiscal_impulse_zscore`, and `gold_valuation_percentile` in `GET /api/sectors/:ticker` (and Z-score in `GET /api/sectors`) and render a high-contrast **"Historical Regime Analogs"** table in `web/src/app/page.tsx`.
- [x] Task 6.3: Add a **"Copy Macro Brief for X/Telegram"** 1-click social export button in `web/src/app/page.tsx` that copies a formatted 5-line summary (Sector, Fiscal Impulse, Rate Regime, Valuation Percentile vs Gold, and Historical Win Rate) to the clipboard.
## Phase 7: 55-Year "Assets vs. Gold" Secular Data Engine (Rust)
- [x] Task 7.1: Create `migrations/004_secular_gold.sql` adding `gold_secular_ratios` (`asset_key`, `asset_name`, `unit_label`, `date`, `asset_value_usd`, `gold_price_usd`, `ratio_in_gold`, `secular_percentile`, PRIMARY KEY(asset_key, date)).
- [x] Task 7.2: Create `src/ingest/secular_gold.rs` to build a continuous **1970–Present** monthly Gold USD series (fetching Stooq `xauusd` monthly CSV and/or splicing an embedded verified 1970–2004 monthly Gold baseline with live Yahoo Finance `GC=F` monthly prices from 2004–present).
- [x] Task 7.3: Ingest 50–60 year historical series and compute each asset priced in Gold:
  - `USD_GOLD`: **US Dollar vs. Gold** (Purchasing power of $1,000 in ounces of Gold, 1970–present).
  - `GBP_GOLD`: **British Pound vs. Gold** (FRED `DEXUSUK` monthly back to 1971, purchasing power of £1,000 in oz of Gold).
  - `CASH_FUND_GOLD`: **US Cash / Fed Funds vs. Gold** ($1,000 compounded monthly at FRED `FEDFUNDS` rate since 1970, priced in oz of Gold).
  - `SP500_GOLD`: **S&P 500 vs. Gold** (Yahoo Finance `^GSPC` `period1=0&interval=1mo` back to 1970, index points per oz of Gold).
  - `NASDAQ_GOLD`: **Nasdaq vs. Gold** (Yahoo Finance `^NDX` Nasdaq-100 back to 1985 + `^IXIC` Nasdaq Composite back to 1971, index points per oz of Gold).
  - `HOUSING_GOLD`: **US Real Estate (Houses) vs. Gold** (FRED `MSPUS` Median Sales Price of US Houses Sold back to 1970, measured in **ounces of Gold to buy 1 median US house**).
- [x] Task 7.4: Compute deterministic 55-year stats per asset (current ratio, secular percentile `0–100%`, all-time high/low in Gold with dates, and 50-year mean) and expose `GET /api/vs-gold` in `src/api.rs`.

## Phase 8: Cross-Sector Decision Engine & Clean Multi-Panel UI (Rust + Next.js)
- [x] Task 8.1: Create `migrations/005_decision_engine.sql` (`signal_snapshots`, `rotation_briefs`) and `src/decision.rs` computing a deterministic **Conviction Score (0–100)** and `decision_tier` (`High Conviction`, `Crowded Momentum`, `Value Trap`, `Avoid`) for all 6 sectors, exposed via `GET /api/decisions` and `POST /api/decisions/analyze`.
- [x] Task 8.2: Refactor `/web` into a **clean, organized multi-panel navigation layout** (`web/src/components/Navbar.tsx`) separating the app into 3 uncluttered pages:
  - `/vs-gold` (**Assets vs. Gold Panel**): Displays ONLY macro assets vs. Gold. Each asset (`USD`, `GBP`, `Cash/Fed Funds`, `S&P 500`, `Nasdaq-100`, `US Real Estate`) renders in its **own separate card with its own dedicated Recharts graph**, `10Y / 25Y / 55Y (Max)` timeframe toggle, secular percentile badge (`Historically Cheap` / `Normal` / `Expensive` in Gold), and key peak/trough callouts.
  - `/sectors` (**Fiscal & Sector Flows Panel**): Clean dedicated view for the 6 US sector ETFs, Fiscal Impulse Z-score, Rate Regimes, and Historical Analogs table.
  - `/` (**Decision Engine Panel**): Clean top-level Conviction Leaderboard ranking the 6 sectors #1–#6 + AI Rotation Brief + quick summary cards linking into `/vs-gold` and `/sectors`.

## Phase 9: Production Packaging, Auto-Refresh & Single-Container Deployment
- [x] Task 9.1: Add `GET /api/health` (`last_market_date`, `last_fiscal_year`, `sectors_count`, `secular_gold_assets_count`), bind Axum to `0.0.0.0:{PORT}` (default `8080`), and add a 24-hour background `tokio::spawn` refresh task in `src/main.rs`.
- [x] Task 9.2: Add `tower-http` (`fs` feature), configure Next.js static export (`output: "export"`, `trailingSlash: true`, `images: { unoptimized: true }`), update `/web` API fetches to same-origin `/api/...` in production, add a `"Synced: {last_market_date}"` badge in `Navbar.tsx`, and serve `web/out` from Axum on `/`.
- [x] Task 9.3: Create a multi-stage `Dockerfile` (Node 20 → Rust release → `debian:bookworm-slim` with `ca-certificates`) and `.dockerignore`, verifying `GET /api/health` test, `./verify.sh`, and `npm.cmd run build` (`web/out/index.html`, `web/out/vs-gold/index.html`, `web/out/sectors/index.html`).