# Knowledge info

A heading can carry a few facts about what it says: when to read it, a one-line conclusion, what the conclusion rests on, when someone last checked it, and whether it still holds. A heading with these facts is a piece of *knowledge*. In the text it adds one small icon after the heading, so a note reads the same as before; the facts are one hover or tap away. A note without knowledge info looks and behaves exactly as it did.

Only a heading at the top level of the note can carry it. A heading inside a column, a list or a quote can't. Known limits are in [Known limitations](./known-limitations/knowledge.md).

## The fields

| Field | What it holds |
|---|---|
| **When to read** | When someone should read this part, up to 200 characters. |
| **Conclusion** | The point of the section in one line, up to 300 characters. |
| **Basis** | **Tested**, **Documentation**, **Inferred** or **Unconfirmed** (the default). |
| **Last verified** | A date, or empty. It may be any valid date, including one in the future. |
| **Status** | **Current** (the default), **Needs review** or **Outdated**. |
| **Replaced by** | Only for **Outdated**, and required then: the knowledge heading that took its place, in this note or in another note you can see. The list offers this note's knowledge headings first, the outdated ones included; type to search the knowledge in your other notes as well (see [Replacing with knowledge in another note](#replacing-with-knowledge-in-another-note)). |

You need at least one of the fields filled in (or a status other than **Current**) to save. To take the info off a heading, use **Remove knowledge info** at the top right of the form; emptying the fields and saving doesn't remove it.

## The icon

The icon sits after the end of the heading's last line. It is faded until you point at it or move the keyboard focus to it, and always faded on a screen that has no pointer to hover with. Its name, which screen readers read, is **Knowledge info:** followed by the state. The first row that applies decides it:

| Icon | State | When |
|---|---|---|
| Red circle with a slash | **Outdated** | The heading is outdated, or a knowledge heading above it is. |
| Amber circle with an exclamation mark | **Needs review** | The status is **Needs review**. |
| Gray circle with an *i* | **Not verified** | There is no last verified date. |
| Green circle with a check | **Verified** | None of the above. |

An outdated heading, and every knowledge heading under it, is dimmed and struck through, so what is out of date can be skipped at a glance. "Under" means below it and before the next heading of the same or a higher level (an H3 is under the H2 above it, until the next H2 or H1). A knowledge heading belongs to the nearest knowledge heading it is under, and its card says **Part of:** and links to it.

## The card

