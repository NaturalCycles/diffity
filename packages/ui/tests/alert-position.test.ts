import { describe, it, expect } from 'vitest';
import { positionForAlert } from '../src/lib/answer-alerts';

const order = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];

describe('which edge a note about an off-screen answer belongs on', () => {
  it('trusts the measurement when the thread is rendered', () => {
    expect(positionForAlert('d.ts', 'a.ts', order, 'above')).toBe('above');
    expect(positionForAlert('a.ts', 'd.ts', order, 'below')).toBe('below');
  });

  // A thread far from the reader is not rendered at all, and null used to fall through to "below" —
  // which is how a note about a thread above ended up in the bottom corner.
  it('falls back to file order when the thread is not rendered', () => {
    expect(positionForAlert('a.ts', 'c.ts', order, null)).toBe('above');
    expect(positionForAlert('d.ts', 'b.ts', order, null)).toBe('below');
  });

  it('treats the same file as ahead, since the thread is further down it', () => {
    expect(positionForAlert('b.ts', 'b.ts', order, null)).toBe('below');
  });

  it('says below when it cannot tell', () => {
    expect(positionForAlert('unknown.ts', 'b.ts', order, null)).toBe('below');
    expect(positionForAlert('a.ts', null, order, null)).toBe('below');
  });
});
