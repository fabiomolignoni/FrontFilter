const assert = require("node:assert/strict");
const test = require("node:test");
const vm = require("node:vm");
const { deferred, runScripts } = require("./helpers");

function loadShared() {
  const context = vm.createContext({ URL, URLSearchParams, console });
  runScripts(context, ["shared/core.js"]);
  return context.FrontFilter;
}

const FrontFilter = loadShared();

test("exposes the immutable Reddit listing-sort vocabulary", () => {
  assert.deepEqual(
    Array.from(FrontFilter.LISTING_SORTS),
    ["best", "hot", "new", "top", "rising", "controversial"],
  );
  assert.equal(Object.isFrozen(FrontFilter.LISTING_SORTS), true);
});

test("normalizes subreddit names and Reddit URLs", () => {
  assert.equal(FrontFilter.normalizeSubredditName(" r/JavaScript/ "), "javascript");
  assert.equal(
    FrontFilter.normalizeSubredditName("https://old.reddit.com/r/Firefox/?sort=top"),
    "firefox",
  );
  assert.equal(FrontFilter.normalizeSubredditName("*News**"), "*news*");
  assert.equal(FrontFilter.normalizeSubredditName("https://example.com/r/firefox"), "");
});

test("rejects invalid subreddit values and normalizes bare Reddit hosts", () => {
  assert.equal(FrontFilter.normalizeSubredditName("reddit.com/r/Firefox/comments/123"), "firefox");
  assert.equal(FrontFilter.normalizeSubredditName("https://reddit.com/"), "");
  assert.equal(FrontFilter.normalizeSubredditName("r/+worldnews"), "");
  assert.equal(FrontFilter.normalizeSubredditName(42), "");
});

test("takes * alone for every subreddit, and patterns for no subreddit's own name", () => {
  assert.equal(FrontFilter.normalizeSubredditName("***"), "*");
  assert.equal(FrontFilter.normalizeSubredditName("r/*"), "*");
  for (const [value, expected] of [
    ["r/Firefox", "firefox"],
    ["https://www.reddit.com/r/Firefox/top/", "firefox"],
    ["news*", ""],
    ["*", ""],
    ["", ""],
    [null, ""],
  ]) {
    assert.equal(FrontFilter.normalizeExactSubredditName(value), expected, String(value));
  }
  // A subreddit's address names it, and a pattern in an address names none.
  assert.equal(FrontFilter.getSubredditPath("/r/Firefox/new").name, "firefox");
  assert.equal(FrontFilter.getSubredditPath("/r/news*/"), null);
});

test("takes a bare name or an r/ path for a subreddit, never a user profile", () => {
  for (const [value, expected] of [
    ["news", "news"],
    ["/r/News/top/", "news"],
    ["r/u_spez/comments/abc", "u_spez"],
    ["u_spez", "u_spez"],
    ["u/spez", ""],
    ["/u/spez/", ""],
    ["user/spez", ""],
    ["news/comments/abc", ""],
    // A prefix alone names nothing, though r and u are names.
    ["r/", ""],
    ["/R/", ""],
    ["u/", ""],
    ["/user//", ""],
    ["r", "r"],
    ["/u", "u"],
  ]) {
    assert.equal(FrontFilter.normalizeSubredditName(value), expected, value);
  }
});

test("takes a username alone, after u/ or user/, or from a profile URL", () => {
  for (const [value, expected] of [
    ["spez", "spez"],
    [" AutoModerator ", "automoderator"],
    ["u/Spez", "spez"],
    ["/u/spez/", "spez"],
    ["user/Some-User_1", "some-user_1"],
    ["/user/spez/submitted/?sort=top", "spez"],
    ["https://www.reddit.com/user/Spez/", "spez"],
    ["https://old.reddit.com/u/spez/comments", "spez"],
    ["reddit.com/user/spez", "spez"],
    ["a".repeat(20), "a".repeat(20)],
    // Not usernames, or not a user's profile.
    ["a".repeat(21), ""],
    ["u/", ""],
    ["/user//", ""],
    ["r/spez", ""],
    ["spez/comments", ""],
    ["https://www.reddit.com/r/spez/", ""],
    ["https://www.reddit.com/spez", ""],
    ["https://example.com/user/spez", ""],
    ["spez*", ""],
    ["two words", ""],
    ["[deleted]", ""],
    ["", ""],
    [null, ""],
    [42, ""],
  ]) {
    assert.equal(FrontFilter.normalizeUserName(value), expected, String(value));
  }
});

test("normalizes and deduplicates blocked users, and validates them on import", () => {
  assert.deepEqual(
    plain(FrontFilter.normalizeBlockedUsers(["u/Spez", "spez", "", "r/news", "kn0thing", 42])),
    ["spez", "kn0thing"],
  );
  assert.deepEqual(plain(FrontFilter.normalizeBlockedUsers("spez")), []);
  assert.deepEqual(plain(FrontFilter.coerceSettings({ blockedUsers: ["/u/Spez/"] }).blockedUsers), ["spez"]);
  assert.deepEqual(plain(FrontFilter.getInvalidSettingKeys({ blockedUsers: ["Spez", "u/kn0thing"] })), []);
  assert.deepEqual(plain(FrontFilter.getInvalidSettingKeys({ blockedUsers: "spez" })), ["blockedUsers"]);
});

test("matches exact names and wildcard patterns", () => {
  assert.equal(FrontFilter.matchesSubredditPattern("firefox", "Firefox"), true);
  assert.equal(FrontFilter.matchesSubredditPattern("*news*", "worldnews"), true);
  assert.equal(FrontFilter.matchesSubredditPattern("news*", "worldnews"), false);
  assert.equal(FrontFilter.matchesSubredditPattern("*", "worldnews"), true);
  assert.equal(FrontFilter.matchesSubredditPattern("*", ""), false);
  assert.equal(FrontFilter.matchesSubredditPattern("", "worldnews"), false);
});

test("matches many patterns at once as it matches each one", () => {
  const patterns = ["Firefox", "*news*", "ask*", "r/Pics/", "*", "", null, "u/spez"];
  const names = [
    "firefox", "FIREFOX", "r/worldnews", "news", "askreddit", "ask", "pics", "pic",
    "spez", "u", "", null, "javascript",
  ];
  const matches = FrontFilter.createSubredditMatcher(patterns);
  for (const name of names) {
    assert.equal(
      matches(name),
      patterns.some((pattern) => FrontFilter.matchesSubredditPattern(pattern, name)),
      String(name),
    );
  }
  assert.equal(FrontFilter.createSubredditMatcher([])("firefox"), false);
});

test("normalizes, migrates and deduplicates blocked entries", () => {
  // One rule per subreddit, in its first position; ALL wins over HOME.
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.normalizeBlockedSubreddits([
      "Firefox",
      { name: "firefox", mode: "home" },
      { name: "javascript", mode: "all" },
      { name: "javascript", mode: "invalid" },
      { name: "news", mode: "home" },
      { name: "pics", mode: "all" },
      { name: "r/News", mode: "all" },
    ]))),
    [
      { name: "firefox", mode: "home" },
      { name: "javascript", mode: "all" },
      { name: "news", mode: "all" },
      { name: "pics", mode: "all" },
    ],
  );
});

