# OpenClaw Cache Keepalive Proxy

Automatically keeps Anthropic prompt cache alive between conversations, saving significant costs on large context windows.

## The Problem

Anthropic's prompt cache has a **5-minute TTL**. If you don't send a request within 5 minutes, the cache expires and the next request rebuilds it from scratch — costing full `cache_creation` tokens. For typical OpenClaw sessions with 100K-300K token contexts, each cache rebuild can cost $0.30-$1.00+.

**Most human conversations have gaps longer than 5 minutes.** Every time you take a break, check something, or just think before replying, your cache expires.

## The Solution

A lightweight local reverse proxy that sits between OpenClaw and your Anthropic API upstream. It:

1. **Intercepts** every API request and caches the request body per session
2. **Replays** a minimal `max_tokens=1` request every 4.5 minutes to refresh the cache TTL
3. **Stops** after 20 minutes of inactivity (configurable)

The keepalive cost is ~1 token per request (~$0.000003). The savings are the full cache rebuild cost avoided — typically 1000x+ ROI.

## How It Works

```
OpenClaw → localhost:8899 (this proxy) → Your Anthropic API upstream
                  ↓
          Caches request body per session
          Every 4.5 min → sends max_tokens=1 keepalive
          Keeps cache alive for up to ~22 minutes after last message
```

**Key design decisions:**
- Keeps `thinking` field intact (required for cache prefix match)
- Per-session bucketing via OpenClaw's injected `chat_id`
- Version-checked timers prevent orphan keepalives on concurrent requests
- Cache misses are NOT retried (cache is already rebuilt, retry would waste money)

## Quick Start

```bash
git clone https://github.com/liaozaozao/openclaw-cache-keepalive.git
cd openclaw-cache-keepalive
chmod +x install.sh
./install.sh
```

The installer will:
1. Copy files to `~/.openclaw/cache-keepalive-proxy/`
2. Create `config.conf` and prompt for your upstream URL
3. Set up a systemd user service (auto-start on boot)
4. Start the proxy and verify it's running

Then point your OpenClaw Anthropic base URL to `http://127.0.0.1:8899` and restart the gateway.

## Requirements

- **Node.js 18+** (no external dependencies)
- **Linux with systemd** (the installer creates a user service)
- **OpenClaw** with Anthropic API configured

## Configuration

Edit `~/.openclaw/cache-keepalive-proxy/config.conf`:

| Config | Default | Hot-reload | Description |
|--------|---------|------------|-------------|
| `UPSTREAM_URL` | *(required)* | ❌ Restart | Your Anthropic API endpoint |
| `PORT` | `8899` | ❌ Restart | Local proxy port |
| `KEEPALIVE_MS` | `270000` (4m30s) | ✅ | Keepalive interval |
| `EXPIRE_MS` | `1200000` (20m) | ✅ | Session inactivity timeout |
| `RETRY_DELAY_MS` | `10000` (10s) | ✅ | Retry delay on failure |
| `KEEPALIVE_EXCLUDE` | `h:` | ✅ | Exclude session ID prefixes |
| `ALERT_WEBHOOK_URL` | *(empty)* | ✅ | Generic webhook for alerts |
| `ALERT_CHAT_ID` | *(empty)* | ✅ | Feishu chat_id for alerts |

> **Hot-reload**: Edit `config.conf` and save — changes take effect immediately. Fields marked "Restart" require `systemctl --user restart cache-keepalive-proxy`.

### Alerting

The proxy can alert you when cache misses occur (unexpected cost) or keepalive requests fail.

**Option A — Generic Webhook** (Slack, Discord, Telegram, etc.):
```
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/xxx
```

**Option B — Feishu / Lark** (auto-detected for OpenClaw + Feishu users):
```
ALERT_CHAT_ID=oc_xxxxxxxxxxxx
```
Feishu credentials are auto-read from `~/.openclaw/openclaw.json`. No extra setup needed if you already use OpenClaw with Feishu.

**Neither configured?** Alerts are written to `.alerts.jsonl` and logged to stdout.

## Monitoring

**Status endpoint:**
```bash
curl http://127.0.0.1:8899/status | python3 -m json.tool
```

Returns structured JSON with:
- Service uptime and config
- Per-session: cache status, keepalive count, cache hit rate, next keepalive time
- Global totals and recent alerts

**Service management:**
```bash
# Status
systemctl --user status cache-keepalive-proxy

# Logs
journalctl --user -u cache-keepalive-proxy -f

# Restart (needed for UPSTREAM_URL/PORT changes)
systemctl --user restart cache-keepalive-proxy

# Hot-reload config
# Just edit config.conf — or:
systemctl --user reload cache-keepalive-proxy
```

## Cache Effective Duration

After your last message, the cache stays alive for **~22 minutes**:

```
Last message → +4m30s → Keepalive 1 → +4m30s → Keepalive 2 → ... → Keepalive 4
Keepalive 4 + 5min TTL ≈ 22-23 minutes total
```

After 20 minutes of silence, the session expires and keepalive stops.

## Important Notes

- **Don't remove the `thinking` field**: The proxy preserves the original request's `thinking` structure. Removing it would break cache prefix matching, causing expensive cache rebuilds.
- **Timer is based on request send time**: Keepalive scheduling uses the request dispatch time (close to when Anthropic starts the cache TTL), not the response arrival time.
- **Proxy restart is safe**: The proxy is an independent service. Restarting it just means the next real request will rebuild the cache once — normal operation resumes immediately.
- **Multi-session support**: Each chat/conversation maintains its own independent cache and keepalive timer.

## Bypass / Uninstall

**Temporarily bypass** (direct connection):
```bash
# Change your OpenClaw Anthropic base URL back to your upstream
# Then restart gateway
systemctl --user stop cache-keepalive-proxy
```

**Uninstall:**
```bash
systemctl --user stop cache-keepalive-proxy
systemctl --user disable cache-keepalive-proxy
rm -rf ~/.openclaw/cache-keepalive-proxy
rm ~/.config/systemd/user/cache-keepalive-proxy.service
systemctl --user daemon-reload
```

## License

MIT
