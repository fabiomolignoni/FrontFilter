/**
 * The release scripts' edits to the version, the manifest and the changelog,
 * and the checks the release workflow makes on a tag. They run without git.
 */
const assert = require("node:assert/strict");
const test = require("node:test");
const { readSource } = require("./helpers");
const { closeChangelog, nextVersion, parseArguments, setManifestVersion } = require("../../scripts/release");
const { releaseNotes, tagVersion } = require("../../scripts/release-notes");

const untagged = () => false;
const CHANGELOG = `# Changelog

Notable changes to FrontFilter, newest first.

## Unreleased

### Added

- Something new.

## 2.4.0 - 2026-10-12

### Added

- Block users.
`;

test("raises one part of the manifest's version, or releases the one given", () => {
  assert.equal(nextVersion("2.4.0", "patch", untagged), "2.4.1");
  assert.equal(nextVersion("2.4.1", "minor", untagged), "2.5.0");
  assert.equal(nextVersion("2.4.1", "major", untagged), "3.0.0");
  assert.equal(nextVersion("2.4.0", "2.10.0", untagged), "2.10.0");
  // A version set by hand, not yet tagged.
  assert.equal(nextVersion("2.5.0", "2.5.0", untagged), "2.5.0");
});

test("releases no lower version, no tagged one, and nothing but x.y.z", () => {
  assert.throws(() => nextVersion("2.4.0", "2.3.9", untagged), /lower/);
  assert.throws(() => nextVersion("2.4.0", "2.4.0", (version) => version === "2.4.0"), /already/);
  assert.throws(() => nextVersion("2.4.0", "2.5", untagged), /not a version/);
  assert.throws(() => nextVersion("2.4.0", "02.5.0", untagged), /not a version/);
  assert.throws(() => nextVersion("2.4.0", undefined, untagged), /not a version/);
  assert.throws(() => nextVersion("2.4", "patch", untagged), /not x\.y\.z/);
});

test("dates the Unreleased entry of the changelog, which the release notes then read", () => {
  const closed = closeChangelog(CHANGELOG, "2.5.0", "2026-11-11");
  assert.equal(closed, CHANGELOG.replace("## Unreleased", "## 2.5.0 - 2026-11-11"));
  assert.equal(releaseNotes(closed, "2.5.0"), "### Added\n\n- Something new.\n");
  assert.equal(releaseNotes(closed, "2.4.0"), "### Added\n\n- Block users.\n");
});

test("closes no changelog without changes under Unreleased, or with the version already in it", () => {
  const date = "2026-11-11";
  assert.throws(() => closeChangelog(CHANGELOG.replace("## Unreleased", "## Next"), "2.5.0", date), /no "## Unreleased"/);
  assert.throws(() => closeChangelog(CHANGELOG.replace("- Something new.\n", ""), "2.5.0", date), /lists no change/);
  assert.throws(() => closeChangelog(CHANGELOG, "2.4.0", date), /already has an entry/);
});

test("finds no release notes for a version the changelog has not dated, or left empty", () => {
  assert.throws(() => releaseNotes(CHANGELOG, "2.5.0"), /no entry "## 2\.5\.0 - YYYY-MM-DD"/);
  const empty = closeChangelog(CHANGELOG, "2.5.0", "2026-11-11").replace("### Added\n\n- Something new.\n", "");
  assert.throws(() => releaseNotes(empty, "2.5.0"), /empty/);
});

test("sets the manifest's version and changes nothing else", () => {
  const source = readSource("manifest.json");
  const updated = setManifestVersion(source, "9.8.7");
  assert.equal(JSON.parse(updated).version, "9.8.7");
  assert.deepEqual({ ...JSON.parse(updated), version: null }, { ...JSON.parse(source), version: null });
  assert.equal(updated.split("\n").length, source.split("\n").length);
});

test("takes a release's version from its tag, which must name the manifest's", () => {
  assert.equal(tagVersion("v2.5.0", "2.5.0"), "2.5.0");
  assert.throws(() => tagVersion("v2.5.0", "2.4.0"), /does not match/);
  assert.throws(() => tagVersion("2.5.0", "2.5.0"), /not a release tag/);
  assert.throws(() => tagVersion("v2.5", "2.5"), /not a release tag/);
});

test("reads the version, the options and the canary's Firefox from the command line", () => {
  assert.deepEqual(parseArguments(["minor", "--push", "--firefox", "/opt/firefox"]), {
    spec: "minor", push: true, dryRun: false, skipCanary: false, firefox: "/opt/firefox",
  });
  assert.equal(parseArguments(["--firefox=/opt/firefox", "2.5.0"]).firefox, "/opt/firefox");
  assert.equal(parseArguments(["patch", "--dry-run", "--skip-canary"]).skipCanary, true);
  assert.throws(() => parseArguments(["patch", "--force"]), /unknown option --force/);
  assert.throws(() => parseArguments(["patch", "minor"]), /unexpected argument minor/);
});
