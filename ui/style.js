/** Status page CSS styles — dark theme, responsive grid layout, session cards. */
"use strict";

const STATUS_PAGE_STYLE = String.raw`
    @import url("https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;600;700&family=Noto+Serif+SC:wght@600;700&display=swap");

    :root {
      --bg-0: #081019;
      --bg-1: #0d1722;
      --panel: rgba(11, 18, 27, 0.82);
      --panel-soft: rgba(14, 24, 36, 0.72);
      --panel-strong: rgba(7, 13, 21, 0.92);
      --surface: rgba(255, 255, 255, 0.05);
      --surface-strong: rgba(255, 255, 255, 0.08);
      --line: rgba(180, 212, 255, 0.14);
      --line-strong: rgba(180, 212, 255, 0.26);
      --line-soft: rgba(180, 212, 255, 0.08);
      --text: #ebf5ff;
      --text-muted: rgba(235, 245, 255, 0.76);
      --text-faint: rgba(235, 245, 255, 0.5);
      --good: #74efc4;
      --warn: #f7c26a;
      --bad: #ff917a;
      --accent: #8ed3ff;
      --accent-2: #7a8eff;
      --shadow-lg: 0 34px 90px rgba(0, 0, 0, 0.42);
      --shadow-md: 0 20px 46px rgba(0, 0, 0, 0.28);
      --radius-xl: 30px;
      --radius-lg: 22px;
      --radius-md: 16px;
      --radius-sm: 999px;
      --focus: 0 0 0 3px rgba(142, 211, 255, 0.28);
    }

    * {
      box-sizing: border-box;
    }

    html {
      min-height: 100%;
      background:
        radial-gradient(circle at 0% 0%, rgba(116, 239, 196, 0.12), transparent 28%),
        radial-gradient(circle at 100% 0%, rgba(247, 194, 106, 0.14), transparent 26%),
        radial-gradient(circle at 50% 100%, rgba(122, 142, 255, 0.16), transparent 34%),
        linear-gradient(180deg, #071019 0%, #0a121b 34%, #0c1520 100%);
      color: var(--text);
      color-scheme: dark;
    }

    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Noto Sans SC", "PingFang SC", "Microsoft YaHei", sans-serif;
      background:
        linear-gradient(rgba(255, 255, 255, 0.018) 1px, transparent 1px),
        linear-gradient(90deg, rgba(255, 255, 255, 0.018) 1px, transparent 1px);
      background-size: 32px 32px;
    }

    body::before,
    body::after {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      z-index: 0;
    }

    body::before {
      background:
        radial-gradient(circle at 12% 16%, rgba(116, 239, 196, 0.08), transparent 20%),
        radial-gradient(circle at 84% 24%, rgba(142, 211, 255, 0.08), transparent 26%),
        radial-gradient(circle at 58% 78%, rgba(255, 145, 122, 0.08), transparent 22%);
      mix-blend-mode: screen;
    }

    body::after {
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.03), transparent 160px),
        linear-gradient(90deg, transparent 0, rgba(255, 255, 255, 0.02) 50%, transparent 100%);
      opacity: 0.45;
    }

    a {
      color: inherit;
    }

    button,
    input {
      font: inherit;
    }

    button:focus-visible,
    input:focus-visible,
    a:focus-visible {
      outline: none;
      box-shadow: var(--focus);
    }

    .shell {
      position: relative;
      z-index: 1;
      width: min(1480px, calc(100vw - 28px));
      margin: 0 auto;
      padding: 22px 0 48px;
    }

    .hero {
      position: sticky;
      top: 0;
      z-index: 20;
      margin-bottom: 20px;
      padding: 24px;
      border: 1px solid var(--line);
      border-radius: var(--radius-xl);
      background:
        linear-gradient(135deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.01)),
        linear-gradient(180deg, rgba(8, 14, 22, 0.82), rgba(10, 18, 27, 0.92));
      backdrop-filter: blur(22px);
      box-shadow: var(--shadow-lg);
      overflow: hidden;
    }

    .hero::before,
    .hero::after {
      content: "";
      position: absolute;
      pointer-events: none;
      border-radius: 50%;
      filter: blur(8px);
    }

    .hero::before {
      inset: -80px auto auto -50px;
      width: 220px;
      height: 220px;
      background: radial-gradient(circle, rgba(116, 239, 196, 0.14), transparent 70%);
    }

    .hero::after {
      inset: auto -70px -80px auto;
      width: 260px;
      height: 260px;
      background: radial-gradient(circle, rgba(142, 211, 255, 0.16), transparent 72%);
    }

    .hero-grid,
    .content-grid {
      display: grid;
      gap: 20px;
    }

    .hero-grid {
      position: relative;
      z-index: 1;
      grid-template-columns: minmax(0, 1.5fr) minmax(280px, 360px);
      align-items: start;
    }

    .hero-copy {
      max-width: 780px;
    }

    .eyebrow {
      display: inline-flex;
      align-items: center;
      min-height: 30px;
      margin-bottom: 14px;
      padding: 6px 12px;
      border: 1px solid rgba(247, 194, 106, 0.22);
      border-radius: var(--radius-sm);
      background: rgba(247, 194, 106, 0.1);
      color: var(--warn);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.09em;
      text-transform: uppercase;
    }

    h1 {
      margin: 0;
      max-width: 11ch;
      font-family: "Noto Serif SC", "Songti SC", serif;
      font-size: clamp(34px, 5vw, 66px);
      line-height: 0.96;
      letter-spacing: -0.045em;
      text-wrap: balance;
    }

    .hero-copy p {
      margin: 16px 0 0;
      max-width: 57ch;
      color: var(--text-muted);
      font-size: 16px;
      line-height: 1.78;
    }

    .hero-actions {
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 20px;
    }

    .hero-side {
      display: grid;
      gap: 12px;
      align-content: start;
    }

    .lang-switch {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px;
      padding: 4px;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: rgba(255, 255, 255, 0.03);
      min-width: 224px;
    }

    .lang-chip {
      appearance: none;
      min-height: 38px;
      padding: 8px 12px;
      border: 1px solid transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      color: var(--text-faint);
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      transition: 180ms ease;
    }

    .lang-chip:hover,
    .lang-chip.active {
      color: var(--text);
      border-color: rgba(255, 255, 255, 0.12);
      background: rgba(255, 255, 255, 0.08);
    }

    .status-pill,
    .search-wrap {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 18px;
      background: rgba(255, 255, 255, 0.04);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }

    .status-pill {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      min-height: 50px;
      padding: 0 16px;
      font-size: 14px;
      font-weight: 700;
    }

    .status-pill-muted {
      color: var(--text-muted);
    }

    .status-dot {
      flex: 0 0 auto;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: currentColor;
      box-shadow: 0 0 18px currentColor;
    }

    .search-wrap {
      display: grid;
      gap: 6px;
      padding: 12px 14px 14px;
    }

    .search-label {
      color: var(--text-faint);
      font-size: 11px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .search {
      width: 100%;
      min-height: 42px;
      padding: 0 2px;
      border: 0;
      background: transparent;
      color: var(--text);
      font-size: 14px;
    }

    .search::placeholder {
      color: var(--text-faint);
    }

    .toolbar {
      position: relative;
      z-index: 1;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-top: 18px;
      padding-top: 18px;
      border-top: 1px solid var(--line-soft);
    }

    .toolbar-copy {
      display: grid;
      gap: 4px;
      max-width: 52ch;
    }

    .toolbar-label {
      color: var(--accent);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }

    .toolbar-note {
      margin: 0;
      color: var(--text-muted);
      font-size: 13px;
      line-height: 1.65;
    }

    .toolbar-filters {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 10px;
    }

    .control,
    .filter-chip {
      appearance: none;
      border: 1px solid var(--line);
      border-radius: var(--radius-sm);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text);
      transition: transform 180ms ease, border-color 180ms ease, background 180ms ease, color 180ms ease;
    }

    .control {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 40px;
      padding: 0 16px;
      font-size: 13.5px;
      font-weight: 700;
      text-decoration: none;
      cursor: pointer;
    }

    .control-primary {
      border-color: rgba(142, 211, 255, 0.26);
      background: linear-gradient(135deg, rgba(142, 211, 255, 0.22), rgba(122, 142, 255, 0.14));
    }

    .filter-chip {
      min-height: 38px;
      padding: 0 14px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
    }

    .control:hover,
    .filter-chip:hover,
    .filter-chip.active {
      transform: translateY(-1px);
      border-color: var(--line-strong);
      background: rgba(255, 255, 255, 0.1);
    }

    .control[disabled] {
      cursor: wait;
      opacity: 0.6;
      transform: none;
    }

    .layout {
      display: grid;
      gap: 20px;
    }

    .stats-grid,
    .session-grid,
    .list {
      display: grid;
      gap: 16px;
    }

    .stats-grid {
      grid-template-columns: repeat(4, minmax(0, 1fr));
    }

    .content-grid {
      grid-template-columns: minmax(0, 1.72fr) minmax(300px, 0.9fr);
      align-items: start;
    }

    .rail {
      display: grid;
      gap: 16px;
      align-content: start;
      position: sticky;
      top: 168px;
    }

    .panel,
    .stat-card,
    .session-card {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: var(--radius-lg);
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0)),
        var(--panel);
      backdrop-filter: blur(18px);
      box-shadow: var(--shadow-md);
    }

    .panel::before,
    .stat-card::before,
    .session-card::before {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), transparent 22%);
      opacity: 0.5;
    }

    .panel {
      padding: 20px;
    }

    .panel-sessions {
      min-height: 520px;
    }

    .panel-rail {
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.03), rgba(255, 255, 255, 0)),
        var(--panel-soft);
    }

    .stat-card {
      min-height: 190px;
      padding: 20px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 12px;
    }

    .stat-card::after,
    .session-card::after {
      content: "";
      position: absolute;
      inset: auto -32px -42px auto;
      width: 180px;
      height: 180px;
      border-radius: 50%;
      pointer-events: none;
      opacity: 0.6;
      background: radial-gradient(circle, rgba(255, 255, 255, 0.14), transparent 72%);
    }

    .stat-card.tone-health::after {
      background: radial-gradient(circle, rgba(116, 239, 196, 0.24), transparent 72%);
    }

    .stat-card.tone-sessions::after {
      background: radial-gradient(circle, rgba(142, 211, 255, 0.22), transparent 72%);
    }

    .stat-card.tone-cycles::after {
      background: radial-gradient(circle, rgba(247, 194, 106, 0.22), transparent 72%);
    }

    .stat-card.tone-savings::after {
      background: radial-gradient(circle, rgba(122, 142, 255, 0.24), transparent 72%);
    }

    .stat-label,
    .section-label {
      color: var(--text-faint);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }

    .stat-value {
      margin-top: 6px;
      font-family: "JetBrains Mono", "Cascadia Code", monospace;
      font-size: clamp(28px, 3.6vw, 42px);
      line-height: 1.04;
      letter-spacing: -0.04em;
      max-width: 12ch;
      word-break: break-word;
    }

    .stat-meta {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      gap: 10px;
      color: var(--text-muted);
      font-size: 13.5px;
      line-height: 1.55;
    }

    .section-head {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 16px;
    }

    .section-head h2 {
      margin: 4px 0 0;
      font-family: "JetBrains Mono", "Cascadia Code", monospace;
      font-size: 24px;
      letter-spacing: -0.03em;
    }

    .section-head p {
      margin: 0;
      color: var(--text-muted);
      font-size: 14px;
    }

    .session-grid {
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
    }

    .session-card {
      padding: 18px;
      display: grid;
      gap: 16px;
      border-color: rgba(180, 212, 255, 0.14);
    }

    .session-card.is-healthy {
      box-shadow: var(--shadow-md), inset 0 0 0 1px rgba(116, 239, 196, 0.12);
    }

    .session-card.is-warning {
      box-shadow: var(--shadow-md), inset 0 0 0 1px rgba(247, 194, 106, 0.14);
    }

    .session-card.is-danger {
      box-shadow: var(--shadow-md), inset 0 0 0 1px rgba(255, 145, 122, 0.18);
    }

    .session-card.is-excluded {
      box-shadow: var(--shadow-md), inset 0 0 0 1px rgba(142, 211, 255, 0.12);
    }

    .session-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }

    .session-title {
      display: grid;
      gap: 10px;
      min-width: 0;
    }

    .session-title h3 {
      margin: 0;
      font-size: 17px;
      line-height: 1.45;
      word-break: break-all;
    }

    .session-id {
      font-size: 0.75rem;
      color: var(--text-muted);
      word-break: break-all;
      margin-top: 2px;
    }

    .session-group-header {
      grid-column: 1 / -1;
      font-size: 0.8rem;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      padding: 12px 4px 4px;
      border-bottom: 1px solid var(--border);
    }
    .session-group-header:first-child {
      padding-top: 0;
    }

    .session-actions {
      display: flex;
      justify-content: flex-end;
      align-items: flex-start;
      flex: 0 0 auto;
    }

    .session-stop {
      appearance: none;
      min-height: 36px;
      padding: 0 12px;
      border-radius: var(--radius-sm);
      border: 1px solid rgba(255, 145, 122, 0.24);
      background: rgba(255, 145, 122, 0.1);
      color: var(--bad);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      transition: 180ms ease;
    }

    .session-stop:hover {
      transform: translateY(-1px);
      background: rgba(255, 145, 122, 0.16);
    }

    .session-stop[disabled] {
      cursor: wait;
      opacity: 0.58;
      transform: none;
    }

    .badges {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      min-height: 30px;
      padding: 0 10px;
      border: 1px solid rgba(180, 212, 255, 0.12);
      border-radius: var(--radius-sm);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-muted);
      font-size: 12.5px;
      line-height: 1;
      white-space: nowrap;
      max-width: 100%;
    }

    .badge strong {
      color: var(--text);
      font-weight: 700;
    }

    .badge.good {
      color: var(--good);
      border-color: rgba(116, 239, 196, 0.22);
      background: rgba(116, 239, 196, 0.1);
    }

    .badge.warn {
      color: var(--warn);
      border-color: rgba(247, 194, 106, 0.22);
      background: rgba(247, 194, 106, 0.1);
    }

    .badge.bad {
      color: var(--bad);
      border-color: rgba(255, 145, 122, 0.24);
      background: rgba(255, 145, 122, 0.1);
    }

    .badge.info {
      color: var(--accent);
      border-color: rgba(142, 211, 255, 0.24);
      background: rgba(142, 211, 255, 0.1);
    }

    .session-kpis {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }

    .kpi {
      padding: 12px 14px;
      border: 1px solid rgba(180, 212, 255, 0.1);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.04);
    }

    .kpi .name {
      display: block;
      margin-bottom: 6px;
      color: var(--text-faint);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }

    .kpi .value {
      font-size: 16px;
      line-height: 1.45;
      color: var(--text);
      word-break: break-word;
    }

    .session-meta {
      display: grid;
      gap: 8px;
      padding-top: 2px;
      border-top: 1px dashed rgba(180, 212, 255, 0.14);
    }

    .meta-row {
      display: flex;
      justify-content: space-between;
      gap: 12px;
      font-size: 13.5px;
      line-height: 1.55;
    }

    .meta-row span:first-child {
      color: var(--text-faint);
    }

    .meta-row span:last-child {
      color: var(--text);
      text-align: right;
      word-break: break-word;
    }

    .mono {
      font-family: "JetBrains Mono", "Cascadia Code", monospace;
    }

    .item {
      position: relative;
      padding: 14px 16px 14px 18px;
      border: 1px solid rgba(180, 212, 255, 0.08);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.04);
    }

    .item::before {
      content: "";
      position: absolute;
      inset: 14px auto 14px 0;
      width: 3px;
      border-radius: 0 999px 999px 0;
      background: linear-gradient(180deg, var(--accent), transparent);
      opacity: 0.7;
    }

    .item strong {
      display: block;
      margin-bottom: 6px;
      color: var(--text);
      font-size: 14px;
      line-height: 1.5;
    }

    .item p {
      margin: 0;
      color: var(--text-muted);
      font-size: 13.5px;
      line-height: 1.65;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .empty {
      padding: 26px 20px;
      border: 1px dashed rgba(180, 212, 255, 0.16);
      border-radius: var(--radius-md);
      background: rgba(255, 255, 255, 0.025);
      color: var(--text-muted);
      text-align: center;
      line-height: 1.75;
    }

    .footer-note {
      margin-top: 2px;
      padding: 0 4px;
      color: var(--text-faint);
      font-size: 12.5px;
      line-height: 1.75;
    }

    @media (max-width: 1180px) {
      .stats-grid {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .content-grid {
        grid-template-columns: 1fr;
      }

      .rail {
        position: static;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }

    @media (max-width: 900px) {
      .hero-grid {
        grid-template-columns: 1fr;
      }

      .hero-copy,
      h1 {
        max-width: none;
      }

      .toolbar {
        align-items: flex-start;
      }

      .toolbar-filters {
        justify-content: flex-start;
      }
    }

    @media (max-width: 720px) {
      .shell {
        width: min(100vw - 18px, 1480px);
        padding-top: 10px;
      }

      .hero,
      .panel,
      .stat-card,
      .session-card {
        border-radius: 20px;
      }

      .hero {
        padding: 18px;
      }

      .hero-actions,
      .toolbar-filters {
        gap: 8px;
      }

      .control,
      .filter-chip,
      .session-stop {
        width: 100%;
        justify-content: center;
      }

      .stats-grid,
      .rail,
      .session-grid,
      .session-kpis {
        grid-template-columns: 1fr;
      }

      .meta-row {
        display: grid;
        gap: 3px;
      }

      .meta-row span:last-child {
        text-align: left;
      }

      .lang-switch {
        width: 100%;
      }
    }
`;

module.exports = {
  STATUS_PAGE_STYLE,
};
