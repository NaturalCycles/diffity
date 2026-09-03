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
  h1 { font-size: 18px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  .sub { color: var(--muted); font-size: 12.5px; }
  main { padding: 8px 24px 40px; max-width: 900px; }
  section { margin-top: 18px; }
  h2 { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted);
    margin: 0 0 8px; font-weight: 600; }
  .row { display: flex; align-items: center; gap: 12px; background: var(--panel);
    border: 1px solid var(--line); border-radius: 10px; padding: 11px 14px; margin-bottom: 8px; }
  .entry { display: flex; align-items: stretch; gap: 8px; margin-bottom: 8px; }
  .entry .row { flex: 1; margin-bottom: 0; }
  .dismiss { flex: none; width: 38px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel);
    color: var(--muted); font-size: 16px; cursor: pointer; }
  .dismiss:hover { color: var(--bad); border-color: var(--bad); }
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
  <div id="all-empty" class="empty" hidden>Nothing waiting for your review right now.</div>
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
      '<div class="meta">by ' + esc(r.author) + ' \\u00b7 ' + r.changedFiles + ' file(s)' + (times(r) ? ' \\u00b7 ' + times(r) : '') + '</div></span>' +
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
      '<div class="meta">' + [esc(r.statusReason || ''), times(r)].filter(Boolean).join(' \\u00b7 ') + '</div></span>' +
      '<span class="badge ' + badgeClass + '">' + esc(badgeText) + '</span>';
    return row;
  }

  function withDismiss(row, r) {
    if (!r.dismissUrl) return row;
    const wrap = document.createElement('div');
    wrap.className = 'entry';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dismiss';
    button.title = 'Dismiss this version of the pull request; new commits bring it back';
    button.textContent = '\\u00d7';
    button.onclick = () => dismiss(r, wrap);
    wrap.append(row, button);
    return wrap;
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

  async function refresh() {
    try {
      const res = await fetch('/api/inbox', { cache: 'no-store' });
      const view = await res.json();
      fill('ready-section', 'ready', view.ready, r => withDismiss(readyRow(r), r));
      fill('working-section', 'working', view.working, r => withDismiss(plainRow(r, 'work', r.status), r));
      fill('other-section', 'other', view.other, r => {
        const bad = r.status === 'failed';
        return withDismiss(plainRow(r, bad ? 'bad' : 'work', r.status), r);
      });
      const total = view.ready.length + view.working.length + view.other.length;
      el('all-empty').hidden = total > 0;
      el('status').textContent = view.ready.length + ' ready \\u00b7 ' + view.working.length + ' queued';
      el('foot').textContent = 'Updated ' + new Date().toLocaleTimeString();
    } catch (err) {
      el('status').textContent = 'the inbox daemon is not responding';
    }
  }

  refresh();
  setInterval(refresh, 4000);
</script>
</body>
</html>`;
}
