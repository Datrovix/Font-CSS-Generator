# Font CSS Generator

A drop-in font pipeline for any frontend project. Put your font files in one folder,
run a single command, and get:

- **`.woff2` builds** of every font — lossless, Google woff2 encoder under the hood
- **`fonts.css`** with correct `@font-face` rules generated from file names —
  including real axis ranges for **variable fonts** (`font-weight: 100 900`)
- **preload fragments** for any stack (plain HTML, Astro, JSX/React — or your own template)

Think of it as a tiny, dependency-light build tool that does *only* fonts,
so you can copy the folder into a static site, an Astro layout, or a React app.

## Quick start

```bash
npm install
# put .ttf / .otf / .woff / .woff2 files into assets/fonts/src/
npm run fonts
```

Output of `npm run fonts`:

```
✓ Roboto-Bold.ttf → Roboto-Bold.woff2 (156 KB → 69 KB)
...
Done: 23 converted, 0 copied, 0 failed
✓ styles — assets\css\fonts.css (23 faces, 2 variable)
✓ preload — partials\fonts-preload.html (2 tags)
```

## How it works

One script, three phases, each can be toggled in `project.config.js`:

1. **Convert** — every `.ttf/.otf/.woff` in `src` is compressed to `.woff2` in `dest`.
   Ready-made `.woff2` in `src` are just copied. The raw sfnt buffer goes straight
   through the Google encoder, so **nothing is dropped**: hinting, kerning, variable
   axes (`fvar`/`gvar`/`HVAR`/`STAT`) — everything a naive object-based converter
   silently loses. With `cleanDest: true` the `dest` folder always mirrors `src`.
