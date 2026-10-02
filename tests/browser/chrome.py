"""Chrome tests on the local fixture pages. Requires Selenium and Chrome for Testing.

Run: python3 tests/browser/chrome.py --chrome PATH [--driver PATH] [unittest options]
Chrome 137 and later ignore --load-extension, so use Chromium or Chrome for
Testing. Uses a temporary unpacked extension and a local HTTP fixture; never
visits Reddit.
"""
import argparse
from pathlib import Path
import sys
import tempfile
import unittest

from selenium.webdriver.support.ui import WebDriverWait

import harness
from harness import ExtensionTestCase
from page_tests import PageTests

OPTIONS = argparse.Namespace(chrome=None, driver=None)


def setUpModule():
    server = harness.FixtureServer()
    temp = tempfile.TemporaryDirectory(prefix="frontfilter-chrome-")
    extension = harness.build_extension(Path(temp.name) / "extension", "chrome", server.port)
    try:
        driver = harness.start_chrome(OPTIONS.chrome, OPTIONS.driver, extension)
    except Exception:
        server.close()
        temp.cleanup()
        raise
    try:
        # Unpacked extensions get an ID derived from their folder.
        driver.get(server.url())
        WebDriverWait(driver, harness.TIMEOUT).until(
            lambda _: driver.find_element("tag name", "html").get_attribute("data-test-extension-id")
        )
        extension_id = driver.find_element("tag name", "html").get_attribute("data-test-extension-id")
    except Exception:
        driver.quit()
        server.close()
        temp.cleanup()
        raise
    ExtensionTestCase.session = harness.Session(
        driver, f"chrome-extension://{extension_id}", server, temp=temp,
    )


def tearDownModule():
    ExtensionTestCase.session.quit()


class ChromePageTests(PageTests, ExtensionTestCase):
    pass


class ChromeSettingsTests(ExtensionTestCase):
    def tearDown(self):
        self.driver.execute_cdp_cmd("Emulation.setEmulatedMedia", {"features": []})

    def test_settings_controls_theme_and_block_page(self):
        driver = self.driver
        find = lambda element_id: driver.find_element("id", element_id)
        driver.execute_cdp_cmd("Emulation.setEmulatedMedia", {
            "features": [{"name": "prefers-color-scheme", "value": "dark"}],
        })
        self.session.open_settings_page()
        explore_toggle = find("block-explore")
        news_toggle = find("block-news")
        self.assertTrue(explore_toggle.is_enabled() and news_toggle.is_enabled())

        self.check_switch_groups()
        suggested_communities = find("hide-suggested-communities")
        self.assertFalse(suggested_communities.is_selected())
        suggested_communities.click()
        self.wait_until(lambda: suggested_communities.is_selected())

        # The system theme follows the emulated dark scheme until set to light.
        theme = find("color-theme")
        self.assertEqual(theme.get_property("value"), "system")
        self.assertEqual(
            self.js("return getComputedStyle(document.querySelector('.container')).backgroundColor"),
            "rgb(26, 26, 27)",
        )
        self.js(
            "arguments[0].value = 'light'; arguments[0].dispatchEvent(new Event('change', {bubbles: true}))",
            theme,
        )
        self.wait_until(lambda: driver.find_element("tag name", "html").get_attribute("data-theme") == "light")
        self.assertEqual(self.js("return localStorage.getItem('frontfilter-theme')"), "light")

        explore_toggle.click()
        news_toggle.click()
        find("block-homepage").click()
        self.wait_until(lambda: find("save-indicator").text == "Saved")
        response = driver.execute_async_script(
            "chrome.runtime.sendMessage({action: 'syncNavigationRules'}).then(arguments[0])"
        )
        self.assertEqual(response, {"success": True})
        block_page = self.session.extension_url("blocked/index.html")
        for path, message in [
            ("/", "Reddit Homepage is blocked"),
            ("/explore/", "Explore page is blocked"),
            ("/news/?feed=home", "News page is blocked"),
        ]:
            with self.subTest(path=path):
                original_url = self.server.url(path, "localhost")
                driver.get(original_url)
                self.wait_until(lambda: (
                    driver.current_url.startswith(block_page)
                    and find("block-message").text == message
                ))
                self.assertEqual(driver.current_url.split("#", 1)[1], original_url)
        # The block page uses the saved light theme despite the dark scheme.
        self.wait_until(lambda: driver.find_element("tag name", "html").get_attribute("data-theme") == "light")
        self.assertEqual(self.js("return localStorage.getItem('frontfilter-theme')"), "light")
        self.assertEqual(self.js("return getComputedStyle(document.body).backgroundColor"), "rgb(236, 239, 241)")

        self.session.open_settings_page()
        self.wait_until(lambda: find("block-homepage").is_selected())
        self.assertTrue(find("block-explore").is_selected())
        self.assertTrue(find("block-news").is_selected())
        self.assertTrue(find("hide-suggested-communities").is_selected())
        self.assertEqual(find("color-theme").get_property("value"), "light")
        self.assertEqual(driver.find_element("tag name", "html").get_attribute("data-theme"), "light")
        self.assertEqual(self.js("return localStorage.getItem('frontfilter-theme')"), "light")


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--chrome", required=True, help="Path to Chromium or Chrome for Testing")
    parser.add_argument("--driver", help="Path to a matching chromedriver")
    _, unittest_args = parser.parse_known_args(namespace=OPTIONS)
    unittest.main(argv=[sys.argv[0], *unittest_args])


if __name__ == "__main__":
    main()