test("normalizes subreddit exceptions as names or patterns, as rules are", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.normalizeAllowedSubreddits([
      "ItalyPersonalFinance",
      "r/italypersonalfinance",
      "https://www.reddit.com/r/AllowedSub/comments/abc/post",
      "*Italy**",
      "*italy*",
      "",
      null,
    ]))),
    ["italypersonalfinance", "allowedsub", "*italy*"],
  );
  assert.equal(
    FrontFilter.isSubredditAllowed("ITALYPERSONALFINANCE", ["italypersonalfinance"]),
    true,
  );
  assert.equal(FrontFilter.isSubredditAllowed("italy", ["italypersonalfinance"]), false);
  assert.equal(FrontFilter.isSubredditAllowed("askhistorians", ["ask*"]), true);
  assert.equal(FrontFilter.isSubredditAllowed("historians", ["ask*"]), false);
});

test("blocks every subreddit with *, but those allowed", () => {
  const settings = {
    blockedSubreddits: [{ name: "*", mode: "all" }],
    allowedSubreddits: ["askhistorians", "science*"],
  };
  assert.equal(FrontFilter.getBlockedRoute("/r/pics/", settings)?.filter, "*");
  assert.equal(FrontFilter.getBlockedRoute("/r/pics/comments/abc/title/", settings)?.filter, "*");
  assert.equal(FrontFilter.getBlockedRoute("/r/AskHistorians/", settings), null);
  assert.equal(FrontFilter.getBlockedRoute("/r/sciencefiction/top/", settings), null);
  // Pages that are not subreddits stay open.
  assert.equal(FrontFilter.getBlockedRoute("/", settings), null);
  assert.equal(FrontFilter.getBlockedRoute("/user/spez/", settings), null);
});

test("normalizes post keywords and matches literal text case-insensitively", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.normalizeTitleKeywords([
      "  Trump  ",
      "TRUMP",
      "climate   change",
      "",
      null,
    ]))),
    ["Trump", "climate change"],
  );
  const matches = FrontFilter.createKeywordMatcher(["Trump headline", "[50%]", " "]);
  assert.equal(matches("Latest\n  TRUMP headline"), true);
  assert.equal(matches("Save [50%] today"), true);
  assert.equal(matches("Other news"), false);
  assert.equal(matches(""), false);
  assert.equal(matches(null), false);
  assert.equal(FrontFilter.createKeywordMatcher([])("Anything"), false);
});

test("matches keywords as whole words", () => {
  const matches = (keyword, text) => FrontFilter.createKeywordMatcher([keyword])(text);
  for (const [keyword, text] of [
    ["ai", "AI art"],
    ["ai", "Is this (AI)?"],
    ["ai", "AI-generated"],
    ["ai", "ai_bot"],
    ["trump", "Trump's speech"],
    ["climate change", "On climate  change, again"],
    ["covid-19", "COVID-19 vaccine"],
    ["c++", "I like C++."],
    ["50%", "Save 50% today"],
    // Edges that are not word characters match next to anything.
    ["[50%]", "Save[50%]now"],
    ["#1", "We're #1!"],
    ["🔥", "hot🔥take"],
  ]) {
    assert.equal(matches(keyword, text), true, `${keyword} in ${text}`);
  }
  for (const [keyword, text] of [
    ["ai", "He said so"],
    ["ai", "Aim higher"],
    ["trump", "Trumpism"],
    ["climate change", "climate changes"],
    ["50%", "Save 150% today"],
    ["#1", "#10"],
    ["covid", "covid19"],
    // A mark that belongs to a letter is part of its word.
    ["क", "कि"],
  ]) {
    assert.equal(matches(keyword, text), false, `${keyword} in ${text}`);
  }
});

test("matches keywords inside words in scripts written without spaces", () => {
  const matches = (keyword, text) => FrontFilter.createKeywordMatcher([keyword])(text);
  assert.equal(matches("ネタバレ", "【ネタバレ注意】"), true);
  assert.equal(matches("中国", "中国人"), true);
  assert.equal(matches("한국", "한국어"), true);
  assert.equal(matches("ai", "用AI画画"), true);
  // Comparing syllables, not their letters: 하 is not part of 한.
  assert.equal(matches("하", "한국"), false);
  // Japanese voicing marks are letters of their own, not accents.
  assert.equal(matches("かき", "がき"), false);
});

test("matches keywords ignoring accents", () => {
  const matches = (keyword, text) => FrontFilter.createKeywordMatcher([keyword])(text);
  assert.equal(matches("perche", "Perché?"), true);
  assert.equal(matches("perché", "PERCHE no"), true);
  assert.equal(matches("PERCHÉ", "perche\u0301"), true);
  assert.equal(matches("naive", "Naïve question"), true);
  assert.equal(matches("istanbul", "İSTANBUL"), true);
  assert.equal(matches("cafe", "Cafés"), false);
});

test("matches keywords between slashes as regular expressions", () => {
  const matches = (keyword, text) => FrontFilter.createKeywordMatcher([keyword])(text);
  assert.equal(matches("/colou?r/", "Pick a COLOR"), true);
  assert.equal(matches("/colou?r/", "Pick a colour"), true);
  assert.equal(matches("/colou?r/", "Pick a shade"), false);
  assert.equal(matches("/spoilers?/", "Spoilers ahead"), true);
  assert.equal(matches("/^\\[serious\\]/", "[Serious] question"), true);
  assert.equal(matches("/^\\[serious\\]/", "Not [serious]"), false);
  assert.equal(matches("/^a b$/", "  a \n b "), true);
  // An expression without accents finds accented text, and one with them
  // finds its own spelling.
  assert.equal(matches("/\\bperche\\b/", "Perché?"), true);
  assert.equal(matches("/perché/", "PERCHÉ"), true);
  assert.equal(matches("/\\p{Lu}{5}/", "SHOUT"), true);
  // Slashes alone, or only at one end, are literal text.
  assert.equal(matches("//", "a // b"), true);
  assert.equal(matches("/s", "Sure /s"), true);
  assert.equal(matches("/s", "Sure"), false);

  const both = FrontFilter.createKeywordMatcher(["/\\d{4}/", "breaking"]);
  assert.equal(both("Back in 1999"), true);
  assert.equal(both("BREAKING: news"), true);
  assert.equal(both("Calm news"), false);
  // An expression that is not valid filters nothing.
  assert.equal(FrontFilter.createKeywordMatcher(["/(/"])("("), false);
});

