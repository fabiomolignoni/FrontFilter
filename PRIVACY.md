# FrontFilter Privacy Policy

**Last updated: October 1, 2026**

FrontFilter is a browser extension that helps you use Reddit with fewer
distractions. This policy explains what data the extension handles and what it
does with it. It applies to the versions published by the FrontFilter project
and to unmodified builds of its
[source code](https://github.com/fabiomolignoni/FrontFilter).

## In short

- FrontFilter works entirely on your device. It never sends data anywhere,
  and never sells or shares it.
- It has no servers, accounts, analytics, ads, or tracking, and runs no remote
  code.
- It reads Reddit pages only to apply the features you turn on, and stores only
  your own settings, in your browser.
- It runs only on `reddit.com` and its subdomains.

## What FrontFilter handles

### Your settings

FrontFilter saves the choices you make in its settings, or with its optional
Block buttons on Reddit:

- blocked and allowed subreddits;
- keywords and post flairs you filter;
- the pages, page elements, and features you choose to hide or limit; and
- your color theme.

Filter rules can reveal your interests, so treat them, and any configuration
file you export, as private.

### Reddit addresses (web browsing activity)

On Reddit, FrontFilter reads the address of the current page to decide whether
a rule applies to it. When you click **Add Current** in the settings, it reads
the address of the active tab to find its subreddit. It does not read your
browsing history or any page outside Reddit.

### Reddit page content (website content)

To apply the features you turn on, FrontFilter reads parts of the Reddit
pages you open: subreddit names, post links, titles, text previews, comment
text, flairs, markers that identify ads or suggested posts, and the page
elements you choose to hide or change. This happens in memory, on your device,
and nothing is kept once you leave the page.

FrontFilter never accesses your passwords or cookies, is not designed to read
private messages or what you type, and does not use your location.

## How FrontFilter uses data

Only to provide the features you turn on: blocking pages and subreddits,
filtering posts and comments, hiding page elements, limiting feeds, and
saving, importing, and exporting your settings. Data is never used for
advertising, profiling, or any other purpose, and no person reviews it.

## Where data is stored and for how long

- **Settings** are kept in your browser's local extension storage until you
  change them or uninstall FrontFilter. They are not synchronized between
  devices.
- **Blocking rules** are also stored by the browser as navigation rules, so
  blocked pages are stopped before they load.
- **Theme cache:** your color theme is also cached in the extension's own
  local storage, so its pages open in the right colors.
- **Undo marker:** a one-click block made on a subreddit's own page stores a
  short-lived marker so the block page can offer **Undo block**. It is valid
  for 10 seconds and is deleted by the block page.
- **Block page addresses** contain the address of the Reddit page that was
  blocked, so FrontFilter can explain the block and return you there after
  undoing it. Your browser may keep these addresses in its history like any
  other page.
- **Exported files** stay wherever you save them. Imported files are read once
  and not kept.

FrontFilter does not encrypt its local storage or exported files; their
protection depends on the security of your device and browser profile.

## Sharing and third parties

FrontFilter shares no data with anyone, including its developer. It makes no
network requests of its own. Other parties may still process data on their
own terms:

- **Reddit** receives the requests your browser makes while you use it. When
  the feed limit loads more posts, FrontFilter asks Reddit's own page to load
  them, as scrolling would. Changes FrontFilter makes to Reddit pages, such as
  hidden elements or added buttons, can be seen by Reddit's own page scripts.
  See [Reddit's Privacy Policy](https://www.reddit.com/policies/privacy-policy).
- **Your browser and its extension store** install and update FrontFilter
  under their own policies.
- **GitHub** hosts FrontFilter's project pages, linked from its settings and
  block page. Nothing is sent there unless you open a link.

FrontFilter is an independent project, not affiliated with Reddit, Google,
Mozilla, or GitHub.

## Permissions

| Permission | Why FrontFilter needs it |
| --- | --- |
| `storage` | Save your settings on your device. |
| `declarativeNetRequest` | Let the browser redirect pages you block to FrontFilter's block page. |
| Access to `reddit.com` and its subdomains | Apply your filters and controls on Reddit pages, and find the subreddit for **Add Current**. |

## Your choices

You can change or remove any setting or rule in FrontFilter's settings at any
time. Uninstalling FrontFilter deletes everything it stores, except files you
exported and pages kept in your browser history. Because the developer never
receives your data, there is nothing the developer can access, correct, or
delete on your behalf. If you allow FrontFilter in private windows, it works
there the same way, and settings you change there are saved.

## Chrome Web Store Limited Use

The use of information received from Google APIs will adhere to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use),
including the Limited Use requirements.

## Changes to this policy

If FrontFilter's data practices change, this policy will be updated with a new
date. Every version remains available in the
[repository history](https://github.com/fabiomolignoni/FrontFilter/commits/main/PRIVACY.md).

## Contact

Questions about this policy can be asked in the
[FrontFilter issue tracker](https://github.com/fabiomolignoni/FrontFilter/issues).
Issues are public, so do not include personal information or exported
configuration files.
