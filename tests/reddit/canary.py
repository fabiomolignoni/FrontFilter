"""Canary tests: the published extension on the real reddit.com.

Run: python3 tests/reddit/canary.py [--firefox PATH] [--snapshots DIR] [--visitor ID] [unittest options]

The fixture tests show that the extension works on the markup the fixtures
describe. These tests show that reddit.com still uses that markup. In
Firefox, with an unmodified build, they load a few public pages logged out
and in English, change settings from the extension's own settings page and
check what the reader would see. CI cannot run them, since Reddit refuses
logged-out visitors from GitHub's runners: run them by hand before each
release.

Features that only exist for signed-in users (the left navigation sections,
chat, notifications, karma, suggested Home posts) and Old Reddit, which now
requires an account, cannot be checked here: test them by hand.

Reddit is no fixture. Each run meets other posts, and pages keep loading,
rendering and recycling their content while the tests read them: tests wait
for what they check, look for the content they need and skip when Reddit
shows none. A page whose content never comes is loaded again, and the run
says so at its end. Reddit also gives part of its visitors another markup,
and every run is a new visitor: a run can fail where the one before passed,
for a fault that is real. A failing run names its visitor, and --visitor
runs the canary as that visitor again, on the same markup.

With --snapshots, each page visited is saved to that folder, redacted, with
an inventory of its component names, slots and test IDs. A failing test
always saves the page as it was then, there or in reddit-snapshots/.
CONTRIBUTING.md explains how to use them to update the fixtures.
"""
import argparse
import json
from pathlib import Path
import re
import sys
import tempfile
import time
import unittest

from selenium.common.exceptions import WebDriverException
from selenium.webdriver.support.ui import WebDriverWait

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))
import harness  # noqa: E402

REDDIT = "https://www.reddit.com"
ROOT = Path(__file__).resolve().parents[2]
WINDOW_SIZE = (1440, 1000)
PAGE_TIMEOUT = 45
EFFECT_TIMEOUT = 15
# How long a feed may take to load a page of posts.
FEED_TIMEOUT = 20
# How often a page is read while a test waits for it, in seconds.
POLL_INTERVAL = 0.25
# Reddit sometimes refuses the requests a page makes for its content, as
# when it gets many in a short time: the page is then loaded again, after a
# pause that grows with each attempt.
LOAD_ATTEMPTS = 3
RELOAD_PAUSE = 10
# The cookie by which Reddit knows a logged-out visitor, and chooses the
# markup it gives them.
VISITOR_COOKIE = "loid"
SNAPSHOT_SCRIPT = Path(__file__).with_name("snapshot.js").read_text() + "\nreturn snapshotPage();"
OPTIONS = argparse.Namespace(firefox=None, snapshots=None, visitor=None)

# Defines deep(selector) to search open shadow roots too, visible(element),
# countVisible(selector), feedPosts(), feedLoader(), creditBar(post),
# outline(element), hasSpoilerTag(element) and searchResults(). Prepended
# to page scripts.
PAGE_HELPERS = """
const deep = (selector, root = document) => {
  const found = Array.from(root.querySelectorAll(selector));
  for (const element of root.querySelectorAll("*")) {
    if (element.shadowRoot) found.push(...deep(selector, element.shadowRoot));
  }
  return found;
};
const visible = (element) => Boolean(element?.isConnected) && element.getClientRects().length > 0
  && getComputedStyle(element).visibility !== "hidden";
const countVisible = (selector) => deep(selector).filter(visible).length;
const feedPosts = () => Array.from(document.querySelectorAll("main shreddit-feed shreddit-post"))
  .filter((post) => !post.parentElement.closest("shreddit-post"));
// The loader of the feed's next page, after its last post.
const feedLoader = () => Array.from(
  document.querySelectorAll('main shreddit-feed faceplate-partial[slot="load-after"]')).at(-1) || null;
// A post's own credit bar: slim cards, such as link posts, hold it inside.
const creditBar = (post) => Array.from(post.querySelectorAll('[slot="credit-bar"]'))
  .find((bar) => bar.closest("shreddit-post") === post) || null;
// The tags an element holds, two levels deep: enough to tell one of
// Reddit's layouts from another.
const outline = (element, depth = 2) => element.localName + (depth > 0 && element.children.length > 0
  ? `(${Array.from(element.children, (child) => outline(child, depth - 1)).join(" ")})` : "");
const hasSpoilerTag = (element) => !!element.querySelector('.content-tags [icon-name="caution-fill"]');
// Post results on a search page, in either layout, what their tracking data
// says of each post, and whether a divider follows each.
const searchResults = () => Array.from(document.querySelectorAll("search-telemetry-tracker"))
  .filter((tracker) => tracker.matches('[data-testid="search-sdui-post"]')
    || tracker.querySelector(':scope > [data-testid="search-post-with-content-preview"]'))
  .map((result) => {
    let post = {};
    try {
      post = JSON.parse(result.getAttribute("data-faceplate-tracking-context")).post || {};
    } catch {}
    const divider = result.nextElementSibling?.localName === "hr" ? result.nextElementSibling : null;
    return {
      id: post.id, nsfw: post.nsfw, spoiler: post.spoiler, shown: visible(result),
      divided: !!divider, dividerShown: visible(divider),
    };
  });
"""
# What the extension leaves on a page: the rules it writes, the attributes
# it marks elements with and the elements it adds, all named after it.
FOOTPRINT = """
const attributes = {};
const elements = {};
const count = (table, name) => { table[name] = (table[name] || 0) + 1; };
for (const element of deep("*")) {
  for (const {name} of element.attributes) if (name.startsWith("data-frontfilter-")) count(attributes, name);
  for (const name of element.classList) if (name.startsWith("frontfilter-")) count(elements, name);
}
return {
  rules: deep('style[id^="frontfilter-"]').map((style) => style.textContent).filter(Boolean),
  attributes, elements,
};
"""
# Whole words, as keywords match them: no letter or digit next to them.
# Plain letters only, which every way of comparing text reads alike.
WORD = re.compile(r"(?<![^\W_])[A-Za-z]{5,}(?![^\W_])")
# A subreddit's name, and not a profile's, which Reddit names u_<user>.
SUBREDDIT = re.compile(r"(?!u_)\w{2,21}", re.ASCII | re.IGNORECASE)
USER = re.compile(r"[\w-]{1,20}", re.ASCII)


class NotReady(AssertionError):
    """A page lacks what the tests use, though another load may bring it."""


class NotServed(NotReady):
    """Reddit served no page of its own."""


def shorten(value, length=300):
    text = repr(value)
    return text if len(text) <= length else f"{text[:length]}… ({len(text)} characters)"


