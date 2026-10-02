const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { readSource, settle } = require("./helpers");

const source = readSource("shared/theme-bootstrap.js");

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
  return { context, attributes, removed, written };
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
  await settle();

  assert.equal(attributes.get("data-theme"), "light");
  assert.equal(attributes.has("data-theme-pending"), false);
  assert.equal(written.get("frontfilter-theme"), "light");
});

test("shows the page with the system mode when extension storage fails", async () => {
  const attributes = new Map();
  const context = vm.createContext({
    chrome: {
      storage: { local: { get: async () => { throw new Error("storage unavailable"); } } },
    },
    document: {
      documentElement: {
        removeAttribute: (name) => attributes.delete(name),
        setAttribute: (name, value) => attributes.set(name, String(value)),
      },
    },
    localStorage: { getItem: () => null },
  });

  vm.runInContext(source, context, { filename: "shared/theme-bootstrap.js" });
  assert.equal(attributes.has("data-theme-pending"), true);
  await settle();
  assert.equal(attributes.has("data-theme-pending"), false);
  assert.equal(attributes.has("data-theme"), false);
});

test("lets pages apply a mode, which it caches for their next load", () => {
  const { context, attributes, written } = runBootstrap("dark");
  assert.equal(context.applyTheme("light"), "light");
  assert.equal(attributes.get("data-theme"), "light");
  assert.equal(written.get("frontfilter-theme"), "light");
  assert.equal(context.applyTheme("sepia"), "system");
  assert.equal(attributes.get("data-theme"), "system");
});

test("ignores missing theme caches and removes invalid values", () => {
  assert.equal(runBootstrap(null).attributes.has("data-theme"), false);

  const invalid = runBootstrap("white");
  assert.equal(invalid.attributes.has("data-theme"), false);
  assert.deepEqual(invalid.removed, ["frontfilter-theme"]);
});

test("loads the bootstrap script before theme CSS on every extension page", () => {
  for (const page of ["popup/index.html", "blocked/index.html"]) {
    const html = readSource(page);
    const bootstrap = html.indexOf('src="../shared/theme-bootstrap.js"');
    const themeCss = html.indexOf('href="../shared/theme.css"');

    assert.ok(bootstrap >= 0, `${page} must load the theme bootstrap`);
    assert.ok(themeCss > bootstrap, `${page} must bootstrap before loading theme CSS`);
  }
});
