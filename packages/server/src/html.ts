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
  button { font: inherit; padding: 6px 12px; cursor: pointer; }
  form.inline { display: inline; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  pre { padding: 8px; border: 1px solid var(--line); overflow-x: auto; }
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
