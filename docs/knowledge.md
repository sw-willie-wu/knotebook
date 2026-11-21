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
| **Replaced by** | Only for **Outdated**, and required then: the knowledge heading that took its place. The list offers the knowledge headings in the same note, the outdated ones included. |

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

Point at the icon (or tap it on a phone) to see a card with the fields, a banner when the state needs one (needs review, outdated and what replaced it, or outdated because of a heading above) and, for a heading that has knowledge headings under it, how many there are and how many of each state. **Part of:** and the names in the banners jump to that heading. Anyone who can read the note sees the card; only people who can edit it see **Edit**.

On a phone the card opens from the bottom, with **Mark as verified** (sets the last verified date to today, and a **Needs review** status back to **Current**) and **Edit**. Both are shown only to people who can edit the note. **Mark as verified** is left out for a heading whose own status is **Outdated**; a heading that only shows as outdated because one above it is still has it.

## Adding and editing

There are three ways in, for someone who can edit the note:

- Type `/info` in the heading (or choose **Knowledge info** in the `/` menu) and press Enter.
- Open the heading's drag handle menu and choose **Knowledge info…** (**Edit knowledge info…** once it has some). A phone has no drag handle.
- Click the icon. On a screen wide enough not to be a phone (640 px or more), with a mouse and the right to edit, the form opens straight away and the card comes from pointing; at phone width, or without the right to edit, the icon opens the card (on a phone, the bottom sheet); on a touch screen, tap the icon for the card and then **Edit**.

The form closes with **Save**, **Cancel** or **Esc**; closing it with unsaved changes drops them. **Mark verified today** fills in today's date. Saving is one change, so **Undo** takes the whole edit back. If someone else turns the heading into a paragraph, deletes it or moves it into a column while your form is open, the form closes with a notice and nothing is written.

Pressing Enter at the very start of a knowledge heading that has text adds an empty paragraph above it, so the heading keeps its info. Pasting or copying a knowledge heading within a note gives the new copy its own id; it doesn't take over the one it was copied from.

## Where it shows and where it doesn't

- **Version history.** Previewing a version shows the icons that version had, and their cards without **Edit**.
- **Public pages and presentations.** A public link shows the note without any knowledge info, and so does the presentation mode (see [Sharing](./sharing.md)). The server removes it before it sends the note.
- **Exports and AI agents.** The HTML and Markdown a note is exported as leave the info out, and so does the Markdown that the API and AI agents read; they don't see knowledge info yet.
