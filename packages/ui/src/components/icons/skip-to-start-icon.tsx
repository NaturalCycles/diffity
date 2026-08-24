import type { SVGProps } from 'react';

export function SkipToStartIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M3 3h10" />
      <path d="M4.5 10.5 8 7l3.5 3.5" />
      <path d="M4.5 14 8 10.5 11.5 14" />
    </svg>
  );
}
