# Working on diffity

## Bump the version in every pull request

A running instance replaces itself only when the binary's version differs from the one it
registered (`packages/cli/src/index.ts`, `isStale`). Merge a behaviour change without a bump and
every instance already running keeps serving the old build, silently, until someone restarts it by
hand. So the version is not a release ceremony here — it is how a change reaches the people who
have diffity open.

Bump inside the pull request, as part of the branch:

```bash
npx tsx scripts/release.ts patch --no-git   # or: minor
```

`--no-git` is what makes it safe in a branch. Without it the script commits and tags, and since
`develop` takes squash merges the commit is rewritten on the way in and the tag is left pointing at
a commit that never lands.

Do not use the `release:patch` / `release:minor` npm scripts for this. They publish to npm, which
is a separate decision and, in this fork, one that is not ours to make.

A pull request that changes nothing a user could observe — a test, a comment, a rename — does not
need a bump. Everything else does.
