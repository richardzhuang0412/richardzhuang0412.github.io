import * as store from "./store.js";
import { normalize, cutout, onWhite, loadImage, blobToDataURL, autoPlace, composite, drawLayer, CATEGORIES, DEFAULT_BODY } from "./imaging.js";
import { parseSizeChart, recommend, estimateBody } from "./fit.js";

const X = globalThis.TryOnExtract;
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const INSTANCE = uid();
const params = new URLSearchParams(location.search);
const EMBED = params.has("embed") || params.has("panel");

// ---------------------------------------------------------------------------
// State
const S = {
  profile: { gender: "female", pref: "regular" },
  settings: { serverUrl: "http://localhost:8787", provider: "auto" },
  photos: [], // {id, src, name}
  activePhotoId: null,
  wardrobe: [], // {id, name, category, original, src, cut, tolerance, sizeChart, sourceUrl, price, addedAt}
  outfit: [], // itemIds, index 0 = innermost / drawn first
  hidden: [], // itemIds hidden in the preview
  placements: {}, // photoId -> itemId -> {cx, cy, w, rot}
  bodies: {}, // photoId -> body box
  renders: {}, // signature -> image (memory only)
};
const PERSIST = ["profile", "settings", "photos", "activePhotoId", "wardrobe", "outfit", "hidden", "placements", "bodies"];
let selectedId = null;
let view = "edit";
let bodyMode = false;

const imgCache = new Map();
function cachedImage(src) {
  if (!imgCache.has(src)) {
    const p = loadImage(src).then((img) => {
      p.img = img;
      draw();
      return img;
    });
    imgCache.set(src, p);
  }
  return imgCache.get(src).img || null;
}

const item = (id) => S.wardrobe.find((w) => w.id === id);
const activePhoto = () => S.photos.find((p) => p.id === S.activePhotoId) || null;
const body = () => (S.activePhotoId && S.bodies[S.activePhotoId]) || DEFAULT_BODY;

// ---------------------------------------------------------------------------
// Persistence (debounced) + cross-context sync for the extension
const dirty = new Set();
let saveTimer = null;
let firstDirty = 0;
function save(...keys) {
  keys.forEach((k) => dirty.add(k));
  clearTimeout(saveTimer);
  firstDirty ||= Date.now();
  // debounce, but never hold changes for more than ~1s
  saveTimer = setTimeout(flush, Date.now() - firstDirty > 1000 ? 0 : 200);
}
addEventListener("pagehide", () => dirty.size && flush());
document.addEventListener("visibilitychange", () => document.hidden && dirty.size && flush());
async function flush() {
  clearTimeout(saveTimer);
  firstDirty = 0;
  const keys = [...dirty];
  if (!keys.length) return;
  dirty.clear();
  try {
    for (const k of keys) await store.set(k, S[k]);
    await store.set("sync", { by: INSTANCE, keys, t: Date.now() });
  } catch (e) {
    toast("保存失败：" + e.message);
  }
}
async function loadAll() {
  for (const k of PERSIST) {
    const v = await store.get(k);
    if (v != null) S[k] = v;
  }
  S.settings = { serverUrl: "http://localhost:8787", provider: "auto", ...S.settings };
}

