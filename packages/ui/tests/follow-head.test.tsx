import type { ReactNode } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { act, render, cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { useFollowHead } from '../src/hooks/use-follow-head';
import { useRequestReview } from '../src/hooks/use-info';
import { repoInfoOptions } from '../src/queries/info';
import { MovedOnBanner } from '../src/components/layout/moved-on-banner';
import { GitHubDialog } from '../src/components/layout/github-dialog';
import { navigation, sessionHref } from '../src/lib/session-head';
import type { GitHubDetails, MovedOn } from '../src/lib/api';
import { makeComment, makeThread } from './helpers/wire';

const OLD = 'a'.repeat(40);
const NEW = 'b'.repeat(40);

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stubServer(answers: Record<string, (body: unknown) => Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? 'GET', body });
    const path = Object.keys(answers).find(key => url.endsWith(key));
    return path ? answers[path](body) : Response.json({ error: 'Not found' }, { status: 404 });
  });
  return calls;
}

function stubNavigation() {
  return vi.spyOn(navigation, 'replace').mockImplementation(() => {});
}

afterEach(() => {
  cleanup();
  setVisibility('visible', false);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sessionStorage.clear();
});

describe('the address of the same view in another session', () => {
  it('swaps the session and keeps the rest', () => {
    const location = { pathname: '/s/old/', search: '?view=unified', hash: '#src.ts' };
    expect(sessionHref('new', location, '/s/old')).toBe('/s/new/?view=unified#src.ts');
    expect(sessionHref('new', { pathname: '/s/old', search: '', hash: '' }, '/s/old')).toBe('/s/new/');
  });
});

function Harness({ movedOn, reviewing, children }: { movedOn: MovedOn | null; reviewing?: boolean; children?: ReactNode }) {
  const head = useFollowHead('old', movedOn, reviewing);
  return (
    <>
      {children}
      {head.movedOn
        ? <MovedOnBanner headSha={head.movedOn.headSha} updating={head.updating} onUpdate={head.update} />
        : <span>current</span>}
    </>
  );
}

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(state: DocumentVisibilityState, announce = true) {
  visibility = state;
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  if (announce) {
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
  }
}

const moved: MovedOn = { headSha: NEW, sessionId: 'new' };

describe('a review page behind its pull request', () => {
  it('moves to the current head on load, without asking', async () => {
    const calls = stubServer({ '/api/advance': () => Response.json({ sessionId: 'new', headSha: NEW }) });
    const replace = stubNavigation();
    render(<Harness movedOn={{ headSha: NEW, sessionId: null }} />);

    await waitFor(() => expect(replace).toHaveBeenCalledWith('/s/new/'));
    expect(calls.map(call => [call.method, call.url])).toEqual([['POST', '/api/advance']]);
  });

  it('stays and offers the update while an agent is still reviewing this session', async () => {
    const calls = stubServer({ '/api/advance': () => Response.json({ sessionId: 'new', headSha: NEW }) });
    const replace = stubNavigation();
    render(<Harness movedOn={{ headSha: NEW, sessionId: null }} reviewing />);

    expect(await screen.findByTestId('moved-on-banner')).toBeTruthy();
    expect(calls).toHaveLength(0);
    expect(replace).not.toHaveBeenCalled();
  });

  it('offers an update when the head moves while the page is open, and moves only when asked', async () => {
    const calls = stubServer({ '/api/advance': () => Response.json({ sessionId: 'new', headSha: NEW }) });
    const replace = stubNavigation();
    const { rerender } = render(<Harness movedOn={null} />);
    expect(screen.getByText('current')).toBeTruthy();

    rerender(<Harness movedOn={{ headSha: NEW, sessionId: 'new' }} />);
    const banner = await screen.findByTestId('moved-on-banner');
    expect(banner.textContent).toContain(`moved on to ${NEW.slice(0, 7)}`);
    expect(calls).toHaveLength(0);
    expect(replace).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/s/new/'));
    expect(calls.map(call => call.url)).toEqual(['/api/advance']);
  });

  it('stays when the server finds the session current after all', async () => {
    stubServer({ '/api/advance': () => Response.json({ sessionId: 'old', headSha: OLD }) });
    const replace = stubNavigation();
    render(<Harness movedOn={{ headSha: NEW, sessionId: null }} />);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy());
    expect(replace).not.toHaveBeenCalled();
  });
});

