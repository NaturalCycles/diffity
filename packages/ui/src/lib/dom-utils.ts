import type { Bounds } from './thread-visibility';
export function getFileBlocks(): HTMLElement[] {
  return Array.from(document.querySelectorAll('[id^="file-"]'));
}

export function getHunkHeaders(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll('tbody > tr:first-child')
  );
}

export function scrollToElement(el: HTMLElement) {
  el.scrollIntoView({ behavior: 'instant', block: 'start' });
}

/**
 * Where a thread sits relative to the scroll container, or null if it is not rendered — a collapsed
 * or virtualised-away file. The container rather than the window, because the diff scrolls inside it.
 */
export function threadBounds(threadId: string): { thread: Bounds; viewport: Bounds } | null {
  const element = document.querySelector(`[data-thread-id="${threadId}"]`);
  const container = document.querySelector('main.overflow-y-auto');
  if (!element || !container) {
    return null;
  }
  const thread = element.getBoundingClientRect();
  const viewport = container.getBoundingClientRect();
  return {
    thread: { top: thread.top, bottom: thread.bottom },
    viewport: { top: viewport.top, bottom: viewport.bottom },
  };
}
