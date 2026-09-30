# FrontFilter Privacy Policy

**Last updated: September 21, 2026**

This Privacy Policy explains how the official FrontFilter browser extension
("FrontFilter" or the "Extension") handles information. It applies to the
versions distributed by the FrontFilter project and to builds made directly
from its [public source code](https://github.com/SilentFoxDev/FrontFilter).
Modified or third-party builds may behave differently.

FrontFilter's single purpose is to give users local controls for making Reddit
less distracting: it blocks selected Reddit destinations, filters posts,
simplifies the Reddit interface, and limits infinite scrolling.

## Privacy at a glance

- FrontFilter processes the limited Reddit data described below on your device
  only, for its user-facing features.
- FrontFilter does not send your Reddit activity, page content, or settings to
  the developer.
- The developer operates no server that receives data from the Extension.
- FrontFilter has no accounts, analytics, telemetry, ads, tracking, or
  profiling.
- FrontFilter does not sell, rent, or share user data with third parties.
- Settings are stored locally in your browser profile. FrontFilter does not
  synchronize them through a developer service.
- All executable code is included in the Extension package. FrontFilter does
  not download or execute remote code.

The Chrome Web Store treats access, use, or storage on a user's device as the
handling of user data even when nothing is transmitted. The following sections
therefore describe both persistent local data and information processed only
temporarily.

## Information handled by FrontFilter

### 1. Settings and filter rules

FrontFilter stores the choices you make in its settings interface, including:

- blocked subreddit names, wildcard rules, block modes, and allowed-subreddit
  exceptions;
- words or phrases used to filter post titles and text previews;
- Reddit page-blocking preferences;
- interface, comment-visibility, and video-autoplay preferences;
- feed-limit status, size, and mode; and
- the selected light, dark, or system theme.

Subreddit rules and post-filter terms can reveal interests or preferences, so
they should be treated as private even though FrontFilter never sends them to
the developer.

These settings are used only to apply the controls you selected. They are kept
in the browser's local extension storage. The theme is also cached in local
storage belonging to the Extension so that its pages can use the chosen color
mode before they render. FrontFilter compiles relevant page and subreddit
blocking preferences into dynamic browser rules stored and enforced by the
browser.

FrontFilter uses local storage, not browser synchronization storage. It does
not intentionally upload or synchronize settings between devices.

### 2. Reddit URLs and navigation information

While you use Reddit, FrontFilter locally examines the current Reddit URL,
including its host, path, and relevant query parameters, to:

- identify a Reddit page or subreddit;
- decide whether a destination matches a blocking rule;
- apply page-specific interface and filtering behavior;
- distinguish one feed from another when enforcing a feed limit; and
- return to a destination if a rule is later changed from FrontFilter's block
  page.

If you select **Add Current** in the settings interface, FrontFilter reads the
URL of the active tab at that moment and uses it only to identify the current
subreddit. FrontFilter does not request access to browser history and does not
create a database of websites you visit. Its site access is limited to
`reddit.com` and its subdomains.

When FrontFilter blocks a top-level navigation, it redirects the tab to a page
bundled with the Extension. That internal page's URL contains the original
Reddit URL and a description of the matching rule so the page can explain the
block and restore the destination when appropriate. FrontFilter does not
transmit that internal URL. The browser may retain it through its ordinary
history or session-restoration features according to the browser's settings.

### 3. Content visible on Reddit pages

FrontFilter locally examines selected parts of the Reddit page structure that
are necessary to provide its features. Depending on the features enabled, this
can include:

- subreddit names and Reddit links;
- post identifiers and permalinks;
- post titles and visible text previews, for user-configured term filtering;
- indicators that distinguish ordinary posts from promoted content;
- feed containers, continuation elements, and the current set of feed cards;
  and
- interface, comment, sidebar, navigation, and video elements that the user has
  chosen to hide, modify, or limit.

This information can include public or personalized content served by Reddit.
FrontFilter uses it in memory for the current page and does not persist a copy
of post titles, previews, identifiers, or page content as a browsing-history or
content database. It does not send that content to the developer or to an
analytics or data-processing service.

FrontFilter is not designed to read authentication credentials, cookies,
payment information, private messages, form entries, or precise location. It
does not request browser permissions for cookies, history, identity,
geolocation, or payment data. Its content script necessarily has access to the
Reddit page on which it runs, but the Extension's code uses that access only for
the functionality described in this policy.

### 4. Imported and exported configuration

FrontFilter can import and export its settings as JSON:

- **Import:** FrontFilter reads the file you explicitly select, accepts only
  recognized settings, and stores the resulting configuration locally. The
  original file is not uploaded or retained by FrontFilter.
- **Export:** FrontFilter creates a configuration file locally and asks the
  browser to download it. The file can contain subreddit rules, post-filter
  terms, and all other Extension preferences.

Exported files remain wherever you save them until you move or delete them.
Anyone who can access an exported file can read its contents, so store and
share it accordingly.

### 5. Diagnostics

FrontFilter may write error messages to the browser's local developer console
when an operation fails. The Extension does not transmit those messages, crash
reports, performance measurements, or usage statistics to the developer.

## How information is used

FrontFilter uses the information above only to provide or maintain its
disclosed user-facing functionality. In particular, it is used to:

- block selected Reddit pages and communities;
- allow user-selected exceptions;
- hide posts from selected communities or containing selected terms;
- hide or modify selected Reddit interface and media elements;
- enforce a finite feed window and request the next finite group when chosen;
- display and restore blocked destinations; and
- save, import, export, and apply the user's preferences.

FrontFilter does not use information for advertising, marketing, analytics,
profiling, fingerprinting, eligibility decisions, creditworthiness, lending,
or any unrelated purpose. No automated decision with legal or similarly
significant effects is made about the user.

## Data transmission and third parties

FrontFilter makes no Extension-originated requests to a developer backend,
analytics provider, advertising network, or other data-processing service. It
contains no tracking pixels or telemetry SDKs.

The following network activity can still occur outside that statement:

- **Reddit:** Using Reddit causes the Reddit website to communicate with
  Reddit's servers. When feed limiting needs additional results, FrontFilter
  can invoke Reddit's existing page loader; the resulting request remains a
  Reddit website request and may use the Reddit session already held by the
  browser. FrontFilter does not read or transmit the user's Reddit cookies or
  credentials. Reddit's processing is governed by
  [Reddit's Privacy Policy](https://www.reddit.com/policies/privacy-policy).
- **Browser and extension store:** The browser or store may check for, download,
  and install Extension updates and may process installation or aggregate store
  statistics independently of FrontFilter. Those practices are controlled by
  the relevant browser or store provider, not by the Extension.
- **Links opened by the user:** FrontFilter includes links to its GitHub
  repository, public issue tracker, and Ko-fi donation page. No Extension data
  is sent to those services automatically. If you choose a link, the service
  you visit receives the information ordinarily associated with a web visit
  and applies its own privacy policy. Information posted in the GitHub issue
  tracker is generally public.

FrontFilter is an independent project and is not affiliated with, endorsed by,
or operated by Reddit, Google, Mozilla, GitHub, or Ko-fi.

## Storage, retention, and security

Settings and locally compiled blocking rules remain in the browser profile
until you change them, clear the Extension's data, or uninstall FrontFilter,
subject to the browser's own deletion, backup, and restoration behavior. The
theme cache follows the same general browser-controlled lifecycle.

Transient Reddit page information is discarded when it is no longer needed by
the current document, tab, or Extension process. FrontFilter maintains no
server-side copy. Browser history entries, session data, browser backups, and
exported configuration files are controlled separately by the browser,
operating system, or user.

FrontFilter reduces exposure by keeping processing on the device, limiting
host access to Reddit, and avoiding remote code and developer-operated data
services. Local Extension storage and exported JSON files are not separately
encrypted by FrontFilter; their protection depends on the security of your
device, operating-system account, and browser profile. No software can
guarantee absolute security.

## Browser permissions

FrontFilter requests only the permissions needed for its stated purpose:

| Permission | Why it is required |
| --- | --- |
| `storage` | Saves FrontFilter settings in local extension storage. |
| `declarativeNetRequest` | Creates browser-enforced rules that redirect user-selected blocked Reddit destinations to FrontFilter's bundled block page. |
| Access to `reddit.com` and its subdomains | Runs FrontFilter on Reddit pages, evaluates Reddit URLs and selected page content, applies filtering and interface controls, and supports **Add Current**. |

FrontFilter does not request general access to unrelated websites.

## Your choices and deletion

You can change individual settings, remove filter rules and exceptions, or
disable features at any time in FrontFilter's settings interface.

You can delete FrontFilter's locally stored settings and rules by uninstalling
the Extension or by using browser-provided extension-data controls where
available. Because the developer never receives a copy, the developer cannot
view, retrieve, correct, or delete this local data on your behalf.

Exported configuration files and browser history or backup records are outside
FrontFilter's storage and must be managed separately by you through the
relevant file, browser, or operating-system controls.

## Chrome Web Store Limited Use disclosure

The use of information received from Google APIs will adhere to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/limited-use),
including the Limited Use requirements.

FrontFilter uses information obtained through browser permissions only to
provide or maintain its disclosed single purpose and user-facing features.
FrontFilter does not transfer user data to the developer, advertising
platforms, data brokers, or other third parties; does not use it for
personalized advertising; and does not use it to determine creditworthiness or
for lending purposes.

## Changes to this policy

This policy may be revised if FrontFilter's functionality, permissions, or data
practices change. The current version will be published in the
[source repository](https://github.com/SilentFoxDev/FrontFilter/blob/main/PRIVACY.md)
with a revised **Last updated** date, and earlier versions remain available in
the repository history. Material changes will also be reflected in the
Extension's store disclosures and presented elsewhere when required by
applicable policy or law.

## Contact

For questions or concerns about this policy or FrontFilter's data practices,
open an issue in the
[FrontFilter issue tracker](https://github.com/SilentFoxDev/FrontFilter/issues).
The issue tracker is public, so do not include passwords, authentication data,
private messages, exported configurations, or other sensitive information.

Source code: <https://github.com/SilentFoxDev/FrontFilter>
