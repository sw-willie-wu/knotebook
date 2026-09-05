# API tokens

A Personal API token lets a script, a CLI, or an AI assistant work with your notes **as you**, without a browser session. This page covers the token half of #107; the MCP endpoint that builds on it is still in progress (see [Coming next](#coming-next)).

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

You can hold up to **20 active tokens** (expired ones don't count). OAuth app credentials count toward the same 20 — so with 20 authorized apps you cannot create a personal token until you revoke one. Creating tokens is rate-limited to 10 per hour per user.

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

Expired tokens stay in the list (marked *Expired*) so you can see what a program was using; they are removed automatically once they have been expired for more than 30 days, and OAuth apps that have not been used for 30 days are removed along with their credential. There is no scheduler: the clean-up runs opportunistically, on any of six triggers — creating a personal token, registering an app, opening the consent page (an authorization request), deciding on it (pressing Allow or Deny), exchanging a code for a token, and refreshing a token.

Revoking an OAuth app's credential here also, eventually, removes its registration (see [Troubleshooting](#troubleshooting) below) — once that has happened, an app you want back has to be added again, not just re-authorized.

## Authorizing an app instead (OAuth)

An MCP client that supports OAuth does not need a pasted token. When it first calls `/api/mcp` it gets a `401` that tells it where the authorization server is; it registers itself (dynamic client registration — no secret, and its `redirect_uri` must be a loopback address on your own machine), opens your browser at the consent page, and once you press **Allow** it exchanges the one-time code for its own credential. That credential shows up in **Settings → Account → API tokens** as an *App* row, next to your personal tokens, and is revoked the same way. Re-authorizing the same app replaces its previous credential rather than adding another.

**What the consent page tells you, and why it matters:** the app's name is whatever the app said it was — it is *not* verified. What you can trust is the redirect address shown on the page: it is always a loopback address (`127.0.0.1`, `localhost` or `[::1]`), so only a program running on the computer where the browser is can receive the code. Only press Allow when you yourself just started that program. Denying (or hitting the credential limit) discards the request; to try again, start over from the app.

### How to connect

MCP requires the server and its authorization endpoints to be `https://`, and clients enforce that differently — which command you run depends on whether your deployment is `https://` or plain `http://` (see [Self-hosting](./self-hosting.md#deployment-prerequisites)).

- **`https://` deployment — connect directly:**

  ```sh
  claude mcp add --transport http knotebook https://<your-host>/api/mcp
  claude mcp login knotebook
  ```

  The consent page shows the app as **"Claude Code (knotebook)"** — the part in brackets is the name you gave the server.

- **Plain `http://` deployment (the self-hosting guide's trusted-LAN topology) — go through `mcp-remote`, which lets you opt out of the TLS check explicitly with `--allow-http`:**

  ```sh
  claude mcp add knotebook -- npx -y mcp-remote http://<your-host>/api/mcp --allow-http
  ```

  Claude Desktop, or any client that only speaks stdio, uses the same command inside its `mcpServers` config:

  ```json
  { "command": "npx", "args": ["-y", "mcp-remote", "http://<your-host>/api/mcp", "--allow-http"] }
  ```

  On Windows, Claude Desktop usually needs the command wrapped:

  ```json
  { "command": "cmd", "args": ["/c", "npx", "-y", "mcp-remote", "http://<your-host>/api/mcp", "--allow-http"] }
  ```

  Drop `--allow-http` once the host is `https://`. The consent page shows the app as **"MCP CLI Proxy"**, and mcp-remote caches its registration and tokens under `~/.mcp-auth/mcp-remote-v1/` on the machine running the client.

Both `claude mcp add` forms default to *local* scope — the server only exists in the directory you ran the command in. Add `-s user` to either one to use it from anywhere.

Once you press Allow, the client has its credential — but the server it is talking to isn't finished: `/api/mcp` answers `501 not_implemented` (see [Coming next](#coming-next)), so the client will still list Knotebook as failing to start. That `501` is the good outcome; a `401` would mean the credential never arrived.

## Troubleshooting

- **"This application's registration with Knotebook has expired or does not exist."** — a plain-text page instead of the consent screen. The app is presenting a registration this server no longer recognizes: a registration is dropped once it is more than 24 hours old and has no live credential and no authorization code on record (even an expired one buys it one more cleanup pass) — which includes a registration whose credential you revoked in Settings, and one whose authorization was never exchanged for a credential — and apps unused for 30 days are dropped along with their credential. **The client does not recover on its own** — `mcp-remote`, for example, gets `401`, fails its refresh, reopens the authorize URL with the same stale `client_id`, lands back on this page, and then just sits on "Waiting for authorization…" until it times out. Recover by clearing the client's cached registration and starting over: for Claude Code's direct transport, run `claude mcp remove knotebook` and add it again — it registers fresh. For `mcp-remote`, delete that server's cached files under `~/.mcp-auth/mcp-remote-v1/` (or the whole directory) and start the client again.
- **Another window of the same app suddenly asks you to authorize again.** Re-authorizing an app replaces its previous credential, so a second instance that shared the old one (e.g. a second Claude Code window) gets `401` and its refresh fails. Let it run the authorization flow once more.
- **The consent page says the request has already been used or has expired.** Requests live for 10 minutes and are single-use; signing in (especially via SSO) can eat into that. Start again from the app.
- **Pressing Allow gives "Token limit reached".** You hold 20 credentials already. Revoke one in Settings → Account, then start again from the app — the request you were on has been consumed.
- **Claude Code says `Couldn't complete authentication for "knotebook": Refusing to send credentials to non-https token endpoint '…'. OAuth token requests MUST use TLS …`.** Its built-in OAuth client gets all the way through consent and the browser callback, then refuses at the last step to send the token exchange to a plain `http://` authorization server (loopback is exempt; your deployment isn't) — `/oauth/token` never sees the request. Either serve the deployment over `https://`, or, on a plain-http LAN deployment, switch to `mcp-remote --allow-http` instead (see [How to connect](#how-to-connect) above).
- **`mcp-remote` says `Non-HTTPS URLs are only allowed for localhost or when --allow-http flag is provided`.** Same requirement, checked up front against the server URL you gave it. Add `--allow-http` to the `mcp-remote` command (see [How to connect](#how-to-connect) above).

## Security notes

- **Changing your password does not revoke your tokens.** They are independent credentials, the same way personal access tokens work on GitHub and similar services. If you think a token has leaked, revoke it here — changing your password will not stop it.
- **A token that never expires never stops working until you revoke it.** If you don't need a permanent token, pick an expiry.
- **Treat a token like a password.** Its reach is deliberately narrow today (note metadata, creating empty notes), but it will widen to note content as the MCP work lands — a leaked token is still a credential that acts as you. Don't paste it into shared config, logs, or chat.
- **An admin disabling your account also stops your tokens** — every token request re-checks the account's status.
- The server never logs a token's plaintext or the `Authorization` header.

## Coming next

- **Reading and writing note content through the API** — today a token sees note metadata only. Server-side content access is tracked in #106; the MCP endpoint below builds on it.
- **The MCP endpoint itself** — `/api/mcp` currently answers `501 not_implemented` after authenticating; it exists so that MCP clients can already discover the server and how to authorize. Tracked in #108.

See also: [API contract summary](./api.md) · [Known limitations](./known-limitations.md).
