# Reviewing on diffity

You are reviewing a change and leaving inline findings on a **hosted diffity server**, through its MCP
tools. The review lives on the server, the user reads it in their browser, and you read the code from
your own checkout.

If no target was named, review **the pull request for the current branch** if there is one; if the
work is not pushed, review it as a patch (see Step 1). Unless the user asked for a focus, review
everything.

## Tools

The connector is usually added as `diffity`, so in Claude Code the tools are named
`mcp__diffity__<tool>`.

```
create_session  { repo: "owner/name", pr? , base?, head?, patch?, review? }  → { session, url, base, head, files }
list_sessions   { repo? }
list_review_requests {}                       open pull requests waiting for the user's review
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
live_token      { session? }                  → { command }: waits for the reader's questions; without
                                              a session, for everything of the user's (see Attend)
```

- `create_session` takes the repository and **exactly one** of: `pr`; `base` and `head` (full
  40-character shas, both pushed); or `base` and `patch` (a unified diff against a pushed base).
- `create_session { …, review: true }` also hands the session to the agent attending the user's queue
  (see Attend), as the Sessions page's **Create and review** button does.
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

If `create_session` says the repository cannot be read, the user has to connect GitHub on the
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

The page is where they are read; the user posts them to the pull request from there once they have
been through them. Never post to GitHub yourself.

### Step 7: Stay for questions

The reader can ask you about a finding from the page ("Ask Claude"). After `review_done` and the
hand-over, call `live_token { session }` and run the `command` it returns **as a background command**
(in Claude Code: Bash with `run_in_background`), so you stay free while it waits. It is plain `curl`
and shell, and exits only when a question arrives.

When it exits with status 0, its output is the question as JSON: the `thread`, the `file` and
`line`, and the `question`. Read the code it points at, answer in the thread with
`reply { id: <thread>, body, aside: true }`, and run the same command again in the background.
Answer what was asked; do not change code from here.

Stop when the user says so, or when the command exits with status 1: the token has expired or was
refused. Tell the user the page no longer reaches you, and offer to start again with a new
`live_token`.

## Attend: wait on the user's queue

When the user asks you to attend — wait for whatever they hand you rather than review one change —
call `live_token {}` with no session, and run the `command` it returns **as a background command**
(in Claude Code: Bash with `run_in_background`). It waits on everything of the user's: the sessions
they hand over with **Create and review** on the Sessions page (or with `create_session { review:
true }`), and the questions they ask on any of their review pages.

When it exits with status 0, its output is one request as JSON:

- `kind: "review"` — a session to review: `session`, `repo`, `pr` and `url`. The session exists
  already; review it with Steps 2–5 above, from `review_start` to `review_done`. The page shows the
  review arriving, and `review_done` tells it the review is ready. Work from `get_diff` and
  `get_file` when your checkout is not of that repository.
- `kind: "ask"` — a question on a finding: answer it with `reply { id: <thread>, body, aside: true }`
  as in Step 7.

Then run the same command again in the background. Claude Code stops a background command after a
while; when it was stopped rather than exiting with a request, run it again too, so the page keeps
showing that an agent is listening.

Stop when the user says so, or when the command exits with status 1: the token has expired or was
refused. Tell the user the queue no longer reaches you, and offer to start again with a new
`live_token {}`.
