interface LiveToggleProps {
  /** False when the server is not on a loopback bind, where live mode is refused outright. */
  available: boolean;
  /** Whether an agent is parked on the claim route right now. */
  listening: boolean;
  waiting: number;
  on: boolean;
  onChange: (on: boolean) => void;
}

/**
 * Turning this on makes a reply a question for the agent rather than a note for the pull request's
 * author. It shows whether anyone is actually there: a switch that lets you type into the void is
 * worse than no switch.
 */
export function LiveToggle(props: LiveToggleProps) {
  const { available, listening, waiting, on, onChange } = props;

  if (!available) {
    return null;
  }

  const state = !on
    ? 'off'
    : listening
      ? 'listening'
      : 'unheard';

  const dotClass = {
    off: 'bg-text-muted/40',
    listening: 'bg-added',
    unheard: 'bg-modified',
  }[state];

  const title = {
    off: 'Off. Replies are review comments, addressed to whoever wrote the code.',
    listening: 'On, and an agent is waiting. A reply goes to it instead of to the pull request.',
    unheard: 'On, but no agent is waiting. Your replies are kept and handed over when one arrives.',
  }[state];

  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      title={title}
      aria-pressed={on}
      className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md cursor-pointer transition-colors ${
        on ? 'bg-accent/10 text-accent' : 'text-text-muted hover:bg-hover hover:text-text'
      }`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${dotClass}`} />
      Live
      {on && waiting > 0 && (
        <span className="text-[10px] tabular-nums" title={`${waiting} waiting to be picked up`}>
          {waiting}
        </span>
      )}
    </button>
  );
}