test("keeps keywords that match differently, and only usable ones", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.normalizeTitleKeywords([
      "Perché",
      "perche",
      "PERCHÉ",
      "/\\d/",
      "/\\D/",
      " /\\d/ ",
      "/(/",
      "/[a/",
      "\u0301",
      "/x/",
      "x",
    ]))),
    ["Perché", "/\\d/", "/\\D/", "/x/", "x"],
  );
  assert.equal(FrontFilter.getKeywordKey("Perché"), FrontFilter.getKeywordKey(" perche "));
  assert.notEqual(FrontFilter.getKeywordKey("/\\d/"), FrontFilter.getKeywordKey("/\\D/"));
  assert.notEqual(FrontFilter.getKeywordKey("/x/"), FrontFilter.getKeywordKey("x"));
  assert.equal(FrontFilter.getKeywordKey("/(/"), "");
  assert.equal(FrontFilter.getKeywordKey(""), "");
  assert.equal(FrontFilter.getKeywordKey(null), "");
  // Flairs keep comparing their spelling, accents included.
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.normalizeBlockedFlairs(["Café", "cafe", "CAFÉ"]))),
    ["Café", "cafe"],
  );
});

test("splits pasted lists at lines and commas, keeping regular expressions whole", () => {
  const split = (text, options) => JSON.parse(JSON.stringify(FrontFilter.splitList(text, options)));
  assert.deepEqual(split(" r/Firefox, news,,\r\nAskReddit\r\n\n *pics* \rcats  dogs\n"), [
    "r/Firefox", "news", "AskReddit", "*pics*", "cats dogs",
  ]);
  assert.deepEqual(split("spez"), ["spez"]);
  assert.deepEqual(split(" , \n "), []);
  assert.deepEqual(split(42), []);
  // Only keywords are regular expressions: subreddit paths split at their commas.
  assert.deepEqual(split("/r/foo, /r/bar/"), ["/r/foo", "/r/bar/"]);

  const keywords = (text) => split(text, { keywords: true });
  assert.deepEqual(keywords("/a{1,3}/, spoiler*\n/(x|y)/,/[,;]/ , climate change"), [
    "/a{1,3}/", "spoiler*", "/(x|y)/", "/[,;]/", "climate change",
  ]);
  assert.deepEqual(keywords("/a/, /b, c/"), ["/a/", "/b, c/"]);
  // Text that never closes its slashes splits as any other.
  assert.deepEqual(keywords("/unclosed, x\n/, y"), ["/unclosed", "x", "/", "y"]);
  // Exceptions keep their + and, for an expression, its commas.
  assert.deepEqual(keywords("+/a{1,3}/, + /b,c/, +ai, -x"), ["+/a{1,3}/", "+ /b,c/", "+ai", "-x"]);
  assert.deepEqual(split("news*, +worldnews"), ["news*", "+worldnews"]);
});

test("reads a + before a rule as an exception, and the rule after it", () => {
  const parse = (text) => JSON.parse(JSON.stringify(FrontFilter.parseException(text)));
  assert.equal(FrontFilter.EXCEPTION_PREFIX, "+");
  assert.deepEqual(parse(" +WorldNews "), { rule: "WorldNews", exception: true });
  assert.deepEqual(parse("+  climate   change"), { rule: "climate change", exception: true });
  assert.deepEqual(parse("news*"), { rule: "news*", exception: false });
  // Only a + before the rule makes an exception.
  assert.deepEqual(parse("c++"), { rule: "c++", exception: false });
  assert.deepEqual(parse("+"), { rule: "", exception: true });
  assert.deepEqual(parse(null), { rule: "", exception: false });
});

test("lets a star at a keyword's end match inside words there", () => {
  const matches = (keyword, text) => FrontFilter.createKeywordMatcher([keyword])(text);
  assert.equal(matches("spoiler*", "Spoilers ahead"), true);
  assert.equal(matches("spoiler*", "No spoiler here"), true);
  assert.equal(matches("spoiler*", "Antispoiler"), false);
  assert.equal(matches("*ai", "OpenAI news"), true);
  assert.equal(matches("*ai", "AIs are here"), false);
  assert.equal(matches("*ai*", "He said so"), true);
  assert.equal(matches("**ai**", "He said so"), true);
  assert.equal(matches("*climate change*", "geoclimate changes"), true);
  // A star inside a keyword is text.
  assert.equal(matches("f*ck", "What the F*CK"), true);
  assert.equal(matches("f*ck", "What the fuck"), false);

  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.normalizeTitleKeywords([
      "ai", "*ai*", "AI", "ai*", "[50%]", "*[50%]*", "*", "**", " * ",
    ]))),
    ["ai", "*ai*", "ai*", "[50%]"],
  );
});

test("upgrades keywords from before whole words to match at least what they did", () => {
  const legacyMatch = (keyword, text) =>
    FrontFilter.normalizeText(text).toLowerCase().includes(FrontFilter.normalizeText(keyword).toLowerCase());
  const upgrade = (keyword) =>
    FrontFilter.upgradeSettings({ blockedTitleKeywords: [keyword] }).blockedTitleKeywords[0];
  const keywords = [
    "ai", "Trump", "climate change", "[50%]", "50%", "#1", "c++", "/r/", "/s", "//", "*",
    "*bold*", "f*ck", "a*", "/(/", "a.b", "ネタバレ", "ai用", "perche",
  ];
  const texts = [
    "He said so", "AI art", "OpenAI and AIs", "Trumpism", "geoclimate changes", "Save[50%]now",
    "150%", "#10", "C++17", "see /r/news", "Sure /s", "a // b", "x*y", "**bold**", "f*cking",
    "a*b", "/(/", "aXb a.b", "【ネタバレ注意】", "用ai用", "Perche", "Perché", "",
  ];
  assert.equal(upgrade("ai"), "*ai*");
  assert.equal(upgrade("[50%]"), "[50%]");
  assert.equal(upgrade("50%"), "*50%");
  assert.equal(upgrade("ネタバレ"), "ネタバレ");
  assert.equal(upgrade("/r/"), "/\\/r\\//");
  assert.equal(upgrade("*"), "/\\*/");
  assert.equal(upgrade("f*ck"), "*f*ck*");
  for (const keyword of keywords) {
    const upgraded = upgrade(keyword);
    assert.equal(FrontFilter.normalizeTitleKeywords([upgraded]).length, 1, upgraded);
    const matches = FrontFilter.createKeywordMatcher([upgraded]);
    for (const text of texts) {
      // Upgraded keywords also ignore accents, so they may only match more.
      if (legacyMatch(keyword, text)) {
        assert.equal(matches(text), true, `${keyword} as ${upgraded} in ${text}`);
      } else if (!/[^\x00-\x7f]/.test(keyword + text)) {
        assert.equal(matches(text), false, `${keyword} as ${upgraded} in ${text}`);
      }
    }
  }
});

