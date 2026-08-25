import type { CommentAuthor, CommentSide } from './types';
import { CommentForm } from './comment-form';

interface CommentFormRowProps {
  colSpan: number;
  filePath: string;
  side: CommentSide;
  startLine: number;
  endLine: number;
  currentAuthor: CommentAuthor;
  onSubmit: (filePath: string, side: CommentSide, startLine: number, endLine: number, body: string, author: CommentAuthor) => void;
  onCancel: () => void;
  viewMode?: 'unified' | 'split';
  /** Hands a brand-new comment to the agent — asking about code nobody has commented on yet. */
  onAsk?: (filePath: string, side: CommentSide, startLine: number, endLine: number, body: string, author: CommentAuthor) => void;
  onAct?: (filePath: string, side: CommentSide, startLine: number, endLine: number, body: string, author: CommentAuthor) => void;
  askIsHeard?: boolean;
}

export function CommentFormRow(props: CommentFormRowProps) {
  const { colSpan, filePath, side, startLine, endLine, currentAuthor, onSubmit, onCancel, viewMode, onAsk, onAct, askIsHeard } = props;

  const lineLabel = startLine === endLine
    ? `${startLine}`
    : `${startLine} to ${endLine}`;

  const formContent = (
    <div className="max-w-[700px]">
      <CommentForm
        onSubmit={(body) => onSubmit(filePath, side, startLine, endLine, body, currentAuthor)}
        onAsk={onAsk && ((body) => onAsk(filePath, side, startLine, endLine, body, currentAuthor))}
        onAct={onAct && ((body) => onAct(filePath, side, startLine, endLine, body, currentAuthor))}
        askIsHeard={askIsHeard}
        onCancel={onCancel}
        lineLabel={`Add a comment on line${startLine !== endLine ? 's' : ''} ${lineLabel}`}
      />
    </div>
  );

  if (viewMode === 'split') {
    return (
      <tr>
        {side === 'old' ? (
          <>
            <td colSpan={colSpan} className="px-4 py-3 bg-bg-secondary">{formContent}</td>
            <td colSpan={colSpan} className="bg-bg-secondary"></td>
          </>
        ) : (
          <>
            <td colSpan={colSpan} className="bg-bg-secondary"></td>
            <td colSpan={colSpan} className="px-4 py-3 bg-bg-secondary">{formContent}</td>
          </>
        )}
      </tr>
    );
  }

  return (
    <tr>
      <td colSpan={colSpan} className="px-4 py-3 bg-bg-secondary">
        {formContent}
      </td>
    </tr>
  );
}
