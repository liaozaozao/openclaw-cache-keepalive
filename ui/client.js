/** Status page client-side JavaScript — polling, rendering, i18n, session management. */
"use strict";

const STATUS_PAGE_CLIENT = String.raw`
    const REFRESH_INTERVAL_MS = 5000;
    const LANGUAGE_STORAGE_KEY = 'cache-keepalive-status-lang';
    const LANGUAGES = ['zh-CN', 'en'];
    const MESSAGES = {
      'zh-CN': {
        page_title: '缓存保活状态',
        eyebrow: 'Prompt Cache Telemetry',
        hero_title: 'Cache Keepalive Signal Board',
        hero_desc: '保留 <span class="mono">/status</span> 原始 JSON 的同时，把会话、保活、排除和节省信息整理成一块适合长期盯盘的状态面板。',
        health_loading: '加载中',
        health_waiting: '等待数据',
        health_risky: '存在风险会话',
        health_recent_alert: '近期有告警',
        health_ok: '保活运行正常',
        health_no_active: '暂无活跃保活',
        refresh_meta_auto: '自动刷新 5s',
        refresh_meta_paused: '自动刷新已暂停',
        refresh_meta_recent: '最近 {time}',
        btn_refresh: '立即刷新',
        btn_auto_on: '自动刷新：开',
        btn_auto_off: '自动刷新：关',
        btn_json: '原始 JSON',
        btn_inspect: 'Inspect',
        btn_capture: 'Capture',
        filter_all: '全部',
        filter_active: '保活中',
        filter_excluded: '已排除',
        filter_risk: '异常',
        search_placeholder: '按 session id / model / kind 过滤',
        session_deck_label: 'Session Deck',
        session_heading: '会话状态',
        session_waiting: '等待首次数据',
        session_count_filtered: '共 {count} 个会话符合当前筛选',
        session_empty: '当前没有匹配的会话。<br>保留筛选条件不变时，下一次轮询会自动补齐新数据。',
        other_sessions: '其他会话',
        session_help: '关闭终端不会立刻停止保活。可在这里手动移除不再需要的会话。',
        control_plane_label: 'Control Plane',
        control_heading: '运行参数',
        control_subtitle: '当前进程视角',
        alert_trail_label: 'Alert Trail',
        alert_heading: '最近告警',
        alert_subtitle: '最多展示 5 条',
        footer_note: '状态页仅做本地展示，不改变现有保活逻辑；所有数据仍来自 <span class="mono">GET /status</span>。',
        footer_error: '无法拉取 <span class="mono">/status</span>：{error}',
        loading_board: '正在读取代理状态…',
        empty_no_data: '暂无数据',
        alerts_empty: '最近没有保活异常。<br>这里会显示 cache miss 和 keepalive 错误。',
        not_configured: '未配置',
        enabled: '开启',
        disabled: '关闭',
        none: '无',
        na: 'N/A',
        expired: '已过期',
        version: '版本 {value}',
        uptime: '运行 {value}',
        active_keepalive: '保活中 {value}',
        excluded_count: '已排除 {value}',
        rebuilds_avoided: '避免重建 {value}',
        read_write_ratio: '读写比 {value}',
        cache_read_total: 'cache_read {value}',
        alert_mode: '告警模式 {value}',
        metric_process_health: '进程健康',
        metric_session_surface: '会话面',
        metric_keepalive_cycles: '保活周期',
        metric_estimated_savings: '估算节省',
        model: 'Model',
        kind: 'Kind',
        source: 'Source',
        next_keepalive: '下次保活',
        cache_remaining: '缓存剩余',
        keepalive_count: '本轮保活',
        keepalive_count_total: '累计保活',
        read_write_ratio_short: '读写占比',
        last_message: '最近消息',
        last_keepalive: '最近保活',
        body_size: '请求体大小',
        session_expiry: '会话过期',
        last_result: '最近结果',
        state_excluded: '已排除',
        state_cache_expired: '缓存已过期',
        state_recent_fail: '最近保活失败',
        state_cache_miss: '发生过 cache miss',
        state_stable: '保活稳定',
        state_waiting: '等待首轮保活',
        reason_haiku_model: 'Haiku 模型',
        reason_prefix_excluded: '前缀排除',
        reason_keepalive_disabled: '已禁用',
        keepalive_excluded: '该会话不进入定时保活',
        keepalive_not_yet: '尚未执行首轮 keepalive',
        keepalive_failed_prefix: '失败：',
        retry_label: '重试',
        read_label: 'read',
        write_label: 'write',
        config_upstream: '上游',
        config_port: '监听端口',
        config_keepalive_interval: '保活间隔',
        config_session_expiry: '会话过期',
        config_cache_ttl: '缓存 TTL',
        config_retry_delay: '重试延迟',
        config_request_timeout: '请求超时',
        config_exclude_prefix: '排除前缀',
        config_inspect: 'Inspect',
        config_capture: 'Capture',
        config_enabled_entries: '开启，保留 {count} 条',
        alert_mode_log_only: '仅日志',
        alert_mode_webhook: 'Webhook',
        alert_mode_feishu: '飞书',
        lang_zh: '中文',
        lang_en: 'English',
        connection_failed: '连接失败'
        ,
        stop_session: '停止保活',
        remove_session: '移除会话',
        stop_failed: '停止失败',
        stop_waiting: '处理中…'
      },
      en: {
        page_title: 'Cache Keepalive Status',
        eyebrow: 'Prompt Cache Telemetry',
        hero_title: 'Cache Keepalive Signal Board',
        hero_desc: 'Keep the raw <span class="mono">/status</span> JSON intact while turning sessions, keepalive, exclusions, and savings into a board you can monitor for hours.',
        health_loading: 'Loading',
        health_waiting: 'Waiting for data',
        health_risky: 'Risky sessions detected',
        health_recent_alert: 'Recent alerts present',
        health_ok: 'Keepalive healthy',
        health_no_active: 'No active keepalive',
        refresh_meta_auto: 'Auto refresh 5s',
        refresh_meta_paused: 'Auto refresh paused',
        refresh_meta_recent: 'Last {time}',
        btn_refresh: 'Refresh now',
        btn_auto_on: 'Auto refresh: On',
        btn_auto_off: 'Auto refresh: Off',
        btn_json: 'Raw JSON',
        btn_inspect: 'Inspect',
        btn_capture: 'Capture',
        filter_all: 'All',
        filter_active: 'Active',
        filter_excluded: 'Excluded',
        filter_risk: 'Risk',
        search_placeholder: 'Filter by session id / model / kind',
        session_deck_label: 'Session Deck',
        session_heading: 'Sessions',
        session_waiting: 'Waiting for first payload',
        session_count_filtered: '{count} session(s) match the current filters',
        session_empty: 'No sessions match the current filters.<br>Keep the filters as they are and the next poll will fill in new data automatically.',
        other_sessions: 'Other Sessions',
        session_help: 'Closing a terminal does not stop keepalive immediately. Remove sessions here when you no longer need them.',
        control_plane_label: 'Control Plane',
        control_heading: 'Runtime Config',
        control_subtitle: 'Current process view',
        alert_trail_label: 'Alert Trail',
        alert_heading: 'Recent Alerts',
        alert_subtitle: 'Showing up to 5 entries',
        footer_note: 'This page is local-only UI. It does not change keepalive logic; all data still comes from <span class="mono">GET /status</span>.',
        footer_error: 'Failed to fetch <span class="mono">/status</span>: {error}',
        loading_board: 'Loading proxy status…',
        empty_no_data: 'No data yet',
        alerts_empty: 'No recent keepalive errors.<br>This panel shows cache misses and keepalive failures.',
        not_configured: 'Not configured',
        enabled: 'Enabled',
        disabled: 'Disabled',
        none: 'None',
        na: 'N/A',
        expired: 'Expired',
        version: 'Version {value}',
        uptime: 'Uptime {value}',
        active_keepalive: 'Active {value}',
        excluded_count: 'Excluded {value}',
        rebuilds_avoided: 'Avoided rebuilds {value}',
        read_write_ratio: 'Read/write {value}',
        cache_read_total: 'cache_read {value}',
        alert_mode: 'Alert mode {value}',
        metric_process_health: 'Process Health',
        metric_session_surface: 'Session Surface',
        metric_keepalive_cycles: 'Keepalive Cycles',
        metric_estimated_savings: 'Estimated Savings',
        model: 'Model',
        kind: 'Kind',
        source: 'Source',
        next_keepalive: 'Next keepalive',
        cache_remaining: 'Cache remaining',
        keepalive_count: 'Current window',
        keepalive_count_total: 'Lifetime total',
        read_write_ratio_short: 'Read/write ratio',
        last_message: 'Last message',
        last_keepalive: 'Last keepalive',
        body_size: 'Body size',
        session_expiry: 'Session expiry',
        last_result: 'Last result',
        state_excluded: 'Excluded',
        state_cache_expired: 'Cache expired',
        state_recent_fail: 'Recent keepalive failed',
        state_cache_miss: 'Observed cache miss',
        state_stable: 'Keepalive stable',
        state_waiting: 'Waiting for first keepalive',
        reason_haiku_model: 'Haiku model',
        reason_prefix_excluded: 'Prefix excluded',
        reason_keepalive_disabled: 'Disabled',
        keepalive_excluded: 'This session does not enter scheduled keepalive',
        keepalive_not_yet: 'The first keepalive has not run yet',
        keepalive_failed_prefix: 'Failed: ',
        retry_label: 'retry',
        read_label: 'read',
        write_label: 'write',
        config_upstream: 'Upstream',
        config_port: 'Listen port',
        config_keepalive_interval: 'Keepalive interval',
        config_session_expiry: 'Session expiry',
        config_cache_ttl: 'Cache TTL',
        config_retry_delay: 'Retry delay',
        config_request_timeout: 'Request timeout',
        config_exclude_prefix: 'Exclude prefix',
        config_inspect: 'Inspect',
        config_capture: 'Capture',
        config_enabled_entries: 'Enabled, keep {count} entries',
        alert_mode_log_only: 'Log only',
        alert_mode_webhook: 'Webhook',
        alert_mode_feishu: 'Feishu',
        lang_zh: '中文',
        lang_en: 'English',
        connection_failed: 'Connection failed',
        stop_session: 'Stop keepalive',
        remove_session: 'Remove session',
        stop_failed: 'Stop failed',
        stop_waiting: 'Working…'
      }
    };

    function normalizeLanguage(value) {
      return LANGUAGES.includes(value) ? value : 'zh-CN';
    }

    function getPreferredLanguage() {
      try {
        return normalizeLanguage(localStorage.getItem(LANGUAGE_STORAGE_KEY) || 'zh-CN');
      } catch {
        return 'zh-CN';
      }
    }

    const state = {
      payload: null,
      filter: 'all',
      query: '',
      autoRefresh: true,
      loading: false,
      pendingStopId: null,
      error: null,
      refreshedAt: null,
      lang: getPreferredLanguage()
    };

    const overviewEl = document.getElementById('overview');
    const sessionsEl = document.getElementById('sessions');
    const alertsEl = document.getElementById('alerts');
    const configEl = document.getElementById('config-list');
    const sessionMetaEl = document.getElementById('session-meta');
    const refreshMetaEl = document.getElementById('refresh-meta');
    const healthPillEl = document.getElementById('health-pill');
    const footerNoteEl = document.getElementById('footer-note');
    const refreshBtn = document.getElementById('refresh-btn');
    const autoBtn = document.getElementById('auto-btn');
    const searchInput = document.getElementById('search-input');
    const filterButtons = Array.from(document.querySelectorAll('[data-filter]'));
    const langButtons = Array.from(document.querySelectorAll('[data-lang]'));

    function t(key, vars = {}) {
      const locale = MESSAGES[state.lang] || MESSAGES['zh-CN'];
      const fallback = MESSAGES['zh-CN'];
      const template = locale[key] || fallback[key] || key;
      return String(template).replace(/\{(\w+)\}/g, (_, token) => String(vars[token] ?? ''));
    }

    function escapeHtml(value) {
      return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function setLanguage(lang) {
      state.lang = normalizeLanguage(lang);
      try {
        localStorage.setItem(LANGUAGE_STORAGE_KEY, state.lang);
      } catch {}
      applyStaticTexts();
      render();
    }

    function applyStaticTexts() {
      document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
      document.title = t('page_title');

      document.querySelectorAll('[data-i18n]').forEach((node) => {
        node.textContent = t(node.dataset.i18n);
      });

      document.querySelectorAll('[data-i18n-html]').forEach((node) => {
        node.innerHTML = t(node.dataset.i18nHtml);
      });

      refreshBtn.textContent = t('btn_refresh');
      searchInput.placeholder = t('search_placeholder');

      const filterKeys = {
        all: 'filter_all',
        active: 'filter_active',
        excluded: 'filter_excluded',
        risk: 'filter_risk'
      };

      filterButtons.forEach((button) => {
        button.textContent = t(filterKeys[button.dataset.filter] || 'filter_all');
      });

      langButtons.forEach((button) => {
        const lang = button.dataset.lang;
        button.textContent = lang === 'en' ? t('lang_en') : t('lang_zh');
        button.classList.toggle('active', lang === state.lang);
      });
    }

    function formatNumber(value) {
      const locale = state.lang === 'en' ? 'en-US' : 'zh-CN';
      return Number(value || 0).toLocaleString(locale);
    }

    function formatUsd(value) {
      if (typeof value !== 'number' || Number.isNaN(value)) return t('not_configured');
      const locale = state.lang === 'en' ? 'en-US' : 'zh-CN';
      return new Intl.NumberFormat(locale, {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: value >= 10 ? 2 : 4,
        maximumFractionDigits: value >= 10 ? 2 : 4
      }).format(value);
    }

    function formatTime(value) {
      if (!value) return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      const locale = state.lang === 'en' ? 'en-US' : 'zh-CN';
      return new Intl.DateTimeFormat(locale, {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).format(date);
    }

    function formatDateTime(value) {
      if (!value) return '—';
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) return String(value);
      const locale = state.lang === 'en' ? 'en-US' : 'zh-CN';
      return new Intl.DateTimeFormat(locale, {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      }).format(date);
    }

    function displayRawValue(value) {
      if (value === 'EXPIRED') return t('expired');
      if (value === 'N/A') return t('na');
      return value || '—';
    }

    function translateExcludedReason(reason) {
      const key = {
        haiku_model: 'reason_haiku_model',
        prefix_excluded: 'reason_prefix_excluded',
        keepalive_disabled: 'reason_keepalive_disabled'
      }[reason];
      return key ? t(key) : reason;
    }

    function translateAlertMode(mode) {
      const key = {
        'log-only': 'alert_mode_log_only',
        webhook: 'alert_mode_webhook',
        feishu: 'alert_mode_feishu'
      }[mode];
      return key ? t(key) : mode;
    }

    function getHealth(payload) {
      if (!payload) return { label: t('health_waiting'), tone: 'var(--warn)' };
      const sessions = payload.sessions?.list || [];
      const active = sessions.filter((session) => !session.excluded);
      const risky = active.filter((session) => session.cacheExpired || session.lastKeepaliveResult?.success === false);
      if (risky.length > 0) {
        return { label: t('health_risky'), tone: 'var(--bad)' };
      }
      if ((payload.recentAlerts || []).length > 0) {
        return { label: t('health_recent_alert'), tone: 'var(--warn)' };
      }
      if (active.length > 0) {
        return { label: t('health_ok'), tone: 'var(--good)' };
      }
      return { label: t('health_no_active'), tone: 'var(--accent)' };
    }

    function getSessionTone(session) {
      if (session.excluded) return 'is-excluded';
      if (session.cacheExpired) return 'is-danger';
      if (session.lastKeepaliveResult?.success === false || session.totalCacheWrite > 0) return 'is-warning';
      return 'is-healthy';
    }

    function getSessionStateBadge(session) {
      if (session.excluded) {
        const reason = session.excludedReason ? ' · ' + translateExcludedReason(session.excludedReason) : '';
        return { tone: 'info', text: t('state_excluded') + reason };
      }
      if (session.cacheExpired) return { tone: 'bad', text: t('state_cache_expired') };
      if (session.lastKeepaliveResult?.success === false) return { tone: 'bad', text: t('state_recent_fail') };
      if (session.totalCacheWrite > 0) return { tone: 'warn', text: t('state_cache_miss') };
      if (session.keepaliveCount > 0) return { tone: 'good', text: t('state_stable') };
      return { tone: 'warn', text: t('state_waiting') };
    }

    function matchesFilter(session) {
      if (state.filter === 'active' && session.excluded) return false;
      if (state.filter === 'excluded' && !session.excluded) return false;
      if (state.filter === 'risk') {
        const risky = session.cacheExpired || session.lastKeepaliveResult?.success === false || session.totalCacheWrite > 0;
        if (!risky) return false;
      }
      if (!state.query) return true;
      const haystack = [
        session.id,
        session.model,
        session.requestKind,
        session.sessionSource,
        session.excludedReason
      ].join(' ').toLowerCase();
      return haystack.includes(state.query);
    }

    function getSessionPriority(session) {
      if (!session) return 0;
      if (!session.excluded && (session.cacheExpired || session.lastKeepaliveResult?.success === false || session.totalCacheWrite > 0)) return 0;
      if (!session.excluded) return 1;
      return 2;
    }

    function compareSessions(left, right) {
      const priorityGap = getSessionPriority(left) - getSessionPriority(right);
      if (priorityGap !== 0) return priorityGap;
      const leftTime = new Date(left?.lastActivity || 0).getTime();
      const rightTime = new Date(right?.lastActivity || 0).getTime();
      return rightTime - leftTime;
    }

    function renderOverview(payload) {
      const sessions = payload.sessions || { total: 0, activeKeepalive: 0, excluded: 0, list: [] };
      const totals = payload.totals || {};
      const cost = payload.costSavings || {};
      const health = getHealth(payload);
      const cards = [
        {
          label: t('metric_process_health'),
          tone: 'health',
          value: health.label,
          metaLeft: t('version', { value: payload.version || 'unknown' }),
          metaRight: t('uptime', { value: payload.uptime || '—' })
        },
        {
          label: t('metric_session_surface'),
          tone: 'sessions',
          value: formatNumber(sessions.total),
          metaLeft: t('active_keepalive', { value: formatNumber(sessions.activeKeepalive) }),
          metaRight: t('excluded_count', { value: formatNumber(sessions.excluded) })
        },
        {
          label: t('metric_keepalive_cycles'),
          tone: 'cycles',
          value: formatNumber(totals.keepaliveCycles),
          metaLeft: t('rebuilds_avoided', { value: formatNumber(totals.rebuildsAvoided) }),
          metaRight: t('read_write_ratio', { value: displayRawValue(totals.cacheReadRatio || 'N/A') })
        },
        {
          label: t('metric_estimated_savings'),
          tone: 'savings',
          value: cost.configured ? formatUsd(cost.netSavings) : t('not_configured'),
          metaLeft: t('cache_read_total', { value: totals.totalCacheReadHuman || '0' }),
          metaRight: t('alert_mode', { value: translateAlertMode(payload.config?.alertMode || 'unknown') })
        }
      ];

      overviewEl.innerHTML = cards.map((card) => {
        return '<article class="stat-card tone-' + escapeHtml(card.tone || 'neutral') + '">' +
          '<div>' +
          '<div class="stat-label">' + escapeHtml(card.label) + '</div>' +
          '<div class="stat-value">' + escapeHtml(card.value) + '</div>' +
          '</div>' +
          '<div class="stat-meta"><span>' + escapeHtml(card.metaLeft) + '</span><span>' + escapeHtml(card.metaRight) + '</span></div>' +
          '</article>';
      }).join('');
    }

    function buildKeepaliveSummary(session) {
      const keepaliveResult = session.lastKeepaliveResult;
      if (!keepaliveResult) {
        return session.excluded ? t('keepalive_excluded') : t('keepalive_not_yet');
      }
      if (keepaliveResult.error) {
        return t('keepalive_failed_prefix') + keepaliveResult.error;
      }
      return [
        'HTTP ' + keepaliveResult.status,
        t('read_label') + ' ' + formatNumber(keepaliveResult.cacheRead || 0),
        t('write_label') + ' ' + formatNumber(keepaliveResult.cacheWrite || 0),
        keepaliveResult.isRetry ? t('retry_label') : null
      ].filter(Boolean).join(' | ');
    }

    async function stopSession(sessionId) {
      state.pendingStopId = sessionId;
      render();
      try {
        const response = await fetch('/sessions/stop', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ id: sessionId })
        });
        const result = await response.json();
        if (!response.ok || !result.ok) throw new Error(result.error || 'HTTP ' + response.status);
        await refresh();
      } catch (error) {
        window.alert(t('stop_failed') + ': ' + (error instanceof Error ? error.message : String(error)));
      } finally {
        state.pendingStopId = null;
        render();
      }
    }

    function renderSessions(payload) {
      const sessions = (payload.sessions?.list || []).filter(matchesFilter).sort(compareSessions);
      sessionMetaEl.textContent = t('session_count_filtered', { count: formatNumber(sessions.length) });
      if (sessions.length === 0) {
        sessionsEl.innerHTML = '<div class="empty">' + t('session_empty') + '</div>';
        return;
      }

      // Group sessions by project name
      const groups = new Map();
      sessions.forEach((session) => {
        const project = session.projectPath
          ? session.projectPath.replace(/[\\/]/g, '/').replace(/\/$/, '').split('/').slice(0, -1).join('/') || '/'
          : null;
        const key = project || '__ungrouped__';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(session);
      });

      const html = [];
      for (const [project, groupSessions] of groups) {
        if (groups.size > 1) {
          const label = project === '__ungrouped__' ? t('other_sessions') : project;
          html.push('<div class="session-group-header">' + escapeHtml(label) + '</div>');
        }
        for (const session of groupSessions) {
          html.push(renderSessionCard(session));
        }
      }
      sessionsEl.innerHTML = html.join('');

      document.querySelectorAll('[data-stop-session]').forEach((button) => {
        button.addEventListener('click', () => {
          stopSession(button.getAttribute('data-stop-session'));
        });
      });
    }

    function renderSessionCard(session) {
        const stateBadge = getSessionStateBadge(session);
        const stopLabel = session.excluded ? t('remove_session') : t('stop_session');
        const isStopping = state.pendingStopId === session.id;
        return '<article class="session-card ' + getSessionTone(session) + '">' +
          '<div class="session-top">' +
          '<div class="session-title">' +
          (session.displayName
            ? '<h3>' + escapeHtml(session.displayName) + '</h3>' +
              '<div class="session-id mono">' + escapeHtml(session.id) + '</div>'
            : '<h3 class="mono">' + escapeHtml(session.id) + '</h3>') +
          '<div class="badges">' +
          '<span class="badge ' + stateBadge.tone + '">' + escapeHtml(stateBadge.text) + '</span>' +
          '<span class="badge"><strong>' + escapeHtml(t('model')) + '</strong>' + escapeHtml(session.model) + '</span>' +
          '<span class="badge"><strong>' + escapeHtml(t('kind')) + '</strong>' + escapeHtml(session.requestKind) + '</span>' +
          '<span class="badge"><strong>' + escapeHtml(t('source')) + '</strong>' + escapeHtml(session.sessionSource) + '</span>' +
          '</div>' +
          '</div>' +
          '<div class="session-actions">' +
          '<button class="session-stop" data-stop-session="' + escapeHtml(session.id) + '"' + (isStopping ? ' disabled' : '') + '>' +
          escapeHtml(isStopping ? t('stop_waiting') : stopLabel) +
          '</button>' +
          '</div>' +
          '</div>' +
          '<div class="session-kpis">' +
          '<div class="kpi"><span class="name">' + escapeHtml(t('next_keepalive')) + '</span><div class="value">' + escapeHtml(displayRawValue(session.nextKeepaliveIn)) + '</div></div>' +
          '<div class="kpi"><span class="name">' + escapeHtml(t('cache_remaining')) + '</span><div class="value">' + escapeHtml(displayRawValue(session.cacheExpiresIn)) + '</div></div>' +
          '<div class="kpi"><span class="name">' + escapeHtml(t('keepalive_count')) + '</span><div class="value">' + formatNumber(session.keepaliveCountCurrentWindow || 0) + '</div></div>' +
          '<div class="kpi"><span class="name">' + escapeHtml(t('read_write_ratio_short')) + '</span><div class="value">' + escapeHtml(displayRawValue(session.cacheReadRatio || 'N/A')) + '</div></div>' +
          '</div>' +
          '<div class="session-meta">' +
          '<div class="meta-row"><span>' + escapeHtml(t('last_message')) + '</span><span>' + escapeHtml(formatDateTime(session.lastActivity)) + ' · ' + escapeHtml(displayRawValue(session.idleTime)) + '</span></div>' +
          '<div class="meta-row"><span>' + escapeHtml(t('last_keepalive')) + '</span><span>' + escapeHtml(formatDateTime(session.lastKeepalive)) + '</span></div>' +
          '<div class="meta-row"><span>' + escapeHtml(t('keepalive_count_total')) + '</span><span>' + formatNumber(session.keepaliveCountTotal || session.keepaliveCount || 0) + '</span></div>' +
          '<div class="meta-row"><span>' + escapeHtml(t('body_size')) + '</span><span>' + escapeHtml(session.bodyLenHuman || '—') + ' · model cache_read ' + escapeHtml(session.totalCacheReadHuman || '0') + '</span></div>' +
          '<div class="meta-row"><span>' + escapeHtml(t('session_expiry')) + '</span><span>' + escapeHtml(formatDateTime(session.sessionExpiresAt)) + ' · ' + escapeHtml(displayRawValue(session.sessionExpiresIn)) + '</span></div>' +
          '<div class="meta-row"><span>' + escapeHtml(t('last_result')) + '</span><span>' + escapeHtml(buildKeepaliveSummary(session)) + '</span></div>' +
          '</div>' +
          '</article>';
    }

    function renderConfig(payload) {
      const config = payload.config || {};
      const items = [
        [t('config_upstream'), config.upstream || '—'],
        [t('config_port'), String(config.port || '—')],
        [t('config_keepalive_interval'), config.keepaliveInterval || '—'],
        [t('config_session_expiry'), config.sessionExpiry || '—'],
        [t('config_cache_ttl'), config.cacheTtl || '—'],
        [t('config_retry_delay'), config.retryDelay || '—'],
        [t('config_request_timeout'), config.requestTimeout || '—'],
        [t('config_exclude_prefix'), Array.isArray(config.exclude) && config.exclude.length > 0 ? config.exclude.join(', ') : t('none')],
        [t('config_inspect'), config.inspectRequests ? t('config_enabled_entries', { count: config.inspectMaxEntries }) : t('disabled')],
        [t('config_capture'), config.fullCaptureRequests ? t('config_enabled_entries', { count: config.fullCaptureMaxEntries }) : t('disabled')]
      ];

      configEl.innerHTML = items.map(([label, value]) => {
        return '<div class="item"><strong>' + escapeHtml(label) + '</strong><p>' + escapeHtml(value) + '</p></div>';
      }).join('');
    }

    function renderAlerts(payload) {
      const alerts = payload.recentAlerts || [];
      if (alerts.length === 0) {
        alertsEl.innerHTML = '<div class="empty">' + t('alerts_empty') + '</div>';
        return;
      }
      alertsEl.innerHTML = alerts.slice().reverse().map((alert) => {
        return '<div class="item">' +
          '<strong>' + escapeHtml(alert.type || 'unknown') + ' · ' + escapeHtml(formatTime(alert.ts)) + '</strong>' +
          '<p class="mono">' + escapeHtml(alert.sid || '—') + '</p>' +
          '<p>' + escapeHtml(alert.detail || '') + '</p>' +
          '</div>';
      }).join('');
    }

    function renderShell() {
      const health = getHealth(state.payload);
      const healthLabel = state.error ? t('connection_failed') : health.label;
      healthPillEl.innerHTML = '<span class="status-dot" style="color: ' + health.tone + '"></span><span>' + escapeHtml(healthLabel) + '</span>';
      const refreshParts = [state.autoRefresh ? t('refresh_meta_auto') : t('refresh_meta_paused')];
      if (state.refreshedAt) refreshParts.push(t('refresh_meta_recent', { time: formatTime(state.refreshedAt) }));
      refreshMetaEl.textContent = refreshParts.join(' · ');
      autoBtn.textContent = state.autoRefresh ? t('btn_auto_on') : t('btn_auto_off');
      refreshBtn.disabled = state.loading;

      filterButtons.forEach((button) => {
        button.classList.toggle('active', button.dataset.filter === state.filter);
      });

      if (state.error) {
        footerNoteEl.innerHTML = t('footer_error', { error: escapeHtml(state.error) });
        footerNoteEl.style.color = 'var(--bad)';
      } else {
        footerNoteEl.innerHTML = t('footer_note');
        footerNoteEl.style.color = 'var(--text-faint)';
      }
    }

    function render() {
      renderShell();
      if (!state.payload) {
        overviewEl.innerHTML = '<div class="empty">' + escapeHtml(t('loading_board')) + '</div>';
        sessionsEl.innerHTML = '<div class="empty">' + escapeHtml(t('empty_no_data')) + '</div>';
        alertsEl.innerHTML = '<div class="empty">' + escapeHtml(t('empty_no_data')) + '</div>';
        configEl.innerHTML = '<div class="empty">' + escapeHtml(t('empty_no_data')) + '</div>';
        return;
      }
      renderOverview(state.payload);
      renderSessions(state.payload);
      renderConfig(state.payload);
      renderAlerts(state.payload);
    }

    async function refresh() {
      state.loading = true;
      renderShell();
      try {
        const response = await fetch('/status', { cache: 'no-store' });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        state.payload = await response.json();
        state.error = null;
        state.refreshedAt = new Date().toISOString();
      } catch (error) {
        state.error = error instanceof Error ? error.message : String(error);
      } finally {
        state.loading = false;
        render();
      }
    }

    refreshBtn.addEventListener('click', () => {
      refresh();
    });

    autoBtn.addEventListener('click', () => {
      state.autoRefresh = !state.autoRefresh;
      renderShell();
    });

    searchInput.addEventListener('input', (event) => {
      state.query = String(event.target.value || '').trim().toLowerCase();
      render();
    });

    filterButtons.forEach((button) => {
      button.addEventListener('click', () => {
        state.filter = button.dataset.filter || 'all';
        render();
      });
    });

    langButtons.forEach((button) => {
      button.addEventListener('click', () => {
        setLanguage(button.dataset.lang);
      });
    });

    window.setInterval(() => {
      if (state.autoRefresh) refresh();
    }, REFRESH_INTERVAL_MS);

    applyStaticTexts();
    render();
    refresh();
`;

module.exports = {
  STATUS_PAGE_CLIENT,
};
