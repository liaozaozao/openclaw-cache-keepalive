#!/usr/bin/env node
/**
 * OpenClaw Cache Keepalive Proxy v1.2
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
const LOG = (tag, sid, msg) => console.log(`[${new Date().toISOString()}] [${tag}] [${sid || '-'}] ${msg}`);

// --- Constants ---
const CONF_FILE = process.env.CONF_FILE || path.join(__dirname, 'config.conf');
const CACHE_TTL_MS = 5 * 60 * 1000; // Anthropic cache TTL: 5 minutes
const ALERTS_FILE = path.join(__dirname, '.alerts.jsonl');
const STARTED_AT = Date.now();
const REQUEST_TIMEOUT_MS = 120000; // 2 minutes timeout for all outbound requests

// --- Configuration ---
// Startup-only (require restart): UPSTREAM_URL, PORT
// Priority: env var > config file > default
let UPSTREAM_URL = process.env.UPSTREAM_URL || '';
let PORT = process.env.PORT ? parseInt(process.env.PORT) : 0;

// Hot-reloadable via config.conf:
let KEEPALIVE_MS = 270000;   // 4m30s
let EXPIRE_MS = 1200000;     // 20m
let RETRY_DELAY_MS = 10000;  // 10s
let KEEPALIVE_EXCLUDE = 'h:';
let ALERT_WEBHOOK_URL = '';
let ALERT_CHAT_ID = '';

// Cost tracking config (hot-reloadable)
let COST_CACHE_WRITE_PER_MTOK = 0; // e.g. 18.75 for Opus
let COST_CACHE_READ_PER_MTOK = 0;  // e.g. 1.50 for Opus

// Apply env vars for hot-reloadable fields (env > config file)
function applyEnvOverrides() {
  if (process.env.KEEPALIVE_MS) KEEPALIVE_MS = validatePositive('KEEPALIVE_MS', parseInt(process.env.KEEPALIVE_MS), KEEPALIVE_MS);
  if (process.env.EXPIRE_MS) EXPIRE_MS = validatePositive('EXPIRE_MS', parseInt(process.env.EXPIRE_MS), EXPIRE_MS);
  if (process.env.RETRY_DELAY_MS) RETRY_DELAY_MS = validatePositive('RETRY_DELAY_MS', parseInt(process.env.RETRY_DELAY_MS), RETRY_DELAY_MS);
  if (process.env.KEEPALIVE_EXCLUDE) KEEPALIVE_EXCLUDE = process.env.KEEPALIVE_EXCLUDE;
  if (process.env.ALERT_WEBHOOK_URL) ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
  if (process.env.ALERT_CHAT_ID) ALERT_CHAT_ID = process.env.ALERT_CHAT_ID;
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
      if (k === 'KEEPALIVE_MS') KEEPALIVE_MS = validatePositive(k, parseInt(v), KEEPALIVE_MS);
      if (k === 'EXPIRE_MS') EXPIRE_MS = validatePositive(k, parseInt(v), EXPIRE_MS);
      if (k === 'RETRY_DELAY_MS') RETRY_DELAY_MS = validatePositive(k, parseInt(v), RETRY_DELAY_MS);
      if (k === 'KEEPALIVE_EXCLUDE') KEEPALIVE_EXCLUDE = v;
      if (k === 'ALERT_WEBHOOK_URL') ALERT_WEBHOOK_URL = v;
      if (k === 'ALERT_CHAT_ID') ALERT_CHAT_ID = v;
      if (k === 'COST_CACHE_WRITE_PER_MTOK') { const n = parseFloat(v); if (n >= 0) COST_CACHE_WRITE_PER_MTOK = n; }
      if (k === 'COST_CACHE_READ_PER_MTOK') { const n = parseFloat(v); if (n >= 0) COST_CACHE_READ_PER_MTOK = n; }
    }
    // Env vars override config file for hot-reloadable fields
    applyEnvOverrides();
    LOG('reload', '-', `conf reloaded: keepalive=${KEEPALIVE_MS / 1000}s expire=${EXPIRE_MS / 1000}s`);
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

function pushAlert(entry) {
  _recentAlerts.push(entry);
  if (_recentAlerts.length > MAX_RECENT_ALERTS) _recentAlerts.shift();
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

function extractSessionId(body) {
  try {
    const blocks = Array.isArray(body.system) ? body.system : [{ text: String(body.system) }];
    for (const b of blocks) {
      if (!b.text) continue;
      const m = b.text.match(/"chat_id"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    // Fallback: hash-based ID using system + model for better bucketing
    const sig = JSON.stringify(body.system || '').slice(0, 2000) + '|' + (body.model || '');
    return 'h:' + crypto.createHash('md5').update(sig).digest('hex').slice(0, 12);
  } catch { return 'unknown'; }
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
  if (!shouldKeepalive(sid)) {
    if (s.timer) clearTimeout(s.timer);
    s.timer = null;
    LOG('keepalive', sid, 'session now excluded, stopping keepalive');
    return;
  }

  const capturedVersion = s.version;

  if (Date.now() - s.lastActive > EXPIRE_MS) {
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
    globalKeepaliveCount++;
  }
  s.lastKeepalive = sentAt;

  LOG(isRetry ? 'keepalive-retry' : 'keepalive', sid,
    `sending body_len=${payload.length} model=${kaBody.model}${isRetry ? ' (RETRY)' : ''}`);

  const upPath = resolveUpstreamPath(s.path);
  const req = UP_PROTO.request({
    hostname: UPSTREAM.hostname, port: UP_PORT, path: upPath, method: 'POST',
    headers: { ...s.headers, 'content-length': Buffer.byteLength(payload) }
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
        s.timer = setTimeout(() => sendKeepalive(sid, true), RETRY_DELAY_MS);
        s.nextKeepaliveAt = Date.now() + RETRY_DELAY_MS;
        return;
      }

      s.timer = setTimeout(() => sendKeepalive(sid), KEEPALIVE_MS);
      s.nextKeepaliveAt = Date.now() + KEEPALIVE_MS;
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
      s.timer = setTimeout(() => sendKeepalive(sid, true), RETRY_DELAY_MS);
      s.nextKeepaliveAt = Date.now() + RETRY_DELAY_MS;
    } else {
      sendAlert(sid, 'keepalive_error_after_retry', e.message);
      s.timer = setTimeout(() => sendKeepalive(sid), KEEPALIVE_MS);
      s.nextKeepaliveAt = Date.now() + KEEPALIVE_MS;
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

// --- /status endpoint ---
function handleStatus(req, res) {
  const now = Date.now();
  const sessionList = [];

  for (const [sid, s] of sessions) {
    const isExcluded = !shouldKeepalive(sid);
    const bodyLen = Buffer.byteLength(s.rawBody);
    const lastCacheRefresh = Math.max(s.lastActive, s.lastKeepalive || 0);
    const cacheExpiresAt = lastCacheRefresh + CACHE_TTL_MS;
    const cacheExpired = now > cacheExpiresAt;
    const kaCount = s.keepaliveCount || 0;
    const totalRead = s.totalCacheRead || 0;
    const totalWrite = s.totalCacheWrite || 0;

    sessionList.push({
      id: sid, excluded: isExcluded,
      model: s.body?.model || 'unknown',
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
      totalCacheRead: totalRead, totalCacheReadHuman: formatTokens(totalRead),
      totalCacheWrite: totalWrite, totalCacheWriteHuman: formatTokens(totalWrite),
      cacheHitRate: kaCount > 0
        ? (totalWrite === 0 ? '100%' : `${Math.round((totalRead / (totalRead + totalWrite)) * 100)}%`)
        : 'N/A'
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
    version: '1.2.0',
    uptime: formatDuration(now - STARTED_AT),
    startedAt: new Date(STARTED_AT).toISOString(),
    now: new Date(now).toISOString(),
    config: {
      upstream: UPSTREAM.origin + UP_BASE_PATH, port: PORT,
      keepaliveInterval: formatDuration(KEEPALIVE_MS), keepaliveMs: KEEPALIVE_MS,
      sessionExpiry: formatDuration(EXPIRE_MS), expireMs: EXPIRE_MS,
      cacheTtl: formatDuration(CACHE_TTL_MS), cacheTtlMs: CACHE_TTL_MS,
      retryDelay: formatDuration(RETRY_DELAY_MS), retryDelayMs: RETRY_DELAY_MS,
      requestTimeout: formatDuration(REQUEST_TIMEOUT_MS),
      alertMode: ALERT_WEBHOOK_URL ? 'webhook' : ALERT_CHAT_ID ? 'feishu' : 'log-only',
      exclude: getExcludePatterns()
    },
    sessions: {
      total: sessions.size,
      activeKeepalive: sessionList.filter(s => !s.excluded).length,
      excluded: sessionList.filter(s => s.excluded).length,
      list: sessionList
    },
    totals: {
      keepalivesSent: globalKeepaliveCount,
      rebuildsAvoided: globalRebuildsAvoided,
      totalCacheRead: globalTotalCacheRead,
      totalCacheReadHuman: formatTokens(globalTotalCacheRead),
      totalCacheWrite: globalTotalCacheWrite,
      totalCacheWriteHuman: formatTokens(globalTotalCacheWrite),
      cacheHitRate: globalKeepaliveCount > 0
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
  // Status endpoint
  if (cReq.method === 'GET' && cReq.url === '/status') return handleStatus(cReq, cRes);

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
      sid = extractSessionId(body);
    }

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

          const prev = sessions.get(sid);
          if (prev?.timer) clearTimeout(prev.timer);
          const doKeepalive = shouldKeepalive(sid);
          const nextAt = doKeepalive ? Date.now() + KEEPALIVE_MS : null;

          sessions.set(sid, {
            body, rawBody: raw.toString(), headers: buildHeaders(cReq.headers),
            path: cReq.url, lastActive: Date.now(),
            version: (prev?.version || 0) + 1,
            timer: doKeepalive ? setTimeout(() => sendKeepalive(sid), KEEPALIVE_MS) : null,
            nextKeepaliveAt: nextAt,
            firstSeen: prev?.firstSeen || Date.now(),
            keepaliveCount: prev?.keepaliveCount || 0,
            totalCacheRead: prev?.totalCacheRead || 0,
            totalCacheWrite: prev?.totalCacheWrite || 0,
            lastKeepalive: prev?.lastKeepalive || null,
            lastKeepaliveResult: prev?.lastKeepaliveResult || null,
          });
          LOG('cache', sid, `cached (${sessions.size} active) model=${body.model} body_len=${raw.length}`);
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

server.listen(PORT, '127.0.0.1', () => {
  LOG('start', '-', `v1.2.0 listening :${PORT} → ${UPSTREAM.origin}${UP_BASE_PATH} (keepalive=${KEEPALIVE_MS / 1000}s, expire=${EXPIRE_MS / 1000}s)`);
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
