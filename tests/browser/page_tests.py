"""Extension behavior on the fixture pages, shared by the Firefox and Chrome runs.

Each test starts from default settings on a freshly loaded fixture page, so
tests can run alone and in any order.
"""


def visible_navbar(**hidden):
    sections = [
        "navbar", "menu", "logo", "search", "chat", "notifications", "profile",
        "campaign", "translate", "advertise", "create", "signup", "login",
    ]
    return {name: not hidden.get(name, False) for name in sections}


ALL_NAVBAR_SECTIONS = {
    "hideNavbarMenu": True,
    "hideNavbarSearch": True,
    "hideNavbarChat": True,
    "hideNavbarNotifications": True,
    "hideNavbarProfile": True,
    "hideNavbarOthers": True,
}
# Logged-in and logged-out leftovers that "Others" hides.
OTHER_NAVBAR_ITEMS = dict.fromkeys(
    ["campaign", "translate", "advertise", "create", "signup", "login"], True,
)
ALL_SIDEBAR_SECTIONS = {
    "hideLeftSidebarGames": True,
    "hideLeftSidebarCustomFeeds": True,
    "hideLeftSidebarRecent": True,
    "hideLeftSidebarCommunities": True,
    "hideLeftSidebarResources": True,
}
VISIBLE_SIDEBAR = {
    "sidebar": True, "top": True, "games": True,
    "customFeeds": True, "recent": True,
    "communities": True, "resources": True,
}
SIGNAL_KEYS = ["hideVotes", "hideKarma", "hideAwards", "hideAvatars", "hideUsernames"]
SIGNALS_SHOWN = {
    "post-author": True, "post-author-avatar": True, "community-icon": True,
    "comment-avatar": True, "comment-author": True, "comment-time": True,
    "comment-award": True, "card-avatar": True, "card-karma": True,
    "karma-help": True, "card-follow": True, "profile-karma": True,
    "post-score": True, "post-award": True, "post-upvote": True, "post-downvote": True,
    "comment-score": True, "comment-upvote": True, "post-comments": True,
}
# Settings that only add CSS rules to the page and to shadow roots.
PAGE_RULE_SETTINGS = [
    "hideNavbar", "hideNavbarMenu", "hideNavbarSearch", "hideNavbarChat",
    "hideNavbarNotifications", "hideNavbarProfile", "hideNavbarOthers",
    "hideLeftSidebar", "hideLeftSidebarGames", "hideLeftSidebarCustomFeeds",
    "hideLeftSidebarRecent", "hideLeftSidebarCommunities", "hideLeftSidebarResources",
    "hideRelatedPosts", "hideSuggestedCommunities", "hideSuggestedPosts", "hideAds",
    "hideComments", "hideCommentReplies", "hideSocialSignals", *SIGNAL_KEYS,
    "blockHomepage", "blockPopular", "blockExplore", "blockNews",
]
AD_PLACEMENTS = [
    "comments-page-ad", "comment-tree-ad", "sidebar-ad", "tracked-promoted",
    "tracked-organic", "legacy-ad", "old-promoted", "old-placeholder",
]
COMMENT_ACTION_DISPLAY = """
  return getComputedStyle(document.querySelector('main shreddit-post')
    .shadowRoot.querySelector('[data-action-bar-action="comments"]')).display
"""


