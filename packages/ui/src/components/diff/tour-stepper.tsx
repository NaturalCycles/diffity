import { useMemo } from 'react';
import type { Tour } from '../../lib/api';
import { CompassIcon } from '../icons/compass-icon';
import { ChevronUpIcon } from '../icons/chevron-up-icon';
import { ChevronDownIcon } from '../icons/chevron-down-icon';
import { Spinner } from '../icons/spinner';
import { MarkdownContent } from '../layout/markdown-content';

interface TourStepperProps {
  tour: Tour;
  stepIndex: number;
  onStepChange: (index: number) => void;
}

export function TourStepper(props: TourStepperProps) {
  const { tour, stepIndex, onStepChange } = props;

  const steps = useMemo(
    () => [...tour.steps].sort((a, b) => a.sortOrder - b.sortOrder),
    [tour.steps],
  );
  const isBuilding = tour.status === 'building';

  if (steps.length === 0) {
    return (
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-bg-secondary text-xs text-text-secondary">
        {isBuilding ? <Spinner className="w-3.5 h-3.5" /> : <CompassIcon className="w-3.5 h-3.5" />}
        {isBuilding ? 'Working out a reading order…' : tour.topic}
      </div>
    );
  }

  const index = Math.min(stepIndex, steps.length - 1);
  const step = steps[index];

  return (
    <div className="flex items-start gap-3 px-4 py-2 border-b border-border bg-bg-secondary">
      <span className="shrink-0 inline-flex items-center gap-1.5 mt-0.5 text-[11px] font-semibold text-accent tabular-nums">
        <CompassIcon className="w-3.5 h-3.5" />
        {index + 1}/{steps.length}
        {isBuilding && <Spinner className="w-3 h-3 text-text-muted" />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium text-text truncate">
          {step.filePath}
          <span className="ml-1.5 text-text-muted font-normal tabular-nums">
            {step.startLine === step.endLine ? step.startLine : `${step.startLine}-${step.endLine}`}
          </span>
        </div>
        {step.body && (
          <div className="text-xs text-text-secondary mt-0.5">
            <MarkdownContent content={step.body} />
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-0.5">
        <button
          className="p-1 rounded-md text-text-muted hover:text-text hover:bg-hover cursor-pointer disabled:opacity-40 disabled:cursor-default"
          onClick={() => onStepChange(index - 1)}
          disabled={index === 0}
          title="Previous step"
        >
          <ChevronUpIcon className="w-3.5 h-3.5" />
        </button>
        <button
          className="p-1 rounded-md text-text-muted hover:text-text hover:bg-hover cursor-pointer disabled:opacity-40 disabled:cursor-default"
          onClick={() => onStepChange(index + 1)}
          disabled={index >= steps.length - 1}
          title="Next step"
        >
          <ChevronDownIcon className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
