import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { render, cleanup, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { parseDiff } from '@diffity/parser';
import type {
  CommentThread,
  DiffResponse,
  LiveStatusResponse,
  RepoInfoResponse,
  Tour,
} from '@diffity/api';

// Shiki loads a wasm highlighter in an effect; the page renders plain tokens while it is null,
// which is the state this smoke test pins anyway.
vi.mock('../src/hooks/use-highlighter', () => ({
  useHighlighter: () => ({ highlight: () => null }),
}));

import { DiffPage } from '../src/components/diff/diff-page';

const RAW_DIFF = `diff --git a/src/greeter.ts b/src/greeter.ts
index 1111111..2222222 100644
--- a/src/greeter.ts
+++ b/src/greeter.ts
@@ -1,3 +1,3 @@
 export function greet() {
-  return 'hello';
+  return 'hello, reviewer';
 }
`;

const info: RepoInfoResponse = {
  name: 'repo',
  branch: 'main',
  root: '/tmp/repo',
  description: 'Unstaged changes',
  capabilities: { reviews: true, revert: false, staleness: false },
  sessionId: 's1',
  review: null,
  github: null,
  editor: null,
};

const diff: DiffResponse = { ...parseDiff(RAW_DIFF), suppressed: null };

const liveStatus: LiveStatusResponse = {
  enabled: false,
  listening: false,
  working: false,
  waiting: 0,
  mayChangeCode: false,
  viewerPresent: true,
};

const threads: CommentThread[] = [{
  id: 't1',
  sessionId: 's1',
  filePath: 'src/greeter.ts',
  side: 'new',
  startLine: 2,
  endLine: 2,
  status: 'open',
  anchorContent: null,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  submittedAt: null,
  submittedReviewUrl: null,
  submittedBody: null,
  submittedHeadSha: null,
  githubCommentId: null,
  comments: [{
    id: 'c1',
    author: { name: 'Agent', type: 'agent' },
    body: 'P2: greet the reviewer by name',
    kind: 'review',
    createdAt: new Date().toISOString(),
    liveRequestedAt: null,
    liveIntent: null,
    liveClaimedAt: null,
    liveAnsweredAt: null,
  }],
}];

const tours: Tour[] = [];

/** One answer per route, so a page whose wiring breaks names the surface that stopped asking. */
function stubbedFetch(input: RequestInfo | URL): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const { pathname } = new URL(url, 'http://localhost');

  const answers: Record<string, unknown> = {
    '/api/info': info,
    '/api/diff': diff,
    '/api/threads': threads,
    '/api/live/status': liveStatus,
    '/api/tours': tours,
    '/api/viewer': { ok: true },
  };
  const body = pathname in answers ? answers[pathname] : {};
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
}

// jsdom lays nothing out: every element is 0×0, so the virtualized file list would see a
// 0-height viewport and render no files at all. A fixed 800px world is enough for every surface
// asserted here — @tanstack/virtual-core reads offsetWidth/offsetHeight, hence the properties.
class InertResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

let queryClient: QueryClient;

beforeAll(() => {
  vi.stubGlobal('fetch', stubbedFetch);
  vi.stubGlobal('ResizeObserver', InertResizeObserver);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 800 });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 1200, height: 800, top: 0, left: 0, bottom: 800, right: 1200, x: 0, y: 0,
    toJSON: () => ({}),
  } as DOMRect);
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLElement.prototype as { offsetHeight?: unknown }).offsetHeight;
  delete (HTMLElement.prototype as { offsetWidth?: unknown }).offsetWidth;
});

afterEach(() => {
  cleanup();
  queryClient?.clear();
});

function mountDiffPage() {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createMemoryRouter(
    [{
      path: '/diff',
      loader: () => ({ ref: 'work', theme: 'light', view: 'unified' }),
      Component: DiffPage,
    }],
    { initialEntries: ['/diff'] },
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

// The page orchestrates threads, live status, tours, presence and the diff itself; a wiring
// mistake in any of them is exactly what a stubbed-fetch mount catches.
describe('the diff page, mounted whole', () => {
  it('renders every main surface from one stubbed fetch', async () => {
    mountDiffPage();

    // Asserted on the page's text as one retried block: the queries land in no fixed order, the
    // sidebar renders paths as directory + name, and word-diff splits a changed line into token
    // spans no single-node matcher can see.
    await waitFor(() => {
      const text = document.body.textContent ?? '';
      expect(text).toContain('greeter.ts');
      expect(text).toContain('hello, reviewer');
      expect(text).toContain('General comments');
      expect(text).toContain('P2: greet the reviewer by name');
    }, { timeout: 4000 });

    // The toolbar's view switch.
    expect(screen.getByRole('button', { name: 'Unified' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Split' })).toBeTruthy();
  });

  it('says when the working tree has nothing to show', async () => {
    const empty: DiffResponse = { ...parseDiff(''), suppressed: null };
    vi.stubGlobal('fetch', (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, 'http://localhost').pathname === '/api/diff') {
        return Promise.resolve(new Response(JSON.stringify(empty), { status: 200 }));
      }
      return stubbedFetch(input);
    });
    try {
      mountDiffPage();

      await screen.findByText(/no changes|nothing to/i, undefined, { timeout: 4000 });
    } finally {
      vi.stubGlobal('fetch', stubbedFetch);
    }
  });
});
