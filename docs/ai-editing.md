# AI editing

An API token — or an App you authorized over OAuth — can **write** a note's content, not just read it: replace the whole note, replace or delete one section, insert after one section, or append to the end. Every write is recorded and can be reverted.

This page is the reference for that surface. The endpoints also accept an ordinary browser session (either credential works); writing needs the `notes:write` scope, reading needs `notes:read`. See [API tokens](./api-tokens.md) for how a program gets a credential, and the [API contract summary](./api.md) for these endpoints alongside the rest of the API.

Every write goes through the same real-time document the browser edits, so a change made through the API appears immediately in every open tab of that note — there is no separate "API copy" of the content.

## Endpoints

| Endpoint | Method | Scope | What it does |
|---|---|---|---|
| `/api/notes/:id/content` | GET | `notes:read` | Read the note as Markdown, with an outline and the fingerprints a write needs. `?section=<id>` returns one section only. Side-effect free — the note itself never changes; a token-authenticated read does make the AI's cursor appear, though (see [Presence](#presence)). |
| `/api/notes/:id/edits` | POST | `notes:write` | Apply one of the five operations. `201 {editId, fingerprint, outline, unboundWikilinks}`. |
| `/api/notes/:id/edits` | GET | `notes:read` | List this note's recorded edits, newest first, and whether each can still be reverted. |
| `/api/notes/:id/edits/:editId/revert` | POST | `notes:write` | Undo one recorded edit. `201 {editId, fingerprint, outline}`. |
| `/api/notes` | POST | `notes:write` | Create a note; an optional `content` field writes its initial Markdown in the same request. `201` is an ordinary note object — unlike `POST …/edits`, it does not carry `unboundWikilinks`, even though wikilinks in `content` are bound the same way. |

`:id` is always a note **uuid** here — the slug forms (`/n/<username>/<slug>`) are not accepted by these endpoints. A note you cannot read at all answers `404 not_found` (the same body whether it does not exist or is not shared with you); on the two writing endpoints, a note you can read but only as a viewer answers `403 forbidden`.

The normal loop is: `GET …/content` → pick a section from `outline` → `POST …/edits` with that section's `fingerprint` as `if_match`. The `201` already carries the new whole-note `fingerprint` and `outline`, so a program making several edits in a row does not have to re-read between them.

```sh
# read
curl -H "Authorization: Bearer knb_…" \
     "https://<your-host>/api/notes/<id>/content"

# write one section back
curl -X POST -H "Authorization: Bearer knb_…" -H "Content-Type: application/json" \
     -d '{"op":"replace_section","section_id":"<block id>","markdown":"# Summary\n\nRewritten.\n","if_match":"<that section fingerprint>"}' \
     "https://<your-host>/api/notes/<id>/edits"
```

## Structure and addressing

A note is a list of **top-level blocks**. Sections are derived from those blocks and nothing else:

