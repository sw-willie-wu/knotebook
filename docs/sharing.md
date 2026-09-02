# Sharing

How a note gets from "only I can see this" to "anyone with the link can read it", and what each step actually grants.

## The three access levels

The Share dialog on a note (owner only) presents one choice with three levels:

- **Private** — only the owner. Picking this while the note has **members** shows an inline confirmation first, because removing people is destructive; the confirmation text also mentions the public link (including any custom public URL) when one is on, and confirming removes both — the link first, then the members — so if the operation is interrupted partway the worst case is "some members remain", never "the link is still live". With no members, switching to Private simply turns the public link off, no confirmation step.
- **Members only** — people the owner invites by email, each with a role (**editor** can change content, **viewer** can only read). Members use their own accounts, see the note in their sidebar, and get live collaboration. Picking this while a public link exists turns the link off; the member list is untouched.
- **Public link** — anyone who has the link can **read** the note, no account needed. Members keep working exactly as before; the link is an addition, not a replacement.

The selector is an action trigger, not a live mirror: adding your first member while "Private" is selected doesn't flip the radio, and the choice you make sticks until you close the dialog.

## What a public link is

Turning on **Public link** generates an unguessable token (`base64url(randomBytes(32))`, 43 characters) and gives you a URL of the form `https://your-host/p/<token>`. That page:

- requires no login, and never redirects to one;
- is **read-only** — there is no anonymous editing, and the page ships none of the editing machinery;
- shows the note's title and content, including images uploaded to that note (served through a public image endpoint that the token authorizes — see the `/api/public/...` rows in the [API contract summary](./api.md));
- shows **no** backlinks, no AI actions, and no timestamp (the note record's timestamp only tracks title/slug changes, not content edits, so showing it would mislead);
- is sent with `X-Robots-Tag: noindex`, so well-behaved search engines won't index it. The link itself is still a capability: anyone it's forwarded to can read the note.

**The content is a snapshot, not a live view.** Anonymous readers get the state the collaboration server last persisted — during active editing that lags the editors by roughly the persistence debounce (about 2 seconds, up to 10 seconds under continuous typing, flushed when the last editor disconnects). Reloading the page fetches a fresh snapshot. Live sync for anonymous readers is deliberately out of scope.

## Custom public URL

While a public link is on, the dialog also offers an optional **custom public URL** of the form `https://your-host/p/<your-username>/<name-you-choose>`. It serves the exact same read-only page (including images), and it is an *addition* — the token link keeps working alongside it. What it changes is the trade-off:

- **Readable and memorable** — you can put it on a slide or say it out loud.
- **Guessable, and it reveals your username.** Anyone who can guess `/p/alice/roadmap` can read the note, and the URL itself tells them the note belongs to `alice`. For anonymous sharing, use the token link and leave the custom URL unset.
- The custom-URL page carries the same `X-Robots-Tag: noindex` as the token page.
- Renaming your account (changing your username) kills the old custom URL immediately — old usernames are never forwarded — while the token link is unaffected.
- Removing the custom URL (its own **Remove** button) leaves the token link alive; **Regenerate link** replaces the token but leaves the custom URL alone; switching to **Members only**/**Private** deletes both. The name is unique per account: two of your notes can't share one, but another user's `roadmap` doesn't collide with yours.

## Revoking and regenerating

- **Regenerate link** mints a new token in place. The old URL stops working immediately (byte-identical 404 with any other unknown token); the new one takes over. Use it when a link has spread further than intended but you still want one.
- Switching to **Members only** or **Private** deletes the token — and the custom public URL with it, in the same update. The public endpoints answer 404 immediately (`Cache-Control: no-store` on the content response means no cache keeps serving it) — with one caveat: images an anonymous reader's browser has *already* downloaded may remain in that browser's cache, same as the revoked-member case in [known limitations](./known-limitations.md).
- Deleting the note deletes the link with it.

Tokens are stored as-is (not hashed) so the dialog can always show you the current link — the trade-offs behind that, and the other sharp edges (what a Yjs snapshot exposes, cross-note images, the `TRUST_PROXY` interaction with the public endpoints' rate limiting), are collected in [known limitations](./known-limitations.md); the deployment side is in the [self-hosting guide](./self-hosting.md).
