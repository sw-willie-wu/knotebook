# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Knotebook follows Keep a Changelog conventions: unreleased work accumulates under [Unreleased] and moves into a dated version section once it ships. The first release is v0.1.0.

## [Unreleased]

### Security

- An embedded image, video, audio or file URL is now checked again when it is rendered, not only when it is typed into the embed field. Note content is a collaborative Yjs document, so any collaborator with edit access can write block properties directly and bypass the input check entirely — a `javascript:` or `data:` URL written that way went into every other reader's document unfiltered (inert in an image or media `src`, but it had no business being there). Uploaded files keep working: the render-side check deliberately accepts the relative URLs uploads produce. A URL that fails the check renders as a broken image or player rather than being fetched (#12).
- An AI provider's stored API key is now cryptographically bound to the provider it belongs to, so a key that ends up under the wrong provider is reported as undecryptable instead of being used. The ciphertext was AES-256-GCM but carried no associated data, so a key copied into another provider's row decrypted just fine and that provider would happily send it upstream — which is how a row restored from an old backup, or a hand-written `UPDATE`, could silently start billing someone else's account. This is an integrity check rather than a defence against an attacker who can already write to the database: anyone who can move ciphertext between rows can also point a provider's base URL at a host they control and read the key in plaintext. Old ciphertexts still decrypt and are rewritten in the new format on the next start (including disabled providers; a failed rewrite is logged and retried next time, never blocking startup). **The rewrite is one-way** — see [Known limitations](docs/known-limitations.md) before rolling back to an older version (#14).
- Changing an AI provider's Base URL now clears its stored API key. The key is sent in plaintext to whatever host that field names — by design, that is what a provider is — so until now any administrator could point an existing provider at a host they controlled, press Test, and receive a key they were never able to read back through the UI. Supplying a new key in the same edit keeps the provider working in one step, and the Settings UI warns before saving. Editing a provider without touching its URL does not clear anything. This does not make an untrusted administrator safe — they can still point a provider somewhere and wait for a key to be entered again, which is now visible rather than silent, and logged with the account and the old and new host. See [Known limitations](docs/known-limitations.md) (#46).

### Fixed

- A rejected collaboration handshake no longer tells people they lost access to a note when they did not. The server had one rejection reason for three different situations, and the client turned all of them into "You no longer have access to this note", closed the note and returned to the list. So an account that was disabled, or whose sessions were invalidated by a password change elsewhere, produced that notice instead of a sign-out; an unexpected server-side error produced it too. The server now separates a genuine access decision from "this token cannot be used right now", and the client only acts on the former — anything else retries the handshake on the same widening delay used for token failures, which for a revoked session converges on a sign-out within seconds. A revoked share still converges on the same notice it always did. Relatedly, a note that finished deleting while a tab was in its reconnect backoff now says the note was deleted rather than blaming the person's access, for a two-minute window after the delete; past that the server deliberately cannot tell the two apart, because distinguishing them for everyone would turn the connection into a way to ask whether any given note id exists (#35).
- A collaboration token response that arrives after switching notes is now ignored instead of being applied to the note now on screen. The request for the previous note stayed in flight across the switch, and its role landed in the current note's state — worst case, the previous note's `none` arrived while the current one was in its post-revocation retry window and ejected someone from a note they had every right to be in (#36).
- A note that cannot fetch its collaboration token now keeps trying instead of sitting on "Connecting" forever. When the token request kept failing past its retry budget, the connection was left open but unauthenticated with nothing scheduled to try again — so a server hiccup during a page load meant that tab stayed dead until it was reloaded, even after the server recovered. It now restarts the whole handshake on a widening delay, and resets that delay once a connection succeeds (#39).
- A reconnect that was slow to close no longer wedges the connection. The one-second safety net that covers "the socket was already gone" used to give up waiting for the real close event; if that event then arrived, it was read as an ordinary disconnect and nothing reconnected, leaving the editor on "Connecting" until reload (#34).
- Losing access to a note before its collaboration connection is established no longer parks the editor on "Connecting" forever — whether the note was still opening or the connection happened to be reconnecting at the time. When the share is revoked before that handshake completes, the server rejects the handshake itself rather than sending the close message the client was waiting for, and that rejection carried no state change at all. The client now reads it, retries once with a fresh token, and then shows the same "You no longer have access to this note" notice and returns to the note list as any other revocation (#6).
- A single SSO sign-in no longer spends two units of the same rate-limit quota. `GET /api/auth/oidc/login` and `GET /api/auth/oidc/callback` shared one 30-per-minute-per-IP bucket, and a complete sign-in always goes through both — so the usable number of sign-ins was half the advertised one, which offices behind a shared outbound IP hit first. Each endpoint now counts against its own bucket (#16).
- The failed-login throttle no longer grows without bound. Its account and IP records were only dropped when the same key happened to be touched again after 15 idle minutes, so a spray of distinct accounts or addresses left entries behind for the life of the process. Both tracks now share the same bounded map the other limiters already used, and the record evicted first is always the one whose last failure is oldest — the one closest to expiring anyway (#15).
- Deleting an AI provider now also drops it from the degraded set. Nothing else clears that entry — re-entering an API key is the only other path — so the id lingered for the life of the process (#17).
- The password-length hint is generated from the shared `MIN_PASSWORD_LENGTH` constant instead of being written out in each translation, so raising the minimum can no longer leave the UI advertising the old one (#22).

### Changed

- A refused collaboration connection now leaves a line in the server log — which note, which account, which of six causes, and whether it was refused while connecting, closed after a permission re-check, or closed because the client did not answer that re-check in time — and an unexpected error inside the handshake is logged with its stack trace instead of being flattened into a generic rejection. Since a refusal now navigates the person away rather than leaving them stuck on "Connecting", the report that reaches the maintainer is "I got kicked out", with nothing on either side to say why. These lines are capped per account, with errors on their own budget and a warning when the cap bites, and refusals decided before the token identifies anyone are logged at `debug` so an anonymous socket cannot drive them at all. See [Troubleshooting](docs/self-hosting.md#troubleshooting) (#37).
- A few stray simplified-Chinese characters and one garbled sentence in source comments (#34).
- **Breaking for reverse-proxy deployments:** `X-Forwarded-For` is no longer believed by default. It used to be trusted from any source, which let anyone forge their apparent address and walk around the per-IP login lockout and the OIDC endpoint limits. The new `TRUST_PROXY` setting turns it back on — a list of trusted proxy addresses (IPs, CIDRs, or `loopback`/`linklocal`/`uniquelocal`), a hop count, or `true` for the old behavior. **If you run behind a reverse proxy and do not set it, every visitor arrives as the proxy address and shares one rate-limit bucket**, so five bad passwords from anyone lock out everybody. The server logs a warning at startup when `PUBLIC_URL` is https while the setting is off, and once at runtime when it sees a forwarding header it was told not to trust. Note that your proxy has to send `X-Forwarded-For` for the setting to do anything (nginx does not by default), and a proxy that rewrites `Host` and relies on `X-Forwarded-Host` will now fail image uploads with 403 until `TRUST_PROXY` is set (#13).
- The collab-token rate limit stays keyed on the user, not the note, and the reasoning is now recorded next to it: the limit exists to bound what one signed-in user can cost the database, keying it per note would multiply an attacker's allowance by their note count, and keying it on the address would penalise offices behind one outbound IP (#24).
- The AI session's context value is memoised, so a streaming response no longer rebuilds every consumer — including the portal-mounted toolbar — on each delta (#20).
- `POST /api/auth/login` and `GET /api/auth/me` are typed against the shared `UserDto`, and `GET /api/auth/config` against `AuthConfigDto`. A change to those shapes now fails the build in `apps/server`, where the mistake is, rather than in the web app that consumes them (#21).
- A stray simplified-Chinese character in a source comment (#23).

## [0.1.1] - 2026-08-20

### Added

- Release automation: pushing a `vX.Y.Z` tag publishes the matching GitHub Release, with the notes taken from this file's section for that version. The workflow fails rather than publishing an empty release when a version has no section here, and can be re-run by hand for a tag pushed earlier.

### Fixed

- Markdown pasted from a Windows clipboard renders as blocks again. Line endings were the whole story: the Markdown parser does not normalise CRLF, so `- ` lists and ``` fences stayed literal while headings came through fine — which is why the failure looked arbitrary. The paste handler now normalises before parsing (#28).
- Copying a Markdown file out of VS Code and pasting it produces blocks rather than one code block. VS Code tags the clipboard with the file's language, which previously wrapped the entire paste in `language-markdown`; that tag is now honoured for code and ignored for Markdown files (#27).
- A code snippet copied from a documentation page pastes as a code block again, instead of having a leading `# comment` promoted to a heading (#27).
- A failed session lookup no longer leaves the whole app spinning. When `GET /api/auth/me` fails with anything other than 401, the route guards show an error with a retry button instead of treating the unresolved session as "still loading" (#7).
- Sidebar highlighting and delete-navigation recognise a custom slug regardless of case or Unicode normalisation form, matching how slugs are normalised on save (#8).
- Editing a note title while a save is in flight no longer loses those keystrokes — neither the server's echo nor the error-path reset overwrites what was typed after submitting (#10).
- "Copy link" works on plain-http deployments. `navigator.clipboard` only exists in a secure context, so the button was inert in the LAN mode this project documents; it now falls back to a copy inside the share dialog, and shows the URL in a read-only field when neither route can copy (#9).
- Dark mode no longer flashes a white screen on first paint (#11).

## [0.1.0] - 2026-08-14

### Added

**Server foundation & auth**
- Password-based authentication: environment-variable admin bootstrap (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) that atomically creates the first admin account at startup and forces a password change on first login, plus session cookies (JWT-backed), login/logout, self-service password change, and login rate limiting with exponential backoff/lockout.
- OIDC/SSO login: `GET /api/auth/oidc/login` and `GET /api/auth/oidc/callback` implement the authorization-code + PKCE flow against any OpenID Connect Discovery-compatible identity provider, auto-provisioning new accounts and linking to existing password accounts on a verified email, gated by a per-IP rate limiter; `GET /api/auth/config` lets the client discover whether it's enabled.
- Notes CRUD API with owner/editor/viewer sharing and role-based permissions, and admin user management (create, disable, enable, promote).
- Docker Compose deployment (`app` + Postgres `db`) with a production build, a persistent `uploads` volume, and a trusted-LAN plain-http deployment mode with a loud startup warning.

**Collaborative editing & sharing revocation**
- Real-time collaborative editing (Yjs/Hocuspocus) mounted at `/collab`, with a short-lived collab-token endpoint and role-based auth/re-verification on connect and on token refresh.
- Immediate revocation semantics: admin-disable and share-removal force-close the affected user's live collab connections; note deletion gates out reconnects during teardown.
- Y.Doc persistence with an optimistic lock and bucketed, auto-pruned snapshot backups (`note_state_backups`), plus a documented manual restore runbook (see `docs/backup-restore.md`).
- Browser UI: note list sidebar, app shell, block editor (BlockNote) with collaborative cursors and title editing, canonical note URLs, custom slugs, share dialog with role management, and an admin users page (later migrated into the Settings modal — see below).

**Wikilinks & backlinks**
- `[[wikilink]]` inline content: `[[` trigger, suggestion menu, create-and-link, and three-state rendering (resolved/unresolved/loading) in the block editor.
- Wikilink index sync (`POST /api/notes/:id/links`) with a transactional `links_clock` gate and batched target authorization, submitted by a debounced client-side link-sync watcher.
- `GET /api/notes/:id/backlinks` with inline reader authorization, and a collapsible backlinks section on the note page.

**Image uploads**
- `POST /api/notes/:id/uploads` and `GET /api/uploads/:id`, with multipart size/type limits, magic-byte content-type sniffing, and a per-user rate limit.
- Uploaded blobs are deleted after note deletion commits (best-effort).
- Restored image block with a custom FilePanel: an Upload tab for images, Embed-by-URL only for audio/video/file blocks.

**AI quick actions**
- Bring-your-own-endpoint AI: shared contracts for error codes, SSE events, and action/admin DTOs across `anthropic` and `openai_compatible` provider types.
- `POST /api/ai` SSE proxy (`text/event-stream`) with upstream reasoning/thinking-output filtering, an abort chain, and a per-user rate limit.
- Guarded apply chain in the editor: block-anchor snapshots, hash-gated apply, semantic revert, and wikilink rebinding after an AI edit.
- AI panel with a session state machine, a floating selection toolbar, streaming responses, and a split-pane note layout (editor + AI panel + backlinks, independently scrolling).

**Admin AI configuration**
- Provider/model/action CRUD (`/api/admin/ai/*`) with a connection-test endpoint, shared model resolution, and `GET /api/ai/actions` (only actions that currently resolve to a usable model).
- AI provider API keys encrypted at rest (AES-256-GCM, key derived from `APP_SECRET`); four built-in actions (rewrite/translate/summarize/continue) seeded idempotently at boot, renameable/disableable but not deletable.

**Settings modal**
- Notion-style Settings modal (Account, Users, AI) opened over the background route from the user menu, replacing the standalone `/admin/users` page; shares its password-change form with the standalone `/change-password` page used for forced resets.

**End-to-end testing**
- Playwright end-to-end test suite (`e2e/`) exercising bootstrap, notes, live collaboration, sharing/revocation, AI quick actions, and OIDC login against a stub identity provider, runnable locally via `scripts/test-e2e.sh` and wired into CI as a dedicated `e2e` job on pushes to `main` (and manual dispatch).

### Changed
- Email matching (login, sharing, admin user creation, OIDC account linking) is now case-insensitive: every write path normalizes the address to lowercase, and every lookup compares via `lower(email)`. `alice@example.com` and `Alice@example.com` now resolve to the same account.

### Fixed
- Hocuspocus setup hash-busy handling and collab hook contract corrections found in final review.
- Router `maxParamLength` raised to 512 so astral (surrogate-pair) characters in note references don't 404.
- Toast id generation no longer depends on `crypto.randomUUID`, which is unavailable in non-secure contexts such as LAN plain-http.
- Viewport-locked app shell so the editor, AI panel, and backlinks regions scroll independently instead of the whole page.
- `/admin/users` now redirects (`<Navigate replace>`) to `/settings/users` instead of 404ing, so old bookmarks/links keep working.
- AI action reorder buttons are disabled while a move is in flight, preventing rapid double-clicks from writing duplicate `sortOrder` values that made ordering unrecoverable from the UI.

### Security
- CSRF protection on uploads scoped to `Origin` header validation, with a documented exemption for requests that carry no `Origin` at all (matching legitimate non-browser clients).
- Byte-capped request body draining and an embed-URL scheme whitelist to bound abuse from unauthenticated or rejected requests.
- Outbound AI provider requests (connection test and streaming) use `redirect: "manual"` so a 3xx from a misconfigured/malicious upstream can't cause the custom `Authorization` header to be forwarded to a third-party host — undici only strips `Authorization`/`Cookie` automatically on redirect, not custom-named auth headers.
- AI provider API keys are never serialized into any API response (admin endpoints return a derived `hasKey` boolean instead of the ciphertext).

## Documentation

- [README](README.md) — quickstart and project overview.
- [docs/self-hosting.md](docs/self-hosting.md), [docs/api.md](docs/api.md), [docs/ai.md](docs/ai.md), [docs/known-limitations.md](docs/known-limitations.md), [docs/backup-restore.md](docs/backup-restore.md).
