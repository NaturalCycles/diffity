import type { DiffFile } from '@diffity/parser';
import { getFilePath } from '../../lib/diff-utils';
import type { TourFileStop } from '../../lib/tour-order';
import { CheckIcon } from '../icons/check-icon';
import { CommentIcon } from '../icons/comment-icon';

interface ReviewOrderListProps {
  files: DiffFile[];
  stops: Map<string, TourFileStop>;
  activeFile: string | null;
  reviewedFiles: Set<string>;
  commentCountsByFile: Map<string, number>;
  onFileClick: (path: string) => void;
}

function splitPath(path: string): { dir: string; name: string } {
  const idx = path.lastIndexOf('/');
  if (idx === -1) {
    return { dir: '', name: path };
  }
  return { dir: path.slice(0, idx), name: path.slice(idx + 1) };
}

export function ReviewOrderList(props: ReviewOrderListProps) {
  const { files, stops, activeFile, reviewedFiles, commentCountsByFile, onFileClick } = props;

  const firstUnvisited = files.findIndex(file => !stops.has(getFilePath(file)));

  return (
    <ul className="flex-1 overflow-y-auto py-1">
      {files.map((file, index) => {
        const path = getFilePath(file);
        const stop = stops.get(path);
        const { dir, name } = splitPath(path);
        const comments = commentCountsByFile.get(path);
        const isActive = activeFile === path;

        return (
          <li key={path}>
            {index === firstUnvisited && firstUnvisited > 0 && (
              <div className="flex items-center gap-2 px-3 py-2 text-[10px] uppercase tracking-wider text-text-muted">
                <span className="h-px flex-1 bg-border" />
                Not in the walkthrough
                <span className="h-px flex-1 bg-border" />
              </div>
            )}
            <button
              className={`w-full text-left flex gap-2 px-3 py-1.5 cursor-pointer ${
                isActive ? 'bg-accent/10' : 'hover:bg-hover'
              }`}
              onClick={() => onFileClick(path)}
              title={path}
            >
              <span
                className={`shrink-0 mt-0.5 inline-flex items-center justify-center w-5 h-5 rounded-full text-[10px] font-semibold tabular-nums ${
                  stop
                    ? 'bg-accent/15 text-accent'
                    : 'bg-bg-tertiary text-text-muted'
                }`}
              >
                {stop ? stop.position : '·'}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                  <span
                    className={`truncate text-xs ${
                      reviewedFiles.has(path) ? 'text-text-muted line-through' : 'text-text'
                    }`}
                  >
                    {name}
                  </span>
                  {reviewedFiles.has(path) && (
                    <CheckIcon className="w-3 h-3 shrink-0 text-text-muted" />
                  )}
                  {comments ? (
                    <span className="ml-auto shrink-0 inline-flex items-center gap-0.5 text-[10px] text-text-muted">
                      <CommentIcon className="w-3 h-3" />
                      {comments}
                    </span>
                  ) : null}
                </span>
                {dir && <span className="block truncate text-[10px] text-text-muted">{dir}</span>}
                {stop?.annotation && (
                  <span className="block text-[11px] text-text-secondary mt-0.5">{stop.annotation}</span>
                )}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