- The first section is always `_top`. It holds every block before the first heading, its `level` is `0` and its `heading` is `""`. On a note that starts with a heading, `_top` exists but has **zero blocks**; on a note that has never been written to at all, `_top` is the only section and the note has no blocks.
- Every other section starts at a heading block, and its `sectionId` **is that heading block's id**. The section runs to the next heading that opens a section.
- A *deeper* heading does not open a new section. In `# A` followed by `## B`, the `## B` heading and everything under it belong to section `A` — there is no section `B`. A section is only opened by a heading at the same level or shallower than the current one.
- Nested content (list items' children, blocks inside a block) is part of its top-level parent's block, not a section of its own.

So section ids are **block ids, not names**. Any operation that replaces or removes a section's heading gives that section a different id, or removes it — including your own `replace_section`. Do not cache a `section_id` across writes; take the fresh `outline` that every successful write returns.

`_top` is the exception: it is a fixed string, and it is always present in the outline.

## Fingerprints and 409

Each outline entry carries a `fingerprint`, and the whole note has one. A fingerprint is 16 hexadecimal characters — a truncated SHA-256 over a canonical serialization of the blocks, with block ids deliberately excluded. It changes when the blocks' content or order changes.

Send back the one you read as `if_match`, and the server refuses the write if it no longer matches: `409 fingerprint_mismatch`, with the note's current content in a `current` field of the error body (the same shape `GET …/content` returns), so a program can rebase and retry without a second request.

**A fingerprint is a concurrency check, not a security boundary.** It says nothing about who made a change, and anyone who can write the note can produce a matching one. It exists so that a write based on a stale read is refused rather than silently overwriting what somebody typed in the meantime.

The comparison happens twice: once against the copy the request read, and once **on the live document, inside the same synchronous transaction that applies the change**. For a target section that has blocks, the window between reading and merging is therefore theoretically zero.

Three cases have no such protection, because a zero-block section's fingerprint is a constant and always compares equal:

- `replace_section` or `insert_after` targeting a `_top` that has zero blocks (the note starts with a heading);
- any operation on a **vacuum document** — a note with no top-level blocks at all;
- `append` sent **without** `if_match`, which skips the comparison by design.

In those cases nothing is lost: content the browser inserted during the window is kept, as is yours. What is not guaranteed is their **relative order** — that is decided by the collaborative document, not by the order the requests arrived in.

### A losing concurrent write is not always a 409

Two writes to the same note are serialised (see `server_busy` under [Limits](#limits)), so one of them is always working against the other's result. Which error it gets depends on the operation:

| Operation | What the loser gets |
|---|---|
| `replace_all`, `append` | `409 fingerprint_mismatch` (the whole-note fingerprint moved) |
| `insert_after` | `409 fingerprint_mismatch` (the heading survives, the section's blocks changed) |
| `replace_section`, `delete_section` on a heading section | **`404 section_not_found`** |
| `replace_section`, `delete_section` on `_top` | `409 fingerprint_mismatch` |

`replace_section` and `delete_section` replace or remove the section's heading, and the heading's block id *is* the section id — so by the time the second request runs, the id it addressed does not exist any more, and addressing fails before the fingerprint is ever compared. `_top` is the exception only because its id is a fixed string.

**Handle both codes.** The recovery is identical: re-read the outline (or the `current` body a 409 already gave you), decide again against what is there now, and retry. A `404 section_not_found` on these endpoints never means "the note is gone" — that is `404 not_found`.

## The five operations

| `op` | `section_id` | `markdown` | `if_match` | What it does |
|---|---|---|---|---|
| `replace_all` | not accepted | required | required — whole note | Replaces the entire note. Every block id changes. |
| `replace_section` | required | required | required — that section | Replaces the section **including its heading**. |
| `insert_after` | required | required | required — that section | Inserts after the section's last top-level block. |
| `append` | not accepted | required | optional — whole note | Adds to the end of the note. |
| `delete_section` | required | not accepted | required — that section | Removes the section and its heading. |

A request is exactly **one** merge into the live document: all of it lands, or none of it does. There is no per-block animation and no partial application — readers watching the note see the change appear in one step.

Empty-shaped notes behave like this:

| | `_top` with zero blocks (note starts with a heading) | Vacuum document (no top-level blocks at all) |
|---|---|---|
| `replace_section` on `_top` | Inserted **before the first heading** | Behaves as `replace_all` |
| `insert_after` on `_top` | Inserted **before the first heading** | Behaves as `replace_all` |
| `append` | Appended at the end, as usual | Behaves as `replace_all` |
| `delete_section` on `_top` | `400 empty_section` | `400 empty_section` |
| `replace_all` | Replaces everything, as usual | Writes the content |

The top-level block list is **never empty**. If an operation (or a revert) would leave the note with no blocks, the server finishes with a single empty paragraph. That paragraph's id does not count toward what the edit wrote or replaced, so it plays no part in fingerprint comparisons — but if the operation was a `delete_section` that emptied the whole note, this paragraph becomes that edit's **anchor**, and whether it is still there decides whether the deletion can still be reverted (see [Revert](#revert)).

### `replace_section` without a heading dissolves the section

`replace_section` replaces the heading too. If the Markdown you send does not start with a heading of the same level, that section stops existing: its `section_id` disappears from the outline and its content is absorbed into the **preceding** section. That is not an error — it is the direct consequence of "the heading is part of the section".

If you meant to keep the section, restate its heading as the first line of the Markdown you send, **at the same level** (`# Summary`, not `## Summary` — a deeper heading is absorbed by the section above it, as described in [Structure and addressing](#structure-and-addressing)). The section's id changes anyway, because the heading block is a new block.

## Revert

`GET /api/notes/:id/edits` lists what has been written through the API, newest first:

```json
{ "edits": [ { "id": "…", "op": "replace_section", "sectionId": "…", "heading": "Summary",
               "byHandle": "alice", "agentLabel": "claude", "createdAt": "…",
               "revertedAt": null, "revertOf": null, "revertable": true } ] }
```

- `op` is one of the five, or `revert` for a row produced by reverting something. `revertOf` points at the row a revert undid.
- `heading` is looked up in the note **as it is now**, so it follows renames and becomes `""` once the section is gone.
- `byHandle` is the username of whoever made the request. `agentLabel` is set only when the write came through a token or an authorized App; a write made with a session cookie leaves it `null`. It follows the credential's current name while the credential exists — unless you have renamed it in Settings, in which case the name you picked wins (see [Agent display name](#agent-display-name)) — and falls back to the label recorded at the time once it has been revoked.
- `revertable` says whether `POST …/:editId/revert` would be accepted right now. Reverting is a normal write: it needs `notes:write`, it produces its own row (which can never itself be reverted), and it appears live in open tabs like any other change.

A revert is refused with `409 already_reverted` (already undone, or the row is itself a revert), `409 stale` (the note has moved on — the body carries the current content in `current`), or `404 not_found` (no such row, or it belongs to another note).

**How "stale" is decided** differs by operation, and this is the part worth knowing:

- For `replace_all`, `replace_section`, `insert_after` and `append`, the server compares a fingerprint over exactly the blocks that edit wrote. Touch or delete any of them and the edit stops being revertable.
- **`delete_section` has no such fingerprint** — the blocks it wrote are the ones it removed. It is judged by an **anchor**: the neighbouring top-level block the section is put back next to. So a `delete_section` stays revertable even when the text *around* the anchor has been rewritten in the meantime; only the anchor block disappearing (or the deletion having already been undone) takes it away. Restoring it can therefore drop a section back into a paragraph that no longer reads the way it did.

**If the record fails to be written**, the content has already changed. Content is merged first and recorded afterwards, on purpose (a database transaction is never held across the merge), so a failure in between answers `500` with the content already applied and no row recorded. There are two shapes of this, and they differ:

- For a **write**, the content is in the note and no row exists — so it cannot be reverted through the API, and a retry is refused by `if_match` rather than duplicating the edit.
- For a **revert**, the content is already restored, but no revert row was written and the original row was not marked. **That row becomes non-revertable**, and pressing revert again answers `409 stale`. The two operation families reach that state differently: for the four non-`delete_section` ops the fingerprint check does it automatically (the restore replaced exactly the blocks it compares), while `delete_section` — which has no fingerprint and whose anchor survives a restore — is caught by a separate idempotency rule: an edit whose `before_blocks` are back at the top level counts as already restored. Without that rule a retry would insert the same blocks a second time, leaving two top-level blocks with the same id.

Neither shape is recoverable by retrying; both are consequences of merging before recording.

**Retention is "at most 100", not "the last 100".** Each note keeps its most recent 100 rows and the trim runs inside the same transaction that inserts a new one. Because a revert row is tied to the row it undid (deleting the original deletes the revert), two things follow: reverting the *oldest* remaining edit pushes that pair out of the window together (101 rows, revert the oldest, 99 remain), and an ordinary write's trim can also take out a revert row that is still well inside the window, if the row being trimmed happens to be that revert's original. A revert row's lifetime is bounded by its original's.

## Limits

| Limit | Value | Applies to | Exceeding it |
|---|---|---|---|
| Request body | 262 144 bytes | `POST /api/notes/:id/edits`, `POST /api/mcp` | `413 content_too_large` |
| `markdown` / `content` length | 262 144 UTF-16 code units | `POST …/edits`, `POST /api/notes` | `400 invalid_body` |
| Blocks after parsing | 2000, counting nested blocks | `POST …/edits`, `POST /api/notes` | `400 too_many_blocks` |
| Writes | 30 per minute per user | `POST …/edits`, `POST …/revert`, `POST /api/notes` with `content` | `429 too_many_requests` |
| Content reads | 120 per minute per user | `GET …/content`, `GET …/edits` | `429 too_many_requests` |
| Token calls | 300 reads/min and 60 writes/10 min per user | every request made with a token or App credential, on top of the two rows above | `429 too_many_requests` |
| Concurrent writes to one note | serialised, 10 s wait | `POST …/edits`, `POST …/revert` | `503 server_busy` |
| Recorded edits kept | at most 100 per note | `GET …/edits` | oldest rows are deleted |
| Wikilink targets indexed | 1000 per note | every write | extra targets are dropped from the index, the write still succeeds |

A `POST /api/mcp` counts as **one** read call against the "Token calls" row no matter how many tools it invokes, and **each** `edit_note` or `create_note` call inside it counts as one write call — including a `create_note` without `content` (#108). For how MCP answers once one of these budgets runs out, see [API tokens](./api-tokens.md#errors-and-rate-limits).

`POST /api/notes` (with or without `content`) uses the server's ordinary 1 MiB body limit rather than the 262 144-byte one — the `content` field's own length limit is what bounds it, and a request over the body limit there is still `413 content_too_large`. It shares the same per-note write queue, but it does not answer `503`: if applying the content fails for any reason, including waiting too long for the queue, the note row it just created is removed again and the answer is `500 internal`.

Note that `server_busy` is a `503` on these endpoints. The same code is a `409` on `POST /api/notes/:id/links`, where it means a write conflict rather than a queue timeout.

## Markdown round-trip

Content crosses the API as Markdown, and the round-trip is deliberately lossy in two places that the server repairs on the way in:

- **Wikilinks.** A `[[Title]]` in the Markdown you send is bound to a note when **exactly one** note you can see has that title. Zero matches or several, and it stays literal text; `unboundWikilinks` in the `POST …/edits` response's `201` counts how many stayed literal in that write. Reading gives back `[[Title]]` — the target's id is not in the Markdown — so a read-modify-write can re-bind a link to a *different* note if titles changed or a second note with the same title appeared in between. Check `unboundWikilinks` if that matters to you.
- **Diagrams.** A ```` ```mermaid ```` fenced block is restored to a real [diagram](./diagrams.md) block, with its source preserved exactly. Reading a diagram gives the fence back.

Two more properties of the Markdown:

- Only block types this note can store are accepted. Anything else is rejected whole, with `400 unsupported_block` — nothing is silently stripped.
- Non-empty Markdown always ends with a trailing newline. A note that has never been opened or written to returns `markdown: ""`; one that has been reduced back to empty returns `"\n"`. Both report `chars: 0`, so test emptiness with `chars` or the fingerprint, not by comparing the string to `""`.

## Presence

While a program works on a note, it shows up **in the note** — as a remote cursor, the same one another person editing gets.

- The cursor is labelled `username (agent)`: your username, and the credential's [agent display name](#agent-display-name).
- It exists only for a note **somebody currently has open**. Presence is attached to the live collaborative document, so if no browser is connected to that note, nothing is created and nothing is broadcast — and there is no record afterwards that a program was there.
- It appears, and moves, on a **token-authenticated** `GET …/content`, `POST …/edits` and `POST …/edits/:editId/revert` — and on the MCP read tools that go through the same code path (`read_note_outline`, `read_note_section`), and on `edit_note`, so an assistant that only *reads* a note still shows up in it. `GET …/edits` deliberately does not: reading the history is not working on the note. `POST /api/notes` with `content` cannot — the note is created by that same request, so nobody can have it open yet.
- **A request authenticated with a session cookie never creates one**, neither reading nor writing. Editing your own note in your own browser therefore does not sprout a second, AI-looking cursor beside your real one.
- It is removed after **2 minutes** with no read or write. A server restart does not broadcast a separate removal for it: by the time that shutdown step runs, every collaborative connection — including this one — has already been torn down, so there is nothing left to notify.

Where the cursor lands:

| What the program did | Where the cursor goes |
|---|---|
| `GET …/content` (whole note) | The start of the note |
| `GET …/content?section=<id>` | That section's first block (the start of the note if that section has no blocks) |
| `replace_section`, `insert_after`, `append` | The first block that write produced |
| `replace_all` | The start of the note |
| `delete_section` | The start of the note — the section it addressed no longer exists |
| a revert | The start of the note |

If somebody has moved that block away in the meantime, the cursor falls back to the start of the note rather than failing.

**The name tag is not permanently on screen.** The cursor stays for as long as the presence does, but the name beside it is shown for about **2 seconds** after each thing the program does — and after each 10-second keep-alive — then collapses back to a bare caret. Hovering the cursor brings the name back. This is how the editor treats every collaborator, human or not: there is no special case for API writers, and the editor option that would pin labels open is the same one that switches off the mechanism lighting them at all, so it is deliberately not used.

At most 500 of these exist at once across the server; when one more appears, the least recently active is dropped. A cursor is only drawn if the block it points at contains text — see [Known limitations](./known-limitations.md).

## Last edited

`GET /api/notes/:id/content` and every note object (`GET /api/notes`, `GET /api/notes/:ref`, …) carry `lastEdited`:

```json
{ "at": "2026-09-06T…Z", "byHandle": "alice", "agentLabel": "claude" }
```

It is `null` on a note nobody has edited since this feature landed. `byHandle` is the **editor's** username, not the owner's (it is `""` if that account has since been deleted). `agentLabel` is non-`null` **only** when that write came through a token or an authorized App; a write made with a session cookie, and anything typed in the browser, leaves it `null`. It is the credential's agent name **as it stood at the moment of that write** — derived from the credential's name (`Claude Code (knotebook)` → `claude`) unless you have renamed it in Settings, in which case the name you picked wins (see [Agent display name](#agent-display-name)). Being a snapshot, it does not move when you rename afterwards; only the next write refreshes it. The edit history above resolves the name live instead.

One approximation is worth knowing: the browser persists a burst of typing once, a couple of seconds after it stops. If an API write lands inside such a burst, its own save flushes those pending human edits too, and the whole batch is attributed to the API write. **No content is lost** — only the attribution is coarse.

## Agent display name

Every credential has a short **agent name**. It is the `(agent)` half of the cursor's label, of the title bar's last-edited line, and of every row in the note's edit history.

By default it is derived from the credential's own name: the first whitespace-separated word, Unicode-normalized, lowercased, with everything outside `A-Za-z0-9._-` removed, cut to 32 characters. `Claude Code (knotebook)` becomes `claude`, `MCP CLI Proxy` becomes `mcp`, and a name that leaves nothing usable behind becomes `agent`.

To change it: **Settings → Account → API tokens → Rename agent** next to the credential, or `PATCH /api/auth/tokens/:id` with `{"agentLabel": "researcher"}`. Like the rest of `/api/auth/tokens`, that endpoint is **session-cookie only** — a token cannot rename itself, or anything else. Sending `{"agentLabel": null}` clears your override and goes back to the derived value; the response, and `GET /api/auth/tokens`, always report the name actually in effect, so `agentLabel` there is never `null`.

A name must match `^[A-Za-z0-9._-]{1,32}$`; anything else is `400 invalid_body`. Renames are limited to 60 per 10 minutes per user.

Two things worth knowing:

- **Re-authorizing an OAuth app keeps the name you chose — but only when the app comes back with the same registration.** The replacement credential inherits the label from the credential it replaces, and the one it replaces is found by the app's `client_id`. An app that has re-registered (its old registration expired, or its cached one was cleared — see [API tokens](./api-tokens.md#troubleshooting)) arrives with a **new** `client_id`, so there is nothing for it to inherit from and it starts again from the derived default.
- The **edit history** resolves the name live, so renaming changes what its existing rows show (until the credential is revoked, after which they fall back to the label recorded at the time). The **last-edited line** does not: it is a snapshot taken when that write happened — see [Last edited](#last-edited).

## Troubleshooting

- **`409 fingerprint_mismatch` right after a read.** Somebody (a person in the browser, or another program) changed the note between your read and your write. The error body's `current` is the note as it is now — rebase on that and retry. If it keeps happening on a note being actively typed in, target a narrower section, or use `append` without `if_match` if position does not matter.
- **`404 section_not_found` on a section that was there a moment ago.** Its heading was replaced or removed — by a person, or by your own previous `replace_section`/`delete_section`. Section ids are block ids ([Structure and addressing](#structure-and-addressing)). Re-read the outline; do not retry with the old id.
- **`503 server_busy`.** Another write to the same note held the queue for longer than 10 seconds. Nothing was applied and nothing was recorded. Retry.
- **`400 empty_section`.** `delete_section` was pointed at a section with no blocks — usually `_top` on a note that starts with a heading, or a note with no content at all.
- **`400 empty_content`.** The Markdown parsed to nothing (it was blank or only whitespace). To empty a section, delete it; to empty a note, `replace_all` still needs something to write.
- **`429 too_many_requests`.** See [Limits](#limits). A token pays both its own bucket and the per-user one for these endpoints, so the tighter of the two is what you actually get.
- **The write succeeded but a wikilink is missing from the target note's backlinks.** The link index can lag briefly; it catches up the next time that note's link set changes or a browser reconnects to it. See [Known limitations](./known-limitations.md).

See also: [API tokens](./api-tokens.md) · [API contract summary](./api.md) · [Known limitations](./known-limitations.md).