class Browser:
    """Firefox with the published extension: one window for Reddit, one for settings."""

    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="frontfilter-canary-")
        self.driver = harness.start_firefox(OPTIONS.firefox)
        # The visitor Reddit takes this run for, once a page has loaded.
        self.visitor = None
        # Whether a test failed, the pages loaded again and why, and what
        # Reddit served when it would serve no page of its own.
        self.failed = False
        self.reloads = []
        self.refusal = None
        try:
            addon = harness.build_extension(Path(self.temp.name) / "frontfilter.xpi", "firefox")
            self.driver.install_addon(str(addon), temporary=True)
            self.driver.set_window_size(*WINDOW_SIZE)
            self.page_window = self.driver.current_window_handle
            # Separate windows keep both pages active, unlike background tabs.
            self.driver.switch_to.new_window("window")
            self.settings_window = self.driver.current_window_handle
            self.driver.get(f"moz-extension://{harness.FIREFOX_UUID}/popup/index.html?standalone=true")
            WebDriverWait(self.driver, harness.TIMEOUT).until(
                lambda driver: driver.find_element("id", "add-subreddit").is_enabled()
            )
            self.driver.switch_to.window(self.page_window)
            if OPTIONS.visitor:
                # A cookie is set from a page of its website.
                self.driver.get(f"{REDDIT}/robots.txt")
                self.driver.delete_all_cookies()
                self.driver.add_cookie({
                    "name": VISITOR_COOKIE, "value": OPTIONS.visitor,
                    "domain": ".reddit.com", "path": "/", "secure": True,
                })
        except Exception:
            self.quit()
            raise

    def remember_visitor(self):
        """Reads the visitor's cookie, from a Reddit page."""
        if not self.visitor:
            cookie = self.driver.get_cookie(VISITOR_COOKIE)
            self.visitor = cookie and cookie["value"]

    def report(self):
        """What the run met on Reddit, for its reader."""
        lines = []
        if self.reloads:
            lines.append("Reddit left pages without their content, and they were loaded again:")
            lines.extend(f"  {reload}" for reload in self.reloads)
        if self.failed and self.visitor and not self.refusal:
            lines.append(
                "Reddit gives part of its visitors another markup, and each run is a new visitor."
                " To run the canary again as this run's visitor:"
            )
            lines.append(f"  python3 tests/reddit/canary.py --visitor '{self.visitor}'")
        return "\n".join(lines)

    def run_in_settings(self, script, *values):
        self.driver.switch_to.window(self.settings_window)
        try:
            return self.driver.execute_async_script(script, *values)
        finally:
            self.driver.switch_to.window(self.page_window)

    def quit(self):
        self.driver.quit()
        self.temp.cleanup()


BROWSER = None


def setUpModule():
    global BROWSER
    BROWSER = Browser()


def tearDownModule():
    BROWSER.quit()


class RedditTestCase(unittest.TestCase):
    """Loads one Reddit page per class; each test starts from default settings.

    Tests wait for what they read: Reddit loads and renders on its own
    time, and so does the extension once a setting changes. They never
    expect Reddit to keep a count from one reading to the next.
    """

    path = None
    # What the extension leaves on the page with default settings.
    defaults = None

    @classmethod
    def setUpClass(cls):
        cls.reset_settings()
        if not cls.path:
            return
        try:
            cls.open_page()
            # The extension writes its rules once it has read its settings.
            found, cls.defaults = cls.poll(lambda: cls.js(FOOTPRINT), lambda footprint: footprint["rules"])
            if not found:
                raise AssertionError("the extension wrote no rules on the page: it may not run there")
        except Exception:
            cls.save_failure(f"{cls.__name__}.setUpClass")
            raise
        cls.save_snapshot(cls.__name__)

    @classmethod
    def open_page(cls):
        """Loads the page the class's tests share."""
        cls.load_ready(cls.path, cls.page_ready)

    @classmethod
    def page_ready(cls):
        """Waits for the parts of the page the tests use."""

    def setUp(self):
        self.reset_settings()
        self.wait_for_defaults()

    @property
    def driver(self):
        return BROWSER.driver

    @classmethod
    def js(cls, script, *values):
        return BROWSER.driver.execute_script(PAGE_HELPERS + script, *values)

    @classmethod
    def poll(cls, read, accept, timeout=EFFECT_TIMEOUT, interval=POLL_INTERVAL):
        """Reads the page until a value is accepted: whether one was, and the last value read."""
        deadline = time.monotonic() + timeout
        while True:
            try:
                value = read()
            except WebDriverException as error:
                # The page changed under the script: read it again.
                value = error
            else:
                if accept(value):
                    return True, value
            if time.monotonic() >= deadline:
                return False, value
            time.sleep(interval)

    @classmethod
    def wait_until(cls, condition, message, timeout=EFFECT_TIMEOUT, interval=POLL_INTERVAL):
        """Waits until a condition holds on the page, which is not ready otherwise."""
        found, value = cls.poll(condition, bool, timeout, interval)
        if not found:
            raise NotReady(f"{message}: {value}" if isinstance(value, Exception) else message)
        return value

    @classmethod
    def load(cls, path):
        if BROWSER.refusal:
            # Reddit serves this network no page: more loads would only wait.
            raise NotServed(BROWSER.refusal)
        driver = BROWSER.driver
        url = path if path.startswith("http") else REDDIT + path
        try:
            driver.get(url)
        except WebDriverException as error:
            raise NotServed(f"{url} did not load: {error.msg}") from None
        # Reddit may first serve a JavaScript check that reloads the page.
        served, _ = cls.poll(lambda: driver.execute_script(
            "return document.readyState === 'complete' && !!document.querySelector('shreddit-app')"
        ), bool, PAGE_TIMEOUT)
        if not served:
            text = driver.execute_script("return document.body?.innerText.slice(0, 300) || ''")
            raise NotServed(
                f"Reddit did not serve {url}: it may be blocking automated browsers from this"
                f" network. Title {driver.title!r}, URL {driver.current_url}, text {text!r}"
            )
        BROWSER.remember_visitor()

    @classmethod
    def refused_requests(cls):
        """The page's requests that Reddit refused, which tell its limits from a change of its markup."""
        try:
            return sorted(set(BROWSER.driver.execute_script("""
                return performance.getEntriesByType("resource")
                  .filter((entry) => entry.responseStatus >= 400 && entry.name.startsWith(location.origin))
                  .map((entry) => `${new URL(entry.name).pathname} (HTTP ${entry.responseStatus})`);
            """)))
        except WebDriverException:
            return []

    @classmethod
    def load_ready(cls, path, ready):
        """Loads a page until it has what the tests use.

        Reddit sometimes refuses a page's requests for its content, which
        then never comes: only another load brings it.
        """
        for attempt in range(1, LOAD_ATTEMPTS + 1):
            try:
                cls.load(path)
                ready()
                return
            except NotReady as error:
                if BROWSER.refusal:
                    raise
                refused = cls.refused_requests()
                reason = f"{error}; Reddit refused {', '.join(refused)}" if refused else str(error)
                if attempt == LOAD_ATTEMPTS:
                    if isinstance(error, NotServed):
                        BROWSER.refusal = reason
                    raise NotReady(reason) from None
                BROWSER.reloads.append(f"{path}: {reason}")
                time.sleep(RELOAD_PAUSE * attempt)

    @classmethod
    def load_feed(cls, posts):
        """Waits until the feed shows this many posts.

        Reddit renders a feed's first posts and loads its next page once the
        loader after them is within two windows of the one in view. After
        tall posts it is not, and nothing loads until the reader scrolls:
        bringing the loader into view loads the page wherever it is.
        """
        def loaded():
            return cls.js("""
                if (feedPosts().filter(visible).length >= arguments[0]) return true;
                feedLoader()?.scrollIntoView({block: "end"});
                return false;
            """, posts)
        cls.wait_until(loaded, f"the feed did not load {posts} posts", FEED_TIMEOUT)
        cls.js("window.scrollTo(0, 0)")

    @classmethod
    def reset_settings(cls):
        result = BROWSER.run_in_settings(harness.RESET_SCRIPT)
        assert result == {"success": True}, result

    @classmethod
    def wait_for_defaults(cls):
        """Waits until the page is as default settings leave it.

        The page applies a change of settings on its own time, so the last
        test's settings could still show when the next one reads the page.
        """
        if cls.defaults is None:
            return
        restored, footprint = cls.poll(lambda: cls.js(FOOTPRINT), lambda footprint: footprint == cls.defaults)
        if not restored:
            changed = {
                key: {"now": footprint[key], "default": cls.defaults[key]}
                for key in cls.defaults if footprint[key] != cls.defaults[key]
            } if isinstance(footprint, dict) else footprint
            raise AssertionError(f"the page kept what earlier settings changed: {shorten(changed, 1500)}")

    def configure(self, **settings):
        result = BROWSER.run_in_settings(harness.STORE_SCRIPT, settings)
        self.assertEqual(result, {"success": True})

    @classmethod
    def save_snapshot(cls, name, folder=None):
        """Saves the page to the folder for snapshots, or to the one given, and returns where."""
        folder = folder or OPTIONS.snapshots
        if not folder:
            return None
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        snapshot = BROWSER.driver.execute_script(SNAPSHOT_SCRIPT)
        (folder / f"{name}.html").write_text(snapshot["html"])
        (folder / f"{name}.json").write_text(json.dumps(snapshot["inventory"], indent=2, sort_keys=True) + "\n")
        return folder / f"{name}.html"

    @classmethod
    def save_failure(cls, name):
        """Saves the Reddit page as it was when a test, or the setup of its class, failed."""
        try:
            if BROWSER.driver.current_url.startswith(REDDIT):
                saved = cls.save_snapshot(f"{name}.failure", OPTIONS.snapshots or ROOT / "reddit-snapshots")
                print(f"\nSaved the page as it was to {saved}", file=sys.stderr)
        except Exception as error:
            print(f"\nCould not save a snapshot: {error}", file=sys.stderr)

    def run(self, result=None):
        problems = lambda: len(result.failures) + len(result.errors)
        before = problems() if result else 0
        outcome = super().run(result)
        if result and problems() > before and BROWSER:
            BROWSER.failed = True
            self.save_failure(f"{type(self).__name__}.{self._testMethodName}")
        return outcome

    def expect(self, script, expected, message, *values):
        """Waits until a page script returns the expected value."""
        found, value = self.poll(lambda: self.js(script, *values), lambda value: value == expected)
        if not found:
            self.fail(f"{message}: expected {expected!r}, got {value!r}")

    def read(self, script, accept, message, *values, timeout=EFFECT_TIMEOUT):
        """Waits until a page script returns a value that is accepted, and returns it."""
        found, value = self.poll(lambda: self.js(script, *values), accept, timeout)
        if not found:
            self.fail(f"{message}: {value!r}")
        return value

    def visible_counts(self, selectors):
        return self.js(
            "return Object.fromEntries(Object.entries(arguments[0])"
            ".map(([name, selector]) => [name, countVisible(selector)]))",
            selectors,
        )


