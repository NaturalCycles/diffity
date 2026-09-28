import type { DiffHunk, DiffLine as DiffLineType } from '@diffity/parser';
import type { SyntaxToken } from '../../lib/syntax-token';
import type { CommentThread as CommentThreadType, CommentAuthor, CommentSide, LineSelection, LineRenderProps } from '../comments/types';
import type { TourMark } from '../../lib/tour-marks';
import { DiffLine } from './diff-line';
import { HunkHeader, type ExpandControls } from './hunk-header';
import { CommentThread } from '../comments/comment-thread';
import { CommentFormRow } from '../comments/comment-form-row';

interface HunkBlockProps {
  hunk: DiffHunk;
  /** Applied to every row group of the hunk, so a whole hunk recedes or stands out together. */
  attentionClass?: string;
  /** Why it was dimmed, so the reader can always find out rather than having to trust it. */
  attentionTitle?: string;
  syntaxMap?: Map<string, SyntaxToken[]>;
  expandControls?: ExpandControls;
  topExpansionLines?: DiffLineType[];
  bottomExpansionLines?: DiffLineType[];
  expansionSyntaxMap?: Map<string, SyntaxToken[]>;
  threads?: CommentThreadType[];
  pendingSelection?: LineSelection | null;
  currentAuthor?: CommentAuthor;
  isLineSelected?: (line: number, side: CommentSide) => boolean;
  onLineMouseDown?: (line: number, side: CommentSide, shiftKey?: boolean) => void;
  onLineMouseEnter?: (line: number, side: CommentSide) => void;
  onCommentClick?: (line: number, side: CommentSide) => void;
  onAddThread?: (filePath: string, side: CommentSide, startLine: number, endLine: number, body: string, author: CommentAuthor, ask?: boolean) => void;
  onReply?: (threadId: string, body: string, author: CommentAuthor, ask?: boolean) => void;
  onResolve?: (threadId: string) => void;
  onUnresolve?: (threadId: string) => void;
  onEditComment?: (commentId: string, body: string) => void;
  onDeleteComment?: (threadId: string, commentId: string) => void;
  onDeleteThread?: (threadId: string) => void;
  onCancelPending?: () => void;
  filePath?: string;
  getOriginalCode?: (side: CommentSide, startLine: number, endLine: number) => string;
  tourMarks?: TourMark[];
  activeStepIndex?: number;
  onTourMarkClick?: (stepIndex: number) => void;
}

export function renderLineWithComments(
  line: DiffLineType,
  index: number,
  expanded: boolean,
  syntaxMap: Map<string, SyntaxToken[]> | undefined,
  props: LineRenderProps,
): React.ReactNode[] {
  const side: CommentSide = line.type === 'delete' ? 'old' : 'new';
  const activeLine = side === 'old' ? line.oldLineNumber : line.newLineNumber;
  const num = activeLine;
  const key = num !== null ? `${expanded ? 'exp-' : ''}${line.type}-${num}` : `line-${index}`;
  const syntaxKey = num !== null ? `${line.type}-${num}` : '';
  const tokens = syntaxMap?.get(syntaxKey);

  const result: React.ReactNode[] = [];

  result.push(
    <DiffLine
      key={key}
      line={line}
      syntaxTokens={tokens}
      expanded={expanded}
      isSelected={activeLine !== null ? props.isLineSelected?.(activeLine, side) : false}
      onLineMouseDown={props.onLineMouseDown}
      onLineMouseEnter={props.onLineMouseEnter}
      onCommentClick={props.onCommentClick}
      tourMarks={props.tourMarks}
      activeStepIndex={props.activeStepIndex}
      onTourMarkClick={props.onTourMarkClick}
    />
  );

  if (activeLine !== null && props.threads) {
    const lineThreads = props.threads.filter(t => t.endLine === activeLine && t.side === side);
    for (const thread of lineThreads) {
      result.push(
        <CommentThread
          key={`thread-${thread.id}`}
          thread={thread}
          onReply={props.onReply!}
          onResolve={props.onResolve!}
          onUnresolve={props.onUnresolve!}
          onEditComment={props.onEditComment!}
          onDeleteComment={props.onDeleteComment!}
          onDeleteThread={props.onDeleteThread!}
          currentAuthor={props.currentAuthor!}
          colSpan={4}
          currentCode={props.getOriginalCode?.(thread.side, thread.startLine, thread.endLine)}
        />
      );
    }
  }

  if (activeLine !== null && props.pendingSelection && props.pendingSelection.endLine === activeLine && props.pendingSelection.side === side && props.filePath && props.currentAuthor && props.onAddThread && props.onCancelPending) {
    result.push(
      <CommentFormRow
        key="pending-comment"
        colSpan={4}
        filePath={props.filePath}
        side={props.pendingSelection.side}
        startLine={props.pendingSelection.startLine}
        endLine={props.pendingSelection.endLine}
        currentAuthor={props.currentAuthor}
        onSubmit={props.onAddThread}
        onCancel={props.onCancelPending}
      />
    );
  }

  return result;
}

export function HunkBlock(props: HunkBlockProps) {
  const {
    hunk, attentionClass = '', attentionTitle, syntaxMap, expandControls, topExpansionLines, bottomExpansionLines, expansionSyntaxMap,
    threads, pendingSelection, currentAuthor, isLineSelected,
    onLineMouseDown, onLineMouseEnter, onCommentClick,
    onAddThread, onReply, onResolve, onUnresolve, onDeleteComment, onDeleteThread,
    onCancelPending, filePath, getOriginalCode,
    tourMarks, activeStepIndex, onTourMarkClick,
  } = props;

  const commentProps = {
    isLineSelected, onLineMouseDown, onLineMouseEnter, onCommentClick,
    threads, pendingSelection, currentAuthor,
    onAddThread, onReply, onResolve, onUnresolve, onDeleteComment, onDeleteThread,
    onCancelPending, filePath, getOriginalCode,
    tourMarks, activeStepIndex, onTourMarkClick,
  };

  const expansionRows: React.ReactNode[] = [];

  if (topExpansionLines) {
    for (let i = 0; i < topExpansionLines.length; i++) {
      expansionRows.push(...renderLineWithComments(topExpansionLines[i], i, true, expansionSyntaxMap, commentProps));
    }
  }

  if (bottomExpansionLines) {
    for (let i = 0; i < bottomExpansionLines.length; i++) {
      expansionRows.push(...renderLineWithComments(bottomExpansionLines[i], i, true, expansionSyntaxMap, commentProps));
    }
  }

  const rows: React.ReactNode[] = [];
  for (let i = 0; i < hunk.lines.length; i++) {
    rows.push(...renderLineWithComments(hunk.lines[i], i, false, syntaxMap, commentProps));
  }

  const tbodyClass = expandControls?.wasExpanded && expandControls.remainingLines <= 0 ? '' : 'border-t border-border-muted';

  return (
    <>
      <tbody className={`${tbodyClass} ${attentionClass}`} title={attentionTitle}>
        <HunkHeader hunk={hunk} expandControls={expandControls} />
        {expansionRows}
      </tbody>
      {rows.length > 0 && (
        <tbody className={attentionClass} title={attentionTitle}>
          {rows}
        </tbody>
      )}
    </>
  );
}
