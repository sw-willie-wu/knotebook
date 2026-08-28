# Diagrams (Mermaid)

Notes can contain diagrams written in [Mermaid](https://mermaid.js.org/) — flowcharts, sequence
diagrams, ER diagrams, state machines, and everything else Mermaid supports. Diagrams are stored as
their **source text**, not as images, so they stay editable, diff-able and searchable, and they follow
the light/dark theme instead of being baked into one.

## Using diagrams

**Insert one** with the slash menu: type `/diagram` (`/圖表` in Traditional Chinese) and pick
**Diagram**. You get an empty block; click it to type the source.

**Edit** by clicking the diagram — it turns into a plain text area with the source. Press `Escape`, or
click somewhere else, to draw it again. `Enter` inserts a newline, because diagram source is
multi-line by nature.

**Paste** a fenced ```` ```mermaid ```` code block and it becomes a diagram automatically. This covers
the common case of copying a diagram out of a chat with an AI, out of a GitHub README, or out of
another note.

**Show the source** with the button in the block's top-right corner — labelled **Edit** if you can
edit the note, **Show source** if you are only reading it (readers get the same text area, read-only).
There is always a way back to the diagram: `Escape`, or clicking somewhere else. The block never stops
being a diagram block, so you can never get stuck looking at source you cannot render (an earlier
design converted the block into a plain code block, which was a one-way trip).

**Syntax errors** don't lose your work: the block shows Mermaid's error message next to the source you
wrote, so you can fix it in place. It never renders Mermaid's own "Syntax error" graphic.

## Copying diagrams out

Copying a diagram out of Knotebook (or exporting a note) produces the ```` ```mermaid ```` source, not
an SVG. So it renders as a diagram on GitHub, Obsidian, and anywhere else that understands Mermaid,
and it remains editable there. Somewhere that doesn't understand Mermaid shows the source, which is
still more useful than a broken image.

## For self-hosters

**Mermaid is loaded on demand.** It's the largest single dependency in the web app (roughly 680KB for
the core, plus per-diagram-type chunks it fetches itself), so it is downloaded only the first time a
note actually draws a diagram. Opening notes that contain no diagrams costs nothing extra. A CI check
(`scripts/check-bundle-size.mjs`) fails the build if Mermaid ever ends up bundled into the main
application chunk.

**Rendering happens in the browser**, in the reader's own tab. No diagram source is sent anywhere for
rendering, and no external service is contacted.

**Security posture.** Mermaid renders to SVG that Knotebook inserts into the page, so the rendering is
locked down in three ways:

- `securityLevel: "strict"` — Mermaid's built-in sanitizer (DOMPurify) processes the output.
- `flowchart.htmlLabels: false` — labels are drawn as SVG text rather than embedded HTML, which removes
  a whole class of injection surface.
- Mermaid's `bindFunctions` is never called, so `click` directives inside a diagram never become real
  event handlers. A diagram cannot make anything happen when you click it.

These are enforced in `apps/web/src/lib/mermaid.ts`, which is the only place allowed to import Mermaid.
