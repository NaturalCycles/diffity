let signedOut = false;
let reloaded = false;
const listeners = new Set<() => void>();

export function isSignedOut(): boolean {
  return signedOut;
}

export function markSignedOut(): void {
  if (signedOut) {
    return;
  }
  signedOut = true;
  for (const listener of listeners) {
    listener();
  }
}

export function subscribeSignedOut(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export interface PageState {
  visible: boolean;
  /** Something the reader typed that a reload would throw away. */
  hasDraft: boolean;
  editing: boolean;
}

export function shouldAutoReload(state: PageState, alreadyReloaded: boolean): boolean {
  return !alreadyReloaded && state.visible && !state.hasDraft && !state.editing;
}

const TEXT_INPUT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number']);

export function readPageState(doc: Document = document): PageState {
  const fields = [
    ...doc.querySelectorAll('textarea'),
    ...[...doc.querySelectorAll('input')].filter(input => TEXT_INPUT_TYPES.has(input.getAttribute('type')?.toLowerCase() ?? '')),
  ];
  const active = doc.activeElement;
  const editing = active instanceof HTMLElement
    && (active.isContentEditable || active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement);
  return {
    visible: doc.visibilityState === 'visible',
    hasDraft: fields.some(field => field.value.trim() !== ''),
    editing,
  };
}

/**
 * An expired IAP sign-in can only be renewed by loading the page again. Does that once per page load, and
 * only when nothing the reader is in the middle of would be lost.
 */
export function reloadIfSafe(reload: () => void = () => window.location.reload(), state: PageState = readPageState()): boolean {
  if (!shouldAutoReload(state, reloaded)) {
    return false;
  }
  reloaded = true;
  reload();
  return true;
}

export function resetSignInForTests(): void {
  signedOut = false;
  reloaded = false;
  listeners.clear();
}
