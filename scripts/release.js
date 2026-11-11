#!/usr/bin/env node
/**
 * Closes a version. From a clean main that matches origin/main, it runs the
 * unit tests and the Reddit canary, sets the version in src/manifest.json,
 * dates the Unreleased entry of CHANGELOG.md, commits both and tags the
 * commit v<version>. With --push it pushes main and the tag together: the tag
 * starts the release workflow (.github/workflows/release.yml), which runs CI
 * on the tagged commit, builds the packages and drafts the GitHub release.
 *
 *   npm run release -- <x.y.z | patch | minor | major>
 *     [--push] [--dry-run] [--skip-canary] [--firefox PATH]
 *
 * patch, minor and major raise the version in src/manifest.json. --dry-run
 * shows the release without changing anything, and --firefox is passed on
 * to the canary.
 */
const { execFileSync } = require("node:child_process");
const { readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { releaseNotes } = require("./release-notes");

const ROOT = join(__dirname, "..");
const MANIFEST = join(ROOT, "src", "manifest.json");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const REPOSITORY = "fabiomolignoni/FrontFilter";

/** Negative, zero or positive as version a is lower than, equal to or higher than version b. */
function compare(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i];
  return 0;
}

/**
 * The version to release: x.y.z as given, or the manifest's version with one
 * part raised. It is never lower than the manifest's version, which can
 * itself be released while it has no tag, and never a version already tagged.
 */
function nextVersion(current, spec, isTagged) {
  const match = VERSION.exec(current);
  if (!match) throw new Error(`the version in src/manifest.json is "${current}", not x.y.z.`);
  const [major, minor, patch] = match.slice(1).map(Number);
  let next;
  if (spec === "major") next = `${major + 1}.0.0`;
  else if (spec === "minor") next = `${major}.${minor + 1}.0`;
  else if (spec === "patch") next = `${major}.${minor}.${patch + 1}`;
  else if (VERSION.test(spec ?? "")) next = spec;
  else throw new Error(`"${spec ?? ""}" is not a version (x.y.z) nor patch, minor or major.`);
  if (compare(next, current) < 0) {
    throw new Error(`${next} is lower than the version in src/manifest.json (${current}).`);
  }
  if (isTagged(next)) throw new Error(`v${next} has already been released.`);
  return next;
}

/**
 * CHANGELOG.md with its "## Unreleased" heading turned into
 * "## <version> - <date>". Throws when the heading is missing, when no change
 * is listed under it, or when the version already has an entry.
 */
function closeChangelog(changelog, version, date) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## Unreleased");
  if (start === -1) throw new Error('CHANGELOG.md has no "## Unreleased" entry.');
  if (lines.some((line) => line === `## ${version}` || line.startsWith(`## ${version} `))) {
    throw new Error(`CHANGELOG.md already has an entry for ${version}.`);
  }
  let end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  if (end === -1) end = lines.length;
  if (!lines.slice(start + 1, end).some((line) => line.startsWith("- "))) {
    throw new Error("the Unreleased entry of CHANGELOG.md lists no change.");
  }
  lines[start] = `## ${version} - ${date}`;
  return lines.join("\n");
}

/** The manifest's text with its version replaced, and nothing else changed. */
function setManifestVersion(text, version) {
  const manifest = JSON.parse(text);
  const updated = text.replace(/^(\s*"version":\s*")[^"]*"/m, `$1${version}"`);
  if (JSON.stringify(JSON.parse(updated)) !== JSON.stringify({ ...manifest, version })) {
    throw new Error("could not find the version in src/manifest.json.");
  }
  return updated;
}

function parseArguments(argv) {
  const options = { spec: undefined, push: false, dryRun: false, skipCanary: false, firefox: undefined };
  for (let i = 0; i < argv.length; i++) {
    const argument = argv[i];
    if (argument === "--push") options.push = true;
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--skip-canary") options.skipCanary = true;
    else if (argument === "--firefox" && i + 1 < argv.length) options.firefox = argv[++i];
    else if (argument.startsWith("--firefox=")) options.firefox = argument.slice("--firefox=".length);
    else if (argument.startsWith("-")) throw new Error(`unknown option ${argument}.`);
    else if (options.spec === undefined) options.spec = argument;
    else throw new Error(`unexpected argument ${argument}.`);
  }
  return options;
}

/** Today in the local time zone, as YYYY-MM-DD. */
function today() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8" }).trim();
const run = (command, args) => execFileSync(command, args, { cwd: ROOT, stdio: "inherit" });

function check(name, command, args, hint = "") {
  console.log(`\n> ${name}`);
  try {
    run(command, args);
  } catch {
    throw new Error(`${name} failed, so nothing was changed.${hint}`);
  }
}

function main(argv) {
  const options = parseArguments(argv);

  if (git("status", "--porcelain")) throw new Error("the working tree has uncommitted changes.");
  if (git("rev-parse", "--abbrev-ref", "HEAD") !== "main") throw new Error("a release is made from main.");
  run("git", ["fetch", "--quiet", "--tags", "origin", "main"]);
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    throw new Error("main is not the same as origin/main: pull or push first.");
  }

  const manifestText = readFileSync(MANIFEST, "utf8");
  const current = JSON.parse(manifestText).version;
  const version = nextVersion(current, options.spec, (v) => git("tag", "--list", `v${v}`) !== "");
  const manifest = setManifestVersion(manifestText, version);
  const changelog = closeChangelog(readFileSync(CHANGELOG, "utf8"), version, today());
  // The same check the release workflow makes on the tag.
  const notes = releaseNotes(changelog, version);

  console.log(`\nRelease ${version} (v${version}) from ${git("rev-parse", "--short", "HEAD")}.\n\n${notes}`);
  if (options.dryRun) {
    console.log("Dry run: nothing was changed.");
    return;
  }

  check("Unit tests", "npm", ["test", "--silent"]);
  if (options.skipCanary) {
    console.log("\nSkipping the canary: run it before submitting the packages if you have not.");
  } else {
    check(
      "Reddit canary",
      "python3",
      ["tests/reddit/canary.py", ...(options.firefox ? ["--firefox", options.firefox] : [])],
      " Run it from a Python environment with Selenium, pass --firefox PATH,"
        + " or pass --skip-canary if you have just run it.",
    );
  }

  writeFileSync(MANIFEST, manifest);
  writeFileSync(CHANGELOG, changelog);
  run("git", ["add", "src/manifest.json", "CHANGELOG.md"]);
  run("git", [
    "commit", "--quiet",
    "-m", `Bump version to ${version}`,
    "-m", "Name the release in the manifest and date its changelog entry.",
  ]);
  run("git", ["tag", "--annotate", `v${version}`, "-m", `FrontFilter ${version}`]);

  if (options.push) {
    run("git", ["push", "--atomic", "origin", "main", `v${version}`]);
    console.log(`\nPushed main and v${version}: the release workflow builds the packages and drafts the release.`);
  } else {
    console.log(`\nCommitted and tagged v${version}, nothing pushed. To publish:`);
    console.log(`  git push --atomic origin main v${version}`);
    console.log(`To undo instead:\n  git tag -d v${version} && git reset --hard HEAD~1`);
  }
  console.log(
    `\nThen https://github.com/${REPOSITORY}/releases has the draft with the packages.`
      + " Submit them to the stores, then publish the draft.",
  );
}

if (require.main === module) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`release: ${error.message}`);
    process.exit(1);
  }
}

module.exports = { closeChangelog, nextVersion, parseArguments, setManifestVersion };
