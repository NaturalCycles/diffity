import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { useFaviconBadge } from '../src/hooks/use-favicon-badge';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 411 395"><path d="M0 0"/></svg>';

function Page(props: { hasUnread: boolean }) {
  useFaviconBadge(props.hasUnread);
  return null;
}

function iconLink(): HTMLLinkElement {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;
}

beforeEach(() => {
  const link = document.createElement('link');
  link.rel = 'icon';
  link.href = '/favicon.svg';
  document.head.append(link);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(ICON))));
});

afterEach(() => {
  cleanup();
  iconLink()?.remove();
  vi.restoreAllMocks();
});

describe('useFaviconBadge', () => {
  it('leaves the tab alone while there is nothing unread', () => {
    render(<Page hasUnread={false} />);

    expect(iconLink().href).toContain('/favicon.svg');
  });

  it('marks the tab once something is unread', async () => {
    render(<Page hasUnread={true} />);

    await waitFor(() => expect(iconLink().href).toContain('data:image/svg+xml'));
    expect(decodeURIComponent(iconLink().href)).toContain('<circle');
  });

  it('puts the plain icon back once nothing is', async () => {
    const { rerender } = render(<Page hasUnread={true} />);
    await waitFor(() => expect(iconLink().href).toContain('data:'));

    rerender(<Page hasUnread={false} />);

    expect(iconLink().href).toContain('/favicon.svg');
  });

  // The icon is fetched once and kept, so a count that changes repeatedly does not refetch it.
  it('does not fetch the icon again when the mark comes back', async () => {
    const { rerender } = render(<Page hasUnread={true} />);
    await waitFor(() => expect(iconLink().href).toContain('data:'));
    const fetched = (fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

    rerender(<Page hasUnread={false} />);
    rerender(<Page hasUnread={true} />);

    await waitFor(() => expect(iconLink().href).toContain('data:'));
    expect((fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(fetched);
  });

  it('leaves the tab as it was when the icon cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    render(<Page hasUnread={true} />);

    await new Promise(r => setTimeout(r, 10));
    expect(iconLink().href).toContain('/favicon.svg');
  });
});
