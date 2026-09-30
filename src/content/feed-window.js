/** Logical feed results outlive their DOM nodes (Reddit may recycle cards). */
FrontFilter.createFeedWindow = function (size, mode) {
  const records = new Map();
  let allowed = new Set();
  let target = size;
  let pending = true;
  let ended = false;

  function eligible() {
    return Array.from(records.values()).filter((record) => record.eligible);
  }

  function reconcile() {
    const candidates = eligible();
    // The quota is a ceiling, not a prerequisite for displaying the first card.
    allowed = new Set(candidates.slice(0, target).map(({ id }) => id));
    pending = candidates.length < target && !ended;
    return snapshot();
  }

  function snapshot() {
    return {
      allowed: new Set(allowed),
      target,
      pending,
      ended,
      available: eligible().length,
      canAdvance: mode === "button" && !pending
        && (!ended || eligible().length > allowed.size),
    };
  }

  return {
    update(items, isEligible) {
      for (const item of items) records.set(item.id, { ...item });
      for (const record of records.values()) record.eligible = isEligible(record);
      return reconcile();
    },
    next() {
      if (!snapshot().canAdvance || !Number.isSafeInteger(target + size)) return false;
      target += size;
      pending = true;
      reconcile();
      return true;
    },
    end() {
      ended = true;
      return reconcile();
    },
    snapshot,
  };
};
