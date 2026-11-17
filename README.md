# Knotebook

[![Latest release](https://img.shields.io/github/v/release/sw-willie-wu/knotebook?sort=semver)](https://github.com/sw-willie-wu/knotebook/releases/latest)
[![CI](https://github.com/sw-willie-wu/knotebook/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/sw-willie-wu/knotebook/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

English | [繁體中文](README.zh-TW.md)

**Self-hosted collaborative notes for your team and its AI agents.** Knotebook is an open-source, Notion/HackMD-style notebook that runs on your own server. People edit notes together in real time; the AI assistants you already use, such as Claude Code, Claude Desktop or any other MCP client, search, read and edit the same notes through an MCP endpoint, and a write of theirs that changes a note's content is recorded in that note's AI edit history, where it can usually be reverted.

![A note in Knotebook: the sidebar with folders on the left, the note with a table and a Mermaid diagram on the right, two collaborators' avatars in the header and their cursors in the text](docs/images/editor.png)

Three non-negotiables:

- **No seat limits** — self-host for one person or a thousand, no license gate.
- **Real-time CRDT collaboration** — Yjs-based multiplayer editing, not a commercial add-on.
- **Bring your own AI endpoint** — point Knotebook at your own OpenAI-compatible or Anthropic endpoint (including a local/on-prem Ollama); no bundled vendor lock-in.

It runs as one app container and a PostgreSQL database with `docker compose`, from prebuilt images for linux/amd64 and linux/arm64. The web app is in English and Traditional Chinese, with light and dark themes.

**Status:** the latest release is v0.17.0 (2026-11-18). Every version and its files are on [Releases](https://github.com/sw-willie-wu/knotebook/releases); what changed, and what is on `main` but not released yet, is in the [CHANGELOG](CHANGELOG.md).

## Screenshots

Who else has the note open, with their cursors in the text:

![The note header with Bob's and Carol's avatars and a tooltip "Bob · Editor, Click to go to their cursor", and their two cursors in the note's list](docs/images/presence.png)

On a phone, the note list is the home screen and a note opens over it:

<p align="center"><img src="docs/images/phone.png" alt="Knotebook on a phone: the note list with folders, and a note with its location under the title" width="640"></p>

## Features

### Writing

- **Block editor** — headings, lists, tables, quotes, code blocks with syntax highlighting, a `/` menu to insert blocks and Markdown shortcuts as you type; see [Help and the feature tour](docs/feature-tour.md) for the shortcuts.
- **Colors** — text, background and table cell colors: nine built-in colors, or any color you pick.
- **Real-time co-editing** — everyone on a note edits at once (Yjs and Hocuspocus) and sees the other editors' cursors; the note header shows who else has it open, and clicking someone's avatar goes to their cursor.
- **Links between notes** — type `[[`, or paste or drag in a note's address; links follow renames, can point at a single paragraph, and each note lists the notes that mention it.
- **Images** — add PNG, JPEG, GIF or WebP images to a note, resize them, and zoom in on them full screen; they count toward the storage plan of the note's space.
- **Side-by-side columns** — rows of two to four columns, made with `/grid` or by dragging a block beside another, resized by dragging the divider ([Side-by-side columns](docs/columns.md)).
- **Diagrams** — Mermaid diagrams, stored as their source text, drawn in the note, and zoomable full screen ([Diagrams](docs/diagrams.md)).
- **Note width** — Standard, Wide or Full width, per note.
- **Heading outline** — a thin line on the right of a note with one tick per heading (H1 to H3); hover or tap it to see the headings, and click one to jump to it. When the window is wide enough to leave a comfortable text column next to it, the outline can be pinned open beside the text. On a phone or a narrow window (below 768px), a bubble showing where you are appears while you scroll and opens the list; in a note's ⋮ menu, **Heading outline** opens it too (shared public pages have no ⋮ menu).
- **Version history** — versions saved automatically after a pause in editing, or by hand; preview one, compare two side by side, and apply an older one ([Version history](docs/versions.md)).
- **Presentation mode** — play a note as a slide show whose slides are its headings, from the note or from its public link.
- **Search** — the sidebar finds notes by title and body text and opens a note at the matching section; the REST API and MCP search the same way ([API](docs/api.md), [MCP](docs/mcp.md#search_notes)).

### Organizing and sharing

- **Folders** — up to five levels, in your notes, in each group, and, for you alone, among the notes shared with you; file notes with **Move to…**, by selecting several, or by dragging with a mouse ([Folders](docs/sharing.md#folders)).
- **Favorites** — star a note to keep it on the Favorites tab; your favorites are yours alone ([Favorites](docs/sharing.md#favorites)).
- **Trash** — a deleted note goes to the trash, where it can be restored; it is deleted for good after 7 days unless a site admin sets another number of days or turns that off ([Notes in the trash](docs/sharing.md#notes-in-the-trash)).
- **Sharing and public links** — a personal note is private, shared with chosen people as editors or viewers, or published as a read-only public link, which can have a custom address ([Sharing](docs/sharing.md)).
- **Groups** — a group owns its notes; what a member can do comes from their role, built in (Admin, Member) or custom ([Notes in a group](docs/sharing.md#notes-in-a-group)).

### Accounts and administration

- **Sign-in** — passwords, and any number of OpenID Connect providers (GitLab, Google or another), which can create an account on someone's first sign-in or be made the only way in; self-registration with a password (on unless a site admin turns it off), invitation links and one-time password-reset links ([Sign-in providers](docs/self-hosting.md#sign-in-providers), [Accounts](docs/self-hosting.md#accounts)).
- **Profile pictures** — upload and crop your own, or use the picture your identity provider sends; it shows on your account button, in the avatars other people see at the top of a note you have open, and next to your name in lists such as a group's members.
- **Storage quotas** — every personal space and group is on a storage plan that can cap its attachments ([Storage quotas](docs/self-hosting.md#storage-quotas)).
- **Site admin** — users, groups, sign-in services, storage plans, AI providers, and 17 limits (upload size, note size, request rates and more) that take effect without restarting the server ([Site limits](docs/self-hosting.md#site-limits)).

### AI

- **AI quick actions** — run an action on selected text and see the result as an inline diff, streamed from the provider a site admin sets up; the built-in actions are Rewrite, Translate, Summarize, Continue writing and Instruct (follows an instruction you type), which a site admin can rename or turn off, and admins can add their own ([AI quick actions](docs/ai.md)).
- **MCP** — `/api/mcp` gives Claude Code, Claude Desktop and other MCP clients up to twenty tools to search, read, create, edit, rename, copy and move notes, manage folders, move notes to the trash and back, and read images ([MCP](docs/mcp.md)).
- **Notes as files** — with `open_notes_as_files`, an assistant that has a shell downloads many notes as Markdown files and sends the changed files back ([MCP](docs/mcp.md#open_notes_as_files)).
- **AI edit history** — a write through the API or MCP that changes a note's content shows up live in open tabs and is recorded in the note's AI edit history, where it can usually be reverted (renaming a note, or creating one, isn't recorded) ([AI editing](docs/ai-editing.md)).
- **API tokens and OAuth** — personal API tokens with scopes, or apps you authorize over OAuth, which are read-only unless you allow more ([API tokens](docs/api-tokens.md)).

### On every screen

- **Phone layout** — below 640 px the note list is the home screen, a note slides in from the right over it, dialogs and menus rise from the bottom, and an editing toolbar sits above the on-screen keyboard; from 640 to 1279 px the sidebar is a drawer ([Known limitations](docs/known-limitations.md#on-a-phone)).
- **Install as an app** — add Knotebook to a phone's or computer's home screen, or install it from Chrome or Edge; like a browser tab, it needs the server ([Installing Knotebook as an app](docs/install-app.md)).
- **Help and feature tour** — **Help** in the user menu, or Ctrl+/ (⌘/ on a Mac), opens the Help window: a feature tour on a sample note, What's new, and the keyboard shortcuts ([Help and the feature tour](docs/feature-tour.md)).

### Running it

- **Docker Compose** — the app and a bundled PostgreSQL, or your own PostgreSQL ([Self-hosting guide](docs/self-hosting.md)).
- **REST API** — the web app runs on a REST API you can call yourself ([API contract summary](docs/api.md)).
- **Note snapshots and restore runbook** — the server keeps periodic snapshots of note content, and a runbook covers restoring a note from one or from a `pg_dump` ([Restoring note content from a backup](docs/backup-restore.md)).

## Quickstart

You need Docker with Compose. This runs Knotebook on `http://localhost:3000`.

1. In an empty directory, download the latest release's compose file and example settings:

   ```sh
   curl -fLO https://github.com/sw-willie-wu/knotebook/releases/latest/download/docker-compose.yml
   curl -fL -o .env https://github.com/sw-willie-wu/knotebook/releases/latest/download/env.example
   ```

   (Or `git clone https://github.com/sw-willie-wu/knotebook.git`, `cd knotebook` and `cp .env.example .env`, to build from source or run `main`.)

2. Fill in four values in `.env`:

   - `APP_SECRET` — 64 or more hexadecimal characters, for example the output of `openssl rand -hex 32`.
   - `PUBLIC_URL=http://localhost:3000`
   - `ADMIN_EMAIL` and `ADMIN_PASSWORD` (12 characters or more) — the first admin account. The server won't start on an empty database without them, and they only take effect that first time.

3. Start it, open `http://localhost:3000` and sign in with `ADMIN_EMAIL` and `ADMIN_PASSWORD`:

   ```sh
   docker compose up -d
   ```

Which image runs: a release's `docker-compose.yml` runs that release, the repository's runs `latest`, and `KNOTEBOOK_VERSION` in `.env` pins a release (recommended with a clone). In a clone, `docker compose up -d --build` builds from source instead ([The app image](docs/self-hosting.md#the-app-image)).

To try co-editing, open **Site admin → Users** from the user menu, use **Create invitation**, open the link in a private window to create a second account, and share a note with it.

**Upgrading:** read the new release's upgrade notes in the [CHANGELOG](CHANGELOG.md) first, and back up when they say so. Then replace `docker-compose.yml` with the new release's (or update your clone), change `KNOTEBOOK_VERSION` if you set it, and run `docker compose pull` and `docker compose up -d` ([Upgrading and rolling back](docs/self-hosting.md#upgrading-and-rolling-back)).

## Before you deploy beyond localhost

Read the full [self-hosting guide](docs/self-hosting.md) before running anywhere other than `localhost` — in short:

- **Only run a single `app` container.** `docker compose up --scale app=N` is **not supported**. Real-time collaboration state (Yjs/Hocuspocus) lives in server memory with no cross-instance sync, so scaling out would let edits to the same note **silently diverge** across instances instead of merging. See [Single-instance warning](docs/self-hosting.md#single-instance-warning).
- **`PUBLIC_URL` is required**, and you must pick a topology: **(a)** trusted-LAN plain http — credentials and the session cookie travel in cleartext, only for a network where you trust every host — or **(b)** reverse proxy + TLS for anything else, including the public internet. See [Deployment prerequisites](docs/self-hosting.md#deployment-prerequisites) for the full trade-offs, the WebSocket-forwarding requirement for `/collab`, and the `TRUST_PROXY` setting you must configure when running behind a proxy.

## Documentation

For people writing notes:

- [Sharing](docs/sharing.md) — private, shared and public notes, groups and their roles, moving or copying a note into a group, folders, favorites and the trash.
- [Version history](docs/versions.md) — when versions are saved, previewing, comparing and applying them, who sees them and how long they are kept.
- [Side-by-side columns](docs/columns.md) — making, resizing, removing, copying and undoing rows of columns.
- [Diagrams (Mermaid)](docs/diagrams.md) — inserting, editing, pasting and copying out Mermaid diagrams.
- [Help and the feature tour](docs/feature-tour.md) — the Help window, the feature tour and the What's new page.
- [Installing Knotebook as an app](docs/install-app.md) — adding it to the home screen on Android, iPhone and iPad, and installing it on a computer.
- [Known limitations](docs/known-limitations.md) — every known rough edge and deliberate trade-off.

For connecting AI and scripts:

- [MCP](docs/mcp.md) — connecting an MCP client, what each tool takes and answers, the read-write loop, limits and errors.
- [API tokens](docs/api-tokens.md) — creating, using and revoking personal API tokens, and authorizing an app over OAuth instead.
- [AI editing](docs/ai-editing.md) — reading and writing note content over the API: sections, fingerprints, the five write operations, reverting and the Markdown format.
- [API contract summary](docs/api.md) — every endpoint with its authentication, request body and error codes.

For running a server:

- [Self-hosting guide](docs/self-hosting.md) — deployment prerequisites, reverse proxy and TLS, environment variables, site limits, sign-in providers, accounts, storage quotas, the app image, upgrading and rolling back, and troubleshooting.
- [AI quick actions](docs/ai.md) — setting up AI providers, models and actions in **Site admin → AI agents**, and how the actions behave in the editor.
- [Restoring note content from a backup](docs/backup-restore.md) — restoring a note's content from a snapshot or from a `pg_dump`.

For contributors and maintainers:

- [Running the e2e suite locally](docs/e2e-local.md) — the Playwright suite against a throwaway Docker Compose stack in WSL, and running several at once.
- [Releasing](docs/releasing.md) — preparing a release pull request with `pnpm release:prepare`, and what the Release workflow does after the merge.
- [CHANGELOG](CHANGELOG.md) — every release, with its upgrade notes.

## Roadmap

Next up:

- Comments on notes, @mentions and notifications ([#289](https://github.com/sw-willie-wu/knotebook/issues/289))

Planning lives in [GitHub Milestones](https://github.com/sw-willie-wu/knotebook/milestones) and the [issue tracker](https://github.com/sw-willie-wu/knotebook/issues); the [CHANGELOG](CHANGELOG.md) has the history.

## License

MIT — see [LICENSE](./LICENSE). A bundled font asset carries its own license — see [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
