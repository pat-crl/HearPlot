/* A storage failure must never interrupt an edit or make a recording unusable. */
(function attach(root, create) {
  const tools = create();
  if (typeof module === "object" && module.exports) module.exports = tools;
  else root.MusicAnalyserStorage = tools;
}(typeof globalThis !== "undefined" ? globalThis : this, function create() {
  function createResilientStorage(getStorage, onFailure = () => {}) {
    const pending = new Map();
    let failed = false;
    function failure(error) { failed = true; onFailure(error); }
    return {
      getItem(key) {
        if (pending.has(key)) return pending.get(key);
        try { return getStorage().getItem(key); }
        catch (error) { failure(error); return null; }
      },
      setItem(key, value) {
        const text = String(value);
        try {
          getStorage().setItem(key, text);
          pending.delete(key);
          return true;
        } catch (error) {
          pending.set(key, text);
          failure(error);
          return false;
        }
      },
      get hasFailed() { return failed; },
    };
  }
  return { createResilientStorage };
}));
