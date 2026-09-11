import { describe, it, expect } from 'vitest';
import { commentableLines, isAlreadyCommented } from '../src/comment-targets.js';
import type { PrComment } from '../src/types.js';

const patch = `diff --git a/src/a.ts b/src/a.ts
index 111..222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,4 +10,5 @@ export function a() {
   const x = 1;
-  return x;
+  const y = 2;
+  return x + y;
 }
diff --git a/src/b.ts b/src/b.ts
index 333..444 100644
--- a/src/b.ts
+++ b/src/b.ts
@@ -1,2 +1,2 @@
-const old = true;
+const now = true;
 export {};
`;

function comment(filePath: string, endLine: number, body = 'P2: x'): PrComment {
  return { filePath, side: 'RIGHT', startLine: null, endLine, body };
}

function onThePr(body: string, login = 'fiddur', line = 11, path = 'src/a.ts') {
  return { path, line, side: 'RIGHT', body, login };
}

describe('commentableLines', () => {
  it('collects the lines each file actually shows', () => {
    const lines = commentableLines(patch);

    expect(lines.get('src/a.ts')?.RIGHT.has(11)).toBe(true);
    expect(lines.get('src/b.ts')?.RIGHT.has(1)).toBe(true);
  });

  it('excludes a line the pull request does not touch', () => {
    const lines = commentableLines(patch);

    // Line 400 is nowhere in the patch, so a comment there cannot be posted.
    expect(lines.get('src/a.ts')?.RIGHT.has(400)).toBe(false);
  });

  it('knows nothing about a file outside the patch', () => {
    expect(commentableLines(patch).get('src/nope.ts')).toBeUndefined();
  });

  it('survives an empty patch', () => {
    expect(commentableLines('').size).toBe(0);
  });
});

describe('isAlreadyCommented', () => {
  const existing = [onThePr('P2: the original wording')];

  it('drops a finding the record says was already sent, however it reads now', () => {
    // The forge cannot update the comment already there, so a locally edited finding that
    // has been posted once is not posted a second time beside it.
    const sent: PrComment = { ...comment('src/a.ts', 11, 'reworded since'), threadId: 'abc' };

    expect(isAlreadyCommented(existing, sent, { threadIds: new Set(['abc']) })).toBe(true);
  });

  it('sends a new finding on a line that already carries an older one', () => {
    // The reported bug: earlier rounds leave comments on a line, resolved or not, and a fresh
    // finding there was silently swallowed as a resend.
    const fresh: PrComment = { ...comment('src/a.ts', 11, 'P1: this is a different problem'), threadId: 'new' };

    expect(isAlreadyCommented(existing, fresh, { threadIds: new Set(['abc']), viewerLogin: 'fiddur' })).toBe(false);
  });

  it('takes the same wording in the same place as a resend when no record says otherwise', () => {
    // A finding imported from a bundle, or posted from another machine, has no local mark.
    expect(isAlreadyCommented(existing, comment('src/a.ts', 11, 'P2: the original wording'))).toBe(true);
  });

  it('ignores line endings and trailing space in that comparison', () => {
    const withCrLf = [onThePr('P2: one\r\ntwo\r\n')];

    expect(isAlreadyCommented(withCrLf, comment('src/a.ts', 11, 'P2: one\ntwo'))).toBe(true);
  });

  it('does not treat another reviewer\'s identical remark as ours', () => {
    const theirs = [onThePr('P2: the original wording', 'someone-else')];

    expect(isAlreadyCommented(theirs, comment('src/a.ts', 11, 'P2: the original wording'), { viewerLogin: 'fiddur' })).toBe(false);
  });

  it('leaves a different line alone', () => {
    expect(isAlreadyCommented(existing, comment('src/a.ts', 12))).toBe(false);
  });

  it('leaves a different file alone', () => {
    expect(isAlreadyCommented(existing, comment('src/b.ts', 11))).toBe(false);
  });

  it('distinguishes the two sides', () => {
    const onLeft: PrComment = { ...comment('src/a.ts', 11, 'P2: the original wording'), side: 'LEFT' };

    expect(isAlreadyCommented(existing, onLeft)).toBe(false);
  });
});
