# Fork ledger

What this fork changes relative to [nilbuild/diffity](https://github.com/nilbuild/diffity).

**This is no longer aimed at upstream.** Decided 2026-08-28: upstream has pull requests sitting
uncommented since May, and this fork has diverged past the point where a pointed patch would still
apply — the review loop, the live agent protocol, session carry-forward and the idle lifecycle are
all ours. The record below stays because it explains where the code came from and why the
arrangement is what it is, not because anything is queued to be offered.

What that changes in practice: keeping a thing because it might be upstreamable is no longer a
reason. Judge it on whether this fork uses it.

## How this fork is arranged

- **`main`** is a pristine mirror of `upstream/main`. Upstream updates land here first
  (`git merge upstream/main`), then flow to `develop`. Nothing is committed to it directly.
- **`develop`** is the default branch and the working version — what the `diffity` on PATH is built
  from. The worktree at `~/nc/diffity-fork/diffity` stays parked on it; feature work happens in a
  second worktree so switching branches cannot rebuild the tool while someone is using it.
- **Squash merge only**, through a pull request, matching the other NaturalCycles repositories.
  Nothing is merged into `develop` locally. After a squash lands, a local `develop` is refreshed with
  `git fetch && git reset --hard origin/develop` rather than merged — the branch commits are not its
  ancestors.
- **The squashed commit is the extraction unit.** One commit per concern, so offering a change
  upstream is `git show <sha>` rather than a branch diff. Head branches are deleted on merge, which
  is fine for that reason; the table below records the commit each change landed as.

Everything up to and including PR #24 was merged with merge commits, before this arrangement — that
part of the history is mixed, and those branches still exist.

The `Fork-local` section below predates the decision above; with upstream retired the distinction
it drew no longer does any work.

## Upstream pull requests merged in

Merged unmodified, so they can simply be dropped once upstream lands them.

| Fork PR | Upstream | Author | What |
| --- | --- | --- | --- |
| #1 | [#30](https://github.com/nilbuild/diffity/pull/30) | @kleinjm | `cleanManagedSkills`, so the build stops wiping `~/.claude/skills` |
| #2 | [#32](https://github.com/nilbuild/diffity/pull/32) | @sdirix | `better-sqlite3` → built-in `node:sqlite` |
| #3 | [#31](https://github.com/nilbuild/diffity/pull/31) | @sdirix | neutralize git config that corrupts diff parsing |
| #3 | [#26](https://github.com/nilbuild/diffity/pull/26) | @stuartsaunders | exclude untracked files from ref-range diffs |
| #3 | [#36](https://github.com/nilbuild/diffity/pull/36) | @gustavo-depaula | ENOBUFS on `git ls-files` in large repositories |
| #4 | [#33](https://github.com/nilbuild/diffity/pull/33) | @antoniocapelo | wrap-lines toggle, sticky file header |
| #4 | [#35](https://github.com/nilbuild/diffity/pull/35) | @adamward459 | viewed-file state persisted across reloads |

[#21](https://github.com/nilbuild/diffity/pull/21) was deliberately **not** taken: #31 covers the
same `--no-ext-diff` more broadly, and the two call sites #21 additionally covered are handled in
our own change on #3.

## Ours (was: offerable upstream)

| Fork PR | Branch | Base | What | Notes for upstreaming |
| --- | --- | --- | --- | --- |
| #1 | `fix-build-skills-wipe` | `main` | `dev.ts` wiped `~/.claude/skills` on SIGINT too; `DIFFITY_SKIP_DEV_SKILLS`; regression test; root `test:scripts` | Offer as a follow-up **to #30**, whose author fixed only the `build-skills.ts` half |
| #3 | `upstream-git-fixes` | `node-sqlite` | applies #31's `DIFF_FORMAT_ARGS` to `--name-only` and `--stat` too, where `color.ui=always` injected ANSI into parsed file names | Offer as a review comment on #31 |
| #5 | `bind-loopback` | `upstream-ui` | server bound the wildcard interface with `ACAO: *` and no auth. `DIFFITY_BIND` (default loopback), CORS headers removed, writes require same-origin, `nosniff` | Independent; the strongest single fix |
| #6 | `pr-base-oid` | `bind-loopback` | PR diffs used the base branch *name* against the stale local branch. Uses `baseRefOid`. `vitest` wired for `@diffity/github` | Independent |
| #7 | `theme-system-default` | `pr-base-oid` | theme falls back to `prefers-color-scheme` and follows it until the reader chooses | Independent |
| #8 | `ref-upstream` | `theme-system-default` | a bare local branch name that is behind its upstream resolves to the upstream; adds argv-form `git()` | Independent |
| #9 | `pin-pr-ref` | `ref-upstream` | a `/diff` request whose `ref` disagrees with the PR base is redirected to it | Depends on #6 |
| #10 | `argv-git` | `pin-pr-ref` | every git call in `@diffity/git` goes through argv instead of `/bin/sh -c`; a PR file named `evil$(…)` executed on open | Independent of #8 in intent, but touches the same helper |
| #11 | `path-containment` | `argv-git` | percent-encoded `../` in `/api/tree/…` read any file; `resolveInRepo` plus inert raw responses | Independent |
| #12 | `sanitize-markdown` | `path-containment` | `rehype-raw` had no sanitizer; adds `rehype-sanitize` and a CSP; widens the UI vitest include to `.tsx` | Independent |
| #14 | `diff-walkthrough` | `sanitize-markdown` | the diff page reads the session's tour and reorders the file list by it; flat numbered sidebar, stepper, order-aware keyboard navigation; review tours hand off to `/diff` | Independent, and the feature this fork exists for — offer it once it has been lived with |
| #15 | `batched-review` | `diff-walkthrough` | one `POST /pulls/:n/reviews` instead of N comment posts; per-comment selection, folded replies, general comments seed the summary, event choice disabled on own PR | Independent; removes `pushComments` |
| #16 | `project-data-dir` | `batched-review` | `DIFFITY_DATA_DIR` / `dataDir` in `.diffity.json` chooses where review notes live; warns when they sit un-ignored inside the working tree; 0600/0700 permissions (audit P2-4) | Independent |
| #17 | `session-continuity` | `project-data-dir` | open threads and walkthroughs follow the session when HEAD moves, instead of being stranded in the old one | Independent, and required for reviewing your own change |
| #18 | `reanchor` | `session-continuity` | `agent comment` records `anchor_content`, and carrying a session forward moves each open thread to where its code went | Depends on #17 |
| #19 | `review-standards` | `reanchor` | `review.severities` and `review.standards` in `.diffity.json`, `agent standards` to read them, and the review skill reads them first and records a reading order | Independent |
| #20 | `repo-flag` | `review-standards` | `--repo <path>` for when the working directory is not the repository; skills look one level down and ask when ambiguous; a bare review reviews the branch's pull request rather than an empty working tree | Independent |
| #21 | `dev-skill-sync-opt-in` | `repo-flag` | a build no longer writes `diffity-dev-*` into `~/.claude/skills` unless `DIFFITY_SYNC_DEV_SKILLS=1` | Independent; the root cause behind #1 |
| #22 | `attention` | `dev-skill-sync-opt-in` | walkthrough line ranges highlight; rule-decided dimming of imports/whitespace/generated hunks, never model-decided; whitespace hiding on by default with disclosure; jsdom component tests | Independent |
| #23 | `review-progress` | `attention` | `agent review-start`/`review-done`, a banner while a review runs and a submit guard; stale-session resolution; head-aware staleness; merged-PR checkout fallback | Independent |
| #24 | `pr-context` | `review-progress` | the pull request's description and existing reviews shown above the diff; a bare verdict may be submitted; details resolve by PR number so a detached checkout still works | Independent |
| — | `shift-select` | `develop` | shift-click a second line to comment on the span, in both renderers | Independent |
| — | `thread-anchoring` | `develop` | a comment whose range runs past the rendered lines attaches to the last one that exists instead of vanishing; `agent comment` trims a range to the file | Independent |
| — | `review-fixes` | `develop` | acted on the self-review: session repo identity, ambiguous re-anchoring refused, ordered whitespace comparison, ref-only staleness, whitespace suppression counts, positional dedupe, comment lines validated before submitting | Independent |
| — | `security-and-coverage` | `develop` | argv-form `gh` with validated owner/repo, anchored remote parsing, `gh pr view` pinned to the local remote, `ls-files --`, `--ignore-scripts` on update, `link-dev` prints instead of editing a profile, no duplicate browser tab, HTTP-level route tests | Independent |

Branches after #24 were merged straight into `develop` rather than through a pull request.

## Known and not yet done

- A submitted thread is not marked as submitted. After a review goes out, its threads are still
  `open` locally with nothing to say they are already on the pull request. `isAlreadyCommented`
  stops a duplicate from being posted, but only by trying — the dialog should show which findings
  have already left the machine.
- There is no way to delete or replace a walkthrough. `agent tour-*` can only add, and the newest
  silently wins, so an agent that gets one wrong leaves the wrong one in the database.
- Hash-based `script-src`, computed from `index.html` at server start, would remove the
  `'unsafe-inline'` caveat in the CSP. The sanitizer is what keeps injected script out of the DOM
  in the meantime.
- Re-anchoring matches lines exactly and refuses an ambiguous short anchor, so a finding whose code
  was *edited* keeps its old position. Anything fuzzier risks moving a comment onto code it was not
  written about.
- The reviews API cannot reply into an *existing* forge thread; that needs `in_reply_to` on the
  comments endpoint.
- A review's summary has no configurable default signature.
- `npm run typecheck -w @diffity/ui` reports four `TS6059` errors, present on upstream `main` too:
  `tsconfig.json` includes `.react-router/types/**` while `rootDir` is `src`. Not wired into
  `npm test`, so it fails silently.
- PR mode trusts `gh pr checkout` to bring a branch current, and it has been observed reporting
  "already up to date" against a stale `origin/<branch>`. A `git fetch` of the head ref before
  checkout would settle it.
- `server.ts` now has HTTP-level tests covering the security surface and the diff routes, but the
  forge routes (`/api/github/*`) are still only exercised by hand.

### Exercised for real

`createReview` submitted its first review on 2026-08-21 (NCBackend3#14378): one `COMMENTED`
review, an edited summary as the body, two inline comments with their multi-line ranges intact
(`start_line` 62, `line` 66), markdown preserved, and the deselected findings correctly absent.

### Done since the audit

Every P1 and P2 from the security review is closed: loopback bind and no CORS wildcard, argv-form
git *and* `gh` with validated owner/repo, anchored remote parsing, path containment with inert raw
responses, sanitized markdown behind a CSP, 0600/0700 data files, `gh pr view` pinned to the local
remote so a fork cannot be aimed at its parent, `ls-files --`, `--ignore-scripts` on update, and
`link-dev` no longer editing a shell profile.

## Queued

- **Move detection** — verbatim moves dim, moved-and-edited highlight, with a nested diff of the
  move. The remaining half of the attention work, and the bigger prize.
- **Configurable repo resolution** — `clone` / `worktree` strategies, so a colleague's pull request
  can be reviewed from a directory that has no checkout at all. `--repo` covers "the repository is
  a subdirectory"; this covers "there is no repository yet", which is the reviewer lane.
- **A user-level config** (`~/.config/diffity/config.json`, lowest precedence) so `severities` and
  `standards` need not be committed to every repository being reviewed.
- **`scrollToLine`** so the walkthrough stepper lands on a stop's lines rather than the top of its
  file. There are no per-line DOM anchors yet, so this is a real change.
- **`diffity review <pr-url>` as one command** with the agent's progress shown in the page. The
  own-PR loop no longer needs it; reviewing someone else's still starts with two commands.

### Lessons paid for

- `vite build` does not typecheck, and nothing executed a component until the jsdom harness, so
  three render-time crashes reached the browser. Scripted edits to TSX must assert that they
  applied — counting occurrences is not proof — and a typecheck filtered through
  `grep … || echo clean` can report success while errors exist.
- **A schema addition needs a migration test, not just a migration.** Adding `repo_root` to
  sessions was three lines; keeping the existing findings visible was fifteen, and skipping them
  stranded every thread in the database until a legacy session was adopted instead of abandoned.
- A test that has never been seen to fail proves nothing. The security assertions in
  `server-routes.test.ts` were mutation-checked: dropping `'wasm-unsafe-eval'` and loosening
  `frame-src` must turn them red.
- Verify what a command *stored*, not what it *reported*. The first range clamp printed a
  reassuring warning and still wrote 25-27 on a 26-line file, because a trailing newline counts as
  a line in `split('\n')`.

### Fixed, not queued

- **Syntax highlighting** stopped working because the CSP added in #12 omitted
  `'wasm-unsafe-eval'`, and shiki compiles an oniguruma WebAssembly module. Fixed on
  `sanitize-markdown` and merged through the stack.

## Fork-local, do not upstream

Nothing yet. Expected to land here: configurable repo resolution (clone/worktree strategies for
reviewing a PR from outside its checkout), a severity vocabulary, and a configurable review
signature.