def choose_word(text, avoid):
    """A word of the text that occurs in none of the other texts."""
    others = " ".join(avoid).lower()
    for word in sorted(set(WORD.findall(text)), key=len, reverse=True):
        if word.lower() not in others:
            return word
    return None


class FeedTests(RedditTestCase):
    path = "/r/popular/"

    @classmethod
    def page_ready(cls):
        cls.load_feed(5)

    def visible_posts(self):
        """The posts the feed shows, once it shows a few."""
        return self.read("""
            return feedPosts().filter(visible).map((post) => ({
              id: post.id,
              subreddit: post.getAttribute("subreddit-name") || "",
              title: post.getAttribute("post-title") || "",
              author: post.getAttribute("author") || "",
            }));
        """, lambda posts: len(posts) >= 5, "the feed shows fewer than 5 posts")

    def test_feed_markup_the_extension_relies_on(self):
        # Reddit adds posts before it renders their buttons: the feed is
        # read until no post lacks a part.
        self.read("""
            const posts = feedPosts();
            const parts = {
              description: (post) => ["subreddit-name", "permalink", "post-title"]
                .every((name) => post.getAttribute(name)),
              wrapperAndDivider: (post) => post.parentElement.localName === "article"
                && post.parentElement.nextElementSibling?.localName === "hr",
              title: (post) => post.querySelector('[slot="title"]'),
              voteGroup: (post) => post.shadowRoot?.querySelector(".rpl-vote-button-group button[upvote]"),
              commentButton: (post) => post.shadowRoot?.querySelector('[data-action-bar-action="comments"]'),
            };
            return {
              posts: posts.length,
              lacking: Object.fromEntries(Object.entries(parts)
                .map(([part, has]) => [part, posts.filter((post) => !has(post)).map((post) => post.id)])
                .filter(([, ids]) => ids.length > 0)),
            };
        """, lambda markup: markup["posts"] >= 5 and not markup["lacking"],
            "feed posts lack parts the extension relies on")
        self.expect("""
            return {
              loader: feedLoader()?.getAttribute("loading"),
              // Reddit's feed and posts start the next page with load(); the
              // page bridge guards it, and loads with loadContent().
              load: typeof customElements.get("faceplate-partial")?.prototype.load,
              loadContent: typeof customElements.get("faceplate-partial")?.prototype.loadContent,
              bridge: document.documentElement.hasAttribute("data-frontfilter-feed-bridge"),
            };
        """, {"loader": "programmatic", "load": "function", "loadContent": "function", "bridge": True},
            "the scroll limit cannot drive Reddit's feed loader")

    def test_all_mode_rule_hides_a_subreddits_posts(self):
        posts = self.visible_posts()
        subreddit = next((post["subreddit"] for post in posts if SUBREDDIT.fullmatch(post["subreddit"])), None)
        self.assertIsNotNone(subreddit, f"no post names its subreddit: {posts}")
        self.configure(blockedSubreddits=[{"name": subreddit, "mode": "all"}])
        self.expect("""
            const posts = feedPosts();
            const shown = (post) => visible(post) || visible(post.closest("article"));
            const isTarget = (post) =>
              (post.getAttribute("subreddit-name") || "").toLowerCase() === arguments[0].toLowerCase();
            return {target: posts.filter(isTarget).some(shown), others: posts.some((post) => !isTarget(post) && shown(post))};
        """, {"target": False, "others": True}, f"posts from r/{subreddit} stayed visible", subreddit)

    def test_blocked_users_posts_hide(self):
        posts = self.visible_posts()
        author = next((post["author"] for post in posts if USER.fullmatch(post["author"])), None)
        self.assertIsNotNone(author, f"no post names its author: {posts}")
        self.configure(blockedUsers=[author])
        self.expect("""
            const posts = feedPosts();
            const shown = (post) => visible(post) || visible(post.closest("article"));
            const isTarget = (post) => post.getAttribute("author")?.toLowerCase() === arguments[0].toLowerCase();
            return {target: posts.filter(isTarget).some(shown), others: posts.some((post) => !isTarget(post) && shown(post))};
        """, {"target": False, "others": True}, f"posts by u/{author} stayed visible", author)

    def test_keywords_hide_posts_by_title(self):
        posts = self.visible_posts()
        target, word = next(
            ((post, word) for post in posts[:8]
             if (word := choose_word(post["title"], [other["title"] for other in posts if other is not post]))),
            (None, None),
        )
        self.assertIsNotNone(word, f"no distinctive title word among {[post['title'] for post in posts]}")
        self.configure(blockedTitleKeywords=[word])
        self.expect("""
            return {target: visible(document.getElementById(arguments[0])), others: feedPosts().some(visible)};
        """, {"target": False, "others": True}, f"the post titled {target['title']!r} stayed visible", target["id"])

    def test_ads_and_promoted_posts_hide(self):
        ads = {"feed": "main shreddit-feed shreddit-ad-post", "sidebar": "shreddit-sidebar-ad"}
        before = self.visible_counts(ads)
        if not any(before.values()):
            self.skipTest("no ads on this page load")
        self.configure(hideAds=True)
        self.expect(
            "return Object.values(arguments[0]).map(countVisible).every((count) => count === 0)",
            True, f"ads stayed visible, before: {before}", ads,
        )

    def test_nsfw_tags_the_extension_relies_on(self):
        # Reddit shows no NSFW post to logged-out visitors: check that posts
        # still take the tags, and that hiding tagged posts keeps the others.
        observed = self.js("return customElements.get('shreddit-post')?.observedAttributes || []")
        self.assertLessEqual({"nsfw", "subreddit-nsfw"}, set(observed), "posts no longer take NSFW tags")
        self.configure(hideNsfw=True)
        self.expect("""
            const tagged = (post) => post.hasAttribute("nsfw") || post.hasAttribute("subreddit-nsfw");
            const shown = (post) => visible(post) || visible(post.closest("article"));
            const posts = feedPosts();
            return {tagged: posts.filter(tagged).some(shown), others: posts.filter((post) => !tagged(post)).some(shown)};
        """, {"tagged": False, "others": True}, "NSFW posts stayed visible, or other posts were hidden")

    def test_votes_and_comment_buttons_hide_inside_posts(self):
        # Hiding the comment buttons comes with "All comments", which the
        # settings page saves with the replies switch.
        controls = """
            const inPosts = (selector) => feedPosts().flatMap((post) =>
              Array.from(post.shadowRoot?.querySelectorAll(selector) || [])).filter(visible).length;
            return {
              votes: inPosts("button[upvote], button[downvote]") > 0,
              comments: inPosts('[data-action-bar-action="comments"]') > 0,
              share: countVisible("shreddit-post-share-button") > 0,
            };
        """
        self.expect(controls, {"votes": True, "comments": True, "share": True},
                    "posts lack vote, comment or share buttons")
        self.configure(hideVotes=True, hideComments=True, hideCommentReplies=True)
        self.expect(controls, {"votes": False, "comments": False, "share": True},
                    "vote or comment buttons stayed visible, or other actions were hidden")

    def test_navbar_sections_hide_without_the_logo(self):
        sections = {
            "search": "reddit-header-large reddit-search-large",
            "profile": "reddit-header-large #expand-user-drawer-button",
            "login": 'reddit-header-large [data-part="primary"] a',
            "signup": 'reddit-header-large [data-part="secondary"] a',
            "logo": "reddit-header-large #reddit-logo",
        }
        shown = (
            "return Object.fromEntries(Object.entries(arguments[0])"
            ".map(([name, selector]) => [name, countVisible(selector) > 0]))"
        )
        self.expect(shown, dict.fromkeys(sections, True), "navbar parts missing", sections)
        self.configure(hideNavbarSearch=True, hideNavbarProfile=True, hideNavbarOthers=True)
        self.expect(
            shown, {"search": False, "profile": False, "login": False, "signup": False, "logo": True},
            "navbar sections did not hide as expected", sections,
        )
        self.configure(blockHomepage=True)
        self.expect("return countVisible(arguments[0])", 0, "the logo stayed visible", sections["logo"])
        # The whole navbar goes, with the space Reddit reserves for it.
        navbar = """
            const app = getComputedStyle(document.querySelector("shreddit-app"));
            return {
              navbar: visible(document.querySelector("reddit-header-large")),
              height: app.getPropertyValue("--shreddit-header-height").trim(),
              space: app.paddingTop,
            };
        """
        self.read(
            navbar,
            lambda before: re.fullmatch(r"[1-9]\d*px", before["height"]) and before["space"] == before["height"],
            "Reddit no longer sizes its navbar, or reserves its space, this way",
        )
        self.configure(hideNavbar=True)
        self.expect(navbar, {"navbar": False, "height": "0px", "space": "0px"}, "the navbar or its space stayed")

    def test_left_and_right_sidebars_hide(self):
        sidebars = (
            "return [countVisible('#left-sidebar-container'), countVisible('#right-sidebar-container'),"
            " feedPosts().filter(visible).length > 0]"
        )
        self.expect(sidebars, [1, 1, True], "the page lacks a sidebar, or its feed")
        self.configure(hideLeftSidebar=True, hideRelatedPosts=True)
        self.expect(sidebars, [0, 0, True], "a sidebar stayed visible, or the feed was hidden")

    def test_block_buttons_join_each_posts_credit_bar(self):
        # Every post of a subreddit gets a button in its credit bar, before
        # Join, however Reddit lays the bar out: it gives part of its
        # visitors another layout, and slim cards hold the bar inside.
        # Profile posts have no subreddit to block.
        self.configure(showBlockSubredditButton=True)
        found, posts = self.poll(lambda: self.js("""
            const posts = feedPosts().filter(visible).map((post) => {
              const bar = creditBar(post);
              const button = post.querySelector(".frontfilter-block-subreddit");
              return {
                id: post.id,
                subreddit: (post.getAttribute("subreddit-name") || "").toLowerCase(),
                bar: bar && outline(bar),
                button: button?.dataset.subreddit || null,
                visible: visible(button),
                inBar: !!bar && bar.contains(button),
                beforeJoin: button?.nextElementSibling?.localName === "shreddit-join-button",
              };
            }).filter(({subreddit}) => subreddit && !subreddit.startsWith("u_"));
            const wrong = posts.filter((post) =>
              !(post.button === post.subreddit && post.visible && post.inBar && post.beforeJoin));
            return {posts: posts.length, wrong: wrong.length, examples: wrong.slice(0, 3)};
        """), lambda buttons: buttons["posts"] >= 5 and buttons["wrong"] == 0)
        if not found:
            self.fail(f"posts without a Block button before Join: {posts}")

    def test_video_autoplay_turns_off(self):
        autoplaying = """
            return Array.from(document.querySelectorAll("shreddit-player")).filter((player) =>
              ["autoplay", "autoplay-pref", "muted-autoplay-fallback"].some((name) => player.hasAttribute(name))
              || player.shadowRoot?.querySelector("video")?.autoplay).length;
        """
        if not self.js(autoplaying):
            self.skipTest("no autoplaying videos on this page load")
        self.configure(disableAutoplay=True)
        self.expect(autoplaying, 0, "videos kept autoplaying")


