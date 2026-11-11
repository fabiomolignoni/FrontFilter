# FrontFilter

A browser extension that makes Reddit less distracting: block feeds and
subreddits, filter posts and comments, and limit endless scrolling.

## Install

- [Chrome Web Store](https://chromewebstore.google.com/detail/frontfilter-reddit-feed-d/ekjnpdhgghniefiljlfopdjgoegneiie)
  (Chrome 121 or later)
- [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/frontfilter-reddit-feed/eimajmdhafjkjaomdffniplpgijoemdm)
  (Edge 121 or later)
- [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/frontfilter/)
  (Firefox 140 or later, Firefox for Android 142 or later)

To install from source, see [Development](#development). The
[changelog](CHANGELOG.md) lists what changed in each version.

## Features

### Block

- Block Home, Popular, Explore, News, or every subreddit's front page.
- Block subreddits by exact name or with `*` wildcards. `HOME` rules block a
  subreddit's front page and sort views; `ALL` rules block every page of it and
  hide its posts, and crossposts of them, from other feeds.
- Allow exceptions that override subreddit rules.
- Optionally add one-click **Block** buttons to feed posts and subreddit
  pages, with undo.
- Optionally hide the **Open settings** button from the page shown in place
  of blocked content, or go to a website of your choice instead of that page.

### Filter

- Hide posts and comments that contain your keywords, as whole words in any
  case and with or without accents, or inside words with `*`, as in
  `spoiler*`, or that match a regular expression. Allowed keywords keep the
  posts and comments that contain them.
- Block users by name, `u/name` or profile URL: their posts and comments
  disappear from every Reddit page, and their profiles are blocked.
- Hide posts by flair, with `*` wildcards.
- Hide suggested posts in the Home feed, and ads and promoted posts.
- Hide NSFW content: posts tagged NSFW and posts from NSFW communities, on
  every Reddit page, Old Reddit included, with the comments on an NSFW
  post's own page.
- Hide spoilers: posts tagged as spoilers, on every Reddit page, Old Reddit
  included, with the comments on a spoiler's own page.

### Simplify

- Hide comments or only their replies, suggested communities, and the right
  sidebar.
- Hide the navbar and the left sidebar, or only some of their sections.
- Hide votes, karma, awards, avatars, and usernames.
- Turn off video autoplay.

### Limit scrolling

- Show a fixed number of posts, or reveal them in groups of your chosen size.
- Show only the first comments on a post's page, each with its replies, a
  fixed number of them or in groups of your chosen size.

Settings can be exported and imported as JSON. FrontFilter's pages follow your
system theme or use a light or dark one.

## Usage

Open FrontFilter from the browser toolbar or extensions menu. The
**Controls** tab turns features on and off, grouped by the part of Reddit
they change, **Filters** holds subreddit, user, keyword, and flair rules,
and **Settings** covers the theme, the Block buttons, the block page,
backups, and the project's links. Changes are saved automatically and apply
right away. A switch with sections, such as **Hide navbar**, shows them from
its arrow. To add several rules at once, paste a list into a field of the
**Filters** tab, one per line or separated by commas. The **?** button next
to a setting or list explains it.

## Privacy

FrontFilter works entirely on your device. It has no servers, accounts,
analytics, or ads, and never sends your data anywhere. It runs only on
`reddit.com` and asks only for `storage` and `declarativeNetRequest`
permissions. See the [privacy policy](PRIVACY.md) for details.

## Development

FrontFilter has no runtime or npm dependencies. Development requires Node.js
22 or later; building packages also requires Python 3.

```bash
npm test        # unit tests, and checks of the manifests and pages
npm run build   # the tests, then the Chrome and Firefox packages in dist/
```

`SOURCE_DATE_EPOCH` sets the archive timestamps for reproducible builds.

To try a local copy:

- **Chrome:** open `chrome://extensions`, turn on **Developer mode**, choose
  **Load unpacked**, and select the `src/` folder.
- **Firefox:** run `npm run build`, open
  `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**,
  and select `dist/frontfilter-firefox-<version>.xpi`.

Browser tests load the extension in Firefox and Chrome with Selenium and
check what it hides on local copies of Reddit's markup. They never visit
Reddit, and CI runs them on every push. To run them, install Selenium with
`pip install -r tests/browser/requirements.txt`:

```bash
python3 tests/browser/firefox.py [--firefox /path/to/firefox]
python3 tests/browser/chrome.py --chrome /path/to/chrome [--driver /path/to/chromedriver]
```

Chrome 137 and later ignore the `--load-extension` switch these tests rely
on, so run the Chrome suite with Chromium or Chrome for Testing, which
`npx @puppeteer/browsers install chrome@stable` downloads (and
`chromedriver@stable` its driver). Both suites accept unittest options, such
as `-k navbar` to run only matching tests.

A canary, `tests/reddit/canary.py`, checks the extension on reddit.com
itself to catch changes in Reddit's markup. Reddit refuses CI's runners, so
it runs by hand before each release; see
[CONTRIBUTING.md](CONTRIBUTING.md#when-reddit-changes).

## Contributing

Bug reports, questions, and focused pull requests are welcome in the
[issue tracker](https://github.com/fabiomolignoni/FrontFilter/issues). Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

Development is human-directed and uses AI coding tools; this note is included
for transparency.

## License

[Mozilla Public License 2.0](LICENSE)
