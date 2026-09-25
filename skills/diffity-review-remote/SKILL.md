---
name: diffity-review-remote
description: >-
  Review a pushed pull request, commit range or patch on a hosted diffity server
  through its MCP tools, and hand the user the review URL
user-invocable: true
---

# Diffity Remote Review Skill

You are reviewing a change and leaving inline findings on a **hosted diffity server**, through its MCP
tools. There is no local `diffity` binary and no local server: the review lives on the server, the
user reads it in their browser, and you read the code from your own checkout.

## Arguments

- `target` (optional): what to review — a pull request (`#123`, a PR URL), a commit range
  (`<base>..<head>`), or nothing. With nothing, review **the pull request for the current branch** if
  there is one; if the work is not pushed, review it as a patch (see Step 1).
- `focus` (optional): one of `security`, `performance`, `naming`, `errors`, `types`, `logic`. If
  omitted, review everything.

## Tools

The connector is usually added as `diffity`, so in Claude Code the tools are named
`mcp__diffity__<tool>`.

```
create_session  { repo: "owner/name", pr? , base?, head?, patch? }  → { session, url, base, head, files }
list_sessions   { repo? }
get_diff        { session, file? }            unified diff; line numbers are in the @@ headers
get_file        { session, path, side? }      side "new" (head, default) or "old" (base)
get_standards   { session }                   the project's standards and severity labels
review_start    { session, note? }
review_done     { session }
comment         { session, file, line, endLine?, side?, body }
general_comment { session, body }
reply           { id, body, aside? }
amend           { id, body }                  a comment id, or a thread id for its finding
resolve         { id, summary? }
dismiss         { id, reason? }
list_comments   { session, status? }
tour_start      { session, topic, body? }     → { tour }
tour_step       { tour, file, line, endLine?, body, annotation? }
tour_done       { tour }
tour_delete     { tour }
```

- `create_session` takes the repository and **exactly one** of: `pr`; `base` and `head` (full
  40-character shas, both pushed); or `base` and `patch` (a unified diff against a pushed base).
- `session`, thread and tour ids accept the full id or its first 8 characters.
- Every tool reports a mistake as an error result with a message. Read it and correct the call; do
  not retry blindly.

If the tools are not available, tell the user to add the connector —
`claude mcp add --transport http diffity <server>/mcp` — and stop.

## Instructions

### Step 1: Create the session

1. Work out the repository: `git remote get-url origin` gives `owner/name`.
2. Decide what to review:
   - A pull request: `gh pr view --json number,url` for the current branch, or the one named. Call
     `create_session { repo, pr }`. The server pins the diff to the pull request's merge base, so it
     matches what GitHub shows.
   - A range whose commits are pushed: `create_session { repo, base, head }` with full shas
     (`git rev-parse`).
   - Work that is not pushed: pick a pushed base (`git merge-base origin/<default-branch> HEAD`), and
     send `git diff <base>` as `patch`. The server applies it to that base.
3. State which one you chose in your first message, so the user can correct you cheaply.
4. Keep the `session` id and the `url` from the result for everything that follows.

If `create_session` says the repository cannot be read, the user has to add a GitHub token on the
server's `/settings` page. Tell them so, with the URL, and stop.

### Step 2: Say that you have started

Call `review_start { session, note: "<what you are reviewing>" }` straight away. The page then shows
that a review is under way; without it a reader cannot tell "nothing found" from "not finished
looking".

Call `review_done { session }` as the last thing you do — **after** the comments and the reading
order are in, including when you found nothing, and including when you give up early.

### Step 3: Review the diff

1. Get the diff from the server with `get_diff { session }`. This is the diff the reader sees, and
   the line numbers you comment on must be the ones in its `@@` headers. Review from your own
   checkout for context — the files around the change, callers, tests — but make sure the checkout
   is at the reviewed head (`git fetch` and compare with the `head` the session returned); when it is
   not, read files with `get_file` instead.
2. Read the project's standards with `get_standards { session }`. Whatever it returns outranks the
   generic guidance here: it is what this team has agreed to review against.