class FeedLimitTests(RedditTestCase):
    path = "/r/popular/"

    @classmethod
    def page_ready(cls):
        # Only the feed's first page: the test needs the next one to be
        # loaded by the limiter, so the feed must not load it before.
        cls.load_feed(5)

    def test_button_mode_loads_more_posts_through_reddits_loader(self):
        # Reddit may refuse the limiter's request, as any other of the
        # page: the test then starts again, on a page loaded anew.
        for attempt in range(1, LOAD_ATTEMPTS + 1):
            refused = self.load_second_group()
            if not refused:
                return
            if attempt == LOAD_ATTEMPTS:
                self.fail(f"the second group did not load: {refused}")
            BROWSER.reloads.append(f"{self.path}: {refused}")
            time.sleep(RELOAD_PAUSE * attempt)
            self.reset_settings()
            self.open_page()
            self.wait_for_defaults()

    def load_second_group(self):
        """Shows two groups of 25 posts; returns what the limiter says if Reddit did not load the second."""
        shown = "return feedPosts().filter((post) => visible(post) && !post.hasAttribute('is-promoted')).length"
        status = "return document.querySelector('.frontfilter-feed-controls [role=status]')?.textContent ?? null"
        to_controls = "document.querySelector('.frontfilter-feed-controls')?.scrollIntoView({block: 'end'})"
        self.configure(limitInfiniteScroll=True, scrollLimit=25, scrollMode="button")
        self.expect(status, "25 posts shown", "the first group did not have 25 posts")
        self.assertEqual(self.js(shown), 25)
        # Firefox records a limited number of requests: start from none.
        self.js("performance.setResourceTimingBufferSize(1000); performance.clearResourceTimings()")
        self.js(to_controls)
        self.expect(
            "return !!document.querySelector('.frontfilter-feed-next:not([hidden]):not(:disabled)')",
            True, "no button for the next group",
        )
        self.js("document.querySelector('.frontfilter-feed-next').click()")

        # The second group needs posts that only Reddit's loader can fetch,
        # and the limiter fetches them as the reader nears the end.
        def second_group():
            self.js(to_controls)
            return self.js("""
                return {
                  status: document.querySelector(".frontfilter-feed-controls [role=status]")?.textContent ?? null,
                  failed: !!document.querySelector(".frontfilter-feed-retry:not([hidden])"),
                };
            """)
        found, group = self.poll(
            second_group, lambda group: group["failed"] or group["status"] == "50 posts shown", 30,
        )
        if not found:
            self.fail(f"the second group did not load: {group}")
        if group["failed"]:
            refused = self.refused_requests()
            return f"{group['status']}" + (f"; Reddit refused {', '.join(refused)}" if refused else "")
        requests = self.js(
            "return performance.getEntriesByType('resource')"
            ".filter((entry) => entry.name.includes('/svc/shreddit/feeds/')).length"
        )
        self.assertGreater(requests, 0, "no feed request went through Reddit's loader")
        # Reddit removes posts far above the viewport, so fewer may remain.
        self.assertLessEqual(self.js(shown), 50)
        return None


