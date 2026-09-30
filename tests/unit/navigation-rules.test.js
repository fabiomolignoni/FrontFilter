const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadRules() {
  const context = vm.createContext({ URL, URLSearchParams });
  for (const file of ["shared/core.js", "background/navigation-rules.js"]) {
    vm.runInContext(
      readFileSync(join(__dirname, "..", "..", "src", file), "utf8"),
      context,
      { filename: file },
    );
  }
  return context.FrontFilter;
}

function matchingRule(rules, url) {
  return rules
    .filter((rule) => new RegExp(rule.condition.regexFilter, "i").test(url))
    .sort((left, right) => right.priority - left.priority)[0] || null;
}

function applyRedirect(rule, url) {
  const regex = new RegExp(rule.condition.regexFilter, "i");
  const replacement = rule.action.redirect.regexSubstitution.replace("\\0", () => "$&");
  return url.replace(regex, replacement);
}

test("creates no declarative rules for the default settings", () => {
  const FrontFilter = loadRules();
  assert.deepEqual(
    Array.from(FrontFilter.createNavigationRules({}, "chrome-extension://id/blocked/index.html")),
    [],
  );
  assert.deepEqual(
    Array.from(FrontFilter.createNavigationRules(
      { allowedSubreddits: ["firefox"] },
      "chrome-extension://id/blocked/index.html",
    )),
    [],
  );
});

test("compiles page settings into prioritized main-frame redirects", () => {
  const FrontFilter = loadRules();
  const rules = FrontFilter.createNavigationRules(
    {
      blockHomepage: true,
      blockPopular: true,
      blockExplore: true,
      blockNews: true,
    },
    "chrome-extension://id/blocked/index.html",
  );

  assert.equal(rules.length, 4);
  assert.ok(rules.every((rule) => rule.priority === 30));
  assert.ok(rules.every((rule) => rule.condition.resourceTypes[0] === "main_frame"));

  for (const [url, page] of [
    ["https://www.reddit.com/", "homepage"],
    ["https://www.reddit.com/new/", "homepage"],
    ["https://www.reddit.com/top/?t=week", "homepage"],
    ["http://reddit.com/r/popular/", "popular"],
    ["https://www.reddit.com/explore/", "explore"],
    ["https://www.reddit.com/news/world?feed=home", "news"],
  ]) {
    const rule = matchingRule(rules, url);
    assert.ok(rule, url);
    const redirect = new URL(applyRedirect(rule, url));
    assert.equal(redirect.searchParams.get("page"), page);
    assert.equal(redirect.hash.slice(1), url);
  }

  assert.equal(matchingRule(rules, "https://www.reddit.com/explorer"), null);
  assert.equal(matchingRule(rules, "https://www.reddit.com/newsletter"), null);
  assert.equal(matchingRule(rules, "https://example.com/r/popular"), null);
});

test("preserves HOME and ALL subreddit semantics, including wildcards", () => {
  const FrontFilter = loadRules();
  const rules = FrontFilter.createNavigationRules({
    blockedSubreddits: [
      { name: "fire*", mode: "home" },
      { name: "*news*", mode: "all" },
    ],
  }, "moz-extension://id/blocked/index.html");

  for (const url of [
    "https://www.reddit.com/r/firefox",
    "https://www.reddit.com/r/firefox/top/?t=week",
    "https://www.reddit.com/r/worldnews/comments/abc/title",
  ]) {
    assert.ok(matchingRule(rules, url), url);
  }
  assert.equal(
    matchingRule(rules, "https://www.reddit.com/r/firefox/comments/abc/title"),
    null,
  );
  assert.equal(matchingRule(rules, "https://www.reddit.com/r/pics"), null);

  const worldNews = matchingRule(
    rules,
    "https://www.reddit.com/r/worldnews/comments/abc/title?tl=it",
  );
  const redirect = new URL(applyRedirect(
    worldNews,
    "https://www.reddit.com/r/worldnews/comments/abc/title?tl=it",
  ));
  assert.equal(redirect.searchParams.get("target"), "subreddit");
  assert.equal(redirect.searchParams.get("filter"), "*news*");
});

test("gives exact subreddit exceptions precedence over subreddit blocking rules", () => {
  const FrontFilter = loadRules();
  const rules = FrontFilter.createNavigationRules({
    blockSubHome: true,
    blockedSubreddits: [{ name: "*italy*", mode: "all" }],
    allowedSubreddits: ["ItalyPersonalFinance"],
  }, "chrome-extension://id/blocked/index.html");

  for (const url of [
    "https://www.reddit.com/r/italypersonalfinance",
    "https://old.reddit.com/r/ItalyPersonalFinance/top/?t=week",
    "https://www.reddit.com/r/italypersonalfinance/comments/abc/post",
  ]) {
    const rule = matchingRule(rules, url);
    assert.equal(rule?.action.type, "allow", url);
    assert.equal(rule?.priority, 25, url);
  }

  assert.equal(
    matchingRule(rules, "https://www.reddit.com/r/italytravel")?.action.type,
    "redirect",
  );
  assert.equal(
    matchingRule(rules, "https://www.reddit.com/r/italypersonalfinanceextra")?.action.type,
    "redirect",
  );
});

