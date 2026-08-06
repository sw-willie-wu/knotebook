# Knotebook

Knotebook is an open-source, self-hostable Notion/HackMD-style collaborative note system with bring-your-own-endpoint AI built in.

Three non-negotiables:

- **No seat limits** — self-host for one person or a thousand, no license gate.
- **Real-time CRDT collaboration** — Yjs-based multiplayer editing, not a commercial add-on.
- **Bring your own AI endpoint** — point Knotebook at your own OpenAI-compatible or Anthropic endpoint (including a local/on-prem Ollama); no bundled vendor lock-in.

**Honest status:** this is the v0.2 development preview (web UI + real-time collaboration milestone) — password auth, a browser UI (note list, block editor, sharing, admin user management), and live multiplayer editing (Yjs/Hocuspocus) with role-based access control, all on top of the Milestone 1 REST API. Wikilinks/uploads, AI quick actions, and OIDC login are still ahead — see the roadmap below. If you want to drive the API directly instead of the browser UI, it's still there (see [API contract summary](#api-contract-summary)).

## Quickstart (~10 minutes)

This brings up the server and a Postgres database with `docker compose`, then walks through first-run setup in the browser.

1. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

2. Generate an `APP_SECRET` (used to sign session cookies and collab tokens, and — from a future milestone — to encrypt stored AI provider credentials) and fill it into `.env`:

   ```sh
   openssl rand -hex 32
   ```

   Paste the output as `APP_SECRET=...` in `.env`.

3. Set `PUBLIC_URL` in `.env`. For local use:

   ```
   PUBLIC_URL=http://localhost:3000
   ```

