import type { CommentSide, CommentThread } from '../components/comments/types';
import { GENERAL_THREAD_FILE_PATH, isThreadResolved } from '../components/comments/types';

export function getUnresolvedFileThreads(threads: CommentThread[]): CommentThread[] {
  return threads.filter(
    thread => !isThreadResolved(thread) && thread.filePath !== GENERAL_THREAD_FILE_PATH,
  );
}

export function buildThreadCountsByFile(threads: CommentThread[]): Map<string, number> {
  const counts = new Map<string, number>();

  for (const thread of getUnresolvedFileThreads(threads)) {
    counts.set(thread.filePath, (counts.get(thread.filePath) ?? 0) + 1);
  }

  return counts;
}

function sortThreadsForNavigation(
  threads: CommentThread[],
  fileOrder: string[],
): CommentThread[] {
  const orderIndex = new Map(fileOrder.map((path, index) => [path, index]));

  return [...getUnresolvedFileThreads(threads)].sort((a, b) => {
    const aOrder = orderIndex.get(a.filePath) ?? Number.MAX_SAFE_INTEGER;
    const bOrder = orderIndex.get(b.filePath) ?? Number.MAX_SAFE_INTEGER;

    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    if (a.filePath !== b.filePath) {
      return a.filePath.localeCompare(b.filePath);
    }
    if (a.startLine !== b.startLine) {
      return a.startLine - b.startLine;
    }
    if (a.endLine !== b.endLine) {
      return a.endLine - b.endLine;
    }

    return a.id.localeCompare(b.id);
  });
}

export function buildFirstOpenThreadByFile(
  threads: CommentThread[],
  fileOrder: string[],
): Map<string, string> {
  const firstThreadByFile = new Map<string, string>();

  for (const thread of sortThreadsForNavigation(threads, fileOrder)) {
    if (!firstThreadByFile.has(thread.filePath)) {
      firstThreadByFile.set(thread.filePath, thread.id);
    }
  }

  return firstThreadByFile;
}
