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

To report a security problem, do not describe it in a public issue. Open an
issue asking for a private contact instead, without details.

## Proposing changes

Open an issue before starting a large feature or architectural change, so the
approach can be agreed first. Small fixes can go straight to a pull request.

## Development setup

You need Node.js 20 or later, and Python 3 to build packages. There are no npm
dependencies, so there is no `npm install` step. See the README's
[Development](README.md#development) section for loading a local copy and
running the optional Selenium browser tests.

Before opening a pull request, run the same checks as CI:

```bash
npm test         # unit tests
npm run build    # source and manifest validation, then packaging
git diff --check # whitespace errors
```

CI runs these on every push and pull request.

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
- **Test the change.** Add unit tests in `tests/unit/` and, for page behavior,
  extend the fixture in `tests/fixtures/` used by the browser tests. Tests
  must never load reddit.com.
- **Update the documentation.** Change the README when features change, and
  [PRIVACY.md](PRIVACY.md) when permissions or data handling change.
- **Write in English** for code, interface text, documentation, and commit
  messages.
- **Commit only source.** Never commit generated packages, browser profiles,
  exported settings, credentials, or personal data.

## Pull requests

Describe the problem and how you solved it, link related issues, and point
out anything users will notice. Confirm that the checks above pass, and test
the change in Firefox and Chrome when you can.

## License

Contributions are licensed under the [Mozilla Public License 2.0](LICENSE),
like the rest of the project.
