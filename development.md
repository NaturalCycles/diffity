# Development Guide

## Prerequisites

- Node.js (v22+ recommended)
- npm
- Git

## Initial Setup

```bash
# Install dependencies
npm install

# Start all watchers (run this in the diffity repo)
npm run dev
```

This automatically creates the `diffity-dev` binary, builds skills, adds `.bin` to your PATH (in `~/.zshrc` or `~/.bashrc`), and starts five concurrent processes:

| Process | What it does |
|---------|-------------|
| **parser** | `tsc --watch` on `@diffity/parser` |
| **git** | `tsc --watch` on `@diffity/git` |
| **cli** | `tsc --watch` on the CLI package |
| **ui** | `vite build --watch` on `@diffity/ui` |
| **skills** | Rebuilds Claude skills on change |

If this is your first time, source your shell profile to pick up the PATH change:

```bash
source ~/.zshrc  # or ~/.bashrc
```

Then, in any git repository:

```bash
diffity-dev
```

This opens a diff viewer for that repo's working tree changes.

## How the Dev Loop Works

### UI changes

The UI uses `vite build --watch` instead of `vite dev`. This is intentional — `vite dev` serves files from memory and never writes to disk, but the CLI server serves static files from `packages/cli/dist/ui/`. Using `vite build --watch` rebuilds the output on every change so the CLI can serve it. Refresh the browser to see changes.

### Server changes (CLI, git, parser)

`tsc --watch` recompiles TypeScript to `dist/` on save. The `diffity-dev` binary uses `node --watch-path=packages/cli/dist` which auto-restarts the Node process when any file in `dist/` changes. The port is persisted across restarts — the server retries the same port if it's briefly held by the old process.

### How `diffity-dev` works

`diffity-dev` is a shell script (not a symlink) created by `scripts/link-dev.ts`. It runs:

```bash
node --watch-path=<dist-dir> <cli-entry> --no-open "$@"
```

- **Shell script, not symlink** — a symlink to `dist/index.js` would load the CLI once and never pick up server changes. The shell script wraps it with `node --watch-path` so it restarts on recompilation.
- **`--watch-path`** — restarts the process when `tsc --watch` writes new files to `dist/`.
- **`--no-open`** — prevents opening a new browser tab on every restart. Open the URL manually on first run.

## Project Structure

```
diffity/
├── packages/
│   ├── api/          # Wire types shared by server and UI
│   ├── cli/          # CLI server and entry point
│   │   ├── src/
│   │   └── dist/
│   │       ├── index.js    # CLI binary
│   │       └── ui/         # Built UI (served as static files)
│   ├── git/          # Git operations (execSync wrappers)
│   ├── github/       # GitHub PR integration (gh wrappers)
│   ├── parser/       # Diff parsing library
│   └── ui/           # React frontend (Vite + Tailwind)
├── scripts/
│   ├── dev.ts        # Starts all watchers concurrently
│   ├── link-dev.ts   # Creates the diffity-dev shell script
│   ├── build.ts      # Production build (all packages in order)
│   └── build-skills.ts
└── .bin/
    └── diffity-dev   # Generated shell script for development
```

### Package dependencies

```
diffity (cli) ───► @diffity/api, @diffity/git, @diffity/github, @diffity/parser
@diffity/ui ─────► @diffity/api, @diffity/parser
@diffity/github ─► @diffity/api, @diffity/parser
@diffity/api ────► @diffity/parser        (types only)
@diffity/git ────► nothing
```

The UI builds into `packages/cli/dist/ui/` so the CLI can serve it as static files. In production, everything ships as a single `diffity` npm package.

## Build Commands

```bash
# Full production build (all packages in dependency order)
npm run build

# Build a single package
npm run build -w @diffity/parser
npm run build -w @diffity/git
npm run build -w @diffity/ui
npm run build -w @naturalcycles/diffity
```

## Testing

```bash
# Run all tests
npm run test

# Run tests for a specific package
npm run test -w @diffity/parser
npm run test -w @diffity/ui

# Watch mode
npm run test:watch -w @diffity/parser
npm run test:watch -w @diffity/ui
```

## Comparing review models

`scripts/inbox-compare.ts` re-prepares a pull request the inbox has already reviewed, with a
different model or effort, and puts the two sets of findings side by side. It is how a change to
`agent.model` is decided: by what the candidate finds, not by what it costs.

```bash
npm run build   # the script runs the built CLI, so build first
npx tsx scripts/inbox-compare.ts NaturalCycles/NCBackend3#14550 --model opus
npx tsx scripts/inbox-compare.ts NaturalCycles/NCBackend3#14550 --effort medium --out /tmp/14550.md
```

The baseline is the newest bundle for that pull request under `~/.diffity/inbox/bundles`
(`--bundles-dir` to look elsewhere, `--head <sha>` to pick an older one). The candidate gets a
scratch worktree and its own diffity data directory under a fresh temp directory (`--scratch` to
name it), so nothing is written into `~/.diffity` and a running `diffity inbox` is undisturbed. The
worktree is removed afterwards unless `--keep` is passed, which leaves it in place so the
candidate's own review can be opened in the browser. One invocation is one agent run, and it takes
as long as a real preparation — up to half an hour.

The candidate is pinned to the baseline's head, so a pull request that has moved on since — or has
merged — can still be compared. An earlier head usually comes along with the pull request's own
ref; when it does not, it is fetched by sha, which the forge serves for any commit reachable from a
ref it advertises. A head that was force-pushed away is gone for good, and the run is refused with
`the baseline's head <sha> is no longer reachable from origin`.

Reading the table: each severity row is `baseline count | reproduced, new`. *Reproduced* means a
candidate finding landed on the same file with an overlapping line range — a one-line finding
counts as its line give or take two. *New* counts candidate findings no baseline finding covers;
some are real, some are noise, which is what the finding list underneath is for. The `cost / time`
row is the candidate's own run: two models are not comparable on the baseline's, which predates
the run log. Exit code 0 is a completed comparison, 2 a candidate that skipped or failed, 1 a
usage error. `--json` prints the same numbers as one object.

The baseline bundles were prepared by the old pipeline, which loaded the reviewer's own settings,
skills and MCP servers and let the agent run the repository's toolchain. A difference between the
columns is therefore prompt *and* model, not model alone.

## CLI Usage (for reference while developing)

```bash
diffity-dev                        # Working tree changes
diffity-dev HEAD~1                 # Last commit vs working tree
diffity-dev HEAD~3                 # Last 3 commits vs working tree
diffity-dev main..feature          # Compare branches
diffity-dev --port 3000            # Custom port
```

## Troubleshooting

### Port already in use

If `diffity-dev` fails with `EADDRINUSE`, a previous process is still running:

```bash
# Find and kill the process
lsof -i :5391
kill <PID>
```

The server retries the same port up to 30 times (15 seconds) on startup to handle the brief overlap during `--watch` restarts. But if a completely separate process holds the port, you need to kill it manually.

### Changes not showing up

1. Make sure `npm run dev` is running in the diffity repo
2. Check that the relevant watcher (ui/cli/parser/git) isn't showing errors
3. Refresh the browser — there's no HMR in this setup
4. For server changes, wait for the `--watch` restart (you'll see the diffity banner re-print in the terminal where `diffity-dev` is running)