test("upgrades only settings without a version, and marks them with this one", () => {
  const plainValues = (value) => JSON.parse(JSON.stringify(value));
  const legacy = { blockedTitleKeywords: ["ai"], blockHomepage: true };
  assert.deepEqual(plainValues(FrontFilter.upgradeSettings(legacy)), {
    blockedTitleKeywords: ["*ai*"],
    blockHomepage: true,
    settingsVersion: 2,
  });
  assert.deepEqual(legacy.blockedTitleKeywords, ["ai"]);
  for (const version of [2, 3]) {
    assert.deepEqual(
      plainValues(FrontFilter.upgradeSettings({ settingsVersion: version, blockedTitleKeywords: ["ai"] })),
      { settingsVersion: 2, blockedTitleKeywords: ["ai"] },
    );
  }
  // Values that are not keywords stay for validation to report.
  assert.deepEqual(
    plainValues(FrontFilter.upgradeSettings({ blockedTitleKeywords: ["ai", 7, ""] }).blockedTitleKeywords),
    ["*ai*", 7, ""],
  );
  assert.deepEqual(
    plainValues(FrontFilter.upgradeSettings({ blockedTitleKeywords: "ai" })),
    { blockedTitleKeywords: "ai", settingsVersion: 2 },
  );
  for (const value of [null, [], "x"]) {
    assert.deepEqual(plainValues(FrontFilter.upgradeSettings(value)), { settingsVersion: 2 });
  }
  assert.equal(FrontFilter.STORAGE_KEYS.includes(FrontFilter.SETTINGS_VERSION_KEY), false);
});

test("validates and coerces keywords and allowed keywords", () => {
  const plainKeys = (values) => JSON.parse(JSON.stringify(FrontFilter.getInvalidSettingKeys(values)));
  assert.deepEqual(plainKeys({ blockedTitleKeywords: ["Trump", "/colou?r/"], allowedKeywords: ["biden"] }), []);
  assert.deepEqual(plainKeys({ blockedTitleKeywords: ["/(/"] }), ["blockedTitleKeywords"]);
  assert.deepEqual(
    plainKeys({ allowedKeywords: ["ok", ""] }),
    ["allowedKeywords"],
  );
  assert.deepEqual(plainKeys({ allowedKeywords: "biden" }), ["allowedKeywords"]);
  const settings = FrontFilter.coerceSettings({
    blockedTitleKeywords: ["Trump", "/(/"],
    allowedKeywords: [" Biden ", "BIDEN", 7],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(settings.blockedTitleKeywords)), ["Trump"]);
  assert.deepEqual(JSON.parse(JSON.stringify(settings.allowedKeywords)), ["Biden"]);
  assert.deepEqual(JSON.parse(JSON.stringify(FrontFilter.coerceSettings().allowedKeywords)), []);
});

test("coerces settings without retaining unknown keys", () => {
  const settings = FrontFilter.coerceSettings({
    blockHomepage: true,
    blockAll: true,
    blockNew: true,
    blockTop: true,
    blockNsfw: true,
    unknown: true,
  });

  assert.equal(settings.blockHomepage, true);
  assert.equal("blockAll" in settings, false);
  assert.equal("blockNew" in settings, false);
  assert.equal("blockTop" in settings, false);
  assert.equal("blockNsfw" in settings, false);
  assert.equal("unknown" in settings, false);
});

test("does not read settings inherited through an object's prototype", () => {
  const values = Object.create({ blockHomepage: true });
  assert.equal(FrontFilter.coerceSettings(values).blockHomepage, false);
});

test("reports malformed recognized settings for strict import validation", () => {
  assert.deepEqual(
    Array.from(FrontFilter.getInvalidSettingKeys({
      blockHomepage: "true",
      blockedSubreddits: [{ name: "firefox", mode: "invalid" }],
      allowedSubreddits: ["+news"],
      blockedUsers: ["u/spez", "not a user"],
      blockedTitleKeywords: [""],
      redirectUrl: "javascript:alert(1)",
      scrollLimit: 0,
      theme: "auto",
      unknown: true,
    })),
    [
      "blockedSubreddits",
      "allowedSubreddits",
      "blockedUsers",
      "blockedTitleKeywords",
      "blockHomepage",
      "redirectUrl",
      "scrollLimit",
      "theme",
    ],
  );
  // An address is valid as typed: imports save it with its scheme.
  for (const redirectUrl of ["", "example.com", "https://example.com/path?q=1"]) {
    assert.deepEqual(Array.from(FrontFilter.getInvalidSettingKeys({ redirectUrl })), [], redirectUrl);
  }
  for (const redirectUrl of [" ", null, "ftp://example.com", "not a url"]) {
    assert.deepEqual(
      Array.from(FrontFilter.getInvalidSettingKeys({ redirectUrl })),
      ["redirectUrl"],
      String(redirectUrl),
    );
  }
});

test("keeps only web addresses to redirect to, adding https when the scheme is left out", () => {
  for (const [value, url] of [
    ["example.com", "https://example.com/"],
    ["  example.com/path?q=1#top ", "https://example.com/path?q=1#top"],
    ["http://example.com", "http://example.com/"],
    ["HTTPS://Example.COM/Page", "https://example.com/Page"],
    ["localhost:3000/start", "https://localhost:3000/start"],
    ["www.reddit.com/r/learnprogramming", "https://www.reddit.com/r/learnprogramming"],
  ]) {
    assert.equal(FrontFilter.normalizeRedirectUrl(value), url, value);
  }
  for (const value of [
    "", "   ", null, 42, "javascript:alert(1)", "javascript://%0aalert(1)",
    "data:text/html,hi", "ftp://example.com", "chrome://extensions", "not a url", "https://",
  ]) {
    assert.equal(FrontFilter.normalizeRedirectUrl(value), "", String(value));
  }
  assert.equal(FrontFilter.coerceSettings({ redirectUrl: "example.com" }).redirectUrl, "https://example.com/");
  assert.equal(FrontFilter.coerceSettings({ redirectUrl: "javascript:alert(1)" }).redirectUrl, "");
});

test("redirects blocked pages to the chosen website, unless it is blocked itself", () => {
  const redirect = (settings) => FrontFilter.getBlockRedirectUrl(settings);
  const chosen = { redirectBlockedPages: true, redirectUrl: "https://example.com/" };
  assert.equal(redirect(chosen), "https://example.com/");
  assert.equal(redirect({ ...chosen, blockHomepage: true }), "https://example.com/");
  assert.equal(redirect({ ...chosen, redirectBlockedPages: false }), "");
  assert.equal(redirect({ ...chosen, redirectBlockedPages: "true" }), "");
  assert.equal(redirect({ ...chosen, redirectUrl: "" }), "");
  assert.equal(redirect({ ...chosen, redirectUrl: "javascript:alert(1)" }), "");
  assert.equal(redirect({}), "");

  // A Reddit page that the settings block would only redirect again.
  const reddit = { redirectBlockedPages: true, redirectUrl: "https://www.reddit.com/?feed=home" };
  assert.equal(redirect(reddit), "https://www.reddit.com/?feed=home");
  assert.equal(redirect({ ...reddit, blockHomepage: true }), "");
  const subreddit = { redirectBlockedPages: true, redirectUrl: "https://old.reddit.com/r/learnprogramming/" };
  assert.equal(redirect({ ...subreddit, blockSubHome: true }), "");
  assert.equal(
    redirect({ ...subreddit, blockSubHome: true, allowedSubreddits: ["learnprogramming"] }),
    "https://old.reddit.com/r/learnprogramming/",
  );
  // A site that only looks like Reddit is not checked against Reddit's routes.
  assert.equal(
    redirect({ redirectBlockedPages: true, redirectUrl: "https://notreddit.com/", blockHomepage: true }),
    "https://notreddit.com/",
  );
});

