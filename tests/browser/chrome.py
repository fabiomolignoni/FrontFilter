"""Optional Chrome integration smoke test. Requires Selenium and Chrome.

Run: python3 tests/browser/chrome.py --chrome /path/to/chrome
The test uses a temporary unpacked extension and a local HTTP fixture. It never
visits Reddit.
"""
import argparse
import json
from pathlib import Path
import shutil
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service
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


def prepare_extension(destination, port):
    shutil.copytree(SOURCE, destination, dirs_exist_ok=True)

    manifest = json.loads((SOURCE / "manifest.json").read_text())
    fixture_origin = f"http://127.0.0.1:{port}/*"
    dnr_origin = f"http://localhost:{port}/*"
    for content_script in manifest["content_scripts"]:
        content_script["matches"] = [fixture_origin]
    isolated_script = next(
        script for script in manifest["content_scripts"]
        if script.get("world", "ISOLATED") == "ISOLATED"
    )
    isolated_script["js"].insert(0, "fixture-bridge.js")
    manifest["host_permissions"].extend([fixture_origin, dnr_origin])
    manifest["web_accessible_resources"][0]["matches"].extend([fixture_origin, dnr_origin])
    (destination / "manifest.json").write_text(json.dumps(manifest))
    rules_path = destination / "background/navigation-rules.js"
    rules_path.write_text(
        rules_path.read_text().replace(r"reddit\\.com", r"localhost"),
    )
    (destination / "fixture-bridge.js").write_text('''
document.documentElement.dataset.testExtensionId = chrome.runtime.id;
window.addEventListener("frontfilter-test-settings", async (event) => {
  await chrome.storage.local.set(JSON.parse(event.detail));
  document.documentElement.dataset.testSettingsApplied = event.detail;
});
''')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--chrome", required=True, help="Path to Chrome or Chromium")
    parser.add_argument("--driver", help="Optional path to chromedriver")
    args = parser.parse_args()

    server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="frontfilter-chrome-") as temp:
            extension = Path(temp) / "extension"
            extension.mkdir()
            prepare_extension(extension, server.server_port)

            options = Options()
            options.binary_location = args.chrome
            options.add_argument("--headless=new")
            options.add_argument("--no-sandbox")
            options.add_argument(f"--load-extension={extension}")
            service = Service(executable_path=args.driver) if args.driver else Service()
            driver = webdriver.Chrome(options=options, service=service)
            wait = WebDriverWait(driver, 15)
            try:
                driver.get(f"http://127.0.0.1:{server.server_port}/r/test/")
                wait.until(lambda _: driver.find_element("tag name", "html").get_attribute("data-test-extension-id"))
                extension_id = driver.find_element("tag name", "html").get_attribute("data-test-extension-id")

                def configure(settings):
                    driver.execute_script(
                        "document.documentElement.removeAttribute('data-test-settings-applied'); configure(arguments[0]);",
                        settings,
                    )
                    wait.until(lambda _: driver.find_element(
                        "tag name", "html"
                    ).get_attribute("data-test-settings-applied"))

                configure({"disableAutoplay": True})
                driver.execute_script("addAutoplayPlayer()")
                wait.until(lambda _: driver.execute_script("return autoplayState()") == {
                    "player": [False, False, False],
                    "playerManaged": True,
                    "videoAutoplay": False,
                    "videoManaged": True,
                })
                configure({"disableAutoplay": False})
                wait.until(lambda _: driver.execute_script("return autoplayState()") == {
                    "player": [True, True, True],
                    "playerManaged": False,
                    "videoAutoplay": True,
                    "videoManaged": False,
                })
                print("PASS Chrome video autoplay toggle", flush=True)

                driver.execute_script("resetComments()")
                configure({"hideComments": False, "hideCommentReplies": True})
                wait.until(lambda _: driver.execute_script("return visibleComments()") == [
                    "comment-top-a", "comment-top-b",
                ])
                configure({"hideComments": True, "hideCommentReplies": True})
                wait.until(lambda _: driver.execute_script("return visibleComments()") == [])
                configure({"hideComments": False, "hideCommentReplies": False})
                wait.until(lambda _: driver.execute_script("return visibleComments()") == [
                    "comment-top-a", "comment-reply", "comment-deep-reply", "comment-top-b",
                ])
                print("PASS Chrome top-level-only comment visibility", flush=True)

                configure({"hideSuggestedCommunities": False})
                wait.until(lambda _: driver.execute_script(
                    "return suggestedCommunitiesVisible()"
                ))
                configure({"hideSuggestedCommunities": True})
                wait.until(lambda _: not driver.execute_script(
                    "return suggestedCommunitiesVisible()"
                ))
                configure({"hideSuggestedCommunities": False})
                wait.until(lambda _: driver.execute_script(
                    "return suggestedCommunitiesVisible()"
                ))
                print("PASS Chrome suggested communities visibility", flush=True)

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
                configure({"hideNavbar": False, **all_navbar_sections})
                wait.until(lambda _: driver.execute_script("return navbarVisibility()") == {
                    **visible_navbar,
                    "menu": False, "search": False, "chat": False,
                    "notifications": False, "profile": False,
                    "campaign": False, "translate": False,
                    "advertise": False, "create": False,
                    "signup": False, "login": False,
                })
                configure({"hideNavbar": True})
                wait.until(lambda _: not driver.execute_script("return navbarVisibility().navbar"))
                configure({
                    "hideNavbar": False,
                    **{key: False for key in all_navbar_sections},
                })
                wait.until(lambda _: driver.execute_script("return navbarVisibility()") == visible_navbar)
                configure({"hideNavbarMenu": True})
                wait.until(lambda _: driver.execute_script("return navbarVisibility()") == {
                    **visible_navbar,
                    "menu": False,
                })
                configure({"hideNavbarMenu": False})
                wait.until(lambda _: driver.execute_script("return navbarVisibility()") == visible_navbar)
                configure({"hideNavbarOthers": True})
                wait.until(lambda _: driver.execute_script("return navbarVisibility()") == {
                    **visible_navbar,
                    "campaign": False, "translate": False,
                    "advertise": False, "create": False,
                    "signup": False, "login": False,
                })
                configure({"hideNavbarOthers": False})
                print("PASS Chrome navbar section filters, logo exception and parent control", flush=True)

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
                configure({"hideLeftSidebar": False, **all_sidebar_sections})
                wait.until(lambda _: driver.execute_script("return sidebarVisibility()") == {
                    **visible_sidebar,
                    "games": False, "customFeeds": False, "recent": False,
                    "communities": False, "resources": False,
                })
                configure({"hideLeftSidebar": True})
                wait.until(lambda _: not driver.execute_script("return sidebarVisibility().sidebar"))
                configure({
                    "hideLeftSidebar": False,
                    **{key: False for key in all_sidebar_sections},
                })
                wait.until(lambda _: driver.execute_script("return sidebarVisibility()") == visible_sidebar)
                print("PASS Chrome left-sidebar section filters and parent control", flush=True)

                visible_main_page_links = {
                    "homepage": True, "popular": True,
                    "explore": True, "news": True,
                }
                configure({"blockNews": True})
                wait.until(lambda _: driver.execute_script("return mainPageLinkVisibility()") == {
                    **visible_main_page_links, "news": False,
                })
                configure({
                    "blockHomepage": True,
                    "blockPopular": True,
                    "blockExplore": True,
                    "blockNews": False,
                })
                wait.until(lambda _: driver.execute_script("return mainPageLinkVisibility()") == {
                    "homepage": False, "popular": False,
                    "explore": False, "news": True,
                })
                wait.until(lambda _: not driver.execute_script("return navbarVisibility().logo"))
                configure({
                    "blockHomepage": False,
                    "blockPopular": False,
                    "blockExplore": False,
                    "blockNews": False,
                })
                wait.until(lambda _: driver.execute_script("return mainPageLinkVisibility()") == visible_main_page_links)
                wait.until(lambda _: driver.execute_script("return navbarVisibility().logo"))
                print("PASS Chrome blocked main-page links hidden from navigation", flush=True)

                configure({
                    "limitInfiniteScroll": True,
                    "scrollLimit": 10,
                    "scrollMode": "fixed",
                })
                driver.execute_script('''
const rows = (start, count) => Array.from({length: count}, (_, index) => post(String(start + index)));
resetFeed(rows(0, 2), [{rows: rows(2, 10)}], true);
''')
                wait.until(lambda _: driver.execute_script("return shown().length") == 10)
                assert driver.execute_script("return loadCalls") == 1
                print("PASS Chrome page-world continuation loading", flush=True)

                configure({
                    "limitInfiniteScroll": True,
                    "scrollLimit": 3,
                    "scrollMode": "fixed",
                })
                driver.execute_script('''
resetFeed([post("a"), post("b"), post("c")], [{rows: [post("d"), post("e")]}], true);
document.querySelector("faceplate-partial").loadContent();
''')
                driver.execute_async_script("setTimeout(arguments[0], 200)")
                assert driver.execute_script("return loadCalls") == 0
                configure({"limitInfiniteScroll": False})
                wait.until(lambda _: driver.execute_script("return shown().length") == 5)
                assert driver.execute_script("return loadCalls") == 1
                print("PASS Chrome native-load guard and release", flush=True)

                configure({
                    "limitInfiniteScroll": True,
                    "scrollLimit": 3,
                    "scrollMode": "fixed",
                    "blockedSubreddits": [{"name": "blocked", "mode": "all"}],
                    "blockedTitleKeywords": ["TRUMP"],
                })
                driver.execute_script("resetFeed([post('a','safe',{body:'Trump preview'}),post('b','blocked'),post('c'),post('d'),post('e')])")
                wait.until(lambda _: driver.execute_script("return shown()") == ["t3_c", "t3_d", "t3_e"])
                print("PASS Chrome community/post-text filtering and fixed feed quota", flush=True)

                configure({
                    "limitInfiniteScroll": False,
                    "blockedSubreddits": [{"name": "*italy*", "mode": "all"}],
                    "allowedSubreddits": ["italypersonalfinance"],
                    "blockedTitleKeywords": [],
                })
                driver.execute_script(
                    "resetFeed([post('allowed','ItalyPersonalFinance'),post('blocked','italytravel')])"
                )
                wait.until(lambda _: driver.execute_script("return shown()") == ["t3_allowed"])
                print("PASS Chrome subreddit exception precedence in feeds", flush=True)

                driver.execute_cdp_cmd("Emulation.setEmulatedMedia", {
                    "features": [{"name": "prefers-color-scheme", "value": "dark"}],
                })
                driver.get(f"chrome-extension://{extension_id}/popup/index.html?standalone=true")
                wait.until(lambda _: driver.find_element("id", "block-homepage").is_enabled())
                explore_toggle = driver.find_element("id", "block-explore")
                news_toggle = driver.find_element("id", "block-news")
                assert explore_toggle.is_enabled() and news_toggle.is_enabled()
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
                suggested_communities = driver.find_element(
                    "id", "hide-suggested-communities"
                )
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
                theme = driver.find_element("id", "color-theme")
                assert theme.get_property("value") == "system"
                assert driver.execute_script("return getComputedStyle(document.querySelector('.container')).backgroundColor") == "rgb(26, 26, 27)"
                driver.execute_script("arguments[0].value = 'light'; arguments[0].dispatchEvent(new Event('change', {bubbles:true}))", theme)
                wait.until(lambda _: driver.find_element("tag name", "html").get_attribute("data-theme") == "light")
                assert driver.execute_script("return localStorage.getItem('frontfilter-theme')") == "light"
                explore_toggle.click()
                news_toggle.click()
                driver.find_element("id", "block-homepage").click()
                wait.until(lambda _: driver.find_element("id", "save-indicator").text == "Saved")
                response = driver.execute_async_script('''
const done = arguments[0];
chrome.runtime.sendMessage({action: "syncNavigationRules"}).then(done);
''')
                assert response == {"success": True}
                for path, message in [
                    ("/", "Reddit Homepage is blocked"),
                    ("/explore/", "Explore page is blocked"),
                    ("/news/?feed=home", "News page is blocked"),
                ]:
                    original_url = f"http://localhost:{server.server_port}{path}"
                    driver.get(original_url)
                    wait.until(lambda _: (
                        driver.current_url.startswith(f"chrome-extension://{extension_id}/blocked/index.html")
                        and driver.find_element("id", "block-message").text == message
                    ))
                    assert driver.current_url.split("#", 1)[1] == original_url
                    actual_message = driver.find_element("id", "block-message").text
                    assert actual_message == message, (path, driver.current_url, actual_message)
                wait.until(lambda _: driver.find_element("tag name", "html").get_attribute("data-theme") == "light")
                assert driver.execute_script("return localStorage.getItem('frontfilter-theme')") == "light"
                assert driver.execute_script("return getComputedStyle(document.body).backgroundColor") == "rgb(236, 239, 241)"
                print("PASS Chrome declarative redirects for Homepage, Explore and News", flush=True)

                driver.get(f"chrome-extension://{extension_id}/popup/index.html?standalone=true")
                wait.until(lambda _: driver.find_element("id", "block-homepage").is_enabled())
                response = driver.execute_async_script('''
const done = arguments[0];
chrome.storage.local.set({
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
                wait.until(lambda _: driver.current_url.startswith(
                    f"chrome-extension://{extension_id}/blocked/index.html"
                ))
                assert "?target=subreddit&filter=*italy*#" in driver.current_url
                assert driver.current_url.split("#", 1)[1] == blocked_url
                print("PASS Chrome subreddit exception precedence in declarative rules", flush=True)

                driver.get(f"chrome-extension://{extension_id}/popup/index.html?standalone=true")
                wait.until(lambda _: driver.find_element("id", "block-homepage").is_selected())
                assert driver.find_element("id", "block-explore").is_selected()
                assert driver.find_element("id", "block-news").is_selected()
                assert driver.find_element(
                    "id", "hide-suggested-communities"
                ).is_selected()
                assert driver.find_element("id", "color-theme").get_property("value") == "light"
                assert driver.find_element("tag name", "html").get_attribute("data-theme") == "light"
                assert driver.execute_script("return localStorage.getItem('frontfilter-theme')") == "light"
                assert not driver.find_elements("id", "block-nsfw")
                print("PASS Chrome popup and color-theme persistence", flush=True)
            finally:
                driver.quit()
    finally:
        server.shutdown()


if __name__ == "__main__":
    main()
