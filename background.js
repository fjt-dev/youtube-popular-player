"use strict";
importScripts("core.js");
// Serialize operations so ending playback cannot be overtaken by an earlier write.
let pending = Promise.resolve();
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!sender.tab || !sender.url?.startsWith("https://www.youtube.com/") || sender.frameId !== 0) return;
  if (message?.type !== "popular-player") return;
  const key = `queue:${sender.tab.id}`;
  pending = pending.catch(() => {}).then(async () => {
    try {
      if (message.action === "read") {
        const result = await chrome.storage.session.get(key);
        const queue = result[key];
        if (queue && !PopularPlayerCore.validQueue(queue)) await chrome.storage.session.remove(key);
        respond({ok: true, queue: PopularPlayerCore.validQueue(queue) ? queue : null});
      } else if (message.action === "write" && PopularPlayerCore.validQueue(message.queue)) {
        await chrome.storage.session.set({[key]: message.queue});
        respond({ok: true});
      } else if (message.action === "clear") {
        await chrome.storage.session.remove(key);
        respond({ok: true});
      } else respond({ok: false, error: "再生リストが不正です。"});
    } catch { respond({ok: false, error: "再生リストを保存できませんでした。"}); }
  });
  return true;
});
chrome.tabs.onRemoved.addListener(tabId => {
  pending = pending.catch(() => {}).then(() => chrome.storage.session.remove(`queue:${tabId}`));
});
