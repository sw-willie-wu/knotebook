# Sharing

How a note gets from "only I can see this" to "anyone with the link can read it", and what each step actually grants.

## The three access levels

The Share dialog on a **personal** note (owner only) presents one choice with three levels (a note that belongs to a group has a different, two-level dialog — see [Notes in a group](#notes-in-a-group); both kinds of note also have a **Group** row at the bottom, on a personal note only once you belong to a group, see [Moving a note into or out of a group](#moving-a-note-into-or-out-of-a-group)):

- **Private** — only the owner. Picking this while the note has **members** shows an inline confirmation first, because removing people is destructive; the confirmation text also mentions the public link (including any custom public URL) when one is on, and confirming removes both — the link first, then the members — so if the operation is interrupted partway the worst case is "some members remain", never "the link is still live". With no members, switching to Private simply turns the public link off, no confirmation step.
- **Members only** — people the owner invites by email, each with a role (**editor** can change content, **viewer** can only read). Members use their own accounts, see the note in their sidebar, and get live collaboration. Picking this while a public link exists turns the link off; the member list is untouched.
- **Public link** — anyone who has the link can **read** the note, no account needed. Members keep working exactly as before; the link is an addition, not a replacement.

The selector is an action trigger, not a live mirror: the choice you make sticks until you close the dialog.

## Notes in a group

A note can belong to one group (see the **Workspace** section of the sidebar). For such a note the Share dialog has two levels instead of three:

- **Group members** — every member of the group has access at the note's group level: can edit by default, or read-only — the owner switches this in the dialog's **Group** row (see [Moving a note into or out of a group](#moving-a-note-into-or-out-of-a-group)). There is no per-person sharing on a group note: the member list you see in the dialog is the group's member list, and inviting someone means adding them to the group (if you own the note and are a group admin you can add them right there; if you own it but aren't an admin, the dialog links to the group's settings page instead; if you've left the group, it just says so — as with personal notes, only the owner sees the Share dialog at all).
- **Public link** — exactly as for a personal note; switching back to **Group members** turns the link off.

Groups themselves — creating one, renaming it, adding and removing people, leaving, deleting — live in **Settings → Groups**, with shortcuts on each group's `⋮` menu in the sidebar. Deleting a group turns its notes back into personal notes and keeps everyone's access as per-person shares at the note's group level. Being removed from a group (or leaving it) takes effect immediately, the same way a revoked share does.

## Moving a note into or out of a group

The owner does this in the **Group** row at the bottom of the Share dialog. It lists only the groups you belong to — you can't move a note into a group you aren't a member of — so on a personal note the row only appears once you belong to at least one group. Right before sending anything, the dialog checks the note's group again: if it no longer matches what the dialog shows (for example, it was changed in another tab or on another device, or its group was deleted), nothing is sent — the dialog reloads and tells you so. A change that lands after that check is not caught; see [Known limitations](./known-limitations.md).

- **Into a group** — from a personal note, or from another group. Every member of that group can then open and edit the note. Moving it removes all of the note's per-person shares and turns off its public link, custom public URL included; the confirmation lists the people you invited, who lose their individual invites (they keep access only if they're also members of the group), and says so when the link will be turned off. Moving a note from one group to another also takes access away from members of the old group who aren't in the new one. Anyone who loses access this way is disconnected from the note.
- **Out of its group** — pick **None**. The note becomes a personal note again and the group's members lose access; their open editors are disconnected. The public link, if there is one, stays on.
- **Can edit / Read-only** — what the group's members can do. Switching to read-only disconnects nobody: members who have the note open stay connected, their editor becomes read-only, and they're told their access changed. Switching back to can-edit restores editing the same way.

If you've left (or been removed from) the group that a note of yours is in, the note stays in that group, and the row shows the group's name instead of the list: you can still switch the level or take the note out of the group there, but not move it straight to another group.

## What a public link is

Turning on **Public link** generates an unguessable token (`base64url(randomBytes(32))`, 43 characters) and gives you a URL of the form `https://your-host/p/<token>`. That page:

- requires no login, and never redirects to one;
- is **read-only** — there is no anonymous editing, and the page ships none of the editing machinery;
- shows the note's title and content, including images uploaded to that note (served through a public image endpoint that the token authorizes — see the `/api/public/...` rows in the [API contract summary](./api.md));
- shows **no** backlinks, no AI actions, and no timestamp (the note record's timestamp only tracks title/slug changes, not content edits, so showing it would mislead);
- is sent with `X-Robots-Tag: noindex`, so well-behaved search engines won't index it. The link itself is still a capability: anyone it's forwarded to can read the note.

**The content is a snapshot, not a live view.** Anonymous readers get the state the collaboration server last persisted — during active editing that lags the editors by roughly the persistence debounce (about 2 seconds, up to 10 seconds under continuous typing, flushed when the last editor disconnects). Reloading the page fetches a fresh snapshot. Live sync for anonymous readers is deliberately out of scope.

## Anonymous link and the custom public URL

While a public link is on, an **Anonymous link** toggle (on by default) controls the trade-off between two forms the same public URL can take:

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
- Switching to **Members only** or **Private** deletes the token — and the custom name with it, in the same update. The public endpoints answer 404 immediately (`Cache-Control: no-store` on the content response means no cache keeps serving it) — with one caveat: images an anonymous reader's browser has *already* downloaded may remain in that browser's cache, same as the revoked-member case in [known limitations](./known-limitations.md).
- Deleting the note deletes the link with it.

Tokens are stored as-is (not hashed) so the dialog can always show you the current link — the trade-offs behind that, and the other sharp edges (what a Yjs snapshot exposes, cross-note images, the `TRUST_PROXY` interaction with the public endpoints' rate limiting), are collected in [known limitations](./known-limitations.md); the deployment side is in the [self-hosting guide](./self-hosting.md).
