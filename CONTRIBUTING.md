# Contributing to FrontFilter

Thanks for helping improve FrontFilter.

## Report a bug or propose a change

Search the [issue tracker](https://github.com/SilentFoxDev/FrontFilter/issues)
before opening a new issue. For bugs, include:

- FrontFilter and browser versions;
- the Reddit layout and relevant settings;
- steps to reproduce, expected behavior, and actual behavior.

Open an issue before starting a large feature or architectural change. Remove
usernames, cookies, tokens, browsing details, and private filter lists from all
reports and attachments.

## Make a change

Use Node.js 20 or newer and Python 3. The project has no npm dependencies, so a
checkout is ready to test without `npm install`.

```bash
npm test
npm run check
npm run build
git diff --check
```

Keep each change focused, preserve existing settings and browser compatibility,
and add regression coverage for changed behavior. Use English for source code,
UI text, documentation, and commit messages. Do not commit generated archives,
browser profiles, exported settings, credentials, or personal data.

Optional browser tests require Selenium and local browser binaries. See the
[development section](README.md#development) for commands.

## Pull request checklist

- Explain the problem and the chosen solution.
- Link related issues and call out user-visible changes.
- Confirm that the commands above pass.
- Test affected behavior in Firefox and Chrome when practical.
- Update user documentation when behavior or permissions change.
