# OpenClaw Cache Keepalive Proxy

> [English](./README.en.md)

**自动保活 Anthropic Prompt Cache，让对话间隔超过 5 分钟也不丢缓存。**

---

## 为什么需要这个？

Anthropic 的 Prompt Cache 有 **5 分钟 TTL**——如果 5 分钟内没有新请求，缓存就过期了。下一条消息会触发完整的缓存重建（`cache_creation`），按上下文大小收费。

但人类聊天不是机器——回消息的间隔经常超过 5 分钟。你只是去倒了杯水、看了个消息、想了一会儿，回来缓存就没了。

**这个代理在你不说话的时候，帮你保住缓存。**

## 能省多少钱？

**一句话**：缓存重建比缓存读取贵 **12.5 倍**。代理的作用就是用便宜的"读"来避免昂贵的"重建"。

### 一个例子

你在用 Opus，对话上下文约 200K tokens：

| 场景 | 费用 |
|------|------|
| **没有代理**：喝了杯水，6 分钟后回来，缓存过期重建 | **$3.75** |
| **有代理**：同样 6 分钟，代理保活了一次，你回来缓存还在 | **$0.60** |
| **一杯水省下** | **$3.15** |

### 不同上下文大小的单次节省

以 Opus 官方价为例，每避免一次缓存重建：

| 上下文 | 重建费用 | 保活费用 | 💰 省下 |
|--------|---------|---------|--------|
| 50K | $0.94 | ~$0.15 | **$0.79** |
| 100K | $1.88 | ~$0.30 | **$1.58** |
| 200K | $3.75 | ~$0.60 | **$3.15** |
| 300K | $5.63 | ~$0.90 | **$4.73** |

### 日常使用估算

假设每天有 5 次对话间隔超过 5 分钟：

| 上下文 | 每天省 | 每月省 |
|--------|-------|-------|
| 100K | ~$8 | **~$240** |
| 200K | ~$16 | **~$480** |
| 300K | ~$24 | **~$720** |

### 为什么永远不亏？

代理 20 分钟没活动就自动停。在这 20 分钟内最多保活 4 次。而一次缓存重建的费用 = 12.5 次保活的费用。**只要避免了一次重建，就已经赚回来了。**

> 配置费率后，`/status` 会自动追踪和显示实际节省金额。

## 工作原理

```
OpenClaw → localhost:8899（本代理）→ 你的 Anthropic API 上游
                  │
                  ├── 正常转发所有请求
                  ├── 上游成功响应后，按会话缓存请求体
                  └── 每 4.5 分钟发送一次 max_tokens=1 的保活请求
                      → 刷新缓存 TTL，保住已有缓存
```

## 核心特性

- **按会话独立管理** — 多个对话窗口各自保活，互不干扰
- **零依赖** — 纯 Node.js，不需要 npm install
- **多数配置热加载** — 修改 `config.conf` 多数配置自动生效（已存在的定时器在下一轮调度时更新）
- **失败自动重试** — 网络异常时 10 秒后重试一次
- **告警通知** — 缓存未命中或保活失败时通过 Webhook 或飞书提醒
- **状态接口** — `GET /status` 查看所有会话的缓存状态和费用节省
- **systemd 集成** — 一键安装，随用户登录自动启动，崩溃自动恢复
- **费用追踪** — 配置费率后自动计算节省金额
- **请求超时** — 所有外发连接有超时保护，不会因网络问题永久挂起

## 快速开始

```bash
git clone https://github.com/liaozaozao/openclaw-cache-keepalive.git
cd openclaw-cache-keepalive
chmod +x install.sh
./install.sh
```

安装向导会引导你完成：
1. 填写上游 API 地址（你的 Anthropic API 端点）
2. 可选配置告警通知
3. 自动注册 systemd 服务并启动

安装完成后，把 OpenClaw 的 Anthropic API 地址改为代理地址，重启即可：

```bash
# 在 .env 或 OpenClaw 配置中设置：
ANTHROPIC_BASE_URL=http://127.0.0.1:8899

# 重启 OpenClaw
openclaw gateway restart
```

## 运行要求

- **Node.js 18+**（无需额外依赖）
- **Linux + systemd**（安装器自动创建用户级服务）
- 已配置 Anthropic API 的 **OpenClaw** 实例

> 没有 systemd？也能用——直接 `node proxy.js` 运行，自行管理进程即可。

## 配置说明

配置文件路径：`~/.openclaw/cache-keepalive-proxy/config.conf`