4. Start the stack (`app` + `db` services; see [Deployment prerequisites](#deployment-prerequisites) before doing this in production):

   ```sh
   docker compose up -d
   ```

5. Open `http://localhost:3000` in a browser. On a fresh instance this shows the **Setup** page, which asks for the one-time setup token — read it from the `app` container's logs:

   ```sh
   docker compose logs app | grep "Setup token"
   ```

   The server logs JSON (pino), so what you actually see (with the `docker compose` container-name prefix) looks like:

   ```
   app-1  | {"level":30,"time":1754380800000,"pid":1,"hostname":"a1b2c3d4e5f6","msg":"Setup token: 8f1c...a02b"}
   ```

   The token is the value after `Setup token: ` inside the `msg` field (64 hex characters). It is required to create the first (admin) account and is only ever printed to the log — there is no other way to retrieve it.

6. Paste the token into the Setup page along with an email, password (12+ characters), and display name, and submit. This creates the first (admin) account and logs you straight in.

7. You're in: create a note and open it in the block editor. To try live co-editing, use the admin page (linked from the user menu — you're an admin) to create a second account, then log that account in from a second browser or an incognito window, share the note with it, and watch edits sync live. There is no public sign-up; every account is created by an admin (or via `POST /api/setup` for the very first one).

If you'd rather drive the API directly than click through the browser — e.g. to script the whole flow or build another client — the same setup/login endpoints are available over `curl`; see [API contract summary](#api-contract-summary) for the full endpoint list. The loop is: setup token from logs → `POST /api/setup` → `POST /api/auth/login` → authenticated API calls, session cookie carried the same way the browser carries it.

## Deployment prerequisites

- **`PUBLIC_URL` is required.** The server refuses to start without it. It is used to decide whether session cookies are marked `Secure` and (in later releases) to build the OIDC `redirect_uri`.
- **`http://` is only accepted for `localhost` / `127.0.0.1` / `[::1]`.** Any other hostname must use `https://` — the server will refuse to start otherwise. This means production deployments must terminate TLS somewhere in front of Knotebook.
- **Reverse proxy and TLS are bring-your-own.** Knotebook does not terminate TLS itself; put a reverse proxy (nginx, Caddy, Traefik, etc.) in front of it and point `PUBLIC_URL` at the public HTTPS address.
- **Your reverse proxy must forward WebSocket upgrade requests on `/collab`** — real-time collaboration connects same-origin to `wss://<your-domain>/collab`, and a proxy that only forwards plain HTTP will silently break live editing while every other page keeps working. On nginx, the `/collab` location needs `proxy_http_version 1.1;` plus `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";`; Caddy and Traefik forward WebSocket upgrades automatically with a plain reverse-proxy directive, no extra config needed.
- **`trustProxy` caveat (read this before exposing the instance publicly):** the server currently runs Fastify with `trustProxy: true`, which means it trusts `X-Forwarded-For` (and related forwarding headers) from *any* client, not just your reverse proxy. Until this is made configurable, anyone who can reach the server directly (or route around your proxy) can forge their apparent source IP. The practical impact today is on the IP-based dimension of login rate limiting/lockout (`apps/server/src/auth/rate-limit.ts`): a forged `X-Forwarded-For` can be used to sidestep the per-IP backoff (the per-account backoff is unaffected) — and, in the other direction, an attacker can also pin failed-login counts onto an arbitrary victim IP by forging it into their requests, locking out that address rather than their own. If you expose Knotebook publicly, make sure your network topology prevents clients from reaching the app directly (i.e. the reverse proxy is the only path in), and treat the per-IP throttle as advisory rather than a hard guarantee until this is addressed.

## Single-instance warning

Only run a single `app` container. `docker compose up --scale app=N` is **not supported** and must not be used.

In-memory state (login rate limiting, the collab-token/slug-change rate limiters, the password-hashing concurrency limiter, and the one-time setup token) is already per-process, so scaling out would already produce inconsistent behavior across instances. On top of that, real-time collaboration state (Yjs/Hocuspocus) **now actually lives in server memory**: each note's live document and the set of connected clients are held in-process, with no cross-instance sync. Running multiple `app` instances behind a load balancer would let different clients editing the same note land on different instances, and their edits would **silently diverge** rather than merge or error. There is no clustering/coordination layer, so treat `app` as a single point of deployment, not a horizontally scaled service.

## Known limitations

- **In-memory rate limiting and login lockout reset on restart.** Failed-login backoff counters, the password-hashing concurrency semaphore, and the collab-token/slug-change rate limiters all live in process memory; restarting the `app` container clears them. This is also why they cannot be shared across instances — see the single-instance warning above.
- **Email addresses are case-sensitive.** `alice@example.com` and `Alice@example.com` are treated as different accounts throughout the system (login, sharing, admin user creation). This is a known rough edge, not an intentional feature.
- **A note's title is not part of the real-time collaborative document.** The block editor content syncs live over Yjs/Hocuspocus, but the title is a separate field updated via `PATCH /api/notes/:id` with last-write-wins semantics — two people renaming a note at the same moment can silently overwrite one another, unlike the CRDT-merged body.
- **Self-service password change has no UI yet.** `POST /api/auth/password` works today (see the API table below), but nothing in the web UI calls it; a settings page is coming in a later milestone.
- **Custom slugs are global and first-come, first-served.** `PATCH /api/notes/:id` with a `slug` claims it instance-wide (`409 slug_taken` if someone got there first) — there is no per-user or per-namespace scoping.
- **The setup token is valid until setup completes, or until the server restarts** (whichever comes first) — an unused token from a previous run is invalidated the next time the process starts, and a fresh one is logged.
- **Admins cannot delete user accounts, only disable them.** Account deletion (including note ownership transfer) is not implemented yet; see the roadmap.
- **Note deletion is permanent.** `DELETE /api/notes/:id` hard-deletes the note and its shares/links immediately — there is no trash/recycle bin to recover from it.
- **Most `429` responses have no `Retry-After` header or wait time at all.** Only `POST /api/auth/login`'s `429 too_many_attempts` includes a wait time, and even that is in the JSON body (`retryAfterMs`), not a standard `Retry-After` header. The two collaboration-related rate limits — `POST /api/notes/:id/collab-token` and slug changes via `PATCH /api/notes/:id` — return a bare `429 too_many_requests` with no timing information at all; callers must back off and retry at their own discretion.
- **Setting `POSTGRES_PASSWORD` after the first `docker compose up` has no effect.** Postgres only applies that environment variable while initializing a brand-new (empty) data directory. If the `db` named volume already exists, changing `POSTGRES_PASSWORD` in `.env` and restarting does nothing — either run `docker compose exec db psql -U knotebook -c "ALTER USER knotebook WITH PASSWORD '...'"` and update `DATABASE_URL` in `.env` to match, or `docker compose down -v` to discard the volume and reinitialize from scratch (this deletes all data).

## Roadmap

| Milestone | Scope |
|---|---|
| Milestone 1 (v0.1) | API foundation: password auth + setup, notes CRUD, sharing/permissions, admin user management |
| **Milestone 2 (v0.2, this release)** | Web UI + real-time CRDT collaboration (Yjs/Hocuspocus) |
| Milestone 3 | Wikilinks (`[[...]]` + backlinks) and file/image uploads |
| Milestone 4 | AI quick actions (bring-your-own OpenAI-compatible / Anthropic endpoints) |
| Milestone 5 | OIDC login |

## License

MIT — see [LICENSE](./LICENSE).

## API contract summary

All endpoints are served by the `app` container. Errors use the shape `{ "error": { "code": "...", "message": "..." } }` unless noted. "Auth" = session cookie required; "Admin" = admin session required. Any `Auth`/`Admin` row can also return `401 unauthorized` (missing/invalid session) or, for `Admin` rows, `403 forbidden` (authenticated but not an admin) — these are omitted from the per-row status codes below for brevity.

| Endpoint | Method | Auth | Notable status codes |
|---|---|---|---|
| `/api/setup/status` | GET | none | 200 |
| `/api/setup` | POST | setup token (in body) | 201, 400 `invalid_body`/`password_too_short`/`invalid_email`/`invalid_display_name`, 403 `invalid_setup_token`/`bootstrap_email_mismatch`, 409 `already_setup`, 429 `server_busy` |
| `/api/auth/login` | POST | none | 200, 400 `invalid_body`, 401 `invalid_credentials`, 403 `account_disabled`, 429 `too_many_attempts` (body includes `retryAfterMs`)/`server_busy` |
| `/api/auth/logout` | POST | none | 204 |
| `/api/auth/me` | GET | Auth | 200, 401 `unauthorized` |
| `/api/auth/password` | POST | Auth | 204, 400 `invalid_body`/`password_too_short`, 401 `invalid_credentials`, 429 `server_busy` |
| `/api/notes` | POST | Auth | 201, 400 `invalid_body` |
| `/api/notes` | GET | Auth | 200 |
| `/api/notes/:ref` | GET | Auth | 200, 404 `not_found` (`:ref` is a note id, custom slug, or `<vanity>-<id>` path) |
| `/api/notes/:id` | PATCH | Auth | 200, 400 `invalid_body`, 403 `forbidden`, 404 `not_found`, 409 `slug_taken`, 429 `too_many_requests` (slug changes only) |
| `/api/notes/:id` | DELETE | Auth | 204, 403 `forbidden`, 404 `not_found` |
| `/api/notes/:id/collab-token` | POST | Auth | 200 (issues a short-lived token for the real-time collab connection; if you have no access to the note this still returns 200 with `role:'none'` in the body rather than 403/404 — the token itself is then rejected when the client tries to connect), 429 `too_many_requests` |
| `/api/notes/:id/shares` | GET | Auth (owner) | 200, 403 `forbidden`, 404 `not_found` |
| `/api/notes/:id/shares` | PUT | Auth (owner) | 200, 400 `invalid_body`/`cannot_share_with_self`, 403 `forbidden`, 404 `not_found`/`user_not_found` |
| `/api/notes/:id/shares/:userId` | DELETE | Auth (owner) | 204, 403 `forbidden`, 404 `not_found`/`share_not_found` |
| `/api/admin/users` | GET | Admin | 200 |
| `/api/admin/users` | POST | Admin | 201, 400 `invalid_body`/`password_too_short`, 409 `email_taken`, 429 `server_busy` |
| `/api/admin/users/:id/disable` | POST | Admin | 204, 400 `cannot_disable_self`, 404 `user_not_found` |
| `/api/admin/users/:id/enable` | POST | Admin | 204, 404 `user_not_found` |
| `/api/admin/users/:id/promote` | POST | Admin | 204, 404 `user_not_found` |
| `/collab` | WebSocket (upgrade) | collab token (Hocuspocus auth message, not a header/cookie — obtained from `POST /api/notes/:id/collab-token`) | Real-time collaboration endpoint (Yjs/Hocuspocus); a reverse proxy in front of Knotebook must forward WebSocket upgrades on this path — see [Deployment prerequisites](#deployment-prerequisites) |
| `/healthz` | GET | none | 200 |

Body/query validation failures generally return `400 invalid_body`. Passwords must be at least 12 characters (`password_too_short` otherwise). Globally: any state-changing request (`POST`/`PUT`/`PATCH`/`DELETE`) that carries a body must set `Content-Type: application/json`, or the server rejects it with `415 unsupported_media_type` before it reaches the route handler.
