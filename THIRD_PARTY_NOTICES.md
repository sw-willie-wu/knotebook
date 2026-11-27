# Third-Party Notices

Knotebook's own code is MIT-licensed (see [LICENSE](./LICENSE)). This file lists
bundled third-party assets that carry a different license.

## Playfair Display (font)

- **Package:** [`@fontsource/playfair-display`](https://www.npmjs.com/package/@fontsource/playfair-display) — bundled as a static font asset in the web app's build output (the sidebar logo's "K"). The browser-tab icon (`apps/web/public/favicon.svg`), the iOS home-screen icon (`apple-touch-icon.png`) and the installed-app icons (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`) are drawn from that font's bold italic "K" glyph (converted to an SVG path with opentype.js from `files/playfair-display-latin-700-italic.woff`; the recipe is in the comment inside `favicon.svg`). The installed-app icons are that path in white on a full-bleed `#676f97` square, rasterized in Chromium by `scripts/generate-pwa-icons.mjs`: scaled 0.79 about the centre of the 64-unit box for `icon-192.png` and `icon-512.png` (matching `apple-touch-icon.png`), 0.6 for `icon-maskable-512.png` so the glyph stays inside the maskable safe zone.
- **Copyright:** Copyright 2017 The Playfair Display Project Authors (https://github.com/clauseggers/Playfair-Display), with Reserved Font Name "Playfair Display".
- **License:** SIL Open Font License, Version 1.1 (OFL-1.1).
- **Full license text:** the `LICENSE` file inside the installed package (`node_modules/@fontsource/playfair-display/LICENSE`), also available at https://scripts.sil.org/OFL.

## KaTeX fonts

- **Package:** [`katex`](https://www.npmjs.com/package/katex) 0.16.47 — math blocks are drawn with it, and the web app loads it on demand. KaTeX's code is MIT-licensed (Copyright (c) 2013-2020 Khan Academy and other contributors; the `LICENSE` file inside the installed package, `node_modules/katex/LICENSE`). The 20 fonts in 12 families in its `dist/fonts/` (the families `KaTeX_AMS`, `KaTeX_Caligraphic`, `KaTeX_Fraktur`, `KaTeX_Main`, `KaTeX_Math`, `KaTeX_SansSerif`, `KaTeX_Script`, `KaTeX_Size1` to `KaTeX_Size4` and `KaTeX_Typewriter`; each font as woff2, woff and ttf) are bundled as static font assets in the web app's build output.
- **Copyright:** Copyright (c) 2009-2010, Design Science, Inc. (<www.mathjax.org>) and Copyright (c) 2014-2018 Khan Academy (<www.khanacademy.org>), with Reserved Font Names KaTeX_AMS, KaTeX_Caligraphic, KaTeX_Fraktur, KaTeX_Main, KaTeX_Math, KaTeX_SansSerif, KaTeX_Script, KaTeX_Size1, KaTeX_Size2, KaTeX_Size3, KaTeX_Size4 and KaTeX_Typewriter (as written in each font file's own name table).
- **License:** SIL Open Font License, Version 1.1 (OFL-1.1).
- **Full license text:** the npm package ships only the MIT license of KaTeX's code, not the OFL, so the text is at https://scripts.sil.org/OFL (the address each font file gives for its license).
- **Modification:** none. The font files are used exactly as the package ships them: not subset, converted or edited, and byte-for-byte identical to the package's files in the build output. The build only rewrites the font addresses in KaTeX's stylesheet, and embeds the smallest font, `KaTeX_Size3-Regular.woff2`, in that stylesheet instead of copying it as a separate file, with the same bytes.

## jsdiff (`diff`)

- **Package:** [`diff`](https://www.npmjs.com/package/diff) — bundled into the web app's build output (the version-history preview compares two versions of a note with it).
- **Copyright:** Copyright (c) 2009-2015, Kevin Decker <kpdecker@gmail.com>.
- **License:** BSD 3-Clause License (BSD-3-Clause).
- **Full license text:** the `LICENSE` file inside the installed package (`node_modules/diff/LICENSE`).

## BlockNote (`@blocknote/core`, modified)

- **Package:** [`@blocknote/core`](https://www.npmjs.com/package/@blocknote/core) 0.52.1 — bundled into the web app's build output (the note editor) and shipped in the container image. Its source code is at https://github.com/TypeCellOS/BlockNote (`packages/core`). `@blocknote/react` and `@blocknote/mantine` 0.52.1, which the web app also bundles, are under the same license and are not modified.
- **License:** Mozilla Public License, Version 2.0 (MPL-2.0).
- **Full license text:** the `LICENSE` file inside the installed package (`node_modules/@blocknote/core/LICENSE`), also available at https://www.mozilla.org/MPL/2.0/.
- **Modification:** Knotebook ships `@blocknote/core` modified. The only change is [`patches/@blocknote__core@0.52.1.patch`](./patches/@blocknote__core@0.52.1.patch) in this repository, applied with `pnpm patch`: it adds `<` to the characters a backslash can escape in the package's Markdown parser.

## Lucide (icon paths, adapted)

- **Source:** [Lucide](https://lucide.dev) (https://github.com/lucide-icons/lucide). It is not an npm dependency of Knotebook: the SVG path data of a number of its icons was copied and adapted, in the same style, into the inline icon components `apps/web/src/components/ui/icons.tsx` and `apps/web/src/components/ui/icons-extra.tsx` (each adapted icon is marked with a comment naming the Lucide icon it comes from). They are bundled into the web app's build output.
- **Copyright:** Copyright (c) 2026 Lucide Icons and Contributors. Some of the Lucide icons are derived from Feather, Copyright (c) 2013-present Cole Bemis (MIT License); the upstream license file lists which.
- **License:** ISC License; MIT License for the Feather-derived icons.
- **Full license text:** the `LICENSE` file in the upstream repository, https://github.com/lucide-icons/lucide/blob/main/LICENSE, reproduced below (the list of Feather-derived icon names is omitted here, see the upstream file).

```text
ISC License

Copyright (c) 2026 Lucide Icons and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

The MIT License (MIT) (for the Feather-derived icons)

Copyright (c) 2013-present Cole Bemis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
