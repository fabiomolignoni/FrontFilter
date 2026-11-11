# Changelog

Notable changes to FrontFilter, newest first.

## Unreleased

### Added

- The **Block** tab can hide the block page's **Open settings** button,
  so a blocked page offers only **Go back**, and **Undo block** after a
  one-click block.
- Blocked pages can lead to a website of your choice instead of the block
  page, from the **Block** tab. A one-click **Block** on a subreddit's
  own page still shows the block page, which offers **Undo block**, and so
  does any blocked page while the chosen website is a blocked Reddit page
  itself.
- Keywords written between slashes, such as `/colou?r/`, are regular
  expressions, matched ignoring case.
- **Allowed keywords**, in the **Filter** tab: keyword filters never hide a
  post or comment that contains one of them.
- A list of subreddits, users, keywords or flairs pasted into a field of one
  of the settings page's lists, one per line or separated by commas, adds a
  rule for each.
  Commas inside a regular expression, as in `/a{1,3}/`, do not split it.
- **Comment limit**, in the **Simplify** tab: a post's page shows only its
  first comments, each with its replies, and stops there or shows the next
  group on request, as the scroll limit does with posts. Comments hidden by
  filters do not count, and Reddit loads no more comments while the limit
  is reached.
- **Hide NSFW content**, in the **Filter** tab: posts tagged NSFW, and
  posts from communities tagged NSFW, hide from feeds, search results,
  community highlights, the posts suggested beside a post, and Old Reddit.
  On an NSFW post's own page, its comments hide with it. Hidden posts do not
  count toward the scroll limit.
- **Hide spoilers**, in the **Filter** tab: posts tagged as spoilers hide
  from feeds, search results, community highlights, the posts suggested
  beside a post, and Old Reddit. On a spoiler's own page, its comments hide
  with it. Hidden posts do not count toward the scroll limit.

### Changed

- The settings page and the block page have a new design, and the settings
  page's tabs follow what you want to do. **Block** holds the blocked pages,
  subreddits and users, the Block buttons and the block page's options.
  **Filter** hides suggestions, ads, sensitive posts, and posts by keyword
  or flair. **Simplify** holds the scroll and comment limits, and hides
  parts of Reddit's pages. **Settings** keeps the theme, backups, and the
  version and project links. Settings, filters and exported configurations
  are unchanged.
- Subreddit rules' modes are called **Front page** and **Everywhere**, for
  HOME and ALL, which read as Reddit's own Home feed and r/all.
- A setting whose name does not say it all says the rest below it, instead
  of behind a **?** button. The **?** buttons that remain show how to write
  a list's rules, with examples.
- On a subreddit, the **Block** tab opens with a card that names it, says
  whether your rules block or allow it, and offers **Block** and **Allow**.
  It replaces the **Add current** buttons, and every list now has one
  **Add** button.
- A list of more than 8 rules shows its first 6, with **Show all** and a
  field that searches it, ignoring case and accents. Rules just added,
  pasted or merged always show.
- A switch whose sections are only partly on says how many, as in "2 of 6
  hidden". Rules take less space, and text is easier to read in both color
  modes.
- Keywords match whole words and ignore accents: `ai` no longer hides
  "said", and `perche` hides "Perché". A `*` at an end lets a keyword match
  inside words there, as in `spoiler*` or `*ai*`. In Chinese, Japanese,
  Korean and Thai text, keywords still match inside words. Keywords that
  differ only in their accents, such as `perche` and `perché`, are one
  keyword.
- Keywords you already have keep hiding what they hid: on update, FrontFilter
  adds `*` to their ends, so `ai` becomes `*ai*`. Remove the stars to match
  whole words only. Configurations exported by earlier versions import the
  same way. A keyword that was text between slashes or with a `*` at an end,
  such as `/r/`, becomes a regular expression that finds that text.
- The settings page's help texts are shorter, and each shows from the **?**
  button next to the setting or list it explains.

### Fixed

- `ALL` rules also hide crossposts of the subreddit's posts from other
  subreddits and feeds, and the scroll limit no longer counts them.

## 2.4.0 - 2026-10-12

### Added

- Block users from the **Filters** tab, by name, `u/name` or profile URL.
  Their posts and comments, with the replies to those comments, are hidden
  on every Reddit page, Old Reddit included, their posts never count toward
  the scroll limit, and their profile pages are blocked.

## 2.3.1 - 2026-10-02

### Changed

- The block page names the rule that blocks a page only when it is a
  pattern, such as `*news*`, and its buttons read **Go back**, **Open
  settings** and **Undo block**.
- In the settings, a subreddit, keyword or flair added twice merges into one
  row, and entries that cannot be used, such as a blocked subreddit with
  spaces or a flair over 100 characters, are explained instead of being
  cleared silently.
- Screen readers no longer announce the FrontFilter logo next to its name.
- FrontFilter does less work on long feeds: it reads a post again only when
  the post or the settings change, and changes to timestamps, counters and
  menus no longer make it go over the page.

### Fixed

- A post that links to a thread in a subreddit blocked in ALL mode is no
  longer hidden as if it were from that subreddit.
- A user profile typed as a subreddit rule, such as `u/name`, is reported as
  invalid instead of blocking or allowing the subreddit r/u, and posts from
  user profiles no longer count as posts from r/u. So is a prefix typed
  alone, such as `r/` or `u/`.
- **+ Add current** reports that it found no subreddit on tabs outside
  Reddit, instead of doing nothing.
- In Chrome and Edge, a subreddit rule too complex for the browser to check
  before a page loads, such as a long HOME rule or a pattern with several
  `*` wildcards, no longer stops every other page block, such as Popular,
  from applying. That rule blocks its pages once they load.
- The settings page shows changes made elsewhere while it is open, such as
  with a **Block** button, **Undo block** or another settings window, and
  saving a list there no longer undoes them.
- Keyword filters check a comment again when its text changes, so a comment
  whose text arrives after it appears is hidden too.
- Turning **Disable video autoplay** off restores each video's autoplay
  settings as Reddit set them, values included.

## 2.3.0 - 2026-10-01

### Added

- FrontFilter is available for Microsoft Edge 121 or later, from Microsoft
  Edge Add-ons.

### Changed

- A group's main switch, such as **Hide navbar**, shows a mixed state while
  only some of its parts are hidden, instead of a summary. Turning it off
  turns its parts off too, comment replies included.
- Each subreddit has at most one block rule. When rules for the same
  subreddit differ, ALL wins over HOME, and a one-click **Block** turns a
  HOME rule into ALL; undo turns it back.

### Fixed

- Turning **Disable video autoplay** off starts videos already on screen,
  and later ones as they scroll into view.
- **Hide usernames** no longer hides the post author's avatar in subreddit
  feeds.

## 2.2.0 - 2026-10-01

### Added

- Hide ads and promoted posts.
- Hide votes, karma, awards, avatars and usernames, all at once or one by one.
- Hide suggested posts in the Home feed: posts from communities you have not
  joined.
- Hide posts by flair, with `*` wildcards.
- Keyword filters also hide the comments that contain a keyword, with their
  replies.
- Optional one-click **Block** buttons on feed posts and subreddit pages, with
  undo.

### Changed

- Grouped controls, such as the navbar and left sidebar sections, collapse
  under their main switch and summarize what they hide.
- Links point to the project's new repository, and the privacy policy is
  rewritten.

### Fixed

- Comments that link to a subreddit blocked in ALL mode are no longer hidden.
- Hidden parts of Reddit, such as the navbar or ads, no longer show briefly
  while a page loads.
