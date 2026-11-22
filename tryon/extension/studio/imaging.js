// Image utilities: loading, resizing, white-background removal, layout.

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    if (!src.startsWith("data:") && !src.startsWith("blob:")) img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("图片加载失败"));
    img.src = src;
  });
}

export function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

/** Downscale so the long edge is <= maxSide; returns a data URL. */
export async function normalize(src, maxSide = 1280, type = "image/jpeg") {
  const img = await loadImage(src);
  const s = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const c = document.createElement("canvas");
  c.width = Math.round(img.naturalWidth * s);
  c.height = Math.round(img.naturalHeight * s);
  const ctx = c.getContext("2d");
  if (type === "image/jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, c.width, c.height);
  }
  ctx.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(type, 0.9);
}

/**
 * Remove a plain (usually white / light grey) studio background by flood-filling
 * from the image border. Good enough for flat-lay product shots; photos of a
 * garment worn by a model need the AI renderer instead.
 * Returns { src, removed } where removed is the fraction of pixels cleared.
 */
export async function cutout(src, tolerance = 28) {
  const img = await loadImage(src);
  const s = Math.min(1, 900 / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * s));
  const h = Math.max(1, Math.round(img.naturalHeight * s));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);
  const data = ctx.getImageData(0, 0, w, h);
  const px = data.data;

  // Border statistics: if the border is already transparent, nothing to do.
  const border = [];
  for (let x = 0; x < w; x += 3) border.push(x, (h - 1) * w + x);
  for (let y = 0; y < h; y += 3) border.push(y * w, y * w + w - 1);
  const transparent = border.filter((i) => px[i * 4 + 3] < 20).length / border.length;
  if (transparent < 0.6) {
    // Reference colour = median of border pixels per channel.
    const med = [0, 1, 2].map((ch) => {
      const v = border.map((i) => px[i * 4 + ch]).sort((a, b) => a - b);
      return v[v.length >> 1];
    });
    const tol2 = tolerance * tolerance * 3;
    const close = (i) => {
      const o = i * 4;
      const dr = px[o] - med[0],
        dg = px[o + 1] - med[1],
        db = px[o + 2] - med[2];
      return dr * dr + dg * dg + db * db <= tol2;
    };
    const mask = new Uint8Array(w * h); // 1 = background
    const stack = [];
    for (const i of border) if (close(i)) stack.push(i);
    for (let x = 0; x < w; x++) stack.push(x, (h - 1) * w + x);
    for (let y = 0; y < h; y++) stack.push(y * w, y * w + w - 1);
    while (stack.length) {
      const i = stack.pop();
      if (mask[i] || !close(i)) continue;
      mask[i] = 1;
      const x = i % w;
      if (x > 0) stack.push(i - 1);
      if (x < w - 1) stack.push(i + 1);
      if (i >= w) stack.push(i - w);
      if (i < w * (h - 1)) stack.push(i + w);
    }
    // Apply with a 1px soft edge.
    for (let i = 0; i < w * h; i++) {
      if (mask[i]) px[i * 4 + 3] = 0;
      else {
        const x = i % w;
        const n = (x > 0 && mask[i - 1]) + (x < w - 1 && mask[i + 1]) + (i >= w && mask[i - w]) + (i < w * (h - 1) && mask[i + w]);
        if (n) px[i * 4 + 3] = Math.round(px[i * 4 + 3] * (1 - n * 0.18));
      }
    }
    ctx.putImageData(data, 0, 0);
  }

  // Trim to the opaque bounding box.
  let x0 = w,
    y0 = h,
    x1 = -1,
    y1 = -1,
    opaque = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (px[(y * w + x) * 4 + 3] > 24) {
        opaque++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return { src, removed: 0 };
  const t = document.createElement("canvas");
  t.width = x1 - x0 + 1;
  t.height = y1 - y0 + 1;
  t.getContext("2d").drawImage(c, x0, y0, t.width, t.height, 0, 0, t.width, t.height);
  return { src: t.toDataURL("image/png"), removed: 1 - opaque / (w * h) };
}

