import { describe, it, expect } from 'vitest';
import { normaliseIntent, directiveFor } from '../src/live-intent.js';

describe('what the reader asked for', () => {
  it('takes an explicit intent', () => {
    expect(normaliseIntent('act')).toBe('act');
    expect(normaliseIntent('ask')).toBe('ask');
  });

  // Least privilege: a request that does not say what it wants gets an answer, not an edit. That
  // covers rows written before intent existed as well as anything malformed.
  it('answers rather than acts when it does not say', () => {
    expect(normaliseIntent(undefined)).toBe('ask');
    expect(normaliseIntent(null)).toBe('ask');
    expect(normaliseIntent('anything else')).toBe('ask');
  });
});

describe('what the agent is told to do with it', () => {
  it('forbids changing code for a question, in as many words', () => {
    const directive = directiveFor('ask', true);

    expect(directive).toContain('Do not change code');
  });

  it('allows a change when one was asked for and is permitted', () => {
    const directive = directiveFor('act', true);

    expect(directive).toContain('make the change');
    expect(directive).not.toContain('Do not change code');
  });

  // Asking for a change on somebody else's pull request is still not permission to make one.
  it('refuses a change on a pull request the reader did not write', () => {
    const directive = directiveFor('act', false);

    expect(directive).toContain('Do not change code');
    expect(directive).toContain('somebody else');
  });

  it('says the same about a question either way', () => {
    expect(directiveFor('ask', false)).toContain('Do not change code');
  });
});
