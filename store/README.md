# Store images

The images for FrontFilter's store listings, in `images/`, and the scenes
they are rendered from, in `scenes/`.

| Image | Size | Chrome Web Store field |
| --- | --- | --- |
| `1-block-feeds.png` to `5-limit-scrolling.png` | 1280x800 | Screenshots, in this order |
| `small-promo-tile.png` | 440x280 | Small promo tile |
| `marquee-promo-tile.png` | 1400x560 | Marquee promo tile |

The screenshots also suit Firefox Add-ons, which recommends 1280x800.

## Rendering

The scenes embed FrontFilter's real settings page and block page, served
with fake extension APIs and the settings each scene gives them, so the
images follow the extension's interface. Render them again whenever these
pages change visibly:

```bash
npm run store:images -- [--chrome /path/to/chrome] [scene ...]
```

It needs Chrome or Chromium, and Node.js 22 or later. Install the Inter font
for images like the committed ones: the pages ask for the system font, and
the scenes use Inter in its place. `--serve` serves the scenes without
rendering them, to edit them in a browser.

## Guidelines

These follow the Chrome Web Store's
[image guidelines](https://developer.chrome.com/docs/webstore/images) and
[listing advice](https://developer.chrome.com/docs/webstore/best-listing):

- **Exact sizes, no transparency.** The store takes the sizes above, as PNG
  without an alpha channel or as JPEG. The render script checks both.
- **Screenshots are full bleed,** with square corners and no padding, and
  show the real interface. Each one is about one feature, with a short
  caption that stays readable when the store shrinks it. The first one
  matters most: it is the one most people see.
- **Promo tiles carry the brand,** not a screenshot: saturated colors, the
  icon's funnel and little text, so they still work at half size. They avoid
  white and light gray, which blend into the store's page.
- **No one else's brand.** The scenes show no Reddit logo, and their feed
  is an illustration with made-up posts. A dashed outline marks the posts
  FrontFilter hides: on Reddit, they simply disappear.
- **No claims the store has not made,** such as "#1" or "Editor's pick", and
  none FrontFilter cannot back: "No tracking" rests on the
  [privacy policy](../PRIVACY.md).
