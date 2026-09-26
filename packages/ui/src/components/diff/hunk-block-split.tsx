import { useState } from 'react';
import type { DiffHunk, DiffLine as DiffLineType } from '@diffity/parser';
import { cn } from '../../lib/cn';
import { getLineBg } from '../../lib/diff-utils';
import { renderContent } from '../../lib/render-content';
import type { SyntaxToken } from '../../lib/syntax-token';
import type { CommentThread as CommentThreadType, CommentAuthor, CommentSide, LineSelection, LineRenderProps } from '../comments/types';
import { HunkHeader, type ExpandControls } from './hunk-header';
import { CommentLineNumber } from '../comments/comment-line-number';
import type { TourMark } from '../../lib/tour-marks';
import { TourMarkLamp } from './tour-mark-lamp';
import { CommentThread } from '../comments/comment-thread';
import { CommentFormRow } from '../comments/comment-form-row';

interface HunkBlockSplitProps {
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
  onAddThread?: (filePath: string, side: CommentSide, startLine: number, endLine: number, body: string, author: CommentAuthor) => void;
  onReply?: (threadId: string, body: string, author: CommentAuthor) => void;
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

interface SplitRow {
  left: DiffLineType | null;
  right: DiffLineType | null;
}

function buildSplitRows(lines: DiffLineType[]): SplitRow[] {
  const rows: SplitRow[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.type === 'context') {
      rows.push({ left: line, right: line });
      i++;
      continue;
    }

    if (line.type === 'delete') {
      const deleteLines: DiffLineType[] = [];
      while (i < lines.length && lines[i].type === 'delete') {
        deleteLines.push(lines[i]);
        i++;
      }

      const addLines: DiffLineType[] = [];
      while (i < lines.length && lines[i].type === 'add') {
        addLines.push(lines[i]);
        i++;
      }

      const maxLen = Math.max(deleteLines.length, addLines.length);
      for (let j = 0; j < maxLen; j++) {
        rows.push({
          left: j < deleteLines.length ? deleteLines[j] : null,
          right: j < addLines.length ? addLines[j] : null,
        });
      }
      continue;
    }

    if (line.type === 'add') {
      rows.push({ left: null, right: line });
      i++;
      continue;
    }

    i++;
  }

  return rows;
}

function getCellBg(line: DiffLineType | null): string {
  if (!line) {
    return 'bg-bg-secondary';
  }
  return getLineBg(line.type);
}

function getSyntaxKey(line: DiffLineType): string {
  const num = line.type === 'delete' ? line.oldLineNumber : line.newLineNumber;
  return `${line.type}-${num}`;
}

function SplitCell(props: {
  line: DiffLineType | null;
  side: 'left' | 'right';
  syntaxMap?: Map<string, SyntaxToken[]>;
  expanded?: boolean;
  isSelected?: boolean;
  onMouseDown?: (shiftKey: boolean) => void;
  onMouseEnter?: () => void;
  onCommentClick?: () => void;
  tourMarks?: TourMark[];
  activeStepIndex?: number;
  onTourMarkClick?: (stepIndex: number) => void;
}) {
  const { line, side, syntaxMap, expanded, isSelected, onMouseDown, onMouseEnter, onCommentClick, tourMarks, activeStepIndex, onTourMarkClick } = props;
  const [contentHovered, setContentHovered] = useState(false);

  if (!line) {
    return (
      <>
        <CommentLineNumber lineNumber={null} className="diff-empty-cell" />
        <td className="px-3 whitespace-pre border-r border-border-muted align-top diff-empty-cell"></td>
      </>
    );
  }

  const bgClass = expanded ? 'bg-diff-expanded-gutter' : getCellBg(line);
  const contentBgClass = expanded ? 'bg-diff-expanded-bg' : getCellBg(line);
  const lineNum = side === 'left' ? line.oldLineNumber : line.newLineNumber;
  const syntaxKey = getSyntaxKey(line);
  const tokens = syntaxMap?.get(syntaxKey);

  return (
    <>
      <CommentLineNumber
        lineNumber={lineNum}
        className={bgClass}
        isSelected={isSelected}
        leadingMarker={
          side === 'right' ? (
            <TourMarkLamp
              marks={tourMarks}
              line={line.newLineNumber}
              activeStepIndex={activeStepIndex}
              onClick={onTourMarkClick}
            />
          ) : undefined
        }
        showCommentButton={!!onCommentClick && lineNum !== null}
        forceShowButton={contentHovered}
        onMouseDown={onMouseDown}
        onMouseEnter={onMouseEnter}
        onCommentClick={onCommentClick}
      />
      <td
        className={cn('px-3 code-cell border-r border-border-muted align-top', isSelected ? 'bg-diff-comment-bg' : contentBgClass)}
        onMouseEnter={() => setContentHovered(true)}
        onMouseLeave={() => setContentHovered(false)}
      >
        <span className="inline">{renderContent(line, tokens)}</span>
      </td>
    </>
  );
}

