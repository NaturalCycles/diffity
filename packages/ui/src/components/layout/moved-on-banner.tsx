import { Spinner } from '../icons/spinner';

interface MovedOnBannerProps {
  headSha: string;
  updating: boolean;
  onUpdate: () => void;
}

export function MovedOnBanner({ headSha, updating, onUpdate }: MovedOnBannerProps) {
  const short = headSha.slice(0, 7);
  return (
    <div
      role="status"
      data-testid="moved-on-banner"
      className="flex items-center gap-2 px-4 py-2 border-b border-accent/40 bg-accent/10 text-xs text-text"
    >
      {updating && <Spinner className="w-3.5 h-3.5 text-accent shrink-0" />}
      <span className="font-medium">
        The pull request has moved on to <code>{short}</code>
      </span>
      {!updating && (
        <button
          type="button"
          onClick={onUpdate}
          className="px-2 py-0.5 rounded border border-accent/60 text-accent hover:bg-accent/15 cursor-pointer"
        >
          Update
        </button>
      )}
    </div>
  );
}
