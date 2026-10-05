/**
 * Reads what filters match in a post: its subreddits, title, text, flair
 * and whether it is an ad. Page filters and the scroll limit both use these
 * readers, so they judge a post the same way. A crosspost embeds the
 * original post, whose title, text and flair are not its own.
 */
FrontFilter.posts = (() => {
  const { post: POST, comment: COMMENT } = FrontFilter.SELECTORS;

  // Elements of a nested post, or of a comment, belong to that post or
  // comment rather than to this one.
  function ownElements(post, selector, { outsideComments = false } = {}) {
    return Array.from(post.querySelectorAll(selector)).filter((element) => {
      if (outsideComments && element.closest?.(COMMENT.layouts)) return false;
      const owner = element.closest?.(POST.roots);
      return !owner || owner === post;
    });
  }

  function firstAttribute(post, names) {
    for (const name of names) {
      const value = post.getAttribute(name)?.trim();
      if (value) return value;
    }
    return "";
  }

  function subreddits(post) {
    const names = new Set();
    for (const attribute of POST.subredditAttributes) {
      const name = FrontFilter.normalizeSubredditName(post.getAttribute(attribute));
      if (name) names.add(name);
    }
    return names;
  }

  function title(post) {
    const fromAttribute = firstAttribute(post, POST.titleAttributes);
    if (fromAttribute) return fromAttribute;
    for (const element of ownElements(post, POST.title)) {
      const text = element.textContent?.trim();
      if (text) return text;
    }
    return "";
  }

  function bodyTexts(post) {
    const texts = new Set();
    for (const attribute of POST.bodyAttributes) {
      const text = post.getAttribute(attribute)?.trim();
      if (text) texts.add(text);
    }
    for (const element of ownElements(post, POST.body, { outsideComments: true })) {
      const text = element.textContent?.trim();
      if (text) texts.add(text);
    }
    return Array.from(texts);
  }

  function flair(post) {
    for (const element of ownElements(post, POST.flair)) {
      const text = FrontFilter.normalizeText(element.textContent);
      if (text) return text;
    }
    return "";
  }

  function isAd(post) {
    return post.matches(POST.adCards)
      || POST.promotedAttributes.some((name) => post.hasAttribute(name)
        && !["false", "0"].includes(post.getAttribute(name).toLowerCase()))
      || Boolean(post.querySelector(POST.adMarkers));
  }

  // An empty value means Reddit did not recommend the post.
  function isRecommended(post) {
    return Boolean(post.getAttribute(POST.recommendationAttribute));
  }

  // Whether a page change only changes text that filters do not read, such
  // as a timestamp or a counter: those change all the time. Filters read
  // the text of posts, and the text that matches readText.
  function isUnreadTextChange({ type, target, addedNodes = [], removedNodes = [] }, readText = POST.text) {
    const textOnly = type === "characterData" || (type === "childList"
      && ![...addedNodes, ...removedNodes].some((node) => node.nodeType === Node.ELEMENT_NODE));
    if (!textOnly) return false;
    const element = type === "characterData" ? target.parentElement : target;
    return !element?.closest(readText);
  }

  return Object.freeze({
    subreddits, title, bodyTexts, flair, isAd, isRecommended, isUnreadTextChange,
  });
})();
