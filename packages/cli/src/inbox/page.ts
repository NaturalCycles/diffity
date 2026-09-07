/**
 * The inbox page, served at `/`. Self-contained (no build step, no external requests): it polls
 * `/api/inbox` and renders the three groups, opening a prepared review in a new tab via `/open/:id`.
 */
export function inboxPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>diffity inbox</title>
<style>
  :root {
    --bg: #f6f7f9; --panel: #ffffff; --ink: #1c2024; --muted: #6b7280; --line: #e5e7eb;
    --accent: #2563eb; --ready: #16a34a; --stale: #d97706; --work: #6b7280; --bad: #dc2626;
    color-scheme: light;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #0f1216; --panel: #171b21; --ink: #e6e8eb; --muted: #9aa4b2; --line: #262c34;
      --accent: #5b9bff; --ready: #4ade80; --stale: #fbbf24; --work: #9aa4b2; --bad: #f87171;
      color-scheme: dark; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink);
    font: 14px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif; }
  header { display: flex; align-items: baseline; gap: 12px; padding: 20px 24px 8px; }
  .tools { margin-left: auto; display: flex; align-items: center; gap: 8px; }
  .bell { border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--ink);
    font: inherit; font-size: 12px; padding: 4px 10px; cursor: pointer; }
  .bell:hover { border-color: var(--accent); }
  .reload { border: 1px solid var(--line); border-radius: 999px; background: var(--panel); color: var(--ink);
    font: inherit; font-size: 15px; line-height: 1; width: 28px; height: 28px; cursor: pointer; }
  .reload:hover { border-color: var(--accent); }
  .reload:disabled { cursor: default; color: var(--muted); border-color: var(--line); }
  .reload.spinning { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .badge.alert { color: var(--bad); border: 1px solid var(--bad); }
  .settings { margin-top: 28px; border-top: 1px solid var(--line); padding-top: 14px; }
  .settings summary { cursor: pointer; color: var(--muted); font-size: 12.5px; }
  .settings label { display: block; margin-top: 12px; font-size: 12.5px; color: var(--muted); }
  .settings textarea { display: block; width: 100%; margin-top: 4px; font: inherit; font-size: 13px; color: var(--ink);
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; resize: vertical; }
  .settings-row { display: flex; align-items: center; gap: 12px; margin-top: 10px; }
  .settings-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px 16px; margin-top: 4px; }
  .settings-grid input, .settings-grid select { display: block; width: 100%; margin-top: 4px; font: inherit; font-size: 13px; color: var(--ink);
    background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
  .settings-grid input[type=checkbox] { display: inline; width: auto; margin-top: 0; }
  .settings-grid .check { display: flex; align-items: center; gap: 8px; align-self: end; margin-top: 12px; }
  .settings button { border: 1px solid var(--accent); border-radius: 8px; background: var(--accent); color: white;
    font: inherit; font-size: 12.5px; padding: 5px 12px; cursor: pointer; }
  h1 { font-size: 18px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 12.5px; }
  main { padding: 8px 24px 40px; max-width: 900px; }
  section { margin-top: 18px; }
  h2 { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
    margin: 0 0 8px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 12px; background: var(--panel);
    border: 1px solid var(--line); border-radius: 10px; padding: 11px 14px; margin-bottom: 8px; }
  .entry { display: flex; align-items: stretch; gap: 8px; margin-bottom: 8px; }
  .entry .row { flex: 1; min-width: 0; margin-bottom: 0; }
  .dismiss { flex: none; width: 38px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel);
    color: var(--muted); font-size: 16px; cursor: pointer; }
  .dismiss:hover { color: var(--bad); border-color: var(--bad); }
  .bump { flex: none; width: 38px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel);
    color: var(--muted); font-size: 16px; cursor: pointer; }
  .bump:hover { color: var(--accent); border-color: var(--accent); }
  .row.open { cursor: pointer; }
  .row.open:hover { border-color: var(--accent); }
  .size { font-variant-numeric: tabular-nums; color: var(--muted); font-size: 12px;
    min-width: 74px; text-align: right; white-space: nowrap; }
  .title { flex: 1; min-width: 0; }
  .title .name { font-weight: 600; }
  .title .repo { color: var(--muted); font-weight: 500; }
  .title .meta { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .badge { font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 999px; white-space: nowrap; }
  .badge.stale { color: var(--stale); border: 1px solid var(--stale); }
  .badge.work { color: var(--work); border: 1px solid var(--line); }
  .badge.bad { color: var(--bad); border: 1px solid var(--bad); }
  .open-hint { color: var(--accent); font-size: 12px; font-weight: 600; white-space: nowrap; }
  .empty { color: var(--muted); padding: 12px 2px; }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--ready); flex: none; }
  .foot { color: var(--muted); font-size: 11.5px; margin-top: 22px; }
  a { color: inherit; text-decoration: none; }
