export function WrapTextIcon(props: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={props.className}
    >
      <path d="M2 3.5h12" />
      <path d="M2 8h9.5a2.5 2.5 0 010 5H8" />
      <path d="M9.5 11l-1.75 2L9.5 15" />
      <path d="M2 12.5h3" />
    </svg>
  );
}
