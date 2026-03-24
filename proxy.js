#!/usr/bin/env node
/**
 * OpenClaw Cache Keepalive Proxy
 *
 * Reverse proxy between OpenClaw and Anthropic API upstream.
 * Automatically sends keepalive requests to prevent prompt cache TTL expiry.
 *
 * Features:
 * - Per-session cache bucketing with automatic keepalive every 4.5 minutes
 * - 20-minute inactivity expiry
 * - Automatic retry on failure (once, after 10s)
 * - Alerts via generic webhook or Feishu API (auto-detected)
 * - GET /status structured JSON endpoint
 * - Hot-reloadable config (fs.watch + SIGHUP)
 * - Version-checked timers to prevent orphan keepalives
 *
 * Requirements: Node.js 18+, no external dependencies.
 *
 * Usage:
 *   node proxy.js
 *   # or via systemd (see install.sh)
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

// --- Configuration ---
// These are set once at startup and NOT hot-reloadable (require restart):
let UPSTREAM_URL = process.env.UPSTREAM_URL || '';
let PORT = parseInt(process.env.PORT || '8899');

// These ARE hot-reloadable via config.conf:
let KEEPALIVE_MS = parseInt(process.env.KEEPALIVE_MS || '270000');   // 4m30s
let EXPIRE_MS = parseInt(process.env.EXPIRE_MS || '1200000');        // 20m
let RETRY_DELAY_MS = parseInt(process.env.RETRY_DELAY_MS || '10000'); // 10s
let KEEPALIVE_EXCLUDE = process.env.KEEPALIVE_EXCLUDE || 'h:';
let ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL || '';
let ALERT_CHAT_ID = process.env.ALERT_CHAT_ID || '';

// Load config file (overrides env vars for hot-reloadable fields)
function reloadConf() {
  try {
    if (!fs.existsSync(CONF_FILE)) return;
    const lines = fs.readFileSync(CONF_FILE, 'utf-8').split('\n');
    for (const line of lines) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (!m) continue;
      const [, k, v] = m;
      // Startup-only config (read from file on first load, but not hot-reloaded at runtime)
      if (k === 'UPSTREAM_URL' && !UPSTREAM_URL) UPSTREAM_URL = v;
      if (k === 'PORT' && !PORT) PORT = parseInt(v) || PORT;
      // Hot-reloadable config
      if (k === 'KEEPALIVE_MS') KEEPALIVE_MS = parseInt(v) || KEEPALIVE_MS;
      if (k === 'EXPIRE_MS') EXPIRE_MS = parseInt(v) || EXPIRE_MS;
      if (k === 'RETRY_DELAY_MS') RETRY_DELAY_MS = parseInt(v) || RETRY_DELAY_MS;
      if (k === 'KEEPALIVE_EXCLUDE') KEEPALIVE_EXCLUDE = v;
      if (k === 'ALERT_WEBHOOK_URL') ALERT_WEBHOOK_URL = v;
      if (k === 'ALERT_CHAT_ID') ALERT_CHAT_ID = v;
    }
    LOG('reload', '-', `conf reloaded: keepalive=${KEEPALIVE_MS / 1000}s expire=${EXPIRE_MS / 1000}s`);
  } catch (e) { LOG('reload', '-', `error: ${e.message}`); }
}

// Initial config load
reloadConf();

// Validate required config
if (!UPSTREAM_URL) {
  console.error('ERROR: UPSTREAM_URL is required. Set it in config.conf or as an environment variable.');
  console.error('Example: UPSTREAM_URL=https://api.anthropic.com');
  process.exit(1);
}

const UPSTREAM = new URL(UPSTREAM_URL);
const UP_PROTO = UPSTREAM.protocol === 'https:' ? https : http;
const UP_PORT = UPSTREAM.port || (UPSTREAM.protocol === 'https:' ? 443 : 80);

// Hot-reload on file change and SIGHUP
process.on('SIGHUP', reloadConf);
try { fs.watch(CONF_FILE, { persistent: false }, () => setTimeout(reloadConf, 500)); } catch {}

// --- Alerting ---
// Priority: 1) Generic webhook  2) Feishu API  3) Log only

let _feishuToken = null;
let _feishuTokenExpire = 0;

/**
 * Auto-detect Feishu credentials from OpenClaw config.
 * Returns { appId, appSecret } or null.
 */
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
      res.on('end', () => LOG('alert-webhook', '-', `sent: ${res.statusCode}`));
    });
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
      res.on('end', () => LOG('alert-feishu', sid, `sent: ${res.statusCode}`));
    });
    req.on('error', e => LOG('alert-feishu', sid, `error: ${e.message}`));
    req.write(body);
    req.end();
  });
}

