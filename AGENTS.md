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

There are no npm publish scripts: every merge to develop whose version is not yet on npm is
published by `.github/workflows/release.yml`, with a `v<version>` tag and a GitHub release. The
workflow needs the `NPM_TOKEN` secret (publish rights on the `@naturalcycles` scope).

Bump in every pull request that touches anything the artifact is built from — `packages/`,
`scripts/`, `skills/`, `README.md`, `LICENSE`, or the root
`package.json`/`package-lock.json`/`tsconfig.json`; tests are exempt. The release workflow enforces exactly that set: a merge to develop whose version is
already on npm and whose diff (since that version's tag) touched it fails, which is what catches
two parallel branches bumping to the same number — the second to land would otherwise ship
nothing, silently. A comment-only source change trips the same wire; bump anyway, a patch number
costs nothing.