class SubredditTests(RedditTestCase):
    path = "/r/firefox/"

    @classmethod
    def page_ready(cls):
        cls.load_feed(8)

    def test_flair_rules_hide_posts_by_flair(self):
        # A flair as its filter can name it: a * in a filter is a wildcard,
        # and filters hold up to 100 characters.
        posts = self.read("""
            return feedPosts().filter(visible).map((post) => ({
              id: post.id,
              flair: post.querySelector("shreddit-post-flair")?.textContent.trim().replace(/\\s+/g, " ") || "",
            }));
        """, lambda posts: len(posts) >= 5, "the feed shows fewer than 5 posts")
        target = next(
            (post for post in posts if post["flair"] and "*" not in post["flair"] and len(post["flair"]) <= 100),
            None,
        )
        self.assertIsNotNone(
            target, f"no post flair found in {len(posts)} posts: shreddit-post-flair may have changed",
        )
        self.configure(blockedFlairs=[target["flair"]])
        self.expect("""
            return {target: visible(document.getElementById(arguments[0])), others: feedPosts().some(visible)};
        """, {"target": False, "others": True},
            f"the post with flair {target['flair']!r} stayed visible", target["id"])

    def test_header_block_button_sits_beside_create_post(self):
        self.configure(showBlockSubredditButton=True)
        self.expect("""
            const button = document.querySelector(".frontfilter-block-subreddit--header");
            return button && {
              subreddit: button.dataset.subreddit,
              visible: visible(button),
              next: button.nextElementSibling?.localName,
              afterCreatePost: !!button.previousElementSibling?.querySelector('[data-testid="create-post"]'),
            };
        """, {
            "subreddit": "firefox", "visible": True,
            "next": "shreddit-subreddit-header-buttons", "afterCreatePost": True,
        }, "the header Block button is missing or misplaced")

    def test_usernames_hide_from_posts(self):
        # The post's own author; crossposts also show the original author,
        # and post text can mention users. Subreddit feeds show the author's
        # avatar beside the name, which stays.
        authors = """
            const shows = (post, selector) => Array.from(
              post.querySelectorAll(`[slot="authorName"] ${selector}`)).some(visible);
            return feedPosts().filter(visible).map((post) => ({
              id: post.id, name: shows(post, '[data-testid="nameplate"]'), avatar: shows(post, "[avatar]"),
            }));
        """
        before = self.read(
            authors, lambda posts: any(post["name"] for post in posts) and any(post["avatar"] for post in posts),
            "no author names or avatars in posts",
        )
        with_avatar = {post["id"] for post in before if post["avatar"]}
        self.configure(hideUsernames=True)
        # Reddit may add posts meanwhile, or remove some: those still there
        # keep their avatars.
        self.read(
            authors,
            lambda posts: not any(post["name"] for post in posts)
            and all(post["avatar"] for post in posts if post["id"] in with_avatar),
            "author names stayed visible, or avatars hid with them",
        )


