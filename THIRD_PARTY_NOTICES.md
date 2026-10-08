# Third-Party Notices

Knotebook's own code is MIT-licensed (see [LICENSE](./LICENSE)). This file lists
bundled third-party assets that carry a different license.

## Playfair Display (font)

- **Package:** [`@fontsource/playfair-display`](https://www.npmjs.com/package/@fontsource/playfair-display) — bundled as a static font asset in the web app's build output (the sidebar logo's "K"). The browser-tab icon (`apps/web/public/favicon.svg`) and the iOS home-screen icon (`apple-touch-icon.png`) are drawn from that font's bold italic "K" glyph (converted to an SVG path with opentype.js from `files/playfair-display-latin-700-italic.woff`; the recipe is in the comment inside `favicon.svg`).
- **Copyright:** Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display".
- **License:** SIL Open Font License, Version 1.1 (OFL-1.1).
- **Full license text:** the `LICENSE` file inside the installed package (`node_modules/@fontsource/playfair-display/LICENSE`), also available at https://scripts.sil.org/OFL.
