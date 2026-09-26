# Working on diffity

diffity is one hosted server: `packages/server` serves the review UI (`packages/ui`) and the MCP
endpoint. See the README for what it does, its environment and the deploy.

## Layout

| Package | |
|---|---|
| `packages/parser` | Unified diff parsing, shared by the server and the UI |
| `packages/api` | The wire types and request parsers of the UI's `/s/:sid/api/*` routes |
| `packages/ui` | The review page (React Router in SPA mode, Vite, Tailwind); builds into `packages/server/dist/ui` |
| `packages/server` | Express: IAP or dev login, OAuth for MCP clients, the MCP tools and the `review` prompt (`src/review-prompt.md`), the UI's API, GitHub App connect and posting, Postgres (PGlite without `DATABASE_URL`) |

The server's esbuild bundle takes `api` and `parser` from source; the UI and the typecheck read
them from their built `dist`, so build before typechecking.

## Commands

From the repository root:

```bash
npm ci
npm run build       # parser → api → ui → server; the server build keeps the UI output
npm test            # typecheck, then every package's tests
npm run dev         # UI build in watch mode, and the server from source (needs the README's localhost env)
```

One package: `npm test -w @diffity/server`, `npm run typecheck -w @diffity/ui`. Server tests run
on in-memory PGlite; nothing needs a database or network.

## Conventions

- Node 24. The version lives only in the root `package.json`; the server build embeds it.
- Every session, thread, comment and tour belongs to one user: a store query takes the user id, and
  another user's id answers as not found. Keep the isolation tests passing.
- Schema changes are new numbered migrations in `packages/server/src/db.ts`; never edit an applied one.
- Comments explain a non-obvious current state only; no change history in code or docs.
