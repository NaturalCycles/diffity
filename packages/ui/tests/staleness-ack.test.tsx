import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDiffStaleness } from '../src/hooks/use-diff-staleness';
import * as api from '../src/lib/api';

describe('bringing one file up to date', () => {
  beforeEach(() => vi.restoreAllMocks());
  afterEach(() => vi.restoreAllMocks());

  it('stops reporting that file while still reporting the others', async () => {
    const responses = [
      { fingerprint: 'one', files: { 'a.ts': '2 +-', 'b.ts': '2 +-' } },
      { fingerprint: 'two', files: { 'a.ts': '9 +++', 'b.ts': '9 +++' } },
    ];
    let call = 0;
    vi.spyOn(api, 'fetchDiffFingerprint').mockImplementation(async () =>
      responses[Math.min(call++, responses.length - 1)],
    );

    const { result } = renderHook(() => useDiffStaleness('main', true, 20));

    await waitFor(() => expect(result.current.staleFiles).toEqual(['a.ts', 'b.ts']));

    act(() => result.current.acknowledgeFile('a.ts'));

    expect(result.current.staleFiles).toEqual(['b.ts']);
    expect(result.current.isStale).toBe(true);
  });

  it('is no longer stale once the last one is dealt with', async () => {
    const responses = [
      { fingerprint: 'one', files: { 'a.ts': '2 +-' } },
      { fingerprint: 'two', files: { 'a.ts': '9 +++' } },
    ];
    let call = 0;
    vi.spyOn(api, 'fetchDiffFingerprint').mockImplementation(async () =>
      responses[Math.min(call++, responses.length - 1)],
    );

    const { result } = renderHook(() => useDiffStaleness('main', true, 20));
    await waitFor(() => expect(result.current.staleFiles).toEqual(['a.ts']));

    act(() => result.current.acknowledgeFile('a.ts'));

    expect(result.current.isStale).toBe(false);
  });
});
