# @diffity/server

The hosted, multi-user diffity: the same review UI as the CLI, served for review sessions on pushed
code, and an OAuth-protected MCP endpoint through which agents create those sessions and comment on
them. The server runs no model and has no working tree; it keeps a blob-less mirror of each GitHub
repository it has been asked about.

An agent calls `create_session` with a pull request, two commits, or a base commit and a patch; the
result carries a URL, which the user opens and signs in to.

## Running on localhost

```bash
npm install
npm run build        # at the repository root: builds the UI into the server's dist

DIFFITY_DATA_DIR=/tmp/diffity-data \
DIFFITY_DEV_LOGIN=1 \
DIFFITY_DEV_GITHUB_TOKEN=$(gh auth token) \
  node packages/server/dist/index.js
```

or, from source, `npm run dev -w @diffity/server` with the same environment (the UI still has to be
built once).

Open <http://localhost:5390>, sign in with an address in the allowed domain, and add a GitHub token
under **Settings** if the dev token is not set.

## Adding it to Claude Code

```bash
claude mcp add --transport http diffity http://localhost:5390/mcp
```

The first tool call opens the browser to sign in and allow the connection. The
`diffity-review-remote` skill (installed by `diffity skills install`) drives a review through these
tools.

## Environment

| Variable | Default | |
|---|---|---|
| `DIFFITY_DATA_DIR` | — (required) | Database (`diffity.db`) and repository mirrors |
| `DIFFITY_PUBLIC_URL` | `http://localhost:5390` | The origin users and agents reach the server on; OAuth issuer and session links use it |
| `PORT` | `5390` | Port to listen on |
| `DIFFITY_BIND` | `127.0.0.1` for a localhost public URL, else `0.0.0.0` | Interface to listen on |
| `DIFFITY_SECRET_KEY` | generated per run on localhost, required elsewhere | 32 bytes, base64 (`openssl rand -base64 32`); encrypts stored GitHub tokens |
| `DIFFITY_DEV_LOGIN` | off | `1` enables the email-only development login; refused unless the public URL is localhost |
| `DIFFITY_ALLOWED_DOMAIN` | `naturalcycles.com` | Who may sign in |
| `DIFFITY_ALLOWED_EMAILS` | — | Comma-separated addresses; replaces the domain rule when set |
| `DIFFITY_DEV_GITHUB_TOKEN` | — | A token used for users who have not set their own; localhost only |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub REST API |

An `http://` public URL other than localhost is refused by the MCP SDK's OAuth metadata unless
`MCP_DANGEROUSLY_ALLOW_INSECURE_ISSUER_URL=1` is set; use https anywhere else.

## Container

```bash
docker build -t diffity-server .
docker run --rm -p 127.0.0.1:5390:5390 -v diffity-data:/data \
  -e DIFFITY_DEV_LOGIN=1 -e DIFFITY_DEV_GITHUB_TOKEN=$(gh auth token) diffity-server
```

Publish the port on loopback only while the dev login is on: it trusts whatever email is typed.

## Access and isolation

- Every session, thread, comment and walkthrough belongs to one user; another user's ids answer as
  if they did not exist.
- Before a session is created, GitHub is asked whether the user's token can read the repository.
  Mirror fetches use that token through the environment, never the mirror's config.
- OAuth client secrets, codes, access and refresh tokens and the web session cookie are stored as
  sha256 hashes; GitHub tokens are encrypted with `DIFFITY_SECRET_KEY`.
