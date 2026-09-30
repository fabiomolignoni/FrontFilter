# FrontFilter

FrontFilter is a browser extension for making Reddit less distracting. It
blocks unwanted destinations and communities, removes selected interface
elements, filters posts, and replaces endless scrolling with a finite feed.

## Features

- Block Home, Popular, Explore, News, or every subreddit front page.
- Block exact or wildcard subreddit names. `HOME` rules cover front and sort
  pages; `ALL` rules also cover posts and other pages in that subreddit.
- Allow exact subreddit exceptions to override subreddit rules.
- Filter post titles and text previews by keyword or phrase.
- Hide comments, suggested communities, navigation controls, sidebar sections,
  and related posts, or disable video autoplay.
- Show a fixed number of feed posts or reveal them in finite groups.
- Import and export settings as JSON, with system, light, and dark themes.

All filtering and settings stay in the browser. FrontFilter has no analytics,
accounts, ads, or remote services. See [PRIVACY.md](PRIVACY.md) for details.

## Browser support

| Browser | Minimum version |
| --- | ---: |
| Chrome | 121 |
| Firefox | 140 |
| Firefox for Android | 142 |

## Install from source

Node.js 20 or newer and Python 3 are required to build release archives.

```bash
npm run build
```

For Chrome, open `chrome://extensions`, enable **Developer mode**, choose
**Load unpacked**, and select `src/`. For Firefox, open
`about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on**, and
select the generated `dist/frontfilter-firefox-<version>.xpi` file.

The source manifest is directly loadable by Chrome. The build applies
`manifests/firefox.json` to create the Firefox package and writes both archives
to `dist/`.

## Development

FrontFilter has no runtime or npm package dependencies.

```bash
npm test       # unit and DOM-harness regression tests
npm run check  # source and manifest validation
npm run build  # deterministic Firefox and Chrome archives
```

Set `SOURCE_DATE_EPOCH` to control archive timestamps.

Optional Selenium suites exercise packaged extensions against local fixtures;
they do not visit Reddit:

```bash
python3 tests/browser/firefox.py --firefox /path/to/firefox
python3 tests/browser/chrome.py --chrome /path/to/chrome
```

Install Selenium in a temporary virtual environment before running those
commands. Chrome requires `--chrome`; Firefox uses the system browser when
`--firefox` is omitted.

## Permissions

| Permission | Why it is needed |
| --- | --- |
| `storage` | Save settings in the local browser profile. |
| `declarativeNetRequest` | Redirect blocked Reddit navigations to the bundled block page. |
| Access to `reddit.com` | Apply filters and identify the current subreddit for **Add Current**. |

## Contributing

Bug reports and focused pull requests are welcome. Read
[CONTRIBUTING.md](CONTRIBUTING.md) before making a change.

Development is human-directed and uses AI coding tools. This note is included
for transparency.
