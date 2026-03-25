#!/bin/bash
set -e

# OpenClaw Cache Keepalive Proxy — 安装脚本
# 自动完成：复制文件 → 创建配置 → 注册 systemd 服务 → 启动代理

INSTALL_DIR="${HOME}/.openclaw/cache-keepalive-proxy"
SERVICE_NAME="cache-keepalive-proxy"
SERVICE_DIR="${HOME}/.config/systemd/user"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- 颜色定义 ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

print_header() {
  echo ""
  echo -e "${CYAN}╔══════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║${NC}  ${BOLD}OpenClaw Cache Keepalive Proxy${NC} — 安装向导         ${CYAN}║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo "  自动保活 Anthropic Prompt Cache，避免缓存过期导致的重复建缓费用。"
  echo ""
}

# Safely write a key=value to config file (avoids sed injection)
write_config_value() {
  local key="$1" value="$2" file="$3"
  local tmpfile
  tmpfile=$(mktemp)
  while IFS= read -r line; do
    if [[ "$line" =~ ^${key}= ]]; then
      echo "${key}=${value}"
    else
      echo "$line"
    fi
  done < "$file" > "$tmpfile"
  mv "$tmpfile" "$file"
}

print_header

# ─── 1. 检查环境 ───────────────────────────────────────

echo -e "${BOLD}[1/4] 检查环境${NC}"
echo ""

# Node.js
if ! command -v node &>/dev/null; then
  echo -e "  ${RED}✗${NC} 未检测到 Node.js，请先安装 Node.js 18 或更高版本"
  echo "    安装指引: https://nodejs.org/"
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  echo -e "  ${RED}✗${NC} 需要 Node.js 18+，当前版本: $(node -v)"
  exit 1
fi
echo -e "  ${GREEN}✓${NC} Node.js $(node -v)"

# systemd (check if user-level systemd actually works, not just if binary exists)
NO_SYSTEMD=0
if ! command -v systemctl &>/dev/null; then
  echo -e "  ${YELLOW}!${NC} 未检测到 systemd，将跳过服务注册"
  NO_SYSTEMD=1
elif ! systemctl --user is-system-running &>/dev/null 2>&1; then
  echo -e "  ${YELLOW}!${NC} 用户级 systemd 不可用（可能在容器或 SSH 非登录会话中）"
  echo "    将跳过服务注册，你需要手动管理进程"
  NO_SYSTEMD=1
else
  echo -e "  ${GREEN}✓${NC} systemd（用户级）"
fi

echo ""

# ─── 2. 安装文件 ───────────────────────────────────────

echo -e "${BOLD}[2/4] 安装文件${NC}"
echo ""

mkdir -p "${INSTALL_DIR}"
cp "${SCRIPT_DIR}/proxy.js" "${INSTALL_DIR}/proxy.js"
chmod +x "${INSTALL_DIR}/proxy.js"
echo -e "  ${GREEN}✓${NC} proxy.js → ${INSTALL_DIR}/（已有文件会被更新）"

# ─── 3. 配置 ──────────────────────────────────────────

echo ""
echo -e "${BOLD}[3/4] 配置${NC}"
echo ""

if [ -f "${INSTALL_DIR}/config.conf" ]; then
  echo -e "  ${GREEN}✓${NC} config.conf 已存在，保留现有配置"
