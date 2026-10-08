<img src="./packages/ui/public/brand.svg" width="80" />

# diffity

A hosted, multi-user code review page for agents' findings. An agent reads a change from its own
checkout and writes findings through diffity's MCP endpoint; the user opens the session's link, reads
the findings on a GitHub-style diff, discusses them, and posts them to the pull request as one
review. The server runs no model and has no working tree; it keeps a blob-less mirror of each GitHub
repository it has been asked about.

Grown from Kamran Ahmed's [nilbuild/diffity](https://github.com/nilbuild/diffity).

## Branches

- `develop`, the default branch, is this server. It deploys to Cloud Run through `deploy.yml` and
  never publishes to npm.
- `cli` is the local tool, `@naturalcycles/diffity` on npm: a single-user diffity with a working
  tree, an inbox daemon and the `diffity agent` commands. Its releases run from that branch alone.
  The two share the `parser` and `api` packages by history, not by merges; a fix wanted on both is
  made twice.

## Using it

Add the connector to Claude Code (or any MCP client that does OAuth):

```bash
claude mcp add --transport http diffity https://diffity.prod.naturalcycles.net/mcp
```

The first tool call opens the browser to sign in and allow the connection. Then:

- **The `review` prompt** (arguments `repo`, `pr`) holds the review method, so nothing has to be
  installed on the agent's side. In Claude Code it is `/mcp__diffity__review`.
- **Sessions.** `create_session` takes a pull request, two commits, or a base commit and a patch
  (for work that is not pushed). Its result carries the page's URL. A new session on a pull request
  that moved on carries the open findings over.
- **Findings** are inline comments with a severity prefix (`P1`/`P2`/`P3` unless the repository
  says otherwise); tours give the diff a reading order.
- **Posting.** From the page the user posts the findings to the pull request as one review, and
  pulls GitHub's review threads in. Posting is only for pull request sessions, and refused once the
  pull request has moved past the session's head. GitHub is reached as the user: through the GitHub
  App they connect on **Settings**, or a token pasted there when no App is configured.

The **Sessions** page also lists the open pull requests that ask for the user's review, asked of
GitHub's search with the user's own access (cached for a minute). Each row links the user's newest
session on that pull request, or has a button that creates one; the first session on a repository
clones it, which can take half a minute. On **Settings** the user filters the list: titles
containing any of a list of patterns (one per line, ignoring case) are left out, and drafts are
unless they tick **List drafts too**. The `list_review_requests` tool answers the same list, so an
agent can be asked to review what is waiting.

### Live questions and the attendant

A reader can ask the agent that wrote the review about a finding: **Ask Claude** on a comment or
reply sends it as an aside and queues it for that session. The agent waits without blocking its
chat: the `live_token { session }` tool returns a plain `curl` + POSIX shell command, which the
agent runs as a background command (Claude Code: Bash with `run_in_background`; it works the same
in a claude.ai cloud session, where nothing of diffity is installed). The command long-polls
`GET /live/await?session=<id>&wait=25` — held up to 25 s, under the load balancer's 30 s timeout —
and exits only when a question arrives, printing it as JSON. The agent answers with `reply`, which
marks the question answered on the page, and runs the command again. A handed-out question that
gets no answer within 10 minutes is handed out again; a `reply` or `review_start` on the session
gives what the agent holds there another 10 minutes. While the agent holds a question its badge
reads *agent working…* and the toolbar **Agent working**; otherwise the toolbar shows **Agent
listening** while the session, or the user's queue, was polled in the last minute, and without
either, Ask Claude is disabled.

