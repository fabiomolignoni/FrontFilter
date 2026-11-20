/**
 * The interface's messages (src/_locales/), and shared/i18n.js, which shows
 * them. Browsers check a translation only once the extension loads, and
 * show a message's name, or nothing, for one it lacks: these checks find
 * such problems first, for English and for every translation.
 */
const assert = require("node:assert/strict");
const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const {
  FakeElement, createDocument, deferred, fakeFetch, fakeI18n, parseHtml, readMessages, readSource, runScripts,
} = require("./helpers");

const LOCALES = join(__dirname, "..", "..", "src", "_locales");
const PAGES = ["popup/index.html", "blocked/index.html"];
const PLURAL_CATEGORIES = ["zero", "one", "two", "few", "many", "other"];
// A message's name, a placeholder's name and its content, as browsers take them.
const NAME = /^[A-Za-z0-9_]+$/;
const CONTENT = /^\$[1-9]$/;
// The markup a page's message may hold (shared/i18n.js).
const TAG = /<\/?([a-z]+)[^>]*>/g;
const ALLOWED_TAGS = new Set(["strong", "code"]);

const english = readMessages();
const translations = readdirSync(LOCALES).filter((folder) => folder !== "en");

function sourceFiles(directory = "", extension) {
  return readdirSync(join(LOCALES, "..", directory), { withFileTypes: true }).flatMap((entry) => {
    const path = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return entry.name === "_locales" ? [] : sourceFiles(path, extension);
    return path.endsWith(extension) ? [path] : [];
  });
}