test("emits allow rules only for exceptions that overlap a subreddit block", () => {
  const FrontFilter = loadRules();
  const rules = FrontFilter.createNavigationRules({
    blockedSubreddits: [{ name: "*news*", mode: "all" }],
    allowedSubreddits: ["worldnews", "firefox"],
  }, "chrome-extension://id/blocked/index.html");

  const allowRules = rules.filter(({ action }) => action.type === "allow");
  assert.equal(allowRules.length, 1);
  assert.match(allowRules[0].condition.regexFilter, /worldnews/);
});

test("gives global page rules precedence and recognizes owned rule IDs", () => {
  const FrontFilter = loadRules();
  const rules = FrontFilter.createNavigationRules({
    blockPopular: true,
    blockSubHome: true,
    blockedSubreddits: [{ name: "popular", mode: "all" }],
    allowedSubreddits: ["popular"],
  }, "chrome-extension://id/blocked/index.html");
  const target = "https://www.reddit.com/r/popular";
  const match = matchingRule(rules, target);

  assert.equal(match.priority, 30);
  assert.equal(new URL(applyRedirect(match, target)).searchParams.get("page"), "popular");
  assert.equal(FrontFilter.isNavigationRuleId(999), false);
  assert.equal(FrontFilter.isNavigationRuleId(1000), true);
  assert.equal(FrontFilter.isNavigationRuleId(999999), true);
  assert.equal(FrontFilter.isNavigationRuleId(1000000), false);
});

test("matches the shared route model across network-navigation cases", () => {
  const FrontFilter = loadRules();
  const configurations = [
    {},
    { blockHomepage: true },
    {
      blockPopular: true,
      blockExplore: true,
      blockNews: true,
    },
    { blockSubHome: true },
    { blockedSubreddits: [{ name: "fire*", mode: "home" }] },
    { blockedSubreddits: [{ name: "*news*", mode: "all" }] },
    {
      blockSubHome: true,
      blockedSubreddits: [{ name: "*fire*", mode: "all" }],
      allowedSubreddits: ["firefox"],
    },
  ];
  const urls = [
    "https://www.reddit.com/",
    "https://www.reddit.com/best/",
    "https://www.reddit.com/new/",
    "https://www.reddit.com/top/?t=week",
    "https://old.reddit.com/r/popular/",
    "https://www.reddit.com/explore/topics?show=all",
    "https://www.reddit.com/news/",
    "https://www.reddit.com/explorer",
    "https://www.reddit.com/newsletter",
    "https://www.reddit.com/r/firefox",
    "https://www.reddit.com/r/firefox//",
    "https://www.reddit.com/r/firefox/top/extra",
    "https://www.reddit.com/r/firefox/comments/abc/title",
    "https://www.reddit.com/r/worldnews/comments/abc/title?tl=it",
    "https://www.reddit.com/r/pics",
  ];

  for (const settings of configurations) {
    const rules = FrontFilter.createNavigationRules(
      settings,
      "chrome-extension://id/blocked/index.html",
    );
    for (const url of urls) {
      const route = FrontFilter.getBlockedRoute(new URL(url).pathname, settings);
      const rule = matchingRule(rules, url);
      assert.equal(
        rule?.action.type === "redirect",
        Boolean(route),
        `${url} ${JSON.stringify(settings)}`,
      );
    }
  }
});

test("caps declarative rules while leaving overflow entries to the content fallback", () => {
  const FrontFilter = loadRules();
  const blockedSubreddits = Array.from(
    { length: FrontFilter.NAVIGATION_RULE_LIMIT + 20 },
    (_, index) => ({ name: `community${index}`, mode: "all" }),
  );
  const rules = FrontFilter.createNavigationRules(
    { blockHomepage: true, blockedSubreddits },
    "chrome-extension://id/blocked/index.html",
  );

  assert.equal(rules.length, FrontFilter.NAVIGATION_RULE_LIMIT);
  assert.ok(matchingRule(rules, "https://www.reddit.com/"));
  assert.equal(
    FrontFilter.getBlockedRoute("/r/community1019/comments/a/title", { blockedSubreddits })?.type,
    "subreddit",
  );
});
