import { useState } from 'react';
import { marksStartingAt, stopTitle, type TourMark } from '../../lib/tour-marks';
import { LightbulbIcon } from '../icons/lightbulb-icon';
import { MarkdownContent } from '../layout/markdown-content';

interface TourMarkLampProps {
  marks: TourMark[] | undefined;
  line: number | null;
  activeStepIndex: number | undefined;
  onClick: ((stepIndex: number) => void) | undefined;
  /**
   * Which way the note opens. In split view it opens over the old side, so it never covers the
   * code being reviewed; unified has nothing to its left, so there it opens right.
   */
  direction?: 'left' | 'right';
}

/**
 * The lamp marks where a walkthrough stop begins, so a reader scrolling the diff — rather than
 * stepping through it — can still see which parts the walkthrough had something to say about.
 * One lamp per line: stops that share a line are read as one note about that block.
 */
export function TourMarkLamp(props: TourMarkLampProps) {
  const { marks, line, activeStepIndex, onClick, direction = 'left' } = props;
  const [showNote, setShowNote] = useState(false);

  if (!marks || marks.length === 0 || line === null) {
    return null;
  }

  const here = marksStartingAt(marks, line);
  if (here.length === 0) {
    return null;
  }

  const isCurrent = here.some(mark => mark.stepIndex === activeStepIndex);
  const label = stopTitle(here, activeStepIndex ?? -1);

  return (
    <span className="absolute left-0 top-0.5 flex items-center">
      <button
        type="button"
        className={`w-3.5 h-4 flex items-center justify-center cursor-pointer ${
          isCurrent ? 'text-accent' : 'text-accent/55 hover:text-accent'
        }`}
        aria-label={label}
        onMouseEnter={() => setShowNote(true)}
        onMouseLeave={() => setShowNote(false)}
        onFocus={() => setShowNote(true)}
        onBlur={() => setShowNote(false)}
        onMouseDown={event => event.stopPropagation()}
        onClick={event => {
          event.stopPropagation();
          event.preventDefault();
          onClick?.(here[0].stepIndex);
        }}
      >
        <LightbulbIcon className="w-3 h-3" />
      </button>
      {showNote && (
        <span
          role="tooltip"
          className={`absolute top-0 z-30 w-96 max-w-[32rem] rounded-md border px-3 py-2 text-left font-sans text-xs whitespace-normal shadow-md bg-note-bg border-note-border text-note-text ${
            direction === 'left' ? 'right-full mr-1.5' : 'left-full ml-1.5'
          }`}
        >
          {here.map(mark => (
            <span key={mark.stepIndex} className="block not-first:mt-2 not-first:pt-2 not-first:border-t not-first:border-note-border">
              <span className="block font-semibold">
                Stop {mark.stepIndex + 1}
                {mark.annotation && <span className="font-normal"> · {mark.annotation}</span>}
              </span>
              {mark.body && <MarkdownContent content={mark.body} />}
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