test("returns independent filter collections for each config", () => {
  const first = FrontFilter.coerceSettings();
  first.blockedSubreddits.push({ name: "firefox", mode: "all" });
  first.allowedSubreddits.push("javascript");
  first.blockedTitleKeywords.push("Trump");

  const second = FrontFilter.coerceSettings();

  assert.deepEqual(JSON.parse(JSON.stringify(second.blockedSubreddits)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(second.allowedSubreddits)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(second.blockedTitleKeywords)), []);
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.DEFAULT_SETTINGS.blockedSubreddits)),
    [],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.DEFAULT_SETTINGS.allowedSubreddits)),
    [],
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.DEFAULT_SETTINGS.blockedTitleKeywords)),
    [],
  );
});

test("rejects malformed stored values instead of throwing or enabling flags", () => {
  assert.doesNotThrow(() => FrontFilter.coerceSettings(null));
  assert.doesNotThrow(() => FrontFilter.coerceSettings({ blockedSubreddits: {} }));
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.coerceSettings({
      blockedSubreddits: "firefox",
      blockHomepage: "false",
    }))),
    {
      blockedSubreddits: [],
      allowedSubreddits: [],
      blockedUsers: [],
      blockedTitleKeywords: [],
      allowedKeywords: [],
      blockedFlairs: [],
      allowedFlairs: [],
      blockHomepage: false,
      blockPopular: false,
      blockExplore: false,
      blockNews: false,
      blockSubHome: false,
      hideComments: false,
      hideCommentReplies: false,
      disableAutoplay: false,
      hideSuggestedCommunities: false,
      hideSuggestedPosts: false,
      hideAds: false,
      hideNsfw: false,
      hideSpoilers: false,
      hideSocialSignals: false,
      hideVotes: false,
      hideKarma: false,
      hideAwards: false,
      hideAvatars: false,
      hideUsernames: false,
      hideNavbar: false,
      hideNavbarMenu: false,
      hideNavbarSearch: false,
      hideNavbarChat: false,
      hideNavbarNotifications: false,
      hideNavbarProfile: false,
      hideNavbarOthers: false,
      hideLeftSidebar: false,
      hideLeftSidebarGames: false,
      hideLeftSidebarCustomFeeds: false,
      hideLeftSidebarRecent: false,
      hideLeftSidebarCommunities: false,
      hideLeftSidebarResources: false,
      hideRelatedPosts: false,
      showBlockSubredditButton: false,
      hideBlockPageSettingsButton: false,
      redirectBlockedPages: false,
      redirectUrl: "",
      limitInfiniteScroll: false,
      scrollLimit: 25,
      scrollMode: "fixed",
      limitComments: false,
      commentLimit: 10,
      commentLimitMode: "fixed",
      theme: "system",
      pauseStatistics: false,
    },
  );
});

test("applies only known local-storage changes", () => {
  const settings = FrontFilter.coerceSettings(FrontFilter.applyStorageChanges(
    { blockHomepage: true, blockPopular: true },
    {
      blockHomepage: { oldValue: true, newValue: false },
      unknown: { newValue: true },
    },
  ));

  assert.equal(settings.blockHomepage, false);
  assert.equal(settings.blockPopular, true);
  assert.equal("unknown" in settings, false);
});

test("resets a setting to its default when it is removed from storage", () => {
  const settings = FrontFilter.coerceSettings(FrontFilter.applyStorageChanges(
    { blockHomepage: true, blockedSubreddits: [{ name: "firefox", mode: "all" }] },
    {
      blockHomepage: { oldValue: true },
      blockedSubreddits: { oldValue: [{ name: "firefox", mode: "all" }] },
    },
  ));

  assert.equal(settings.blockHomepage, false);
  assert.deepEqual(JSON.parse(JSON.stringify(settings.blockedSubreddits)), []);
});

test("settings store preserves changes received during its initial load", async () => {
  const initialSettings = deferred();
  let readCount = 0;
  const store = FrontFilter.createSettingsStore({
    get() {
      readCount += 1;
      return initialSettings.promise;
    },
  });

  const firstLoad = store.load();
  const concurrentLoad = store.load();
  store.applyChanges({
    blockHomepage: { oldValue: true, newValue: false },
  });
  initialSettings.resolve({ blockHomepage: true, blockPopular: true });

  assert.equal(firstLoad, concurrentLoad);
  assert.deepEqual(
    JSON.parse(JSON.stringify(await firstLoad)),
    {
      blockedSubreddits: [],
      allowedSubreddits: [],
      blockedUsers: [],
      blockedTitleKeywords: [],
      allowedKeywords: [],
      blockedFlairs: [],
      allowedFlairs: [],
      blockHomepage: false,
      blockPopular: true,
      blockExplore: false,
      blockNews: false,
      blockSubHome: false,
      hideComments: false,
      hideCommentReplies: false,
      disableAutoplay: false,
      hideSuggestedCommunities: false,
      hideSuggestedPosts: false,
      hideAds: false,
      hideNsfw: false,
      hideSpoilers: false,
      hideSocialSignals: false,
      hideVotes: false,
      hideKarma: false,
      hideAwards: false,
      hideAvatars: false,
      hideUsernames: false,
      hideNavbar: false,
      hideNavbarMenu: false,
      hideNavbarSearch: false,
      hideNavbarChat: false,
      hideNavbarNotifications: false,
      hideNavbarProfile: false,
      hideNavbarOthers: false,
      hideLeftSidebar: false,
      hideLeftSidebarGames: false,
      hideLeftSidebarCustomFeeds: false,
      hideLeftSidebarRecent: false,
      hideLeftSidebarCommunities: false,
      hideLeftSidebarResources: false,
      hideRelatedPosts: false,
      showBlockSubredditButton: false,
      hideBlockPageSettingsButton: false,
      redirectBlockedPages: false,
      redirectUrl: "",
      limitInfiniteScroll: false,
      scrollLimit: 25,
      scrollMode: "fixed",
      limitComments: false,
      commentLimit: 10,
      commentLimitMode: "fixed",
      theme: "system",
      pauseStatistics: false,
    },
  );
  await store.load();
  assert.equal(readCount, 1);
});

