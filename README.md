# OpenClaw Cache Keepalive Proxy

> [English](./README.en.md)

**自动保活 Anthropic Prompt Cache，让对话间隔超过 5 分钟也不丢缓存。**

---

## 为什么需要这个？

Anthropic 的 Prompt Cache 有 **5 分钟 TTL**——如果 5 分钟内没有新请求，缓存就过期了。下一条消息会触发完整的缓存重建（`cache_creation`），按上下文大小收费。

一次典型的 OpenClaw 会话有 100K-300K tokens 的上下文。每次缓存重建的成本在 **$0.30 ~ $1.00+**。

但人类聊天不是机器——回消息的间隔经常超过 5 分钟。你只是去倒了杯水、看了个消息、想了一会儿，回来缓存就没了。

**这个代理在你不说话的时候，帮你保住缓存。**

## 工作原理

```
OpenClaw → localhost:8899（本代理）→ 你的 Anthropic API 上游
                  │
                  ├── 正常转发所有请求
                  ├── 按会话（session）缓存请求体
                  └── 每 4.5 分钟发送一次 max_tokens=1 的保活请求
                      → 刷新缓存 TTL，保住已有缓存
```

- 每次保活消耗 **~1 个 token**（≈ $0.000003），避免的是一次完整缓存重建（$0.30-$1.00+）
- 最后一条消息后，缓存最多可保持 **~22 分钟**
- 20 分钟无活动后自动停止保活，释放资源

## 核心特性

- **按会话独立管理** — 多个对话窗口各自保活，互不干扰
- **零依赖** — 纯 Node.js，不需要 npm install
- **配置热加载** — 修改 `config.conf` 自动生效，无需重启
- **失败自动重试** — 网络异常时 10 秒后重试一次
- **告警通知** — 缓存未命中时通过 Webhook 或飞书提醒
- **状态接口** — `GET /status` 查看所有会话的缓存状态
- **systemd 集成** — 一键安装，开机自启，崩溃自动恢复

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
| `UPSTREAM_URL` | *（必填）* | ❌ 需重启 | Anthropic API 上游地址 |
| `PORT` | `8899` | ❌ 需重启 | 代理监听端口 |
| `KEEPALIVE_MS` | `270000`（4 分 30 秒） | ✅ | 保活请求间隔 |
| `EXPIRE_MS` | `1200000`（20 分钟） | ✅ | 会话过期时间（无活动后） |
| `RETRY_DELAY_MS` | `10000`（10 秒） | ✅ | 失败重试等待时间 |
| `KEEPALIVE_EXCLUDE` | `h:` | ✅ | 排除的 session ID 前缀（逗号分隔） |
| `ALERT_WEBHOOK_URL` | *（空）* | ✅ | Webhook 告警地址 |
| `ALERT_CHAT_ID` | *（空）* | ✅ | 飞书告警群 ID |

> **热加载**：标记 ✅ 的配置项修改后立即生效。标记 ❌ 的需要重启服务：`systemctl --user restart cache-keepalive-proxy`

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
# 查看代理状态（JSON）
curl http://127.0.0.1:8899/status | python3 -m json.tool

# 查看服务状态
systemctl --user status cache-keepalive-proxy

# 实时日志
journalctl --user -u cache-keepalive-proxy -f

# 重启（修改 UPSTREAM_URL 或 PORT 后需要）
systemctl --user restart cache-keepalive-proxy
```

`/status` 接口返回：
- 服务运行时间和配置
- 每个会话：缓存状态、保活次数、命中率、下次保活时间
- 全局统计和最近告警

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

**实际保护窗口：~22-23 分钟。** 对大多数对话间隔来说足够了。

## 注意事项

- **不要删除 `thinking` 字段**：代理保留原始请求中的 `thinking` 结构，这是缓存前缀匹配的必要条件。删除它会导致缓存失效，每次保活都会重建缓存（非常贵）。
- **定时器基于请求发出时间**：保活调度使用请求发出时间（接近 Anthropic 开始计算 TTL 的时刻），而非响应到达时间。
- **重启代理是安全的**：代理是独立服务，重启只意味着下一次真实请求会重建一次缓存，之后恢复正常。
- **多会话支持**：每个对话窗口独立维护缓存和保活定时器。

## 常见问题

**Q: 保活请求会不会影响正常对话？**

不会。保活请求设置了 `max_tokens=1`，响应几乎没有内容。它不经过 OpenClaw，不会出现在对话历史中。

**Q: 能用在非 OpenClaw 的场景吗？**

可以，但需要一些适配。代理默认从 Anthropic API 请求体的 `system` 字段中提取 `chat_id` 来区分会话（这是 OpenClaw 的注入格式）。如果你的系统不注入 `chat_id`，所有请求会被归入同一个 hash-based session，保活仍然有效，只是粒度更粗。

**Q: 代理挂了怎么办？**

systemd 配了 `Restart=on-failure`，会自动重启。重启后第一次请求会重建缓存，之后恢复正常。对话不会丢失，只是丢一次缓存。

**Q: 上游换了地址怎么办？**

编辑 `config.conf` 中的 `UPSTREAM_URL`，然后重启服务：
```bash
systemctl --user restart cache-keepalive-proxy
```

## 绕过 / 卸载

**临时绕过**（直连上游）：
```bash
# 把 OpenClaw 的 Anthropic API 地址改回上游
# 然后重启 OpenClaw gateway
systemctl --user stop cache-keepalive-proxy
```

**完全卸载**：
```bash
systemctl --user stop cache-keepalive-proxy
systemctl --user disable cache-keepalive-proxy
rm -rf ~/.openclaw/cache-keepalive-proxy
rm ~/.config/systemd/user/cache-keepalive-proxy.service
systemctl --user daemon-reload
```

## 技术细节

如果你想了解实现原理或贡献代码：

- **会话识别**：从 Anthropic API 请求的 `system` 字段中提取 OpenClaw 注入的 `chat_id`。无法提取时 fallback 到 MD5 hash。
- **保活请求**：完整复制原始请求体（保持缓存前缀匹配），只修改 `max_tokens=1`、`stream=false`、`thinking.budget_tokens=128`。
- **版本检查**：每个 session 有 version 号，防止并发请求产生孤儿定时器。
- **重试策略**：网络/HTTP 错误重试一次；缓存未命中（cache_write > 0）不重试——缓存已重建，再试只是浪费。

## 许可证

[MIT](./LICENSE)