describe('a review page nobody is looking at', () => {
  it('follows a head that moves while the tab is hidden', async () => {
    const calls = stubServer({ '/api/advance': () => Response.json({ sessionId: 'new', headSha: NEW }) });
    const replace = stubNavigation();
    const { rerender } = render(<Harness movedOn={null} />);
    setVisibility('hidden', false);

    rerender(<Harness movedOn={moved} />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/s/new/'));
    expect(calls.map(call => call.url)).toEqual(['/api/advance']);
  });

  it('follows when the reader leaves the tab, or comes back to it, with the update still on offer', async () => {
    const calls = stubServer({ '/api/advance': () => Response.json({ sessionId: 'new', headSha: NEW }) });
    const replace = stubNavigation();
    const { rerender } = render(<Harness movedOn={null} />);
    rerender(<Harness movedOn={moved} />);
    expect(await screen.findByTestId('moved-on-banner')).toBeTruthy();
    expect(calls).toHaveLength(0);

    setVisibility('hidden');
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/s/new/'));
    expect(calls).toHaveLength(1);
  });

  it('stays while the reader is on the page', async () => {
    const calls = stubServer({ '/api/advance': () => Response.json({ sessionId: 'new', headSha: NEW }) });
    const replace = stubNavigation();
    const { rerender } = render(<Harness movedOn={null} />);
    rerender(<Harness movedOn={moved} />);
    expect(await screen.findByTestId('moved-on-banner')).toBeTruthy();
    rerender(<Harness movedOn={{ ...moved }} />);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);
    expect(replace).not.toHaveBeenCalled();
  });

  const blockers: [string, () => ReactNode, () => void][] = [
    ['a draft in a field', () => <textarea defaultValue="Half a thought" />, () => {}],
    ['a field being edited', () => <input aria-label="Reply" />, () => screen.getByRole('textbox', { name: 'Reply' }).focus()],
    ['the post dialog open', () => <div data-post-dialog />, () => {}],
  ];

  it.each(blockers)('stays and offers the update with %s', async (_name, extra, prepare) => {
    const calls = stubServer({ '/api/advance': () => Response.json({ sessionId: 'new', headSha: NEW }) });
    const replace = stubNavigation();
    const { rerender } = render(<Harness movedOn={null}>{extra()}</Harness>);
    prepare();
    setVisibility('hidden', false);

    rerender(<Harness movedOn={moved}>{extra()}</Harness>);
    expect(await screen.findByTestId('moved-on-banner')).toBeTruthy();
    setVisibility('visible');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);
    expect(replace).not.toHaveBeenCalled();
  });

  it('stays while an agent is reviewing this session, even hidden', async () => {
    const calls = stubServer({ '/api/advance': () => Response.json({ sessionId: 'new', headSha: NEW }) });
    const { rerender } = render(<Harness movedOn={null} reviewing />);
    setVisibility('hidden', false);
    rerender(<Harness movedOn={moved} reviewing />);
    expect(await screen.findByTestId('moved-on-banner')).toBeTruthy();
    setVisibility('visible');
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toHaveLength(0);
  });
});

const details: GitHubDetails = {
  prNumber: 7,
  prTitle: 'Change line ten',
  prUrl: 'https://github.com/o/r/pull/7',
  prCreatedAt: '2026-08-21T10:00:00.000Z',
  headSha: OLD,
  commentCount: 0,
  viewerDidAuthor: false,
  prAuthor: 'octocat',
  prBody: '',
  reviews: [],
};

const threads = [
  makeThread({ id: 't1', comments: [makeComment({ id: 'c1', body: 'P2: one' })] }),
  makeThread({ id: 't2', comments: [makeComment({ id: 'c2', body: 'P2: two' })] }),
];