test("settings store derives implied settings from storage after every change", async () => {
  const store = FrontFilter.createSettingsStore({
    get: async () => ({ hideComments: true, hideNavbar: true, hideNavbarSearch: true }),
  });
  const settings = await store.load();
  assert.equal(settings.hideCommentReplies, true);
  assert.equal(settings.hideNavbarChat, true);

  // A switch turned off alone takes the settings it implied with it, but
  // values stored for those settings remain.
  store.applyChanges({ hideComments: { oldValue: true }, hideNavbar: { oldValue: true, newValue: false } });
  assert.equal(store.get().hideCommentReplies, false);
  assert.equal(store.get().hideNavbarChat, false);
  assert.equal(store.get().hideNavbarSearch, true);
});

test("settings store keeps valid updates when its initial load fails", async () => {
  const errors = [];
  const store = FrontFilter.createSettingsStore(
    { get: async () => { throw new Error("storage unavailable"); } },
    { onLoadError: (error) => errors.push(error.message) },
  );
  store.applyChanges({ blockNews: { newValue: true } });

  const settings = await store.load();

  assert.equal(settings.blockNews, true);
  assert.deepEqual(errors, ["storage unavailable"]);
});

test("hiding all comments implies hiding replies, but replies can be hidden alone", () => {
  const allComments = FrontFilter.coerceSettings({
    hideComments: true,
    hideCommentReplies: false,
  });
  assert.equal(allComments.hideComments, true);
  assert.equal(allComments.hideCommentReplies, true);

  const repliesOnly = FrontFilter.coerceSettings({
    hideComments: false,
    hideCommentReplies: true,
  });
  assert.equal(repliesOnly.hideComments, false);
  assert.equal(repliesOnly.hideCommentReplies, true);
});

test("hiding the navbar implies every section, but sections remain independent", () => {
  const sectionKeys = [
    "hideNavbarMenu",
    "hideNavbarSearch",
    "hideNavbarChat",
    "hideNavbarNotifications",
    "hideNavbarProfile",
    "hideNavbarOthers",
  ];
  const allNavbar = FrontFilter.coerceSettings({
    hideNavbar: true,
    ...Object.fromEntries(sectionKeys.map((key) => [key, false])),
  });
  assert.equal(allNavbar.hideNavbar, true);
  for (const key of sectionKeys) assert.equal(allNavbar[key], true);

  const searchOnly = FrontFilter.coerceSettings({
    hideNavbar: false,
    hideNavbarSearch: true,
  });
  assert.equal(searchOnly.hideNavbar, false);
  assert.equal(searchOnly.hideNavbarSearch, true);
  for (const key of sectionKeys.filter((key) => key !== "hideNavbarSearch")) {
    assert.equal(searchOnly[key], false);
  }
});

test("hiding the left sidebar implies every section, but sections remain independent", () => {
  const sectionKeys = [
    "hideLeftSidebarGames",
    "hideLeftSidebarCustomFeeds",
    "hideLeftSidebarRecent",
    "hideLeftSidebarCommunities",
    "hideLeftSidebarResources",
  ];
  const allSidebar = FrontFilter.coerceSettings({
    hideLeftSidebar: true,
    ...Object.fromEntries(sectionKeys.map((key) => [key, false])),
  });
  assert.equal(allSidebar.hideLeftSidebar, true);
  for (const key of sectionKeys) assert.equal(allSidebar[key], true);

  const gamesOnly = FrontFilter.coerceSettings({
    hideLeftSidebar: false,
    hideLeftSidebarGames: true,
  });
  assert.equal(gamesOnly.hideLeftSidebar, false);
  assert.equal(gamesOnly.hideLeftSidebarGames, true);
  for (const key of sectionKeys.slice(1)) assert.equal(gamesOnly[key], false);
});

test("hiding votes and user info implies every signal, but signals remain independent", () => {
  const signalKeys = [
    "hideVotes",
    "hideKarma",
    "hideAwards",
    "hideAvatars",
    "hideUsernames",
  ];
  const allSignals = FrontFilter.coerceSettings({
    hideSocialSignals: true,
    ...Object.fromEntries(signalKeys.map((key) => [key, false])),
  });
  assert.equal(allSignals.hideSocialSignals, true);
  for (const key of signalKeys) assert.equal(allSignals[key], true);

  const karmaOnly = FrontFilter.coerceSettings({
    hideSocialSignals: false,
    hideKarma: true,
  });
  assert.equal(karmaOnly.hideSocialSignals, false);
  assert.equal(karmaOnly.hideKarma, true);
  for (const key of signalKeys.filter((key) => key !== "hideKarma")) {
    assert.equal(karmaOnly[key], false);
  }
});

// Values created in the VM context have their own Array prototype.
const plain = (value) => JSON.parse(JSON.stringify(value));

test("normalizes blocked flairs and matches them case-insensitively with wildcards", () => {
  assert.deepEqual(
    plain(FrontFilter.normalizeBlockedFlairs([" Meme ", "meme", "*Politic*", "", "x".repeat(101)])),
    ["Meme", "*Politic*"],
  );
  assert.equal(FrontFilter.matchesFlairPattern("meme", "  MEME "), true);
  assert.equal(FrontFilter.matchesFlairPattern("meme", "Memes"), false);
  assert.equal(FrontFilter.matchesFlairPattern("*politic*", "US Politics"), true);
  assert.equal(FrontFilter.matchesFlairPattern("Question (Serious)", "question  (serious)"), true);
  assert.equal(FrontFilter.matchesFlairPattern("*", ""), false);
});

test("collapses whitespace in text and ignores values that are not text", () => {
  assert.equal(FrontFilter.normalizeText("  Question \n\t (Serious) "), "Question (Serious)");
  for (const value of [null, undefined, 42, {}]) {
    assert.equal(FrontFilter.normalizeText(value), "");
  }
});

test("validates and coerces blocked flairs", () => {
  assert.deepEqual(plain(FrontFilter.getInvalidSettingKeys({ blockedFlairs: ["Meme"] })), []);
  assert.deepEqual(plain(FrontFilter.getInvalidSettingKeys({ blockedFlairs: [3] })), ["blockedFlairs"]);
  assert.deepEqual(plain(FrontFilter.getInvalidSettingKeys({ blockedFlairs: "Meme" })), ["blockedFlairs"]);
  const settings = FrontFilter.coerceSettings({ blockedFlairs: [" Meme ", "meme", 7] });
  assert.deepEqual(plain(settings.blockedFlairs), ["Meme"]);
});

