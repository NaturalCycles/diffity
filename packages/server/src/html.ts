export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const STYLE = `
  :root { color-scheme: light dark; --fg: #1f2328; --muted: #59636e; --bg: #fff; --line: #d1d9e0; --accent: #0969da; }
  @media (prefers-color-scheme: dark) { :root { --fg: #e6edf3; --muted: #9198a1; --bg: #0d1117; --line: #3d444d; --accent: #4493f8; } }
  body { font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: var(--fg); background: var(--bg); margin: 0; }
  header { display: flex; gap: 16px; align-items: center; padding: 10px 16px; border-bottom: 1px solid var(--line); }
  header .spacer { flex: 1; }
  main { max-width: 880px; margin: 24px auto; padding: 0 16px; }
  a { color: var(--accent); }
  .muted { color: var(--muted); }
  .error { color: #cf222e; }
  table { border-collapse: collapse; width: 100%; }
  td, th { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  input[type=email], input[type=password], input[type=text] { font: inherit; padding: 6px 8px; min-width: 280px; }
  textarea { font: inherit; padding: 6px 8px; max-width: 100%; }
  button { font: inherit; padding: 6px 12px; cursor: pointer; }
  form.inline { display: inline; }
  summary { cursor: pointer; }
  summary > h2 { display: inline-block; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  pre { padding: 8px; border: 1px solid var(--line); overflow-x: auto; }
  .badge { display: inline-block; padding: 0 7px; border: 1px solid var(--line); border-radius: 2em; font-size: 12px; font-weight: 500; line-height: 18px; color: var(--muted); white-space: nowrap; }
  .status { display: flex; gap: 8px; align-items: center; }
  .reload { display: inline-flex; padding: 4px; color: var(--muted); background: none; border: 1px solid var(--line); border-radius: 6px; }
  .reload svg { width: 16px; height: 16px; }
  .reload[aria-busy=true] svg { animation: spin 1s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .reload[aria-busy=true] svg { animation: none; } }
`;

/**
 * Keeps each collapsible section of a page open or closed as the user last left it. `applySections`
 * is global so a script that swaps in new sections can restore their state before showing them.
 */
export const SECTIONS_SCRIPT = `function applySections(root) {
  for (const details of root.querySelectorAll('details[data-section]')) {
    try {
      if (localStorage.getItem('diffity.section:' + details.dataset.section) === 'closed') details.open = false;
    } catch {}
  }
}
applySections(document);
// toggle does not bubble, so one capturing listener covers every section, including ones swapped in later.
document.addEventListener('toggle', event => {
  const details = event.target;
  if (!(details instanceof HTMLDetailsElement) || !details.dataset.section) return;
  try { localStorage.setItem('diffity.section:' + details.dataset.section, details.open ? 'open' : 'closed'); } catch {}
}, true);
`;

/** Also runs in the browser, inside SESSIONS_SCRIPT, so it stays free of anything outside itself. */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  return `${Math.floor(seconds / 3600)} h ago`;
}

const RELOAD_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true" fill="currentColor"><path d="M8 2.5a5.5 5.5 0 0 0-5.3 4H1.2A7 7 0 0 1 13 3.1V1.5a.75.75 0 0 1 1.5 0v4a.75.75 0 0 1-.75.75h-4a.75.75 0 0 1 0-1.5h2.1A5.5 5.5 0 0 0 8 2.5Zm-6.5 8.25a.75.75 0 0 1 .75-.75h4a.75.75 0 0 1 0 1.5H4.2A5.5 5.5 0 0 0 13.3 9.5h1.5A7 7 0 0 1 3 12.9v1.6a.75.75 0 0 1-1.5 0Z"/></svg>`;

/** The line above the sessions page's sections: how old its GitHub data is, and a button to ask again. */
export function sessionsStatus(fetchedAt: number, now: number): string {
  return `<p class="status"><span class="muted" id="sessions-age">Updated ${formatAge(now - fetchedAt)}</span>`
    + '<span class="error" id="sessions-error" hidden>Update failed · retrying</span>'
    + `<button type="button" class="reload" id="sessions-reload" title="Reload" aria-label="Reload">${RELOAD_ICON}</button></p>`;
}

/**
 * Keeps the sessions page current without reloading it: swaps in `/sessions/body` every minute while the tab
 * is visible, and from GitHub rather than the server's cache when the reload button asks. Needs SECTIONS_SCRIPT.
 */
export const SESSIONS_SCRIPT = `(() => {
  const AUTO_MS = 60000;
  const container = document.getElementById('sessions');
  const age = document.getElementById('sessions-age');
  const error = document.getElementById('sessions-error');
  const reload = document.getElementById('sessions-reload');
  if (!container || !age || !error || !reload) return;
  let loadedAt = Date.now();
  let inFlight = false;
  let failed = false;

  const formatAge = ${formatAge.toString()};
  const tick = () => {
    const fetchedAt = Date.parse(container.dataset.fetchedAt || '');
    if (!Number.isNaN(fetchedAt)) age.textContent = 'Updated ' + formatAge(Date.now() - fetchedAt);
  };

  const refresh = async fresh => {
    if (inFlight) return;
    inFlight = true;
    reload.setAttribute('aria-busy', 'true');
    try {
      const res = await fetch('/sessions/body' + (fresh ? '?fresh=1' : ''), { credentials: 'same-origin', cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const template = document.createElement('template');
      template.innerHTML = await res.text();
      applySections(template.content);
      container.replaceChildren(template.content);
      const fetchedAt = res.headers.get('X-Fetched-At');
      if (fetchedAt) container.dataset.fetchedAt = fetchedAt;
      loadedAt = Date.now();
      failed = false;
    } catch {
      failed = true;
    } finally {
      inFlight = false;
      reload.removeAttribute('aria-busy');
      error.hidden = !failed;
      tick();
    }
  };

  const due = () => failed || Date.now() - loadedAt >= AUTO_MS;
  reload.addEventListener('click', () => refresh(true));
  setInterval(() => {
    tick();
    if (document.visibilityState === 'visible' && due()) refresh(false);
  }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && due()) refresh(false);
  });
})();
`;

export function page(input: { title: string; body: string; user?: { email: string } | null }): string {
  const nav = input.user
    ? `<a href="/">Sessions</a><a href="/settings">Settings</a><span class="spacer"></span>
       <span class="muted">${escapeHtml(input.user.email)}</span>
       <form class="inline" method="post" action="/logout"><button type="submit">Sign out</button></form>`
    : '<span class="spacer"></span>';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(input.title)} · diffity</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<style>${STYLE}</style>
</head>
<body>
<header><strong>diffity</strong>${nav}</header>
<main>${input.body}</main>
</body>
</html>`;
}
