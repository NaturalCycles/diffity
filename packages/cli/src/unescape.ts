/**
 * Undo the escaping a shell string picks up on its way in.
 *
 * An agent building a `--body "..."` argument escapes backticks and quotes, and those backslashes
 * survive into the text, where markdown reads them as escapes and stops formatting.
 *
 * Only ever apply this to text that came through a shell. It is lossy in the other direction: a
 * comment discussing `split('\n')` has that turned into a real line break, so text typed into the
 * page must reach the database exactly as written.
 */
export function unescapeMarkdown(text: string): string {
  return text
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\`/g, '`')
    .replace(/\\"/g, '"');
}
