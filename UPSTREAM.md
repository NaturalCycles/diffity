# Fork ledger

What this fork changes relative to [nilbuild/diffity](https://github.com/nilbuild/diffity), so any
of it can be extracted as a pointed upstream pull request later.

Every branch below is a **single concern** and they are **stacked** in the order listed, each based
on the previous. To extract one as a standalone patch against upstream:

```bash
git diff <its-base-branch>..<its-branch>
```

Nothing here is NaturalCycles-specific yet — all of it is upstreamable as-is. When that changes,
fork-local work goes in its own section below so it never lands in an upstream patch by accident.

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

## Ours, offerable upstream

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

## Known and not yet done

From the security audit, in rough priority order:

- `packages/github` still interpolates `owner`/`repo` into `gh api …` shell strings, and neither is
  validated. Delivery path is a submodule's attacker-controlled `.gitmodules` URL. (audit P2-1)
- `detectRemote()` reads only `origin` while `gh pr view` resolves a fork's **parent**, so in a
  fork workflow a review can be pushed to the wrong repository. (audit P2-2)
- `detection.ts`'s remote regex is an unanchored substring match on `github.com`. (audit P3)
- `git ls-files` in `tree.ts` has no `--` before its path arguments, so `?path=-x` is read as an
  option. (audit P3)
- `update.ts` runs an unpinned `npm install -g` with install scripts enabled. (audit P3)
- `link-dev.ts` appends a `PATH` line to `~/.bashrc` from `npm run dev`. Should print it instead.
- Hash-based `script-src`, computed from `index.html` at server start, would remove the
  `'unsafe-inline'` caveat in #12.
- `DiffViewHandle` exposes only `scrollToFile`, so the walkthrough stepper cannot scroll to a
  stop's line, and a stop's line range is not highlighted in the diff.
- Re-anchoring (#18) matches lines exactly, so a finding whose code was *edited* rather than moved
  keeps its old position. Anything fuzzier risks moving a comment onto code it was not written about.
- A review's summary has no configurable default signature.
- The reviews API cannot reply into an *existing* GitHub thread; that needs `in_reply_to` on the
  comments endpoint.
- `npm run typecheck -w @diffity/ui` reports four `TS6059` errors on upstream `main` as well:
  `tsconfig.json` includes `.react-router/types/**` while `rootDir` is `src`. Not wired into
  `npm test`, so it fails silently.

## Queued

- **`diffity review <pr-url>` as one command** with the agent's progress shown in the page. The
  own-PR loop no longer needs it — the coding agent drives `agent comment` itself — but reviewing
  *someone else's* PR still starts with two commands.
- **Configurable repo resolution** — `clone` / `worktree` strategies, so a colleague's PR can be
  reviewed from a directory that has no checkout at all. #20 covers "the repository is a
  subdirectory"; this covers "there is no repository yet", which is the reviewer lane.
- **A user-level config** (`~/.config/diffity/config.json`, lowest precedence) so `severities` and
  `standards` do not have to be committed to every repository being reviewed.
- **The pull request's description and its existing forge comments** shown in the page. `pullComments`
  already imports inline review threads, but the PR body and review bodies (a bot summary, an
  "lgtm") are nowhere, and they are what a reviewer wants before reading code.
- **Move detection** — verbatim moves dim, moved-and-edited highlight, with a nested diff of the
  move. The remaining half of the attention work in #22, and the bigger prize.
- **`scrollToLine`** so the walkthrough stepper lands on a stop's lines rather than the top of its
  file; there are no per-line DOM anchors yet.
- **A severity vocabulary and a review signature**, both configuration rather than code.

### Lessons paid for

- `vite build` does not typecheck, and until #22 nothing in this repo executed a component, so two
  render-time `ReferenceError`s reached the browser. Scripted edits to TSX must assert that they
  applied — counting occurrences is not proof — and a typecheck filtered through
  `grep … || echo clean` can report success while errors exist.

### Fixed, not queued

- **Syntax highlighting** stopped working because the CSP added in #12 omitted
  `'wasm-unsafe-eval'`, and shiki compiles an oniguruma WebAssembly module. Fixed on
  `sanitize-markdown` and merged through the stack.

## Fork-local, do not upstream

Nothing yet. Expected to land here: configurable repo resolution (clone/worktree strategies for
reviewing a PR from outside its checkout), a severity vocabulary, and a configurable review
signature.