// ---------------------------------------------------------------------------
// UI helpers
let toastTimer;
function toast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}
function status(msg, err = false) {
  const el = $("#renderStatus");
  el.textContent = msg || "";
  el.classList.toggle("err", !!err);
}
function setTab(name) {
  $$(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
  $$(".tab").forEach((t) => t.classList.toggle("active", t.id === "tab-" + name));
  if (name === "stage") requestAnimationFrame(resize);
}
function setView(v) {
  view = v;
  $$("#viewSeg button").forEach((b) => b.classList.toggle("active", b.dataset.view === v));
  const r = S.renders[signature()];
  $("#aiResult").hidden = !(v === "ai" && r);
  if (v === "ai" && r) $("#aiResult").src = r;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// ---------------------------------------------------------------------------
// Fetching images / pages (extension pages may fetch cross-origin directly;
// the plain web page falls back to the local server's proxy).
function server() {
  return (S.settings.serverUrl || "").replace(/\/+$/, "");
}
async function fetchImageDataURL(url) {
  if (url.startsWith("data:")) return url;
  const attempts = [() => fetch(url, { referrerPolicy: "no-referrer" })];
  if (server()) attempts.push(() => fetch(server() + "/api/image?url=" + encodeURIComponent(url)));
  let lastErr;
  for (const go of attempts) {
    try {
      const r = await go();
      if (!r.ok) throw new Error("HTTP " + r.status);
      const blob = await r.blob();
      if (!blob.type.startsWith("image/")) throw new Error("不是图片");
      return await blobToDataURL(blob);
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("无法下载图片（" + (lastErr && lastErr.message) + "）。网页版需要启动本地服务，或使用浏览器插件。");
}
async function fetchPage(url) {
  const tries = [];
  if (store.isExtension) tries.push(() => fetch(url, { credentials: "include" }));
  if (server()) tries.push(() => fetch(server() + "/api/fetch?url=" + encodeURIComponent(url)));
  if (!tries.length) throw new Error("网页版需要启动本地服务（node server/server.mjs）才能解析商品链接");
  let lastErr;
  for (const go of tries) {
    try {
      const r = await go();
      if (!r.ok) throw new Error("HTTP " + r.status);
      const type = r.headers.get("content-type") || "";
      if (type.startsWith("image/")) return { image: await blobToDataURL(await r.blob()) };
      return { html: await r.text() };
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("打不开这个链接：" + (lastErr && lastErr.message));
}

// ---------------------------------------------------------------------------
// Wardrobe
async function addGarment({ src, name, category, sourceUrl, price, wear = true, sizeChart = "" }) {
  const existing = !src.startsWith("data:") && S.wardrobe.find((w) => w.imageUrl === src);
  if (existing) {
    if (wear) wear_(existing.id, true);
    toast(`衣橱里已经有了：${existing.name}${wear ? "，已穿上" : ""}`);
    return existing;
  }
  status("正在处理图片…");
  try {
    const data = await fetchImageDataURL(src);
    const original = await normalize(data, 1200, "image/png");
    const cut = await cutout(original, 28);
    const it = {
      id: uid(),
      name: name || "未命名单品",
      category: category || X.guessCategory(name),
      original,
      src: cut.removed > 0.03 ? cut.src : original,
      cut: cut.removed > 0.03,
      tolerance: 28,
      sizeChart,
      sourceUrl: sourceUrl || "",
      imageUrl: src.startsWith("data:") ? "" : src,
      price: price || "",
      addedAt: Date.now(),
    };
    S.wardrobe.unshift(it);
    save("wardrobe");
    if (wear) wear_(it.id, true);
    renderAll();
    status(cut.removed > 0.03 ? "" : "这张图背景不是纯色，未能自动抠图：叠搭预览会带背景，AI 渲染不受影响。");
    toast(`已加入衣橱${wear ? "并穿上" : ""}：${it.name}`);
    return it;
  } catch (e) {
    status(e.message, true);
    throw e;
  }
}

function wear_(id, on) {
  const isOn = S.outfit.includes(id);
  if (on === undefined) on = !isOn;
  if (on && !isOn) {
    // Single-slot categories replace what's there; tops and outer layers stack.
    const cat = item(id).category;
    const clash = { bottom: ["bottom", "dress"], dress: ["dress", "bottom"], shoes: ["shoes"], hat: ["hat"], bag: ["bag"] }[cat] || [];
    const removed = S.outfit.filter((o) => clash.includes(item(o)?.category));
    if (removed.length) {
      S.outfit = S.outfit.filter((o) => !removed.includes(o));
      toast(`已替换：${removed.map((o) => item(o).name).join("、")}`);
    }
    const z = (CATEGORIES[cat] || CATEGORIES.top).z;
    let idx = S.outfit.length;
    while (idx > 0 && (CATEGORIES[item(S.outfit[idx - 1])?.category] || CATEGORIES.top).z > z) idx--;
    S.outfit.splice(idx, 0, id);
    selectedId = id;
  } else if (!on && isOn) {
    S.outfit = S.outfit.filter((x) => x !== id);
    if (selectedId === id) selectedId = null;
  }
  save("outfit");
  setView("edit");
  renderAll();
}

function placementFor(id) {
  const p = activePhoto();
  if (!p) return null;
  const map = (S.placements[p.id] ||= {});
  if (!map[id]) {
    const it = item(id);
    const gi = it && cachedImage(it.src);
    const pi = cachedImage(p.src);
    if (!gi || !pi) return null; // images still loading; draw() reruns when ready
    map[id] = autoPlace(it.category, gi.naturalWidth, gi.naturalHeight, pi.naturalWidth, pi.naturalHeight, body());
    save("placements");
  }
  return map[id];
}

function autoPlaceAll() {
  const p = activePhoto();
  if (!p) return;
  S.placements[p.id] = {};
  save("placements");
  draw();
}

// Layers to draw, inner -> outer.
function layers() {
  return S.outfit
    .map((id) => ({ id, it: item(id), pl: placementFor(id) }))
    .filter((l) => l.it && l.pl)
    .map((l) => ({ ...l.pl, id: l.id, src: l.it.src, visible: !S.hidden.includes(l.id) }));
}
function signature() {
  return JSON.stringify([S.activePhotoId, S.outfit.filter((id) => !S.hidden.includes(id))]);
}

// ---------------------------------------------------------------------------
// Canvas stage
const canvas = $("#canvas");
const ctx = canvas.getContext("2d");
let geo = { fx: 0, fy: 0, fw: 1, fh: 1, dpr: 1 };

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(r.width * dpr));
  canvas.height = Math.max(1, Math.round(r.height * dpr));
  geo.dpr = dpr;
  draw();
}

function draw() {
  const p = activePhoto();
  $("#stageEmpty").hidden = !!p;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!p) return;
  const photo = cachedImage(p.src);
  if (!photo) return;
  const cw = canvas.width,
    ch = canvas.height;
  const s = Math.min(cw / photo.naturalWidth, ch / photo.naturalHeight);
  const fw = photo.naturalWidth * s,
    fh = photo.naturalHeight * s;
  geo = { ...geo, fx: (cw - fw) / 2, fy: (ch - fh) / 2, fw, fh };
  ctx.drawImage(photo, geo.fx, geo.fy, fw, fh);

  for (const L of layers()) {
    if (!L.visible) continue;
    const img = cachedImage(L.src);
    if (img) drawLayer(ctx, img, L, fw, fh, geo.fx, geo.fy);
  }
  const sel = selectedId && layers().find((l) => l.id === selectedId);
  if (sel && !bodyMode && view === "edit") drawSelection(sel);
  if (bodyMode) drawBody();
}

function layerBox(L) {
  const img = cachedImage(L.src);
  const w = L.w * geo.fw;
  const h = img ? w * (img.naturalHeight / img.naturalWidth) : w;
  return { x: geo.fx + L.cx * geo.fw, y: geo.fy + L.cy * geo.fh, w, h, rot: L.rot || 0 };
}
const HANDLE = () => 9 * geo.dpr;

function drawSelection(L) {
  const b = layerBox(L);
  ctx.save();
  ctx.translate(b.x, b.y);
  ctx.rotate(b.rot);
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#c2410c";
  ctx.lineWidth = 1.5 * geo.dpr;
  ctx.setLineDash([5 * geo.dpr, 4 * geo.dpr]);
  ctx.strokeRect(-b.w / 2, -b.h / 2, b.w, b.h);
  ctx.setLineDash([]);
  ctx.fillStyle = "#fff";
  const hs = HANDLE();
  // scale handle (bottom-right) and rotate handle (top centre)
  ctx.beginPath();
  ctx.rect(b.w / 2 - hs / 2, b.h / 2 - hs / 2, hs, hs);
  ctx.moveTo(hs / 2, -b.h / 2 - 22 * geo.dpr);
  ctx.arc(0, -b.h / 2 - 22 * geo.dpr, hs / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(0, -b.h / 2);
  ctx.lineTo(0, -b.h / 2 - 22 * geo.dpr + hs / 2);
  ctx.stroke();
  ctx.restore();
}

function bodyRect() {
  const B = body();
  return { x: geo.fx + B.x * geo.fw, y: geo.fy + B.y * geo.fh, w: B.w * geo.fw, h: B.h * geo.fh };
}
function drawBody() {
  const r = bodyRect();
  ctx.save();
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  ctx.fillRect(geo.fx, geo.fy, geo.fw, geo.fh);
  ctx.clearRect(r.x, r.y, r.w, r.h);
  const photo = cachedImage(activePhoto().src);
  // redraw the photo inside the box so it is not darkened
  ctx.beginPath();
  ctx.rect(r.x, r.y, r.w, r.h);
  ctx.clip();
  ctx.drawImage(photo, geo.fx, geo.fy, geo.fw, geo.fh);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = "#fb923c";
  ctx.lineWidth = 2 * geo.dpr;
  ctx.setLineDash([6 * geo.dpr, 4 * geo.dpr]);
  ctx.strokeRect(r.x, r.y, r.w, r.h);
  ctx.setLineDash([]);
  ctx.fillStyle = "#fff";
  const hs = HANDLE() * 1.3;
  for (const [x, y] of [
    [r.x, r.y],
    [r.x + r.w, r.y + r.h],
  ]) {
    ctx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
    ctx.strokeRect(x - hs / 2, y - hs / 2, hs, hs);
  }
  // guide lines: shoulders / waist / hips / knees
  ctx.lineWidth = 1 * geo.dpr;
  ctx.font = `${11 * geo.dpr}px sans-serif`;
  for (const [f, label] of [
    [0.16, "肩"],
    [0.42, "腰"],
    [0.5, "臀"],
    [0.72, "膝"],
  ]) {
    const y = r.y + r.h * f;
    ctx.globalAlpha = 0.7;
    ctx.beginPath();
    ctx.moveTo(r.x, y);
    ctx.lineTo(r.x + r.w, y);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#fb923c";
    ctx.fillText(label, r.x + r.w + 4 * geo.dpr, y + 4 * geo.dpr);
  }
  ctx.restore();
}

function toCanvas(e) {
  const r = canvas.getBoundingClientRect();
  return { x: (e.clientX - r.left) * geo.dpr, y: (e.clientY - r.top) * geo.dpr };
}
function toLocal(pt, b) {
  const dx = pt.x - b.x,
    dy = pt.y - b.y;
  const c = Math.cos(-b.rot),
    s = Math.sin(-b.rot);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  if (view !== "edit" || !activePhoto()) return;
  const pt = toCanvas(e);
  const hs = HANDLE() * 1.6;
  if (bodyMode) {
    const r = bodyRect();
    const B = { ...body() };
    let mode = "move";
    if (Math.hypot(pt.x - r.x, pt.y - r.y) < hs) mode = "tl";
    else if (Math.hypot(pt.x - r.x - r.w, pt.y - r.y - r.h) < hs) mode = "br";
    else if (!(pt.x > r.x && pt.x < r.x + r.w && pt.y > r.y && pt.y < r.y + r.h)) return;
    drag = { kind: "body", mode, start: pt, B };
  } else {
    const all = layers().filter((l) => l.visible);
    const sel = all.find((l) => l.id === selectedId);
    if (sel) {
      const b = layerBox(sel);
      const lp = toLocal(pt, b);
      if (Math.hypot(lp.x - b.w / 2, lp.y - b.h / 2) < hs) drag = { kind: "scale", id: sel.id, b, start: pt, L: { ...placementFor(sel.id) } };
      else if (Math.hypot(lp.x, lp.y + b.h / 2 + 22 * geo.dpr) < hs) drag = { kind: "rotate", id: sel.id, b };
    }
    if (!drag) {
      const hit = [...all].reverse().find((l) => {
        const b = layerBox(l);
        const lp = toLocal(pt, b);
        return Math.abs(lp.x) <= b.w / 2 && Math.abs(lp.y) <= b.h / 2;
      });
      selectedId = hit ? hit.id : null;
      if (hit) drag = { kind: "move", id: hit.id, start: pt, L: { ...placementFor(hit.id) } };
      renderLayers();
    }
  }
  if (drag) canvas.setPointerCapture(e.pointerId);
  draw();
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) {
    canvas.style.cursor = bodyMode ? "crosshair" : "default";
    return;
  }
  const pt = toCanvas(e);
  if (drag.kind === "body") {
    const dx = (pt.x - drag.start.x) / geo.fw,
      dy = (pt.y - drag.start.y) / geo.fh;
    const B = { ...drag.B };
    if (drag.mode === "move") {
      B.x += dx;
      B.y += dy;
    } else if (drag.mode === "tl") {
      B.x += dx;
      B.y += dy;
      B.w -= dx;
      B.h -= dy;
    } else {
      B.w += dx;
      B.h += dy;
    }
    B.w = Math.max(0.05, B.w);
    B.h = Math.max(0.1, B.h);
    S.bodies[S.activePhotoId] = B;
  } else {
    const P = placementFor(drag.id);
    if (drag.kind === "move") {
      P.cx = drag.L.cx + (pt.x - drag.start.x) / geo.fw;
      P.cy = drag.L.cy + (pt.y - drag.start.y) / geo.fh;
    } else if (drag.kind === "scale") {
      const d0 = Math.hypot(drag.start.x - drag.b.x, drag.start.y - drag.b.y);
      const d1 = Math.hypot(pt.x - drag.b.x, pt.y - drag.b.y);
      P.w = Math.max(0.02, drag.L.w * (d1 / d0));
    } else if (drag.kind === "rotate") {
      P.rot = Math.atan2(pt.y - drag.b.y, pt.x - drag.b.x) + Math.PI / 2;
      if (Math.abs(P.rot) < 0.06) P.rot = 0;
    }
  }
  draw();
});
const endDrag = () => {
  if (!drag) return;
  if (drag.kind === "body") save("bodies");
  else save("placements");
  drag = null;
};
canvas.addEventListener("pointerup", endDrag);
canvas.addEventListener("pointercancel", endDrag);
canvas.addEventListener(
  "wheel",
  (e) => {
    if (!selectedId || view !== "edit" || bodyMode) return;
    e.preventDefault();
    const P = placementFor(selectedId);
    P.w = Math.max(0.02, P.w * (e.deltaY < 0 ? 1.04 : 1 / 1.04));
    save("placements");
    draw();
  },
  { passive: false }
);
document.addEventListener("keydown", (e) => {
  if (!selectedId || e.target.closest("input,textarea,select") || view !== "edit") return;
  const P = placementFor(selectedId);
  const step = e.shiftKey ? 0.02 : 0.004;
  const k = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (k) {
    P.cx += k[0];
    P.cy += k[1];
    save("placements");
    draw();
    e.preventDefault();
  } else if (e.key === "Delete" || e.key === "Backspace") {
    wear_(selectedId, false);
    e.preventDefault();
  }
});

// ---------------------------------------------------------------------------
// Side panel: layers + fit
function renderLayers() {
  const list = $("#layerList");
  const ids = [...S.outfit].reverse();
  $("#layerEmpty").hidden = ids.length > 0;
  list.innerHTML = ids
    .map((id) => {
      const it = item(id);
      if (!it) return "";
      const hidden = S.hidden.includes(id);
      return `<li class="layer ${id === selectedId ? "selected" : ""} ${hidden ? "hidden-layer" : ""}" data-id="${id}">
        <img src="${it.src}" alt="">
        <div><div class="name">${esc(it.name)}</div><div class="meta">${CATEGORIES[it.category]?.label || ""}${
          it.price ? " · " + esc(it.price) : ""
        }</div></div>
        <div class="acts">
          <button data-act="up" title="往外层">▲</button>
          <button data-act="down" title="往内层">▼</button>
          <button data-act="vis" title="显示/隐藏">${hidden ? "◌" : "●"}</button>
          <button data-act="edit" title="尺码/详情">✎</button>
          <button data-act="off" title="脱下">✕</button>
        </div></li>`;
    })
    .join("");
  renderFit();
}
$("#layerList").addEventListener("click", (e) => {
  const li = e.target.closest(".layer");
  if (!li) return;
  const id = li.dataset.id;
  const act = e.target.closest("button")?.dataset.act;
  const i = S.outfit.indexOf(id);
  if (act === "up" && i < S.outfit.length - 1) [S.outfit[i], S.outfit[i + 1]] = [S.outfit[i + 1], S.outfit[i]];
  else if (act === "down" && i > 0) [S.outfit[i], S.outfit[i - 1]] = [S.outfit[i - 1], S.outfit[i]];
  else if (act === "vis") S.hidden = S.hidden.includes(id) ? S.hidden.filter((x) => x !== id) : [...S.hidden, id];
  else if (act === "edit") return openItem(id);
  else if (act === "off") return wear_(id, false);
  selectedId = id;
  save("outfit", "hidden");
  setView("edit");
  renderLayers();
  draw();
});

function bodyMeasurements() {
  const p = S.profile;
  const num = (v) => (v === "" || v == null ? null : +v);
  const est = estimateBody({ height: num(p.height), weight: num(p.weight), gender: p.gender });
  const out = {};
  for (const k of ["chest", "waist", "hip", "shoulder"]) out[k] = num(p[k]) || est[k] || null;
  out.estimated = ["chest", "waist", "hip", "shoulder"].some((k) => !num(p[k]) && est[k]);
  return out;
}

function fitHTML(it) {
  const rows = parseSizeChart(it.sizeChart);
  const b = bodyMeasurements();
  if (!rows.length) return null;
  if (!b.chest && !b.waist && !b.hip) return `<div class="muted">在「我的」里填身高体重或三围，就能判断尺码。</div>`;
  const { best, all } = recommend(rows, b, S.profile.pref || "regular");
  return { best, all, b };
}

function renderFit() {
  const box = $("#fitBox");
  const it = item(selectedId) || S.outfit.map(item).find((x) => x && x.sizeChart);
  if (!it) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const r = fitHTML(it);
  if (!r) {
    box.innerHTML = `<b>${esc(it.name)}</b><div class="muted">粘贴这件的尺码表，就能告诉你哪个码合适。</div>
      <button class="btn ghost" data-open="${it.id}" style="margin-top:6px">粘贴尺码表</button>`;
  } else if (typeof r === "string") {
    box.innerHTML = `<b>${esc(it.name)}</b>${r}`;
  } else if (!r.best) {
    box.innerHTML = `<b>${esc(it.name)}</b><div class="muted">尺码表里没有能和你身体数据对比的项（胸围/腰围/臀围/肩宽）。</div>`;
  } else {
    box.innerHTML = `<div class="fit-row"><b>${esc(it.name)}</b><span>推荐 <b style="color:var(--accent)">${esc(r.best.size)}</b></span></div>
      ${r.best.checks
        .map(
          (c) =>
            `<div class="fit-row"><span>${c.label} ${c.garment} vs 你 ${c.body}（${c.ease >= 0 ? "+" : ""}${c.ease.toFixed(
              1
            )}）</span><span class="tag ${c.level}">${c.text}</span></div>`
        )
        .join("")}
      <div class="muted">${r.b.estimated ? "部分身体数据由身高体重估算，实测更准。" : ""}偏好：${
        { slim: "修身", regular: "常规", loose: "宽松" }[S.profile.pref || "regular"]
      }</div>
      <button class="btn ghost" data-open="${it.id}" style="margin-top:6px">查看所有尺码</button>`;
  }
}
$("#fitBox").addEventListener("click", (e) => {
  const id = e.target.closest("[data-open]")?.dataset.open;
  if (id) openItem(id);
});

// ---------------------------------------------------------------------------
// Wardrobe grid
function renderWardrobe() {
  $("#wardrobeCount").textContent = S.wardrobe.length;
  const f = $("#filterCat").value;
  const items = S.wardrobe.filter((w) => !f || w.category === f);
  $("#wardrobeGrid").innerHTML =
    items
      .map(
        (w) => `<div class="card ${S.outfit.includes(w.id) ? "worn" : ""}" data-id="${w.id}" draggable="true">
        <span class="badge">${CATEGORIES[w.category]?.label || w.category}</span>
        <button class="edit" data-edit="${w.id}">✎</button>
        <img src="${w.src}" alt="" loading="lazy"><div class="cap">${esc(w.name)}</div></div>`
      )
      .join("") || `<div class="muted">衣橱是空的。上传单品图、粘贴商品链接，或在购物网站上用插件拖图进来。</div>`;
}
$("#wardrobeGrid").addEventListener("click", (e) => {
  const edit = e.target.closest("[data-edit]");
  if (edit) return openItem(edit.dataset.edit);
  const card = e.target.closest(".card");
  if (card) wear_(card.dataset.id);
});
$("#filterCat").addEventListener("change", renderWardrobe);

// Photos
function renderPhotos() {
  $("#photoGrid").innerHTML =
    S.photos
      .map(
        (p) => `<div class="card ${p.id === S.activePhotoId ? "active-photo" : ""}" data-id="${p.id}">
        <button class="edit" data-del="${p.id}" title="删除">✕</button>
        <img src="${p.src}" alt=""><div class="cap">${p.id === S.activePhotoId ? "✓ 正在使用" : "点击使用"}</div></div>`
      )
      .join("") || `<div class="muted">还没有照片。</div>`;
}
$("#photoGrid").addEventListener("click", (e) => {
  const del = e.target.closest("[data-del]");
  if (del) {
    S.photos = S.photos.filter((p) => p.id !== del.dataset.del);
    if (S.activePhotoId === del.dataset.del) S.activePhotoId = S.photos[0]?.id || null;
    save("photos", "activePhotoId");
    return renderAll();
  }
  const card = e.target.closest(".card");
  if (card) {
    S.activePhotoId = card.dataset.id;
    save("activePhotoId");
    renderAll();
    setTab("stage");
  }
});
async function addPhoto(src, name = "我的照片") {
  const data = await normalize(src, 1600, "image/jpeg");
  const p = { id: uid(), src: data, name };
  S.photos.push(p);
  S.activePhotoId = p.id;
  save("photos", "activePhotoId");
  renderAll();
  return p;
}

function renderAll() {
  renderLayers();
  renderWardrobe();
  renderPhotos();
  $("#viewSeg [data-view=ai]").disabled = !S.renders[signature()];
  draw();
}

// ---------------------------------------------------------------------------
// Item dialog
const dlg = $("#itemDialog");
const form = $("#itemForm");
let editingId = null;
let previewTimer;
function openItem(id) {
  const it = item(id);
  if (!it) return;
  editingId = id;
  form.name.value = it.name;
  form.category.value = it.category;
  form.price.value = it.price || "";
  form.sourceUrl.value = it.sourceUrl || "";
  form.cut.value = it.cut ? "1" : "0";
  form.tolerance.value = it.tolerance || 28;
  form.sizeChart.value = it.sizeChart || "";
  $("#itemPreview").src = it.src;
  renderItemFit();
  dlg.showModal();
}
async function refreshPreview() {
  const it = item(editingId);
  if (!it) return;
  $("#itemPreview").src = form.cut.value === "1" ? (await cutout(it.original, +form.tolerance.value)).src : it.original;
}
form.cut.addEventListener("change", refreshPreview);
form.tolerance.addEventListener("input", () => {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 150);
});
form.sizeChart.addEventListener("input", renderItemFit);
function renderItemFit() {
  const rows = parseSizeChart(form.sizeChart.value);
  const el = $("#itemFit");
  if (!rows.length) {
    el.innerHTML = form.sizeChart.value.trim()
      ? `<div class="muted">没识别出尺码行。第一行写表头（如：尺码 胸围 衣长），后面每行一个尺码。</div>`
      : "";
    return;
  }
  const b = bodyMeasurements();
  const { best, all } = recommend(rows, b, S.profile.pref || "regular");
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r).filter((k) => k !== "size")))];
  const L = { chest: "胸围", waist: "腰围", hip: "臀围", shoulder: "肩宽", length: "长度", sleeve: "袖长" };
  el.innerHTML = `<table><tr><th>尺码</th>${cols.map((c) => `<th>${L[c]}</th>`).join("")}<th>判断</th></tr>
    ${rows
      .map((r, i) => {
        const ev = all[i];
        const v = ev.checks.map((c) => `<span class="tag ${c.level}">${c.label}${c.text}</span>`).join(" ");
        return `<tr class="${best && best.size === r.size ? "best" : ""}"><td>${esc(r.size)}${best && best.size === r.size ? " ★" : ""}</td>${cols
          .map((c) => `<td>${r[c] ?? ""}</td>`)
          .join("")}<td>${v || '<span class="muted">缺身体数据</span>'}</td></tr>`;
      })
      .join("")}</table>`;
}
dlg.addEventListener("close", async () => {
  const it = item(editingId);
  if (!it) return;
  if (dlg.returnValue === "delete") {
    S.wardrobe = S.wardrobe.filter((w) => w.id !== it.id);
    S.outfit = S.outfit.filter((x) => x !== it.id);
    save("wardrobe", "outfit");
  } else if (dlg.returnValue === "save") {
    const catChanged = it.category !== form.category.value;
    const cutChanged = it.cut !== (form.cut.value === "1") || it.tolerance !== +form.tolerance.value;
    Object.assign(it, {
      name: form.name.value.trim() || it.name,
      category: form.category.value,
      price: form.price.value.trim(),
      sourceUrl: form.sourceUrl.value.trim(),
      cut: form.cut.value === "1",
      tolerance: +form.tolerance.value,
      sizeChart: form.sizeChart.value,
    });
    if (cutChanged) it.src = it.cut ? (await cutout(it.original, it.tolerance)).src : it.original;
    if (catChanged || cutChanged) Object.values(S.placements).forEach((m) => delete m[it.id]);
    save("wardrobe", "placements");
  }
  renderAll();
});

