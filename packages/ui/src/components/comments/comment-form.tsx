import { useState, useRef, useEffect } from 'react';

interface CommentFormProps {
  onSubmit: (body: string) => void;
  onCancel: () => void;
  placeholder?: string;
  submitLabel?: string;
  autoFocus?: boolean;
  lineLabel?: string;
  /**
   * Hands the text to the agent instead of leaving it for whoever wrote the code. Absent when no
   * agent can be reached, so the button is never offered where it would do nothing.
   */
  onAsk?: (body: string) => void;
  /** Whether an agent is waiting right now, which changes what the button promises. */
  askIsHeard?: boolean;
}

export function CommentForm(props: CommentFormProps) {
  const {
    onSubmit, onCancel, placeholder = 'Leave a comment', submitLabel = 'Comment',
    autoFocus = true, lineLabel, onAsk, askIsHeard,
  } = props;
  const [body, setBody] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (autoFocus && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [autoFocus]);

  const handleSubmit = () => {
    const trimmed = body.trim();
    if (!trimmed) {
      return;
    }
    onSubmit(trimmed);
    setBody('');
  };

  const handleAsk = () => {
    const trimmed = body.trim();
    if (!trimmed || !onAsk) {
      return;
    }
    onAsk(trimmed);
    setBody('');
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="rounded-lg overflow-hidden bg-bg-tertiary pt-2">
      {lineLabel && (
        <div className="px-3 pb-1.5 -mt-0.5">
          <span className="text-xs text-text-secondary font-medium">{lineLabel}</span>
        </div>
      )}
      <div className="mx-1.5 mb-0.5 rounded-md overflow-hidden">
        <textarea
          ref={textareaRef}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          rows={3}
          className="w-full px-3 py-2 text-sm bg-bg text-text resize-y outline-none placeholder:text-text-muted min-h-[80px]"
        />
      </div>
      <div className="flex items-center gap-2 px-1.5 pb-1.5">
        <div className="flex-1" />
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs font-medium rounded-md text-text-secondary hover:bg-hover transition-colors cursor-pointer"
        >
          Cancel
        </button>
        {onAsk && (
          <button
            onClick={handleAsk}
            disabled={!body.trim()}
            title={
              askIsHeard
                ? 'Hand this to the agent. It will answer, rewrite the comment, or make the change.'
                : 'Hand this to the agent. Nobody is waiting right now, so it is kept until one is.'
            }
            className="px-3 py-1.5 text-xs font-medium rounded-md border border-accent/40 text-accent hover:bg-accent/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          >
            Ask / Act
          </button>
        )}
        <button
          onClick={handleSubmit}
          disabled={!body.trim()}
          className="px-3 py-1.5 text-xs font-medium rounded-md bg-accent text-white hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
        >
          {submitLabel}
        </button>
      </div>
    </div>
  );
}