else
  cp "${SCRIPT_DIR}/config.example.conf" "${INSTALL_DIR}/config.conf"
  chmod 600 "${INSTALL_DIR}/config.conf"
  echo -e "  ${GREEN}✓${NC} 已创建 config.conf（权限 600）"

  # 交互式配置
  if [ -t 0 ]; then
    echo ""
    echo -e "  ${BOLD}── 快速配置 ──${NC}"
    echo ""
    echo "  代理会把 OpenClaw 的请求转发到你的 Anthropic API 上游地址，"
    echo "  同时在后台自动发送保活请求以维持缓存。"
    echo ""

    # UPSTREAM_URL
    while true; do
      read -rp "  上游 API 地址 (如 https://api.anthropic.com): " INPUT_URL
      if [ -z "$INPUT_URL" ]; then
        echo -e "  ${YELLOW}!${NC} 上游地址不能为空，这是代理的必填配置"
        continue
      fi
      if [[ ! "$INPUT_URL" =~ ^https?:// ]]; then
        echo -e "  ${YELLOW}!${NC} 地址必须以 http:// 或 https:// 开头"
        continue
      fi
      break
    done
    write_config_value "UPSTREAM_URL" "$INPUT_URL" "${INSTALL_DIR}/config.conf"
    echo -e "  ${GREEN}✓${NC} 上游地址已设置"

    # PORT
    echo ""
    read -rp "  代理监听端口 [默认 8899]: " INPUT_PORT
    if [ -n "$INPUT_PORT" ]; then
      if [[ "$INPUT_PORT" =~ ^[0-9]+$ ]] && [ "$INPUT_PORT" -ge 1 ] && [ "$INPUT_PORT" -le 65535 ]; then
        write_config_value "PORT" "$INPUT_PORT" "${INSTALL_DIR}/config.conf"
        echo -e "  ${GREEN}✓${NC} 端口设为 ${INPUT_PORT}"
      else
        echo -e "  ${YELLOW}!${NC} 端口无效，使用默认 8899"
      fi
    fi

    # Alert (optional)
    echo ""
    echo "  ── 告警配置（可选，直接回车跳过）──"
    echo ""

    read -rp "  飞书告警群 chat_id (oc_xxx 格式): " INPUT_CHAT_ID
    if [ -n "$INPUT_CHAT_ID" ]; then
      write_config_value "ALERT_CHAT_ID" "$INPUT_CHAT_ID" "${INSTALL_DIR}/config.conf"
      echo -e "  ${GREEN}✓${NC} 飞书告警已配置"
    fi

    read -rp "  Webhook 告警 URL (Slack/Discord/自定义): " INPUT_WEBHOOK
    if [ -n "$INPUT_WEBHOOK" ]; then
      write_config_value "ALERT_WEBHOOK_URL" "$INPUT_WEBHOOK" "${INSTALL_DIR}/config.conf"
      echo -e "  ${GREEN}✓${NC} Webhook 告警已配置"
    fi
  else
    echo ""
    echo -e "  ${YELLOW}!${NC} 非交互模式，请手动编辑配置文件："
    echo "    ${INSTALL_DIR}/config.conf"
  fi
fi

# 读取最终配置（安全方式，不 source）
FINAL_PORT=$(grep '^PORT=' "${INSTALL_DIR}/config.conf" 2>/dev/null | head -1 | cut -d= -f2-)
FINAL_PORT="${FINAL_PORT:-8899}"
FINAL_UPSTREAM=$(grep '^UPSTREAM_URL=' "${INSTALL_DIR}/config.conf" 2>/dev/null | head -1 | cut -d= -f2-)

echo ""

# ─── 4. 注册服务 ──────────────────────────────────────

echo -e "${BOLD}[4/4] 注册服务${NC}"
echo ""

NODE_BIN="$(command -v node)"
if [ -z "$NODE_BIN" ]; then
  echo -e "  ${RED}✗${NC} 找不到 node 可执行文件"
  exit 1
fi

if [ "${NO_SYSTEMD}" = "1" ]; then
  echo -e "  ${YELLOW}!${NC} 跳过 systemd 配置"
  echo "  手动启动: node ${INSTALL_DIR}/proxy.js"
else
  mkdir -p "${SERVICE_DIR}"
  cat > "${SERVICE_DIR}/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=Cache Keepalive Proxy for Anthropic API
After=network.target

[Service]
Type=simple
WorkingDirectory=${INSTALL_DIR}
ExecStart=${NODE_BIN} ${INSTALL_DIR}/proxy.js
ExecReload=/bin/kill -HUP \$MAINPID
Restart=on-failure
RestartSec=5
Environment=HOME=${HOME}

[Install]
WantedBy=default.target
EOF

  systemctl --user daemon-reload
  systemctl --user enable "${SERVICE_NAME}" 2>/dev/null
  echo -e "  ${GREEN}✓${NC} systemd 用户服务已注册（随用户登录自动启动）"

  # 提示 linger
  if ! loginctl show-user "$(whoami)" 2>/dev/null | grep -q "Linger=yes"; then
    echo -e "  ${YELLOW}提示${NC}: 如需开机即启动（不登录也运行），执行："
    echo "    sudo loginctl enable-linger $(whoami)"
  fi

  # 启动
  if [ -n "$FINAL_UPSTREAM" ]; then
    systemctl --user restart "${SERVICE_NAME}"
    sleep 1

    if systemctl --user is-active "${SERVICE_NAME}" &>/dev/null; then
      echo -e "  ${GREEN}✓${NC} 代理已启动"

      if curl -sf "http://127.0.0.1:${FINAL_PORT}/status" >/dev/null 2>&1; then
        echo -e "  ${GREEN}✓${NC} 健康检查通过 (端口 ${FINAL_PORT})"
      fi
    else
      echo -e "  ${RED}✗${NC} 启动失败，查看日志："
      echo "    journalctl --user -u ${SERVICE_NAME} -n 20"
    fi
  else
    echo -e "  ${YELLOW}!${NC} 上游地址未设置，服务未启动"
    echo "  编辑 config.conf 后手动启动: systemctl --user start ${SERVICE_NAME}"
  fi
fi

# ─── 完成 ─────────────────────────────────────────────

echo ""
echo -e "${CYAN}════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "  ${GREEN}${BOLD}✓ 安装完成！${NC}"
echo ""
echo -e "  ${BOLD}接下来：${NC}"
echo ""
echo "  1. 把 OpenClaw 的 Anthropic API 地址指向代理："
echo -e "     ${CYAN}ANTHROPIC_BASE_URL=http://127.0.0.1:${FINAL_PORT}${NC}"
echo ""
echo "  2. 重启 OpenClaw："
echo -e "     ${CYAN}openclaw gateway restart${NC}"
echo ""
echo "  3. 发几条消息后，查看缓存状态："
echo -e "     ${CYAN}curl http://127.0.0.1:${FINAL_PORT}/status | python3 -m json.tool${NC}"
echo ""
echo -e "  配置文件: ${INSTALL_DIR}/config.conf"
echo "  (多数配置修改后自动生效；UPSTREAM_URL 和 PORT 需重启服务)"
echo ""
