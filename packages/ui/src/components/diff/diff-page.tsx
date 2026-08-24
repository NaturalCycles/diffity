import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useLoaderData } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDiff } from '../../hooks/use-diff';
import { useInfo } from '../../hooks/use-info';
import { useTheme } from '../../hooks/use-theme';
import { useWrapLines } from '../../hooks/use-wrap-lines';
import { useKeyboard } from '../../hooks/use-keyboard';
import { useReviewThreads } from '../../hooks/use-review-threads';
import { useTours } from '../../hooks/use-tours';
import { useHideWhitespace } from '../../hooks/use-hide-whitespace';
import { pickActiveTour, orderPathsByTour, stopsByPath } from '../../lib/tour-order';
import { TOUR_NOT_STARTED, clampTourStep } from '../../lib/tour-navigation';
import { liveStatusOptions } from '../../queries/live';
import { readReadingPosition, writeReadingPosition } from '../../lib/reading-position';
import { staleMessage } from '../../lib/stale-files';
import { patchDiffFile } from '../../lib/patch-diff-file';
import { fetchDiffFile } from '../../lib/api';
import { diffOptions } from '../../queries/diff';
import { tourMarks, marksByPath, focusRangesFromMarks, type TourFocusRange } from '../../lib/tour-marks';
import { TourStepper } from './tour-stepper';
import { useCommentActions } from '../../hooks/use-comment-actions';
import { Toolbar } from '../layout/toolbar';
import { DiffView, type DiffViewHandle } from './diff-view';
import { Sidebar } from '../layout/sidebar';
import { ShortcutModal } from '../layout/shortcut-modal';
import { StaleDiffBanner } from '../layout/stale-diff-banner';
import { ReviewProgressBanner } from '../layout/review-progress-banner';
import { PullRequestPanel } from '../layout/pull-request-panel';
import { CheckCircleIcon } from '../icons/check-circle-icon';
import { PageLoader } from '../layout/skeleton';
import { useDiffStaleness } from '../../hooks/use-diff-staleness';
import { type ViewMode, getFilePath, getAutoCollapsedPaths } from '../../lib/diff-utils';
import { buildFirstOpenThreadByFile, buildThreadCountsByFile } from '../../lib/comment-navigation';
import { getHunkHeaders, scrollToElement } from '../../lib/dom-utils';
import {
  fingerprintFiles,
  loadViewedFiles,
  pickFingerprints,
  reconcileViewed,
  saveViewedFiles,
} from '../../lib/viewed-storage';
import { fetchGitHubDetails, type GitHubDetails } from '../../lib/api';
import type { LineSelection } from '../comments/types';
import type { ParsedDiff } from '@diffity/parser';
import { isThreadResolved } from '../comments/types';

