# Math (LaTeX)

Notes can contain math formulas written in [LaTeX](https://katex.org/docs/supported.html) and drawn with
[KaTeX](https://katex.org/). A formula is a block of its own, shown centred on its own line. It is stored as
its **source text**, not as an image, so it stays editable, diff-able and searchable, and it follows the
light/dark theme.

## Using math

**Insert one** with the slash menu: type `/math` (`/formula`, `/數學` and `/公式` also find it) and pick
**Math** (**數學式** in Traditional Chinese). You get an empty block; click it to type the source.

**Type a fence.** In an empty paragraph, type ```` ```math ```` and press `Enter` or `Space`. The paragraph
turns into a formula block with its source open for typing, the same way typing ```` ```mermaid ```` makes a
[diagram](./diagrams.md). `Esc` closes the source and puts the caret back in the note. A fence in another
language, such as ```` ```latex ````, makes the usual code block.

**Edit** by clicking the formula — it turns into a plain text area with the source. Press `Escape`, or click
somewhere else, to draw it again. `Enter` inserts a newline.

**Show the source** with the button in the block's top-right corner — labelled **Edit** if you can edit the
note, **Show source** if you are only reading it (readers get the same text area, read-only).

**Syntax errors** don't lose your work: KaTeX shows the source in red, and its message appears when you point
at it. A command KaTeX doesn't know is marked in red where it stands, and the rest of the formula is still drawn.
Fix it in place. A block with no source shows a hint to click it to people who can edit the note.

**Chinese inside a formula** (for example `\text{速度}`) is drawn in the note's body font; the Latin letters
and symbols keep KaTeX's own fonts.

**On a phone**, a formula that is wider than the screen scrolls sideways, with a fade at the edge, the same as a
wide table.

## What becomes a formula

A fenced ```` ```math ```` block turns into a formula block, in the editor and everywhere text enters a note:
when you **paste** it, **import** a file or **send** it over the API or MCP, or when an **AI edit** writes it.

These stay as they are:

- ```` ```latex ````, ```` ```tex ```` and every other fence. A ```` ```latex ```` block is an ordinary code
  block: it is colored, not drawn, and never becomes a formula block. The language name is matched exactly, in
  lower case: ```` ```Math ```` and ```` ```LaTeX ```` stay plain code blocks.
- Inline `$…$`, a paragraph that is only `$x^2$`, amounts such as `$5`,
  `\(…\)` and `\[…\]`. Knotebook has no inline math.

## Copying and exporting

Exporting a note, and reading it over MCP or the API, gives each formula as a ```` ```math ```` fenced block with
the LaTeX source, and writing that back keeps the formula (see [AI editing](./ai-editing.md#markdown-round-trip)).
Copying and pasting a formula inside Knotebook keeps it a formula block.

## Presentations and search

Formulas are drawn in presentation mode too (see [Presentations](./known-limitations/presentations.md)), and on a
touch screen a formula wider than the slide scrolls instead of changing slides when you swipe on it.

Search looks at a formula's source: searching for text that is in a formula finds the note, and clicking the result
jumps to that block ([Search](./known-limitations/search.md)).

## For self-hosters

**KaTeX is loaded on demand.** Its script is about 260 KB and its stylesheet about 29 KB before compression,
plus the font files, which the browser fetches as formulas use them. They are downloaded only the first time a
note actually draws a formula; opening notes without formulas costs nothing extra. The text of the math block's
own menu and hints is split out the same way. A CI check (`scripts/check-bundle-size.mjs`) fails the build if
KaTeX, its stylesheet or those strings end up in the main application chunk, or if the main chunk, the note page or
the presentation imports KaTeX at load time.

**Rendering happens in the browser.** No formula is sent anywhere. KaTeX and its fonts come from your own
server; the app's `Content-Security-Policy` needed no change for them.

**A formula cannot make anything execute.** KaTeX runs with `trust` off, so `\href`, `\url` and the `\html…`
commands don't work (the command's name shows in red, and its arguments, such as a link's text, are not shown), and `maxSize` and `maxExpand` stop formulas that try to draw
absurdly large boxes or expand macros without end. These are set in `apps/web/src/lib/katex.ts`, the only place allowed to import KaTeX.

**The fonts** are KaTeX's own, used unchanged; their license (SIL Open Font License 1.1) is in
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

**Upgrading.** Math adds a block type, so [the upgrade](./self-hosting.md#upgrading-and-rolling-back) asks open
tabs to reload and indexes existing notes for search again in the background. Rolling back removes the formulas
from any note that someone who can edit it opens, or that an MCP or API write changes, afterwards: back up the
database before upgrading, and read [the rolling-back notes](./self-hosting.md#upgrading-and-rolling-back) before you go back.
