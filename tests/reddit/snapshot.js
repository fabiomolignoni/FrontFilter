/**
 * Serializes the current page for comparison with the test fixtures.
 *
 * Runs inside a Reddit page and returns { html, inventory }. Open shadow
 * roots become declarative shadow DOM, so a saved snapshot renders with its
 * components' internal structure. Scripts, styles, media and icons are
 * dropped, and every piece of user content is redacted: text, URLs to user
 * profiles, query strings, user-related attributes and string values inside
 * JSON attributes. Tag names, attribute names and structural values (slots,
 * test IDs, nouns, component names) are kept, since the extension relies on
 * them. Run with `return snapshotPage();` appended.
 */
function snapshotPage() {
  "use strict";

  const SKIPPED = new Set(["script", "style", "noscript", "iframe", "link", "meta", "template"]);
  const EMPTIED = new Set(["svg", "img", "video", "audio", "picture", "source", "canvas"]);
  const DROPPED_ATTRIBUTES = new Set(["srcset", "style", "nonce", "integrity", "poster"]);
  // Labels and titles can quote user names, as in arialabel="Comment from …".
  const TEXT_ATTRIBUTE = /label|title|^alt$|placeholder|description|^value$/i;
  const PERSONAL_ATTRIBUTE = /author|user|email|token|karma|avatar|icon/i;
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "source", "track", "wbr"]);
  const inventory = {
    tags: {}, attributes: {}, slots: {}, nouns: {}, testIds: {}, dataParts: {}, loaders: {},
  };

  function count(table, key) {
    if (key) table[key] = (table[key] || 0) + 1;
  }

  function redactText(text) {
    return text.replace(/\s+/g, " ").replace(/\S/g, "x");
  }

  function redactUrl(value) {
    try {
      const url = new URL(value, location.origin);
      const path = url.pathname.replace(/^\/(user|u)\/[^/]+/i, "/$1/redacted");
      return url.origin === location.origin ? path : `${url.origin}${path}`;
    } catch {
      return "";
    }
  }

  function redactJson(value) {
    if (typeof value === "string") return "x";
    if (Array.isArray(value)) return value.map(redactJson);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactJson(item)]));
    }
    return value;
  }

  function attributeValue(name, value) {
    if (TEXT_ATTRIBUTE.test(name) || PERSONAL_ATTRIBUTE.test(name)) return redactText(value);
    if (/^(\/|https?:)/i.test(value)) return redactUrl(value);
    if (/^[[{]/.test(value)) {
      try {
        return JSON.stringify(redactJson(JSON.parse(value)));
      } catch {
        return redactText(value);
      }
    }
    return value;
  }

  function escape(value) {
    return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function serializeChildren(parent) {
    return Array.from(parent.childNodes, serialize).join("");
  }

  function serialize(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent.trim() ? escape(redactText(node.textContent)) : "";
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const tag = node.localName;
    if (SKIPPED.has(tag)) return "";
    count(inventory.tags, tag);
    count(inventory.slots, node.getAttribute("slot"));
    count(inventory.nouns, node.getAttribute("noun"));
    count(inventory.testIds, node.getAttribute("data-testid"));
    count(inventory.dataParts, node.getAttribute("data-part"));
    if (tag === "faceplate-loader") count(inventory.loaders, node.getAttribute("name"));

    const attributes = Array.from(node.attributes)
      .filter(({ name }) => !DROPPED_ATTRIBUTES.has(name) && !name.startsWith("on"))
      .map(({ name, value }) => {
        count(inventory.attributes, name);
        return value === "" ? ` ${name}` : ` ${name}="${escape(attributeValue(name, value))}"`;
      })
      .join("");
    if (VOID.has(tag)) return `<${tag}${attributes}>`;
    if (EMPTIED.has(tag)) return `<${tag}${attributes}></${tag}>`;

    const shadow = node.shadowRoot
      ? `<template shadowrootmode="open">${serializeChildren(node.shadowRoot)}</template>`
      : "";
    return `<${tag}${attributes}>${shadow}${serializeChildren(node)}</${tag}>`;
  }

  const body = serialize(document.body);
  const html = [
    "<!doctype html>",
    `<html lang="${escape(document.documentElement.lang || "en")}">`,
    `<head><meta charset="utf-8"><title>Snapshot of ${escape(redactUrl(location.href))}</title></head>`,
    body,
    "</html>",
  ].join("\n");
  return { html, inventory };
}