// ---------------------------------------------------------------------------
// Links
async function handleLink(url) {
  url = url.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url) && !url.startsWith("data:image")) return toast("请粘贴 http(s) 链接");
  const picker = $("#linkPicker");
  status("正在解析链接…");
  try {
    if (/\.(jpe?g|png|webp|avif|gif)(\?|#|$)/i.test(url) || url.startsWith("data:image")) {
      await addGarment({ src: url, name: "链接图片", sourceUrl: url });
      return;
    }
    const page = await fetchPage(url);
    if (page.image) {
      await addGarment({ src: page.image, name: "链接图片", sourceUrl: url });
      return;
    }
    const doc = new DOMParser().parseFromString(page.html, "text/html");
    const info = X.extractProduct(doc, url);
    status("");
    if (!info.images.length) throw new Error("没在页面里找到商品图（可能需要登录或被反爬）。可以用插件直接在商品页上拖图。");
    picker.hidden = false;
    picker.innerHTML = `<div class="fit-row"><b>${esc(info.title || "商品")}</b><span>${esc(
      info.price ? (info.currency || "") + " " + info.price : ""
    )}</span></div>
      <div class="muted">选一张图穿上（平铺/白底图效果最好）·
        <select id="pickCat">${Object.entries(CATEGORIES)
          .map(([k, v]) => `<option value="${k}" ${k === info.category ? "selected" : ""}>${v.label}</option>`)
          .join("")}</select>
        <button class="btn ghost" id="pickClose" type="button">关闭</button></div>
      <div class="imgs">${info.images.map((u) => `<img src="${esc(u)}" data-src="${esc(u)}" referrerpolicy="no-referrer" alt="">`).join("")}</div>`;
    picker.onclick = async (e) => {
      if (e.target.id === "pickClose") return (picker.hidden = true);
      const src = e.target.dataset && e.target.dataset.src;
      if (!src) return;
      await addGarment({
        src,
        name: info.title,
        category: $("#pickCat").value,
        sourceUrl: url,
        price: info.price ? `${info.currency || ""} ${info.price}`.trim() : "",
      });
    };
  } catch (e) {
    status(e.message, true);
  }
}
$("#linkForm").addEventListener("submit", (e) => {
  e.preventDefault();
  handleLink($("#linkInput").value);
  $("#linkInput").value = "";
});

