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
- Block subreddits by exact name or with `*` wildcards. **Front page** rules
  block a subreddit's front page and sort views; **Everywhere** rules block
  every page of it and hide its posts, and crossposts of them, from other
  feeds.
- Allow exceptions that override subreddit rules.
- Block users by name, `u/name` or profile URL: their posts and comments
  disappear from every Reddit page, and their profiles are blocked.
- Optionally add one-click **Block** buttons to feed posts and subreddit
  pages, with undo.
- Optionally hide the **Open settings** button from the page shown in place
  of blocked content, or go to a website of your choice instead of that page.

### Filter

- Hide posts and comments that contain your keywords, as whole words in any
  case and with or without accents, or inside words with `*`, as in
  `spoiler*`, or that match a regular expression. Allowed keywords keep the
  posts and comments that contain them.
- Hide posts by flair, with `*` wildcards.
- Hide suggested posts in the Home feed, suggested communities, and ads and
  promoted posts.
- Hide NSFW content: posts tagged NSFW and posts from NSFW communities, on
  every Reddit page, Old Reddit included, with the comments on an NSFW
  post's own page.
- Hide spoilers: posts tagged as spoilers, on every Reddit page, Old Reddit
  included, with the comments on a spoiler's own page.

### Simplify

- Hide comments or only their replies, and the right sidebar.
- Hide the navbar and the left sidebar, or only some of their sections.
- Hide votes, karma, awards, avatars, and usernames.
- Turn off video autoplay.

### Limit scrolling

- Show a fixed number of posts, or reveal them in groups of your chosen size.
- Show only the first comments on a post's page, each with its replies, a
  fixed number of them or in groups of your chosen size.

### Statistics

- See how long you spend on Reddit today and on each of the last 7 days, in
  how many visits, with your daily average and how it compares with the week
  before.
- See how many pages FrontFilter blocked, and which most, and how many posts
  and comments its filters hid, and why.
- Statistics stay on your device and are not exported with your settings.
  You can pause them or delete them at any time.

Settings can be exported and imported as JSON. FrontFilter's pages follow your
system theme or use a light or dark one.

## Usage

Open FrontFilter from the browser toolbar or extensions menu. Its tabs
follow the features above: **Block** covers pages, subreddits, users, the
Block buttons and the block page, **Filter** hides suggestions, ads,
sensitive posts, and posts by keyword or flair, **Simplify** limits
scrolling and hides parts of Reddit's pages, **Stats** shows your
statistics, and **Settings** covers the theme, backups, and the project's
links. Changes are saved automatically and apply right away.

In **Stats**, time counts while a Reddit tab is in front and you have
scrolled, clicked or typed in it in the last 5 minutes, and a new visit
starts after 10 minutes away from Reddit. Point at a day of the chart, or
move through the days with the arrow keys, to see its time. The **?**
button beside **Today** explains each figure.

On Reddit, the **Block** tab opens with a card for the page in front. It
names the page and says how many posts and comments your filters hide on
it, as the page shows them now; Old Reddit and search results get no
count. On a subreddit, it also says whether your rules block or allow it,
and blocks or allows it in one click. A switch with sections, such as **Hide navbar**, shows them from
its arrow. To add several rules at once, paste a list into a field of a
list, one per line or separated by commas. A long list shows its first
rules, with a field that searches it and a button that shows it all. The
**?** button next to a list shows how to write its rules. Removing a rule
leaves **Undo** in its place.

Importing a configuration shows what it would change before it does, and
keeps the settings it replaces: **Restore**, under **Configuration backup**,
puts them back. The settings also open in a tab of their own, from the
popup's button beside the save state, or from the browser's extension
settings, as FrontFilter's options.

## Privacy

FrontFilter works entirely on your device. It has no servers, accounts,
analytics, or ads, and never sends your data anywhere. It runs only on
`reddit.com` and asks only for `storage` and
`declarativeNetRequestWithHostAccess` permissions, and in Chrome for
`scripting`. See the [privacy policy](PRIVACY.md) for details.

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