test("one-click blocks add an ALL rule, or upgrade a HOME rule, and undo restores the rules", () => {
  const rules = [{ name: "pics", mode: "home" }, { name: "news", mode: "home" }];
  const upgraded = FrontFilter.addBlockedSubreddit(rules, "r/News");
  assert.equal(upgraded.added, true);
  assert.equal(upgraded.previousMode, "home");
  assert.deepEqual(plain(upgraded.entries), [
    { name: "pics", mode: "home" },
    { name: "news", mode: "all" },
  ]);
  assert.deepEqual(
    plain(FrontFilter.undoBlockedSubreddit(upgraded.entries, "NEWS", upgraded.previousMode)),
    rules,
  );

  const added = FrontFilter.addBlockedSubreddit(rules, "gaming");
  assert.equal(added.added, true);
  assert.equal(added.previousMode, null);
  assert.deepEqual(plain(added.entries), [...rules, { name: "gaming", mode: "all" }]);
  assert.deepEqual(plain(FrontFilter.undoBlockedSubreddit(added.entries, "gaming", null)), rules);

  const again = FrontFilter.addBlockedSubreddit(upgraded.entries, "news");
  assert.equal(again.added, false);
  assert.deepEqual(plain(again.entries), plain(upgraded.entries));
  assert.equal(FrontFilter.addBlockedSubreddit([], "*news*").added, false);
  assert.equal(FrontFilter.addBlockedSubreddit([], "").added, false);
  // Undo never touches a HOME rule.
  assert.deepEqual(plain(FrontFilter.undoBlockedSubreddit(rules, "news", null)), rules);
});

test("accepts only HTTP(S) Reddit URLs", () => {
  assert.equal(
    FrontFilter.getRedditUrl("/r/firefox", "https://old.reddit.com").href,
    "https://old.reddit.com/r/firefox",
  );
  assert.equal(FrontFilter.getRedditUrl("https://example.com/r/firefox"), null);
  assert.equal(FrontFilter.getRedditUrl("ftp://reddit.com/r/firefox"), null);
  assert.equal(FrontFilter.getRedditUrl("https://reddit.com.evil.example/r/firefox"), null);
  assert.equal(FrontFilter.getRedditUrl("not a URL"), null);
});

test("parses subreddit paths and their remaining segments", () => {
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.getSubredditPath("/r/Firefox/TOP/week/"))),
    { name: "firefox", rest: "top/week" },
  );
  assert.equal(FrontFilter.getSubredditPath("/user/firefox"), null);
  assert.equal(FrontFilter.getSubredditPath("/r/***"), null);
  assert.equal(FrontFilter.getSubredditPath(null), null);
});

test("recognizes page and subreddit blocking routes", () => {
  const popular = FrontFilter.getBlockedRoute("/r/popular/new", { blockPopular: true });
  assert.deepEqual({ type: popular.type, page: popular.page }, { type: "page", page: "popular" });
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.getBlockedRoute("/r/firefox/comments/abc/post", {
      blockedSubreddits: [{ name: "fire*", mode: "all" }],
    }))),
    { type: "subreddit", subreddit: "firefox", filter: "fire*" },
  );
  assert.equal(
    FrontFilter.getBlockedRoute("/r/firefox/comments/abc/post", {
      blockedSubreddits: [{ name: "firefox", mode: "home" }],
    }),
    null,
  );
});

test("finds the user a profile page belongs to", () => {
  for (const [pathname, user] of [
    ["/user/Spez", "spez"],
    ["/user/spez/", "spez"],
    ["/u/spez/comments/", "spez"],
    ["/user/spez/comments/abc/title/", "spez"],
    ["/r/u_Spez/", "spez"],
    ["/r/u_spez/comments/abc/title", "spez"],
    ["/r/spez/", ""],
    ["/user/", ""],
    ["/users/spez", ""],
    ["/r/firefox/comments/abc/title", ""],
    [null, ""],
  ]) {
    assert.equal(FrontFilter.getProfileUser(pathname), user, String(pathname));
  }
});

test("blocks the profile pages of blocked users", () => {
  const settings = { blockedUsers: ["spez"] };
  for (const pathname of ["/user/spez", "/u/Spez/submitted/", "/r/u_spez/", "/user/spez/comments/abc/t"]) {
    assert.deepEqual(plain(FrontFilter.getBlockedRoute(pathname, settings)), { type: "user", user: "spez" }, pathname);
  }
  for (const pathname of ["/user/spezz", "/user/kn0thing", "/r/spez", "/", "/r/firefox/comments/abc/t"]) {
    assert.equal(FrontFilter.getBlockedRoute(pathname, settings), null, pathname);
  }
  // Subreddit exceptions are for subreddits, not for users' profiles.
  assert.equal(
    FrontFilter.getBlockedRoute("/r/u_spez", { ...settings, allowedSubreddits: ["u_spez"] })?.type,
    "user",
  );
});

test("subreddit exceptions override global fronts and wildcard block rules", () => {
  const settings = {
    blockSubHome: true,
    blockedSubreddits: [{ name: "*italy*", mode: "all" }],
    allowedSubreddits: ["ItalyPersonalFinance"],
  };

  for (const pathname of [
    "/r/italypersonalfinance",
    "/r/ItalyPersonalFinance/top/?t=week",
    "/r/italypersonalfinance/comments/abc/post",
  ]) {
    assert.equal(FrontFilter.getBlockedRoute(pathname, settings), null, pathname);
  }
  assert.equal(
    FrontFilter.getBlockedRoute("/r/italytravel", settings),
    FrontFilter.SUBREDDIT_FRONTS_ROUTE,
  );
  assert.equal(
    FrontFilter.getBlockedRoute("/r/italytravel/comments/abc/post", settings)?.filter,
    "*italy*",
  );
});

test("global page blocks take precedence over subreddit exceptions", () => {
  const route = FrontFilter.getBlockedRoute("/r/popular", {
    blockPopular: true,
    blockSubHome: true,
    blockedSubreddits: [{ name: "popular", mode: "all" }],
    allowedSubreddits: ["popular"],
  });

  assert.equal(route?.page, "popular");
});

test("covers every main-page route without matching similar paths", () => {
  const cases = [
    ["/", { blockHomepage: true }, "homepage"],
    ["/new", { blockHomepage: true }, "homepage"],
    ["/top/", { blockHomepage: true }, "homepage"],
    ["/r/popular/new", { blockPopular: true }, "popular"],
    ["/explore/topics", { blockExplore: true }, "explore"],
    ["/news/world", { blockNews: true }, "news"],
  ];

  for (const [pathname, settings, page] of cases) {
    assert.equal(FrontFilter.getBlockedRoute(pathname, settings).page, page);
  }

  assert.equal(FrontFilter.getBlockedRoute("/explorer", { blockExplore: true }), null);
  assert.equal(FrontFilter.getBlockedRoute("/newsletter", { blockNews: true }), null);
  assert.equal(FrontFilter.getBlockedRoute("/newest", { blockHomepage: true }), null);
});

test("distinguishes subreddit fronts from posts for HOME and ALL modes", () => {
  const homeSettings = {
    blockedSubreddits: [{ name: "firefox", mode: "home" }],
  };

  for (const pathname of ["/r/firefox", "/r/firefox/hot", "/r/firefox/top/week"]) {
    assert.equal(FrontFilter.getBlockedRoute(pathname, homeSettings)?.subreddit, "firefox");
  }
  assert.equal(
    FrontFilter.getBlockedRoute("/r/firefox/comments/abc/post", homeSettings),
    null,
  );
  assert.equal(
    FrontFilter.getBlockedRoute("/r/firefox/comments/abc/post", {
      blockedSubreddits: [{ name: "firefox", mode: "all" }],
    })?.subreddit,
    "firefox",
  );
  assert.equal(
    FrontFilter.getBlockedRoute("/r/firefox/rising", { blockSubHome: true }),
    FrontFilter.SUBREDDIT_FRONTS_ROUTE,
  );
});

