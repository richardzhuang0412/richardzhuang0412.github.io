// Shared product-page helpers. Loaded as a classic script both by the content
// script (runs on the shopping page) and by the studio (parses fetched HTML).
// Exposes globalThis.TryOnExtract.
(function () {
  const CATEGORY_RULES = [
    ["dress", /连衣裙|连体|裙装|jumpsuit|romper|dress|gown|overall/i],
    ["outer", /外套|夹克|大衣|风衣|羽绒|西装|西服|开衫|马甲|棉服|冲锋衣|jacket|coat|blazer|parka|cardigan|vest|gilet|trench|puffer|outerwear/i],
    ["bottom", /裤|裙|短裤|牛仔裤|jeans|pants|trousers|shorts|skirt|leggings|chinos|joggers/i],
    ["shoes", /鞋|靴|拖鞋|凉鞋|sneaker|shoe|boot|loafer|sandal|heel|trainer|slipper/i],
    ["hat", /帽|beanie|cap\b|hat\b|beret/i],
    ["bag", /包|手袋|背包|bag|tote|backpack|purse|clutch/i],
    ["accessory", /围巾|领带|腰带|项链|耳环|眼镜|手表|scarf|tie\b|belt|necklace|earring|glasses|sunglasses|watch/i],
    ["top", /衫|T恤|卫衣|毛衣|针织|背心|上衣|polo|shirt|tee|t-shirt|top|blouse|sweater|hoodie|sweatshirt|knit|tank|camisole/i],
  ];

  function guessCategory(text) {
    const t = String(text || "");
    for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
    return "top";
  }

  function abs(url, base) {
    if (!url) return null;
    try {
      const u = new URL(String(url).trim(), base);
      if (u.protocol === "http:" || u.protocol === "https:" || u.protocol === "data:") return u.href;
    } catch (e) {}
    return null;
  }

  function flattenLd(node, out) {
    if (!node) return out;
    if (Array.isArray(node)) {
      node.forEach((n) => flattenLd(n, out));
      return out;
    }
    if (typeof node === "object") {
      out.push(node);
      if (node["@graph"]) flattenLd(node["@graph"], out);
      if (node.mainEntity) flattenLd(node.mainEntity, out);
    }
    return out;
  }

  function isProduct(n) {
    const t = n && n["@type"];
    return t === "Product" || (Array.isArray(t) && t.includes("Product")) || t === "ProductGroup";
  }

  function ldImages(img) {
    if (!img) return [];
    if (typeof img === "string") return [img];
    if (Array.isArray(img)) return img.flatMap(ldImages);
    if (img.url) return [img.url];
    if (img.contentUrl) return [img.contentUrl];
    return [];
  }

  /** Extract product info from a Document (live page or DOMParser result). */
  function extractProduct(doc, baseUrl) {
    const base = baseUrl || (doc.location && doc.location.href) || "";
    const meta = (sel) => {
      const el = doc.querySelector(sel);
      return el ? el.getAttribute("content") || el.getAttribute("value") : null;
    };
    const info = { url: base, title: null, brand: null, price: null, currency: null, images: [] };

    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try {
        const nodes = flattenLd(JSON.parse(s.textContent), []);
        nodes.filter(isProduct).forEach((p) => {
          info.title = info.title || p.name;
          info.brand = info.brand || (p.brand && (p.brand.name || p.brand));
          info.images.push(...ldImages(p.image));
          const offer = Array.isArray(p.offers) ? p.offers[0] : p.offers;
          if (offer && !info.price) {
            info.price = offer.price || offer.lowPrice || null;
            info.currency = offer.priceCurrency || null;
          }
          (p.hasVariant || []).slice(0, 4).forEach((v) => info.images.push(...ldImages(v.image)));
        });
      } catch (e) {}
    });

    info.title = info.title || meta('meta[property="og:title"]') || meta('meta[name="twitter:title"]') || (doc.title || "").trim();
    info.price = info.price || meta('meta[property="product:price:amount"]') || meta('meta[property="og:price:amount"]');
    info.currency = info.currency || meta('meta[property="product:price:currency"]') || meta('meta[property="og:price:currency"]');
    info.brand = info.brand || meta('meta[property="product:brand"]') || meta('meta[property="og:brand"]');
    doc.querySelectorAll('meta[property="og:image"], meta[property="og:image:secure_url"], meta[name="twitter:image"]').forEach((m) => {
      info.images.push(m.getAttribute("content"));
    });

    // Fallback: big <img> tags in document order (works best on a live page).
    if (info.images.length < 2) {
      Array.from(doc.querySelectorAll("img"))
        .map((img) => ({ src: bestImageSrc(img), w: img.naturalWidth || parseInt(img.getAttribute("width") || "0", 10) }))
        .filter((x) => x.src && (x.w === 0 || x.w >= 300))
        .slice(0, 8)
        .forEach((x) => info.images.push(x.src));
    }

    const seen = new Set();
    info.images = info.images
      .map((u) => abs(u, base))
      .filter((u) => u && !/\.svg(\?|$)|sprite|logo|icon/i.test(u) && !seen.has(u) && seen.add(u))
      .slice(0, 12);
    info.category = guessCategory(info.title);
    return info;
  }

  /** Pick the highest-resolution source an <img> (or element with a background) offers. */
  function bestImageSrc(el) {
    if (!el) return null;
    if (el.tagName === "IMG") {
      const srcset = el.getAttribute("srcset") || el.getAttribute("data-srcset");
      if (srcset) {
        const best = srcset
          .split(",")
          .map((p) => p.trim().split(/\s+/))
          .map(([u, d]) => ({ u, n: parseFloat(d) || 1 }))
          .sort((a, b) => b.n - a.n)[0];
        if (best && best.u) return abs(best.u, el.baseURI);
      }
      return abs(el.currentSrc || el.getAttribute("data-src") || el.getAttribute("data-original") || el.src, el.baseURI);
    }
    const bg = el.ownerDocument && el.ownerDocument.defaultView && el.ownerDocument.defaultView.getComputedStyle(el).backgroundImage;
    const m = bg && bg.match(/url\(["']?(.*?)["']?\)/);
    return m ? abs(m[1], el.baseURI) : null;
  }

  /** From a DataTransfer (drag & drop), return {imageUrl, files, pageUrl}. */
  function readDataTransfer(dt) {
    const out = { imageUrl: null, files: [], linkUrl: null };
    if (!dt) return out;
    out.files = Array.from(dt.files || []).filter((f) => f.type.startsWith("image/"));
    const html = dt.getData && dt.getData("text/html");
    if (html) {
      const m = html.match(/<img[^>]+src=["']([^"']+)["']/i);
      if (m) out.imageUrl = m[1].replace(/&amp;/g, "&");
    }
    const uri = dt.getData && (dt.getData("text/uri-list") || dt.getData("text/plain"));
    if (uri) {
      const first = uri
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find((s) => s && !s.startsWith("#"));
      if (first && /^(https?:|data:image)/.test(first)) {
        if (!out.imageUrl && /\.(jpe?g|png|webp|avif|gif)(\?|$)|^data:image|\/images?\//i.test(first)) out.imageUrl = first;
        else out.linkUrl = first;
      }
    }
    return out;
  }

  globalThis.TryOnExtract = { extractProduct, guessCategory, bestImageSrc, readDataTransfer };
})();
