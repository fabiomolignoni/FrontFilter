"""Edge tests on the local fixture pages. Requires Selenium and Microsoft Edge.

Run: python3 tests/browser/edge.py [--edge PATH] [--driver PATH] [unittest options]
Edge ignores --load-extension, so the tests install the extension over
WebDriver BiDi. Uses a temporary unpacked extension and a local HTTP fixture;
never visits Reddit.
"""
import argparse
from pathlib import Path
import sys
import tempfile
import unittest

import harness
from chromium_tests import ChromiumSettingsTests
from harness import ExtensionTestCase
from page_tests import PageTests

OPTIONS = argparse.Namespace(edge=None, driver=None)


def setUpModule():
    server = harness.FixtureServer()
    temp = tempfile.TemporaryDirectory(prefix="frontfilter-edge-")
    extension = harness.build_extension(Path(temp.name) / "extension", "edge", server.port)
    try:
        driver = harness.start_edge(OPTIONS.edge, OPTIONS.driver)
    except Exception:
        server.close()
        temp.cleanup()
        raise
    try:
        extension_id = driver.webextension.install(path=str(extension))["extension"]
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


class EdgePageTests(PageTests, ExtensionTestCase):
    pass


class EdgeSettingsTests(ChromiumSettingsTests, ExtensionTestCase):
    pass


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--edge", help="Path to Microsoft Edge, if not installed in the default location")
    parser.add_argument("--driver", help="Path to a matching msedgedriver")
    _, unittest_args = parser.parse_known_args(namespace=OPTIONS)
    unittest.main(argv=[sys.argv[0], *unittest_args])


if __name__ == "__main__":
    main()
