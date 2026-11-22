#!/usr/bin/env bash
set -e

echo "1. Checking types..."
cargo check --message-format=short

echo "2. Running strict linter..."
cargo clippy --quiet -- -D warnings

echo "3. Running unit tests..."
cargo test --quiet

echo "✅ ALL CHECKS PASSED."