// ---------------------------------------------------------------------------
// Drag & drop / paste anywhere
let dragDepth = 0;
document.addEventListener("dragenter", (e) => {
  if (e.target.closest && e.target.closest("#wardrobeGrid")) return;
  dragDepth++;
  document.body.classList.add("dragging");
});
document.addEventListener("dragleave", () => {
  if (--dragDepth <= 0) {
    dragDepth = 0;
    document.body.classList.remove("dragging");
  }
});
document.addEventListener("dragover", (e) => e.preventDefault());
document.addEventListener("drop", async (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove("dragging");
  const wardrobeId = e.dataTransfer.getData("application/x-tryon-item");
  if (wardrobeId) return wear_(wardrobeId, true);
  const d = X.readDataTransfer(e.dataTransfer);
  const toPhotos = $("#tab-me").classList.contains("active");
  for (const f of d.files) {
    const src = await blobToDataURL(f);
    if (toPhotos) await addPhoto(src, f.name);
    else await addGarment({ src, name: f.name.replace(/\.\w+$/, "") });
  }
  if (!d.files.length && d.imageUrl) {
    if (toPhotos) await addPhoto(await fetchImageDataURL(d.imageUrl));
    else await addGarment({ src: d.imageUrl, name: "拖入的单品", sourceUrl: d.linkUrl || "" });
  } else if (!d.files.length && d.linkUrl) handleLink(d.linkUrl);
});
$("#wardrobeGrid").addEventListener("dragstart", (e) => {
  const card = e.target.closest(".card");
  if (card) e.dataTransfer.setData("application/x-tryon-item", card.dataset.id);
});
document.addEventListener("paste", async (e) => {
  if (e.target.closest("input,textarea")) return;
  const file = Array.from(e.clipboardData.files || []).find((f) => f.type.startsWith("image/"));
  if (file) return addGarment({ src: await blobToDataURL(file), name: "粘贴的图片" });
  const text = e.clipboardData.getData("text");
  if (/^https?:\/\//.test(text)) handleLink(text);
});

// ---------------------------------------------------------------------------
// Uploads
$("#garmentFile").addEventListener("change", async (e) => {
  for (const f of e.target.files) await addGarment({ src: await blobToDataURL(f), name: f.name.replace(/\.\w+$/, ""), wear: false });
  e.target.value = "";
});
$("#photoFile").addEventListener("change", async (e) => {
  for (const f of e.target.files) await addPhoto(await blobToDataURL(f), f.name);
  e.target.value = "";
  toast("照片已添加，回到「试穿」开始搭配");
});

// ---------------------------------------------------------------------------
// Profile + settings forms
function fillForm(f, obj) {
  for (const el of f.elements) if (el.name && obj[el.name] != null) el.value = obj[el.name];
}
$("#profileForm").addEventListener("input", (e) => {
  S.profile[e.target.name] = e.target.value;
  save("profile");
  renderFit();
});
$("#settingsForm").addEventListener("change", (e) => {
  S.settings[e.target.name] = e.target.value.trim();
  save("settings");
  checkServer();
});
async function checkServer() {
  const el = $("#serverState");
  if (!server()) return (el.textContent = "未配置服务：叠搭预览可用，AI 渲染和网页版链接解析不可用。");
  try {
    const r = await fetch(server() + "/api/health", { signal: AbortSignal.timeout(3000) });
    const j = await r.json();
    el.innerHTML = `✅ 服务在线。可用引擎：<b>${j.providers.join(", ") || "仅 mock（未配置 API Key）"}</b>`;
    return j;
  } catch (e) {
    el.textContent = "⚠️ 连不上服务（" + server() + "）。叠搭预览不受影响；AI 渲染需要先运行 node server/server.mjs";
    return null;
  }
}

// ---------------------------------------------------------------------------
// AI render
$("#btnRender").addEventListener("click", async () => {
  const p = activePhoto();
  const ls = layers().filter((l) => l.visible);
  if (!p) return toast("先在「我的」上传一张全身照");
  if (!ls.length) return toast("先穿上至少一件单品");
  if (!server()) return toast("请先在「我的 → AI 渲染设置」里配置服务地址");
  const btn = $("#btnRender");
  btn.disabled = true;
  const t0 = Date.now();
  const tick = setInterval(() => status(`AI 渲染中… ${Math.round((Date.now() - t0) / 1000)}s（通常 10–60 秒）`), 500);
  try {
    const garments = [];
    for (const l of ls) {
      const it = item(l.id);
      garments.push({
        name: it.name,
        category: it.category,
        aiCategory: CATEGORIES[it.category]?.ai || null,
        image: it.cut ? await onWhite(it.src) : await normalize(it.original, 1024, "image/jpeg"),
      });
    }
    const layout = await composite(p.src, ls);
    const r = await fetch(server() + "/api/tryon", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: S.settings.provider || "auto",
        person: p.src,
        garments,
        layout,
        profile: { gender: S.profile.gender, height: S.profile.height, pref: S.profile.pref },
      }),
    });
    const j = await r.json();
    if (!r.ok || !j.image) throw new Error(j.error || "渲染失败 HTTP " + r.status);
    S.renders[signature()] = j.image;
    $("#viewSeg [data-view=ai]").disabled = false;
    setView("ai");
    status(`✅ 完成（${j.provider}，${Math.round((Date.now() - t0) / 1000)}s）${j.notes?.length ? " · " + j.notes.join("；") : ""}`);
  } catch (e) {
    status("AI 渲染失败：" + e.message, true);
  } finally {
    clearInterval(tick);
    btn.disabled = false;
  }
});

