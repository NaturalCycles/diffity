export interface Bounds {
  top: number;
  bottom: number;
}

export type ThreadPosition = 'above' | 'on-screen' | 'below';

/**
 * Where a thread sits relative to what the reader can see. Partly visible counts as visible: they
 * can see the reply, so announcing it would be noise.
 *
 * Null when the thread is not rendered at all — a collapsed or virtualised-away file — which is not
 * the same as being off screen in a direction.
 */
export function whereIsThread(thread: Bounds | null, viewport: Bounds): ThreadPosition | null {
  if (!thread) {
    return null;
  }
  if (thread.bottom <= viewport.top) {
    return 'above';
  }
  if (thread.top >= viewport.bottom) {
    return 'below';
  }
  return 'on-screen';
}