</style>
</head>
<body>
<header>
  <h1>diffity inbox</h1>
  <span class="sub" id="status">loading…</span>
  <span class="tools">
    <button class="bell" id="bell" type="button" hidden
      title="Announces a review the moment it turns prepared. What gets announced is in Settings, at the bottom of the page.">Turn on notifications</button>
    <button class="reload" id="reload" type="button" title="Poll GitHub now" aria-label="Poll GitHub now">&#x27F3;</button>
  </span>
</header>
<main>
  <section id="ready-section" hidden>
    <h2>Ready to review</h2>
    <div id="ready"></div>
  </section>
  <section id="working-section" hidden>
    <h2>Queue</h2>
    <div id="working"></div>
  </section>
  <section id="other-section" hidden>
    <h2>Other</h2>
    <div id="other"></div>
  </section>
  <section id="dismissed-section" hidden>
    <h2>Dismissed</h2>
    <div id="dismissed"></div>
  </section>
  <div id="all-empty" class="empty" hidden>Nothing waiting for your review right now.</div>
  <details class="settings" id="settings">
    <summary>Settings</summary>
    <label>Skip PRs if:
      <textarea id="filter" rows="3" placeholder="e.g. the change is payments-focused, or only touches translations"></textarea>
    </label>
    <label>Notify me if:
      <textarea id="alertWhen" rows="3" placeholder="e.g. there is a P1, or the change touches authentication (empty: every prepared review)"></textarea>
    </label>
    <label>MCP tools the review agent may use, one per line:
      <textarea id="agentMcpAllow" rows="3" placeholder="e.g. mcp__claude_ai_Atlassian__getJiraIssue (empty: no MCP servers at all)"></textarea>
    </label>
    <div class="settings-grid">
      <label>Max prepared at once<input id="maxPrepared" type="number" min="1" step="1"></label>
      <label>Poll every (minutes)<input id="pollMinutes" type="number" min="1" step="1"></label>
      <label>Preparation timeout (minutes)<input id="prepareTimeoutMinutes" type="number" min="1" step="1"></label>
      <label>Answer timeout (minutes)<input id="liveTimeoutMinutes" type="number" min="1" step="1"></label>
      <label>Model<input id="agentModel" type="text" placeholder="the agent's default"></label>
      <label>Effort<select id="agentEffort">
        <option value="">the agent&#39;s default</option>
        <option value="low">low</option>
        <option value="medium">medium</option>
        <option value="high">high</option>
        <option value="xhigh">xhigh</option>
        <option value="max">max</option>
      </select></label>
      <label>Budget per run ($)<input id="agentMaxBudgetUsd" type="number" min="0.5" step="0.5" placeholder="uncapped"></label>
      <label class="check"><input id="live" type="checkbox"> Park a live agent on opened reviews</label>
    </div>
    <div class="settings-row">
      <button id="save" type="button">Save</button>
      <span class="sub" id="settings-status"></span>
    </div>
  </details>
  <div class="foot" id="foot"></div>
