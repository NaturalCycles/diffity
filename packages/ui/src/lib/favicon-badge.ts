export const FAVICON_HREF = '/favicon.svg';

/**
 * The same icon with an unread mark on it, the way a chat app marks a tab you are not looking at.
 *
 * Done as SVG text rather than drawn on a canvas because the icon already is an SVG: the mark
 * inherits its scaling, and the ring can follow the same colour-scheme rules the icon uses, so it
 * reads on a light tab strip and a dark one.
 */
export function addBadge(svg: string): string {
  const closing = svg.lastIndexOf('</svg>');
  if (closing === -1) {
    return svg;
  }

  const mark = '<style>.unread-ring{stroke:#fff}'
    + '@media (prefers-color-scheme: dark){.unread-ring{stroke:#000}}</style>'
    + '<circle class="unread-ring" cx="300" cy="110" r="88" fill="#e5484d" stroke-width="24"/>';

  return svg.slice(0, closing) + mark + svg.slice(closing);
}

export function toHref(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
