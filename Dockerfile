FROM oven/bun:1 AS base
WORKDIR /app

# Install deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Download tree-sitter-al WASM from the latest GitHub Release
RUN apt-get update -qq && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p src/source \
    && curl -fsSL \
       https://github.com/SShadowS/tree-sitter-al/releases/latest/download/tree-sitter-al.wasm \
       -o src/source/tree-sitter-al.wasm

# Copy source + web assets (WASM already in place from above)
COPY src/ src/
COPY web/ web/

EXPOSE 3010

# Production gates dev-only endpoints (e.g. /api/record-next-batch).
ENV NODE_ENV=production

# Persistent data (debug/consent captures, stats, tenants) lives under /data so it
# survives container redeploys. Mount a volume here:
#   docker run -v al-perf-data:/data -p 3010:3010 sshadows/al-perf
ENV AL_PERF_DATA_DIR=/data
VOLUME /data

# Temp files (zip extraction) go to /tmp — mount as tmpfs for in-memory processing:
#   docker run --tmpfs /tmp:size=512m -p 3010:3010 sshadows/al-perf
CMD ["bun", "run", "web/server.ts"]
