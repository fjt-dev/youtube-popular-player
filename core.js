/* Shared by the content script, service worker and Node tests. */
(function (root) {
  "use strict";
  const ID = /^[A-Za-z0-9_-]{11}$/;
  const MAX = 1000;
  function videoId(href) {
    try {
      const url = new URL(href, "https://www.youtube.com");
      const id = url.searchParams.get("v");
      return url.origin === "https://www.youtube.com" && url.pathname === "/watch" && ID.test(id || "") ? id : null;
    } catch { return null; }
  }
  function isChannel(path) {
    return /^\/(?:@[^/]+|(?:channel|c|user)\/[^/]+)\/videos\/?$/.test(path);
  }
  function isPopular(label) {
    return /^(人気の動画|人気順|人気|Popular|Mostpopular|인기순|最热门|最熱門)$/i.test(label.replace(/\s+/g, ""));
  }
  function normalize(items) {
    const seen = new Set();
    return items.filter(item => {
      if (!item || !ID.test(item.id || "") || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    }).slice(0, MAX).map(item => ({id: item.id, title: String(item.title || "動画").slice(0, 300)}));
  }
  function validQueue(q) {
    return Boolean(q && Array.isArray(q.items) && q.items.length > 0 && q.items.length <= MAX &&
      q.items.every(item => item && typeof item.id === "string" && ID.test(item.id) && typeof item.title === "string" && item.title.length <= 300) &&
      new Set(q.items.map(item => item.id)).size === q.items.length &&
      Number.isInteger(q.index) && q.index >= 0 && q.index < q.items.length &&
      typeof q.source === "string" && q.source.startsWith("https://www.youtube.com/") &&
      Number.isFinite(q.created) && Date.now() - q.created < 24 * 60 * 60 * 1000 && q.created <= Date.now() + 60000);
  }
  const api = {videoId, isChannel, isPopular, normalize, validQueue, MAX};
  root.PopularPlayerCore = api;
  if (typeof module !== "undefined") module.exports = api;
})(globalThis);