class SpoilerTests(RedditTestCase):
    # Large subreddits where spoilers are common, though not on every load:
    # the first that shows one is used.
    paths = ("/r/JuJutsuKaisen/", "/r/OnePiece/", "/r/Invincible/")
    path = paths[0]

    @classmethod
    def open_page(cls):
        for cls.path in cls.paths:
            cls.load_ready(cls.path, cls.page_ready)
            if cls.js("return feedPosts().some((post) => post.hasAttribute('spoiler'))"):
                break

    @classmethod
    def page_ready(cls):
        cls.load_feed(8)

    def spoilers(self):
        return self.js("""
            const posts = feedPosts();
            return {
              tagged: posts.filter((post) => post.hasAttribute("spoiler"))
                .map((post) => ({id: post.id, shownTag: hasSpoilerTag(post)})),
              untaggedWithTag: posts.filter((post) => !post.hasAttribute("spoiler") && hasSpoilerTag(post))
                .map((post) => post.id),
            };
        """)

    def test_spoiler_markup_the_extension_relies_on(self):
        # Posts take the spoiler tag and show it with the icon that, beside
        # a post, is all that names spoilers.
        observed = self.js("return customElements.get('shreddit-post')?.observedAttributes || []")
        self.assertIn("spoiler", observed, "posts no longer take the spoiler tag")
        if not self.spoilers()["tagged"]:
            self.skipTest(f"no spoilers on {', '.join(self.paths)}")
        found, posts = self.poll(
            self.spoilers,
            lambda posts: not posts["untaggedWithTag"] and all(post["shownTag"] for post in posts["tagged"]),
        )
        if not found:
            self.fail(f"spoilers show another icon, or posts that are no spoilers show theirs: {posts}")

    def test_spoilers_hide(self):
        if not self.spoilers()["tagged"]:
            self.skipTest(f"no spoilers on {', '.join(self.paths)}")
        self.configure(hideSpoilers=True)
        self.expect("""
            const shown = (post) => visible(post) || visible(post.closest("article"));
            const posts = feedPosts();
            return {
              tagged: posts.filter((post) => post.hasAttribute("spoiler")).some(shown),
              others: posts.filter((post) => !post.hasAttribute("spoiler")).some(shown),
            };
        """, {"tagged": False, "others": True}, "spoilers stayed visible, or other posts were hidden")


class SearchTests(RedditTestCase):
    # Most results for this query are spoilers.
    path = "/search/?q=spoiler"

    @classmethod
    def page_ready(cls):
        cls.wait_until(
            lambda: cls.js("return searchResults().length") >= 5, "fewer than 5 search results", FEED_TIMEOUT,
        )

    def results(self):
        return self.js("return searchResults()")

    def test_search_markup_the_extension_relies_on(self):
        # Each result names, in its tracking data, whether the post is NSFW
        # and whether it is a spoiler, and a divider follows it.
        found, results = self.poll(self.results, lambda results: len(results) >= 5 and all(
            isinstance(result["nsfw"], bool) and isinstance(result["spoiler"], bool) and result["divided"]
            for result in results
        ))
        if not found:
            self.fail(f"search results lack their tags or dividers: {results}")

    def test_spoilers_and_nsfw_posts_hide_from_search_results(self):
        # Each setting adds its tag to those that hide results, with their
        # dividers. Reddit shows no NSFW result to logged-out visitors: the
        # others must stay.
        if not any(result["spoiler"] for result in self.results()):
            self.skipTest("no spoilers among the results")
        tags = []
        for setting, tag in [("hideNsfw", "nsfw"), ("hideSpoilers", "spoiler")]:
            tags.append(tag)
            with self.subTest(setting=setting):
                self.configure(**{setting: True})
                found, results = self.poll(self.results, lambda results: results and all(
                    result["shown"] == result["dividerShown"] != any(result[name] for name in tags)
                    for result in results
                ))
                if not found:
                    self.fail(f"tagged results stayed visible, or others were hidden: {results}")


class CrosspostTests(RedditTestCase):
    # A large subreddit where crossposts are common, though not on every load.
    path = "/r/BeAmazed/"

    @classmethod
    def page_ready(cls):
        cls.load_feed(8)

    def crossposts(self):
        return self.js("""
            return feedPosts().filter((post) => post.matches('[is-crosspost], [post-type="crosspost" i]'))
              .map((post) => ({
                id: post.id,
                marked: post.hasAttribute("is-crosspost") && post.getAttribute("post-type") === "crosspost",
                nested: !!post.querySelector("shreddit-post"),
                source: post.getAttribute("content-href") || "",
                // The subreddit or profile the card names for the shared post.
                shown: post.querySelector(".crosspost-credit-bar a[href]")?.getAttribute("href") || "",
              }));
        """)

    @staticmethod
    def unexpected(post):
        """Whether a crosspost is not marked up as the extension reads it."""
        # The shared post's permalink: under the subreddit the card shows,
        # or under a user profile, which is no subreddit.
        source = re.fullmatch(r"/(r|user)/([^/]+)/comments/[a-z0-9]+/.*", post["source"], re.I)
        return not source or not post["marked"] or post["nested"] or (
            source[1] == "r" and post["shown"].lower().rstrip("/") != f"/r/{source[2]}".lower()
        )

    def test_crosspost_markup_the_extension_relies_on(self):
        if not self.crossposts():
            self.skipTest("no crossposts on this page load")
        found, posts = self.poll(self.crossposts, lambda posts: not any(map(self.unexpected, posts)))
        if not found:
            self.fail(f"crossposts are marked up otherwise: {list(filter(self.unexpected, posts))}")

    def test_all_mode_rule_hides_crossposts_of_a_subreddits_posts(self):
        page = self.path.split("/")[2].lower()
        sources = [
            (post["id"], source[1]) for post in self.crossposts()
            if (source := re.match(r"/r/([^/]+)/", post["source"])) and source[1].lower() != page
        ]
        if not sources:
            self.skipTest("no crossposts from other subreddits on this page load")
        target, subreddit = sources[0]
        self.configure(blockedSubreddits=[{"name": subreddit, "mode": "all"}])
        self.expect("""
            const shown = (post) => visible(post) || visible(post.closest("article"));
            return {target: shown(document.getElementById(arguments[0])), others: feedPosts().some(shown)};
        """, {"target": False, "others": True}, f"the crosspost of a post from r/{subreddit} stayed visible", target)


