# Sharing

How a note gets from "only I can see this" to "anyone with the link can read it", and what each step actually grants.

## The three access levels

The Share dialog on a **personal** note (owner only) presents one choice with three levels (a note that belongs to a group has a simpler dialog — see [Notes in a group](#notes-in-a-group)):

- **Private** — only the owner. Picking this while the note has **members** shows an inline confirmation first, because removing people is destructive; the confirmation text also mentions the public link (including any custom public URL) when one is on, and confirming removes both — the link first, then the members — so if the operation is interrupted partway the worst case is "some members remain", never "the link is still live". With no members, switching to Private simply turns the public link off, no confirmation step.
- **Members only** — people the owner invites by email, each with a role (**editor** can change content, **viewer** can only read). Members use their own accounts, see the note in their sidebar, and get live collaboration. Picking this while a public link exists turns the link off; the member list is untouched.
- **Public link** — anyone who has the link can **read** the note, no account needed. Members keep working exactly as before; the link is an addition, not a replacement.

The selector is an action trigger, not a live mirror: the choice you make sticks until you close the dialog.

## Notes in a group

A note can belong to one group (see the **Workspace** section of the sidebar). A group note belongs to the group, not to a person: nobody owns it, and what you can do with it comes from your role in the group. Every role can read the group's notes. On top of that, a role allows any combination of six permissions — they are independent of each other:

- **Create** — create notes in the group. It doesn't include Edit: if your role can create notes but not edit them, a note you create is read-only for you too. In the web app the **+** next to the group's name appears only for roles that can both create and edit, so a role with Create alone can't start a new note from the sidebar: it can create one only through the API (`POST /api/notes` with `groupId`; `POST /api/notes/:id/copy` with `groupId`, which copies any note they can read into the group; or `POST /api/notes/:id/move`, which moves a personal note they own into it; see the [API contract summary](./api.md)), from an AI assistant connected over MCP (`create_note` with `groupId`; see [MCP](./mcp.md)), or by moving or copying a personal note into the group from that note's Share dialog (see [Moving or copying a note into a group](#moving-or-copying-a-note-into-a-group)). In every case the note is read-only for them.
- **Edit** — change the content and title of the group's notes.
- **Delete** — delete any note in the group, including ones other people created.
- **Manage public links** — turn the anonymous public link of the group's notes on and off, and give a note a custom URL name (an API-only feature, see the [API contract summary](./api.md)).
- **Manage members** — add and remove people and change their roles (except that a group always keeps at least one Admin), including making anyone, themselves included, an Admin.
- **Manage roles & group** — rename or delete the group, and create, change and delete its roles.

A group starts with two built-in roles. **Admin** always has every permission and can't be changed. **Member** is the role new members get unless someone picks another, and it starts with Create and Edit: members can read, create and edit notes, but not delete them — not even the ones they created. People whose role can manage roles and the group can change Member's permissions (but not rename or delete it) and can create more roles, on the group's **Roles** tab; a new role starts with none of the six turned on, so the people who hold it can only read. Every member can see the group's roles. There is no per-person sharing on a group note: to let someone in, add them to the group.

Changing someone's role, or a role's permissions, takes effect on the next request; an editor someone already has open follows within a few seconds. On a group note someone has open, losing Edit turns their editor read-only, and getting Edit back makes it editable again — normally without closing the editor (if their browser doesn't answer the server's re-check in time, the connection is dropped and reconnects with the new role). Changing any of a role's other permissions leaves open editors alone, and the next request that needs a permission the person no longer has is refused. Since every role can read, nobody loses read access to a note because of a role change. Deleting a role moves the people who had it to Member.

Two of the permissions can be used to gain the others: someone whose role can manage members can make anyone — themselves included — an Admin, and someone whose role can manage roles and the group can give their own role Manage members. Keeping them apart is a convenience, not a security boundary: give either one only to people you would trust as an Admin.

Group notes live at `https://your-host/g/<group id>/<name>`; the name is unique within the group. If your server ran a pre-release build that already had groups (a build of the `main` branch from after #103 and before migration 0012), notes that were already in a group when it was upgraded moved to that form, and their old `/n/<username>/<name>` address keeps forwarding to the new one for a month — unless the person whose username is in it gives one of their own notes the same name in the meantime, which then takes the address over for as long as it keeps that name. The same one-month forwarding applies to a personal note you move into a group (see below). When a group is deleted and its notes are given to an admin, each note's old `/g/` address forwards to its new address the same way, for a month — but only for people who can read the note, which right after the deletion means only that admin (see below).

The Share dialog on a group note explains who has access and links to the group's settings. If your role can manage public links, it also has a **Public link** switch — the same anonymous link as on a personal note (a group note has no custom public URL). Anyone who can read the note sees the Share button. If your role can't manage public links, neither the button nor the dialog tells you whether the note has a public link: they show only the group's access, even when the note is also public.

Groups themselves — creating one, renaming it, adding and removing people, changing someone's role, defining roles (the group's **Roles** tab), leaving — live in **Settings → Groups**, with shortcuts on each group's `⋮` menu in the sidebar. Being removed from a group (or leaving it) takes effect immediately, the same way a revoked share does (a note you have open closes within a few seconds — see [Known limitations](./known-limitations.md)).

A group can be deleted by people whose role can manage roles and the group (and by site admins), from **Delete group** in the group's `⋮` menu or its settings page. Deleting it asks what happens to its notes:

- **Give them to an admin** — every note in the group becomes the personal note of the group's Admin you pick (you, if you are one). Its address changes from `/g/…` to `/n/<that person's username>/…`, keeping its name unless that person already has a note by that name, in which case a number is added. The old `/g/` address forwards to the new one for a month, but only for that admin — for everyone else it's a 404, because everyone else in the group loses access to the notes, and a note they have open closes within a few seconds. The notes' public links are turned off too (both the anonymous link and any custom public URL), so each one ends up as an unshared personal note; a public page someone already has open stops working when it's reloaded. The notes keep their AI edit history, their attachments and the links between them and other notes.
- **Delete everything** — the notes, their attachments and their AI edit history are permanently deleted with the group (you have to tick a confirmation first). Someone who has one of the notes open is told "This note has been deleted." (with an exception described in [Known limitations](./known-limitations.md)).

## Moving or copying a note into a group

The Share dialog on a personal note you own has a **Move or copy into a group** row, which lists the groups where your role can create notes (the row isn't shown if there are none). Pick a group, then:

- **Move** hands the note over to the group. Before anything happens, an inline confirmation says what the move does: its per-person shares are removed (it names the people; anyone who isn't also in the group loses access, and a note they have open closes within a few seconds), its public link is turned off (when it has one), its address changes, and you stop owning it — what you can do with it afterwards depends on your role in the group. The custom public URL, if the note had one, goes with the public link. The note's new address is `https://your-host/g/<group id>/<name>`: it keeps its name, unless the group already has a note by that name, in which case a number is added. Its old `/n/<username>/<name>` address forwards to the new one for a month; if you had changed the note's URL name earlier, the name it had before that stops working. Its AI edit history, its attachments and the links between it and other notes stay with it. If the note has changed hands elsewhere by the time you confirm — say, you already moved it from another tab — nothing is moved, and a notice says so.
- **Copy** creates a new note in the group and leaves the original as it is. The copy gets its own copies of the note's attachments, so its images don't depend on the original — deleting the original doesn't break them (the exceptions are in [Known limitations](./known-limitations.md)). The original's AI edit history, backlinks, per-person shares and public link are not copied.

Any group note you can read can be copied to your own notes with **Copy to my notes**, in its Share dialog or its `⋮` menu; the copy gets its own copies of the attachments the same way. After a copy is made, a notice offers **Open copy**; a copy made from the Share dialog also closes the dialog, returning focus to the **Share** button. Copying counts against your upload limit, one unit per attachment — see the `copy` row of the [API contract summary](./api.md).

A single note can't be taken out of a group — to get a personal version, copy it. Deleting the whole group is the exception: it can give all of the group's notes to one of its admins (see [Notes in a group](#notes-in-a-group)).

## What a public link is

Turning on **Public link** generates an unguessable token (`base64url(randomBytes(32))`, 43 characters) and gives you a URL of the form `https://your-host/p/<token>`. That page:

- requires no login, and never redirects to one;
- is **read-only** — there is no anonymous editing, and the page ships none of the editing machinery;
- shows the note's title and content, including images uploaded to that note (served through a public image endpoint that the token authorizes — see the `/api/public/...` rows in the [API contract summary](./api.md));
- shows **no** backlinks, no AI actions, and no timestamp (the note record's timestamp only tracks title/slug changes, not content edits, so showing it would mislead);
- is sent with `X-Robots-Tag: noindex`, so well-behaved search engines won't index it. The link itself is still a capability: anyone it's forwarded to can read the note.

**The content is a snapshot, not a live view.** Anonymous readers get the state the collaboration server last persisted — during active editing that lags the editors by roughly the persistence debounce (about 2 seconds, up to 10 seconds under continuous typing, flushed when the last editor disconnects). Reloading the page fetches a fresh snapshot. Live sync for anonymous readers is deliberately out of scope.

## Anonymous link and the custom public URL

On a personal note, while a public link is on, an **Anonymous link** toggle (on by default) controls the trade-off between two forms the same public URL can take (a group note's public link is always the anonymous token form):

- **Anonymous link on** (the default) — the URL is `https://your-host/p/<token>`.
- **Anonymous link off** — the URL becomes `https://your-host/p/<your-username>/<name-you-choose>` (a random name to start; you can edit it and save a custom one). It serves the exact same read-only page (including images) as the token URL.

Turning the toggle off doesn't add a second URL alongside the token one — it replaces which form the single public URL takes. What it changes is the trade-off:

- **Readable and memorable** — you can put it on a slide or say it out loud.
- **Guessable, and it reveals your username.** Anyone who can guess `/p/alice/roadmap` can read the note, and the URL itself tells them the note belongs to `alice`. For anonymous sharing, keep **Anonymous link** turned on.
- The custom-URL page carries the same `X-Robots-Tag: noindex` as the token page.
- Renaming your account (changing your username) kills the old custom URL immediately — old usernames are never forwarded — while the underlying token is unaffected.
- Turning **Anonymous link** back on returns the URL to the token form; the custom name is unique per account: two of your notes can't share one, but another user's `roadmap` doesn't collide with yours.

## Revoking and regenerating

- **Regenerate link** mints a new token. With **Anonymous link** on, that's the whole story: the old URL stops working immediately (byte-identical 404 with any other unknown token) and the new one takes over. With **Anonymous link** off, it replaces **both** the token and the custom name — a new random name as well as a new token — so the exact custom URL that was leaked stops working too, not just its underlying token; the custom URL doesn't just point at the same still-guessable name with a fresh token behind it. Use it when a link has spread further than intended but you still want one.
- Switching to **Members only** or **Private** (on a group note, turning the **Public link** switch off) deletes the token — and the custom name with it, in the same update. The public endpoints answer 404 immediately (`Cache-Control: no-store` on the content response means no cache keeps serving it) — with one caveat: images an anonymous reader's browser has *already* downloaded may remain in that browser's cache, same as the revoked-member case in [known limitations](./known-limitations.md).
- Deleting the note deletes the link with it.

Tokens are stored as-is (not hashed) so the dialog can always show you the current link — the trade-offs behind that, and the other sharp edges (what a Yjs snapshot exposes, cross-note images, the `TRUST_PROXY` interaction with the public endpoints' rate limiting), are collected in [known limitations](./known-limitations.md); the deployment side is in the [self-hosting guide](./self-hosting.md).
