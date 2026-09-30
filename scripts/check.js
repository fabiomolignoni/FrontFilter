const { execFileSync } = require("node:child_process");
const { accessSync, readFileSync } = require("node:fs");
const { dirname, join, relative, resolve } = require("node:path");

const root = join(__dirname, "..");
const sourceRoot = join(root, "src");
const manifest = JSON.parse(
  readFileSync(join(sourceRoot, "manifest.json"), "utf8"),
);
const firefoxOverrides = JSON.parse(
  readFileSync(join(root, "manifests/firefox.json"), "utf8"),
);
const firefoxManifest = structuredClone(manifest);
delete firefoxManifest.minimum_chrome_version;
Object.assign(firefoxManifest, firefoxOverrides);
const packageJson = JSON.parse(
  readFileSync(join(root, "package.json"), "utf8"),
);
const projectUrl = "https://github.com/SilentFoxDev/FrontFilter";
const allowedExternalLinks = new Set([
  projectUrl,
  `${projectUrl}/issues`,
  "https://ko-fi.com/silentfoxdev/donate",
]);
const htmlPages = [
  { file: "popup/index.html", script: "popup/popup.js" },
  { file: "blocked/index.html", script: "blocked/blocked.js" },
];

if (manifest.version !== packageJson.version) {
  throw new Error("manifest.json and package.json versions do not match");
}
if (
  manifest.homepage_url !== projectUrl ||
  packageJson.homepage !== `${projectUrl}#readme` ||
  packageJson.repository?.url !== `git+${projectUrl}.git` ||
  packageJson.bugs?.url !== `${projectUrl}/issues`
) {
  throw new Error("Project metadata URLs are inconsistent");
}
for (const document of ["README.md", "CONTRIBUTING.md"]) {
  accessSync(join(root, document));
}

const popupHtml = readFileSync(join(sourceRoot, "popup/index.html"), "utf8");
const popupVersion = popupHtml.match(/\bFrontFilter v(\d+\.\d+\.\d+)\b/)?.[1];
if (popupVersion !== manifest.version) {
  throw new Error(
    "src/popup/index.html and src/manifest.json versions do not match",
  );
}

if (manifest.manifest_version !== 3) {
  throw new Error("FrontFilter must use Manifest V3");
}
if (manifest.background.scripts || !manifest.background.service_worker) {
  throw new Error(
    "src/manifest.json must be directly loadable as a Chrome MV3 extension",
  );
}
if (manifest.browser_specific_settings) {
  throw new Error("Firefox-only metadata belongs in manifests/firefox.json");
}
if (
  firefoxManifest.background.service_worker ||
  !firefoxManifest.background.scripts
) {
  throw new Error("The Firefox manifest must use background scripts");
}
if (!firefoxManifest.browser_specific_settings?.gecko?.id) {
  throw new Error("The Firefox manifest must define a Gecko extension ID");
}
const allowedFirefoxOverrides = new Set([
  "background",
  "browser_specific_settings",
]);
if (
  Object.keys(firefoxOverrides).some((key) => !allowedFirefoxOverrides.has(key))
) {
  throw new Error(
    "Firefox overrides must contain browser-specific fields only",
  );
}
if (
  manifest.browser_action ||
  manifest.permissions.includes("webRequestBlocking")
) {
  throw new Error(
    "Manifest V2 action or blocking webRequest configuration found",
  );
}
if (!manifest.permissions.includes("declarativeNetRequest")) {
  throw new Error("Manifest V3 navigation rules require declarativeNetRequest");
}
if (
  manifest.permissions.some((permission) => permission.includes("reddit.com"))
) {
  throw new Error("Manifest V3 host patterns belong in host_permissions");
}

const backgroundScripts = [
  ...firefoxManifest.background.scripts,
  manifest.background.service_worker,
];
const webAccessibleResources = manifest.web_accessible_resources.flatMap(
  (entry) => (Array.isArray(entry) ? entry : entry.resources),
);
const manifestFiles = new Set([
  ...backgroundScripts,
  ...manifest.content_scripts.flatMap(({ js }) => js),
  ...manifest.content_scripts.flatMap(({ css = [] }) => css),
  ...webAccessibleResources,
  manifest.action.default_popup,
  ...Object.values(manifest.icons),
  ...Object.values(manifest.action.default_icon),
]);
for (const file of manifestFiles) {
  accessSync(join(sourceRoot, file));
}

