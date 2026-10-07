import { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { useLoaderData } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useDiff } from '../../hooks/use-diff';
import { useInfo, useRequestReview } from '../../hooks/use-info';
import { useTheme } from '../../hooks/use-theme';
import { useWrapLines } from '../../hooks/use-wrap-lines';
import { useKeyboard } from '../../hooks/use-keyboard';
import { useReviewThreads } from '../../hooks/use-review-threads';
import { useTours } from '../../hooks/use-tours';
import { useHeld, useReviewArrival } from '../../hooks/use-review-arrival';
import { useHideWhitespace } from '../../hooks/use-hide-whitespace';
import { pickActiveTour, orderPathsByTour, stopsByPath } from '../../lib/tour-order';
import { TOUR_NOT_STARTED, clampTourStep } from '../../lib/tour-navigation';
import { readReadingPosition, writeReadingPosition } from '../../lib/reading-position';
import { tourMarks, marksByPath, focusRangesFromMarks, type TourFocusRange } from '../../lib/tour-marks';
import { TourStepper } from './tour-stepper';
import { useCommentActions } from '../../hooks/use-comment-actions';
import { Toolbar } from '../layout/toolbar';
import { DiffView, type DiffViewHandle } from './diff-view';
import { Sidebar } from '../layout/sidebar';
import { ShortcutModal } from '../layout/shortcut-modal';
import { ReviewBanner } from '../layout/review-banner';
import { PullRequestPanel } from '../layout/pull-request-panel';
import { CheckCircleIcon } from '../icons/check-circle-icon';
import { PageLoader } from '../layout/skeleton';
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
import { liveStatusOptions } from '../../queries/live';
import { AgentListeningContext } from '../../lib/agent-listening';

export function DiffPage() {
  const { theme: initialTheme, view: initialViewMode } = useLoaderData<{
    theme: 'light' | 'dark' | null;
    view: 'split' | 'unified' | null;
  }>();

  const [viewMode, setViewMode] = useState<ViewMode>(initialViewMode || 'split');
  const { hideWhitespace, setHideWhitespace } = useHideWhitespace();
  const [showHelp, setShowHelp] = useState(false);
  const { theme, toggleTheme } = useTheme(initialTheme);
  const { wrapLines, toggleWrapLines } = useWrapLines();
  const { data: diff, error } = useDiff(hideWhitespace);
  const { data: info } = useInfo();
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [reviewedFiles, setReviewedFiles] = useState<Set<string>>(new Set());
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(new Set());
  const manuallyToggledRef = useRef<Set<string>>(new Set());
  const [pendingSelection, setPendingSelection] = useState<LineSelection | null>(null);
  const diffViewRef = useRef<DiffViewHandle>(null);
  const currentFileIdx = useRef(0);
  const initializedDiffRef = useRef<typeof diff>(null);

  const sessionId = info?.sessionId ?? null;
  const reviewsEnabled = sessionId !== null;
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
  const liveStatus = useQuery(liveStatusOptions(sessionId)).data;
  const agentListening = !!liveStatus?.listening;
  const requestReview = useRequestReview();

  const commentCountsByFile = useMemo(() => buildThreadCountsByFile(threads), [threads]);

  const arrival = useReviewArrival(info?.review?.state ?? 'none');
  const { data: liveTours } = useTours(reviewsEnabled ? sessionId : null);
  // A review's reading order arrives while it is written; it is applied when the reader reloads.
  const tours = useHeld(liveTours, arrival.watching);
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

  // A filtered diff disagrees with the forge's own counts, so the page names the difference.
  const whitespaceNotice = useMemo(() => {
    if (!hideWhitespace) {
      return null;
    }
    const base = info?.description ?? '';
    const suppressed = diff?.suppressed;
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
  const branch = info?.branch ?? '';
  const fileFingerprints = useMemo(() => (diff ? fingerprintFiles(diff.files) : {}), [diff]);

  useEffect(() => {
    if (!diff || diff === initializedDiffRef.current) {
      return;
    }
    initializedDiffRef.current = diff;

    const restoredViewed = repoRoot
      ? reconcileViewed(loadViewedFiles(repoRoot, branch), fileFingerprints)
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
  }, [diff, fileFingerprints, repoRoot, branch]);

  useEffect(() => {
    if (!repoRoot || !initializedDiffRef.current) {
      return;
    }
    saveViewedFiles(repoRoot, branch, pickFingerprints(fileFingerprints, reviewedFiles));
  }, [reviewedFiles, fileFingerprints, repoRoot, branch]);

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
    const wasReading = readReadingPosition(window.localStorage, repoRoot, branch);
    if (!wasReading || !orderedDiff.files.some(file => getFilePath(file) === wasReading)) {
      restoredPositionRef.current = true;
      return;
    }

    // The diff view mounts after this runs, and a single frame was not enough — the scroll went
    // nowhere and the reader was left at the top of the diff, which is where the general comments
    // are. Keep asking until the handle exists, then give up rather than spin.
    let attempts = 0;
    let frame = requestAnimationFrame(function restore() {
      if (diffViewRef.current) {
        restoredPositionRef.current = true;
        setActiveFile(wasReading);
        diffViewRef.current.scrollToFile(wasReading);
        return;
      }
      if (attempts++ > 60) {
        restoredPositionRef.current = true;
        return;
      }
      frame = requestAnimationFrame(restore);
    });

    return () => cancelAnimationFrame(frame);
  }, [orderedDiff, repoRoot, branch]);

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
      writeReadingPosition(window.localStorage, repoRoot, branch, path);
    }
  }, [repoRoot, branch]);

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
      </div>
    );
  }

  return (
    <AgentListeningContext.Provider value={agentListening}>
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
          threads={threads}
          onDeleteAllComments={commentActions.deleteAllThreads}
          onScrollToThread={handleScrollToThread}
          repoName={info?.name || null}
          branch={info?.branch || null}
          description={whitespaceNotice ?? info?.description ?? null}
          githubDetails={githubDetails}
          reviewInProgress={info?.review?.state === 'reviewing'}
          agentListening={agentListening}
          agentWorking={liveStatus?.working ?? 0}
          sessionId={sessionId}
          onGitHubPulled={() => queryClient.invalidateQueries({ queryKey: ['threads'] })}
        />
        <PullRequestPanel details={githubDetails} hasPullRequest={!!info?.github} repoRoot={repoRoot} />
        {info?.review && (
          <ReviewBanner
            review={info.review}
            findings={threads.length}
            ready={arrival.ready}
            onReload={arrival.reload}
            agentListening={agentListening}
            onRequestReview={() => requestReview.mutate()}
          />
        )}
        {activeTour && (
          <TourStepper
            tour={activeTour}
            stepIndex={activeStepIndex}
            onStepChange={handleTourStepChange}
          />
        )}
        <div className="relative flex flex-1 overflow-hidden">
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
          <div className="relative flex flex-1 min-w-0">
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
              threads={threads}
              commentsEnabled={reviewsEnabled}
              commentActions={commentActions}
              onAddThread={handleAddThread}
              pendingSelection={pendingSelection}
              onPendingSelectionChange={setPendingSelection}
              focusRangesByFile={focusRangesByFile}
              tourMarksByFile={tourMarksByFile}
              activeStepIndex={activeStepIndex}
              onTourMarkClick={handleTourStepChange}
            />
          ) : null}
          </div>
        </div>
        {showHelp && <ShortcutModal onClose={() => setShowHelp(false)} />}
      </div>
    </AgentListeningContext.Provider>
  );
}
