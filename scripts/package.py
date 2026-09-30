"""Build deterministic Firefox and Chrome release archives."""
from datetime import datetime, timezone
from copy import deepcopy
import json
import os
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parent.parent
SOURCE = ROOT / "src"
DIST = ROOT / "dist"
CHROME_MANIFEST = json.loads((SOURCE / "manifest.json").read_text())
FIREFOX_OVERRIDES = json.loads((ROOT / "manifests/firefox.json").read_text())
VERSION = CHROME_MANIFEST["version"]
FILES = sorted(path for path in SOURCE.rglob("*") if path.is_file())


def timestamp():
    epoch = int(os.environ.get("SOURCE_DATE_EPOCH", "315532800"))
    value = datetime.fromtimestamp(max(epoch, 315532800), timezone.utc)
    return (value.year, value.month, value.day, value.hour, value.minute, value.second)


def target_manifest(browser):
    manifest = deepcopy(CHROME_MANIFEST)
    if browser == "firefox":
        manifest.pop("minimum_chrome_version")
        manifest.update(deepcopy(FIREFOX_OVERRIDES))
    elif browser == "chrome":
        pass
    else:
        raise ValueError(f"Unsupported browser: {browser}")
    return (json.dumps(manifest, indent=2) + "\n").encode()


def build(name, browser):
    target = DIST / name
    with ZipFile(target, "w", ZIP_DEFLATED, compresslevel=9) as archive:
        for path in FILES:
            relative = path.relative_to(SOURCE).as_posix()
            info = ZipInfo(relative, timestamp())
            info.compress_type = ZIP_DEFLATED
            info.external_attr = 0o644 << 16
            contents = target_manifest(browser) if relative == "manifest.json" \
                else path.read_bytes()
            archive.writestr(info, contents)
    print(f"Built {target.relative_to(ROOT)}")


DIST.mkdir(exist_ok=True)
build(f"frontfilter-firefox-{VERSION}.xpi", "firefox")
build(f"frontfilter-chrome-{VERSION}.zip", "chrome")