export function DiffPage() {
  const { ref: refParam, theme: initialTheme, view: initialViewMode } = useLoaderData<{
    ref: string;
    theme: 'light' | 'dark' | null;
    view: 'split' | 'unified' | null;
  }>();

  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode || 'split');
  const { hideWhitespace, setHideWhitespace } = useHideWhitespace();
  const [showHelp, setShowHelp] = useState(false);
  const { theme, toggleTheme } = useTheme(initialTheme);
  const { wrapLines, toggleWrapLines } = useWrapLines();
  const { data: diff, error } = useDiff(hideWhitespace, refParam);
  const { data: info } = useInfo(refParam);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [reviewedFiles, setReviewedFiles] = useState<Set<string>>(new Set());
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const manuallyToggledRef = useRef<Set<string>>(new Set());
  const [pendingSelection, setPendingSelection] = useState<LineSelection | null>(null);
  const mainRef = useRef<HTMLElement | null>(null);
  const diffViewRef = useRef<DiffViewHandle>(null);
  const currentFileIdx = useRef(0);
  const initializedDiffRef = useRef<typeof diff>(null);

  const reviewsEnabled = !!info?.capabilities?.reviews;
  const sessionId = info?.sessionId ?? null;
  const canRevert = !!info?.capabilities?.revert;
  const { isStale, staleFiles, resetStaleness, acknowledgeFile } = useDiffStaleness(refParam, !!info?.capabilities?.staleness);
  const [githubDetails, setGithubDetails] = useState<GitHubDetails | null>(null);

  useEffect(() => {
    if (!info?.github) {
      return;
    }
    fetchGitHubDetails()
      .then(data => setGithubDetails(data))
      .catch(() => {});
  }, [info?.github]);

  const { data: serverThreads, isFetched: threadsFetched } = useReviewThreads(reviewsEnabled ? sessionId : null);
  const threads = reviewsEnabled && serverThreads ? serverThreads : [];
  const commentActions = useCommentActions(sessionId, reviewsEnabled);

  // Asking is a button on the comment box, not a mode: a mode you have to remember is a mode you
  // forget, and the first version of this answered three comments with silence because of it.
  const { data: liveStatus } = useQuery(liveStatusOptions(refParam));
  const canAsk = !!liveStatus?.enabled && reviewsEnabled;
  const askIsHeard = !!liveStatus?.listening;

  const handleAskReply = useCallback(
    (threadId: string, body: string, author: Parameters<typeof commentActions.addReply>[2]) =>
      commentActions.addReply(threadId, body, author, { aside: true, live: true }),
    [commentActions],
  );

  const handleAskThread = useCallback(
    (
      filePath: string,
      side: Parameters<typeof commentActions.addThread>[1],
      startLine: number,
      endLine: number,
      body: string,
      author: Parameters<typeof commentActions.addThread>[5],
    ) => commentActions.addThread(filePath, side, startLine, endLine, body, author, undefined, { aside: true, live: true }),
    [commentActions],
  );
  const commentCountsByFile = useMemo(() => buildThreadCountsByFile(threads), [threads]);

  const { data: tours } = useTours(reviewsEnabled ? sessionId : null);
  const activeTour = useMemo(() => pickActiveTour(tours), [tours]);
  const [reviewOrderEnabled, setReviewOrderEnabled] = useState(true);
  const [tourStepIndex, setTourStepIndex] = useState(TOUR_NOT_STARTED);

  const diffPaths = useMemo(() => (diff ? diff.files.map(file => getFilePath(file)) : []), [diff]);
  const tourStops = useMemo(() => stopsByPath(activeTour, diffPaths), [activeTour, diffPaths]);
  const activeStepIndex = clampTourStep(tourStepIndex, activeTour?.steps.length ?? 0);

  // A different walkthrough is a different reading order, so the position does not carry over.
  useEffect(() => {
    setTourStepIndex(TOUR_NOT_STARTED);
  }, [activeTour?.id]);

  // Naming the amount matters: a filtered diff disagrees with the forge's own counts, and after
  // the stale-base episode an unexplained disagreement is the last thing this page should show.
  const whitespaceNotice = useMemo(() => {
    if (!hideWhitespace) {
      return null;
    }
    const base = info?.description ?? '';
    const suppressed = (diff as { suppressed?: { files: number; lines: number } } | undefined)?.suppressed;
    if (!suppressed || (suppressed.files === 0 && suppressed.lines === 0)) {
      return `${base} · whitespace hidden`;
    }
    const parts: string[] = [];
    if (suppressed.files > 0) {
      parts.push(`${suppressed.files} file${suppressed.files === 1 ? '' : 's'}`);
    }
    if (suppressed.lines > 0) {
      parts.push(`${suppressed.lines} line${suppressed.lines === 1 ? '' : 's'}`);
    }
    return `${base} · whitespace hidden (${parts.join(', ')} suppressed)`;
  }, [hideWhitespace, info?.description, diff]);

  const tourMarksByFile = useMemo(() => marksByPath(tourMarks(activeTour)), [activeTour]);

  const focusRangesByFile = useMemo(() => {
    const ranges = new Map<string, TourFocusRange[]>();
    for (const [path, marks] of tourMarksByFile) {
      ranges.set(path, focusRangesFromMarks(marks));
    }
    return ranges;
  }, [tourMarksByFile]);

  const orderedDiff = useMemo(() => {
    if (!diff || !activeTour || !reviewOrderEnabled || activeTour.steps.length === 0) {
      return diff;
    }
    const order = orderPathsByTour(diffPaths, activeTour.steps.map(step => step.filePath));
    const byPath = new Map(diff.files.map(file => [getFilePath(file), file]));
    return { ...diff, files: order.map(path => byPath.get(path)!) };
  }, [diff, activeTour, reviewOrderEnabled, diffPaths]);

  const filesWithComments = useMemo(() => {
    return new Set(commentCountsByFile.keys());
  }, [commentCountsByFile]);

  const firstOpenThreadByFile = useMemo(() => {
    const fileOrder = diff?.files.map(file => getFilePath(file)) ?? [];
    return buildFirstOpenThreadByFile(threads, fileOrder);
  }, [diff, threads]);

  const handleAddThread = useCallback((...args: Parameters<typeof commentActions.addThread>) => {
    commentActions.addThread(...args);
    setPendingSelection(null);
  }, [commentActions]);

  const repoRoot = info?.root ?? null;
  const fileFingerprints = useMemo(() => (diff ? fingerprintFiles(diff.files) : {}), [diff]);

  useEffect(() => {
    if (!diff || diff === initializedDiffRef.current) {
      return;
    }
    initializedDiffRef.current = diff;

    const restoredViewed = repoRoot
      ? reconcileViewed(loadViewedFiles(repoRoot, refParam), fileFingerprints)
      : new Set<string>();
    setReviewedFiles(restoredViewed);

    const autoCollapsed = getAutoCollapsedPaths(diff.files);
    for (const path of filesWithComments) {
      autoCollapsed.delete(path);
    }
    for (const path of restoredViewed) {
      autoCollapsed.add(path);
    }
    for (const path of manuallyToggledRef.current) {
      if (autoCollapsed.has(path)) {
        autoCollapsed.delete(path);
      } else {
        autoCollapsed.add(path);
      }
    }
    setCollapsedFiles(autoCollapsed);
  }, [diff, fileFingerprints, repoRoot, refParam]);

  useEffect(() => {
    if (!repoRoot || !initializedDiffRef.current) {
      return;
    }
    saveViewedFiles(repoRoot, refParam, pickFingerprints(fileFingerprints, reviewedFiles));
  }, [reviewedFiles, fileFingerprints, repoRoot, refParam]);

  useEffect(() => {
    if (filesWithComments.size === 0) {
      return;
    }
    setCollapsedFiles((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const path of filesWithComments) {
        if (reviewedFiles.has(path)) {
          continue;
        }
        if (next.has(path)) {
          next.delete(path);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [filesWithComments, reviewedFiles]);

  const handleToggleCollapse = useCallback((path: string) => {
    const toggled = manuallyToggledRef.current;
    if (toggled.has(path)) {
      toggled.delete(path);
    } else {
      toggled.add(path);
    }
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  // A restart or a failed poll rebuilds this page from scratch. Without this the reader lands at
  // the top of the diff, which on a long review is worse than the interruption itself.
  const restoredPositionRef = useRef(false);
  useEffect(() => {
    if (restoredPositionRef.current || !orderedDiff || !repoRoot || typeof window === 'undefined') {
      return;
    }
    restoredPositionRef.current = true;
    const wasReading = readReadingPosition(window.localStorage, repoRoot, refParam ?? '');
    if (!wasReading || !orderedDiff.files.some(file => getFilePath(file) === wasReading)) {
      return;
    }
    setActiveFile(wasReading);
    requestAnimationFrame(() => diffViewRef.current?.scrollToFile(wasReading));
  }, [orderedDiff, repoRoot, refParam]);

  const handleReviewedChange = useCallback((path: string, reviewed: boolean) => {
    setReviewedFiles((prev) => {
      const next = new Set(prev);
      if (reviewed) {
        next.add(path);
      } else {
        next.delete(path);
      }
      return next;
    });
    if (reviewed) {
      // Measured before the collapse: afterwards the page is shorter, the browser may already have
      // clamped the scroll, and the file no longer looks like the one the reader was inside.
      const wasInsideFile = diffViewRef.current?.isScrolledInsideFile(path) ?? false;
      setCollapsedFiles((prev) => {
        const next = new Set(prev);
        next.add(path);
        return next;
      });
      // The header is sticky, so it was under the cursor when it was clicked. Put the collapsed
      // file back there rather than letting the page shorten under the reader.
      if (wasInsideFile) {
        requestAnimationFrame(() => diffViewRef.current?.scrollFileToTop(path));
      }
    } else {
      setCollapsedFiles((prev) => {
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
    }
  }, []);

  const getCurrentFilePath = useCallback((): string | null => {
    if (!orderedDiff) {
      return null;
    }
    return getFilePath(orderedDiff.files[currentFileIdx.current]);
  }, [orderedDiff]);

  const navigateFile = useCallback((direction: number) => {
    if (!orderedDiff) {
      return;
    }
    const nextIdx = Math.max(0, Math.min(orderedDiff.files.length - 1, currentFileIdx.current + direction));
    currentFileIdx.current = nextIdx;
    const path = getFilePath(orderedDiff.files[nextIdx]);
    diffViewRef.current?.scrollToFile(path);
  }, [orderedDiff]);

  const handleTourStepChange = useCallback((index: number) => {
    const steps = activeTour ? [...activeTour.steps].sort((a, b) => a.sortOrder - b.sortOrder) : [];
    if (steps.length === 0) {
      return;
    }
    const clamped = Math.max(0, Math.min(steps.length - 1, index));
    const step = steps[clamped];
    setTourStepIndex(clamped);
    setActiveFile(step.filePath);
    setCollapsedFiles((prev) => {
      if (!prev.has(step.filePath)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(step.filePath);
      return next;
    });
    diffViewRef.current?.scrollToLine(step.filePath, step.startLine);
  }, [activeTour]);

  const navigateHunk = useCallback((direction: number) => {
    const hunks = getHunkHeaders();
    if (hunks.length === 0) {
      return;
    }
    let target = direction > 0 ? hunks[0] : hunks[hunks.length - 1];

    for (let i = 0; i < hunks.length; i++) {
      const rect = hunks[i].getBoundingClientRect();
      if (direction > 0 && rect.top > 100) {
        target = hunks[i];
        break;
      }
      if (direction < 0 && rect.top < -10) {
        target = hunks[i];
      }
    }

    scrollToElement(target);
  }, []);

  useKeyboard({
    onNextFile: () => navigateFile(1),
    onPrevFile: () => navigateFile(-1),
    onNextHunk: () => navigateHunk(1),
    onPrevHunk: () => navigateHunk(-1),
    onToggleCollapse: () => {
      const path = getCurrentFilePath();
      if (path) {
        handleToggleCollapse(path);
      }
    },
    onCollapseAll: () => {
      if (!orderedDiff) {
        return;
      }
      const allPaths = orderedDiff.files.map((f) => getFilePath(f));
      const anyExpanded = allPaths.some((p) => !collapsedFiles.has(p));
      manuallyToggledRef.current = new Set();
      if (anyExpanded) {
        setCollapsedFiles(new Set(allPaths));
      } else {
        setCollapsedFiles(new Set());
      }
    },
    onToggleReviewed: () => {
      const path = getCurrentFilePath();
      if (!path) {
        return;
      }
      const wasReviewed = reviewedFiles.has(path);
      handleReviewedChange(path, !wasReviewed);
      if (!wasReviewed) {
        navigateFile(1);
      }
    },
    onUnifiedView: () => setViewMode('unified'),
    onSplitView: () => setViewMode('split'),
    onShowHelp: () => setShowHelp(true),
    onFocusSearch: () => {
      const input = document.querySelector(
        'input[placeholder="Filter files..."]',
      ) as HTMLInputElement;
      if (input) {
        input.focus();
      }
    },
    onEscape: () => setShowHelp(false),
  });

  const queryClient = useQueryClient();

  const handleRevert = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['diff'] });
  }, [queryClient]);

  // Reloading one file rather than the diff. Everything the reader has not asked about keeps its
  // object identity, so their collapse states, their place and the rest of the page are untouched.
  const handleRefreshFile = useCallback(async (path: string) => {
    const fresh = await fetchDiffFile(path, hideWhitespace, refParam);
    queryClient.setQueryData<ParsedDiff>(
      diffOptions(hideWhitespace, refParam).queryKey,
      current => (current ? patchDiffFile(current, path, fresh) : current),
    );
    acknowledgeFile(path);
  }, [hideWhitespace, refParam, queryClient, acknowledgeFile]);

  const handleRefreshDiff = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ['diff'] });
    resetStaleness();
  }, [queryClient, resetStaleness]);

  const handleSidebarFileClick = useCallback((path: string) => {
    setActiveFile(path);
    diffViewRef.current?.scrollToFile(path);
  }, []);

  const handleScrollToThread = useCallback((threadId: string, filePath: string) => {
    setActiveFile(filePath);
    setCollapsedFiles((prev) => {
      if (!prev.has(filePath)) {
        return prev;
      }
      const next = new Set(prev);
      next.delete(filePath);
      return next;
    });
    diffViewRef.current?.scrollToThread(threadId, filePath);
  }, []);

  const handleSidebarCommentedFileClick = useCallback((path: string) => {
    const threadId = firstOpenThreadByFile.get(path);
    if (!threadId) {
      handleSidebarFileClick(path);
      return;
    }
    handleScrollToThread(threadId, path);
  }, [firstOpenThreadByFile, handleSidebarFileClick, handleScrollToThread]);

  const handleActiveFileFromScroll = useCallback((path: string) => {
    setActiveFile(path);
    if (repoRoot && typeof window !== 'undefined') {
      writeReadingPosition(window.localStorage, repoRoot, refParam ?? '', path);
    }
  }, [repoRoot, refParam]);

  if (error) {
    return (
      <div className="flex flex-col min-h-screen bg-bg text-text font-sans">
        <div className="flex flex-col items-center justify-center p-12 text-deleted text-center">
          <h2 className="text-xl mb-2">Failed to load diff</h2>
          <p className="text-text-secondary">{error}</p>
        </div>
      </div>
    );
  }

  const threadsLoading = reviewsEnabled && !threadsFetched;
  if (threadsLoading) {
    return <PageLoader />;
  }

  if (diff.files.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-bg text-text font-sans gap-2">
        <div className="text-added opacity-40 mb-1">
          <CheckCircleIcon />
        </div>
        <h2 className="text-base font-medium text-text-secondary">No changes found</h2>
        <p className="text-xs text-text-muted">There are no differences to display.</p>
        <div className="mt-4 flex flex-col gap-1.5 items-center">
          <p className="text-xs text-text-muted mb-1">Try one of these</p>
          <code className="inline-block px-3 py-1 bg-bg-secondary border border-border rounded-md font-mono text-xs text-text">
            diffity HEAD~1
          </code>
          <code className="inline-block px-3 py-1 bg-bg-secondary border border-border rounded-md font-mono text-xs text-text">
            diffity main..feature
          </code>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-bg text-text font-sans">
      <Toolbar
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        hideWhitespace={hideWhitespace}
        onHideWhitespaceChange={setHideWhitespace}
        theme={theme}
        onToggleTheme={toggleTheme}
        wrapLines={wrapLines}
        onToggleWrapLines={toggleWrapLines}
        onShowHelp={() => setShowHelp(true)}
        diff={diff || undefined}
        diffRef={refParam}
        threads={threads}
        onDeleteAllComments={commentActions.deleteAllThreads}
        onScrollToThread={handleScrollToThread}
        repoName={info?.name || null}
        branch={info?.branch || null}
        description={whitespaceNotice ?? info?.description ?? null}
        githubDetails={githubDetails}
        reviewInProgress={!!info?.review?.inProgress}
        live={liveStatus}
        sessionId={sessionId}
        onGitHubPulled={() => queryClient.invalidateQueries({ queryKey: ['threads'] })}
      />
      {isStale && <StaleDiffBanner onRefresh={handleRefreshDiff} message={staleMessage(staleFiles)} />}
      <PullRequestPanel details={githubDetails} hasPullRequest={!!info?.github} repoRoot={repoRoot} />
      {info?.review?.inProgress && (
        <ReviewProgressBanner review={info.review} findings={threads.length} />
      )}
      {activeTour && (
        <TourStepper
          tour={activeTour}
          stepIndex={activeStepIndex}
          onStepChange={handleTourStepChange}
        />
      )}
      <div className="flex flex-1 overflow-hidden">
        <Sidebar
          files={orderedDiff?.files || []}
          activeFile={activeFile}
          reviewedFiles={reviewedFiles}
          commentCountsByFile={commentCountsByFile}
          onFileClick={handleSidebarFileClick}
          onCommentedFileClick={handleSidebarCommentedFileClick}
          reviewOrder={
            activeTour && activeTour.steps.length > 0
              ? {
                  stops: tourStops,
                  enabled: reviewOrderEnabled,
                  onToggle: () => setReviewOrderEnabled(prev => !prev),
                }
              : undefined
          }
        />
        {orderedDiff ? (
          <DiffView
            diff={orderedDiff}
            viewMode={viewMode}
            theme={theme}
            collapsedFiles={collapsedFiles}
            onToggleCollapse={handleToggleCollapse}
            reviewedFiles={reviewedFiles}
            onReviewedChange={handleReviewedChange}
            onActiveFileChange={handleActiveFileFromScroll}
            handle={diffViewRef}
            baseRef={refParam}
            canRevert={canRevert}
            onRevert={handleRevert}
            scrollRef={(node) => {
              mainRef.current = node;
            }}
            threads={threads}
            commentsEnabled={reviewsEnabled}
            commentActions={commentActions}
            onAddThread={handleAddThread}
            pendingSelection={pendingSelection}
            onPendingSelectionChange={setPendingSelection}
            focusRangesByFile={focusRangesByFile}
            staleFiles={staleFiles}
            onRefreshFile={handleRefreshFile}
            onAskThread={canAsk ? handleAskThread : undefined}
            onAskReply={canAsk ? handleAskReply : undefined}
            askIsHeard={askIsHeard}
            tourMarksByFile={tourMarksByFile}
            activeStepIndex={activeStepIndex}
            onTourMarkClick={handleTourStepChange}
          />
        ) : null}
      </div>
      {showHelp && <ShortcutModal onClose={() => setShowHelp(false)} />}
    </div>
  );
}
