#!/bin/bash
set -e

# OpenClaw Cache Keepalive Proxy — Installer
# Creates config, systemd service, and starts the proxy.

INSTALL_DIR="${HOME}/.openclaw/cache-keepalive-proxy"
SERVICE_NAME="cache-keepalive-proxy"
SERVICE_DIR="${HOME}/.config/systemd/user"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "╔══════════════════════════════════════════════════╗"
echo "║  OpenClaw Cache Keepalive Proxy — Installer      ║"
echo "╚══════════════════════════════════════════════════╝"
echo ""

# --- Check Node.js ---
if ! command -v node &>/dev/null; then
  echo "❌ Node.js not found. Please install Node.js 18+ first."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo "❌ Node.js 18+ required. Found: $(node -v)"
  exit 1
fi
echo "✅ Node.js $(node -v)"

# --- Copy files ---
echo ""
echo "📁 Installing to: ${INSTALL_DIR}"
mkdir -p "${INSTALL_DIR}"
cp "${SCRIPT_DIR}/proxy.js" "${INSTALL_DIR}/proxy.js"
chmod +x "${INSTALL_DIR}/proxy.js"

# --- Config ---
if [ -f "${INSTALL_DIR}/config.conf" ]; then
  echo "✅ config.conf already exists, keeping it."
else
  cp "${SCRIPT_DIR}/config.example.conf" "${INSTALL_DIR}/config.conf"
  echo "📝 Created config.conf from template."
  echo ""

  # Interactive config
  if [ -t 0 ]; then
    echo "─── Quick Setup ───"
    echo ""
    read -rp "Upstream API URL (e.g. https://api.anthropic.com): " UPSTREAM_URL
    if [ -n "$UPSTREAM_URL" ]; then
      sed -i "s|^UPSTREAM_URL=.*|UPSTREAM_URL=${UPSTREAM_URL}|" "${INSTALL_DIR}/config.conf"
      echo "  ✅ UPSTREAM_URL set"
    else
      echo "  ⚠️  UPSTREAM_URL is empty — you must edit config.conf before starting!"
    fi

    echo ""
    read -rp "Feishu alert chat_id (optional, press Enter to skip): " ALERT_CHAT_ID
    if [ -n "$ALERT_CHAT_ID" ]; then
      sed -i "s|^ALERT_CHAT_ID=.*|ALERT_CHAT_ID=${ALERT_CHAT_ID}|" "${INSTALL_DIR}/config.conf"
      echo "  ✅ ALERT_CHAT_ID set"
    fi

    echo ""
    read -rp "Webhook alert URL (optional, press Enter to skip): " ALERT_WEBHOOK_URL
    if [ -n "$ALERT_WEBHOOK_URL" ]; then
      sed -i "s|^ALERT_WEBHOOK_URL=.*|ALERT_WEBHOOK_URL=${ALERT_WEBHOOK_URL}|" "${INSTALL_DIR}/config.conf"
      echo "  ✅ ALERT_WEBHOOK_URL set"
    fi
  else
    echo "  ⚠️  Non-interactive mode. Edit ${INSTALL_DIR}/config.conf manually."
  fi
fi

# --- Validate config ---
source <(grep '^UPSTREAM_URL=' "${INSTALL_DIR}/config.conf")
if [ -z "$UPSTREAM_URL" ]; then
  echo ""
  echo "⚠️  UPSTREAM_URL is not set in config.conf."
  echo "   Edit ${INSTALL_DIR}/config.conf before starting the service."
fi

# --- systemd service ---
echo ""
echo "🔧 Creating systemd user service..."
mkdir -p "${SERVICE_DIR}"
cat > "${SERVICE_DIR}/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Cache Keepalive Proxy for Anthropic API
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=$(which node) ${INSTALL_DIR}/proxy.js
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=5
Environment=HOME=${HOME}

[Install]
WantedBy=default.target
EOF

# --- Enable and start ---
systemctl --user daemon-reload
systemctl --user enable "${SERVICE_NAME}" 2>/dev/null

# Check if UPSTREAM_URL is set before starting
if [ -n "$UPSTREAM_URL" ]; then
  systemctl --user restart "${SERVICE_NAME}"
  sleep 1

  if systemctl --user is-active "${SERVICE_NAME}" &>/dev/null; then
    echo "✅ Service started and enabled."
    echo ""

    # Quick verification
    PORT=$(grep '^PORT=' "${INSTALL_DIR}/config.conf" | cut -d= -f2)
    PORT="${PORT:-8899}"
    if curl -sf "http://127.0.0.1:${PORT}/status" >/dev/null 2>&1; then
      echo "✅ Proxy is responding on port ${PORT}"
    fi
  else
    echo "❌ Service failed to start. Check logs:"
    echo "   journalctl --user -u ${SERVICE_NAME} -n 20"
  fi
else
  echo "⏸️  Service created but NOT started (UPSTREAM_URL not set)."
  echo "   Edit config.conf, then: systemctl --user start ${SERVICE_NAME}"
fi

# --- Next steps ---
echo ""
echo "═══════════════════════════════════════════════════"
echo ""
echo "📋 Next steps:"
echo ""
echo "1. Point your OpenClaw Anthropic base URL to the proxy:"
echo "   In your .env or OpenClaw config, set:"
echo "   ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT:-8899}"
echo ""
echo "2. Restart OpenClaw gateway:"
echo "   openclaw gateway restart"
echo ""
echo "3. Verify keepalive is working:"
echo "   curl http://127.0.0.1:${PORT:-8899}/status"
echo ""
echo "4. Check logs:"
echo "   journalctl --user -u ${SERVICE_NAME} -f"
echo ""
echo "📖 Config: ${INSTALL_DIR}/config.conf"
echo "   (edit and save — changes take effect immediately)"
echo ""
