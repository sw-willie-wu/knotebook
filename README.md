# Knotebook

English | [繁體中文](README.zh-TW.md)

Knotebook is an open-source, self-hostable Notion/HackMD-style collaborative note system with bring-your-own-endpoint AI built in.

Three non-negotiables:

- **No seat limits** — self-host for one person or a thousand, no license gate.
- **Real-time CRDT collaboration** — Yjs-based multiplayer editing, not a commercial add-on.
- **Bring your own AI endpoint** — point Knotebook at your own OpenAI-compatible or Anthropic endpoint (including a local/on-prem Ollama); no bundled vendor lock-in.

**Status:** the latest release is v0.8.0 (2026-10-10). What it does today:

- **Writing together** — a block editor with live multiplayer editing (Yjs/Hocuspocus), `[[wikilinks]]` with backlinks, image uploads, and Mermaid diagrams (see [Diagrams](docs/diagrams.md)).
- **Version history** — every note keeps versions, saved automatically (after a few minutes without edits, when everyone leaves, around AI and API writes) or by hand; compare any two side by side, apply one to bring an older state back, and rely on retention rules and three switches (site, your own notes, a group) that turn automatic saving off (see [Version history](docs/versions.md)).
- **Presentation mode** — play any note as a slide show: its headings become the slides, the cover is the title, and signed-in viewers see collaborators' edits as they happen (see [Known limitations](docs/known-limitations.md)).
- **Accounts** — password sign-in and sign-in through any number of OpenID Connect identity providers (GitLab, Google, or another provider), which can also be made the only way in; people can register on their own unless a site admin turns registration off, and can link several sign-in services to one account. Site admins manage users, sign-in services (with their icons) and AI providers on their own **Site admin** pages (`/admin/users`, `/admin/auth`, `/admin/ai`) — see [Sign-in providers](docs/self-hosting.md#sign-in-providers) and [Accounts](docs/self-hosting.md#accounts).
- **Sharing** — a personal note is private, shared with chosen people as editors or viewers, or published as a read-only public link (see [Sharing](docs/sharing.md)).
- **Groups** — a group owns its notes, which live at `/g/<group id>/<name>`; what each member can do comes from their role in the group — the built-in Admin and Member roles, or custom roles built from six permissions. A personal note can be moved or copied into a group, and deleting a group either gives its notes to one of its admins or deletes them with it (see [Notes in a group](docs/sharing.md#notes-in-a-group)).
- **Storage quotas** — every personal space and every group sits on a storage plan that can cap its attachments (or set no limit); site admins manage plans and assignments under **Site admin → Storage plans**, and people see their own usage in **Settings → Account** (see [Storage quotas](docs/self-hosting.md#storage-quotas)).
- **AI quick actions** — rewrite, translate, summarize and continue, streamed from an OpenAI-compatible or Anthropic endpoint an admin configures (see [AI quick actions](docs/ai.md)).
- **Your own AI on your notes** — personal API tokens, or apps authorized over OAuth, can read and write note content; a write that changes a note's content shows up live in open tabs and is recorded in the note's AI edit history, where it can be reverted (see [API tokens](docs/api-tokens.md) and [AI editing](docs/ai-editing.md)). An MCP endpoint at `/api/mcp` gives Claude Code, Claude Desktop and other MCP clients ten tools to find, read, edit, create, rename and copy notes, group notes included, to move a note into a group, and to move images in and out (see [MCP](docs/mcp.md)).

All of it sits on a REST API you can also drive directly (see [API contract summary](docs/api.md)), and it is exercised end-to-end by a Playwright test suite. Upgrading to 0.8.0 runs a database migration (note versions) and turns automatic note versions on for the whole site — back up first and read the [0.8.0 upgrade notes](CHANGELOG.md#080---2026-10-10). (Coming from 0.6.x? The [0.7.0 upgrade notes](CHANGELOG.md#070---2026-10-09) apply too: every existing user and group goes on a 2 GiB default storage plan. Coming from 0.5.x? The [0.6.0 upgrade notes](CHANGELOG.md#060---2026-10-08) apply as well: SSO configuration moves from `.env` into **Site admin → Sign-in**, and self-registration opens by default.)

## Quickstart (~10 minutes)

This brings up the server and a Postgres database with `docker compose`; the first (admin) account is created from environment variables at startup — there's no in-browser setup step.

1. Copy the example environment file:

   ```sh
   cp .env.example .env
   ```

2. Generate an `APP_SECRET` (used to sign session cookies and collab tokens, and to encrypt stored AI provider credentials — see [AI quick actions](docs/ai.md)) and fill it into `.env`:

   ```sh
   openssl rand -hex 32
   ```

   Paste the output as `APP_SECRET=...` in `.env`.

3. Set `PUBLIC_URL` in `.env`. For local use:

   ```
   PUBLIC_URL=http://localhost:3000
   ```

4. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` — this creates the first (admin) account at startup. `ADMIN_PASSWORD` must be 12+ characters. This is the only way to initialize a fresh instance: the server refuses to start on an empty database without these set (see `.env.example` and [Known limitations](docs/known-limitations.md) — it only takes effect on first initialization).

5. Start the stack (`app` + `db` services; see [Deployment prerequisites](docs/self-hosting.md#deployment-prerequisites) before doing this in production):

   ```sh
   docker compose up -d
   ```

6. Open `http://localhost:3000` in a browser and log in with `ADMIN_EMAIL`/`ADMIN_PASSWORD`. You're signed in straight away — there is no forced password change for this account. You can change the password later under **Settings → Account**.

7. Create a note and open it in the block editor. To try live co-editing, open **Site admin → Users** (`/admin/users`; **Site admin** is in the user menu — you're an admin) to create a second account, then log that account in from a second browser or an incognito window, share the note with it, and watch edits sync live. While registration is on (the default; turn it off in **Site admin → Sign-in**), people can also create their own account at `/register`, or get one the first time they sign in through a sign-in service — see [Accounts](docs/self-hosting.md#accounts).

If you'd rather drive the API directly than click through the browser — e.g. to script the whole flow or build another client — the same login endpoints are available over `curl`; see [API contract summary](docs/api.md) for the full endpoint list. The loop is: `ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env` → `POST /api/auth/login` → authenticated API calls, session cookie carried the same way the browser carries it.

## Before you deploy beyond localhost

Read the full [self-hosting guide](docs/self-hosting.md) before running anywhere other than `localhost` — in short:

- **Only run a single `app` container.** `docker compose up --scale app=N` is **not supported**. Real-time collaboration state (Yjs/Hocuspocus) lives in server memory with no cross-instance sync, so scaling out would let edits to the same note **silently diverge** across instances instead of merging. See [Single-instance warning](docs/self-hosting.md#single-instance-warning).
- **`PUBLIC_URL` is required**, and you must pick a topology: **(a)** trusted-LAN plain http — credentials and the session cookie travel in cleartext, only for a network where you trust every host — or **(b)** reverse proxy + TLS for anything else, including the public internet. See [Deployment prerequisites](docs/self-hosting.md#deployment-prerequisites) for the full trade-offs, the WebSocket-forwarding requirement for `/collab`, and the `TRUST_PROXY` setting you must configure when running behind a proxy.

## Documentation

- [Self-hosting guide](docs/self-hosting.md) — deployment prerequisites, compose services/volumes, reverse proxy & TLS, LAN plain-http mode, environment variable reference, sign-in services (OIDC/SSO) and their setup on GitLab and Google, accounts and registration, SSO-only sign-in and its recovery switch, content security policy, upgrading/rollback, and troubleshooting.
- [API contract summary](docs/api.md) — full endpoint table with auth requirements and error codes.
- [API tokens](docs/api-tokens.md) — Personal API tokens for scripts and AI assistants, which can read and write note content today: creating, using (`Authorization: Bearer`), which endpoints accept them, rate limits, revoking, and why changing your password doesn't revoke them; plus how an MCP client authorizes itself over OAuth instead of using a pasted token.
- [AI editing](docs/ai-editing.md) — the note-content read/write API a token or authorized app uses: the five write operations, fingerprints and conflict handling, reverting a write, the presence cursor and agent display names, and rate limits and error codes.
- [MCP](docs/mcp.md) — connecting an MCP client (the exact `claude mcp add` and `mcp-remote` commands), the ten tools and what each answers, the read-write loop, MCP's own limits and error shapes, and its known limitations.
- [Sharing](docs/sharing.md) — the three access levels of a personal note (private / members / public link), notes in a group and what each role permission allows, moving or copying a note into a group, what a public read-only link grants, and how revoking and regenerating behave.
- [Version history](docs/versions.md) — when a note's versions are saved, previewing, comparing and applying them, who can see them, how long automatic versions are kept, and the three switches that turn automatic versions off.
- [AI quick actions](docs/ai.md) — admin setup guide (under **Site admin → AI**) for AI providers/models/actions, key encryption, and how quick actions behave in the editor.
- [Diagrams (Mermaid)](docs/diagrams.md) — inserting, editing and pasting Mermaid diagrams, what copying one out produces, and the on-demand loading and rendering lockdown behind them.
- [Known limitations](docs/known-limitations.md) — the full list of known rough edges and deliberate trade-offs.
- [Restoring note content from a backup](docs/backup-restore.md) — runbook for restoring `note_states` from a snapshot or `pg_dump`.
- [CHANGELOG](CHANGELOG.md).

## Roadmap

All five v0.1 milestones — the API foundation, the web UI with real-time collaboration, wikilinks and image uploads, AI quick actions, and OIDC login — have shipped, followed by a hardening release (0.2), a UI overhaul, Mermaid diagrams, readable note URLs and public share links (0.3.x), API tokens, OAuth and MCP for bringing your own AI (0.4.x), groups (0.5), multiple sign-in services with self-registration (0.6), storage quotas and presentation mode (0.7), and note version history (0.8); see the [CHANGELOG](CHANGELOG.md) for the history.

Planning lives in [GitHub Milestones](https://github.com/sw-willie-wu/knotebook/milestones) and the issue tracker, which stay current as work is scheduled.

## License

MIT — see [LICENSE](./LICENSE). A bundled font asset carries its own license — see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
