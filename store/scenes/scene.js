/**
 * Helpers for the store scenes: they embed FrontFilter's real pages, crop
 * them to the part a scene shows, and draw a Reddit-like feed around them.
 * The feed is an illustration: it shows no real posts or users.
 */
const Scene = (() => {
  // Work to finish before the scene is captured.
  const pending = [];
  const ICONS = {
    up: '<path d="M12 4 4 13h5v7h6v-7h5z"/>',
    down: '<path d="M12 20 4 11h5V4h6v7h5z"/>',
    comment: '<path d="M4 5h16v11H9l-5 4z"/>',
    share: '<path d="M14 5l6 6-6 6v-4c-5 0-8 1.5-10 5 1-5 4-9 10-10z"/>',
    award: '<circle cx="12" cy="9" r="6"/><path d="M8 14l-2 8 6-3 6 3-2-8z"/>',
  };

  // Drawings over a post image's gradient.
  const ART = {
    mountains: `<svg viewBox="0 0 520 150" preserveAspectRatio="none" aria-hidden="true">
      <circle cx="380" cy="62" r="26" fill="#fde68a" opacity="0.9"/>
      <path d="M0 150V96l70-44 60 38 90-70 80 62 50-30 90 56 80-40v88z" fill="#000" opacity="0.28"/>
      <path d="M0 150v-30l110-40 90 36 110-60 100 52 110-28v70z" fill="#000" opacity="0.4"/>
    </svg>`,
    stars: `<svg viewBox="0 0 520 150" aria-hidden="true">${
      Array.from({ length: 60 }, (_, index) => {
        // The same stars every time.
        const x = (index * 97) % 520;
        const y = (index * 61 + (index % 7) * 13) % 150;
        return `<circle cx="${x}" cy="${y}" r="${index % 5 ? 0.9 : 1.8}" fill="#fff" opacity="${
          0.4 + (index % 3) * 0.2}"/>`;
      }).join("")}
      <ellipse cx="330" cy="70" rx="120" ry="44" fill="#f0abfc" opacity="0.18"/>
    </svg>`,
    bubbles: `<svg viewBox="0 0 520 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <circle cx="110" cy="40" r="70" fill="#fff" opacity="0.18"/>
      <circle cx="400" cy="120" r="90" fill="#fff" opacity="0.12"/>
      <circle cx="260" cy="70" r="34" fill="#fff" opacity="0.22"/>
    </svg>`,
  };

  function icon(name) {
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  }

  function escape(text) {
    return String(text).replace(/[&<>"]/g, (char) => `&#${char.charCodeAt(0)};`);
  }

  /**
   * Feed posts. A post has a subreddit (sub), its color and a title, and
   * optionally an image (two gradient colors and a drawing from ART), a
   * flair, votes, awards, comments, a Block button (block: true, or "hover")
   * and, for a post FrontFilter hides, the rule that hides it (hiddenBy).
   */
  function feed(container, posts) {
    container.innerHTML = posts.map((post) => `
      <article class="post${post.hiddenBy ? " post--hidden" : ""}">
        ${post.hiddenBy ? `<span class="hidden-by">Hidden · ${escape(post.hiddenBy)}</span>` : ""}
        <div class="post-meta">
          <span class="sub-icon" style="--sub: ${post.color}"></span>
          <span class="sub">r/${escape(post.sub)}</span>
          <span>· ${escape(post.time || "4 hr. ago")}</span>
          ${post.block ? `<button type="button" class="frontfilter-block-subreddit${
            post.block === "hover" ? " is-hovered" : ""}">Block</button>` : ""}
          ${post.promoted ? '<span class="promoted">Promoted</span>' : ""}
        </div>
        <h3 class="post-title">${post.flair ? `<span class="flair">${escape(post.flair)}</span>` : ""}${
          escape(post.title)}</h3>
        ${post.image ? `<div class="post-image" style="--from: ${post.image[0]}; --to: ${post.image[1]}">${
          ART[post.image[2]] || ""}</div>` : ""}
        <div class="post-actions">
          <span class="pill votes">${icon("up")}<b>${post.votes || "1.2k"}</b>${icon("down")}</span>
          ${post.award ? `<span class="pill award">${icon("award")}${post.award}</span>` : ""}
          <span class="pill">${icon("comment")}${post.comments || "248"}</span>
          <span class="pill">${icon("share")}Share</span>
        </div>
      </article>`).join('<hr class="post-rule">');
  }

  /**
   * Shows an extension page in a frame, with these settings and theme.
   * Once it loads, setup(document) prepares it, and crop(document) returns
   * the element the frame's .crop wrapper shows.
   */
  function embed(frame, { page, settings = {}, theme = "dark", setup, crop }) {
    frame.dataset.settings = JSON.stringify(settings);
    frame.dataset.theme = theme;
    pending.push(new Promise((done) => {
      frame.addEventListener("load", () => {
        // Let the page's settings load and render first.
        setTimeout(() => {
          const doc = frame.contentDocument;
          setup?.(doc);
          if (crop) cropTo(frame, crop(doc));
          done();
        }, 100);
      }, { once: true });
    }));
    frame.src = `/src/${page}`;
  }

  function cropTo(frame, element) {
    const { left, top, width, height } = element.getBoundingClientRect();
    const wrapper = frame.parentElement;
    wrapper.style.width = `${width}px`;
    wrapper.style.height = `${height}px`;
    frame.style.left = `${-left}px`;
    frame.style.top = `${-top}px`;
  }

  // Points the cursor at the element, both inside the same .page.
  function pointAt(cursor, element) {
    const page = element.closest(".page").getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    cursor.style.left = `${rect.left - page.left + rect.width * 0.55}px`;
    cursor.style.top = `${rect.top - page.top + rect.height * 0.5}px`;
  }

  // Scrolls a settings panel so that the element is near its top.
  function scrollTo(element, margin = 16) {
    const panel = element.closest(".tab-panel");
    panel.scrollTop = element.offsetTop - panel.offsetTop - margin;
  }

  // Gives each .browser[data-url] its toolbar, with FrontFilter pinned.
  function drawBrowsers() {
    for (const browser of document.querySelectorAll(".browser[data-url]")) {
      browser.insertAdjacentHTML("afterbegin", `
        <div class="toolbar">
          <div class="dots"><span></span><span></span><span></span></div>
          <div class="address">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7 10V7a5 5 0 0 1 10 0v3h1v11H6V10zm2 0h6V7a3 3 0 0 0-6 0z"/>
            </svg>${escape(browser.dataset.url)}
          </div>
          <div class="extensions">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M10 3a2 2 0 0 1 4 0v2h5v5h-2a2 2 0 0 0 0 4h2v5h-5v-2a2 2 0 0 0-4 0v2H5v-5h2a2 2 0 0 0 0-4H5V5h5z"/>
            </svg>
            <img src="/src/icons/icon-32.png" alt="" />
          </div>
        </div>`);
    }
  }
  drawBrowsers();

  // The icon's white funnel alone, for the orange promo tiles.
  function drawGlyph(canvas) {
    pending.push(paintGlyph(canvas));
  }

  async function paintGlyph(canvas) {
    const image = new Image();
    image.src = "/src/icons/icon-512.png";
    await image.decode();
    const source = document.createElement("canvas");
    source.width = image.width;
    source.height = image.height;
    const context = source.getContext("2d");
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, source.width, source.height);
    const { data } = pixels;
    let [left, top, right, bottom] = [source.width, source.height, 0, 0];
    for (let index = 0; index < data.length; index += 4) {
      // The orange has almost no blue and the funnel is near white.
      const whiteness = Math.min(1, Math.max(0, (data[index + 2] - 8) / 236));
      data[index + 3] = Math.round(data[index + 3] * whiteness);
      data[index] = data[index + 1] = data[index + 2] = 255;
      if (data[index + 3] > 0) {
        const x = (index / 4) % source.width;
        const y = Math.floor(index / 4 / source.width);
        [left, top] = [Math.min(left, x), Math.min(top, y)];
        [right, bottom] = [Math.max(right, x + 1), Math.max(bottom, y + 1)];
      }
    }
    context.putImageData(pixels, 0, 0);
    // Only the funnel, which the canvas's CSS height then sizes.
    canvas.width = right - left;
    canvas.height = bottom - top;
    canvas.getContext("2d").drawImage(source, -left, -top);
  }

  // Resolves once the scene is complete, for scripts/store-images.js.
  async function ready() {
    await Promise.all(pending);
    await document.fonts.ready;
  }

  return { drawGlyph, embed, feed, pointAt, ready, scrollTo };
})();
