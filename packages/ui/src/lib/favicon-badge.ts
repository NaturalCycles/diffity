/**
 * The same icon with an unread mark on it. Done as SVG text because the icon already is an SVG: the
 * mark scales with it, and its ring follows the colour scheme the way the icon does.
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

const COUNT_PREFIX = /^\(\d+\) /;

export function titleWithCount(title: string, count: number): string {
  const plain = title.replace(COUNT_PREFIX, '');
  return count > 0 ? `(${count}) ${plain}` : plain;
}
