FROM oven/bun:1 AS base
WORKDIR /app

# Install deps
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

# Copy source + WASM + web assets
COPY src/ src/
COPY web/ web/

EXPOSE 3010

# Temp files (zip extraction) go to /tmp — mount as tmpfs for in-memory processing:
#   docker run --tmpfs /tmp:size=512m -p 3010:3010 al-perf
CMD ["bun", "run", "web/server.ts"]
