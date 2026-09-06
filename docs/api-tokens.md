# API tokens

A Personal API token lets a script, a CLI, or an AI assistant work with your notes **as you**, without a browser session. This page covers the credentials — issuing them, what they reach, and how an app can authorize itself instead. What a program can then *do* with note content is documented separately in [AI editing](./ai-editing.md); the MCP endpoint that builds on all of it is not finished yet (see [Coming next](#coming-next)).

## What a token is

- A token acts **on your behalf** with a fixed scope. In this release it can list the notes you can read, read a note's title and details, **read a note's content** as markdown (the whole note or one section, with the fingerprints a write needs — `GET /api/notes/:id/content`), and — with the wider scope — **write a note's content**: create a note with content in it, replace the whole note, replace, delete or insert after one section, append to the end, and undo any of those again. Writes are guarded by those fingerprints, so a change made from a stale read is refused rather than overwriting what someone typed in the browser meanwhile; see [AI editing](./ai-editing.md). It cannot do anything else (no sharing, no password changes, no admin actions, no deleting notes). See [Which endpoints accept a token](#which-endpoints-accept-a-token).
- Tokens start with `knb_` and are 47 characters long. The server stores only a SHA-256 hash; **the plaintext is shown exactly once**, when you create it. If you lose it, revoke it and create a new one.
- Tokens are **separate credentials from your password** — see [Security notes](#security-notes).

## Creating one

**Settings → Account → API tokens → Create API token.**

- **Name** — anything that helps you tell tokens apart later (e.g. the program that will use it). 1–64 characters.
- **Access** — *Read notes* (`notes:read`) or *Read and write notes* (`notes:write`, which includes reading). `notes:write` lets the token create notes, change the content of notes you already have, and revert those changes — see [AI editing](./ai-editing.md).
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

What you get back from `GET /api/notes/:ref` is note **metadata** — id, title, slug, owner, your role, timestamps, and who last edited it. The note's content is readable through `GET /api/notes/:id/content` (the whole note as markdown, or one section, together with the fingerprints a write needs) and writable through `POST /api/notes/:id/edits`. `POST /api/notes` can also carry a `content` field, so a note can be created with its text in a single request rather than starting empty:

```sh
curl -X POST -H "Authorization: Bearer knb_…" -H "Content-Type: application/json" \
     -d '{"title":"From a script","content":"# Notes\n\nWritten by a program.\n"}' \
     https://<your-host>/api/notes
```

⚠ `POST /api/notes` rejects **unknown** body fields with `400 invalid_body` rather than ignoring them — so a misspelled `content` is reported instead of quietly creating an empty note.

Everything a program needs in order to write safely — how sections are addressed, what the fingerprints mean, the five operations, the error codes and how to undo a change — is in [AI editing](./ai-editing.md).

### Which endpoints accept a token

| Endpoint | Scope needed |
|---|---|
| `GET /api/notes` — list your notes | `notes:read` |
| `GET /api/notes/:ref` — read one note's metadata | `notes:read` |
| `GET /api/notes/:id/content` — read a note's content as markdown (whole or one section, with fingerprints) | `notes:read` |
| `GET /api/notes/:id/edits` — list a note's recorded API writes, and whether each can still be undone | `notes:read` |
| `POST /api/notes` — create a note, optionally with its `content` | `notes:write` |
| `POST /api/notes/:id/edits` — write a note's content: replace the whole note, replace/insert after/delete one section, or append | `notes:write` |
| `POST /api/notes/:id/edits/:editId/revert` — undo one recorded write | `notes:write` |
| `GET`/`POST`/`DELETE /api/mcp` — MCP endpoint | `notes:read` (**placeholder — returns `501 not_implemented` until the MCP server lands**) |

Every other endpoint that requires a login is session-cookie only and answers a plain `401 unauthorized` to a Bearer request (endpoints that need no login at all, such as public share pages, simply ignore the header). In particular, tokens can **not** manage tokens (`/api/auth/tokens`), and can **not** obtain a collaboration token for the live editor.

### Errors and rate limits

- `401 unauthorized` with a `WWW-Authenticate: Bearer …` header — no credentials, an unknown or expired token, or a token whose account is disabled. The header's `error` parameter is `invalid_token` when a Bearer token was sent but rejected, and absent when no credentials were sent — or when a non-Bearer scheme such as `Basic` was used (RFC 6750 §3).
- `403 insufficient_scope` — the token is valid but doesn't have the scope this endpoint needs (e.g. a read-only token calling `POST /api/notes`). This does **not** count against any rate limit.
- `429 too_many_requests` — token requests are rate-limited **per user, separately from browser sessions**: 300 reads per minute and 60 writes per 10 minutes. The content endpoints add tighter budgets on top of those: `GET /api/notes/:id/content` and `GET /api/notes/:id/edits` share 120 reads per minute per user, and `POST /api/notes/:id/edits`, `POST /api/notes/:id/edits/:editId/revert` and `POST /api/notes` carrying `content` share 30 writes per minute per user. A token calling them burns from both budgets, so its real ceilings there are 120/min and 30/min, not 300/min and 60/10 min. The tighter budgets are keyed by user, not by credential, so they apply to browser sessions too, not just tokens — though in practice the web app never calls these endpoints itself; it reads and writes note content through the live collaboration connection instead. A runaway script cannot lock you out of the web UI. Invalid Bearer attempts are additionally limited per IP (30 per minute). `429` responses carry no `WWW-Authenticate` header and no `Retry-After`.
- `503 server_busy` — on the two writing endpoints only: another write to the same note held the per-note queue for longer than 10 seconds. Nothing was applied and nothing was recorded; retry.

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
- **Treat a token like a password.** A `notes:write` token can **rewrite the content of any note you can edit** — not just create new ones — and those writes go straight into the live document everyone is looking at. A leaked one is a credential that acts as you, on your notes. Nothing is destroyed silently: every API write is recorded, listed by `GET /api/notes/:id/edits`, and can be reverted while it is still the most recent state of those blocks — but only the most recent 100 entries per note are kept. Prefer `notes:read` for anything that only needs to read, and don't paste a token into shared config, logs, or chat.
- **An admin disabling your account also stops your tokens** — every token request re-checks the account's status.
- The server never logs a token's plaintext or the `Authorization` header.

## Agent display name

Each credential carries a short **agent name** — the name a program is shown under inside the app. It appears on the AI's cursor label while it is working on a note, on that note's last-edited line, and on every row of its **AI edit history**.

By default it is derived from the credential's own name: the first word, lowercased, with anything outside letters, digits, `.`, `_` and `-` removed — so `Claude Code (knotebook)` becomes `claude`, and an app registered as `MCP CLI Proxy` becomes `mcp`. If nothing usable is left (a name written entirely in Chinese, say) it becomes `agent`.

**Settings → Account → API tokens → Rename agent** changes it, for personal tokens and authorized apps alike. Letters, digits, `.`, `_` and `-`, up to 32 characters; clear the field to go back to the derived name. Everyone who can see the note sees this name, so it is worth making it recognizable rather than clever.

Re-authorizing an app keeps the name you gave it, as long as the app comes back with the same registration — an app that had to register again (see [Troubleshooting](#troubleshooting)) arrives as a fresh credential and starts from the derived name. Renaming is also available over the API (`PATCH /api/auth/tokens/:id`, session-cookie only, like everything else under `/api/auth/tokens`); the full rules are in [AI editing](./ai-editing.md#agent-display-name).

## Coming next

- **The MCP endpoint itself** — `/api/mcp` currently answers `501 not_implemented` after authenticating; it exists so that MCP clients can already discover the server and how to authorize. Tracked in #108.

See also: [AI editing](./ai-editing.md) · [API contract summary](./api.md) · [Known limitations](./known-limitations.md).
