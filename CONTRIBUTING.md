# Contributing to FrontFilter

Thanks for helping improve FrontFilter. Bug reports, questions, and focused
pull requests are all welcome.

## Questions and bug reports

Use the [issue tracker](https://github.com/fabiomolignoni/FrontFilter/issues)
and search it first. For a bug, include:

- the FrontFilter and browser versions;
- the Reddit page and the settings involved;
- the steps to reproduce it, and what you expected to happen.

Issues are public: remove usernames, cookies, tokens, private filter lists,
and exported configurations from reports and screenshots.

To report a security problem, do not open a public issue. Use GitHub's
[private vulnerability reporting](https://github.com/fabiomolignoni/FrontFilter/security/advisories/new)
instead (**Security** tab, **Report a vulnerability**): only you and the
project's maintainers can see the report.

## Proposing changes

Open an issue before starting a large feature or architectural change, so the
approach can be agreed first. Small fixes can go straight to a pull request.

## Development setup

You need Node.js 22 or later, and Python 3 to build packages. There are no npm
dependencies, so there is no `npm install` step. See the README's
[Development](README.md#development) section for loading a local copy and
running the Selenium browser tests.

Before opening a pull request, run the same checks as CI:

```bash
npm run build    # unit tests and static checks, then packaging
git diff --check # whitespace errors
```

CI runs these, and the Firefox and Chrome browser tests, on every push and
pull request. Run the browser tests yourself when you change page behavior.

## Guidelines

- **Keep changes focused.** One problem per pull request.
- **Keep compatibility.** Existing settings and exported configurations must
  keep working, and so must the minimum browser versions in the README.
- **Match Reddit by structure, never by text.** Find elements by tag,
  attribute, slot, or `data-testid`: Reddit's visible text is translated.
- **Mind performance.** Prefer CSS for hiding elements, and keep the work done
  on each page change small, since Reddit pages change constantly.
- **No dependencies or remote code.** Everything the extension runs must be in
  its package.
- **Test the change.** Add unit tests in `tests/unit/` for logic, such as
  settings, rules and matching; they run the scripts with fake browser APIs,
  and the settings and block pages with their real markup (see
  `tests/unit/helpers.js`). For anything that depends on Reddit's markup,
  add a browser test in `tests/browser/page_tests.py` and extend the fixtures
  in `tests/fixtures/`, following Reddit's current markup: only a browser can
  show that a rule hides the right element. Tests must never load reddit.com,
  except the canary described below.
- **Update the documentation.** Change the README when features change, and
  [PRIVACY.md](PRIVACY.md) when permissions or data handling change.
- **Write in English** for code, interface text, documentation, and commit
  messages.
- **Commit only source.** Never commit generated packages, browser profiles,
  exported settings, credentials, or personal data.

## When Reddit changes

The fixtures can only show that FrontFilter works on the markup they
describe. Every week, a scheduled workflow runs `tests/reddit/canary.py`,
which loads a few public reddit.com pages, logged out and in English, with
the published extension, and checks both that Reddit still has the elements
FrontFilter relies on and that they hide. When a check fails, the workflow
opens an issue. The log says whether Reddit changed or refused the runner.

To fix a failure:

1. Download the run's `reddit-snapshots` artifact, or run the canary yourself
   with `python3 tests/reddit/canary.py --snapshots reddit-snapshots`. Each
   page is saved with its shadow DOM and an inventory of component names,
   slots and test IDs. Text and user details are redacted.
2. Update `tests/fixtures/` to the new markup, so that the browser tests fail
   the way the canary did.
3. Fix the extension until both pass. Reddit's markup is described in one
   place, `src/content/selectors.js`, so most fixes are made there.

The canary cannot sign in, so features shown only to signed-in users and Old
Reddit, which now requires an account, need checking by hand. Keep it light:
it should load a handful of pages, and run on demand only when needed.
Never commit snapshots.

## Releasing

1. Set the new version in `src/manifest.json`, and describe user-facing
   changes in `CHANGELOG.md`.
2. On `main`, once CI passes, tag the release (`git tag v<version>`) and run
   `SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) npm run build`, which writes
   both packages to `dist/`.
3. Upload `dist/frontfilter-firefox-<version>.xpi` to Firefox Add-ons and
   `dist/frontfilter-chrome-<version>.zip` to the Chrome Web Store and to
   Microsoft Edge Add-ons, with the changelog entry as release notes.

## Pull requests

Describe the problem and how you solved it, link related issues, and point
out anything users will notice. Confirm that the checks above pass, and test
the change in Firefox and Chrome when you can.

## License

Contributions are licensed under the [Mozilla Public License 2.0](LICENSE),
like the rest of the project.
