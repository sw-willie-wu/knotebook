# Side-by-side columns

A note can put blocks next to each other in a row of two to four columns — an image beside the text
that describes it, two lists to compare, a short table next to a paragraph. A column holds ordinary
blocks, so anything you can write in a note can go in a column.

## Using columns

**Insert a row** with the slash menu: type `/grid` and pick **2 columns**, **3 columns** or
**4 columns**. `/grid2`, `/grid3` and `/grid4` narrow the menu to one of them, and `/columns`, `/並排`
and `/欄` find all three. In an empty paragraph the row takes the paragraph's place; anywhere else it
goes below the block the cursor is in. The columns start equally wide with an empty paragraph each,
and the cursor moves into the first one. When the row would be the last block of the note, an empty
paragraph is added after it so you can keep writing below. The menu doesn't offer columns while the
cursor is in a column, a table or an indented block: rows sit at the top level of a note and are
never nested.

**Put any block in a column** — text, headings, lists, images, code, tables, diagrams. A table too
wide for its column scrolls sideways inside the column.

**Blocks in a column have no `+` button.** Their side menu shows only ⋮⋮, because the space between
columns is too narrow for both buttons. To add a block in a column, press Enter at the end of a block
there (or with an image selected, press Enter to add a paragraph below it in the same column), or
type `/` in a block that has text and pick a block type: the new block goes below it.

**Columns line up at the top.** A row is as tall as its tallest column, so a shorter column leaves
blank space below its content. That is expected.

**On a narrow screen the row stacks.** A column needs at least 200 pixels, or 96 for a column that
holds only images, plus 24 pixels between columns. When the row is narrower than that, the whole row
turns into its columns one after another, top to bottom, each the full width; a row never wraps
partly. So two columns of images can stay side by side on a phone where two columns of text stack.
This is worked out again whenever the row's width changes — when you resize the window, or change the
note's width (Standard, Wide, Full width).

**Images keep their own width.** An image in a column keeps the width you gave it. When the column is
narrower than the image, the image is only shown smaller, and grows back when there is room again.
Dragging an image's resize handle inside a column stops at the column's width.

Rows show the same way on a note's public page, in presentations and in version comparisons (see
[Known limitations](./known-limitations.md#side-by-side-columns) for how presentations and
comparisons differ).

## Removing columns

**Ungroup columns**, in the ⋮⋮ menu of a block that sits directly in a column, turns the whole row
back into ordinary blocks: everything in the first column, then everything in the second, and so on.
Empty paragraphs are dropped; a row with nothing in it leaves one empty paragraph.

**With the keyboard:**

- Backspace at the start of an empty column, or Delete at the end of the column before it, removes
  that column. When only one column would be left, the row turns back into ordinary blocks.
- In the second or a later column, when the column's first block is a paragraph, Backspace at its
  start moves it to the end of the column before it. Delete at the end of a column's last block does
  the reverse and brings the first block of the next column up. A column this leaves empty is
  removed, so in a row of two columns, *a* and *b*, Backspace at the start of *b* turns the row back
  into the paragraphs *a* and *b*.
- Delete at the end of a block that has blocks nested under it, or in a code block, is left to the
  editor's usual behavior, and so is Backspace at the start of a heading (the first press turns it back
  into a paragraph). See [Known limitations](./known-limitations.md#side-by-side-columns) for the
  keys at the edges of a row.

**Deleting what is in a column doesn't remove the column.** When ⋮⋮ **Delete**, or the delete button
on an image's toolbar, empties a column, the column keeps an empty paragraph and the row stays as it
is. With a selection that spans columns, ⋮⋮ **Delete** keeps the columns too. Only the selected
blocks are deleted; a column the selection empties keeps an empty paragraph.

To delete a whole row, select from above the row to below it and delete, or ungroup it first.

## Copying and pasting

Copying a whole row and pasting it at the top level of a note gives a new row with the same columns
and widths. Pasted inside a column or under an indented block, the row is flattened into its blocks —
the first column's, then the second's, and so on — because rows can't be nested.

A layout copied from a web page — boxes side by side, without Knotebook's column markers — doesn't
become columns; it is pasted as ordinary blocks.

## Columns over MCP, the API and the in-app AI

MCP, the REST API and the in-app AI read and write a row as HTML `<div>` lines with ordinary
Markdown inside each column; the exact form, and what a write refuses, are in
[AI editing](./ai-editing.md#columns). Sending a row back whole and unchanged keeps it, except a row
of more than four columns, which reads back but can't be written.

When a selection reaches across columns, or into or out of a row, the in-app [AI](./ai.md) works on
the whole row: each selected block counts as the top-level block it belongs to, so the action gets
the entire row, and its result replaces it. A selection inside one column works on just the blocks
you selected there; a result for it that contains columns is refused, because rows can't be nested.

## Undo

Creating a row, ungrouping one, and each Backspace or Delete above that moves a block or removes a
column is a single step: one Ctrl+Z undoes it. So is each resize of an image inside a column.
