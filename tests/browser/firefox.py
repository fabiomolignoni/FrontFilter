"""Firefox tests on the local fixture pages. Requires Selenium and Firefox.

Run: python3 tests/browser/firefox.py [--firefox PATH] [--screenshots DIR] [unittest options]
Uses a temporary profile and add-on and a local HTTP fixture; never visits Reddit.
"""
import argparse
from pathlib import Path
import sys
import tempfile
import unittest

from selenium.webdriver.common.keys import Keys

import harness
from harness import ExtensionTestCase
from page_tests import PageTests

OPTIONS = argparse.Namespace(firefox=None, screenshots=None)


def setUpModule():
    server = harness.FixtureServer()
    driver = harness.start_firefox(OPTIONS.firefox)
    # Firefox reads a temporary add-on from its file for the whole session.
    temp = tempfile.TemporaryDirectory(prefix="frontfilter-firefox-")
    try:
        addon = harness.build_extension(Path(temp.name) / "frontfilter-test.xpi", "firefox", server.port)
        addon_id = driver.install_addon(str(addon), temporary=True)
    except Exception:
        driver.quit()
        server.close()
        temp.cleanup()
        raise
    ExtensionTestCase.session = harness.Session(
        driver, f"moz-extension://{harness.FIREFOX_UUID}", server, OPTIONS.screenshots, temp, addon_id,
    )


def tearDownModule():
    ExtensionTestCase.session.quit()


class FirefoxPageTests(PageTests, ExtensionTestCase):
    pass


