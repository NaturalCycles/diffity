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
