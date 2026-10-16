/**
 * Renders the Chrome Web Store images in store/images/ from store/scenes/.
 *
 *   node scripts/store-images.js [--chrome /path/to/chrome] [--serve] [scene ...]
 *
 * The scenes show FrontFilter's real pages, served here with fake extension
 * APIs, so the images follow the extension's current interface. Chrome runs
 * headless and is driven over the DevTools protocol on a pipe, which sets the
 * exact viewport each image needs. --serve only serves the scenes, to edit
 * them in a browser.
 */
const { spawn } = require("node:child_process");
const {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} = require("node:fs");
const { createServer } = require("node:http");
const { tmpdir } = require("node:os");
const { extname, join, relative, resolve, sep } = require("node:path");
const { parseArgs } = require("node:util");

const ROOT = resolve(__dirname, "..");
const IMAGES = join(ROOT, "store", "images");
// Each scene's image and its size in pixels, as the store asks for them.
const OUTPUTS = {
  "1-block-feeds": [1280, 800],
  "2-filter": [1280, 800],
  "3-block-subreddits": [1280, 800],
  "4-simplify": [1280, 800],
  "5-limit-scrolling": [1280, 800],
  "small-promo-tile": [440, 280],
  "marquee-promo-tile": [1400, 560],
};
const FAKE_APIS = '<script src="/store/scenes/extension-apis.js"></script>';
const TYPES = {
  ".css": "text/css",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".json": "application/json",
  ".png": "image/png",
};
const CHROME_PATHS = {
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"],
  win32: [join(process.env.PROGRAMFILES || "", "Google/Chrome/Application/chrome.exe")],
};

// Serves the repository, with the fake extension APIs in extension pages.
function serve() {
  const server = createServer((request, response) => {
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT + sep) || !existsSync(file) || !extname(file)) {
      response.writeHead(404).end();
      return;
    }
    let body = readFileSync(file);
    if (path.startsWith("/src/") && path.endsWith(".html")) {
      body = body.toString().replace("<head>", `<head>${FAKE_APIS}`);
    }
    response.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream" });
    response.end(body);
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done(server)));
}

/**
 * Chrome, driven over the DevTools protocol: it reads commands from its
 * fourth file descriptor and writes replies to its fifth, each ending in a
 * null byte.
 */
function launch(chrome) {
  const profile = mkdtempSync(join(tmpdir(), "frontfilter-store-"));
  const args = [
    "--headless", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
    "--no-first-run", "--hide-scrollbars", "--force-color-profile=srgb",
    // Chrome's sandbox cannot run as root, as in containers.
    ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
    "about:blank",
  ];
  const child = spawn(chrome, args, { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const pending = new Map();
  const listeners = new Set();
  let nextId = 1;
  let buffer = "";
  child.stdio[4].on("data", (chunk) => {
    buffer += chunk;
    let end;
    while ((end = buffer.indexOf("\0")) >= 0) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id && pending.has(message.id)) {
        const { done, fail } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) fail(new Error(message.error.message));
        else done(message.result);
      } else {
        for (const listener of listeners) listener(message);
      }
    }
  });
  const exited = new Promise((done) => child.on("exit", done));
  // Commands still waiting fail once Chrome is gone, as when it cannot start.
  const failAll = (error) => {
    for (const { fail } of pending.values()) fail(error);
    pending.clear();
  };
  void exited.then(() => failAll(new Error(`Chrome exited: ${chrome}`)));
  child.on("error", failAll);
  child.stdio[3].on("error", () => {});

  function send(method, params = {}, sessionId) {
    const id = nextId++;
    child.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId })}\0`);
    return new Promise((done, fail) => pending.set(id, { done, fail }));
  }

  function once(method, sessionId) {
    return new Promise((done) => {
      const listener = (message) => {
        if (message.method !== method || message.sessionId !== sessionId) return;
        listeners.delete(listener);
        done(message.params);
      };
      listeners.add(listener);
    });
  }

  async function close() {
    await send("Browser.close").catch(() => {});
    await exited;
    rmSync(profile, { recursive: true, force: true });
  }

  return { send, once, close };
}

async function render(browser, url, target, [width, height]) {
  const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  try {
    await send("Page.enable");
    await send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: 1, mobile: false,
    });
    // The pages then skip their animations, so nothing is caught midway.
    await send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const loaded = browser.once("Page.loadEventFired", sessionId);
    await send("Page.navigate", { url });
    await loaded;
    const ready = await send("Runtime.evaluate", {
      expression: `Scene.ready().then(() => new Promise((done) =>
        requestAnimationFrame(() => requestAnimationFrame(done))))`,
      awaitPromise: true,
    });
    if (ready.exceptionDetails) {
      throw new Error(`${url}: ${ready.exceptionDetails.exception?.description}`);
    }
    const { data } = await send("Page.captureScreenshot", {
      format: "png", clip: { x: 0, y: 0, width, height, scale: 1 },
    });
    writeFileSync(target, Buffer.from(data, "base64"));
  } finally {
    await browser.send("Target.closeTarget", { targetId });
  }
  checkImage(target, width, height);
  console.log(`Rendered ${relative(ROOT, target)} (${width}x${height})`);
}

// The store takes PNG screenshots and tiles only at their exact size, and
// without an alpha channel.
function checkImage(file, width, height) {
  const header = readFileSync(file).subarray(16, 26);
  const size = [header.readUInt32BE(0), header.readUInt32BE(4)];
  const colorType = header[9];
  if (size[0] !== width || size[1] !== height || colorType === 4 || colorType === 6) {
    throw new Error(`${relative(ROOT, file)} is ${size.join("x")} with color type ${colorType}, `
      + `expected ${width}x${height} without alpha`);
  }
}

function findChrome(path) {
  const found = path || (CHROME_PATHS[process.platform] || []).find(existsSync);
  if (!found) throw new Error("Chrome not found: pass --chrome /path/to/chrome");
  return found;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { chrome: { type: "string" }, serve: { type: "boolean" } },
    allowPositionals: true,
  });
  const unknown = positionals.filter((name) => !(name in OUTPUTS));
  if (unknown.length) throw new Error(`Unknown scenes: ${unknown.join(", ")}`);

  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/store/scenes`;
  if (values.serve) {
    console.log(`Serving the scenes at ${base}/ (Ctrl+C stops)`);
    return;
  }

  const browser = launch(findChrome(values.chrome));
  mkdirSync(IMAGES, { recursive: true });
  try {
    for (const name of positionals.length ? positionals : Object.keys(OUTPUTS)) {
      await render(browser, `${base}/${name}.html`, join(IMAGES, `${name}.png`), OUTPUTS[name]);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