export function renderSplitRows(
  lines: DiffLineType[],
  expanded: boolean,
  syntaxMap: Map<string, SyntaxToken[]> | undefined,
  keyPrefix: string,
  props: LineRenderProps,
): React.ReactNode[] {
  const splitRows = buildSplitRows(lines);
  const result: React.ReactNode[] = [];

  for (let i = 0; i < splitRows.length; i++) {
    const row = splitRows[i];
    const leftLine = row.left;
    const rightLine = row.right;
    const leftNum = leftLine?.oldLineNumber ?? null;
    const rightNum = rightLine?.newLineNumber ?? null;

    result.push(
      <tr
        key={`${keyPrefix}-${i}`}
        className="group/split-row font-mono text-sm leading-6"
        data-new-line={rightNum ?? undefined}
      >
        <SplitCell
          line={leftLine}
          side="left"
          syntaxMap={syntaxMap}
          expanded={expanded}
          isSelected={leftNum !== null ? props.isLineSelected?.(leftNum, 'old') : false}
          onMouseDown={leftNum !== null ? (shiftKey: boolean) => props.onLineMouseDown?.(leftNum, 'old', shiftKey) : undefined}
          onMouseEnter={leftNum !== null ? () => props.onLineMouseEnter?.(leftNum, 'old') : undefined}
          onCommentClick={leftNum !== null && props.onCommentClick ? () => props.onCommentClick!(leftNum, 'old') : undefined}
        />
        <SplitCell
          line={rightLine}
          side="right"
          syntaxMap={syntaxMap}
          expanded={expanded}
          isSelected={rightNum !== null ? props.isLineSelected?.(rightNum, 'new') : false}
          onMouseDown={rightNum !== null ? (shiftKey: boolean) => props.onLineMouseDown?.(rightNum, 'new', shiftKey) : undefined}
          onMouseEnter={rightNum !== null ? () => props.onLineMouseEnter?.(rightNum, 'new') : undefined}
          onCommentClick={rightNum !== null && props.onCommentClick ? () => props.onCommentClick!(rightNum, 'new') : undefined}
          tourMarks={props.tourMarks}
          activeStepIndex={props.activeStepIndex}
          onTourMarkClick={props.onTourMarkClick}
        />
      </tr>
    );

    const threadRows: React.ReactNode[] = [];

    if (leftNum !== null && props.threads) {
      const leftThreads = props.threads.filter(t => t.endLine === leftNum && t.side === 'old');
      for (const thread of leftThreads) {
        threadRows.push(
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
            colSpan={2}
            viewMode="split"
            side="old"
            currentCode={props.getOriginalCode?.(thread.side, thread.startLine, thread.endLine)}
          />
        );
      }
    }

    if (rightNum !== null && props.threads) {
      const rightThreads = props.threads.filter(t => t.endLine === rightNum && t.side === 'new');
      for (const thread of rightThreads) {
        threadRows.push(
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
            colSpan={2}
            viewMode="split"
            side="new"
            currentCode={props.getOriginalCode?.(thread.side, thread.startLine, thread.endLine)}
          />
        );
      }
    }

    if (props.pendingSelection && props.filePath && props.currentAuthor && props.onAddThread && props.onCancelPending) {
      const showForLeft = leftNum !== null && props.pendingSelection.endLine === leftNum && props.pendingSelection.side === 'old';
      const showForRight = rightNum !== null && props.pendingSelection.endLine === rightNum && props.pendingSelection.side === 'new';
      if (showForLeft || showForRight) {
        threadRows.push(
          <CommentFormRow
            key="pending-comment"
            colSpan={2}
            filePath={props.filePath}
            side={props.pendingSelection.side}
            startLine={props.pendingSelection.startLine}
            endLine={props.pendingSelection.endLine}
            currentAuthor={props.currentAuthor}
            onSubmit={props.onAddThread}
            onCancel={props.onCancelPending}
            viewMode="split"
          />
        );
      }
    }

    if (threadRows.length > 0) {
      result.push(...threadRows);
    }
  }

  return result;
}

export function HunkBlockSplit(props: HunkBlockSplitProps) {
  const {
    hunk, attentionClass = '', attentionTitle, syntaxMap, expandControls, topExpansionLines, bottomExpansionLines, expansionSyntaxMap,
    threads, pendingSelection, currentAuthor, isLineSelected,
    onLineMouseDown, onLineMouseEnter, onCommentClick,
    onAddThread, onReply, onResolve, onUnresolve, onEditComment, onDeleteComment, onDeleteThread,
    onCancelPending, filePath, getOriginalCode,
    tourMarks, activeStepIndex, onTourMarkClick,
  } = props;

  const commentProps = {
    isLineSelected, onLineMouseDown, onLineMouseEnter, onCommentClick,
    threads, pendingSelection, currentAuthor,
    onAddThread, onReply, onResolve, onUnresolve, onEditComment, onDeleteComment, onDeleteThread,
    onCancelPending, filePath, getOriginalCode,
    tourMarks, activeStepIndex, onTourMarkClick,
  };

  const expansionRows: React.ReactNode[] = [];

  if (topExpansionLines && topExpansionLines.length > 0) {
    expansionRows.push(...renderSplitRows(topExpansionLines, true, expansionSyntaxMap, 'top-exp', commentProps));
  }

  if (bottomExpansionLines && bottomExpansionLines.length > 0) {
    expansionRows.push(...renderSplitRows(bottomExpansionLines, true, expansionSyntaxMap, 'bot-exp', commentProps));
  }

  const allRows = renderSplitRows(hunk.lines, false, syntaxMap, 'hunk', commentProps);

  const tbodyClass = expandControls?.wasExpanded && expandControls.remainingLines <= 0 ? '' : 'border-t border-border-muted';

  return (
    <>
      <tbody className={`${tbodyClass} ${attentionClass}`} title={attentionTitle}>
        <HunkHeader hunk={hunk} expandControls={expandControls} />
        {expansionRows}
      </tbody>
      {allRows.length > 0 && (
        <tbody className={attentionClass} title={attentionTitle}>
          {allRows}
        </tbody>
      )}
    </>
  );
}
