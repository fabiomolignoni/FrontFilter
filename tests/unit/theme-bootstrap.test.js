const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = join(__dirname, "..", "..");
const source = readFileSync(
  join(root, "src", "shared", "theme-bootstrap.js"),
  "utf8",
);

function runBootstrap(cachedTheme) {
  const attributes = new Map();
  const removed = [];
  const written = new Map();
  const context = vm.createContext({
    document: {
      documentElement: {
        removeAttribute(name) {
          attributes.delete(name);
        },
        setAttribute(name, value) {
          attributes.set(name, String(value));
        },
      },
    },
    localStorage: {
      getItem: () => cachedTheme,
      removeItem: (key) => removed.push(key),
      setItem: (key, value) => written.set(key, String(value)),
    },
  });

  vm.runInContext(source, context, { filename: "shared/theme-bootstrap.js" });
  return { attributes, removed, written };
}

test("applies every valid cached theme before stylesheets run", () => {
  for (const theme of ["system", "dark", "light"]) {
    const result = runBootstrap(theme);
    assert.equal(result.attributes.get("data-theme"), theme);
    assert.equal(result.written.get("frontfilter-theme"), theme);
    assert.deepEqual(result.removed, []);
  }
});

test("primes a missing cache from extension storage as early as possible", async () => {
  const attributes = new Map();
  const written = new Map();
  const context = vm.createContext({
    chrome: {
      storage: { local: { get: async () => ({ theme: "light" }) } },
    },
    document: {
      documentElement: {
        removeAttribute: (name) => attributes.delete(name),
        setAttribute: (name, value) => attributes.set(name, String(value)),
      },
    },
    localStorage: {
      getItem: () => null,
      setItem: (key, value) => written.set(key, String(value)),
    },
  });

  vm.runInContext(source, context, { filename: "shared/theme-bootstrap.js" });
  assert.equal(attributes.has("data-theme-pending"), true);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(attributes.get("data-theme"), "light");
  assert.equal(attributes.has("data-theme-pending"), false);
  assert.equal(written.get("frontfilter-theme"), "light");
});

test("ignores missing theme caches and removes invalid values", () => {
  assert.equal(runBootstrap(null).attributes.has("data-theme"), false);

  const invalid = runBootstrap("white");
  assert.equal(invalid.attributes.has("data-theme"), false);
  assert.deepEqual(invalid.removed, ["frontfilter-theme"]);
});

test("loads the bootstrap script before theme CSS on every extension page", () => {
  for (const page of ["popup/index.html", "blocked/index.html"]) {
    const html = readFileSync(join(root, "src", page), "utf8");
    const bootstrap = html.indexOf('src="../shared/theme-bootstrap.js"');
    const themeCss = html.indexOf('href="../shared/theme.css"');

    assert.ok(bootstrap >= 0, `${page} must load the theme bootstrap`);
    assert.ok(themeCss > bootstrap, `${page} must bootstrap before loading theme CSS`);
  }
});
