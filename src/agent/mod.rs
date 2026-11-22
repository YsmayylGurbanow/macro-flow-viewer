pub mod analyst;
pub mod tools;

use thiserror::Error;

/// Errors returned by the macro analyst agent and its SQLite tools.
#[derive(Debug, Error)]
pub enum AgentError {
    /// SQLite query error while reading macro data or caching analyst briefs.
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),

    /// HTTP error while calling the Gemini API.
    #[error("HTTP request error: {0}")]
    Http(#[from] reqwest::Error),

    /// JSON serialization or deserialization error.
    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    /// Requested ticker does not correspond to a supported sector ETF.
    #[error("unknown sector ticker: {0}")]
    UnknownTicker(String),

    /// Invalid or unrecognized tool call invocation.
    #[error("tool execution error: {0}")]
    ToolError(String),
}