const scripts = new Set([
  ...backgroundScripts,
  ...manifest.content_scripts.flatMap(({ js }) => js),
]);
for (const { file } of htmlPages) {
  const htmlPath = join(sourceRoot, file);
  const htmlSource = readFileSync(htmlPath, "utf8");
  if (!/<html\s+[^>]*lang=["']en["']/i.test(htmlSource)) {
    throw new Error(`${file} must declare English as its document language`);
  }
  const ids = Array.from(
    htmlSource.matchAll(/\bid=["']([^"']+)["']/gi),
    (match) => match[1],
  );
  const duplicateIds = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicateIds.length) {
    throw new Error(
      `${file} contains duplicate IDs: ${[...new Set(duplicateIds)].join(", ")}`,
    );
  }
  for (const match of htmlSource.matchAll(
    /<link\s+[^>]*href=["']([^"']+\.css)["']/gi,
  )) {
    accessSync(resolve(dirname(htmlPath), match[1]));
  }
  for (const match of htmlSource.matchAll(
    /<img\s+[^>]*src=["']([^"']+)["']/gi,
  )) {
    accessSync(resolve(dirname(htmlPath), match[1]));
  }
  for (const match of htmlSource.matchAll(/<script\b([^>]*)>/gi)) {
    if (!/\bsrc=["'][^"']+["']/i.test(match[1])) {
      throw new Error(
        `${file} contains an inline script, which Manifest V3 forbids`,
      );
    }
  }
  for (const match of htmlSource.matchAll(
    /<script\s+[^>]*src=["']([^"']+)["']/gi,
  )) {
    const scriptPath = resolve(dirname(htmlPath), match[1]);
    accessSync(scriptPath);
    scripts.add(relative(sourceRoot, scriptPath));
  }
  for (const match of htmlSource.matchAll(/<a\b([^>]*)>/gi)) {
    const attributes = match[1];
    const href = attributes.match(/\bhref=["']([^"']+)["']/i)?.[1];
    if (!href?.startsWith("https://")) continue;
    if (!allowedExternalLinks.has(href)) {
      throw new Error(`${file} contains an unexpected external link: ${href}`);
    }
    if (
      !/\btarget=["']_blank["']/i.test(attributes) ||
      !/\brel=["'][^"']*\bnoopener\b[^"']*\bnoreferrer\b[^"']*["']/i.test(
        attributes,
      )
    ) {
      throw new Error(`${file} must protect external links opened in new tabs`);
    }
  }
}

for (const script of scripts) {
  const scriptPath = join(sourceRoot, script);
  execFileSync(process.execPath, ["--check", scriptPath], {
    stdio: "inherit",
  });
  if (/\bbrowser\./.test(readFileSync(scriptPath, "utf8"))) {
    throw new Error(`${script} uses the Firefox-only browser namespace`);
  }
}

for (const file of [
  "shared/core.js",
  "content/post-elements.js",
  "content/main.js",
  "content/feed-limit.js",
  "popup/popup.js",
  "popup/index.html",
  "blocked/blocked.js",
]) {
  const source = readFileSync(join(sourceRoot, file), "utf8");
  if (/blockNsfw|getNsfw|isPostNsfw|Block NSFW/.test(source)) {
    throw new Error(`${file} still contains removed NSFW filtering code`);
  }
}

for (const { script, file: html } of htmlPages) {
  const scriptSource = readFileSync(join(sourceRoot, script), "utf8");
  const htmlSource = readFileSync(join(sourceRoot, html), "utf8");
  const referencedIds = Array.from(
    scriptSource.matchAll(/getElementById\("([^"]+)"\)/g),
    (match) => match[1],
  );

  for (const id of referencedIds) {
    const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (!new RegExp(`\\bid=["']${escapedId}["']`).test(htmlSource)) {
      throw new Error(`${script} references missing #${id} in ${html}`);
    }
  }
}

console.log(
  `Validated ${scripts.size} scripts, 3 JSON files, and ${manifestFiles.size} manifest resources.`,
);
