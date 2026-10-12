/**
 * Static checks of the extension as it is packaged: its manifests, pages and
 * scripts. Browsers report these problems only once the extension loads, and
 * stores only once it is uploaded.
 */
const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join, posix } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { readSource } = require("./helpers");

const ROOT = join(__dirname, "..", "..");
const PROJECT_URL = "https://github.com/fabiomolignoni/FrontFilter";
const PAGES = ["popup/index.html", "blocked/index.html"];
const manifest = JSON.parse(readSource("manifest.json"));
const firefoxOverrides = JSON.parse(readFileSync(join(ROOT, "manifests", "firefox.json"), "utf8"));
// As scripts/package.py builds it.
const firefoxManifest = { ...structuredClone(manifest), ...firefoxOverrides };
delete firefoxManifest.minimum_chrome_version;

const sourceExists = (file) => existsSync(join(ROOT, "src", file));
const contentScripts = manifest.content_scripts.flatMap(({ js }) => js);
// Paths in a page or script are relative to its folder.
const resolve = (from, path) => posix.join(posix.dirname(from), path);
const pageScripts = PAGES.flatMap((page) => Array.from(
  readSource(page).matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g),
  ([, src]) => resolve(page, src),
));

test("keeps the source manifest directly loadable by Chrome", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "background/service-worker.js");
  assert.equal("scripts" in manifest.background, false);
  assert.equal("browser_specific_settings" in manifest, false);
  assert.equal(manifest.homepage_url, PROJECT_URL);
  // The Chrome Web Store's limits.
  assert.ok(manifest.name.length <= 75);
  assert.ok(manifest.description.length <= 132);
});

test("builds the Firefox manifest from browser-specific overrides only", () => {
  assert.deepEqual(Object.keys(firefoxOverrides).sort(), ["background", "browser_specific_settings", "name"]);
  assert.equal("service_worker" in firefoxManifest.background, false);
  assert.ok(firefoxManifest.browser_specific_settings.gecko.id);
  // Firefox Add-ons rejects longer names.
  assert.ok(firefoxManifest.name.length <= 45);
});

test("runs the same background scripts in Chrome's service worker and in Firefox", () => {
  const worker = manifest.background.service_worker;
  const [, imports] = readSource(worker).match(/importScripts\(([^)]*)\)/);
  assert.deepEqual(
    Array.from(imports.matchAll(/"([^"]+)"/g), ([, path]) => resolve(worker, path)),
    firefoxManifest.background.scripts,
  );
});

test("lists only files that exist", () => {
  for (const file of [
    manifest.background.service_worker,
    ...firefoxManifest.background.scripts,
    ...contentScripts,
    ...manifest.content_scripts.flatMap(({ css = [] }) => css),
    ...manifest.web_accessible_resources.flatMap(({ resources }) => resources),
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ]) {
    assert.ok(sourceExists(file), file);
  }
});

test("loads each content script after the modules it uses", () => {
  const pageBridge = manifest.content_scripts.find(({ world }) => world === "MAIN");
  assert.deepEqual(pageBridge.js, ["content/feed-bridge.js"]);
  const isolated = manifest.content_scripts.find(({ world }) => world !== "MAIN").js;
  const position = (file) => {
    assert.ok(isolated.includes(file), file);
    return isolated.indexOf(file);
  };
  assert.equal(position("shared/core.js"), 0);
  assert.equal(position("content/main.js"), isolated.length - 1);
  for (const file of ["content/posts.js", "content/page-style.js", "content/autoplay.js"]) {
    assert.ok(position("content/selectors.js") < position(file), file);
  }
  for (const file of ["content/feed-window.js", "content/posts.js"]) {
    assert.ok(position(file) < position("content/feed-limit.js"), file);
  }
});

test("parses every script, which uses the chrome namespace that both browsers have", () => {
  const scripts = new Set([
    manifest.background.service_worker,
    ...firefoxManifest.background.scripts,
    ...contentScripts,
    ...pageScripts,
  ]);
  for (const file of scripts) {
    const source = readSource(file);
    assert.doesNotThrow(() => new vm.Script(source, { filename: file }), file);
    assert.doesNotMatch(source, /\bbrowser\.[a-z]/, file);
  }
});

for (const page of PAGES) {
  test(`${page} loads only packaged files, with no inline scripts`, () => {
    const html = readSource(page);
    assert.match(html, /<html\s[^>]*\blang="en"/);
    // Manifest V3 forbids inline scripts.
    for (const [, attributes] of html.matchAll(/<script\b([^>]*)>/g)) {
      assert.match(attributes, /\bsrc="[^"]+"/);
    }
    for (const [, path] of html.matchAll(/\b(?:src|href)="(?!https:)([^"]+)"/g)) {
      assert.ok(sourceExists(resolve(page, path)), path);
    }
    const ids = Array.from(html.matchAll(/\bid="([^"]+)"/g), ([, id]) => id);
    assert.deepEqual(ids.filter((id, index) => ids.indexOf(id) !== index), []);
  });

  test(`${page} links only to the project, in tabs that cannot reach the page`, () => {
    const links = Array.from(readSource(page).matchAll(/<a\b([^>]*)>/g), ([, attributes]) => attributes);
    assert.deepEqual(
      links.map((attributes) => attributes.match(/\bhref="([^"]+)"/)[1]),
      [PROJECT_URL, `${PROJECT_URL}/issues`],
    );
    for (const attributes of links) {
      assert.match(attributes, /\btarget="_blank"/);
      assert.match(attributes, /\brel="noopener noreferrer"/);
    }
  });
}
