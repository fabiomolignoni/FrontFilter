"""Optional real Firefox integration tests. Requires Selenium and Firefox.

Run: python3 tests/browser/firefox.py --firefox /path/to/firefox
Uses a temporary profile/add-on and a local HTTP fixture; never visits Reddit.
"""
import argparse
import json
from pathlib import Path
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from zipfile import ZipFile

from selenium import webdriver
from selenium.webdriver.firefox.options import Options
from selenium.webdriver.firefox.service import Service
from selenium.webdriver.common.keys import Keys
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "src"


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write((ROOT / "tests/fixtures/infinite-feed.html").read_bytes())

    def log_message(self, *args):
        pass


def verify_toolbar_popup(driver, wait, addon_id, screenshot):
    """Exercise Firefox's initial popup sizing, which a normal tab cannot test."""
    driver.set_window_size(1366, 900)
    driver.set_context("chrome")
    popup_selector = 'panel[panelopen="true"] browser.webextension-popup-browser'
    try:
        widget_id = addon_id.lower().replace("{", "_").replace("}", "_") + "-browser-action"
        driver.execute_script(
            "CustomizableUI.addWidgetToArea(arguments[0], CustomizableUI.AREA_NAVBAR)",
            widget_id,
        )
        button = driver.find_element("css selector", f"#{widget_id} .unified-extensions-item-action-button")
        for attempt in range(2):
            button.click()
            wait.until(lambda _: driver.execute_script("""
                const popup = document.querySelector(arguments[0]);
                if (!popup || popup.closest('panel').state !== 'open') return false;
                const rect = popup.getBoundingClientRect();
                return rect.width === 460 && rect.height === 600;
            """, popup_selector))
            if screenshot and attempt == 0:
                driver.save_screenshot(str(Path(screenshot).with_name("toolbar-popup.png")))
            driver.execute_script(
                "document.querySelector(arguments[0]).closest('panel').hidePopup()",
                popup_selector,
            )
            wait.until(lambda _: not driver.execute_script(
                "return !!document.querySelector(arguments[0])", popup_selector,
            ))
        print("PASS native toolbar popup opens and reopens at 460x600", flush=True)
    finally:
        driver.set_context("content")