3. Read the CLAUDE.md files that apply: the root one and those in directories with changed files.

#### Adapt to the size of the change

- **Small** (under ~100 changed lines, 1-3 files): review each file in order.
- **Medium** (100-500 lines, 3-10 files): group files by area, core logic first.
- **Large** (500+ lines or 10+ files): group by area, core logic first, then every remaining file.
  For a mechanically repeated change, verify the pattern on the first instances, then check every
  remaining one for deviations.

Whatever the size, **read and review every changed file**.

#### Understand the change before judging it

Summarise the change for yourself first: what it is trying to do, which files carry the core logic
and which follow from it, what the author intended (commit messages, the pull request description).
Read each changed file in full, not just its hunks. For any changed signature, export, return type or
behaviour, find the callers and check they still hold.

#### How to analyse

- **Data flow** — where each value comes from and goes; null where the code assumes not; branches of
  an upstream conditional the change does not handle.
- **State and lifecycle** — states that cannot be reached or left, resources not cleaned up on some
  path, concurrent access, ordering invariants.
- **Contracts** — does the code still satisfy what callers expect; do API responses match clients.
- **Boundaries** — validation of user input and external data; injection (SQL, shell, XSS, path
  traversal).
- **Edge cases that will happen** — empty inputs, zero, off-by-one, division by input.

#### Completeness

- New behaviour without tests, a bug fix without a regression test, changed behaviour with stale
  tests: flag as the project's mildest severity unless its CLAUDE.md requires tests.
- Missing pieces clearly needed for the change to work: a migration, a config default, a client
  update, a lockfile.

#### What to flag, and how to validate it

Flag real problems: code that will not compile or run, logic errors, security holes, demonstrable
races or data loss, CLAUDE.md violations you can quote, broken contracts, missing tests, incomplete
changes. Skip style, linter-catchable issues and problems in unchanged code.

Before posting a finding, verify it: re-read the surrounding code, grep for the "missing" import,
read the actual call sites, confirm the CLAUDE.md rule applies to the file. A repeated pattern gets
one comment on its first occurrence and a mention in the summary.

### Step 4: Leave the findings

1. Order them by severity, most severe first, then by file order.
2. Prefix each with a severity label from `get_standards` (`P1: …`, `P2: …`, `P3: …` by default). The
   most severe label means *this must not merge*; do not inflate.
3. Leave each as `comment { session, file, line, endLine?, side?, body }`:
   - `side: "new"` (the default) for added or kept lines, `"old"` for removed ones.
   - The file must be in the session's diff; the tool says so, with the file list, when it is not.
   - **Lead with the problem.** Two or three sentences, around 60 words: the problem, its
     consequence, the fix. At most one small code suggestion. Anything longer belongs in the general
     comment or the walkthrough.
4. Then decide on a general comment (`general_comment { session, body }`):
   - No findings → "No issues found. Checked for bugs and CLAUDE.md compliance."
   - 1-2 findings → skip it unless there is a cross-cutting concern.
   - 3+ findings, or a large diff → a short paragraph of themes, verdict first, no recap of the inline
     findings and no severity prefixes.
   - Name a severity only where a finding with it is open, and keep any count right.

### Step 5: Set the reading order

Unless the change is a single file, record the order it should be read in:

```
tour_start { session, topic: "Reading order", body: "<why this order>" }
tour_step  { tour, file, line, endLine?, body: "<what to understand here>", annotation: "<3-6 words: why here>" }
tour_done  { tour }
```

The `annotation` becomes the file's label in the reordered file list, so make it say *why* the file
is read at that point ("the primitive", "first consumer"). Point each step at the most important
lines, not line 1. If a step went in wrong, `tour_delete` and build it again.

Then call `review_done { session }`.

### Step 6: Hand over the review

Give the user the session `url` and the counts, using the labels you used:

> Review ready: <url>
>
> Found: 1 P1, 2 P2. The file list is in reading order; the P1 is on the last stop.

The user signs in on that page the first time. Findings are not posted to GitHub from the hosted
server yet; the page is where they are read.
