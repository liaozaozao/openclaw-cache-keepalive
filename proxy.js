#!/usr/bin/env node
/**
 * OpenClaw Cache Keepalive Proxy v1.7.0
 *
 * Reverse proxy between OpenClaw and Anthropic API upstream.
 * Automatically sends keepalive requests to prevent prompt cache TTL expiry.
 *
 * Features:
 * - Per-session cache bucketing with automatic keepalive every 4.5 minutes
 * - 20-minute inactivity expiry
 * - Automatic retry on failure (once, after 10s)
 * - Alerts via generic webhook or Feishu API (auto-detected)
 * - GET /status structured JSON endpoint with cost savings tracking
 * - Hot-reloadable config (fs.watch + SIGHUP)
 * - Version-checked timers to prevent orphan keepalives
 * - Request timeout on all outbound connections
 * - Keepalive only activates after upstream success
 * - Claude Code session detection and classification (main/subagent/title/haiku)
 * - Project context extraction (working directory, git branch) for UI display
 * - /status/ui browser-based status dashboard
 * - /inspect and /capture debug endpoints
 * - POST /sessions/stop manual session removal
 * - Per-session and global cost savings tracking
 * - Config validation warnings (keepalive >= TTL, keepalive >= expire)
 * - Request inspection and full capture modes (hot-reloadable)
 *
 * Requirements: Node.js 18+, no external dependencies.
 *
 * @see https://github.com/liaozaozao/openclaw-cache-keepalive
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { renderStatusPage } = require('./ui/page');
const LOG = (tag, sid, msg) => console.log(`[${new Date().toISOString()}] [${tag}] [${sid || '-'}] ${msg}`);

// --- Constants ---
const VERSION = '1.7.0';
const UA_PREFIX = `cache-keepalive-proxy/${VERSION}`;
const CONF_FILE = process.env.CONF_FILE || path.join(__dirname, 'config.conf');
const CACHE_TTL_MS = 5 * 60 * 1000; // Anthropic cache TTL: 5 minutes (minimum; may extend with frequent use)
const ALERTS_FILE = path.join(__dirname, '.alerts.jsonl');
const INSPECT_FILE = path.join(__dirname, '.inspect.jsonl');
const CAPTURE_FILE = path.join(__dirname, '.capture.jsonl');
const STARTED_AT = Date.now();
const REQUEST_TIMEOUT_MS = 120000; // 2 minutes timeout for all outbound requests

// --- Configuration ---
// Startup-only (require restart): UPSTREAM_URL, PORT
// Priority: env var > config file > default
let UPSTREAM_URL = process.env.UPSTREAM_URL || '';
let PORT = process.env.PORT ? parseInt(process.env.PORT) : 0;

// Hot-reloadable via config.conf (user-facing unit: seconds)
let KEEPALIVE_MS = 270 * 1000;   // 4m30s
let EXPIRE_MS = 1200 * 1000;     // 20m
let RETRY_DELAY_MS = 10 * 1000;  // 10s
let KEEPALIVE_EXCLUDE = 'h:';
let ALERT_WEBHOOK_URL = '';
let ALERT_CHAT_ID = '';
let INSPECT_REQUESTS = false;
let INSPECT_MAX_ENTRIES = 30;
let FULL_CAPTURE_REQUESTS = false;
let FULL_CAPTURE_MAX_ENTRIES = 10;

// Cost tracking config (hot-reloadable)
let COST_CACHE_WRITE_PER_MTOK = 0; // e.g. 18.75 for Opus
let COST_CACHE_READ_PER_MTOK = 0;  // e.g. 1.50 for Opus

function parseBooleanFlag(value, fallback = false) {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function validateDurationSeconds(name, value, fallbackMs) {
  const validated = validatePositive(name, parseFloat(value), fallbackMs / 1000);
  return Math.round(validated * 1000);
}

// Apply env vars for hot-reloadable fields (env > config file)
function applyEnvOverrides() {
  if (process.env.KEEPALIVE_SECONDS) KEEPALIVE_MS = validateDurationSeconds('KEEPALIVE_SECONDS', process.env.KEEPALIVE_SECONDS, KEEPALIVE_MS);
  else if (process.env.KEEPALIVE_MS) KEEPALIVE_MS = validatePositive('KEEPALIVE_MS', parseInt(process.env.KEEPALIVE_MS), KEEPALIVE_MS);
  if (process.env.EXPIRE_SECONDS) EXPIRE_MS = validateDurationSeconds('EXPIRE_SECONDS', process.env.EXPIRE_SECONDS, EXPIRE_MS);
  else if (process.env.EXPIRE_MS) EXPIRE_MS = validatePositive('EXPIRE_MS', parseInt(process.env.EXPIRE_MS), EXPIRE_MS);
  if (process.env.RETRY_DELAY_SECONDS) RETRY_DELAY_MS = validateDurationSeconds('RETRY_DELAY_SECONDS', process.env.RETRY_DELAY_SECONDS, RETRY_DELAY_MS);
  else if (process.env.RETRY_DELAY_MS) RETRY_DELAY_MS = validatePositive('RETRY_DELAY_MS', parseInt(process.env.RETRY_DELAY_MS), RETRY_DELAY_MS);
  if (process.env.KEEPALIVE_EXCLUDE) KEEPALIVE_EXCLUDE = process.env.KEEPALIVE_EXCLUDE;
  if (process.env.ALERT_WEBHOOK_URL) ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
  if (process.env.ALERT_CHAT_ID) ALERT_CHAT_ID = process.env.ALERT_CHAT_ID;
  if (process.env.INSPECT_REQUESTS) INSPECT_REQUESTS = parseBooleanFlag(process.env.INSPECT_REQUESTS, INSPECT_REQUESTS);
  if (process.env.INSPECT_MAX_ENTRIES) INSPECT_MAX_ENTRIES = validatePositive('INSPECT_MAX_ENTRIES', parseInt(process.env.INSPECT_MAX_ENTRIES), INSPECT_MAX_ENTRIES);
  if (process.env.FULL_CAPTURE_REQUESTS) FULL_CAPTURE_REQUESTS = parseBooleanFlag(process.env.FULL_CAPTURE_REQUESTS, FULL_CAPTURE_REQUESTS);
  if (process.env.FULL_CAPTURE_MAX_ENTRIES) FULL_CAPTURE_MAX_ENTRIES = validatePositive('FULL_CAPTURE_MAX_ENTRIES', parseInt(process.env.FULL_CAPTURE_MAX_ENTRIES), FULL_CAPTURE_MAX_ENTRIES);
  if (process.env.COST_CACHE_WRITE_PER_MTOK) { const n = parseFloat(process.env.COST_CACHE_WRITE_PER_MTOK); if (n >= 0) COST_CACHE_WRITE_PER_MTOK = n; }
  if (process.env.COST_CACHE_READ_PER_MTOK) { const n = parseFloat(process.env.COST_CACHE_READ_PER_MTOK); if (n >= 0) COST_CACHE_READ_PER_MTOK = n; }
}

// Validate numeric config value
function validatePositive(name, value, fallback) {
  if (!Number.isFinite(value) || value <= 0) {
    LOG('config', '-', `invalid ${name}=${value}, keeping ${fallback}`);
    return fallback;
  }
  return value;
}

// Load config file
function reloadConf() {
  try {
    if (!fs.existsSync(CONF_FILE)) return;
    const lines = fs.readFileSync(CONF_FILE, 'utf-8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      // Startup-only config (only read on first load)
      if (k === 'UPSTREAM_URL' && !UPSTREAM_URL) UPSTREAM_URL = v;
      if (k === 'PORT' && !PORT) PORT = parseInt(v) || 0;
      // Hot-reloadable config (config file sets base, env overrides later)
      if (k === 'KEEPALIVE_SECONDS') KEEPALIVE_MS = validateDurationSeconds(k, v, KEEPALIVE_MS);
      if (k === 'EXPIRE_SECONDS') EXPIRE_MS = validateDurationSeconds(k, v, EXPIRE_MS);
      if (k === 'RETRY_DELAY_SECONDS') RETRY_DELAY_MS = validateDurationSeconds(k, v, RETRY_DELAY_MS);
      if (k === 'KEEPALIVE_MS') KEEPALIVE_MS = validatePositive(k, parseInt(v), KEEPALIVE_MS);
      if (k === 'EXPIRE_MS') EXPIRE_MS = validatePositive(k, parseInt(v), EXPIRE_MS);
      if (k === 'RETRY_DELAY_MS') RETRY_DELAY_MS = validatePositive(k, parseInt(v), RETRY_DELAY_MS);
      if (k === 'KEEPALIVE_EXCLUDE') KEEPALIVE_EXCLUDE = v;
      if (k === 'ALERT_WEBHOOK_URL') ALERT_WEBHOOK_URL = v;
      if (k === 'ALERT_CHAT_ID') ALERT_CHAT_ID = v;
      if (k === 'INSPECT_REQUESTS') INSPECT_REQUESTS = parseBooleanFlag(v, INSPECT_REQUESTS);
      if (k === 'INSPECT_MAX_ENTRIES') INSPECT_MAX_ENTRIES = validatePositive(k, parseInt(v), INSPECT_MAX_ENTRIES);
      if (k === 'FULL_CAPTURE_REQUESTS') FULL_CAPTURE_REQUESTS = parseBooleanFlag(v, FULL_CAPTURE_REQUESTS);
      if (k === 'FULL_CAPTURE_MAX_ENTRIES') FULL_CAPTURE_MAX_ENTRIES = validatePositive(k, parseInt(v), FULL_CAPTURE_MAX_ENTRIES);
      if (k === 'COST_CACHE_WRITE_PER_MTOK') { const n = parseFloat(v); if (n >= 0) COST_CACHE_WRITE_PER_MTOK = n; }
      if (k === 'COST_CACHE_READ_PER_MTOK') { const n = parseFloat(v); if (n >= 0) COST_CACHE_READ_PER_MTOK = n; }
    }
    // Env vars override config file for hot-reloadable fields
    applyEnvOverrides();
    LOG('reload', '-', `conf reloaded: keepalive=${KEEPALIVE_MS / 1000}s expire=${EXPIRE_MS / 1000}s inspect=${INSPECT_REQUESTS ? 'on' : 'off'} capture=${FULL_CAPTURE_REQUESTS ? 'on' : 'off'}`);
    if (KEEPALIVE_MS >= CACHE_TTL_MS) LOG('config', '-', `WARNING: KEEPALIVE (${KEEPALIVE_MS / 1000}s) >= cache TTL (${CACHE_TTL_MS / 1000}s). Keepalive will not prevent cache expiry!`);
    if (KEEPALIVE_MS >= EXPIRE_MS) LOG('config', '-', `WARNING: KEEPALIVE (${KEEPALIVE_MS / 1000}s) >= session EXPIRE (${EXPIRE_MS / 1000}s). Sessions will expire before first keepalive fires!`);
  } catch (e) { LOG('reload', '-', `error: ${e.message}`); }
}

// Initial config load
reloadConf();
applyEnvOverrides();

// Apply defaults for startup-only config
if (!PORT) PORT = 8899;

// Validate required config
if (!UPSTREAM_URL) {
  console.error('ERROR: UPSTREAM_URL is required. Set it in config.conf or as an environment variable.');
  console.error('Example: UPSTREAM_URL=https://api.anthropic.com');
  process.exit(1);
}

let UPSTREAM;
try {
  UPSTREAM = new URL(UPSTREAM_URL);
} catch (e) {
  console.error(`ERROR: Invalid UPSTREAM_URL "${UPSTREAM_URL}": ${e.message}`);
  console.error('Must be a valid URL like https://api.anthropic.com');
  process.exit(1);
}
const UP_PROTO = UPSTREAM.protocol === 'https:' ? https : http;
const UP_PORT = UPSTREAM.port || (UPSTREAM.protocol === 'https:' ? 443 : 80);
// Preserve base path for relays like https://relay.example.com/anthropic
const UP_BASE_PATH = UPSTREAM.pathname.replace(/\/+$/, ''); // strip trailing slash

// Validate timing config
if (KEEPALIVE_MS >= CACHE_TTL_MS) {
  LOG('config', '-', `WARNING: KEEPALIVE (${KEEPALIVE_MS / 1000}s) >= cache TTL (${CACHE_TTL_MS / 1000}s). Keepalive will not prevent cache expiry!`);
}
if (KEEPALIVE_MS >= EXPIRE_MS) {
  LOG('config', '-', `WARNING: KEEPALIVE (${KEEPALIVE_MS / 1000}s) >= session EXPIRE (${EXPIRE_MS / 1000}s). Sessions will expire before first keepalive fires!`);
}

// Hot-reload on file change and SIGHUP
process.on('SIGHUP', reloadConf);
try { fs.watch(CONF_FILE, { persistent: false }, () => setTimeout(reloadConf, 500)); } catch {}

// --- Alerting ---
// Priority: 1) Generic webhook  2) Feishu API  3) Log only

let _feishuToken = null;
let _feishuTokenExpire = 0;
// In-memory ring buffer for recent alerts (avoids reading file on every /status)
const _recentAlerts = [];
const MAX_RECENT_ALERTS = 10;
const _recentInspections = [];
const _recentCaptures = [];

function pushAlert(entry) {
  _recentAlerts.push(entry);
  if (_recentAlerts.length > MAX_RECENT_ALERTS) _recentAlerts.shift();
}

function pushInspection(entry) {
  _recentInspections.push(entry);
  while (_recentInspections.length > INSPECT_MAX_ENTRIES) _recentInspections.shift();
}

function pushCapture(entry) {
  _recentCaptures.push(entry);
  while (_recentCaptures.length > FULL_CAPTURE_MAX_ENTRIES) _recentCaptures.shift();
}

function getSystemBlocks(system) {
  if (Array.isArray(system)) return system;
  if (typeof system === 'string') return [{ text: system }];
  return [];
}

function readFeishuCreds() {
  const searchPaths = [
    path.join(process.env.HOME || '', '.openclaw/openclaw.json'),
    path.join(process.env.HOME || '', '.openclaw/config.json'),
  ];
  for (const p of searchPaths) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      const appId = content.match(/"appId"\s*:\s*"([^"]+)"/);
      const appSecret = content.match(/"appSecret"\s*:\s*"([^"]+)"/);
      if (appId && appSecret) return { appId: appId[1], appSecret: appSecret[1] };
    } catch {}
  }
  return null;
}

function getFeishuToken(callback) {
  if (_feishuToken && _feishuTokenExpire > Date.now()) return callback(_feishuToken);
  const creds = readFeishuCreds();
  if (!creds) return callback(null);
  const body = JSON.stringify({ app_id: creds.appId, app_secret: creds.appSecret });
  const req = https.request({
    hostname: 'open.feishu.cn', port: 443, method: 'POST',
    path: '/open-apis/auth/v3/tenant_access_token/internal',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
  }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      try {
        const r = JSON.parse(d);
        if (r.tenant_access_token) {
          _feishuToken = r.tenant_access_token;
          _feishuTokenExpire = Date.now() + (r.expire || 7200) * 1000 - 120000;
          callback(_feishuToken);
        } else callback(null);
      } catch { callback(null); }
    });
  });
  req.setTimeout(15000, () => { req.destroy(); callback(null); });
  req.on('error', () => callback(null));
  req.write(body);
  req.end();
}

function sendWebhookAlert(payload) {
  if (!ALERT_WEBHOOK_URL) return;
  try {
    const url = new URL(ALERT_WEBHOOK_URL);
    const proto = url.protocol === 'https:' ? https : http;
    const body = JSON.stringify(payload);
    const req = proto.request({
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        LOG('alert-webhook', '-', `${ok ? 'sent' : 'failed'}: ${res.statusCode}`);
      });
    });
    req.setTimeout(15000, () => { req.destroy(); LOG('alert-webhook', '-', 'timeout'); });
    req.on('error', e => LOG('alert-webhook', '-', `error: ${e.message}`));
    req.write(body);
    req.end();
  } catch (e) { LOG('alert-webhook', '-', `error: ${e.message}`); }
}

function sendFeishuAlert(sid, message) {
  if (!ALERT_CHAT_ID) return;
  getFeishuToken((token) => {
    if (!token) return LOG('alert-feishu', sid, 'feishu token unavailable, skipped');
    const body = JSON.stringify({
      receive_id: ALERT_CHAT_ID, msg_type: 'text',
      content: JSON.stringify({ text: message })
    });
    const req = https.request({
      hostname: 'open.feishu.cn', port: 443, method: 'POST',
      path: '/open-apis/im/v1/messages?receive_id_type=chat_id',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        const ok = res.statusCode >= 200 && res.statusCode < 300;
        LOG('alert-feishu', sid, `${ok ? 'sent' : 'failed'}: ${res.statusCode}`);
      });
    });
    req.setTimeout(15000, () => { req.destroy(); LOG('alert-feishu', sid, 'timeout'); });
    req.on('error', e => LOG('alert-feishu', sid, `error: ${e.message}`));
    req.write(body);
    req.end();
  });
}

function sendAlert(sid, type, detail) {
  const message = `⚠️ Cache Keepalive Alert\nSession: ${sid}\nType: ${type}\n${detail}\nTime: ${new Date().toISOString()}`;
  LOG('alert', sid, `${type}: ${detail}`);

  const entry = { ts: Date.now(), sid, type, detail };
  pushAlert(entry);

  // Persist to file (async to avoid blocking event loop)
  fs.appendFile(ALERTS_FILE, JSON.stringify(entry) + '\n', () => {});

  // Route alert: webhook > feishu > log-only
  if (ALERT_WEBHOOK_URL) {
    sendWebhookAlert({ sid, type, detail, timestamp: new Date().toISOString() });
  } else if (ALERT_CHAT_ID) {
    sendFeishuAlert(sid, message);
  }
}

// --- Exclude rules ---
function getExcludePatterns() {
  return KEEPALIVE_EXCLUDE.split(',').filter(Boolean).map(s => s.trim());
}

function shouldKeepalive(sid) {
  const patterns = getExcludePatterns();
  if (patterns.length === 0) return true;
  return !patterns.some(pattern => sid.startsWith(pattern));
}

// --- Session cache ---
const sessions = new Map();

// Global cost tracking (survives individual session expiry)
let globalTotalCacheRead = 0;
let globalTotalCacheWrite = 0;
let globalKeepaliveCount = 0;
let globalRebuildsAvoided = 0;

function readOpenClawChatId(body) {
  const blocks = getSystemBlocks(body?.system);
  for (const b of blocks) {
    if (!b?.text) continue;
    const m = b.text.match(/"chat_id"\s*:\s*"([^"]+)"/);
    if (m) return m[1];
  }
  return null;
}

// Claude Code sends metadata.user_id as either a JSON string or a pre-parsed object.
// This function normalizes both cases into a plain object (or null).
function parseClaudeCodeUserIdMetadata(body) {
  const raw = body?.metadata?.user_id;
  if (!raw) return null;
  if (typeof raw === 'object' && raw !== null) return raw;
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function isClaudeCodeRequest(headers, body) {
  const userAgent = String(headers?.['user-agent'] || '');
  const beta = String(headers?.['anthropic-beta'] || '');
  return userAgent.includes('claude-cli/') ||
    beta.includes('claude-code-') ||
    Boolean(parseClaudeCodeUserIdMetadata(body)?.session_id);
}

function isClaudeCodeTitleRequest(body) {
  const systemText = getSystemBlocks(body?.system)
    .map(block => block?.text || '')
    .join('\n');
  const outputFormatType = body?.output_config?.format?.type || null;
  const tools = Array.isArray(body?.tools) ? body.tools.length : 0;
  return systemText.includes('Generate a concise, sentence-case title (3-7 words)') &&
    outputFormatType === 'json_schema' &&
    tools === 0;
}

function isHaikuModel(model) {
  return typeof model === 'string' && model.startsWith('claude-haiku');
}

function getFirstMessage(body) {
  return Array.isArray(body?.messages) && body.messages.length > 0 ? body.messages[0] : null;
}

function getStringContent(message) {
  return typeof message?.content === 'string' ? message.content : null;
}

function getArrayTextContents(message) {
  if (!Array.isArray(message?.content)) return [];
  return message.content
    .filter(item => typeof item?.text === 'string')
    .map(item => item.text);
}

function getMessageText(message) {
  const stringContent = getStringContent(message);
  if (stringContent) return stringContent;
  const arrayTexts = getArrayTextContents(message);
  return arrayTexts.length > 0 ? arrayTexts.join('\n') : null;
}

function getDeclaredToolNames(body) {
  if (!Array.isArray(body?.tools)) return new Set();
  return new Set(
    body.tools
      .map(tool => typeof tool?.name === 'string' ? tool.name : null)
      .filter(Boolean)
  );
}

function parseDeferredToolNames(messageText) {
  if (typeof messageText !== 'string' || !messageText.startsWith('<available-deferred-tools>')) return null;
  const end = messageText.indexOf('</available-deferred-tools>');
  if (end < 0) return null;
  const payload = messageText
    .slice('<available-deferred-tools>'.length, end)
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  return new Set(payload);
}

function hasDeferredTools(messageText, requiredNames) {
  const toolSet = parseDeferredToolNames(messageText);
  if (!toolSet) return false;
  return requiredNames.every(name => toolSet.has(name));
}

// Heuristic: main sessions have AskUserQuestion deferred tool or Agent declared tool,
// extended thinking enabled, effort config, and a small tool set (<=10).
// This distinguishes them from subagent requests.
function isClaudeCodeMainRequest(body) {
  const firstMessage = getFirstMessage(body);
  const firstMessageText = getMessageText(firstMessage);
  const declaredTools = getDeclaredToolNames(body);
  const hasInteractiveMainShell =
    hasDeferredTools(firstMessageText, ['AskUserQuestion']) ||
    declaredTools.has('Agent');
  if (!hasInteractiveMainShell) return false;
  if (!body?.thinking || body?.output_config?.effort == null) return false;
  const toolCount = Array.isArray(body?.tools) ? body.tools.length : 0;
  return toolCount > 0 && toolCount <= 10;
}

function isClaudeCodeExplicitSubagentRequest(body) {
  const firstMessage = getFirstMessage(body);
  const firstMessageText = getStringContent(firstMessage);
  const firstMessageArrayTexts = getArrayTextContents(firstMessage);
  const systemBlocks = getSystemBlocks(body?.system);
  const systemText = systemBlocks.map(block => block?.text || '').join('\n');
  const hasSubagentReminder = firstMessageArrayTexts.some(text => text.includes('SubagentStart hook additional context'));
  const hasAgentSdkShell = systemText.includes("You are a Claude agent, built on Anthropic's Claude Agent SDK");
  const hasClaudeAgentShell = systemText.includes("You are an agent for Claude Code, Anthropic's official CLI for Claude.");
  const hasAgentPromptWrapper = systemText.includes('<Agent_Prompt>');
  return hasSubagentReminder ||
    hasAgentSdkShell ||
    hasClaudeAgentShell ||
    hasAgentPromptWrapper;
}

// "Narrow" means: has deferred tools but missing Agent or AskUserQuestion (restricted
// tool set), and no thinking enabled — characteristics of lightweight subagent workers.
function isClaudeCodeNarrowSubagentShell(body) {
  const firstMessage = getFirstMessage(body);
  const firstMessageText = getMessageText(firstMessage);
  const toolSet = parseDeferredToolNames(firstMessageText);
  return Boolean(toolSet) &&
    (!toolSet.has('Agent') || !toolSet.has('AskUserQuestion')) &&
    !body?.thinking;
}

function shouldCacheRequestTemplate(kind) {
  return kind === 'openclaw_chat' || kind === 'generic_fallback' || kind === 'claude_code_main';
}

function extractSessionInfo(headers, body) {
  try {
    const chatId = readOpenClawChatId(body);
    if (chatId) {
      return { sid: chatId, source: 'system.chat_id', kind: 'openclaw_chat' };
    }
    if (isClaudeCodeRequest(headers, body)) {
      const metadata = parseClaudeCodeUserIdMetadata(body);
      if (metadata?.session_id) {
        let kind = 'claude_code_unknown';
        if (isClaudeCodeTitleRequest(body)) kind = 'claude_code_title';
        else if (isClaudeCodeExplicitSubagentRequest(body)) kind = 'claude_code_subagent';
        else if (isHaikuModel(body?.model)) kind = 'claude_code_haiku_main';
        else if (isClaudeCodeNarrowSubagentShell(body)) kind = 'claude_code_subagent';
        else if (isClaudeCodeMainRequest(body)) kind = 'claude_code_main';
        return {
          sid: `cc:${metadata.session_id}`,
          source: 'metadata.user_id.session_id',
          kind
        };
      }
    }
    const sig = JSON.stringify(body.system || '').slice(0, 2000) + '|' + (body.model || '');
    return {
      sid: 'h:' + crypto.createHash('md5').update(sig).digest('hex').slice(0, 12),
      source: 'system+model hash fallback',
      kind: 'generic_fallback'
    };
  } catch {
    return { sid: 'unknown', source: 'unavailable', kind: 'unknown' };
  }
}

function extractSessionId(body) {
  return extractSessionInfo({}, body).sid;
}

function extractProjectContext(body) {
  try {
    const blocks = getSystemBlocks(body?.system);
    const text = blocks.map(b => b?.text || '').join('\n').replace(/\r/g, '');
    const projectPath = text.match(/Primary working directory:\s*(.+)/i)?.[1]?.trim() || null;
    const gitBranch = text.match(/Current branch:\s*(.+)/i)?.[1]?.trim() || null;
    const platform = text.match(/Platform:\s*(.+)/i)?.[1]?.trim() || null;
    if (!projectPath && !gitBranch) return null;
    const dirName = projectPath ? path.basename(projectPath) : null;
    const displayName = dirName && gitBranch ? `${dirName} (${gitBranch})`
      : dirName || gitBranch || null;
    return { projectPath, gitBranch, platform, displayName };
  } catch {
    return null;
  }
}

function isSessionKeepaliveEligible(sid, session) {
  if (!session) return false;
  if (session.keepaliveEnabled === false) return false;
  return shouldKeepalive(sid);
}

function scheduleSessionKeepalive(sid, session, delayMs = KEEPALIVE_MS) {
  if (!session) return;
  if (session.timer) clearTimeout(session.timer);
  if (!isSessionKeepaliveEligible(sid, session)) {
    session.timer = null;
    session.nextKeepaliveAt = null;
    return;
  }
  session.timer = setTimeout(() => sendKeepalive(sid), delayMs);
  session.nextKeepaliveAt = Date.now() + delayMs;
}

function touchSessionActivity(sid, timestamp = Date.now()) {
  const session = sessions.get(sid);
  if (!session) return;
  session.lastActive = timestamp;
  session.sessionSource = session.sessionSource || 'retained_template';
  session.requestKind = session.requestKind || 'retained_template';
  session.keepaliveCountCurrentWindow = 0;
  scheduleSessionKeepalive(sid, session, KEEPALIVE_MS);
}

function replaceSessionTemplate(sid, body, raw, headers, path, sessionInfo, enableKeepalive, disabledReason = null) {
  const prev = sessions.get(sid);
  if (prev?.timer) clearTimeout(prev.timer);
  const keepaliveEnabled = enableKeepalive && shouldKeepalive(sid);
  const ctx = extractProjectContext(body);
  const session = {
    body,
    rawBody: raw.toString(),
    headers: buildHeaders(headers),
    path,
    lastActive: Date.now(),
    sessionSource: sessionInfo.source,
    requestKind: sessionInfo.kind,
    keepaliveEnabled,
    keepaliveDisabledReason: keepaliveEnabled ? null : (disabledReason || prev?.keepaliveDisabledReason || null),
    version: (prev?.version || 0) + 1,
    timer: null,
    nextKeepaliveAt: null,
    firstSeen: prev?.firstSeen || Date.now(),
    keepaliveCount: prev?.keepaliveCount || 0,
    keepaliveCountCurrentWindow: 0,
    totalCacheRead: prev?.totalCacheRead || 0,
    totalCacheWrite: prev?.totalCacheWrite || 0,
    lastKeepalive: prev?.lastKeepalive || null,
    lastKeepaliveResult: prev?.lastKeepaliveResult || null,
    projectPath: ctx?.projectPath || prev?.projectPath || null,
    gitBranch: ctx?.gitBranch || prev?.gitBranch || null,
    platform: ctx?.platform || prev?.platform || null,
    displayName: ctx?.displayName || prev?.displayName || null,
  };
  sessions.set(sid, session);
  scheduleSessionKeepalive(sid, session, KEEPALIVE_MS);
}

function upsertExcludedSessionPlaceholder(sid, body, raw, headers, path, sessionInfo, disabledReason) {
  replaceSessionTemplate(sid, body, raw, headers, path, sessionInfo, false, disabledReason);
}

function removeSession(sid, reason = 'manual_stop') {
  const session = sessions.get(sid);
  if (!session) return false;
  if (session.timer) clearTimeout(session.timer);
  sessions.delete(sid);
  LOG('session', sid, `removed (${reason})`);
  return true;
}

function isSensitiveHeader(name) {
  const lower = name.toLowerCase();
  return ['authorization', 'proxy-authorization', 'x-api-key', 'api-key', 'cookie', 'set-cookie']
    .includes(lower) || lower.includes('token') || lower.includes('secret');
}

function summarizeHeaderValue(name, value) {
  if (value == null) return null;
  if (isSensitiveHeader(name)) return '(present)';
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

function redactHeaderValue(name, value) {
  if (value == null) return value;
  const lower = name.toLowerCase();
  const text = Array.isArray(value) ? value.join(', ') : String(value);
  if (!isSensitiveHeader(lower)) return text;
  if (lower === 'authorization' || lower === 'proxy-authorization') {
    const space = text.indexOf(' ');
    if (space > 0) return `${text.slice(0, space)} (redacted)`;
  }
  return '(redacted)';
}

function redactHeaders(headers) {
  const result = {};
  for (const [key, value] of Object.entries(headers || {})) {
    result[key.toLowerCase()] = redactHeaderValue(key, value);
  }
  return result;
}

function collectInterestingHeaders(headers) {
  const picked = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    const interesting = lower === 'user-agent' ||
      lower === 'content-type' ||
      lower === 'accept' ||
      lower === 'anthropic-version' ||
      lower === 'anthropic-beta' ||
      lower.includes('session') ||
      lower.includes('conversation') ||
      lower === 'x-request-id' ||
      lower.startsWith('x-claude') ||
      isSensitiveHeader(lower);
    if (interesting) picked[lower] = summarizeHeaderValue(lower, value);
  }
  return picked;
}

function summarizeSystem(system) {
  const blocks = getSystemBlocks(system);
  if (blocks.length > 0) {
    return blocks.slice(0, 3).map((block, index) => ({
      index,
      type: block?.type || typeof block,
      textPreview: typeof block?.text === 'string' ? block.text.slice(0, 80) : null
    }));
  }
  return [];
}

function summarizeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  return messages.slice(0, 5).map((message, index) => ({
    index,
    role: message?.role || 'unknown',
    contentType: Array.isArray(message?.content) ? 'array' : typeof message?.content,
    contentSummary: Array.isArray(message?.content)
      ? message.content.slice(0, 5).map((item, itemIndex) => ({
          index: itemIndex,
          type: item?.type || typeof item
        }))
      : null
  }));
}

function collectCandidateFields(body, headers) {
  const headerCandidates = Object.keys(headers || {}).filter((key) => {
    const lower = key.toLowerCase();
    return lower.includes('session') || lower.includes('conversation') || lower.includes('chat');
  });
  const bodyCandidates = Object.keys(body || {}).filter((key) => {
    const lower = key.toLowerCase();
    return lower.includes('session') || lower.includes('conversation') || lower.includes('chat') || lower.includes('project');
  });
  return { headerCandidates, bodyCandidates };
}

function summarizeScalar(value) {
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 80 ? `${value.slice(0, 77)}...` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return typeof value;
}

function tryParseJsonString(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if ((!trimmed.startsWith('{') || !trimmed.endsWith('}')) &&
      (!trimmed.startsWith('[') || !trimmed.endsWith(']'))) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

function summarizeObject(obj, depth = 1) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const summary = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value == null) {
      summary[key] = null;
      continue;
    }
    if (Array.isArray(value)) {
      summary[key] = {
        type: 'array',
        length: value.length,
        itemTypes: value.slice(0, 5).map((item) => item?.type || typeof item)
      };
      continue;
    }
    const parsed = tryParseJsonString(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      summary[key] = {
        type: 'json-string-object',
        keys: Object.keys(parsed).sort(),
        preview: depth > 0 ? summarizeObject(parsed, depth - 1) : null
      };
      continue;
    }
    if (typeof value === 'object') {
      summary[key] = depth > 0
        ? { type: 'object', keys: Object.keys(value).sort(), preview: summarizeObject(value, depth - 1) }
        : { type: 'object', keys: Object.keys(value).sort() };
      continue;
    }
    summary[key] = summarizeScalar(value);
  }
  return summary;
}

function summarizeTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.slice(0, 20).map((tool, index) => ({
    index,
    name: tool?.name || null,
    type: tool?.type || typeof tool
  }));
}

function summarizeThinking(thinking) {
  if (!thinking || typeof thinking !== 'object') return null;
  return {
    type: thinking.type || null,
    budget_tokens: typeof thinking.budget_tokens === 'number' ? thinking.budget_tokens : null
  };
}

function summarizeQueryParams(requestUrl) {
  try {
    const parsed = new URL(requestUrl, 'http://localhost');
    const result = {};
    for (const [key, value] of parsed.searchParams.entries()) result[key] = summarizeScalar(value);
    return result;
  } catch {
    return {};
  }
}

function detectStringHints(text) {
  if (typeof text !== 'string') return [];
  const hints = [];
  if (/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.test(text)) hints.push('uuid');
  if (/\bses_[A-Za-z0-9]+\b/.test(text)) hints.push('ses_id');
  if (/[A-Za-z]:\\/.test(text) || /\/Users\//.test(text) || /\/home\//.test(text)) hints.push('path');
  if (/session/i.test(text)) hints.push('session_word');
  if (/conversation/i.test(text)) hints.push('conversation_word');
  return hints;
}

function collectStringHints(body) {
  const hints = [];
  const addHints = (source, text) => {
    const found = detectStringHints(text);
    if (found.length > 0) hints.push({ source, hints: found });
  };
  if (body?.metadata && typeof body.metadata === 'object') {
    for (const [key, value] of Object.entries(body.metadata)) {
      if (typeof value === 'string') {
        addHints(`metadata.${key}`, value);
        const parsed = tryParseJsonString(value);
        if (parsed && typeof parsed === 'object') {
          for (const [nestedKey, nestedValue] of Object.entries(parsed)) {
            if (typeof nestedValue === 'string') addHints(`metadata.${key}.${nestedKey}`, nestedValue);
          }
        }
      }
    }
  }
  if (Array.isArray(body?.messages)) {
    body.messages.slice(0, 5).forEach((message, msgIndex) => {
      if (typeof message?.content === 'string') addHints(`messages[${msgIndex}].content`, message.content);
      if (Array.isArray(message?.content)) {
        message.content.slice(0, 5).forEach((item, itemIndex) => {
          if (typeof item?.text === 'string') addHints(`messages[${msgIndex}].content[${itemIndex}].text`, item.text);
        });
      }
    });
  }
  return hints;
}

function recordInspection(req, raw, body, sid) {
  if (!INSPECT_REQUESTS) return;
  const sessionHint = body ? extractSessionInfo(req.headers, body) : { sid: null, source: 'body unavailable', kind: 'body_unavailable' };
  const entry = {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.url,
    bodyBytes: raw.length,
    bodyHash: crypto.createHash('sha1').update(raw.slice(0, 4096)).digest('hex').slice(0, 16),
    contentType: req.headers['content-type'] || null,
    queryParams: summarizeQueryParams(req.url),
    topLevelKeys: body ? Object.keys(body).sort() : [],
    model: body?.model || null,
    messageCount: Array.isArray(body?.messages) ? body.messages.length : 0,
    systemSummary: summarizeSystem(body?.system),
    messageSummary: summarizeMessages(body?.messages),
    metadataSummary: summarizeObject(body?.metadata),
    outputConfigSummary: summarizeObject(body?.output_config),
    thinkingSummary: summarizeThinking(body?.thinking),
    toolsCount: Array.isArray(body?.tools) ? body.tools.length : 0,
    toolsSummary: summarizeTools(body?.tools),
    stringHints: collectStringHints(body),
    headerNames: Object.keys(req.headers).map(key => key.toLowerCase()).sort(),
    interestingHeaders: collectInterestingHeaders(req.headers),
    candidateFields: collectCandidateFields(body, req.headers),
    derivedSessionId: sid,
    sessionSource: sessionHint.source,
    requestKind: sessionHint.kind
  };
  pushInspection(entry);
  fs.appendFile(INSPECT_FILE, JSON.stringify(entry) + '\n', () => {});
  LOG('inspect', sid || '-', JSON.stringify({
    path: entry.path,
    model: entry.model,
    messageCount: entry.messageCount,
    metadataSummary: entry.metadataSummary,
    stringHints: entry.stringHints,
    thinkingSummary: entry.thinkingSummary,
    toolsCount: entry.toolsCount,
    sessionSource: entry.sessionSource,
    requestKind: entry.requestKind,
    candidateFields: entry.candidateFields
  }));
}

function recordFullCapture(req, raw, body, sid) {
  if (!FULL_CAPTURE_REQUESTS) return;
  const sessionHint = body ? extractSessionInfo(req.headers, body) : { sid: null, source: 'body unavailable', kind: 'body_unavailable' };
  const entry = {
    timestamp: new Date().toISOString(),
    method: req.method,
    path: req.url,
    headers: redactHeaders(req.headers),
    bodyText: raw.toString('utf-8'),
    parsedJson: body,
    derivedSessionId: sid,
    sessionSource: sessionHint.source,
    requestKind: sessionHint.kind
  };
  pushCapture(entry);
  fs.appendFile(CAPTURE_FILE, JSON.stringify(entry) + '\n', () => {});
  LOG('capture', sid || '-', JSON.stringify({
    path: entry.path,
    bodyBytes: raw.length,
    headers: Object.keys(entry.headers).sort(),
    sessionSource: entry.sessionSource,
    requestKind: entry.requestKind
  }));
}

function buildHeaders(src) {
  const h = { 'host': UPSTREAM.host, 'content-type': src['content-type'] || 'application/json' };
  for (const k of Object.keys(src)) {
    // Forward auth and API headers; skip hop-by-hop headers
    const kl = k.toLowerCase();
    if (kl === 'host' || kl === 'content-length' || kl === 'connection' ||
        kl === 'transfer-encoding' || kl === 'keep-alive' || kl === 'upgrade' ||
        kl === 'content-type' || kl === 'te' || kl === 'trailer' ||
        kl === 'proxy-authorization' || kl === 'proxy-authenticate' ||
        kl === 'proxy-connection') continue;
    // Forward everything else (covers x-api-*, anthropic*, authorization, api-key, cf-access-*, etc.)
    h[k] = src[k];
  }
  return h;
}

// Resolve upstream path preserving base path, avoiding segment duplication.
// e.g. base=/v1, request=/v1/messages → /v1/messages (not /v1/v1/messages)
// e.g. base=/anthropic, request=/v1/messages → /anthropic/v1/messages
// e.g. base=/v1, request=/v1?foo=1 → /v1?foo=1 (not /v1/v1?foo=1)
function resolveUpstreamPath(requestPath) {
  if (!UP_BASE_PATH || UP_BASE_PATH === '') return requestPath;
  // Split off query string to compare only the pathname portion
  const qIdx = requestPath.indexOf('?');
  const pathname = qIdx >= 0 ? requestPath.slice(0, qIdx) : requestPath;
  // If pathname already starts with the base path (segment-aligned), don't prepend
  if (pathname === UP_BASE_PATH || pathname.startsWith(UP_BASE_PATH + '/')) {
    return requestPath;
  }
  return UP_BASE_PATH + requestPath;
}

// --- Keepalive ---
function sendKeepalive(sid, isRetry = false) {
  const s = sessions.get(sid);
  if (!s) return;

  // Re-check exclude rules on every keepalive (supports hot-reload)
  if (!isSessionKeepaliveEligible(sid, s)) {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    LOG('keepalive', sid, 'session now excluded or disabled, stopping keepalive');
    return;
  }

  const capturedVersion = s.version;

  if (Date.now() - s.lastActive > EXPIRE_MS) {
    if (s.timer) clearTimeout(s.timer);
    LOG('expire', sid, 'removing inactive session');
    sessions.delete(sid);
    return;
  }

  const kaBody = JSON.parse(s.rawBody);
  kaBody.max_tokens = 1;
  kaBody.stream = false;
  if (kaBody.thinking && kaBody.thinking.type === 'enabled') {
    kaBody.thinking.budget_tokens = 128;
  }
  const payload = JSON.stringify(kaBody);
  const sentAt = Date.now();
  const sentAtISO = new Date(sentAt).toISOString();

  if (!isRetry) {
    s.keepaliveCount = (s.keepaliveCount || 0) + 1;
    s.keepaliveCountCurrentWindow = (s.keepaliveCountCurrentWindow || 0) + 1;
    globalKeepaliveCount++;
  }
  s.lastKeepalive = sentAt;

  LOG(isRetry ? 'keepalive-retry' : 'keepalive', sid,
    `sending body_len=${payload.length} model=${kaBody.model}${isRetry ? ' (RETRY)' : ''}`);

  const upPath = resolveUpstreamPath(s.path);
  // Strip accept-encoding from keepalive headers to ensure plain-text JSON response.
  // The stored session headers may include accept-encoding from the original client,
  // which could cause upstream to return gzip/br that we can't JSON.parse.
  const kaHeaders = { ...s.headers, 'content-length': Buffer.byteLength(payload) };
  delete kaHeaders['accept-encoding'];
  // Set User-Agent for keepalive: OpenClaw gets prefix + original, Claude Code keeps original
  const originalUA = kaHeaders['user-agent'] || '';
  if (s.requestKind === 'openclaw_chat') {
    kaHeaders['user-agent'] = originalUA ? `${UA_PREFIX} ${originalUA}` : UA_PREFIX;
  } else if (!originalUA) {
    kaHeaders['user-agent'] = UA_PREFIX;
  }
  const req = UP_PROTO.request({
    hostname: UPSTREAM.hostname, port: UP_PORT, path: upPath, method: 'POST',
    headers: kaHeaders
  }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      const current = sessions.get(sid);
      if (!current || current.version !== capturedVersion) {
        LOG('keepalive', sid, 'session replaced during in-flight request, skipping');
        return;
      }

      let success = false;
      try {
        const resp = JSON.parse(d);
        const u = resp.usage || {};
        const cacheRead = u.cache_read_input_tokens || 0;
        const cacheWrite = u.cache_creation_input_tokens || 0;
        success = cacheWrite === 0 && res.statusCode === 200;

        s.totalCacheRead = (s.totalCacheRead || 0) + cacheRead;
        s.totalCacheWrite = (s.totalCacheWrite || 0) + cacheWrite;
        globalTotalCacheRead += cacheRead;
        globalTotalCacheWrite += cacheWrite;

        if (success) globalRebuildsAvoided++;

        s.lastKeepaliveResult = {
          status: res.statusCode, cacheRead, cacheWrite, success,
          sentAt: sentAtISO, respondedAt: new Date().toISOString(), isRetry
        };

        LOG('keepalive', sid,
          `${res.statusCode} cache_read=${cacheRead} cache_write=${cacheWrite}${isRetry ? ' (RETRY)' : ''}`);

        if (cacheWrite > 0) {
          sendAlert(sid, 'cache_miss',
            `cache_write=${cacheWrite} (expected 0)\ncache_read=${cacheRead}\nCache rebuilt (cost incurred), no retry needed`);
        }
      } catch {
        success = false;
        s.lastKeepaliveResult = {
          status: res.statusCode, error: d.slice(0, 200),
          sentAt: sentAtISO, respondedAt: new Date().toISOString(), isRetry
        };
        LOG('keepalive', sid, `${res.statusCode} parse_error raw=${d.slice(0, 200)}`);
      }

      const needsRetry = !success && !isRetry && !(s.lastKeepaliveResult?.cacheWrite > 0);
      if (needsRetry) {
        LOG('keepalive', sid, `scheduling retry in ${RETRY_DELAY_MS}ms`);
        if (s.timer) clearTimeout(s.timer);
        s.timer = setTimeout(() => sendKeepalive(sid, true), RETRY_DELAY_MS);
        s.nextKeepaliveAt = Date.now() + RETRY_DELAY_MS;
        return;
      }

      scheduleSessionKeepalive(sid, s, KEEPALIVE_MS);
    });
  });

  req.setTimeout(REQUEST_TIMEOUT_MS, () => {
    req.destroy(new Error('keepalive request timeout'));
  });

  req.on('error', e => {
    const curr = sessions.get(sid);
    if (!curr || curr.version !== capturedVersion) {
      LOG('keepalive', sid, 'session replaced during in-flight request (error path), skipping');
      return;
    }

    s.lastKeepaliveResult = { status: 0, error: e.message, sentAt: sentAtISO, isRetry };
    LOG('keepalive', sid, `error: ${e.message}${isRetry ? ' (RETRY)' : ''}`);

    if (!isRetry) {
      sendAlert(sid, 'keepalive_error', `${e.message}\nRetrying in ${RETRY_DELAY_MS / 1000}s`);
      if (s.timer) clearTimeout(s.timer);
      s.timer = setTimeout(() => sendKeepalive(sid, true), RETRY_DELAY_MS);
      s.nextKeepaliveAt = Date.now() + RETRY_DELAY_MS;
    } else {
      sendAlert(sid, 'keepalive_error_after_retry', e.message);
      scheduleSessionKeepalive(sid, s, KEEPALIVE_MS);
    }
  });

  req.write(payload);
  req.end();
}

// --- Utility ---
function formatDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
  if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatTokens(n) {
  if (n >= 1000000) return `${(n / 1000000).toFixed(2)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function calcCost(tokens, pricePerMTok) {
  if (!pricePerMTok || pricePerMTok <= 0) return null;
  return (tokens / 1000000) * pricePerMTok;
}

function handleInspect(req, res) {
  const result = {
    enabled: INSPECT_REQUESTS,
    maxEntries: INSPECT_MAX_ENTRIES,
    file: path.basename(INSPECT_FILE),
    count: _recentInspections.length,
    entries: _recentInspections
  };
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(result, null, 2));
}

function handleCapture(req, res) {
  const result = {
    enabled: FULL_CAPTURE_REQUESTS,
    maxEntries: FULL_CAPTURE_MAX_ENTRIES,
    file: path.basename(CAPTURE_FILE),
    count: _recentCaptures.length,
    entries: _recentCaptures
  };
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(result, null, 2));
}

function handleStatusPage(req, res) {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(renderStatusPage());
}

function handleFavicon(req, res) {
  res.writeHead(204, { 'cache-control': 'public, max-age=86400' });
  res.end();
}

function handleSessionStop(req, res) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    let payload = null;
    try { payload = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch {}
    const sid = typeof payload?.id === 'string' ? payload.id.trim() : '';
    if (!sid) {
      res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, error: 'session id required' }));
      return;
    }
    const removed = removeSession(sid, 'manual_stop');
    res.writeHead(removed ? 200 : 404, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: removed, id: sid }));
  });
}

// --- /status endpoint ---
function handleStatus(req, res) {
  const now = Date.now();
  const sessionList = [];

  for (const [sid, s] of sessions) {
    const isPrefixExcluded = !shouldKeepalive(sid);
    const isExcluded = !isSessionKeepaliveEligible(sid, s);
    const excludedReason = isPrefixExcluded
      ? 'prefix_excluded'
      : s.keepaliveEnabled === false
        ? (s.keepaliveDisabledReason || 'keepalive_disabled')
        : null;
    const bodyLen = Buffer.byteLength(s.rawBody);
    const lastCacheRefresh = Math.max(s.lastActive, s.lastKeepalive || 0);
    const cacheExpiresAt = lastCacheRefresh + CACHE_TTL_MS;
    const cacheExpired = now > cacheExpiresAt;
    const kaCount = s.keepaliveCount || 0;
    const kaCountCurrentWindow = s.keepaliveCountCurrentWindow || 0;
    const totalRead = s.totalCacheRead || 0;
    const totalWrite = s.totalCacheWrite || 0;

    sessionList.push({
      id: sid, excluded: isExcluded, excludedReason,
      model: s.body?.model || 'unknown',
      requestKind: s.requestKind || 'unknown',
      sessionSource: s.sessionSource || 'unknown',
      keepaliveEnabled: s.keepaliveEnabled !== false,
      bodyLen, bodyLenHuman: formatBytes(bodyLen),
      firstSeen: s.firstSeen ? new Date(s.firstSeen).toISOString() : null,
      sessionAge: s.firstSeen ? formatDuration(now - s.firstSeen) : null,
      lastActivity: new Date(s.lastActive).toISOString(),
      idleTime: formatDuration(now - s.lastActive),
      lastKeepalive: s.lastKeepalive ? new Date(s.lastKeepalive).toISOString() : null,
      lastKeepaliveResult: s.lastKeepaliveResult || null,
      nextKeepaliveAt: (!isExcluded && s.nextKeepaliveAt) ? new Date(s.nextKeepaliveAt).toISOString() : null,
      nextKeepaliveIn: (!isExcluded && s.nextKeepaliveAt && s.nextKeepaliveAt > now)
        ? formatDuration(s.nextKeepaliveAt - now) : null,
      cacheExpiresAt: new Date(cacheExpiresAt).toISOString(),
      cacheExpiresIn: cacheExpired ? 'EXPIRED' : formatDuration(cacheExpiresAt - now),
      cacheExpired,
      sessionExpiresAt: new Date(s.lastActive + EXPIRE_MS).toISOString(),
      sessionExpiresIn: formatDuration((s.lastActive + EXPIRE_MS) - now),
      keepaliveCount: kaCount,
      keepaliveCountTotal: kaCount,
      keepaliveCountCurrentWindow: kaCountCurrentWindow,
      totalCacheRead: totalRead, totalCacheReadHuman: formatTokens(totalRead),
      totalCacheWrite: totalWrite, totalCacheWriteHuman: formatTokens(totalWrite),
      cacheReadRatio: kaCount > 0
        ? (totalWrite === 0 ? '100%' : `${Math.round((totalRead / (totalRead + totalWrite)) * 100)}%`)
        : 'N/A',
      projectPath: s.projectPath || null,
      gitBranch: s.gitBranch || null,
      platform: s.platform || null,
      displayName: s.displayName || null,
    });
  }

  sessionList.sort((a, b) => (a.excluded === b.excluded) ? 0 : a.excluded ? 1 : -1);

  // Cost savings calculation
  const hasCostConfig = COST_CACHE_WRITE_PER_MTOK > 0 && COST_CACHE_READ_PER_MTOK > 0;
  // Cost savings model:
  // Without proxy: each session restart pays cache_write price for all prompt tokens.
  // With proxy: keepalives pay cache_read price instead.
  // Net savings = (what we'd have paid as cache_write) - (what we actually paid as cache_read)
  //
  // Note: "rebuildsAvoided" counts successful keepalives (cache_write=0).
  // This is an upper-bound estimate — some keepalives may fire before the cache
  // would have naturally expired. For precise tracking, compare with actual
  // request patterns.
  const costSavings = hasCostConfig ? {
    configured: true,
    rates: {
      cacheWritePerMTok: COST_CACHE_WRITE_PER_MTOK,
      cacheReadPerMTok: COST_CACHE_READ_PER_MTOK,
    },
    // Cost of all keepalive requests (cache_read tokens × read price)
    keepaliveCost: calcCost(globalTotalCacheRead, COST_CACHE_READ_PER_MTOK),
    // Count of successful keepalives (cache stayed warm)
    rebuildsAvoided: globalRebuildsAvoided,
    // What those same tokens would have cost as cache_write (rebuild)
    hypotheticalRebuildCost: calcCost(globalTotalCacheRead, COST_CACHE_WRITE_PER_MTOK),
    // Net savings = hypothetical rebuild cost - actual keepalive cost
    netSavings: calcCost(globalTotalCacheRead, COST_CACHE_WRITE_PER_MTOK)
      - calcCost(globalTotalCacheRead, COST_CACHE_READ_PER_MTOK),
  } : { configured: false, hint: 'Set COST_CACHE_WRITE_PER_MTOK and COST_CACHE_READ_PER_MTOK in config.conf to enable cost tracking' };

  const result = {
    version: VERSION,
    uptime: formatDuration(now - STARTED_AT),
    startedAt: new Date(STARTED_AT).toISOString(),
    now: new Date(now).toISOString(),
    config: {
      upstream: UPSTREAM.origin + UP_BASE_PATH, port: PORT,
      keepaliveInterval: formatDuration(KEEPALIVE_MS), keepaliveSeconds: KEEPALIVE_MS / 1000, keepaliveMs: KEEPALIVE_MS,
      sessionExpiry: formatDuration(EXPIRE_MS), expireSeconds: EXPIRE_MS / 1000, expireMs: EXPIRE_MS,
      cacheTtl: formatDuration(CACHE_TTL_MS), cacheTtlMs: CACHE_TTL_MS,
      retryDelay: formatDuration(RETRY_DELAY_MS), retryDelaySeconds: RETRY_DELAY_MS / 1000, retryDelayMs: RETRY_DELAY_MS,
      requestTimeout: formatDuration(REQUEST_TIMEOUT_MS),
      alertMode: ALERT_WEBHOOK_URL ? 'webhook' : ALERT_CHAT_ID ? 'feishu' : 'log-only',
      inspectRequests: INSPECT_REQUESTS,
      inspectMaxEntries: INSPECT_MAX_ENTRIES,
      fullCaptureRequests: FULL_CAPTURE_REQUESTS,
      fullCaptureMaxEntries: FULL_CAPTURE_MAX_ENTRIES,
      exclude: getExcludePatterns()
    },
    sessions: {
      total: sessions.size,
      activeKeepalive: sessionList.filter(s => !s.excluded).length,
      excluded: sessionList.filter(s => s.excluded).length,
      list: sessionList
    },
    totals: {
      keepaliveCycles: globalKeepaliveCount,
      rebuildsAvoided: globalRebuildsAvoided,
      totalCacheRead: globalTotalCacheRead,
      totalCacheReadHuman: formatTokens(globalTotalCacheRead),
      totalCacheWrite: globalTotalCacheWrite,
      totalCacheWriteHuman: formatTokens(globalTotalCacheWrite),
      cacheReadRatio: globalKeepaliveCount > 0
        ? (globalTotalCacheWrite === 0 ? '100%' : `${Math.round((globalTotalCacheRead / (globalTotalCacheRead + globalTotalCacheWrite)) * 100)}%`)
        : 'N/A'
    },
    costSavings,
    recentAlerts: _recentAlerts.slice(-5)
  };

  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(result, null, 2));
}

// --- HTTP Server ---
const server = http.createServer((cReq, cRes) => {
  const requestUrl = new URL(cReq.url, 'http://127.0.0.1');

  // Status endpoint
  if (cReq.method === 'GET' && requestUrl.pathname === '/status') return handleStatus(cReq, cRes);
  if (cReq.method === 'GET' && requestUrl.pathname === '/status/ui') return handleStatusPage(cReq, cRes);
  if (cReq.method === 'GET' && requestUrl.pathname === '/favicon.ico') return handleFavicon(cReq, cRes);
  if (cReq.method === 'GET' && requestUrl.pathname === '/inspect') return handleInspect(cReq, cRes);
  if (cReq.method === 'GET' && requestUrl.pathname === '/capture') return handleCapture(cReq, cRes);
  if (cReq.method === 'POST' && requestUrl.pathname === '/sessions/stop') return handleSessionStop(cReq, cRes);

  // Proxy all other requests
  const chunks = [];
  cReq.on('data', c => chunks.push(c));
  cReq.on('end', () => {
    const raw = Buffer.concat(chunks);
    let body;
    try { body = JSON.parse(raw.toString()); } catch { body = null; }

    // Identify session (but don't start keepalive yet — wait for upstream success)
    let sid = null;
    if (body && (body.system || body.messages)) {
      sid = extractSessionInfo(cReq.headers, body).sid;
    }
    recordInspection(cReq, raw, body, sid);
    recordFullCapture(cReq, raw, body, sid);

    // Forward to upstream
    const upPath = resolveUpstreamPath(cReq.url);
    const fwd = { ...buildHeaders(cReq.headers), 'content-length': raw.length };
    const pReq = UP_PROTO.request({
      hostname: UPSTREAM.hostname, port: UP_PORT,
      path: upPath, method: cReq.method, headers: fwd
    }, (pRes) => {
      // Pipe response immediately (don't block client on our caching logic)
      cRes.writeHead(pRes.statusCode, pRes.headers);
      pRes.pipe(cRes);

      // Only cache session after upstream stream completes successfully
      if (sid && pRes.statusCode >= 200 && pRes.statusCode < 300) {
        // Wait for the upstream response stream to fully complete before starting
        // keepalive. This prevents caching sessions where upstream returned 200 but
        // the stream was aborted mid-way (e.g., upstream network issues, partial
        // response). We intentionally do NOT gate on downstream (client) completion:
        // if upstream delivered a full response, the cache is valid regardless of
        // whether the client consumed it.
        pRes.on('close', () => {
          if (!pRes.complete) {
            LOG('proxy', sid, `stream incomplete (status=${pRes.statusCode}), not caching session`);
            return;
          }

          const sessionInfo = body && (body.system || body.messages)
            ? extractSessionInfo(cReq.headers, body)
            : { sid, source: 'body unavailable', kind: 'body_unavailable' };
          const canCacheTemplate = shouldCacheRequestTemplate(sessionInfo.kind);
          const isClaudeCodeNonTemplate = sessionInfo.kind === 'claude_code_title' ||
            sessionInfo.kind === 'claude_code_subagent' ||
            sessionInfo.kind === 'claude_code_unknown';
          const hasPreviousTemplate = sessions.has(sid);
          const isClaudeCodeHaiku = sessionInfo.kind === 'claude_code_haiku_main';

          if (isClaudeCodeNonTemplate) {
            if (sessionInfo.kind === 'claude_code_unknown' && !hasPreviousTemplate) {
              upsertExcludedSessionPlaceholder(sid, body, raw, cReq.headers, cReq.url, sessionInfo, 'unknown_request_shape');
              LOG('cache', sid, 'stored unknown Claude Code session as excluded placeholder (no prior main template)');
              return;
            }
            touchSessionActivity(sid);
            LOG('cache', sid, `skipping template update for ${sessionInfo.kind}, retained previous main template`);
            return;
          }
          if (isClaudeCodeHaiku) {
            replaceSessionTemplate(sid, body, raw, cReq.headers, cReq.url, sessionInfo, false, 'haiku_model');
            LOG('cache', sid, `stored ${sessionInfo.kind} without keepalive (haiku excluded) model=${body.model} body_len=${raw.length}`);
            return;
          }
          if (!canCacheTemplate) {
            touchSessionActivity(sid);
            LOG('cache', sid, `skipping template update for ${sessionInfo.kind}`);
            return;
          }

          replaceSessionTemplate(sid, body, raw, cReq.headers, cReq.url, sessionInfo, true);
          LOG('cache', sid, `cached (${sessions.size} active) kind=${sessionInfo.kind} source=${sessionInfo.source} model=${body.model} body_len=${raw.length}`);
        });
      } else if (sid && pRes.statusCode >= 400) {
        LOG('proxy', sid, `upstream returned ${pRes.statusCode}, not caching session`);
      }
    });
    pReq.setTimeout(REQUEST_TIMEOUT_MS, () => {
      pReq.destroy(new Error('upstream request timeout'));
    });
    pReq.on('error', e => {
      LOG('proxy', '-', `upstream error: ${e.message}`);
      if (!cRes.headersSent) cRes.writeHead(502);
      cRes.end();
    });
    pReq.write(raw);
    pReq.end();
  });
});

// Periodic cleanup of expired sessions (runs at most every 10 minutes)
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [sid, s] of sessions) {
    if (now - s.lastActive > EXPIRE_MS) {
      if (s.timer) clearTimeout(s.timer);
      sessions.delete(sid);
      cleaned++;
      LOG('cleanup', sid, 'removed expired session');
    }
  }
  if (cleaned > 0) LOG('cleanup', '-', `removed ${cleaned} expired session(s), ${sessions.size} remaining`);
}, Math.min(EXPIRE_MS, 600000));

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`ERROR: Port ${PORT} is already in use. Is another instance running?`);
    process.exit(1);
  }
  throw e;
});

server.listen(PORT, '127.0.0.1', () => {
  LOG('start', '-', `v${VERSION} listening :${PORT} → ${UPSTREAM.origin}${UP_BASE_PATH} (keepalive=${KEEPALIVE_MS / 1000}s, expire=${EXPIRE_MS / 1000}s)`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  LOG('shutdown', '-', 'received SIGTERM, shutting down...');
  for (const [, s] of sessions) if (s.timer) clearTimeout(s.timer);
  server.close(() => {
    LOG('shutdown', '-', 'server closed');
    process.exit(0);
  });
  // Force exit after 5 seconds if connections don't close
  setTimeout(() => process.exit(0), 5000);
});
process.on('SIGINT', () => process.emit('SIGTERM'));
