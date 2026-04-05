/** Status page HTML template — page structure, sections, and element IDs. */
"use strict";

const STATUS_PAGE_TEMPLATE = String.raw`
  <div class="shell">
    <section class="hero">
      <div class="hero-grid">
        <div class="hero-copy">
          <div class="eyebrow" data-i18n="eyebrow"></div>
          <h1 data-i18n="hero_title"></h1>
          <p data-i18n-html="hero_desc"></p>
          <div class="hero-actions">
            <button class="control control-primary" id="refresh-btn" type="button"></button>
            <button class="control" id="auto-btn" type="button"></button>
            <a class="control" href="/status" target="_blank" rel="noreferrer" data-i18n="btn_json"></a>
            <a class="control" href="/inspect" target="_blank" rel="noreferrer" data-i18n="btn_inspect"></a>
            <a class="control" href="/capture" target="_blank" rel="noreferrer" data-i18n="btn_capture"></a>
          </div>
        </div>
        <aside class="hero-side">
          <div class="lang-switch" role="group" aria-label="Language switch">
            <button class="lang-chip" id="lang-zh" data-lang="zh-CN" type="button"></button>
            <button class="lang-chip" id="lang-en" data-lang="en" type="button"></button>
          </div>
          <div class="status-pill" id="health-pill">
            <span class="status-dot"></span>
            <span data-i18n="health_loading"></span>
          </div>
          <div class="status-pill status-pill-muted">
            <span class="status-dot" style="color: var(--accent)"></span>
            <span id="refresh-meta"></span>
          </div>
          <label class="search-wrap" for="search-input">
            <span class="search-label mono">session probe</span>
            <input class="search" id="search-input" type="search" aria-label="Session search">
          </label>
        </aside>
      </div>
      <div class="toolbar" role="group" aria-label="Session filters">
        <div class="toolbar-copy">
          <span class="toolbar-label mono">filter lane</span>
          <p class="toolbar-note" data-i18n="session_help"></p>
        </div>
        <div class="toolbar-filters">
          <button class="filter-chip active" data-filter="all" type="button"></button>
          <button class="filter-chip" data-filter="active" type="button"></button>
          <button class="filter-chip" data-filter="excluded" type="button"></button>
          <button class="filter-chip" data-filter="risk" type="button"></button>
        </div>
      </div>
    </section>

    <main class="layout">
      <section class="stats-grid" id="overview"></section>
      <section class="content-grid">
        <div class="panel panel-sessions">
          <div class="section-head">
            <div>
              <div class="section-label" data-i18n="session_deck_label"></div>
              <h2 data-i18n="session_heading"></h2>
            </div>
            <p id="session-meta"></p>
          </div>
          <div class="session-grid" id="sessions"></div>
        </div>
        <aside class="rail">
          <div class="panel panel-rail">
            <div class="section-head">
              <div>
                <div class="section-label" data-i18n="control_plane_label"></div>
                <h2 data-i18n="control_heading"></h2>
              </div>
              <p data-i18n="control_subtitle"></p>
            </div>
            <div class="list" id="config-list"></div>
          </div>
          <div class="panel panel-rail">
            <div class="section-head">
              <div>
                <div class="section-label" data-i18n="alert_trail_label"></div>
                <h2 data-i18n="alert_heading"></h2>
              </div>
              <p data-i18n="alert_subtitle"></p>
            </div>
            <div class="list" id="alerts"></div>
          </div>
        </aside>
      </section>
      <div class="footer-note" id="footer-note"></div>
    </main>
  </div>
`;

module.exports = {
  STATUS_PAGE_TEMPLATE,
};
