# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Knotebook follows Keep a Changelog conventions: unreleased work accumulates under [Unreleased] and moves into a dated version section once it ships. The first release is v0.1.0.

## [Unreleased]

### Added

- Release automation: pushing a `vX.Y.Z` tag now publishes the matching GitHub Release, with the release notes taken from this file's section for that version (`scripts/changelog-section.mjs`, `.github/workflows/release.yml`). The workflow fails rather than publishing an empty release when the version has no CHANGELOG section, and can be re-run manually for a tag that was pushed earlier.

### Fixed

- Pasting Markdown now renders as blocks on Windows. Two separate defects: BlockNote's Markdown parser does not normalise CRLF, so `- ` lists and ``` fences pasted from a Windows clipboard stayed literal (headings were unaffected, which made it look arbitrary) (#28); and copying from VS Code puts a private `vscode-editor-data` format on the clipboard, which BlockNote honours ahead of everything else and turns the whole paste into a `language-markdown` code block (#27). A custom paste handler now takes over whenever the clipboard carries Markdown — plain text or `text/markdown`, including alongside HTML when the text carries line-level Markdown markers — normalising line endings first. Rich HTML pastes, in-app copies, files, VS Code copies of other languages, and pasting inside a code block all keep their existing behaviour.
- A failed session lookup no longer leaves the whole app spinning: when `GET /api/auth/me` fails with anything other than 401, the route guards now show an error with a retry button instead of treating the unresolved session as "still loading" (#7).
- Sidebar highlighting and delete-navigation now recognise a custom slug regardless of case or Unicode normalisation form, matching how slugs are normalised on save (#8).
- Editing the note title while a save is in flight no longer loses those keystrokes — neither the server's echo nor the error-path reset overwrites text the user typed after submitting (#10).
- "Copy link" works again on plain-http deployments: `navigator.clipboard` only exists in a secure context, so the button was inert on the LAN mode documented in `docs/self-hosting.md`. It now falls back to `document.execCommand("copy")` — copying inside the share dialog rather than at the document body, which a modal focus trap would otherwise defeat — and when neither route can copy, the dialog shows the URL in a read-only field to select by hand (#9).
- Dark mode no longer flashes a white screen on first paint: `index.html` applies the stored (or system) theme in an inline script before React mounts (#11).

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
