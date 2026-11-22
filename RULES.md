# Project Rules & Constraints (STRICT)

1. **Tech Stack Lock:**
   - Backend & Data Pipeline: Rust ONLY (2021 edition, `tokio`, `axum`, `sqlx` with SQLite, `reqwest`, `serde`, `dotenvy`, `thiserror`, `rig-core`).
   - Frontend (Phase 4): TypeScript + Next.js + TailwindCSS.
   - NO Python, NO Go, NO Flutter/mobile apps, NO external Postgres/Docker servers.
2. **Verification Gate:**
   - No task in `tasks.md` may be marked `[x]` until `./verify.sh` passes with zero errors and zero clippy warnings.
3. **Architecture Boundary:**
   - All financial math, YoY spending changes, and historical percentile ranks MUST be calculated deterministically in Rust—never inside an LLM prompt.
   - No authentication, user accounts, or admin panels in MVP v1.