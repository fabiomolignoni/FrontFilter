/**
 * Helpers for the unit tests, which run the extension's scripts in vm
 * contexts with fake browser APIs. Extension pages get a fake document built
 * from their real markup, so tests use the ids, names and structure the
 * scripts rely on.
 */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const SOURCE = join(__dirname, "..", "..", "src");

function readSource(file) {
  return readFileSync(join(SOURCE, file), "utf8");
}

// Runs extension scripts in order, as a page or the manifest loads them.
function runScripts(context, files) {
  for (const file of files) {
    vm.runInContext(readSource(file), context, { filename: file });
  }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, reject, resolve };
}

// Lets pending promise callbacks run.
function settle() {
  return new Promise((resolve) => setImmediate(resolve));
}

// Compound selectors (tag, #id, .class, [name] and [name="value"]), joined
// by descendant combinators and commas: what the pages' scripts query.
function matchesCompound(element, compound) {
  const parts = compound.match(/^[\w-]+|#[\w-]+|\.[\w-]+|\[[^\]]+\]/g) || [];
  if (parts.join("") !== compound) throw new Error(`Unsupported selector: ${compound}`);
  return parts.every((part) => {
    if (part[0] === "#") return element.id === part.slice(1);
    if (part[0] === ".") return element.classList.contains(part.slice(1));
    if (part[0] === "[") {
      const [, name, value] = part.match(/^\[([\w-]+)(?:="([^"]*)")?\]$/);
      return value === undefined ? element.hasAttribute(name) : element.getAttribute(name) === value;
    }
    return element.localName === part.toLowerCase();
  });
}

function matchesSelector(element, selector) {
  return selector.split(",").some((complex) => {
    const compounds = complex.trim().split(/\s+/);
    if (!matchesCompound(element, compounds.at(-1))) return false;
    let ancestor = element.parentElement;
    for (const compound of compounds.slice(0, -1).reverse()) {
      while (ancestor && !matchesCompound(ancestor, compound)) ancestor = ancestor.parentElement;
      if (!ancestor) return false;
      ancestor = ancestor.parentElement;
    }
    return true;
  });
}

class FakeElement {
  constructor(tagName, attributes = {}) {
    this.localName = tagName.toLowerCase();
    this.tagName = tagName.toUpperCase();
    this.attributes = {};
    this.children = [];
    this.parentElement = null;
    this.listeners = {};
    this.dataset = {};
    this.text = "";
    this.checked = "checked" in attributes;
    this.disabled = "disabled" in attributes;
    this.hidden = "hidden" in attributes;
    this.indeterminate = false;
    this.selected = "selected" in attributes;
    this.value = attributes.value ?? "";
    this.files = [];
    this.focused = false;
    this.tabIndex = Number(attributes.tabindex ?? 0);
    for (const [name, value] of Object.entries(attributes)) this.setAttribute(name, value);
  }

  get id() { return this.getAttribute("id") ?? ""; }
  set id(value) { this.setAttribute("id", value); }
  get className() { return this.getAttribute("class") ?? ""; }
  set className(value) { this.setAttribute("class", value); }
  get name() { return this.getAttribute("name") ?? ""; }
  set name(value) { this.setAttribute("name", value); }
  get type() { return this.getAttribute("type") ?? ""; }
  set type(value) { this.setAttribute("type", value); }

  get classList() {
    const names = () => this.className.split(/\s+/).filter(Boolean);
    const update = (list) => { this.className = Array.from(new Set(list)).join(" "); };
    return {
      add: (...added) => update([...names(), ...added]),
      remove: (...removed) => update(names().filter((name) => !removed.includes(name))),
      contains: (name) => names().includes(name),
    };
  }

  get textContent() {
    return this.text + this.children.map((child) => child.textContent).join("");
  }

  set textContent(value) {
    this.text = String(value);
    this.children = [];
  }

  getAttribute(name) { return this.attributes[name] ?? null; }
  hasAttribute(name) { return name in this.attributes; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  removeAttribute(name) { delete this.attributes[name]; }

  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (typeof node === "string") this.appendChild({ textContent: node });
      else this.appendChild(node);
    }
  }

  prepend(...nodes) {
    const existing = this.children;
    this.children = [];
    this.append(...nodes);
    this.children.push(...existing);
  }

  before(node) {
    node.remove?.();
    const siblings = this.parentElement.children;
    siblings.splice(siblings.indexOf(this), 0, node);
    node.parentElement = this.parentElement;
  }

  get previousElementSibling() {
    const siblings = this.parentElement?.children.filter((child) => child instanceof FakeElement) || [];
    return siblings[siblings.indexOf(this) - 1] || null;
  }

  get lastElementChild() {
    return this.children.filter((child) => child instanceof FakeElement).at(-1) || null;
  }

  remove() {
    if (!this.parentElement) return;
    this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }

  replaceChildren(...nodes) {
    this.text = "";
    this.children = [];
    this.append(...nodes);
  }

  addEventListener(type, listener) {
    (this.listeners[type] ??= []).push(listener);
  }

  // Calls the listeners for an event and returns what the last returned,
  // so tests can await asynchronous handlers.
  dispatch(type, event = {}) {
    let result;
    for (const listener of this.listeners[type] || []) {
      result = listener({ target: this, ...event });
    }
    return result;
  }

  click() {
    this.clickCount = (this.clickCount || 0) + 1;
    return this.dispatch("click");
  }

  focus() {
    this.focused = true;
  }

  matches(selector) {
    return matchesSelector(this, selector);
  }

  querySelectorAll(selector) {
    const scoped = selector.match(/^:scope\s*>\s*(.+)$/);
    if (scoped) {
      return this.children.filter((child) => child instanceof FakeElement && child.matches(scoped[1]));
    }
    const found = [];
    const visit = (element) => {
      for (const child of element.children) {
        if (!(child instanceof FakeElement)) continue;
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

const VOID_ELEMENTS = new Set(["img", "input", "link", "meta", "br", "hr"]);
const MARKUP = /<!--[\s\S]*?-->|<![^>]*>|<\/([\w-]+)\s*>|<([\w-]+)((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*(\/?)>|([^<]+)/g;
const ATTRIBUTE = /([^\s=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;

function parseHtml(html) {
  const root = new FakeElement("#document");
  const open = [root];
  for (const [, closing, tag, attributeSource, selfClosing, text] of html.matchAll(MARKUP)) {
    if (closing) {
      const index = open.findLastIndex((element) => element.localName === closing.toLowerCase());
      if (index > 0) open.length = index;
    } else if (tag) {
      const attributes = Object.fromEntries(Array.from(
        attributeSource.matchAll(ATTRIBUTE),
        ([, name, double, single, bare]) => [name, double ?? single ?? bare ?? ""],
      ));
      const element = open.at(-1).appendChild(new FakeElement(tag, attributes));
      if (!selfClosing && !VOID_ELEMENTS.has(element.localName)) open.push(element);
    } else if (text && open.length > 1) {
      open.at(-1).text += text.replace(/\s+/g, " ");
    }
  }
  return root;
}

// A fake document built from markup. Its DOMContentLoaded listeners run
// when the test calls ready().
function createDocument(html) {
  const root = parseHtml(html);
  const documentElement = root.querySelector("html");
  const readyListeners = [];
  const created = [];
  const document = {
    documentElement,
    body: root.querySelector("body"),
    addEventListener(type, listener) {
      if (type === "DOMContentLoaded") readyListeners.push(listener);
    },
    createElement(tagName) {
      const element = new FakeElement(tagName);
      created.push(element);
      return element;
    },
    getElementById: (id) => root.querySelector(`#${id}`),
    querySelector: (selector) => root.querySelector(selector),
    querySelectorAll: (selector) => root.querySelectorAll(selector),
  };
  // Elements by id, as tests read them.
  const elements = new Proxy({}, { get: (_, id) => document.getElementById(id) });
  return {
    created,
    document,
    elements,
    ready: () => readyListeners.forEach((listener) => listener()),
  };
}

// The fake document for an extension page, built from its real markup.
function loadPage(file) {
  return createDocument(readSource(file));
}

module.exports = {
  FakeElement,
  createDocument,
  deferred,
  loadPage,
  readSource,
  runScripts,
  settle,
};
