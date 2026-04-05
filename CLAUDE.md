# OpenClaw Cache Keepalive Proxy

## 核心目标

这个项目只做一件事：**作为透明代理，通过定时发送最小请求来保持 Anthropic Prompt Cache 不过期。**

Anthropic Prompt Cache TTL 为 5 分钟。代理在客户端与上游之间透明转发所有请求，同时每 4.5 分钟发送一次 `max_tokens=1` 的 keepalive 请求，用便宜的 `cache_read` 避免昂贵的 `cache_creation`。

## 设计原则

- **最简原则**：只实现透明转发和定时保活。不做请求修改、不做缓存存储、不做负载均衡。任何超出这两个核心功能的特性都应被质疑。
- **零依赖**：纯 Node.js 标准库，不需要 `npm install`。
- **只保活高置信主会话**：子代理、标题请求、Haiku 会话不进入保活队列，避免模板污染。
- **保活在上游成功后才启动**：不对失败/中断的请求启动保活。

## 架构

```
客户端 (OpenClaw / Claude Code)
    ↓
localhost:8899 (本代理 - proxy.js)
    ↓ 透明转发
Anthropic 兼容上游
```

关键路径：
1. 客户端请求进来 → 原样转发到上游
2. 上游响应流完整结束 → 缓存该会话的请求模板
3. 每 4.5 分钟 → 用缓存模板发 `max_tokens=1` keepalive
4. 20 分钟无活动 → 清理会话

## 文件结构

- `proxy.js` — 代理主入口，所有核心逻辑在这一个文件里
- `install.sh` — 安装器，支持 macOS (launchd) / Linux (systemd) / 手动模式
- `ui/` — `/status/ui` 浏览器状态面板（纯前端，无构建步骤）
- `scripts/macos/` — macOS 手动启动脚本
- `scripts/windows/` — Windows 启动脚本
- `extras/cache-status-cmd/` — 可选的 `/cache` 斜杠命令（非核心）
- `config.example.conf` — 配置模板

## 开发注意事项

- 修改 proxy.js 后用 `node --check proxy.js` 验证语法
- 修改 install.sh 后用 `bash -n install.sh` 验证语法
- install.sh 必须兼容 bash 3.2（macOS 自带版本）
- 代理只监听 `127.0.0.1`，这是刻意的安全决策
- 配置文件不支持行内注释（`KEY=value # comment` 中 `# comment` 会被当作值的一部分）
- `UPSTREAM_URL` 和 `PORT` 需重启；其他配置热加载

## 平台支持

| 平台 | 服务管理 | 安装方式 |
|------|----------|----------|
| macOS | launchd (plist) | `./install.sh` 自动检测 |
| Linux | systemd (user service) | `./install.sh` 自动检测 |
| Windows | 手动进程 | `scripts/windows/run.ps1` |
| 其他/容器 | 手动进程 | `node proxy.js` |
