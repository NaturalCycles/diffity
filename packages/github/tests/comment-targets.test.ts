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
  const existing = [{ path: 'src/a.ts', line: 11, side: 'RIGHT', body: 'the original wording' }];

  it('matches on position, not on wording', () => {
    // Editing a finding locally and resubmitting used to post a second comment beside the first.
    expect(isAlreadyCommented(existing, comment('src/a.ts', 11, 'reworded since'))).toBe(true);
  });

  it('leaves a different line alone', () => {
    expect(isAlreadyCommented(existing, comment('src/a.ts', 12))).toBe(false);
  });

  it('leaves a different file alone', () => {
    expect(isAlreadyCommented(existing, comment('src/b.ts', 11))).toBe(false);
  });

  it('distinguishes the two sides', () => {
    const onLeft: PrComment = { ...comment('src/a.ts', 11), side: 'LEFT' };

    expect(isAlreadyCommented(existing, onLeft)).toBe(false);
  });
});
