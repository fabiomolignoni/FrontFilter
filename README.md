# FrontFilter

[![CI](https://github.com/fabiomolignoni/FrontFilter/actions/workflows/ci.yml/badge.svg)](https://github.com/fabiomolignoni/FrontFilter/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/fabiomolignoni/FrontFilter)](https://github.com/fabiomolignoni/FrontFilter/releases/latest)
[![License: MPL 2.0](https://img.shields.io/badge/license-MPL--2.0-blue)](LICENSE)

A browser extension that makes Reddit less distracting: block feeds and
subreddits, filter posts and comments, and limit endless scrolling. It works
entirely on your device, with no account, servers or tracking.

## Install

| Browser | Store | Requires |
| --- | --- | --- |
| Chrome | [Chrome Web Store](https://chromewebstore.google.com/detail/frontfilter-reddit-feed-d/ekjnpdhgghniefiljlfopdjgoegneiie) | Chrome 121 |
| Edge | [Microsoft Edge Add-ons](https://microsoftedge.microsoft.com/addons/detail/frontfilter-reddit-feed/eimajmdhafjkjaomdffniplpgijoemdm) | Edge 121 |
| Firefox | [Firefox Add-ons](https://addons.mozilla.org/firefox/addon/frontfilter/) | Firefox 140, Firefox for Android 142 |

To run it from source, see [Development](#development). The
[changelog](CHANGELOG.md) lists what changed in each version.

## Features

- **Block pages.** Home, Popular, Explore, News, every subreddit's front
  page, or subreddits of your choice, on their front page or everywhere. A
  blocked page shows a block page, or leads to a website you choose. Block
  Home's For You feed alone, and Home opens on Following.
- **Filter posts and comments** by keyword, flair or user, and hide ads,
  suggested posts and communities, NSFW posts and spoilers.
- **Simplify Reddit.** Hide comments or their replies, the navbar, the
  sidebars, votes, karma, awards, avatars and usernames, and turn off video
  autoplay.
- **Limit scrolling.** Show a fixed number of posts, or of top-level
  comments, or reveal them in groups of a size you choose.
- **See your statistics.** Time on Reddit and visits, today and over the last
  7 days, and what FrontFilter blocked and hid. You can pause or delete them.
- **Lock your settings** until a date you choose. Changes that block or hide
  more apply at once; changes that loosen your settings wait, from an hour to
  a week or until the lock ends, and can be cancelled.
- **Block in one click**, optionally, from buttons on feed posts and
  subreddit pages, with undo.
- **Export and import** your settings as JSON, with a backup of what an
  import replaces. Light, dark or system theme.

## Usage

Open FrontFilter from the browser toolbar. Changes are saved as you make
them and apply to open Reddit tabs right away. On Reddit, the **Block** tab
starts with a card for the page in front: how many posts and comments your
filters hide on it and, on a subreddit, buttons to block or allow it.

Rules go in lists, one per row. Paste several at once, one per line or
separated by commas. Each list's **?** button shows its syntax:

| List | A rule is | Examples |
| --- | --- | --- |
| Subreddits | a name, a pattern with `*`, or a Reddit URL | `news`, `gam*`, `*` |
| Keywords | a whole word or phrase, ignoring case and accents; `*` at an end to match inside words; or a `/regular expression/` | `ai`, `spoiler*`, `/colou?r/` |
| Flairs | a flair, or a pattern with `*` | `Meme`, `*politic*` |
| Users | a name, `u/name` or a profile URL | `u/spez` |

A `+` before a subreddit, keyword or flair makes it an exception, which
overrides the list's other rules: block `*` and allow `+askscience` to keep
only that subreddit.

While settings are locked, a bar under the tabs says until when, and
**Settings lock**, in **Settings**, lists the changes that wait. For 10
minutes, a change made while locked, or a new lock, can be taken back at
once. Settings that no impulse would loosen stay free to change: ads,
avatars, awards, usernames, the left sidebar's Resources, the Block buttons,
the block page's options, the theme and statistics.

## Privacy and permissions

FrontFilter has no servers, accounts, analytics or ads, and never sends your
data anywhere: settings and statistics stay in your browser. It runs only on
`reddit.com`. The [privacy policy](PRIVACY.md) has the details.

| Permission | Why |
| --- | --- |
| Access to `reddit.com` | Hide and filter what Reddit's pages show |
| `storage` | Keep your settings and statistics on your device |
| `declarativeNetRequestWithHostAccess` | Redirect blocked Reddit pages before they load |
| `alarms` | Apply the settings lock's waiting changes when they are due |
| `scripting` (Chrome and Edge) | Count time on Reddit tabs already open when FrontFilter updates |

## Development

FrontFilter has no runtime or npm dependencies. You need Node.js 22 or
later, and Python 3 to build packages.

```bash
npm test        # unit tests, and checks of the manifests and pages
npm run build   # the tests, then the Chrome and Firefox packages in dist/
```

To try a local copy, load `src/` as an unpacked extension from
`chrome://extensions` (with **Developer mode** on), or run `npm run build`
and load `dist/frontfilter-firefox-<version>.xpi` as a temporary add-on from
`about:debugging#/runtime/this-firefox`.

```text
src/
  manifest.json   Chrome's manifest; manifests/firefox.json holds Firefox's overrides
  shared/         settings, rule matching, statistics, the settings lock, the theme
  background/     navigation rules, and the one writer of statistics and the lock
  content/        what runs on Reddit: filters, limits, Block buttons
  popup/          the settings page, as the toolbar popup and in a tab
  blocked/        the page shown in place of a blocked one
scripts/          packaging and releases
tests/            unit tests, browser tests on local fixtures, the Reddit canary
```

Browser tests load the extension in Firefox and Chrome with Selenium, on
local copies of Reddit's markup. They never visit Reddit, and CI runs them
on every push:

```bash
pip install -r tests/browser/requirements.txt
python3 tests/browser/firefox.py [--firefox /path/to/firefox]
python3 tests/browser/chrome.py --chrome /path/to/chrome [--driver /path/to/chromedriver]
```

The Chrome suite needs Chromium or Chrome for Testing, as Chrome 137 and
later ignore `--load-extension`: `npx @puppeteer/browsers install
chrome@stable` downloads it, and `chromedriver@stable` its driver. Both
suites take unittest options, such as `-k navbar`. Set `SOURCE_DATE_EPOCH`
for reproducible packages.

Reddit changes its pages without notice. Everything FrontFilter relies on in
Reddit's markup is in `src/content/selectors.js`, and a canary,
`tests/reddit/canary.py`, checks the extension on reddit.com itself before
each release. See [CONTRIBUTING.md](CONTRIBUTING.md#when-reddit-changes).

## Contributing

Bug reports, questions and focused pull requests are welcome in the
[issue tracker](https://github.com/fabiomolignoni/FrontFilter/issues); read
[CONTRIBUTING.md](CONTRIBUTING.md) first. Report security problems
privately, through
[GitHub's vulnerability reporting](https://github.com/fabiomolignoni/FrontFilter/security/advisories/new).

Development is human-directed and uses AI coding tools; this note is included
for transparency.

## License

[Mozilla Public License 2.0](LICENSE)
