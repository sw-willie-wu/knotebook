# Knotebook

Knotebook is an open-source, self-hostable Notion/HackMD-style collaborative note system with bring-your-own-endpoint AI built in.

Three non-negotiables:

- **No seat limits** — self-host for one person or a thousand, no license gate.
- **Real-time CRDT collaboration** — Yjs-based multiplayer editing, not a commercial add-on.
- **Bring your own AI endpoint** — point Knotebook at your own OpenAI-compatible or Anthropic endpoint (including a local/on-prem Ollama); no bundled vendor lock-in.

**Honest status:** this is the v0.2 development preview — password auth, a browser UI (note list, block editor, sharing, admin user management), live multiplayer editing (Yjs/Hocuspocus) with role-based access control, `[[wikilinks]]` with backlinks, image uploads, and bring-your-own-endpoint AI quick actions (rewrite/translate/summarize/continue, streamed, against an admin-configured OpenAI-compatible or Anthropic provider), all on top of the Milestone 1 REST API. OIDC login is the one piece left on the roadmap below. If you want to drive the API directly instead of the browser UI, it's still there (see [API contract summary](#api-contract-summary)).

## Quickstart (~10 minutes)

This brings up the server and a Postgres database with `docker compose`, then walks through first-run setup in the browser.

1. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