// The names the extension asks for: in scripts, always as a literal first
// argument, on pages in data-i18n attributes, and in the manifest.
function namesInUse() {
  const names = new Set(["languageTag"]);
  const plurals = new Set();
  for (const file of sourceFiles("", ".js")) {
    const source = readSource(file);
    for (const [, name] of source.matchAll(/\b(?:t|parts)\(\s*"(\w+)"/g)) names.add(name);
    for (const [, name] of source.matchAll(/\bplural\(\s*"(\w+)"/g)) plurals.add(name);
  }
  for (const file of sourceFiles("", ".html")) {
    for (const [, name] of readSource(file).matchAll(/\bdata-i18n(?:-[\w-]+)?="(\w+)"/g)) names.add(name);
  }
  for (const [, name] of readSource("manifest.json").matchAll(/__MSG_(\w+)__/g)) names.add(name);
  return { names, plurals };
}

// A plural form's family and category, as name_few is name's few form.
function pluralOf(name) {
  const match = name.match(/^(\w+)_([a-z]+)$/);
  return match && PLURAL_CATEGORIES.includes(match[2]) ? { family: match[1], category: match[2] } : null;
}

// What browsers would refuse in a messages.json, or show wrong.
function formatProblems(messages) {
  const problems = [];
  const lowercase = new Map();
  for (const [name, entry] of Object.entries(messages)) {
    if (!NAME.test(name)) problems.push(`${name}: not a valid name`);
    const other = lowercase.get(name.toLowerCase());
    if (other) problems.push(`${name}: the same name as ${other}, in another case`);
    lowercase.set(name.toLowerCase(), name);
    if (typeof entry?.message !== "string") {
      problems.push(`${name}: no message`);
      continue;
    }
    const placeholders = Object.fromEntries(Object.entries(entry.placeholders ?? {})
      .map(([placeholder, value]) => [placeholder.toLowerCase(), value]));
    for (const [placeholder, value] of Object.entries(placeholders)) {
      if (!NAME.test(placeholder) || !CONTENT.test(value?.content ?? "")) {
        problems.push(`${name}: placeholder ${placeholder} should hold one of $1 to $9`);
      }
    }
    for (const [, placeholder] of entry.message.matchAll(/\$([^$\s]+)\$/g)) {
      if (!Object.hasOwn(placeholders, placeholder.toLowerCase())) {
        problems.push(`${name}: $${placeholder}$ is no placeholder of its own`);
      }
    }
    const tags = new Set(Array.from(entry.message.matchAll(TAG), ([, tag]) => tag));
    for (const tag of tags) {
      if (!ALLOWED_TAGS.has(tag)) problems.push(`${name}: holds a <${tag}> tag`);
    }
  }
  return problems;
}

// What a translation gets wrong against English: messages English does
// not have, placeholders other than English's, and a language that is not
// its folder's. A plural family may add the forms its language needs.
function translationProblems(folder, messages) {
  const problems = formatProblems(messages);
  const placeholdersOf = (entry) => JSON.stringify(Object.entries(entry?.placeholders ?? {})
    .map(([name, { content }]) => [name.toLowerCase(), content]).sort());
  for (const [name, entry] of Object.entries(messages)) {
    const plural = pluralOf(name);
    const source = english[name] ?? (plural && english[`${plural.family}_other`]);
    if (!source) {
      problems.push(`${name}: no such message in English`);
    } else if (typeof entry?.message === "string" && placeholdersOf(entry) !== placeholdersOf(source)) {
      problems.push(`${name}: placeholders other than English's`);
    }
  }
  const tag = messages.languageTag?.message;
  if (tag !== folder.replace("_", "-")) problems.push(`languageTag: ${tag} for the folder ${folder}`);
  return problems;
}

// The extension's name and description as a translation gives them, within
// the stores' limits.
function manifestProblems(messages) {
  const text = (name) => messages[name]?.message ?? english[name].message;
  return [
    text("extensionName").length > 75 && "extensionName: longer than 75 characters",
    text("extensionDescription").length > 132 && "extensionDescription: longer than 132 characters",
  ].filter(Boolean);
}

test("names in the code every English message, and only those", () => {
  const { names, plurals } = namesInUse();
  for (const name of names) assert.ok(Object.hasOwn(english, name), `${name} is no English message`);
  for (const family of plurals) {
    for (const category of ["one", "other"]) {
      assert.ok(Object.hasOwn(english, `${family}_${category}`), `${family}_${category} is no English message`);
    }
  }
  const unused = Object.keys(english).filter((name) => {
    const plural = pluralOf(name);
    return !names.has(name) && !(plural && plurals.has(plural.family));
  });
  assert.deepEqual(unused, []);
  // English has the one and other forms of each plural family, as plural()
  // falls back on other: a translation adds the forms its language uses.
  for (const name of Object.keys(english)) {
    const plural = pluralOf(name);
    if (plural) assert.ok(["one", "other"].includes(plural.category), name);
  }
});

test("writes the English messages as browsers read them", () => {
  assert.deepEqual(formatProblems(english), []);
  assert.equal(english.languageTag.message, "en");
  assert.deepEqual(manifestProblems(english), []);
  const manifest = JSON.parse(readSource("manifest.json"));
  assert.equal(manifest.default_locale, "en");
  assert.equal(manifest.name, "__MSG_extensionName__");
  assert.equal(manifest.description, "__MSG_extensionDescription__");
  // Every placeholder says what it holds, with an example.
  for (const [name, { placeholders = {} }] of Object.entries(english)) {
    for (const [placeholder, { example }] of Object.entries(placeholders)) {
      assert.ok(example, `${name}: ${placeholder} has no example`);
    }
  }
});

for (const folder of translations) {
  test(`translates into ${folder} only what English says, with its placeholders`, () => {
    const messages = readMessages(folder);
    assert.deepEqual(translationProblems(folder, messages), []);
    assert.deepEqual(manifestProblems(messages), []);
  });
}

test("finds what a translation gets wrong", () => {
  const translation = {
    languageTag: { message: "pl" },
    commonCancel: { message: "Anuluj" },
    // Forms Polish adds to a plural family.
    countPosts_few: { message: "$COUNT$ posty", placeholders: { count: { content: "$1" } } },
    countPosts_many: { message: "$COUNT$ postów", placeholders: { count: { content: "$1" } } },
    // A message English does not have, and placeholders other than English's.
    commonMaybe: { message: "Może" },
    currentBlockLabel: { message: "Zablokuj $STRONA$", placeholders: { strona: { content: "1" } } },
    blockedSubreddit: { message: "r/$SUBREDDIT$ <em>zablokowany</em>" },
    extensionName: { message: "FrontFilter".repeat(8) },
  };
  assert.deepEqual(translationProblems("pl", translation), [
    "currentBlockLabel: placeholder strona should hold one of $1 to $9",
    "blockedSubreddit: $SUBREDDIT$ is no placeholder of its own",
    "blockedSubreddit: holds a <em> tag",
    "commonMaybe: no such message in English",
    "currentBlockLabel: placeholders other than English's",
    "blockedSubreddit: placeholders other than English's",
  ]);
  assert.deepEqual(translationProblems("pt_BR", { languageTag: { message: "pt" } }),
    ["languageTag: pt for the folder pt_BR"]);
  assert.deepEqual(manifestProblems(translation), ["extensionName: longer than 75 characters"]);
});

for (const page of PAGES) {
  test(`${page} takes all its text from the messages`, () => {
    // Names, symbols and numbers, which no language changes.
    const fixed = new Set(["FrontFilter", "GitHub", "?", "&middot;", "0"]);
    const found = [];
    const visit = (element) => {
      const text = element.text.trim();
      if (element.hasAttribute("data-i18n")) {
        // The message is all the element shows.
        if (text || element.children.length > 0) found.push(`${element.getAttribute("data-i18n")}: has content`);
      } else if (text && !fixed.has(text) && !["script", "style"].includes(element.localName)) {
        found.push(text);
      }
      for (const attribute of ["title", "aria-label", "alt"]) {
        if (element.getAttribute(attribute)) found.push(`${attribute}="${element.getAttribute(attribute)}"`);
      }
      const placeholder = element.getAttribute("placeholder");
      if (placeholder && placeholder !== "example.com") found.push(`placeholder="${placeholder}"`);
      for (const child of element.children) if (child instanceof FakeElement) visit(child);
    };
    visit(parseHtml(readSource(page)));
    assert.deepEqual(found, []);
  });
}

// shared/i18n.js in a page whose browser has the language given and, if a
// test gives them, a translation's messages, with the extension's files to
// fetch and the local storage given.
function loadI18n({ html = "<html><body></body></html>", fetch = fakeFetch(), localStorage, ...options } = {}) {
  const page = createDocument(html);
  const errors = [];
  const context = vm.createContext({
    chrome: {
      i18n: fakeI18n(options),
      runtime: { getURL: (path) => `chrome-extension://frontfilter/${path}` },
    },
    console: { error: (...args) => errors.push(args) },
    document: page.document,
    fetch,
    localStorage,
  });
  runScripts(context, ["shared/core.js", "shared/i18n.js"]);
  return { ...page, errors, FrontFilter: context.FrontFilter, i18n: context.FrontFilter.i18n };
}

// Local storage as extension pages have it, holding the values given.
function fakeLocalStorage(values = {}) {
  const stored = new Map(Object.entries(values));
  return {
    stored,
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, String(value)),
  };
}

test("fills a page's text, attributes and markup, and says its language", () => {
  const { document, elements, i18n } = loadI18n({ html: `<html lang="en"><body>
    <h2 id="title" data-i18n="subredditsTitle">stale</h2>
    <button id="toggle" data-i18n-aria-label="subredditsHelpLabel" data-i18n-title="openInTab">?</button>
    <p id="help" data-i18n="subredditsHelpKeepFew"></p>
  </body></html>` });
  i18n.localizePage(document);
  assert.equal(document.documentElement.getAttribute("lang"), "en");
  assert.equal(elements.title.textContent, "Subreddits");
  assert.equal(elements.toggle.getAttribute("aria-label"), "About subreddits");
  assert.equal(elements.toggle.getAttribute("title"), "Open settings in a tab");
  assert.equal(elements.toggle.textContent, "?");
  // Tags in a message become elements, which hold their text.
  const code = elements.help.children.find((child) => child instanceof FakeElement);
  assert.equal(code.localName, "code");
  assert.equal(code.textContent, "*");
  assert.equal(elements.help.textContent,
    "To keep only a few subreddits, block * everywhere and allow them. A Reddit URL works too.");
});

test("fills placeholders, and shows the name of a message no language has", () => {
  const { i18n } = loadI18n();
  assert.equal(i18n.t("lockChangeWaits", "Remove r/news", "until Friday"), "Remove r/news: waits until Friday");
  assert.equal(i18n.t("noSuchMessage"), "noSuchMessage");
  // A message with nodes among its substitutions, as the parts to append.
  const rule = { localName: "strong" };
  assert.deepEqual(Array.from(i18n.parts("blockedByRule", rule)), ["Blocked by the rule ", rule]);
});

test("counts in the forms of the messages' language, falling back on their other form", () => {
  assert.equal(loadI18n().i18n.plural("countPosts", 1), "1 post");
  assert.equal(loadI18n().i18n.plural("countPosts", 1234), "1,234 posts");
  const form = (message) => ({ message, placeholders: { count: { content: "$1" } } });
  const { i18n } = loadI18n({
    uiLanguage: "pl",
    messages: {
      languageTag: { message: "pl" },
      countPosts_one: form("$COUNT$ post"),
      countPosts_few: form("$COUNT$ posty"),
      countPosts_many: form("$COUNT$ postów"),
    },
  });
  assert.deepEqual([1, 3, 5, 22].map((count) => i18n.plural("countPosts", count)),
    ["1 post", "3 posty", "5 postów", "22 posty"]);
  // Polish counts 1.5 as other, a form this translation lacks: English's.
  assert.equal(i18n.plural("countPosts", 1.5), "1,5 posts");
});

test("writes dates and numbers as the messages' language does, in the browser's variant of it", () => {
  const cases = [
    // English in a British browser reads as British English.
    [{ uiLanguage: "en-GB" }, "en", "en-GB"],
    // Without an Italian translation, an Italian browser shows English.
    [{ uiLanguage: "it-IT" }, "en", "en"],
    [{ uiLanguage: "it-IT", messages: { languageTag: { message: "it" } } }, "it", "it-IT"],
    // A translation for a region writes as that region does.
    [{ uiLanguage: "pt-PT", messages: { languageTag: { message: "pt-BR" } } }, "pt-BR", "pt-BR"],
    [{ uiLanguage: "not a language" }, "en", "en"],
  ];
  for (const [options, language, locale] of cases) {
    const { i18n } = loadI18n(options);
    assert.equal(i18n.language, language, options.uiLanguage);
    assert.equal(i18n.locale, locale, options.uiLanguage);
  }
  assert.equal(loadI18n({ uiLanguage: "it-IT", messages: { languageTag: { message: "it" } } })
    .i18n.formatNumber(1234.5), "1234,5");
});

test("offers each language it has a folder for, named in its own words", () => {
  const { FrontFilter, i18n } = loadI18n();
  assert.deepEqual(Array.from(FrontFilter.LANGUAGES).sort(),
    readdirSync(LOCALES).map((folder) => folder.replace("_", "-")).sort());
  assert.deepEqual(JSON.parse(JSON.stringify(i18n.languageNames())),
    [{ tag: "de", name: "Deutsch" }, { tag: "en", name: "English" }, { tag: "es", name: "Español" },
      { tag: "fr", name: "Français" }, { tag: "it", name: "Italiano" },
      { tag: "pt-BR", name: "Português (Brasil)" }, { tag: "pt-PT", name: "Português (Portugal)" }]);
});

test("speaks a language chosen in the settings, with English for what it lacks, or the browser's", async () => {
  const files = fakeFetch();
  // A translation that has only some of the messages.
  const fetch = async (url) => (String(url).endsWith("_locales/it/messages.json")
    ? { ok: true, json: async () => ({ languageTag: { message: "it" }, tabBlock: { message: "Blocca" } }) }
    : files(url));
  const { i18n } = loadI18n({ uiLanguage: "en-GB", fetch });
  assert.equal(i18n.setting, "system");
  assert.equal(await i18n.use("it"), true);
  assert.equal(i18n.setting, "it");
  assert.equal(i18n.language, "it");
  // The browser's variant is British English's, not Italian's.
  assert.equal(i18n.locale, "it");
  assert.equal(i18n.t("tabBlock"), "Blocca");
  assert.equal(i18n.t("tabFilter"), "Filter");
  assert.equal(i18n.t("lockChangeWaits", "Remove r/news", "until Friday"), "Remove r/news: waits until Friday");
  assert.equal(await i18n.use("it"), false);
  assert.equal(await i18n.use("system"), true);
  assert.equal(i18n.t("tabBlock"), "Block");
  assert.equal(i18n.locale, "en-GB");
  // An unknown language is the browser's.
  assert.equal(await i18n.use("xx"), false);
  assert.equal(i18n.setting, "system");
});

test("speaks Italian from its own messages", async () => {
  const { i18n } = loadI18n({ uiLanguage: "it-IT" });
  await i18n.use("it");
  assert.equal(i18n.locale, "it-IT");
  assert.deepEqual([1, 3].map((count) => i18n.plural("subredditsAdded", count)),
    ["Aggiunta 1 regola", "Aggiunte 3 regole"]);
  assert.equal(i18n.plural("usersCount", 1234), "1234 utenti");
  assert.equal(i18n.t("lockChangeWaits", "Rimuovi r/news", "fino a venerdì"), "Rimuovi r/news: attende fino a venerdì");
});

test("speaks German from its own messages", async () => {
  const { i18n } = loadI18n({ uiLanguage: "de-AT" });
  await i18n.use("de");
  assert.equal(i18n.locale, "de-AT");
  assert.deepEqual([1, 3].map((count) => i18n.plural("countPosts", count)), ["1 Beitrag", "3 Beiträge"]);
  // A form may leave out its count, which only one can take.
  assert.deepEqual([1, 25].map((count) => i18n.plural("feedLimitShowNext", count)),
    ["Nächsten Beitrag anzeigen", "Nächste 25 anzeigen"]);
  assert.equal(i18n.t("listRemoved", "news"), "„news“ entfernt");
  assert.equal(i18n.t("lockChangeWaits", "r/news entfernen", "bis Freitag"), "r/news entfernen: wartet bis Freitag");
});

test("speaks Brazilian and European Portuguese from their own messages", async () => {
  const { i18n } = loadI18n({ uiLanguage: "pt-PT" });
  await i18n.use("pt-BR");
  assert.equal(i18n.language, "pt-BR");
  assert.equal(i18n.locale, "pt-BR");
  assert.equal(i18n.t("tabSettings"), "Configurações");
  // Brazilian Portuguese counts 0 as it counts 1.
  assert.deepEqual([0, 1, 3].map((count) => i18n.plural("countPosts", count)), ["0 post", "1 post", "3 posts"]);
  assert.equal(i18n.plural("usersCount", 1234), "1.234 contas");
  await i18n.use("pt-PT");
  assert.equal(i18n.locale, "pt-PT");
  assert.equal(i18n.t("tabSettings"), "Definições");
  assert.deepEqual([0, 1, 3].map((count) => i18n.plural("countPosts", count)), ["0 posts", "1 post", "3 posts"]);
  assert.equal(i18n.t("lockChangeWaits", "Remover r/news", "até sexta"), "Remover r/news: espera até sexta");
});

test("keeps its language when a chosen one cannot load, and takes the last choice", async () => {
  const { errors, i18n } = loadI18n();
  assert.equal(await i18n.use("it", async () => { throw new Error("offline"); }), false);
  assert.equal(await i18n.use("it", async () => undefined), false);
  assert.equal(i18n.setting, "system");
  assert.equal(errors.length, 2);
  // A choice made while another loads wins over it.
  const slow = deferred();
  const first = i18n.use("it", () => slow.promise);
  assert.equal(await i18n.use("system"), false);
  slow.resolve(await i18n.fetchMessages("it"));
  assert.equal(await first, false);
  assert.equal(i18n.setting, "system");
});

test("starts a page in the language cached for it, and loads it again only to speak another", async () => {
  const localStorage = fakeLocalStorage({ "frontfilter-language": "it" });
  const page = loadI18n({ html: '<html lang="en"><body><h2 id="title" data-i18n="subredditsTitle"></h2></body></html>', localStorage });
  const { document, elements, i18n } = page;
  const started = i18n.startPage(document);
  // Hidden while its messages load.
  assert.equal(document.documentElement.hasAttribute("data-i18n-pending"), true);
  await started;
  i18n.localizePage(document);
  assert.equal(document.documentElement.hasAttribute("data-i18n-pending"), false);
  assert.equal(document.documentElement.getAttribute("lang"), "it");
  assert.equal(elements.title.textContent, "Subreddit");
  assert.equal(i18n.pageNeedsReload("it"), false);
  // Another language is cached for the page's next load.
  assert.equal(i18n.pageNeedsReload("system"), true);
  assert.equal(localStorage.stored.get("frontfilter-language"), "system");

  // A page that could not load the language it started in does not load
  // again for it: it would fail again.
  const failing = loadI18n({ localStorage: fakeLocalStorage({ "frontfilter-language": "it" }), fetch: async () => ({ ok: false }) });
  await failing.i18n.startPage(failing.document);
  assert.equal(failing.i18n.setting, "system");
  assert.equal(failing.i18n.pageNeedsReload("it"), false);
  // Nor one whose cache cannot keep the language.
  const uncached = loadI18n();
  await uncached.i18n.startPage(uncached.document);
  assert.equal(uncached.i18n.pageNeedsReload("it"), false);
});
