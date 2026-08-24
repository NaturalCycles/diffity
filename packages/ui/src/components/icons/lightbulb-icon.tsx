import type { SVGProps } from 'react';

export function LightbulbIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round" {...props}>
      <path d="M6 13h4" />
      <path d="M6.5 10.5C5 9.6 4 8 4 6.25a4 4 0 0 1 8 0C12 8 11 9.6 9.5 10.5V13h-3v-2.5Z" />
    </svg>
  );
}