function sendAlert(sid, type, detail) {
  const message = `⚠️ Cache Keepalive Alert\nSession: ${sid}\nType: ${type}\n${detail}\nTime: ${new Date().toISOString()}`;
  LOG('alert', sid, `${type}: ${detail}`);

  // Persist to file
  try {
    fs.appendFileSync(ALERTS_FILE, JSON.stringify({ ts: Date.now(), sid, type, detail }) + '\n');
  } catch {}

  // Route alert: webhook > feishu > log-only
  if (ALERT_WEBHOOK_URL) {
    sendWebhookAlert({ sid, type, detail, timestamp: new Date().toISOString() });
  } else if (ALERT_CHAT_ID) {
    sendFeishuAlert(sid, message);
  }
  // If neither configured, alert is already logged + written to .alerts.jsonl
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

/**
 * Extract session ID from request body.
 * Uses OpenClaw's injected chat_id from system prompt.
 * Falls back to hash-based ID for unrecognized sessions.
 */
function extractSessionId(body) {
  try {
    const blocks = Array.isArray(body.system) ? body.system : [{ text: String(body.system) }];
    for (const b of blocks) {
      if (!b.text) continue;
      // OpenClaw injects chat_id in inbound context metadata
      const m = b.text.match(/"chat_id"\s*:\s*"([^"]+)"/);
      if (m) return m[1];
    }
    // Fallback: hash-based ID (for heartbeat, cron, or unknown sessions)
    const sig = JSON.stringify(body.system || '').slice(0, 2000);
    return 'h:' + crypto.createHash('md5').update(sig).digest('hex').slice(0, 12);
  } catch { return 'unknown'; }
}

function buildHeaders(src) {
  const h = { 'host': UPSTREAM.host, 'content-type': src['content-type'] || 'application/json' };
  for (const k of Object.keys(src)) {
    if (k.startsWith('x-api-') || k.startsWith('anthropic') || k === 'authorization') h[k] = src[k];
  }
  return h;
}

