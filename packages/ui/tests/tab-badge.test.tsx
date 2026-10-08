import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { useTabBadge } from '../src/hooks/use-tab-badge';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>';

function Page(props: { count: number }) {
  useTabBadge(props.count);
  return null;
}

const iconLink = () => document.querySelector<HTMLLinkElement>('link[rel="icon"]')!;

beforeEach(() => {
  document.title = 'diffity';
  const link = document.createElement('link');
  link.rel = 'icon';
  link.setAttribute('href', '/favicon.svg');
  document.head.append(link);
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(ICON))));
});

afterEach(() => {
  cleanup();
  iconLink()?.remove();
  vi.unstubAllGlobals();
});

describe('useTabBadge', () => {
  it('leaves the tab alone with nothing unseen', () => {
    render(<Page count={0} />);

    expect(document.title).toBe('diffity');
    expect(iconLink().getAttribute('href')).toBe('/favicon.svg');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('marks the title and the icon while something is unseen', async () => {
    render(<Page count={1} />);

    expect(document.title).toBe('(1) diffity');
    await waitFor(() => expect(iconLink().getAttribute('href')).toContain('data:image/svg+xml'));
  });

  it('puts both back once it is seen', async () => {
    const { rerender } = render(<Page count={1} />);
    await waitFor(() => expect(iconLink().getAttribute('href')).toContain('data:'));

    rerender(<Page count={0} />);

    expect(document.title).toBe('diffity');
    expect(iconLink().getAttribute('href')).toBe('/favicon.svg');
  });

  it('leaves the icon as it was when it cannot be read', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('offline'))));
    render(<Page count={1} />);

    await new Promise(resolve => setTimeout(resolve, 10));
    expect(iconLink().getAttribute('href')).toBe('/favicon.svg');
  });
});