test("serializes block details into the block page query", () => {
  // Navigation rules cannot name the subreddit; the page then reads it
  // from the blocked URL in the fragment.
  assert.equal(
    FrontFilter.blockPageQuery({ type: "subreddit", subreddit: "firefox", filter: "fire*" }),
    "?target=subreddit&subreddit=firefox&filter=fire*",
  );
  assert.equal(
    FrontFilter.blockPageQuery({ type: "subreddit", filter: "fire*" }),
    "?target=subreddit&filter=fire*",
  );
  assert.equal(
    FrontFilter.blockPageQuery(FrontFilter.SUBREDDIT_FRONTS_ROUTE),
    "?page=subhome",
  );
  assert.equal(FrontFilter.blockPageQuery({ type: "user", user: "spez" }), "?target=user&user=spez");
  assert.equal(FrontFilter.blockPageQuery(null), "");
});

test("opens the settings page in a tab of its own, for a subreddit", () => {
  assert.equal(FrontFilter.settingsPagePath(), "popup/index.html?standalone=true");
  assert.equal(
    FrontFilter.settingsPagePath("r/Firefox"),
    "popup/index.html?standalone=true&currentSubreddit=firefox",
  );
  assert.equal(
    FrontFilter.settingsPagePath("firefox", { importing: true }),
    "popup/index.html?standalone=true&currentSubreddit=firefox&import=true",
  );
  assert.equal(FrontFilter.settingsPagePath("", { importing: "yes" }), "popup/index.html?standalone=true");
  for (const invalid of ["fire*", "", "https://example.com/r/firefox", 42]) {
    assert.equal(FrontFilter.settingsPagePath(invalid), "popup/index.html?standalone=true", invalid);
  }
});

test("lists each blockable main page once, with its setting", () => {
  for (const route of FrontFilter.PAGE_ROUTES) {
    assert.ok(Object.isFrozen(route), route.page);
    assert.equal(route.type, "page");
    assert.equal(FrontFilter.DEFAULT_SETTINGS[route.key], false, route.key);
  }
  assert.deepEqual(
    JSON.parse(JSON.stringify(FrontFilter.PAGE_ROUTES.map(({ page }) => page))),
    ["homepage", "popular", "explore", "news"],
  );
});

test("normalizes typed scroll and comment limits and resets removed values", () => {
  for (const [count, mode, defaultCount] of [
    ["scrollLimit", "scrollMode", 25],
    ["commentLimit", "commentLimitMode", 10],
  ]) {
    assert.equal(FrontFilter.coerceSettings({ [count]: 1 })[count], 1);
    for (const value of [0, -1, 2.5, "10", null, true, Infinity, NaN, 2 ** 53]) {
      assert.equal(FrontFilter.coerceSettings({ [count]: value })[count], defaultCount, `${count}: ${value}`);
    }
    assert.equal(FrontFilter.coerceSettings({ [mode]: "button" })[mode], "button");
    assert.equal(FrontFilter.coerceSettings({ [mode]: "other" })[mode], "fixed");
    const settings = FrontFilter.coerceSettings(FrontFilter.applyStorageChanges({ [count]: 7, [mode]: "button" }, {
      [count]: { oldValue: 7 }, [mode]: { oldValue: "button" },
    }));
    assert.equal(settings[count], defaultCount);
    assert.equal(settings[mode], "fixed");
  }
  assert.deepEqual(Array.from(FrontFilter.getInvalidSettingKeys({
    limitComments: "yes", commentLimit: 0, commentLimitMode: "auto",
  })), ["limitComments", "commentLimit", "commentLimitMode"]);
  assert.deepEqual(Array.from(FrontFilter.getInvalidSettingKeys({
    limitComments: true, commentLimit: 3, commentLimitMode: "button",
  })), []);
});

test("normalizes color themes and resets removed themes to system", () => {
  for (const theme of ["system", "dark", "light"]) {
    assert.equal(FrontFilter.coerceSettings({ theme }).theme, theme);
    assert.deepEqual(plain(FrontFilter.getInvalidSettingKeys({ theme })), []);
  }
  for (const theme of ["white", "auto", "", null, true]) {
    assert.equal(FrontFilter.coerceSettings({ theme }).theme, "system");
    assert.deepEqual(plain(FrontFilter.getInvalidSettingKeys({ theme })), ["theme"]);
  }

  const settings = FrontFilter.coerceSettings(FrontFilter.applyStorageChanges(
    { theme: "dark" },
    { theme: { oldValue: "dark" } },
  ));
  assert.equal(settings.theme, "system");
});

test("limits listing routes without treating comments, wiki or settings as feeds", () => {
  for (const path of [
    "/", "/best", "/hot", "/new", "/top", "/rising", "/controversial",
    "/r/popular/", "/r/firefox", "/r/firefox/new/",
  ]) {
    assert.equal(FrontFilter.isFeedPath(path), true, path);
  }
  for (const path of [
    "/r/firefox/comments/abc/post", "/r/firefox/wiki", "/settings",
    "/message/inbox", "/r/firefox/top/extra",
  ]) {
    assert.equal(FrontFilter.isFeedPath(path), false, path);
  }
});

test("recognizes post pages, where comments are, in subreddits and on profiles", () => {
  for (const path of [
    "/r/firefox/comments/abc/post", "/r/firefox/comments/abc/post/", "/r/firefox/comments/abc",
    "/r/firefox/comments/abc/post/def/", "/r/firefox/comments/abc/comment/def/",
    "/user/spez/comments/abc/post/", "/u/spez/comments/abc/", "/R/Firefox/Comments/ABC/",
  ]) {
    assert.equal(FrontFilter.isCommentsPath(path), true, path);
  }
  for (const path of [
    "/", "/r/firefox/", "/r/firefox/new/", "/r/firefox/comments/", "/user/spez/comments/",
    "/user/spez/", "/comments/abc/", "/r/firefox/wiki/comments/abc/", "/search/?q=comments",
  ]) {
    assert.equal(FrontFilter.isCommentsPath(path), false, path);
  }
});

test("recognizes only the Home feed and its sort views as the Home feed", () => {
  for (const path of ["/", "/best", "/hot/", "/NEW", "/top", "/rising"]) {
    assert.equal(FrontFilter.isHomeFeedPath(path), true, path);
  }
  for (const path of [
    "/r/popular/", "/r/all/", "/r/firefox/", "/explore/", "/news/",
    "/r/firefox/comments/abc/post", "/user/alice/", "/best/extra",
  ]) {
    assert.equal(FrontFilter.isHomeFeedPath(path), false, path);
  }
});