function renderDialog(sessionId: string) {
  return render(
    <GitHubDialog details={details} threads={threads} sessionId={sessionId} onPulled={vi.fn()} onClose={vi.fn()} />,
  );
}

const movedOn = () => Response.json(
  { error: 'The pull request has moved on', code: 'moved_on', headSha: NEW, sessionHeadSha: OLD },
  { status: 409 },
);

const posted = () => Response.json({
  submitted: 2, submittedThreadIds: ['t1', 't2'], commentIds: [], skipped: 0, failed: 0, errors: [], reviewUrl: 'u', commitSha: OLD,
});

describe('posting after the pull request moved on', () => {
  it('asks first, and posts to the reviewed commit when told to', async () => {
    let refuse = true;
    const calls = stubServer({ '/api/github/create-review': () => (refuse ? movedOn() : posted()) });
    const user = userEvent.setup();
    renderDialog('old');

    await user.click(screen.getByRole('button', { name: /^submit 2/i }));
    const confirm = await screen.findByTestId('moved-on-confirm');
    expect(confirm.textContent).toContain(NEW.slice(0, 7));
    expect(screen.getByRole('button', { name: `Update to ${NEW.slice(0, 7)}` })).toBeTruthy();
    expect((calls[0].body as { allowOutdated?: boolean }).allowOutdated).toBeUndefined();

    refuse = false;
    await user.click(screen.getByRole('button', { name: `Post to ${OLD.slice(0, 7)} anyway` }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1].body).toMatchObject({ event: 'COMMENT', allowOutdated: true });
  });

  it('does not post to the reviewed commit once there is nothing to post', async () => {
    stubServer({ '/api/github/create-review': movedOn });
    const user = userEvent.setup();
    renderDialog('old');

    await user.click(screen.getByRole('button', { name: /^submit 2/i }));
    const anyway = await screen.findByRole('button', { name: `Post to ${OLD.slice(0, 7)} anyway` });
    expect((anyway as HTMLButtonElement).disabled).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Deselect all' }));
    expect((anyway as HTMLButtonElement).disabled).toBe(true);
  });

  it('updates to the new head, and the draft comes along', async () => {
    const calls = stubServer({
      '/api/github/create-review': movedOn,
      '/api/advance': () => Response.json({ sessionId: 'new', headSha: NEW }),
    });
    const replace = stubNavigation();
    const user = userEvent.setup();
    renderDialog('old');

    await user.click(screen.getAllByRole('checkbox')[0]);
    await user.type(screen.getByRole('textbox'), 'Looks right');
    await user.click(screen.getByRole('button', { name: /^request changes$/i }));
    await user.click(screen.getByRole('button', { name: /^submit 1/i }));
    await user.click(await screen.findByRole('button', { name: `Update to ${NEW.slice(0, 7)}` }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/s/new/'));
    expect(calls.map(call => call.url)).toEqual(['/api/github/create-review', '/api/advance']);

    cleanup();
    renderDialog('new');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Looks right');
    expect(screen.getByRole('button', { name: /^request changes$/i }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: /^submit 1/i })).toBeTruthy();

    cleanup();
    renderDialog('new');
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('');
  });
});

function RequestHarness() {
  const { data } = useQuery(repoInfoOptions());
  const request = useRequestReview();
  return data ? <button onClick={() => request.mutate()}>Ask</button> : null;
}

describe('asking for a review after the pull request moved on', () => {
  it('goes to the session the review was asked for on', async () => {
    const run = { state: 'queued', queuedAt: null, startedAt: null, doneAt: null, note: '' };
    stubServer({
      '/api/info': () => Response.json({ sessionId: 'old', review: { ...run, state: 'none' } }),
      '/api/review-request': () => Response.json({ ...run, sessionId: 'new' }),
    });
    const replace = stubNavigation();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RequestHarness />
      </QueryClientProvider>,
    );

    await userEvent.setup().click(await screen.findByRole('button', { name: 'Ask' }));
    await waitFor(() => expect(replace).toHaveBeenCalledWith('/s/new/'));
    expect(client.getQueryData(repoInfoOptions().queryKey)?.review?.state).toBe('none');
    client.clear();
  });
});
