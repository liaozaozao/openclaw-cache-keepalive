# OpenClaw Cache Keepalive Proxy

> 当前版本：v2.0.0

> [English](./README.en.md)

**自动保活 Anthropic Prompt Cache，支持 OpenClaw 与 Claude Code 主会话。**

---

## 项目定位

这个代理运行在客户端与 Anthropic 兼容上游之间，作用是：

- 正常转发请求
- 在上游成功响应且流完整后，保存“可安全保活”的主会话请求模板
- 每 4 分 30 秒发送一次极小 keepalive 请求，刷新 Prompt Cache TTL

当前支持：

| 客户端 | 会话识别 | 保活策略 |
|--------|----------|----------|
| OpenClaw | `system.chat_id` | 正常保活 |
| Claude Code 主会话（Opus / Sonnet） | `metadata.user_id.session_id` | 正常保活 |
| Claude Code 标题请求 | 同主会话 `session_id` | **不保活** |
| Claude Code 子代理请求 | 同主会话 `session_id` | **不保活** |
| Claude Code Haiku 主会话 | `metadata.user_id.session_id` | **不保活** |

> 关键原则：只让高置信主会话模板进入保活；子代理、标题请求、一次性轻请求不会覆盖模板。

## 为什么需要它

Anthropic Prompt Cache 默认 TTL 只有 **5 分钟**。  
如果 5 分钟内没有新请求，下一条消息就会触发完整缓存重建（`cache_creation`），成本远高于缓存读取（`cache_read`）。

这个代理的目标就是：

- 用便宜的“读缓存”请求
- 避免昂贵的“重建缓存”

## 工作原理

```text
OpenClaw / Claude Code → localhost:8899（本代理）→ Anthropic 兼容上游
                              │
                              ├── 正常转发所有请求
                              ├── 只缓存高置信主会话模板
                              └── 每 4.5 分钟发送一次 max_tokens=1 keepalive
                                  → 刷新缓存 TTL
```

## 核心特性

- **按会话独立管理**：多个 OpenClaw / Claude Code 主窗口互不干扰
- **Claude Code 智能识别**：自动检测并分类主会话、子代理、标题请求和 Haiku 会话
- **Claude Code 子代理安全排除**：子代理请求只刷新活动时间，不会污染主模板
- **Haiku 不保活**：Claude Code 的 Haiku 主会话不会进入保活队列
- **零依赖**：纯 Node.js，不需要 `npm install`
- **多数配置热加载**：修改 `config.conf` 后，多数配置在下一轮调度生效
- **失败自动重试**：网络错误时 10 秒后重试一次
- **状态接口**：`GET /status` 查看会话状态、保活结果和排除原因
- **浏览器状态面板**：`/status/ui` 提供会话分组、手动停止、筛选过滤和自动刷新
- **配置校验警告**：keepalive 间隔 >= TTL 或 >= 过期时间时自动告警
- **Linux 可安装为 systemd 用户服务**
- **Windows 可直接运行 Node 进程**

## 快速开始

### Linux / Debian

```bash
git clone https://github.com/liaozaozao/openclaw-cache-keepalive.git
cd openclaw-cache-keepalive
chmod +x install.sh
./install.sh
```

`install.sh` 会：

1. 复制文件到 `~/.openclaw/cache-keepalive-proxy/`
2. 创建配置文件
3. 注册并启动 `systemd --user` 服务

### macOS

```bash
git clone https://github.com/liaozaozao/openclaw-cache-keepalive.git
cd openclaw-cache-keepalive
chmod +x install.sh
./install.sh
```

`install.sh` 会自动检测 macOS 并：

1. 复制文件到 `~/.openclaw/cache-keepalive-proxy/`
2. 创建配置文件
3. 注册并启动 `launchd` 服务（随用户登录自动启动）

服务管理：

```bash
# 查看日志
tail -f ~/.openclaw/cache-keepalive-proxy/proxy.log

# 停止服务
launchctl unload ~/Library/LaunchAgents/com.openclaw.cache-keepalive-proxy.plist

# 启动服务
launchctl load ~/Library/LaunchAgents/com.openclaw.cache-keepalive-proxy.plist
```

