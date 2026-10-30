# MCP

Knotebook speaks [MCP](https://modelcontextprotocol.io) at `POST /api/mcp`, so an AI client — Claude Code, Claude Desktop, or anything else that speaks the protocol — can read and write your notes **as you**, through nineteen tools. This page is the reference for that surface: how to connect, what each tool takes and answers, what the limits are, and where the edges are.

The credential is an ordinary Knotebook credential. How one is issued, listed and revoked — a Personal API token, or one an app obtains for itself over OAuth — is in [API tokens](./api-tokens.md). What a write actually does to a note — what a section is, what fingerprints mean, the five operations, how a change is undone — is in [AI editing](./ai-editing.md). This page does not repeat either; it covers what is different about reaching them over MCP.

## The endpoint

| | |
|---|---|
| URL | `<your-host>/api/mcp` |
| Transport | Streamable HTTP, stateless, JSON responses — no SSE stream, no session id |
| Methods | `POST` only. `GET` and `DELETE` are authenticated and Origin-checked first, then answered with `405` and `Allow: POST`. |
| Capabilities | `tools` only — no resources, no prompts, no sampling. `tools.listChanged` is `false`. |
| Scope | `notes:read` gets you in; `edit_note`, `create_note`, `move_note_to_group`, `copy_note`, `create_folder`, `rename_folder`, `move_folder` and `move_note_to_folder` additionally need `notes:write`, and so does `create_transfer_token` when you ask it for an upload token. `move_note_to_group`, and `copy_note` with `group_id`, also need `notes:move`, which only comes together with `notes:write`. `delete_note`, `restore_note` and `delete_folder` need `notes:delete`, which also only comes together with `notes:write`. |

Authentication happens before the MCP transport sees the request, so a request with no credential gets `401` with a `WWW-Authenticate` challenge advertising `scope="notes:read notes:write notes:move notes:delete"` — that challenge is what an OAuth client follows to find the authorization server. A few things are refused by the HTTP layer earlier still, before any credential is looked at: a `Content-Type` that is not `application/json`, a body over the size limit, and a body that is not valid JSON. Those answer without a challenge — see [Errors](#errors).

Two things trip up hand-written clients:

- **`Accept` must contain both `application/json` and `text/event-stream`.** The MCP transport rejects anything else with `406`, and a bare `*/*` does **not** count. Real MCP clients send both; a `curl` by hand usually does not.
- **If the request carries an `Origin` header, it must match the host in `PUBLIC_URL`** — and so must the request's own `Host`. Anything else is `403 forbidden`, which is the DNS-rebinding guard the MCP specification requires. A request with no `Origin` at all — which is what command-line and desktop MCP clients normally send — is not subject to it. If a correctly-configured client suddenly gets `403`, check `PUBLIC_URL` first; see [Deployment prerequisites](./self-hosting.md#deployment-prerequisites).

The server announces itself as `knotebook`, and most clients use that name to namespace the tools (`knotebook:list_notes`, and so on). Each connection is also handed a short set of instructions describing how reading is paged, which tool lists the notes in the trash, and that `list_folders` shows the folders notes sit in; a read-only credential gets a different set, which names no tool that changes anything.

## How to connect

**The quickest way in is the app itself:** **Settings → Authorization → Connect Claude with MCP** shows this deployment's endpoint and ready-to-paste snippets for two ways of connecting: authorizing over OAuth, which needs no token and is shown only on `https://` deployments, and using a Personal API token. Both are described below. Every `claude mcp add` command on this page carries `-s user`, so the server is available in any directory; without it, the server would only exist in the directory you ran the command in (local scope).

### Authorizing over OAuth (https:// deployments)

MCP requires the server and its authorization endpoints to be `https://` (see [Self-hosting](./self-hosting.md#deployment-prerequisites)). On an `https://` deployment, a client that supports OAuth can obtain a credential of its own, so there is no token to create.

- **Claude Code:**

  ```sh
  claude mcp add -s user -t http knotebook https://<your-host>/api/mcp
  ```

  `-t http` is required: without a transport, `claude mcp add` always treats the argument as a stdio command, and the URL would be taken for a program to run. Then, in Claude Code, type `/mcp`, pick **knotebook**, choose **Authenticate**, and authorize in the browser that opens.

- **Claude Desktop (Windows):** add this under `mcpServers` in `claude_desktop_config.json`:

  ```json
  "knotebook": {
    "command": "cmd",
    "args": ["/c", "npx", "-y", "mcp-remote", "https://<your-host>/api/mcp"]
  }
  ```

  Quit Claude Desktop completely and start it again; `mcp-remote` opens the browser for you to authorize. The consent page shows the app as **"MCP CLI Proxy"**. This needs Node.js, and `mcp-remote` caches its registration and tokens under `~/.mcp-auth/mcp-remote-v1/` on the machine running the client.

On the consent page, tick *Create and edit notes* if the assistant should write: the first time you authorize a client, the boxes start unticked, and pressing **Allow** straight away gives it read-only access. Tick *Move or copy notes into groups* as well, if the page offers it, for `move_note_to_group` and for copying into a group, and *Move notes to the trash and restore them*, if the page offers it, for `delete_note`, `restore_note` and `delete_folder`; both can only be ticked together with *Create and edit notes*. A client that only connects through OAuth and got less than you want can be authorized again, ticking the boxes this time — the consent page then starts from the access it already has (see [Authorizing an app instead](./api-tokens.md#authorizing-an-app-instead-oauth)); or connect it with a token instead, as below (see [With a personal API token](#with-a-personal-api-token)).

After you press Allow, the client has its credential — once it reconnects it will list Knotebook's tools; how many it sees depends on the credential's scope and on the deployment, see [The tools](#the-tools). A `401` at this point would mean the credential never arrived. The access token lasts 24 hours, and the client renews it by itself with its refresh token; an app that has not been used for 30 days is removed (see [Revoking](./api-tokens.md#revoking)).

**Plain `http://` deployments.** OAuth does not work there: Claude Code and current versions of `mcp-remote` both refuse to send the token exchange to a server that is not `https://` (loopback excepted), and `--allow-http` only lets the connection through, not the token exchange. Use a personal API token instead (#159).

### With a personal API token

A personal token suits scripts and clients that don't support OAuth, and it is the only way to connect to a plain `http://` deployment.

`/api/mcp` takes an ordinary Knotebook credential as a Bearer token, so a client that lets you set an `Authorization` header yourself can point at it with a Personal API token — [Creating one](./api-tokens.md#creating-one) covers issuing it. Tick *Create and edit notes* when you create it if the assistant should write, and *Move or copy notes into groups* as well if it should be able to move notes into your groups or copy them there, and *Move notes to the trash and restore them* if it should be able to move notes to the trash and bring them back, or delete folders. With Claude Code, for example:

```sh
claude mcp add -s user knotebook https://<your-host>/api/mcp -t http -H "Authorization: Bearer knb_…"
```

A static header involves no OAuth token exchange, so this also works on a plain `http://` deployment. The `claude mcp add` command only writes the client's configuration, with the token in it as you typed it; a Claude Code session that is already running doesn't pick it up, so start a new one. To change what the assistant can do later, turn **Edit**, **Move** or **Delete** on or off for the token with the pencil button on its row in **Settings → Authorization → API tokens**; the header stays the same, and the client picks up the new tool list once it is restarted (see [Changing a token's access](./api-tokens.md#changing-a-tokens-access)).

**Claude Desktop with a personal access token.** Claude Desktop reaches `/api/mcp` through `mcp-remote`, which can send the same header. Put the header's value in `env` rather than in `args`: mcp-remote's README notes that Cursor, Codex CLI and Claude Desktop on Windows don't escape spaces inside `args` when they invoke `npx`, so `Authorization: Bearer knb_…` written as one argument would be split apart. Add this under `mcpServers` in `claude_desktop_config.json`:

```json
"knotebook": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://<your-host>/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
  "env": { "AUTH_HEADER": "Bearer knb_…" }
}
```

On a plain `http://` deployment, add `"--allow-http"` at the end of `args`. On Windows, Claude Desktop usually needs the command wrapped in `cmd /c`: set `command` to `"cmd"` and put `"/c", "npx"` at the start of `args`, keeping `env` as it is:

```json
"knotebook": {
  "command": "cmd",
  "args": ["/c", "npx", "-y", "mcp-remote", "https://<your-host>/api/mcp", "--header", "Authorization:${AUTH_HEADER}"],
  "env": { "AUTH_HEADER": "Bearer knb_…" }
}
```

## The tools

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
| `list_trash` | `notes:read` | List the notes in your trash |
| `delete_note` | `notes:delete` (with `notes:write`) | Move a note to the trash |
| `restore_note` | `notes:delete` (with `notes:write`) | Bring a note back from the trash |
| `list_folders` | `notes:read` | Page through the folders you can see, each with its path |
| `create_folder` | `notes:write` | Create a folder |
| `rename_folder` | `notes:write` | Rename a folder |
| `move_folder` | `notes:write` | Move a folder, with everything in it, within its space |
| `move_note_to_folder` | `notes:write` | File a note in a folder of its own space, or at that space's top level |
| `delete_folder` | `notes:delete` (with `notes:write`) | Delete a folder and the folders in it; the notes in your own or a group's folders move to the trash |
| `read_note_image` | `notes:read` | Look at an image uploaded to a note |

The permission summary under **Settings → Authorization → Connect Claude with MCP** is copied from this table; keep the two in sync.

Five things decide how many of these a client actually sees, and all five are settled when the request is served rather than when the tool is called:

- **A read-only credential never sees `edit_note`, `create_note`, `move_note_to_group`, `copy_note`, `delete_note`, `restore_note`, `create_folder`, `rename_folder`, `move_folder`, `move_note_to_folder` or `delete_folder`.** They are not registered for that request at all, so — on a deployment with the collaboration component — `tools/list` returns eight tools (only six on one without it; see below), and calling `create_note` anyway gets the SDK's own "Tool create_note not found" (an `isError` result, HTTP `200`) rather than a permission error. There is no scope error to handle here, because there is no tool to call. A read-only credential does see `create_transfer_token`, but it can only ask for a `download` token. To get the writing tools and upload tokens, turn on **Edit** (*Create and edit notes*, `notes:write`) for the credential on its row in **Settings → Authorization → API tokens** (the pencil), then reconnect — the client only picks up the new tools on a fresh connection.
- **A credential without `notes:move` never sees `move_note_to_group`.** A `notes:write` token or app credential with neither `notes:move` nor `notes:delete` gets fifteen tools on a deployment with the collaboration component (twelve without), and one more in either case once it has `notes:move` as well. It still sees `copy_note`, whose description then says that copying into a group needs `notes:move`, and a call with `group_id` answers `insufficient_scope` without copying anything — unless it also carries a `folder_id` that is refused first (see [`copy_note`](#copy_note)). To get `move_note_to_group`, turn on **Move** (*Move or copy notes into groups*) for the credential the same way, then reconnect; `copy_note` with `group_id` works from the credential's next request without reconnecting, though its description keeps saying that it needs `notes:move` until the client reconnects. A connection made with the web app's own sign-in session isn't limited by scope; it gets eighteen tools (fifteen), because it has no `create_transfer_token` (see the last point).
- **A credential without `notes:delete` never sees `delete_note`, `restore_note` or `delete_folder`.** A `notes:write` token or app credential that has `notes:delete` but not `notes:move` gets eighteen tools on a deployment with the collaboration component (fifteen without), and all nineteen (sixteen) with `notes:move` as well — the two scopes are independent of each other, and both need `notes:write`. `list_trash` and `list_folders` don't depend on any of this: every credential sees them, a read-only one included. To get `delete_note`, `restore_note` and `delete_folder`, turn on **Delete** (*Move notes to the trash and restore them*) for the credential the same way, then reconnect.
- **`read_note_outline`, `read_note_section` and `edit_note` need the collaboration component.** A deployment running without it never registers those three; a `notes:write` credential still sees `create_note`, but a call to it carrying `content` answers `invalid_body` and tells you to create the note without it — unless the call also carries a `folder_id` or a `group_id` that is refused first (`not_found`, `invalid_body`, `group_not_found` or `forbidden`). A read-only credential on such a deployment sees only `list_notes`, `search_notes`, `create_transfer_token`, `list_trash`, `list_folders` and `read_note_image` — `create_note` needs `notes:write` regardless of the deployment. `move_note_to_group`, `copy_note`, `list_trash`, `delete_note`, `restore_note`, `read_note_image` and the six folder tools — `list_folders`, `create_folder`, `rename_folder`, `move_folder`, `move_note_to_folder` and `delete_folder` — don't need the collaboration component.
- **`create_transfer_token` is only offered to a token or app credential.** A request made with the web app's own sign-in session never sees it — the browser can already upload and fetch images itself.

A result Knotebook itself produces — success or one of its own errors — comes back twice, identically: as `structuredContent` and, as a JSON string, in `content[0].text`. Read whichever your client prefers. (An error the MCP SDK produces itself, rather than a tool, is the exception — see [Errors](#errors).)

Every tool that takes a `note_id` — `read_note_outline`, `read_note_section`, `edit_note`, `move_note_to_group`, `copy_note`, `create_transfer_token`, `delete_note`, `restore_note`, `move_note_to_folder` and `read_note_image` — answers a note you cannot see and a note that does not exist with the **same** `not_found`, byte for byte, so they cannot be used to find out which note ids exist.

The same goes for folders: every tool that takes a `folder_id` or `parent_id` — `create_note`, `move_note_to_group`, `copy_note`, `create_folder`, `rename_folder`, `move_folder`, `move_note_to_folder` and `delete_folder` — answers a folder you cannot see and a folder that does not exist with the same `not_found`, byte for byte. A folder id that is not a uuid fails the tool's input check (see [Errors](#errors) — that answer carries no `code`). MCP takes a folder only by its id, never by a path or a name: to find a folder by its name, look it up with [`list_folders`](#list_folders).

Tool inputs are snake_case (`note_id`, `group_id`); replies use camelCase. Every tool rejects an argument it doesn't know instead of ignoring it — `ifMatch` for `if_match`, for example, fails the tool's input check (see [Errors](#errors) — that answer carries no `code`).

### `list_notes`

**Takes** `cursor` (opaque — the `nextCursor` from a previous call; omit it for the first page) and `limit` (1–100, default 50).

**Answers** `notes`, and `nextCursor` which is `null` on the last page. A page can hold fewer notes than `limit` when the notes are large, to keep the reply small; it then also carries `pageCutShort: true`, and `nextCursor` is not `null` — keep paging until it is. Each entry is `{id, title, titleTruncated?, owner, slug, url, role, updatedAt, lastEdited, folder}`. `title` is cut at 200 characters as written in JSON (see [Limits](#limits)) and `titleTruncated: true` appears only when it was cut. `owner` says whose note it is: `{kind: "user", handle}` for a personal note, `{kind: "group", id, name, nameTruncated?}` for a note that belongs to one of your groups. A group's `name` is cut the same way as `title`, with `nameTruncated: true` when it was; group names are at most 80 characters, so a name can only be long enough to be cut if it contains control characters. `url` is the note's page as a **site-relative path** — `/n/<username>/<slug>` for a personal note, `/g/<group id>/<slug>` for a group note — there is no scheme and no host in it, so put this deployment's own origin in front before handing it to anyone; take the path from here rather than assembling it yourself. `role` is `owner`, `editor` or `viewer`, and it describes your access to that note, not your credential's scope. A group note is never `owner`: your access to it comes from your role in the group. `lastEdited` is `null` on a note nobody has edited since this feature landed; once someone has, it is `{at, byHandle, agentLabel}` — see [AI editing](./ai-editing.md#last-edited) for what each of those means. `folder` is the folder the note is filed in **for you**, `{id, name, nameTruncated?}`, or `null` at the top level: for a note someone shared with you, it is where you filed it among your own folders, never where its owner filed it — the owner's folders don't show up here at all. It is only that one folder; `list_folders` gives its whole path. `name` is cut as described in [Limits](#limits).

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

**Answers** `note`, `folder`, `totalChars`, `sections`, `truncated`, `nextSectionOffset` and `lastEdited`.

- `note` here is an **object**: `{id, title, titleTruncated?, owner, role}`.
- `folder` is where the note is filed for you — the same folder as `list_notes`' `folder`, so for a note shared with you it is where you filed it — as `{id, path, pathTruncated?}`, with `path` the folder names from the top level down, ending with that folder's own; or `null` at the top level. A long path is cut from the top (see [Limits](#limits)). Like the tool itself, it exists only on a deployment with the collaboration component; elsewhere, `list_folders` gives a folder's path.
- `totalChars` is the whole note, not this page.
- `sections` holds at most 100 entries in document order, each `{sectionId, level, heading, headingTruncated?, chars}`. The first section of every note is `_top` — whatever comes before the first heading — and its `level` is `0`.
- Any `sectionId` other than `_top` is also the id of that heading's block, so `/notes/<note id>#b-<sectionId>` links to that heading: opening it in the web app scrolls to the heading. Use it as the URL of a link you write (see [Links to notes](#links-to-notes)).
- **There are no fingerprints here**, neither per section nor for the note. An outline tells you what a note contains and what to read next; the fingerprint a write needs comes from `read_note_section` (on the page that finishes a section) or from a previous `edit_note` reply.

**Errors** `not_found`, `too_many_requests`.

### `read_note_section`

**Takes** `note_id`, `section_id` (from the outline — `_top` for the text before the first heading), and `offset`, counted in **markdown characters**.

**Answers** `section` = `{id, level, chars, markdown, fingerprint?}`, plus `truncated`, `nextOffset`, `lastEdited` and `note`.

- `markdown` is at most 4000 UTF-16 code units per call. The first page of a section starts with the section's heading line — except `_top`, which has no heading; a later page simply resumes where the previous one stopped.
- **`fingerprint` arrives only with the page that finishes the section** — a page with `truncated: true` carries no `fingerprint` field at all. Read to the end before you rewrite a section, or you will replace text you never saw.
- **`chars` and `offset` are different units.** `chars` is the section's plain text; `offset` and `nextOffset` count markdown characters, which include heading marks, list bullets, link syntax and fence lines. A section reporting `chars: 5403` can still hand back `nextOffset: 8000`. Decide whether you have read it all from `truncated` and `nextOffset` — never by comparing `offset` to `chars`.
- **Colors come back as HTML** in the markdown: colored text as a `<span style="color:red">` inside the ordinary markdown; a paragraph, heading, list or quote with a color of its own, or a table with a colored cell, as a block of HTML with `data-text-color` / `data-background-color`. Send it back unchanged and the colors are kept. The forms, the ten color names and what is not carried are in [AI editing](./ai-editing.md#colors).
- **Side-by-side columns come back as HTML `<div>`s with markdown inside**: a row is a `<div data-kb-columns style="display:flex;gap:16px">` line holding one `<div data-kb-column style="flex:N">` per column, each tag on a line of its own, with a blank line after each column's opening tag and before its `</div>`. A heading inside a column doesn't start a section. Send the row back whole and unchanged and the columns are kept — except a row of more than four columns, which a paste can produce and a write refuses; the exact rules, and what else is refused, are in [AI editing](./ai-editing.md#columns).
- **Image widths and table column widths come back as HTML**: an image shown at a set width as `<figure><img … width="W">…</figure>` (with a `<figcaption>` before `</figure>` when it has a caption; an image whose preview is turned off reads as a link, without its width), and a table with column widths as an HTML table with `colwidth` on its first row's cells. Send them back unchanged and the sizes are kept — see [AI editing](./ai-editing.md#sizes).
- **A link saved as a link to a note comes back as `[text](/notes/<id>)`** (inside a block that comes back as HTML, as `<a href="/notes/<id>">`), ending in `#b-<block id>` when it points at a place in that note. `text` is the link's own text when it has one; otherwise it is the note's current title — or, if you can't see that note (or it was deleted), the text the link was made with (the note's title then, if the link had no text of its own): the reply never shows you the current title of a note you can't see. Write it back unchanged and it stays the same link, as long as you can see that note (see [Links to notes](#links-to-notes)).
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

**Errors** `invalid_body` (the fields do not match the operation), `not_found`, `forbidden` (you can read this note but not change it), `section_not_found`, `fingerprint_mismatch`, `too_many_requests`, `server_busy` (another write held the note's queue for 10 seconds — nothing was applied and nothing was recorded), and — from parsing the markdown you sent — `unsupported_block` (something this editor can't store, markdown it fails to parse, or HTML with an event-handler attribute such as `onerror`), `unsupported_color` (a text or background color that isn't one of the editor's ten names — nothing was written; the message lists the names, and [AI editing](./ai-editing.md#colors) has the forms), `unsupported_columns` (side-by-side columns not written in the form [AI editing](./ai-editing.md#columns) describes — including a row of fewer than 2 or more than 4 columns — or another `<div>` laid out with `display:flex` or `display:grid`, or an element carrying `data-node-type`; nothing was written), `unsupported_size` (an image width or table column width not written in the form [AI editing](./ai-editing.md#sizes) describes; nothing was written), `empty_content`, `too_many_blocks`. `empty_section` is separate: it means the section you asked `delete_section` to remove is already empty — which includes `_top` on a note that starts with a heading.

`fingerprint_mismatch` carries one extra field: `outline`, the note's sections **as they are now** — deliberately with no fingerprints on them. Your view is stale; read what you want to change again and retry with a fresh `if_match` rather than guessing.

#### Links to notes

A Markdown link whose URL is a note on this site — `/notes/<id>` or the `url` list_notes gives, relative or this site's full URL, optionally ending in `#b-<block id>` — is saved as a link to that note if you can see it; any other link to this site is kept as an ordinary link. A note link follows the note when it is renamed, shows up in the note's backlinks, and is what `read_note_section` gives back as `[text](/notes/<id>)`. If the link's text is the note's current title (or the URL itself), the link shows whatever the note is called later; any other text is kept as the link's own text, without its formatting (bold, italic and so on are dropped).

These stay ordinary links: a note you can't see, a URL that only reaches the note through an older address (a renamed note's previous URL, or a `/notes/<old slug>` link from before 0.3.3), a URL with a query (`?…`) or with a fragment other than `#b-<block id>`, and a public `/p/…` page. `[[Title]]` keeps working as before, now also inside tables; `unboundWikilinks` still counts only `[[…]]` that weren't bound.

#### `rename`

`rename` changes a note's title and takes `title` and nothing else — no `if_match`, because a title has no fingerprint: the last title written wins, the same as renaming the note in the browser. It needs the same access as changing the title in the web app — a `role` of `owner` or `editor` on the note; otherwise `forbidden`.

- **It is not recorded** in the note's AI edit history and has no `editId`. To undo it, rename the note back — its URL may not come back as it was, because the old name may already have been taken by another note (see [Known limitations](./known-limitations.md)).
- **Unless the note has a custom URL, its URL follows the new title**, derived and de-duplicated the same way as `create_note`'s, and the old URL usually stops working: no redirect is left behind, and the old address can later lead to a different note that takes that name. A custom URL stays as it is.
- **It answers `title` and `url`** instead of `editId`, `fingerprint`, `outline` and `unboundWikilinks`. `title` is cut like any other title, with `titleTruncated: true`; `url` is the same site-relative path `list_notes` gives.
- It doesn't count against the 30-writes-per-minute budget — only against the token-writes one, when it is made with a token — and it doesn't show you as present in the note.
- **Errors** `not_found`, `forbidden`, `invalid_body` (a field other than `title` with `rename`, or `title` with another operation), `conflict` (the note was moved into a group, or its group was deleted, between the access check and the write — nothing changed; try again), `too_many_requests` (token writes).

### `create_note`

**Takes** `title`, `content`, `group_id` and `folder_id`, all optional. `create_note` creates a new note — yours, or in one of your groups when you pass `group_id` — at the top level, or in a folder when you pass `folder_id`.

Links in `content` are saved the same way as in `edit_note` (see [Links to notes](#links-to-notes)).

**Answers** `note` — the same entry shape `list_notes` returns. Its `id` is what you pass to `read_note_outline`, or to `edit_note` when its `role` allows writing; its `url` is the same site-relative path described under `list_notes`, not a link you can hand over as it stands. A personal note comes back with `role: "owner"`. A note created with `group_id` belongs to the group: its `owner` is `{kind: "group", id, name, nameTruncated?}`, its `url` is `/g/<group id>/<slug>`, and its `role` is what your role in that group gives you on the group's notes — `"editor"`, or `"viewer"` if your role can create notes but not edit them, in which case your role doesn't let you change the note's content: `edit_note` answers `forbidden`.

- **`group_id` puts the note in one of your groups.** Pass the id of one of your groups where your role lets you create notes. The note then belongs to the group, not to you. Leave it out for a personal note. If your role there can create notes but not edit them, the note is read-only for you: the reply's `role` is `viewer`. The id is the `id` in the `owner` of any of that group's notes from `list_notes` or `search_notes`, or the `groupId` in the `space` of any of its folders from `list_folders`. There is no tool that lists your groups as such, so a group with neither notes nor folders yet doesn't show up in any of those three — its id is in the address of the group's panel in the web app (the group's `⋮` menu in the sidebar → **Members & settings**, or **View members** if your role can't manage members), `/groups/<group id>`. Without `folder_id`, a group you don't belong to and a group that doesn't exist both answer the same `group_not_found`, byte for byte; a group where your role can't create notes answers `forbidden`. A `group_id` that is not a uuid fails the tool's input check (see [Errors](#errors) — that answer carries no `code`).
- **`folder_id` puts the note in a folder**, one from `list_folders`; leave it out for the top level. One of your personal folders makes a personal note, so leave out `group_id`; one of a group's folders needs that group's id as `group_id`, and a role there that can both create and edit notes — a role that can create notes but not edit them answers `forbidden`, and can still create the note at the group's top level without `folder_id`. Your folders for notes shared with you can't hold new notes. The folder is checked first, before the group: a folder you can't see answers `not_found`, the same as one that doesn't exist, and a folder you can see that doesn't fit the call — a group's folder without that group's `group_id`, a personal folder with a `group_id`, or one of your folders for notes shared with you — answers `invalid_body`. So with `folder_id`, a group you don't belong to usually answers `not_found` or `invalid_body`, not `group_not_found`.
- Leave out `title` and the note is called "Untitled" and keeps a database-assigned `untitled-<8 hex characters>` URL. A `title` you pass here is also what the note's URL is derived from, de-duplicated against the other notes in the same place — your personal notes, or that group's notes — with a numeric suffix (`meeting-notes`, then `meeting-notes-2`). Some titles have no usable URL form and fall back to `untitled`, numbered the same way — punctuation on its own, a reserved word, or a uuid, or a title ending in one. Pass a title if you know it; `edit_note`'s `rename` can change it later when the reply's `role` is `owner` or `editor`.
- `content` is the new note's markdown. Leave `content` out for an empty note, which `edit_note` can fill in later if the reply's `role` is `owner` or `editor`. Bad markdown is rejected before anything is stored, so a call that fails to parse leaves no note behind.
- **Only a call carrying `content` is recorded and can be undone** — undone by anyone who can edit the note, which leaves out the creator when their role in the group can create notes but not edit them. Creating an empty note writes no history row — there is nothing to revert. Filling it in afterwards with `edit_note`, when your `role` on the note lets you, is what produces a revertable entry.
- A deployment without the collaboration component answers `invalid_body` to a call carrying `content`, unless a `folder_id` or `group_id` in the same call is refused first. Create the note without `content`; the note still exists.

**Errors** `invalid_body`, `not_found` (with `folder_id`: no folder with that id that you can see — including one deleted, or whose group was deleted, just before the note would have been created), `group_not_found` (with `group_id`: no group with that id among the groups you belong to — including, without `folder_id`, one deleted just before the note would have been created), `forbidden` (with `group_id`: your role in that group can't create notes, or, with `folder_id`, can't edit them), `too_many_requests`, `server_busy` (a lock or serialization conflict while the note was being created; nothing was created — try again in a moment), `internal` (the content could not be applied; the row that had just been created is then removed again, but only on a best-effort basis — if that removal fails too, an empty note is left behind. In principle this includes the note's write queue timing out, the same way it can for `edit_note`, but in practice that never happens: a note this call just created has no other writer that could be contending for it), and — from parsing the markdown you sent, as for `edit_note` — `unsupported_block`, `unsupported_color`, `unsupported_columns`, `unsupported_size`, `empty_content`, `too_many_blocks`. There is no `empty_section` here: that code only comes from `delete_section` being asked to remove a section (including `_top`) that is already empty, and `create_note` never deletes a section.

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

**Takes** `note_id` and `group_id`, both required, and optionally `folder_id`. It moves one of your own personal notes into one of your groups — what picking a group in **Move to…** does in the web app; moving a note within the space it is in is `move_note_to_folder`. A token or app credential needs `notes:move` for it; one without it isn't offered this tool at all.

**Answers** `note` — the note after the move, in the entry shape `list_notes` returns: its `owner` is the group, its `url` is `/g/<group id>/<slug>`, its `role` is what your role in that group gives you, which can be `viewer`, and its `folder` is where it landed.

- **Only the owner of a personal note can move it.** A note shared with you, and a note already in a group, answer `forbidden`. A single note can't be taken out of a group again — here or in the web app; `copy_note` can copy it out instead.
- `group_id` is a group where your role lets you create notes; a group that doesn't exist, one you aren't in, and one where your role can't create notes all answer the same `group_not_found` when there is no `folder_id`. The web app's **Move to…** only lists groups where your role can both create and edit notes; without `folder_id`, this tool only checks create, so it can move a note into a group where the note is then read-only for you.
- **`folder_id` puts the note in one of that group's folders** (`list_folders` with `group_id` lists them) instead of at the group's top level, and then your role there must also be able to edit notes — otherwise `forbidden`. The folder is checked after the note and before the group: a folder you can't see answers `not_found`, the same as one that doesn't exist — which is what a folder of a group you aren't in answers — and a folder you can see that isn't one of that group's answers `invalid_body`.
- **What moving does** is the same as in the web app: the note's per-person shares, its public link (including a custom public URL) and its version history are removed and don't come back; it gets the group's URL, and its old `/n/…` URL forwards to it for a month; from then on the group's roles decide who can read and change it. Its content, AI edit history and attachments stay with it, and its place in `list_notes`' order doesn't change. The move itself is not recorded in any history.
- **Errors** `not_found` (the note, or with `folder_id` the folder — also one deleted while the note was being moved), `forbidden`, `group_not_found`, `invalid_body` (with `folder_id`: a folder that isn't one of that group's), `conflict` (the note stopped being your personal note after the access check — for example another request moved it at the same moment; it was not moved), `storage_quota_exceeded` (the group's storage space has no room for the note's images; someone who can see that group's usage also gets `usedBytes`, `quotaBytes` and `incomingBytes`), `server_busy` (a lock or serialization conflict; nothing was moved — try again in a moment), `too_many_requests` (token writes).

### `copy_note`

**Takes** `note_id`, and optionally `group_id` and `folder_id`. It copies a note you can read into a new note — yours, or one of your groups' when you pass `group_id` — what **Make a copy** and **Copy to…** do in the web app; the copy lands at the top level, or in the folder you pass as `folder_id`. With a token or app credential, passing `group_id` needs `notes:move`.

**Answers** `note` — the new copy, in the entry shape `list_notes` returns. A personal copy comes back with `role: "owner"`; a copy in a group has the role your group role gives you, which can be `viewer`.

- Any note you can read can be copied, including one shared with you as a viewer. `group_id` follows the same rule as for `move_note_to_group` without `folder_id`.
- **`folder_id`** is one of your personal folders, for a copy of your own (leave out `group_id`), or one of the folders of the group you pass as `group_id`, where your role must also be able to edit notes — otherwise `forbidden`. Your folders for notes shared with you can't hold a copy. Leaving out `folder_id` doesn't put the copy next to the original: it goes to the top level.
- **With `folder_id`, the folder is checked first** — before `notes:move` is checked, before the note is looked up, and before any of the budgets below is spent: a folder you can't see answers `not_found` (the same as one that doesn't exist), and a folder you can see that doesn't fit the call — a group's folder without that group's `group_id`, a personal folder with a `group_id`, or one of your folders for notes shared with you — answers `invalid_body`. So a call with `folder_id` can get a different error than the same call without it, or than `POST /api/notes/:id/copy`, which looks up the note before the folder: a note you can't see together with a folder you can't see answers the folder's `not_found`, and a group folder you can't see answers `not_found` rather than `insufficient_scope` on a credential without `notes:move`.
- **The copy gets the note's title and its current content**, and usually its own copies of the images uploaded to that note: an image block pointing at another note's upload, an upload URL inside a text link, and a full `https://…/api/uploads/…` URL keep pointing at the original, and an image whose file is already missing on the server is skipped and keeps its original URL (see [Known limitations](./known-limitations.md)). From then on the two notes change separately.
- Per-person shares, the public link, the AI edit history and the version history are not copied, and making the copy isn't recorded in any note's history — the copy starts with none.
- **Three budgets apply**: with a token, one token write (60 per 10 minutes); one write from the 30-writes-per-minute budget; and, when the copy will include images, one upload per image from the 120-per-10-minutes upload budget it shares with uploading images, counted before anything is copied.
- **Errors** `insufficient_scope` (`group_id` was passed and the credential doesn't have `notes:move`; this is checked before the note is looked up or any of the three budgets above is spent — after the folder, when there is a `folder_id` — so nothing is copied, and a `note_id` that doesn't exist answers the same), `not_found` (the note, or the folder), `invalid_body` (a `folder_id` that doesn't fit the call), `forbidden` (a group's folder, and your role there can't edit notes), `group_not_found`, `storage_quota_exceeded` (the target space has no room for the note's images — a copy without images is never refused for space; someone who can see that space's usage also gets `usedBytes` and `quotaBytes`, and `incomingBytes` when the server got as far as measuring the images), `too_many_requests` (any of the three budgets), `server_busy` (nothing was copied — try again in a moment).

### `list_trash`

**Takes** `cursor`, optional (opaque — the `nextCursor` from a previous call; omit it to start with the newest); like every tool, it rejects an argument it doesn't know. Every credential is offered it, a read-only one included.

**Answers** `retentionDays`, `items`, `truncated` and `nextCursor`, plus `pageCutShort: true` when the page was cut short.

- `items` are the notes in your trash: your own personal notes, and the notes of groups where your role can both edit and delete notes. A note you moved to the trash from a group where your role can delete notes but not edit them isn't listed — see [`delete_note`](#delete_note).
- They are newest first, by when they were moved to the trash, counted to the millisecond; notes moved there in the same millisecond come by id, descending — the same order as `GET /api/trash`. A call returns up to 100, fewer when they are large, and then carries `pageCutShort: true`. Pass `nextCursor` back as `cursor` for the next page, until it is `null`; that way you can page through the whole trash. `truncated` is `true` exactly when `nextCursor` isn't `null` — when more notes follow. The pages are read live, not from a snapshot (see [Known limitations](#known-limitations)).
- Each entry is `{id, title, titleTruncated?, deletedAt, purgeAt, deletedBy, group, folderPath, folderPathTruncated?}`. `title` is cut like every other title (see [Limits](#limits)). `deletedBy` is `{handle, displayName, displayNameTruncated?}` of whoever moved the note to the trash, with `displayName` cut the same way, or `null` when that account no longer exists. `group` is `{id, name, nameTruncated?}`, or `null` for a personal note.
- `folderPath` is where [`restore_note`](#restore_note) usually puts the note back: the folder names from the top level down, or `[]` for the top level. While the note's folder still exists, it is that folder's path as it is now, following renames and moves; once the folder has been deleted — by `delete_folder`, for example — it is the path the folder had then, and it no longer follows renames. When the note's group is deleted with its notes handed over to one of its admins, and a top-level folder named after the group is created for them (see [Sharing](./sharing.md#notes-in-a-group)), the note's path starts with that folder — one whose `folderPath` was `[]` then has just that folder as its path. A long path is cut from the top, with `folderPathTruncated: true` (see [Limits](#limits)).
- `retentionDays` is the site's current trash setting — how many days a note stays in the trash before it becomes due to be deleted permanently — or `null` when the site doesn't empty the trash on its own at the moment. `purgeAt` is `deletedAt` plus that many days, or `null`. Both follow the setting as it is now: a site admin can change it, including from not deleting automatically to a number of days, and that moves every note's date, possibly to one that has already passed. A note that is due is usually deleted within the next hour, by the server's clean-up pass (see [Trash](./self-hosting.md#trash)), and someone can delete it permanently sooner in the web app — from the trash, by emptying the trash, or by deleting its group with **Delete everything**.
- Notes in the trash don't appear in `list_notes` or `search_notes`, and every other tool that takes a `note_id` except `restore_note` answers `not_found` for one.

`list_trash` draws on none of the per-tool budgets in [Limits](#limits); a token request to `/api/mcp` still counts against the 300-reads-per-minute token budget, as every request does.

**Errors** `invalid_body` — the `cursor` is not one this server issued. Omit it and start over.

### `delete_note`

**Takes** `note_id`. It moves a note to the trash — what **Delete** in a note's `⋮` menu does in the web app. A token or app credential needs `notes:delete` for it; one without it isn't offered this tool at all.

**Answers** `id`, `title` (cut like every other title, with `titleTruncated: true` when it was) and `purgeAt` — when the note becomes due to be deleted permanently, as described under [`list_trash`](#list_trash), under the site's trash setting at the moment of the reply, or `null` when the site doesn't empty the trash on its own. A site admin can change that setting afterwards; for the notes you can restore, `list_trash` shows the current date.

- **Who can move a note to the trash:** the owner of a personal note, and, for a group note, a member whose role can delete notes. A note shared with you, even as an editor, and a group note your role can see but not delete answer `forbidden`.
- **What moving it does** is the same as in the web app: the note stops appearing in `list_notes` and `search_notes`, reading or editing it answers `not_found`, its per-person shares and public link stop working, and anyone who has it open is disconnected. Nothing is deleted: shares, the public link, versions, the AI edit history and attachments are kept (attachments keep counting toward storage), and `restore_note` brings them back with the note — unless the note's group is deleted, with its notes handed over to one of its admins, while the note is in the trash: that removes its public link and gives it a new owner and URL (see [`restore_note`](#restore_note)).
- **Bringing a group note back** needs a role that can both edit and delete notes. If your role can delete but not edit, you can move a group note to the trash, but then neither `list_trash` nor `restore_note` reaches it — a member whose role has both, such as an Admin, can restore it.
- **This tool deletes nothing permanently, but a note in the trash can still be deleted permanently.** No tool deletes a note permanently or empties the trash. A note in the trash is deleted permanently once it is due under the site's trash setting, when the site empties the trash on its own, or sooner if someone deletes it permanently in the web app.
- A note that is already in the trash answers `not_found`, the same as one that doesn't exist; `list_trash` shows the ones you can restore.
- Moving a note to the trash is not recorded in any note's history; `restore_note` is how to undo it.
- **Two budgets apply**: with a token, one token write (60 per 10 minutes), spent before the note is looked up; and one write from the 30-writes-per-minute budget, spent once the access check has passed and the site's trash setting has been read (if the setting can't be read, the call answers `internal` having spent only the token write). Once spent, they stay spent even when the call then fails without moving the note (see [Known limitations](#known-limitations)).
- **Errors** `not_found`, `forbidden`, `too_many_requests` (either budget), `server_busy` (a lock or serialization conflict; nothing was moved — try again in a moment).

### `restore_note`

**Takes** `note_id` — a note in the trash, as `list_trash` or the reply of `delete_note` or `delete_folder` gives it. It works on any note in your trash — your own personal notes, and the notes of groups where your role can both edit and delete notes — including notes `delete_folder` moved there. It is what **Restore** does in the web app. A token or app credential needs `notes:delete` for it; one without it isn't offered this tool at all.

**Answers** `note` — the note after it was restored, in the entry shape `list_notes` returns.

- The note appears in `list_notes` and `search_notes` again, and the per-person shares and public link it kept while in the trash work again.
- It usually goes back into the folder `list_trash` shows as its `folderPath`, the same as restoring it over the REST API: into the folder it was in or, if that folder has been deleted since — by `delete_folder`, say — into the folders on that path, found again by name or created again (see **Trash** in the [API reference](./api.md)). The reply's `folder` shows where it went.
- **A note whose group was deleted while it was in the trash** — with its notes handed over to one of the group's admins — comes back as that admin's personal note, so its `owner` and `url` are not what they were, and it has no public link any more.
- **Two budgets apply**, the same two as for `delete_note`: the token write before the note is looked up, and the 30-writes-per-minute one once the access check has passed.
- **Errors** `not_found` (no note with that id in a trash you can restore from: it may not exist, may not be in the trash, may have been deleted permanently, may be someone else's, may belong to a group you aren't in, or may be in the trash of a group where your role can't both edit and delete notes — all answer the same), `too_many_requests` (either budget), `server_busy` (a lock or serialization conflict; nothing was restored — try again in a moment).

### `list_folders`

**Takes** `group_id` and `cursor`, both optional. Every credential is offered it, a read-only one included, on every deployment.

**Answers** `folders` and `nextCursor`, which is `null` on the last page, plus `pageCutShort: true` if a page was cut short to keep the reply small.

- `folders` are the folders you can see: your personal folders, the folders of your groups where your role can read notes, and your folders for notes others shared with you, which only you can see. `group_id` lists only that group's folders.
- Up to 50 per call; pass `nextCursor` back as `cursor` for the next page. Folders come grouped by space and, within a space, by id — not in tree order and not by name; use `parentId` to put the tree together. The pages are read live, not from a snapshot, so a folder created while you page may not appear (see [Known limitations](#known-limitations)).
- Each entry is `{id, name, nameTruncated?, parentId, space, path, pathTruncated?}`. `parentId` is `null` for a top-level folder. `space` is `{kind: "personal"}`, `{kind: "shared"}` — your folders for notes others shared with you — or `{kind: "group", groupId, groupName, groupNameTruncated?}`. `path` is the folder names from the top level down, ending with the folder's own name. Names, group names and paths are cut as described in [Limits](#limits).
- A group whose notes your role can read is listed here, with its id as `space.groupId`, as soon as it has a folder — even when it has no notes yet, so that id can go to `create_note`'s `group_id`.
- The other folder tools take a folder by its `id` from here.

`list_folders` draws on none of the per-tool budgets in [Limits](#limits); a token request to `/api/mcp` still counts against the 300-reads-per-minute token budget, as every request does.

**Errors** `group_not_found` (a `group_id` that names a group you aren't in, one where your role can't read notes, or one that doesn't exist — all answer the same), `invalid_body` (the `cursor` is not one this server issued — omit it and start over).

### Writing folders: what the five tools share

`create_folder`, `rename_folder`, `move_folder`, `move_note_to_folder` and `delete_folder` work the same way as the sidebar's folders in the web app (see [Folders](./sharing.md#folders)), with the same role rules:

- **Your personal folders and your folders for notes shared with you** are yours alone, and only you can see them. **A group's folders** are seen by every member whose role can read the group's notes, names included; changing them — creating, renaming, moving, deleting them, and filing the group's notes in them — needs a role that can edit notes, and a member who can see them but whose role can't edit notes gets `forbidden`.
- A token or app credential needs `notes:write` for the first four and `notes:delete` for `delete_folder`; one without it isn't offered the tool.
- **Two budgets apply** to each call: with a token, one token write (60 per 10 minutes), spent before anything is looked up; and one write from the 30-writes-per-minute budget, spent once the checks before the change itself have passed — for `delete_folder`, one however many notes it moves to the trash. Once spent, they stay spent even when the call then fails without changing anything.
- `server_busy` means a lock or serialization conflict: nothing was changed — try again in a moment.
- None of them is recorded in a note's history; after `delete_folder`, `restore_note` is how to bring the notes back.

### `create_folder`

**Takes** `name`, and at most one of `parent_id`, `group_id` and `shared`: `parent_id` creates the folder inside one you can see; `group_id` at the top level of one of your groups' folders; `shared: true` at the top level of your folders for notes others shared with you; and none of them at the top level of your personal folders. `shared: false` counts as not passing it.

**Answers** `folder` — the new folder, in the entry shape `list_folders` returns.

- **Names.** Surrounding whitespace is removed, and what is left must be 1 to 80 characters, with no line breaks, tabs, or other control or text-direction characters, and nothing that can't be stored (a NUL or an unpaired surrogate). A name can't repeat the name of a folder already in the same place; names that differ only in letter case can count as the same, depending on the database (see [Known limitations](./known-limitations.md)).
- **Depth and number.** A new folder can be at most 5 levels deep, a top-level folder being level 1, and a space that already has 1000 folders or more can't get another. Handing a deleted group's notes to an admin, and restoring notes from the trash, aren't held to these limits, so a space can end up with deeper folders or more of them.
- **Errors** `invalid_body` (the name, or more than one of `parent_id`, `group_id` and `shared: true`), `not_found` (`parent_id`), `group_not_found` (`group_id`: a group you aren't in, one where your role can't read notes, and one that doesn't exist all answer the same), `forbidden`, `conflict` (the name is taken in that place, the folder would be too deep, or the space already has the most folders it can hold), `too_many_requests`, `server_busy`.

### `rename_folder`

**Takes** `folder_id` and `name`. It renames a folder you can see; nothing else changes — not where the folder is, not the notes in it, not any URL. The name follows the same rules as for `create_folder`.

**Answers** `folder`, in the entry shape `list_folders` returns.

**Errors** `invalid_body` (the name), `not_found`, `forbidden`, `conflict` (another folder in the same place has that name), `too_many_requests`, `server_busy`.

### `move_folder`

**Takes** `folder_id` and `parent_id` — a folder of the same space to move it into, or `null` for the top level of its space. The folder moves with everything in it; the notes stay in their folders, and who can see them and their URLs don't change.

**Answers** `folder`, in the entry shape `list_folders` returns.

- A folder can't move to another space — out of your personal folders, out of its group, or out of your folders for notes shared with you: that answers `invalid_body`. It can't move into itself or one of its subfolders, end up with itself or anything under it more than 5 levels deep, or land next to a folder with the same name: those answer `conflict`.
- **Errors** `not_found` (`folder_id` or `parent_id`), `invalid_body`, `forbidden`, `conflict`, `too_many_requests`, `server_busy`.

### `move_note_to_folder`

**Takes** `note_id` and `folder_id` — a folder from `list_folders`, or `null` for the top level of the note's space. It files the note there: what **Move to…** does in the web app when you pick a place in the space the note is in.

**Answers** `note` — the note, in the entry shape `list_notes` returns, with its `folder` showing where you filed it.

- **The folder must be in the note's own space:** one of your personal folders for a note of yours; one of the group's folders for a group note; or one of your folders for notes shared with you, for a note someone shared with you, as a viewer or an editor. A folder in any other space answers `invalid_body`. Filing a note someone shared with you is yours alone: its owner and anyone else it is shared with see nothing change, and never see your folders.
- Filing never changes who can see the note, its URL, its content or its `updatedAt`, so it doesn't move the note in `list_notes`' order. It never moves a personal note into a group — that is `move_note_to_group`, which needs `notes:move`.
- The note is checked before the folder: a note you can't see answers `not_found`, the same as one that doesn't exist, whatever the folder.
- **Errors** `not_found` (the note or the folder), `forbidden` (for example, a group note and your role in the group can't edit notes), `invalid_body`, `too_many_requests`, `server_busy`.

### `delete_folder`

**Takes** `folder_id`. It deletes that folder and every folder inside it — what deleting a folder, or removing one in **Shared with me**, does in the web app. A token or app credential needs `notes:delete` for it; one without it isn't offered this tool at all.

**Answers** `trashedNoteCount` (how many notes it moved to the trash), `trashedNoteIds` (the ids of up to 100 of them, in id order, with `trashedNoteIdsTruncated: true` when there were more), `deletedFolderCount` (how many folders were deleted, counting the one you named) and `purgeAt` — when the notes it moved to the trash become due to be deleted permanently, under the site's trash setting at the moment of the reply, as under [`delete_note`](#delete_note). `purgeAt` can be `null` — for example when no note was moved to the trash, or when the site doesn't empty the trash on its own; for the notes you can restore, `list_trash` shows the current date.

- **In your personal folders and a group's folders,** every note in them that isn't in the trash yet moves to the trash, each just as `delete_note` would move it, and all at once: if any of them is a note your role can't move to the trash, nothing is deleted and the answer is `forbidden`. In a group, that means deleting a folder needs a role that can edit notes, and one that can also delete notes when notes in it would move to the trash. Notes already in the trash from those folders stay there.
- **In your folders for notes shared with you,** only the folders go: the notes in them stay shared with you, at the top level, and nothing moves to the trash.
- **Folders don't go to the trash.** `restore_note` usually puts a note back into a folder at the path it had, re-creating the folders on that path — `list_trash` shows that path as `folderPath` — but folders that held no notes don't come back.
- **Errors** `not_found`, `forbidden`, `conflict` (something changed while the folder was being deleted — a note was put into one of the folders, for example; nothing was deleted — try again), `too_many_requests`, `server_busy`.

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

**Writing does not require reading first.** `if_match` is a concurrency check: it refuses a write built on a stale read. It is not a record of what this agent has read, and an `append` sent without `if_match` skips the check by design. What actually bounds an agent is the credential's scope, the sharing on each note (for a group note, your role in its group), and the fact that most writes that put content into a note are recorded in that note's **AI edit history**, where such a write can be undone — while it is still one of the note's 100 most recent recorded writes and nothing has changed those blocks since. A `create_note` with no `content` records nothing, so there is nothing to undo; what keeps a recorded write undoable, and what takes that away, is in [AI editing](./ai-editing.md#revert). Some writes aren't in that history, for example a `rename` (rename it back instead), `move_note_to_group` (a single note can't be moved back out, and the shares, public link and version history it loses don't come back), `copy_note` (the copy starts with no history) and `delete_note` (`restore_note` brings the note back, while it is still in the trash and only for someone who can restore it).

## Limits

| Limit | Value | Applies to | What you get |
|---|---|---|---|
| Heading, title and group name length, and the display name of whoever moved a note to the trash | 200 characters as written in JSON: `"`, `\` and the control characters JSON writes as `\n`, `\t`, `\r`, `\b`, `\f` count as two each, every other control character (U+0000–U+001F) and an unpaired surrogate as six | every tool that returns one; the display name, `list_trash` | cut, with `headingTruncated` / `titleTruncated` / `nameTruncated` / `groupNameTruncated` (`list_folders`) / `displayNameTruncated: true` |
| Folder name length | 80 characters as written in JSON, counted as in the first row | a note's `folder.name`, the `name` of each folder in `list_folders`, and every name in a folder path | cut, with `nameTruncated: true`; a name cut inside a path only sets the path's flag (next row) |
| Folder path length | every name in it cut as in the row above, and the whole path at most 400 characters as written in JSON, counting the quotes around each name and the commas between them | `path` in `list_folders` and in `read_note_outline`'s `folder`, `folderPath` in `list_trash` | names are left out from the top level down until it fits, always keeping at least the last one; `pathTruncated: true` (`folderPathTruncated: true` in `list_trash`) when any name was cut or left out — there is no flag for each name |
| Snippet length | 160 characters as written in JSON, counted as in the first row | `search_notes` | cut, with `…` |
| Matches per note | 3 | `search_notes` | the rest aren't listed |
| Sections per page | 100 | `read_note_outline`, and `edit_note`'s reply | `truncated: true` (plus `nextSectionOffset` on `read_note_outline`) |
| Notes per `list_notes` call | `limit` (at most 100), fewer when the notes are large | `list_notes` | `pageCutShort: true` when the page was cut short; page on with `nextCursor` |
| Notes per `list_trash` call | 100, newest first, fewer when the notes are large | `list_trash` | `truncated: true` and a `nextCursor` while more follow, `pageCutShort: true` when the page was cut short |
| Folders per `list_folders` call | 50 | `list_folders` | a `nextCursor` while more follow |
| Note ids in `delete_folder`'s reply | 100, in id order | `delete_folder` | `trashedNoteIdsTruncated: true`; `trashedNoteCount` still counts them all |
| Blocks after parsing | 2000, counting nested blocks | `edit_note`, `create_note` with `content` | tool error `too_many_blocks` |
| Content reads | 120 per minute per user | `read_note_outline`, `read_note_section`, `read_note_image`, `create_transfer_token` with `download` | tool error `too_many_requests` |
| Searches | 60 per minute per user | `search_notes` | tool error `too_many_requests` |
| Writes | 30 per minute per user | `edit_note` (except `rename`), `create_note` **with `content`**, `copy_note`, `delete_note`, `restore_note`, `create_folder`, `rename_folder`, `move_folder`, `move_note_to_folder`, `delete_folder` | tool error `too_many_requests` |
| Uploads | 120 files per 10 minutes per user | `copy_note` (one per attached image the copy will include, counted before copying), shared with uploads | tool error `too_many_requests` |
| Token writes | 60 per 10 minutes per user | `edit_note`, `create_note` **with or without `content`**, `move_note_to_group`, `copy_note` (except one refused for its `folder_id` or for lack of `notes:move`, which spends nothing), `delete_note`, `restore_note`, `create_folder`, `rename_folder`, `move_folder`, `move_note_to_folder`, `delete_folder`, and `create_transfer_token` with `upload`, made with a token | tool error `too_many_requests` |
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

- Errors Knotebook produces carry `structuredContent: {code, message, …}`. `code` comes from the same vocabulary the REST API uses: `unauthorized`, `insufficient_scope`, `not_found`, `group_not_found`, `section_not_found`, `forbidden`, `conflict`, `invalid_body`, `fingerprint_mismatch`, `unsupported_block`, `unsupported_color`, `unsupported_columns`, `unsupported_size`, `empty_content`, `empty_section`, `too_many_blocks`, `too_many_requests`, `server_busy`, `storage_quota_exceeded`, `file_too_large`, `internal`. `internal` is not tied to any one tool: every tool handler shares the same catch-all for an unexpected exception, so any of them can answer it, not only `create_note`, whose own reference is the only place that spells out a cause.
- Errors the MCP SDK produces — an unknown tool name, arguments that do not match a tool's input schema, a reply that does not match its output schema, or an unhandled failure — carry **no `code` and no `structuredContent`**, only a text message. **Do not write a client that reads `code` without checking it is there.**

One check the SDK makes sits outside the tool altogether: a reply that doesn't match the protocol's `CallToolResult` shape reaches the client as a JSON-RPC error rather than a tool result. Knotebook's replies always match it; it is listed so that a client knows the shape exists.

## Known limitations

These are the MCP-specific entries in the shared [Known limitations](./known-limitations.md) list. The ones that bite an assistant first are the four about paging through live data rather than a snapshot — `list_notes`, `read_note_outline`, `read_note_section`, and `list_trash` with `list_folders`.

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
- [`list_trash` and `list_folders` page through live data, not a snapshot](./known-limitations.md)
- [`edit_note`'s reply carries fingerprints only for the page its change landed on](./known-limitations.md)
- [Body-text search can lag the editors by a few seconds](./known-limitations.md)
- [Only about the first million characters and the first 2000 sections of a note are searchable](./known-limitations.md)
- [Right after an upgrade, older notes can be found by title only until the server has indexed them](./known-limitations.md)
- [An assistant tricked by a prompt injection can send your notes' images off-site](./known-limitations.md)
- [An assistant tricked by a prompt injection can move your personal notes into a group, or copy notes into one](./known-limitations.md)
- [An assistant tricked by a prompt injection can move your notes to the trash](./known-limitations.md)
- [An assistant tricked by a prompt injection can delete your folders, or rearrange them](./known-limitations.md)
- [Someone whose role can delete notes but not edit them can't get back a note they deleted](./known-limitations.md)
- [The date a note in the trash is due to be deleted can change](./known-limitations.md)
- [`delete_note` and `restore_note` can use up their budgets without changing anything](./known-limitations.md)
- [`read_note_image` shows an image only if you can read the note it was uploaded to](./known-limitations.md)
- [An image uploaded but never written into a note is still an attachment](./known-limitations.md)
- [The `curl` command `create_transfer_token` returns is built from `PUBLIC_URL`](./known-limitations.md)
- [On a plain-http `PUBLIC_URL` (for example a LAN deployment), transfer tokens cross the network unencrypted](./known-limitations.md)
- [An MCP connection made with the browser's sign-in session has no `create_transfer_token`](./known-limitations.md)
- [Only the editor's ten built-in colors can be written, and a list or table with block or cell colors reads back as HTML as a whole](./known-limitations.md)
- [Some image widths don't travel over the API and MCP, and sizes not written in the form reading gives are refused](./known-limitations.md)
- [A pasted row keeps all of its columns, even more than four](./known-limitations.md)

## See also

[API tokens](./api-tokens.md) · [AI editing](./ai-editing.md) · [API contract summary](./api.md) · [Known limitations](./known-limitations.md)