def verify_settings_tabs(driver, wait, screenshot):
    def selected(name):
        assert driver.find_element("css selector", '[role=tab][aria-selected=true]').get_dom_attribute("id") == f"tab-{name}"
        assert [p.get_dom_attribute("id") for p in driver.find_elements("css selector", '[role=tabpanel]') if p.rect["height"] > 0] == [f"panel-{name}"]

    selected("controls")
    assert driver.find_element("id", "block-explore").is_enabled()
    assert driver.find_element("id", "block-news").is_enabled()
    all_comments = driver.find_element("id", "hide-comments")
    comment_replies = driver.find_element("id", "hide-comment-replies")
    assert not all_comments.is_selected()
    assert not comment_replies.is_selected() and comment_replies.is_enabled()
    all_comments.click()
    wait.until(lambda _: comment_replies.is_selected() and not comment_replies.is_enabled())
    all_comments.click()
    wait.until(lambda _: comment_replies.is_selected() and comment_replies.is_enabled())
    comment_replies.click()
    wait.until(lambda _: not comment_replies.is_selected())
    suggested_communities = driver.find_element("id", "hide-suggested-communities")
    assert not suggested_communities.is_selected()
    suggested_communities.click()
    wait.until(lambda _: suggested_communities.is_selected())
    all_navbar = driver.find_element("id", "hide-navbar")
    navbar_sections = [driver.find_element("id", element_id) for element_id in [
        "hide-navbar-menu",
        "hide-navbar-search",
        "hide-navbar-chat",
        "hide-navbar-notifications",
        "hide-navbar-profile",
        "hide-navbar-others",
    ]]
    assert all(not toggle.is_selected() and toggle.is_enabled() for toggle in navbar_sections)
    all_navbar.click()
    wait.until(lambda _: all(
        toggle.is_selected() and not toggle.is_enabled()
        for toggle in navbar_sections
    ))
    all_navbar.click()
    wait.until(lambda _: all(
        not toggle.is_selected() and toggle.is_enabled()
        for toggle in navbar_sections
    ))
    navbar_sections[1].click()
    wait.until(lambda _: navbar_sections[1].is_selected())
    navbar_sections[1].click()
    wait.until(lambda _: all(not toggle.is_selected() for toggle in navbar_sections))
    all_left_sidebar = driver.find_element("id", "hide-left-sidebar")
    left_sidebar_sections = [driver.find_element("id", element_id) for element_id in [
        "hide-left-sidebar-games",
        "hide-left-sidebar-custom-feeds",
        "hide-left-sidebar-recent",
        "hide-left-sidebar-communities",
        "hide-left-sidebar-resources",
    ]]
    assert all(not toggle.is_selected() and toggle.is_enabled() for toggle in left_sidebar_sections)
    all_left_sidebar.click()
    wait.until(lambda _: all(
        toggle.is_selected() and not toggle.is_enabled()
        for toggle in left_sidebar_sections
    ))
    all_left_sidebar.click()
    wait.until(lambda _: all(
        not toggle.is_selected() and toggle.is_enabled()
        for toggle in left_sidebar_sections
    ))
    left_sidebar_sections[0].click()
    wait.until(lambda _: left_sidebar_sections[0].is_selected())
    left_sidebar_sections[0].click()
    wait.until(lambda _: all(not toggle.is_selected() for toggle in left_sidebar_sections))
    driver.find_element("id", "tab-controls").send_keys(Keys.ARROW_RIGHT)
    selected("filters")
    assert driver.switch_to.active_element.get_dom_attribute("id") == "tab-filters"
    driver.find_element("id", "add-subreddit").click()
    draft = driver.find_element("css selector", ".blocked-item input")
    draft.send_keys("firefox")
    driver.find_element("id", "add-allowed-subreddit").click()
    allowed_draft = driver.find_element("css selector", ".allowed-item input")
    allowed_draft.send_keys("ItalyPersonalFinance")
    driver.find_element("id", "add-title-keyword").click()
    keyword_draft = driver.find_element("css selector", ".keyword-item input")
    keyword_draft.send_keys("Trump")
    driver.find_element("id", "tab-settings").click()
    selected("settings")
    theme = driver.find_element("id", "color-theme")
    assert theme.get_property("value") == "system"
    driver.execute_script("arguments[0].value = 'dark'; arguments[0].dispatchEvent(new Event('change', {bubbles:true}))", theme)
    wait.until(lambda _: driver.find_element("tag name", "html").get_attribute("data-theme") == "dark")
    assert driver.execute_script("return getComputedStyle(document.querySelector('.container')).backgroundColor") == "rgb(26, 26, 27)"
    driver.execute_script("arguments[0].value = 'light'; arguments[0].dispatchEvent(new Event('change', {bubbles:true}))", theme)
    wait.until(lambda _: driver.find_element("tag name", "html").get_attribute("data-theme") == "light")
    assert driver.execute_script("return localStorage.getItem('frontfilter-theme')") == "light"
    assert driver.execute_script("return getComputedStyle(document.querySelector('.container')).backgroundColor") == "rgb(255, 255, 255)"
    driver.find_element("id", "tab-settings").send_keys(Keys.ARROW_RIGHT)
    selected("controls")
    driver.find_element("id", "tab-controls").send_keys(Keys.END)
    selected("settings")
    driver.find_element("id", "tab-settings").send_keys(Keys.HOME, Keys.ARROW_RIGHT)
    selected("filters")
    assert draft.get_property("value") == "firefox"
    assert allowed_draft.get_property("value") == "italypersonalfinance"
    assert keyword_draft.get_property("value") == "Trump"
    wait.until(lambda _: driver.find_element("id", "save-indicator").get_property("textContent") == "Saved")
    driver.refresh()
    wait.until(lambda _: driver.find_element("id", "add-subreddit").is_enabled())
    assert driver.find_element("id", "hide-suggested-communities").is_selected()
    assert driver.find_element("tag name", "html").get_attribute("data-theme") == "light"
    assert driver.execute_script("return localStorage.getItem('frontfilter-theme')") == "light"
    assert driver.find_element("id", "color-theme").get_property("value") == "light"
    driver.find_element("id", "tab-filters").click()
    assert "firefox" in [i.get_property("value") for i in driver.find_elements("css selector", ".blocked-item input")]
    assert "italypersonalfinance" in [i.get_property("value") for i in driver.find_elements("css selector", ".allowed-item input")]
    assert "Trump" in [i.get_property("value") for i in driver.find_elements("css selector", ".keyword-item input")]
    print("PASS accessible tabs, color themes, filter drafts, exceptions and persistence", flush=True)

    # Exercise a long list with the real add-on storage and rendering code.
    settings_handle = driver.current_window_handle
    driver.switch_to.window(driver.window_handles[0])
    driver.execute_script("document.documentElement.removeAttribute('data-test-settings-applied'); configure({blockedSubreddits: Array.from({length:60}, (_,i) => ({name: 'community' + i, mode: 'home'}))})")
    wait.until(lambda _: driver.find_element("tag name", "html").get_attribute("data-test-settings-applied"))
    driver.switch_to.window(settings_handle)
    driver.refresh()
    wait.until(lambda _: driver.find_element("id", "blocked-count").get_property("textContent") == "60 rules")
    for width in (560, 320):
        driver.set_window_size(width, 750)
        for name in ("controls", "filters", "settings"):
            driver.find_element("id", f"tab-{name}").click()
            selected(name)
            root = driver.find_element("tag name", "html")
            panel = driver.find_element("id", f"panel-{name}")
            assert root.get_property("scrollWidth") <= root.get_property("clientWidth")
            assert panel.get_property("scrollWidth") <= panel.get_property("clientWidth")
            top = driver.find_element("css selector", '[role=tablist]').rect["y"]
            if name == "filters":
                driver.find_elements("css selector", ".blocked-item input")[-1].click()
            elif name == "controls":
                driver.find_element("id", "scroll-limit").click()
            assert driver.find_element("css selector", '[role=tablist]').rect["y"] == top
        driver.find_element("id", "tab-filters").click()
        assert driver.find_element("id", "panel-filters").get_property("scrollTop") > 0
    print("PASS long lists, independent scroll positions and narrow standalone layout", flush=True)

    # Render the exact popup document at its compact dimensions as well.
    driver.get(driver.current_url.split("?")[0])
    driver.set_window_size(560, 800)
    wait.until(lambda _: driver.find_element("id", "add-subreddit").is_enabled())
    for name in ("controls", "filters", "settings"):
        driver.find_element("id", f"tab-{name}").click()
        assert driver.find_element("css selector", ".container").rect["height"] == 600
        assert driver.find_element("tag name", "body").rect["width"] == 460
        if screenshot:
            driver.save_screenshot(str(Path(screenshot).with_name(f"popup-{name}.png")))
    print("PASS stable popup dimensions across tabs", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--firefox")
    parser.add_argument("--screenshot", help="Optional path for a settings screenshot")
    args = parser.parse_args()
    options = Options()
    options.add_argument("-headless")
    if args.firefox:
        options.binary_location = args.firefox
    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    # The temporary test profile must allow WebDriver to reload extension pages.
    driver = webdriver.Firefox(options=options, service=Service(service_args=["--allow-system-access"]))
    wait = WebDriverWait(driver, 15)
    try:
        with tempfile.TemporaryDirectory(prefix="frontfilter-firefox-") as temp:
            manifest = json.loads((SOURCE / "manifest.json").read_text())
            manifest.pop("minimum_chrome_version")
            manifest.update(json.loads((ROOT / "manifests/firefox.json").read_text()))
            fixture_origin = "http://127.0.0.1/*"
            dnr_origin = "http://localhost/*"
            for content_script in manifest["content_scripts"]:
                content_script["matches"] = [fixture_origin]
            isolated_script = next(
                script for script in manifest["content_scripts"]
                if script.get("world", "ISOLATED") == "ISOLATED"
            )
            isolated_script["js"].insert(0, "fixture-bridge.js")
            manifest["host_permissions"].extend([fixture_origin, dnr_origin])
            manifest["web_accessible_resources"][0]["matches"].extend([fixture_origin, dnr_origin])
            addon = Path(temp) / "frontfilter-test.xpi"
            with ZipFile(addon, "w") as archive:
                for path in SOURCE.rglob("*"):
                    if not path.is_file():
                        continue
                    relative = path.relative_to(SOURCE).as_posix()
                    if relative == "manifest.json":
                        continue
                    if relative == "background/navigation-rules.js":
                        archive.writestr(
                            relative,
                            path.read_text().replace(r"reddit\\.com", "localhost"),
                        )
                    else:
                        archive.write(path, relative)
                archive.writestr("manifest.json", json.dumps(manifest))
                archive.writestr("fixture-bridge.js", '''
document.documentElement.setAttribute("data-test-extension-id", chrome.runtime.id);
window.addEventListener("frontfilter-test-settings", async (event) => {
  await chrome.storage.local.set(JSON.parse(event.detail));
  document.documentElement.setAttribute("data-test-settings-applied", event.detail);
});
window.addEventListener("frontfilter-test-open-popup", () => chrome.runtime.sendMessage({ action: "openSettings" }));
window.addEventListener("frontfilter-test-sync-rules", async () => {
  const response = await chrome.runtime.sendMessage({ action: "syncNavigationRules" });
  document.documentElement.setAttribute("data-test-rules-synced", JSON.stringify(response));
});
''')
            addon_id = driver.install_addon(str(addon), temporary=True)
            driver.get(f"http://127.0.0.1:{server.server_port}/r/test/")
            verify_toolbar_popup(driver, wait, addon_id, args.screenshot)

            def js(script, *values):
                return driver.execute_script(script, *values)

            def configure(**settings):
                wait.until(lambda _: js(
                    "return document.documentElement.hasAttribute('data-test-extension-id')"
                ))
                js("document.documentElement.removeAttribute('data-test-settings-applied'); configure(arguments[0]);", settings)
                wait.until(lambda _: js("return document.documentElement.hasAttribute('data-test-settings-applied')"))

            def expect(ids):
                try:
                    wait.until(lambda _: js("return shown()") == [f"t3_{i}" for i in ids])
                except Exception:
                    print(js("return {shown:shown(), calls:loadCalls, log:loadLog, plans, controls:document.querySelector('.frontfilter-feed-controls')?.textContent}"), flush=True)
                    raise

            def click():
                wait.until(lambda _: js("return !!document.querySelector('.frontfilter-feed-controls button:not([hidden]):not(:disabled)')"))
                js("document.querySelector('.frontfilter-feed-controls button:not([hidden]):not(:disabled)').click()")

            configure(hideComments=True)
            js("resetFeed([post('comments')])")
            comment_display = """
              return getComputedStyle(document.querySelector('main shreddit-post')
                .shadowRoot.querySelector('[data-action-bar-action="comments"]')).display
            """
            wait.until(lambda _: js(comment_display) == "none")
            configure(hideComments=False)
            wait.until(lambda _: js(comment_display) != "none")
            print("PASS feed comment action shadow DOM visibility", flush=True)

            js("resetComments()")
            configure(hideComments=False, hideCommentReplies=True)
            wait.until(lambda _: js("return visibleComments()") == [
                "comment-top-a", "comment-top-b",
            ])
            assert js(comment_display) != "none"
            configure(hideComments=True, hideCommentReplies=True)
            wait.until(lambda _: js("return visibleComments()") == [])
            wait.until(lambda _: js(comment_display) == "none")
            configure(hideComments=False, hideCommentReplies=False)
            wait.until(lambda _: js("return visibleComments()") == [
                "comment-top-a", "comment-reply", "comment-deep-reply", "comment-top-b",
            ])
            print("PASS top-level-only comment visibility and parent-toggle implication", flush=True)

            configure(hideSuggestedCommunities=False)
            wait.until(lambda _: js("return suggestedCommunitiesVisible()"))
            configure(hideSuggestedCommunities=True)
            wait.until(lambda _: not js("return suggestedCommunitiesVisible()"))
            configure(hideSuggestedCommunities=False)
            wait.until(lambda _: js("return suggestedCommunitiesVisible()"))
            print("PASS suggested communities visibility", flush=True)

            all_navbar_sections = {
                "hideNavbarMenu": True,
                "hideNavbarSearch": True,
                "hideNavbarChat": True,
                "hideNavbarNotifications": True,
                "hideNavbarProfile": True,
                "hideNavbarOthers": True,
            }
            visible_navbar = {
                "navbar": True, "menu": True, "logo": True,
                "search": True, "chat": True, "notifications": True,
                "profile": True, "campaign": True, "translate": True,
                "advertise": True, "create": True,
                "signup": True, "login": True,
            }
            configure(hideNavbar=False, **all_navbar_sections)
            wait.until(lambda _: js("return navbarVisibility()") == {
                **visible_navbar,
                "menu": False, "search": False, "chat": False,
                "notifications": False, "profile": False,
                "campaign": False, "translate": False,
                "advertise": False, "create": False,
                "signup": False, "login": False,
            })
            configure(hideNavbar=True)
            wait.until(lambda _: not js("return navbarVisibility().navbar"))
            configure(hideNavbar=False, **{
                key: False for key in all_navbar_sections
            })
            wait.until(lambda _: js("return navbarVisibility()") == visible_navbar)
            configure(hideNavbarMenu=True)
            wait.until(lambda _: js("return navbarVisibility()") == {
                **visible_navbar,
                "menu": False,
            })
            configure(hideNavbarMenu=False)
            wait.until(lambda _: js("return navbarVisibility()") == visible_navbar)
            configure(hideNavbarOthers=True)
            wait.until(lambda _: js("return navbarVisibility()") == {
                **visible_navbar,
                "campaign": False, "translate": False,
                "advertise": False, "create": False,
                "signup": False, "login": False,
            })
            configure(hideNavbarOthers=False)
            print("PASS navbar section filters, logo exception and parent control", flush=True)

            all_sidebar_sections = {
                "hideLeftSidebarGames": True,
                "hideLeftSidebarCustomFeeds": True,
                "hideLeftSidebarRecent": True,
                "hideLeftSidebarCommunities": True,
                "hideLeftSidebarResources": True,
            }
            visible_sidebar = {
                "sidebar": True, "top": True, "games": True,
                "customFeeds": True, "recent": True,
                "communities": True, "resources": True,
            }
            configure(hideLeftSidebar=False, **all_sidebar_sections)
            wait.until(lambda _: js("return sidebarVisibility()") == {
                **visible_sidebar,
                "games": False, "customFeeds": False, "recent": False,
                "communities": False, "resources": False,
            })
            configure(hideLeftSidebar=True)
            wait.until(lambda _: not js("return sidebarVisibility().sidebar"))
            configure(hideLeftSidebar=False, **{
                key: False for key in all_sidebar_sections
            })
            wait.until(lambda _: js("return sidebarVisibility()") == visible_sidebar)
            print("PASS left-sidebar section filters and parent control", flush=True)

            visible_main_page_links = {
                "homepage": True, "popular": True,
                "explore": True, "news": True,
            }
            configure(blockNews=True)
            wait.until(lambda _: js("return mainPageLinkVisibility()") == {
                **visible_main_page_links, "news": False,
            })
            configure(
                blockHomepage=True,
                blockPopular=True,
                blockExplore=True,
                blockNews=False,
            )
            wait.until(lambda _: js("return mainPageLinkVisibility()") == {
                "homepage": False, "popular": False,
                "explore": False, "news": True,
            })
            wait.until(lambda _: not js("return navbarVisibility().logo"))
            configure(
                blockHomepage=False,
                blockPopular=False,
                blockExplore=False,
                blockNews=False,
            )
            wait.until(lambda _: js("return mainPageLinkVisibility()") == visible_main_page_links)
            wait.until(lambda _: js("return navbarVisibility().logo"))
            print("PASS blocked main-page links hidden from navigation", flush=True)

            configure(disableAutoplay=True)
            js("addAutoplayPlayer()")
            wait.until(lambda _: js("return autoplayState()") == {
                "player": [False, False, False],
                "playerManaged": True,
                "videoAutoplay": False,
                "videoManaged": True,
            })
            configure(disableAutoplay=False)
            wait.until(lambda _: js("return autoplayState()") == {
                "player": [True, True, True],
                "playerManaged": False,
                "videoAutoplay": True,
                "videoManaged": False,
            })
            print("PASS video autoplay disabled and restored inside shadow DOM", flush=True)

            configure(blockHomepage=True, blockExplore=True, blockNews=True)
            js("document.documentElement.removeAttribute('data-test-rules-synced'); window.dispatchEvent(new Event('frontfilter-test-sync-rules'))")
            wait.until(lambda _: js("return document.documentElement.getAttribute('data-test-rules-synced')") == '{"success":true}')
            for path, message in [
                ("/", "Reddit Homepage is blocked"),
                ("/explore/", "Explore page is blocked"),
                ("/news/?feed=home", "News page is blocked"),
            ]:
                original_url = f"http://localhost:{server.server_port}{path}"
                driver.get(original_url)
                wait.until(lambda _: (
                    driver.current_url.startswith("moz-extension://")
                    and driver.find_element("id", "block-message").text == message
                ))
                assert driver.current_url.split("#", 1)[1] == original_url
                actual_message = driver.find_element("id", "block-message").text
                assert actual_message == message, (path, driver.current_url, actual_message)
            print("PASS Firefox declarative redirects for Homepage, Explore and News", flush=True)
            response = driver.execute_async_script('''
const done = arguments[0];
chrome.storage.local.set({
  blockHomepage: false,
  blockExplore: false,
  blockNews: false,
  blockSubHome: true,
  blockedSubreddits: [{name: "*italy*", mode: "all"}],
  allowedSubreddits: ["italypersonalfinance"]
}).then(() => chrome.runtime.sendMessage({action: "syncNavigationRules"})).then(done);
''')
            assert response == {"success": True}
            allowed_url = (
                f"http://localhost:{server.server_port}"
                "/r/italypersonalfinance/comments/abc/post"
            )
            driver.get(allowed_url)
            assert driver.current_url == allowed_url
            blocked_url = (
                f"http://localhost:{server.server_port}"
                "/r/italytravel/comments/abc/post"
            )
            driver.get(blocked_url)
            wait.until(lambda _: driver.current_url.startswith("moz-extension://"))
            assert "?target=subreddit&filter=*italy*#" in driver.current_url
            assert driver.current_url.split("#", 1)[1] == blocked_url
            print("PASS Firefox subreddit exception precedence in declarative rules", flush=True)
            response = driver.execute_async_script('''
const done = arguments[0];
chrome.storage.local.set({
  blockSubHome: false,
  allowedSubreddits: [],
  limitInfiniteScroll: true,
  scrollLimit: 3,
  scrollMode: "fixed",
  blockedSubreddits: [{name: "blocked", mode: "all"}]
}).then(() => chrome.runtime.sendMessage({action: "syncNavigationRules"})).then(done);
''')
            assert response == {"success": True}
            driver.get(f"http://127.0.0.1:{server.server_port}/r/test/?after=whitelist")
            wait.until(lambda _: js(
                "return document.documentElement.hasAttribute('data-test-extension-id')"
            ))
            js("resetFeed([post('a'),post('ad','safe',{ad:true}),post('b','blocked'),post('c'),post('d'),post('e'),post('f')])")
            expect(["a", "c", "d"])
            assert js("return document.querySelector('aside shreddit-post').getClientRects().length > 0")
            assert js("return document.querySelector('.frontfilter-feed-controls button').hidden")
            assert js("return !document.querySelector('.frontfilter-feed-next')")
            print("PASS fixed quota, ads, ALL filtering and sidebar isolation", flush=True)

            js("appendRows(document.querySelector('#t3_a'),[post('nested')]); appendRows(document.querySelector('shreddit-feed'),[post('a')])")
            expect(["a", "c", "d"])
            assert js("return document.querySelector('#t3_nested').getClientRects().length > 0")
            print("PASS duplicate cards and nested crosspost content", flush=True)

            configure(blockedSubreddits=[], blockedTitleKeywords=["Trump"])
            js("resetFeed([post('a','safe',{title:'Trump update'}),post('b'),post('c','safe',{body:'A TRUMP preview'}),post('d'),post('e')])")
            expect(["b", "d", "e"])
            configure(blockedTitleKeywords=[])
            print("PASS case-insensitive title/preview filtering and fixed feed quota", flush=True)

            configure(
                limitInfiniteScroll=False,
                blockedSubreddits=[{"name": "*italy*", "mode": "all"}],
                allowedSubreddits=["italypersonalfinance"],
            )
            js("resetFeed([post('allowed','ItalyPersonalFinance'),post('blocked','italytravel')])")
            expect(["allowed"])
            print("PASS Firefox subreddit exception precedence in feeds", flush=True)

            configure(limitInfiniteScroll=True, scrollMode="button", allowedSubreddits=[],
                      blockedSubreddits=[{"name": "blocked", "mode": "all"}])
            js("resetFeed([post('a'),post('b')], [{rows:[post('ad','safe',{ad:true}),post('x','blocked')],next:'2'}, {rows:[post('c'),post('d'),post('e'),post('f'),post('g')],next:'3'}], true)")
            expect(["a", "b", "c"])
            assert js("return loadCalls") == 2
            click()
            expect(["a", "b", "c", "d", "e", "f"])
            assert js("return loadCalls") == 2
            print("PASS filling filtered batches and buffering excess results", flush=True)

            js("window.plans=[{rows:[post('h'),post('i'),post('j'),post('k')],next:'4',delay:500}]")
            click()
            assert js("return shown()") == [f"t3_{i}" for i in "abcdefg"]
            js("document.querySelector('.frontfilter-feed-controls button').click()")
            expect(list("abcdefghi"))
            assert js("return loadCalls") == 3
            assert js("return document.querySelector('.frontfilter-feed-controls').textContent.includes('9 posts shown')")
            print("PASS progressive groups and double-click protection", flush=True)

            # Native calls must be suppressed while at the boundary.
            js("document.querySelector('faceplate-partial').loadContent()")
            assert js("return loadCalls") == 3
            js("window.plans=[{rows:[post('l')]}]")
            configure(limitInfiniteScroll=False)
            expect(list("abcdefghijkl"))
            assert js("return !document.querySelector('.frontfilter-feed-controls')")
            print("PASS native load guard and restoring infinite scroll", flush=True)

            configure(limitInfiniteScroll=True, scrollMode="button", scrollLimit=3)
            js("resetFeed([post('a'),post('b'),post('c')],[{error:true},{rows:[post('d'),post('e')]}],true)")
            expect(list("abc"))
            click()
            wait.until(lambda _: js("return !document.querySelector('.frontfilter-feed-retry').hidden"))
            expect(list("abc"))
            click()
            expect(list("abcde"))
            wait.until(lambda _: js("return document.querySelector('.frontfilter-feed-controls').textContent.includes('End of feed')"))
            print("PASS error retry and explicit partial final group", flush=True)

            # Route changes and replacement feeds cannot inherit a larger quota.
            js("history.pushState({}, '', '/r/second/top/?t=week'); resetFeed([post('m'),post('n'),post('o'),post('p')])")
            expect(list("mno"))
            configure(blockedSubreddits=[{"name": "safe", "mode": "home"}])
            expect(list("mno"))
            print("PASS SPA reset and HOME entries not filtering feed posts", flush=True)

            configure(blockedSubreddits=[], scrollMode="fixed")
            js("resetFeed([post('a'),post('b'),post('c'),post('d'),post('e')])")
            expect(list("abc"))
            js("document.querySelector('#t3_c').setAttribute('is-promoted','')")
            expect(list("abd"))
            configure(limitInfiniteScroll=False)
            expect(list("abde"))
            print("PASS late ad classification and independent filter visibility", flush=True)

            configure(limitInfiniteScroll=True, scrollMode="button")
            js("resetFeed([post('a'),post('b'),post('c')],[{rows:[post('d'),post('e'),post('f')],next:'2',delay:600}],true)")
            expect(list("abc"))
            click()
            js("history.pushState({}, '', '/r/third/'); resetFeed([post('m'),post('n'),post('o'),post('p')])")
            expect(list("mno"))
            # Waiting beyond the old response verifies it cannot mutate the new group.
            js("window.oldResponseSettled = false; setTimeout(() => window.oldResponseSettled = true, 750)")
            wait.until(lambda _: js("return window.oldResponseSettled"))
            expect(list("mno"))
            print("PASS stale responses after navigation", flush=True)

            # Feed updates can reuse the container, after the URL changes first.
            js("history.pushState({}, '', '/r/fourth/')")
            wait.until(lambda _: js("return shown().length === 0"))
            js("const feed=document.querySelector('shreddit-feed'); feed.replaceChildren(); appendRows(feed,[post('u'),post('v'),post('w'),post('z')])")
            expect(list("uvw"))
            print("PASS delayed SPA container reuse", flush=True)

            # A page response that repeats its cursor must stop, not loop forever.
            js("resetFeed([post('a')],[{rows:[post('b')],next:'1'}],true)")
            wait.until(lambda _: js("return document.querySelector('.frontfilter-feed-controls').textContent.includes('did not advance')"))
            assert js("return loadCalls") == 1
            assert js("return shown()") == ["t3_a", "t3_b"]
            print("PASS repeated-cursor protection", flush=True)

            # Other faceplate partials (such as comments) must still work.
            js("window.plans=[{rows:[]}]; const p=document.createElement('faceplate-partial'); document.querySelector('shreddit-feed').append(p); p.loadContent().catch(()=>{})")
            assert js("return loadCalls") == 2
            print("PASS unrelated native loaders remain callable", flush=True)

            # Incomplete cards must not lose their position to fully hydrated ones.
            js("resetFeed([post('a'),post('b'),post('c'),post('d')]); document.querySelector('#t3_a').removeAttribute('subreddit-name'); document.querySelector('#t3_a').removeAttribute('permalink'); document.querySelector('#t3_a a').removeAttribute('href')")
            wait.until(lambda _: js("return shown().length === 0"))
            js("document.querySelector('#t3_a').setAttribute('subreddit-name','safe')")
            expect(list("abc"))
            print("PASS incomplete-card ordering", flush=True)

            # n=100 must not fetch the entire quota before the reader needs it.
            js("const s=document.createElement('style'); s.textContent='main > shreddit-feed > article { min-height: 350px; } button { display: block; line-height: 80px; padding-block: 20px; }'; document.head.append(s)")
            for mode in ["fixed", "button"]:
                configure(scrollLimit=100, scrollMode=mode, blockedSubreddits=[])
                js("window.scrollTo(0,0); const rows=(start,n)=>Array.from({length:n},(_,i)=>post(String(start+i))); resetFeed(rows(0,20),[{rows:rows(20,20),next:'2'},{rows:rows(40,20),next:'3'},{rows:rows(60,20),next:'4'},{rows:rows(80,40),next:'5'}],true)")
                expect([str(i) for i in range(20)])
                driver.execute_async_script("setTimeout(arguments[0], 350)")
                assert js("return loadCalls") == 0
                assert js("return !document.querySelector('.frontfilter-feed-next:not([hidden])')")
                assert js("return Array.from(document.querySelectorAll('.frontfilter-feed-controls button[hidden]')).every(b=>getComputedStyle(b).display==='none')")
                for count in [40, 60, 80, 100]:
                    js("document.querySelector('.frontfilter-feed-controls').scrollIntoView({block:'end'})")
                    expect([str(i) for i in range(count)])
                    driver.execute_async_script("setTimeout(arguments[0], 200)")
                    assert js("return loadCalls") == (count - 20) // 20
                js("document.querySelector('.frontfilter-feed-controls').scrollIntoView({block:'end'})")
                driver.execute_async_script("setTimeout(arguments[0], 250)")
                assert js("return loadCalls") == 4
                if mode == "fixed":
                    assert js("return !document.querySelector('.frontfilter-feed-next')")
                else:
                    assert js("const b=document.querySelector('.frontfilter-feed-next'); const s=getComputedStyle(b); return !b.hidden && s.alignItems==='center' && s.justifyContent==='center' && b.getBoundingClientRect().height===40")
                    if args.screenshot:
                        driver.save_screenshot(str(Path(args.screenshot).with_name("feed-button.png")))
                    click()
                    expect([str(i) for i in range(120)])
                    driver.execute_async_script("setTimeout(arguments[0], 250)")
                    assert js("return loadCalls") == 4
                    js("window.plans=[{rows:Array.from({length:110},(_,i)=>post(String(i+120))),next:'6'}]; document.querySelector('.frontfilter-feed-controls').scrollIntoView({block:'end'})")
                    expect([str(i) for i in range(200)])
                    assert js("return loadCalls") == 5
                print(f"PASS n=100 lazy loading, exact quota and button visibility ({mode})", flush=True)

            # Repeated filtered pages have a small budget even near the boundary.
            configure(scrollLimit=100, scrollMode="fixed", blockedSubreddits=[{"name":"blocked","mode":"all"}])
            js("window.scrollTo(0,0); resetFeed([], Array.from({length:5},(_,i)=>({rows:[post(String(i),'blocked')],next:String(i+2)})), true)")
            wait.until(lambda _: js("return !document.querySelector('.frontfilter-feed-retry').hidden"))
            assert js("return loadCalls") == 3
            assert js("return !document.querySelector('.frontfilter-feed-next')")
            print("PASS bounded loading when all posts are filtered", flush=True)
            configure(scrollLimit=3, scrollMode="button")

            # Verify the actual settings UI as well as the unit-test mock.
            handles = set(driver.window_handles)
            js("window.dispatchEvent(new Event('frontfilter-test-open-popup'))")
            wait.until(lambda _: len(driver.window_handles) == 2)
            driver.switch_to.window(next(iter(set(driver.window_handles) - handles)))
            wait.until(lambda _: driver.find_element("id", "scroll-limit").is_enabled())
            assert driver.find_element("id", "scroll-limit").get_property("value") == "3"
            field = driver.find_element("id", "scroll-limit")
            field.click()
            field.send_keys(Keys.END, Keys.BACKSPACE, "7", Keys.TAB)
            assert field.get_property("value") == "7", field.get_property("value")
            wait.until(lambda _: driver.find_element("id", "save-indicator").text == "Saved")
            driver.switch_to.window(driver.window_handles[0])
            handles = set(driver.window_handles)
            js("window.dispatchEvent(new Event('frontfilter-test-open-popup'))")
            wait.until(lambda _: len(driver.window_handles) == 3)
            driver.switch_to.window(next(iter(set(driver.window_handles) - handles)))
            wait.until(lambda _: driver.find_element("id", "scroll-limit").get_property("value") == "7")
            driver.set_window_size(560, 1100)
            if args.screenshot:
                driver.save_screenshot(args.screenshot)
            print("PASS real popup persistence", flush=True)
            verify_settings_tabs(driver, wait, args.screenshot)
    finally:
        driver.quit()
        server.shutdown()


if __name__ == "__main__":
    main()
