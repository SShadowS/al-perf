#!/bin/bash
set -e

IMAGE="sshadows/al-perf:latest"
CONTAINER="al-perf"

# Pull latest image
echo "Pulling $IMAGE..."
docker pull "$IMAGE"

# Stop and remove old container (ignore errors if not running)
echo "Stopping $CONTAINER..."
docker stop "$CONTAINER" 2>/dev/null || true
docker rm "$CONTAINER" 2>/dev/null || true

# Start new container
echo "Starting $CONTAINER..."
docker run -d \
  --restart unless-stopped \
  --name "$CONTAINER" \
  -p 3010:3010 \
  -v al-perf-data:/data \
  -e ANTHROPIC_API_KEY \
  "$IMAGE"

# Clean up old images
docker image prune -f

echo "Done. Running $(docker inspect --format='{{.Config.Image}}' "$CONTAINER")"
