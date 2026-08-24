import { describe, it, expect } from 'vitest';
import { whereIsThread } from '../src/lib/thread-visibility';

describe('where a thread is relative to the reader', () => {
  const viewport = { top: 100, bottom: 700 };

  it('is on screen when it is inside the viewport', () => {
    expect(whereIsThread({ top: 300, bottom: 380 }, viewport)).toBe('on-screen');
  });

  it('is above when it has scrolled off the top', () => {
    expect(whereIsThread({ top: -200, bottom: -120 }, viewport)).toBe('above');
  });

  it('is below when it has not been reached', () => {
    expect(whereIsThread({ top: 900, bottom: 980 }, viewport)).toBe('below');
  });

  // Partly visible is visible: the reader can see the reply, so a bubble about it is noise.
  it('counts a partly visible thread as on screen', () => {
    expect(whereIsThread({ top: 60, bottom: 140 }, viewport)).toBe('on-screen');
    expect(whereIsThread({ top: 660, bottom: 760 }, viewport)).toBe('on-screen');
  });

  it('has nothing to say about a thread that is not rendered', () => {
    expect(whereIsThread(null, viewport)).toBeNull();
  });
});
