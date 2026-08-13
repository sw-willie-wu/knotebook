# Knotebook

Knotebook is an open-source, self-hostable Notion/HackMD-style collaborative note system with bring-your-own-endpoint AI built in.

Three non-negotiables:

- **No seat limits** — self-host for one person or a thousand, no license gate.
- **Real-time CRDT collaboration** — Yjs-based multiplayer editing, not a commercial add-on.
- **Bring your own AI endpoint** — point Knotebook at your own OpenAI-compatible or Anthropic endpoint (including a local/on-prem Ollama); no bundled vendor lock-in.

**Status:** this is the v0.1.0 release — password auth with optional OIDC/SSO login, a browser UI (note list, block editor, sharing, admin user management), live multiplayer editing (Yjs/Hocuspocus) with role-based access control, `[[wikilinks]]` with backlinks, image uploads, and bring-your-own-endpoint AI quick actions (rewrite/translate/summarize/continue, streamed, against an admin-configured OpenAI-compatible or Anthropic provider), all on top of the REST API, exercised end-to-end by a Playwright test suite. If you want to drive the API directly instead of the browser UI, it's still there (see [API contract summary](docs/api.md)).

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

4. Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env` — this creates the first (admin) account at startup. `ADMIN_PASSWORD` must be 12+ characters. This is the only way to initialize a fresh instance: the server refuses to start on an empty database without these set (see `.env.example` and [Known limitations](docs/known-limitations.md) — it only takes effect on first initialization, and the account must change its password on first login).

5. Start the stack (`app` + `db` services; see [Deployment prerequisites](docs/self-hosting.md#deployment-prerequisites) before doing this in production):

   ```sh
   docker compose up -d
   ```

6. Open `http://localhost:3000` in a browser and log in with `ADMIN_EMAIL`/`ADMIN_PASSWORD`. You'll be routed straight to a forced password-change screen before you can do anything else — set a new password there and you're in.

7. Create a note and open it in the block editor. To try live co-editing, open **Settings → Users** (linked from the user menu — you're an admin) to create a second account, then log that account in from a second browser or an incognito window, share the note with it, and watch edits sync live. There is no public sign-up; every account is created by an admin, created by the environment-variable bootstrap above, or (if you've set it up) provisioned automatically on first OIDC/SSO login — see [Self-hosting guide](docs/self-hosting.md#oidc--sso-login-setup).

If you'd rather drive the API directly than click through the browser — e.g. to script the whole flow or build another client — the same login endpoints are available over `curl`; see [API contract summary](docs/api.md) for the full endpoint list. The loop is: `ADMIN_EMAIL`/`ADMIN_PASSWORD` from `.env` → `POST /api/auth/login` → authenticated API calls, session cookie carried the same way the browser carries it.

## Before you deploy beyond localhost

Read the full [self-hosting guide](docs/self-hosting.md) before running anywhere other than `localhost` — in short:

- **Only run a single `app` container.** `docker compose up --scale app=N` is **not supported**. Real-time collaboration state (Yjs/Hocuspocus) lives in server memory with no cross-instance sync, so scaling out would let edits to the same note **silently diverge** across instances instead of merging. See [Single-instance warning](docs/self-hosting.md#single-instance-warning).
- **`PUBLIC_URL` is required**, and you must pick a topology: **(a)** trusted-LAN plain http — credentials and the session cookie travel in cleartext, only for a network where you trust every host — or **(b)** reverse proxy + TLS for anything else, including the public internet. See [Deployment prerequisites](docs/self-hosting.md#deployment-prerequisites) for the full trade-offs, the WebSocket-forwarding requirement for `/collab`, and the `trustProxy` caveat.

## Documentation

- [Self-hosting guide](docs/self-hosting.md) — deployment prerequisites, compose services/volumes, reverse proxy & TLS, LAN plain-http mode, environment variable reference, OIDC/SSO setup, and troubleshooting.
- [API contract summary](docs/api.md) — full endpoint table with auth requirements and error codes.
- [AI quick actions](docs/ai.md) — admin setup guide for AI providers/models/actions, key encryption, and how quick actions behave in the editor.
- [Known limitations](docs/known-limitations.md) — the full list of known rough edges and deliberate trade-offs.
- [Restoring note content from a backup](docs/backup-restore.md) — runbook for restoring `note_states` from a snapshot or `pg_dump`.
- [CHANGELOG](CHANGELOG.md).

## Roadmap

| Milestone | Scope |
|---|---|
| Milestone 1 (v0.1) | API foundation: password auth, notes CRUD, sharing/permissions, admin user management |
| Milestone 2 (v0.1) | Web UI + real-time CRDT collaboration (Yjs/Hocuspocus) |
| Milestone 3 (v0.1) | Wikilinks (`[[...]]` + backlinks) and image uploads |
| Milestone 4 (v0.1) | AI quick actions (bring-your-own OpenAI-compatible / Anthropic endpoints), admin-configurable via the Settings modal |
| **Milestone 5 (v0.1, this release)** | OIDC login |

## License

MIT — see [LICENSE](./LICENSE).
