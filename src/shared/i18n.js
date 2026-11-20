/**
 * FrontFilter's interface text. By default it speaks the browser's
 * language, when FrontFilter has a translation for it, and English
 * otherwise: browsers pick the messages from _locales/ themselves. A
 * language chosen in the settings loads its messages instead, over
 * English's for any it lacks. Scripts ask for messages by name; extension
 * pages mark their text with data-i18n attributes, which localizePage fills.
 *
 * A message that counts has a form for each plural category its language
 * uses, as name_one and name_other in English, and takes the count as its
 * first placeholder: plural() picks the form the count takes.
 */
FrontFilter.i18n = (() => {
  // The browser's language, as browsers pick it.
  const SYSTEM = "system";
  // The attributes a page names messages for, as data-i18n-title does.
  const ATTRIBUTES = Object.freeze(["title", "aria-label"]);
  // The markup a page's message may hold: these tags alone, which become
  // elements. Anything else stays text.
  const MARKUP = /<(strong|code)>([^<]*)<\/\1>/g;
  // Extension pages keep their language in local storage, as their theme,
  // since it reads at once: extension storage answers later.
  const PAGE_CACHE_KEY = "frontfilter-language";
  const PENDING_ATTRIBUTE = "data-i18n-pending";

  // The language setting in use, and for a chosen language its messages,
  // by name in lower case, as browsers look them up.
  let setting = SYSTEM;
  let messages = null;
  // The language an extension page started in, as cached for it.
  let pageStart = null;
  let switches = 0;
  let language;
  let locale;
  let numbers;
  let pluralRules;

  // A message with its placeholders filled as browsers fill them: each
  // $name$ takes its placeholder's content, in which $1 to $9 are the
  // substitutions, and $$ is a dollar sign.
  function fill({ message, placeholders = {} }, substitutions) {
    return message.replace(/\$\$|\$([\w@]+)\$/g, (match, name) => {
      if (match === "$$") return "$";
      const content = placeholders[name.toLowerCase()];
      if (content === undefined) return match;
      return content.replace(/\$([1-9])/g, (_, index) => substitutions[index - 1] ?? "");
    });
  }

  function getMessage(name, substitutions) {
    if (messages) {
      const entry = messages.get(name.toLowerCase());
      return entry ? fill(entry, substitutions) : "";
    }
    try {
      return chrome.i18n.getMessage(name, substitutions) || "";
    } catch {
      return "";
    }
  }

  // The messages' language, which each translation names, and how its
  // dates and numbers read: in the browser's variant of it, such as
  // British English, when it has one. A translation for a region, such as
  // Brazilian Portuguese, writes them as that region does.
  function configure() {
    language = getMessage("languageTag", []) || "en";
    locale = language;
    try {
      const [browser] = Intl.getCanonicalLocales(chrome.i18n.getUILanguage());
      const own = new Intl.Locale(language);
      if (!own.region && new Intl.Locale(browser).language === own.language) locale = browser;
    } catch {
      // Without the browser's language, the messages' own.
    }
    numbers = new Intl.NumberFormat(locale);
    pluralRules = new Intl.PluralRules(language);
  }
  configure();

  function formatNumber(number) {
    return numbers.format(number);
  }

  // A message, with its placeholders filled by the substitutions, in order.
  // A message missing from every language shows its name.
  function t(name, ...substitutions) {
    return getMessage(name, substitutions.map(String)) || name;
  }

  // A message that counts, in the form its count takes, with the count,
  // formatted, as its first substitution. A translation without the form
  // falls back to its other form.
  function plural(name, count, ...substitutions) {
    const values = [formatNumber(count), ...substitutions].map(String);
    return getMessage(`${name}_${pluralRules.select(count)}`, values)
      || getMessage(`${name}_other`, values)
      || name;
  }

  // A message with nodes, such as elements, among its substitutions: what
  // to append, in order. Each node takes its place in the message.
  function parts(name, ...substitutions) {
    const isNode = (value) => value !== null && typeof value === "object";
    const mark = (index) => String.fromCharCode(0xE000 + index);
    const text = t(name, ...substitutions.map((value, index) => (isNode(value) ? mark(index) : value)));
    const pieces = [];
    let rest = text;
    substitutions.forEach((value, index) => {
      if (!isNode(value)) return;
      const at = rest.indexOf(mark(index));
      if (at === -1) return;
      pieces.push(rest.slice(0, at), value);
      rest = rest.slice(at + 1);
    });
    pieces.push(rest);
    return pieces.filter((piece) => piece !== "");
  }

  // A language's messages, from its folder, over English's for any it
  // lacks, with only what getMessage reads: small enough for the content
  // scripts, which ask the background for them.
  async function fetchMessages(tag) {
    const read = async (folder) => {
      const response = await fetch(chrome.runtime.getURL(`_locales/${folder}/messages.json`));
      if (!response.ok) throw new Error(`no messages for ${folder}`);
      return response.json();
    };
    const [english, own] = await Promise.all([read("en"), tag === "en" ? {} : read(tag.replace("-", "_"))]);
    return Object.fromEntries(Object.entries({ ...english, ...own }).map(([name, entry]) => [name, {
      message: entry.message,
      ...(entry.placeholders && {
        placeholders: Object.fromEntries(Object.entries(entry.placeholders)
          .map(([placeholder, { content }]) => [placeholder.toLowerCase(), content])),
      }),
    }]));
  }

  // Speaks the language a setting names: the browser's, or one of
  // FrontFilter.LANGUAGES, once its messages load. Returns whether the
  // language changed; one whose messages cannot load leaves it as it was.
  async function use(value, load = fetchMessages) {
    const next = FrontFilter.LANGUAGES.includes(value) ? value : SYSTEM;
    const switchId = ++switches;
    if (next === setting) return false;
    let loaded = null;
    if (next !== SYSTEM) {
      try {
        loaded = await load(next);
        if (!loaded || typeof loaded !== "object") throw new Error("no messages");
      } catch (error) {
        console.error(`Could not load FrontFilter's ${next} messages:`, error);
        return false;
      }
    }
    // A later setting wins over one still loading.
    if (switchId !== switches) return false;
    setting = next;
    messages = loaded && new Map(Object.entries(loaded).map(([name, entry]) => [name.toLowerCase(), entry]));
    configure();
    return true;
  }

  // An extension page starts in the language cached for it, hidden while
  // a chosen language's messages load. Without a cache, as on the page's
  // first load, it speaks the browser's language until its settings say.
  function startPage(document) {
    let cached = null;
    try {
      cached = globalThis.localStorage?.getItem(PAGE_CACHE_KEY);
    } catch {
      // Without local storage, pages speak the browser's language.
    }
    pageStart = FrontFilter.LANGUAGES.includes(cached) ? cached : SYSTEM;
    if (pageStart !== SYSTEM) document.documentElement.setAttribute(PENDING_ATTRIBUTE, "");
    return use(pageStart, fetchMessages);
  }

  // Caches the language a setting names for extension pages' next loads,
  // and tells whether this page should load again to speak it. Loading
  // again would not help a page that started in that language and could
  // not load it, nor one whose cache cannot keep it.
  function pageNeedsReload(value) {
    const next = FrontFilter.LANGUAGES.includes(value) ? value : SYSTEM;
    let cached = false;
    try {
      globalThis.localStorage.setItem(PAGE_CACHE_KEY, next);
      cached = globalThis.localStorage.getItem(PAGE_CACHE_KEY) === next;
    } catch {
      // The page keeps speaking its language.
    }
    return cached && next !== setting && next !== pageStart;
  }

  // A page's message as nodes: its text, with the markup it may hold.
  function nodesOf(document, text) {
    const nodes = [];
    let last = 0;
    for (const match of text.matchAll(MARKUP)) {
      if (match.index > last) nodes.push(text.slice(last, match.index));
      const element = document.createElement(match[1]);
      element.textContent = match[2];
      nodes.push(element);
      last = match.index + match[0].length;
    }
    if (last < text.length) nodes.push(text.slice(last));
    return nodes;
  }

  // Fills a page's text with its messages: each element with data-i18n
  // shows the message it names, and data-i18n-title and the like set
  // those attributes. The page says which language it shows, and shows.
  function localizePage(document) {
    const root = document.documentElement;
    root.setAttribute("lang", language);
    for (const element of document.querySelectorAll("[data-i18n]")) {
      element.replaceChildren(...nodesOf(document, t(element.getAttribute("data-i18n"))));
    }
    for (const attribute of ATTRIBUTES) {
      for (const element of document.querySelectorAll(`[data-i18n-${attribute}]`)) {
        element.setAttribute(attribute, t(element.getAttribute(`data-i18n-${attribute}`)));
      }
    }
    root.removeAttribute(PENDING_ATTRIBUTE);
  }

  // The languages to choose from, each named in its own language, with
  // its region in brackets where it has one: Português (Portugal), as
  // browsers list them, rather than a name of its own.
  function languageNames() {
    return FrontFilter.LANGUAGES.map((tag) => {
      let name = tag;
      try {
        name = new Intl.DisplayNames([tag], { type: "language", languageDisplay: "standard" }).of(tag) || tag;
      } catch {
        // Without display names, the language's tag.
      }
      return { tag, name: name.charAt(0).toLocaleUpperCase(tag) + name.slice(1) };
    });
  }

  return Object.freeze({
    ATTRIBUTES,
    SYSTEM,
    get setting() { return setting; },
    get language() { return language; },
    get locale() { return locale; },
    formatNumber,
    t,
    plural,
    parts,
    fetchMessages,
    use,
    startPage,
    pageNeedsReload,
    localizePage,
    languageNames,
  });
})();
