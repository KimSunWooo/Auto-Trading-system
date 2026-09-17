# EC2 PAPER Deployment

PAPER-only. REAL trading stays locked. This document prepares a single-instance EC2 host; it does not provision AWS resources for you.

## Architecture

```text
Internet
   ↓
Nginx (optional)
   ↓
Next.js (standalone)  :43147
   ├── Dashboard / API
   └── Engine Worker (file lock + heartbeat)
          ↓
      KIS PAPER (VTS) API

Node process
 ↓
/app/data/paper-account.json     (JSON authority)
/app/data/strategy-config.json
/app/data/trading-worker.lock
 ↓ best-effort mirror
AWS RDS MySQL
```

Do not introduce multi-replica App Auto Scaling, PM2 cluster mode, or Redis locks until a distributed lock exists.

## EC2 requirements

- Amazon Linux 2023 or Ubuntu 22.04+
- 2 vCPU / 4 GB RAM minimum (Node + Next standalone)
- EBS volume for `/opt/mirae-autobuy/data` (persist across reboot)
- Docker Engine + Compose plugin
- Outbound HTTPS to KIS VTS and outbound TCP 3306 to RDS (private SG)

## Security Group

| Direction | Port | Source / Dest | Purpose |
| --- | --- | --- | --- |
| Inbound | 22 | Admin CIDR only | SSH |
| Inbound | 80/443 | Trusted CIDR / ALB | Optional Nginx |
| Inbound | 43147 | Admin / ALB only | App (prefer reverse proxy) |
| Outbound | 443 | 0.0.0.0/0 | KIS PAPER HTTPS |
| Outbound | 3306 | RDS SG | MySQL |

RDS: Public Access = No. Inbound 3306 only from the EC2 security group.

## RDS connection

- Use application user `autotrading_app` with SELECT/INSERT/UPDATE/DELETE only (no DROP/ALTER/CREATE).
- Prefer `DATABASE_URL` or `AWS_RDS_*` with `AWS_RDS_SSL=true`.
- After boot: `docker compose -f docker-compose.paper.yml exec mirae-paper node -e "…"` or host `npm run db:check` with the same env.
- Runtime never retries a broker order because RDS failed (`DB_MIRROR_DEGRADED`).

## Persistent EBS data

```text
/opt/mirae-autobuy/data
  paper-account.json
  strategy-config.json
  trading-worker.lock
```

Compose bind:

```bash
export MIRA_DATA_DIR=/opt/mirae-autobuy/data
docker compose -f docker-compose.paper.yml up -d
```

Container ephemeral storage alone is not acceptable for JSON authority or the worker lock.

## Environment variables

Copy `.env.ec2.example` → `.env.ec2` on the host. Fill secrets from AWS Systems Manager Parameter Store or Secrets Manager. Never commit:

- KIS account / APP_KEY / APP_SECRET
- DATABASE_URL password
- REAL credentials

Required PAPER posture:

```env
BROKER=kis
TRADING_MODE=live_test
KIS_MODE=paper
ALLOW_LIVE_TRADING=false
PERSISTENCE_MODE=mirror
PAPER_MAX_QTY_PER_ORDER=5
PAPER_MAX_POSITION_QTY_PER_SYMBOL=50
# No operational daily COUNT cap. VTS harness keeps its own 5/day.
```

Unset / never set: `TRADING_MODE=live`, `ALLOW_LIVE_TRADING=true`, `KIS_MODE=real`, `KIS_LIVE_CONFIRM`, `KIS_REAL_*`.

## Secrets

Recommended: store `KIS_PAPER_*` and `DATABASE_URL` in Secrets Manager; inject at container start. Logs redact credential-like tokens. Health endpoints never return host passwords.

## Docker build

```bash
docker build -t mirae-autobuy-paper:local .
docker compose -f docker-compose.paper.yml config
```

Image uses Next `output: "standalone"`. Single replica only.

## Docker Compose

```bash
cp .env.ec2.example .env.ec2
# fill secrets
mkdir -p /opt/mirae-autobuy/data
export MIRA_DATA_DIR=/opt/mirae-autobuy/data
docker compose -f docker-compose.paper.yml up -d --build
```

`restart: unless-stopped` survives EC2 reboot when Docker is enabled on boot.

## Start / Stop / Restart

```bash
docker compose -f docker-compose.paper.yml up -d
docker compose -f docker-compose.paper.yml stop
docker compose -f docker-compose.paper.yml restart
```

Graceful stop (SIGTERM): new ticks stop → worker lock released → DB pool closed. Positions are **not** flattened.

## Health check

```bash
curl -s http://127.0.0.1:43147/api/health/live
curl -s http://127.0.0.1:43147/api/health/ready
npm run ec2:health   # or HEALTH_BASE_URL=... tsx scripts/ec2-health-check.ts
```

| Endpoint | Meaning |
| --- | --- |
| `/api/health/live` | Process up |
| `/api/health/ready` | JSON readable, worker heartbeat, REAL locked, mirror configured without lastError |
| `/api/runtime/database` | enabled / connected / mode / lastMirrorAt / lastError (no secrets) |

Ready does not call KIS on every probe.

## Log check

Compose logging: `max-size=10m`, `max-file=5`.

```bash
docker compose -f docker-compose.paper.yml logs -f --tail=200
```

Expect: Worker start, lock, tick, signal/risk, ODNO, execution, UNKNOWN, reconciliation, AUTO STOP, DB_MIRROR_DEGRADED.

## Emergency stop

Inside the running environment (with the same `data/` mount):

```bash
npm run emergency:stop
```

Blocks new orders. Does **not** flatten. Flatten remains a separate explicit command (`npm run emergency:flatten`) and must not be confused with stop.

## Recovery

1. Confirm JSON still on EBS.
2. Confirm RDS reachable (`db:check`).
3. Restart container; worker lock recovers from stale PID/heartbeat.
4. Confirm UNKNOWN orders are not blind-retried.
5. Confirm duplicate broker submit = 0.

## Rollback

Keep previous image tag. `docker compose ... up -d` with prior image. Restore `paper-account.json` from EBS snapshot if needed. RDS mirror is rebuildable from JSON; JSON remains authority.

## PAPER-only guarantees

- No REAL endpoint / REAL credential path on this host.
- Overseas PAPER orders stay opt-in (`RUN_KIS_VTS_OVERSEAS_ORDER_TESTS`) and market-gated.
- First EC2 soak: domestic PAPER only until overseas VTS-B2 actual lifecycle PASS.
- 24h process uptime ≠ 24h ordering; market closed ⇒ worker alive, no new strategy orders.
- `PERSISTENCE_MODE=database` is not implemented; do not remove JSON.

## Dry-run checklist

- [ ] App boot
- [ ] Worker lock acquired
- [ ] JSON loaded from EBS
- [ ] RDS connected + SSL
- [ ] KIS PAPER configured
- [ ] REAL locked
- [ ] Overseas order opt-in off (unless intentional)
- [ ] Recon healthy
- [ ] Health live/ready 200
