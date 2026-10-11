# MCP

Knotebook speaks [MCP](https://modelcontextprotocol.io) at `POST /api/mcp`, so an AI client — Claude Code, Claude Desktop, or anything else that speaks the protocol — can read and write your notes **as you**, through ten tools. This page is the reference for that surface: how to connect, what each tool takes and answers, what the limits are, and where the edges are.

The credential is an ordinary Knotebook credential. How one is issued, listed and revoked — a Personal API token, or one an app obtains for itself over OAuth — is in [API tokens](./api-tokens.md). What a write actually does to a note — what a section is, what fingerprints mean, the five operations, how a change is undone — is in [AI editing](./ai-editing.md). This page does not repeat either; it covers what is different about reaching them over MCP.

## The endpoint

| | |
|---|---|
| URL | `<your-host>/api/mcp` |
| Transport | Streamable HTTP, stateless, JSON responses — no SSE stream, no session id |
| Methods | `POST` only. `GET` and `DELETE` are authenticated and Origin-checked first, then answered with `405` and `Allow: POST`. |
| Capabilities | `tools` only — no resources, no prompts, no sampling. `tools.listChanged` is `false`. |
| Scope | `notes:read` gets you in; `edit_note`, `create_note`, `move_note_to_group` and `copy_note` additionally need `notes:write`, and so does `create_transfer_token` when you ask it for an upload token. `move_note_to_group`, and `copy_note` with `group_id`, also need `notes:move`, which only comes together with `notes:write`. |

Authentication happens before the MCP transport sees the request, so a request with no credential gets `401` with a `WWW-Authenticate` challenge advertising `scope="notes:read notes:write notes:move"` — that challenge is what an OAuth client follows to find the authorization server. A few things are refused by the HTTP layer earlier still, before any credential is looked at: a `Content-Type` that is not `application/json`, a body over the size limit, and a body that is not valid JSON. Those answer without a challenge — see [Errors](#errors).

Two things trip up hand-written clients:

- **`Accept` must contain both `application/json` and `text/event-stream`.** The MCP transport rejects anything else with `406`, and a bare `*/*` does **not** count. Real MCP clients send both; a `curl` by hand usually does not.
- **If the request carries an `Origin` header, it must match the host in `PUBLIC_URL`** — and so must the request's own `Host`. Anything else is `403 forbidden`, which is the DNS-rebinding guard the MCP specification requires. A request with no `Origin` at all — which is what command-line and desktop MCP clients normally send — is not subject to it. If a correctly-configured client suddenly gets `403`, check `PUBLIC_URL` first; see [Deployment prerequisites](./self-hosting.md#deployment-prerequisites).

The server announces itself as `knotebook`, and most clients use that name to namespace the tools (`knotebook:list_notes`, and so on). Each connection is also handed a short set of instructions describing how reading is paged; a read-only credential gets a different set, which does not mention the writing tools at all.

## How to connect

`/api/mcp` takes an ordinary Knotebook credential as a Bearer token, so a client that lets you set an `Authorization` header yourself can point at it with a Personal API token — [Creating one](./api-tokens.md#creating-one) covers issuing it. Tick *Create and edit notes* when you create it if the assistant should write, and *Move or copy notes into groups* as well if it should be able to move notes into your groups or copy them there. With Claude Code, for example:

```sh
claude mcp add knotebook https://<your-host>/api/mcp -t http -H "Authorization: Bearer knb_…"
```

A static header involves no OAuth token exchange, so this also works on a plain `http://` deployment. `claude mcp add` only writes the client's configuration, with the token in it as you typed it; a Claude Code session that is already running doesn't pick it up, so start a new one. To change what the assistant can do later, create another token with the boxes you want and put that one in the header instead.

The commands below are the other route: letting the client obtain a credential of its own over OAuth, which is what Claude Code and `mcp-remote` do.

MCP requires the server and its authorization endpoints to be `https://`, and clients enforce that differently — which command you run depends on whether your deployment is `https://` or plain `http://` (see [Self-hosting](./self-hosting.md#deployment-prerequisites)).

- **`https://` deployment — connect directly:**

  ```sh
  claude mcp add --transport http knotebook https://<your-host>/api/mcp
  claude mcp login knotebook
  ```

  The consent page shows the app as **"Claude Code (knotebook)"** — the part in brackets is the name you gave the server.

- **Plain `http://` deployment (the self-hosting guide's trusted-LAN topology) — go through `mcp-remote`, which lets you opt out of the TLS check explicitly with `--allow-http`:**

  ```sh
  claude mcp add knotebook -- npx -y mcp-remote http://<your-host>/api/mcp --allow-http
  ```

  Claude Desktop, or any client that only speaks stdio, uses the same command inside its `mcpServers` config:

  ```json
  { "command": "npx", "args": ["-y", "mcp-remote", "http://<your-host>/api/mcp", "--allow-http"] }
  ```

  On Windows, Claude Desktop usually needs the command wrapped:

  ```json
  { "command": "cmd", "args": ["/c", "npx", "-y", "mcp-remote", "http://<your-host>/api/mcp", "--allow-http"] }
  ```

  Drop `--allow-http` once the host is `https://`. The consent page shows the app as **"MCP CLI Proxy"**, and mcp-remote caches its registration and tokens under `~/.mcp-auth/mcp-remote-v1/` on the machine running the client.

Every `claude mcp add` command on this page defaults to *local* scope — the server only exists in the directory you ran the command in. Add `-s user` to any of them to use it from anywhere.

On the consent page, tick *Create and edit notes* if the assistant should write: the first time you authorize a client, the boxes start unticked, and pressing **Allow** straight away gives it read-only access. Tick *Move or copy notes into groups* as well, if the page offers it, for `move_note_to_group` and for copying into a group. A client that only connects through OAuth and got less than you want can be authorized again, ticking the boxes this time — the consent page then starts from the access it already has (see [Authorizing an app instead](./api-tokens.md#authorizing-an-app-instead-oauth)); or connect it with a token instead, as above.

After you press Allow, the client has its credential — once it reconnects it will list Knotebook's tools; how many it sees depends on the credential's scope and on the deployment, see [The ten tools](#the-ten-tools). A `401` at this point would mean the credential never arrived.

## The ten tools

| Tool | Scope | What it does |
|---|---|---|
| `list_notes` | `notes:read` | Page through the notes you can see, most recently updated first |
| `search_notes` | `notes:read` | Find notes by text in their title or body |
| `read_note_outline` | `notes:read` | A note's sections — id, heading, depth, length |
| `read_note_section` | `notes:read` | One section's markdown, 4000 characters per call |
| `edit_note` | `notes:write` | Apply one of the five write operations to a note, or rename it |
| `create_note` | `notes:write` | Create a note, optionally with its markdown |
| `move_note_to_group` | `notes:move` (with `notes:write`) | Move one of your personal notes into one of your groups |
| `copy_note` | `notes:write`; with `group_id`, `notes:move` as well | Copy a note you can read into a new note, yours or a group's |
| `create_transfer_token` | `notes:read` (`download`), `notes:write` (`upload`) | A short-lived token that lets a shell command upload an image to a note, or download its images |
| `read_note_image` | `notes:read` | Look at an image uploaded to a note |

Four things decide how many of these a client actually sees, and all four are settled when the request is served rather than when the tool is called:

- **A read-only credential never sees `edit_note`, `create_note`, `move_note_to_group` or `copy_note`.** They are not registered for that request at all, so — on a deployment with the collaboration component — `tools/list` returns six tools (only four on one without it; see below), and calling `create_note` anyway gets the SDK's own "Tool create_note not found" (an `isError` result, HTTP `200`) rather than a permission error. There is no scope error to handle here, because there is no tool to call. A read-only credential does see `create_transfer_token`, but it can only ask for a `download` token. To get the writing tools and upload tokens, create a token with *Create and edit notes* (`notes:write`) ticked in **Settings → Account → API tokens** and connect with that one instead.
- **A credential without `notes:move` never sees `move_note_to_group`.** A `notes:write` token or app credential without it gets nine tools on a deployment with the collaboration component (six without), and all ten (seven) once it has `notes:move` as well. It still sees `copy_note`, whose description then says that copying into a group needs `notes:move`, and a call with `group_id` answers `insufficient_scope` without copying anything. To get `move_note_to_group`, create a token with both *Create and edit notes* and *Move or copy notes into groups* ticked and connect with that one. A connection made with the web app's own sign-in session isn't limited by scope; it gets nine tools (six), because it has no `create_transfer_token` (see the last point).
- **`read_note_outline`, `read_note_section` and `edit_note` need the collaboration component.** A deployment running without it never registers those three; a `notes:write` credential still sees `create_note`, but a call to it carrying `content` answers `invalid_body` and tells you to create the note without it — unless the call also carries a `group_id` that is refused first (`group_not_found` or `forbidden`). A read-only credential on such a deployment sees only `list_notes`, `search_notes`, `create_transfer_token` and `read_note_image` — `create_note` needs `notes:write` regardless of the deployment. `move_note_to_group`, `copy_note` and `read_note_image` don't need the collaboration component.
- **`create_transfer_token` is only offered to a token or app credential.** A request made with the web app's own sign-in session never sees it — the browser can already upload and fetch images itself.

A result Knotebook itself produces — success or one of its own errors — comes back twice, identically: as `structuredContent` and, as a JSON string, in `content[0].text`. Read whichever your client prefers. (An error the MCP SDK produces itself, rather than a tool, is the exception — see [Errors](#errors).)

Every tool that takes a `note_id` — `read_note_outline`, `read_note_section`, `edit_note`, `move_note_to_group`, `copy_note`, `create_transfer_token` and `read_note_image` — answers a note you cannot see and a note that does not exist with the **same** `not_found`, byte for byte, so they cannot be used to find out which note ids exist.

Tool inputs are snake_case (`note_id`, `group_id`); replies use camelCase. Every tool rejects an argument it doesn't know instead of ignoring it — `ifMatch` for `if_match`, for example, fails the tool's input check (see [Errors](#errors) — that answer carries no `code`).

### `list_notes`

**Takes** `cursor` (opaque — the `nextCursor` from a previous call; omit it for the first page) and `limit` (1–100, default 50).

**Answers** `notes`, and `nextCursor` which is `null` on the last page. Each entry is `{id, title, titleTruncated?, owner, slug, url, role, updatedAt, lastEdited}`. `title` is cut at 200 characters as written in JSON (see [Limits](#limits)) and `titleTruncated: true` appears only when it was cut. `owner` says whose note it is: `{kind: "user", handle}` for a personal note, `{kind: "group", id, name, nameTruncated?}` for a note that belongs to one of your groups. A group's `name` is cut the same way as `title`, with `nameTruncated: true` when it was; group names are at most 80 characters, so a name can only be long enough to be cut if it contains control characters. `url` is the note's page as a **site-relative path** — `/n/<username>/<slug>` for a personal note, `/g/<group id>/<slug>` for a group note — there is no scheme and no host in it, so put this deployment's own origin in front before handing it to anyone; take the path from here rather than assembling it yourself. `role` is `owner`, `editor` or `viewer`, and it describes your access to that note, not your credential's scope. A group note is never `owner`: your access to it comes from your role in the group. `lastEdited` is `null` on a note nobody has edited since this feature landed; once someone has, it is `{at, byHandle, agentLabel}` — see [AI editing](./ai-editing.md#last-edited) for what each of those means.

**Errors** `invalid_body` — the `cursor` is not one this server issued. Omit it and start over.

### `search_notes`

**Takes** `query` (1–200 characters, used exactly as sent — it is not trimmed) and `limit` (1–50, default 20).

**Answers** `notes`, best match first, and `truncated`, plus `matchesTruncated: true` only when some matches were left out. Each entry in `notes` is a `list_notes` entry with two more fields:

- `matchedOn` — `"title"`, `"body"` or `"both"`: where your text was found.
- `matches` — up to 3 sections of the note that contain your text, in document order, each `{sectionId, heading, headingTruncated?, snippet}`. `heading` is cut like every other heading (see [Limits](#limits)) and is empty for `_top`; `snippet` is an excerpt of that section's text around its first hit. `matches` is always empty when `matchedOn` is `"title"`. For a body match it can be empty only in a reply that carries `matchesTruncated: true`: to keep a reply small, matches are added note by note in the order of `notes`, and adding stops for good at the first one that doesn't fit. Ask for fewer notes with `limit` to get them.

**Matching** is case-insensitive and literal — `%` and `_` are ordinary characters, not wildcards; how far case-insensitivity reaches beyond ASCII depends on the database (see [Known limitations](./known-limitations.md)). Notes whose title contains your text come first — exact titles, then titles that start with your text, then the rest — followed by notes that match only in the body; within each of those groups, the most recently updated note comes first. Body text is matched one section at a time, so text that runs across the boundary between two sections is not found. Inside a section, each block's text is separated from the next block's by one line break, so the end of one paragraph and the start of the next don't run together into a match.

**Snippets** are at most 160 characters as written in JSON (counted the same way as headings, see [Limits](#limits)), with `…` at an end where the section's text goes on. Runs of whitespace on either side of the hit, line breaks included, are shown as a single space; the hit itself is shown as the note has it, which can differ in case from your query. On a database where lower-casing text never changes its length — the default database image is one — a snippet always contains the start of the section's first hit, and contains the whole hit whenever your query is at most 158 characters, none of which JSON escapes.

**When text becomes searchable.** A note's body text is indexed each time the collaboration server saves the note: about 2 seconds after people stop typing, at most about 10 seconds apart while they keep typing, and at once when the last person with it open disconnects. A write made through the REST API, `edit_note` or `create_note` is indexed before its reply comes back. The first time the server starts after an upgrade to a version with body-text search, it indexes the existing notes in the background, and until it gets to a note, that note can only be found by its title.

**Not searched:** attachments, text inside images, a media block's caption and file name, and the address behind a link or a media block (a link's own text is searched).

**On a deployment without the collaboration component**, no tool there reads a `sectionId`, and body text gets into the index only when the server starts and when a note is copied.

There is **no next page**: when `truncated` is true the answer is a narrower query, not a cursor.

**Errors** `too_many_requests` — searches have a budget of their own, 60 per minute per user (see [Limits](#limits)).

### `read_note_outline`

**Takes** `note_id`, and `section_offset` — counted in **sections**, not characters.

**Answers** `note`, `totalChars`, `sections`, `truncated`, `nextSectionOffset` and `lastEdited`.

- `note` here is an **object**: `{id, title, titleTruncated?, owner, role}`.
- `totalChars` is the whole note, not this page.
- `sections` holds at most 100 entries in document order, each `{sectionId, level, heading, headingTruncated?, chars}`. The first section of every note is `_top` — whatever comes before the first heading — and its `level` is `0`.
- **There are no fingerprints here**, neither per section nor for the note. An outline tells you what a note contains and what to read next; the fingerprint a write needs comes from `read_note_section` (on the page that finishes a section) or from a previous `edit_note` reply.

**Errors** `not_found`, `too_many_requests`.

### `read_note_section`

**Takes** `note_id`, `section_id` (from the outline — `_top` for the text before the first heading), and `offset`, counted in **markdown characters**.

**Answers** `section` = `{id, level, chars, markdown, fingerprint?}`, plus `truncated`, `nextOffset`, `lastEdited` and `note`.

- `markdown` is at most 4000 UTF-16 code units per call. The first page of a section starts with the section's heading line — except `_top`, which has no heading; a later page simply resumes where the previous one stopped.
- **`fingerprint` arrives only with the page that finishes the section** — a page with `truncated: true` carries no `fingerprint` field at all. Read to the end before you rewrite a section, or you will replace text you never saw.
- **`chars` and `offset` are different units.** `chars` is the section's plain text; `offset` and `nextOffset` count markdown characters, which include heading marks, list bullets, link syntax and fence lines. A section reporting `chars: 5403` can still hand back `nextOffset: 8000`. Decide whether you have read it all from `truncated` and `nextOffset` — never by comparing `offset` to `chars`.
- **Colors come back as HTML** in the markdown: colored text as a `<span style="color:red">` inside the ordinary markdown; a paragraph, heading, list or quote with a color of its own, or a table with a colored cell, as a block of HTML with `data-text-color` / `data-background-color`. Send it back unchanged and the colors are kept. The forms, the ten color names and what is not carried are in [AI editing](./ai-editing.md#colors).
- **`note` here is a plain string**, present only while `truncated` is true: it is the sentence telling you how to finish reading. `read_note_outline`'s `note` is an object describing the note. Same field name, two tools, two types — if you handle both replies with one piece of code, check the type.

**Errors** `not_found`, `section_not_found` (an edit can change a section's id — call `read_note_outline` again rather than retrying the old one), `too_many_requests`.

### `edit_note`

**Takes** `note_id`, `op` — one of `replace_all`, `replace_section`, `insert_after`, `append`, `delete_section`, `rename` — and then `section_id`, `markdown`, `if_match` and `title` according to the operation:

| Field | Required for |
|---|---|
| `section_id` | `replace_section`, `insert_after`, `delete_section` |
| `markdown` | every operation except `delete_section` and `rename` |
| `if_match` | every operation except `append` and `rename` |
| `title` | `rename` only |

Fields that do not belong to the operation you asked for are rejected rather than ignored. What each operation does to a note — including the fact that replacing a section replaces its heading, and that section ids are block ids — is in [AI editing](./ai-editing.md#the-five-operations).

**Answers** for the five content operations: `editId` (anyone who can edit the note can undo this change with it), `fingerprint` (the whole note's new one — pass it as `if_match` to a following `replace_all`), `outline`, and `unboundWikilinks` (how many `[[wikilinks]]` in what you wrote were left as plain text because **no note you can see has that exact title, or more than one does**).

`outline` is `{sections, truncated}`, at most 100 entries, and — unlike `read_note_outline`'s — **every entry carries its own `fingerprint`**, so a run of edits does not have to re-read between them. **Where that page starts depends on the operation:**

- `replace_section` and `insert_after` start it at the section that now holds what you wrote. That can be the *preceding* section, if your markdown did not open with a heading.
- `replace_all`, `append` and `delete_section` start it at the beginning of the note. On a note with more than 100 sections, an `append` therefore does not show you the end you just wrote — read it back with `read_note_outline`.

**Errors** `invalid_body` (the fields do not match the operation), `not_found`, `forbidden` (you can read this note but not change it), `section_not_found`, `fingerprint_mismatch`, `too_many_requests`, `server_busy` (another write held the note's queue for 10 seconds — nothing was applied and nothing was recorded), and — from parsing the markdown you sent — `unsupported_block`, `unsupported_color` (a text or background color that isn't one of the editor's ten names — nothing was written; the message lists the names, and [AI editing](./ai-editing.md#colors) has the forms), `empty_content`, `too_many_blocks`. `empty_section` is separate: it means the section you asked `delete_section` to remove is already empty — which includes `_top` on a note that starts with a heading.

`fingerprint_mismatch` carries one extra field: `outline`, the note's sections **as they are now** — deliberately with no fingerprints on them. Your view is stale; read what you want to change again and retry with a fresh `if_match` rather than guessing.

#### `rename`

`rename` changes a note's title and takes `title` and nothing else — no `if_match`, because a title has no fingerprint: the last title written wins, the same as renaming the note in the browser. It needs the same access as changing the title in the web app — a `role` of `owner` or `editor` on the note; otherwise `forbidden`.

- **It is not recorded** in the note's AI edit history and has no `editId`. To undo it, rename the note back — its URL may not come back as it was, because the old name may already have been taken by another note (see [Known limitations](./known-limitations.md)).
- **Unless the note has a custom URL, its URL follows the new title**, derived and de-duplicated the same way as `create_note`'s, and the old URL usually stops working: no redirect is left behind, and the old address can later lead to a different note that takes that name. A custom URL stays as it is.
- **It answers `title` and `url`** instead of `editId`, `fingerprint`, `outline` and `unboundWikilinks`. `title` is cut like any other title, with `titleTruncated: true`; `url` is the same site-relative path `list_notes` gives.
- It doesn't count against the 30-writes-per-minute budget — only against the token-writes one, when it is made with a token — and it doesn't show you as present in the note.
- **Errors** `not_found`, `forbidden`, `invalid_body` (a field other than `title` with `rename`, or `title` with another operation), `conflict` (the note was moved into a group, or its group was deleted, between the access check and the write — nothing changed; try again), `too_many_requests` (token writes).

### `create_note`

**Takes** `title`, `content` and `group_id`, all optional. `create_note` creates a new note — yours, or in one of your groups when you pass `group_id`.

**Answers** `note` — the same entry shape `list_notes` returns. Its `id` is what you pass to `read_note_outline`, or to `edit_note` when its `role` allows writing; its `url` is the same site-relative path described under `list_notes`, not a link you can hand over as it stands. A personal note comes back with `role: "owner"`. A note created with `group_id` belongs to the group: its `owner` is `{kind: "group", id, name, nameTruncated?}`, its `url` is `/g/<group id>/<slug>`, and its `role` is what your role in that group gives you on the group's notes — `"editor"`, or `"viewer"` if your role can create notes but not edit them, in which case your role doesn't let you change the note's content: `edit_note` answers `forbidden`.

- **`group_id` puts the note in one of your groups.** Pass the id of one of your groups where your role lets you create notes. The note then belongs to the group, not to you. Leave it out for a personal note. If your role there can create notes but not edit them, the note is read-only for you: the reply's `role` is `viewer`. The id is the `id` in the `owner` of any of that group's notes from `list_notes` or `search_notes`; there is no tool that lists your groups, so a group with no notes yet doesn't show up anywhere here — its id is in the address of the group's settings page in the web app (`/settings/groups/<group id>`). A group you don't belong to and a group that doesn't exist both answer the same `group_not_found`, byte for byte; a group where your role can't create notes answers `forbidden`. A `group_id` that is not a uuid fails the tool's input check (see [Errors](#errors) — that answer carries no `code`).
- Leave out `title` and the note is called "Untitled" and keeps a database-assigned `untitled-<8 hex characters>` URL. A `title` you pass here is also what the note's URL is derived from, de-duplicated against the other notes in the same place — your personal notes, or that group's notes — with a numeric suffix (`meeting-notes`, then `meeting-notes-2`). Some titles have no usable URL form and fall back to `untitled`, numbered the same way — punctuation on its own, a reserved word, or a uuid, or a title ending in one. Pass a title if you know it; `edit_note`'s `rename` can change it later when the reply's `role` is `owner` or `editor`.
- `content` is the new note's markdown. Leave `content` out for an empty note, which `edit_note` can fill in later if the reply's `role` is `owner` or `editor`. Bad markdown is rejected before anything is stored, so a call that fails to parse leaves no note behind.
- **Only a call carrying `content` is recorded and can be undone** — undone by anyone who can edit the note, which leaves out the creator when their role in the group can create notes but not edit them. Creating an empty note writes no history row — there is nothing to revert. Filling it in afterwards with `edit_note`, when your `role` on the note lets you, is what produces a revertable entry.
- A deployment without the collaboration component answers `invalid_body` to a call carrying `content`, unless a `group_id` in the same call is refused first. Create the note without `content`; the note still exists.

**Errors** `invalid_body`, `group_not_found` (with `group_id`: no group with that id among the groups you belong to — including one deleted just before the note would have been created), `forbidden` (with `group_id`: your role in that group can't create notes), `too_many_requests`, `internal` (the content could not be applied; the row that had just been created is then removed again, but only on a best-effort basis — if that removal fails too, an empty note is left behind. In principle this includes the note's write queue timing out, the same way it can for `edit_note`, but in practice that never happens: a note this call just created has no other writer that could be contending for it), and — from parsing the markdown you sent — `unsupported_block`, `unsupported_color`, `empty_content`, `too_many_blocks`. There is no `empty_section` here: that code only comes from `delete_section` being asked to remove a section (including `_top`) that is already empty, and `create_note` never deletes a section.

### `create_transfer_token`

**Takes** `note_id` and `purpose` — `upload` or `download` (a read-only credential is offered `download` only).

**Answers** a short-lived token for one note and one purpose, plus a ready-made `curl` command — your MCP credential can't be sent from a shell, and image bytes don't fit in tool arguments, so this is how an assistant moves an image in or out:

- `token` — starts with `knbt_`; send it only as `Authorization: Bearer <token>` to the address in `url`. It is not accepted anywhere else, and an ordinary API token is not accepted at those two addresses.
- `expiresAt` — when the token stops working: 10 minutes after it was issued, or earlier if the credential that asked for it expires first.
- `url`, `method`, `curl` — built from the server's `PUBLIC_URL`. For `upload`: `POST <PUBLIC_URL origin>/api/notes/<noteId>/uploads` with the image as the multipart field `file`. For `download`: `GET <PUBLIC_URL origin>/api/uploads/<upload_id>`, where you replace `<upload_id>` with the id from `/api/uploads/<id>` in the note's markdown.
- `next` — what to do with the reply and what its status codes mean, written for the assistant.

- **`upload` needs edit access and is good for one file.** The upload answers `{id, url}`; put the image in the note with `edit_note` using `![description](url)`, with `url` exactly as returned — the relative `/api/uploads/<id>`, which is the form copying a note and public pages recognise. A `401` means the token can't be used (expired, already used, or revoked); a `403` or `429` doesn't use it up (after a `429`, wait a moment and retry); a `404` means the note is gone or you can no longer see it. A `409 storage_quota_exceeded` means the note's storage space has no room for the file — don't retry until space has been freed, then ask for a new token; a `409 server_busy` means the token is used up — ask for a new one and retry. Once the server has started reading the file, a rejection — `413` too large, `415` not a PNG, JPEG, GIF or WebP image, `400` no file — still uses the token up.
- **A credential can hold at most 5 unused upload tokens at a time.** Using one, or letting it expire, frees its place; a sixth answers `too_many_requests`.
- **`download` fetches any image uploaded to that note,** any number of times until `expiresAt`, within your 300-reads-per-minute token budget. A `403` means the image belongs to another note, or you can no longer read this one; a `404` means there is no image with that id; a `429` means wait a moment and retry with the same token.
- Each use is checked again: the token's note, your role on it, and the credential that asked for it. Revoking that credential ends every token it issued.
- A browser session connected to `/api/mcp` doesn't get this tool.

**Errors** `not_found` (a note you can't see and one that doesn't exist answer the same), `forbidden` (`upload` on a note you can only read), `storage_quota_exceeded` (`upload` on a note whose storage space is already full — no token is issued; someone who can see that space's usage also gets `usedBytes` and `quotaBytes`), `too_many_requests` (the token-writes budget for `upload`, the content-reads budget for `download`, or 5 unused upload tokens already out), `unauthorized` (the credential was revoked or expired while the request was being handled).

### `move_note_to_group`

**Takes** `note_id` and `group_id`, both required. It moves one of your own personal notes into one of your groups — what **Move to…** does in the web app. A token or app credential needs `notes:move` for it; one without it isn't offered this tool at all.

**Answers** `note` — the note after the move, in the entry shape `list_notes` returns: its `owner` is the group, its `url` is `/g/<group id>/<slug>`, and its `role` is what your role in that group gives you, which can be `viewer`.

- **Only the owner of a personal note can move it.** A note shared with you, and a note already in a group, answer `forbidden`. A single note can't be taken out of a group again — here or in the web app; `copy_note` can copy it out instead.
- `group_id` is a group where your role lets you create notes; a group that doesn't exist, one you aren't in, and one where your role can't create notes all answer the same `group_not_found`. The web app's **Move to…** only lists groups where your role can both create and edit notes; this tool only checks create, so it can move a note into a group where the note is then read-only for you.
- **What moving does** is the same as in the web app: the note's per-person shares, its public link (including a custom public URL) and its version history are removed and don't come back; it gets the group's URL, and its old `/n/…` URL forwards to it for a month; from then on the group's roles decide who can read and change it. Its content, AI edit history and attachments stay with it, and its place in `list_notes`' order doesn't change. The move itself is not recorded in any history.
- **Errors** `not_found`, `forbidden`, `group_not_found`, `conflict` (the note stopped being your personal note after the access check — for example another request moved it at the same moment; it was not moved), `storage_quota_exceeded` (the group's storage space has no room for the note's images; someone who can see that group's usage also gets `usedBytes`, `quotaBytes` and `incomingBytes`), `server_busy` (a lock or serialization conflict; nothing was moved — try again in a moment), `too_many_requests` (token writes).

### `copy_note`

**Takes** `note_id`, and optionally `group_id`. It copies a note you can read into a new note — yours, or one of your groups' when you pass `group_id` — what **Make a copy** and **Copy to…** do in the web app. With a token or app credential, passing `group_id` needs `notes:move`.

**Answers** `note` — the new copy, in the entry shape `list_notes` returns. A personal copy comes back with `role: "owner"`; a copy in a group has the role your group role gives you, which can be `viewer`.

- Any note you can read can be copied, including one shared with you as a viewer. `group_id` follows the same rule as for `move_note_to_group`.
- **The copy gets the note's title and its current content**, and usually its own copies of the images uploaded to that note: an image block pointing at another note's upload, an upload URL inside a text link, and a full `https://…/api/uploads/…` URL keep pointing at the original, and an image whose file is already missing on the server is skipped and keeps its original URL (see [Known limitations](./known-limitations.md)). From then on the two notes change separately.
- Per-person shares, the public link, the AI edit history and the version history are not copied, and making the copy isn't recorded in any note's history — the copy starts with none.
- **Three budgets apply**: with a token, one token write (60 per 10 minutes); one write from the 30-writes-per-minute budget; and, when the copy will include images, one upload per image from the 120-per-10-minutes upload budget it shares with uploading images, counted before anything is copied.
- **Errors** `insufficient_scope` (`group_id` was passed and the credential doesn't have `notes:move`; this is checked before the note is looked up or any of the three budgets above is spent, so nothing is copied, and a `note_id` that doesn't exist answers the same), `not_found`, `group_not_found`, `storage_quota_exceeded` (the target space has no room for the note's images — a copy without images is never refused for space; someone who can see that space's usage also gets `usedBytes` and `quotaBytes`, and `incomingBytes` when the server got as far as measuring the images), `too_many_requests` (any of the three budgets), `server_busy` (nothing was copied — try again in a moment).

### `read_note_image`

**Takes** `note_id` and `upload_id` — the id from `/api/uploads/<id>` in the note's markdown; the whole `/api/uploads/<id>` is accepted too.

**Answers** the image itself, as an MCP image content block, plus `noteId` (the note the image was uploaded to), `uploadId`, `mimeType` and `bytes`.

- Images up to 5 242 880 bytes (5 MiB) come back as an image. A larger one answers `file_too_large` with `noteId` and `bytes`: with a token, download it with `create_transfer_token` (`purpose: "download"`) for that `noteId`; over a browser session, open it in the browser.
- You need to be able to read `note_id` **and** the note the image was uploaded to — the same rule as fetching `/api/uploads/<id>` in the browser. An image block copied from another note shows only if you can read that note; an image with an external URL can't be read here.
- It counts as one content read (120 per minute per user).
- **Errors** `not_found` (no note you can read with that id; or no image with that id you can read — an image that doesn't exist, one on a note you can't read, and one whose file is missing answer the same), `file_too_large`, `too_many_requests`.

**What Claude Code does with an image it receives.** This is the client's behaviour, observed with Claude Code 2.1.295 — Knotebook doesn't control it, and other clients or other Claude Code versions may differ. In that test, an image of up to 512 000 bytes was passed to the model as it is; from 516 096 bytes up (the two nearest sizes tested), it was re-encoded as a JPEG of about 500 KB first, and an image more than 2000 pixels on its longer side was scaled down to 2000. Claude Code also keeps a full-size copy of each image an MCP tool returns on the machine it runs on, under `~/.claude/projects/<project>/<session>/tool-results/`. Claude Code's own documentation lists that directory among the files it deletes once they are older than its `cleanupPeriodDays` setting; if you'd rather not keep note images on that machine for that long, lower the setting or delete the directory yourself.

## Images

In a note's markdown, an uploaded image is a reference to its upload, `/api/uploads/<id>`. To add one: `create_transfer_token` with `purpose: "upload"` → run the `curl` it returns with the image's path → `edit_note` with `![description](<url from the reply>)`. To fetch the images of a note you can read: `create_transfer_token` with `purpose: "download"` → run the `curl` with each `<upload_id>` filled in. To look at an image in a note you can read: take the id from `/api/uploads/<id>` in `read_note_section`'s markdown and call `read_note_image`. What Claude Code does with an image it receives is described under [`read_note_image`](#read_note_image).

## The read-write loop

Over the REST API the loop is "read the whole note, pick a section, write it back". Over MCP it is not, for two reasons: no tool returns a whole note, and an outline carries no fingerprints. The loop is:

1. `list_notes` or `search_notes` → a note `id`. When `search_notes` already gave you the `sectionId` you want, go straight to step 3 with it.
2. `read_note_outline` → the section ids, headings and lengths.
3. `read_note_section` on the section you mean, paging with `offset` until `truncated` is false. **The last page is where the `fingerprint` arrives.**
4. `edit_note` with that fingerprint as `if_match`.

After a successful `edit_note` you do not have to go back to step 2: the reply already carries the note's new whole-note `fingerprint` and a page of per-section fingerprints. The exception is a note with more than 100 sections, where the next section you want can fall outside the page that reply returned — read it back with `read_note_outline`, then `read_note_section`.

**Reading is always sectioned, and what that caps is a single response, not a total.** One call returns at most 4000 characters of body text, at most 100 sections, at most 100 notes; headings and titles are cut at 200 characters as written in JSON. Nothing caps the total — only the rate at which a client can ask; see the reading-budget entry in [Known limitations](#known-limitations).

**Writing does not require reading first.** `if_match` is a concurrency check: it refuses a write built on a stale read. It is not a record of what this agent has read, and an `append` sent without `if_match` skips the check by design. What actually bounds an agent is the credential's scope, the sharing on each note (for a group note, your role in its group), and the fact that most writes that put content into a note are recorded in that note's **AI edit history**, where such a write can be undone — while it is still one of the note's 100 most recent recorded writes and nothing has changed those blocks since. A `create_note` with no `content` records nothing, so there is nothing to undo; what keeps a recorded write undoable, and what takes that away, is in [AI editing](./ai-editing.md#revert). Some writes aren't in that history, for example a `rename` (rename it back instead), `move_note_to_group` (a single note can't be moved back out, and the shares, public link and version history it loses don't come back) and `copy_note` (the copy starts with no history).

## Limits

| Limit | Value | Applies to | What you get |
|---|---|---|---|
| Heading, title and group name length | 200 characters as written in JSON: `"`, `\` and the control characters JSON writes as `\n`, `\t`, `\r`, `\b`, `\f` count as two each, every other control character (U+0000–U+001F) and an unpaired surrogate as six | every tool that returns one | cut, with `headingTruncated` / `titleTruncated` / `nameTruncated: true` |
| Section text per call | 4000 UTF-16 code units | `read_note_section` | `truncated: true` and a `nextOffset` |
| Snippet length | 160 characters as written in JSON, counted as in the first row | `search_notes` | cut, with `…` |
| Matches per note | 3 | `search_notes` | the rest aren't listed |
| Sections per page | 100 | `read_note_outline`, and `edit_note`'s reply | `truncated: true` (plus `nextSectionOffset` on `read_note_outline`) |
| Blocks after parsing | 2000, counting nested blocks | `edit_note`, `create_note` with `content` | tool error `too_many_blocks` |
| Content reads | 120 per minute per user | `read_note_outline`, `read_note_section`, `read_note_image`, `create_transfer_token` with `download` | tool error `too_many_requests` |
| Searches | 60 per minute per user | `search_notes` | tool error `too_many_requests` |
| Writes | 30 per minute per user | `edit_note` (except `rename`), `create_note` **with `content`**, `copy_note` | tool error `too_many_requests` |
| Uploads | 120 files per 10 minutes per user | `copy_note` (one per attached image the copy will include, counted before copying), shared with uploads | tool error `too_many_requests` |
| Token writes | 60 per 10 minutes per user | `edit_note`, `create_note` **with or without `content`**, `move_note_to_group`, `copy_note`, and `create_transfer_token` with `upload`, made with a token | tool error `too_many_requests` |
| Concurrent writes to one note | serialised, 10 s wait | `edit_note` (except `rename`) | tool error `server_busy` |
| Concurrent writes to one note | serialised | `create_note` with `content` | not observable in practice — a note this call just created has no other writer to contend with, so the 10 s wait never fires |
| Token reads | 300 per minute per user | every `POST /api/mcp` made with a token, and each image download made with a transfer token | **HTTP `429`** |
| Request body | 262 144 bytes | the whole `POST /api/mcp` request, however many tool calls it carries | **HTTP `413 content_too_large`** |
| Transfer token lifetime | 10 minutes, or less when the credential that asked for it expires sooner | `create_transfer_token` | the token answers `401` once expired |
| Unused upload tokens | 5 per credential | `create_transfer_token` with `upload` | tool error `too_many_requests` |
| Image size | 5 242 880 bytes | `read_note_image` | tool error `file_too_large` |

The rate limits above are counted **per tool call, not per request** — one `POST /api/mcp` can carry several calls — with one exception: the 300-reads-per-minute budget is spent once per request, because the endpoint always declares `notes:read` whatever tools the request goes on to call. Apart from the search budget, which only `search_notes` draws on, these are the same per-user budgets the REST endpoints draw on, and a credential pays both its own and the tighter one; the full accounting is in [API tokens](./api-tokens.md#errors-and-rate-limits) and [AI editing](./ai-editing.md#limits).

Two limits are deliberately **not** in the table above:

- **`markdown` and `content` have a 262 144 code-unit length limit of their own, but on MCP you cannot reach it.** The request body limit is 262 144 **bytes**; a UTF-8 encoding is never shorter than the UTF-16 code-unit count, and the JSON-RPC envelope adds more than a hundred bytes on top — so over-long markdown is always answered by the HTTP `413` first, never by a length error.
- **The `limit` parameters** on `list_notes` and `search_notes` are enforced by the tool's own input schema, so a value outside the range is refused by the MCP SDK before the tool runs. That refusal is an `isError` result with a message and **no `code`** — see [Errors](#errors).

A tool call is never answered with an HTTP status, so the limits that bind over MCP are tabulated separately, above.

## Errors

Three layers answer differently, and a client has to handle all three.

**The HTTP layer** uses Knotebook's ordinary error body, `{"error": {"code", "message"}}`:

- `401 unauthorized` — no credential, or one that is unknown, expired, or whose account is disabled. Carries the `WWW-Authenticate` challenge.
- `403 forbidden` — the request carried an `Origin` header, and either it or the request's own `Host` did not match the host in `PUBLIC_URL`.
- `413 content_too_large` — the request body was over 262 144 bytes.
- `429 too_many_requests` — the 300-reads-per-minute token budget, or the per-IP limit on invalid Bearer attempts (30 per minute).
- `415 unsupported_media_type` — the request had a body, and its `Content-Type` was either missing or not `application/json`.
- `400 bad_request` — the body was not valid JSON.

**We answer `405` ourselves** on `GET` and `DELETE` (with `Allow: POST`) — those two methods are rejected before the request ever reaches the MCP transport, and the body is not the error shape above but the same JSON-RPC error envelope the transport uses. **The MCP transport itself** answers `406` as a JSON-RPC error envelope with an HTTP status of its own, when `Accept` is missing either media type.

**Everything the tools themselves refuse is HTTP `200` with `isError: true`,** and there are two shapes:

- Errors Knotebook produces carry `structuredContent: {code, message, …}`. `code` comes from the same vocabulary the REST API uses: `unauthorized`, `insufficient_scope`, `not_found`, `group_not_found`, `section_not_found`, `forbidden`, `conflict`, `invalid_body`, `fingerprint_mismatch`, `unsupported_block`, `unsupported_color`, `empty_content`, `empty_section`, `too_many_blocks`, `too_many_requests`, `server_busy`, `storage_quota_exceeded`, `file_too_large`, `internal`. `internal` is not tied to any one tool: every tool handler shares the same catch-all for an unexpected exception, so any of them can answer it, not only `create_note`, whose own reference is the only place that spells out a cause.
- Errors the MCP SDK produces — an unknown tool name, arguments that do not match a tool's input schema, a reply that does not match its output schema, or an unhandled failure — carry **no `code` and no `structuredContent`**, only a text message. **Do not write a client that reads `code` without checking it is there.**

One check the SDK makes sits outside the tool altogether: a reply that doesn't match the protocol's `CallToolResult` shape reaches the client as a JSON-RPC error rather than a tool result. Knotebook's replies always match it; it is listed so that a client knows the shape exists.

## Known limitations

These are the MCP-specific entries in the shared [Known limitations](./known-limitations.md) list. The ones that bite an assistant first are the three that page through live data rather than a snapshot.

- [A fingerprint is concurrency protection, not permission protection](./known-limitations.md)
- [A per-minute read limit is not a per-turn context budget](./known-limitations.md)
- [Notes other people shared with you, and your groups' notes, end up in your assistant's context](./known-limitations.md)
- [MCP clients don't list your groups](./known-limitations.md)
- [There is no cross-note view of what an assistant changed](./known-limitations.md)
- [A wrong `PUBLIC_URL` makes MCP requests that carry an `Origin` header answer `403`](./known-limitations.md)
- [A client's cached tool list does not shrink on its own](./known-limitations.md)
- [`list_notes` pages through live data, not a snapshot](./known-limitations.md)
- [`read_note_outline` pages through live positions, not a snapshot](./known-limitations.md)
- [`read_note_section` pages through live text, not a snapshot](./known-limitations.md)
- [`edit_note`'s reply carries fingerprints only for the page its change landed on](./known-limitations.md)
- [Body-text search can lag the editors by a few seconds](./known-limitations.md)
- [Only about the first million characters and the first 2000 sections of a note are searchable](./known-limitations.md)
- [Right after an upgrade, older notes can be found by title only until the server has indexed them](./known-limitations.md)
- [An assistant tricked by a prompt injection can send your notes' images off-site](./known-limitations.md)
- [An assistant tricked by a prompt injection can move your personal notes into a group, or copy notes into one](./known-limitations.md)
- [`read_note_image` shows an image only if you can read the note it was uploaded to](./known-limitations.md)
- [An image uploaded but never written into a note is still an attachment](./known-limitations.md)
- [The `curl` command `create_transfer_token` returns is built from `PUBLIC_URL`](./known-limitations.md)
- [On a plain-http `PUBLIC_URL` (for example a LAN deployment), transfer tokens cross the network unencrypted](./known-limitations.md)
- [An MCP connection made with the browser's sign-in session has no `create_transfer_token`](./known-limitations.md)
- [Only the editor's ten built-in colors can be written, and a list or table with block or cell colors reads back as HTML as a whole](./known-limitations.md)

## See also

[API tokens](./api-tokens.md) · [AI editing](./ai-editing.md) · [API contract summary](./api.md) · [Known limitations](./known-limitations.md)
