# OpenClaw Cache Keepalive Proxy

> [中文文档](./README.md)

**Automatically keep Anthropic Prompt Cache alive between conversations — no more expensive cache rebuilds.**

---

## The Problem

Anthropic's Prompt Cache has a **5-minute TTL**. Miss that window and the next request rebuilds the entire cache from scratch, charged as `cache_creation` tokens.

A typical OpenClaw session carries 100K–300K tokens of context. Each cache rebuild costs **$0.30 – $1.00+**.

Most human conversations have gaps longer than 5 minutes. You go grab coffee, read something, think before replying — cache gone.

**This proxy keeps your cache alive while you're away.**

## How It Works

```
OpenClaw → localhost:8899 (this proxy) → Your Anthropic API upstream
                │
                ├── Forwards all requests normally
                ├── Caches request body per session
                └── Every 4.5 min → sends max_tokens=1 keepalive
                    → Refreshes cache TTL, preserves existing cache
```

- Each keepalive costs **~1 token** (≈ $0.000003) vs. a full cache rebuild ($0.30–$1.00+)
- Cache stays alive for **~22 minutes** after your last message
- Stops automatically after 20 minutes of inactivity

## Features

- **Per-session management** — Multiple chat windows are tracked independently
- **Zero dependencies** — Pure Node.js, no `npm install` needed
- **Hot-reloadable config** — Edit `config.conf`, changes apply instantly
- **Auto-retry on failure** — Retries once after 10 seconds on network errors
- **Alerting** — Webhook or Feishu/Lark notifications on cache miss
- **Status endpoint** — `GET /status` returns structured JSON with all session states
- **systemd integration** — One-command install, auto-start on boot, auto-restart on crash

## Quick Start

```bash
git clone https://github.com/liaozaozao/openclaw-cache-keepalive.git
cd openclaw-cache-keepalive
chmod +x install.sh
./install.sh
```

The installer will guide you through:
1. Enter your upstream API URL (your Anthropic API endpoint)
2. Optionally configure alert notifications
3. Auto-register and start the systemd service

Then point your OpenClaw Anthropic base URL to the proxy:

```bash
# In your .env or OpenClaw config:
ANTHROPIC_BASE_URL=http://127.0.0.1:8899

# Restart OpenClaw
openclaw gateway restart
```

## Requirements

- **Node.js 18+** (no external dependencies)
- **Linux with systemd** (installer creates a user-level service)
- **OpenClaw** with Anthropic API configured

> No systemd? Just run `node proxy.js` directly and manage the process yourself.

## Configuration

Config file: `~/.openclaw/cache-keepalive-proxy/config.conf`

| Config | Default | Hot-reload | Description |
|--------|---------|------------|-------------|
| `UPSTREAM_URL` | *(required)* | ❌ Restart | Your Anthropic API endpoint |
| `PORT` | `8899` | ❌ Restart | Local proxy port |
| `KEEPALIVE_MS` | `270000` (4m30s) | ✅ | Keepalive interval |
| `EXPIRE_MS` | `1200000` (20m) | ✅ | Session inactivity timeout |
| `RETRY_DELAY_MS` | `10000` (10s) | ✅ | Retry delay on failure |
| `KEEPALIVE_EXCLUDE` | `h:` | ✅ | Exclude session ID prefixes (comma-separated) |
| `ALERT_WEBHOOK_URL` | *(empty)* | ✅ | Generic webhook URL for alerts |
| `ALERT_CHAT_ID` | *(empty)* | ✅ | Feishu/Lark chat_id for alerts |

> **Hot-reload**: Fields marked ✅ take effect immediately on save. Fields marked ❌ require: `systemctl --user restart cache-keepalive-proxy`

### Alerting

Get notified when cache unexpectedly misses (cache_write > 0) or keepalive requests fail.

**Option A — Generic Webhook** (Slack, Discord, etc.):
```
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/xxx
```

