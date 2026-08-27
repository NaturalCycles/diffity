import { describe, it, expect } from 'vitest';
import { addBadge, toHref, FAVICON_HREF } from '../src/lib/favicon-badge';

const ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 411 395"><path d="M0 0"/></svg>';

describe('addBadge', () => {
  it('puts the mark inside the icon, so it scales with it', () => {
    const badged = addBadge(ICON);

    expect(badged.endsWith('</svg>')).toBe(true);
    expect(badged).toContain('<circle');
    expect(badged.indexOf('<circle')).toBeLessThan(badged.indexOf('</svg>'));
  });

  it('keeps what was already there', () => {
    expect(addBadge(ICON)).toContain('<path d="M0 0"/>');
  });

  // A tab strip is light in one theme and dark in the other, and the icon itself already flips.
  it('gives the mark a ring that follows the colour scheme', () => {
    const badged = addBadge(ICON);

    expect(badged).toContain('prefers-color-scheme: dark');
    expect(badged).toContain('stroke');
  });

  it('leaves something that is not an icon alone rather than corrupting it', () => {
    expect(addBadge('not an svg')).toBe('not an svg');
  });
});

describe('toHref', () => {
  it('is usable as a link href', () => {
    expect(toHref('<svg/>')).toBe('data:image/svg+xml,%3Csvg%2F%3E');
  });

  it('escapes what would otherwise end the attribute', () => {
    expect(toHref('<svg a="b"/>')).not.toContain('"');
  });

  it('knows where the plain icon lives', () => {
    expect(FAVICON_HREF).toBe('/favicon.svg');
  });
});
