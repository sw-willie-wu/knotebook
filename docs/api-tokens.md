# API tokens

A Personal API token lets a script, a CLI, or an AI assistant work with your notes **as you**, without a browser session. This page covers the token half of #107; the OAuth authorization flow and the MCP endpoint that build on it are still in progress (see [Coming next](#coming-next)).

## What a token is

- A token acts **on your behalf** with a fixed scope. In this release it reaches note **metadata** only: it can list the notes you can read, read a note's title and details, and — with the wider scope — create a new (empty) note. It cannot read or write note **content** yet: content lives in the live-collaboration document, which a token deliberately cannot open (see [Coming next](#coming-next)). It cannot do anything else either (no sharing, no password changes, no admin actions, no deleting notes). See [Which endpoints accept a token](#which-endpoints-accept-a-token).
- Tokens start with `knb_` and are 47 characters long. The server stores only a SHA-256 hash; **the plaintext is shown exactly once**, when you create it. If you lose it, revoke it and create a new one.
- Tokens are **separate credentials from your password** — see [Security notes](#security-notes).

## Creating one

**Settings → Account → API tokens → Create API token.**

- **Name** — anything that helps you tell tokens apart later (e.g. the program that will use it). 1–64 characters.
- **Access** — *Read notes* (`notes:read`) or *Read and create notes* (`notes:write`, which includes reading).
- **Expires** — never (the default), or in 30 / 90 / 365 days. A token with no expiry keeps working until you revoke it.

Copy the token from the dialog before closing it. It will not be shown again.

You can hold up to **20 active tokens** (expired ones don't count). Creating tokens is rate-limited to 10 per hour per user.

## Using one

Send it as a Bearer token:

```sh
curl -H "Authorization: Bearer knb_…" https://<your-host>/api/notes
```

```sh
curl -X POST -H "Authorization: Bearer knb_…" -H "Content-Type: application/json" \
     -d '{"title":"From a script"}' https://<your-host>/api/notes
```

Responses are the same JSON the browser UI gets. On these endpoints a request that carries an `Authorization` header is authenticated **only** by that header — a session cookie sent alongside it is ignored.

What you get back is note **metadata** — id, title, slug, owner, your role, timestamps. The note's content isn't reachable through the REST API yet (it lives in the collaboration document, and tokens can't obtain a collaboration ticket), so a note created with a token starts empty until someone opens it in the editor. Content access for tokens is tracked in #106.

### Which endpoints accept a token

| Endpoint | Scope needed |
|---|---|
| `GET /api/notes` — list your notes | `notes:read` |
| `GET /api/notes/:ref` — read one note's metadata | `notes:read` |
| `POST /api/notes` — create a note (title only; it starts empty) | `notes:write` |
| `GET`/`POST`/`DELETE /api/mcp` — MCP endpoint | `notes:read` (**placeholder — returns `501 not_implemented` until the MCP server lands**) |

Every other endpoint that requires a login is session-cookie only and answers a plain `401 unauthorized` to a Bearer request (endpoints that need no login at all, such as public share pages, simply ignore the header). In particular, tokens can **not** manage tokens (`/api/auth/tokens`), and can **not** obtain a collaboration token for the live editor.

### Errors and rate limits

- `401 unauthorized` with a `WWW-Authenticate: Bearer …` header — no credentials, an unknown or expired token, or a token whose account is disabled. The header's `error` parameter is `invalid_token` when a Bearer token was sent but rejected, and absent when no credentials were sent — or when a non-Bearer scheme such as `Basic` was used (RFC 6750 §3).
- `403 insufficient_scope` — the token is valid but doesn't have the scope this endpoint needs (e.g. a read-only token calling `POST /api/notes`). This does **not** count against any rate limit.
- `429 too_many_requests` — token requests are rate-limited **per user, separately from browser sessions**: 300 reads per minute and 60 writes per 10 minutes. A runaway script cannot lock you out of the web UI. Invalid Bearer attempts are additionally limited per IP (30 per minute). `429` responses carry no `WWW-Authenticate` header and no `Retry-After`.

## Revoking

**Settings → Account → API tokens → Revoke.** Revocation deletes the token and takes effect immediately — the next request with it gets `401`. There is no undo; create a new token instead.

Expired tokens stay in the list (marked *Expired*) so you can see what a program was using; they are removed automatically — the next time you create a token — once they have been expired for more than 30 days.

## Security notes

- **Changing your password does not revoke your tokens.** They are independent credentials, the same way personal access tokens work on GitHub and similar services. If you think a token has leaked, revoke it here — changing your password will not stop it.
- **A token that never expires never stops working until you revoke it.** If you don't need a permanent token, pick an expiry.
- **Treat a token like a password.** Its reach is deliberately narrow today (note metadata, creating empty notes), but it will widen to note content as the MCP work lands — a leaked token is still a credential that acts as you. Don't paste it into shared config, logs, or chat.
- **An admin disabling your account also stops your tokens** — every token request re-checks the account's status.
- The server never logs a token's plaintext or the `Authorization` header.

## Coming next

- **Reading and writing note content through the API** — today a token sees note metadata only. Server-side content access is tracked in #106; the MCP endpoint below builds on it.
- **OAuth sign-in for MCP clients** — instead of pasting a token, an MCP client (Claude Code, Claude Desktop, …) will open a consent page in your browser and get its own credential, which then shows up in the same list as an *App* row. Tracked in #132.
- **The MCP endpoint itself** — `/api/mcp` currently answers `501 not_implemented` after authenticating; it exists so that MCP clients can already discover the server and how to authorize. Tracked in #108.

See also: [API contract summary](./api.md) · [Known limitations](./known-limitations.md).
