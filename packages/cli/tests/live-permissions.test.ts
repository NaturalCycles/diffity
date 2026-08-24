import { describe, it, expect } from 'vitest';
import { mayChangeCode } from '../src/live-permissions.js';

describe('whether a request may be acted on', () => {
  // Reviewing is not editing. A pull request somebody else wrote can be asked about and its
  // comments rewritten, never its code — however the conversation goes.
  it('says no on a pull request written by somebody else', () => {
    expect(mayChangeCode({ viewerDidAuthor: false })).toBe(false);
  });

  it('says yes on one you wrote', () => {
    expect(mayChangeCode({ viewerDidAuthor: true })).toBe(true);
  });

  // No pull request means your own working tree, which is what changes exist for.
  it('says yes when there is no pull request at all', () => {
    expect(mayChangeCode(null)).toBe(true);
  });

  // An unknown author is not a yes. The forge not telling us is not permission.
  it('says no when the forge did not say who wrote it', () => {
    expect(mayChangeCode({})).toBe(false);
  });
});
