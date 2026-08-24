import { marksStartingAt, stopTitle, type TourMark } from '../../lib/tour-marks';
import { LightbulbIcon } from '../icons/lightbulb-icon';

interface TourMarkLampProps {
  marks: TourMark[] | undefined;
  line: number | null;
  activeStepIndex: number | undefined;
  onClick: ((stepIndex: number) => void) | undefined;
}

/**
 * The lamp marks where a walkthrough stop begins, so a reader scrolling the diff — rather than
 * stepping through it — can still see which parts the walkthrough had something to say about.
 */
export function TourMarkLamp(props: TourMarkLampProps) {
  const { marks, line, activeStepIndex, onClick } = props;

  if (!marks || marks.length === 0 || line === null) {
    return null;
  }

  const here = marksStartingAt(marks, line);
  if (here.length === 0) {
    return null;
  }

  return (
    <span className="absolute left-0 top-0.5 flex items-center">
      {here.map(mark => (
        <button
          key={mark.stepIndex}
          type="button"
          className={`w-3.5 h-4 flex items-center justify-center cursor-pointer ${
            mark.stepIndex === activeStepIndex ? 'text-accent' : 'text-accent/55 hover:text-accent'
          }`}
          title={stopTitle([mark], activeStepIndex ?? -1)}
          aria-label={stopTitle([mark], activeStepIndex ?? -1)}
          onMouseDown={event => event.stopPropagation()}
          onClick={event => {
            event.stopPropagation();
            event.preventDefault();
            onClick?.(mark.stepIndex);
          }}
        >
          <LightbulbIcon className="w-3 h-3" />
        </button>
      ))}
    </span>
  );
}
