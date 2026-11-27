# Presentations

Presenting a note as slides. Part of [Known limitations](../known-limitations.md).

- **A presentation opened from a public link is not live.** It picks up changes only when the page fetches the note again — for example when the tab regains focus — and then stays on the same slide when it can.
- **The cover slide's title can lag behind a rename by someone else.** The title comes from the note's details, not from the live document, so another person's rename reaches the cover when your copy of the note is refreshed (for example when the tab regains focus).
- **A link to a note in a presentation can show an old title.** In the app, it opens the linked note in a new tab (one to a note that was deleted, or that you can't see, can't be clicked); one with no text of its own keeps the linked note's old title until that slide's content changes — renaming the linked note does not redraw the slides by itself. On a public link (even if you are signed in) it is plain text that can't be clicked, showing the link's own text, or the text the link was made with (#269).
- **The presentation overview (O) shows the content of only the slides near the current one.** Up to 10 slides either side (6 on a phone) are drawn; farther ones are empty frames until you move closer. This is reveal.js's view distance.
- **Opening a presentation link while signed out starts at the cover after you sign in.** The slide part of the address (`#/…`) is not carried through sign-in.
- **Changing the slide part of the address by hand while presenting does not move to that slide.** It is read when the presentation opens; reload to jump there.
- **On touch screens, a swipe doesn't change slides on a slide that scrolls, on a table, on a code block or a formula too wide to fit, or on a video or audio player.** There a swipe is left to the content, which scrolls if it can; use the arrows on the screen to move between slides.
- **iPhone Safari can't show a presentation full screen.** It fills the browser window instead.
- **Diagrams in a presentation follow the same rules as in the editor**, including that a diagram can load images from other sites (see [Diagrams](../diagrams.md)).
- **Opening a presentation removes any other query parameters from the address.** The address is rewritten to end in exactly `?present` (keeping whatever follows the `#`) before the slides start, so that nothing else in the address can change how the presentation behaves.
- **A link to a `#…` anchor inside a slide isn't clickable.** The presentation would otherwise take it as a jump to another slide.
