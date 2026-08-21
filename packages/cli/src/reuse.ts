/**
 * A second invocation for an instance that is already serving the same diff should not spawn
 * another browser tab: the view the caller wants is already on screen. A different ref is a
 * different view, so that one opens.
 */
export function shouldOpenExisting(input: {
  existingRef: string | undefined;
  requestedRef: string;
  openFlag: boolean;
}): boolean {
  if (!input.openFlag) {
    return false;
  }
  return input.existingRef !== input.requestedRef;
}
