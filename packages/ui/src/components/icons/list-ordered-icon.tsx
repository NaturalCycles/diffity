export function ListOrderedIcon(props: { className?: string }) {
  return (
    <svg
      className={props.className}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 4h8M6 8h8M6 12h8" />
      <path d="M2 3.5h1V6M2 6h2" />
      <path d="M2 10h2v2H2v1.5h2" />
    </svg>
  );
}