class PageTests:
    """Mixed into a browser's ExtensionTestCase."""

    # Visibility of page elements

    def test_feed_comment_actions_hide_inside_post_shadow_roots(self):
        self.configure(hideComments=True)
        self.js("resetFeed([post('comments')])")
        self.wait_until(lambda: self.js(COMMENT_ACTION_DISPLAY) == "none")
        self.configure(hideComments=False)
        self.wait_until(lambda: self.js(COMMENT_ACTION_DISPLAY) != "none")

    def test_comment_replies_and_all_comments_hide_independently(self):
        self.js("resetFeed([post('comments')]); resetComments()")
        self.configure(hideCommentReplies=True)
        self.wait_until(lambda: self.js("return visibleComments()") == [
            "comment-top-a", "comment-top-b",
        ])
        self.assertNotEqual(self.js(COMMENT_ACTION_DISPLAY), "none")
        # "All comments" implies replies and also hides the feed's comment buttons.
        self.configure(hideComments=True)
        self.wait_until(lambda: self.js("return visibleComments()") == [])
        self.wait_until(lambda: self.js(COMMENT_ACTION_DISPLAY) == "none")
        self.configure(hideComments=False, hideCommentReplies=False)
        self.wait_until(lambda: self.js("return visibleComments()") == [
            "comment-top-a", "comment-reply", "comment-deep-reply", "comment-top-b",
        ])

    def test_suggested_communities(self):
        self.wait_until(lambda: self.js("return suggestedCommunitiesVisible()"))
        self.configure(hideSuggestedCommunities=True)
        self.wait_until(lambda: not self.js("return suggestedCommunitiesVisible()"))
        self.configure(hideSuggestedCommunities=False)
        self.wait_until(lambda: self.js("return suggestedCommunitiesVisible()"))

    def test_ads_and_promoted_posts(self):
        self.js(
            "resetFeed([post('a'), post('b', 'safe', {ad: true}), post('c', 'safe', {adPost: true}),"
            " post('d', 'safe', {adPost: true, unwrapped: true}), post('e')])"
        )
        ads_shown = {
            "feed": {f"t3_{post_id}": [True, True] for post_id in "abcde"},
            "placements": dict.fromkeys(AD_PLACEMENTS, True),
        }
        # Organic posts, their dividers, non-promoted trackers and Old Reddit's
        # 1px placeholders stay visible.
        ads_hidden = {
            "feed": {f"t3_{post_id}": [post_id in "ae"] * 2 for post_id in "abcde"},
            "placements": {
                placement: placement in ("tracked-organic", "old-placeholder")
                for placement in AD_PLACEMENTS
            },
        }
        self.wait_until(lambda: self.js("return adVisibility()") == ads_shown)
        self.configure(hideAds=True)
        self.wait_until(lambda: self.js("return adVisibility()") == ads_hidden)
        self.configure(hideAds=False)
        self.wait_until(lambda: self.js("return adVisibility()") == ads_shown)

    def test_votes_karma_awards_avatars_and_usernames(self):
        # Avatars hide on their own: names and subreddit icons stay visible.
        avatars_hidden = {
            **SIGNALS_SHOWN,
            "post-author-avatar": False, "comment-avatar": False, "card-avatar": False,
        }
        # Timestamps, subreddit icons, other post actions and hover-card actions stay.
        signals_hidden = {
            **dict.fromkeys(SIGNALS_SHOWN, False),
            "community-icon": True, "comment-time": True, "card-follow": True,
            "post-comments": True,
        }
        self.wait_until(lambda: self.js("return socialVisibility()") == SIGNALS_SHOWN)
        self.configure(hideAvatars=True)
        self.wait_until(lambda: self.js("return socialVisibility()") == avatars_hidden)
        self.configure(hideSocialSignals=True, **dict.fromkeys(SIGNAL_KEYS, True))
        self.wait_until(lambda: self.js("return socialVisibility()") == signals_hidden)
        self.configure(hideSocialSignals=False, **dict.fromkeys(SIGNAL_KEYS, False))
        self.wait_until(lambda: self.js("return socialVisibility()") == SIGNALS_SHOWN)

    def test_navbar_sections_logo_exception_and_parent_control(self):
        navbar = lambda: self.js("return navbarVisibility()")
        self.configure(**ALL_NAVBAR_SECTIONS)
        self.wait_until(lambda: navbar() == visible_navbar(
            menu=True, search=True, chat=True, notifications=True, profile=True,
            **OTHER_NAVBAR_ITEMS,
        ))
        self.configure(hideNavbar=True)
        self.wait_until(lambda: not navbar()["navbar"])
        self.configure(hideNavbar=False, **dict.fromkeys(ALL_NAVBAR_SECTIONS, False))
        self.wait_until(lambda: navbar() == visible_navbar())
        self.configure(hideNavbarMenu=True)
        self.wait_until(lambda: navbar() == visible_navbar(menu=True))
        self.configure(hideNavbarMenu=False)
        self.wait_until(lambda: navbar() == visible_navbar())
        self.configure(hideNavbarOthers=True)
        self.wait_until(lambda: navbar() == visible_navbar(**OTHER_NAVBAR_ITEMS))

    def test_left_sidebar_sections_and_parent_control(self):
        sidebar = lambda: self.js("return sidebarVisibility()")
        self.configure(**ALL_SIDEBAR_SECTIONS)
        self.wait_until(lambda: sidebar() == {
            **VISIBLE_SIDEBAR,
            "games": False, "customFeeds": False, "recent": False,
            "communities": False, "resources": False,
        })
        self.configure(hideLeftSidebar=True)
        self.wait_until(lambda: not sidebar()["sidebar"])
        self.configure(hideLeftSidebar=False, **dict.fromkeys(ALL_SIDEBAR_SECTIONS, False))
        self.wait_until(lambda: sidebar() == VISIBLE_SIDEBAR)

    def test_blocked_main_page_links_hide_from_navigation(self):
        links = lambda: self.js("return mainPageLinkVisibility()")
        all_links = dict.fromkeys(["homepage", "popular", "explore", "news"], True)
        self.configure(blockNews=True)
        self.wait_until(lambda: links() == {**all_links, "news": False})
        self.configure(blockHomepage=True, blockPopular=True, blockExplore=True, blockNews=False)
        self.wait_until(lambda: links() == {
            "homepage": False, "popular": False, "explore": False, "news": True,
        })
        self.wait_until(lambda: not self.js("return navbarVisibility().logo"))
        self.configure(blockHomepage=False, blockPopular=False, blockExplore=False)
        self.wait_until(lambda: links() == all_links)
        self.wait_until(lambda: self.js("return navbarVisibility().logo"))

    def test_right_sidebar_hides_without_related_posts_in_the_page(self):
        self.open_fixture("/r/test/comments/abc/post/", fixture="right-sidebar")
        visibility = """
          const visible = (element) => element.getClientRects().length > 0;
          return {
            sidebars: Array.from(document.querySelectorAll('[data-right-sidebar]'), visible),
            kept: Array.from(document.querySelectorAll(
              '#main-post, #comment, #inline-related-posts, #left-sidebar-container,'
              + ' shreddit-related-posts, #related-posts, [data-testid="related-posts"]'
            ), visible),
          };
        """
        self.assertEqual(self.js(visibility), {"sidebars": [True] * 6, "kept": [True] * 7})
        self.configure(hideRelatedPosts=True)
        self.wait_until(lambda: self.js(visibility) == {"sidebars": [False] * 6, "kept": [True] * 7})
        self.configure(hideRelatedPosts=False)
        self.wait_until(lambda: self.js(visibility) == {"sidebars": [True] * 6, "kept": [True] * 7})

    def test_video_autoplay_disabled_and_restored_inside_shadow_dom(self):
        self.configure(disableAutoplay=True)
        self.js("addAutoplayPlayer()")
        self.wait_until(lambda: self.js("return autoplayState()") == {
            "player": [False, False, False],
            "playerManaged": True,
            "videoAutoplay": False,
            "videoManaged": True,
        })
        self.configure(disableAutoplay=False)
        self.wait_until(lambda: self.js("return autoplayState()") == {
            "player": [True, True, True],
            "playerManaged": False,
            "videoAutoplay": True,
            "videoManaged": False,
        })

    def test_every_page_rule_is_valid_css(self):
        # Browsers drop a rule whose selector they reject, which would then
        # hide nothing without any error.
        self.js("resetFeed([post('a')])")
        self.configure(**dict.fromkeys(PAGE_RULE_SETTINGS, True))
        rules = """
          const hosts = document.querySelectorAll('shreddit-post, shreddit-comment-action-row, left-nav-top-section');
          const styles = [
            document.getElementById('frontfilter-hidden-style'),
            ...Array.from(hosts, (host) => Array.from(host.shadowRoot.querySelectorAll('style[id^="frontfilter-"]'))).flat(),
          ];
          // Firefox hides content-script sheets from the page: parse a copy.
          const parsed = (text) => {
            const sheet = new CSSStyleSheet();
            sheet.replaceSync(text);
            return sheet.cssRules.length;
          };
          return styles.map((style) => [
            style.id, (style.textContent.match(/\\{[^{}]*\\}/g) || []).length, parsed(style.textContent),
          ]);
        """
        self.wait_until(lambda: len(self.js(rules)) >= 4, "shadow-root styles were not added")
        for style_id, written, parsed in self.js(rules):
            with self.subTest(style=style_id):
                self.assertGreater(written, 0)
                self.assertEqual(parsed, written)

    # Navigation blocking

    def wait_for_block_page(self, message=None):
        block_page = self.session.extension_url("blocked/index.html")
        self.wait_until(lambda: self.driver.current_url.startswith(block_page))
        if message:
            self.wait_until(lambda: self.driver.find_element("id", "block-message").text == message)

    def test_declarative_redirects_for_homepage_explore_and_news(self):
        self.session.store(blockHomepage=True, blockExplore=True, blockNews=True)
        for path, message in [
            ("/", "Reddit Homepage is blocked"),
            ("/explore/", "Explore page is blocked"),
            ("/news/?feed=home", "News page is blocked"),
        ]:
            with self.subTest(path=path):
                original_url = self.server.url(path, "localhost")
                self.driver.get(original_url)
                self.wait_for_block_page(message)
                self.assertEqual(self.driver.current_url.split("#", 1)[1], original_url)

    def test_subreddit_exceptions_take_precedence_in_declarative_rules(self):
        self.session.store(
            blockSubHome=True,
            blockedSubreddits=[{"name": "*italy*", "mode": "all"}],
            allowedSubreddits=["italypersonalfinance"],
        )
        allowed_url = self.server.url("/r/italypersonalfinance/comments/abc/post", "localhost")
        self.driver.get(allowed_url)
        self.assertEqual(self.driver.current_url, allowed_url)
        blocked_url = self.server.url("/r/italytravel/comments/abc/post", "localhost")
        self.driver.get(blocked_url)
        self.wait_for_block_page()
        self.assertIn("?target=subreddit&filter=*italy*#", self.driver.current_url)
        self.assertEqual(self.driver.current_url.split("#", 1)[1], blocked_url)

    # Feed filters and the scroll limit

    def test_fixed_quota_skips_ads_filtered_duplicate_and_nested_posts(self):
        self.configure(
            limitInfiniteScroll=True, scrollLimit=3, scrollMode="fixed",
            blockedSubreddits=[{"name": "blocked", "mode": "all"}],
        )
        self.js(
            "resetFeed([post('a'), post('ad', 'safe', {ad: true}), post('b', 'blocked'),"
            " post('c'), post('d'), post('e'), post('f')])"
        )
        self.expect("acd")
        # Posts outside the main feed never count toward it.
        self.assertTrue(self.js(
            "return document.querySelector('aside shreddit-post').getClientRects().length > 0"
        ))
        self.assertTrue(self.js("return document.querySelector('.frontfilter-feed-controls button').hidden"))
        self.assertTrue(self.js("return !document.querySelector('.frontfilter-feed-next')"))
        # A crosspost nested in a card and a repeated card take no extra slot.
        self.js(
            "appendRows(document.querySelector('#t3_a'), [post('nested')]);"
            " appendRows(document.querySelector('shreddit-feed'), [post('a')])"
        )
        self.expect("acd")
        self.assertTrue(self.js(
            "return document.querySelector('#t3_nested').getClientRects().length > 0"
        ))

    def test_title_and_preview_keywords_with_fixed_quota(self):
        self.configure(
            limitInfiniteScroll=True, scrollLimit=3, scrollMode="fixed",
            blockedTitleKeywords=["Trump"],
        )
        self.js(
            "resetFeed([post('a', 'safe', {title: 'Trump update'}), post('b'),"
            " post('c', 'safe', {body: 'A TRUMP preview'}), post('d'), post('e')])"
        )
        self.expect("bde")

    def test_subreddit_exceptions_take_precedence_in_feeds(self):
        self.configure(
            blockedSubreddits=[{"name": "*italy*", "mode": "all"}],
            allowedSubreddits=["italypersonalfinance"],
        )
        self.js("resetFeed([post('allowed', 'ItalyPersonalFinance'), post('blocked', 'italytravel')])")
        self.expect(["allowed"])

    def test_page_world_loading_fills_the_fixed_quota(self):
        self.configure(limitInfiniteScroll=True, scrollLimit=10, scrollMode="fixed")
        self.js("""
            const rows = (start, count) => Array.from({length: count}, (_, i) => post(String(start + i)));
            resetFeed(rows(0, 2), [{rows: rows(2, 10)}], true);
        """)
        self.wait_until(lambda: self.js("return shown().length") == 10)
        self.assertEqual(self.js("return loadCalls"), 1)

    def test_button_groups_buffering_double_clicks_and_native_load_guard(self):
        self.configure(
            limitInfiniteScroll=True, scrollLimit=3, scrollMode="button",
            blockedSubreddits=[{"name": "blocked", "mode": "all"}],
        )
        # Filtered batches are refilled; excess results wait for the next group.
        self.js(
            "resetFeed([post('a'), post('b')], [{rows: [post('ad', 'safe', {ad: true}), post('x', 'blocked')], next: '2'},"
            " {rows: [post('c'), post('d'), post('e'), post('f'), post('g')], next: '3'}], true)"
        )
        self.expect("abc")
        self.assertEqual(self.js("return loadCalls"), 2)
        self.click_feed_button()
        self.expect("abcdef")
        self.assertEqual(self.js("return loadCalls"), 2)
        # Results appear progressively, and a second click while loading
        # cannot authorize another group.
        self.js("window.plans = [{rows: [post('h'), post('i'), post('j'), post('k')], next: '4', delay: 500}]")
        self.click_feed_button()
        self.assertEqual(self.js("return shown()"), [f"t3_{i}" for i in "abcdefg"])
        self.js("document.querySelector('.frontfilter-feed-controls button').click()")
        self.expect("abcdefghi")
        self.assertEqual(self.js("return loadCalls"), 3)
        self.assertTrue(self.js(
            "return document.querySelector('.frontfilter-feed-controls').textContent.includes('9 posts shown')"
        ))
        # Native loads are suppressed at the boundary and released with the limit.
        self.js("document.querySelector('faceplate-partial').loadContent()")
        self.assertEqual(self.js("return loadCalls"), 3)
        self.js("window.plans = [{rows: [post('l')]}]")
        self.configure(limitInfiniteScroll=False)
        self.expect("abcdefghijkl")
        self.assertTrue(self.js("return !document.querySelector('.frontfilter-feed-controls')"))

    def test_native_load_guard_releases_when_the_limit_is_removed(self):
        self.configure(limitInfiniteScroll=True, scrollLimit=3, scrollMode="fixed")
        self.js("""
            resetFeed([post("a"), post("b"), post("c")], [{rows: [post("d"), post("e")]}], true);
            document.querySelector("faceplate-partial").loadContent();
        """)
        self.pause(200)
        self.assertEqual(self.js("return loadCalls"), 0)
        self.configure(limitInfiniteScroll=False)
        self.wait_until(lambda: self.js("return shown().length") == 5)
        self.assertEqual(self.js("return loadCalls"), 1)

    def test_load_error_retry_and_partial_final_group(self):
        self.configure(limitInfiniteScroll=True, scrollLimit=3, scrollMode="button")
        self.js("resetFeed([post('a'), post('b'), post('c')], [{error: true}, {rows: [post('d'), post('e')]}], true)")
        self.expect("abc")
        self.click_feed_button()
        self.wait_until(lambda: self.js("return !document.querySelector('.frontfilter-feed-retry').hidden"))
        self.expect("abc")
        self.click_feed_button()
        self.expect("abcde")
        self.wait_until(lambda: self.js(
            "return document.querySelector('.frontfilter-feed-controls').textContent.includes('End of feed')"
        ))

    def test_spa_navigation_resets_the_quota(self):
        self.configure(limitInfiniteScroll=True, scrollLimit=3, scrollMode="button")
        self.js("resetFeed([post('a'), post('b'), post('c')], [{rows: [post('d'), post('e'), post('f')]}], true)")
        self.expect("abc")
        self.click_feed_button()
        self.expect("abcdef")
        # Route changes and replacement feeds cannot inherit a larger quota.
        self.js(
            "history.pushState({}, '', '/r/second/top/?t=week');"
            " resetFeed([post('m'), post('n'), post('o'), post('p')])"
        )
        self.expect("mno")
        # HOME entries block a subreddit's front page, not its posts in feeds.
        self.configure(blockedSubreddits=[{"name": "safe", "mode": "home"}])
        self.expect("mno")

    def test_late_ad_classification_and_independent_filter_visibility(self):
        self.configure(limitInfiniteScroll=True, scrollLimit=3, scrollMode="fixed")
        self.js("resetFeed([post('a'), post('b'), post('c'), post('d'), post('e')])")
        self.expect("abc")
        self.js("document.querySelector('#t3_c').setAttribute('is-promoted', '')")
        self.expect("abd")
        self.configure(limitInfiniteScroll=False)
        self.expect("abde")

    def test_stale_responses_after_navigation(self):
        self.configure(limitInfiniteScroll=True, scrollLimit=3, scrollMode="button")
        self.js(
            "resetFeed([post('a'), post('b'), post('c')],"
            " [{rows: [post('d'), post('e'), post('f')], next: '2', delay: 600}], true)"
        )
        self.expect("abc")
        self.click_feed_button()
        self.js("history.pushState({}, '', '/r/third/'); resetFeed([post('m'), post('n'), post('o'), post('p')])")
        self.expect("mno")
        # Waiting beyond the old response verifies it cannot change the new group.
        self.pause(750)
        self.expect("mno")

    def test_delayed_spa_container_reuse(self):
        self.configure(limitInfiniteScroll=True, scrollLimit=3, scrollMode="button")
        self.js("resetFeed([post('m'), post('n'), post('o'), post('p')])")
        self.expect("mno")
        # Feed updates can reuse the container after the URL has changed.
        self.js("history.pushState({}, '', '/r/fourth/')")
        self.wait_until(lambda: self.js("return shown().length === 0"))
        self.js(
            "const feed = document.querySelector('shreddit-feed'); feed.replaceChildren();"
            " appendRows(feed, [post('u'), post('v'), post('w'), post('z')])"
        )
        self.expect("uvw")

    def test_repeated_cursor_stops_loading(self):
        self.configure(limitInfiniteScroll=True, scrollLimit=3, scrollMode="button")
        # A response that repeats its cursor must stop, not loop forever.
        self.js("resetFeed([post('a')], [{rows: [post('b')], next: '1'}], true)")
        self.wait_until(lambda: self.js(
            "return document.querySelector('.frontfilter-feed-controls').textContent.includes('did not advance')"
        ))
        self.assertEqual(self.js("return loadCalls"), 1)
        self.assertEqual(self.js("return shown()"), ["t3_a", "t3_b"])

    def test_unrelated_native_loaders_remain_callable(self):
        self.configure(limitInfiniteScroll=True, scrollLimit=3, scrollMode="button")
        self.js("resetFeed([post('a'), post('b'), post('c'), post('d')], [], true)")
        self.expect("abc")
        self.assertTrue(self.js("return document.documentElement.hasAttribute('data-frontfilter-feed-gate')"))
        # Other partials, such as comment loaders, still load behind the gate.
        self.js(
            "window.plans = [{rows: []}]; const partial = document.createElement('faceplate-partial');"
            " document.querySelector('shreddit-feed').append(partial); partial.loadContent().catch(() => {})"
        )
        self.assertEqual(self.js("return loadCalls"), 1)

    def test_incomplete_cards_keep_their_position(self):
        self.configure(limitInfiniteScroll=True, scrollLimit=3, scrollMode="button")
        self.js(
            "resetFeed([post('a'), post('b'), post('c'), post('d')]);"
            " const first = document.querySelector('#t3_a'); first.removeAttribute('subreddit-name');"
            " first.removeAttribute('permalink'); first.querySelector('a').removeAttribute('href')"
        )
        self.wait_until(lambda: self.js("return shown().length === 0"))
        self.js("document.querySelector('#t3_a').setAttribute('subreddit-name', 'safe')")
        self.expect("abc")

    def check_lazy_loading_up_to_100(self, mode):
        """n=100 must not fetch the entire quota before the reader needs it."""
        self.js(
            "const style = document.createElement('style'); style.textContent ="
            " 'main > shreddit-feed > article { min-height: 350px; }"
            " button { display: block; line-height: 80px; padding-block: 20px; }';"
            " document.head.append(style)"
        )
        self.configure(limitInfiniteScroll=True, scrollLimit=100, scrollMode=mode)
        self.js(
            "window.scrollTo(0, 0); const rows = (start, n) => Array.from({length: n}, (_, i) => post(String(start + i)));"
            " resetFeed(rows(0, 20), [{rows: rows(20, 20), next: '2'}, {rows: rows(40, 20), next: '3'},"
            " {rows: rows(60, 20), next: '4'}, {rows: rows(80, 40), next: '5'}], true)"
        )
        self.expect([str(i) for i in range(20)])
        self.pause(350)
        self.assertEqual(self.js("return loadCalls"), 0)
        self.assertTrue(self.js("return !document.querySelector('.frontfilter-feed-next:not([hidden])')"))
        self.assertTrue(self.js(
            "return Array.from(document.querySelectorAll('.frontfilter-feed-controls button[hidden]'))"
            ".every((button) => getComputedStyle(button).display === 'none')"
        ))
        scroll_to_controls = "document.querySelector('.frontfilter-feed-controls').scrollIntoView({block: 'end'})"
        for count in [40, 60, 80, 100]:
            self.js(scroll_to_controls)
            self.expect([str(i) for i in range(count)])
            self.pause(200)
            self.assertEqual(self.js("return loadCalls"), (count - 20) // 20)
        self.js(scroll_to_controls)
        self.pause(250)
        self.assertEqual(self.js("return loadCalls"), 4)

    def test_lazy_loading_up_to_100_in_fixed_mode(self):
        self.check_lazy_loading_up_to_100("fixed")
        self.assertTrue(self.js("return !document.querySelector('.frontfilter-feed-next')"))

    def test_lazy_loading_up_to_100_in_button_mode(self):
        self.check_lazy_loading_up_to_100("button")
        self.assertTrue(self.js(
            "const button = document.querySelector('.frontfilter-feed-next'); const style = getComputedStyle(button);"
            " return !button.hidden && style.alignItems === 'center' && style.justifyContent === 'center'"
            " && button.getBoundingClientRect().height === 40"
        ))
        self.save_screenshot("feed-button.png")
        self.click_feed_button()
        self.expect([str(i) for i in range(120)])
        self.pause(250)
        self.assertEqual(self.js("return loadCalls"), 4)
        self.js(
            "window.plans = [{rows: Array.from({length: 110}, (_, i) => post(String(i + 120))), next: '6'}];"
            " document.querySelector('.frontfilter-feed-controls').scrollIntoView({block: 'end'})"
        )
        self.expect([str(i) for i in range(200)])
        self.assertEqual(self.js("return loadCalls"), 5)

    def test_loading_stays_bounded_when_every_post_is_filtered(self):
        self.configure(
            limitInfiniteScroll=True, scrollLimit=100, scrollMode="fixed",
            blockedSubreddits=[{"name": "blocked", "mode": "all"}],
        )
        self.js(
            "window.scrollTo(0, 0); resetFeed([], Array.from({length: 5},"
            " (_, i) => ({rows: [post(String(i), 'blocked')], next: String(i + 2)})), true)"
        )
        self.wait_until(lambda: self.js("return !document.querySelector('.frontfilter-feed-retry').hidden"))
        self.assertEqual(self.js("return loadCalls"), 3)
        self.assertTrue(self.js("return !document.querySelector('.frontfilter-feed-next')"))

    def test_suggested_posts_hide_only_in_the_home_feed(self):
        # Suggested posts go from the Home feed whatever the page language; an
        # empty recommendation source means a joined community.
        self.configure(hideSuggestedPosts=True)
        self.js("history.pushState({}, '', '/'); window.scrollTo(0, 0)")
        self.js(
            "resetFeed([post('joined'), post('suggested', 'safe', {recommended: 'user_to_post'}),"
            " post('unranked', 'safe', {recommended: ''})])"
        )
        self.expect(["joined", "unranked"])
        self.wait_until(lambda: self.js("return adVisibility().feed") == {
            "t3_joined": [True, True], "t3_suggested": [False, False], "t3_unranked": [True, True],
        })
        self.js("history.pushState({}, '', '/r/popular/')")
        self.js("resetFeed([post('joined'), post('suggested', 'safe', {recommended: 'popular'})])")
        self.expect(["joined", "suggested"])

    def test_native_infinite_scroll_pauses_after_fully_filtered_pages(self):
        # Without a limit, Reddit would otherwise fetch hidden pages forever.
        pause_controls = "document.querySelector('.frontfilter-feed-paused')"
        self.configure(hideSuggestedPosts=True)
        self.js("history.pushState({}, '', '/'); window.scrollTo(0, 0)")
        self.js(
            "resetFeed([post('j1')], Array.from({length: 8}, (_, i) => ({rows: [post('s' + i, 'safe',"
            " {recommended: 'geo_popular'})], next: String(i + 2), delay: 150})), true); enableNativeLoading()"
        )
        self.wait_until(lambda: self.js(f"return !!{pause_controls}"))
        paused_calls = self.js("return loadCalls")
        self.assertIn(paused_calls, (3, 4))
        self.pause(800)
        self.assertEqual(self.js("return loadCalls"), paused_calls)
        self.assertEqual(self.js("return shown()"), ["t3_j1"])
        self.js(f"{pause_controls}.querySelector('button').click()")
        self.wait_until(lambda: self.js("return loadCalls") > paused_calls)
        self.wait_until(lambda: self.js(f"return !!{pause_controls}"))
        # Revealing hidden posts resumes loading on its own.
        self.configure(hideSuggestedPosts=False)
        self.wait_until(lambda: self.js(f"return !{pause_controls}"))
        self.js("disableNativeLoading()")

    def test_flair_filters_in_feeds_and_the_scroll_limit(self):
        # Flair-filtered posts take their wrapper and divider and never count
        # toward the scroll limit.
        rows = (
            "resetFeed([post('a'), post('b', 'safe', {flair: 'US Politics'}),"
            " post('c', 'safe', {flair: 'MEME'}), post('d', 'safe', {flair: 'Question'}),"
            " post('e'), post('f')])"
        )
        self.configure(blockedFlairs=["*politic*", "meme"])
        self.js(rows)
        self.expect("adef")
        self.wait_until(lambda: self.js("return adVisibility().feed") == {
            **{f"t3_{i}": [True, True] for i in "adef"},
            **{f"t3_{i}": [False, False] for i in "bc"},
        })
        self.configure(limitInfiniteScroll=True, scrollLimit=3, scrollMode="fixed")
        self.js(rows)
        self.expect("ade")

    def test_keyword_filters_hide_comments_with_their_replies(self):
        self.configure(blockedTitleKeywords=["trump"])
        self.js("resetFilterComments()")
        self.wait_until(lambda: self.js("return visibleComments()") == [
            "comment-photo", "comment-thanks", "comment-spam", "comment-spam-reply",
            "comment-mention", "comment-deleted",
        ])
        self.configure(blockedTitleKeywords=[])
        self.wait_until(lambda: self.js("return visibleComments()") == [
            "comment-photo", "comment-thanks", "comment-spam", "comment-spam-reply",
            "comment-mention", "comment-politics", "comment-politics-reply", "comment-deleted",
            "comment-deleted-reply",
        ])

    def test_comments_linking_to_a_blocked_subreddit_stay_visible(self):
        # Comments are not posts: an ALL rule hides a subreddit's posts, not
        # the comments that mention it.
        self.js("resetFeed([post('a'), post('b', 'blocked')]); resetFilterComments()")
        self.configure(blockedSubreddits=[{"name": "blocked", "mode": "all"}])
        self.expect("a")
        self.pause(300)
        self.assertTrue(self.js(
            "return document.querySelector('#comment-mention [slot=\"comment\"]').getClientRects().length > 0"
        ))

    # One-click Block buttons

    def test_feed_block_buttons_undo_and_visibility_rules(self):
        # The buttons are off by default. The page is r/test, so its own posts
        # get none, and allowed subreddits get none either.
        block_buttons = (
            "return Array.from(document.querySelectorAll('.frontfilter-block-subreddit'),"
            " (button) => button.dataset.subreddit)"
        )
        self.js(
            "resetFeed([post('one', 'alpha', {credit: true}), post('two', 'beta', {credit: true}),"
            " post('own', 'test', {credit: true})])"
        )
        self.expect(["one", "two", "own"])
        self.pause(300)
        self.assertEqual(self.js(block_buttons), [])
        self.configure(showBlockSubredditButton=True)
        self.wait_until(lambda: self.js(block_buttons) == ["alpha", "beta"])
        # The button sits in the actions group, before Join.
        self.assertEqual(self.js(
            "return document.querySelector('.frontfilter-block-subreddit').nextElementSibling.localName"
        ), "shreddit-join-button")
        self.configure(allowedSubreddits=["beta"])
        self.wait_until(lambda: self.js(block_buttons) == ["alpha"])
        self.js("document.querySelector('.frontfilter-block-subreddit').click()")
        # An ALL rule hides the subreddit's posts; the page does not navigate.
        self.expect(["two", "own"])
        toast = "return document.querySelector('.frontfilter-block-toast')?.textContent"
        self.wait_until(lambda: self.js(toast) == "r/alpha blockedUndo")
        self.assertEqual(self.js("return location.pathname"), "/r/test/")
        self.js("document.querySelector('.frontfilter-block-toast button').click()")
        self.expect(["one", "two", "own"])
        self.wait_until(lambda: self.js(toast) == "r/alpha unblocked")
        self.configure(showBlockSubredditButton=False, allowedSubreddits=[])
        self.wait_until(lambda: self.js(block_buttons) == [])

    def test_subreddit_header_block_button_and_one_time_undo(self):
        # On a subreddit's own page the button sits beside Create Post; the
        # block sends the page to the block page, which offers the undo.
        header_button = "document.querySelector('.frontfilter-block-subreddit--header')"
        stored_rules = (
            "chrome.storage.local.get('blockedSubreddits')"
            ".then((stored) => arguments[0](stored.blockedSubreddits))"
        )
        self.js("setSubredditHeader('test')")
        self.pause(300)
        self.assertTrue(self.js(f"return !{header_button}"))
        self.configure(showBlockSubredditButton=True)
        self.wait_until(lambda: self.js(f"return {header_button}?.dataset.subreddit") == "test")
        self.assertTrue(self.js(
            f"return {header_button}.previousElementSibling.querySelector('[data-testid=create-post]') !== null"
        ))
        self.assertEqual(
            self.js(f"return {header_button}.nextElementSibling.localName"),
            "shreddit-subreddit-header-buttons",
        )

        def block_from_header():
            self.wait_until(lambda: self.js(f"return {header_button}?.dataset.subreddit") == "test")
            self.js(f"{header_button}.click()")
            self.wait_for_block_page("r/test is blocked")

        def undo_offered():
            # Let the one-time token check finish before reading the button.
            self.pause(300)
            return self.driver.find_element("id", "undo-block").is_displayed()

        block_from_header()
        self.assertTrue(undo_offered())
        self.assertNotIn("undo", self.driver.current_url)
        # Not on a reload of the block page...
        self.driver.refresh()
        self.wait_until(lambda: self.driver.find_element("id", "block-message").text == "r/test is blocked")
        self.assertFalse(undo_offered())
        # ...nor when visiting the already blocked subreddit again.
        self.driver.get(self.server.url())
        self.wait_for_block_page("r/test is blocked")
        self.assertFalse(undo_offered())
        self.assertEqual(self.driver.execute_async_script(stored_rules), [{"name": "test", "mode": "all"}])

        # A new one-click block offers it again, and undo removes the rule.
        self.driver.execute_async_script("chrome.storage.local.set({blockedSubreddits: []}).then(arguments[0])")
        self.open_fixture()
        self.js("setSubredditHeader('test')")
        block_from_header()
        self.assertTrue(undo_offered())
        self.driver.find_element("id", "undo-block").click()
        self.wait_until(lambda: self.driver.execute_async_script(stored_rules) == [])