也可以不通过 `install.sh`，直接手动运行：

```bash
chmod +x scripts/macos/run.sh
./scripts/macos/run.sh
```

### Windows

Windows 不使用 `install.sh`。直接运行：

```powershell
Set-Location <仓库目录>
.\scripts\windows\run.ps1
```

如果需要长期后台运行，建议使用：

- Windows Terminal / PowerShell 长期开一个窗口
- 或 Windows 任务计划程序 / NSSM 托管 Node 进程

也可以直接运行：

```cmd
scripts\windows\run.cmd
```

说明：

- 首次运行如果没有 `config.conf`，脚本会自动从 `config.example.conf` 复制一份
- 然后你只需要编辑 `UPSTREAM_URL`
- 脚本会自动把 `CONF_FILE` 指向仓库内的 `config.conf`
- Windows 启动脚本已整理到 `scripts/windows/`

## 目录结构

- `proxy.js`：代理主入口
- `ui/`：状态页模板、样式和前端逻辑
- `scripts/macos/`：macOS 启动脚本
- `scripts/windows/`：Windows 启动脚本
- `extras/cache-status-cmd/`：可选的 `/cache` 斜杠命令

## 配置客户端

### OpenClaw

把 OpenClaw 的 Anthropic Base URL 指向代理：

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:8899
openclaw gateway restart
```

建议从 [config.openclaw.example.conf](./config.openclaw.example.conf) 开始。
这份文件是面向 OpenClaw 的精简起步模板；完整字段说明仍以 [config.example.conf](./config.example.conf) 为准。

### Claude Code

把 Claude Code 的 `ANTHROPIC_BASE_URL` 指向代理。

方式一：在 Claude Code settings 中配置

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:8899"
  }
}
```

方式二：命令行指定 settings 文件

```powershell
claude --settings "$env:USERPROFILE\.claude\settings.proxy.json"
```

建议从 [config.claude-code.example.conf](./config.claude-code.example.conf) 开始。
这份文件是面向 Claude Code 的精简起步模板；完整字段说明仍以 [config.example.conf](./config.example.conf) 为准。

## 运行要求

- **Node.js 18+**
- macOS 长期部署推荐：
  - **macOS 10.15+**（Catalina 及更新版本）
  - **launchd**（系统自带，`install.sh` 自动配置）
- Linux 长期部署推荐：
  - **Debian / Ubuntu / 其他 Linux**
  - **systemd**
- Windows 长期部署推荐：
  - 常驻终端窗口，或任务计划程序 / NSSM

## 配置说明

正式配置模板见 [config.example.conf](./config.example.conf)。

配置文件常见位置：

- Linux 安装版：`~/.openclaw/cache-keepalive-proxy/config.conf`
- 手动运行版：任意路径，通过 `CONF_FILE` 指定

| 配置项 | 默认值 | 热加载 | 说明 |
|--------|--------|--------|------|
| `UPSTREAM_URL` | *必填* | ❌ | Anthropic 兼容上游地址 |
| `PORT` | `8899` | ❌ | 本地监听端口 |
| `KEEPALIVE_SECONDS` | `270` | ✅ | 保活间隔，默认 4 分 30 秒 |
| `EXPIRE_SECONDS` | `1200` | ✅ | 无活动后会话过期时间，默认 20 分钟 |
| `RETRY_DELAY_SECONDS` | `10` | ✅ | 保活失败后的重试等待时间 |
| `KEEPALIVE_EXCLUDE` | `h:` | ✅ | 按 session ID 前缀排除 |
| `ALERT_WEBHOOK_URL` | 空 | ✅ | 通用告警 webhook |
| `ALERT_CHAT_ID` | 空 | ✅ | 飞书告警 chat_id |
| `INSPECT_REQUESTS` | `0` | ✅ | 安全摘要调试开关 |
| `FULL_CAPTURE_REQUESTS` | `0` | ✅ | 完整请求捕获调试开关，不建议常开 |
| `INSPECT_MAX_ENTRIES` | `30` | ✅ | inspect 内存环形缓冲区最大条目数 |
| `FULL_CAPTURE_MAX_ENTRIES` | `10` | ✅ | capture 内存环形缓冲区最大条目数 |
| `COST_CACHE_WRITE_PER_MTOK` | `0` | ✅ | cache_write 单价 |
| `COST_CACHE_READ_PER_MTOK` | `0` | ✅ | cache_read 单价 |

