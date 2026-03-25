# OpenClaw Cache Keepalive Proxy

> [中文文档](./README.md)

**Automatically keep Anthropic Prompt Cache alive between conversations — no more expensive cache rebuilds.**

---

## The Problem

Anthropic's Prompt Cache has a **5-minute TTL**. Miss that window and the next request rebuilds the entire cache from scratch.

Most human conversations have gaps longer than 5 minutes. You grab coffee, read something, think before replying — cache gone.

**This proxy keeps your cache alive while you're away.**

## How Much Does It Save?

**In short**: Cache rebuilds cost **12.5x** more than cache reads. The proxy replaces expensive "rebuilds" with cheap "reads".

### Example

Using Opus with ~200K token context:

| Scenario | Cost |
|----------|------|
| **No proxy**: 6-minute break, cache expires and rebuilds | **$3.75** |
| **With proxy**: Same break, one keepalive fired, cache intact | **$0.60** |
| **Saved in one coffee break** | **$3.15** |

### Savings by Context Size

Per avoided cache rebuild (Opus rates):

| Context | Rebuild Cost | Keepalive Cost | 💰 Saved |
|---------|-------------|----------------|----------|
| 50K | $0.94 | ~$0.15 | **$0.79** |
| 100K | $1.88 | ~$0.30 | **$1.58** |
| 200K | $3.75 | ~$0.60 | **$3.15** |
| 300K | $5.63 | ~$0.90 | **$4.73** |

### Daily Estimate

Assuming 5 conversation gaps per day:

| Context | Daily Savings | Monthly Savings |
|---------|--------------|-----------------|
| 100K | ~$8 | **~$240** |
| 200K | ~$16 | **~$480** |
| 300K | ~$24 | **~$720** |

### Why It Never Loses Money

The proxy stops after 20 minutes of inactivity — at most 4 keepalives. One cache rebuild costs 12.5 keepalives. **Avoiding just one rebuild pays for everything.**

> Configure cost rates and `/status` will track estimated savings (upper-bound).

## How It Works

```
OpenClaw → localhost:8899 (this proxy) → Your Anthropic API upstream
                │
                ├── Forwards all requests normally
                ├── Caches request body per session (after upstream 2xx + stream complete)
                └── Every 4.5 min → sends max_tokens=1 keepalive
                    → Refreshes cache TTL, preserves existing cache
```

## Features

- **Per-session management** — Multiple chat windows tracked independently
- **Zero dependencies** — Pure Node.js, no `npm install` needed
- **Hot-reloadable config** — Most settings apply on next scheduling cycle
- **Auto-retry** — Retries once after 10 seconds on network errors
- **Alerting** — Webhook or Feishu/Lark notifications on cache miss or keepalive failure
- **Status endpoint** — `GET /status` with session states and cost savings
- **systemd integration** — One-command install, auto-start on login, auto-restart on crash
- **Cost tracking** — Configure rates to see estimated savings in `/status`
- **Request timeout** — All outbound connections have timeout protection

## Quick Start

```bash
git clone https://github.com/liaozaozao/openclaw-cache-keepalive.git
cd openclaw-cache-keepalive
chmod +x install.sh
./install.sh
```

Then point your OpenClaw Anthropic base URL to the proxy:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8899
openclaw gateway restart
```

## Requirements

- **Node.js 18+** (no external dependencies)
- **Linux with systemd** (installer creates a user-level service)
- **OpenClaw** with Anthropic API configured

> No systemd? Just run `node proxy.js` directly.

## Configuration

Config file: `~/.openclaw/cache-keepalive-proxy/config.conf`

| Config | Default | Hot-reload | Description |
|--------|---------|------------|-------------|
| `UPSTREAM_URL` | *(required)* | ❌ Restart | Anthropic API endpoint (supports path-prefixed relays) |
| `PORT` | `8899` | ❌ Restart | Local proxy port |
| `KEEPALIVE_MS` | `270000` (4m30s) | ✅ | Keepalive interval |
| `EXPIRE_MS` | `1200000` (20m) | ✅ | Session inactivity timeout |
| `RETRY_DELAY_MS` | `10000` (10s) | ✅ | Retry delay on failure |
| `KEEPALIVE_EXCLUDE` | `h:` | ✅ | Exclude session ID prefixes |
| `ALERT_WEBHOOK_URL` | *(empty)* | ✅ | Generic webhook URL |
| `ALERT_CHAT_ID` | *(empty)* | ✅ | Feishu/Lark chat_id |
| `COST_CACHE_WRITE_PER_MTOK` | `0` | ✅ | cache_write price ($/MTok) |
| `COST_CACHE_READ_PER_MTOK` | `0` | ✅ | cache_read price ($/MTok) |

> **Hot-reload**: ✅ fields take effect on next scheduling cycle. ❌ fields require restart. Environment variables take priority over config file.

### Cost Tracking

Set your rates to see savings in `/status`:

```
# Opus rates
COST_CACHE_WRITE_PER_MTOK=18.75
COST_CACHE_READ_PER_MTOK=1.50
```

> Only cache_write and cache_read prices matter. The proxy turns "rebuilds" into "reads" — it doesn't generate extra input/output tokens.

### Alerting

**Webhook** (Slack, Discord, etc.): `ALERT_WEBHOOK_URL=https://...`

**Feishu/Lark**: `ALERT_CHAT_ID=oc_xxx` (credentials auto-detected from OpenClaw config)

**Neither?** Alerts go to `.alerts.jsonl` and stdout.

## Monitoring

```bash
curl http://127.0.0.1:8899/status | python3 -m json.tool
```

> `/status` is localhost-only, intended for local troubleshooting.

## Known Limitations

- **Non-OpenClaw clients**: Session identification falls back to hash-based bucketing. Keepalive granularity may be coarse.
- **Third-party relays**: The proxy forwards most request headers. Verify compatibility if your relay uses custom authentication headers.

## Bypass / Uninstall

**Bypass**: `systemctl --user stop cache-keepalive-proxy`, revert your API URL.

**Uninstall**:
```bash
systemctl --user stop cache-keepalive-proxy
systemctl --user disable cache-keepalive-proxy
rm -rf ~/.openclaw/cache-keepalive-proxy
rm ~/.config/systemd/user/cache-keepalive-proxy.service
systemctl --user daemon-reload
```

## License

[MIT](./LICENSE)
