import { queryOptions } from '@tanstack/react-query';
import { fetchTreePaths, fetchTreeEntries, fetchTreeInfo, fetchTreeFileContent, fetchTour } from '../lib/api';

export function treePathsOptions() {
  return queryOptions({
    queryKey: ['tree-paths'],
    queryFn: () => fetchTreePaths(),
    staleTime: 60_000,
  });
}

export function treeEntriesOptions(dirPath?: string) {
  return queryOptions({
    queryKey: ['tree-entries', dirPath ?? null],
    queryFn: () => fetchTreeEntries(dirPath),
    staleTime: 30_000,
  });
}

export function treeInfoOptions() {
  return queryOptions({
    queryKey: ['tree-info'],
    queryFn: () => fetchTreeInfo(),
    staleTime: 60_000,
  });
}

export function treeFileContentOptions(filePath: string) {
  return queryOptions({
    queryKey: ['tree-file-content', filePath],
    queryFn: () => fetchTreeFileContent(filePath),
    staleTime: 30_000,
  });
}

export function tourOptions(tourId: string) {
  return queryOptions({
    queryKey: ['tour', tourId],
    queryFn: () => fetchTour(tourId),
    // An agent adds steps while the page is open, and the server follows the reader by
    // this poll — a focus-refetch of the tree chrome would otherwise steer it away for good.
    refetchInterval: 3000,
  });
}