$("#viewSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b && !b.disabled) setView(b.dataset.view);
});
$("#btnAuto").addEventListener("click", () => {
  autoPlaceAll();
  toast("已按类别重新摆放");
});
$("#btnBody").addEventListener("click", () => {
  bodyMode = !bodyMode;
  $("#btnBody").classList.toggle("on", bodyMode);
  setView("edit");
  if (bodyMode) toast("拖动框/角，让框贴合头顶到脚底、左右贴合肩宽；完成后再点一次", 4000);
  else autoPlaceAll();
  draw();
});
$("#btnDownload").addEventListener("click", async () => {
  const p = activePhoto();
  if (!p) return;
  const src = view === "ai" && S.renders[signature()] ? S.renders[signature()] : await composite(p.src, layers());
  const a = document.createElement("a");
  a.href = src;
  a.download = "tryon-" + Date.now() + (src.startsWith("data:image/png") ? ".png" : ".jpg");
  a.click();
});

// ---------------------------------------------------------------------------
// Data
$("#btnExport").addEventListener("click", () => {
  const data = {};
  PERSIST.forEach((k) => (data[k] = S[k]));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: "application/json" }));
  a.download = "tryon-backup.json";
  a.click();
});
$("#importFile").addEventListener("change", async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const data = JSON.parse(await f.text());
  PERSIST.forEach((k) => data[k] !== undefined && (S[k] = data[k]));
  save(...PERSIST);
  boot2();
});
$("#btnClear").addEventListener("click", () => {
  if (!confirm("清空所有照片、衣橱和设置？")) return;
  S.photos = [];
  S.wardrobe = [];
  S.outfit = [];
  S.hidden = [];
  S.placements = {};
  S.bodies = {};
  S.activePhotoId = null;
  save(...PERSIST);
  renderAll();
});

