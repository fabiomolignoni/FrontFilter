# FrontFilter

A browser extension that makes Reddit less distracting: block feeds and
subreddits, filter posts and comments, and limit endless scrolling.

## Install

- [Chrome Web Store](https://chromewebstore.google.com/detail/frontfilter-reddit-feed-d/ekjnpdhgghniefiljlfopdjgoegneiie)
  (Chrome 121 or later)
- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/frontfilter/)
  (Firefox 140 or later, Firefox for Android 142 or later)

To install from source, see [Development](#development).

## Features

### Block

- Block Home, Popular, Explore, News, or every subreddit's front page.
- Block subreddits by exact name or with `*` wildcards. `HOME` rules block a
  subreddit's front page and sort views; `ALL` rules block every page of it and
  hide its posts from other feeds.
- Allow exceptions that override subreddit rules.
- Optionally add one-click **Block** buttons to feed posts and subreddit
  pages, with undo.

### Filter

- Hide posts and comments that contain your keywords.
- Hide posts by flair, with `*` wildcards.
- Hide suggested posts in the Home feed, and ads and promoted posts.

### Simplify

- Hide comments or only their replies, suggested communities, and the right
  sidebar.
- Hide the navbar and the left sidebar, or only some of their sections.
- Hide votes, karma, awards, avatars, and usernames.
- Turn off video autoplay.

### Limit scrolling

- Show a fixed number of posts, or reveal them in groups of your chosen size.

Settings can be exported and imported as JSON. FrontFilter's pages follow your
system theme or use a light or dark one.

## Usage

Open FrontFilter from the browser toolbar or extensions menu. The
**Controls** tab turns features on and off, **Filters** holds subreddit,
keyword, and flair rules, and **Settings** covers the theme, the Block
buttons, and backups. Changes are saved automatically and apply right away.

## Privacy

FrontFilter works entirely on your device. It has no servers, accounts,
analytics, or ads, and never sends your data anywhere. It runs only on
`reddit.com` and asks only for `storage` and `declarativeNetRequest`
permissions. See the [privacy policy](PRIVACY.md) for details.

## Development

FrontFilter has no runtime or npm dependencies. Development requires Node.js
20 or later; building packages also requires Python 3.

```bash
npm test        # unit tests
npm run check   # validate sources and manifests
npm run build   # write Chrome and Firefox packages to dist/
```

`SOURCE_DATE_EPOCH` sets the archive timestamps for reproducible builds.

To try a local copy:

- **Chrome:** open `chrome://extensions`, turn on **Developer mode**, choose
  **Load unpacked**, and select the `src/` folder.
- **Firefox:** run `npm run build`, open
  `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
  and select `dist/frontfilter-firefox-<version>.xpi`.

Optional browser tests drive a local test page with Selenium
(`pip install selenium`) and never visit Reddit:

```bash
python3 tests/browser/firefox.py [--firefox /path/to/firefox]
python3 tests/browser/chrome.py --chrome /path/to/chromium [--driver /path/to/chromedriver]
```

Chrome 137 and later ignore the `--load-extension` switch these tests rely
on, so run the Chrome suite with Chromium or Chrome for Testing.

## Contributing

Bug reports, questions, and focused pull requests are welcome in the
[issue tracker](https://github.com/fabiomolignoni/FrontFilter/issues). Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

Development is human-directed and uses AI coding tools; this note is included
for transparency.

## License

[Mozilla Public License 2.0](LICENSE)
