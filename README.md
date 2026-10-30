# Knotebook

English | [繁體中文](README.zh-TW.md)

Knotebook is an open-source, self-hostable Notion/HackMD-style collaborative note system with bring-your-own-endpoint AI built in.

Three non-negotiables:

- **No seat limits** — self-host for one person or a thousand, no license gate.
- **Real-time CRDT collaboration** — Yjs-based multiplayer editing, not a commercial add-on.
- **Bring your own AI endpoint** — point Knotebook at your own OpenAI-compatible or Anthropic endpoint (including a local/on-prem Ollama); no bundled vendor lock-in.

**Status:** the latest release is v0.13.0 (2026-10-26). What it does today:

- **Writing together** — a block editor with live multiplayer editing (Yjs/Hocuspocus), links between notes (`[[`, or just paste or drag in a note's address) that follow renames, with backlinks and links to a single paragraph, image uploads, side-by-side columns (see [Side-by-side columns](docs/columns.md)), three content widths for a note (Standard, Wide or Full width), a row of avatars in the note header showing who else has the note open right now, and Mermaid diagrams (see [Diagrams](docs/diagrams.md)).
- **Version history** — every note keeps versions, saved automatically (after a few minutes without new edits — 5 by default, set by a site admin) or by hand; each version is shown by its name and the first 7 characters of its id; compare any two side by side, apply one to bring an older state back, and rely on retention rules and three switches (site, your own notes, a group) that turn automatic saving off; the version list can be narrowed to manual versions only, and on a wide screen the version panel can be resized by dragging its left edge (see [Version history](docs/versions.md)).
- **Presentation mode** — play any note as a slide show: its headings become the slides, the cover is the title, and signed-in viewers see collaborators' edits as they happen (see [Known limitations](docs/known-limitations.md)).
- **Accounts** — password sign-in and sign-in through any number of OpenID Connect identity providers (GitLab, Google, or another provider), which can also be made the only way in; people can register with a password unless a site admin turns that off, site admins can invite people or reset someone's password with a one-time link, and each sign-in service can be set to create an account on someone's first sign-in, and people can link several sign-in services to one account. Site admins manage users (their role, and see when each was last active, or **Online** if within the last 5 minutes), groups, sign-in services (with their icons), storage plans and AI providers in the **Site admin** panel (`/admin/users`, `/admin/groups`, `/admin/login`, `/admin/storage`, `/admin/ai`); your own profile, sign-in methods, authorization, groups and storage live in **Settings**, which, like the Site admin panel and each group's panel, opens as a modal over the page you were on — see [Sign-in providers](docs/self-hosting.md#sign-in-providers) and [Accounts](docs/self-hosting.md#accounts).
- **Trash** — deleting a note moves it to the trash instead of deleting it for good. The sidebar shows one kind of note at a time under five tabs — **Recent**, **My notes**, **Workspace**, **Shared with me** and **Trash**; in **Trash** you restore notes or delete them permanently, one by one, several at a time or all at once, and **Select** in the other tabs acts on several notes in one go — copying them, moving them to the trash (except in **Shared with me**), or, in **My notes**, moving them into a group. Notes in the trash are permanently deleted automatically after 7 days unless a site admin sets another number of days or turns that off under **Site admin → Storage plans → Trash** (see [Notes in the trash](docs/sharing.md#notes-in-the-trash) and [Trash](docs/self-hosting.md#trash)).
- **Sharing** — a personal note is private, shared with chosen people as editors or viewers, or published as a read-only public link (see [Sharing](docs/sharing.md)).
- **Groups** — a group owns its notes, which live at `/g/<group id>/<name>`; what each member can do comes from their role in the group — the built-in Admin and Member roles, or custom roles built from six permissions, managed in the group's own panel at `/groups/<id>`. A personal note can be moved or copied into a group, and deleting a group either gives its notes to one of its admins or deletes them with it (see [Notes in a group](docs/sharing.md#notes-in-a-group)).
- **Storage quotas** — every personal space and every group sits on a storage plan that can cap its attachments (or set no limit); site admins manage plans and assignments under **Site admin → Storage plans**, and people see their own usage in **Settings → Storage**; a group's storage is shown by file type and by the member who brought each file in, to every member of the group (see [Storage quotas](docs/self-hosting.md#storage-quotas)).
- **AI quick actions** — rewrite, translate, summarize, continue, and free-form instructions you type yourself (the **Instruct** action), run on a text selection from the **AI** button on the formatting toolbar, with the result shown as an inline diff; streamed from an OpenAI-compatible or Anthropic endpoint an admin configures (see [AI quick actions](docs/ai.md)).
- **Your own AI on your notes** — personal API tokens, or apps authorized over OAuth, can read and write note content; a write that changes a note's content shows up live in open tabs and is recorded in the note's AI edit history, where it can be reverted (see [API tokens](docs/api-tokens.md) and [AI editing](docs/ai-editing.md)). An MCP endpoint at `/api/mcp` gives Claude Code, Claude Desktop and other MCP clients thirteen tools to find, read, edit, create, rename and copy notes, group notes included, to move a note into a group, to move notes to the trash and back, and to move images in and out (see [MCP](docs/mcp.md)). Moving or copying a note into a group takes its own `notes:move` permission, which you tick per token or per app; moving notes to the trash or restoring them takes the separate `notes:delete` permission; and every MCP tool rejects an argument it doesn't know.

All of it sits on a REST API you can also drive directly, which also has folders for organizing notes (`/api/folders`; the web app doesn't show folders yet) (see [API contract summary](docs/api.md)), and it is exercised end-to-end by a Playwright test suite. Upgrading to 0.13.0 runs database migrations 0027–0035 (username renames, a public page width for notes, sign-in services without a client ID yet, one-time links for password resets and invitations, **Creates accounts** per sign-in service, the trash, folders, and the `notes:delete` scope) — back up first. Reload every open tab after upgrading: tabs opened before it ask to be reloaded. Sign-in behaves as before after the upgrade, and no existing token or app gets `notes:delete` until you turn it on. Rolling back to an earlier version deletes side-by-side columns, with what is in them, the first time such a note is opened, and has more consequences — read the [0.13.0 upgrade notes](CHANGELOG.md#0130---2026-10-26) and [Upgrading to v0.13](docs/self-hosting.md#upgrading-and-rolling-back) first. (Coming from 0.11.x? The [0.12.0 upgrade notes](CHANGELOG.md#0120---2026-10-15) apply too: no database migration, but in a clone of the repository `docker compose up -d` now runs the prebuilt image instead of building one: after updating the clone, run `docker compose pull` and `docker compose up -d`, or `docker compose up -d --build` to keep building from source. If you have your own `docker-compose.override.yml`, read [Upgrading to v0.12](docs/self-hosting.md#upgrading-and-rolling-back) first. Coming from 0.10.x? The [0.11.0 upgrade notes](CHANGELOG.md#0110---2026-10-15) apply too: database migrations 0024–0026 (last active time, automatic versions saved after a pause, links to notes) — back up first. Reload every open tab after upgrading: tabs opened before it can't connect to the new server. About 30 seconds after the first start, the server turns ordinary links to notes on this site into links to those notes, in the background, and automatic versions are now saved only after a note has had no new changes for a while (5 minutes by default). The first start also adds the **Instruct** AI action, enabled, so where AI actions already work every editor can send free-form instructions — see also [Upgrading to v0.11](docs/self-hosting.md#upgrading-and-rolling-back). Coming from 0.9.x? The [0.10.0 upgrade notes](CHANGELOG.md#0100---2026-10-11) apply too: database migrations 0020–0023 (self-link cleanup, the `notes:move` scope, last sign-in time, who takes up group space) and changes to the MCP tools and OAuth: existing tokens and apps lose moving and copying notes into groups until you allow it again, every MCP tool now rejects arguments it doesn't know, and apps you authorize for the first time are read-only by default — back up first. The bundled database is now optional: set `BUNDLED_DB=0` and `DATABASE_URL` in `.env` to use your own PostgreSQL instead. Coming from 0.8.x? The [0.9.0 upgrade notes](CHANGELOG.md#090---2026-10-10) apply too: no database migration, but scripts that call `create_note` with `groupId` must switch to `group_id`, and MCP clients need a restart to see the new tools. Coming from 0.7.x? The [0.8.0 upgrade notes](CHANGELOG.md#080---2026-10-10) apply too: a database migration (note versions) runs and automatic note versions are on for the whole site — back up first. Coming from 0.6.x? The [0.7.0 upgrade notes](CHANGELOG.md#070---2026-10-09) apply too: every existing user and group goes on a 2 GiB default storage plan. Coming from 0.5.x? The [0.6.0 upgrade notes](CHANGELOG.md#060---2026-10-08) apply as well: SSO configuration moves from `.env` into **Site admin → Sign-in**, and self-registration opens by default.)

## Quickstart (~10 minutes)

This brings up the server and a Postgres database with `docker compose`; the first (admin) account is created from environment variables at startup — there's no in-browser setup step. The server runs from a prebuilt image, `ghcr.io/sw-willie-wu/knotebook` on the GitHub Container Registry (linux/amd64 and linux/arm64, published from v0.11.1 on), so it doesn't have to be built on your machine.

1. Get `docker-compose.yml` and `.env.example`, then copy the example environment file:
   - **Clone the repository** — what you need to build from source or run what is on `main`: `git clone https://github.com/sw-willie-wu/knotebook.git && cd knotebook`.
   - **Or, without cloning**, download the two files attached to the latest release into an empty directory (releases from v0.12.0 on carry them).

     ```sh
     curl -fLO https://github.com/sw-willie-wu/knotebook/releases/latest/download/docker-compose.yml
     curl -fL -o .env.example https://github.com/sw-willie-wu/knotebook/releases/latest/download/env.example
     ```

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

5. Start the stack (`app` + `db` services, where `db` is a bundled PostgreSQL — to use your own PostgreSQL instead, see [Using your own PostgreSQL](docs/self-hosting.md#using-your-own-postgresql); see [Deployment prerequisites](docs/self-hosting.md#deployment-prerequisites) before doing this in production):

   ```sh
   docker compose up -d
   ```

   The first run downloads the image: the release's own version with a release's `docker-compose.yml`, `latest` with the repository's — unless you set `KNOTEBOOK_VERSION` in `.env` to a release (for example `KNOTEBOOK_VERSION=0.11.1`), which is recommended with a clone. In a clone, `docker compose up -d --build` builds from source instead (see [The app image](docs/self-hosting.md#the-app-image)).

6. Open `http://localhost:3000` in a browser and log in with `ADMIN_EMAIL`/`ADMIN_PASSWORD`. You're signed in straight away — there is no forced password change for this account. You can change the password later under **Settings → Sign-in**.

7. Create a note and open it in the block editor. To try live co-editing, open **Site admin → Users** (`/admin/users`; **Site admin** is in the user menu — you're an admin), use **Create invitation** to make an invitation link, and open the link in a second browser or an incognito window to create a second account there. Then share the note with that account and watch edits sync live. Admins can invite people this way while password sign-in is on. People can also create their own account at `/register` while password sign-in and **Allow self-registration with a password** are both on (the default; turn the latter off in **Site admin → Sign-in**), or get one the first time they sign in through a sign-in service that has **Creates accounts** on — see [Accounts](docs/self-hosting.md#accounts).

If you'd rather drive the API directly than click through the browser — e.g. to script the whole flow or build another client — the same login endpoints are available over `curl`; see [API contract summary](docs/api.md) for the full endpoint list. The loop is: `ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env` → `POST /api/auth/login` → authenticated API calls, session cookie carried the same way the browser carries it.

**Upgrading:** with a release's files, download the new release's `docker-compose.yml` over the old one — keep your own changes, such as the LAN-mode port, in `docker-compose.override.yml`, which the download doesn't touch (see [The app image](docs/self-hosting.md#the-app-image)) — keep your `.env`, and if it sets `KNOTEBOOK_VERSION`, change it to the new version or remove it; with a clone, update it to the new release (for example `git pull`) and set `KNOTEBOOK_VERSION` in `.env` to the new version (or leave it unset to follow `latest`). Then run `docker compose pull` and `docker compose up -d`. Read the release's upgrade notes first, and back up when they say so — see [Upgrading and rolling back](docs/self-hosting.md#upgrading-and-rolling-back).

## Before you deploy beyond localhost

Read the full [self-hosting guide](docs/self-hosting.md) before running anywhere other than `localhost` — in short:

- **Only run a single `app` container.** `docker compose up --scale app=N` is **not supported**. Real-time collaboration state (Yjs/Hocuspocus) lives in server memory with no cross-instance sync, so scaling out would let edits to the same note **silently diverge** across instances instead of merging. See [Single-instance warning](docs/self-hosting.md#single-instance-warning).
- **`PUBLIC_URL` is required**, and you must pick a topology: **(a)** trusted-LAN plain http — credentials and the session cookie travel in cleartext, only for a network where you trust every host — or **(b)** reverse proxy + TLS for anything else, including the public internet. See [Deployment prerequisites](docs/self-hosting.md#deployment-prerequisites) for the full trade-offs, the WebSocket-forwarding requirement for `/collab`, and the `TRUST_PROXY` setting you must configure when running behind a proxy.

## Documentation

- [Self-hosting guide](docs/self-hosting.md) — deployment prerequisites, compose services/volumes, reverse proxy & TLS, LAN plain-http mode, environment variable reference, sign-in services (OIDC/SSO) and their setup on GitLab and Google, accounts and registration, SSO-only sign-in and its recovery switch, content security policy, the prebuilt image (installing from a release's files or a clone, building from source, `docker run` with your own PostgreSQL), upgrading/rollback, and troubleshooting.
- [API contract summary](docs/api.md) — full endpoint table with auth requirements and error codes.
- [API tokens](docs/api-tokens.md) — Personal API tokens for scripts and AI assistants, which can read and write note content today: creating, using (`Authorization: Bearer`), which endpoints accept them, rate limits, revoking, and why changing your password doesn't revoke them; plus how an MCP client authorizes itself over OAuth instead of using a pasted token.
- [AI editing](docs/ai-editing.md) — the note-content read/write API a token or authorized app uses: the five write operations, fingerprints and conflict handling, reverting a write, the presence cursor and agent display names, and rate limits and error codes.
- [MCP](docs/mcp.md) — connecting an MCP client (the exact `claude mcp add` and `mcp-remote` commands), the thirteen tools and what each answers, the read-write loop, MCP's own limits and error shapes, and its known limitations.
- [Sharing](docs/sharing.md) — the three access levels of a personal note (private / members / public link), notes in a group and what each role permission allows, moving or copying a note into a group, what a public read-only link grants, and how revoking and regenerating behave.
- [Version history](docs/versions.md) — when a note's versions are saved, previewing, comparing and applying them, who can see them, how long automatic versions are kept, and the three switches that turn automatic versions off.
- [AI quick actions](docs/ai.md) — admin setup guide (under **Site admin → AI agents**) for AI providers/models/actions, key encryption, and how quick actions behave in the editor.
- [Diagrams (Mermaid)](docs/diagrams.md) — inserting, editing and pasting Mermaid diagrams, what copying one out produces, and the on-demand loading and rendering lockdown behind them.
- [Side-by-side columns](docs/columns.md) — putting blocks next to each other in rows of two to four columns made with `/grid`, how rows stack on narrow screens, removing columns with the keyboard or **Ungroup columns**, copying and pasting rows, and undo.
- [Known limitations](docs/known-limitations.md) — the full list of known rough edges and deliberate trade-offs.
- [Restoring note content from a backup](docs/backup-restore.md) — runbook for restoring `note_states` from a snapshot or `pg_dump`.
- [Releasing](docs/releasing.md) — for maintainers: preparing a release pull request with `pnpm release:prepare`, and what the Release workflow does after it is merged (the tag, the GitHub Release and the Docker images).
- [CHANGELOG](CHANGELOG.md).

## Roadmap

All five v0.1 milestones — the API foundation, the web UI with real-time collaboration, wikilinks and image uploads, AI quick actions, and OIDC login — have shipped, followed by a hardening release (0.2), a UI overhaul, Mermaid diagrams, readable note URLs and public share links (0.3.x), API tokens, OAuth and MCP for bringing your own AI (0.4.x), groups (0.5), multiple sign-in services with self-registration (0.6), storage quotas and presentation mode (0.7), note version history (0.8), MCP tools to rename, move and copy notes (0.9), separate panels for settings, groups and site admin with a `notes:move` permission (0.10), links to notes that carry their own text and point to a paragraph, an AI box and free-form instructions on a selection, and automatic versions saved after a pause in editing (0.11), `docker compose` running the prebuilt image by default, with release files that install Knotebook without a clone (0.12), and the trash, a tabbed sidebar, three content widths for a note, one-time links for password resets and invitations, who else has a note open, side-by-side columns and a folders API (0.13); see the [CHANGELOG](CHANGELOG.md) for the history.

Planning lives in [GitHub Milestones](https://github.com/sw-willie-wu/knotebook/milestones) and the issue tracker, which stay current as work is scheduled.

## License

MIT — see [LICENSE](./LICENSE). A bundled font asset carries its own license — see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