2. **Styles** — `fonts.css` is regenerated from the `.woff2` files in `dest`
   (see [naming](#font-naming-convention)). Each file is decoded and its `fvar`
   table parsed, so variable fonts get honest ranges instead of a fixed `400`.
3. **Preload** — a fragment file with `<link rel="preload">` tags (or imports)
   rendered through a template — see [preload templates](#preload-templates).

## Font naming convention

The generator derives `font-family`, `font-weight` and `font-style` from the file
name. Tokens are matched **from right to left**, everything unrecognized stays in
the family name and is joined with spaces:

| File name | Result |
|---|---|
| `Roboto-Regular` | `"Roboto"` / 400 / normal |
| `Roboto-Bold` | `"Roboto"` / 700 / normal |
| `Roboto-BoldItalic` or `Roboto-Bold-Italic` | `"Roboto"` / 700 / italic |
| `Roboto-Italic` | `"Roboto"` / 400 / italic |
| `Roboto-ExtraLightItalic` | `"Roboto"` / 200 / italic |
| `Playfair-Display-Variable` | `"Playfair Display"` / variable / normal |
| `Playfair-Display-Italic-Variable` | `"Playfair Display"` / variable / italic |
| `Roboto` | `"Roboto"` / 400 / normal |

Weight tokens: `thin/hairline` 100, `extralight/ultralight` 200, `light` 300,
`regular/normal` 400, `medium` 500, `semibold/demibold` 600, `bold` 700,
`extrabold/ultrabold` 800, `black/heavy` 900, `extrablack/ultrablack` 950.

Spaces in file names are sanitized to `-` on output, so `Roboto Condensed-Bold.ttf`
→ `Roboto-Condensed-Bold.woff2` → `font-family: "Roboto Condensed"`.

### Variable fonts

Name them `Family-Variable.ttf` / `Family-Italic-Variable.ttf`
(`Variable` is always the last token, no weight — the range replaces it).
The generator reads the actual axes from the font:

```css
@font-face {
	font-family: "Roboto";
	font-display: swap;
	src: url("../fonts/Roboto-Variable.woff2") format("woff2");
	font-weight: 100 900;
	font-stretch: 75% 100%;
	font-style: normal;
}
```

Now `font-weight: 137` in CSS selects a real instance, not a synthesized fake.

## Configuration — `project.config.js`

```js
export const fonts = {
	src: 'assets/fonts/src',     // source fonts (.ttf, .otf, .woff, .woff2)
	dest: 'assets/fonts',        // woff2 output folder
	css: 'assets/css/fonts.css', // generated styles file
	cssUrl: '',                  // url() prefix in CSS; '' = computed (relative css → dest)

	convert: true,               // phase 1 on/off
	generateCss: true,           // phase 2 on/off

	preload: {                   // phase 3 on/off
		enable: true,
		files: ['Roboto-Variable', 'Sk-Modernist-Regular'], // 'all' or names without .woff2
		out: 'partials/fonts-preload.html', // fragment file to write (any extension)
		template: '',            // '' = plain html tags; 'html' | 'astro' | 'jsx' | path to .tpl
		url: '',                 // base url for href; '' = '/' + dest
	},

	keepSource: true,            // keep originals after conversion
	cleanDest: true,             // dest mirrors src (old builds removed before conversion)
	fontDisplay: 'swap',         // font-display value
}
```

**Details**

- Three independent address systems, don't mix them up:
  `cssUrl` is the `url()` prefix inside the generated css — **relative** (css file → dest),
  computed automatically, leave it empty in almost every case;
  `preload.url` is the **http** path for `<link href>` (`''` = `'/' + dest`, override it
  for subfolder deployments like `/my-app/assets/fonts`, CDN urls, or Astro `public/`
  which is served from the root);
  `{{path}}` in templates is a **file-system** relative path computed from the output
  file location to each font — always automatic, nothing to configure.
- `preload.files`: matching is case-insensitive, the `.woff2` suffix is optional;
  an unknown name prints a warning and does not fail the build; `'all'` takes every
  woff2 in `dest` in config order for listed names, alphabetical for `'all'`.
- `preload.enable: false` — the fragment file is neither created nor updated.
- `template` resolution: a short name (`'html'`, `'astro'`, `'jsx'`) maps to
  `tools/fonts/templates/preload.<name>.tpl`; a value with a slash (or ending in
  `.tpl`) is a path from the project root; empty string uses the built-in plain-html
  output. Missing template file → error logged, fragment not written.

## Preload templates

The preload phase renders a template file, so the output fits the stack you use.
**Templates are editable source files** — the `Generated by ... do not edit manually`
header lives in the template and is copied into the output fragment (it warns about
the *generated* file and points back to the template it came from).
Bundled templates live in `tools/fonts/templates/`:

`preload.html.tpl` — plain `<link>` tags:

```html
<!-- Generated by tools/fonts/fonts.js from tools/fonts/templates/preload.html.tpl — do not edit manually -->
<link rel="preload" href="/assets/fonts/Roboto-Variable.woff2" as="font" type="font/woff2" crossorigin>
```

`preload.astro.tpl` — a real Astro component with asset imports (bundler resolves
and hashes the URLs, which is what frameworks need):

```astro
---
// Generated by tools/fonts/fonts.js from tools/fonts/templates/preload.astro.tpl — do not edit manually
import RobotoVariable from '../assets/fonts/Roboto-Variable.woff2';
---
<link rel="preload" href={RobotoVariable} as="font" type="font/woff2" crossorigin>
```

`preload.jsx.tpl` — a React component. Write your own `.tpl` for any other stack.

Template syntax: repeat the `{{#tags}} ... {{/tags}}` block per font (multiple
blocks allowed — e.g. imports and markup in Astro), variables:

| Variable | Example | Use |
|---|---|---|
| `{{url}}` | `/assets/fonts/Roboto-Variable.woff2` | http path (`preload.url` or `'/' + dest`) |
| `{{path}}` | `../assets/fonts/Roboto-Variable.woff2` | fs-relative path to the output file, for `import` |
| `{{file}}` | `Roboto-Variable.woff2` | file name |
| `{{name}}` | `Roboto-Variable` | base name |
| `{{var}}` | `RobotoVariable` | JS identifier: hyphens/spaces stripped, deduped |

## Project layout

```
project.config.js            // the only file you edit per project
tools/fonts/
├── fonts.js                 // the script (npm run fonts)
└── templates/               // preload output templates (*.tpl)
assets/fonts/src/            // original fonts
assets/fonts/                // generated .woff2
assets/css/fonts.css         // generated styles
partials/fonts-preload.html  // generated preload fragment
index.html                   // demo/test page
examples/                    // reference material (FLS vite template etc.), not used at build
```

## Integrating into an existing project

1. Copy `tools/fonts/` and `project.config.js` into the project root
   (add `"fonts": "node tools/fonts/fonts.js"` to `package.json`).
2. Point `src`/`dest`/`css` at the project's structure and configure `preload`.
3. Static site: leave `dest` inside the public folder so `{{url}}` works.
   Astro/Vite: put fonts where the bundler can import them, use the `astro`/`jsx`
   template, or adjust the import base inside a copied `.tpl`.

Requires Node.js 20+ (`fonteditor-core` is the only dependency).
