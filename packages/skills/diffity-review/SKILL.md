---
name: diffity-review
description: Review current diff and leave comments using diffity agent commands
user-invocable: true
---

# Diffity Review Skill

You are reviewing a diff and leaving inline comments using the `{{binary}} agent` CLI.

## Arguments

- `ref` (optional): Git ref to review (e.g. `main..feature`, `HEAD~3`). When both `ref` and `focus` are provided, use both (e.g. `/diffity-review main..feature security`).
  With no `ref`, review **the pull request for the current branch** if there is one, and the working
  tree otherwise — see Step 0. "Review my draft PR" with everything committed means the pull
  request, not the empty set of uncommitted changes.
- `focus` (optional): Focus the review on a specific area. One of: `security`, `performance`, `naming`, `errors`, `types`, `logic`. If omitted, review everything.

## CLI Reference

```
{{binary}} agent review-start [--note "<text>"]
{{binary}} agent review-done
{{binary}} agent standards [--json]
{{binary}} agent diff
{{binary}} agent list [--status open|resolved|dismissed] [--json]
{{binary}} agent comment --file <path> --line <n> [--end-line <n>] [--side new|old] --body "<text>"
{{binary}} agent general-comment --body "<text>"
{{binary}} agent resolve <id> [--summary "<text>"]
{{binary}} agent dismiss <id> [--reason "<text>"]
{{binary}} agent reply <id> --body "<text>"
{{binary}} agent tour-start --topic "<text>" [--body "<text>"] --json
{{binary}} agent tour-step --tour <id> --file <path> --line <n> [--end-line <n>] --body "<text>" [--annotation "<text>"]
{{binary}} agent tour-done --tour <id>
{{binary}} agent tour-delete [<id>]
```

- `--file`, `--line`, `--body` are required for `comment`
- `--end-line` defaults to `--line` (single-line comment)
- `--side` defaults to `new`
- Every `--body` also takes `--body-file <path>`, and `--body-file -` reads stdin. Write anything
  holding quotes, backticks or newlines with a quoted heredoc, so nothing needs escaping and the
  text lands exactly as typed:

  ```
  {{binary}} agent reply <id> --body-file - <<'EOF'
  The `\n` case is deliberate — `split('\n')` never sees it.
  EOF
  ```

- `general-comment` creates a diff-level comment not tied to any file or line
- `<id>` accepts full UUID or 8-char prefix

## Prerequisites

1. Check that `{{binary}}` is available: run `which {{binary}}`. If not found, {{install_hint}}.
2. **Work out which repository to use.** A project directory often holds several worktrees as
   subdirectories rather than being a repository itself, so the current directory may not be one.
   - If the current directory is a git repository (`git rev-parse --show-toplevel` succeeds), use it.
   - Otherwise look one level down for directories containing a `.git` entry. Exactly one → use it.
     Several → **ask the user which one**, listing them with their current branch, and stop until
     they answer. Guessing here reviews the wrong branch, which wastes the whole review.
   - Pass the chosen directory to every `{{binary}}` call as `--repo <path>`, before any positional
     argument. Do not `cd`.


## Instructions

### Step 0: Say that you have started

As soon as the session exists, run:

```
{{binary}} agent review-start --note "<what you are reviewing>"
```

The page then shows an unmissable banner, and submitting the review to the forge is blocked
until you finish. Without it a reader cannot tell "nothing found" from "not finished looking",
and may approve the change while findings are still arriving.

Run `{{binary}} agent review-done` as the last thing you do, **after** the comments and the
reading order are in — including when you found nothing, and including when you give up early.
Leaving a review marked in progress blocks submission indefinitely.

### Step 0b: Decide what to review

Only when no `ref` argument was given:

1. Ask GitHub whether the current branch has a pull request:
   ```
   gh pr view --json number,url,isDraft,baseRefName
   ```
2. If it returns one, **review the pull request**: use its URL as the ref
   (`{{binary}} --repo <path> --no-open <pr-url>`). diffity pins the diff to the pull request's base
   commit, so it matches what GitHub shows — a plain working-tree diff on a branch whose work is
   committed would be empty. A draft counts; that is the usual case for a review before marking it
   Ready.
3. If there is no pull request, or `gh` is unavailable, review the working tree as before.

State which one you chose in your first message, so the user can correct you cheaply.

### Step 1: Ensure diffity is running for the correct ref (without opening browser)