class FirefoxSettingsTests(ExtensionTestCase):
    def selected(self, name):
        tab = self.driver.find_element("css selector", "[role=tab][aria-selected=true]")
        self.assertEqual(tab.get_dom_attribute("id"), f"tab-{name}")
        panels = [
            panel.get_dom_attribute("id")
            for panel in self.driver.find_elements("css selector", "[role=tabpanel]")
            if panel.rect["height"] > 0
        ]
        self.assertEqual(panels, [f"panel-{name}"])

    def set_theme(self, theme):
        self.js(
            "arguments[0].value = arguments[1];"
            " arguments[0].dispatchEvent(new Event('change', {bubbles: true}))",
            self.driver.find_element("id", "color-theme"), theme,
        )
        self.wait_until(lambda: self.driver.find_element("tag name", "html").get_attribute("data-theme") == theme)

    def background(self):
        return self.js("return getComputedStyle(document.querySelector('.container')).backgroundColor")

    def test_native_toolbar_popup_opens_and_reopens_at_full_size(self):
        """Firefox's initial popup sizing, which a normal tab cannot test."""
        driver = self.driver
        popup_selector = 'panel[panelopen="true"] browser.webextension-popup-browser'
        driver.set_context("chrome")
        try:
            widget_id = self.session.addon_id.lower().replace("{", "_").replace("}", "_") + "-browser-action"
            driver.execute_script(
                "CustomizableUI.addWidgetToArea(arguments[0], CustomizableUI.AREA_NAVBAR)", widget_id,
            )
            button = driver.find_element("css selector", f"#{widget_id} .unified-extensions-item-action-button")
            for attempt in range(2):
                button.click()
                self.wait_until(lambda: driver.execute_script("""
                    const popup = document.querySelector(arguments[0]);
                    if (!popup || popup.closest('panel').state !== 'open') return false;
                    const rect = popup.getBoundingClientRect();
                    return rect.width === 460 && rect.height === 600;
                """, popup_selector))
                if attempt == 0:
                    self.save_screenshot("toolbar-popup.png")
                driver.execute_script(
                    "document.querySelector(arguments[0]).closest('panel').hidePopup()", popup_selector,
                )
                self.wait_until(lambda: not driver.execute_script(
                    "return !!document.querySelector(arguments[0])", popup_selector,
                ))
        finally:
            driver.set_context("content")

    def test_settings_page_opened_from_a_page_saves_edits(self):
        self.configure(limitInfiniteScroll=True, scrollLimit=3, scrollMode="button")
        driver = self.driver
        fixture_window = driver.current_window_handle

        def open_settings():
            handles = set(driver.window_handles)
            self.js("window.dispatchEvent(new Event('frontfilter-test-open-popup'))")
            self.wait_until(lambda: len(driver.window_handles) == len(handles) + 1)
            driver.switch_to.window(next(iter(set(driver.window_handles) - handles)))
            # The new tab may still be loading.
            self.wait_until(lambda: any(
                field.is_enabled() for field in driver.find_elements("id", "scroll-limit")
            ))
            return driver.find_element("id", "scroll-limit")

        field = open_settings()
        self.assertEqual(field.get_property("value"), "3")
        field.click()
        field.send_keys(Keys.END, Keys.BACKSPACE, "7", Keys.TAB)
        self.assertEqual(field.get_property("value"), "7")
        self.wait_until(lambda: driver.find_element("id", "save-indicator").text == "Saved")
        driver.switch_to.window(fixture_window)
        field = open_settings()
        self.wait_until(lambda: field.get_property("value") == "7")
        driver.set_window_size(560, 1100)
        self.save_screenshot("settings.png")

    def test_settings_tabs_themes_drafts_and_persistence(self):
        driver = self.driver
        driver.set_window_size(560, 1100)
        self.session.open_settings_page()
        find = lambda element_id: driver.find_element("id", element_id)

        self.selected("controls")
        self.assertTrue(find("block-explore").is_enabled())
        self.assertTrue(find("block-news").is_enabled())
        self.check_switch_groups()
        suggested_communities = find("hide-suggested-communities")
        self.assertFalse(suggested_communities.is_selected())
        suggested_communities.click()
        self.wait_until(lambda: suggested_communities.is_selected())

        find("tab-controls").send_keys(Keys.ARROW_RIGHT)
        self.selected("filters")
        self.assertEqual(driver.switch_to.active_element.get_dom_attribute("id"), "tab-filters")
        find("add-subreddit").click()
        draft = driver.find_element("css selector", ".blocked-item input")
        draft.send_keys("firefox")
        find("add-allowed-subreddit").click()
        allowed_draft = driver.find_element("css selector", ".allowed-item input")
        allowed_draft.send_keys("ItalyPersonalFinance")
        find("add-title-keyword").click()
        keyword_draft = driver.find_element("css selector", ".keyword-item input")
        keyword_draft.send_keys("Trump")

        find("tab-settings").click()
        self.selected("settings")
        self.assertEqual(find("color-theme").get_property("value"), "system")
        self.set_theme("dark")
        self.assertEqual(self.background(), "rgb(26, 26, 27)")
        self.set_theme("light")
        self.assertEqual(self.js("return localStorage.getItem('frontfilter-theme')"), "light")
        self.assertEqual(self.background(), "rgb(255, 255, 255)")

        find("tab-settings").send_keys(Keys.ARROW_RIGHT)
        self.selected("controls")
        find("tab-controls").send_keys(Keys.END)
        self.selected("settings")
        find("tab-settings").send_keys(Keys.HOME, Keys.ARROW_RIGHT)
        self.selected("filters")
        # Drafts survive tab changes, and subreddit names are normalized.
        self.assertEqual(draft.get_property("value"), "firefox")
        self.assertEqual(allowed_draft.get_property("value"), "italypersonalfinance")
        self.assertEqual(keyword_draft.get_property("value"), "Trump")
        self.wait_until(lambda: find("save-indicator").get_property("textContent") == "Saved")

        driver.refresh()
        self.wait_until(lambda: find("add-subreddit").is_enabled())
        self.assertTrue(find("hide-suggested-communities").is_selected())
        self.assertEqual(driver.find_element("tag name", "html").get_attribute("data-theme"), "light")
        self.assertEqual(self.js("return localStorage.getItem('frontfilter-theme')"), "light")
        self.assertEqual(find("color-theme").get_property("value"), "light")
        find("tab-filters").click()
        values = lambda selector: [
            field.get_property("value") for field in driver.find_elements("css selector", selector)
        ]
        self.assertIn("firefox", values(".blocked-item input"))
        self.assertIn("italypersonalfinance", values(".allowed-item input"))
        self.assertIn("Trump", values(".keyword-item input"))

    def test_settings_page_keeps_rules_added_elsewhere(self):
        # A Block button adds a rule while the settings page is open in
        # another window; a rule added there afterwards keeps it.
        driver = self.driver
        fixture_window = driver.current_window_handle
        self.configure(showBlockSubredditButton=True)
        self.js("resetFeed([post('one', 'alpha', {credit: true})])")
        driver.switch_to.new_window("window")
        self.session.open_settings_page()
        settings_window = driver.current_window_handle
        driver.find_element("id", "tab-filters").click()
        values = lambda: [
            field.get_property("value") for field in driver.find_elements("css selector", ".blocked-item input")
        ]
        self.assertEqual(values(), [])

        driver.switch_to.window(fixture_window)
        self.wait_until(lambda: self.js("return !!document.querySelector('.frontfilter-block-subreddit')"))
        self.js("document.querySelector('.frontfilter-block-subreddit').click()")
        driver.switch_to.window(settings_window)
        self.wait_until(lambda: values() == ["alpha"])

        driver.find_element("id", "add-subreddit").click()
        driver.switch_to.active_element.send_keys("beta", Keys.TAB)
        self.wait_until(lambda: driver.find_element("id", "save-indicator").text == "Saved")
        stored = driver.execute_async_script(
            "chrome.storage.local.get('blockedSubreddits')"
            ".then((stored) => arguments[0](stored.blockedSubreddits))"
        )
        self.assertCountEqual(stored, [{"name": "alpha", "mode": "all"}, {"name": "beta", "mode": "all"}])

    def test_long_lists_independent_scroll_and_narrow_layout(self):
        driver = self.driver
        self.session.store(blockedSubreddits=[
            {"name": f"community{index}", "mode": "home"} for index in range(60)
        ])
        self.session.open_settings_page()
        self.wait_until(lambda: driver.find_element("id", "blocked-count").get_property("textContent") == "60 rules")
        for width in (560, 320):
            driver.set_window_size(width, 750)
            for name in ("controls", "filters", "settings"):
                with self.subTest(width=width, tab=name):
                    driver.find_element("id", f"tab-{name}").click()
                    self.selected(name)
                    root = driver.find_element("tag name", "html")
                    panel = driver.find_element("id", f"panel-{name}")
                    self.assertLessEqual(root.get_property("scrollWidth"), root.get_property("clientWidth"))
                    self.assertLessEqual(panel.get_property("scrollWidth"), panel.get_property("clientWidth"))
                    top = driver.find_element("css selector", "[role=tablist]").rect["y"]
                    if name == "filters":
                        driver.find_elements("css selector", ".blocked-item input")[-1].click()
                    elif name == "controls":
                        driver.find_element("id", "scroll-limit").click()
                    self.assertEqual(driver.find_element("css selector", "[role=tablist]").rect["y"], top)
            driver.find_element("id", "tab-filters").click()
            self.assertGreater(driver.find_element("id", "panel-filters").get_property("scrollTop"), 0)

    def test_popup_dimensions_stay_stable_across_tabs(self):
        driver = self.driver
        driver.set_window_size(560, 800)
        self.session.open_settings_page(query="")
        for name in ("controls", "filters", "settings"):
            with self.subTest(tab=name):
                driver.find_element("id", f"tab-{name}").click()
                self.assertEqual(driver.find_element("css selector", ".container").rect["height"], 600)
                self.assertEqual(driver.find_element("tag name", "body").rect["width"], 460)
                self.save_screenshot(f"popup-{name}.png")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--firefox", help="Path to the Firefox binary")
    parser.add_argument("--screenshots", help="Directory for screenshots of the settings pages")
    _, unittest_args = parser.parse_known_args(namespace=OPTIONS)
    unittest.main(argv=[sys.argv[0], *unittest_args])


if __name__ == "__main__":
    main()
