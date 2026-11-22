# Stage 1: Build static Next.js frontend export (/app/web/out)
FROM node:20-alpine AS web-builder
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

# Stage 2: Build Rust release binary
FROM rust:1-bookworm AS rust-builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends pkg-config libssl-dev \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY migrations ./migrations
COPY src ./src
RUN cargo build --release

# Stage 3: Minimal production runtime
FROM debian:bookworm-slim AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3 \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=rust-builder /app/target/release/viewer /app/viewer
COPY --from=rust-builder /app/migrations /app/migrations
COPY --from=web-builder /app/web/out /app/web/out

ENV PORT=8080
ENV DATABASE_URL=sqlite:macro_data.db
EXPOSE 8080

CMD ["/app/viewer"]
