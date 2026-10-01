"""Canary tests: the published extension on the real reddit.com.

Run: python3 tests/reddit/canary.py [--firefox PATH] [--snapshots DIR] [unittest options]

The fixture tests show that the extension works on the markup the fixtures
describe. These tests show that reddit.com still uses that markup. In
Firefox, with an unmodified build, they load a few public pages logged out
and in English, change settings from the extension's own settings page and
check what the reader would see. CI does not run them on every push: a
scheduled workflow runs them once a week.

Features that only exist for signed-in users (the left navigation sections,
chat, notifications, karma, suggested Home posts) and Old Reddit, which now
requires an account, cannot be checked here: test them by hand.

With --snapshots, each page visited is saved to that folder, redacted, with
an inventory of its component names, slots and test IDs; a failing test also
saves the page as it was then. CONTRIBUTING.md explains how to use them to
update the fixtures.
"""
import argparse
import json
from pathlib import Path
import re
import sys
import tempfile
import unittest

from selenium.webdriver.support.ui import WebDriverWait

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "browser"))
import harness  # noqa: E402

REDDIT = "https://www.reddit.com"
WINDOW_SIZE = (1440, 1000)
PAGE_TIMEOUT = 45
EFFECT_TIMEOUT = 15
SNAPSHOT_SCRIPT = Path(__file__).with_name("snapshot.js").read_text() + "\nreturn snapshotPage();"
OPTIONS = argparse.Namespace(firefox=None, snapshots=None)

