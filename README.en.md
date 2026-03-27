# OpenClaw Cache Keepalive Proxy

> Current version: v1.7.0

> [中文文档](./README.md)

**Keep Anthropic Prompt Cache alive automatically for OpenClaw and Claude Code main sessions.**

---

## Project Scope

This proxy sits between your client and an Anthropic-compatible upstream. It:

- forwards requests normally
- stores only safe-to-keepalive main-session templates after upstream success
- sends a tiny keepalive request every 4.5 minutes to refresh Prompt Cache TTL

Currently supported:

| Client | Session key | Keepalive behavior |
|--------|-------------|--------------------|
| OpenClaw | `system.chat_id` | kept alive |
| Claude Code main sessions (Opus / Sonnet) | `metadata.user_id.session_id` | kept alive |
| Claude Code title requests | same outer `session_id` | **excluded** |
| Claude Code subagent requests | same outer `session_id` | **excluded** |
| Claude Code Haiku main sessions | `metadata.user_id.session_id` | **excluded** |

> Principle: only high-confidence main-session templates are allowed to enter keepalive. Title, subagent, and one-shot helper requests never overwrite the template.

## Why This Exists

Anthropic Prompt Cache has a **5-minute TTL**. If no new request arrives in time, the next request rebuilds the cache from scratch (`cache_creation`), which is much more expensive than a cache read (`cache_read`).

This proxy keeps the cache warm while you are idle.

## How It Works

```text
OpenClaw / Claude Code → localhost:8899 (this proxy) → Anthropic-compatible upstream
                              │
                              ├── Forwards requests normally
                              ├── Stores only high-confidence main-session templates
                              └── Every 4.5 min sends max_tokens=1 keepalive
                                  → refreshes cache TTL
```

## Features

- **Per-session isolation** — independent keepalive state per main session
- **Claude Code smart detection** — automatically classifies main sessions, subagents, title requests, and Haiku sessions
- **Claude Code subagent-safe** — subagent requests refresh activity but do not overwrite the main template
- **Haiku excluded** — Claude Code Haiku main sessions are never kept alive
- **Zero dependencies** — pure Node.js, no `npm install`
- **Hot-reloadable config** — most config changes apply on the next scheduling cycle
- **Auto-retry** — retries once after 10 seconds on network failure
- **Status endpoint** — `GET /status` with session state, keepalive results, and exclusion reasons
- **Browser dashboard** — `/status/ui` with session grouping, manual stop, filters, and auto-refresh
- **Config validation warnings** — warns when keepalive interval >= TTL or >= session expiry
- **Linux systemd integration**
- **Windows direct-run support**

## Quick Start

### Linux / Debian

```bash
git clone https://github.com/liaozaozao/openclaw-cache-keepalive.git
cd openclaw-cache-keepalive
chmod +x install.sh
./install.sh
```

`install.sh` will:

1. copy files into `~/.openclaw/cache-keepalive-proxy/`
2. create the config file
3. register and start a `systemd --user` service

### Windows

Windows does not use `install.sh`. Run directly:

```powershell
Set-Location <repo-dir>
.\scripts\windows\run.ps1
```

For long-running use on Windows, prefer either:

- a dedicated PowerShell / Windows Terminal window
- or Task Scheduler / NSSM to supervise the Node process

You can also run:

```cmd
scripts\windows\run.cmd
```

Notes:

- On first run, if `config.conf` does not exist, the launcher copies `config.example.conf`
- Then you only need to edit `UPSTREAM_URL`
- The launcher automatically points `CONF_FILE` at the repo-local `config.conf`
- Windows launchers now live under `scripts/windows/`

## Project Layout

- `proxy.js`: main proxy entry
- `ui/`: status page template, styling, and client logic
- `scripts/windows/`: Windows launchers
- `extras/cache-status-cmd/`: optional `/cache` slash command

## Point Clients to the Proxy

### OpenClaw

Point OpenClaw's Anthropic base URL to the proxy:

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8899
openclaw gateway restart
```

Start from [config.openclaw.example.conf](./config.openclaw.example.conf).
This is a shorter OpenClaw-oriented starter; [config.example.conf](./config.example.conf) remains the canonical full template.

### Claude Code

Point Claude Code's `ANTHROPIC_BASE_URL` at the proxy.

Option 1: configure it in Claude Code settings

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8899"
  }
}
```

Option 2: launch with a dedicated settings file

```powershell
claude --settings "$env:USERPROFILE\.claude\settings.proxy.json"
```

Start from [config.claude-code.example.conf](./config.claude-code.example.conf).
This is a shorter Claude Code-oriented starter; [config.example.conf](./config.example.conf) remains the canonical full template.

## Requirements

- **Node.js 18+**
- Recommended for Linux long-running use:
  - **Debian / Ubuntu / other Linux**
  - **systemd**
- Recommended for Windows long-running use:
  - long-lived terminal session, or Task Scheduler / NSSM

## Configuration

