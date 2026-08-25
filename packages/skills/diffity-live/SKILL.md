---
name: diffity-live
description: Handle a request the reader left in the review page, then go back to waiting
user-invocable: true
---

# Diffity Live Skill

The reader asked something in the review page and `{{binary}} agent await` handed it to you. Answer
it, then go back to waiting.

**This is the tail of a review, not a review.** It assumes the findings and the reading order are
already in — {{slash}}review does that, and arms this loop as its last step. If you have arrived here
without having reviewed the diff, review it first: an agent that answers questions about a review it
never did is guessing.

## What you were handed

`await` prints one request as JSON on stdout:

```json
{
  "commentId": "…",     // the aside that asked
  "threadId": "…",      // the thread it sits in
  "body": "…",          // what the reader wrote
  "authorName": "You",
  "filePath": "…", "side": "new", "startLine": 12, "endLine": 18,
  "findingBody": "…"    // the finding the aside is about, or null on a thread you did not start
}
```

`findingBody` is usually the thing being asked about. Read it before the question.

## The reader already chose

The request carries an `intent`, because there are two buttons in the page and they mean different
things. `await` prints what it means in plain words before the payload; that line is the instruction,
not a summary of it.

- **`ask`** — a question. Answer it, or amend the finding it is about. **Do not change code**, however
  obvious the change looks. They pressed Ask.
- **`act`** — a request for a change. Make it, and say what you did.

An `intent` that is absent or unrecognised is a question. If `mayChangeCode` is false the answer is
the same whatever they pressed: this pull request is somebody else's.

Read `body` and decide *how* to do what was asked. Do not do more than was asked.

**Answer it.** A question about the finding, the code, or your reasoning.

```
{{binary}} agent reply <thread-id> --aside --answers <comment-id> --body "<your answer>"
```

`--aside` keeps it off the pull request. `--answers` closes the request, so the page stops saying you
are working on it. Both matter; leaving either off leaves the thread lying to the reader.

**Amend the finding.** "Put that in the comment", "say it more directly", "you mean X — write that".
This is the most valuable thing this loop does: the conversation never ships, but it improves what
does.

```
{{binary}} agent amend <finding-comment-id> --body "<the rewritten finding>"
{{binary}} agent reply <thread-id> --aside --answers <comment-id> --body "Rewritten."
```

Amend the **finding**, not the aside. If the finding has already been sent, `amend` tells you so —
pass that on rather than letting the reader think the pull request has changed.

**Make the change.** Only when the intent is `act` and `mayChangeCode` is not false. Read the rule
below before you edit anything.

```
# make the edit, then:
{{binary}} agent reply <thread-id> --aside --answers <comment-id> --body "<what you changed>"
```

Resolve the thread as well if the finding is now dealt with. Do not commit, do not push, and do not
merge — those wait to be asked for, here as everywhere.

### When you must not change code

Run `{{binary}} agent live-status` if you are unsure. Editing is off the table when the diff is
somebody else's pull request, however the conversation goes: reviewing is not editing, and a reader
asking a follow-up has not asked you to rewrite their branch. Answer and amend instead, and say that
is what you did.

## Then go back to waiting

```
{{binary}} agent await --timeout 240
```

Background command, same as before. Exit 3 means nothing was asked — re-arm without saying anything.
Anything else means the server is gone; say so once and stop, rather than looping on a dead port.

## Keep it short

The reader is looking at a diff, not reading a report. An answer is a sentence or two in the thread.
If the honest answer is long, that is a sign the finding itself needs amending — do that instead.
