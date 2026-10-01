"""Shared setup for the browser tests.

Builds test copies of the extension, serves the local fixture pages and runs
WebDriver sessions in Firefox and Chrome. The fixture tests in firefox.py and
chrome.py never visit Reddit; tests/reddit/canary.py reuses the Firefox
session to check the unmodified extension on reddit.com.
"""
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import threading
import unittest
from urllib.parse import parse_qs, urlparse
from zipfile import ZipFile

from selenium import webdriver
from selenium.webdriver.chrome.options import Options as ChromeOptions
from selenium.webdriver.chrome.service import Service as ChromeService
from selenium.webdriver.firefox.options import Options as FirefoxOptions
from selenium.webdriver.firefox.service import Service as FirefoxService
from selenium.webdriver.support.ui import WebDriverWait

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
from package import SOURCE, browser_manifest, source_files  # noqa: E402

FIXTURES = ROOT / "tests" / "fixtures"
WINDOW_SIZE = (1366, 900)
TIMEOUT = 15
# A fixed internal UUID makes the add-on's moz-extension:// pages addressable.
FIREFOX_UUID = "5f1e3c9a-0b7d-4e2a-9c61-f0f0e1a2b3c4"

# Lets fixture pages change settings and open the settings page. It is only
# added to the fixture builds.
FIXTURE_BRIDGE = """
document.documentElement.setAttribute("data-test-extension-id", chrome.runtime.id);
window.addEventListener("frontfilter-test-settings", async (event) => {
  await chrome.storage.local.set(JSON.parse(event.detail));
  document.documentElement.setAttribute("data-test-settings-applied", event.detail);
});
window.addEventListener("frontfilter-test-open-popup", () => chrome.runtime.sendMessage({ action: "openSettings" }));
"""

# Restores default settings, navigation rules and the cached theme. Runs on
# an extension page once it has loaded its settings.
RESET_SCRIPT = """
const done = arguments[0];
localStorage.clear();
chrome.storage.local.clear()
  .then(() => chrome.runtime.sendMessage({ action: "syncNavigationRules" }))
  .then(done, (error) => done({ success: false, error: error.message }));
"""

STORE_SCRIPT = """
const [settings, done] = arguments;
chrome.storage.local.set(settings)
  .then(() => chrome.runtime.sendMessage({ action: "syncNavigationRules" }))
  .then(done, (error) => done({ success: false, error: error.message }));
"""


FIREFOX_ADDON_ID = browser_manifest("firefox")["browser_specific_settings"]["gecko"]["id"]


def build_extension(destination, browser, fixture_port=None):
    """Writes a test copy of the extension: a Firefox .xpi or a Chrome folder.

    With a fixture port, content scripts and navigation rules target the local
    fixture server instead of reddit.com, and the fixture bridge is added.
    Without one, the copy is the extension as published.
    """
    files = {path.relative_to(SOURCE).as_posix(): path.read_bytes() for path in source_files()}
    manifest = browser_manifest(browser)

    if fixture_port is not None:
        # Firefox match patterns cannot name a port.
        port = "" if browser == "firefox" else f":{fixture_port}"
        fixture_origin = f"http://127.0.0.1{port}/*"
        # Navigation rules redirect localhost, which stands in for reddit.com.
        redirect_origin = f"http://localhost{port}/*"
        for content_script in manifest["content_scripts"]:
            content_script["matches"] = [fixture_origin]
        isolated_script = next(
            script for script in manifest["content_scripts"]
            if script.get("world", "ISOLATED") == "ISOLATED"
        )
        isolated_script["js"].insert(0, "fixture-bridge.js")
        manifest["host_permissions"].extend([fixture_origin, redirect_origin])
        manifest["web_accessible_resources"][0]["matches"].extend(
            [fixture_origin, redirect_origin],
        )
        rules = "background/navigation-rules.js"
        files[rules] = files[rules].decode().replace(r"reddit\\.com", "localhost").encode()
        files["fixture-bridge.js"] = FIXTURE_BRIDGE.encode()
    files["manifest.json"] = json.dumps(manifest, indent=2).encode()

    destination = Path(destination)
    if browser == "firefox":
        with ZipFile(destination, "w") as archive:
            for name, data in files.items():
                archive.writestr(name, data)
    else:
        for name, data in files.items():
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
    return destination


class FixtureHandler(BaseHTTPRequestHandler):
    def do_GET(self):
        # Every path serves a fixture, so pages can stand in for any Reddit URL.
        name = parse_qs(urlparse(self.path).query).get("fixture", ["infinite-feed"])[0]
        fixture = FIXTURES / f"{name}.html"
        if fixture.parent != FIXTURES or not fixture.is_file():
            self.send_error(404)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(fixture.read_bytes())

    def log_message(self, *args):
        pass


class FixtureServer:
    def __init__(self):
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FixtureHandler)
        self.port = self.server.server_port
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def url(self, path="/r/test/", host="127.0.0.1"):
        return f"http://{host}:{self.port}{path}"

    def close(self):
        self.server.shutdown()
        self.server.server_close()


