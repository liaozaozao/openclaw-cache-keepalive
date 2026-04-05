#!/bin/bash
# OpenClaw Cache Keepalive Proxy — macOS 手动启动脚本
# 从仓库源码直接运行；install.sh 安装的服务使用 ~/.openclaw/ 下的副本。
# 用法: ./scripts/macos/run.sh [配置文件路径]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
CONFIG_PATH="${1:-${REPO_ROOT}/config.conf}"

NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
  echo "错误: 未找到 node，请先安装 Node.js 18+"
  exit 1
fi

if [ ! -f "$CONFIG_PATH" ]; then
  if [ ! -f "${REPO_ROOT}/config.example.conf" ]; then
    echo "错误: config.example.conf 未找到，请确认在仓库目录下运行"
    exit 1
  fi
  cp "${REPO_ROOT}/config.example.conf" "$CONFIG_PATH"
  echo "已创建配置文件: ${CONFIG_PATH}"
  echo "请先编辑 UPSTREAM_URL，然后重新运行此脚本。"
  exit 0
fi

export CONF_FILE="$CONFIG_PATH"
exec "$NODE_BIN" "${REPO_ROOT}/proxy.js"
