/** Sub-pixel scroll offsets are not "scrolled into the file". */
const TOLERANCE = 1;

/**
 * Whether the reader is somewhere inside the file rather than looking at its header. The header is
 * sticky, so it sits at the top of the container either way — but collapsing a file the reader has
 * scrolled into shortens the page above them and leaves them among files they had already read.
 */
export function isScrolledPastFileTop(fileTop: number, containerTop: number): boolean {
  return fileTop < containerTop - TOLERANCE;
}
