#!/usr/bin/env node
/**
 * Release notes: checks that a release tag names the version in
 * src/manifest.json and that CHANGELOG.md dates an entry for it, then prints
 * that entry and how to verify the files. The release workflow
 * (.github/workflows/release.yml) uses the output as the text of the GitHub
 * release, and stops when this script fails.
 *
 *   node scripts/release-notes.js v<version>
 */
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const ROOT = join(__dirname, "..");
const REPOSITORY = "fabiomolignoni/FrontFilter";

/** The version a release tag names ("v2.5.0" gives "2.5.0"); throws unless it is the manifest's. */
function tagVersion(tag, manifestVersion) {
  const match = /^v(\d+\.\d+\.\d+)$/.exec(tag);
  if (!match) throw new Error(`"${tag}" is not a release tag (v<x.y.z>).`);
  if (match[1] !== manifestVersion) {
    throw new Error(`tag ${tag} does not match the version in src/manifest.json (${manifestVersion}).`);
  }
  return match[1];
}

/**
 * The body of the CHANGELOG.md entry "## <version> - YYYY-MM-DD", up to the
 * next entry; throws when the entry is missing or empty.
 */
function releaseNotes(changelog, version) {
  const lines = changelog.split("\n");
  const heading = `## ${version} - `;
  const start = lines.findIndex(
    (line) => line.startsWith(heading) && /^\d{4}-\d{2}-\d{2}\s*$/.test(line.slice(heading.length)),
  );
  if (start === -1) throw new Error(`CHANGELOG.md has no entry "${heading}YYYY-MM-DD".`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const body = lines.slice(start + 1, end === -1 ? undefined : end).join("\n").trim();
  if (!body) throw new Error(`the CHANGELOG.md entry for ${version} is empty.`);
  return `${body}\n`;
}

/** How to check the files of a release, appended to its notes. */
function verifyNote(repository) {
  return [
    "### Verify the files",
    "",
    "The release workflow built these files from the tagged commit. Check them",
    "with `sha256sum -c SHA256SUMS` and",
    `\`gh attestation verify <file> --repo ${repository}\`.`,
    "",
  ].join("\n");
}

if (require.main === module) {
  try {
    const manifest = JSON.parse(readFileSync(join(ROOT, "src", "manifest.json"), "utf8"));
    const version = tagVersion(process.argv[2] ?? "", manifest.version);
    const notes = releaseNotes(readFileSync(join(ROOT, "CHANGELOG.md"), "utf8"), version);
    process.stdout.write(`${notes}\n${verifyNote(REPOSITORY)}`);
  } catch (error) {
    console.error(`release-notes: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { releaseNotes, tagVersion, verifyNote };