// Samples (bundled SVGs so the demo works with zero setup)
$("#loadSamples").addEventListener("click", async () => {
  const base = new URL("samples/", import.meta.url).href;
  if (!activePhoto()) await addPhoto(base + "model.svg", "示例模特");
  for (const [f, name, wear] of [
    ["jeans.svg", "直筒牛仔裤", true],
    ["tee.svg", "白色 T 恤", true],
    ["jacket.svg", "卡其短夹克", true],
    ["sneakers.svg", "白色运动鞋", true],
    ["skirt.svg", "百褶半身裙", false],
  ]) {
    const it = await addGarment({ src: base + f, name, wear });
    if (f === "tee.svg") it.sizeChart = "尺码 胸围 衣长 肩宽\nS 94 64 42\nM 100 67 44\nL 106 70 46\nXL 112 72 48";
  }
  save("wardrobe");
  setTab("stage");
  renderAll();
});

// ---------------------------------------------------------------------------
// Extension inbox: the content script drops {imageUrl, title, ...} under "inbox:<id>".
async function drainInbox() {
  if (!store.isExtension) return;
  const run = async () => {
    const entries = await store.entries("inbox:");
    for (const [k, v] of entries.sort((a, b) => (a[1].t || 0) - (b[1].t || 0))) {
      await store.remove(k);
      try {
        setTab("stage");
        await addGarment({
          src: v.dataUrl || v.imageUrl,
          name: v.title || "网页单品",
          category: v.category,
          sourceUrl: v.pageUrl,
          price: v.price,
          wear: v.wear !== false,
        });
      } catch (e) {
        toast(e.message, 5000);
      }
    }
  };
  if (navigator.locks) await navigator.locks.request("tryon-inbox", run);
  else await run();
}