One agent can also attend the user's whole queue. `live_token {}`, without a session, returns the
same command polling `GET /live/await?wait=25`; it hands out the user's oldest request across every
session: questions from any review page, and sessions handed over for review. While an agent polls
the queue, the **Sessions** page says **Agent listening** and each waiting pull request's button
becomes **Create and review**: it creates the session, queues it for the agent, and opens the page,
whose banner follows the review from *Queued for your agent* and *Your agent picked this up…*
through *Reviewing… n findings so far* to **Review ready · Reload**, which takes in the findings and
the reading order. An existing session goes to the agent from its banner's **Ask your agent to
review**, or from the **review** button beside it on the Sessions page; an agent hands a session
over with `create_session { …, review: true }`. While the agent works on requests, the Sessions
page says **Agent working on n requests**. One review waits per session;
`review_done` settles it, a review an agent has started is not handed to another, and one nobody
holds 15 minutes after it was queued shows as not picked up. The `review` prompt's **Attend**
section is the agent's side of it.

`/live/await` bypasses IAP on the load balancer and takes only the live token as a bearer: no
cookie, no MCP token. A live token is stored hashed, expires after 12 hours, and allows waiting and
nothing else: on its one session, or for a queue token on the user's queue and any of the user's
sessions. Once it is refused (401), the command exits with status 1.

A repository can name its review standards in a `.diffity.json` at its root, which the
`get_standards` tool reads:

```json
{ "review": { "severities": ["P1", "P2", "P3"], "standards": ".claude/skills/code-review/SKILL.md" } }
```

## Running on localhost

The database is PGlite under the data directory; the dev login trusts any typed address in the
allowed domain, and a dev GitHub token stands in for connecting GitHub.

```bash
pnpm install
pnpm build

DIFFITY_DATA_DIR=/tmp/diffity-data \
DIFFITY_DEV_LOGIN=1 \
DIFFITY_DEV_GITHUB_TOKEN=$(gh auth token) \
  node packages/server/dist/index.js
```

Open <http://localhost:5390> and sign in, and add the connector with
`claude mcp add --transport http diffity http://localhost:5390/mcp`. `pnpm dev` with the same
environment runs the server from source and restarts it when that changes; after a UI change,
`pnpm -F @diffity/ui build` and reload the page.

## Environment

| Variable | Default | |
|---|---|---|
| `DIFFITY_DATA_DIR` | — (required) | Repository mirrors, and the PGlite database (`pg/`) when there is no `DATABASE_URL` |
| `DATABASE_URL` | — | Postgres connection URL; without it the database is PGlite under the data directory |
| `DIFFITY_PG_CA` | — | The Postgres server CA's PEM; the server is then verified against it, not by host name (`verify-ca`), and `sslmode`/`sslrootcert` in the URL are ignored |
| `DIFFITY_PUBLIC_URL` | `http://localhost:5390` | The origin users and agents reach the server on; OAuth issuer and session links use it |
| `PORT` | `5390` | Port to listen on |
| `DIFFITY_BIND` | `127.0.0.1` for a localhost public URL, else (or on Cloud Run) `0.0.0.0` | Interface to listen on |
| `DIFFITY_TRUST_PROXY` | off | Express `trust proxy`: the number of proxies in front (`1` on Cloud Run), `true`, or addresses |
| `DIFFITY_SECRET_KEY` | generated per run on localhost, required elsewhere | 32 bytes, base64 (`openssl rand -base64 32`); encrypts stored GitHub tokens |
| `DIFFITY_IAP_AUDIENCE` | — | `/projects/<number>/global/backendServices/<id>`: every page request must carry a valid IAP assertion for it; no login form |
| `DIFFITY_DEV_LOGIN` | off | `1` enables the email-only development login; refused unless the public URL is localhost, and with IAP |
| `DIFFITY_ALLOWED_DOMAIN` | `naturalcycles.com` | Who may sign in (checked behind IAP too) |
| `DIFFITY_ALLOWED_EMAILS` | — | Comma-separated addresses; replaces the domain rule when set |
| `DIFFITY_GITHUB_APP_CLIENT_ID`, `DIFFITY_GITHUB_APP_CLIENT_SECRET` | — | The GitHub App users connect on **Settings**; without it, users paste a token there instead |
| `DIFFITY_GITHUB_APP_SLUG` | — | The App's URL name, for the install link on **Settings** |
| `DIFFITY_DEV_GITHUB_TOKEN` | — | A token used for users who have not connected GitHub; localhost only |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub REST and GraphQL API |
| `GITHUB_URL` | `https://github.com` | Where the App's authorization and token exchange happen |