> 新配置建议统一使用秒。旧版 `KEEPALIVE_MS / EXPIRE_MS / RETRY_DELAY_MS` 仍兼容，但仅用于兼容旧部署。
>
> 调试开关只用于短期排障。正式运行时应保持关闭。

## `/status` 状态接口

```bash
curl http://127.0.0.1:8899/status | python3 -m json.tool
```

浏览器状态页：

```text
http://127.0.0.1:8899/status/ui
```

说明：

- `/status` 继续保留为机器可读 JSON，兼容现有脚本与排障命令
- `/status/ui` 基于 `/status` 数据做本地可视化展示，不引入额外依赖或构建步骤
- `/status/ui` 默认中文，支持页面内切换英文，并记住上次语言选择

状态输出中和 Claude Code 相关的关键字段：

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
  - `header.x-claude-code-session-id`（备用来源）
  - `system.chat_id`
- `keepaliveEnabled`
  - `true`：进入保活队列
  - `false`：已显式排除
- `excludedReason`
  - `haiku_model`
  - `prefix_excluded`
  - `unknown_request_shape`

说明：

- Claude Code 的标题请求和子代理请求不会出现在活跃保活列表里
- Claude Code 的 Haiku 主会话会被明确标记为排除，不参与保活

## 费用追踪

如果你填写了价格，`/status` 会给出估算节省金额：

```ini
COST_CACHE_WRITE_PER_MTOK=18.75
COST_CACHE_READ_PER_MTOK=1.50
```

> 这里只关心 `cache_write` 和 `cache_read`，不关心 output 成本。

## 告警

### 通用 Webhook

```ini
ALERT_WEBHOOK_URL=https://hooks.slack.com/services/xxx
```

### 飞书

```ini
ALERT_CHAT_ID=oc_xxxxxxxxxxxx
```

飞书凭证会从 OpenClaw 配置中自动读取。

## 调试与排障

安全摘要调试：

- `GET /inspect`
- 输出到 `.inspect.jsonl`

完整捕获调试：

- `GET /capture`
- 输出到 `.capture.jsonl`
- 鉴权头会脱敏，但正文仍会落盘

正式运行前建议删除：

- `.inspect.jsonl`
- `.capture.jsonl`

## 隐私与本地路径

仓库中的文档和示例配置不应包含你的本地绝对路径、用户名或调试产物。

正式使用时建议：

- 使用仓库相对路径或 `$env:USERPROFILE`
- 不要把本地调试配置、抓取文件、个人 settings 文件提交进仓库

## 已确认行为

根据真实请求验证：

- OpenClaw 原有保活路径不受影响
- Claude Code 主会话（Opus / Sonnet）可成功保活
- Claude Code 子代理请求不会覆盖主模板
- Claude Code Haiku 会话不保活
- Claude Code v2.1.85+ 的 `adaptive` thinking 类型正确处理
- 保活请求 User-Agent 带 `cache-keepalive-proxy/` 前缀，便于在 API 日志中区分
- 当 `metadata.user_id` 解析失败时，自动回退到 `x-claude-code-session-id` header

## 已知限制

- Claude Code 未来版本如果显著更改请求结构，主模板准入规则可能需要微调
- 代理默认只监听 `127.0.0.1`
- macOS 的 `/cache` 斜杠命令需要 Python 3（可通过 `brew install python3` 或 Xcode Command Line Tools 安装）
- Windows 目前没有内置服务安装器，推荐手动托管 Node 进程

## 绕过 / 卸载

### macOS

临时绕过：

```bash
launchctl unload ~/Library/LaunchAgents/com.openclaw.cache-keepalive-proxy.plist
```

卸载：

```bash
./install.sh --uninstall
```

### Linux

临时绕过：

```bash
systemctl --user stop cache-keepalive-proxy
```

卸载：

```bash
./install.sh --uninstall
```

### Windows

直接停止运行 `node proxy.js` 的终端 / 任务即可。

## 许可证

[MIT](./LICENSE)
