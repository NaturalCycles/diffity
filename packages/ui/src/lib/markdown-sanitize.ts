import { defaultSchema } from 'rehype-sanitize';

/**
 * rehype-raw turns a repository's own markdown into live HTML, so it has to be sanitized: a
 * README in a pull request could otherwise script, iframe or beacon out of this origin.
 *
 * The default schema is GitHub's own, which keeps `class="language-…"` on `code` — the pre
 * renderer reads it to pick a highlighter.
 */
export const markdownSanitizeSchema: typeof defaultSchema = defaultSchema;
