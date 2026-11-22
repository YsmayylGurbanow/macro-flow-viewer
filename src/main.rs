pub mod agent;
pub mod api;
pub mod db;
pub mod decision;
pub mod ingest;

async fn needs_initial_ingest(pool: &sqlx::SqlitePool) -> Result<bool, sqlx::Error> {
    let fiscal_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM fiscal_spending")
        .fetch_one(pool)
        .await?;
    let rates_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM macro_rates")
        .fetch_one(pool)
        .await?;
    let valuations_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sector_valuations")
        .fetch_one(pool)
        .await?;
    let secular_gold_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM gold_secular_ratios")
        .fetch_one(pool)
        .await?;
    Ok(fiscal_count == 0
        || rates_count == 0
        || valuations_count == 0
        || secular_gold_count == 0)
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();
    let database_url =
        std::env::var("DATABASE_URL").unwrap_or_else(|_| "sqlite:macro_data.db".to_string());
    let pool = db::init_db(&database_url).await?;

    if std::env::args().any(|arg| arg == "--ingest") {
        ingest::ingest_all(&pool).await?;
        println!("Ingestion complete.");
        return Ok(());
    }

    if needs_initial_ingest(&pool).await? {
        println!("Database tables empty; attempting initial data ingestion...");
        if let Err(err) = ingest::ingest_all(&pool).await {
            eprintln!("Warning: auto-ingestion did not complete ({err}). Starting server anyway.");
        }
    }

    let refresh_pool = pool.clone();
    tokio::spawn(async move {
        let refresh_interval = std::time::Duration::from_secs(24 * 60 * 60);
        loop {
            tokio::time::sleep(refresh_interval).await;
            println!("Running scheduled 24h macro data refresh...");
            if let Err(err) = ingest::ingest_all(&refresh_pool).await {
                eprintln!("Warning: scheduled 24h refresh failed ({err}).");
            } else {
                println!("Scheduled 24h macro data refresh complete.");
            }
        }
    });

    let port: u16 = std::env::var("PORT")
        .ok()
        .and_then(|v| v.trim().parse::<u16>().ok())
        .unwrap_or(8080);
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    println!("Macro Capital-Flow API listening on http://{addr}");
    axum::serve(listener, api::build_router(pool)).await?;

    Ok(())
}
