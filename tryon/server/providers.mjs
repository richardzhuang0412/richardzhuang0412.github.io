// Try-on providers. Each takes { person, garments[], layout, profile } where
// images are data URLs and garments are ordered inner -> outer, and returns
// { image: dataURL | url, notes: string[] }.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function splitDataURL(d) {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(d || "");
  if (!m) throw new Error("expected a data: URL");
  return { mime: m[1], data: m[2] ? m[3] : Buffer.from(decodeURIComponent(m[3])).toString("base64") };
}

async function urlToDataURL(url) {
  if (url.startsWith("data:")) return url;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download result failed: HTTP ${r.status}`);
  const type = r.headers.get("content-type") || "image/png";
  return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString("base64")}`;
}

// Order used when chaining single-garment models: inner layers first.
const CHAIN_ORDER = { bottom: 1, dress: 2, top: 3, outer: 4, shoes: 5, hat: 6, bag: 7, accessory: 8 };
const chainSort = (gs) => [...gs].sort((a, b) => (CHAIN_ORDER[a.category] || 9) - (CHAIN_ORDER[b.category] || 9));

// ---------------------------------------------------------------------------
// Google Gemini image model ("Nano Banana"): handles a whole outfit in one call,
// including shoes / bags / hats, and respects layering instructions in text.
const CAT_EN = {
  top: "top",
  outer: "outer layer (jacket/coat)",
  dress: "dress / one-piece",
  bottom: "bottoms",
  shoes: "shoes",
  hat: "hat",
  bag: "bag",
  accessory: "accessory",
};

export const gemini = {
  name: "gemini",
  available: () => !!process.env.GEMINI_API_KEY,
  async run({ person, garments, layout }) {
    const model = process.env.GEMINI_IMAGE_MODEL || "gemini-2.5-flash-image";
    const ordered = chainSort(garments);
    const lines = ordered.map((g, i) => `  Image ${i + 2}: ${CAT_EN[g.category] || g.category}${g.name ? ` ("${g.name}")` : ""}`);
    const prompt = [
      "You are a virtual fitting room. Image 1 is a photo of a person.",
      "The following images are product photos of garments:",
      ...lines,
      layout
        ? `  Image ${
            ordered.length + 2
          }: a rough collage showing the intended layering and placement (for reference only, do not copy its artifacts).`
        : "",
      "",
      "Generate a single photorealistic image of the SAME person from Image 1 wearing ALL of these garments together.",
      "Layering, from innermost to outermost: " +
        ordered.map((g) => CAT_EN[g.category] || g.category).join(" → ") +
        ". Outer layers go over inner layers (e.g. a jacket is worn open over the top unless it is clearly a closed pullover).",
      "Strictly preserve the person's face, identity, hair, skin tone, body shape, pose, and the background, lighting and camera framing of Image 1.",
      "Reproduce each garment's exact colour, pattern, print, logo, material and cut. Fit the garments naturally to the person's body with realistic drape, folds and shadows; keep the garment's own length (e.g. cropped vs long).",
      "Replace whatever the person was wearing in those regions. Output only the image.",
    ]
      .filter(Boolean)
      .join("\n");

    const parts = [{ text: prompt }, { inline_data: toInline(person) }, ...ordered.map((g) => ({ inline_data: toInline(g.image) }))];
    if (layout) parts.push({ inline_data: toInline(layout) });

    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({ contents: [{ role: "user", parts }], generationConfig: { responseModalities: ["IMAGE", "TEXT"] } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Gemini ${r.status}: ${j.error?.message || "request failed"}`);
    const out = (j.candidates?.[0]?.content?.parts || []).find((p) => p.inline_data || p.inlineData);
    if (!out) {
      const text = (j.candidates?.[0]?.content?.parts || [])
        .map((p) => p.text)
        .filter(Boolean)
        .join(" ");
      throw new Error(
        "Gemini returned no image" +
          (text ? `: ${text.slice(0, 200)}` : j.promptFeedback?.blockReason ? ` (blocked: ${j.promptFeedback.blockReason})` : "")
      );
    }
    const d = out.inline_data || out.inlineData;
    return { image: `data:${d.mime_type || d.mimeType || "image/png"};base64,${d.data}`, notes: [`model ${model}`] };
  },
};

function toInline(dataURL) {
  const { mime, data } = splitDataURL(dataURL);
  return { mime_type: mime, data };
}

// ---------------------------------------------------------------------------
// FASHN (https://docs.fashn.ai): dedicated try-on model, one garment per call.
// Layering = feed the previous result back in as the model image.
export const fashn = {
  name: "fashn",
  available: () => !!process.env.FASHN_API_KEY,
  async run({ person, garments }) {
    const key = process.env.FASHN_API_KEY;
    const modelName = process.env.FASHN_MODEL || "tryon-v1.6";
    const supported = chainSort(garments).filter((g) => g.aiCategory);
    const skipped = garments.filter((g) => !g.aiCategory).map((g) => g.name || g.category);
    if (!supported.length) throw new Error("FASHN 只支持上衣/下装/连衣裙；鞋、包、帽子请用 Gemini 引擎");
    let current = person;
    for (const g of supported) {
      const run = await fetch("https://api.fashn.ai/v1/run", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model_name: modelName,
          inputs: {
            model_image: current,
            garment_image: g.image,
            category: g.aiCategory || "auto",
            garment_photo_type: "auto",
            mode: process.env.FASHN_MODE || "balanced",
          },
        }),
      });
      const rj = await run.json().catch(() => ({}));
      if (!run.ok || !rj.id) throw new Error(`FASHN run ${run.status}: ${rj.error?.message || rj.error || JSON.stringify(rj).slice(0, 200)}`);
      const t0 = Date.now();
      for (;;) {
        await sleep(2000);
        const st = await (await fetch(`https://api.fashn.ai/v1/status/${rj.id}`, { headers: { authorization: `Bearer ${key}` } })).json();
        if (st.status === "completed") {
          current = await urlToDataURL(st.output[0]);
          break;
        }
        if (st.status === "failed" || st.error) throw new Error(`FASHN failed on "${g.name}": ${st.error?.message || st.error || "unknown"}`);
        if (Date.now() - t0 > 180000) throw new Error("FASHN timeout");
      }
    }
    const notes = [`${supported.length} 件逐层叠加`];
    if (skipped.length) notes.push(`未渲染（FASHN 不支持）：${skipped.join("、")}`);
    return { image: current, notes };
  },
};

