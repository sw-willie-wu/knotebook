# Version history

How Knotebook keeps earlier states of a note, when it saves them, and what you can do with them.

## What a version is

A version is a copy of the whole note as it was at one moment. Versions are numbered v1, v2, … in the order they are saved. Deleting a version doesn't free its number: the next version still gets the next number. The numbering starts again at v1 only when a note's whole history is cleared (see [Moving, copying and transferring](#moving-copying-and-transferring)).

Each version lists the people who changed the note since the version before it — an AI agent's changes show as the person's name followed by the agent's name in parentheses — and, for a new version saved by hand, the person who saved it. A version records who took part, not who wrote which word.

## When versions are saved

**Automatically**, as long as automatic versions are on for the note (see [Turning automatic versions off](#turning-automatic-versions-off)):

- once a note whose content has changed goes 5 minutes without further changes;
- when everyone has left a note that has changes not yet in a version, without waiting for the 5 minutes;
- around a write by an AI assistant (through the API or MCP), including reverting one: if there are human changes that aren't in a version yet, they are saved as a version first, and the assistant's write is then saved as a version of its own.

A version is saved automatically only when the content has actually changed: opening a note and closing it again doesn't save a version, nor does typing something and deleting it again, and block attributes that merely restate the editor's defaults (for example a paragraph aligned left) don't count as a change.

**By hand**: choose **Save current version** from the `⋮` menu at the top of the note (the `⋮` on a note's row in the sidebar doesn't have it), press **Ctrl+S** (**Cmd+S** on a Mac), or use **Save current version** at the bottom of the version list. A dialog asks for an optional **Version name** (up to 120 characters). Ctrl+S is left to the browser while another dialog or a drop-down menu (such as a `⋮` menu) is open — the full-screen version history on a narrow window counts as a dialog, the sidebar on a narrow window doesn't — and during a presentation; on a note you can only view, it is always left to the browser. If the note's content is the same as the version it is based on, no new version is created: that version is turned into a manual one (and given the name, if you entered one), and the notice says so.

**Nothing else creates a version.** A note that existed before version history was added has no versions until its content changes, and the content it had before that first change is not kept as a version. A copied or moved note has no versions until its content changes (or a version is saved by hand) in its new place.

## The current state and the base

At the top of the list, **Current state** describes how the note's content relates to its versions. The version the current content is based on — the one last saved, or the one last applied — is the **base**, and its row has a green dot. The line under **Current state** is one of:

- **No versions yet**
- **No base version** — there are versions, but the current content isn't based on any of them. This happens when the version being applied is deleted at that same moment (see [Known limitations](./known-limitations.md#version-history)).
- **= vN, no unsaved changes**
- **Unsaved changes after vN** — vN is the newest version.
- **Continued from vN, with unsaved changes** — vN is an older version that was applied.

When automatic versions are off for the note, a second line says **Automatic saving is off for this space**.

A version saved while its base was not the newest version in the list — that is, after an older version was applied and while a newer version still exists — says **continued from vN** on its row.

## Previewing and comparing

On a wide window, open the history with the round **Version history** button at the bottom right of the note, or from **Version history** in the `⋮` menu at the top of the note. The list opens beside the note.

Click a row to preview that version; its content isn't loaded until you do. The ↑ and ↓ keys move between rows and preview each one. While you preview, a bar under the page header shows the version and lets you choose:

- What to compare, as a pair: on the left the version you clicked, on the right **Current state** by default — the note's content when you picked the pair; it doesn't follow edits made while you look. Both sides are menus listing the versions (the right one also lists **Current state**), so you can compare any two versions; the changes always read from the left side to the right side, whichever of the two is newer. Clicking another row changes only the left side; the right side stays as you set it until you close the preview. While the versions are shown side by side, the two menus head the two columns; otherwise they sit in the bar, left → right. **Apply vN** always applies the left side.
- **Side by side** or **Single column**. When the preview area is at least 720 pixels wide, the two versions are shown side by side unless you pick **Single column**. When it is narrower, there is only a single column and these two buttons aren't shown; if you had picked **Side by side**, it comes back once the area is wide enough again.
- **Only changes**, which folds runs of unchanged blocks into one line. It works only in a single column: while the versions are shown side by side, it is greyed out and can't be switched.

Added, deleted, changed and moved blocks are marked with a colored bar at their left, and changed text shows what was removed and what was added. For a changed block that isn't text, such as an image, **Changed · see before and after** opens both versions of it.

Previewing doesn't change the note, and the editor stays open underneath: other people's edits keep arriving. Close the preview with ✕ in the bar or with Esc.

On a narrow window (narrower than 768 pixels) there is no **Version history** button: choose **Version history** from the `⋮` menu. It opens full screen: tap a version to see its changes in a single column, with the same pair of menus at the top and **Older version**, **Apply vN** and **Newer version** at the bottom (these two change the left side only). Esc goes back from a version to the list, and from the list closes the history.

## Applying a version

Applying a version makes its content the note's current content, for everyone who has the note open. It is not a rollback: the versions after it stay in the list, applying doesn't create a version, and the applied version becomes the base. If the applied version isn't the newest one, the next version saved after it is marked **continued from vN** — unless every newer version has been deleted by then. To get back, apply another version.

Choose **Apply vN** at the bottom of the list, or **Apply** from a row's `⋯` menu. If the note has changes that aren't in a version yet — yours or anyone else's — a dialog offers three choices:

- **Cancel**
- **Apply without saving** — those changes are overwritten.
- **Save current version** — opens the save dialog, and once the version is saved, applies.

Applying never saves those changes on its own. Ctrl+Z can't undo an apply; apply another version instead.

## Renaming and deleting

**Edit version name** in a row's `⋯` menu renames a version. Editing the name of an automatic version — even clearing it — turns it into a manual version, which retention never removes (see [Retention](#retention)).

**Delete** removes a version from the history; the note's content doesn't change. The base version can't be deleted.

## Who can see history

Anyone who can edit a note can see its history and save, preview, apply, rename and delete its versions. On a group note, that is a role with the Edit permission (see [Sharing](./sharing.md#notes-in-a-group)). People who can only view a note, and visitors to a public link, see only the current content. Site admins have no extra access to other people's notes' history.

## Moving, copying and transferring

- **Copying** a note doesn't copy its versions; the copy starts with none.
- **Moving** a personal note into a group, and **transferring** a group's notes to a person when the group is deleted, deletes the note's versions: the history of a note's earlier life isn't shown to its new owners. The next version is v1.
- **Deleting** a note deletes its versions.

## Retention

Retention never removes manual versions, the base version or the newest version. Older automatic versions are thinned out:

- from the last **F** days, all are kept;
- from **F** days ago up to **D** days ago, the latest one of each day is kept;
- from **D** days ago or more, the latest one of each week is kept.

Days and weeks are counted in UTC, and weeks start on Monday at 00:00 UTC. F and D default to 7 and 30; a site admin changes them in **Site admin → Version history** (**Keep all for (days)** and **One a day until (days)**), with 1 ≤ F ≤ D ≤ 3650. Nothing is deleted at the moment you save the setting: a note is cleaned up each time a new version of it is saved, and a background pass runs every hour.

## Turning automatic versions off

There are three switches named **Automatic versions**:

- **Site admin → Version history** — for the whole site. When it is off, the other two can't be changed, and they say that the site has turned automatic saving off.
- **Settings → Account** — for your personal notes.
- A group's page in **Settings → Groups** — for the group's notes; only members whose role has **Manage roles & group** (and site admins) can change it.

A note gets automatic versions only when both the site switch and the switch of the space it belongs to (your personal space, or its group) are on. A change reaches a note that is open right now only after everyone has closed it. With automatic versions off, you can still save versions by hand.

## Storage

Versions don't count toward a space's storage limit, and there is no site-wide limit on their total size; the retention settings above are what keeps automatic versions in check.

## API

See **Note versions** in the [API contract summary](./api.md) for the endpoints behind version history and exactly when a version is saved automatically.