/** Composite a transparent PNG onto white (for APIs that want JPEG garments). */
export async function onWhite(src) {
  const img = await loadImage(src);
  const pad = Math.round(Math.max(img.naturalWidth, img.naturalHeight) * 0.06);
  const c = document.createElement("canvas");
  c.width = img.naturalWidth + pad * 2;
  c.height = img.naturalHeight + pad * 2;
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(img, pad, pad);
  return c.toDataURL("image/jpeg", 0.92);
}

// ---------------------------------------------------------------------------
// Layout: where each category sits on the body. Values are fractions of the
// body box (y0/y1 vertical span, w = max width relative to shoulder width,
// dx = horizontal offset). The body box spans head-top..feet and shoulder width.
export const CATEGORIES = {
  top: { label: "上衣", z: 30, y0: 0.15, y1: 0.5, w: 1.45, ai: "tops" },
  outer: { label: "外套", z: 40, y0: 0.14, y1: 0.56, w: 1.65, ai: "tops" },
  dress: { label: "连衣裙/连体", z: 30, y0: 0.15, y1: 0.8, w: 1.3, ai: "one-pieces" },
  bottom: { label: "下装", z: 20, y0: 0.44, y1: 0.97, w: 1.0, ai: "bottoms" },
  shoes: { label: "鞋", z: 10, y0: 0.955, y1: 1.02, w: 0.8, ai: null },
  hat: { label: "帽子", z: 60, y0: -0.02, y1: 0.08, w: 0.5, ai: null },
  bag: { label: "包", z: 50, y0: 0.4, y1: 0.62, w: 0.45, dx: 0.55, ai: null },
  accessory: { label: "配饰", z: 55, y0: 0.12, y1: 0.24, w: 0.5, ai: null },
};

/** Default body box: a centred, standing, full-body photo. */
export const DEFAULT_BODY = { x: 0.3, y: 0.04, w: 0.4, h: 0.93 };

/** Place a garment of size (gw, gh) in a photo of size (pw, ph). Returns a layer transform in photo-normalised units. */
export function autoPlace(category, gw, gh, pw, ph, body = DEFAULT_BODY) {
  const spec = CATEGORIES[category] || CATEGORIES.top;
  const bx = body.x * pw,
    by = body.y * ph,
    bw = body.w * pw,
    bh = body.h * ph;
  const boxW = spec.w * bw,
    boxH = (spec.y1 - spec.y0) * bh;
  const s = Math.min(boxW / gw, boxH / gh);
  const w = gw * s,
    h = gh * s;
  const cx = bx + bw / 2 + (spec.dx || 0) * bw;
  const cy = by + spec.y0 * bh + h / 2;
  return { cx: cx / pw, cy: cy / ph, w: w / pw, rot: 0 };
}

/** Render photo + layers to a canvas at the photo's native resolution. */
export async function composite(photoSrc, layers) {
  const photo = await loadImage(photoSrc);
  const c = document.createElement("canvas");
  c.width = photo.naturalWidth;
  c.height = photo.naturalHeight;
  const ctx = c.getContext("2d");
  ctx.drawImage(photo, 0, 0);
  for (const L of layers) {
    if (!L.visible) continue;
    const img = await loadImage(L.src);
    drawLayer(ctx, img, L, c.width, c.height);
  }
  return c.toDataURL("image/jpeg", 0.92);
}

export function drawLayer(ctx, img, L, pw, ph, offX = 0, offY = 0) {
  const w = L.w * pw;
  const h = w * (img.naturalHeight / img.naturalWidth);
  ctx.save();
  ctx.translate(offX + L.cx * pw, offY + L.cy * ph);
  ctx.rotate(L.rot || 0);
  ctx.shadowColor = "rgba(0,0,0,0.18)";
  ctx.shadowBlur = Math.max(2, w * 0.02);
  ctx.shadowOffsetY = Math.max(1, w * 0.008);
  ctx.globalAlpha = L.opacity == null ? 1 : L.opacity;
  ctx.drawImage(img, -w / 2, -h / 2, w, h);
  ctx.restore();
  return { w, h };
}