# Defines deep(selector) to search open shadow roots too, visible(element)
# and countVisible(selector). Prepended to page scripts.
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
"""
WORD = re.compile(r"[^\W\d_]{5,}")


class Browser:
    """Firefox with the published extension: one window for Reddit, one for settings."""

    def __init__(self):
        self.temp = tempfile.TemporaryDirectory(prefix="frontfilter-canary-")
        self.driver = harness.start_firefox(OPTIONS.firefox)
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
        except Exception:
            self.quit()
            raise

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
    """Loads one Reddit page per class; each test starts from default settings."""

    path = None

    @classmethod
    def setUpClass(cls):
        cls.reset_settings()
        if cls.path:
            cls.load(cls.path)
            cls.page_ready()
            cls.save_snapshot(cls.__name__)

    @classmethod
    def page_ready(cls):
        """Waits for the parts of the page the tests use."""

    def setUp(self):
        self.reset_settings()

    @property
    def driver(self):
        return BROWSER.driver

    @classmethod
    def js(cls, script, *values):
        return BROWSER.driver.execute_script(PAGE_HELPERS + script, *values)

    @classmethod
    def wait_until(cls, condition, message, timeout=EFFECT_TIMEOUT):
        return WebDriverWait(BROWSER.driver, timeout).until(lambda _: condition(), message)

    @classmethod
    def load(cls, path):
        driver = BROWSER.driver
        url = path if path.startswith("http") else REDDIT + path
        driver.get(url)
        try:
            # Reddit may first serve a JavaScript check that reloads the page.
            cls.wait_until(lambda: driver.execute_script(
                "return document.readyState === 'complete' && !!document.querySelector('shreddit-app')"
            ), "no Reddit app", PAGE_TIMEOUT)
        except Exception:
            text = driver.execute_script("return document.body?.innerText.slice(0, 300) || ''")
            raise AssertionError(
                f"Reddit did not serve {url}: it may be blocking automated browsers from this"
                f" network. Title {driver.title!r}, URL {driver.current_url}, text {text!r}"
            ) from None

    @classmethod
    def reset_settings(cls):
        result = BROWSER.run_in_settings(harness.RESET_SCRIPT)
        assert result == {"success": True}, result

    def configure(self, **settings):
        result = BROWSER.run_in_settings(harness.STORE_SCRIPT, settings)
        self.assertEqual(result, {"success": True})

    @classmethod
    def save_snapshot(cls, name):
        if not OPTIONS.snapshots:
            return
        folder = Path(OPTIONS.snapshots)
        folder.mkdir(parents=True, exist_ok=True)
        snapshot = BROWSER.driver.execute_script(SNAPSHOT_SCRIPT)
        (folder / f"{name}.html").write_text(snapshot["html"])
        (folder / f"{name}.json").write_text(json.dumps(snapshot["inventory"], indent=2, sort_keys=True) + "\n")

    def run(self, result=None):
        problems = lambda: len(result.failures) + len(result.errors)
        before = problems() if result else 0
        outcome = super().run(result)
        if result and problems() > before and BROWSER:
            try:
                self.save_snapshot(f"{type(self).__name__}.{self._testMethodName}.failure")
            except Exception as error:
                print(f"Could not save a snapshot: {error}", file=sys.stderr)
        return outcome

    def expect(self, script, expected, message, *values):
        """Waits until a page script returns the expected value."""
        try:
            self.wait_until(lambda: self.js(script, *values) == expected, message)
        except Exception:
            self.fail(f"{message}: expected {expected!r}, got {self.js(script, *values)!r}")

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
        cls.wait_until(lambda: cls.js("return feedPosts().filter(visible).length") >= 5, "no feed posts")

    def visible_posts(self):
        return self.js("""
            return feedPosts().filter(visible).map((post) => ({
              id: post.id,
              subreddit: post.getAttribute("subreddit-name"),
              title: post.getAttribute("post-title") || "",
            }));
        """)

    def test_feed_markup_the_extension_relies_on(self):
        markup = self.js("""
            const posts = feedPosts();
            const count = (test) => posts.filter(test).length;
            return {
              posts: posts.length,
              described: count((post) => ["subreddit-name", "permalink", "post-title"]
                .every((name) => post.getAttribute(name))),
              wrappedWithDivider: count((post) => post.parentElement.localName === "article"
                && post.parentElement.nextElementSibling?.localName === "hr"),
              titled: count((post) => post.querySelector('[slot="title"]')),
              voteGroups: count((post) => post.shadowRoot?.querySelector(".rpl-vote-button-group button[upvote]")),
              commentButtons: count((post) => post.shadowRoot?.querySelector('[data-action-bar-action="comments"]')),
              loader: !!document.querySelector('main shreddit-feed faceplate-partial[slot="load-after"]'),
              loadContent: typeof customElements.get("faceplate-partial")?.prototype.loadContent,
              bridge: document.documentElement.hasAttribute("data-frontfilter-feed-bridge"),
            };
        """)
        self.assertGreaterEqual(markup["posts"], 5, markup)
        every_post = ["described", "wrappedWithDivider", "titled", "voteGroups", "commentButtons"]
        self.assertEqual(
            {key: markup[key] for key in every_post}, dict.fromkeys(every_post, markup["posts"]), markup,
        )
        self.assertEqual(
            {key: markup[key] for key in ["loader", "loadContent", "bridge"]},
            {"loader": True, "loadContent": "function", "bridge": True},
            "the scroll limit cannot drive Reddit's feed loader",
        )

    def test_all_mode_rule_hides_a_subreddits_posts(self):
        posts = self.visible_posts()
        subreddit = posts[0]["subreddit"]
        self.configure(blockedSubreddits=[{"name": subreddit, "mode": "all"}])
        self.expect("""
            const posts = feedPosts();
            const shown = (post) => visible(post) || visible(post.closest("article"));
            const isTarget = (post) => post.getAttribute("subreddit-name").toLowerCase() === arguments[0].toLowerCase();
            return {target: posts.filter(isTarget).some(shown), others: posts.some((post) => !isTarget(post) && shown(post))};
        """, {"target": False, "others": True}, f"posts from r/{subreddit} stayed visible", subreddit)

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
        self.assertEqual(self.js(controls), {"votes": True, "comments": True, "share": True})
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
        before = self.visible_counts(sections)
        self.assertTrue(all(before.values()), f"navbar parts missing: {before}")
        self.configure(hideNavbarSearch=True, hideNavbarProfile=True, hideNavbarOthers=True)
        self.expect(
            "return Object.fromEntries(Object.entries(arguments[0])"
            ".map(([name, selector]) => [name, countVisible(selector) > 0]))",
            {"search": False, "profile": False, "login": False, "signup": False, "logo": True},
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
        before = self.js(navbar)
        self.assertRegex(before["height"], r"^[1-9]\d*px$", f"Reddit no longer sizes its navbar this way: {before}")
        self.assertEqual(before["space"], before["height"], "Reddit reserves the navbar's space differently")
        self.configure(hideNavbar=True)
        self.expect(navbar, {"navbar": False, "height": "0px", "space": "0px"}, "the navbar or its space stayed")

    def test_left_and_right_sidebars_hide(self):
        sidebars = {"left": "#left-sidebar-container", "right": "#right-sidebar-container"}
        self.assertEqual(self.visible_counts(sidebars), {"left": 1, "right": 1})
        self.configure(hideLeftSidebar=True, hideRelatedPosts=True)
        self.expect(
            "return [countVisible('#left-sidebar-container'), countVisible('#right-sidebar-container'),"
            " feedPosts().filter(visible).length > 0]",
            [0, 0, True], "a sidebar stayed visible, or the feed was hidden",
        )

    def test_block_buttons_join_each_posts_credit_bar(self):
        self.configure(showBlockSubredditButton=True)
        buttons = """
            return feedPosts().filter(visible).flatMap((post) => {
              const bar = post.querySelector(':scope > [slot="credit-bar"]');
              if (!bar) return [];
              const button = bar.querySelector(".frontfilter-block-subreddit");
              return [{
                subreddit: post.getAttribute("subreddit-name").toLowerCase(),
                button: button?.dataset.subreddit || null,
                visible: visible(button),
                beforeJoin: button?.nextElementSibling?.localName === "shreddit-join-button",
              }];
            });
        """
        self.wait_until(lambda: any(post["button"] for post in self.js(buttons)), "no Block buttons appeared")
        posts = [post for post in self.js(buttons) if not post["subreddit"].startswith("u_")]
        self.assertTrue(posts)
        for post in posts:
            self.assertEqual(
                post, {**post, "button": post["subreddit"], "visible": True, "beforeJoin": True},
            )

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
        FeedTests.page_ready()

    def test_button_mode_loads_more_posts_through_reddits_loader(self):
        shown = "return feedPosts().filter((post) => visible(post) && !post.hasAttribute('is-promoted')).length"
        status = "return document.querySelector('.frontfilter-feed-controls [role=status]')?.textContent"
        requests = "return performance.getEntriesByType('resource').filter((entry) => entry.name.includes('/svc/shreddit/feeds/')).length"
        self.configure(limitInfiniteScroll=True, scrollLimit=25, scrollMode="button")
        self.expect(status, "25 posts shown", "the first group did not have 25 posts")
        self.assertEqual(self.js(shown), 25)
        # Firefox records a limited number of requests: start from none.
        self.js("performance.clearResourceTimings()")
        self.js("document.querySelector('.frontfilter-feed-controls').scrollIntoView({block: 'end'})")
        self.wait_until(lambda: self.js(
            "return !!document.querySelector('.frontfilter-feed-next:not([hidden]):not(:disabled)')"
        ), "no button for the next group")
        self.js("document.querySelector('.frontfilter-feed-next').click()")

        # The second group needs posts that only Reddit's loader can fetch,
        # and the limiter fetches them as the reader nears the end.
        def second_group_shown():
            self.js("document.querySelector('.frontfilter-feed-controls').scrollIntoView({block: 'end'})")
            return self.js(status) == "50 posts shown"

        try:
            self.wait_until(second_group_shown, "", 30)
        except Exception:
            self.fail(f"the second group did not load: status {self.js(status)!r}")
        self.assertGreater(self.js(requests), 0, "no feed request went through Reddit's loader")
        # Reddit removes posts far above the viewport, so fewer may remain.
        self.assertLessEqual(self.js(shown), 50)


class SubredditTests(RedditTestCase):
    path = "/r/firefox/"

    @classmethod
    def page_ready(cls):
        # Subreddit pages render a few posts and load the rest on scroll.
        def loaded():
            cls.js("window.scrollBy(0, innerHeight)")
            return cls.js("return feedPosts().length") >= 8
        cls.wait_until(loaded, "fewer than 8 posts loaded", PAGE_TIMEOUT)
        cls.js("window.scrollTo(0, 0)")

    def test_flair_rules_hide_posts_by_flair(self):
        posts = self.js("""
            return feedPosts().filter(visible).map((post) => ({
              id: post.id,
              flair: post.querySelector("shreddit-post-flair")?.textContent.trim().replace(/\\s+/g, " ") || "",
            }));
        """)
        target = next((post for post in posts if post["flair"]), None)
        self.assertIsNotNone(target, f"no post flair found in {len(posts)} posts: shreddit-post-flair may have changed")
        self.configure(blockedFlairs=[target["flair"].replace("*", "")])
        self.expect(
            "return visible(document.getElementById(arguments[0]))", False,
            f"the post with flair {target['flair']!r} stayed visible", target["id"],
        )

    def test_header_block_button_sits_beside_create_post(self):
        self.configure(showBlockSubredditButton=True)
        self.expect("""
            const button = document.querySelector(".frontfilter-block-subreddit--header");
            return button && {
              subreddit: button.dataset.subreddit,
              visible: visible(button),
              next: button.nextElementSibling?.localName,
              afterCreatePost: !!button.previousElementSibling?.querySelector("create-post-entry-point-wrapper"),
            };
        """, {
            "subreddit": "firefox", "visible": True,
            "next": "shreddit-subreddit-header-buttons", "afterCreatePost": True,
        }, "the header Block button is missing or misplaced")

    def test_usernames_hide_from_posts(self):
        # The post's own author; crossposts also show the original author,
        # and post text can mention users. Subreddit feeds show the author's
        # avatar beside the name, which stays.
        in_author_slots = """
            return feedPosts().flatMap((post) => Array.from(post.querySelectorAll(
              `[slot="authorName"] ${arguments[0]}`))).filter(visible).length;
        """
        self.assertGreater(self.js(in_author_slots, '[data-testid="nameplate"]'), 0, "no author names in posts")
        avatars = self.js(in_author_slots, "[avatar]")
        self.configure(hideUsernames=True)
        self.expect(in_author_slots, 0, "author names stayed visible", '[data-testid="nameplate"]')
        # The feed may grow meanwhile, never lose avatars.
        self.assertGreaterEqual(self.js(in_author_slots, "[avatar]"), avatars, "author avatars hid with the names")


class CommentsTests(RedditTestCase):
    @classmethod
    def setUpClass(cls):
        cls.reset_settings()
        cls.load("/r/popular/")
        FeedTests.page_ready()
        permalink = cls.js("""
            const posts = feedPosts().filter((post) => Number(post.getAttribute("comment-count")) >= 50);
            return posts[0]?.getAttribute("permalink");
        """)
        assert permalink, "no post with 50 comments on r/popular"
        cls.load(permalink)
        cls.wait_until(lambda: cls.js("""
            const comments = Array.from(document.querySelectorAll("shreddit-comment")).filter(visible);
            return comments.length >= 5 && comments.some((comment) => comment.getAttribute("depth") !== "0");
        """), "no comments with visible replies", PAGE_TIMEOUT)
        cls.save_snapshot(cls.__name__)

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
        markup = self.js("""
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
        """)
        self.assertEqual(markup["withDepth"], markup["comments"], markup)
        self.assertGreater(markup["replies"], 0, markup)
        self.assertEqual(markup["nestedReplies"], markup["replies"], markup)
        # Deleted and removed comments have no body of their own.
        self.assertGreaterEqual(markup["ownBodies"], markup["comments"] / 2, markup)
        self.assertGreater(markup["actionRows"], 0, markup)
        self.assertEqual(markup["actionRowVotes"], markup["actionRows"], markup)

    def test_all_comments_hide_with_the_posts_comment_button(self):
        state = """
            return {
              comments: countVisible("shreddit-comment") > 0,
              button: Array.from(document.querySelector("shreddit-post")?.shadowRoot
                ?.querySelectorAll('[data-action-bar-action="comments"]') || []).some(visible),
              post: visible(document.querySelector("shreddit-post")),
            };
        """
        self.assertEqual(self.js(state), {"comments": True, "button": True, "post": True})
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
        before = self.js(levels)
        self.assertTrue(before["topLevel"] and before["replies"], before)
        self.configure(hideCommentReplies=True)
        self.expect(levels, {"topLevel": before["topLevel"], "replies": 0}, "replies stayed visible")

    def test_keywords_hide_matching_comments(self):
        bodies = self.comment_bodies()
        target, word = next(
            ((body, word) for body in bodies if body["depth"] == "0"
             if (word := choose_word(body["text"], [other["text"] for other in bodies if other is not body]))),
            (None, None),
        )
        self.assertIsNotNone(word, "no top-level comment with a distinctive word")
        self.configure(blockedTitleKeywords=[word])
        self.expect("""
            const comment = document.querySelector(`shreddit-comment[thingid="${arguments[0]}"]`);
            return {target: visible(comment), others: countVisible('shreddit-comment[depth="0"]') > 0};
        """, {"target": False, "others": True}, f"the comment containing {word!r} stayed visible", target["id"])

    def test_votes_awards_avatars_and_usernames_hide(self):
        # Vote buttons live in shadow roots, which countVisible also searches.
        signals = {
            "votes": "button[upvote], button[downvote]",
            "awards": "award-button",
            "avatars": 'shreddit-comment [slot="commentAvatar"] a[href*="/user/"]',
            "usernames": 'shreddit-comment [slot="commentMeta"] a[href*="/user/"]',
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
        before = self.js(state, signals, kept)
        self.assertTrue(all(before.values()), before)
        self.configure(hideVotes=True, hideAwards=True, hideAvatars=True, hideUsernames=True)
        expected = {**dict.fromkeys(signals, False), **dict.fromkeys(kept, True)}
        try:
            self.wait_until(lambda: self.js(state, signals, kept) == expected, "")
        except Exception:
            self.fail(f"social signals did not hide as expected: {self.js(state, signals, kept)}")

    def test_comment_page_ads_hide(self):
        ads = "shreddit-comments-page-ad, shreddit-comment-tree-ad, shreddit-sidebar-ad"
        if not self.js("return countVisible(arguments[0])", ads):
            self.skipTest("no ads on this page load")
        self.configure(hideAds=True)
        self.expect("return countVisible(arguments[0])", 0, "ads stayed visible", ads)

    def test_right_rail_hides(self):
        self.assertEqual(self.js("return countVisible('pdp-right-rail')"), 1)
        self.configure(hideRelatedPosts=True)
        self.expect("return [countVisible('pdp-right-rail'), countVisible('shreddit-comment') > 0]",
                    [0, True], "the right rail stayed visible, or comments were hidden")


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
        try:
            self.wait_until(lambda: self.driver.current_url.startswith(block_page), "")
        except Exception:
            self.fail(f"{url} was not redirected: {self.driver.current_url}")
        self.assertIn(query, self.driver.current_url)
        self.assertEqual(self.driver.current_url.split("#", 1)[1], url)

    def test_blocked_main_pages_redirect(self):
        self.configure(blockPopular=True, blockExplore=True)
        self.assert_redirected("/r/popular/", "page=popular")
        self.assert_redirected("/explore/", "page=explore")

    def test_home_mode_rules_redirect_a_subreddits_front_page(self):
        self.configure(blockedSubreddits=[{"name": "firefox", "mode": "home"}])
        self.assert_redirected("/r/firefox/top/", "target=subreddit")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--firefox", help="Path to the Firefox binary")
    parser.add_argument("--snapshots", help="Folder for redacted snapshots of the pages visited")
    _, unittest_args = parser.parse_known_args(namespace=OPTIONS)
    unittest.main(argv=[sys.argv[0], *unittest_args])


if __name__ == "__main__":
    main()