store.onChange(async (key, val) => {
  if (key.startsWith("inbox:") && val) return drainInbox();
  if (key === "sync" && val && val.by !== INSTANCE) {
    for (const k of val.keys) {
      const v = await store.get(k);
      if (v != null) S[k] = v;
    }
    renderAll();
  }
});

// ---------------------------------------------------------------------------
// Boot
function boot2() {
  const catOpts = Object.entries(CATEGORIES)
    .map(([k, v]) => `<option value="${k}">${v.label}</option>`)
    .join("");
  form.category.innerHTML = catOpts;
  if ($("#filterCat").options.length === 1) $("#filterCat").insertAdjacentHTML("beforeend", catOpts);
  fillForm($("#profileForm"), S.profile);
  fillForm($("#settingsForm"), S.settings);
  renderAll();
  resize();
}

(async function boot() {
  if (EMBED) {
    document.body.classList.add("embed");
    if (params.has("embed")) {
      $("#closeEmbed").hidden = false;
      $("#closeEmbed").onclick = () => parent.postMessage({ type: "tryon-close" }, "*");
    }
  }
  $$(".tabs button").forEach((b) => (b.onclick = () => setTab(b.dataset.tab)));
  new ResizeObserver(resize).observe($("#stage"));
  await loadAll();
  boot2();
  checkServer();
  drainInbox();
})();