| 配置项 | 默认值 | 热加载 | 说明 |
|--------|--------|--------|------|
| `UPSTREAM_URL` | *（必填）* | ❌ 需重启 | Anthropic API 上游地址（支持带路径的中转地址） |
| `PORT` | `8899` | ❌ 需重启 | 代理监听端口 |
| `KEEPALIVE_MS` | `270000`（4 分 30 秒） | ✅ | 保活请求间隔 |
| `EXPIRE_MS` | `1200000`（20 分钟） | ✅ | 会话过期时间（无活动后） |
| `RETRY_DELAY_MS` | `10000`（10 秒） | ✅ | 失败重试等待时间 |
| `KEEPALIVE_EXCLUDE` | `h:` | ✅ | 排除的 session ID 前缀 |
| `ALERT_WEBHOOK_URL` | *（空）* | ✅ | Webhook 告警地址 |
| `ALERT_CHAT_ID` | *（空）* | ✅ | 飞书告警群 ID |
| `COST_CACHE_WRITE_PER_MTOK` | `0` | ✅ | cache_write 价格（$/MTok） |
| `COST_CACHE_READ_PER_MTOK` | `0` | ✅ | cache_read 价格（$/MTok） |

> **热加载**：标记 ✅ 的配置项修改后在下一轮调度时生效。标记 ❌ 的需要重启服务。环境变量优先级高于配置文件。

### 费用追踪

在配置文件中设置你的实际费率，`/status` 会自动显示节省金额：

```
# Opus 官方价
COST_CACHE_WRITE_PER_MTOK=18.75
COST_CACHE_READ_PER_MTOK=1.50

# Sonnet 官方价
# COST_CACHE_WRITE_PER_MTOK=3.75
# COST_CACHE_READ_PER_MTOK=0.30
```

> 只需要 cache_write 和 cache_read 两个价格。input/output 价格不影响省钱计算——代理只把"重建"变成"读取"，不产生额外的 input/output 消耗。

### 告警配置

当缓存意外失效（cache_write > 0）或保活请求失败时，代理会发送告警。

**方式一：通用 Webhook**（Slack / Discord / 自定义）：
```
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/xxx
```

**方式二：飞书**（OpenClaw + 飞书用户推荐）：
```
ALERT_CHAT_ID=oc_xxxxxxxxxxxx
```
飞书凭证自动从 `~/.openclaw/openclaw.json` 读取，无需额外配置。

**都不配？** 告警会写入 `.alerts.jsonl` 并输出到日志。

## 监控

```bash
# 查看代理状态（JSON，含费用节省信息）
curl http://127.0.0.1:8899/status | python3 -m json.tool

# 查看服务状态
systemctl --user status cache-keepalive-proxy

# 实时日志
journalctl --user -u cache-keepalive-proxy -f

# 重启（修改 UPSTREAM_URL 或 PORT 后需要）
systemctl --user restart cache-keepalive-proxy
```

> `/status` 仅监听本机（127.0.0.1），仅供本地排障使用。

## 缓存保活时长

最后一条消息发出后，缓存保持有效的时间线：

```
最后一条消息
  ├── +4m30s → 保活 1（刷新 TTL）
  ├── +9m00s → 保活 2
  ├── +13m30s → 保活 3
  └── +18m00s → 保活 4
      └── +5m TTL → ≈ 第 23 分钟缓存才真正过期

20 分钟无新消息 → 会话过期，停止保活
```

**实际保护窗口：~22-23 分钟。**

## 注意事项

- **不要删除 `thinking` 字段**：代理保留原始请求中的 `thinking` 结构，这是缓存前缀匹配的必要条件。
- **重启代理是安全的**：重启只意味着下一次真实请求会重建一次缓存，之后恢复正常。
- **多会话支持**：每个对话窗口独立维护缓存和保活定时器。
- **只在成功后保活**：代理只在上游返回 2xx 后才缓存会话并启动保活。

## 已知限制

- **非 OpenClaw 场景**：代理默认从 system 字段提取 `chat_id` 来区分会话。其他客户端的请求会使用 hash-based fallback，保活粒度可能不够精确。
- **第三方 relay**：代理转发除 hop-by-hop 以外的所有请求头。如果你的 relay 使用了特殊的认证机制，请验证兼容性。

## 常见问题

**Q: 保活请求会不会影响正常对话？**

不会。保活请求设置了 `max_tokens=1`，不经过 OpenClaw，不会出现在对话历史中。

**Q: 代理挂了怎么办？**

systemd 会自动重启。重启后第一次请求会重建缓存，之后恢复正常。

**Q: 上游换了地址怎么办？**

编辑 `config.conf` 中的 `UPSTREAM_URL`，然后重启服务。

## 绕过 / 卸载

**临时绕过**：
```bash
systemctl --user stop cache-keepalive-proxy
# 把 OpenClaw 的 API 地址改回上游，重启 gateway
```

**完全卸载**：
```bash
systemctl --user stop cache-keepalive-proxy
systemctl --user disable cache-keepalive-proxy
rm -rf ~/.openclaw/cache-keepalive-proxy
rm ~/.config/systemd/user/cache-keepalive-proxy.service
systemctl --user daemon-reload
```

## 许可证

[MIT](./LICENSE)
