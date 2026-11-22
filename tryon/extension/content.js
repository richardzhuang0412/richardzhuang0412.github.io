// Runs on every shopping page. Adds:
//  - a "👗 试穿" button on hover over product images
//  - a drop zone that appears whenever you start dragging an image
//  - a floating launcher that opens the studio as an in-page panel
(function () {
  if (window.top !== window || document.getElementById("tryon-host")) return;
  const X = globalThis.TryOnExtract;
  const STUDIO = chrome.runtime.getURL("studio/studio.html?embed=1");
  const ORIGIN = new URL(STUDIO).origin;

  const host = document.createElement("div");
  host.id = "tryon-host";
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `
  <style>
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif; }
    .launcher { position: fixed; right: 18px; bottom: 22px; z-index: 2147483646; width: 48px; height: 48px; border-radius: 50%;
      border: 0; background: #c2410c; color: #fff; font-size: 22px; cursor: grab; box-shadow: 0 6px 20px rgba(0,0,0,.25); }
    .launcher .n { position: absolute; top: -2px; right: -2px; min-width: 18px; height: 18px; border-radius: 9px; background: #111; color: #fff; font-size: 11px; line-height: 18px; display: none; }
    .panel { position: fixed; top: 0; right: 0; width: min(440px, 100vw); height: 100vh; z-index: 2147483645; background: #fff;
      box-shadow: -8px 0 30px rgba(0,0,0,.18); transform: translateX(105%); transition: transform .22s ease; }
    .panel.open { transform: none; }
    .panel iframe { width: 100%; height: 100%; border: 0; display: block; }
    .dock { position: fixed; top: 12px; right: 12px; bottom: 12px; width: min(420px, 60vw); z-index: 2147483647; display: none;
      align-items: center; justify-content: center; flex-direction: column; gap: 8px; border-radius: 18px;
      border: 3px dashed #c2410c; background: rgba(255, 247, 237, .93); color: #9a3412; font-size: 20px; font-weight: 700; text-align: center; }
    .dock.show { display: flex; }
    .dock.over { background: rgba(254, 215, 170, .97); }
    .dock small { font-size: 13px; font-weight: 400; color: #7c2d12; }
    .hover { position: fixed; z-index: 2147483644; display: none; padding: 5px 10px; border-radius: 999px; border: 0; cursor: pointer;
      background: rgba(17,17,17,.82); color: #fff; font-size: 13px; box-shadow: 0 2px 8px rgba(0,0,0,.3); }
    .hover:hover { background: #c2410c; }
    .toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: 30px; z-index: 2147483647; background: #111; color: #fff; padding: 8px 12px; border-radius: 10px;
      font-size: 13px; opacity: 0; transition: opacity .2s; pointer-events: none; }
    .toast.show { opacity: 1; }
  </style>
  <button class="launcher" title="试衣间（可拖动图片到这里）">👗<span class="n"></span></button>
  <div class="panel"><iframe allow="clipboard-read; clipboard-write" title="试衣间"></iframe></div>
  <div class="dock">👕 松手就穿上<small>拖到这里：加入衣橱并直接试穿</small></div>
  <button class="hover">👗 试穿</button>
  <div class="toast"></div>`;
  document.documentElement.appendChild(host);

  const $ = (s) => root.querySelector(s);
  const panel = $(".panel"),
    iframe = $("iframe"),
    dock = $(".dock"),
    hoverBtn = $(".hover"),
    launcher = $(".launcher");

  function openPanel() {
    if (!iframe.src) iframe.src = STUDIO;
    panel.classList.add("open");
    launcher.style.display = "none";
  }
  function closePanel() {
    panel.classList.remove("open");
    launcher.style.display = "";
  }
  launcher.addEventListener("click", () => (panel.classList.contains("open") ? closePanel() : openPanel()));
  window.addEventListener("message", (e) => {
    if (e.origin === ORIGIN && e.data && e.data.type === "tryon-close") closePanel();
  });

  let toastTimer;
  function toast(msg) {
    const t = $(".toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2200);
  }

  // --- push an item into the studio's inbox ------------------------------------
  async function addToStudio({ el, imageUrl }) {
    let url = imageUrl || (el && X.bestImageSrc(el));
    if (!url) return toast("没找到这张图的地址");
    let dataUrl = null;
    if (url.startsWith("blob:")) {
      try {
        const b = await (await fetch(url)).blob();
        dataUrl = await new Promise((r) => {
          const fr = new FileReader();
          fr.onload = () => r(fr.result);
          fr.readAsDataURL(b);
        });
      } catch (e) {
        return toast("这张图无法读取");
      }
    }
    const info = X.extractProduct(document, location.href);
    const alt = el && (el.getAttribute("alt") || el.getAttribute("title"));
    const title = (info.title || document.title || "").slice(0, 80);
    const id = "inbox:" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await chrome.storage.local.set({
      [id]: {
        imageUrl: url,
        dataUrl,
        pageUrl: location.href,
        title: title || alt || "网页单品",
        price: info.price ? `${info.currency || ""} ${info.price}`.trim() : "",
        category: X.guessCategory(`${alt || ""} ${title}`),
        wear: true,
        t: Date.now(),
      },
    });
    if (panel.classList.contains("open")) toast("已发送到试衣间 👗");
    openPanel();
  }

  // --- hover button on large images --------------------------------------------
  let hoverEl = null,
    raf = 0;
  function imageAt(x, y) {
    for (const el of document.elementsFromPoint(x, y)) {
      if (el === host) return null;
      if (el.tagName === "IMG") return el;
    }
    return null;
  }
  document.addEventListener(
    "mousemove",
    (e) => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (e.composedPath()[0] === hoverBtn) return;
        const img = imageAt(e.clientX, e.clientY);
        const r = img && img.getBoundingClientRect();
        if (img && r.width >= 160 && r.height >= 160) {
          hoverEl = img;
          hoverBtn.style.display = "block";
          hoverBtn.style.left = Math.max(4, r.left + 10) + "px";
          hoverBtn.style.top = Math.max(4, r.top + 10) + "px";
        } else if (!img) {
          hoverBtn.style.display = "none";
          hoverEl = null;
        }
      });
    },
    { passive: true }
  );
  hoverBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (hoverEl) addToStudio({ el: hoverEl });
  });

  // --- drag an image anywhere -> drop zone ------------------------------------
  let dragged = null;
  document.addEventListener(
    "dragstart",
    (e) => {
      const t = e.target;
      const img = t && (t.tagName === "IMG" ? t : t.querySelector && t.querySelector("img"));
      if (!img) return;
      dragged = img;
      dock.classList.add("show");
      hoverBtn.style.display = "none";
    },
    true
  );
  document.addEventListener(
    "dragend",
    () => {
      dock.classList.remove("show", "over");
      dragged = null;
    },
    true
  );
  // Images dragged in from other tabs/windows: show the dock too.
  document.addEventListener("dragenter", (e) => {
    if (!dragged && e.dataTransfer && Array.from(e.dataTransfer.types || []).some((t) => t === "Files" || t === "text/uri-list"))
      dock.classList.add("show");
  });
  dock.addEventListener("dragover", (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    dock.classList.add("over");
  });
  dock.addEventListener("dragleave", () => dock.classList.remove("over"));
  dock.addEventListener("drop", async (e) => {
    e.preventDefault();
    dock.classList.remove("show", "over");
    if (dragged) return addToStudio({ el: dragged });
    const d = X.readDataTransfer(e.dataTransfer);
    if (d.files.length) {
      const fr = new FileReader();
      fr.onload = () => addToStudio({ imageUrl: fr.result });
      return fr.readAsDataURL(d.files[0]);
    }
    if (d.imageUrl || d.linkUrl) return addToStudio({ imageUrl: d.imageUrl || d.linkUrl });
  });
  window.addEventListener("dragleave", (e) => {
    if (!dragged && (e.clientX <= 0 || e.clientY <= 0 || e.clientX >= innerWidth || e.clientY >= innerHeight)) dock.classList.remove("show", "over");
  });
  // Launcher also accepts drops.
  launcher.addEventListener("dragover", (e) => e.preventDefault());
  launcher.addEventListener("drop", (e) => {
    e.preventDefault();
    dock.classList.remove("show");
    if (dragged) addToStudio({ el: dragged });
  });

  // --- messages from the context menu -------------------------------------------
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "tryon-add") {
      const el = Array.from(document.images).find((i) => i.currentSrc === msg.imageUrl || i.src === msg.imageUrl);
      addToStudio({ el, imageUrl: msg.imageUrl });
    } else if (msg.type === "tryon-add-page") {
      const info = X.extractProduct(document, location.href);
      if (info.images[0]) addToStudio({ imageUrl: info.images[0] });
      else toast("这个页面没识别到商品图，试试直接拖图片");
    }
  });

  // Badge: number of wardrobe items.
  chrome.storage.local.get("wardrobe").then(({ wardrobe }) => setCount((wardrobe || []).length));
  chrome.storage.onChanged.addListener((c) => c.wardrobe && setCount((c.wardrobe.newValue || []).length));
  function setCount(n) {
    const b = $(".launcher .n");
    b.textContent = n;
    b.style.display = n ? "block" : "none";
  }
})();