// --- Keepalive ---
function sendKeepalive(sid, isRetry = false) {
  const s = sessions.get(sid);
  if (!s) return;
  const capturedVersion = s.version;

  if (Date.now() - s.lastActive > EXPIRE_MS) {
    LOG('expire', sid, 'removing inactive session');
    sessions.delete(sid);
    return;
  }

  // Build minimal keepalive request: same body, but max_tokens=1, no streaming
  const kaBody = JSON.parse(s.rawBody);
  kaBody.max_tokens = 1;
  kaBody.stream = false;
  // Keep thinking structure intact (required for cache prefix match),
  // but minimize budget to avoid wasting tokens
  if (kaBody.thinking && kaBody.thinking.type === 'enabled') {
    kaBody.thinking.budget_tokens = 128;
  }
  const payload = JSON.stringify(kaBody);
  const sentAt = Date.now();
  const sentAtISO = new Date(sentAt).toISOString();

  if (!isRetry) {
    s.keepaliveCount = (s.keepaliveCount || 0) + 1;
  }
  s.lastKeepalive = sentAt;

  LOG(isRetry ? 'keepalive-retry' : 'keepalive', sid,
    `sending body_len=${payload.length} model=${kaBody.model}${isRetry ? ' (RETRY)' : ''}`);

  const req = UP_PROTO.request({
    hostname: UPSTREAM.hostname, port: UP_PORT, path: s.path, method: 'POST',
    headers: { ...s.headers, 'content-length': Buffer.byteLength(payload) }
  }, (res) => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      // Version check: if session was replaced by a new real request, skip
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
        s.lastKeepaliveResult = {
          status: res.statusCode, cacheRead, cacheWrite, success,
          sentAt: sentAtISO, respondedAt: new Date().toISOString(), isRetry
        };

        LOG('keepalive', sid,
          `${res.statusCode} cache_read=${cacheRead} cache_write=${cacheWrite}${isRetry ? ' (RETRY)' : ''}`);

        // Alert on cache miss (cache already rebuilt, no retry needed)
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

      // Retry logic: only retry on network/HTTP/parse errors, NOT on cache_miss
      const needsRetry = !success && !isRetry && !(s.lastKeepaliveResult?.cacheWrite > 0);
      if (needsRetry) {
        LOG('keepalive', sid, `scheduling retry in ${RETRY_DELAY_MS}ms`);
        s.timer = setTimeout(() => sendKeepalive(sid, true), RETRY_DELAY_MS);
        s.nextKeepaliveAt = Date.now() + RETRY_DELAY_MS;
        return;
      }

      // Schedule next keepalive
      s.timer = setTimeout(() => sendKeepalive(sid), KEEPALIVE_MS);
      s.nextKeepaliveAt = Date.now() + KEEPALIVE_MS;
    });
  });

  req.on('error', e => {
    // Version check
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

  const totals = sessionList.reduce((acc, s) => {
    acc.keepalivesSent += s.keepaliveCount;
    acc.totalCacheRead += s.totalCacheRead;
    acc.totalCacheWrite += s.totalCacheWrite;
    return acc;
  }, { keepalivesSent: 0, totalCacheRead: 0, totalCacheWrite: 0 });

  let recentAlerts = [];
  try {
    const lines = fs.readFileSync(ALERTS_FILE, 'utf-8').trim().split('\n').filter(Boolean);
    recentAlerts = lines.slice(-5).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {}

  const result = {
    uptime: formatDuration(now - STARTED_AT),
    startedAt: new Date(STARTED_AT).toISOString(),
    now: new Date(now).toISOString(),
    config: {
      upstream: UPSTREAM.origin, port: PORT,
      keepaliveInterval: formatDuration(KEEPALIVE_MS), keepaliveMs: KEEPALIVE_MS,
      sessionExpiry: formatDuration(EXPIRE_MS), expireMs: EXPIRE_MS,
      cacheTtl: formatDuration(CACHE_TTL_MS), cacheTtlMs: CACHE_TTL_MS,
      retryDelay: formatDuration(RETRY_DELAY_MS), retryDelayMs: RETRY_DELAY_MS,
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
      ...totals,
      totalCacheReadHuman: formatTokens(totals.totalCacheRead),
      totalCacheWriteHuman: formatTokens(totals.totalCacheWrite),
      cacheHitRate: totals.keepalivesSent > 0
        ? (totals.totalCacheWrite === 0 ? '100%' : `${Math.round((totals.totalCacheRead / (totals.totalCacheRead + totals.totalCacheWrite)) * 100)}%`)
        : 'N/A'
    },
    recentAlerts
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

    // Cache session for keepalive
    if (body && (body.system || body.messages)) {
      const sid = extractSessionId(body);
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
    }

    // Forward to upstream
    const fwd = { ...buildHeaders(cReq.headers), 'content-length': raw.length };
    const pReq = UP_PROTO.request({
      hostname: UPSTREAM.hostname, port: UP_PORT,
      path: cReq.url, method: cReq.method, headers: fwd
    }, (pRes) => {
      cRes.writeHead(pRes.statusCode, pRes.headers);
      pRes.pipe(cRes);
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

server.listen(PORT, '127.0.0.1', () => {
  LOG('start', '-', `listening :${PORT} → ${UPSTREAM.origin} (keepalive=${KEEPALIVE_MS / 1000}s, expire=${EXPIRE_MS / 1000}s)`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  for (const [, s] of sessions) if (s.timer) clearTimeout(s.timer);
  server.close();
  process.exit(0);
});
process.on('SIGINT', () => process.emit('SIGTERM'));
