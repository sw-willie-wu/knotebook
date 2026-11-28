# AI editing

An API token — or an App you authorized over OAuth — can **write** a note's content, not just read it: replace the whole note, replace or delete one section, insert after one section, or append to the end. A write is recorded in the note's edit history, where it can usually be reverted — see [Revert](#revert) for what takes that away.

This page is the reference for that surface. The endpoints also accept an ordinary browser session (either credential works); writing needs the `notes:write` scope, reading needs `notes:read`. See [API tokens](./api-tokens.md) for how a program gets a credential, and the [API contract summary](./api.md) for these endpoints alongside the rest of the API.

Every write goes through the same real-time document the browser edits, so a change made through the API appears immediately in every open tab of that note — there is no separate "API copy" of the content.

## Endpoints

| Endpoint | Method | Scope | What it does |
|---|---|---|---|
| `/api/notes/:id/content` | GET | `notes:read` | Read the note as Markdown, with an outline and the fingerprints a write needs. `?section=<id>` returns one section only. Side-effect free — the note itself never changes; a token-authenticated read does make the AI's cursor appear, though (see [Presence](#presence)). |
| `/api/notes/:id/edits` | POST | `notes:write` | Apply one of the five operations. `201 {editId, fingerprint, outline, unboundWikilinks}`, plus `knowledge` when the write did something to [knowledge info](#knowledge-info). |
| `/api/notes/:id/edits` | GET | `notes:read` | List this note's recorded edits, newest first, and whether each can still be reverted. |
| `/api/notes/:id/edits/:editId/revert` | POST | `notes:write` | Undo one recorded edit. `201 {editId, fingerprint, outline}`. |
| `/api/notes` | POST | `notes:write` | Create a note; an optional `content` field writes its initial Markdown in the same request. `201` is an ordinary note object — unlike `POST …/edits`, it does not carry `unboundWikilinks`, even though wikilinks in `content` are bound the same way. |

`:id` is always a note **uuid** here — the slug forms (`/n/<username>/<slug>`, and `/g/<group id>/<slug>` for a group note) are not accepted by these endpoints. A note you cannot read at all answers `404 not_found` (the same body whether it does not exist, is not shared with you, or belongs to a group you aren't in); on the two writing endpoints, a note you can read but only as a viewer answers `403 forbidden`.

The normal loop is: `GET …/content` → pick a section from `outline` → `POST …/edits` with that section's `fingerprint` as `if_match`. The `201` already carries the new whole-note `fingerprint` and `outline`, so a program making several edits in a row does not have to re-read between them. Over MCP the loop is different — there is no whole-note read there, and an outline carries no content fingerprints — see [MCP](./mcp.md#the-read-write-loop).

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

So section ids are **block ids, not names**. An operation that removes a section's heading, or replaces it with a block that doesn't keep its id (see [Which blocks keep their ids](#which-blocks-keep-their-ids)), gives that section a different id or removes it — including your own `replace_section`. Do not cache a `section_id` across writes; take the fresh `outline` that every successful write returns.

`_top` is the exception: it is a fixed string, and it is always present in the outline.

### Which blocks keep their ids

`replace_section` and `replace_all`, and the places a file sent back changes (see [Sending a file back](#sending-a-file-back)), don't give every block they write a new id. The blocks that were there and the blocks that replace them are compared, and a new block takes over an old block's id when:

1. **It has the same type and the same text as an old block**, and the blocks that match this way stay in the order they had.
2. **It is the one edited block** of the same type between two blocks that matched by rule 1, or between one end of the replaced range and the nearest block that matched: exactly one old block and exactly one new block lie in that stretch. This also covers a range in which nothing matched but one old and one new block of the same type.

Everything else gets a new id: a block that is split or merged, one whose type changed, a larger reorder, and two or more edited blocks next to each other (a stretch with more than one old or more than one new block in it).

- **Text is compared, not formatting.** Bold or italic, colors, a heading's level and other block attributes don't count. A link is compared by its text and a link to a note by its label (when it has one). A table is compared by the text of its cells. A block with no inline text (a divider, an image) is compared by its attributes.
- **Nested blocks** (list children, blocks inside columns) keep their ids only under an outer block that matched by rule 1, which also needs everything nested in it to be the same. Under an edited block (rule 2) they get new ids.
- **A very large rewrite** isn't compared in the middle: when (changed old blocks + 1) × (changed new blocks + 1) is over 1,000,000, roughly a thousand blocks on each side, only the unchanged blocks at the start and at the end of the range keep their ids.
- **Keeping an id is not keeping the block.** The block is still a new element in the note, so somebody typing inside a block that is being rewritten still has their cursor moved.
- **Other ways of replacing blocks aren't covered.** Applying a version to the note gives every block a new id, and so does the in-app AI when it replaces a selection in the editor.
- **A person can bring an old block back.** If someone drags a block that was rewritten, or restores it with undo, after the rewrite was merged (in a tab that was offline, for example), the note can hold two blocks with one id; the editor then gives both new ids, so a link to that id stops working, but never leads to another block.

A `section_id` can therefore survive a write, but isn't guaranteed to: use the `outline` the last write returned.

## Fingerprints and 409

Each outline entry carries a `fingerprint`, and the whole note has one. A fingerprint is 16 hexadecimal characters — a truncated SHA-256 over a canonical serialization of the blocks, with block ids deliberately excluded. It changes when the blocks' content or order changes.

Send back the one you read as `if_match`, and the server refuses the write if it no longer matches: `409 fingerprint_mismatch`, with the note's current content in a `current` field of the error body (the same shape `GET …/content` returns), so a program can rebase and retry without a second request.

**A fingerprint is a concurrency check, not a security boundary.** It says nothing about who made a change, and anyone who can write the note can produce a matching one. It exists so that a write based on a stale read is refused rather than silently overwriting what somebody typed in the meantime.

The server works the write out in a parse worker against the note as it is at that moment — comparing `if_match` there — and then puts the result into the live document, inside one synchronous transaction. If someone changed the note while the write was being worked out, what happens depends on what they changed:

- **A part of the note the write doesn't depend on** — anything outside the section its `if_match` names, or anything at all for a write without `if_match` — the write goes in anyway and is merged with their change by the collaborative document: both are kept. The `fingerprint` and `outline` in the reply are of the note as the write left it, without their change; if your next `if_match` doesn't match, read again.
- **The section the write's `if_match` names** (any part of the note for a whole-note `if_match` — `replace_all`, `append` — and for a file sent back): the server starts over against the changed note, comparing `if_match` again, so you get `409` with the current content. A section that keeps being touched but ends up the same overtakes the write at most three times; then it answers `503 server_busy` with `Retry-After` and writes nothing.

A new block typed right after the last block of the section counts as touching it (it becomes part of the section). One typed at the end of the previous section, right before the section's heading, doesn't: it stays in the previous section — `replace_section` puts the new content after the section's last old block and then removes the old blocks, so the two insertions can't swap places when they are merged.

### A losing concurrent write is not always a 409

Two writes to the same note are serialised (see `server_busy` under [Limits](#limits)), so one of them is always working against the other's result. Which error it gets depends on the operation:

| Operation | What the loser gets |
|---|---|
| `replace_all`, `append` | `409 fingerprint_mismatch` (the whole-note fingerprint moved) |
| `insert_after` | `409 fingerprint_mismatch` (the heading survives, the section's blocks changed) |
| `replace_section`, `delete_section` on a heading section | `409 fingerprint_mismatch` when the winning write kept the heading's id, otherwise **`404 section_not_found`** |
| `replace_section`, `delete_section` on `_top` | `409 fingerprint_mismatch` |

`replace_section` and `delete_section` replace or remove the section's heading, and the heading's block id *is* the section id. If the winning write gave the heading a new id or removed it (see [Which blocks keep their ids](#which-blocks-keep-their-ids)), the id the second request addressed does not exist any more, and addressing fails before the fingerprint is ever compared. If the winning write kept the heading's id, the section is still found and its changed fingerprint is what refuses the second request. `_top` is always found because its id is a fixed string.

**Handle both codes.** The recovery is identical: re-read the outline (or the `current` body a 409 already gave you), decide again against what is there now, and retry. A `404 section_not_found` on these endpoints never means "the note is gone" — that is `404 not_found`.

## The five operations

| `op` | `section_id` | `markdown` | `if_match` | What it does |
|---|---|---|---|---|
| `replace_all` | not accepted | required | required — whole note | Replaces the entire note. Blocks that keep their id are described in [Which blocks keep their ids](#which-blocks-keep-their-ids); the others get new ids. |
| `replace_section` | required | required | required — that section | Replaces the section **including its heading**. |
| `insert_after` | required | required | required — that section | Inserts after the section's last top-level block. |
| `append` | not accepted | required | optional — whole note | Adds to the end of the note. |
| `delete_section` | required | not accepted | required — that section | Removes the section and its heading. |

A request is exactly **one** merge into the live document: all of it lands, or none of it does. There is no per-block animation and no partial application — readers watching the note see the change appear in one step.

`replace_all` and `replace_section` keep the [knowledge info](#knowledge-info) of a heading you send back without a comment, when the heading has the same level and text as one in what the write replaces; `insert_after` and `append` add headings that have none unless they come with a comment.

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

If you meant to keep the section, restate its heading as the first line of the Markdown you send, **at the same level** (`# Summary`, not `## Summary` — a deeper heading is absorbed by the section above it, as described in [Structure and addressing](#structure-and-addressing)). The section's id stays only if the heading you send still matches the old one by the rules in [Which blocks keep their ids](#which-blocks-keep-their-ids); if it doesn't, it changes.

## Revert

`GET /api/notes/:id/edits` lists what has been written through the API, newest first:

```json
{ "edits": [ { "id": "…", "op": "replace_section", "sectionId": "…", "heading": "Summary",
               "byHandle": "alice", "agentLabel": "claude",
               "avatar": { "id": "…", "v": 1 }, "createdAt": "…",
               "revertedAt": null, "revertOf": null, "revertable": true } ] }
```

- `op` is one of the five, `file_sync` for a part of a note changed by a file sent back (see [Sending a file back](#sending-a-file-back)), or `revert` for a row produced by reverting something. `revertOf` points at the row a revert undid.
- `heading` is looked up in the note **as it is now**, so it follows renames and becomes `""` once the section is gone.
- `byHandle` is the username of whoever made the request. `agentLabel` is set only when the write came through a token or an authorized App; a write made with a session cookie leaves it `null`. It follows the credential's current name while the credential exists — unless you have renamed it in Settings, in which case the name you picked wins (see [Agent display name](#agent-display-name)) — and falls back to the label recorded at the time once it has been revoked.
- `avatar` is the profile picture reference of the account the write was made as (also when `agentLabel` is set), or `null`; the picture itself (`/api/avatars/<id>?v=<v>`) can only be fetched with a session cookie, not with a token.
- `revertable` says whether `POST …/:editId/revert` would be accepted right now. Reverting is a normal write: it needs `notes:write`, it produces its own row (which can never itself be reverted), and it appears live in open tabs like any other change.

In the **AI edit history** dialog (in the note's `⋮` menu), a row that can't be reverted shows why instead of a **Revert** button: **Already reverted**, that a revert can't itself be reverted, or — for any other row — that the content has changed since or the note was switched to another version. Below the list, the dialog notes that each note keeps up to its 100 most recent AI edits.

A revert is refused with `409 already_reverted` (already undone, or the row is itself a revert), `409 stale` (the note has moved on — the body carries the current content in `current`), or `404 not_found` (no such row, or it belongs to another note).

**How "stale" is decided** differs by operation, and this is the part worth knowing:

- For `replace_all`, `replace_section`, `insert_after` and `append`, the server compares a fingerprint over exactly the blocks that edit wrote. Touch or delete any of them and the edit stops being revertable. A later write that leaves them exactly as they were, ids included, doesn't make it stale — which is what a later `replace_section` or `replace_all` does to the blocks it keeps (see [Which blocks keep their ids](#which-blocks-keep-their-ids)). Such an edit also stops being revertable when blocks it removed are back at the top level, for example because an earlier revert of it was merged.
- **`delete_section` has no such fingerprint** — the blocks it wrote are the ones it removed. It is judged by an **anchor**: the neighbouring top-level block the section is put back next to. So a `delete_section` stays revertable even when the text *around* the anchor has been rewritten in the meantime; only the anchor block disappearing (or the deletion having already been undone) takes it away. Restoring it can therefore drop a section back into a paragraph that no longer reads the way it did.
- **`file_sync` rows come in both kinds.** A row for a part a file rewrote or added is judged like the first four, by a fingerprint over the blocks it wrote; a row for a part a file only removed is judged like `delete_section`, by an anchor.

**If the record fails to be written**, the content has already changed. Content is merged first and recorded afterwards, on purpose (a database transaction is never held across the merge), so a failure in between answers `500` with the content already applied and no row recorded. There are two shapes of this, and they differ:

- For a **write**, the content is in the note and no row exists — so it cannot be reverted through the API, and a retry is refused by `if_match` rather than duplicating the edit.
- For a **revert**, the content is already restored, but no revert row was written and the original row was not marked. **That row becomes non-revertable**, and pressing revert again answers `409 stale`. Every operation is caught by the same idempotency rule: an edit whose removed blocks (all of its `before_blocks` for `delete_section`; for the others, the ones the edit didn't write back with the same id) are back at the top level counts as already restored. For the four non-`delete_section` ops the fingerprint check can also do it by itself, when the restore replaced exactly the blocks it compares; `delete_section` has no fingerprint, and its anchor survives a restore. Without the rule a retry would insert the same blocks a second time, leaving two top-level blocks with the same id.

Neither shape is recoverable by retrying; both are consequences of merging before recording.

**Retention is "at most 100", not "the last 100".** Each note keeps its most recent 100 rows and the trim runs inside the same transaction that inserts a new one. Because a revert row is tied to the row it undid (deleting the original deletes the revert), two things follow: reverting the *oldest* remaining edit pushes that pair out of the window together (101 rows, revert the oldest, 99 remain), and an ordinary write's trim can also take out a revert row that is still well inside the window, if the row being trimmed happens to be that revert's original. A revert row's lifetime is bounded by its original's.

## Sending a file back

The MCP tool `open_notes_as_files` (see [MCP](./mcp.md#open_notes_as_files)) lets an assistant download notes as markdown files and send a changed file back with `PUT /api/transfer/notes`. Sending a file back is not one of the five operations, and it takes no `if_match`: the server compares the file with the copy that was downloaded and writes only what the file changed.

- **The unit is a top-level block** — a paragraph, a heading, a list item, a table and so on, together with the blocks nested inside it. A run of list items that includes colored items is one unit, because the file has it as one block of HTML.
- **Only the blocks the file changed are written.** The blocks it didn't change keep their ids. In a part the file rewrote, a block keeps its id by the rules in [Which blocks keep their ids](#which-blocks-keep-their-ids); the other blocks of that part get new ids. An added part goes after the nearest block before it, or before the nearest block after it, that the file didn't change.
- **A note that has changed since the download refuses a changed file.** Before writing, the server checks that the note is still what the copy was downloaded with: its title, and its blocks — the same blocks with the same ids, each with the same text, formatting, attributes and nested blocks. Links to other notes are compared as they are stored, so renaming a linked note, or the linked note going out of your sight, doesn't count. (A note marked `mergeable: false` has no such list of blocks; for it, which can only be renamed with a file, the note's text as it downloads is compared instead — so there a linked note's new title, or a link whose note went out of your sight, does count.) If anything differs — someone typed in it, `edit_note` changed it, another file was sent back to it — the whole file is refused with `409 base_unavailable` (`reason: "note_changed"`) and nothing is written, not even the title; download the note again and redo the change in the new copy. The check of the text and the writing of the text happen together: if the note changes after the check, before the file's changes are merged in, they aren't merged, and the server checks again. The title is changed only if it is still the one the server checked. A file's text is never put over a change that had reached the server (see [Known limitations](./known-limitations/bulk-transfer.md) for text still being typed), so sending a file back doesn't save a version first. A file that is the same as the copy downloaded answers `unchanged` however the note has changed.
- **A link to another note with no text of its own keeps following that note's title when the file leaves its text as downloaded.** Such a link is written to the file as it read at download time — normally the linked note's title then. If that note has been renamed since, that text in a changed block still counts as no text of its own, so the link goes on showing whatever the note is called, as long as you can still see that note. Link text changed to anything else is handled as for `edit_note` (see [Links to notes](./mcp.md#links-to-notes)), except that what reading over MCP or the API showed you, or what you wrote there, doesn't count: the note's current title, or the URL, follows the note; other text is kept as the link's own text.
- **Some notes can't be written back as a file.** When a note's blocks can't be lined up with its markdown at download time, the download's manifest marks it `mergeable: false`, and a file that changes its content is refused with `409 not_mergeable`; change it with `edit_note`.
- **Each changed place is one row** in the AI edit history, with `op: "file_sync"`, and the **AI edit history** dialog shows it as `file_sync`. Renaming a note with a file isn't recorded. A file that changes more than 100 places in a note leaves only the 100 latest of its rows, and the reply's `editIds` lists only those.
- **A toggle becomes a bullet.** A toggle is written to the file as a bullet item, so when the file changes it, it comes back as a bullet list item. `edit_note` does the same with a toggle read with `read_note_section` and written back.
- **Blocks nested under a list item come out of it.** A list item with a paragraph nested under it is written to the file as one item; when the file changes that item, the nested paragraph comes back as a block of its own, after it.
- **A file carries the note's tags and knowledge info.** Its front matter has a `tags` line, and a [knowledge comment](#knowledge-info) follows each knowledge heading. A file is the whole content, so a knowledge heading that comes back without its comment has no knowledge info afterwards: the rule that `replace_section` and `replace_all` keep it for a heading sent without a comment doesn't apply to files. A comment the file keeps decides the info, even when the heading's text changed. A `tags` line that differs from the one downloaded sets the note's tags, which needs edit rights in the note's own space; see [MCP](./mcp.md#sending-a-file-back).
- **HTML comments other than a knowledge comment are dropped**, and text after one, on its line and on the lines right below it, becomes plain text that can run on into the text after a later comment; leave a blank line after each comment, with nothing after it on its line, to keep the lines below it as markdown. A block whose text has a comment inside it is replaced by one without the comment, which keeps the old block's id only by the rules in [Which blocks keep their ids](#which-blocks-keep-their-ids). A comment the file opens with `<!--` and doesn't close can hide the text after it; when that leaves a changed part with nothing in it, the whole file is refused with `400 empty_content`. `edit_note` parses markdown the same way.
- Some cases where a block is replaced although the file didn't change it, and other blocks that come back different from how they went out, are in [Known limitations](./known-limitations/bulk-transfer.md).

## Limits

| Limit | Value | Applies to | Exceeding it |
|---|---|---|---|
| Request body | 262 144 bytes | `POST /api/notes/:id/edits`, `POST /api/mcp` | `413 content_too_large` |
| `markdown` / `content` length | 262 144 UTF-16 code units | `POST …/edits`, `POST /api/notes` | `400 invalid_body` |
| Blocks after parsing | 2000, counting nested blocks | `POST …/edits`, `POST /api/notes` | `400 too_many_blocks` |
| Writes | 30 per minute per user by default (a site admin can lower it) | `POST …/edits`, `POST …/revert`, `POST /api/notes` with `content` | `429 too_many_requests` |
| Content reads | 120 per minute per user by default (a site admin can lower it) | `GET …/content`, `GET …/edits` | `429 too_many_requests` |
| Token calls | 300 reads/min and 60 writes/10 min per user by default (a site admin can lower them) | every request made with a token or App credential, on top of the two rows above | `429 too_many_requests` |
| Concurrent writes to one note | serialised, 10 s wait | `POST …/edits`, `POST …/revert` | `503 server_busy` |
| Reading the Markdown | `PARSE_TIMEOUT_MS` (default 10 s) and `PARSE_WORKER_MEMORY_MB` (default 1024 MiB) per write, set by the site | `POST …/edits`, `POST /api/notes` with `content` | `400 unsupported_block`, the message saying the content is too complex |
| Waiting to be read | `PARSE_QUEUE_WAIT_MS` (default 4 × `PARSE_TIMEOUT_MS` + 5 s = 45 s), set by the site, and at most 100 writes waiting | `POST …/edits`, `POST /api/notes` with `content` | `503 server_busy` with `Retry-After` |
| Turning a note into Markdown, or putting a write into it | 3 × `PARSE_TIMEOUT_MS` (default 30 s) and `PARSE_WORKER_MEMORY_MB`, with the same wait for a worker | `GET …/content` and the `current` of a `409`; `POST …/edits`, `POST …/revert`, `POST /api/notes` with `content` | reading: `500 too_complex`; putting a write or revert into an existing note: `500 too_complex` (the note is the problem); reading the written Markdown, or a new note's content: `400 unsupported_block` (too complex); waiting: `503 server_busy` with `Retry-After` |
| Section touched while a write was worked out | 3 tries (changes elsewhere in the note are merged, not retried) | `POST …/edits`, `POST …/revert` | `409` once the section differs; `503 server_busy` with `Retry-After` after three tries |
| Note size | `NOTE_MAX_BYTES` (default 5 MiB of stored state), set by the site; only a change that grows the note past it and adds content (or grows it by more than 4 KiB without adding content) is refused — deleting and replacing with the same amount or less are accepted | `POST …/edits`, `POST …/revert`, `POST /api/notes` with `content` | `413 note_too_large` with `limitBytes` |
| Recorded edits kept | at most 100 per note | `GET …/edits` | oldest rows are deleted |
| Linked notes indexed | 1000 per note | every write | extra targets are dropped from the index, the write still succeeds |

A `POST /api/mcp` counts as **one** read call against the "Token calls" row no matter how many tools it invokes, and **each** `edit_note`, `create_note`, `move_note_to_group`, `copy_note`, `delete_note`, `restore_note`, `create_folder`, `rename_folder`, `move_folder`, `move_note_to_folder`, `delete_folder`, `post_comment` or `create_transfer_token` with `upload` call inside it counts as one write call — including a `create_note` without `content` (#108), but not a `copy_note` refused for its `folder_id` or for lack of `notes:move`, which spends nothing. `read_note_outline`, `read_note_section`, `read_note_image`, `read_comments`, `list_notifications` and `create_transfer_token` with `download` each count as one content read against the content-read budget above, and `edit_note` (except `rename`), `create_note` (when it carries `content`), `copy_note`, `delete_note` and `restore_note` draw on the write one — even though those rows list only the REST endpoints: what a tool answers is never an HTTP status, so MCP's own limits are tabulated separately. `copy_note` also draws on the upload limit, one per image it copies. `create_folder`, `rename_folder`, `move_folder`, `move_note_to_folder` and `delete_folder` draw on neither the write budget (30 per minute by default) nor the content-read one, but on a separate folder budget of 600 per minute per user that the web app's folder changes share. `post_comment` draws on the comment budget instead, 30 per minute per user, shared with the web app and fixed. `list_notes`, `search_notes`, `list_trash`, `list_folders` and `open_notes_as_files` draw on neither — the commands it returns have budgets of their own, listed in [MCP](./mcp.md#limits); `search_notes` draws on a separate search budget of 60 searches per minute per user by default (a site admin can lower it). For that table see [MCP](./mcp.md#limits); for how MCP answers once one of these budgets runs out, see [API tokens](./api-tokens.md#errors-and-rate-limits).

`POST /api/notes` (with or without `content`) uses the server's ordinary 1 MiB body limit rather than the 262 144-byte one — the `content` field's own length limit is what bounds it, and a request over the body limit there is still `413 content_too_large`. It shares the same per-note write queue, but waiting too long for that queue doesn't answer `503`: if applying the content fails for any reason, including waiting too long for the queue, the note row it just created is removed again and the answer is `500 internal`. Its only `503 server_busy` comes from waiting too long to be read (see the table), before any row is created.

Note that `server_busy` is a `503` on these endpoints. The same code is a `409` on `POST /api/notes/:id/links`, where it means a write conflict rather than a queue timeout.

## Markdown round-trip

Content crosses the API as Markdown, and the round-trip is deliberately lossy in two places that the server repairs on the way in:

- **Links to notes.** A link whose URL is a note on this site you can see — `/notes/<id>`, or its address from `list_notes`, optionally ending in `#b-<block id>` — is saved as a link to that note; any other link to this site stays an ordinary link (see [MCP](./mcp.md#links-to-notes)). Reading gives it back as `[text](/notes/<id>)`, with the target's id in the URL, so a read-modify-write keeps each link on the same note even if titles change, as long as you can see that note. A link with no text of its own reads as the note's title, and written back with that text it keeps following the note's title, even if the note was renamed after you read it — for up to 24 hours after a read showed it (or after you wrote that link yourself), as long as the server hasn't restarted since (see [MCP](./mcp.md#links-to-notes) and [Known limitations](./known-limitations.md)). A `[[Title]]` you send is still bound to a note when **exactly one** note you can see has that title — now also inside tables; zero matches or several, and it stays literal text, and `unboundWikilinks` in the `POST …/edits` response's `201` counts how many stayed literal in that write.
- **Diagrams.** A ```` ```mermaid ```` fenced block is restored to a real [diagram](./diagrams.md) block, with its source preserved exactly. Reading a diagram gives the fence back.

Eight more properties of the Markdown:

- **Line breaks inside a block.** A line break within a paragraph (Shift+Enter in the editor) can be written as a plain newline, a backslash at the end of the line, or two spaces at the end of the line; all three store the same line break, and the next line starts with exactly what follows it, with no space added. Reading gives it back as a backslash at the end of the line, except in a list item, a table cell or a heading, and when the next line starts with a space, a tab, an ASCII punctuation character or a number followed by `.` or `)`: there it reads as `<br>` on the same line (`first<br> second`, `first<br>- second`), because the backslash form can't be written back there (a next line such as `- second` or `# second` would start a list or a heading) (a block that reads as HTML, such as a colored one, has `<br>` anyway). Write `<br>` yourself to start the next line with a space; spaces at the start of a new line in the Markdown itself are dropped, as Markdown does. Outside list items, table cells and headings, what decides the form is only the plain text right after the line break: when the next line starts with a link, inline code, colored text or other formatting, it always reads with the backslash (a space at the start of that link, code or colored text stays inside it). A line break at the very start or end of a paragraph reads as `<br>` too. In a table cell, a space right after `<br>` is dropped when written.
- **Line endings.** `\r\n` and a lone `\r` in the Markdown you send are read as `\n`.
- **Characters Markdown would read as formatting** read back with a backslash in front, so that writing back what you read keeps them as text: `*`, `` ` ``, `[` and `]` always; `_` unless both characters next to it are ASCII letters, digits or `_` (`snake_case` and `a__b` read as they are); `~` next to another `~` or at either end of a run of text; and `\` when the next character is one a backslash escapes in Markdown (``\`*_{}[]()#+-.!~|><``) or it ends a run of text (`C:\Users` reads as it is). At the start of a paragraph or a quote — also after leading spaces, and in a paragraph nested under a list item — text that Markdown would read as the start of a heading, quote, list or divider gets a backslash too: `\# x`, `\> x`, `\- x`, `\+ x`, `1\. x`, `\---` (`-1`, `#tag` and `1.5` read as they are). So does a ` #` at the end of a heading, which Markdown would otherwise drop. So does a `<` followed by an ASCII letter, `/`, `!` or `?`, or ending a run of text — where Markdown could read it as the start of an HTML tag or comment: `\<b>bold\</b>`, `\<!-- c -->` (`2 < 3` reads as it is). Text in inline code, in code blocks and in a block that reads as HTML is never escaped this way (in such a block, a `<` in the text reads as `&lt;`).
- **HTML you write is read as HTML; `\<` is a literal `<`.** In Markdown text, `\<` stores a `<`, so `\<b>` stays the text `<b>`; HTML written without the backslash is parsed as HTML (see "Only block types this note can store are accepted" below for what is rejected or dropped). Inside inline code and code blocks, and inside a block written as HTML, a backslash is not an escape.
- **Spaces at the edges of bold, italic or struck-through text** read outside the markers — ` **b**` rather than `** b**`, which Markdown doesn't read as bold; also when that text is colored. Writing that back keeps the text and its formatting; only the space itself is no longer bold, italic, struck through or colored.
- **A link's title is dropped.** The optional title in `[text](url "title")` has nowhere to live — a link keeps only its text and its URL — so it is gone as soon as the Markdown is parsed, and reading the note back gives you `[text](url)`. Nothing reports the loss, and unlike links to notes and diagrams (the two repairs at the top of this section) the server does not repair it; the link itself, text and URL, is preserved exactly.
- Only block types this note can store are accepted. Anything else is rejected whole, with `400 unsupported_block` — no block is silently stripped. The same code answers Markdown the editor fails to parse, such as `<div data-content-type="paragraph">`; HTML with an event-handler attribute such as `onerror` or `onclick` anywhere in it, including inside a `<details>` block or a `<figure>` (this check comes before the column and size checks below); a `<script>`, `<style>`, `<iframe>`, `<object>`, `<noscript>`, `<title>` or `<template>` element anywhere in it, also in the middle of a paragraph, a list or a column (one inside an HTML comment or a code block doesn't count); a paragraph inside another paragraph, which only HTML can make (a `<p>` inside a `<button>`, `<marquee>`, `<svg>` or `<math>` that is itself in a `<p>`); Markdown nested more than 128 HTML elements deep, counting each element it becomes and the paragraph inside — a quote is one level and a list level two, so quotes nested 127 levels deep and lists nested 63 levels deep still fit, 128 and 64 don't; and Markdown the server can't read within its time and memory limits (see [Limits](#limits)), with a message saying it is too complex — Markdown nested several thousand levels deep can end up here instead of being refused for its depth. Other HTML the editor has no place for is not an error: an element with text in it, such as `<span>` or `<button>`, keeps only its text (except `<video>` and `<audio>` in the middle of a line, whose fallback text is dropped with them), and one without, such as an `<img>` in the middle of a line of text or `<input>`, is dropped. Side-by-side columns and sizes are checked as well: columns not written in the form under [Columns](#columns) are rejected whole with `400 unsupported_columns`, and image widths or table column widths not written in the form under [Sizes](#sizes) with `400 unsupported_size`.
- Non-empty Markdown always ends with a trailing newline. A note that has never been opened or written to returns `markdown: ""`; one that has been reduced back to empty returns `"\n"`. Both report `chars: 0`, so test emptiness with `chars` or the fingerprint, not by comparing the string to `""`.

### Knowledge info

A heading at the top level of a note can carry [knowledge info](./knowledge.md): when to read it, a conclusion, how well it is backed, when it was last verified and whether it was replaced. Reading gives it as a comment on the lines right after the heading, and a write reads the same comment back:

```markdown
## Retry policy
<!-- knotebook:knowledge
id: k_3f9a01bc
when: When a job fails twice
conclusion: Back off before the third try
evidence: tested
verified: 2026-11-14
status: verified
-->

Wait before the third attempt.
```

- **The lines.** `<!-- knotebook:knowledge` is alone on the comment's first line, `-->` closes it, and each line between is `key: value`. The keys are `id`, `status` (`verified`, `needs-verify` or `obsolete`, and the older `unverified` and `outdated`; left out, the knowledge counts as verified when it has a last-verified date and as needs-verify otherwise) and those of the fields the site has turned on: `when`, `conclusion`, `evidence` (one of its options — `tested`, `docs` or `inferred` unless the site changed them; `unconfirmed` is the same as leaving it out), `verified` (`YYYY-MM-DD`) and `superseded_by` (a knowledge id of the same note, or `<note id>#<knowledge id>` for another note; optional), then `x-<key>` for each custom field, in the site's order. A custom field's value depends on its type: one line of up to 300 characters for text, one of its option keys for a single choice, `YYYY-MM-DD` for a date, an address starting with `http://` or `https://` or a path on the site starting with `/` (not `//`), up to 2,048 characters and without spaces, for a link, and for a person their handle (in any case) or `user:<id>`. `read_note_outline` lists the fields the site has turned on, with their keys, types and options, under `knowledgeFields`. Reading always writes `status`, writes a person by their handle (`user:<id>` when the stored id matches no account), and leaves out the line of an empty field and of a field the site turned off. A built-in key or a well-formed `x-` key can appear once; a repeated unknown key is not an error, it is reported once per line as `unknown_field`.
- **Values.** A value that starts with `"` is read as one JSON string; reading writes a value that way when it starts with `"`, has a space at either end, or holds `--`, a control character or a lone surrogate. A comment may leave every field out, and the blank line after `-->` is required.
- **Where it counts.** Only on the lines right after a heading at the top level of the note, not in a column, a list or a quote. A knowledge comment anywhere else is ignored, and the reply counts it in `ignoredComments`. A second comment under one heading is refused. Knowledge info can't be set in any other way: a `data-knowledge-…` attribute in HTML is taken off before the markdown is read, so it sets nothing (in markdown that has a `<plaintext>` tag the write is refused with `400 unsupported_block`).
- **Only a malformed comment refuses the write.** A comment that isn't laid out as above (a line that isn't `key: value`, a key twice, a quoted value that isn't one JSON string, no blank line after `-->`, a second comment under one heading) or whose `id` isn't valid is refused with `400 invalid_knowledge`, whose message names the heading and what is wrong, and nothing is written. That holds for `POST /api/notes/:id/edits`, `POST /api/notes`, the MCP tools and a file sent back.
- **A line that can't be written is ignored.** A key the site doesn't have (`unknown_field`), a field it turned off (`field_disabled`), a value that isn't one of the field's options (`not_an_option`), a status it doesn't know (`bad_status`), a date that isn't `YYYY-MM-DD` (`bad_date`), a `superseded_by` that isn't a reference (`bad_ref`) or that names the knowledge itself (`superseded_self`), a value over 200 characters for `when` or 300 for `conclusion` or a custom text field (`too_long`), a value with a line break (`line_break`), a link that isn't one of the addresses above (`bad_link`) and a person you can't name (`unresolved_member`) aren't written; the rest of the comment is. That field keeps the value it had (none for new knowledge), and the reply lists the line in `knowledge.ignored`. A write never empties a field the site turned off: its value stays as long as the knowledge does.
- **People and the size of custom values.** You can name yourself and the people the web app suggests to you when sharing: members of your groups and the people you have shared one of your notes with (one not in the trash), but not a disabled account. Any other handle or id is `unresolved_member`, whether that person exists or not, and a person written back as reading showed them is kept even after they left the group or had their account disabled. All custom values of one piece of knowledge together are held to 65,536 characters as stored: a new value that would make them larger than that is left out as `too_long`.
- **A comment sets the whole info.** A line you leave out empties that field, except `id`, `status` and a field the site turned off: a turned-off field keeps its value, a comment without `status` reads it from the last-verified date as above, and a comment without `id` on a heading that keeps its level and text in a `replace_section`, a `replace_all` or a file sent back keeps that knowledge's id, and on any other heading it makes new knowledge with a new id. An `id` has to be `k_` and 8 lowercase hex digits; one that starts with `k_new:` is refused.
- **A heading sent without a comment.** `replace_section` and `replace_all` keep the knowledge info of the heading it lines up with in what the write replaces: one with the same level and the same text (the replaced blocks and the new ones are lined up by their content, and headings left over are paired when their level and text are unique on both sides). A heading whose text or level you changed has none unless you send a comment. The reply's `knowledge.kept` lists what was kept and `knowledge.removed` what was in the replaced part and is no longer in the note. The AI actions in the web app follow the same rules.
- **Ids stay unique in a note.** An `id` you write on a heading while another heading holds it is not given to the one you wrote it on: that heading gets a new id, which the reply lists in `knowledge.renewed` with the id you wrote as `from`. The heading that holds it is the one that already had the knowledge: a heading outside what the write replaces; inside it, a heading that kept the old info (in `replace_section` and `replace_all`, sent without a comment, or with a comment without an `id` line; in a file, only with a comment without an `id` line, since a heading a file sends without its comment has no knowledge info); else the one that lines up with the old heading that had the id, of the headings you wrote it on; else the first heading you wrote it on. Where a heading is renamed and keeps its comment, nothing else holds the id, so it keeps it, unless another heading you wrote carries the same id and comes first: then that one keeps it and the renamed one gets a new id. Two headings that swap their comments (one writes the other's id and the other writes the first's) are written as they are, and renew nothing. `knowledge.created` lists the ids that are new to the note after the write, whether you left `id` out or wrote a new one.
- **Writing back what is stored.** Knowledge info that is in the note and comes back reading the same as what is stored (the status compared by what it means, fields the site turned off left out of the comparison) isn't checked again and is stored unchanged, so what the web app stored can always be written back. A value equal to the stored one is accepted even where it no longer fits, such as an option the site turned off; a changed value is checked.
- **The reply.** `knowledge` is `{kept, created, removed, renewed, ignored, ignoredComments}`; `ignored` holds `{heading, key, value, reason}` entries, the other lists `{id, heading}` entries, and `ignoredComments` is a number. It is there only when the write kept, created, removed or renewed knowledge info, or ignored a line or a comment. `POST /api/notes` with `content` answers with the note, plus `knowledgeIgnored` (entries as in `ignored`) when it ignored a line.
- **Revert.** Reverting an edit puts back the knowledge info it removed, with the same ids.

What doesn't travel in the comment is in [Known limitations](./known-limitations/knowledge.md).

### Colors

Text and background colors travel as HTML inside the Markdown: a colored stretch of text is a `<span>` inside ordinary Markdown, and only a color Markdown has no place for — on a whole paragraph, heading, list item or quote, or on a table cell — needs the block written as HTML. Use one of the editor's ten built-in color names — `default`, `gray`, `brown`, `red`, `orange`, `yellow`, `green`, `blue`, `purple`, `pink` (`default` means no color) — or a hex color written `#rgb` or `#rrggbb`, such as `#ff6600`.

| What | Write it as |
|---|---|
| Colored text | `<span style="color:red">…</span>`, `<span style="background-color:yellow">…</span>`, or both in one `style`: `<span style="color:red;background-color:yellow">…</span>`, or a hex color: `<span style="color:#ff6600">…</span>` — inside a Markdown paragraph, list item, heading or pipe-table cell. Markdown inside the span still works: `<span style="color:red">**late**</span>` is red bold text |
| A colored paragraph | `<p data-text-color="red" data-background-color="yellow">…</p>` or `<p data-text-color="#ff6600">…</p>`, as a block of its own with a blank line after it (either attribute can be left out) |
| A colored heading, list item or quote | the same attributes on `<h1>`–`<h6>`, on an `<li>` inside `<ul>` or `<ol>`, or on `<blockquote>` |
| A colored table cell | an HTML `<table>` with the same attributes on its `<td>` or `<th>`, for example `<td data-background-color="#ff6600">` — a Markdown (pipe) table can't carry a cell's own color (colored text inside a cell is fine). A table with column widths is an HTML `<table>` too, with `colwidth` on its first row's cells only — see [Sizes](#sizes) |

- **A hex color is stored as lowercase `#rrggbb`**: `#F60` is stored as `#ff6600`. Inside `style`, other opaque spellings of a color — `rgb()`, `hsl()`, `hwb()`, `#rrggbbff`, `rgba(…, 1)`, with or without `!important` — are converted by the HTML parser and stored as the matching `#rrggbb` too. In a `data-` attribute, write a color name or `#rgb` / `#rrggbb` (the hex letters may be in either case).
- **A color the editor can't show rejects the whole write.** Examples: a color with transparency (alpha below 1, whether written `#rrggbbaa`, `rgba()` or `/ 50%`), a CSS color name that isn't one of the ten (`tomato`, `transparent`, `currentcolor`), `var()`, another color function such as `oklch()`, and, in a `data-` attribute, a color name that isn't written in lowercase. The answer is `400 unsupported_color` (over MCP, the tool error `unsupported_color`), its message lists the ten names and the hex form, and nothing is stored. Inside `style`, CSS's own case-insensitivity applies, so `color:RED` is accepted as `red`.
- **Other markup is not a color.** `<mark>`, or `data-text-color` / `data-background-color` on a `<span>`, is accepted, but the color is dropped without an error and only the text is kept.
- **Inside a block written as HTML, Markdown is not interpreted.** Write bold as `<strong>`, a link as `<a href="…">`, and so on; `**` there is literal text.

Reading gives colors back in the same forms; a hex color reads back as lowercase `#rrggbb`, whatever form it was written in. Content with no color in it reads back as Markdown, exactly as before. Colored text reads back as a `<span>` in the Markdown, with the span outside any bold, italics or link around that text (`<span style="color:red">**late**</span>`). A paragraph, heading, list item or quote with a color of its own reads back as one block of HTML — the whole list, nested items included, when any of its items has one — and so does a whole table when any of its cells has one, with `colwidth` only on its first row when it also has column widths. An image with a background color reads back as HTML with `data-background-color` on it; when its width has been set, that is the `<figure>` form under [Sizes](#sizes), with the color on the `<figure>`. Writing back what you read keeps the colors: sending a section back unchanged with `replace_section` and reading it again gives the same text. That holds for the colors; text that merely looks like Markdown or HTML is another matter — see [Known limitations](./known-limitations.md). Three kinds of color are not carried:

- **A file attachment's background color.** A file attachment reads back as an `<embed>` ([Audio, video and files](#audio-video-and-files)), and the color is not in it.
- **A color value that isn't one of the ten names or a lowercase `#rrggbb` color**, such as one stored before Knotebook checked colors or left by pasting from elsewhere. The editor doesn't show it either; it reads back as no color, so writing that block back removes it.
- **The color of a block with no text in it**, such as an empty paragraph given a background. Written back, an empty colored block would be dropped, so it reads back as it did before colors were read at all.

### Columns

A row of [side-by-side columns](./columns.md) travels as HTML `<div>`s with ordinary Markdown inside each column. Reading a row gives exactly this form; write rows the same way:

```markdown
<div data-kb-columns style="display:flex;gap:16px">
<div data-kb-column style="flex:1">

<figure><img alt="Point A" src="/api/uploads/0f8c…" width="300"></figure>

</div>
<div data-kb-column style="flex:1.5">

## Equipment specs

* Model: …

</div>
</div>
```

- **The row's opening tag, and each column's, is a line of its own**, not indented and with nothing else on the line, written exactly as above: the same attributes in the same order, in double quotes and lowercase, with no other attributes and no extra spaces. Reading puts the first column's tag on the line right after the row's tag, each later column's tag on the line right after the previous column's `</div>`, and the row's own `</div>` on the line after the last column's.
- **`N` in `flex:N` is the column's relative width**, from 0.1 to 10 with at most two decimal places (`1`, `1.5`, `0.75`, `2.25`; `0.5`, not `.5`) and no leading zero (`01` is refused). Reading writes it without trailing zeros.
- **Put a blank line after each column's opening tag.** Without it, Markdown text that follows the tag is taken as raw HTML, and the write is refused. Reading puts a blank line there and another before each column's `</div>`; a write that leaves out the one before `</div>` is accepted.
- **An empty column** reads as its opening tag, one blank line and `</div>`.
- **Inside a column is ordinary Markdown**: colors, sizes, links to notes and diagrams work there as described on this page. A column can't hold another row.
- **A write takes rows of 2 to 4 columns.** A note can have a row with more — a pasted row keeps all of its columns — and reading gives every column back, but sending such a row back is refused.
- **A row is a top-level block.** It can't be inside a list item, a quote or a `<details>` block. It belongs to the section of the heading before it, and a heading inside a column doesn't open a section of its own, so it isn't in the outline either. Replacing a section replaces any row in it; to keep a row, send it back whole, from its `<div data-kb-columns …>` line to its last `</div>`.
- **A row and each of its columns count as blocks** toward the 2000-block limit, along with the blocks inside them.

These are refused with `400 unsupported_columns` (over MCP, the tool error `unsupported_columns`), and nothing is written:

- a row's or a column's opening tag that isn't written exactly as above, on a line of its own;
- a `flex` value outside 0.1 to 10, with more than two decimal places, or with a leading zero before its whole part, such as `01`;
- Markdown text right after a column's opening tag, with no blank line between them;
- a column tag outside a row, or text between a row's columns;
- a row of fewer than 2 or more than 4 columns;
- a row that isn't at the top level — inside a list item, a quote or a `<details>` block, for example — or a row inside a column;
- `data-kb-columns` or `data-kb-column` on any element other than such a `<div>` line, for example `<span data-kb-column>`;
- an element with a `data-node-type` attribute — that is the editor's internal form, not this one;
- **any other `<div>` whose `style` contains `display:flex` or `display:grid`**, whatever its spacing or case. Before columns could be written, such a `<div>` was accepted and its contents flattened into ordinary blocks; it is now refused, because it is almost always an attempt at columns.

A write that is wrong about both columns and sizes answers `unsupported_columns`.

Knotebook's own [AI actions](./ai.md) send the selected blocks to the model in this same form, ask it to keep the column tags and the knowledge comments, and check its result the same way before it can be applied. When the blocks an action works on are inside a column, or indented under another block, a result that contains columns is refused.

### Sizes

An image's width and a table's column widths, as set in the editor, travel as HTML. An image or table without them reads as before, with one exception for stored column widths that aren't positive numbers (see the end of this section).

| What | Reads, and is written, as |
|---|---|
| An image with a set width | `<figure><img alt="NAME" src="URL" width="W"></figure>`, as a block of its own |
| The same, with a caption | `<figure><img alt="NAME" src="URL" width="W"><figcaption>CAPTION</figcaption></figure>` |
| The same, with a background color | `data-background-color="…"` on the `<figure>`, not on the `<img>` |
| An image without a set width | `![NAME](URL)` as before, or a `<figure>` without `width` when it has a caption |
| A table with any column width set | the whole table as an HTML `<table>`, with `colwidth="W"` on the cells of its **first row** only. A cell that spans several columns (`colspan`) has one comma-separated value per column, left empty for a column without a width: `colwidth="120,"` |
| A table without column widths | a Markdown (pipe) table as before, unless a cell has a color (see [Colors](#colors)) |

- **`W` is a whole number of pixels from 32 to 4000**, with no leading zero: `300`, not `300.5`, `0300` or `31`.
- **The `<img>` carries `alt`, `src` and `width`, in that order**, and nothing else; `alt` is left out when the image has no name, or when its name is the same as its caption. The `<figure>` carries nothing but an optional `data-background-color`, and holds the `<img>` and, optionally, a `<figcaption>` after it.
- **A `colwidth` has one value per column its cell spans**, and an empty value means that column has no width. A `colwidth` with a value in it belongs on the first row only. One with only empty values (`colwidth=","`, a merged cell without a width) is accepted on any row; a table that is HTML because of a cell color can read back with one on a later row.
- **Writing `![NAME](URL)`, a `<figure>` without `width`, or a pipe table** gives an image or a table without a set size.
- **A toggle heading or toggle list item that holds such an image or table** reads back whole as one block of HTML, with the `<figure>` or `<table>` inside it.
- **Inside a table written as HTML, Markdown is not interpreted**, as with colors.
- **A stored width outside 32–4000, or with a fraction,** reads back rounded and brought into that range, so that it can be written back; a stored column width that isn't a positive number reads as an empty value.
- **An image whose preview is turned off** reads back as a link, without its width.

These are refused with `400 unsupported_size` (over MCP, the tool error `unsupported_size`), and nothing is written:

- a `width` on an `<img>` that isn't the `<img>` of such a `<figure>` — an `<img … width>` on a line of its own, or inside a paragraph;
- an `<img>` with a `width` inside a table cell, which this version doesn't store;
- a width or `colwidth` that breaks the rules above.

**Markdown read from an earlier version.** A note with a resized image or with table column widths now reads differently: the image as the `<figure>` above, with its `width`, and a table with column widths but no cell color as HTML instead of a pipe table. Two forms that were already HTML are now stricter, too: a colored table with column widths had `colwidth` on every row, and a colored image with a set width had more attributes than the `<figure>` form above allows. Sending such older text back unchanged is refused with `unsupported_size`. A row of side-by-side columns read as its columns' blocks one after another, without the column tags, or as one block of HTML when a block in it had a color (see [Columns](#columns)); sending the first form back turns the row into ordinary blocks, and the second is refused with `unsupported_columns`. A note with no columns, no set image width and no table column widths reads as before, except that a stored column width that isn't a positive number — `NaN` in a colored table with merged cells, for example — now reads as an empty value.

### Audio, video and files

Audio, video and file blocks read as HTML, one block each, so that they come back as the same block when written:

| What | Reads, and is written, as |
|---|---|
| Audio | `<audio src="URL" data-name="NAME"></audio>` |
| Video | `<video src="URL" data-name="NAME" width="W"></video>`, with `width` only when a width is set |
| A file | `<embed src="URL" data-name="NAME">` |
| Any of them with a caption | the same element in `<figure>…<figcaption>CAPTION</figcaption></figure>` |
| Audio or video whose preview is turned off | `data-show-preview="false"` after `data-name` |

- **`URL` is the upload's own `/api/uploads/<id>`**, kept relative. `data-name` is left out when the block has no name.
- **`W` follows the rule for image widths** under [Sizes](#sizes): a whole number of pixels from 32 to 4000. A stored width outside that range reads back brought into it, and a written one outside it is refused with `400 unsupported_size`.
- **A block with no URL** reads as it did before: nothing.
- **A background color on one of these blocks isn't kept** in the Markdown.
- **A plain link, `[NAME](/api/uploads/<id>)`, stays a link** in a paragraph. Only the HTML above makes a block.
- **An event-handler attribute** such as `onload` on any of these elements is refused with `400 unsupported_block`, as everywhere else.
- **Markdown read from an earlier version** showed these blocks as a link or a bare `<audio>` / `<video>`. Reading the same note now gives the HTML above, so a fingerprint taken before the upgrade no longer matches; read it again.

## Presence

While a program works on a note, it shows up **in the note** — as a remote cursor, the same one another person editing gets, and in the note header's row of people.

- In the row it is a sparkle icon ringed in the same violet as its cursor, labelled `username (agent)` and **AI agent**. It is listed on its own, separately from you, even though the credential is yours — so you see your own AI there although you aren't listed yourself — and it shows there even when the note has no text for a cursor to point at.
- The cursor is labelled `username (agent)`: your username, and the credential's [agent display name](#agent-display-name).
- It exists only for a note **somebody currently has open**. Presence is attached to the live collaborative document, so if no browser is connected to that note, nothing is created and nothing is broadcast — and there is no record afterwards that a program was there.
- It appears, and moves, on a **token-authenticated** `GET …/content`, `POST …/edits` and `POST …/edits/:editId/revert` — and on the MCP read tools that go through the same code path (`read_note_outline`, `read_note_section`, `read_note_image`), and on `edit_note` (except `rename`), so an assistant that only *reads* a note still shows up in it. `GET …/edits` deliberately does not: reading the history is not working on the note. Neither do the comment tools `read_comments`, `post_comment` and `list_notifications`, nor the comment endpoints: talking about a note is not working on it. `POST /api/notes` with `content` cannot — the note is created by that same request, so nobody can have it open yet.
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

Every credential has a short **agent name**. It is the `(agent)` half of the cursor's label, of the note header's row of people, of the title bar's last-edited line, and of every row in the note's edit history.

By default it is derived from the credential's own name: the first whitespace-separated word, Unicode-normalized, lowercased, with everything outside `A-Za-z0-9._-` removed, cut to 32 characters. `Claude Code (knotebook)` becomes `claude`, `MCP CLI Proxy` becomes `mcp`, and a name that leaves nothing usable behind becomes `agent`.

To change it: the pencil button on the credential's row in **Settings → Authorization → API tokens**, or `PATCH /api/auth/tokens/:id` with `{"agentLabel": "researcher"}`. Like the rest of `/api/auth/tokens`, that endpoint is **session-cookie only** — a token cannot rename itself, or anything else. Sending `{"agentLabel": null}` clears your override and goes back to the derived value; the response, and `GET /api/auth/tokens`, always report the name actually in effect, so `agentLabel` there is never `null`.

A name must match `^[A-Za-z0-9._-]{1,32}$`; anything else is `400 invalid_body`. Renames are limited to 60 per 10 minutes per user — a limit they share with changing a credential's scope through the same endpoint (see [API tokens](./api-tokens.md#changing-a-tokens-access)).

Two things worth knowing:

- **Re-authorizing an OAuth app keeps the name you chose — but only when the app comes back with the same registration.** The replacement credential inherits the label from the credential it replaces, and the one it replaces is found by the app's `client_id`. An app that has re-registered (its old registration expired, or its cached one was cleared — see [API tokens](./api-tokens.md#troubleshooting)) arrives with a **new** `client_id`, so there is nothing for it to inherit from and it starts again from the derived default.
- The **edit history** resolves the name live, so renaming changes what its existing rows show (until the credential is revoked, after which they fall back to the label recorded at the time). The **last-edited line** does not: it is a snapshot taken when that write happened — see [Last edited](#last-edited).

## Troubleshooting

- **`409 fingerprint_mismatch` right after a read.** Somebody (a person in the browser, or another program) changed the note between your read and your write. The error body's `current` is the note as it is now — rebase on that and retry. If it keeps happening on a note being actively typed in, target a narrower section, or use `append` without `if_match` if position does not matter.
- **`404 section_not_found` on a section that was there a moment ago.** Its heading was replaced or removed — by a person, or by your own previous `replace_section`/`delete_section` — and, if replaced, the new heading didn't keep its id ([Which blocks keep their ids](#which-blocks-keep-their-ids)). Section ids are block ids ([Structure and addressing](#structure-and-addressing)). Re-read the outline; do not retry with the old id.
- **`503 server_busy`.** Another write to the same note held the queue for longer than 10 seconds, or — with `Retry-After` — the server was busy reading other writes' Markdown for longer than `PARSE_QUEUE_WAIT_MS` or already had 100 writes waiting (see [Self-hosting](./self-hosting.md#parse-workers)). Nothing was applied and nothing was recorded. Retry.
- **`400 unsupported_block` saying the content is too complex.** Reading the Markdown took longer than the site's time limit or more memory than its limit (see [Limits](#limits)). Nothing was written. Split it into smaller writes, or write less formatting into one paragraph or into deeply nested quotes.
- **`400 empty_section`.** `delete_section` was pointed at a section with no blocks — usually `_top` on a note that starts with a heading, or a note with no content at all.
- **`400 empty_content`.** The Markdown parsed to nothing (it was blank or only whitespace). To empty a section, delete it; to empty a note, `replace_all` still needs something to write.
- **`429 too_many_requests`.** See [Limits](#limits). A token pays both its own bucket and the per-user one for these endpoints, so the tighter of the two is what you actually get.
- **The write succeeded but a link to a note is missing from the target note's backlinks.** The link index can lag briefly; it catches up the next time that note's link set changes or a browser reconnects to it. See [Known limitations](./known-limitations.md).

See also: [API tokens](./api-tokens.md) · [API contract summary](./api.md) · [Known limitations](./known-limitations.md).
