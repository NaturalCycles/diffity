import { describe, it, expect } from 'vitest';
import { inboxPage } from '../src/inbox/page.js';

/** The page's own script, as the browser would parse it. */
function pageScript(): string {
  const html = inboxPage();
  const open = html.indexOf('<script>');
  const close = html.indexOf('</script>', open);
  expect(open).toBeGreaterThan(-1);
  expect(close).toBeGreaterThan(open);
  return html.slice(open + '<script>'.length, close);
}

describe('the inbox page', () => {
  it('has script the browser can parse', () => {
    // The page is a string template with no build step, so a stray escape would only show up in
    // the browser; parsing it here is the check that never runs it.
    expect(() => new Function(pageScript())).not.toThrow();
  });

  it('has a settings field for each agent setting the daemon accepts', () => {
    const html = inboxPage();
    for (const id of ['agentModel', 'agentEffort', 'agentMcpAllow', 'agentMaxBudgetUsd']) {
      expect(html).toContain(`id="${id}"`);
    }
    for (const effort of ['low', 'medium', 'high', 'xhigh', 'max']) {
      expect(html).toContain(`<option value="${effort}">`);
    }
    // The daemon refuses a budget of 0, so the field must not let the browser submit one.
    expect(html).toContain('id="agentMaxBudgetUsd" type="number" min="0.5"');
  });

  it('has a settings field for each validate setting, and sends the block back', () => {
    const html = inboxPage();
    for (const id of ['validateModel', 'validateTimeoutMinutes', 'validateMaxBudgetUsd']) {
      expect(html).toContain(`id="${id}"`);
    }
    // The pass is off until a model is named, which is what the field's placeholder says.
    expect(html).toContain('id="validateModel" type="text" placeholder="off"');
    expect(html).toContain('id="validateMaxBudgetUsd" type="number" min="0.5"');
    const script = pageScript();
    expect(script).toContain("model: el('validateModel').value.trim() || null");
    expect(script).toContain("timeoutMinutes: Number(el('validateTimeoutMinutes').value)");
    expect(script).toContain("maxBudgetUsd: checkBudget === '' ? null : Number(checkBudget)");
  });

  it('shows what a prepared review spent, the totals, and the pause', () => {
    const script = pageScript();
    expect(script).toContain("Math.round(r.spend.minutes) + ' min");
    expect(script).toContain("'agent runs today: '");
    expect(script).toContain("'preparing paused until '");
    // The cost hangs off the meta line, which is the part that gives: a long one cannot widen the card.
    expect(script).toContain("r.spend ? r.spend.detail : ''");
    expect(inboxPage()).toContain('.title .meta { color: var(--muted); font-size: 12px; min-width: 0;');
  });

  it('marks each card with what CI said, and keeps the card\'s width its own', () => {
    const script = pageScript();
    expect(script).toContain("'<span class=\"ci ci-' + r.ciState");
    for (const label of ['CI passing', 'CI failing', 'CI running']) {
      expect(script).toContain(label);
    }
    // A row with nothing reported gets no dot at all, and the glyph itself cannot stretch a card.
    expect(script).toContain('ciDot(r) +');
    expect(inboxPage()).toContain('.ci { flex: none;');
  });

  it('has a settings field for the CI hold and the alert paths, and sends both back', () => {
    const html = inboxPage();
    expect(html).toContain('id="waitForCi" type="checkbox"');
    expect(html).toContain('Hold a pull request until its CI has passed');
    expect(html).toContain('id="alertPaths"');
    expect(html).toContain('Alert me if a changed file matches (one glob per line)');
    const script = pageScript();
    expect(script).toContain("alertPaths: el('alertPaths').value.split('\\n')");
    expect(script).toContain("waitForCi: el('waitForCi').checked");
  });

  it('has a settings field for the title patterns, sends them back as lines, and says what the filter costs', () => {
    const html = inboxPage();
    expect(html).toContain('id="skipTitles"');
    expect(html).toContain('Skip pull requests whose title matches (one regular expression per line)');
    // The placeholder has to reach the browser with its backslashes intact.
    expect(html).toContain('placeholder="e.g. \\(payments\\)  or  Release$"');
    // The division between the two ways to skip: one is free, the other is an agent run per skip.
    expect(html).toContain('spends a run on every pull request it skips');
    const script = pageScript();
    expect(script).toContain("skipTitles: el('skipTitles').value.split('\\n')");
    expect(script).toContain("el('skipTitles').value = (settings.skipTitles || []).join('\\n')");
  });

  it('names the prepared cap for what it does, leaving bumps out of it', () => {
    expect(inboxPage()).toContain('Auto-prepare from queue<input id="maxPrepared"');
  });

  it('sends the agent block back with the settings, empty fields as null', () => {
    const script = pageScript();
    expect(script).toContain("model: el('agentModel').value.trim() || null");
    expect(script).toContain("effort: el('agentEffort').value || null");
    expect(script).toContain("mcpAllow: el('agentMcpAllow').value.split('\\n')");
    expect(script).toContain("maxBudgetUsd: budget === '' ? null : Number(budget)");
    // extraArgs is not editable here, so it has to travel back untouched.
    expect(script).toContain("extraArgs: (settings.agent && settings.agent.extraArgs) || []");
  });
});
