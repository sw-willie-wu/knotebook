# Help and the feature tour

The **Help** window has three kinds of pages: a **Feature tour** that walks you through Knotebook on a
sample note, **What's new** (what the current version added), and the **Keyboard shortcuts**, sorted into groups
(General, Typing triggers, Markdown shortcuts and so on). Nothing in it starts or opens by itself.

## Opening Help

**Choose Help** in the user menu at the bottom of the sidebar. The window opens on the **Feature tour**
page. When the sidebar is folded away (windows narrower than 1280 px), open it with the sidebar button first.

**On a phone** (a screen narrower than 640 px) the user menu is your avatar (your picture or initial) at the top right of the list: tap it and choose
**Help**. Help opens on its list of pages, so tap **Feature tour**, then **Start tour**.

**Press Ctrl+/** (⌘/ on a Mac). The window opens on the **General** shortcuts. Press the shortcut again or Esc to close it.
It doesn't open while another dialog or menu is open, during a presentation, or on pages without the
sidebar (sign-in, public notes).

The left column lists **Feature tour**, **What's new** and, under **Keyboard shortcuts**, the groups. On a narrow
screen the list and the page take turns, and a back button returns to the list. A group that doesn't apply
to your site isn't listed: the AI group isn't shown when no AI action is set up.

## What's new

The page is titled **New in vX.Y.Z** and lists the features that version added, each with a short
description. The version in the title comes from the list itself, not from the version of the app you are running. Some entries are only for site admins (the site limits, for example); other people don't see them.
When a version has nothing to point out, the page says "Nothing new to highlight in this version."

## The feature tour

**Start it** with **Start tour** on the **Feature tour** page. The Help window closes and the tour begins.
It never starts by itself.

**The sample note.** Every time you start the tour, Knotebook creates a new note in **My notes** called
"Welcome to Knotebook" (the Chinese interface names it 歡迎使用 Knotebook), opens it, and fills it in. It holds
a heading, bulleted and numbered lists, to-dos, a quote, a code block, a link to the note itself, two columns, a
Mermaid diagram and a table, plus, only when your site has an AI action, one sentence for the AI stop. The tour
works on that note only; it doesn't change your other notes.

The sample note's heading carries [knowledge info](knowledge.md) (when to read it, a one-line conclusion, current, and
verified on the day you start the tour), so its status icon shows a green check. Because of that, as long as the sample
note is in **My notes** it is listed in the My notes [knowledge index](knowledge.md#the-index), and the **My notes** title
has an index button (shown when you point at the title, always on a touch screen); once the note is in the trash it leaves
the index again. The tour creates no tag: the Tags stop points at the menu where tags are added instead of tagging the
sample note.

**The stops.** A card says what the highlighted part is for; the rest of the screen is dimmed. The card
shows "n / N", **Back** and **Next**; the first stop has **Skip feature tour** instead of **Back**.

| Stop | What it shows |
| --- | --- |
| Sidebar sections | The sidebar's sections, where deleted notes go first |
| New note | The button that creates a note in My notes |
| Folders | The button that creates a folder, and **Move to…** in a note's `⋮` menu |
| Search | The search box, and Ctrl+K (⌘K on a Mac) |
| Share and more | **Share**, the width button next to it (Standard, Wide, Full width; also under `⋮` → **Width**; not on a phone) and the `⋮` menu in the note header |
| Version history | The version history button (bubbles hidden with the arrow button below them are shown again for this stop) |
| Knowledge info | The status icon after the sample note's heading; the card names `/info` and the knowledge index |
| Tags | The `⋮` menu in the note header, which has **Add tag**; the card also names `/tag`, `#name` and a space on the note's first line (when that line is an ordinary paragraph), the tag row above the text, the dots and the filter in the sidebar, and `#` in the search box |
| Link to another note | The `[[` menu, shown live |
| Ask AI about a selection | A selected sentence and the AI button in the toolbar (only when your site has an AI action) |
| Insert blocks with / | The `/` menu, shown live |
| Forgot how something works? | The user menu, where Help is |

Three of the sidebar stops (sections, folders and search) are left out while the sidebar's search box has
text in it, because the sidebar then shows search results instead. The total in "n / N" leaves out the stops dropped this way.

**On narrower screens.** When the sidebar is folded away (640 to 1279 px wide), the sidebar stops point at the sidebar button
instead; the sidebar stays closed during the tour. On a phone the list and a note are separate screens, so the tour moves
between them:

- It starts on the list, even when you started it from a note. **Lists of notes** (the phone's name for **Sidebar sections**)
  points at the row of tab icons, **New note** and **Search** at the round buttons at the bottom of the screen, and
  **Folders** at the New folder button in the My notes header.
- Then it opens the sample note for **Share and more**, **Version history** (the `⋮` menu, which has **Version history** on a
  phone), **Knowledge info** (the status icon), **Tags** (the `⋮` menu again) and the `[[` and `/` stops.
- It goes back to the list for the last stop, which points at your avatar at the top right: Help is in its menu.
- The AI stop is left out: selecting text on a phone doesn't bring up the toolbar. "n / N" doesn't count it.

**Back** and **Next** move between the two screens as needed; the card disappears for a moment while the screen changes.

If the screen crosses one of these widths during the tour (turning a tablet, resizing the window), the current stop moves
to that layout's target.

**Live stops.** On the `[[` and `/` stops the real menu opens in the sample note's last, empty paragraph, and the AI stop
selects the sample sentence so the real toolbar appears. The tour doesn't change the note while it does this: it holds
back typing and most shortcuts, and nothing is written, so reloading or closing the tab in the middle leaves no half-finished
edit behind. On a touch screen the on-screen keyboard stays down on these stops, although the cursor is in the note; once the
tour has moved on, tapping the text brings the keyboard up as usual. On these stops use the → and Enter keys for the next stop and ← for the previous one. A few key combinations that
move the cursor still reach the editor; see [Known limitations](known-limitations/shortcuts-and-tour.md#feature-tour).

**Ending.** The last stop asks whether to keep the sample note.

- **Keep sample note** leaves it in **My notes**.
- **Delete** moves it to the trash, with an **Undo** in the message that appears.

Closing the tour with the ✕ button or Esc, at any stop, always keeps the sample note. So does **Skip feature tour** on the first
stop. If the sample note's page goes away during the tour (the browser's Back button, reloading the page, or the note
being deleted somewhere else), the tour ends and the sample note stays.

When the tour ends while you are still on the sample note, you go back to the page you started from (on a phone, the list; see the end of this paragraph). On a wide window the
sidebar also returns to the section it was showing, and the focus goes back to the user menu button. When the sidebar is
folded away, the focus goes to the sidebar button instead. On a phone, finishing the tour, closing it or skipping it takes you
back to the list with the focus on your avatar, and the list returns to the tab it was showing; if you leave the tour (the
browser's Back button, for example), you stay where you went and only the tab is put back.

**If it can't start.** When the sample note can't be created, a message says so. When the first stop isn't up within 15
seconds, a message says the tour couldn't start, and a sample note that was created but is still empty is moved to the trash.

## Updating "New in this version"

For maintainers. The list lives in one file, `apps/web/src/components/shortcuts/release-highlights.ts`: a `version` and a list of
`items`, each with an `id` and, for features only a site admin can use, `adminOnly: true`.

**In the pull request that adds a feature worth pointing out:**

1. Add the entry's English and Traditional Chinese `title` and `desc` to `apps/web/src/i18n/shortcuts.en.json` and
   `apps/web/src/i18n/shortcuts.zh-TW.json`, under `helpGuide.whatsNew.items.<id>` (a test checks that both files have the same keys).
2. Add the `id` to `items` in `release-highlights.ts`. If `version` is still the last released version, change it to the
   next one and remove the last release's entries together with their strings.

The page lists every entry in the file by itself, so nothing else needs to change.

**In the release pull request**, What's new needs only `release-highlights.ts` and the strings. Make sure `version` is the version being
released and delete the entries you don't want to show. If this release has nothing to point out, empty `items` (and delete
the strings): the page then says "Nothing new to highlight in this version."

`release-highlights.guard.test.ts` fails when `version` isn't `X.Y.Z`, when it is lower than the `version` in
`apps/web/package.json` (the file wasn't updated when the release was prepared), when an entry is missing a string in
either language, and when a string is left over for an entry that is no longer listed. See [Releasing](releasing.md).