The review needs a running session whose ref matches the requested ref. A ref mismatch causes "file not in current diff" errors when adding comments.

1. Run `{{binary}} list --json` to get all running instances. Parse the JSON output and find the entry whose `repoRoot` matches the current repo.
2. If a matching entry exists, compare its `ref` field against the requested ref:
   - The registry stores `"work"` for working-tree sessions and the user-provided ref string (e.g. `"main"`, `"HEAD~3"`) for named refs.
   - If refs **match** → reuse the session, note the port, and continue to Step 2.
   - If refs **don't match** → restart: run `{{binary}} <ref> --no-open --new` (or `{{binary}} --no-open --new` if no ref). The `--new` flag kills the old session and starts a fresh one. Use Bash tool with `run_in_background: true`. Wait 2 seconds, then verify with `{{binary}} list --json` and note the port.
   - If **no ref was requested** and the running session's ref is not `"work"` → restart with `{{binary}} --no-open --new` (the running session is for a named ref, but we need working-tree).
3. If **no session is running** for this repo, start one in the background:
   - Command: `{{binary}} <ref> --no-open --review` (or `{{binary}} --no-open --review` if no ref)
   - `--review` says what you are here for. Reviewing is not editing, so it keeps Act off the
     comment box and refuses a change request even on a pull request the reader wrote themselves.
     Authorship alone cannot tell the difference; you can.
   - Use Bash tool with `run_in_background: true`
   - Wait 2 seconds, then verify with `{{binary}} list --json` and note the port.

### Step 2: Review the diff

1. **Get the unified diff** directly from diffity — this handles merge-base resolution, untracked files, and all ref types automatically:
   ```
   {{binary}} agent diff
   ```
   This outputs the full unified diff for the current session. Line numbers are in the `@@` hunk headers.
2. **Read the project's review standards.** Run `{{binary}} agent standards`. A project can point
   `review.standards` in `.diffity.json` at its own standards document, and set `review.severities`
   to the labels its reviewers use. Whatever it prints outranks the generic guidance in this skill:
   it is what this team has agreed to review against. If nothing is configured, carry on with the
   defaults below.
3. Find and read all relevant CLAUDE.md files — the root CLAUDE.md and any CLAUDE.md files in directories containing modified files. These define project-specific rules that the diff must follow.

#### Assess the change size and adapt your strategy

4. **Gauge the diff size** and plan your approach. Every file gets a thorough review regardless of diff size — the difference is how you organize the work:
   - **Small** (under ~100 changed lines, 1-3 files): Straightforward — review each file in order.
   - **Medium** (100-500 changed lines, 3-10 files): Group files by area (e.g. backend, frontend, tests, config). Review core logic files first so you understand intent before reviewing the ripple effects.
   - **Large** (500+ changed lines or 10+ files): Group files by area. Start with core logic, then review every remaining file. For mechanically repetitive changes (e.g. the same rename applied to 20 files), verify the pattern is correct on the first few instances, then check every remaining instance for deviations from the pattern — don't skip any, but you can check them faster once the pattern is established.

   No matter the size, **read and review every changed file**. Do not skip or spot-check files.

#### Understand the change before reviewing it

5. **Summarize the change first.** Before looking for problems, build a mental model of the diff:
   - What is this change trying to accomplish? (new feature, bug fix, refactor, config change)
   - Which files are structural changes vs. the core logic change?
   - What is the author's intent? Read commit messages (`git log --oneline <args>`) and any linked issues or PR descriptions for context.
   - What are the key decisions the author made, and what constraints were they working within?

   Understanding intent helps you distinguish intentional behavior from real bugs.

6. For each changed file (adjusted by size strategy above), read the **entire file** (not just the diff hunks) to understand the full context.
7. **Cross-reference callers and dependents.** For any changed function signature, renamed export, modified return type, or altered behavior: grep for usages across the codebase. A function that looks correct in isolation can break every caller. Check:
   - Who calls this function? Will they handle the new return value / error / null case?
   - Who imports this module? Will the changed export name resolve?
   - Does this type change propagate correctly to consumers?
8. Analyze the code changes using the techniques below. If a `focus` argument was provided, concentrate on that area. Otherwise, apply all analysis passes and the signal threshold.

#### How to analyze

The diff tells you *what* changed; the surrounding code tells you whether the change is *correct*. Apply these analysis passes:

