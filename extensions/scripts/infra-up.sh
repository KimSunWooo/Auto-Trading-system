#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
echo "Starting extensions Kafka(Redpanda)+Redis ..."
docker compose -f docker-compose.yml up -d
echo "Waiting for health..."
for i in $(seq 1 60); do
  if docker compose -f docker-compose.yml ps | grep -q healthy; then
    rp=$(docker inspect -f '{{.State.Health.Status}}' ext-redpanda 2>/dev/null || echo starting)
    rd=$(docker inspect -f '{{.State.Health.Status}}' ext-redis 2>/dev/null || echo starting)
    echo "redpanda=$rp redis=$rd"
    if [ "$rp" = "healthy" ] && [ "$rd" = "healthy" ]; then
      echo "INFRA_UP"
      exit 0
    fi
  fi
  sleep 2
done
echo "INFRA_TIMEOUT" >&2
docker compose -f docker-compose.yml ps >&2 || true
exit 1
