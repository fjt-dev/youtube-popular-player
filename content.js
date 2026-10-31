(() => {
  "use strict";
  if (globalThis.__popularPlayerLoaded) return;
  globalThis.__popularPlayerLoaded = true;
  const C = PopularPlayerCore;
  let queue = null;
  let previewing = false;
  let previewTimer = null;
  let stopConfirm = false;
  let controls = null;
  let panel = null;
  let job = null;
  let navigating = false;
  let advancing = false;
  let timer;
  let sortingUntil = 0;
  let attemptedId = null;
  let listExpanded = false;

  async function request(action, value) {
    const result = await chrome.runtime.sendMessage({type: "popular-player", action, queue: value});
    if (!result?.ok) throw new Error(result?.error || "拡張機能を再読み込み後、YouTubeも再読み込みしてください。");
    return result.queue || null;
  }
  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }
  function button(text, action, primary = false) {
    const node = element("button", `ypp-button${primary ? " ypp-primary" : ""}`, text);
    node.type = "button";
    node.addEventListener("click", event => {
      // The filter bar delegates clicks; our button must not select a YouTube chip.
      event.preventDefault();
      event.stopPropagation();
      try { Promise.resolve(action()).catch(showError); }
      catch (error) { showError(error); }
    });
    return node;
  }
  function showError(error) { toast(error.message || String(error)); }
  function toast(text) {
    document.querySelector(".ypp-toast")?.remove();
    const node = element("div", "ypp-toast", text);
    node.setAttribute("role", "status");
    document.body.append(node);
    setTimeout(() => node.remove(), 6500);
  }
  function browse() {
    return [...document.querySelectorAll("ytd-browse")].find(node => !node.closest("[hidden]"));
  }
  function popularChip() {
    if (!C.isChannel(location.pathname)) return null;
    const root = browse();
    if (!root) return null;
    const sortHosts = "yt-chip-cloud-chip-renderer, ytd-sort-filter-sub-menu-renderer, yt-dropdown-menu";
    const label = node => (node.textContent.trim() || node.getAttribute("aria-label") || "").replace(/[▾▿▼⌄⌃▲]/g, "").trim();
    const candidates = [...root.querySelectorAll(`${sortHosts}, button, [role=button], [role=tab]`)].filter(node =>
      !node.closest('[hidden], [aria-hidden="true"], [role=menu], [role=listbox], [role=menuitem], [role=option], tp-yt-paper-listbox, ytd-menu-popup-renderer, .ypp-controls, .ypp-panel'));
    const hasOtherSortChoices = candidates.some(node => /^(新しい順|古い順|Latest|Newest|Oldest)$/i.test(label(node)));
    const node = candidates.find(node => {
      if (!C.isPopular(label(node))) return false;
      const selected = node.hasAttribute("selected") || node.getAttribute("aria-selected") === "true" ||
        node.getAttribute("aria-pressed") === "true" || node.querySelector('[aria-selected="true"], [aria-pressed="true"]');
      const menu = node.matches('ytd-sort-filter-sub-menu-renderer, yt-dropdown-menu, [aria-haspopup="menu"], [aria-haspopup="listbox"], [aria-haspopup="true"]') ||
        node.querySelector('[aria-haspopup="menu"], [aria-haspopup="listbox"], [aria-haspopup="true"]');
      // In the dropdown layout, "selected" belongs to the independent public /
      // members filter. The sort trigger's label expresses the current sort.
      return selected || menu || !hasOtherSortChoices;
    });
    return node ? node.closest(sortHosts) || node : null;
  }
  function videos() {
    const root = browse();
    if (!root) return [];
    const grid = root.querySelector("ytd-rich-grid-renderer, ytd-grid-renderer") || root.querySelector("#contents") || root;
    const items = new Map();
    // Card wrappers and thumbnail IDs vary between YouTube layouts. Canonical watch
    // links are shared across those layouts, and DOM order preserves popularity rank.
    for (const link of grid.querySelectorAll("a[href]")) {
      if (link.closest('[hidden], [aria-hidden="true"]')) continue;
      if (link.closest("ytd-rich-shelf-renderer, ytd-reel-shelf-renderer, ytd-rich-section-renderer, ytd-ad-slot-renderer, ytd-in-feed-ad-layout-renderer, ytd-promoted-video-renderer, ytd-promoted-sparkles-web-renderer, ytd-channel-video-player-renderer, #secondary")) continue;
      const id = C.videoId(link.href);
      if (!id) continue;
      const heading = link.closest("h3") || link.querySelector("h3");
      const title = link.getAttribute("title")?.trim() || heading?.textContent.trim() || link.textContent.trim() || link.getAttribute("aria-label")?.trim();
      const score = link.getAttribute("title")?.trim() ? 4 : heading?.textContent.trim() ? 3 : link.textContent.trim() ? 2 : title ? 1 : 0;
      const previous = items.get(id);
      if (!previous || score > previous.score) items.set(id, {id, title: title || "動画", score});
    }
    return C.normalize([...items.values()]);
  }
  function setText(node, value) {
    if (node.textContent !== value) node.textContent = value;
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(reconcile, 220);
  }
  function renderControls() {
    const chip = !navigating && Date.now() >= sortingUntil && popularChip();
    if (!chip) {
      controls?.remove();
      controls = null;
      if (job) job.cancelled = true;
      return;
    }
    if (!controls?.isConnected) {
      controls = element("span", "ypp-controls");
      controls.append(button("▶ 人気順で再生", prepare, true));
      chip.after(controls);
    }
    const play = controls.firstElementChild;
    // A missing card selector used to leave a visible but permanently disabled
    // button. Always let the user start detection and receive progress or an error.
    play.disabled = Boolean(job);
    play.title = `現在${videos().length}本を検出。追加読み込みしてから人気順で連続再生します（最大1,000本）。`;
  }
  function clearPanel() { panel?.remove(); panel = null; }
  function renderQueue() {
    if (job) return;
    const preview = previewing && queue && location.href === queue.source && C.isChannel(location.pathname);
    if (!document.body) return;
    if (!queue || navigating || (!preview && location.pathname !== "/watch")) { clearPanel(); return; }
    const signature = `${preview}:${queue.index}:${queue.items.length}:${queue.items[queue.index].id}:${listExpanded}:${stopConfirm}`;
    if (panel?.isConnected && panel.dataset.signature === signature) return;
    clearPanel();
    panel = element("aside", "ypp-panel");
    panel.dataset.signature = signature;
    panel.setAttribute("aria-label", "人気順の連続再生");
    const bar = element("div", "ypp-player-bar");
    const info = element("div", "ypp-info");
    const meta = element("div", "ypp-meta");
    meta.append(element("span", "ypp-mode", preview ? "再生準備完了" : "人気順"),
      element("span", "ypp-count", preview ? `${queue.items.length}本` : `${queue.index + 1} / ${queue.items.length}`));
    const nextItem = preview ? queue.items[queue.index] : queue.items[queue.index + 1];
    const nextTitle = element("div", "ypp-next", nextItem ? `${preview ? "最初に再生" : "次に再生"}：${nextItem.title}` : "次に再生：なし（最後の動画）");
    info.append(meta, nextTitle);
    const iconButton = (label, path, action) => {
      const node = button("", action);
      node.classList.add("ypp-icon-button");
      node.setAttribute("aria-label", label);
      node.title = label;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      const shape = document.createElementNS("http://www.w3.org/2000/svg", "path");
      shape.setAttribute("d", path);
      svg.append(shape);
      node.append(svg);
      return node;
    };
    const prev = iconButton("前へ", "M6 5h2v14H6zm3 7 10 7V5z", () => move(-1));
    prev.disabled = queue.index === 0;
    const end = iconButton("連続再生を終了", "M6 6h12v12H6z", requestStop);
    const next = iconButton("次へ", "M16 5h2v14h-2zM5 5v14l10-7z", () => move(1));
    next.disabled = queue.index === queue.items.length - 1;
    const toggle = iconButton(listExpanded ? "一覧を閉じる" : "再生リスト",
      listExpanded ? "M7 14l5-5 5 5z" : "M3 5h14v2H3zm0 6h14v2H3zm0 6h9v2H3zm12-2 6 4-6 4z", () => {
      listExpanded = !listExpanded;
      renderQueue();
      panel?.querySelector(".ypp-list-toggle")?.focus();
    });
    toggle.classList.add("ypp-list-toggle");
    toggle.classList.toggle("ypp-list-toggle-open", listExpanded);
    toggle.setAttribute("aria-expanded", String(listExpanded));
    toggle.setAttribute("aria-controls", "ypp-queue-list");
    const actions = element("div", "ypp-player-actions");
    if (preview) actions.append(end, toggle);
    else actions.append(prev, end, next, toggle);
    bar.append(info, actions);
    const listContainer = element("section", "ypp-queue-container");
    listContainer.id = "ypp-queue-list";
    listContainer.hidden = !listExpanded;
    if (listExpanded) {
      listContainer.append(element("h3", "ypp-list-heading", `再生リスト · ${queue.items.length}本`),
        element("div", "ypp-current-title", `${preview ? "最初に再生" : "再生中"}：${queue.items[queue.index].title}`));
      const list = element("ol", "ypp-list");
      list.setAttribute("aria-label", "人気順の動画一覧");
      queue.items.forEach((item, index) => {
        const row = element("li", "ypp-list-row");
        const current = index === queue.index;
        const upcoming = !preview && index === queue.index + 1;
        const badge = current ? preview ? "最初に再生" : "再生中" : upcoming ? "次に再生" : "";
        const play = button("", () => preview ? selectPreview(index) : move(index - queue.index));
        play.classList.add("ypp-queue-item");
        play.setAttribute("aria-label", `${index + 1}. ${item.title}${badge ? `（${badge}）` : ""}`);
        const rank = element("span", "ypp-rank", String(index + 1));
        const details = element("span", "ypp-row-details");
        const title = element("span", "ypp-row-title", item.title);
        title.title = item.title;
        details.append(title);
        if (badge) details.append(element("span", `ypp-row-badge${upcoming ? " ypp-row-upcoming" : ""}`, badge));
        play.append(rank, details);
        if (index === queue.index && !preview) {
          play.setAttribute("aria-current", "true");
          play.disabled = true;
        }
        row.append(play);
        list.append(row);
      });
      listContainer.append(list);
    }
    panel.classList.add("ypp-player");
    panel.classList.toggle("ypp-confirming", stopConfirm);
    // When opened, the queue sits above the compact playback banner.
    panel.append(listContainer, bar);
    if (stopConfirm) {
      const dialog = element("div", "ypp-stop-confirm");
      dialog.setAttribute("role", "alertdialog");
      dialog.setAttribute("aria-label", "連続再生の終了確認");
      dialog.append(element("span", "", "連続再生を終了しますか？"),
        button("続ける", () => {
          stopConfirm = false;
          renderQueue();
          panel?.querySelector('[aria-label="連続再生を終了"]')?.focus();
          resumePreview();
        }),
        button("終了する", stop));
      panel.append(dialog);
    }
    panel.addEventListener("keydown", event => {
      if (event.key !== "Escape") return;
      if (stopConfirm) {
        event.preventDefault();
        event.stopPropagation();
        stopConfirm = false;
        renderQueue();
        panel?.querySelector('[aria-label="連続再生を終了"]')?.focus();
        resumePreview();
        return;
      }
      if (!listExpanded) return;
      event.preventDefault();
      event.stopPropagation();
      listExpanded = false;
      renderQueue();
      panel?.querySelector(".ypp-list-toggle")?.focus();
    });
    document.body.append(panel);
    const list = panel.querySelector(".ypp-list");
    const current = list?.querySelector('[aria-current="true"]');
    if (current) list.scrollTop = current.offsetTop - list.offsetTop;
  }
  function renderPreparation(task) {
    clearPanel();
    panel = element("aside", "ypp-panel");
    panel.setAttribute("aria-label", "再生準備");
    const info = element("div", "ypp-info");
    info.setAttribute("role", "status");
    panel.append(info, button("ここまでで再生", () => { task.finish = true; }),
      button("キャンセル", () => { task.cancelled = true; }));
    document.body.append(panel);
    task.info = info;
  }
  async function prepare() {
    if (job || !popularChip()) return;
    const task = {cancelled: false, finish: false, href: location.href, x: scrollX, y: scrollY};
    job = task;
    renderPreparation(task);
    renderControls();
    let collected = [];
    let lastGrowth = Date.now();
    const started = Date.now();
    let limited = false;
    try {
      while (true) {
        if (task.cancelled || task.href !== location.href || !popularChip()) return;
        const next = C.normalize([...collected, ...videos()]);
        if (next.length > collected.length) lastGrowth = Date.now();
        collected = next;
        setText(task.info, `人気順の動画を準備中… ${collected.length}本`);
        if (task.finish) { limited = true; break; }
        if (collected.length >= C.MAX || Date.now() - started >= 90000) { limited = true; break; }
        // Wait for lazy loading. A visible spinner/continuation may linger even at the end.
        if (Date.now() - lastGrowth > 6500) { limited = true; break; }
        const continuation = browse()?.querySelector("ytd-rich-grid-renderer ytd-continuation-item-renderer, ytd-grid-renderer ytd-continuation-item-renderer");
        if (!continuation && Date.now() - lastGrowth > 2000) break;
        (continuation || browse()?.querySelector("ytd-rich-grid-renderer, ytd-grid-renderer"))?.scrollIntoView({block: "end"});
        window.scrollTo(0, document.documentElement.scrollHeight);
        await new Promise(resolve => setTimeout(resolve, 450));
      }
      if (!collected.length) throw new Error("動画を取得できませんでした。人気の動画を表示してから再度お試しください。");
      if (task.cancelled || task.href !== location.href || !popularChip()) return;
      const value = {items: collected, index: 0, source: task.href, created: Date.now()};
      await request("write", value);
      if (task.cancelled || task.href !== location.href || !popularChip()) { await request("clear"); return; }
      queue = value;
      previewing = true;
      listExpanded = true;
      if (limited) toast(`上位${collected.length}本の一覧を表示してから再生します。`);
    } catch (error) { showError(error); }
    finally {
      job = null;
      if (previewing && queue?.source === task.href && location.href === task.href) {
        renderQueue();
        clearTimeout(previewTimer);
        previewTimer = setTimeout(startPlayback, 800);
      }
      else clearPanel();
      if (location.href === task.href) window.scrollTo(task.x, task.y);
      schedule();
    }
  }
  function openVideo(id) {
    advancing = true;
    // A full navigation avoids YouTube's unrelated recommendation queue.
    location.assign(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}&autoplay=1`);
  }
  function startPlayback() {
    if (!previewing || !queue || location.href !== queue.source) return;
    clearTimeout(previewTimer);
    previewTimer = null;
    previewing = false;
    stopConfirm = false;
    openVideo(queue.items[queue.index].id);
  }
  function resumePreview() {
    if (!previewing || !queue || previewTimer) return;
    previewTimer = setTimeout(startPlayback, 800);
  }
  async function selectPreview(index) {
    if (!previewing || !queue || index < 0 || index >= queue.items.length) return;
    const previous = queue;
    const selected = {...queue, index};
    await request("write", selected);
    if (!previewing || queue !== previous || location.href !== selected.source) return;
    queue = selected;
    renderQueue();
  }
  function requestStop() {
    if (!queue || stopConfirm) return;
    clearTimeout(previewTimer);
    previewTimer = null;
    stopConfirm = true;
    renderQueue();
  }
  async function stop() {
    clearTimeout(previewTimer);
    previewTimer = null;
    queue = null;
    listExpanded = false;
    previewing = false;
    stopConfirm = false;
    clearPanel();
    await request("clear");
  }
  async function move(delta, automatic = false) {
    if (!queue || advancing || (!automatic && C.videoId(location.href) !== queue.items[queue.index].id)) return;
    const index = queue.index + delta;
    if (index < 0) return;
    if (index >= queue.items.length) {
      await stop();
      toast("人気順の連続再生が完了しました。");
      return;
    }
    advancing = true;
    try {
      const value = {...queue, index};
      await request("write", value);
      // A stop or manual departure must win. YouTube's own autoplay can change
      // the URL while the write is in flight; automatic transitions override it.
      if (!queue || pageLeaving) { advancing = false; return; }
      if (!automatic && C.videoId(location.href) !== queue.items[queue.index].id) {
        await stop(); advancing = false; return;
      }
      queue = value;
      openVideo(value.items[index].id);
    } catch (error) { advancing = false; showError(error); }
  }
  function reconcile() {
    if (!document.body) return;
    if (navigating || advancing) return;
    if (queue && !previewing && (location.pathname !== "/watch" || C.videoId(location.href) !== queue.items[queue.index].id)) {
      stop().catch(showError);
    }
    renderControls();
    renderQueue();
    const video = document.querySelector("video.html5-main-video");
    if (queue && !previewing && video && video.readyState >= 2 && attemptedId !== queue.items[queue.index].id && !isAd()) {
      attemptedId = queue.items[queue.index].id;
      video.play().catch(() => toast("ブラウザが自動再生を止めました。動画の再生ボタンを押してください。"));
    }
  }
  function isAd() { return Boolean(document.querySelector("#movie_player.ad-showing, #movie_player.ad-interrupting")); }
  window.addEventListener("ended", event => {
    if (!queue || previewing || advancing || isAd() || !event.target.matches?.("video.html5-main-video") ||
        C.videoId(location.href) !== queue.items[queue.index].id) return;
    event.stopImmediatePropagation();
    move(1, true).catch(showError);
  }, true);
  document.addEventListener("click", event => {
    if (event.target.closest?.(".ypp-controls, .ypp-panel")) return;
    const link = event.target.closest?.('a[href]');
    if (queue && !previewing && link && link.target !== "_blank" && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      const targetId = C.videoId(link.href);
      if (targetId !== queue.items[queue.index].id) stop().catch(showError);
    }
    if (!C.isChannel(location.pathname) || !event.target.closest?.("yt-chip-cloud-chip-renderer")) return;
    if (job) job.cancelled = true;
    sortingUntil = Date.now() + 1200;
    controls?.remove(); controls = null;
    setTimeout(schedule, 1250);
  }, true);
  document.addEventListener("yt-navigate-start", () => {
    const video = document.querySelector("#movie_player video.html5-main-video");
    // Some YouTube/autoplay paths update the URL before dispatching the media
    // ended event. The still-ended main player proves the previous item finished.
    if (queue && !previewing && !advancing && !isAd() && video?.ended) move(1, true).catch(showError);
    navigating = true;
    if (job) job.cancelled = true;
    controls?.remove(); controls = null;
    clearPanel();
  });
  document.addEventListener("yt-navigate-finish", () => { navigating = false; schedule(); });
  document.addEventListener("yt-page-data-updated", schedule);
  document.addEventListener("loadeddata", schedule, true);
  window.addEventListener("popstate", schedule);
  let pageLeaving = false;
  window.addEventListener("pagehide", () => { pageLeaving = true; }, {once: true});
  window.addEventListener("pageshow", event => {
    if (!event.persisted) return;
    advancing = false;
    navigating = false;
    attemptedId = null;
    request("read").then(value => { queue = value; reconcile(); }).catch(showError);
  });
  new MutationObserver(records => {
    if (records.every(record => record.target.closest?.(".ypp-panel, .ypp-controls, .ypp-toast"))) return;
    schedule();
  }).observe(document, {subtree: true, childList: true, attributes: true, attributeFilter: ["selected", "aria-selected", "hidden"]});
  // Also handles player readiness and SPA updates with no useful DOM mutation.
  setInterval(reconcile, 1500);
  request("read").then(value => { queue = value; reconcile(); }).catch(showError);
})();
