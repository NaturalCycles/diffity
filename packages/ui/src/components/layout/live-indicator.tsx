interface LiveIndicatorProps {
  working: boolean;
  /** False when the server is not on a loopback bind, where live mode is refused outright. */
  enabled: boolean;
  /** Whether an agent is parked on the claim route right now. */
  listening: boolean;
  waiting: number;
}

/**
 * Says whether anything is there to hear an Ask. Not a switch: asking is a button on the comment
 * box, and a mode you have to remember is a mode you forget — the first version of this answered
 * three comments with silence because the mode was off and nothing said so.
 */
export function LiveIndicator(props: LiveIndicatorProps) {
  const { enabled, listening, working, waiting } = props;

  if (!enabled) {
    return null;
  }

  return (
    <span
      className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md ${
        listening || working ? 'text-accent' : 'text-text-muted'
      }`}
      title={
        working
          ? 'An agent has your request and is working on it.'
          : listening
            ? 'An agent is waiting. Ask / Act on a comment goes straight to it.'
            : 'No agent is waiting. Ask / Act still works — what you write is kept until one arrives.'
      }
    >
      <span
        className={`w-1.5 h-1.5 rounded-full ${
          working ? 'bg-modified animate-pulse' : listening ? 'bg-added' : 'bg-text-muted/40'
        }`}
      />
      {working ? 'Agent working' : listening ? 'Agent waiting' : 'No agent'}
      {waiting > 0 && (
        <span className="text-[10px] tabular-nums" title={`${waiting} waiting to be picked up`}>
          {waiting}
        </span>
      )}
    </span>
  );
}
