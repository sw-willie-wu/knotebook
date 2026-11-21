# Known limitations

This is the complete reference: every known rough edge and deliberate trade-off, down to small details of layout, timing and individual endpoints, on one page per topic. If you are deciding whether to deploy Knotebook or trust it with your notes, read [Limitations worth knowing](./limitations.md) first; it collects the ones that matter for that and links to the pages here.

Per-person rate figures in these pages for API and MCP reads and writes, note content reads and writes, searches, uploads and copies, AI actions, bulk downloads and bulk write-backs are the defaults; a site admin can lower each of them in Site admin → Site limits (see [Site limits](./self-hosting.md#site-limits)). The other rate limits are fixed.

Each section below names one page and lists the bold headings of its entries; follow a heading to the page that holds the entry.

## Editing notes

[Editing notes](./known-limitations/editor.md): undo and redo, dragging blocks, the heading outline, block handles, custom colors and pasting text.

- [Redoing across an "undone to empty" boundary while a collaborator is typing can leave a stray empty block.](./known-limitations/editor.md)
- [A collaborator's edits to the blocks you are dragging can be lost.](./known-limitations/editor.md)
- [The editor's collaboration library, y-prosemirror, is patched.](./known-limitations/editor.md)
- [Only headings of level 1 to 3 appear in the heading outline.](./known-limitations/editor.md)
- [Tabbing out of the outline to the browser's address bar, or past the end of the page, can leave the floating outline panel open.](./known-limitations/editor.md)
- [Scrolling by hand, or pressing a scroll key outside the outline's list (on its rail or buttons, or while typing), moves the highlighted heading back to where the page actually is.](./known-limitations/editor.md)
- [With the outline pinned, typing a note's first heading, or deleting its last one, makes the text column move or narrow at once instead of sliding.](./known-limitations/editor.md)
- [On a phone or a window narrower than 768px, the heading outline is reached from a bubble that appears only while you scroll, or from the note's ⋮ menu.](./known-limitations/editor.md)
- [Pasting a plain-text file view (a `/raw/` URL) can be parsed as Markdown even when the file is source code.](./known-limitations/editor.md)
- [Pasting a large amount of plain text into an ordinary paragraph is slow in the browser, and very large pastes never arrive.](./known-limitations/editor.md)
- [On a window between 640px and 767px wide, a block's hover handles are partially clipped.](./known-limitations/editor.md)
- [On a window narrower than 640px, three block actions have no entry point.](./known-limitations/editor.md)
- [A note with thousands of distinct custom colors loads more slowly.](./known-limitations/editor.md)

## Links and links to notes

[Links and links to notes](./known-limitations/links.md): typed Markdown links, the "opens in a new tab" icon, links to notes and how links become them, link toolbars and backlinks.

- [The "opens in a new tab" icon on a link can wrap onto a line of its own.](./known-limitations/links.md)
- [A few unusual ways of writing a web address get no "opens in a new tab" icon.](./known-limitations/links.md)
- [A note's backlinks reflect whoever most recently wrote its outgoing link set, filtered to what *they* could see at the time.](./known-limitations/links.md)
- [`GET /api/notes/:id/backlinks` is capped at 200 results (`MAX_BACKLINKS`), most-recently-updated first, with no pagination.](./known-limitations/links.md)
- [`POST /api/notes/:id/links` has no rate limit.](./known-limitations/links.md)
- [The note list has no pagination](./known-limitations/links.md)
- [Typing a markdown link where the URL contains an unescaped `)` closes the link at that first `)`, leaving the rest as plain text.](./known-limitations/links.md)
- [A typed markdown link only converts when the whole markdown syntax reconstructs back to exactly what you typed — a title, angle brackets around the URL, a trailing space inside the parentheses, or styled display text all block that.](./known-limitations/links.md)
- [Typing a markdown link does nothing while a suggestion menu is open](./known-limitations/links.md)
- [Backspace right after a link forms usually reverts it to plain text — but a collaborator editing the note anywhere in the meantime cancels that, so Backspace just deletes a character like normal.](./known-limitations/links.md)
- [A markdown link won't convert if a wikilink sits inside the `[…](…)` syntax itself — one elsewhere in the same paragraph doesn't stop it.](./known-limitations/links.md)
- [Typing `![a](url)` character by character never turns it into an image.](./known-limitations/links.md)
- [A markdown link doesn't convert while you're typing inside bold or italic text.](./known-limitations/links.md)
- [A markdown link near the end of a very long paragraph can fail to convert once the link's own syntax is close to or past about 500 characters.](./known-limitations/links.md)
- [Typing the closing `()` first and filling in the display text or URL afterwards never turns it into a link.](./known-limitations/links.md)
- [Turning a link into a link to a note drops its formatting.](./known-limitations/links.md)
- [Two ordinary links with the same address that touch become one link to a note.](./known-limitations/links.md)
- [A link to a note the writer can't see stays an ordinary link — even for readers who can see that note.](./known-limitations/links.md)
- [Some links to this site never become links to notes.](./known-limitations/links.md)
- [Dragging a note from the sidebar's Recent or Favorites tab into a note adds the note's title and its location as two paragraphs of their own, each a link to the note.](./known-limitations/links.md)
- [A pasted, dragged-in or typed link that the page has to look up on the server becomes a link to a note a moment later.](./known-limitations/links.md)
- [An ordinary link whose text is a single character can't open its toolbar.](./known-limitations/links.md)
- [A stylus that can't hover has no way to open a link to a note's toolbar.](./known-limitations/links.md)
- [The toolbar of a link to a note can't be opened from the keyboard.](./known-limitations/links.md)
- [The "#" button that copies a link to a heading needs a mouse pointer or the text cursor.](./known-limitations/links.md)
- [Writing back a link to a note you can't see, that was deleted, or that is in the trash, turns it into an ordinary link.](./known-limitations/links.md)
- [In a group note, the one-time conversion after upgrading only converts links to notes in the same group.](./known-limitations/links.md)
- [A link to a block that was later deleted still opens the note, at the top.](./known-limitations/links.md)
- [Over MCP and the API, only a note's current address becomes a link to the note.](./known-limitations/links.md)
- [Links the in-app AI writes are only matched against your note list.](./known-limitations/links.md)
- [Right after upgrading, an ordinary link written into an older note before the conversion reaches that note is converted with the owner's permissions.](./known-limitations/links.md)
- [Notes created after the upgrade are not converted.](./known-limitations/links.md)

## Side-by-side columns

[Side-by-side columns](./known-limitations/side-by-side-columns.md): rows of columns in the editor, in presentations and over the API and MCP.

- [Columns line up at the top, so a shorter column leaves blank space below it.](./known-limitations/side-by-side-columns.md)
- [Blocks in a column have no `+` button.](./known-limitations/side-by-side-columns.md)
- [A heading inside a column doesn't start a section.](./known-limitations/side-by-side-columns.md)
- [Removing or replacing what is in a column never removes the column.](./known-limitations/side-by-side-columns.md)
- [A selection that only touches a row at its edge also makes the in-app AI work on the whole row.](./known-limitations/side-by-side-columns.md)
- [When a selection that starts inside a row taller than the window opens the AI box, the box can be out of view.](./known-limitations/side-by-side-columns.md)
- [Deleting a selection that spans columns leaves the columns in place.](./known-limitations/side-by-side-columns.md)
- [Backspace and Delete remove a column only when it is empty, with two exceptions.](./known-limitations/side-by-side-columns.md)
- [Some Backspace and Delete presses move a block into or out of a row.](./known-limitations/side-by-side-columns.md)
- [Selecting across columns and then deleting or typing removes the columns in between.](./known-limitations/side-by-side-columns.md)
- [Copying part of a row and pasting it outside the row can make a new row.](./known-limitations/side-by-side-columns.md)
- [Copying a row to another app flattens it in the plain-text copy.](./known-limitations/side-by-side-columns.md)
- [Editing a row while someone else edits the same row can lose their typing.](./known-limitations/side-by-side-columns.md)
- [Two people adding a column to the same row at the same moment can end up with five columns.](./known-limitations/side-by-side-columns.md)
- [A pasted row keeps all of its columns, even more than four.](./known-limitations/side-by-side-columns.md)
- [Making columns by dragging is meant for a mouse.](./known-limitations/side-by-side-columns.md)
- [Dragging a column's only block to the side of another block in the same row leaves an empty column.](./known-limitations/side-by-side-columns.md)
- [The columns of a row of four can't be reordered by dragging.](./known-limitations/side-by-side-columns.md)
- [Equal heights for pictures are worked out only when a drag makes the row or adds the column, and small pictures aren't enlarged.](./known-limitations/side-by-side-columns.md)
- [Holding Ctrl (⌥ on a Mac) while dragging a block copies it and doesn't make columns.](./known-limitations/side-by-side-columns.md)
- [Dropping a block beside another one has no keyboard shortcut.](./known-limitations/side-by-side-columns.md)
- [Dragging an already-selected image by the picture itself doesn't make columns.](./known-limitations/side-by-side-columns.md)
- [In the gap between two columns, the guide you see can differ from where the block lands.](./known-limitations/side-by-side-columns.md)
- [While something is being dragged, the formatting toolbar and its own pop-ups don't accept drops.](./known-limitations/side-by-side-columns.md)
- [Making an image in a column smaller doesn't make the column narrower again.](./known-limitations/side-by-side-columns.md)
- [An image can't be dragged wider once the other columns are down to their minimum widths.](./known-limitations/side-by-side-columns.md)
- [Every divider between columns is a Tab stop, so a note with many rows needs extra Tab presses to get past them.](./known-limitations/side-by-side-columns.md)
- [When two people resize the same row at the same moment, one person's change can be lost.](./known-limitations/side-by-side-columns.md)
- [In a presentation, whether a row stacks is decided when its slide is shown.](./known-limitations/side-by-side-columns.md)
- [Columns in a presentation have no minimum width.](./known-limitations/side-by-side-columns.md)
- [Rolling back to an earlier version deletes side-by-side columns, together with what is in them.](./known-limitations/side-by-side-columns.md)

## Presentations

[Presentations](./known-limitations/presentations.md): presenting a note as slides.

- [A presentation opened from a public link is not live.](./known-limitations/presentations.md)
- [The cover slide's title can lag behind a rename by someone else.](./known-limitations/presentations.md)
- [A link to a note in a presentation can show an old title.](./known-limitations/presentations.md)
- [The presentation overview (O) shows the content of only the slides near the current one.](./known-limitations/presentations.md)
- [Opening a presentation link while signed out starts at the cover after you sign in.](./known-limitations/presentations.md)
- [Changing the slide part of the address by hand while presenting does not move to that slide.](./known-limitations/presentations.md)
- [On touch screens, a swipe doesn't change slides on a slide that scrolls, on a table, on a code block too wide to fit, or on a video or audio player.](./known-limitations/presentations.md)
- [iPhone Safari can't show a presentation full screen.](./known-limitations/presentations.md)
- [Code in a presentation isn't syntax-highlighted.](./known-limitations/presentations.md)
- [Diagrams in a presentation follow the same rules as in the editor](./known-limitations/presentations.md)
- [Opening a presentation removes any other query parameters from the address.](./known-limitations/presentations.md)
- [A link to a `#…` anchor inside a slide isn't clickable.](./known-limitations/presentations.md)

## Zooming in on images and diagrams

[Zooming in on images and diagrams](./known-limitations/zooming.md): the zoomed view of images and diagrams.

- [In a note you can edit, the zoom button on an image can't be reached with Tab.](./known-limitations/zooming.md)
- [On a read-only page, the whole diagram acts as one zoom button.](./known-limitations/zooming.md)
- [The zoomed view isn't meant for following links inside a diagram.](./known-limitations/zooming.md)
- [Presentation mode, version history previews and AI suggestion previews have no zoom.](./known-limitations/zooming.md)

## Version history

[Version history](./known-limitations/version-history.md): saving, comparing and applying versions.

- [Applying a version usually makes earlier AI edits impossible to revert.](./known-limitations/version-history.md)
- [Ctrl+Z can't undo applying a version.](./known-limitations/version-history.md)
- [Applying a version overwrites changes that nobody has saved as a version, including other people's.](./known-limitations/version-history.md)
- [Everyone who edits a note between two versions is listed on the later one, without saying who changed what.](./known-limitations/version-history.md)
- [Comparing versions of a very large note takes a moment.](./known-limitations/version-history.md)
- [Versions don't count toward storage limits, and there is no site-wide cap on them.](./known-limitations/version-history.md)
- [A block moved under a different parent block shows as deleted in one place and added in another.](./known-limitations/version-history.md)
- [Side by side, the columns line up only block by block, at the top level.](./known-limitations/version-history.md)
- [In the side-by-side comparison, a row of side-by-side columns lines up as one unit.](./known-limitations/version-history.md)
- [A row of side-by-side columns is marked a little differently from other blocks in a comparison.](./known-limitations/version-history.md)
- [Copying a note doesn't bring its versions along, and moving a note into a group or transferring a group's notes deletes their versions.](./known-limitations/version-history.md)
- [Applying a version to a note whose content is malformed fails with a server error.](./known-limitations/version-history.md)
- [Deleting a group and transferring its notes deletes all of their versions in the same database transaction.](./known-limitations/version-history.md)
- [Changing an Automatic versions switch reaches a note that is open right now only after everyone has closed it.](./known-limitations/version-history.md)
- [If automatic versions are off for a note when its waiting changes come due](./known-limitations/version-history.md)
- [When a version is applied at almost the same moment as someone else types, those few characters may not count as a change until the note is edited again](./known-limitations/version-history.md)
- [If the server can't read a note's version settings when the note is opened, saving a version by hand answers that the server is busy until everyone has closed the note, and changes made in the meantime aren't, on their own, saved as an automatic version until the note is edited again after it is reopened.](./known-limitations/version-history.md)
- [Deleting a version at the moment someone applies it leaves the note without a base version.](./known-limitations/version-history.md)
- [Deleting a version at the moment someone else's apply of that version finishes can leave the note based on a version that no longer exists.](./known-limitations/version-history.md)
- [An automatic version appears a little after the X minutes are up.](./known-limitations/version-history.md)
- [If the server fails to record a change and the note isn't changed again, that change isn't saved as an automatic version.](./known-limitations/version-history.md)
- [Someone whose edit is saved at the very moment an automatic version is being made may be listed on the wrong version.](./known-limitations/version-history.md)
- [A note that keeps failing to be saved as an automatic version is retried every 10 minutes, with at most one warning in the server log per try.](./known-limitations/version-history.md)
- [Saving a note's content also works out a fingerprint of the note, to tell whether the content really changed.](./known-limitations/version-history.md)
- [Made-up version names repeat.](./known-limitations/version-history.md)
- [When the version that another version is based on has been deleted, the deleted version's own name isn't shown](./known-limitations/version-history.md)
- [After rolling back to 0.10 and upgrading again, some bases are shown wrongly.](./known-limitations/version-history.md)
- [If saving the applied content, or clearing the waiting changes, fails while a version is being applied](./known-limitations/version-history.md)
- [Moving a note into a group, or deleting a group and transferring its notes, can fail with "The server is busy" while the background cleanup of old versions is working on those notes.](./known-limitations/version-history.md)
- [While a notice is showing at the bottom of the screen (for about 5 seconds), the first Esc closes the notice rather than the dialog that is open.](./known-limitations/version-history.md)
- [Pressing Esc in the sidebar's search box while previewing a version also closes the preview](./known-limitations/version-history.md)
- [Applying a version from before the upgrade to 0.11 brings back ordinary links, and the one-time conversion doesn't convert them again.](./known-limitations/version-history.md)
- [In a comparison or the AI box's preview, a link to a note you can't see can show as removed and added again inside a block that changed for another reason.](./known-limitations/version-history.md)

## Collaboration and presence

[Collaboration and presence](./known-limitations/collaboration.md): editing with others in real time, reconnecting, and the people and AI assistants shown in a note.

- [A tab that cannot reach the collaboration server keeps retrying in the background; edits made while offline are still lost if you reload before it recovers.](./known-limitations/collaboration.md)
- [A note's title is not part of the real-time collaborative document.](./known-limitations/collaboration.md)
- [A collaboration client that sends ten messages the server doesn't recognize gets disconnected — including a hypothetical newer client version.](./known-limitations/collaboration.md)
- [An AI's presence is only visible to people who have the note open at that moment, and it fades after 2 minutes.](./known-limitations/collaboration.md)
- [The presence registry and its counters live in the server process, so a restart leaves an already-open browser unable to see the AI until the page is reloaded.](./known-limitations/collaboration.md)
- [That counter map is never trimmed.](./known-limitations/collaboration.md)
- [The AI's name tag is only lit for about two seconds at a time.](./known-limitations/collaboration.md)
- [A token reading a note whose first block has no text puts no AI cursor in the note.](./known-limitations/collaboration.md)
- [Viewers have no cursor, so clicking a viewer in the header's row of people doesn't scroll.](./known-limitations/collaboration.md)
- [Someone who changes their display name keeps showing the old one in the header's row of people until they reopen or reload the note, or until its connection drops and comes back.](./known-limitations/collaboration.md)
- [Someone whose tab loses its network stays in the header's row of people on other screens for up to about half a minute.](./known-limitations/collaboration.md)
- [A tab that has to send the server more than the collaboration message limit (11 MiB by default) at once keeps reconnecting, and almost none of its later changes reach the server.](./known-limitations/collaboration.md)
- [A collaborator who already knows an AI cursor's identifier can keep that AI out of view in tabs that are open at the time.](./known-limitations/collaboration.md)
- [While someone's collaboration connection is gone, a collaborator's fresh connection that has no presence entry yet can take over that person's entry, and the person is then not shown to others after they come back.](./known-limitations/collaboration.md)
- [Tabs that were open before the upgrade to 0.11 don't show the reload notice — they keep trying to connect.](./known-limitations/collaboration.md)

## Note addresses and usernames

[Note addresses and usernames](./known-limitations/note-urls.md): automatic note URLs, renaming notes and usernames, and old links.

- [A note's automatic URL changes the moment its title does — with no grace period.](./known-limitations/note-urls.md)
- [A released slug can be re-used by the same owner's other notes (or the same group's) — an old link can silently start showing a different note.](./known-limitations/note-urls.md)
- [Editors can change a note's automatic URL out from under the note's owner (or, on a group note, the rest of the group), silently and without limit.](./known-limitations/note-urls.md)
- [Old-form `/notes/…` links keep working forever, and are actually more durable than the new form.](./known-limitations/note-urls.md)
- [Clicking a note in your own sidebar can hit a dead link for a moment after a collaborator renames it.](./known-limitations/note-urls.md)
- [The URLs assigned during the URL upgrade migration (#122) can shift once, silently, on the first title save.](./known-limitations/note-urls.md)
- [Moving a note into a group, or deleting a group and giving its notes to an admin, drops the note's previous-name redirect.](./known-limitations/note-urls.md)
- [A username you rename away from is free for anyone to take — including you — and old links can then lead to the new owner's notes.](./known-limitations/note-urls.md)
- [Renaming your username breaks your `/n/<old-name>/…` links immediately, and other people's open tabs keep offering the dead links until their caches refresh.](./known-limitations/note-urls.md)
- [Renaming a note twice in very quick succession can make the editor reconnect once.](./known-limitations/note-urls.md)
- [Right after going back into the settings window with the browser's Back button, following a link to the current note's old address stays on the current note, even if another note now has that address.](./known-limitations/note-urls.md)
- [Following a link to the current note's own old address briefly reconnects the editor.](./known-limitations/note-urls.md)

## Folders

[Folders](./known-limitations/folders.md): nesting, sorting and dragging folders in the sidebar, and moving many notes at once.

- [Folders nest up to five levels, but giving a deleted group's notes to an admin, or restoring notes from the trash, can make a deeper tree.](./known-limitations/folders.md)
- [Undoing a folder deletion, or restoring its notes from the trash, re-creates only the folders on the way to a note you restore.](./known-limitations/folders.md)
- [How the notes in a folder are sorted is remembered only in this browser,](./known-limitations/folders.md)
- [Sorting by Size uses the size of a note's editing state plus its attachments,](./known-limitations/folders.md)
- [Changes someone else makes to a group's folders show up when you come back to the window or reload the page,](./known-limitations/folders.md)
- [Moving many notes and folders at once within a space stops after about 600 in a minute — sooner if you've made other changes to folders in that minute.](./known-limitations/folders.md)
- [Dragging notes in the sidebar needs a mouse or a similar pointer.](./known-limitations/folders.md)
- [Making a folder by dropping a note on another note isn't all or nothing.](./known-limitations/folders.md)
- [Dragging can't be done with the keyboard or a screen reader.](./known-limitations/folders.md)
- [When a deleted group's notes are given to an admin and the group's name is nothing but control characters, the new folder is named 群組 when the browser's preferred language is Chinese and Group otherwise](./known-limitations/folders.md)
- [Folder names in the same place are unique ignoring letter case; for letters outside ASCII, what counts as the same letter depends on the database's locale.](./known-limitations/folders.md)
- [In a narrow sidebar, deeply nested folders and notes can lose their names to the indentation, have their right-hand side cut off by the sidebar's edge, and show a folder row's icons on top of its buttons.](./known-limitations/folders.md)

## Tags

[Tags](./known-limitations/tags.md): tagging notes, the tag filter and tag search in the sidebar and managing a space's tags.

- [Tags other people change, or that you change in another window, show up when you come back to the window or reload the page,](./known-limitations/tags.md)
- [Tags are not part of the note's text, so they are not in the version history.](./known-limitations/tags.md)
- [Whether two names differ only in letter case depends on the database's locale.](./known-limitations/tags.md)
- [The tag filter in the sidebar and the tags in the search box are cleared when the page is reloaded.](./known-limitations/tags.md)
- [Once a space has used all nine colors, new tags repeat them.](./known-limitations/tags.md)
- [The color dots in the sidebar can be hard to tell apart on a highlighted row.](./known-limitations/tags.md)
- [A note's tags, in the order they were added, are the order of its tags everywhere.](./known-limitations/tags.md)
- [Copying a note while one of its tags is being merged into another can leave that tag off the copy.](./known-limitations/tags.md)
- [After going back to version 0.17 and upgrading again, some notes lose their tags or show none.](./known-limitations/tags.md)
- [`#name` and a space adds a tag only on the note's first line.](./known-limitations/tags.md)
- [`#a, #b` makes two tags named `a,` and `b`.](./known-limitations/tags.md)
- [Pasting a line of `#names` needs a blank line (a new paragraph) after it.](./known-limitations/tags.md)
- [Some input methods and autocorrect don't trigger `#name` and a space.](./known-limitations/tags.md)
- [Ctrl+Z after `#name` and a space doesn't take the tag off.](./known-limitations/tags.md)
- [Choosing a tag in the search box runs the text search for what you typed on the way.](./known-limitations/tags.md)
- [If the tag code can't be loaded, `#` completion in the search box isn't available.](./known-limitations/tags.md)
- [One search can use tags of only one space.](./known-limitations/tags.md)
- [A screen reader may not read the number of results when a tag is added to the search.](./known-limitations/tags.md)

## Knowledge info

[Knowledge info](./known-limitations/knowledge.md): the facts a heading carries about what it says, and their status icon.

- [Turning a knowledge heading into a paragraph, or merging it into the paragraph above, removes its knowledge info.](./known-limitations/knowledge.md)
- [Pressing Backspace at the very start of a knowledge heading turns it into a paragraph, and its knowledge info goes with it.](./known-limitations/knowledge.md)
- [Public pages and presentations show no knowledge info.](./known-limitations/knowledge.md)
- [Knowledge info can only be added to a heading at the top level of a note.](./known-limitations/knowledge.md)
- [A phone has no drag handle, so the way in is `/info` or the icon.](./known-limitations/knowledge.md)
- [Tab indents a block in an editable note, so you can't Tab from the text to a status icon while you type.](./known-limitations/knowledge.md)
- [A heading you edit in the previous version loses its knowledge info after you go back to it.](./known-limitations/knowledge.md)
- [After a change that only turns the heading's text italic or into inline code, the icon can sit a little off for a moment.](./known-limitations/knowledge.md)
- [While it is faded, the status icon has a lower contrast than 3:1 against the page.](./known-limitations/knowledge.md)
- [In a very large note, typing in a heading is slower.](./known-limitations/knowledge.md)
- [A very large note that has knowledge info is slower to open as a public page.](./known-limitations/knowledge.md)
- [If the window crosses the phone width while the form is open, what you had typed and not saved is lost.](./known-limitations/knowledge.md)
- [A heading can only be marked as replaced by a knowledge heading of the same note.](./known-limitations/knowledge.md)
- [The last verified date can be a date in the future.](./known-limitations/knowledge.md)

## Trash

[Trash](./known-limitations/trash.md): moving notes to the trash, restoring them and permanent deletion.

- [A note move to the trash that fails partway still ejects everyone who had it open.](./known-limitations/trash.md)
- [Moving a note to the trash from the sidebar while that same note is still opening doesn't always end the same way.](./known-limitations/trash.md)
- [Notes in the trash are deleted for good after the retention period, usually within an hour of it.](./known-limitations/trash.md)
- [A note in the trash still holds its URL and its custom public URL.](./known-limitations/trash.md)
- [Deleting a group with Delete everything also permanently deletes the notes in its trash.](./known-limitations/trash.md)
- [Someone whose role can delete notes but not edit them can't get back a note they deleted.](./known-limitations/trash.md)
- [An image copied into another note breaks while the note it was uploaded to is in the trash.](./known-limitations/trash.md)
- [A direct write can land in a note that is being moved to the trash.](./known-limitations/trash.md)
- [The date a note in the trash is due to be deleted can change.](./known-limitations/trash.md)

## Search

[Search](./known-limitations/search.md): body-text search in the sidebar, the API and MCP.

- [The result count may not be announced by a screen reader when you type the first character of a search.](./known-limitations/search.md)
- [Body-text search can lag the editors by a few seconds.](./known-limitations/search.md)
- [Attachments, text in images, media captions and file names, and link addresses aren't searched.](./known-limitations/search.md)
- [Only about the first million characters and the first 2000 sections of a note are searchable.](./known-limitations/search.md)
- [The sidebar searches body text only from the second character, 20 notes at a time.](./known-limitations/search.md)
- [Clicking a body-text match jumps to the first block in its section that contains the search text; if none is found it stops at the section heading, also scrolled to the middle (or, for a match before the first heading, at the top of the note), and a reload jumps there again.](./known-limitations/search.md)
- [Right after an upgrade, older notes can be found by title only until the server has indexed them.](./known-limitations/search.md)
- [How far search ignores case depends on the database's locale.](./known-limitations/search.md)
- [Every search reads through the body text the searcher can see.](./known-limitations/search.md)
- [A link to a note with no text of its own is searchable under the text it was made with, not under the note's current title.](./known-limitations/search.md)
- [Sections with a duplicated or malformed block id aren't searchable, and neither is any body text of a note with a top-level block whose id isn't a non-empty string.](./known-limitations/search.md)

## The web app

[The web app](./known-limitations/web-app.md): panels, the sidebar, window widths, reloading after a deploy and the installed app.

- [The old `/settings/users`, `/settings/ai` and `/settings/groups/<id>` paths redirect.](./known-limitations/web-app.md)
- [Closing a panel navigates forward, not back.](./known-limitations/web-app.md)
- [On a window 640 pixels wide or wider, the pinned name column can cover part of a row's first button when a table doesn't fit its panel.](./known-limitations/web-app.md)
- [On a narrow window or a touch screen, the icon buttons at the bottom of the sidebar in selection mode have no visible name.](./known-limitations/web-app.md)
- [On a window 1280 pixels wide or more, the sidebar and the version history panel sit beside the note and can crowd its header.](./known-limitations/web-app.md)
- [The Recent tab doesn't reorder for edits made elsewhere until the note list refreshes.](./known-limitations/web-app.md)
- [The Favorites tab doesn't update right away in another window or on another device.](./known-limitations/web-app.md)
- [A floating sidebar or version history panel covers part of the note.](./known-limitations/web-app.md)
- [Notes with the same title have sidebar `⋮` buttons that sound the same to a screen reader.](./known-limitations/web-app.md)
- [A wide table on a phone can show a fade on its right edge when it overflows by only a fraction of a pixel, and can show it late.](./known-limitations/web-app.md)
- [While several notes are being moved into a group or copied from the sidebar, or folders deleted or removed, the confirmation can't be closed — if the server stops answering, reload the page.](./known-limitations/web-app.md)
- ["This looks like a failed chunk load" is decided by matching error messages.](./known-limitations/web-app.md)
- [The note page auto-reloads at most once per successful load, per tab.](./known-limitations/web-app.md)
- [Scrollbars are deliberately low-contrast.](./known-limitations/web-app.md)
- [In Chromium-based browsers, Knotebook can only be installed as an app when it is served over HTTPS (or opened from `localhost`).](./known-limitations/web-app.md)
- [The installed app doesn't work offline.](./known-limitations/web-app.md)
- [The installed app's top bar is briefly light on each start for someone who uses dark.](./known-limitations/web-app.md)
- [On a public share page, the browser's own menu can still offer to install Knotebook.](./known-limitations/web-app.md)

## On a phone

[On a phone](./known-limitations/phone.md): the phone layout, below 640 pixels.

- [After a note was opened from outside Knotebook, `‹` replaces the note in the browser history with the list.](./known-limitations/phone.md)
- [Tapping the strip above Settings, Site admin or a group's panel closes it without asking.](./known-limitations/phone.md)
- [Turning a phone across 640 pixels closes the full-screen search and the sidebar drawer.](./known-limitations/phone.md)
- [Narrowing a browser window on a computer used with a mouse to below 640 pixels doesn't keep your place in the list or a note.](./known-limitations/phone.md)
- [How the phone layout behaves with an on-screen keyboard, a notch or a home indicator, and the slide-in when a note opens hasn't been checked on a real phone.](./known-limitations/phone.md)
- [With a selection that crosses two side-by-side columns, the block type button changes only the first column's blocks.](./known-limitations/phone.md)
- [While the dialog for adding or editing a link is open, a collaborator typing before the link shifts where it lands.](./known-limitations/phone.md)

## Keyboard shortcuts

[Keyboard shortcuts](./known-limitations/shortcuts-and-tour.md#keyboard-shortcuts): on the [Keyboard shortcuts and the feature tour](./known-limitations/shortcuts-and-tour.md) page.

- [On a keyboard where `/` needs Shift, Ctrl+/ may not open the Help window while the cursor is in a note.](./known-limitations/shortcuts-and-tour.md#keyboard-shortcuts)
- [Whether ⌘/ and ⌘, reach Knotebook in Safari, Chrome and Firefox on a Mac hasn't been checked.](./known-limitations/shortcuts-and-tour.md#keyboard-shortcuts)

## Feature tour

[Feature tour](./known-limitations/shortcuts-and-tour.md#feature-tour): on the [Keyboard shortcuts and the feature tour](./known-limitations/shortcuts-and-tour.md) page.

- [At the stops that show a live menu (the `[[` and `/` stops), a few key combinations still move the cursor, and that closes the menu.](./known-limitations/shortcuts-and-tour.md#feature-tour)
- [Each tour that gets to its first stop and doesn't end with Delete leaves a sample note in My notes.](./known-limitations/shortcuts-and-tour.md#feature-tour)
- [If the tour has to stop at the very moment the sample note's page is opening, you may see "This note has been deleted." and land on the home page instead of the page you started from.](./known-limitations/shortcuts-and-tour.md#feature-tour)
- [A blank sample note can be left in My notes.](./known-limitations/shortcuts-and-tour.md#feature-tour)
- [On a phone, turning the device back and forth across the 640 px width while the tour is moving between the list and the sample note can end the tour.](./known-limitations/shortcuts-and-tour.md#feature-tour)
- [On a phone, if the sample note takes more than 5 seconds to show when the tour moves to it (on a slow connection, for example), the tour ends.](./known-limitations/shortcuts-and-tour.md#feature-tour)

## Uploads, images and storage

[Uploads, images and storage](./known-limitations/uploads.md): image uploads, embedded media, attachments of copied notes, and storage quotas.

- [A media URL that fails the safety check shows up as a broken image, with no explanation.](./known-limitations/uploads.md)
- [Pasting a right-click-copied image is blocked.](./known-limitations/uploads.md)
- [Uploaded file cleanup is not automatic.](./known-limitations/uploads.md)
- [An image block copied and pasted into another note still points at the note it was originally uploaded to, not the note displaying it.](./known-limitations/uploads.md)
- [Storage quotas count attachments and profile pictures only, per space.](./known-limitations/uploads.md)
- [Removing an image from a note doesn't free its space.](./known-limitations/uploads.md)
- [Storage usage is the recorded size, not disk usage.](./known-limitations/uploads.md)
- [A group's By member can credit the wrong person for files from before v0.10.](./known-limitations/uploads.md)
- [An image block copied from another note into yours doesn't count against your space.](./known-limitations/uploads.md)
- [Adding attachments to the same space happens one at a time.](./known-limitations/uploads.md)
- [A plan change can race an upload already in progress.](./known-limitations/uploads.md)
- [Copying into a full space can be refused even when nothing would be copied.](./known-limitations/uploads.md)
- [Anyone who can read a note can re-store its attachments without having uploaded them.](./known-limitations/uploads.md)
- [External images embedded by URL are hotlinked, not proxied.](./known-limitations/uploads.md)
- [Uploads have no CSRF check when the request carries no `Origin` header.](./known-limitations/uploads.md)
- [Revoked upload access can still be served from a browser's cache.](./known-limitations/uploads.md)
- [Only image blocks can upload; audio, video, and file blocks are embed-by-URL only.](./known-limitations/uploads.md)
- [Copying a note doesn't rewrite every link to its attachments.](./known-limitations/uploads.md)
- [Copying a note with many attachments holds it briefly and doubles their disk usage.](./known-limitations/uploads.md)

## Sharing and groups

[Sharing and groups](./known-limitations/sharing-and-groups.md): sharing notes with people, and groups, their roles and deleting them.

- [Email suggestions show the emails of everyone you share a group with.](./known-limitations/sharing-and-groups.md)
- [Adding someone to a group, or sharing a note with them, tells you whether their email has an account.](./known-limitations/sharing-and-groups.md)
- [Group notes can't be shared with individual people.](./known-limitations/sharing-and-groups.md)
- [MCP clients don't list your groups.](./known-limitations/sharing-and-groups.md)
- [A group's last admin can't leave it or step down.](./known-limitations/sharing-and-groups.md)
- [Disabling a group's only admin leaves the group without a working admin.](./known-limitations/sharing-and-groups.md)
- [Site admins can manage a group they don't belong to only through the API.](./known-limitations/sharing-and-groups.md)
- [The permissions that manage a group are a convenience, not a security boundary.](./known-limitations/sharing-and-groups.md)
- [After someone's role or its permissions change, pages they already have open may update only the editor; menus and buttons can lag until the page reloads or its tab regains focus.](./known-limitations/sharing-and-groups.md)
- [On a group note, two people who can manage its public link can undo each other's link without noticing.](./known-limitations/sharing-and-groups.md)
- [If your role can't manage a group note's public link, the Share button and dialog don't tell you the note is public.](./known-limitations/sharing-and-groups.md)
- [Leaving a group while one of its notes is open doesn't close that note right away.](./known-limitations/sharing-and-groups.md)
- [Deleting a group with Delete everything can remove a note added to it a moment earlier without telling the people who have it open that it was deleted.](./known-limitations/sharing-and-groups.md)
- [When deleting a group with Delete everything fails, people who had its notes open may already have been told a note was deleted when it wasn't.](./known-limitations/sharing-and-groups.md)
- [A request a former member had already sent when the group was deleted can still take effect on a note that now belongs to the admin who received it.](./known-limitations/sharing-and-groups.md)
- [Deleting a group can occasionally fail with "The server is busy"; trying again works.](./known-limitations/sharing-and-groups.md)

## Public pages

[Public pages](./known-limitations/public-pages.md): public links, custom public URLs and what anonymous readers can see.

- [A public share page shows a snapshot that can lag the editors by a few seconds.](./known-limitations/public-pages.md)
- [A public share exposes the note's full CRDT state, not just its rendered text.](./known-limitations/public-pages.md)
- [Images an anonymous reader already loaded survive revoking the public link, in that reader's browser cache.](./known-limitations/public-pages.md)
- [An image block copied and pasted from another note breaks on the public page.](./known-limitations/public-pages.md)
- [An image embedded by absolute same-origin URL breaks on the public page.](./known-limitations/public-pages.md)
- [A custom public URL reveals your username, and is meant to be guessable.](./known-limitations/public-pages.md)
- [A note reachable both ways gets double the public read quota, and the throttle table grows accordingly.](./known-limitations/public-pages.md)
- [On a public page, links to notes that aren't published under a custom public URL show as plain text — but the page's data still contains their target's id and the text they were made with.](./known-limitations/public-pages.md)
- [On a public page, a link to a block of another note can scroll to a block of the page itself.](./known-limitations/public-pages.md)

## Accounts and sign-in

[Accounts and sign-in](./known-limitations/accounts-and-sign-in.md): passwords, reset links and invitations, sign-in services (SSO), sessions and managing accounts.

- [A flood of distinct accounts or addresses can push an active login lockout out of memory.](./known-limitations/accounts-and-sign-in.md)
- [Email matching is case-insensitive; only new writes are stored lowercased.](./known-limitations/accounts-and-sign-in.md)
- [Resolving pre-v0.1 duplicate email rows (e.g. `alice@example.com` vs. `Alice@example.com`).](./known-limitations/accounts-and-sign-in.md)
- [Resetting someone else's password takes an admin and a link they send themselves, and it doesn't sign out the person's API tokens.](./known-limitations/accounts-and-sign-in.md)
- [A password reset link or an invitation link can end up in browser history or in a chat.](./known-limitations/accounts-and-sign-in.md)
- [Password reset links and invitations share two in-memory limits, and neither one is what stops guessing.](./known-limitations/accounts-and-sign-in.md)
- [Admins cannot delete user accounts, only disable them.](./known-limitations/accounts-and-sign-in.md)
- ["Online" in Site admin → Users means recently active, not connected right now.](./known-limitations/accounts-and-sign-in.md)
- [Shortening the web sign-in period doesn't sign anyone out.](./known-limitations/accounts-and-sign-in.md)
- [Switching identity providers means linking each person again.](./known-limitations/accounts-and-sign-in.md)
- [No RP-initiated logout.](./known-limitations/accounts-and-sign-in.md)
- [OIDC discovery is cached until the sign-in service's settings change or the server restarts.](./known-limitations/accounts-and-sign-in.md)
- [The OIDC login/callback endpoints are rate-limited per-IP and in-memory.](./known-limitations/accounts-and-sign-in.md)
- [HS256-only identity providers aren't supported — and how that surfaces depends on what they advertise.](./known-limitations/accounts-and-sign-in.md)
- [Linking a password account to SSO doesn't invalidate the original password.](./known-limitations/accounts-and-sign-in.md)
- [Signing in returns you to the page you were trying to open — unless you have to change your password first.](./known-limitations/accounts-and-sign-in.md)
- [Only same-site page paths are honoured as a return target.](./known-limitations/accounts-and-sign-in.md)
- [Starting SSO sign-in in two browser tabs at the same time can fail both of them.](./known-limitations/accounts-and-sign-in.md)
- [The account-linking page tells someone that an email has an account.](./known-limitations/accounts-and-sign-in.md)
- [The account-linking page shows which ways the account can be proved.](./known-limitations/accounts-and-sign-in.md)
- [An account with no password can't be linked from the outside when none of its sign-in services can be used to prove it.](./known-limitations/accounts-and-sign-in.md)
- ["Must change password" is cleared only by changing the password.](./known-limitations/accounts-and-sign-in.md)
- [The identity provider's `email_verified` claim isn't used.](./known-limitations/accounts-and-sign-in.md)
- [Someone can take a colleague's email and receive what is shared with it.](./known-limitations/accounts-and-sign-in.md)
- [Turning a sign-in service off doesn't sign anyone out.](./known-limitations/accounts-and-sign-in.md)
- [A sign-in service that creates accounts lets in anyone its identity provider lets in.](./known-limitations/accounts-and-sign-in.md)
- [Registering with a password is on by default, upgraded sites included.](./known-limitations/accounts-and-sign-in.md)
- [Linking a sign-in service from Settings can end on the login page.](./known-limitations/accounts-and-sign-in.md)
- [Adding a password doesn't ask you to sign in again, and suspending someone at the identity provider doesn't revoke their password or API tokens.](./known-limitations/accounts-and-sign-in.md)
- [With password sign-in turned off, the identity provider is the only way in.](./known-limitations/accounts-and-sign-in.md)
- [Turning password sign-in off doesn't sign anyone out.](./known-limitations/accounts-and-sign-in.md)
- [While password sign-in is off, the account-linking page still accepts passwords.](./known-limitations/accounts-and-sign-in.md)
- [Turning password sign-in off doesn't remove anyone's password.](./known-limitations/accounts-and-sign-in.md)
- [A password account whose email differs from its identity-provider email can't move over on its own once password sign-in is off — unless its owner is still signed in.](./known-limitations/accounts-and-sign-in.md)
- [The check when turning password sign-in off only looks at you.](./known-limitations/accounts-and-sign-in.md)
- [Test connection can't check the client ID or secret.](./known-limitations/accounts-and-sign-in.md)
- [An administrator can still obtain a sign-in service's client secret, just not silently.](./known-limitations/accounts-and-sign-in.md)
- [The affected-account counts can be off when a sign-in service has never connected.](./known-limitations/accounts-and-sign-in.md)

## Profile pictures

[Profile pictures](./known-limitations/profile-pictures.md): uploading, cropping and showing profile pictures, and pictures from sign-in services.

- [A site admin can't remove someone else's profile picture.](./known-limitations/profile-pictures.md)
- [Anyone who is signed in can read a profile picture's display image if they have its address.](./known-limitations/profile-pictures.md)
- [A changed profile picture or display name reaches the people on a note you have open only after that note reconnects.](./known-limitations/profile-pictures.md)
- [A profile picture appears only in some places.](./known-limitations/profile-pictures.md)
- [A list that is already open shows someone's changed picture only when it is fetched again.](./known-limitations/profile-pictures.md)
- [A sign-in service's picture is downloaded without pinning the address.](./known-limitations/profile-pictures.md)
- [What a sign-in service's picture can be.](./known-limitations/profile-pictures.md)
- [A sign-in linked on the Link your sign-in page gets its picture at its next sign-in.](./known-limitations/profile-pictures.md)
- [Until your browser has made the display image of a sign-in picture, other people see your initial.](./known-limitations/profile-pictures.md)
- [Cropping a profile picture needs a recent browser.](./known-limitations/profile-pictures.md)

## AI actions in the editor

[AI actions in the editor](./known-limitations/ai.md): AI providers and their keys, the built-in and custom AI actions, and the AI box.

- [An administrator can still obtain AI provider API keys, just not silently.](./known-limitations/ai.md)
- [An error response from the AI provider is written to the server log, and a gateway that echoes credentials in it puts them there.](./known-limitations/ai.md)
- [A deleted built-in AI action reappears on the next server restart.](./known-limitations/ai.md)
- [The Instruct action's guard is a prompt, not a filter.](./known-limitations/ai.md)
- [The AI's instruction to keep columns and sizes is a prompt, not a filter.](./known-limitations/ai.md)
- [A selection that includes or is inside a code block shows no formatting toolbar, so the AI box can't be opened on it.](./known-limitations/ai.md)
- [If the code for the AI box's preview fails to download, a result you haven't applied yet is lost.](./known-limitations/ai.md)
- [On touch screens, custom AI actions in the AI box have no visible name.](./known-limitations/ai.md)
- [The AI box's result covers the text below the selected blocks until you close it.](./known-limitations/ai.md)
- [The AI box's result stays at the top of the note's scrolling area once the selected blocks scroll up out of view.](./known-limitations/ai.md)
- [The AI box takes the width of the first block it works on.](./known-limitations/ai.md)
- [When the AI box's preview is taller than the box, a scrollbar can make its lines wrap differently than in the note.](./known-limitations/ai.md)
- [In the AI box's preview, code blocks show no coloured bar for added, removed or changed blocks.](./known-limitations/ai.md)
- [The AI box's instruction field grows with its text, up to four lines, in browsers that support CSS `field-sizing: content`.](./known-limitations/ai.md)
- [AI quick-action requests are rate-limited to 30 per user per minute by default (a site admin can lower it), in-memory.](./known-limitations/ai.md)
- [AI quick actions round-trip your note content through Markdown, which can lose fidelity.](./known-limitations/ai.md)
- [Anthropic responses are capped at 4096 output tokens (`max_tokens`), with no error on truncation.](./known-limitations/ai.md)

## Writing notes over the API and MCP

[Writing notes over the API and MCP](./known-limitations/api-writes.md): how writes merge, are recorded and reverted, and what survives a Markdown round trip.

- [A write can be refused with `server_busy` when someone keeps changing the same section back and forth.](./known-limitations/api-writes.md)
- [Typing that happens in the same couple of seconds as an API write is attributed to that write.](./known-limitations/api-writes.md)
- [A *rejected* API write can swallow the attribution of human typing that was waiting to be saved.](./known-limitations/api-writes.md)
- [`replace_all` and `replace_section` give some of the blocks they write new ids.](./known-limitations/api-writes.md)
- [A person's later action can leave two blocks with one id after a rewrite.](./known-limitations/api-writes.md)
- [The in-app AI and applying a version still give the blocks they replace new ids.](./known-limitations/api-writes.md)
- [An API write can succeed and still not be recorded.](./known-limitations/api-writes.md)
- [`POST /api/notes` with `content` can leave an empty note behind.](./known-limitations/api-writes.md)
- [A note's edit history stores a full copy of what each edit replaced, with no size cap.](./known-limitations/api-writes.md)
- [`revert_of` cascades, so "the last 100 edits" is really "at most 100".](./known-limitations/api-writes.md)
- [The per-note write queue and the editing runtime are process-local, and there is no cap on how many notes are written at once.](./known-limitations/api-writes.md)
- [A concurrent write is only protected where the target section has content.](./known-limitations/api-writes.md)
- [The wikilink index can briefly lag an API write.](./known-limitations/api-writes.md)
- [`POST /api/notes` now rejects unknown body fields.](./known-limitations/api-writes.md)
- [Merely opening an empty note in the browser editor records you as having edited it.](./known-limitations/api-writes.md)
- [After a revert is refused, that row keeps offering a Revert button until the dialog is reopened.](./known-limitations/api-writes.md)
- [A fingerprint is concurrency protection, not permission protection.](./known-limitations/api-writes.md)
- [Over the API and MCP, some spaces don't survive writing what you read back, and code can't carry a color.](./known-limitations/api-writes.md)
- [A list or table with block or cell colors reads back as HTML as a whole.](./known-limitations/api-writes.md)
- [Some image widths don't travel over the API and MCP, and sizes not written in the form reading gives are refused.](./known-limitations/api-writes.md)
- [Over MCP or the API, a link to a note with no text of its own can still get the note's old title as its own text when it is written back.](./known-limitations/api-writes.md)
- [`edit_note`'s reply carries fingerprints only for the page its change landed on.](./known-limitations/api-writes.md)

## AI assistants over MCP

[AI assistants over MCP](./known-limitations/mcp.md): what an assistant can reach, prompt injection, transfer tokens and paging through live data.

- [An assistant tricked by a prompt injection can send your notes' images off-site.](./known-limitations/mcp.md)
- [An assistant tricked by a prompt injection can move your personal notes into a group, or copy notes into one.](./known-limitations/mcp.md)
- [An assistant tricked by a prompt injection can move your notes to the trash.](./known-limitations/mcp.md)
- [An assistant tricked by a prompt injection can delete your folders, or rearrange them.](./known-limitations/mcp.md)
- [`read_note_image` shows an image only if you can read the note it was uploaded to.](./known-limitations/mcp.md)
- [An image uploaded but never written into a note is still an attachment.](./known-limitations/mcp.md)
- [The `curl` commands `create_transfer_token` and `open_notes_as_files` return are built from `PUBLIC_URL`.](./known-limitations/mcp.md)
- [On a plain-http `PUBLIC_URL` (for example a LAN deployment), transfer tokens cross the network unencrypted,](./known-limitations/mcp.md)
- [An MCP connection made with the browser's sign-in session has no `create_transfer_token` or `open_notes_as_files`.](./known-limitations/mcp.md)
- [A per-minute read limit is not a per-turn context budget.](./known-limitations/mcp.md)
- [Notes other people shared with you, and your groups' notes, end up in your assistant's context.](./known-limitations/mcp.md)
- [There is no cross-note view of what an assistant changed.](./known-limitations/mcp.md)
- [A wrong `PUBLIC_URL` makes MCP requests that carry an `Origin` header answer `403`.](./known-limitations/mcp.md)
- [A client's cached tool list does not shrink on its own.](./known-limitations/mcp.md)
- [`list_notes` pages through live data, not a snapshot.](./known-limitations/mcp.md)
- [`read_note_outline` pages through live positions, not a snapshot.](./known-limitations/mcp.md)
- [`read_note_section` pages through live text, not a snapshot.](./known-limitations/mcp.md)
- [`list_trash` and `list_folders` page through live data, not a snapshot.](./known-limitations/mcp.md)
- [`delete_note` and `restore_note` can use up their budgets without changing anything.](./known-limitations/mcp.md)

## Sending notes back as files (MCP bulk transfer)

[Sending notes back as files (MCP bulk transfer)](./known-limitations/bulk-transfer.md): downloading notes as files with `open_notes_as_files` and sending them back.

- [Only a note with nothing in it at all counts as empty.](./known-limitations/bulk-transfer.md)
- [A block the file didn't change can still be replaced when the file changes a large part of the note.](./known-limitations/bulk-transfer.md)
- [When a note has the same paragraph twice and the file keeps only one, the copy kept isn't always the one you meant.](./known-limitations/bulk-transfer.md)
- [Moving a long stretch of paragraphs in a file is written back as removing and re-adding the paragraphs on the shorter side of the move.](./known-limitations/bulk-transfer.md)
- [An assistant tricked by a prompt injection can send every note you can see off-site.](./known-limitations/bulk-transfer.md)
- [Text someone is typing can be lost when a file replaces the block it is in.](./known-limitations/bulk-transfer.md)
- [A download is not a snapshot.](./known-limitations/bulk-transfer.md)
- [A download that nobody reads holds up every other download on the site.](./known-limitations/bulk-transfer.md)
- [Revoking a bulk transfer token, or the credential that asked for it, doesn't stop a download that is already running right away.](./known-limitations/bulk-transfer.md)
- [A downloaded copy can be sent back only while the server still keeps what it needs of it.](./known-limitations/bulk-transfer.md)
- [A downloaded copy carries its changes back only once.](./known-limitations/bulk-transfer.md)
- [A note that has changed since the download refuses every changed file.](./known-limitations/bulk-transfer.md)
- [Two new notes made from the same file within 30 minutes are one note.](./known-limitations/bulk-transfer.md)
- [Moving, renaming or deleting a downloaded file changes nothing on the server.](./known-limitations/bulk-transfer.md)
- [Attachments aren't in the download.](./known-limitations/bulk-transfer.md)
- [A path in the download can be longer than Windows' default limit of 260 characters.](./known-limitations/bulk-transfer.md)
- [Windows' own `tar.exe` skips notes whose file names it can't represent.](./known-limitations/bulk-transfer.md)
- [A file that changes many places can push older rows out of a note's AI edit history.](./known-limitations/bulk-transfer.md)
- [Files sent back have a budget of their own, separate from the token write budget.](./known-limitations/bulk-transfer.md)
- [A copy whose changes were reverted is no longer accepted at all, not even to rename the note.](./known-limitations/bulk-transfer.md)
- [A file near the size limit may not fit once it is a note.](./known-limitations/bulk-transfer.md)
- [A viewer's file is refused even when it is unchanged.](./known-limitations/bulk-transfer.md)
- [Spaces at the start of a note's title stay in its file name.](./known-limitations/bulk-transfer.md)
- [Blocks nested under a list item come out of it when a file changes that item.](./known-limitations/bulk-transfer.md)
- [A toggle becomes a bullet when a file changes it.](./known-limitations/bulk-transfer.md)
- [Some blocks come back different when a file changes the part of the note they are in.](./known-limitations/bulk-transfer.md)
- [A list with colored items is one block in the file.](./known-limitations/bulk-transfer.md)
- [A few notes can't be written back as files.](./known-limitations/bulk-transfer.md)
- [An empty paragraph can't be added by adding a blank line, and removing blank lines removes empty paragraphs.](./known-limitations/bulk-transfer.md)
- [If recording a file's changes fails after they were merged, the note is changed with no row in its AI edit history.](./known-limitations/bulk-transfer.md)
- [HTML comments in a file are dropped, and can turn the lines below them into plain text.](./known-limitations/bulk-transfer.md)
- [A code block a file opens and never closes gets the whole file refused.](./known-limitations/bulk-transfer.md)
- [The check for an unclosed code block has gaps.](./known-limitations/bulk-transfer.md)
- [An indented line after a blank line can read differently when a file changes the part it is in.](./known-limitations/bulk-transfer.md)
- [After `APP_SECRET` changes, every downloaded copy answers `409 base_unavailable`.](./known-limitations/bulk-transfer.md)
- [Changing only the spaces at the end of a line doesn't write anything.](./known-limitations/bulk-transfer.md)
- [Changing where a numbered list starts doesn't write anything.](./known-limitations/bulk-transfer.md)
- [A copy of a `mergeable: false` note downloaded before #386 or #379 was fixed can't send back a new title.](./known-limitations/bulk-transfer.md)
- [Reverting a removed part and an added part at the same place can put them back in a slightly different order.](./known-limitations/bulk-transfer.md)
- [Don't revert the AI edit history rows of files sent back over MCP while v0.14 runs.](./known-limitations/bulk-transfer.md)

## API tokens and OAuth

[API tokens and OAuth](./known-limitations/api-tokens-and-oauth.md): personal API tokens and the OAuth authorization server for MCP clients.

- [API tokens survive a password change.](./known-limitations/api-tokens-and-oauth.md)
- [The API-token quota is best-effort.](./known-limitations/api-tokens-and-oauth.md)
- [Expired API tokens are cleaned up opportunistically, not on a schedule.](./known-limitations/api-tokens-and-oauth.md)
- [The `WWW-Authenticate` challenge points at a single resource.](./known-limitations/api-tokens-and-oauth.md)
- [OAuth for MCP clients only works for clients that run on your own machine.](./known-limitations/api-tokens-and-oauth.md)
- [Neither the consent screen, nor creating a personal API token, nor changing a credential's scope asks for your password again.](./known-limitations/api-tokens-and-oauth.md)
- [App names on the consent page and in Settings are self-reported and unverified.](./known-limitations/api-tokens-and-oauth.md)
- [The authorization server only supports dynamic client registration, which the MCP spec has marked deprecated.](./known-limitations/api-tokens-and-oauth.md)
- [OAuth credentials are not short-lived, and there is no revocation endpoint.](./known-limitations/api-tokens-and-oauth.md)
- [A replayed authorization code, or a replayed refresh token, is simply rejected — it does not revoke the credential it belonged to.](./known-limitations/api-tokens-and-oauth.md)
- [A failed token exchange does not consume the authorization code.](./known-limitations/api-tokens-and-oauth.md)
- [Denying on the consent page — or hitting the 20-credential limit there — discards the request.](./known-limitations/api-tokens-and-oauth.md)
- [Unknown scope values are silently ignored rather than rejected.](./known-limitations/api-tokens-and-oauth.md)
- [`resource` is required on the authorization request](./known-limitations/api-tokens-and-oauth.md)
- [Confidential clients are not supported.](./known-limitations/api-tokens-and-oauth.md)
- [Scopes cover your whole account.](./known-limitations/api-tokens-and-oauth.md)
- [An invalid Bearer token still costs a database lookup once its per-IP bucket is exhausted.](./known-limitations/api-tokens-and-oauth.md)
- [Matching a `redirect_uri` against a registered one ignores the port](./known-limitations/api-tokens-and-oauth.md)
- [Re-authorizing an app replaces its previous credential — which logs out any other running copy of that app.](./known-limitations/api-tokens-and-oauth.md)
- [An app the server has forgotten has to be removed and re-added on the client.](./known-limitations/api-tokens-and-oauth.md)
- [Changing `PUBLIC_URL` invalidates OAuth apps that cached the old issuer or resource.](./known-limitations/api-tokens-and-oauth.md)
- [Serving the authorization server over plain `http://` breaks the MCP requirement that it be `https://`.](./known-limitations/api-tokens-and-oauth.md)
- [The automatic clean-up of OAuth leftovers has no scheduler.](./known-limitations/api-tokens-and-oauth.md)

## Limits

[Limits](./known-limitations/limits.md): note size, parse workers, rate limits and site limits.

- [In-memory rate limiting and login lockout reset on restart.](./known-limitations/limits.md)
- [Markdown that takes the server too long or too much memory to read is refused.](./known-limitations/limits.md)
- [One person can keep parse workers busy, and when every worker is busy, others wait.](./known-limitations/limits.md)
- [Putting a large write into a note, and reading a large note back, still hold up the server briefly.](./known-limitations/limits.md)
- [Inserting a very large number of blocks in one write takes more than proportionally longer.](./known-limitations/limits.md)
- [Merging a large deletion into the open note holds up the server and every open tab briefly.](./known-limitations/limits.md)
- [Applying a version of a large note holds up the server for a moment.](./known-limitations/limits.md)
- [In the browser the note size limit is only a soft check, and a note can end up somewhat over it.](./known-limitations/limits.md)
- [A note over its size limit can still grow a little through MCP, the API and bulk transfer.](./known-limitations/limits.md)
- [The note size limit counts the note's stored state, not its text.](./known-limitations/limits.md)
- [A tab that is already open can check uploads and note size against an old limit.](./known-limitations/limits.md)
- [Changes to the site limits are not passed on between server instances.](./known-limitations/limits.md)
- [Lowering a rate limit, or raising it again, doesn't reset anyone's count.](./known-limitations/limits.md)
- [Changing the memory per parse worker replaces every worker.](./known-limitations/limits.md)
- [A very large note can't be read over MCP or the API, or downloaded.](./known-limitations/limits.md)
- [Most `429` responses have no `Retry-After` header or wait time at all.](./known-limitations/limits.md)
- [Copying many notes at once from the sidebar stops after about 30 in a minute — sooner if you've made other writes in that minute, or, when the notes have attachments, copied or uploaded many attachments in the last 10 minutes.](./known-limitations/limits.md)

## Running a server

[Running a server](./known-limitations/operations.md): deployment settings, reverse proxies, volumes, upgrades and rollbacks.

- [Rolling back to a pre-0.2 version after starting 0.2 makes stored AI provider keys unreadable.](./known-limitations/operations.md)
- [Setting `POSTGRES_PASSWORD` after the first `docker compose up` has no effect.](./known-limitations/operations.md)
- [`ADMIN_EMAIL`/`ADMIN_PASSWORD` only take effect on first initialization](./known-limitations/operations.md)
- [The uploads directory is a Docker named volume; if it isn't mounted, uploaded images vanish the next time the `app` container is rebuilt.](./known-limitations/operations.md)
- [Upgrading a pre-release build that already had groups moves every group note out of its owner's hands, and some old links stop working.](./known-limitations/operations.md)
- [Accounts created while running a rolled-back (pre-username) server version aren't in the username registry until the next upgrade boots.](./known-limitations/operations.md)
- [Behind a reverse proxy with `TRUST_PROXY` unset, one client can rate-limit the public share pages for everyone.](./known-limitations/operations.md)
