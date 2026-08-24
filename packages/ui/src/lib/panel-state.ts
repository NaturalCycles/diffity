/**
 * Whether a collapsible panel is open, remembered across mounts. The pull request panel arrives
 * after first paint and mounts again whenever the page's queries are rebuilt — a server restart
 * will do it — and without this it springs open each time, undoing a reader who had closed it.
 */
export function panelStateKey(panel: string, repoRoot: string): string {
  return `diffity:panel:${panel}:${repoRoot}`;
}

export function readPanelOpen(storage: Storage, panel: string, repoRoot: string): boolean {
  return storage.getItem(panelStateKey(panel, repoRoot)) !== 'closed';
}

export function writePanelOpen(storage: Storage, panel: string, repoRoot: string, open: boolean): void {
  if (open) {
    storage.removeItem(panelStateKey(panel, repoRoot));
    return;
  }
  storage.setItem(panelStateKey(panel, repoRoot), 'closed');
}
