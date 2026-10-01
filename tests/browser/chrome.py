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
from chromium_tests import ChromiumSettingsTests
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


class ChromeSettingsTests(ChromiumSettingsTests, ExtensionTestCase):
    pass


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--chrome", required=True, help="Path to Chromium or Chrome for Testing")
    parser.add_argument("--driver", help="Path to a matching chromedriver")
    _, unittest_args = parser.parse_known_args(namespace=OPTIONS)
    unittest.main(argv=[sys.argv[0], *unittest_args])


if __name__ == "__main__":
    main()
