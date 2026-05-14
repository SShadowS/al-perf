# AL Profile Analyzer — Deployment

Docker image: `sshadows/al-perf` on Docker Hub.

## Quick Start

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
./update-server.sh
```

The update script pulls the latest image, stops the old container, and starts a new one.

## Manual Run

```bash
docker run -d \
  --restart unless-stopped \
  --name al-perf \
  -p 3010:3010 \
  -v al-perf-data:/data \
  -e ANTHROPIC_API_KEY \
  sshadows/al-perf
```

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | No | — | Enables AI-powered analysis (narrative explanation + deep findings with code fix suggestions). Without it, the server runs deterministic analysis only. |
| `PORT` | No | `3010` | HTTP port the server listens on. |
| `AL_PERF_DEBUG` | No | — | Set to `1` to enable debug mode: all requests are automatically saved to disk (no user consent needed). An orange banner appears in the UI. |
| `DATA_DIR` | No | `/data` | Directory for persistent data (stats, debug captures). Defaults to `/data` inside the container (the declared volume). |

## Volumes

| Mount Point | Purpose |
|-------------|---------|
| `/data` | Persistent storage for `stats.json` (analysis counter) and `debug/` (user-consented captures, 7-day retention). Mount a named volume here so data survives container updates. |
| `/tmp` | Temporary files during analysis (uploaded profiles, extracted zips). Cleaned up after each request. Optionally mount as tmpfs for in-memory processing: `--tmpfs /tmp:size=512m`. |

## Ports

| Port | Protocol | Description |
|------|----------|-------------|
| `3010` | HTTP | Web UI and API. Serves the single-page app at `/` and the analysis API at `/api/*`. |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/analyze` | Single profile analysis. Multipart form: `profile` (required), `source` (.zip, optional). Query: `?format=html\|json`, `?stream=1` for SSE. |
| `POST` | `/api/analyze-batch` | Batch analysis. Multipart form: `profiles[]` (required), `manifest` (JSON, optional), `source` (.zip, optional). Query: same as above. |
| `GET` | `/api/stats` | Usage statistics (total analyses, daily counts). |
| `GET` | `/api/debug/status` | Whether debug mode is active. |
| `POST` | `/api/debug/save` | User consent to save a capture. Body: `{ "debugToken": "..." }`. |
| `OPTIONS` | `*` | Health check (returns 200). Used by HAProxy/load balancers. |

## update-server.sh

The update script does the following:

1. `docker pull sshadows/al-perf:latest`
2. Stop and remove the existing `al-perf` container
3. Start a new container with the same configuration
4. Prune unused images

It reads `ANTHROPIC_API_KEY` from the environment. Set it in your shell profile:

```bash
echo 'export ANTHROPIC_API_KEY="sk-ant-..."' >> ~/.bashrc
source ~/.bashrc
```

## Reverse Proxy

The server supports being behind Cloudflare or other reverse proxies. Long-running analyses use SSE (Server-Sent Events) with keepalive pings every 5 seconds to survive proxy timeouts.

Example nginx config:

```nginx
location / {
    proxy_pass http://localhost:3010;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_buffering off;           # required for SSE
    proxy_read_timeout 300s;
    client_max_body_size 100m;
}
```
