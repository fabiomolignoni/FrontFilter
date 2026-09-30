const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const test = require("node:test");

const pages = ["popup", "blocked"].map((directory) => ({
  directory,
  html: readFileSync(
    join(__dirname, "..", "..", "src", directory, "index.html"),
    "utf8",
  ),
}));

const links = [
  ["GitHub", "https://github.com/SilentFoxDev/FrontFilter"],
  ["Report a bug", "https://github.com/SilentFoxDev/FrontFilter/issues"],
  ["Donate ☕", "https://ko-fi.com/silentfoxdev/donate"],
];

test("renders the project links safely in the popup and blocked page", () => {
  assert.doesNotMatch(pages[0].html, /Changes saved automatically/);

  for (const { directory, html } of pages) {
    for (const [label, url] of links) {
      const escapedUrl = url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const anchor = html.match(
        new RegExp(`<a\\s+[^>]*href="${escapedUrl}"[^>]*>\\s*${label}\\s*</a>`),
      )?.[0];

      assert.ok(anchor, `${label} link is missing from ${directory}`);
      assert.match(anchor, /target="_blank"/);
      assert.match(anchor, /rel="noopener noreferrer"/);
    }
  }
});