The generic template is [config.example.conf](./config.example.conf).

Common config locations:

- Linux installed mode: `~/.openclaw/cache-keepalive-proxy/config.conf`
- Manual mode: anywhere, via `CONF_FILE`

| Config | Default | Hot-reload | Description |
|--------|---------|------------|-------------|
| `UPSTREAM_URL` | *(required)* | ❌ | Anthropic-compatible upstream URL |
| `PORT` | `8899` | ❌ | Local listen port |
| `KEEPALIVE_SECONDS` | `270` | ✅ | Keepalive interval |
| `EXPIRE_SECONDS` | `1200` | ✅ | Session inactivity expiry |
| `RETRY_DELAY_SECONDS` | `10` | ✅ | Retry delay on keepalive failure |
| `KEEPALIVE_EXCLUDE` | `h:` | ✅ | Exclude by session ID prefix |
| `ALERT_WEBHOOK_URL` | empty | ✅ | Generic webhook URL |
| `ALERT_CHAT_ID` | empty | ✅ | Feishu/Lark chat_id |
| `INSPECT_REQUESTS` | `0` | ✅ | Safe summary debugging |
| `FULL_CAPTURE_REQUESTS` | `0` | ✅ | Full request capture debugging, not for normal use |
| `INSPECT_MAX_ENTRIES` | `30` | ✅ | Inspect in-memory ring buffer max entries |
| `FULL_CAPTURE_MAX_ENTRIES` | `10` | ✅ | Capture in-memory ring buffer max entries |
| `COST_CACHE_WRITE_PER_MTOK` | `0` | ✅ | cache_write unit price |
| `COST_CACHE_READ_PER_MTOK` | `0` | ✅ | cache_read unit price |

> New configs should use seconds. Legacy `KEEPALIVE_MS / EXPIRE_MS / RETRY_DELAY_MS` remain supported only for backward compatibility.
>
> Debug flags are for short-lived troubleshooting only. Keep them off in production.

## `/status`

```bash
curl http://127.0.0.1:8899/status | python3 -m json.tool
```

Browser dashboard:

```text
http://127.0.0.1:8899/status/ui
```

Notes:

- `/status` stays machine-readable JSON for scripts and troubleshooting
- `/status/ui` renders the same data as a local dashboard without adding a build step or extra dependencies
- `/status/ui` defaults to Chinese, supports switching to English in-page, and remembers the last language choice

Key fields related to Claude Code:

- `requestKind`
  - `claude_code_main`
  - `claude_code_title`
  - `claude_code_subagent`
  - `claude_code_unknown`
  - `claude_code_haiku_main`
  - `generic_fallback`
  - `openclaw_chat`
- `sessionSource`
  - `metadata.user_id.session_id`
  - `system.chat_id`
- `keepaliveEnabled`
  - `true`: eligible for keepalive
  - `false`: explicitly excluded
- `excludedReason`
  - `haiku_model`
  - `prefix_excluded`
  - `unknown_request_shape`

Notes:

- Claude Code title and subagent requests do not appear as active keepalive sessions
- Claude Code Haiku sessions are explicitly excluded from keepalive

## Cost Tracking

If you set prices, `/status` will estimate savings:

```ini
COST_CACHE_WRITE_PER_MTOK=18.75
COST_CACHE_READ_PER_MTOK=1.50
```

## Alerts

### Generic webhook

```ini
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/xxx
```

### Feishu / Lark

```ini
ALERT_CHAT_ID=oc_xxxxxxxxxxxx
```

Credentials are auto-detected from OpenClaw config.

## Debugging / Troubleshooting

Safe summary debugging:

- `GET /inspect`
- written to `.inspect.jsonl`

Full request capture debugging:

- `GET /capture`
- written to `.capture.jsonl`
- auth headers are redacted, but request bodies are still stored

Before long-running use, delete:

- `.inspect.jsonl`
- `.capture.jsonl`

## Privacy / Local Paths

Repository docs and example configs should not contain your personal absolute paths, usernames, or debug artifacts.

For normal use:

- prefer repo-relative paths or `$env:USERPROFILE`
- do not commit local debug configs, capture files, or personal settings files

## Verified Behavior

Validated with real traffic:

- OpenClaw keepalive flow remains intact
- Claude Code main Opus / Sonnet sessions can be kept alive successfully
- Claude Code subagent requests do not overwrite the main template
- Claude Code Haiku sessions are not kept alive

## Known Limitations

- If Claude Code changes request structure significantly in a future release, the main-template admission rule may need adjustment
- The proxy listens on `127.0.0.1` by default
- There is no built-in Windows service installer yet; supervise the Node process yourself

## Bypass / Uninstall

### Linux

Bypass:

```bash
systemctl --user stop cache-keepalive-proxy
```

Uninstall:

```bash
./install.sh --uninstall
```

### Windows

Stop the `node proxy.js` process (terminal window, Task Scheduler job, or NSSM service).

## License

[MIT](./LICENSE)
