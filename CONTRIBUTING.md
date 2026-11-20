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
- **Fail soft.** Reddit changes its pages without notice. A feature that
  does not find what it needs must stand aside or fall back, never hide what
  it cannot judge, break the page, or stop the other features.
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
- **Write in English** for code, documentation, and commit messages. Write
  interface text in `src/_locales/en/messages.json`, never in code or markup:
  see [Translations](#translations).
- **Commit only source.** Never commit generated packages, browser profiles,
  exported settings, credentials, or personal data.

## When Reddit changes

The fixtures can only show that FrontFilter works on the markup they
describe. The canary, `tests/reddit/canary.py`, loads a few public
reddit.com pages, logged out and in English, with the published extension,
and checks both that Reddit still has the elements FrontFilter relies on and
that they hide. CI cannot run it, since Reddit refuses logged-out visitors
from GitHub's runners, so run it before each release and whenever Reddit
seems to have changed:

```bash
python3 tests/reddit/canary.py --snapshots reddit-snapshots [--firefox /path/to/firefox]
```

A failure says whether Reddit changed or refused the network, and saves the
page as it was, in `reddit-snapshots/` or the folder given.

Reddit gives part of its visitors another markup, as it tries changes on
them, and each run of the canary is a new visitor. A test can so fail in one
run and pass in the next for a fault that is real: do not take a failure
that goes away for chance. A failing run names the visitor it ran as, and
`--visitor ID` runs the canary as that visitor again, on the same markup,
until the fix passes there too.

What does come by chance, the canary handles itself. Its tests wait for what
they read instead of reading it once, and never expect Reddit to keep a
count from one reading to the next: write new ones the same way (`expect`,
`read`). A page that Reddit leaves without its content is loaded again, and
the run says so at its end. Reddit refuses requests from a network that
makes many in a short time (HTTP 429): when a run reports such refusals,
wait a few minutes before the next one.

To fix a change:

1. Look at the pages in `reddit-snapshots/`. Each page is saved with its
   shadow DOM and an inventory of component names, slots and test IDs. Text
   and user details are redacted.
2. Update `tests/fixtures/` to the new markup, so that the browser tests fail
   the way the canary did.
3. Fix the extension until both pass. Reddit's markup is described in one
   place, `src/content/selectors.js`, so most fixes are made there.

The canary cannot sign in, so features shown only to signed-in users and Old
Reddit, which now requires an account, need checking by hand. Keep it light:
it should load a handful of pages. Never commit snapshots.

## Translations

FrontFilter's text is in `src/_locales/`: `en/messages.json` holds English,
the default, and each other folder a translation. By default, browsers show
the translation for their own language, and English for any message it
lacks; **Language**, in the settings, chooses another. Scripts ask for
messages by name (`src/shared/i18n.js`), and pages name theirs with
`data-i18n` attributes.

To add a language:

1. Copy `src/_locales/en/messages.json` to a folder named as browsers name
   the language: `it`, `de`, `pt_BR`.
2. Translate each `message`. Keep the `placeholders` as they are: browsers
   need each translation's own. `$NAME$` marks where a placeholder's value
   goes, and the placeholder's `example` shows one: word the message so
   that it reads right with any value, as an article before a date may not
   (Italian writes “dal 20” but “dall'8”), nor a case that changes a
   number's word (German writes “innerhalb von 2 Tagen”, not “Tage”). The
   `description`s are for translators, and can be left out.
3. Call Reddit's pages, sorts and buttons what Reddit calls them in the
   language, and keep one word for each thing throughout. Where Reddit words
   a thing differently by region, as its Spanish for Spain and for Mexico,
   choose a word that reads right in each, or name the thing as both do.
   Where the regions part further, in their words and in how they address
   the reader, as Portuguese does in Brazil and in Portugal, give each region
   a folder of its own, `pt_BR` and `pt_PT`, with every message: what a
   folder lacks shows in English, not in the other region's words.
4. Set `languageTag` to the language, with a hyphen: `pt-BR`. Dates and
   numbers are written as it writes them: a translation for a region, as
   the region does; one for a whole language, as the browser's variant of
   it does.
5. A message whose name ends in `_one` or `_other` counts something. Add the
   forms the language uses, such as `_few` and `_many` for Polish, by
   [Unicode's plural rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html).
   A form that would read as `_other` can be left out, as Italian's `_many`:
   `_other` stands in for any form missing. Mind which counts a form covers:
   French's `_one` is for 0 as well as 1, and so is Brazilian Portuguese's,
   but not European Portuguese's.
6. Keep `<strong>` and `<code>` tags around the words they mark: no other
   markup shows. Follow the language's typography, its quotation marks and
   apostrophes included, and write a space that must not break as an escape,
   so that it shows: French puts `\u00a0` before a colon and `\u202f`
   before ; ! ? and inside « ».
7. `extensionName` and `extensionDescription` are the extension's name and
   description in the browser and the stores: at most 75 and 132
   characters.
8. Add the language to `LANGUAGES` in `src/shared/core.js`, so that the
   settings offer it, in the order of the languages' own names. A region's
   name follows in brackets, as in “Português (Brasil)”.

`npm test` checks every translation against English: messages English does
not have, placeholders other than English's, and the stores' limits; and
that `LANGUAGES` lists every folder. A
right-to-left language also needs the pages' styles checked, as they lay
out left to right.

When you change interface text:

- Write whole sentences, with placeholders for what changes, rather than
  pieces joined in code: word order and agreement differ between languages.
- Write a message that counts as a plural family, with `_one` and `_other`
  forms and the count as its first placeholder, and show it with `plural()`.
- Name messages with a literal string in `t()`, `plural()` and `parts()`,
  so the tests find them: `npm test` fails on a message that is missing,
  and on one that nothing uses.
- Rename a message whose meaning changes, so that no translation shows the
  old meaning for the new one.

## Releasing

Describe user-facing changes under `## Unreleased` in `CHANGELOG.md` as
they are made. A maintainer releases them from an up-to-date `main`, in a
Python environment with Selenium for the [canary](#when-reddit-changes):

```bash
npm run release -- minor --push
```

The version is `x.y.z`, or `patch`, `minor` or `major` to raise the one in
`src/manifest.json`. The command runs the unit tests and the canary (pass
`--firefox PATH` for its Firefox, or `--skip-canary` if you have just run
it), sets the version in `src/manifest.json`, dates the `Unreleased` entry
of the changelog, commits them and tags the commit `v<version>`. `--push`
pushes `main` and the tag together. Without it nothing leaves your machine,
and `--dry-run` shows the release without changing anything.

The tag starts the release workflow. Once CI passes on the tagged commit, it
builds both packages and drafts a GitHub release with them, their SHA-256
checksums and the changelog entry. Upload `frontfilter-firefox-<version>.xpi`
from the draft to Firefox Add-ons and `frontfilter-chrome-<version>.zip` to
the Chrome Web Store and to Microsoft Edge Add-ons, with the changelog entry
as release notes, then publish the draft.

## Pull requests

Describe the problem and how you solved it, link related issues, and point
out anything users will notice. Confirm that the checks above pass, and test
the change in Firefox and Chrome when you can.

## License

Contributions are licensed under the [Mozilla Public License 2.0](LICENSE),
like the rest of the project.
