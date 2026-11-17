/**
 * What the scroll limit (feed-limit.js) and the comment limit
 * (comment-limit.js) share on the page: the markers that show and hide what
 * they count, and the controls they add after it. feed-limit.css styles
 * both.
 */
FrontFilter.limitView = (() => {
  const VISIBLE_ATTRIBUTE = "data-frontfilter-limit-visible";
  const HIDDEN_ATTRIBUTE = "data-frontfilter-limit-hidden";
  const MARKED = `[${VISIBLE_ATTRIBUTE}], [${HIDDEN_ATTRIBUTE}]`;
  const CONTROLS_CLASS = "frontfilter-feed-controls";

  // An element is marked either way: what a limit has not counted yet has
  // no marker, and stays hidden until it has one.
  function setVisible(element, visible) {
    element.toggleAttribute(VISIBLE_ATTRIBUTE, Boolean(visible));
    element.toggleAttribute(HIDDEN_ATTRIBUTE, !visible);
  }

  // Removes the markers from the elements of a feed or of a comment tree,
  // except those to keep.
  function clearMarkers(root, keep = new Set()) {
    for (const element of root.querySelectorAll(MARKED)) {
      if (keep.has(element)) continue;
      element.removeAttribute(VISIBLE_ATTRIBUTE);
      element.removeAttribute(HIDDEN_ATTRIBUTE);
    }
  }

  // A limit's controls: a status, which screen readers announce as it
  // changes, to which the limit adds its buttons.
  function createControls(className = "") {
    const controls = document.createElement("div");
    controls.className = className ? `${CONTROLS_CLASS} ${className}` : CONTROLS_CLASS;
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    controls.append(status);
    return { controls, status };
  }

  function createButton({ className = "", text = "", hidden = false } = {}) {
    const button = document.createElement("button");
    button.type = "button";
    if (className) button.className = className;
    if (text) button.textContent = text;
    button.hidden = hidden;
    return button;
  }

  return Object.freeze({ setVisible, clearMarkers, createControls, createButton });
})();
