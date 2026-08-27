import { describe, it, expect } from 'vitest';
import { shouldShutDown, AFTER_VIEWER_LEFT_MS, NEVER_OPENED_MS } from '../src/idle-shutdown.js';
import type { IdleFacts } from '../src/idle-shutdown.js';

const facts = (over: Partial<IdleFacts> = {}): IdleFacts => ({
  viewerGone: false,
  everSeen: false,
  idleForMs: 0,
  listeners: 0,
  reviewInProgress: false,
  ...over,
});

describe('a reader who closed the page', () => {
  it('is given time to come back, because reopening from history is normal', () => {
    expect(shouldShutDown(facts({ everSeen: true, viewerGone: true, idleForMs: AFTER_VIEWER_LEFT_MS - 1 }))).toBe(false);
  });

  it('is taken at their word once that time is up', () => {
    expect(shouldShutDown(facts({ everSeen: true, viewerGone: true, idleForMs: AFTER_VIEWER_LEFT_MS }))).toBe(true);
  });
});

describe('a server nobody has opened', () => {
  // Every review an agent prepares starts this way, and the reader may be minutes or hours behind.
  it('waits far longer, since this is how every prepared review begins', () => {
    expect(shouldShutDown(facts({ idleForMs: AFTER_VIEWER_LEFT_MS * 2 }))).toBe(false);
    expect(shouldShutDown(facts({ idleForMs: NEVER_OPENED_MS - 1 }))).toBe(false);
  });

  it('gives up eventually', () => {
    expect(shouldShutDown(facts({ idleForMs: NEVER_OPENED_MS }))).toBe(true);
  });
});

describe('somebody who means to come back', () => {
  it('keeps the server up while an agent is parked', () => {
    expect(shouldShutDown(facts({ everSeen: true, viewerGone: true, idleForMs: AFTER_VIEWER_LEFT_MS, listeners: 1 }))).toBe(false);
  });

  // The findings are not on the page yet, so closing the tab is not the reader being finished.
  it('keeps it up while a review is unfinished', () => {
    expect(shouldShutDown(facts({ everSeen: true, viewerGone: true, idleForMs: AFTER_VIEWER_LEFT_MS, reviewInProgress: true }))).toBe(false);
    expect(shouldShutDown(facts({ idleForMs: NEVER_OPENED_MS, reviewInProgress: true }))).toBe(false);
  });
});

describe('a page that is open right now', () => {
  it('is never a reason to shut down, however long it has been quiet', () => {
    expect(shouldShutDown(facts({ everSeen: true, viewerGone: false, idleForMs: NEVER_OPENED_MS * 10 }))).toBe(false);
  });
});