2. Generate an `APP_SECRET` (used to sign session cookies and collab tokens, and to encrypt stored AI provider credentials — see [AI quick actions](#ai-quick-actions) below) and fill it into `.env`:

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

   Alternatively, you can skip the setup page entirely: set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` before the first `docker compose up`, and the server creates that admin account at startup instead of waiting for the setup page — see the commented-out example in `.env.example` and the "Known limitations" note below (it only takes effect on first initialization, and the account must change its password on first login).

7. You're in: create a note and open it in the block editor. To try live co-editing, open **Settings → Users** (linked from the user menu — you're an admin) to create a second account, then log that account in from a second browser or an incognito window, share the note with it, and watch edits sync live. There is no public sign-up; every account is created by an admin (or via `POST /api/setup` for the very first one).

If you'd rather drive the API directly than click through the browser — e.g. to script the whole flow or build another client — the same setup/login endpoints are available over `curl`; see [API contract summary](#api-contract-summary) for the full endpoint list. The loop is: setup token from logs → `POST /api/setup` → `POST /api/auth/login` → authenticated API calls, session cookie carried the same way the browser carries it.

## Deployment prerequisites

- **`PUBLIC_URL` is required.** The server refuses to start without it (or if it isn't a valid `http(s)://` URL). It is used to decide whether session cookies are marked `Secure` and (in later releases) to build the OIDC `redirect_uri`.
- **Two supported topologies.** Pick one:
  - **(a) Trusted-LAN plain http.** For a home/office network with no untrusted devices, you can run Knotebook without TLS, reachable by hostname/IP from other machines on the LAN:
    - In `docker-compose.yml`, comment out the default `"127.0.0.1:3000:3000"` port line and uncomment `"3000:3000"` instead (this binds `0.0.0.0`, i.e. every interface).
    - Set `PUBLIC_URL=http://<lan-ip-or-hostname>:3000` (e.g. `http://192.168.1.50:3000`) in `.env`.
    - Understand the trade-off before enabling this: login credentials and the session cookie travel in **cleartext**; the session cookie has **no `Secure` flag**; **anyone on the same network segment can sniff or MITM the traffic**. The server will start and stay up, but it logs a prominent warning line at startup as a reminder — the server logs JSON (see Quickstart step 5's note), so this arrives as one JSON log line with a `SECURITY WARNING: ...` `msg`, not a formatted banner. Only do this on a network where you trust every host, and accept that trade-off knowingly — it is not a substitute for topology (b) on any network you don't fully control.
  - **(b) Public — reverse proxy + TLS.** For anything reachable beyond a trusted LAN (the internet, a shared/untrusted network, etc.), terminate TLS in front of Knotebook and set `PUBLIC_URL` to the public `https://` address — see the next two bullets.
- **Reverse proxy and TLS are bring-your-own (topology (b)).** Knotebook does not terminate TLS itself; put a reverse proxy (nginx, Caddy, Traefik, etc.) in front of it and point `PUBLIC_URL` at the public HTTPS address.
- **Your reverse proxy must forward WebSocket upgrade requests on `/collab`** — real-time collaboration connects same-origin to `wss://<your-domain>/collab`, and a proxy that only forwards plain HTTP will silently break live editing while every other page keeps working. On nginx, the `/collab` location needs `proxy_http_version 1.1;` plus `proxy_set_header Upgrade $http_upgrade;` and `proxy_set_header Connection "upgrade";`; Caddy and Traefik forward WebSocket upgrades automatically with a plain reverse-proxy directive, no extra config needed.
- **`trustProxy` caveat (read this before exposing the instance publicly):** the server currently runs Fastify with `trustProxy: true`, which means it trusts `X-Forwarded-For` (and related forwarding headers) from *any* client, not just your reverse proxy. Until this is made configurable, anyone who can reach the server directly (or route around your proxy) can forge their apparent source IP. The practical impact today is on the IP-based dimension of login rate limiting/lockout (`apps/server/src/auth/rate-limit.ts`): a forged `X-Forwarded-For` can be used to sidestep the per-IP backoff (the per-account backoff is unaffected) — and, in the other direction, an attacker can also pin failed-login counts onto an arbitrary victim IP by forging it into their requests, locking out that address rather than their own. If you expose Knotebook publicly, make sure your network topology prevents clients from reaching the app directly (i.e. the reverse proxy is the only path in), and treat the per-IP throttle as advisory rather than a hard guarantee until this is addressed.

## Single-instance warning

Only run a single `app` container. `docker compose up --scale app=N` is **not supported** and must not be used.

In-memory state (login rate limiting, the collab-token/slug-change rate limiters, the password-hashing concurrency limiter, and the one-time setup token) is already per-process, so scaling out would already produce inconsistent behavior across instances. On top of that, real-time collaboration state (Yjs/Hocuspocus) **now actually lives in server memory**: each note's live document and the set of connected clients are held in-process, with no cross-instance sync. Running multiple `app` instances behind a load balancer would let different clients editing the same note land on different instances, and their edits would **silently diverge** rather than merge or error. There is no clustering/coordination layer, so treat `app` as a single point of deployment, not a horizontally scaled service.

## Restoring note content from a backup

A note's live collaborative document is `note_states` (one row per note, the current Y.Doc, written only by the collaboration server), with periodic snapshots kept in `note_state_backups` (bucketed and pruned automatically). There is no restore CLI. Restoring a note's content — from a `note_state_backups` row, or from a `pg_dump`/`pg_restore` of the whole database after data loss — means writing a Y.Doc snapshot back into `note_states`, and that's **not** a plain `UPDATE` for two reasons:

1. If the `app` process is running, the collaboration server may already hold that note's document in memory. Overwriting `note_states` underneath it changes nothing observable — the in-memory copy stays authoritative until the server evicts it, and the next periodic store just overwrites your restore with the (stale/corrupt) in-memory content again.
2. `notes.links_clock` — the counter that gates `POST /api/notes/:id/links` writes (see [API contract summary](#api-contract-summary)) — only ever moves forward, compared against the *live* document's clock. A restored document's clock can be lower than the value already sitting in `links_clock` (the wikilink index and the Y.Doc are committed independently, on different schedules). Note loading already guards against this automatically — `onLoadDocument` clamps `links_clock` down to `LEAST(links_clock, <loaded document's clock>)` every time a note is loaded, so a stale index can't actually lock future writes out on its own. Resetting `links_clock` to `0` as part of this procedure is belt-and-braces on top of that automatic clamp: it guarantees the gate is wide open regardless of what clock the restored document happens to carry, without you having to go work that clock out by hand.

Procedure, to evict a note from a running server and restore it without restarting the whole instance:

1. Confirm nobody is currently connected to the note (see the warning below — this is not optional).
2. Force-close the note's live connections: `hocuspocus.closeConnections(noteId)`.
3. Flush any in-flight debounced store for it: `hocuspocus.flushPendingStores()`.
4. Call `hocuspocus.unloadDocument(doc)` and poll `hocuspocus.documents.has(noteId)` until it's `false` — an in-flight store makes `unloadDocument` a silent no-op, so this has to be retried on a short interval, not called once and trusted.
5. With the document confirmed evicted, write the restored content into `note_states` and, **in the same database transaction**, run `UPDATE notes SET links_clock = 0 WHERE id = :noteId` — this resets the gate so the next client's wikilink submission is accepted no matter what clock the restored document happens to carry.
6. Only now lift whatever kept clients out in step 1 and allow reconnects.

**This procedure cannot be run against a note with online users.** `closeConnections` force-closes the current WebSocket, but a connected browser's collaboration provider reconnects automatically — the reconnect races step 4's polling loop, the document gets reloaded from the pre-restore database before it ever fully unloads, and the loop either spins forever or converges on the wrong content. There is no connection gate for this the way there is for note deletion (which sets an internal `deleting` flag *before* closing connections so reconnect attempts are rejected — see `beforeNoteDeleted` in `apps/server/src/collab/hooks-impl.ts`); a restore has no equivalent, so the outside world genuinely cannot be reconnecting to this note while you run it. In practice this means either taking the whole instance offline (stop the `app` container — with no process running there's no in-memory state to fight, so steps 2–4 are unnecessary and you can write the restored content plus the `links_clock` reset directly via SQL) or, if you need to avoid a full outage, first confirming and enforcing that nobody is connected to that specific note.

There's no packaged tool for steps 2–5 today — running them live means attaching a one-off script to the running server process (the `hocuspocus` instance exposed by `CollabServer`, see `apps/server/src/collab/server.ts`). The eviction (steps 2–4) and `links_clock` reset (step 5) portion of this sequence — the mechanics, not the online-user failure mode above, which isn't something a test can safely reproduce — is exercised in `apps/server/test/collab-links.test.ts:375` (its client disconnects deliberately, sidestepping the auto-reconnect race described above, rather than exercising it).

## AI quick actions

Knotebook ships four built-in AI quick actions — rewrite, translate, summarize, continue — that run against a provider you configure yourself; there's no bundled AI vendor and nothing is sent anywhere until an admin sets one up.

**Setup (admin only):** open **Settings → AI** (linked from the user menu). Configuration is three layers, in order:

1. **Providers** — an upstream AI API. Two types:
   - `anthropic` — talks to the Anthropic Messages API. `baseUrl` is the API **origin**, e.g. `https://api.anthropic.com` (no `/v1` suffix — Knotebook appends the versioned path itself).
   - `openai_compatible` — talks to any OpenAI-compatible chat-completions API (OpenAI itself, a local/on-prem [Ollama](https://ollama.com) instance, vLLM, etc.). `baseUrl` **includes** the `/v1` suffix, e.g. `http://<host>:11434/v1` for Ollama. The API key is optional here — leave it blank for an unauthenticated local server.
   - Use the **Test** button after saving a provider to confirm Knotebook can reach it with the stored key before relying on it.
2. **Models** — a specific model ID under one of your providers (e.g. `claude-sonnet-4-5` or `llama3.1`), marked available for chat. One model per provider can be flagged as the default; quick actions that aren't bound to a specific model fall back to it.
3. **Actions** — the four built-in ones (rename or disable them freely, but they can't be deleted — see "Known limitations" below), plus any custom actions you add with your own system prompt and a user-message template containing the literal placeholder `{{text}}` (the selected text is substituted in verbatim, special-character-safe).

An action with no model configured for it, and no provider default to fall back to, simply doesn't appear in the editor — "not configured" fails closed and silently, not with an error.

**API keys are encrypted at rest** with a key derived from `APP_SECRET` (AES-256-GCM; the ciphertext, IV, auth tag, a non-secret key fingerprint (used to detect a stale `APP_SECRET` before attempting to decrypt), and a format version number are the only things stored — the server process never even selects the ciphertext column back out of the database except on the one code path that needs to decrypt it to make an upstream call). **Rotating `APP_SECRET` invalidates every stored provider key** — Knotebook can no longer decrypt them, providers show as degraded in the Settings UI, and you'll need to re-enter each provider's API key (which re-encrypts it under the new secret) before quick actions using it work again.

**Using it:** select text in the block editor and pick an action from the floating toolbar, or open the action list in the right-hand AI panel to run one over the whole note. The response streams in live. Each action is configured as either "direct" (built-in Rewrite/Translate: applies automatically as the response finishes) or "preview" (built-in Summarize/Continue writing: shows the result and waits for you to accept or discard it) — either way you can cancel mid-stream, and an applied direct action can still be reverted afterward. If the model's own extended-thinking/reasoning output is available upstream, it's filtered out server-side and never reaches the browser — only the final answer streams to the client.

## Known limitations

- **In-memory rate limiting and login lockout reset on restart.** Failed-login backoff counters, the password-hashing concurrency semaphore, and the collab-token/slug-change rate limiters all live in process memory; restarting the `app` container clears them. This is also why they cannot be shared across instances — see the single-instance warning above.
- **Email addresses are case-sensitive.** `alice@example.com` and `Alice@example.com` are treated as different accounts throughout the system (login, sharing, admin user creation). This is a known rough edge, not an intentional feature.
- **A note's title is not part of the real-time collaborative document.** The block editor content syncs live over Yjs/Hocuspocus, but the title is a separate field updated via `PATCH /api/notes/:id` with last-write-wins semantics — two people renaming a note at the same moment can silently overwrite one another, unlike the CRDT-merged body.
- **Admins cannot reset another user's password.** Self-service password change has a UI now (**Settings → Account**, reachable once signed in via the user menu; any account with `mustChangePassword: true` — env-bootstrapped admins and accounts created via the admin UI — is instead routed to the standalone `/change-password` page automatically on next login until they change it), but there is no UI or API for an admin to reset a password on someone else's behalf; the account holder must know their current password to change it themselves.
- **The old `/admin/users` page path redirects.** `/admin/users` redirects to `/settings/users` — admin-only user management moved into the same Settings modal as account and AI configuration (linked from the user menu). Bookmarks/links to the old path still work.
- **Closing the Settings modal navigates forward, not back.** Opening Settings (account/users/AI) pushes a new browser history entry rather than replacing the current one; closing it (Esc, the ✕, or clicking outside) navigates back to wherever you were. If you then press your browser's own Back button, it reopens the modal instead of leaving the page you were on before Settings — one extra Back press gets you past it.
- **A deleted built-in AI action reappears on the next server restart.** The four built-in quick actions (rewrite/translate/summarize/continue) are re-created idempotently on every startup if missing. Renaming or disabling a built-in action persists normally — only deletion is undone. If you don't want a built-in action available, disable it (or rename it to repurpose it) rather than deleting it.
- **Custom slugs are global and first-come, first-served.** `PATCH /api/notes/:id` with a `slug` claims it instance-wide (`409 slug_taken` if someone got there first) — there is no per-user or per-namespace scoping.
- **The setup token is valid until setup completes, or until the server restarts** (whichever comes first) — an unused token from a previous run is invalidated the next time the process starts, and a fresh one is logged.
- **Admins cannot delete user accounts, only disable them.** Account deletion (including note ownership transfer) is not implemented yet; see the roadmap.
- **Note deletion is permanent.** `DELETE /api/notes/:id` hard-deletes the note and its shares, wikilinks, and uploaded files immediately — there is no trash/recycle bin to recover from it. File removal from disk happens best-effort after the delete transaction commits; if that unlink fails (or the process is killed mid-cleanup) the blob is orphaned on disk with no DB row pointing at it — see "Uploaded file cleanup is not automatic" below.
- **Most `429` responses have no `Retry-After` header or wait time at all.** Only `POST /api/auth/login`'s `429 too_many_attempts` includes a wait time, and even that is in the JSON body (`retryAfterMs`), not a standard `Retry-After` header. The other rate-limited endpoints — `POST /api/notes/:id/collab-token`, slug changes via `PATCH /api/notes/:id`, and `POST /api/notes/:id/uploads` — return a bare `429 too_many_requests` with no timing information at all; callers must back off and retry at their own discretion.
- **Setting `POSTGRES_PASSWORD` after the first `docker compose up` has no effect.** Postgres only applies that environment variable while initializing a brand-new (empty) data directory. If the `db` named volume already exists, changing `POSTGRES_PASSWORD` in `.env` and restarting does nothing — either run `docker compose exec db psql -U knotebook -c "ALTER USER knotebook WITH PASSWORD '...'"` and update `DATABASE_URL` in `.env` to match, or `docker compose down -v` to discard the volume and reinitialize from scratch (this deletes *all* named volumes, not just `db` — it takes the `uploads` volume with it too, so every note and every uploaded image is gone).
- **`ADMIN_EMAIL`/`ADMIN_PASSWORD` only take effect on first initialization** — the same "only applies while there's nothing there yet" shape as `POSTGRES_PASSWORD` above. Once the instance has completed setup (whether via these variables, the setup page, or `POST /api/setup` directly), leaving them set in `.env` and restarting the `app` container does nothing: no new account is created, no error, no warning. There's no supported way to use them to change an existing account after the fact — see the Quickstart note above for how they behave on a genuinely empty database.
- **Pasting a right-click-copied image is blocked.** Copying an image from a web page or another app with your browser/OS's "Copy Image" and pasting it into the editor gets intercepted with a "please save the file first, then drag it in" toast, even though it looks like a plain image paste. The clipboard in that case carries an HTML representation alongside the image file, and the guard treats "file plus a usable text/HTML representation" as ambiguous and blocks it outright rather than guessing which one you meant. Work around it by saving the image to disk first and dragging the file in, or by using your OS's "Copy image as file" if it has one. Dragging an image straight off a web page (no save step) embeds it by its external URL instead of uploading it — see "External images embedded by URL" below. The same guard also blocks pasting a file copied from a file manager (e.g. Windows Explorer) whenever the clipboard additionally carries a plain-text filename representation, for the same first-match-wins reason.
- **Uploaded file cleanup is not automatic.** Orphaned blobs on disk (a DB row was never created, or was deleted, but the file wasn't removed) can accumulate from: an `INSERT` failing after the file was already written (best-effort unlink, which can itself fail); `DELETE /api/notes/:id`'s best-effort post-commit unlink failing; and a known upstream BlockNote behavior where, during a multi-file drag-and-drop under live collaboration, a block can be removed (by undo, a manual delete, or a remote collaborator) while its upload is still in flight — the editor's own `updateBlock` then throws, aborting the rest of that batch and leaving any already-uploaded files in that batch orphaned. None of this corrupts data; it just wastes disk space. Automatic orphan cleanup is planned for a future release.
- **A copied image block still points at the note it was originally uploaded to, not the note displaying it.** BlockNote's image blocks store a plain `/api/uploads/:id` URL, and copying that block into a different note copies the URL, not the file. Two consequences: deleting the *source* note deletes the blob too, permanently breaking the image everywhere else it's been copied, with no way to recover it; and a reader who can see the note the image is copied into, but not the note it was originally uploaded to, gets `403` trying to load it — access is checked against the upload's owning note, not wherever it's currently displayed.
- **Uploads have no disk quota.** Any editor can keep uploading images until the volume fills up; the only mitigation is the 120-uploads-per-10-minutes-per-user rate limit below, which slows this down but doesn't cap total usage.
- **A note's backlinks reflect whichever editor most recently submitted its outgoing link set, filtered to what *they* could see at the time.** The wikilink index is submitted by the editing client as a full replacement of the note's outgoing links (not a diff), and each target is filtered through that submitter's own read access. If an editor with narrower access than a previous editor saves the note, links to notes they can't see drop out of the index — and reappear if someone with broader access edits it again. This is by design (there's no server-side parse of the document to establish "ground truth" independent of who's editing), not a bug, but it means backlinks can be surprising in heavily-shared notebooks.
- **`GET /api/notes/:id/backlinks` is capped at 200 results (`MAX_BACKLINKS`), most-recently-updated first, with no pagination.** A note linked from more than 200 others silently shows only the newest 200 sources.
- **`POST /api/notes/:id/links` has no rate limit.** Unlike most other write endpoints, this one is deliberately not throttled — its per-request cost is already bounded by the single batched authorization query and the 1000-target cap (`MAX_LINK_TARGETS`), and it's normally called by a debounced background sync, not directly by user action.
- **The note list has no pagination**, and it's the only source used both for wikilink autocomplete candidates and for resolving a wikilink's live title — both effectively cap out at however many notes the list endpoint returns before something has to change. Full-text search (a real solution to this) is a future release.
- **External images embedded by URL are hotlinked, not proxied.** BlockNote's image block also accepts a plain external URL (not just an uploaded file) — Knotebook renders that URL directly in the reader's browser rather than fetching and re-serving it, so the external host sees the reader's IP address and referrer on every view. Treat this the same as embedding any external image in any other tool.
- **Uploads have no CSRF check when the request carries no `Origin` header.** `POST /api/notes/:id/uploads` rejects a mismatched `Origin`, but a request with *no* `Origin` header at all is allowed through, matching how legitimate non-browser API clients behave. This is a deliberate trade-off documented for completeness, not an oversight.
- **Revoked upload access can still be served from a browser's cache.** `GET /api/uploads/:id` sets `Cache-Control: private, max-age=31536000, immutable` so a browser never re-checks it — appropriate for a URL that never changes content, but it also means a viewer whose share was just revoked can keep seeing an image they already loaded until that cache entry is evicted on its own, well past any revocation SLA the rest of the system aims for.
- **The uploads directory is a Docker named volume; if it isn't mounted, uploaded images vanish the next time the `app` container is rebuilt.** The default `docker-compose.yml` already mounts it (`uploads:/app/uploads`) — this only bites if you've customized the compose file and dropped that volume.
- **Only image blocks can upload; audio, video, and file blocks are embed-by-URL only.** The block editor's file panel gives image blocks both an Upload tab and an Embed tab, but audio/video/file blocks only ever get the Embed tab — there's no server-side upload path for them, only pasting in a URL to an already-hosted file.
- **AI quick-action requests are rate-limited to 30 per user per minute, in-memory.** Like the other in-memory limiters above, this counter lives in process memory and resets whenever the `app` container restarts (and can't be shared across instances — see the single-instance warning).
- **AI quick actions round-trip your note content through Markdown, which can lose fidelity.** The selected block(s) are serialized to Markdown before being sent to the AI provider, and the response is parsed back from Markdown into blocks; formatting that doesn't survive that round-trip cleanly (e.g. some nested structures or block-specific attributes) can be altered by running a quick action over it, independent of anything the AI itself changed.
- **Anthropic responses are capped at 4096 output tokens (`max_tokens`), with no error on truncation.** If a quick action's response hits that limit, Anthropic's API stops generating and Knotebook streams whatever was produced without surfacing an error — long outputs (e.g. "continue" on a lengthy selection) can be silently cut off mid-sentence. This is a fixed server-side constant today, not yet a configurable setting.

## Roadmap

| Milestone | Scope |
|---|---|
| Milestone 1 (v0.1) | API foundation: password auth + setup, notes CRUD, sharing/permissions, admin user management |
| Milestone 2 | Web UI + real-time CRDT collaboration (Yjs/Hocuspocus) |
| Milestone 3 | Wikilinks (`[[...]]` + backlinks) and image uploads |
| **Milestone 4 (v0.2, this release)** | AI quick actions (bring-your-own OpenAI-compatible / Anthropic endpoints), admin-configurable via the Settings modal |
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
| `/api/admin/ai/providers/:id` | PATCH | Admin | 200, 400 `invalid_body`, 404 `not_found` |
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
| `/collab` | WebSocket (upgrade) | collab token (Hocuspocus auth message, not a header/cookie — obtained from `POST /api/notes/:id/collab-token`) | Real-time collaboration endpoint (Yjs/Hocuspocus); a reverse proxy in front of Knotebook must forward WebSocket upgrades on this path — see [Deployment prerequisites](#deployment-prerequisites) |
| `/healthz` | GET | none | 200 |

Body/query validation failures generally return `400 invalid_body`. Passwords must be at least 12 characters (`password_too_short` otherwise). Globally: any state-changing request (`POST`/`PUT`/`PATCH`/`DELETE`) that carries a body must set `Content-Type: application/json`, or the server rejects it with `415 unsupported_media_type` before it reaches the route handler — the sole exception is `POST /api/notes/:id/uploads`, which requires `multipart/form-data` instead (and rejects `application/json` there with the same `415`).