// ---------------------------------------------------------------------------
// Self-hosted open-source model (CatVTON / IDM-VTON / Leffa / OOTDiffusion ...)
// behind a tiny HTTP wrapper with this contract:
//   POST $SELFHOST_URL  {person: dataURL, garment: dataURL, category: "upper"|"lower"|"overall"}
//   -> {image: dataURL | url}
export const selfhost = {
  name: "selfhost",
  available: () => !!process.env.SELFHOST_URL,
  async run({ person, garments }) {
    const map = { tops: "upper", bottoms: "lower", "one-pieces": "overall" };
    const supported = chainSort(garments).filter((g) => g.aiCategory);
    if (!supported.length) throw new Error("自部署模型只处理上衣/下装/连衣裙");
    let current = person;
    for (const g of supported) {
      const r = await fetch(process.env.SELFHOST_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ person: current, garment: g.image, category: map[g.aiCategory] }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.image) throw new Error(`selfhost ${r.status}: ${j.error || "no image"}`);
      current = await urlToDataURL(j.image);
    }
    return { image: current, notes: [`${supported.length} 件逐层叠加（自部署）`] };
  },
};

// ---------------------------------------------------------------------------
// Mock: returns the client's collage so the whole flow can be tested offline.
export const mock = {
  name: "mock",
  available: () => true,
  async run({ layout, person }) {
    await sleep(600);
    return { image: layout || person, notes: ["mock：返回的是叠搭预览图，未调用模型"] };
  },
};

export const PROVIDERS = { gemini, fashn, selfhost, mock };

export function pickProvider(name) {
  if (name && name !== "auto") {
    const p = PROVIDERS[name];
    if (!p) throw new Error(`unknown provider ${name}`);
    if (!p.available()) throw new Error(`${name} 未配置（检查 server/.env 里的 API Key / URL）`);
    return p;
  }
  return [gemini, fashn, selfhost].find((p) => p.available()) || mock;
}