**Data flow analysis** — Trace values through the changed code. Where does each variable come from? Where does it go? Check:
- Can a value be null/undefined where the changed code assumes it isn't?
- Does the changed code handle all branches of an upstream conditional?
- If a function's return type changed, do all callers handle the new shape?
- Are there narrowing checks (e.g. `if (x)`) that the diff accidentally moved outside of?

**State and lifecycle analysis** — For stateful code (React state, database transactions, streams, event listeners):
- Does the change create a state that can't be reached or can't be exited?
- Are resources (listeners, subscriptions, file handles) still cleaned up on all paths?
- Can concurrent access corrupt shared state?
- Does the ordering of operations still satisfy invariants (e.g. init before use)?

**Contract analysis** — Check the changed code against the contracts it must satisfy:
- Does the function still satisfy what its callers expect? (Read the callers, don't guess.)
- If it implements an interface or overrides a base method, does it still conform?
- Are pre-conditions and post-conditions preserved?
- For API endpoints: does the response shape match what clients send/expect?

**Boundary analysis** — For code at system boundaries (user input, network, file I/O, IPC):
- Is user-controlled input validated before use?
- Can malformed external data crash the process or corrupt state?
- Are there injection vectors (SQL, shell, XSS, path traversal)?

**Edge case analysis** — Only for cases that *will* happen in practice, not theoretical ones:
- Empty arrays/strings, zero, negative numbers — does the code handle them?
- Off-by-one in loops, slices, or index arithmetic
- Integer overflow, division by zero where the divisor comes from input

#### Completeness check

After analyzing the code for correctness, check whether the change is **complete** — not just correct, but finished:

**Test coverage:**
- If the diff adds new behavior (a new function, endpoint, UI flow, branch), are there tests covering it? If not, flag it as a `[suggestion]`.
- If the diff fixes a bug, is there a test that would have caught the bug? Regression tests prevent re-introduction.
- If the diff modifies existing behavior, are existing tests updated to match? Stale tests that still pass are worse than no tests — they give false confidence.
- If the diff includes tests, review them for quality:
  - Do they test the **right thing**? (behavior, not implementation details)
  - Do they cover **edge cases** the code handles? (empty input, error paths, boundary values)
  - Are they **isolated**? (no hidden dependencies on test ordering or global state)
  - Could they pass even if the code were broken? (tautological assertions, mocked-away logic)

**Missing pieces:**
- Schema change without a migration?
- New environment variable without documentation or defaults?
- New dependency without lockfile update?
- Changed API response without client-side update?
- New error type without handling at the call site?
- Removed feature without cleanup of related code (dead imports, unused config, orphaned tests)?

Only flag missing pieces that are **clearly needed** for this change to work correctly. Don't flag aspirational improvements.

#### What to flag

Flag real problems that would affect correctness, security, or reliability:
- Code that will fail to compile, parse, or run (syntax errors, type errors, missing imports, unresolved references)
- Logic errors that will produce wrong results (clear bugs, off-by-one errors, broken conditions)
- Security vulnerabilities in changed code (injection, XSS, auth bypass, data exposure)
- Race conditions or data loss risks you can demonstrate with a concrete scenario
- CLAUDE.md violations where you can quote the exact rule being broken
- Broken contracts — a changed function that no longer satisfies what its callers expect
- Missing tests for new or changed behavior (as `[suggestion]`, not `[must-fix]`, unless the project's CLAUDE.md requires tests)
- Incomplete changes — migrations, config, client-side updates that are clearly needed for this change to work

Skip style concerns, linter-catchable issues, and pre-existing problems in unchanged code. Focus on the diff, not the whole file.

#### Validate before commenting

For each finding, verify it's real before posting:
- Re-read the surrounding code — many apparent bugs disappear in full context
- For "missing import" or "undefined variable" claims, grep to confirm
- For broken callers, read the actual call sites
- For CLAUDE.md violations, confirm the rule is scoped to this file
- For missing tests, check that there isn't already a test in a different file that covers this path

If a repeated pattern appears across files, comment on the first occurrence and mention the pattern in the general summary instead of duplicating comments.

### Step 3: Leave comments

1. **Order comments by severity**, most severe first, and within a severity follow file order. The
   most important issues are then seen first by someone who skims.

2. Prefix each finding with its severity. Use the labels `{{binary}} agent standards` printed — they
   are what this project's reviewers read, and matching them is what makes a review usable rather
   than merely correct. `P1: …`, `P2: …`, `P3: …` are the default. Only when a project configures
   nothing, fall back to:
   - `[must-fix]` — Bugs, security issues, data loss risks. Code that will break or produce wrong results.
   - `[suggestion]` — Concrete improvements with a clear reason. Not style preferences — real improvements. This includes missing tests, incomplete changes, and better approaches.
   - `[question]` — Something unclear that needs clarification from the author.

   Whichever vocabulary applies, the most severe label means *this must not merge*. Do not inflate:
   a review where everything is severe tells the reader nothing.

3. For each finding, leave an inline comment using:
   ```
   {{binary}} agent comment --file <path> --line <n> [--end-line <n>] [--side new] --body-file - <<'EOF'
   <comment>
   EOF
   ```
   - Use `--side new` (default) for comments on added/modified code
   - Use `--side old` for comments on removed code
   - Use `--end-line` when the issue spans multiple lines
   - **Lead with the problem**, not background. Be specific and actionable.
   - For small, self-contained fixes, include a code suggestion showing the fix
   - For larger fixes (structural changes, multi-location), describe the issue and suggested approach without a full code block
   - If flagging a CLAUDE.md violation, quote the exact rule being broken
4. After leaving all inline comments, decide whether a general comment is needed:
   - **No findings → leave a general comment:** "No issues found. Checked for bugs and CLAUDE.md compliance."
   - **1-2 findings → skip the general comment** unless there's a cross-cutting concern the inline comments don't cover.
   - **3+ findings → leave a general comment** summarizing the themes.
   - **Large diffs → always leave a general comment** noting the scope of the review and grouping findings by area.
   - **Do not use severity prefixes in the general comment** — prefixes are only for inline findings.
   - Lead with the verdict, be direct and concise — no compliments, no filler, no narrating what the code does.
   ```
   {{binary}} agent general-comment --body "<overall review summary>"
   ```

### Step 4: Set the reading order

A diff is served alphabetically, which is rarely the order it should be read in. Give the reader
one, unless the change is a single file:

1. Decide the order someone should read the change in — the piece that explains the rest first, the
   call sites and their ripple effects after, mechanical or signature-only files last.
2. Record it:
   ```
   {{binary}} agent tour-start --topic "Reading order" --body "<why this order>" --json
   {{binary}} agent tour-step --tour <id> --file <path> --line <n> [--end-line <n>] \
     --body "<what to understand here>" --annotation "<3-6 words on why it is read here>"
   {{binary}} agent tour-done --tour <id>
   ```
3. The `--annotation` becomes the file's label in the reordered file list, so make it say *why* this
   file is read at this point ("the primitive", "first consumer", "where the P1 lives") rather than
   restating its name. Point a step at the most important lines in the file, not line 1.
4. Check what you recorded — `{{binary}} agent tour-start --json` and the steps you added. If a step
   went in wrong, `{{binary}} agent tour-delete` and build it again. Adding a second walkthrough
   leaves the wrong one in place, and the reader only ever sees the newest.

### Step 5: Open the browser

1. Open the browser now that comments are ready:
   ```
   {{binary}} open <ref>
   ```
   Pass the ref argument if one was provided (e.g. `{{binary}} open HEAD~3`). Omit it to open the default view.
2. Tell the user the review is ready and they can check the browser. Example:

   > Review complete — check your browser.
   >
   > Found: 1 P1, 2 P2. The file list is in reading order; the P1 is on the last stop.
   >
   > When you're ready, run **{{slash}}resolve** to fix them.

   Report the counts using the same labels you used in the comments.

### Step 6: Stay for the questions

Check whether the page can reach you: `{{binary}} agent live-status`. If it reports that live mode is
available, arm the loop as the last thing you do:

```
{{binary}} agent await --timeout 240
```

Run it as a **background** command. It blocks until the reader asks something in the page and then
exits, which is what wakes you; nothing asked exits 3, and you re-arm. Follow the **{{slash}}live**
skill when it hands you a request.

This does not replace anything above. The review — the findings, the reading order, `review-done` —
is done first and in full. Arming the loop only means you are still there afterwards, so a question
about a finding gets an answer instead of a shrug.

If live mode is not available, say so once and stop: the reader can turn it on in the page.
