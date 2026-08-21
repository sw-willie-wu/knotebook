# API contract summary

All endpoints are served by the `app` container. Errors use the shape `{ "error": { "code": "...", "message": "..." } }` unless noted. "Auth" = session cookie required; "Admin" = admin session required. Any `Auth`/`Admin` row can also return `401 unauthorized` (missing/invalid session) or, for `Admin` rows, `403 forbidden` (authenticated but not an admin) — these are omitted from the per-row status codes below for brevity.

| Endpoint | Method | Auth | Notable status codes |
|---|---|---|---|
| `/api/auth/config` | GET | none | 200 `{oidc: {enabled: boolean}}` — tells the client whether to show the "Continue with SSO" option |
| `/api/auth/oidc/login` | GET | none | 302 (browser-navigation endpoint, not JSON — redirects to the identity provider's authorization endpoint). On failure before that point, redirects to `/login?error=<code>` instead: `oidc_unavailable`, `too_many_requests` |
| `/api/auth/oidc/callback` | GET | none | 302 (browser-navigation endpoint, not JSON — redirects to `/` on success and sets the session cookie). On failure, redirects to `/login?error=<code>`: `oidc_unavailable`, `too_many_requests`, `oidc_state_mismatch`, `oidc_exchange_failed`, `oidc_email_unverified`, `oidc_email_missing`, `oidc_conflict`, `account_disabled` |
| `/api/auth/login` | POST | none | 200, 400 `invalid_body`, 401 `invalid_credentials`, 403 `account_disabled`, 429 `too_many_attempts` (body includes `retryAfterMs`)/`server_busy` |
| `/api/auth/logout` | POST | none | 204 |
| `/api/auth/me` | GET | Auth | 200, 401 `unauthorized` |
| `/api/auth/password` | POST | Auth | 204, 400 `invalid_body`/`password_too_short`, 401 `invalid_credentials`, 429 `server_busy` |
| `/api/notes` | POST | Auth | 201, 400 `invalid_body` |
| `/api/notes` | GET | Auth | 200 |
| `/api/notes/:ref` | GET | Auth | 200, 404 `not_found` (`:ref` is a note id, custom slug, or `<vanity>-<id>` path) |
| `/api/notes/:id` | PATCH | Auth | 200, 400 `invalid_body`, 403 `forbidden`, 404 `not_found`, 409 `slug_taken`, 429 `too_many_requests` (slug changes only) |
| `/api/notes/:id` | DELETE | Auth | 204, 403 `forbidden`, 404 `not_found` |
| `/api/notes/:id/links` | POST | Auth | 204 (replaces the note's outgoing wikilink set wholesale), 400 `invalid_body` (non-uuid target, or more than `MAX_LINK_TARGETS`=1000 targets after de-duplication), 403 `forbidden` (viewer), 404 `not_found`, 409 `not_loaded` (the note isn't currently loaded in the collaboration server for this connection — the client's own self-healing resubmit on next `synced` recovers this, no user-visible retry needed), 409 `server_busy` (transient write conflict — a concurrent request should be retried) |
| `/api/notes/:id/backlinks` | GET | Auth | 200 `{backlinks: [{id, title, slug}]}` (notes that link to `:id`, filtered to ones you can read, newest-updated first, capped at `MAX_BACKLINKS`=200), 404 `not_found` |
| `/api/notes/:id/collab-token` | POST | Auth | 200 (issues a short-lived token for the real-time collab connection; if you have no access to the note this still returns 200 with `role:'none'` in the body rather than 403/404 — the token itself is then rejected when the client tries to connect), 429 `too_many_requests` |
| `/api/notes/:id/shares` | GET | Auth (owner) | 200, 403 `forbidden`, 404 `not_found` |
| `/api/notes/:id/shares` | PUT | Auth (owner) | 200, 400 `invalid_body`/`cannot_share_with_self`, 403 `forbidden`, 404 `not_found`/`user_not_found` |
| `/api/notes/:id/shares/:userId` | DELETE | Auth (owner) | 204, 403 `forbidden`, 404 `not_found`/`share_not_found` |
| `/api/notes/:id/uploads` | POST | Auth | 201 `{id, url}` (multipart, field name `file`, image formats only), 400 `invalid_body` (missing file, or a malformed multipart body), 403 `forbidden` (viewer — has read access but not editor+), 404 `not_found` (no read access to the note at all — note the reversal from the usual pattern: here "can't even see it" is 404 and "can see it, can't edit it" is 403, same as `PATCH`/`DELETE` on the note itself), 413 `file_too_large` (over `MAX_UPLOAD_BYTES`=10MB), 415 `unsupported_media_type` (magic-byte sniff failed — the declared `Content-Type` is never trusted), 429 `too_many_requests` (120 uploads per user per 10 minutes) |
| `/api/uploads/:id` | GET | Auth | 200 (streams the file with `Cache-Control: private, max-age=31536000, immutable`), 403 `forbidden` (authenticated, upload exists, but you have no access to the note it belongs to — deliberately not 404: the id is an unguessable `crypto.randomUUID()`, so there's nothing to hide by pretending it doesn't exist), 404 `not_found` (bad/non-uuid id, or no such upload, or the DB row exists but the file is missing from disk) |
| `/api/admin/users` | GET | Admin | 200 |
| `/api/admin/users` | POST | Admin | 201, 400 `invalid_body`/`password_too_short`, 409 `email_taken`, 429 `server_busy` |
| `/api/admin/users/:id/disable` | POST | Admin | 204, 400 `cannot_disable_self`, 404 `user_not_found` |
| `/api/admin/users/:id/enable` | POST | Admin | 204, 404 `user_not_found` |
| `/api/admin/users/:id/promote` | POST | Admin | 204, 404 `user_not_found` |
| `/api/admin/ai/providers` | GET | Admin | 200 (never includes the encrypted key; `hasKey` boolean instead) |
| `/api/admin/ai/providers` | POST | Admin | 201, 400 `invalid_body` |
| `/api/admin/ai/providers/:id` | PATCH | Admin | 200, 400 `invalid_body`, 404 `not_found` (a `baseUrl` different from the stored one clears the stored key unless the same request also supplies `apiKey`; a request that sends `apiKey` alone binds that key to whatever `base_url` is stored at the time) |
| `/api/admin/ai/providers/:id` | DELETE | Admin | 204, 404 `not_found` (cascades: its models are deleted, and any action bound to one of them falls back to the next available chat model) |
| `/api/admin/ai/providers/:id/test` | POST | Admin | 200 `{ok:true}` (fetches the provider's model list upstream with the stored key — never echoes upstream response bodies back), 404 `not_found`, 502 `upstream_error`, 503 `provider_unavailable` (key can't be decrypted with the current `APP_SECRET` — re-enter it) |
| `/api/admin/ai/models` | GET | Admin | 200 |
| `/api/admin/ai/models` | POST | Admin | 201, 400 `invalid_body` (bad `providerId`), 409 `model_taken` |
| `/api/admin/ai/models/:id` | PATCH | Admin | 200, 400 `invalid_body`, 404 `not_found`, 409 `model_taken` |
| `/api/admin/ai/models/:id` | DELETE | Admin | 204, 404 `not_found` |
| `/api/admin/ai/actions` | GET | Admin | 200 |
| `/api/admin/ai/actions` | POST | Admin | 201, 400 `invalid_body` (`userTemplate` must contain `{{text}}`) |
| `/api/admin/ai/actions/:id` | PATCH | Admin | 200, 400 `invalid_body`, 404 `not_found` |
| `/api/admin/ai/actions/:id` | DELETE | Admin | 204, 400 `builtin_action` (the four built-in actions can't be deleted, only renamed/disabled), 404 `not_found` |
| `/api/ai/actions` | GET | Auth | 200 `{actions: [{id, name, applyMode}]}` (only actions that currently resolve to a usable model — i.e. "not configured" means "doesn't appear", same resolution logic as `POST /api/ai`) |
| `/api/ai` | POST | Auth | Body `{action_id, note_id, text}` (snake_case, a deliberate exception to the rest of the API's camelCase). On success, streams `text/event-stream` (SSE `delta`/`done`/`error` events) proxying the resolved upstream provider; once streaming starts, failures surface only as an SSE `error` event, never an HTTP error status. Before streaming starts: 400 `invalid_body`, 403 `forbidden` (viewer), 404 `not_found` (no access to the note, or the action doesn't exist/is disabled), 429 `too_many_requests` (30 requests/minute per user), 503 `ai_not_configured` (action's model doesn't resolve to anything usable), 503 `provider_unavailable` (provider has no key yet, or its key can't be decrypted with the current `APP_SECRET`) |
| `/collab` | WebSocket (upgrade) | collab token (Hocuspocus auth message, not a header/cookie — obtained from `POST /api/notes/:id/collab-token`) | Real-time collaboration endpoint (Yjs/Hocuspocus); a reverse proxy in front of Knotebook must forward WebSocket upgrades on this path — see [Deployment prerequisites](./self-hosting.md#deployment-prerequisites) |
| `/healthz` | GET | none | 200 |

Body/query validation failures generally return `400 invalid_body`. Passwords must be at least 12 characters (`password_too_short` otherwise). Globally: any state-changing request (`POST`/`PUT`/`PATCH`/`DELETE`) that carries a body must set `Content-Type: application/json`, or the server rejects it with `415 unsupported_media_type` before it reaches the route handler — the sole exception is `POST /api/notes/:id/uploads`, which requires `multipart/form-data` instead (and rejects `application/json` there with the same `415`).