def start_firefox(binary=None):
    options = FirefoxOptions()
    options.add_argument("-headless")
    if binary:
        options.binary_location = binary
    options.set_preference(
        "extensions.webextensions.uuids", json.dumps({FIREFOX_ADDON_ID: FIREFOX_UUID}),
    )
    options.set_preference("intl.accept_languages", "en-US")
    # The temporary test profile must allow WebDriver to reload extension pages.
    service = FirefoxService(service_args=["--allow-system-access"])
    return webdriver.Firefox(options=options, service=service)


def start_chrome(binary, driver_path, extension_directory):
    # Chrome 137 and later ignore --load-extension: use Chromium or Chrome for Testing.
    options = ChromeOptions()
    options.binary_location = binary
    options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument(f"--load-extension={extension_directory}")
    service = ChromeService(executable_path=driver_path) if driver_path else ChromeService()
    return webdriver.Chrome(options=options, service=service)


class Session:
    """A browser with the extension installed, shared by every test in a run."""

    def __init__(self, driver, extension_base, server=None, screenshots=None, temp=None, addon_id=None):
        self.driver = driver
        self.extension_base = extension_base
        self.server = server
        self.screenshots = Path(screenshots) if screenshots else None
        # The temporary folder holding the installed test build, if any.
        self.temp = temp
        self.addon_id = addon_id

    def extension_url(self, path):
        return f"{self.extension_base}/{path}"

    def reset(self):
        """Closes extra windows and restores defaults in the remaining one."""
        driver = self.driver
        first, *others = driver.window_handles
        for handle in others:
            driver.switch_to.window(handle)
            driver.close()
        driver.switch_to.window(first)
        driver.set_window_size(*WINDOW_SIZE)
        self.open_settings_page()
        result = driver.execute_async_script(RESET_SCRIPT)
        if result != {"success": True}:
            raise RuntimeError(f"Could not reset the extension: {result}")

    def open_settings_page(self, query="?standalone=true"):
        self.driver.get(self.extension_url(f"popup/index.html{query}"))
        # The page has loaded its settings once its controls are enabled.
        WebDriverWait(self.driver, TIMEOUT).until(
            lambda driver: driver.find_element("id", "add-subreddit").is_enabled()
        )

    def store(self, **settings):
        """Saves settings from an extension page and waits for navigation rules."""
        self.open_settings_page()
        result = self.driver.execute_async_script(STORE_SCRIPT, settings)
        if result != {"success": True}:
            raise RuntimeError(f"Could not store settings: {result}")

    def quit(self):
        self.driver.quit()
        if self.server:
            self.server.close()
        if self.temp:
            self.temp.cleanup()


class ExtensionTestCase(unittest.TestCase):
    """Starts each test from default settings on the main fixture page."""

    session = None

    @property
    def driver(self):
        return self.session.driver

    @property
    def server(self):
        return self.session.server

    def setUp(self):
        self.session.reset()
        self.open_fixture()

    def js(self, script, *values):
        return self.driver.execute_script(script, *values)

    def wait_until(self, condition, message=None, timeout=TIMEOUT):
        return WebDriverWait(self.driver, timeout).until(lambda _: condition(), message)

    def pause(self, milliseconds):
        self.driver.execute_async_script(
            "setTimeout(arguments[1], arguments[0])", milliseconds,
        )

    def open_fixture(self, path="/r/test/", host="127.0.0.1", fixture=None):
        url = self.server.url(path, host)
        if fixture:
            url += f"{'&' if '?' in url else '?'}fixture={fixture}"
        self.driver.get(url)
        self.wait_until(lambda: self.js(
            "return document.documentElement.hasAttribute('data-test-extension-id')"
        ), "the extension did not load on the fixture page")

    def configure(self, **settings):
        """Changes settings from the fixture page and waits until they are saved."""
        self.js("""
            document.documentElement.removeAttribute('data-test-settings-applied');
            window.dispatchEvent(new CustomEvent('frontfilter-test-settings', {
              detail: JSON.stringify(arguments[0]),
            }));
        """, settings)
        self.wait_until(lambda: self.js(
            "return document.documentElement.hasAttribute('data-test-settings-applied')"
        ), f"settings were not applied: {settings}")

    def expect(self, ids):
        """Waits until exactly these feed posts are shown, in this order."""
        expected = [f"t3_{post_id}" for post_id in ids]
        try:
            self.wait_until(lambda: self.js("return shown()") == expected)
        except Exception:
            state = self.js(
                "return {shown: shown(), calls: loadCalls, plans,"
                " controls: document.querySelector('.frontfilter-feed-controls')?.textContent}"
            )
            self.fail(f"expected {expected}, page state: {state}")

    def click_feed_button(self):
        button = ".frontfilter-feed-controls button:not([hidden]):not(:disabled)"
        self.wait_until(lambda: self.js(f"return !!document.querySelector('{button}')"))
        self.js(f"document.querySelector('{button}').click()")

    def save_screenshot(self, name):
        if self.session.screenshots:
            self.session.screenshots.mkdir(parents=True, exist_ok=True)
            self.driver.save_screenshot(str(self.session.screenshots / name))