**Option B — Feishu / Lark** (auto-detected for OpenClaw + Feishu users):
```
ALERT_CHAT_ID=oc_xxxxxxxxxxxx
```
Feishu credentials are auto-read from `~/.openclaw/openclaw.json`. No extra setup needed.

**Neither configured?** Alerts are written to `.alerts.jsonl` and logged to stdout.

## Monitoring

```bash
# Proxy status (JSON)
curl http://127.0.0.1:8899/status | python3 -m json.tool

# Service status
systemctl --user status cache-keepalive-proxy

# Live logs
journalctl --user -u cache-keepalive-proxy -f

# Restart (after UPSTREAM_URL or PORT changes)
systemctl --user restart cache-keepalive-proxy
```

The `/status` endpoint returns:
- Service uptime and active config
- Per-session: cache status, keepalive count, hit rate, next keepalive time
- Global totals and recent alerts

## Cache Duration

After your last message, the cache stays alive:

```
Last message
  ├── +4m30s → Keepalive 1 (refreshes TTL)
  ├── +9m00s → Keepalive 2
  ├── +13m30s → Keepalive 3
  └── +18m00s → Keepalive 4
      └── +5m TTL → Cache actually expires at ~minute 23

20 min of silence → Session expires, keepalive stops
```

**Effective protection window: ~22–23 minutes.** Plenty for most conversation gaps.

## Important Notes

- **Don't remove the `thinking` field**: The proxy preserves the original request's `thinking` structure. This is required for cache prefix matching. Removing it causes every keepalive to rebuild the cache (very expensive).
- **Timers use request send time**: Keepalive scheduling uses dispatch time (close to when Anthropic starts the TTL), not response arrival time.
- **Restarting is safe**: The proxy is an independent service. A restart just means one cache rebuild on the next real request — then normal operation resumes.
- **Multi-session**: Each chat window maintains its own cache and keepalive timer.

## FAQ

**Q: Do keepalive requests affect normal conversations?**

No. Keepalives use `max_tokens=1` and bypass OpenClaw entirely. They don't appear in chat history.

**Q: Can I use this without OpenClaw?**

Yes, with some adaptation. The proxy extracts `chat_id` from the `system` field in Anthropic API requests (injected by OpenClaw). Without it, all requests fall into one hash-based session — keepalive still works, just at coarser granularity.

**Q: What if the proxy crashes?**

systemd auto-restarts it (`Restart=on-failure`). The first real request after restart rebuilds the cache once, then everything returns to normal. No conversations are lost.

**Q: How do I change the upstream URL?**

Edit `UPSTREAM_URL` in `config.conf`, then restart:
```bash
systemctl --user restart cache-keepalive-proxy
```

## Bypass / Uninstall

**Temporarily bypass** (direct connection):
```bash
# Revert your OpenClaw Anthropic base URL to the upstream
# Restart OpenClaw gateway
systemctl --user stop cache-keepalive-proxy
```

**Full uninstall:**
```bash
systemctl --user stop cache-keepalive-proxy
systemctl --user disable cache-keepalive-proxy
rm -rf ~/.openclaw/cache-keepalive-proxy
rm ~/.config/systemd/user/cache-keepalive-proxy.service
systemctl --user daemon-reload
```

## Technical Details

For contributors and the curious:

- **Session identification**: Extracts `chat_id` from OpenClaw's injected inbound context in the `system` field. Falls back to MD5 hash for unrecognized sessions.
- **Keepalive request**: Clones the original request body (preserving cache prefix), sets `max_tokens=1`, `stream=false`, `thinking.budget_tokens=128`.
- **Version guard**: Each session carries a version number to prevent orphan timers from concurrent requests.
- **Retry policy**: Network/HTTP errors retry once; cache misses (cache_write > 0) do not retry — cache is already rebuilt, retrying would waste money.

## License

[MIT](./LICENSE)
