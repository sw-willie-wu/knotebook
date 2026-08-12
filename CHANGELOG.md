# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Knotebook has not yet made a versioned release; everything to date is tracked under [Unreleased].

## [Unreleased]

### Added

**Server foundation & auth**
- Password-based authentication: one-time setup flow with atomic first-admin creation, session cookies (JWT-backed), login/logout, self-service password change, and login rate limiting with exponential backoff/lockout.
- Notes CRUD API with owner/editor/viewer sharing and role-based permissions, and admin user management (create, disable, enable, promote).
- Environment-variable admin bootstrap (`ADMIN_EMAIL`/`ADMIN_PASSWORD`) that creates the first admin account at startup and forces a password change on first login.
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

### Fixed
- Hocuspocus setup hash-busy handling and collab hook contract corrections found in final review.
- Router `maxParamLength` raised to 512 so astral (surrogate-pair) characters in note references don't 404.
- Toast id generation no longer depends on `crypto.randomUUID`, which is unavailable in non-secure contexts such as LAN plain-http.
- Viewport-locked app shell so the editor, AI panel, and backlinks regions scroll independently instead of the whole page.
- `/admin/users` now redirects (`<Navigate replace>`) to `/settings/users` instead of 404ing, so old bookmarks/links keep working.

### Security
- CSRF protection on uploads scoped to `Origin` header validation, with a documented exemption for requests that carry no `Origin` at all (matching legitimate non-browser clients).
- Byte-capped request body draining and an embed-URL scheme whitelist to bound abuse from unauthenticated or rejected requests.
- Outbound AI provider requests (connection test and streaming) use `redirect: "manual"` so a 3xx from a misconfigured/malicious upstream can't cause the custom `Authorization` header to be forwarded to a third-party host — undici only strips `Authorization`/`Cookie` automatically on redirect, not custom-named auth headers.
- AI provider API keys are never serialized into any API response (admin endpoints return a derived `hasKey` boolean instead of the ciphertext).

## Documentation

- [README](README.md) — quickstart and project overview.
- [docs/self-hosting.md](docs/self-hosting.md), [docs/api.md](docs/api.md), [docs/ai.md](docs/ai.md), [docs/known-limitations.md](docs/known-limitations.md), [docs/backup-restore.md](docs/backup-restore.md).