class CommentsTests(RedditTestCase):
    # The feed whose posts lead to the thread the tests share.
    path = "/r/popular/"

    @classmethod
    def open_page(cls):
        cls.load_ready(cls.path, FeedTests.page_ready)
        permalinks = cls.js("""
            return feedPosts().filter((post) => Number(post.getAttribute("comment-count")) >= 50)
              .map((post) => post.getAttribute("permalink")).filter(Boolean).slice(0, 5);
        """)
        if not permalinks:
            raise AssertionError("no post with 50 comments on r/popular")
        # Reddit serves some threads without their replies: try the next one.
        for permalink in permalinks:
            try:
                cls.load(permalink)
                cls.wait_until(lambda: cls.js("""
                    const comments = Array.from(document.querySelectorAll("shreddit-comment")).filter(visible);
                    return comments.length >= 5 && comments.some((comment) => comment.getAttribute("depth") !== "0");
                """), "no comments with visible replies")
                break
            except NotReady:
                pass
        else:
            raise AssertionError(f"no comments with visible replies in {len(permalinks)} threads from r/popular")

        # Reddit renders a comment's votes and actions once it scrolls into view.
        def rendered():
            cls.js("window.scrollBy(0, innerHeight / 2)")
            return cls.js("return document.querySelectorAll('shreddit-comment-action-row').length") >= 5
        cls.wait_until(rendered, "fewer than 5 comment action rows rendered", PAGE_TIMEOUT, 0.5)
        cls.js("window.scrollTo(0, 0)")

    def comment_bodies(self):
        return self.js("""
            return Array.from(document.querySelectorAll("shreddit-comment")).flatMap((comment) => {
              const body = comment.querySelector('[slot="comment"]');
              return body && body.closest("shreddit-comment") === comment && visible(body)
                ? [{id: comment.getAttribute("thingid"), depth: comment.getAttribute("depth"),
                    text: body.textContent.trim()}]
                : [];
            });
        """)

    def test_comment_markup_the_extension_relies_on(self):
        # Reddit renders a comment's actions after the comment: the page is
        # read until all it holds is as the extension reads it.
        self.read("""
            const comments = Array.from(document.querySelectorAll("shreddit-comment"));
            const replies = comments.filter((comment) => comment.getAttribute("depth") !== "0");
            const rows = Array.from(document.querySelectorAll("shreddit-comment-action-row"));
            return {
              comments: comments.length,
              withDepth: comments.filter((comment) => /^\\d+$/.test(comment.getAttribute("depth") || "")).length,
              replies: replies.length,
              nestedReplies: replies.filter((reply) => reply.parentElement.closest("shreddit-comment")).length,
              ownBodies: comments.filter((comment) => {
                const body = comment.querySelector('[slot="comment"]');
                return body && body.closest("shreddit-comment") === comment;
              }).length,
              actionRows: rows.length,
              actionRowVotes: rows.filter((row) => row.shadowRoot?.querySelector(".rpl-vote-button-group button[upvote]")).length,
            };
        """, lambda markup: (
            markup["withDepth"] == markup["comments"]
            and 0 < markup["replies"] == markup["nestedReplies"]
            # Deleted and removed comments have no body of their own.
            and markup["ownBodies"] >= markup["comments"] / 2
            and 0 < markup["actionRows"] == markup["actionRowVotes"]
        ), "comments are marked up otherwise")

    def test_comment_limit_shows_the_first_top_level_comments(self):
        # The limit counts the comments outside every other comment, and
        # hides the loader of more, outside every comment too.
        state = """
            const tree = document.querySelector("main shreddit-comment-tree");
            const outsideComments = (element) => !element.parentElement.closest("shreddit-comment");
            const comments = Array.from(tree?.querySelectorAll("shreddit-comment") || []).filter(outsideComments);
            const loaders = Array.from(tree?.querySelectorAll('faceplate-partial[src*="/more-comments/"]') || [])
              .filter(outsideComments);
            return {
              tree: !!tree,
              comments: comments.length,
              topLevel: comments.filter((comment) => comment.getAttribute("depth") === "0").length,
              shown: comments.filter(visible).length,
              loaders: loaders.length,
              loadersShown: loaders.filter(visible).length,
              controls: document.querySelector(".frontfilter-comment-controls")?.textContent || "",
            };
        """
        before = self.read(
            state, lambda before: before["tree"] and before["comments"] >= 5
            and before["topLevel"] == before["comments"],
            "the comment tree holds fewer than 5 comments, or some that are not top-level",
        )
        if before["loaders"] != 1:
            self.skipTest(f"no single loader of more top-level comments: {before}")
        self.configure(limitComments=True, commentLimit=3, commentLimitMode="fixed")
        # Reddit may have loaded comments meanwhile: only what the limit
        # shows is known.
        limited = self.read(
            state, lambda limited: (limited["shown"], limited["loadersShown"], limited["controls"])
            == (3, 0, "3 comments shown · Limit reached"),
            "the comment limit did not apply",
        )
        # Reddit loads no more comments while the limit is reached, however
        # far the reader scrolls.
        self.addCleanup(self.js, "window.scrollTo(0, 0)")
        for _ in range(3):
            self.js("window.scrollTo(0, document.documentElement.scrollHeight)")
            time.sleep(1)
        self.assertEqual(self.js(state), limited, "Reddit loaded comments past the limit")

    def test_all_comments_hide_with_the_posts_comment_button(self):
        state = """
            return {
              comments: countVisible("shreddit-comment") > 0,
              button: Array.from(document.querySelector("shreddit-post")?.shadowRoot
                ?.querySelectorAll('[data-action-bar-action="comments"]') || []).some(visible),
              post: visible(document.querySelector("shreddit-post")),
            };
        """
        self.expect(state, {"comments": True, "button": True, "post": True},
                    "the page lacks comments, the post or its comment button")
        # The settings page saves the replies switch with it, checked.
        self.configure(hideComments=True, hideCommentReplies=True)
        self.expect(state, {"comments": False, "button": False, "post": True}, "comments stayed visible")

    def test_replies_hide_and_top_level_comments_stay(self):
        levels = """
            const comments = Array.from(document.querySelectorAll("shreddit-comment")).filter(visible);
            return {
              topLevel: comments.filter((comment) => comment.getAttribute("depth") === "0").length,
              replies: comments.filter((comment) => comment.getAttribute("depth") !== "0").length,
            };
        """
        before = self.read(
            levels, lambda before: before["topLevel"] > 0 and before["replies"] > 0,
            "the page lacks top-level comments or replies",
        )
        self.configure(hideCommentReplies=True)
        # Reddit may load more top-level comments meanwhile, never fewer.
        self.read(
            levels, lambda after: after["replies"] == 0 and after["topLevel"] >= before["topLevel"],
            f"replies stayed visible, or top-level comments hid: before {before}, after",
        )

    def test_keywords_hide_matching_comments(self):
        def distinctive():
            bodies = self.comment_bodies()
            return next(
                ((body, word) for body in bodies if body["depth"] == "0"
                 if (word := choose_word(body["text"], [other["text"] for other in bodies if other is not body]))),
                None,
            )
        found, choice = self.poll(distinctive, bool)
        self.assertTrue(found, "no top-level comment with a distinctive word")
        target, word = choice
        self.configure(blockedTitleKeywords=[word])
        self.expect("""
            const comment = document.querySelector(`shreddit-comment[thingid="${arguments[0]}"]`);
            return {target: visible(comment), others: countVisible('shreddit-comment[depth="0"]') > 0};
        """, {"target": False, "others": True}, f"the comment containing {word!r} stayed visible", target["id"])

    def test_blocked_users_comments_hide(self):
        authors = self.read("""
            return Array.from(document.querySelectorAll('shreddit-comment[depth="0"]'))
              .filter(visible).map((comment) => comment.getAttribute("author") || "");
        """, lambda authors: any(USER.fullmatch(name) for name in authors),
            "no top-level comment names its author")
        author = next(name for name in authors if USER.fullmatch(name))
        self.configure(blockedUsers=[author])
        self.expect("""
            const comments = Array.from(document.querySelectorAll('shreddit-comment[depth="0"]'));
            const isTarget = (comment) => comment.getAttribute("author")?.toLowerCase() === arguments[0].toLowerCase();
            return {target: comments.filter(isTarget).some(visible), others: comments.some((comment) => !isTarget(comment) && visible(comment))};
        """, {"target": False, "others": True}, f"comments by u/{author} stayed visible", author)

    def test_votes_awards_avatars_and_usernames_hide(self):
        # Vote buttons live in shadow roots, which countVisible also searches.
        # A comment's author links to their profile twice: from the avatar,
        # beside the comment or in its metadata, as Reddit lays it out for
        # each visitor, and from the name, in its metadata.
        signals = {
            "votes": "button[upvote], button[downvote]",
            "awards": "award-button",
            "avatars": 'shreddit-comment :is([slot="commentAvatar"], [slot="commentMeta"])'
                       ' a[href*="/user/"]:has([avatar])',
            "usernames": 'shreddit-comment [slot="commentMeta"] a[href*="/user/"]:not(:has([avatar]))',
        }
        # Comment text and times are not social signals and stay visible.
        kept = {
            "bodies": 'shreddit-comment [slot="comment"]',
            "times": 'shreddit-comment [slot="commentMeta"] faceplate-timeago',
        }
        state = (
            "const [signals, kept] = arguments;"
            " const any = (selectors) => Object.fromEntries(Object.entries(selectors)"
            ".map(([name, selector]) => [name, countVisible(selector) > 0]));"
            " return {...any(signals), ...any(kept)};"
        )
        self.expect(state, dict.fromkeys([*signals, *kept], True), "the page lacks a social signal", signals, kept)
        self.configure(hideVotes=True, hideAwards=True, hideAvatars=True, hideUsernames=True)
        self.expect(
            state, {**dict.fromkeys(signals, False), **dict.fromkeys(kept, True)},
            "social signals did not hide as expected", signals, kept,
        )

    def test_nsfw_tags_on_post_pages(self):
        # The post sits in main, before its comments, and the right rail's
        # posts, which Reddit loads after the page, name in their tracking
        # data whether they are NSFW.
        markup = """
            const rail = Array.from(document.querySelectorAll("li > reddit-pdp-right-rail-post"));
            return {
              postInMain: !!document.querySelector("main > shreddit-post"),
              commentsInMain: !!document.querySelector("main shreddit-comment-tree"),
              railPosts: rail.length > 0,
              railTagged: rail.every((post) => /"nsfw":(true|false)/.test(post.getAttribute("data-faceplate-tracking-context") || "")),
            };
        """
        self.expect(markup, dict.fromkeys(["postInMain", "commentsInMain", "railPosts", "railTagged"], True),
                    "post pages are marked up otherwise")
        self.configure(hideNsfw=True)
        self.expect(
            "return [countVisible('main > shreddit-post'), countVisible('shreddit-comment') > 0]",
            [1, True], "an untagged post or its comments were hidden",
        )

    def test_spoilers_hide_from_post_pages(self):
        # The post and its comments stay unless it is a spoiler, and posts
        # suggested beside it hide if they show the spoiler tag.
        state = """
            const rail = Array.from(document.querySelectorAll("li > reddit-pdp-right-rail-post")).filter(visible);
            return {
              post: countVisible("main > shreddit-post"),
              comments: countVisible("shreddit-comment") > 0,
              railSpoilers: rail.filter(hasSpoilerTag).length,
              railOthers: rail.filter((post) => !hasSpoilerTag(post)).map((post) => post.getAttribute("right-rail-post-id")),
            };
        """
        before = self.read(state, lambda before: before["post"] == 1 and before["comments"],
                           "the page lacks its post or its comments")
        spoiler = self.js("return !!document.querySelector('main > shreddit-post[spoiler]')")
        self.configure(hideSpoilers=True)
        expected = {"post": 0 if spoiler else 1, "comments": not spoiler, "railSpoilers": 0}
        self.read(
            state,
            lambda now: {key: now[key] for key in expected} == expected
            and set(before["railOthers"]) <= set(now["railOthers"]),
            f"spoilers stayed visible, or other posts were hidden: before {before}, after",
        )

    def test_comment_page_ads_hide(self):
        ads = "shreddit-comments-page-ad, shreddit-comment-tree-ad, shreddit-sidebar-ad"
        if not self.js("return countVisible(arguments[0])", ads):
            self.skipTest("no ads on this page load")
        self.configure(hideAds=True)
        self.expect("return countVisible(arguments[0])", 0, "ads stayed visible", ads)

    def test_right_rail_hides(self):
        rail = "return [countVisible('pdp-right-rail'), countVisible('shreddit-comment') > 0]"
        self.expect(rail, [1, True], "the page lacks its right rail or its comments")
        self.configure(hideRelatedPosts=True)
        self.expect(rail, [0, True], "the right rail stayed visible, or comments were hidden")


