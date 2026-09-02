<img src="./packages/ui/public/brand.svg" width="80" />

# diffity

[![npm version](https://img.shields.io/npm/v/@naturalcycles/diffity)](https://www.npmjs.com/package/@naturalcycles/diffity)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Diffity is an agent-agnostic, GitHub-style diff viewer and code review tool — with a live loop
where the reader asks questions or requests changes on any line and a parked agent answers.

This is [Natural Cycles](https://github.com/NaturalCycles)' fork of
[nilbuild/diffity](https://github.com/nilbuild/diffity) by Kamran Ahmed. The review loop, the live
agent protocol, session carry-forward and the idle lifecycle are this fork's own; the viewer it
grew from is upstream's.

```bash
npm install -g @naturalcycles/diffity
diffity skills install
```

The binary is `diffity`. `skills install` puts the agent skills into `~/.claude/skills` — run it
again after an update (`diffity update` says when the skills changed). Any skill directory named
`diffity-*` is treated as diffity's and may be replaced or removed there; `diffity-dev-*` and
everything else is never touched. Had upstream's `diffity` installed? `npm uninstall -g diffity`
first, or npm refuses the colliding binary. It works with Claude Code, Cursor, Codex, and any AI
coding agent.

| What can you do? | Description |
|---|---|
| [See your diffs](#see-your-diffs) | View changes in working area, across commits, branches, tags, etc  |
| [AI code review](#ai-code-review) | Let your agent review code and leave comments on the diff |
| [Browse project files](#browse-project-files) | Explore your repo and comment on any file for AI to resolve |
| [Guided code tours](#guided-code-tours) | Walk through your codebase step by step with highlighted code |
| [Learn any topic](#learn-any-topic) | Project-driven learning for programming languages, tools, and frameworks |
| [GitHub PRs](#github-prs) | Pull down a PR, review it locally, submit one review back |
| [Reading order](#reading-a-diff-in-the-order-it-makes-sense) | Read a diff in the order it makes sense, not alphabetically |
| [Attention](#what-gets-your-attention) | Highlight what matters, dim what a rule can prove is mechanical |
| [Review state](#while-a-review-is-running) | See when a review is still running, and what has already been sent |
| [Multiple projects](#multiple-projects) | Run it in multiple repos at once, each gets its own port |

## See your diffs

Run `diffity` inside any git repo — your browser opens with a GitHub-style, syntax-highlighted diff.

```bash
# everyday use
diffity                                    # review all uncommitted changes
diffity HEAD~1                             # review your last commit
diffity HEAD~3                             # review your last 3 commits

# branch workflows
diffity main                               # compare current branch against main
diffity main..feature                      # compare feature branch against main
diffity main feature                       # same as above, shorthand syntax
diffity --base main --compare feature      # same as above, explicit flags

# releases and tags
diffity v1.0.0 v2.0.0                     # compare two releases
diffity v1.0.0                             # what changed since v1.0.0

# specific commits
diffity abc1234                            # changes since a specific commit
diffity abc1234..def5678                   # changes between two commits

# filter by change type
diffity work                               # all changes (staged + unstaged + untracked)
diffity staged                             # only staged changes (git add'd)
diffity unstaged                           # only unstaged modifications
```

The `--base`/`--compare` flags use the same terminology as GitHub PRs — base is what you're comparing against, compare is the branch with changes. You can also use range syntax (`main..feature`) or just pass two positional args (`diffity main feature`).

You can leave comments on any diff — working tree changes, branch comparisons, commit ranges. Your agent can also review and leave its own comments. Either way, run `/diffity-resolve` and your agent reads all open comments (yours or its own) and makes the code changes for you.

## AI code review

Install the skills for your coding agent (`diffity skills install`), then use the slash commands:

### `/diffity-diff`

Opens the diff viewer in your browser. Accepts the same refs as the CLI, plus natural language:

```
/diffity-diff                          # working tree changes
/diffity-diff main                     # current branch against main
/diffity-diff main..feature            # branch diff
/diffity-diff HEAD~1                   # last commit
/diffity-diff last 3 commits           # natural language works too
```

Leave comments on any line — when you're done, run `/diffity-resolve` to have your agent fix them.

### `/diffity-review`

Your agent reviews the diff and leaves inline comments in the viewer, prefixed with severities so you can triage by importance — `P1`/`P2`/`P3` by default, or whatever the project configures (see [Review standards](#review-standards)). It reads the project's own standards first, records a reading order for the diff, and announces itself as running so you do not approve while findings are still arriving. Supports refs, focus areas, and natural language:

```
/diffity-review                             # the branch's pull request, or the working tree
/diffity-review main                        # review what you're merging into main
/diffity-review main..feature               # review what you're merging into main
/diffity-review identify security issues    # focus on security issues
/diffity-review performance in src/lib      # focus on performance in specific dir
/diffity-review last 3 commits              # natural language works too
```

### `/diffity-resolve`

Reads all open comments and makes the requested code changes. Works with both your comments and AI review comments:

```
/diffity-resolve                       # resolve all open comments
/diffity-resolve abc123                # resolve a specific thread by ID
```

A typical workflow: run `/diffity-review` to get AI feedback, check the comments in the browser, then run `/diffity-resolve` to apply the fixes.

## A live agent on the diff

Every comment box carries **Ask** and **Act** next to the plain reply. Ask hands the agent a
question — it answers in the thread, or amends the finding the question was about. Act hands it a
change request — it edits the code and replies with what it did. A question never turns into an
edit, and on somebody else's pull request the agent is told not to touch code.

The agent parks on the review with `diffity agent await` (the `diffity-live` skill drives the
loop): it sleeps until you press one of the buttons, acts, and re-arms. The page shows whether an
agent is listening, working, or absent — a request made with nobody listening says so, and is
picked up when an agent next arms. When the review page closes, the parked agent is told and stops
rather than waiting on a window nobody has open; the server itself stops a few minutes after its
reader leaves, and everything is in SQLite, so running `diffity` again picks the review back up.

## Browse project files

Run `diffity tree` to open a full file tree browser — no diff required. Browse your repo, read files with syntax highlighting, and leave comments on any file or folder.

```bash
diffity tree
```

The tree view supports the same commenting and resolve workflow as the diff viewer. Leave comments on specific lines, files, or folders, then have your agent resolve them.

### `/diffity-tree`

Opens the file tree browser:

```
/diffity-tree
```

### `/diffity-resolve-tree`

Reads open comments from the tree browser and makes the requested code changes:

```
/diffity-resolve-tree                  # resolve all open comments
/diffity-resolve-tree abc123           # resolve a specific thread by ID
```

## Guided code tours

Create narrated, step-by-step walkthroughs of your codebase. Tours open in the browser with a sidebar showing the narrative and highlighted code sections.

### `/diffity-tour`

Your agent researches the codebase, then builds a tour with highlighted code regions and rich markdown explanations:

```
/diffity-tour how does authentication work?
/diffity-tour explain the request lifecycle
/diffity-tour how are comments stored and retrieved?
/diffity-tour closures
/diffity-tour async/await patterns
/diffity-tour walk me through this branch before I merge
/diffity-tour https://github.com/owner/repo/pull/123
```

Works for features ("how does auth work?"), concepts ("closures", "generics"), and pre-merge reviews. For concepts, the agent finds real examples in your codebase and teaches the concept progressively from simple to complex. For reviews, it walks the user-facing flows end-to-end and ends with a "things to flag in the PR conversation" list — you can pass a branch, a ref range, or a GitHub PR URL.

Each tour has an intro (step 0) with an architectural overview, followed by numbered steps that highlight specific code regions and explain them in detail. The agent follows the actual execution path, not file order — foundations (schemas, config, helpers) are introduced just-in-time when the flow first touches them.

Tour steps can include **sub-highlights** — clickable focus links in the narrative that narrow the highlight to a specific sub-range within the step. Useful for walking through large functions section by section.

## Learn any topic

Start a project-driven learning journey for any programming language, tool, or framework. Your agent becomes a tutor — it builds teaching projects that open as guided tours in the browser, gives you challenges to complete, reviews your code with inline feedback, and adapts to your pace.

### `/diffity-learn`

Kick off a learning journey. Run it in an empty directory where you want to keep your learning files — the agent creates a `learn-<topic>/` folder with lessons, projects, and progress tracking.

```bash
mkdir ~/learning && cd ~/learning
```

Then start learning:

```
/diffity-learn Rust
/diffity-learn Go
/diffity-learn Docker
/diffity-learn SQL
/diffity-learn TypeScript
/diffity-learn Kubernetes
```

Each lesson follows a loop: your agent builds a small project and opens it as a Diffity tour explaining the concepts, then gives you a challenge to build yourself. When you're done, it reviews your code with inline Diffity comments and decides what to teach next.

Progress is saved to `learn.json` — come back anytime and pick up where you left off. The agent tracks what you've mastered, what you're struggling with, and adjusts the curriculum accordingly.

## GitHub PRs

Pass a GitHub PR URL to view and review pull requests locally:

```bash
diffity https://github.com/owner/repo/pull/123
```

This checks out the PR and opens the diff against **the commit the pull request is based on**, so the file and line counts match what the forge shows rather than drifting with your local base branch. A merged pull request works too: its branch is usually deleted, so the head is fetched from `refs/pull/<n>/head`. Requires the [`gh` CLI](https://cli.github.com/) installed and authenticated (`gh auth login`), and the current repo must match the PR's repository.

Above the diff you get the pull request's description and every review already on it, so you are not re-deriving intent from the code or repeating a point someone else has made.

### Submitting a review

The forge dialog is a composer, not a push button:

- a checkbox per finding, so you send the ones you agree with. Everything open starts selected; deselecting is remembered, so a finding your agent writes while the dialog is open cannot slip into a set you have already curated
- replies on a finding are folded into the one comment the forge will hold
- general comments seed the summary, which you can edit
- **Comment**, **Approve** or **Request changes** — and an approval needs nothing attached, since a verdict stands on its own. Approve and Request changes are disabled on your own pull request, which the forge refuses anyway
- everything goes as **one review**: one notification for the author, a summary that has somewhere to live, and no half-posted review if something fails

A comment on a line the pull request does not touch is caught before anything is sent, because the whole review is a single request and one unpostable line would reject all of it. Findings already sent are marked *already on the pull request* and left unselected.

Existing inline comments can be pulled into the viewer from the same dialog.

The skills work with PR URLs too:

```
/diffity-diff https://github.com/owner/repo/pull/123
/diffity-review https://github.com/owner/repo/pull/123
/diffity-tour https://github.com/owner/repo/pull/123
```

Passing a PR URL to `/diffity-tour` locks it to review mode — the agent reads the PR's description, commits, and diff to build a guided walkthrough that you can use before approving or merging.

## Reading a diff in the order it makes sense

A diff arrives alphabetically, which is rarely the order it should be read in. When a walkthrough
exists for the change, the file list is **reordered** to follow it: the file that explains the rest
first, the mechanical ones last, everything the walkthrough does not mention below a divider. Each
file carries the walkthrough's one-line note on why it is read at that point, a stepper walks the
stops, and `A-Z` in the sidebar header returns to the alphabetical tree.

A walkthrough is recorded by an agent (`/diffity-review` does it as its last step, and
`/diffity-tour` builds one on request), so this costs you nothing to use.

## What gets your attention

Two mechanisms, with the decider deliberately different for each.

**Highlighted** — the lines a walkthrough points at are tinted. An agent can only ever *add*
attention this way, never take it away.

**Dimmed** — decided by rules, never by a model, because dimming asserts that something needs
*less* attention. A hunk recedes when every line it touches is an import, when its added and
removed lines are the same lines with different whitespace, or when the file is generated. It comes
back on hover, stays selectable and commentable, and carries the reason, so you can always find out
why rather than having to trust it.

Files where indentation is syntax — `.py`, `.yml`, `.yaml`, `.md`, `Makefile` and friends — are
never whitespace-dimmed, because a reindent there can change behaviour.

Whitespace hiding is **on by default** and remembered: it is the formatter's business, not yours.
Because a filtered diff shows fewer lines than the forge does, the header says so and names the
amount — `whitespace hidden (2 files, 18 lines suppressed)`.

## Commenting

Click a line to comment on it. **Shift-click** a second line to extend the comment across the span,
the way the forge does it — within one file and one side, since a range spanning both sides of a
diff is not something that can be commented on. Dragging down the gutter also selects a range.

## While a review is running

An agent announces a review before it starts writing and again when it finishes. While one is open
the page carries a banner with the count of findings so far, and **submitting is blocked** — the
difference between "nothing found" and "not finished looking" is the difference between approving a
change and approving it too early.

A finding survives the commits you make in response to it: when HEAD moves, open findings and the
walkthrough follow into the new session, and a finding whose code merely *moved* is re-anchored to
it. A finding whose code was **edited** keeps its old position rather than being guessed onto
something it was not written about.

## The agent CLI

Skills drive these; they are listed because they are the whole interface an agent needs.

```
diffity agent standards [--json]        # the project's severities and standards document
diffity agent diff                      # the unified diff for this session
diffity agent list [--status open|resolved|dismissed] [--json]
diffity agent review-start [--note <text>]
diffity agent review-done
diffity agent comment --file <path> --line <n> [--end-line <n>] [--side new|old] --body <text>
diffity agent general-comment --body <text>
diffity agent reply <id> --body <text>
diffity agent resolve <id> [--summary <text>]
diffity agent dismiss <id> [--reason <text>]
diffity agent tour-start --topic <text> [--body <text>] [--json]
diffity agent tour-step --tour <id> --file <path> --line <n> [--end-line <n>] --body <text> [--annotation <text>]
diffity agent tour-done --tour <id>
diffity agent tour-delete <id>          # correct a walkthrough instead of adding another
diffity agent tour-delete --all         # or clear the session's finished ones
```

Every `--body` also takes `--body-file <path>`, and `--body-file -` reads stdin — a quoted
heredoc needs no escaping, and the text lands exactly as typed.

Every command follows the running server's own session. `diffity agent --session <id> <command>`
(canonically between `agent` and the command) addresses another session by id or 8-char prefix.

A comment's line range is trimmed to the file's length, and you are told when that happens: a range
running past the end would otherwise be counted and highlighted with nothing to show.

## The review inbox

`diffity inbox` watches the pull requests awaiting your review and prepares each one ahead of time, so the review is ready the moment you look. It polls GitHub (`gh search prs --review-requested=@me`), and for each pull request worth your attention it cuts a worktree at the PR head, runs a diffity session over the diff, has an agent prepare a review with a walkthrough, and saves the result as a bundle. New commits redo a stale review; a merged, closed, or no-longer-requested PR is retired. **Nothing is ever posted to GitHub** — prepared reviews are local drafts you open and submit yourself.

```bash
diffity inbox              # run the watcher and a small status server
diffity inbox --once       # run a single poll-and-prepare pass, then exit
diffity inbox status       # print the current inbox without starting the daemon
diffity inbox status --json
```

On first run it writes `~/.diffity/inbox/config.json`:

| Key | Meaning |
|-----|---------|
| `pollMinutes` | How often GitHub is polled (default 5). |
| `port` | The status server's port (default 5390). |
| `reposDir` | Where your base clones live, one directory per repository name. |
| `worktreesDir` | Where each pull request gets its worktree. |
| `filter` | Your own words on what does and doesn't need your attention, handed to the agent — it answers with a skip instead of reviewing when a PR matches (e.g. "Skip payments-focused PRs"). |
| `prepare` | The review agent, as a command and its arguments. It runs in the PR's worktree and reads its prompt on stdin. |
| `prepareTimeoutMinutes` | How long one preparation may take before it's abandoned. |

> ⚠️ The `prepare` command runs inside a checkout the pull request's author controls, so it executes their repository scripts. The daemon runs it without the forge's credentials in its environment, but you should still only point `prepare` at an agent you're willing to run on untrusted code.

## Multiple projects

Diffity supports running multiple projects simultaneously. Each gets its own port automatically:

```bash
# Terminal 1 — starts on :5391
cd ~/projects/app && diffity

# Terminal 2 — starts on :5392
cd ~/projects/api && diffity
```

If you run `diffity` in a repo that already has a running instance, it opens the existing one instead of starting a new server. Use `--new` to kill the existing instance and start fresh.

```bash
diffity list               # show all running instances
diffity list --json        # machine-readable output
```

## Options

```
--base <ref>       Base ref to compare from (e.g. main, HEAD~3, v1.0.0)
--compare <ref>    Ref to compare against base (default: working tree)
--port <port>      Custom port (default: auto-assigned from 5391)
--no-open          Don't open browser
--dark             Dark mode
--unified          Unified view (default: split)
--quiet            Minimal terminal output
--new              Stop existing instance and start fresh
--repo <path>      Repository to work on, when the current directory is not one
```

`--repo` is for the common case where a project directory holds several worktrees as
subdirectories rather than being a repository itself. It must come before a positional argument.

## Environment variables

| Variable       | Description                                                               |
| -------------- | ------------------------------------------------------------------------- |
| `DIFFITY_HOST` | Hostname used in the printed URL (default: `localhost`).                  |
| `DIFFITY_BIND` | Interface the server listens on (default: `127.0.0.1`).                   |
| `DIFFITY_DATA_DIR` | Where review notes are kept (default: `~/.diffity/<repo-hash>`).      |
| `DIFFITY_SYNC_DEV_SKILLS` | Set to `1` to have a build install the `diffity-dev-*` skills into `~/.claude/skills`. |

Useful when running diffity inside a VM or container and opening it from another machine:

```bash
DIFFITY_BIND=0.0.0.0 DIFFITY_HOST=diffity.local diffity
```

The server has no authentication: anything that can reach it can read the diff, the
repository's files and the review comments. Only widen `DIFFITY_BIND` on a network you
trust.

## Where review notes live

Review threads, walkthroughs and sessions are kept in a SQLite database. By default that is
`~/.diffity/<repo-hash>/reviews.db`, one per repository.

A project can keep its own instead, which is what you want when several worktrees of the same
repository each need their own notes, or when the notes should travel with the project rather
than the machine. Commit a `.diffity.json` at the repository root:

```json
{ "dataDir": "../.diffity" }
```

Relative paths resolve against the repository root, absolute paths are used as given, and
`DIFFITY_DATA_DIR` overrides both. A directory chosen this way is used as-is — no hashed
subdirectory, since there is nothing to disambiguate.

Point it **outside** the working tree, or add it to `.gitignore`. Otherwise the notes show up as
untracked files in the very diff you are reviewing; diffity warns on startup when that happens.
The database quotes the code under review, so it is created readable only by you.

## Review standards

An agent reviewing a diff can be told what this project reviews against, so the standards live with
the code rather than in one person's agent configuration:

```json
{
  "review": {
    "severities": ["P1", "P2", "P3"],
    "standards": ".claude/skills/code-review/SKILL.md"
  }
}
```

`severities` are the labels findings are prefixed with, most severe first, defaulting to
`P1`/`P2`/`P3`. `standards` is a repository-relative path to a document the agent reads before
reviewing. `diffity agent standards` prints both, and the review skill reads it first.

## License

[MIT](./LICENSE) — © Kamran Ahmed (the upstream
[diffity](https://github.com/nilbuild/diffity)), with this fork's changes by Natural Cycles.
