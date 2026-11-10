/**
 * Reads what filters match in a post: its subreddits, title, text, flair,
 * author and whether it is an ad, and in a comment its text. Page filters
 * and the scroll and comment limits use these readers, so they judge a
 * post or a comment the same way. A post nested in another is judged on
 * its own: its title, text, flair and author are not the outer post's. A
 * crosspost does not nest the post it shares but shows it, so it is judged
 * by that post's subreddit as well as its own.
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

  // The subreddit of the post a crosspost shares, or "" for other posts and
  // for posts shared from a user profile, which is not a subreddit.
  function crosspostedFrom(post) {
    const source = post.getAttribute(POST.crosspostSourceAttribute);
    if (!source || !post.matches(POST.crossposts)) return "";
    // Permalinks are relative to Reddit, whatever page shows them.
    const url = FrontFilter.getRedditUrl(source, "https://www.reddit.com");
    return (url && FrontFilter.getSubredditPath(url.pathname)?.name) || "";
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

  function author(post) {
    return firstAttribute(post, POST.authorAttributes);
  }

  function isAd(post) {
    return post.matches(POST.adCards)
      || POST.promotedAttributes.some((name) => post.hasAttribute(name)
        && !["false", "0"].includes(post.getAttribute(name).toLowerCase()))
      || Boolean(post.querySelector(POST.adMarkers));
  }

  // A comment's own text, not its replies', in modern and Old Reddit; null
  // while its body has not rendered yet. Current markup nests the body
  // inside <details>; older markup made it a direct child. In both, a
  // comment's own body precedes its replies, so the first match is its own
  // unless it has none, as deleted comments do.
  function commentText(comment) {
    if (comment.localName !== COMMENT.modern) {
      const body = comment.querySelector(COMMENT.oldBody);
      return body ? body.textContent : null;
    }
    const body = comment.querySelector(COMMENT.modernBody);
    if (!body) return null;
    return body.closest(COMMENT.modern) === comment ? body.textContent : "";
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
    subreddits, crosspostedFrom, title, bodyTexts, flair, author, isAd, isRecommended,
    commentText, isUnreadTextChange,
  });
})();