class RedirectTests(RedditTestCase):
    """Blocked pages redirect before the request, so Reddit never sees them."""

    def setUp(self):
        # An open Reddit page would redirect itself as soon as a rule changes.
        self.driver.get("about:blank")
        super().setUp()

    def assert_redirected(self, path, query):
        url = REDDIT + path
        self.driver.get(url)
        block_page = f"moz-extension://{harness.FIREFOX_UUID}/blocked/index.html"
        redirected, current = self.poll(lambda: self.driver.current_url, lambda current: current.startswith(block_page))
        if not redirected:
            self.fail(f"{url} was not redirected: {current}")
        self.assertIn(query, current)
        self.assertEqual(current.split("#", 1)[1], url)

    def test_blocked_main_pages_redirect(self):
        self.configure(blockPopular=True, blockExplore=True)
        self.assert_redirected("/r/popular/", "page=popular")
        self.assert_redirected("/explore/", "page=explore")

    def test_home_mode_rules_redirect_a_subreddits_front_page(self):
        self.configure(blockedSubreddits=[{"name": "firefox", "mode": "home"}])
        self.assert_redirected("/r/firefox/top/", "target=subreddit")

    def test_blocked_users_profiles_redirect(self):
        self.configure(blockedUsers=["spez"])
        self.assert_redirected("/user/spez/", "target=user&user=spez")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--firefox", help="Path to the Firefox binary")
    parser.add_argument("--snapshots", help="Folder for redacted snapshots of the pages visited")
    parser.add_argument("--visitor", help="Run as the visitor a failing run named, to meet the same markup")
    _, unittest_args = parser.parse_known_args(namespace=OPTIONS)
    program = unittest.main(argv=[sys.argv[0], *unittest_args], exit=False)
    # After the tests' own report, where it is read.
    report = BROWSER.report() if BROWSER else ""
    if report:
        print(f"\n{report}", file=sys.stderr)
    sys.exit(not program.result.wasSuccessful())


if __name__ == "__main__":
    main()