An `http://` public URL other than localhost is refused by the MCP SDK's OAuth metadata unless
`MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=1` is set; use https anywhere else.

The GitHub App's callback URL is `<DIFFITY_PUBLIC_URL>/github/callback`. Its user tokens expire
and are refreshed by the server; the App reads only repositories it is installed on.

## Container

```bash
docker build -t diffity .
docker run --rm -p 127.0.0.1:5390:5390 \
  -e DIFFITY_DEV_LOGIN=1 -e DIFFITY_DEV_GITHUB_TOKEN=$(gh auth token) diffity
```

Publish the port on loopback only while the dev login is on: it trusts whatever email is typed.
The image keeps its data (mirrors, and PGlite without `DATABASE_URL`) in `/data`.

## Deploy

`.github/workflows/deploy.yml`, run by hand (`workflow_dispatch`), builds and smoke-tests the image,
pushes it to `europe-west1-docker.pkg.dev/nc-innovation-496314/diffity/diffity`, and deploys the
Cloud Run service `diffity` in `nc-innovation-496314`. The infrastructure (IAP load balancer at
`diffity.prod.naturalcycles.net`, Cloud SQL Postgres over the VPC connector, runtime service
account, secrets) is in NaturalCycles/NCInfraIaC. On the load balancer, `/mcp`, `/token`,
`/register`, `/revoke`, `/live/await` and the OAuth `/.well-known/*` metadata bypass IAP, since
agents authenticate with diffity's own OAuth or a live token; everything else is behind IAP. The
service accepts unauthenticated invocations for those open paths, so the deploy limits its ingress
to the load balancer and disables the `run.app` URL.

The deploy runs one instance (pending OAuth consents are held in memory), sets
`DIFFITY_PUBLIC_URL`, `DIFFITY_TRUST_PROXY=1` and `DIFFITY_IAP_AUDIENCE`, and mounts the secrets `diffity-database-url`
(`DATABASE_URL`), `diffity-postgres-ca` (`DIFFITY_PG_CA`) and `diffity-secret-key`
(`DIFFITY_SECRET_KEY`). It needs:

- the `GCP_SERVICE_ACCOUNT` secret in the `prod` environment, and `SLACK_API_TOKEN`;
- the repository variable `DIFFITY_IAP_AUDIENCE`:
  `/projects/<project number>/global/backendServices/<id>`, the id from
  `gcloud compute backend-services describe diffity --global --project nc-innovation-496314 --format='value(id)'`;
- the repository variable `DIFFITY_GITHUB_APP_CLIENT_ID` (and optionally
  `DIFFITY_GITHUB_APP_SLUG`) for the GitHub App; with it, the secret
  `diffity-github-app-client-secret` is mounted as `DIFFITY_GITHUB_APP_CLIENT_SECRET`. Without it,
  users paste a GitHub token on **Settings**.

## Access and isolation

- Every session, thread, comment and walkthrough belongs to one user; another user's ids answer as
  if they did not exist.
- Behind IAP the user is whoever IAP's signed `x-goog-iap-jwt-assertion` names, verified on every
  request against Google's keys and `DIFFITY_IAP_AUDIENCE`; a request without it gets 401.
- Before a session is created, GitHub is asked whether the user's token can read the repository.
  Mirror fetches use that token through the environment, never the mirror's config.
- OAuth client secrets, codes, access and refresh tokens and the web session cookie are stored as
  sha256 hashes; GitHub tokens (pasted, or the App's access and refresh tokens) are encrypted with
  `DIFFITY_SECRET_KEY`.
- Posting is only for pull request sessions, and refused once the pull request has moved past the
  session's head: the user asks for a new session, which the open findings carry over to.

## License

[MIT](./LICENSE) — © Kamran Ahmed (the upstream [diffity](https://github.com/nilbuild/diffity)),
with Natural Cycles' changes.
