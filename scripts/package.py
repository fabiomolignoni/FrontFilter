"""Build deterministic Firefox, Chrome and Edge release archives."""
from copy import deepcopy
from datetime import datetime, timezone
import json
import os
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src"
DIST = ROOT / "dist"
CHROME_MANIFEST = json.loads((SOURCE / "manifest.json").read_text())
FIREFOX_OVERRIDES = json.loads((ROOT / "manifests/firefox.json").read_text())
EDGE_OVERRIDES = json.loads((ROOT / "manifests/edge.json").read_text())
VERSION = CHROME_MANIFEST["version"]


def source_files():
    """Every packaged file, skipping hidden ones such as .DS_Store."""
    return sorted(
        path for path in SOURCE.rglob("*")
        if path.is_file()
        and not any(part.startswith(".") for part in path.relative_to(SOURCE).parts)
    )


def browser_manifest(browser):
    """The source manifest, with the browser's overrides for Firefox and Edge."""
    manifest = deepcopy(CHROME_MANIFEST)
    if browser == "firefox":
        manifest.pop("minimum_chrome_version")
        manifest.update(deepcopy(FIREFOX_OVERRIDES))
    elif browser == "edge":
        # Edge versions follow Chromium's, so minimum_chrome_version applies.
        manifest.update(deepcopy(EDGE_OVERRIDES))
    elif browser != "chrome":
        raise ValueError(f"Unsupported browser: {browser}")
    return manifest


def timestamp():
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "315532800"))
    value = datetime.fromtimestamp(max(epoch, 315532800), timezone.utc)
    return (value.year, value.month, value.day, value.hour, value.minute, value.second)


def build(name, browser):
    target = DIST / name
    manifest = (json.dumps(browser_manifest(browser), indent=2) + "\n").encode()
    with ZipFile(target, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for path in source_files():
            relative = path.relative_to(SOURCE).as_posix()
            info = ZipInfo(relative, timestamp())
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            archive.writestr(info, manifest if relative == "manifest.json" else path.read_bytes())
    print(f"Built {target.relative_to(ROOT)}")


def main():
    DIST.mkdir(exist_ok=True)
    build(f"frontfilter-firefox-{VERSION}.xpi", "firefox")
    build(f"frontfilter-chrome-{VERSION}.zip", "chrome")
    build(f"frontfilter-edge-{VERSION}.zip", "edge")


if __name__ == "__main__":
    main()