</main>
<script>
  const el = id => document.getElementById(id);

  function sizeLabel(r) { return '+' + r.additions + ' \\u2212' + r.deletions; }

  function ago(iso) {
    const seconds = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (seconds < 90) return 'just now';
    const minutes = seconds / 60;
    if (minutes < 90) return Math.round(minutes) + ' min ago';
    const hours = minutes / 60;
    if (hours < 36) return Math.round(hours) + ' h ago';
    return Math.round(hours / 24) + ' d ago';
  }

  function metaLine(parts, hover) {
    const text = parts.filter(Boolean).join(' \\u00b7 ');
    // The line is cut to the card; the full text, wrapped, is a hover away.
    return text ? '<div class="meta"' + (hover ? ' title="' + esc(hover) + '"' : '') + '>' + text + '</div>' : '';
  }

  function times(r) {
    const parts = [];
    if (r.createdAt) parts.push('opened ' + ago(r.createdAt));
    if (r.updatedAt) parts.push('updated ' + ago(r.updatedAt));
    return parts.join(' \\u00b7 ');
  }

  function readyRow(r) {
    const row = document.createElement('a');
    row.className = 'row open';
    row.href = r.openUrl;
    row.target = '_blank';
    row.rel = 'noopener';
    row.innerHTML =
      '<span class="dot"></span>' +
      '<span class="size">' + sizeLabel(r) + '</span>' +
      '<span class="title"><div><span class="repo">' + esc(r.repo) + '#' + r.number + '</span> ' +
      '<span class="name">' + esc(r.title) + '</span></div>' +
      '<div class="meta">by ' + esc(r.author) + ' \\u00b7 ' + r.changedFiles + ' file(s)' + (r.summary ? ' \\u00b7 ' + esc(r.summary) : '') + (times(r) ? ' \\u00b7 ' + times(r) : '') + '</div></span>' +
      (r.alert ? '<span class="badge alert" title="' + esc(r.alert) + '">alert</span>' : '') +
      (r.stale ? '<span class="badge stale">stale</span>' : '') +
      '<span class="open-hint">open \\u2197</span>';
    return row;
  }

  function plainRow(r, badgeClass, badgeText) {
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML =
      '<span class="size">' + sizeLabel(r) + '</span>' +
      '<span class="title"><div><span class="repo">' + esc(r.repo) + '#' + r.number + '</span> ' +
      '<span class="name">' + esc(r.title) + '</span></div>' +
      metaLine([esc(r.statusReason || ''), times(r)], r.statusReason || '') + '</span>' +
      '<span class="badge ' + badgeClass + '">' + esc(badgeText) + '</span>';
    return row;
  }

  function withActions(row, r) {
    if (!r.dismissUrl && !r.prepareUrl) return row;
    const wrap = document.createElement('div');
    wrap.className = 'entry';
    wrap.append(row);
    if (r.prepareUrl) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'bump';
      up.title = 'Prepare this one next: ahead of the queue, past the limit, filter set aside';
      up.textContent = '\\u2191';
      up.onclick = () => bump(r);
      wrap.append(up);
    }
    if (r.dismissUrl) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'dismiss';
      button.title = 'Dismiss this version of the pull request; new commits bring it back';
      button.textContent = '\\u00d7';
      button.onclick = () => dismiss(r, wrap);
      wrap.append(button);
    }
    return wrap;
  }

  async function bump(r) {
    const res = await fetch(r.prepareUrl, { method: 'POST' });
    if (!res.ok) {
      el('status').textContent = 'could not bump ' + r.repo + '#' + r.number + ': ' + await res.text();
    }
    refresh();
  }

  async function dismiss(r, entry) {
    if (!confirm('Dismiss ' + r.repo + '#' + r.number + '? It comes back if the pull request gets new commits.')) return;
    entry.remove();
    const res = await fetch(r.dismissUrl, { method: 'POST' });
    if (!res.ok) {
      el('status').textContent = 'could not dismiss ' + r.repo + '#' + r.number + ': ' + await res.text();
    }
    refresh();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function fill(sectionId, listId, rows, make) {
    const box = el(listId);
    box.replaceChildren(...rows.map(make));
    el(sectionId).hidden = rows.length === 0;
  }

  // --- notifications: the set of prepared reviews seen at the last poll; a new one is announced.
  let known = null;
  let settings = { filter: '', alertWhen: '' };

  function canNotify() {
    return 'Notification' in window && Notification.permission === 'granted';
  }

  function announce(view) {
    const current = new Map(view.ready.map(r => [r.id + '@' + (r.preparedAt || ''), r]));
    if (known !== null && canNotify()) {
      for (const [key, r] of current) {
        if (known.has(key)) continue;
        // With words on what matters, only what the agent flagged is worth interrupting for.
        if (settings.alertWhen.trim() && !r.alert) continue;
        const body = [r.title, r.summary, r.alert].filter(Boolean).join('\\n');
        const n = new Notification(r.repo + '#' + r.number + ' is ready to review', { body, tag: r.id });
        n.onclick = () => { window.open(r.openUrl, '_blank'); n.close(); };
      }
    }
    known = new Set(current.keys());
  }

  function showBell() {
    const bell = el('bell');
    bell.hidden = !('Notification' in window) || Notification.permission !== 'default';
    bell.onclick = async () => {
      const granted = await Notification.requestPermission() === 'granted';
      showBell();
      // The next poll writes over this line, which is as long as the note needs to stay.
      el('foot').textContent = granted
        ? 'Notifications on \\u00b7 what gets announced is in Settings, at the bottom of the page'
        : 'Notifications stay off \\u00b7 allow them in the browser to turn them on';
    };
  }

  function showReload(ticking) {
    const button = el('reload');
    button.disabled = ticking;
    button.classList.toggle('spinning', ticking);
    button.title = ticking ? 'Polling GitHub\\u2026' : 'Poll GitHub now';
  }

  async function pollNow() {
    showReload(true);
    const res = await fetch('/api/tick', { method: 'POST' });
    if (!res.ok) {
      el('status').textContent = 'could not start a poll: ' + await res.text();
    }
    refresh();
  }

  async function loadSettings() {
    try {
      const res = await fetch('/api/settings', { cache: 'no-store' });
      if (!res.ok) return;
      settings = await res.json();
      el('filter').value = settings.filter;
      el('alertWhen').value = settings.alertWhen;
      for (const key of ['maxPrepared', 'pollMinutes', 'prepareTimeoutMinutes', 'liveTimeoutMinutes']) el(key).value = settings[key];
      el('live').checked = settings.live;
      const agent = settings.agent || {};
      el('agentModel').value = agent.model || '';
      el('agentEffort').value = agent.effort || '';
      el('agentMcpAllow').value = (agent.mcpAllow || []).join('\\n');
      el('agentMaxBudgetUsd').value = agent.maxBudgetUsd == null ? '' : agent.maxBudgetUsd;
    } catch (err) {
      el('settings-status').textContent = 'settings could not be loaded';
    }
  }

  async function saveSettings() {
    const budget = el('agentMaxBudgetUsd').value.trim();
    const next = {
      filter: el('filter').value,
      alertWhen: el('alertWhen').value,
      maxPrepared: Number(el('maxPrepared').value),
      pollMinutes: Number(el('pollMinutes').value),
      prepareTimeoutMinutes: Number(el('prepareTimeoutMinutes').value),
      liveTimeoutMinutes: Number(el('liveTimeoutMinutes').value),
      live: el('live').checked,
      agent: {
        model: el('agentModel').value.trim() || null,
        effort: el('agentEffort').value || null,
        mcpAllow: el('agentMcpAllow').value.split('\\n').map(line => line.trim()).filter(Boolean),
        // Not editable here; sent back as it came so a save does not drop it.
        extraArgs: (settings.agent && settings.agent.extraArgs) || [],
        maxBudgetUsd: budget === '' ? null : Number(budget),
      },
    };
    const res = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(next) });
    if (!res.ok) {
      el('settings-status').textContent = 'not saved: ' + await res.text();
      return;
    }
    settings = next;
    el('settings-status').textContent = 'saved \\u00b7 in effect from the next poll and preparation';
  }

  async function refresh() {
    try {
      const res = await fetch('/api/inbox', { cache: 'no-store' });
      const view = await res.json();
      announce(view);
      fill('ready-section', 'ready', view.ready, r => withActions(readyRow(r), r));
      fill('working-section', 'working', view.working, r => withActions(plainRow(r, 'work', r.bumped ? 'bumped' : r.status), r));
      fill('other-section', 'other', view.other, r => {
        const bad = r.status === 'failed';
        return withActions(plainRow(r, bad ? 'bad' : 'work', r.status), r);
      });
      fill('dismissed-section', 'dismissed', view.dismissed, r => withActions(plainRow(r, 'work', 'dismissed'), r));
      const total = view.ready.length + view.working.length + view.other.length + view.dismissed.length;
      el('all-empty').hidden = total > 0;
      el('status').textContent = view.ready.length + ' ready \\u00b7 ' + view.working.length + ' queued';
      showReload(view.ticking === true);
      el('foot').textContent = 'Updated ' + new Date().toLocaleTimeString() + (view.lastPollAt ? ' \\u00b7 last poll ' + ago(view.lastPollAt) : '');
    } catch (err) {
      el('status').textContent = 'the inbox daemon is not responding';
    }
  }

  el('save').onclick = saveSettings;
  el('reload').onclick = pollNow;
  showBell();
  loadSettings();
  refresh();
  setInterval(refresh, 4000);
</script>
</body>
</html>`;
}