Point at the icon (or tap it on a phone) to see a card with the fields, a banner when the state needs one (needs review, outdated and what replaced it, or outdated because of a heading above) and, for a heading that has knowledge headings under it, how many there are and how many of each state. **Part of:** and the names in the banners jump to that heading, in another note too (see [Replacing with knowledge in another note](#replacing-with-knowledge-in-another-note)). Anyone who can read the note sees the card; only people who can edit it see **Edit**.

On a phone the card opens from the bottom, with **Mark as verified** (sets the last verified date to today, and a **Needs review** status back to **Current**) and **Edit**. Both are shown only to people who can edit the note. **Mark as verified** is left out for a heading whose own status is **Outdated**; a heading that only shows as outdated because one above it is still has it.

## Adding and editing

There are three ways in, for someone who can edit the note:

- Type `/info` in the heading (or choose **Knowledge info** in the `/` menu) and press Enter.
- Open the heading's drag handle menu and choose **Knowledge info…** (**Edit knowledge info…** once it has some). A phone has no drag handle.
- Click the icon. On a screen wide enough not to be a phone (640 px or more), with a mouse and the right to edit, the form opens straight away and the card comes from pointing; at phone width, or without the right to edit, the icon opens the card (on a phone, the bottom sheet); on a touch screen, tap the icon for the card and then **Edit**.

The form closes with **Save**, **Cancel** or **Esc**; closing it with unsaved changes drops them. **Mark verified today** fills in today's date. Saving is one change, so **Undo** takes the whole edit back. If someone else turns the heading into a paragraph, deletes it or moves it into a column while your form is open, the form closes with a notice and nothing is written.

Pressing Enter at the very start of a knowledge heading that has text adds an empty paragraph above it, so the heading keeps its info. Pasting or copying a knowledge heading within a note gives the new copy its own id; it doesn't take over the one it was copied from.

## Replacing with knowledge in another note

In the form, **Replaced by** lists this note's knowledge under **This note**. Once you type something and pause for a moment, the knowledge in your other notes that matches appears under **Other notes**: it matches the heading, when to read, the conclusion or the title of the note, ignoring case, and shows at most 20 results. Only notes you can see are searched, and notes in the trash aren't. A heading can't be marked as replaced by itself. If the search fails the form says so and **This note** keeps working; if you search too often it asks you to wait a minute.

The search draws on the same per-minute budget as the sidebar's text search and the `search_notes` tool (60 searches a minute per person by default, see [API](./api.md)), and the more knowledge you can see, the longer it takes.

The card, the phone sheet and the index then show that heading's name, and a click opens that note at that heading. The name follows the other note: rename the heading and the card shows the new name within a minute, or when you reload. If the other note has been deleted or is in the trash, or you can't see it, the card says **knowledge in another note** without a name or a link, and that text is the same whichever it is, so it doesn't tell you whether the note exists. A replacement in the same note that has been removed reads **knowledge that no longer exists**. A version preview doesn't look other notes up: there it always says **knowledge in another note**.

## The index

An index lists the knowledge in a folder, in your own notes or in a group, one row for each piece, so you can see when to read what without opening the notes. It is built from the knowledge info in the notes and is read-only.

**Opening it.** A folder row, a group row and the **My notes** tab's title row show an index button when you point at them (on a touch screen it is always there), and the `⋮` menu of a folder or a group has **Open index**. They are there only for a folder, group or space that holds knowledge; a folder's index includes the knowledge in its subfolders. When you add the first knowledge to a folder, the button shows once the sidebar's note list has refreshed, for example after reloading the page. The addresses are `/knowledge/me`, `/knowledge/g/<group id>` and `/knowledge/f/<folder id>`.

**Who can open it.** Your own notes' index and your own folders' indexes are yours. A group's index, and the index of a folder in it, is for the members whose role can read the group's notes. Everyone else, including someone who has only been shared a note in that folder or group, gets **Index not found**, which reads the same whether or not the folder or group exists. **Shared with me** and its folders have no index, and a note shared with you is in no index.

**What it lists.** The knowledge in the notes you can see in that space or folder, not the ones in the trash. A note appears a few seconds after it is saved. Each row shows the status icon, **when to read → conclusion** (the heading when both are empty), and the note's title and the heading; a click opens the note at that heading. A heading with no when to read of its own is nested under the knowledge it belongs to, which carries a count of what is under it. Knowledge that needs review is amber. Outdated knowledge is faded and goes last in its section, with **→ replaced by** and the replacement's name, a link when you can see it.

**Sections.** By default the rows are grouped by folder: first the notes directly in the space or folder, then one section for each subfolder. **Group by Tag** (offered when the notes in the index have tags) makes one section for each tag, with a note under each of its tags and the rest under **No tag**.

**Filters.** **Tags** keeps the notes that have every tag you tick, **Status** keeps knowledge that is **Not verified**, **Needs review** or **Outdated**, and **Basis** keeps one basis. **Clear filters** resets them. The filters and the grouping are in the address, so a reload or a shared link keeps them; changing them doesn't add a step to the browser's history, so **Back** returns to the page before the index.

After an upgrade, older notes are indexed in the background and the page says so while that goes on. The limits of the index are in [Known limitations](./known-limitations/knowledge.md).

## Where it shows and where it doesn't

- **Version history.** Previewing a version shows the icons that version had, and their cards without **Edit**.
- **Public pages and presentations.** A public link shows the note without any knowledge info, and so does the presentation mode (see [Sharing](./sharing.md)). The server removes it before it sends the note.
- **Exports.** The HTML and Markdown a note is exported as leave the info out.
- **AI agents and downloaded files.** The Markdown that MCP, the API and a downloaded file give an agent has the info: a comment after each knowledge heading, which the agent can keep, change or add when it writes the note back. Reading and writing it is described in [AI editing](./ai-editing.md#knowledge-info); a downloaded file also has a `tags:` line, which an agent can change to set the note's tags (see [Sharing](./sharing.md#tags)). The AI actions in the editor send and check it the same way.
