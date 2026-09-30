const assert = require("node:assert/strict");
const { existsSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const root = join(__dirname, "..", "..");
const sourceRoot = join(root, "src");
const chromeManifest = JSON.parse(
  readFileSync(join(sourceRoot, "manifest.json"), "utf8"),
);
const firefoxOverrides = JSON.parse(
  readFileSync(join(root, "manifests", "firefox.json"), "utf8"),
);

test("keeps the source manifest directly loadable by Chrome MV3", () => {
  assert.equal(chromeManifest.manifest_version, 3);
  assert.equal(chromeManifest.background.service_worker, "background/service-worker.js");
  assert.equal("scripts" in chromeManifest.background, false);
  assert.equal("browser_specific_settings" in chromeManifest, false);
  assert.equal(existsSync(join(sourceRoot, chromeManifest.background.service_worker)), true);
  const pageBridge = chromeManifest.content_scripts.find(({ world }) => world === "MAIN");
  assert.deepEqual(pageBridge.js, ["content/feed-bridge.js"]);
  assert.equal(existsSync(join(sourceRoot, pageBridge.js[0])), true);
  const isolatedScripts = chromeManifest.content_scripts.find(({ world }) => world !== "MAIN").js;
  assert.ok(
    isolatedScripts.indexOf("content/post-elements.js")
      < isolatedScripts.indexOf("content/feed-limit.js"),
  );
  assert.ok(isolatedScripts.every((file) => existsSync(join(sourceRoot, file))));
});

test("builds the Firefox manifest from browser-specific overrides", () => {
  const firefoxManifest = structuredClone(chromeManifest);
  delete firefoxManifest.minimum_chrome_version;
  Object.assign(firefoxManifest, firefoxOverrides);

  assert.equal("service_worker" in firefoxManifest.background, false);
  assert.deepEqual(firefoxManifest.background.scripts, [
    "shared/core.js",
    "background/navigation-rules.js",
    "background/main.js",
  ]);
  assert.ok(firefoxManifest.browser_specific_settings.gecko.id);
  assert.equal(
    firefoxManifest.browser_specific_settings.gecko.strict_min_version,
    "140.0",
  );
  assert.equal(
    firefoxManifest.browser_specific_settings.gecko_android.strict_min_version,
    "142.0",
  );
  assert.equal("minimum_chrome_version" in firefoxManifest, false);
  assert.ok(firefoxManifest.background.scripts.every(
    (file) => existsSync(join(sourceRoot, file)),
  ));
});
